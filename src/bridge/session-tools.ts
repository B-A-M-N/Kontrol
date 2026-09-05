/**
 * Work-session lifecycle, inspection, surface, handoff and cancellation tools
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig } from "./context.js";
import { cancelRemoteRun, selectHealthyAgent } from "../acp-gateway.js";
import { TERMINAL_STATUSES } from "../review-workflow.js";
import { registerMutationAppTool } from "./app-tool.js";
import { assertWorkerSessionBinding, forbidden, isReviewer, requireWorkSessionRead, workspaceAppModelAndAppMeta } from "./shared.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod/v4";

export function registerSessionTools(server: McpServer, config: BridgeConfig): void {
  registerMutationAppTool(
    server,
    "start_work_session",
    {
      title: "Start work session",
      description: "Create a work session linked to the current workspace. Enables auto-tracking of tool calls. Returns a sessionId. After submit_for_review, call await_review_feedback IMMEDIATELY (event-driven, blocks until feedback) — do NOT poll. check_review_status is a recovery-only fallback.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier from open_workspace."),
        title: z.string().optional().describe("Optional title for this session."),
        completionPolicy: z.enum(["agent_completion", "webui_approval_required"]).optional().describe("Completion policy. Use webui_approval_required for Ralph/WebUI-reviewed work."),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: { sessionId: z.string(), status: z.string() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ workspaceId, title, completionPolicy }) => {
      try {
        config.workspaces.getWorkspace(workspaceId);
        const session = config.workSessions.create({ workspaceSessionId: workspaceId, submittedBy: "cli", title, completionPolicy });
        config.workspaces.setActiveSession(workspaceId, session.id);
        return {
          content: [{ type: "text" as const, text: `Session ${session.id} active. Tool calls will be logged. Use submit_for_review when ready.` }],
          structuredContent: { sessionId: session.id, status: "in_progress" },
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Failed" }], isError: true };
      }
    },
  );

  registerAppTool(
    server,
    "get_work_session",
    {
      title: "Get work session",
      description: "Read the current state of a work session including status, submissions, feedback history, and tool events. Use for recovery, sanity checks, or inspecting session state.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID."),
      },
      outputSchema: {
        sessionId: z.string(),
        status: z.string(),
        submittedBy: z.string(),
        title: z.string().optional(),
        submissionCount: z.number(),
        feedbackCount: z.number(),
        latestSubmission: z.object({
          submissionNumber: z.number(),
          message: z.string().optional(),
          status: z.string(),
          createdAt: z.string(),
        }).optional(),
        latestFeedback: z.object({
          verdict: z.string(),
          comments: z.string().optional(),
          requiredActions: z.array(z.string()).optional(),
          allowedNextActions: z.array(z.string()).optional(),
          createdAt: z.string(),
        }).optional(),
        toolEvents: z.array(z.object({
          tool: z.string(),
          path: z.string().optional(),
          summary: z.string().optional(),
          success: z.boolean(),
          createdAt: z.string(),
        })),
        createdAt: z.string(),
        updatedAt: z.string(),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }) => {
      const access = requireWorkSessionRead(config, sessionId);
      if (access) return access;
      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };

      const submissions = config.workSessions.getSubmissions(sessionId);
      const feedbackCount = config.workSessions.countFeedback(sessionId);
      const lf = session.latestFeedback;

      const latestFeedbackStructured = lf ? {
        verdict: lf.verdict,
        comments: lf.comments,
        requiredActions: lf.requiredActionsJson ? JSON.parse(lf.requiredActionsJson) as string[] : undefined,
        allowedNextActions: lf.allowedNextActionsJson ? JSON.parse(lf.allowedNextActionsJson) as string[] : undefined,
        createdAt: lf.createdAt,
      } : undefined;

      const latestSub = session.latestSubmission;
      const text = [
        `Session: ${session.id}`,
        `Status: ${session.status}`,
        `Submitted by: ${session.submittedBy}`,
        session.title ? `Title: ${session.title}` : null,
        `Submissions: ${submissions.length}, Feedback: ${feedbackCount}`,
        latestSub ? `Latest submission #${latestSub.submissionNumber} (${latestSub.status}) at ${latestSub.createdAt}` : null,
        lf ? `Latest feedback: ${lf.verdict} at ${lf.createdAt}` : null,
        lf?.comments ? `Comments: ${lf.comments}` : null,
      ].filter(Boolean).join("\n");

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          sessionId: session.id,
          status: session.status,
          submittedBy: session.submittedBy,
          title: session.title,
          submissionCount: submissions.length,
          feedbackCount,
          latestSubmission: latestSub ? {
            submissionNumber: latestSub.submissionNumber,
            message: latestSub.message,
            status: latestSub.status,
            createdAt: latestSub.createdAt,
          } : undefined,
          latestFeedback: latestFeedbackStructured,
          toolEvents: config.workSessions.getToolEvents(sessionId, 20).map((e) => ({
            tool: e.tool,
            path: e.path,
            summary: e.outputSummary,
            success: e.success,
            createdAt: e.createdAt,
          })),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
      };
    },
  );

  registerAppTool(
    server,
    "get_work_session_snapshot",
    {
      title: "Get work session snapshot",
      description: "Return a compact projection of a work session's current state (status, workspace, latest submission/feedback, mission summary, last event seq) so the WebUI reviewer can hydrate without replaying the event log. The caller should then call await_work_session_events with afterSeq = snapshot.lastSeq to receive only new activity.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID to snapshot."),
      },
      outputSchema: {
        sessionId: z.string(),
        workspaceSessionId: z.string(),
        status: z.string(),
        title: z.string().optional(),
        submittedBy: z.string(),
        runId: z.string().optional(),
        lastHeartbeatAt: z.string().optional(),
        submissionCount: z.number(),
        lastSeq: z.number(),
        updatedAt: z.string(),
        latestSubmission: z.object({
          submissionId: z.string(),
          submissionNumber: z.number(),
          status: z.string(),
          additions: z.number(),
          removals: z.number(),
          diffSha256: z.string().optional(),
          reviewEpoch: z.number().optional(),
        }).optional(),
        latestFeedback: z.object({
          id: z.string(),
          submissionId: z.string().optional(),
          verdict: z.string(),
          comments: z.string().optional(),
          reviewerId: z.string().optional(),
        }).optional(),
        recentActivity: z.array(z.object({
          id: z.string(),
          seq: z.number(),
          durable: z.boolean().optional(),
          type: z.string(),
          sessionId: z.string(),
          workspaceSessionId: z.string().optional(),
          payload: z.record(z.string(), z.unknown()),
          createdAt: z.string(),
        })).optional(),
        hasMission: z.boolean(),
        missionSummary: z.object({
          objective: z.string().optional(),
          status: z.string().optional(),
          cycleNumber: z.number().optional(),
          maxCycles: z.number().optional(),
        }).optional(),
        pendingApprovals: z.array(z.object({
          approvalId: z.string(),
          kind: z.string().optional(),
          title: z.string().optional(),
          description: z.string().optional(),
          risk: z.string().optional(),
          tool: z.string().optional(),
          path: z.string().optional(),
          command: z.string().optional(),
          origin: z.enum(["direct_mcp", "work_session"]).optional(),
          conversationId: z.string().optional(),
          orphanedAt: z.string().optional(),
          reattachDeadline: z.string().optional(),
          liveWaiterCount: z.number().optional(),
          requestedAt: z.string().optional(),
          createdAt: z.string().optional(),
          expiresAt: z.string().optional(),
          options: z.array(z.object({
            id: z.string(),
            label: z.string(),
            effect: z.enum(["approve", "deny", "changes_requested"]),
            scope: z.enum(["once", "work_session", "workspace"]).optional(),
          })).optional(),
        })).optional(),
        agentMessages: z.array(z.object({
          messageId: z.string(),
          kind: z.string(),
          author: z.string().optional(),
          title: z.string().optional(),
          body: z.string().optional(),
          status: z.string().optional(),
          runId: z.string().optional(),
          createdAt: z.string().optional(),
        })).optional(),
        lastEventSeq: z.number().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }) => {
      const startedAt = performance.now();
      try {
        const access = requireWorkSessionRead(config, sessionId);
        if (access) return access;
        const buildSnapshot = () => {
      const session = config.workSessions.get(sessionId);
      if (!session) {
        return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      }
      const run = config.agentRegistry.getRunByWorkSessionId(sessionId);
      const latestSubmission = session.latestSubmission;
      const latestFeedback = session.latestFeedback;

      // Mission detection: check the mission ledger rather than calling inspect_supervised_work.
      let hasMission = false;
      let missionSummary: { objective?: string; status?: string; cycleNumber?: number; maxCycles?: number } | undefined;
      if (config.missionLedger) {
        const mission = config.missionLedger.getMissionByWorkSession(sessionId);
        if (mission) {
          hasMission = true;
          const supervisor = config.supervisorRuns?.getByWorkSession(sessionId);
          missionSummary = {
            objective: mission.objective,
            status: supervisor?.status,
            cycleNumber: supervisor?.cycleNumber,
            maxCycles: supervisor?.maxCycles,
          };
        }
      }

      // Get the last event seq for this session so the client can resume from there.
      const lastEvent = config.eventStore.getLatestEvent(sessionId);
      const lastSeq = lastEvent?.seq ?? 0;
      // Keep a bounded, durable activity tail in the snapshot. The live
      // watcher starts strictly after lastSeq, so reconnecting restores the
      // visible timeline without replaying or duplicating this tail.
      const recentActivity = lastSeq > 0
        ? config.eventStore.getEventsAfter(sessionId, Math.max(0, lastSeq - 50), 50)
        : [];

      // P0 #6: Expand snapshot to include pending approvals and agent messages
      const pendingApprovals = config.approvalRequests
        ? config.approvalRequests.listPending(session.workspaceSessionId).filter((a) => a.workSessionId === sessionId).map((a) => ({
            approvalId: a.approvalId,
            kind: a.kind,
            title: a.title,
            description: a.description,
            risk: a.risk,
            tool: a.tool,
            path: a.path,
            command: a.command,
            origin: a.origin,
            conversationId: a.conversationId,
            orphanedAt: a.orphanedAt,
            reattachDeadline: a.reattachDeadline,
            liveWaiterCount: a.liveWaiterCount,
            requestedAt: a.createdAt,
            createdAt: a.createdAt,
            expiresAt: a.expiresAt,
            options: a.options,
          }))
        : [];
      const agentMessages = config.agentMessages
        ? config.agentMessages.list(sessionId).filter((m) => m.status === "open").map((m) => ({
            messageId: m.id,
            kind: m.kind,
            author: m.author,
            title: m.title,
            body: m.body,
            status: m.status,
            runId: m.runId,
            createdAt: m.createdAt,
          }))
        : [];

      return {
        content: [{ type: "text" as const, text: `Snapshot for session ${sessionId}: status=${session.status}, submissions=${session.latestSubmission ? "yes" : "no"}, lastSeq=${lastSeq}.` }],
        structuredContent: {
          sessionId: session.id,
          workspaceSessionId: session.workspaceSessionId,
          status: session.status,
          title: session.title,
          submittedBy: session.submittedBy,
          runId: run?.runId,
          lastHeartbeatAt: run?.lastHeartbeatAt ?? undefined,
          submissionCount: config.workSessions.getSubmissions(sessionId).length,
          lastSeq,
          updatedAt: session.updatedAt,
          latestSubmission: latestSubmission ? {
            submissionId: latestSubmission.id,
            submissionNumber: latestSubmission.submissionNumber,
            status: latestSubmission.status,
            additions: latestSubmission.additions ?? 0,
            removals: latestSubmission.removals ?? 0,
            diffSha256: latestSubmission.diffSha256 ?? undefined,
            reviewEpoch: latestSubmission.reviewEpoch ?? undefined,
          } : undefined,
          latestFeedback: latestFeedback ? {
            id: latestFeedback.id,
            submissionId: latestFeedback.submissionId,
            verdict: latestFeedback.verdict,
            comments: latestFeedback.comments ?? undefined,
            reviewerId: latestFeedback.reviewerId ?? undefined,
          } : undefined,
          recentActivity,
          hasMission,
          missionSummary,
          // P0 #6: Include pending approvals and agent messages for full recovery
          pendingApprovals,
          agentMessages,
          // Alias makes the cursor contract explicit to clients that use the
          // event-sourced terminology from the reliability protocol.
          lastEventSeq: lastSeq,
        },
        };
      };
      // All projection reads and the event cursor use the same SQLite
      // connection and transaction. This closes the fetch-vs-subscribe race:
      // the cursor is the exact boundary of the state returned above.
        return config.db
          ? config.db.sqlite.transaction(buildSnapshot)()
          : buildSnapshot();
      } finally {
        config.onPhaseTiming?.("workspace.snapshot_query", performance.now() - startedAt);
      }
    },
  );

  registerAppTool(
    server,
    "get_workspace_session_surface",
    {
      title: "Get workspace session surface",
      description: "Return a compact batch projection for the workspace session picker. It includes current lifecycle, review identity, pending counts, and event cursors without loading diffs or replaying event history. Fetch get_work_session_snapshot lazily for the selected session.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID to scope the session surface."),
        limit: z.number().int().min(1).max(200).optional().default(50),
        filter: z.enum(["all", "pending_review", "stale_pending_review", "live"]).optional().default("all"),
        afterUpdatedAt: z.string().optional().describe("Return sessions strictly older than this updatedAt cursor."),
        afterSessionId: z.string().optional().describe("Tie-breaker for afterUpdatedAt; use the last sessionId from the previous page."),
      },
      outputSchema: {
        lastSeq: z.number(),
        sessions: z.array(z.object({
          sessionId: z.string(),
          workspaceSessionId: z.string(),
          status: z.string(),
          lifecycle: z.string(),
          runtimeState: z.string(),
          title: z.string().optional(),
          submittedBy: z.string(),
          updatedAt: z.string(),
          runId: z.string().optional(),
          lastHeartbeatAt: z.string().optional(),
          hasMission: z.boolean(),
          missionStatus: z.string().optional(),
          missionCycleNumber: z.number().optional(),
          missionMaxCycles: z.number().optional(),
          lastSeq: z.number(),
          submissionCount: z.number(),
          unresolvedMessageCount: z.number(),
          pendingApprovalCount: z.number(),
          latestSubmission: z.object({
            submissionId: z.string(),
            submissionNumber: z.number(),
            status: z.string(),
            additions: z.number(),
            removals: z.number(),
            diffSha256: z.string().optional(),
            reviewEpoch: z.number().optional(),
          }).optional(),
          latestFeedback: z.object({
            id: z.string(),
            submissionId: z.string().optional(),
            verdict: z.string(),
            comments: z.string().optional(),
            reviewerId: z.string().optional(),
          }).optional(),
        })),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, limit, filter, afterUpdatedAt, afterSessionId }) => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "get_workspace_session_surface");
      }
      const startedAt = performance.now();
      try {
        const readSurface = () => ({
          lastSeq: config.workSessions.getWorkspaceEventCursor(workspaceId),
          sessions: config.workSessions.getWorkspaceSessionSurface(
            workspaceId,
            limit,
            filter,
            afterUpdatedAt && afterSessionId ? { updatedAt: afterUpdatedAt, sessionId: afterSessionId } : undefined,
          ),
        });
        const surface = config.db
          ? config.db.sqlite.transaction(readSurface)()
          : readSurface();
        return {
          content: [{ type: "text" as const, text: `${surface.sessions.length} workspace session surface entr${surface.sessions.length === 1 ? "y" : "ies"}.` }],
          structuredContent: surface,
        };
      } finally {
        config.onPhaseTiming?.("workspace.surface_query", performance.now() - startedAt);
      }
    },
  );

  registerAppTool(
    server,
    "list_active_work_sessions",
    {
      title: "List live work sessions",
      description: "List live worker sessions (optionally scoped to a workspace) for WebUI rehydration. Awaiting-review, detached, stale, and archived work is returned through its dedicated recovery/review listing instead of being presented as currently running.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Optional workspace ID to scope the listing. Omit only when the user explicitly asks to view all sessions across all workspaces."),
      },
      outputSchema: {
        sessions: z.array(z.object({
          sessionId: z.string(),
          workspaceSessionId: z.string(),
          status: z.string(),
          title: z.string().optional(),
          submittedBy: z.string(),
          runId: z.string().optional(),
          submissionCount: z.number(),
          lastSeq: z.number(),
          updatedAt: z.string(),
          hasMission: z.boolean(),
          missionStatus: z.string().optional(),
          missionCycleNumber: z.number().optional(),
          missionMaxCycles: z.number().optional(),
          lifecycle: z.string(),
          runtimeState: z.string(),
        })),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "list_active_work_sessions");
      }
      const surface = config.workSessions.getWorkspaceSessionSurface(workspaceId, 50, "live");
      const mapped = surface.map((s) => {
        return {
          sessionId: s.sessionId,
          workspaceSessionId: s.workspaceSessionId,
          status: s.status,
          title: s.title,
          submittedBy: s.submittedBy,
          runId: s.runId,
          submissionCount: s.submissionCount,
          lastSeq: s.lastSeq,
          updatedAt: s.updatedAt,
          hasMission: s.hasMission,
          missionStatus: s.missionStatus,
          missionCycleNumber: s.missionCycleNumber,
          missionMaxCycles: s.missionMaxCycles,
          lifecycle: s.lifecycle,
          runtimeState: s.runtimeState,
        };
      });
      const text = mapped.length === 0
        ? "No active work sessions."
        : `${mapped.length} active session(s):\n${mapped.map((s) => `  ${s.sessionId} [${s.status}] ${s.title ?? "untitled"} — updated ${s.updatedAt}`).join("\n")}`;

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { sessions: mapped },
      };
    },
  );

  registerMutationAppTool(
    server,
    "handoff_work_session",
    {
      title: "Hand off work session to another agent",
      description: "Reassign an in-flight work session to a different registered coding agent for the next bounded continuation. The session, workspace, mission, submissions, and review history are preserved; the WebUI remains the reviewer and completion authority. A currently parked worker is not force-killed unless you also cancel it.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID to hand off."),
        toAgent: z.string().describe("Name of the target registered agent (role=agent)."),
        reason: z.string().optional().describe("Why the session is being handed off (recorded)."),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: { sessionId: z.string(), fromAgent: z.string().optional(), toAgent: z.string(), status: z.string() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ sessionId, toAgent, reason }) => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "handoff_work_session");
      }
      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      if (TERMINAL_STATUSES.has(session.status)) {
        return { content: [{ type: "text" as const, text: `Session is ${session.status}; cannot hand off a terminal session.` }], isError: true };
      }

      // The target must be a real, registered agent — otherwise the next resume
      // would fail with "no healthy agent" and strand the session.
      const selection = await selectHealthyAgent(config.agentRegistry.listAlive(), {
        name: toAgent,
        role: "agent",
        adapterSecret: config.adapterSecret,
      });
      if (!selection.agent) {
        return { content: [{ type: "text" as const, text: `No healthy agent named ${toAgent} (role=agent) is registered.` }], isError: true };
      }

      const run = config.agentRegistry.getRunByWorkSessionId(sessionId);
      if (!run) {
        return { content: [{ type: "text" as const, text: "No correlated run to reassign for this session." }], isError: true };
      }
      const fromAgent = run.agentName;
      if (fromAgent === toAgent) {
        return {
          content: [{ type: "text" as const, text: `Session already assigned to ${toAgent}.` }],
          structuredContent: { sessionId, fromAgent, toAgent, status: "unchanged" },
        };
      }

      // Reassign the correlated run. The continuation dispatcher reads
      // run.agentName when it routes the next resume, so this reroutes future
      // work without disturbing the durable session/review state.
      config.agentRegistry.updateRun(run.runId, { agentName: toAgent });
      // Keep the mission's preferredAgent in sync — the dispatcher prefers it
      // over run.agentName, so a stale work-order value would otherwise re-route
      // the very next resume back to the old agent, silently undoing the handoff.
      config.missionLedger?.setWorkOrderPreferredAgent(sessionId, toAgent);
      config.eventStore.appendEvent({
        type: "session.handoff",
        sessionId,
        payload: { runId: run.runId, fromAgent, toAgent, reason },
      });

      return {
        content: [{ type: "text" as const, text: `Handed off session ${sessionId} from ${fromAgent} to ${toAgent}.` }],
        structuredContent: { sessionId, fromAgent, toAgent, status: "handed_off" },
      };
    },
  );

  registerMutationAppTool(
    server,
    "cancel_work_session",
    {
      title: "Cancel work session",
      description: "Abandon a work session. Transitions status to cancelled, wakes blocked waiters, supersedes pending continuations, and requests remote worker cancellation.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID to cancel."),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: { status: z.string(), sessionId: z.string(), remoteCancellation: z.unknown().optional() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ sessionId }) => {
      if (config.principalRole !== "reviewer" && config.principalRole !== "worker") {
        return forbidden(config.principalRole, "cancel_work_session");
      }
      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      const bind = assertWorkerSessionBinding(config, sessionId);
      if (bind) return bind;

      const cancellation = config.reviewWorkflow.cancelSession({ sessionId });
      const supervisor = config.supervisorRuns?.getByWorkSession(sessionId);
      if (supervisor) config.supervisorRuns?.transition({ id: supervisor.id, expectedStatus: supervisor.status, expectedRevision: supervisor.revision, nextStatus: "cancelled" });
      const run = config.agentRegistry.getRunByWorkSessionId(sessionId);
      let remoteCancellation = run
        ? await cancelRemoteRun(config, run)
        : { acknowledged: false, error: "No correlated ACP run" };
      if (!run || (!remoteCancellation.acknowledged && (!run.remoteRunId || remoteCancellation.status === 404))) {
        config.reviewWorkflow.finalizeCancellation({ sessionId, reason: "no live worker remained" });
        remoteCancellation = { ...remoteCancellation, acknowledged: true };
      }
      return {
        content: [{ type: "text" as const, text: `Session ${sessionId} ${config.workSessions.get(sessionId)?.status ?? cancellation.status}.${remoteCancellation.acknowledged ? " Remote worker cancellation requested." : ""}` }],
        structuredContent: { status: config.workSessions.get(sessionId)?.status ?? cancellation.status, sessionId, remoteCancellation },
      };
    },
  );
}
