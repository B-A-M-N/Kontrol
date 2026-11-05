/**
 * Unified read-only result projection: `get_work_result`.
 *
 * One authenticated, read-only tool that answers "what happened to this
 * dispatched work?" from the existing durable stores only — work session,
 * ACP run + dispatch attempt, review submission/feedback, agent messages
 * and replies, tool activity, event tail, mission receipt, supervisor run,
 * and checkout lease. It never dispatches, mutates, releases leases, or
 * advances review state, so it is safe to call repeatedly for polling,
 * reconnect recovery, and cross-session inspection (subject to the same
 * per-session read gate as get_work_session).
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { BridgeConfig } from "./context.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { requireWorkSessionRead } from "./shared.js";
import { workSessionTerminalOutcome } from "../work-session-lifecycle.js";
import { z } from "zod/v4";

function parseJsonSafe(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function projectWorkResult(config: BridgeConfig, sessionId: string, options: { includePatch?: boolean; eventLimit?: number } = {}) {
  const session = config.workSessions.get(sessionId);
  if (!session) return undefined;

  const run = config.agentRegistry.getRunByWorkSessionId(sessionId);
  const dispatchAttempt = run
    ? config.agentRegistry.getLatestDispatchAttemptForRun(run.runId)
    : undefined;
  const agentInfo = run?.agentId ? config.agentRegistry.get(run.agentId) : undefined;

  const dispatchStatus: string = !run
    ? "not_dispatched"
    : dispatchAttempt?.status === "accepted"
      ? "accepted"
      : dispatchAttempt?.status === "uncertain" || dispatchAttempt?.status === "dispatching" || run.status === "dispatch_uncertain"
        ? "uncertain"
        : dispatchAttempt?.status === "failed"
          ? "failed"
          : run.status;

  const submissions = config.workSessions.getSubmissions(sessionId);
  const latestSubmission = submissions[submissions.length - 1];
  const latestFeedback = config.workSessions.getLatestFeedback(sessionId);
  const feedbackCount = config.workSessions.countFeedback(sessionId);

  const messages = config.agentMessages?.list(sessionId) ?? [];
  const replies = config.agentMessages?.listReplies(sessionId) ?? [];

  const toolActivity = config.workSessions.getToolEvents(sessionId, 20).map((e) => ({
    tool: e.tool,
    path: e.path,
    success: e.success,
    outputSummary: e.outputSummary,
    createdAt: e.createdAt,
  }));

  const events = config.eventStore.getEventsForSession(sessionId);
  const eventLimit = Math.min(Math.max(options.eventLimit ?? 20, 1), 100);
  const recentEvents = events.slice(-eventLimit).map((e) => ({
    seq: e.seq,
    id: e.id,
    type: e.type,
    createdAt: e.createdAt,
  }));
  const lastSeq = events.length ? events[events.length - 1].seq : 0;
  const terminalEvent = [...events].reverse().find((e) => workSessionTerminalOutcome(e.type, session.completionPolicy));
  const terminalOutcome = terminalEvent ? workSessionTerminalOutcome(terminalEvent.type, session.completionPolicy) : undefined;

  const lease = config.workSessions.getWorkspaceLeaseForSession(sessionId);
  const leaseActive = lease ? Date.parse(lease.expiresAt) > Date.now() : false;

  const supervisor = config.supervisorRuns?.getByWorkSession(sessionId);
  const mission = config.missionLedger?.getMissionByWorkSession(sessionId);
  const missionReceipt = config.missionLedger?.getResultReceipt(sessionId);

  const submissionSummary = latestSubmission ? parseJsonSafe(latestSubmission.summaryJson) : {};
  const failures: Array<{ source: string; message: string }> = [];
  if (run?.errorMessage) failures.push({ source: "run", message: run.errorMessage });
  if (supervisor?.lastError) failures.push({ source: "supervisor", message: supervisor.lastError });
  for (const e of events) {
    if (e.type === "agent.run.failed" || e.type === "agent.dispatch.failed" || e.type === "agent.run.failed_protocol") {
      const reason = typeof e.payload?.reason === "string" ? e.payload.reason : typeof e.payload?.error === "string" ? e.payload.error : "worker failed";
      failures.push({ source: e.type, message: reason });
    }
  }

  return {
    session: {
      sessionId: session.id,
      workspaceSessionId: session.workspaceSessionId,
      status: session.status,
      lifecycle: session.lifecycle,
      runtimeState: session.runtimeState,
      completionPolicy: session.completionPolicy,
      title: session.title,
      submittedBy: session.submittedBy,
      reviewEpoch: session.reviewEpoch,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
    run: run ? {
      runId: run.runId,
      remoteRunId: run.remoteRunId,
      agentName: run.agentName,
      agentId: run.agentId,
      status: run.status,
      attemptNumber: run.attemptNumber,
      errorMessage: run.errorMessage,
      outputPreview: run.outputPreview,
      lastHeartbeatAt: run.lastHeartbeatAt,
      workerLeaseUntil: run.workerLeaseUntil,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      agentAlive: agentInfo?.alive,
    } : undefined,
    dispatch: {
      status: dispatchStatus,
      idempotencyKey: dispatchAttempt?.dispatchIdempotencyKey,
      attemptStatus: dispatchAttempt?.status,
      remoteRunId: dispatchAttempt?.remoteRunId ?? run?.remoteRunId,
    },
    submissions: {
      count: submissions.length,
      latest: latestSubmission ? {
        submissionId: latestSubmission.id,
        submissionNumber: latestSubmission.submissionNumber,
        status: latestSubmission.status,
        diffSha256: latestSubmission.diffSha256,
        snapshotKind: latestSubmission.snapshotKind,
        snapshotRef: latestSubmission.snapshotRef,
        snapshotCommit: latestSubmission.snapshotCommit,
        reviewEpoch: latestSubmission.reviewEpoch,
        message: latestSubmission.message,
        additions: typeof submissionSummary.additions === "number" ? submissionSummary.additions : latestSubmission.additions,
        removals: typeof submissionSummary.removals === "number" ? submissionSummary.removals : latestSubmission.removals,
        fileCount: latestSubmission.files?.length,
        patch: options.includePatch ? latestSubmission.diff : undefined,
      } : undefined,
    },
    review: {
      feedbackCount,
      latestFeedback: latestFeedback ? {
        feedbackId: latestFeedback.id,
        submissionId: latestFeedback.submissionId,
        verdict: latestFeedback.verdict,
        comments: latestFeedback.comments,
        reviewerId: latestFeedback.reviewerId,
        createdAt: latestFeedback.createdAt,
      } : undefined,
      submissionStatus: latestSubmission?.status,
    },
    messages: messages.map((m) => ({
      messageId: m.id,
      kind: m.kind,
      author: m.author,
      title: m.title,
      body: m.body,
      status: m.status,
      runId: m.runId,
      createdAt: m.createdAt,
    })),
    replies: replies.map((r) => ({
      replyId: r.id,
      messageId: r.messageId,
      replyRevision: r.replyRevision,
      body: r.body,
      status: r.status,
      createdAt: r.createdAt,
      acknowledgedAt: r.acknowledgedAt,
    })),
    toolActivity,
    events: { lastSeq, recent: recentEvents },
    mission: mission ? {
      missionId: mission.id,
      objective: mission.objective,
      outcomeEvidence: mission.outcomeEvidence,
      approval: missionReceipt?.approval,
      requiredEvidenceLevel: missionReceipt?.requiredEvidenceLevel,
      verificationEvidenceIds: missionReceipt?.verificationEvidenceIds,
      outcomeObservationIds: missionReceipt?.outcomeObservationIds,
      completionReport: missionReceipt?.completionReport ? { status: missionReceipt.completionReport.status } : undefined,
    } : undefined,
    supervisor: supervisor ? {
      supervisorId: supervisor.id,
      status: supervisor.status,
      revision: supervisor.revision,
      autonomyMode: supervisor.autonomyMode,
      approvalMode: supervisor.approvalMode,
      lastError: supervisor.lastError,
      deadlineAt: supervisor.deadlineAt,
    } : undefined,
    lease: lease ? {
      active: leaseActive,
      workSessionId: lease.workSessionId,
      expiresAt: lease.expiresAt,
      hasNonce: Boolean(lease.leaseNonce),
    } : undefined,
    outcome: {
      terminal: Boolean(terminalOutcome),
      successful: terminalOutcome?.successful,
      status: terminalOutcome?.status ?? session.status,
      terminalEventType: terminalEvent?.type,
    },
    failures,
  };
}

export function registerWorkResultTools(server: McpServer, config: BridgeConfig): void {
  registerAppTool(
    server,
    "get_work_result",
    {
      title: "Get work result",
      description: "Unified read-only projection of a dispatched work session: run and dispatch status (including uncertain acceptance), latest submission and diff identity, review feedback, worker messages and replies, tool activity, event tail, mission/supervisor state, lease state, failures, and final outcome. Read-only; safe to poll and to use after reconnect. Use await_work_session_events after lastSeq for live updates.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID."),
        workSessionId: z.string().optional().describe("Alias for sessionId."),
        includePatch: z.boolean().optional().default(false).describe("Include the latest submission patch text. Default false; prefer the diff identity for polling."),
        eventLimit: z.number().int().min(1).max(100).optional().default(20).describe("How many recent events to include in the tail."),
      },
      outputSchema: {
        session: z.object({
          sessionId: z.string(),
          workspaceSessionId: z.string(),
          status: z.string(),
          lifecycle: z.string(),
          runtimeState: z.string(),
          completionPolicy: z.string(),
          title: z.string().optional(),
          submittedBy: z.string(),
          reviewEpoch: z.number(),
          createdAt: z.string(),
          updatedAt: z.string(),
        }),
        run: z.object({
          runId: z.string(),
          remoteRunId: z.string().optional(),
          agentName: z.string(),
          agentId: z.string().optional(),
          status: z.string(),
          attemptNumber: z.number(),
          errorMessage: z.string().optional(),
          outputPreview: z.string().optional(),
          lastHeartbeatAt: z.string().optional(),
          workerLeaseUntil: z.string().optional().nullable(),
          createdAt: z.string(),
          finishedAt: z.string().optional().nullable(),
          agentAlive: z.boolean().optional(),
        }).optional(),
        dispatch: z.object({
          status: z.string(),
          idempotencyKey: z.string().optional(),
          attemptStatus: z.string().optional(),
          remoteRunId: z.string().optional(),
        }),
        submissions: z.object({
          count: z.number(),
          latest: z.object({
            submissionId: z.string(),
            submissionNumber: z.number(),
            status: z.string(),
            diffSha256: z.string().optional(),
            snapshotKind: z.string().optional(),
            snapshotRef: z.string().optional(),
            snapshotCommit: z.string().optional(),
            reviewEpoch: z.number(),
            message: z.string().optional(),
            additions: z.number().optional(),
            removals: z.number().optional(),
            fileCount: z.number().optional(),
            patch: z.string().optional(),
          }).optional(),
        }),
        review: z.object({
          feedbackCount: z.number(),
          latestFeedback: z.object({
            feedbackId: z.string(),
            submissionId: z.string(),
            verdict: z.string(),
            comments: z.string().optional(),
            reviewerId: z.string().optional(),
            createdAt: z.string(),
          }).optional(),
          submissionStatus: z.string().optional(),
        }),
        messages: z.array(z.object({
          messageId: z.string(),
          kind: z.string(),
          author: z.string(),
          title: z.string().optional(),
          body: z.string().optional(),
          status: z.string(),
          runId: z.string().optional(),
          createdAt: z.string(),
        })),
        replies: z.array(z.object({
          replyId: z.string(),
          messageId: z.string(),
          replyRevision: z.number(),
          body: z.string(),
          status: z.string(),
          createdAt: z.string(),
          acknowledgedAt: z.string().optional(),
        })),
        toolActivity: z.array(z.object({
          tool: z.string(),
          path: z.string().optional(),
          success: z.boolean(),
          outputSummary: z.string().optional(),
          createdAt: z.string(),
        })),
        events: z.object({
          lastSeq: z.number(),
          recent: z.array(z.object({ seq: z.number(), id: z.string(), type: z.string(), createdAt: z.string() })),
        }),
        mission: z.object({
          missionId: z.string(),
          objective: z.string().optional(),
          outcomeEvidence: z.string().optional(),
          approval: z.object({ allowed: z.boolean(), reasons: z.array(z.string()) }).optional(),
          requiredEvidenceLevel: z.string().optional(),
          verificationEvidenceIds: z.array(z.string()).optional(),
          outcomeObservationIds: z.array(z.string()).optional(),
          completionReport: z.object({ status: z.string() }).optional(),
        }).optional(),
        supervisor: z.object({
          supervisorId: z.string(),
          status: z.string(),
          revision: z.number(),
          autonomyMode: z.string(),
          approvalMode: z.string(),
          lastError: z.string().optional(),
          deadlineAt: z.string().optional(),
        }).optional(),
        lease: z.object({
          active: z.boolean(),
          workSessionId: z.string(),
          expiresAt: z.string(),
          hasNonce: z.boolean(),
        }).optional(),
        outcome: z.object({
          terminal: z.boolean(),
          successful: z.boolean().optional(),
          status: z.string(),
          terminalEventType: z.string().optional(),
        }),
        failures: z.array(z.object({ source: z.string(), message: z.string() })),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, workSessionId, includePatch, eventLimit }) => {
      const target = sessionId ?? workSessionId;
      if (!target) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      const access = requireWorkSessionRead(config, target);
      if (access) return access;
      const projection = projectWorkResult(config, target, { includePatch, eventLimit });
      if (!projection) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      const text = [
        `Work result for ${projection.session.sessionId}: status=${projection.session.status} dispatch=${projection.dispatch.status} outcome=${projection.outcome.status} terminal=${projection.outcome.terminal}.`,
        projection.run ? `Run ${projection.run.runId} (${projection.run.agentName}) status=${projection.run.status} attempt=${projection.run.attemptNumber}.` : "No run dispatched yet.",
        projection.submissions.latest ? `Latest submission #${projection.submissions.latest.submissionNumber} (${projection.submissions.latest.status}) diff=${projection.submissions.latest.diffSha256 ?? "unknown"}.` : "No submissions yet.",
        projection.failures.length ? `Failures: ${projection.failures.map((f) => `${f.source}: ${f.message}`).join("; ")}` : "No failures recorded.",
      ].join("\n");
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: projection,
      };
    },
  );
}
