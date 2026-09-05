/**
 * Adapter -> Kontrol lifecycle event ingestion (POST /runs/:run_id/events).
 *
 * Extracted verbatim from acp-server.ts's createAcpServer closure (P1
 * decomposition). Turns adapter events into durable work-session events, holds
 * the attempt-binding and terminal-monotonicity guards (P0 #7/#8), and serves
 * the blocking approval long-poll.
 */
import type { Router } from "express";
import { serializeFinalAcpResult } from "../../acp-registry.js";
import type { ApprovalOption, ApprovalRequestManager } from "../../approval-requests.js";
import type { AcpContext, AcpRole } from "./context.js";
import { APPROVAL_WAIT_TIMEOUT_MS } from "./context.js";
import type { makeAuth } from "./auth.js";
import type { makeReviewBarrier } from "./review-barrier.js";
import { acpRunEventSchema } from "./schemas.js";

export function registerEventRoutes(
  router: Router,
  ctx: AcpContext,
  auth: ReturnType<typeof makeAuth>,
  barrier: ReturnType<typeof makeReviewBarrier>,
) {
  const { workSessions, agentRegistry, eventStore, approvalRequests, reviewWorkflow } = ctx;
  const { authGate, requireAgentOwnership } = auth;
  const { TERMINAL_SESSION_STATUSES, evaluateCompletion } = barrier;

  // ── Adapter → Kontrol lifecycle events ──────────────
  // The CRUSH adapter POSTs run lifecycle events here (authenticated with the
  // shared secret). Kontrol turns them into durable work-session events that
  // drive the WebUI watcher, and updates the run's heartbeat/lease.
  const ADAPTER_EVENT_TYPE_TO_RUN: Record<string, string> = {
    started: "agent.run.started",
    heartbeat: "agent.run.heartbeat",
    output_delta: "agent.run.output_delta",
    thought_delta: "agent.run.thought_delta",
    tool_started: "agent.tool.started",
    tool_completed: "agent.tool.completed",
    tool_failed: "agent.tool.failed",
    plan_updated: "agent.plan.updated",
    completed: "agent.run.completed",
    failed: "agent.run.failed",
    cancelled: "agent.run.cancelled",
    // Migration: older adapters reported a nonzero exit as `exited`, which
    // Kontrol rejected with HTTP 400 and silently stranded the work session.
    // Map it to the same durable event as `failed` so legacy adapters still work.
    exited: "agent.run.failed",
  };

  const APPROVAL_EVENT_TYPES = new Set([
    "approval.requested",
    "approval_requested",
    "permission.requested",
    "permission_requested",
    "confirmation.requested",
    "confirmation_requested",
    "user_input.required",
    "user_input_required",
  ]);

  router.post("/runs/:run_id/events", async (req, res) => {
    const role = authGate(req, res, ["agent", "operator"]);
    if (!role) return;

    const run = agentRegistry.getRun(req.params.run_id);
    if (!run) { res.status(404).json({ error: { code: "not_found", message: "Run not found" } }); return; }

    const parsedEvent = acpRunEventSchema.safeParse(req.body);
    if (!parsedEvent.success) {
      res.status(400).json({ error: { code: "invalid_input", message: "Invalid ACP lifecycle event", issues: parsedEvent.error.issues } });
      return;
    }
    const body = parsedEvent.data;

    if (!body.type || (!ADAPTER_EVENT_TYPE_TO_RUN[body.type] && !APPROVAL_EVENT_TYPES.has(body.type))) {
      res.status(400).json({ error: { code: "invalid_input", message: "unknown or missing event type" } });
      return;
    }
    // The adapter must report the same work session the run was created for.
    if (run.workSessionId && body.work_session_id !== run.workSessionId) {
      res.status(409).json({ error: { code: "conflict", message: "work_session_id does not match run" } });
      return;
    }
    if (role === "agent") {
      // Agent ownership is header-bound; accepting the body copy here would
      // let a caller choose which registered identity it claims to be.
      if (!requireAgentOwnership(req, res, role, run.agentId)) return;
      if (body.agent_id && body.agent_id !== run.agentId) {
        res.status(403).json({ error: { code: "forbidden", message: "agent_id does not match the bound run" } });
        return;
      }
    }

    // P0 #7: bind lifecycle events to the exact dispatch attempt. An event
    // from a superseded attempt is recorded diagnostically and idempotently
    // acked — it must never mutate the current attempt's state.
    if (body.attempt_number !== undefined && run.attemptNumber !== undefined && body.attempt_number !== run.attemptNumber) {
      eventStore?.appendEvent({
        type: "agent.event.stale_attempt",
        sessionId: run.workSessionId ?? run.workspaceSessionId ?? "",
        payload: {
          runId: run.runId,
          eventAttempt: body.attempt_number,
          currentAttempt: run.attemptNumber,
          eventType: body.type,
          remoteRunId: body.remote_run_id,
        },
      }, { publish: false });
      res.status(202).json({ run_id: run.runId, status: run.status, ignored: true, stale_attempt: true });
      return;
    }

    // P0 #7: remote_run_id is immutable once attached to the current attempt.
    if (body.remote_run_id && run.remoteRunId && body.remote_run_id !== run.remoteRunId) {
      res.status(409).json({ error: { code: "conflict", message: `remote_run_id does not match the attached execution attempt (${run.remoteRunId})` } });
      return;
    }

    const now = new Date().toISOString();
    if (APPROVAL_EVENT_TYPES.has(body.type)) {
      if (!approvalRequests) {
        res.status(500).json({ error: { code: "server_error", message: "Approval request store unavailable" } });
        return;
      }
      const sessionId = run.workSessionId;
      const workspaceSessionId = run.workspaceSessionId;
      if (!workspaceSessionId) {
        res.status(409).json({ error: { code: "conflict", message: "run has no workspace session" } });
        return;
      }
      const payload = body.payload ?? {};
      // The agent may either fire-and-forget (wait:false) or block for the human
      // decision (default). A blocking request holds this HTTP call open until
      // the reviewer resolves the approval, then returns the decision inline so
      // the agent's tool call can proceed or abort. Without this the generic
      // approval flow was write-only: the agent could never learn the outcome.
      const wantsDecision = payload.wait !== false && eventStore !== undefined;
      const eventSessionId = sessionId ?? workspaceSessionId;

      // The predicate closes over this ref; it is populated with the concrete
      // approvalId immediately after create() but BEFORE we await, and the
      // subscription is installed first so a fast human decision can never
      // resolve in the gap between create and wait (lost-wakeup safe).
      const approvalIdRef: { id?: string } = {};
      const resolutionPromise = wantsDecision
        ? eventStore.waitForEvent(
            eventSessionId,
            "approval.resolved",
            (e: { payload?: Record<string, unknown> }) =>
              approvalIdRef.id !== undefined && e.payload?.approvalId === approvalIdRef.id,
            APPROVAL_WAIT_TIMEOUT_MS,
          )
        : undefined;

      const request = approvalRequests.create({
        kind: body.type.startsWith("user_input") ? "user_input" : "agent_permission",
        workspaceSessionId,
        workSessionId: sessionId,
        runId: run.runId,
        agentId: run.agentId ?? run.agentName,
        title: stringPayload(payload.title) ?? stringPayload(payload.tool) ?? "Agent approval requested",
        description: stringPayload(payload.description) ?? stringPayload(payload.message),
        risk: stringPayload(payload.risk),
        tool: stringPayload(payload.tool),
        command: stringPayload(payload.command),
        path: stringPayload(payload.path),
        options: parseApprovalOptions(payload.options),
        expiresAt: stringPayload(payload.expiresAt),
      });
      approvalIdRef.id = request.approvalId;
      eventStore?.appendEvent({
        type: "approval.requested",
        sessionId: eventSessionId,
        payload: approvalToEventPayload(request),
      });

      if (!resolutionPromise) {
        res.status(202).json({ approval_id: request.approvalId, status: request.status });
        return;
      }

      const resolution = await resolutionPromise;
      if (!resolution) {
        // The long-poll window elapsed WITHOUT a human decision. This is NOT a
        // denial — people step away, and (like the CLI coding agents) the tool
        // call must simply keep waiting. The approval row stays pending; we tell
        // the caller to re-park via GET /approvals/:id/decision. No verdict is
        // fabricated and no work is dropped.
        res.status(200).json({
          approval_id: request.approvalId,
          status: "pending",
          decision: null,
          still_pending: true,
          poll_url: `/approvals/${encodeURIComponent(request.approvalId)}/decision`,
        });
        return;
      }
      const rp = resolution.payload ?? {};
      res.status(200).json({
        approval_id: request.approvalId,
        status: stringPayload(rp.status) ?? (rp.decision === "approve" ? "approved" : "denied"),
        decision: stringPayload(rp.decision) ?? "deny",
        option_id: stringPayload(rp.optionId),
        reason: stringPayload(rp.reason),
      });
      return;
    }

    // P0 #8: terminal logical-run states are MONOTONIC. Once a run reaches
    // approved/rejected/cancelled/failed/failed_protocol, no later lifecycle
    // event may move it to another terminal state (a late `failed` must not
    // overwrite an `approved` run). Exact duplicate terminal delivery is an
    // idempotent ack; any other late terminal event is recorded and ignored.
    const terminalRunStatus = new Set(["approved", "rejected", "cancelled", "failed", "failed_protocol"]);
    const duplicateDelivery = body.type === "completed" && run.status === "approved";
    if (terminalRunStatus.has(run.status)) {
      if (duplicateDelivery) {
        res.status(202).json({ run_id: run.runId, status: run.status, ignored: true, duplicate: true });
        return;
      }
      eventStore?.appendEvent({
        type: "agent.event.after_terminal",
        sessionId: run.workSessionId ?? run.workspaceSessionId ?? "",
        payload: { runId: run.runId, runStatus: run.status, eventType: body.type },
      }, { publish: false });
      res.status(202).json({ run_id: run.runId, status: run.status, ignored: true, terminal_monotonic: true });
      return;
    }

    const sessionId = run.workSessionId;
    const session = sessionId ? workSessions.get(sessionId) : undefined;
    const gatedCompletedTurn =
      body.type === "completed" &&
      session?.completionPolicy === "webui_approval_required";

    agentRegistry.updateRun(run.runId, {
      status: body.type === "started" ? "running" : run.status,
      remoteRunId: body.remote_run_id ?? run.remoteRunId,
      lastHeartbeatAt: now,
      workerLeaseUntil: body.type === "started" || body.type === "heartbeat"
        ? new Date(Date.now() + 30_000).toISOString()
        : run.workerLeaseUntil,
      ...(body.type === "completed" || body.type === "failed" || body.type === "cancelled"
        ? (() => {
            const finalOutput = stringPayload(body.payload?.final_output);
            return finalOutput === undefined
              ? {}
              : {
                  outputPreview: finalOutput.slice(0, 2000),
                  outputJson: serializeFinalAcpResult({}, finalOutput),
                };
          })()
        : {}),
    });

    // Renew the CHECKOUT lease from the same worker heartbeat. The worker lease
    // above is short (30s) but the checkout (workspace) lease defaults to 1h and
    // was previously renewed only at acquire time — so a worker on a long task
    // would let its checkout lease lapse and another session could seize the
    // checkout out from under it. Renewal is ownership-scoped and never seizes.
    if ((body.type === "started" || body.type === "heartbeat") && sessionId) {
      const lease = workSessions.getWorkspaceLeaseForSession(sessionId);
      workSessions.renewWorkspaceLeaseForSession(sessionId, undefined, lease?.leaseNonce);
    }

    // Defect #1: a worker CRASH while the review is still open must not emit the
    // terminal agent.run.failed — the WebUI would drop a resumable session. That
    // case is handled below with the non-terminal worker.attempt.failed event.
    const awaitingReviewCrash =
      (body.type === "failed" || body.type === "exited") &&
      sessionId !== undefined &&
      workSessions.get(sessionId)?.status === "awaiting_review";
    const workflowHandledCancellation =
      body.type === "cancelled" &&
      sessionId !== undefined &&
      reviewWorkflow !== undefined &&
      session !== undefined &&
      !TERMINAL_SESSION_STATUSES.has(session.status);
    if (sessionId && eventStore && !awaitingReviewCrash && !workflowHandledCancellation) {
      eventStore.appendEvent({
        type: gatedCompletedTurn ? "worker.turn.completed" : ADAPTER_EVENT_TYPE_TO_RUN[body.type],
        sessionId,
        payload: {
          runId: run.runId,
          remoteRunId: body.remote_run_id ?? run.remoteRunId,
          workSessionId: sessionId,
          ...(body.payload ?? {}),
        },
      });
    }

    if (body.type === "completed") {
      await evaluateCompletion(run.runId, sessionId ?? "");
    } else if (body.type === "cancelled") {
      const session = sessionId ? workSessions.get(sessionId) : undefined;
      if (session && !TERMINAL_SESSION_STATUSES.has(session.status) && reviewWorkflow) {
        await reviewWorkflow.finalizeCancellation({ sessionId: session.id, reason: stringPayload(body.payload?.message) ?? "worker cancelled" });
      } else {
        agentRegistry.updateRun(run.runId, { status: "cancelled", finishedAt: now, workerLeaseUntil: null });
      }
    } else if (body.type === "failed" || body.type === "exited") {
      // An execution/infrastructure failure is distinct from a protocol
      // violation. Conflation (the old `failed_protocol` rewrite) wrongly
      // stranded sessions whose only crime was a crashed worker — including a
      // worker that crashed AFTER submitting, while the durable review was
      // still open. Map to `failed`; only a zero-exit in the wrong session
      // state (handled by evaluateCompletion) is a protocol failure.
      const session = sessionId ? workSessions.get(sessionId) : undefined;
      const errorMessage = stringPayload(body.payload?.message) ?? "worker process exited";
      if (session && session.status === "awaiting_review") {
        // Worker died after submitting but before the reviewer responded. Keep
        // the durable review OPEN (resumable): mark the attempt detached and do
        // NOT mark the session terminal — the reviewer can still approve/reject.
        // Emit the NON-terminal worker.attempt.failed (not agent.run.failed) so
        // the WebUI keeps watching the resumable session (defect #1).
        agentRegistry.updateRun(run.runId, {
          status: "awaiting_review",
          finishedAt: new Date().toISOString(),
          workerLeaseUntil: null,
        });
        eventStore?.appendEvent({
          type: "worker.attempt.failed",
          sessionId: session.id,
          payload: { runId: run.runId, resumable: true, reason: errorMessage },
        });
      } else if (session && !TERMINAL_SESSION_STATUSES.has(session.status)) {
        workSessions.updateStatus(session.id, "failed");
        eventStore?.appendEvent({
          type: "agent.run.failed",
          sessionId: session.id,
          payload: { runId: run.runId, reason: errorMessage },
        });
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage, finishedAt: now });
      } else {
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage, finishedAt: now });
      }
    }

    const finalRun = agentRegistry.getRun(run.runId);
    const finalSession = finalRun?.workSessionId ? workSessions.get(finalRun.workSessionId) : undefined;
    res.status(202).json({
      run_id: run.runId,
      status: finalRun?.status ?? run.status,
      work_session_status: finalSession?.status,
      accepted: true,
    });
  });

  function stringPayload(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  function parseApprovalOptions(value: unknown): ApprovalOption[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const options = value.flatMap((entry): ApprovalOption[] => {
      if (!entry || typeof entry !== "object") return [];
      const obj = entry as Record<string, unknown>;
      const id = stringPayload(obj.id);
      const label = stringPayload(obj.label);
      const effect = obj.effect === "approve" || obj.effect === "deny" || obj.effect === "changes_requested"
        ? obj.effect
        : undefined;
      if (!id || !label || !effect) return [];
      return [{ id, label, effect, scope: obj.scope as ApprovalOption["scope"] }];
    });
    return options.length ? options : undefined;
  }

  function approvalToEventPayload(approval: NonNullable<ReturnType<ApprovalRequestManager["get"]>>): Record<string, unknown> {
    return {
      approvalId: approval.approvalId,
      kind: approval.kind,
      workspaceId: approval.workspaceSessionId,
      workspaceSessionId: approval.workspaceSessionId,
      workSessionId: approval.workSessionId,
      runId: approval.runId,
      agentId: approval.agentId,
      title: approval.title,
      description: approval.description,
      risk: approval.risk,
      tool: approval.tool,
      command: approval.command,
      path: approval.path,
      options: approval.options,
      status: approval.status,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
    };
  }
}
