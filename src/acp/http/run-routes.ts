/**
 * ACP run execution routes (POST/GET /runs*).
 *
 * Extracted verbatim from acp-server.ts's createAcpServer closure (P1
 * decomposition). Covers peer dispatch, local tool execution, the
 * kontrol-review / kontrol-submit-work-to-webui surfaces, feedback-driven
 * resume, and cancellation. Review-barrier and completion evaluation shared
 * with event-routes live in review-barrier.ts.
 */
import type { Request, Response, Router } from "express";
import {
  serializeFinalAcpResult,
  type AgentRegistryManager,
} from "../../acp-registry.js";
import { cancelRemoteRun, DEFAULT_ACP_TIMEOUT, dispatchToPeer, executeKontrolTool, selectHealthyAgent } from "../../acp-gateway.js";
import { validateWebhookUrl } from "../../webhook-policy.js";
import { acpRunRequestSchema } from "./schemas.js";
import { ACP_TOOL_POLICY_NAMES } from "../../policy-enforcement.js";
import { authorizeWorkSessionAction } from "../../work-session-action-guard.js";
import type { AcpContext, AcpRole } from "./context.js";
import { MUTATING_LOCAL_AGENTS } from "./context.js";
import type { makeAuth } from "./auth.js";
import type { makeSseHub } from "./sse-hub.js";
import type { makeRunSupport } from "./run-support.js";
import type { makeReviewBarrier } from "./review-barrier.js";

