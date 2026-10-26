/**
 * Work-session lifecycle, inspection, surface, handoff and cancellation tools
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { BridgeConfig } from "./context.js";
import { cancelRemoteRun, selectHealthyAgent } from "../acp-gateway.js";
import { TERMINAL_STATUSES } from "../review-workflow.js";
import { registerMutationAppTool } from "./app-tool.js";
import { assertWorkerSessionBinding, forbidden, isReviewer, liveConnectionIdentity, liveOwnerContextId, livePrincipalId, requireWorkSessionMutation, requireWorkSessionRead, workspaceAppModelAndAppMeta } from "./shared.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod/v4";
import { createHash, randomUUID } from "node:crypto";

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
        const session = config.workSessions.create({ workspaceSessionId: workspaceId, submittedBy: "cli", title, completionPolicy, ownerContextId: liveOwnerContextId(config) ?? config.principalId, principalId: livePrincipalId(config) });
        config.workspaces.setActiveSession(workspaceId, session.id, liveConnectionIdentity(config).mcpSessionId);
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
        principalId: z.string().optional(),
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
          principalId: session.principalId,
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
          replyId: z.string().optional(),
          replyStatus: z.string().optional(),
          replyBody: z.string().optional(),
        })).optional(),
        lastEventSeq: z.number().optional(),
        agentPtys: z.array(z.object({
          processSessionId: z.string(),
          agentName: z.string(),
          processGeneration: z.number(),
          outputCursor: z.number(),
          status: z.enum(["attached", "detached", "exited", "lost"]),
          createdAt: z.string(),
          finishedAt: z.string().optional(),
        })).optional(),
        reviewLoop: z.object({
          routeId: z.string(),
          reviewThreadId: z.string().optional(),
          reviewThreadStatus: z.string().optional(),
          status: z.string(),
          mode: z.string(),
          completedReviewRounds: z.number(),
          admittedReviewRounds: z.number(),
          maxReviewRounds: z.number(),
          roundNumber: z.number().optional(),
          handoffId: z.string().optional(),
          handoffStatus: z.string().optional(),
          deliveryTransport: z.string().optional(),
          browserProfileId: z.string().optional(),
          conversation: z.object({
            key: z.string().optional(),
            url: z.string().optional(),
            bindingStatus: z.string().optional(),
            bindingRevision: z.number().optional(),
            browserGeneration: z.number().optional(),
          }).optional(),
          deliveryMessage: z.object({
            messageId: z.string(),
            kind: z.string(),
            status: z.string(),
            updatedAt: z.string(),
          }).optional(),
          browserAttempt: z.object({
            attemptId: z.string(),
            status: z.string(),
            attemptNumber: z.number(),
            errorCode: z.string().optional(),
            submittedAt: z.string().optional(),
            generationStartedAt: z.string().optional(),
            generationFinishedAt: z.string().optional(),
          }).optional(),
        }).optional(),
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
        ? config.agentMessages.list(sessionId).filter((m) => m.status === "open").map((m) => {
            // Preserve the open question while joining any accepted reply so a
            // cold WebUI can render "Reply saved — awaiting agent" rather than
            // making the answered question look unanswered.
            const reply = config.agentMessages!.listPendingReplies(sessionId).find((candidate) => candidate.messageId === m.id)
              ?? config.agentMessages!.listReplies(sessionId).find((candidate) => candidate.messageId === m.id);
            return {
              messageId: m.id,
              kind: m.kind,
              author: m.author,
              title: m.title,
              body: m.body,
              status: m.status,
              runId: m.runId,
              createdAt: m.createdAt,
              replyId: reply?.id,
              replyStatus: reply?.status,
              replyBody: reply?.body,
            };
          })
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
          agentPtys: config.agentPtyBindingsForWorkSession?.(sessionId) ?? [],
          reviewLoop: config.reviewRoutes
            ? (() => {
                const route = config.reviewRoutes!.getRouteBySession(sessionId);
                const handoff = route && latestSubmission
                  ? config.reviewRoutes!.getHandoffBySubmission(sessionId, latestSubmission.id, latestSubmission.reviewEpoch ?? 0)
                  : undefined;
                const thread = route ? config.reviewThreads?.getForRoute(route.id, route.routeEpoch) : undefined;
                const threadMessages = thread ? config.reviewThreads?.listMessages(thread.id) ?? [] : [];
                const deliveryMessage = handoff
                  ? [...threadMessages].reverse().find((message) => message.handoffId === handoff.id)
                  : [...threadMessages].reverse().find((message) => ["queued", "presenting", "presented", "reviewer_claimed", "awaiting_attachment", "failed"].includes(message.status));
                const browserAttempt = thread ? config.reviewBrowserJobs?.getActiveForThread(thread.id) : undefined;
                return route
                  ? {
                      routeId: route.id,
                      reviewThreadId: thread?.id,
                      reviewThreadStatus: thread?.status,
                      status: route.status,
                      mode: route.mode,
                      completedReviewRounds: route.completedReviewRounds,
                      admittedReviewRounds: route.admittedReviewRounds,
                      maxReviewRounds: route.maxReviewRounds,
                      roundNumber: handoff?.roundNumber,
                      handoffId: handoff?.id,
                      handoffStatus: handoff?.status,
                      deliveryTransport: route.deliveryTransport,
                      browserProfileId: route.browserProfileId,
                      conversation: thread ? {
                        key: thread.conversationKey,
                        url: thread.conversationUrl,
                        bindingStatus: thread.conversationBindingStatus,
                        bindingRevision: thread.conversationBindingRevision,
                        browserGeneration: thread.browserGeneration,
                      } : undefined,
                      deliveryMessage: deliveryMessage ? {
                        messageId: deliveryMessage.id,
                        kind: deliveryMessage.kind,
                        status: deliveryMessage.status,
                        updatedAt: deliveryMessage.updatedAt,
                      } : undefined,
                      browserAttempt: browserAttempt ? {
                        attemptId: browserAttempt.id,
                        status: browserAttempt.status,
                        attemptNumber: browserAttempt.attemptNumber,
                        errorCode: browserAttempt.lastErrorCode,
                        submittedAt: browserAttempt.promptSubmittedAt,
                        generationStartedAt: browserAttempt.generationStartedAt,
                        generationFinishedAt: browserAttempt.generationFinishedAt,
                      } : undefined,
                    }
                  : undefined;
              })()
            : undefined,
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
    "observe_agent_pty",
    {
      title: "Observe agent terminal",
      description: "Reviewer-only, read-only observation of an interactive PTY explicitly bound to a work session. Returns bounded output and cursor metadata; it cannot send input, resize, or signal the process.",
      inputSchema: {
        sessionId: z.string().min(1),
        processSessionId: z.string().min(1),
        afterCursor: z.number().int().nonnegative().optional(),
        maxOutputCharacters: z.number().int().positive().max(20_000).optional(),
      },
      outputSchema: {
        sessionId: z.string(),
        processSessionId: z.string(),
        agentName: z.string(),
        processGeneration: z.number(),
        status: z.enum(["attached", "detached", "exited", "lost"]),
        running: z.boolean(),
        output: z.string(),
        outputCursor: z.number(),
        oldestAvailableCursor: z.number(),
        outputTruncated: z.boolean(),
        exitCode: z.number().optional(),
        signal: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ sessionId, processSessionId, afterCursor, maxOutputCharacters }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "observe_agent_pty");
      const access = requireWorkSessionRead(config, sessionId);
      if (access) return access;
      const observation = config.observeAgentPty?.({ workSessionId: sessionId, processSessionId, afterCursor, maxOutputCharacters });
      if (!observation) {
        return { content: [{ type: "text" as const, text: "PTY binding not found for this work session." }], isError: true };
      }
      return {
        content: [{ type: "text" as const, text: observation.output || `PTY ${observation.binding.status}; no retained output in this range.` }],
        structuredContent: {
          sessionId,
          processSessionId,
          agentName: observation.binding.agentName,
          processGeneration: observation.binding.processGeneration,
          status: observation.binding.status,
          running: observation.running,
          output: observation.output,
          outputCursor: observation.outputCursor,
          oldestAvailableCursor: observation.oldestAvailableCursor,
          outputTruncated: observation.outputTruncated,
          exitCode: observation.exitCode,
          signal: observation.signal,
        },
      };
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
        // Conversation-scoped reviewers receive only their own work-session
        // projection. An ownerless reviewer intentionally retains the global
        // review surface for operational recovery.
        const owner = liveOwnerContextId(config);
        if (config.connectionContext && !owner) return forbidden(config.principalRole, "get_workspace_session_surface");
        const readSurface = () => ({
          lastSeq: config.workSessions.getWorkspaceEventCursor(workspaceId),
          sessions: config.workSessions.getWorkspaceSessionSurface(
            workspaceId,
            limit,
            filter,
            afterUpdatedAt && afterSessionId ? { updatedAt: afterUpdatedAt, sessionId: afterSessionId } : undefined,
            owner,
            livePrincipalId(config),
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
      const owner = liveOwnerContextId(config);
      if (config.connectionContext && !owner) return forbidden(config.principalRole, "list_active_work_sessions");
      const surface = config.workSessions.getWorkspaceSessionSurface(workspaceId, 50, "live", undefined, owner, livePrincipalId(config));
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
      outputSchema: { sessionId: z.string(), fromAgent: z.string().optional(), toAgent: z.string(), status: z.string(), transferId: z.string().optional() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ sessionId, toAgent, reason }) => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "handoff_work_session");
      }
      const access = requireWorkSessionMutation(config, sessionId);
      if (access) return access;
      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      if (session.status === "cancelling") {
        return { content: [{ type: "text" as const, text: "Session is cancelling; wait for worker shutdown before handing it off." }], isError: true };
      }
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
      const latestAttempt = config.agentRegistry.getLatestDispatchAttemptForRun(run.runId);
      const currentAgentId = latestAttempt?.agentId ?? run.agentId;
      const fromAgent = (currentAgentId ? config.agentRegistry.get(currentAgentId)?.name : undefined) ?? run.agentName;
      // Agent names are routing labels, not execution identities. A restarted
      // or re-registered adapter can reuse a name with a new durable ID; that
      // is a new destination and must be eligible for an explicit handoff.
      if (currentAgentId ? currentAgentId === selection.agent.id : fromAgent === toAgent) {
        return {
          content: [{ type: "text" as const, text: `Session already assigned to ${toAgent}.` }],
          structuredContent: { sessionId, fromAgent, toAgent, status: "unchanged" },
        };
      }

      const latestSubmission = config.workSessions.getLatestSubmission(sessionId);
      const latestFeedback = config.workSessions.getLatestFeedback(sessionId);
      const mission = config.missionLedger?.getPacket(sessionId);
      const criteriaById = new Map((mission?.criterionStates ?? []).map((state) => [state.criterionId, state]));
      const unresolvedRequirements = (mission?.criteria ?? [])
        .filter((criterion) => (criteriaById.get(criterion.id)?.status ?? "pending") !== "verified")
        .map((criterion) => ({
          id: criterion.id,
          description: criterion.description,
          status: criteriaById.get(criterion.id)?.status ?? "pending",
          priority: criterion.priority,
        }));
      const transferId = randomUUID();
      const contextTransferPacket = {
        version: 1,
        transferId,
        workSessionId: sessionId,
        task: run.inputTask ?? run.inputPreview ?? session.title ?? "Continue the existing work session.",
        taskSha256: run.inputTaskSha256,
        taskComplete: run.inputTask !== undefined,
        priorWork: {
          latestRunOutput: run.outputPreview,
          latestSubmission: latestSubmission ? {
            submissionId: latestSubmission.id,
            message: latestSubmission.message,
            reviewEpoch: latestSubmission.reviewEpoch,
            files: latestSubmission.files,
            diffSha256: latestSubmission.diffSha256,
          } : undefined,
        },
        checkpoint: latestSubmission ? {
          submissionId: latestSubmission.id,
          snapshotKind: latestSubmission.snapshotKind,
          snapshotRef: latestSubmission.snapshotRef,
          reviewEpoch: latestSubmission.reviewEpoch,
        } : undefined,
        latestReviewerFeedback: latestFeedback ? {
          feedbackId: latestFeedback.id,
          submissionId: latestFeedback.submissionId,
          verdict: latestFeedback.verdict,
          comments: latestFeedback.comments,
          requiredActions: latestFeedback.requiredActionsJson ? JSON.parse(latestFeedback.requiredActionsJson) : undefined,
          allowedNextActions: latestFeedback.allowedNextActionsJson ? JSON.parse(latestFeedback.allowedNextActionsJson) : undefined,
          reviewerId: latestFeedback.reviewerId,
          createdAt: latestFeedback.createdAt,
        } : undefined,
        unresolvedRequirements,
        reason,
        createdAt: new Date().toISOString(),
      };
      const packetJson = JSON.stringify(contextTransferPacket);
      const contextTransferSha256 = createHash("sha256").update(packetJson).digest("hex");
      config.eventStore.appendEvent({
        type: "session.handoff",
        sessionId,
        payload: {
          transferId,
          runId: run.runId,
          fromAgent,
          // A handoff records the current executor as its source. The logical
          // run's agentId remains the immutable origin and can differ after a
          // prior committed transfer.
          fromAgentId: currentAgentId,
          toAgent,
          toAgentId: selection.agent.id,
          reason,
          state: "requested",
          contextTransferPacket,
          contextTransferSha256,
        },
      });
      config.eventStore.appendEvent({
        type: "session.handoff.state",
        sessionId,
        payload: {
          transferId,
          runId: run.runId,
          fromAgent,
          toAgent,
          state: "requested",
        },
      });
      // The durable event is the routing authority. Do not rewrite the logical
      // run: its agent identity records the origin and historical attempts.
      config.missionLedger?.setWorkOrderPreferredAgent(sessionId, toAgent);

      return {
        content: [{ type: "text" as const, text: `Handoff ${transferId} requested for session ${sessionId}, from ${fromAgent} to ${toAgent}. The transfer is not complete until the source is quiesced and the destination accepts its first attempt.` }],
        structuredContent: { sessionId, fromAgent, toAgent, status: "requested", transferId },
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
      const access = requireWorkSessionMutation(config, sessionId);
      if (access) return access;
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
