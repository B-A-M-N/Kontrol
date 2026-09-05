/**
 * Review submission, retrieval, feedback, status, pending list and await-feedback tools
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig } from "./context.js";
import type { Continuation } from "../continuation.js";
import type { EventPredicate, EventStoreEvent } from "../event-log.js";
import type { ReviewSubmissionDTO } from "../review-submission.js";
import { authorizeWorkSessionAction } from "../work-session-action-guard.js";
import { registerMutationAppTool } from "./app-tool.js";
import { assertWorkerSessionBinding, defaultLiveWaiters, forbidden, isReviewer, isWorkerOrClient, parsePatchFiles, requireWorkSessionRead, workspaceAppModelAndAppMeta } from "./shared.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod/v4";

export function registerReviewTools(server: McpServer, config: BridgeConfig): void {
  registerMutationAppTool(
    server,
    "submit_for_review",
    {
      title: "Submit for review",
      description: "Capture workspace changes against the session checkpoint and submit the backend-neutral snapshot identity plus structured file metadata for human review. Git is optional; the presentation patch is not a path protocol. After calling this, call await_review_feedback immediately; do not poll except as recovery.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID from start_work_session."),
        message: z.string().optional().describe("Note to the reviewer."),
        continuationId: z.string().optional().describe("Continuation ID returned by await_review_feedback; completed only after this submission is persisted."),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: { submissionId: z.string(), status: z.string(), files: z.number(), additions: z.number(), removals: z.number(), diffSha256: z.string().optional(), reviewEpoch: z.number(), snapshotKind: z.enum(["git", "filesystem"]).optional(), snapshotRef: z.string().optional(), housekeepingWarnings: z.array(z.string()).optional() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ sessionId, message, continuationId }) => {
      // ROLE CHECK: submit_for_review is for the worker (coding agent) or an
      // ordinary client, NOT a reviewer approving work.
      if (!isWorkerOrClient(config.principalRole)) {
        return forbidden(config.principalRole, "submit_for_review");
      }

      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found. Call start_work_session first." }], isError: true };

      // P0 #6: a dispatched worker is bound to one work session; it must not
      // submit a different session for review.
      const bind = assertWorkerSessionBinding(config, sessionId);
      if (bind) return bind;

      // P1 #3: enforce the reviewer's allowedNextActions on resubmission. A
      // reviewer that omitted "resubmit" cannot be bypassed by the worker
      // calling submit_for_review again (e.g. while changes_requested).
      const resubmitDecision = authorizeWorkSessionAction(config.workSessions, {
        workSessionId: sessionId,
        tool: "submit_for_review",
      });
      if (!resubmitDecision.allowed) {
        return {
          content: [{ type: "text" as const, text: resubmitDecision.reason ?? "Resubmission is not permitted by the reviewer's allowedNextActions." }],
          isError: true,
        };
      }

      // Terminal-state enforcement: once a session is approved/rejected/cancelled,
      // no further submission may reopen it (fixes late submit_for_review
      // reopening an approved session).
      const TERMINAL = new Set(["approved", "rejected", "cancelled", "failed"]);
      if (TERMINAL.has(session.status)) {
        return {
          content: [{ type: "text" as const, text: `Session ${sessionId} is ${session.status}; no further submissions are accepted.` }],
          isError: true,
        };
      }

      try {
        const ws = config.workspaces.getWorkspace(session.workspaceSessionId);
        // Capture the diff WITHOUT advancing the checkpoint. The checkpoint is only
        // committed AFTER the submission is persisted, so a failure between capture
        // and persistence cannot silently drop the diff from the next review.
        const review = await config.reviewCheckpoints.reviewChanges({
          workspaceId: session.workspaceSessionId,
          root: ws.root,
          since: "work_session",
          workSessionId: session.id,
          markReviewed: false,
        });

        // Delegate the state transition to the authoritative workflow service
        // (validates status, transitions to awaiting_review, updates the correlated
        // run, and emits review.submitted atomically).
        const submitted = config.reviewWorkflow.submitForReview({
          workSessionId: sessionId,
          diff: review.patch,
          message: message ?? review.result,
          summaryJson: JSON.stringify(review.summary),
          files: review.summary.files,
          changedFiles: review.files,
          additions: review.summary.additions,
          removals: review.summary.removals,
          snapshotKind: review.snapshotKind,
          snapshotRef: review.snapshotRef,
          snapshotCommit: review.snapshotCommit,
        });

        const housekeepingWarnings: string[] = [];
        const recordHousekeepingFailure = (scope: string, error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          housekeepingWarnings.push(`${scope}: ${detail}`);
          try {
            config.eventStore.appendEvent({
              type: "review.submission.housekeeping_failed",
              sessionId,
              payload: { scope, detail, submissionId: submitted.submissionId },
            }, { publish: false });
          } catch (eventError) {
            console.error(`[kontrol] review submission housekeeping telemetry failed: ${eventError instanceof Error ? eventError.message : String(eventError)}`);
          }
        };

        // The submission is already durable. Checkpoint advancement is
        // follow-up housekeeping and must not turn a successful submission
        // into a misleading tool error if it fails.
        try {
          if (review.snapshot && typeof config.reviewCheckpoints.commitReviewedSnapshot === "function") {
            await config.reviewCheckpoints.commitReviewedSnapshot({
              workspaceId: session.workspaceSessionId,
              root: ws.root,
              workSessionId: session.id,
              snapshot: review.snapshot,
            });
          } else {
            await config.reviewCheckpoints.commitReviewed({
              workspaceId: session.workspaceSessionId,
              root: ws.root,
              workSessionId: session.id,
              snapshotCommit: review.snapshotCommit,
            });
          }
        } catch (error) {
          recordHousekeepingFailure("checkpoint_commit", error);
        }

        try {
          const completedContinuationId = continuationId ?? config.connectionContinuationId;
          if (completedContinuationId) {
            const continuation = config.continuationManager.get(completedContinuationId);
            if (continuation && continuation.sessionId === sessionId) {
              config.continuationManager.markCompleted(completedContinuationId);
              config.workSessions.markFeedbackConsumed(sessionId, continuation.reviewId);
            }
          } else {
            const claimed = config.continuationManager
              .listForSession(sessionId)
              .filter((c) => c.status === "claimed" && c.claimOwner?.startsWith("live-worker:"))
              .sort((a, b) => (b.claimedAt ?? "").localeCompare(a.claimedAt ?? ""))[0];
            if (claimed) {
              config.continuationManager.markCompleted(claimed.id);
              config.workSessions.markFeedbackConsumed(sessionId, claimed.reviewId);
            }
          }
        } catch (error) {
          recordHousekeepingFailure("continuation_cleanup", error);
        }

        const submission = {
          id: submitted.submissionId,
          submissionNumber: submitted.submissionNumber,
        };
        const correlatedRun = config.agentRegistry.getRunByWorkSessionId(sessionId);

        // review-workflow.submitForReview already emitted the canonical
        // review.submitted event with file stats. Do not emit a duplicate.

        return {
          content: [{ type: "text" as const, text: `Submitted #${submission.submissionNumber}: ${review.summary.files} file(s), +${review.summary.additions} -${review.summary.removals}. Status: awaiting_review.${housekeepingWarnings.length ? ` Housekeeping warning: ${housekeepingWarnings.join("; ")}` : ""}` }],
          structuredContent: {
            submissionId: submission.id,
            sessionId,
            submissionNumber: submission.submissionNumber,
            reviewEpoch: submitted.reviewEpoch,
          status: "awaiting_review",
          snapshotKind: review.snapshotKind,
          snapshotRef: review.snapshotRef,
          diffSha256: submitted.diffSha256,
            patch: review.patch,
            files: review.files,
            fileCount: review.summary.files,
            additions: review.summary.additions,
            removals: review.summary.removals,
            message: message ?? review.result,
            housekeepingWarnings,
          } satisfies ReviewSubmissionDTO,
          _meta: {
            tool: "submit_for_review",
            card: {
              tool: "submit_for_review",
              workspaceId: session.workspaceSessionId,
              status: "awaiting_review",
              summary: { ...review.summary, submissionId: submission.id, sessionId, submissionNumber: submission.submissionNumber, runId: correlatedRun?.runId, message: message ?? review.result, diffSha256: submitted.diffSha256, reviewEpoch: submitted.reviewEpoch },
              files: review.files,
              payload: { patch: review.patch },
            },
          },
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Review capture failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );

  registerAppTool(
    server,
    "get_review_submission",
    {
      title: "Get review submission",
      description: "Fetch the full review submission (including the diff/patch) for a work session, so the WebUI can render the acceptance card after the original submit_for_review tool invocation has ended.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID."),
        submissionId: z.string().optional().describe("Specific submission ID; defaults to the latest."),
      },
      outputSchema: {
        submissionId: z.string(),
        sessionId: z.string(),
        status: z.string(),
        submissionNumber: z.number(),
        reviewEpoch: z.number(),
        diffSha256: z.string().optional(),
        patch: z.string(),
        files: z.array(z.object({ path: z.string(), previousPath: z.string().optional(), type: z.string().optional(), operation: z.string().optional(), additions: z.number(), removals: z.number() })),
        fileCount: z.number(),
        additions: z.number(),
        removals: z.number(),
        message: z.string().optional(),
      },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, submissionId }) => {
      const startedAt = performance.now();
      try {
        const access = requireWorkSessionRead(config, sessionId);
      if (access) return access;
      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };

      const submission = submissionId
        ? config.workSessions.getSubmissions(sessionId).find((s) => s.id === submissionId)
        : config.workSessions.getLatestSubmission(sessionId);
      if (!submission) {
        return {
          content: [{ type: "text" as const, text: `Submission ${submissionId} was not found for session ${sessionId}.` }],
          structuredContent: {
            submissionId: submissionId ?? "",
            sessionId,
            status: "not_found",
            submissionNumber: 0,
            reviewEpoch: 0,
            patch: "",
            files: [],
            fileCount: 0,
            additions: 0,
            removals: 0,
          },
          isError: true,
        };
      }

      const summary = submission.summaryJson ? (JSON.parse(submission.summaryJson) as Record<string, unknown>) : {};
      const patch = submission.diff ?? "";
      const files = submission.files ?? parsePatchFiles(patch);
      const dto: ReviewSubmissionDTO = {
        submissionId: submission.id,
        sessionId,
        submissionNumber: submission.submissionNumber,
        reviewEpoch: submission.reviewEpoch,
        status: submission.status,
        snapshotKind: submission.snapshotKind,
        snapshotRef: submission.snapshotRef,
        diffSha256: submission.diffSha256,
        patch,
        files,
        fileCount: files.length,
        additions: Number(summary.additions ?? 0),
        removals: Number(summary.removals ?? 0),
        message: submission.message,
      };

      return {
        content: [{ type: "text" as const, text: `Submission #${submission.submissionNumber}: ${files.length} file(s).` }],
        structuredContent: dto,
        _meta: {
          tool: "submit_for_review",
          card: {
            tool: "submit_for_review",
            workspaceId: session.workspaceSessionId,
            status: "awaiting_review",
            summary: {
              ...summary,
              submissionId: submission.id,
              sessionId,
              submissionNumber: submission.submissionNumber,
              message: submission.message,
              files: files.length,
              additions: Number(summary.additions ?? 0),
              removals: Number(summary.removals ?? 0),
              diffSha256: submission.diffSha256,
              reviewEpoch: submission.reviewEpoch,
            },
            files,
            payload: { patch },
          },
        },
      };
      } finally {
        config.onPhaseTiming?.("review.diff_fetch", performance.now() - startedAt);
      }
    },
  );

  registerMutationAppTool(
    server,
    "provide_review_feedback",
    {
      title: "Provide review feedback",
      description: "Submit human review feedback (approve, changes_requested, or reject) with optional comments and structured actions. Called by the WebUI after reviewing a submission. Wakes any agent blocked on await_review_feedback.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID to provide feedback on."),
        submissionId: z.string().optional().describe("Exact submission being reviewed. Enforced strictly — a stale card carrying an old id yields a conflict instead of approving the wrong submission. Defaults to the current pending submission."),
        diffSha256: z.string().optional().describe("SHA-256 of the submitted diff being reviewed. Required for webui_approval_required sessions."),
        reviewEpoch: z.number().optional().describe("Review epoch of the submitted diff being reviewed. Required for webui_approval_required sessions."),
        verdict: z.enum(["approve", "changes_requested", "reject"]).describe("The reviewer's verdict."),
        comments: z.string().optional().describe("Optional feedback comments for the coding agent."),
        requiredActions: z.array(z.string()).optional().describe("Specific actions the agent must take before resubmitting."),
        allowedNextActions: z.array(z.string()).optional().describe("Actions the agent is permitted to take next (e.g. edit_files, run_commands, resubmit)."),
        reviewerId: z.string().optional().describe("Identifier of the reviewer."),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: { status: z.string(), verdict: z.string() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ sessionId, verdict, comments, requiredActions, allowedNextActions, reviewerId, submissionId, diffSha256, reviewEpoch }) => {
      // ROLE CHECK: provide_review_feedback is reviewer-only (or an ordinary
      // client). A worker (coding agent) must never be able to review/approve
      // its own submitted work.
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "provide_review_feedback");
      }
      if (verdict === "changes_requested" && !comments?.trim()) {
        return {
          content: [{ type: "text" as const, text: "Request Changes requires nonempty instructions for the agent." }],
          isError: true,
        };
      }

      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };

      // Resolve the exact submission. If the caller (WebUI) supplies an explicit
      // submissionId it is enforced EXACTLY — a stale card carrying an old id
      // yields a conflict rather than approving the wrong submission. When omitted
      // we default to the current pending submission (the latest), which is the
      // correct target and carries no stale-card race.
      let targetSubmissionId = submissionId;
      if (!targetSubmissionId) {
        const submissions = config.workSessions.getSubmissions(sessionId);
        const pending = submissions.filter((s) => s.status === "pending");
        const currentPending = pending[pending.length - 1];
        if (!currentPending) {
          return { content: [{ type: "text" as const, text: "No pending submission to review. Call submit_for_review first." }], isError: true };
        }
        targetSubmissionId = currentPending.id;
      }

      try {
        // Snapshot drift validation is performed centrally inside
        // reviewWorkflow.provideFeedback() (scoped to approval), so BOTH the
        // MCP and ACP transports enforce identical checks (P0 #5 / P1 #1).
        const result = await config.reviewWorkflow.provideFeedback({
          sessionId,
          submissionId: targetSubmissionId,
          diffSha256,
          reviewEpoch,
          verdict,
          comments,
          requiredActions,
          allowedNextActions,
          reviewerId,
        });

        // The continuation.created event is emitted inside the workflow transaction
        // (atomic with the feedback + continuation writes). Do NOT emit a duplicate.

        return {
          content: [{ type: "text" as const, text: `Feedback recorded: ${verdict}. Session status: ${result.status}.` }],
          structuredContent: { status: result.status, verdict, submissionId: result.submissionId },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    },
  );

  registerAppTool(
    server,
    "check_review_status",
    {
      title: "Check review status",
      description: "Poll for human feedback on a submitted review session. If changes_requested, read the comments and adjust. If approved, the work is accepted. If rejected, stop.",
      inputSchema: { sessionId: z.string().describe("Work session ID.") },
      outputSchema: { status: z.string(), verdict: z.string().optional(), comments: z.string().optional(), submissionCount: z.number(), feedbackCount: z.number() },
      _meta: workspaceAppModelAndAppMeta(),
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

      const text = (
        session.status === "awaiting_review" ? "⏳ awaiting_review — no feedback yet" :
        session.status === "in_review" ? "🔍 in_review — reviewer is examining" :
        session.status === "changes_requested" ? `✏️ changes_requested — ${lf?.comments ?? "reviewer wants changes"}` :
        session.status === "approved" ? "✅ approved!" :
        session.status === "rejected" ? `❌ rejected — ${lf?.comments ?? ""}` :
        `Status: ${session.status}`
      );

      return { content: [{ type: "text" as const, text }], structuredContent: { status: session.status, verdict: lf?.verdict, comments: lf?.comments, submissionCount: submissions.length, feedbackCount } };
    },
  );

  registerAppTool(
    server,
    "await_review_feedback",
    {
      title: "Await review feedback",
      description: "Block (event-driven) until review feedback is provided for the latest submission. Subscribes before checking durable state, so no feedback is missed (idempotent re-entry via lastSeenFeedbackId). Times out after timeoutMs (default 5 min) — timeout means 'still pending', not failure. After submit_for_review, call this IMMEDIATELY; do NOT poll check_review_status. Use get_work_session or list_pending_reviews to resume later.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID from start_work_session."),
        lastSeenFeedbackId: z.string().optional().describe("If resuming after a prior await, pass the last feedback ID you saw to skip duplicates."),
        timeoutMs: z.number().int().min(1000).max(900_000).optional().default(300_000).describe("Max wait in ms. Default 300000 (5 min). Max 900000 (15 min)."),
      },
      outputSchema: {
        status: z.enum(["feedback_ready", "timeout", "error"]),
        sessionId: z.string(),
        nextSeq: z.number().int().optional().describe("Durable event seq cursor; pass as afterSeq on resume to skip already-seen feedback."),
        feedback: z.object({
          id: z.string(),
          verdict: z.string(),
          comments: z.string().optional(),
          requiredActions: z.array(z.string()).optional(),
          allowedNextActions: z.array(z.string()).optional(),
          reviewerId: z.string().optional(),
          createdAt: z.string(),
          continuationId: z.string().optional(),
        }).optional(),
        message: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, lastSeenFeedbackId, timeoutMs }) => {
      // ROLE CHECK: await_review_feedback is for the worker (coding agent) or
      // an ordinary client, NOT a reviewer.
      if (!isWorkerOrClient(config.principalRole)) {
        return forbidden(config.principalRole, "await_review_feedback");
      }

      const session = config.workSessions.get(sessionId);
      if (!session) {
        return {
          content: [{ type: "text" as const, text: "Session not found. Call start_work_session first." }],
          structuredContent: { status: "error", sessionId, message: "Session not found" },
          isError: true,
        };
      }

      // P0 #6: a dispatched worker is bound to one work session; it must not
      // poll feedback for a different session.
      const bind = assertWorkerSessionBinding(config, sessionId);
      if (bind) return bind;

      // Register this call as a live waiter so the continuation dispatcher does
      // not also spawn a duplicate worker for this session. Cleared on exit.
      const liveWaiters = config.liveWaiters ?? defaultLiveWaiters;
      const waiterId = liveWaiters.add(sessionId);
      const waiterOwner = `live-worker:${sessionId}:${waiterId}`;

      // P1 #8: emit worker.waiter.closed when this is the LAST live waiter on the
      // session, so the continuation dispatcher redrives immediately instead of
      // waiting for the lease sweep to notice the disconnect.
      const cleanup = () => {
        const wasLast = liveWaiters.remove(sessionId, waiterId);
        if (wasLast) {
          config.eventStore.appendEvent({
            type: "worker.waiter.closed",
            sessionId,
            payload: { waiterId },
          });
        }
      };

      // P0 #5 + defect #2: race-free, sequence-anchored wait.
      // waitForMatchingEventAfter subscribes to live events BEFORE re-querying
      // durable state, so an event published between our start and our
      // subscription cannot be lost. We anchor on the SEQUENCE of the last
      // consumed feedback (not 0), so a multi-round review never replays an
      // OLDER cycle's feedback — getEventsAfter is strictly exclusive, so only
      // feedback published after the consumed one is ever returned. The anchor
      // feedback id is also excluded by the predicate (defense in depth).
      const anchor = lastSeenFeedbackId ?? session.lastConsumedFeedbackId;
      let afterSeq = 0;
      if (anchor) {
        const anchorEvent = config.eventStore
          .getEventsForSession(sessionId)
          .find((e) => String((e.payload as { feedbackId?: unknown }).feedbackId ?? e.id) === anchor);
        if (anchorEvent) afterSeq = anchorEvent.seq;
      }
      // Compare the FEEDBACK id (carried in the event payload as feedbackId),
      // not the event id — the anchor/lastConsumedFeedbackId is a feedback id.
      const predicate: EventPredicate = (event) =>
        (event.type === "review.feedback.provided" &&
          String((event.payload as { feedbackId?: unknown }).feedbackId ?? event.id) !== anchor) ||
        event.type === "agent.run.cancelled";

      let matched: EventStoreEvent | null = null;
      const waitStartedAt = performance.now();
      try {
        matched = await config.eventStore.waitForMatchingEventAfter(
          sessionId,
          afterSeq,
          predicate,
          timeoutMs ?? 300_000,
        );
      } catch (error) {
        cleanup();
        config.onPhaseTiming?.("event.review_wait", performance.now() - waitStartedAt);
        throw error;
      }
      config.onPhaseTiming?.("event.review_wait", performance.now() - waitStartedAt);

      if (!matched) {
        cleanup();
        return {
          content: [{ type: "text" as const, text: `No review feedback received within ${Math.round((timeoutMs ?? 300_000) / 1000)}s. Use list_pending_reviews or get_work_session to recover, or call await_review_feedback again.` }],
          structuredContent: { status: "timeout", sessionId, message: "Timeout waiting for feedback" },
        };
      }

      if (matched.type === "agent.run.cancelled") {
        cleanup();
        const reason = String((matched.payload as { reason?: unknown }).reason ?? "cancelled");
        return {
          content: [{ type: "text" as const, text: `Session cancelled: ${reason}` }],
          structuredContent: { status: "error" as const, sessionId, nextSeq: matched.seq, message: `Session cancelled: ${reason}` },
          isError: true,
        };
      }

      const p = matched.payload;
      const structured = {
        id: String(p.feedbackId ?? matched.id),
        verdict: String(p.verdict ?? ""),
        comments: p.comments as string | undefined,
        requiredActions: p.requiredActions as string[] | undefined,
        allowedNextActions: p.allowedNextActions as string[] | undefined,
        reviewerId: p.reviewerId as string | undefined,
        createdAt: matched.createdAt,
        continuationId: undefined as string | undefined,
      };
      const continuation = config.continuationManager
        .listForSession(sessionId)
        .find((c) => c.reviewId === structured.id && c.status === "pending");
      const claimed = continuation
        ? config.continuationManager.claim(waiterOwner, { id: continuation.id })
        : null;
      structured.continuationId = claimed?.id;

      cleanup();
      return {
        content: [{ type: "text" as const, text: `Feedback received: ${p.verdict}${p.comments ? ` — ${p.comments}` : ""}` }],
        structuredContent: { status: "feedback_ready" as const, sessionId, nextSeq: matched.seq, feedback: structured },
      };
    },
  );

  registerAppTool(
    server,
    "list_pending_reviews",
    {
      title: "List pending reviews",
      description: "Find work sessions that are awaiting review or have review in progress. Use for recovery after timeout, reconnect, or discovering unreviewed submissions.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Optional workspace ID to scope the search."),
      },
      outputSchema: {
        sessions: z.array(z.object({
          sessionId: z.string(),
          workspaceSessionId: z.string(),
          status: z.string(),
          title: z.string().optional(),
          submittedBy: z.string(),
          submissionCount: z.number(),
          updatedAt: z.string(),
        })),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "list_pending_reviews");
      }
      const surface = config.workSessions.getWorkspaceSessionSurface(workspaceId, 20, "pending_review");
      const text = surface.length === 0
        ? "No sessions awaiting review."
        : `${surface.length} session(s) awaiting review:\n${surface.map((s) => {
            return `  ${s.sessionId} [${s.status}] ${s.title ?? "untitled"} — ${s.submissionCount} submission(s), updated ${s.updatedAt}`;
          }).join("\n")}`;

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          sessions: surface.map((s) => ({
            sessionId: s.sessionId,
            workspaceSessionId: s.workspaceSessionId,
            status: s.status,
            title: s.title,
            submittedBy: s.submittedBy,
            submissionCount: s.submissionCount,
            updatedAt: s.updatedAt,
          })),
        },
      };
    },
  );
}