export function registerRunRoutes(
  router: Router,
  ctx: AcpContext,
  auth: ReturnType<typeof makeAuth>,
  sse: ReturnType<typeof makeSseHub>,
  support: ReturnType<typeof makeRunSupport>,
  barrier: ReturnType<typeof makeReviewBarrier>,
) {
  const { workspaces, workSessions, agentRegistry, eventStore, reviewCheckpoints, reviewWorkflow, policyEnforcer, adapterSecret, sharedSecret } = ctx;
  const { authGate } = auth;
  const { emitSse, sseSubscribe, requestAbortSignal } = sse;
  const { resolveCwd, extractTaskText, resolveRunContext, acquireCheckoutModifyLease } = support;

  // ── Run Execution ──────────────────────────────────

  router.post("/runs", async (req: Request, res: Response) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;
    const requestSignal = requestAbortSignal(req, res);

    const parsed = acpRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_input", message: "Invalid ACP run request", issues: parsed.error.issues } });
      return;
    }
    const { agent_name, input, mode, session_id, work_session_id, workspace_id, workspace_session_id, webhook_url } = parsed.data;
    if (webhook_url) {
      const webhookError = validateWebhookUrl(webhook_url, ctx.effectiveWebhookPolicy);
      if (webhookError) {
        res.status(403).json({ error: { code: "webhook_not_allowed", message: webhookError } });
        return;
      }
    }

    const agent = ctx.agentMap.get(agent_name);
    if (!agent) {
      const selection = await selectHealthyAgent(agentRegistry.listAlive(), {
        name: agent_name,
        role: "agent",
        adapterSecret: adapterSecret ?? sharedSecret,
      });
      if (!selection.agent) {
        const dead = selection.deadUrls.length
          ? ` Dead/unhealthy endpoints found: ${selection.deadUrls.join("; ")}.`
          : "";
        if (dead) {
          res.status(502).json({ error: { code: "unavailable", message: `No healthy ACP agent named ${agent_name}.${dead}` } });
        } else {
          res.status(404).json({ error: { code: "not_found", message: `Unknown agent: ${agent_name}` } });
        }
        return;
      }
      const peer = selection.agent;
      const taskText = extractTaskText(input);
      if (!taskText.trim()) {
        return res.status(400).json({ error: { code: "invalid_task", message: "ACP task must be non-empty" } });
      }
      const context = resolveRunContext(res, {
        workspace_id,
        workspace_session_id,
        work_session_id,
        session_id,
        submittedBy: "acp",
        title: `${agent_name}: ${taskText.slice(0, 100)}`,
      });
      if (!context) return;
      const { session, workspaceRoot, createdSession } = context;
      if (!(await acquireCheckoutModifyLease(res, session.workspaceSessionId, workspaceRoot, session.id))) {
        if (createdSession) workSessions.updateStatus(session.id, "cancelled");
        return;
      }
      const workspaceLeaseNonce = workSessions.getWorkspaceLeaseForSession(session.id)?.leaseNonce;

      const run = agentRegistry.createRun({ agentName: agent_name, agentId: peer.id, workspaceSessionId: session.workspaceSessionId, workSessionId: session.id, inputPreview: taskText.slice(0, 500), webhookUrl: webhook_url, status: "running" });

      try {
        const peerResp = await dispatchToPeer({
          agentUrl: peer.url,
          adapterSecret: adapterSecret ?? sharedSecret,
          body: {
            agent_name,
            mode: mode ?? "async",
            input,
            session_id: session.id,
            work_session_id: session.id,
            workspace_session_id: session.workspaceSessionId,
            workspace_root: workspaceRoot,
            parent_run_id: run.runId,
            agent_id: peer.id,
            workspace_lease_nonce: workspaceLeaseNonce,
            webhook_url,
          },
          timeoutMs: DEFAULT_ACP_TIMEOUT,
        });
        const peerResult = peerResp.body;
        const remoteRunId = typeof peerResult.remote_run_id === "string"
          ? peerResult.remote_run_id
          : typeof peerResult.run_id === "string"
            ? peerResult.run_id
            : undefined;
        agentRegistry.updateRun(run.runId, {
          status: peerResp.status === 202 || peerResult.accepted === true ? "running" : "completed",
          remoteRunId,
          outputJson: serializeFinalAcpResult(peerResult),
          finishedAt: peerResp.status === 202 || peerResult.accepted === true ? undefined : new Date().toISOString(),
        });
        res.status(peerResp.status === 202 || mode === "async" ? 202 : 200).json({ ...peerResult, kontrol_run_id: run.runId, session_id: session.id });
      } catch (error) {
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
        res.status(502).json({ agent_name, run_id: run.runId, status: "failed", error: { message: `Peer routing failed: ${error instanceof Error ? error.message : String(error)}` }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
      }
      return;
    }

    // ── Local agent execution ──

    const taskText = extractTaskText(input);
    if (!taskText.trim()) {
      return res.status(400).json({ error: { code: "invalid_task", message: "ACP task must be non-empty" } });
    }
    const context = resolveRunContext(res, {
      workspace_id,
      workspace_session_id,
      work_session_id,
      session_id,
      submittedBy: "acp",
      title: `${agent_name}: ${taskText.slice(0, 100)}`,
    });
    if (!context) return;
    const { session, workspaceRoot, createdSession } = context;
    if (MUTATING_LOCAL_AGENTS.has(agent_name) && !(await acquireCheckoutModifyLease(res, session.workspaceSessionId, workspaceRoot, session.id))) {
      if (createdSession) workSessions.updateStatus(session.id, "cancelled");
      return;
    }

    const run = agentRegistry.createRun({ agentName: agent_name, workspaceSessionId: session.workspaceSessionId, workSessionId: session.id, inputPreview: taskText.slice(0, 500), webhookUrl: webhook_url, status: "in-progress" });

    // kontrol-review: enter awaiting
    if (agent_name === "kontrol-review") {
      agentRegistry.updateRun(run.runId, { status: "awaiting" });
      emitSse(run.runId, "run.awaiting", { run });

      if (mode === "stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        sseSubscribe(run.runId, req, res);
        res.write(`event: run.awaiting\ndata: ${JSON.stringify({ agent_name, run_id: run.runId, session_id: session.id, status: "awaiting", output: [], created_at: run.createdAt })}\n\n`);
        return;
      }
      res.status(mode === "async" ? 202 : 200).json({ agent_name, run_id: run.runId, session_id: session.id, status: "awaiting", output: [], created_at: run.createdAt });
      return;
    }

    // kontrol-agent-registry: list registered peers
    if (agent_name === "kontrol-agent-registry") {
      const alive = agentRegistry.listAlive();
      const output = `Discovered ${alive.length} peer(s):\n${alive.map((a) => `  ${a.name} [${a.role}] → ${a.url}${a.alive ? "" : " (stale)"}`).join("\n")}`;
      agentRegistry.updateRun(run.runId, { status: "completed", outputPreview: output, finishedAt: new Date().toISOString() });

      if (webhook_url) agentRegistry.enqueueWebhook(run.runId, webhook_url, { agent_name, run_id: run.runId, status: "completed", output: [{ role: "agent", parts: [{ content_type: "text/plain", content: output }] }] });

      res.status(mode === "async" ? 202 : 200).json({ agent_name, run_id: run.runId, session_id: session.id, status: "completed", output: [{ role: "agent", parts: [{ content_type: "text/plain", content: output }] }], created_at: run.createdAt, finished_at: new Date().toISOString() });
      return;
    }

    // kontrol-submit-work-to-webui: agent → WebUI review surface
    if (agent_name === "kontrol-submit-work-to-webui") {
      if (!reviewCheckpoints) {
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: "Review checkpoints are not available.", finishedAt: new Date().toISOString() });
        res.status(500).json({ agent_name, run_id: run.runId, status: "failed", error: { message: "Review checkpoints unavailable" }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
        return;
      }

      // P1 #3: enforce the reviewer's allowedNextActions on resubmission. A
      // reviewer that omitted "resubmit" cannot be bypassed by calling
      // kontrol-submit-work-to-webui again while changes_requested.
      const resubmitDecision = authorizeWorkSessionAction(workSessions, {
        workSessionId: session.id,
        tool: "kontrol-submit-work-to-webui",
      });
      if (!resubmitDecision.allowed) {
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: resubmitDecision.reason, finishedAt: new Date().toISOString() });
        res.status(403).json({ agent_name, run_id: run.runId, status: "failed", error: { message: resubmitDecision.reason ?? "Resubmission not permitted by the reviewer's allowedNextActions." }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
        return;
      }

      let wsRoot: string;
      try {
        wsRoot = workspaces.getWorkspace(session.workspaceSessionId).root;
      } catch {
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: "Workspace not found. Open a workspace via MCP first.", finishedAt: new Date().toISOString() });
        res.status(400).json({ agent_name, run_id: run.runId, status: "failed", error: { message: "Workspace not found" }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
        return;
      }

      try {
        // Capture the diff WITHOUT advancing the checkpoint. The checkpoint is
        // only committed AFTER the submission is persisted, so a failure between
        // capture and persistence cannot silently drop the diff (mirrors the
        // safe MCP path; P1 #2).
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId: session.workspaceSessionId,
          root: wsRoot,
          since: "work_session",
          workSessionId: session.id,
          markReviewed: false,
        });

        // Delegate the state transition to the authoritative workflow service.
        const submitted = reviewWorkflow
          ? reviewWorkflow.submitForReview({ workSessionId: session.id, diff: review.patch, message: taskText || review.result, summaryJson: JSON.stringify(review.summary), files: review.summary.files, changedFiles: review.files, additions: review.summary.additions, removals: review.summary.removals, snapshotKind: review.snapshotKind, snapshotRef: review.snapshotRef, snapshotCommit: review.snapshotCommit })
          : (() => {
              const s = workSessions.submitForReview({ workSessionId: session.id, diff: review.patch, message: taskText || review.result, summaryJson: JSON.stringify(review.summary), files: review.files, snapshotKind: review.snapshotKind, snapshotRef: review.snapshotRef, snapshotCommit: review.snapshotCommit });
              return { submissionId: s.id, submissionNumber: s.submissionNumber, diffSha256: s.diffSha256, reviewEpoch: s.reviewEpoch };
            })();

        // Advance the review baseline to the EXACT captured snapshot only after
        // the submission was persisted, so a crash cannot strand the diff.
        if (reviewWorkflow) {
          if (review.snapshot && typeof reviewCheckpoints.commitReviewedSnapshot === "function") {
            await reviewCheckpoints.commitReviewedSnapshot({ workspaceId: session.workspaceSessionId, root: wsRoot, workSessionId: session.id, snapshot: review.snapshot });
          } else {
            await reviewCheckpoints.commitReviewed({ workspaceId: session.workspaceSessionId, root: wsRoot, workSessionId: session.id, snapshotCommit: review.snapshotCommit });
          }
        }

        agentRegistry.updateRun(run.runId, { status: "awaiting", finishedAt: new Date().toISOString() });

        const card = {
          tool: "submit_for_review",
          workspaceId: session.workspaceSessionId,
          status: "awaiting_review",
          summary: { ...review.summary, submissionId: submitted.submissionId, sessionId: session.id, submissionNumber: submitted.submissionNumber, message: taskText || review.result, diffSha256: submitted.diffSha256, reviewEpoch: submitted.reviewEpoch, snapshotKind: review.snapshotKind, snapshotRef: review.snapshotRef },
          files: review.files,
          payload: { patch: review.patch },
        };

        // NOTE: The reviewWorkflow.submitForReview() call above already emits the
        // canonical `review.submitted` event with file stats. Do NOT emit a second
        // one here — that caused duplicate watcher activity and duplicate UI fetches.
        emitSse(run.runId, "run.submitted", { run, card });

        res.status(200).json({
          agent_name,
          run_id: run.runId,
          session_id: session.id,
          status: "awaiting_review",
          output: [{ role: "agent", parts: [{ content_type: "text/plain", content: `Submitted #${submitted.submissionNumber}: ${review.summary.files} file(s), +${review.summary.additions} -${review.summary.removals}. Awaiting WebUI sign-off (A-okay).` }] }],
          card,
          created_at: run.createdAt,
          finished_at: new Date().toISOString(),
        });
        return;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: errorMsg, finishedAt: new Date().toISOString() });
        res.status(500).json({ agent_name, run_id: run.runId, status: "failed", error: { message: errorMsg }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
        return;
      }
    }

    // Execute Kontrol tool with policy enforcement
    const wsCtx = resolveCwd(session.id);
    if (!wsCtx) {
      agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: "Workspace not found. Open a workspace via MCP first.", finishedAt: new Date().toISOString() });
      res.status(400).json({ agent_name, run_id: run.runId, status: "failed", error: { message: "Workspace not found" }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
      return;
    }

    try {
      const canonicalTool = ACP_TOOL_POLICY_NAMES[agent_name] ?? agent_name;
      const sessionDecision = authorizeWorkSessionAction(workSessions, {
        workSessionId: session.id,
        tool: canonicalTool,
        path: wsCtx.cwd,
      });
      if (!sessionDecision.allowed) {
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: sessionDecision.reason, finishedAt: new Date().toISOString() });
        res.status(403).json({ agent_name, run_id: run.runId, status: "failed", error: { message: sessionDecision.reason ?? `Tool "${agent_name}" denied by work-session policy.` }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
        return;
      }

      // Policy enforcement for ACP tools (kontrol-*)
      if (policyEnforcer) {
        const { allowed } = await policyEnforcer.enforce({
          principalId: session.id,
          principalRole: "worker",
          workspaceId: session.workspaceSessionId,
          workSessionId: session.id,
          runId: run.runId,
          tool: canonicalTool,
          path: wsCtx.cwd, // working dir for shell tools
          signal: requestSignal,
        });
        if (!allowed) {
          agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: `Tool "${agent_name}" denied by policy.`, finishedAt: new Date().toISOString() });
          res.status(403).json({ agent_name, run_id: run.runId, status: "failed", error: { message: `Tool "${agent_name}" denied by policy.` }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
          return;
        }
      }

      const output = await executeKontrolTool(agent_name, taskText, wsCtx.cwd, wsCtx.root);
      agentRegistry.updateRun(run.runId, { status: "completed", outputPreview: output.slice(0, 2000), finishedAt: new Date().toISOString() });

      workSessions.logToolEvent({ workSessionId: session.id, workspaceSessionId: session.workspaceSessionId, tool: agent_name, inputJson: taskText, outputSummary: output.slice(0, 500), success: true, elapsedMs: 0 });

      if (webhook_url) agentRegistry.enqueueWebhook(run.runId, webhook_url, { agent_name, run_id: run.runId, status: "completed", output: [{ role: "agent", parts: [{ content_type: "text/plain", content: output }] }] });

      if (mode === "stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(`event: run.completed\ndata: ${JSON.stringify({ agent_name, run_id: run.runId, status: "completed", output: [{ role: "agent", parts: [{ content_type: "text/plain", content: output }] }] })}\n\n`);
        res.end();
        return;
      }

      res.status(mode === "async" ? 202 : 200).json({ agent_name, run_id: run.runId, session_id: session.id, status: "completed", output: [{ role: "agent", parts: [{ content_type: "text/plain", content: output }] }], created_at: run.createdAt, finished_at: new Date().toISOString() });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: errorMsg, finishedAt: new Date().toISOString() });

      if (webhook_url) agentRegistry.enqueueWebhook(run.runId, webhook_url, { agent_name, run_id: run.runId, status: "failed", error: { message: errorMsg } });

      res.status(500).json({ agent_name, run_id: run.runId, status: "failed", error: { message: errorMsg }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
    }
  });

  // GET /runs/{run_id}
  router.get("/runs/:run_id", (req, res) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;
    const run = agentRegistry.getRun(req.params.run_id);
    if (!run) { res.status(404).json({ error: { code: "not_found", message: "Run not found" } }); return; }
    res.json({
      agent_name: run.agentName,
      run_id: run.runId,
      session_id: run.workSessionId,
      status: run.status,
      output: run.outputJson ? JSON.parse(run.outputJson).output ?? [] : [],
      error: run.errorMessage ? { message: run.errorMessage } : undefined,
      created_at: run.createdAt,
      finished_at: run.finishedAt,
    });
  });

  // POST /runs/{run_id} — resume an awaiting run (submit feedback)
  router.post("/runs/:run_id", async (req, res) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;

    const run = agentRegistry.getRun(req.params.run_id);
    if (!run) { res.status(404).json({ error: { code: "not_found", message: "Run not found" } }); return; }

    // Accept both the legacy await_resume envelope and flat fields. The work
    // session is identified by work_session_id (NOT the run's session_id field
    // which is overloaded elsewhere).
    const body = req.body as {
      await_resume?: { session_id?: string; submission_id?: string; diff_sha256?: string; review_epoch?: number; verdict?: string; comments?: string };
      work_session_id?: string;
      submission_id?: string;
      diff_sha256?: string;
      review_epoch?: number;
      verdict?: string;
      comments?: string;
      mode?: string;
    };
    const awaitResume = body.await_resume;
    const sessionId = body.work_session_id ?? awaitResume?.session_id;
    const submissionId = body.submission_id ?? awaitResume?.submission_id;
    const diffSha256 = body.diff_sha256 ?? awaitResume?.diff_sha256;
    const reviewEpoch = body.review_epoch ?? awaitResume?.review_epoch;
    const verdict = body.verdict ?? awaitResume?.verdict;
    const comments = body.comments ?? awaitResume?.comments;
    const mode = body.mode;

    if (!sessionId || !verdict) {
      res.status(400).json({ error: { code: "invalid_input", message: "work_session_id and verdict are required" } });
      return;
    }

    const allowedVerdicts = ["approve", "changes_requested", "reject"];
    if (!allowedVerdicts.includes(verdict)) {
      res.status(400).json({ error: { code: "invalid_input", message: `verdict must be one of: ${allowedVerdicts.join(", ")}` } });
      return;
    }

    // The run must belong to the session being reviewed; a mismatched run/session
    // is rejected (guards against cross-session feedback).
    if (run.workSessionId && run.workSessionId !== sessionId) {
      res.status(409).json({ error: { code: "conflict", message: "run does not belong to this work session" } });
      return;
    }

    if (!reviewWorkflow) {
      res.status(500).json({ error: { code: "server_error", message: "Review workflow is unavailable" } });
      return;
    }

    try {
      const result = await reviewWorkflow.provideFeedback({
        sessionId,
        submissionId: submissionId ?? "",
        diffSha256,
        reviewEpoch,
        verdict: verdict as "approve" | "changes_requested" | "reject",
        comments,
      });

      // NOTE: All canonical lifecycle events (continuation.created,
      // agent.run.approved, agent.run.rejected) are emitted INSIDE the workflow
      // transaction. Do NOT emit duplicates here.

      // Never report "completed" merely because feedback was accepted.
      evaluateCompletionOnFeedback(run.runId, sessionId, result.status);
      emitSse(run.runId, `run.${result.status}`, { run_id: run.runId, status: result.status });

      res.status(mode === "async" ? 202 : 200).json({
        agent_name: run.agentName,
        run_id: run.runId,
        status: result.status,
        output: [{ role: "agent", parts: [{ content_type: "text/plain", content: `Feedback submitted: ${verdict}` }] }],
        created_at: run.createdAt,
        finished_at: new Date().toISOString(),
      });
    } catch (error) {
      const status = error instanceof Error && "httpStatus" in error ? (error as { httpStatus: number }).httpStatus : 500;
      const message = error instanceof Error ? error.message : "Failed";
      res.status(status).json({ error: { code: "server_error", message } });
      return;
    }
  });

  // Reflect the feedback verdict onto the correlated run. Terminal verdicts are
  // terminal; changes_requested keeps the run alive for the resumed worker.
  function evaluateCompletionOnFeedback(runId: string, _sessionId: string, status: string): void {
    if (status === "approved" || status === "rejected" || status === "cancelled" || status === "failed") {
      agentRegistry.updateRun(runId, { status, finishedAt: new Date().toISOString() });
    } else {
      agentRegistry.updateRun(runId, { status });
    }
  }

  // POST /runs/{run_id}/cancel
  router.post("/runs/:run_id/cancel", async (req, res) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;
    const run = agentRegistry.getRun(req.params.run_id);
    if (!run) {
      res.status(404).json({ error: { code: "not_found", message: "Run not found" } });
      return;
    }
    const workSessionId = run.workSessionId;
    // Resolve the correlated work session and delegate to the authoritative
    // workflow. Cancellation first enters `cancelling`; the checkout lease and
    // logical run remain fenced until the worker reports that it actually
    // stopped.
    let remoteCancellation: Awaited<ReturnType<typeof cancelRemoteRun>> | undefined;
    if (workSessionId && reviewWorkflow) {
      try {
        await reviewWorkflow.cancelSession({ sessionId: workSessionId, reason: "cancelled via ACP" });
      } catch (error) {
        const status = error instanceof Error && "httpStatus" in error ? (error as { httpStatus: number }).httpStatus : 500;
        // A 4xx (e.g. already terminal) is not fatal; a 5xx is.
        if (status >= 500) {
          res.status(status).json({ error: { code: "server_error", message: error instanceof Error ? error.message : "Failed" } });
          return;
        }
      }
    } else {
      agentRegistry.updateRun(run.runId, { status: "cancelling" });
      if (workSessionId) {
        eventStore?.appendEvent({
          type: "agent.run.cancellation_requested",
          sessionId: workSessionId,
          payload: { runId: run.runId, reason: "cancelled via ACP" },
        });
      }
    }
    remoteCancellation = await cancelRemoteRun(
      { agentRegistry, workspaces, workSessions, adapterSecret: adapterSecret ?? sharedSecret },
      run,
    );
    if (workSessionId && reviewWorkflow && (!run.remoteRunId || (!remoteCancellation.acknowledged && remoteCancellation.status === 404))) {
      await reviewWorkflow.finalizeCancellation({ sessionId: workSessionId, reason: "no live worker remained" });
    }
    const finalRun = agentRegistry.getRun(run.runId);
    emitSse(run.runId, "run.cancelled", { run_id: run.runId, status: finalRun?.status ?? "cancelling" });
    res.status(202).json({ run_id: run.runId, status: finalRun?.status ?? "cancelling", remote_cancellation: remoteCancellation, output: [], created_at: run.createdAt, finished_at: finalRun?.finishedAt });
  });

  // GET /runs — list runs
  router.get("/runs", (req, res) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;
    const workspaceId = req.query.workspace_id as string | undefined;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const runs = agentRegistry.listRuns(workspaceId, limit);
    res.json({ runs });
  });
}
