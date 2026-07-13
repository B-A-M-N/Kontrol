import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { DatabaseHandle } from "./db/client.js";
import type { EventStoreEvent } from "./event-log.js";

// Type-only imports (erased at runtime, so no circular-dependency risk).
import type { ContinuationManager, CreateContinuationInput } from "./continuation.js";
import type { AgentRegistryManager } from "./acp-registry.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { ReviewCheckpointManager } from "./review-checkpoints.js";
import type { MissionLedger } from "./mission-ledger.js";

export type WorkflowVerdict = "approve" | "changes_requested" | "reject";

export const TERMINAL_STATUSES = new Set([
  "approved",
  "rejected",
  "cancelled",
  "failed",
  "failed_protocol",
]);

export class WorkflowError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_found"
      | "terminal"
      | "conflict"
      | "bad_request"
      | "not_pending"
      | "stale_submission"
      | "server_error",
    public readonly httpStatus: number = 400,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

export interface SubmitForReviewInput {
  workSessionId: string;
  diff?: string;
  message?: string;
  summaryJson?: string;
  files?: number;
  additions?: number;
  removals?: number;
  diffSha256?: string;
  /** Exact working-tree snapshot commit the diff was captured against. */
  snapshotCommit?: string;
}

export interface SubmitForReviewResult {
  submissionId: string;
  submissionNumber: number;
  diffSha256?: string;
  reviewEpoch: number;
  status: string;
  runId?: string;
}

export interface ProvideFeedbackInput {
  sessionId: string;
  submissionId: string;
  diffSha256?: string;
  reviewEpoch?: number;
  verdict: WorkflowVerdict;
  comments?: string;
  requiredActions?: string[];
  allowedNextActions?: string[];
  reviewerId?: string;
}

export interface ProvideFeedbackResult {
  status: string;
  verdict: WorkflowVerdict;
  submissionId: string;
  runId?: string;
  continuationId?: string;
  feedbackEventId?: string;
}

export interface CancelSessionInput {
  sessionId: string;
  reason?: string;
}

export interface ReviewWorkflowService {
  submitForReview(input: SubmitForReviewInput): SubmitForReviewResult;
  provideFeedback(input: ProvideFeedbackInput): Promise<ProvideFeedbackResult>;
  cancelSession(input: CancelSessionInput): { status: string };
}

export interface ReviewWorkflowDeps {
  workSessions: any;
  eventStore: any;
  continuationManager: ContinuationManager;
  agentRegistry: AgentRegistryManager;
  db: DatabaseHandle;
  /** Optional: required to bind approval to the exact submitted snapshot. */
  workspaces?: WorkspaceRegistry;
  /** Optional: required to bind approval to the exact submitted snapshot. */
  reviewCheckpoints?: ReviewCheckpointManager;
  /** Optional mission ledger. When present for a session, approval is gated by it. */
  missionLedger?: MissionLedger;
}

/**
 * Valid action classes a reviewer may grant via `allowedNextActions`. Keep in
 * sync with work-session-action-guard ActionClass. Used to reject typos at the
 * boundary instead of silently denying them (P1 #4).
 */
export const VALID_ACTION_CLASSES = [
  "read_files",
  "edit_files",
  "run_commands",
  "resubmit",
  "await_feedback",
  "cancel",
] as const;

const allowedNextActionsSchema = z.array(z.enum(VALID_ACTION_CLASSES)).optional();

/**
 * Server-side default for `changes_requested`: when the reviewer omits
 * `allowedNextActions` (as the current WebUI feedback UI does), apply a safe
 * remediation default so the worker can actually make the requested changes
 * (edit / run / resubmit). An EXPLICIT empty list still freezes the worker to
 * read/await/cancel only (P0 #2).
 */
export const DEFAULT_CHANGES_REQUESTED_ACTIONS: string[] = [
  "read_files",
  "edit_files",
  "run_commands",
  "resubmit",
  "await_feedback",
  "cancel",
];

function resolveAllowedNextActions(input: ProvideFeedbackInput): string[] | undefined {
  // Explicit value (including an empty list) is honored as-is.
  if (input.allowedNextActions !== undefined) return input.allowedNextActions;
  // Omitted on changes_requested: apply the remediation default.
  if (input.verdict === "changes_requested") return DEFAULT_CHANGES_REQUESTED_ACTIONS;
  return undefined;
}

const SUBMITTABLE_STATUSES = new Set([
  "in_progress",
  "changes_requested",
  "resuming",
]);

export function createReviewWorkflowService(
  deps: ReviewWorkflowDeps,
): ReviewWorkflowService {
  const { workSessions, eventStore, continuationManager, agentRegistry, db, workspaces, reviewCheckpoints, missionLedger } = deps;

  function submitForReview(input: SubmitForReviewInput): SubmitForReviewResult {
    const session = workSessions.get(input.workSessionId);
    if (!session) {
      throw new WorkflowError(
        `Work session not found: ${input.workSessionId}`,
        "not_found",
        404,
      );
    }
    if (TERMINAL_STATUSES.has(session.status)) {
      throw new WorkflowError(
        `Session ${input.workSessionId} is ${session.status}; no further submissions accepted.`,
        "terminal",
        409,
      );
    }
    if (!SUBMITTABLE_STATUSES.has(session.status)) {
      throw new WorkflowError(
        `Session ${input.workSessionId} is ${session.status}; cannot submit for review now.`,
        "bad_request",
        409,
      );
    }

    // All writes in ONE transaction so the submission, session transition,
    // correlated run update, and review.submitted event are atomic.
    const publishQueue: EventStoreEvent[] = [];
    const appendWorkflowEvent = (event: Parameters<typeof eventStore.appendEvent>[0]) => {
      const appended = eventStore.appendEvent(event, { publish: false });
      publishQueue.push(appended);
      return appended;
    };
    const result = db.sqlite.transaction(() => {
      const submission = workSessions.submitForReview({
        workSessionId: input.workSessionId,
        diff: input.diff,
        message: input.message,
        summaryJson: input.summaryJson,
        diffSha256: input.diffSha256,
        snapshotCommit: input.snapshotCommit,
      });

      const correlatedRun = agentRegistry.getRunByWorkSessionId(input.workSessionId);
      if (correlatedRun) {
        agentRegistry.updateRun(correlatedRun.runId, { status: "awaiting_review" });
      }

      appendWorkflowEvent({
        type: "review.submitted",
        sessionId: input.workSessionId,
        payload: {
          submissionId: submission.id,
          submissionNumber: submission.submissionNumber,
          runId: correlatedRun?.runId,
          files: input.files ?? 0,
          additions: input.additions ?? 0,
          removals: input.removals ?? 0,
        },
      });

      return { submission, runId: correlatedRun?.runId };
    })();
    eventStore.publishEvents(publishQueue);

    return {
      submissionId: result.submission.id,
      submissionNumber: result.submission.submissionNumber,
      diffSha256: result.submission.diffSha256,
      reviewEpoch: result.submission.reviewEpoch,
      status: "awaiting_review",
      runId: result.runId,
    };
  }

  async function provideFeedback(input: ProvideFeedbackInput): Promise<ProvideFeedbackResult> {
    const session = workSessions.get(input.sessionId);
    if (!session) {
      throw new WorkflowError(`Session not found: ${input.sessionId}`, "not_found", 404);
    }
    if (TERMINAL_STATUSES.has(session.status)) {
      throw new WorkflowError(
        `Session ${input.sessionId} is already ${session.status}; no further feedback accepted.`,
        "terminal",
        409,
      );
    }
    if (session.status !== "awaiting_review") {
      throw new WorkflowError(
        `Session ${input.sessionId} is ${session.status}, not awaiting_review.`,
        "bad_request",
        409,
      );
    }

    // Validate submission exists and is the current pending one
    // Validate submission BEFORE mutating anything
    const submissions = workSessions.getSubmissions(input.sessionId);
    if (submissions.length === 0) {
      throw new WorkflowError(
        `No submissions to review for session ${input.sessionId}.`,
        "bad_request",
        409,
      );
    }

    const pending = submissions.filter((s: any) => s.status === "pending");
    const currentPending = pending[pending.length - 1];
    if (!currentPending || currentPending.id !== input.submissionId) {
      throw new WorkflowError(
        `Submission ${input.submissionId} is not the current pending submission.`,
        "not_pending",
        409,
      );
    }
    if (session.completionPolicy === "webui_approval_required") {
      if (!input.diffSha256 || input.diffSha256 !== currentPending.diffSha256) {
        throw new WorkflowError(
          `Submission ${input.submissionId} diff hash is stale.`,
          "stale_submission",
          409,
        );
      }
      if (!input.reviewEpoch || input.reviewEpoch !== currentPending.reviewEpoch || input.reviewEpoch !== session.reviewEpoch) {
        throw new WorkflowError(
          `Submission ${input.submissionId} review epoch is stale.`,
          "stale_submission",
          409,
        );
      }
    }

    // P0 #4 / P0 #5 / P1 #1: approval must require the workspace to
    // still equal the EXACT snapshot the submission was captured against.
    // Centralized here so BOTH the MCP and ACP transports enforce
    // identical checks (the ACP reviewer endpoint previously skipped it).
    // Scoped to approval only: a reviewer must still be able to reject or
    // request changes on a stale/changed workspace.
    if (session.completionPolicy === "webui_approval_required" && input.verdict === "approve") {
      const missionApproval = missionLedger?.canApprove(input.sessionId, {
        submissionId: currentPending.id,
        snapshotCommit: currentPending.snapshotCommit,
      });
      if (missionApproval && !missionApproval.allowed) {
        throw new WorkflowError(
          `Mission approval predicate failed: ${missionApproval.reasons.join("; ")}`,
          "conflict",
          409,
        );
      }
      if (!workspaces || !reviewCheckpoints) {
        throw new WorkflowError(
          "Workspace/review-checkpoint service unavailable; cannot verify submission snapshot.",
          "server_error",
          500,
        );
      }
      const ws = workspaces.getWorkspace(session.workspaceSessionId);
      const current = await reviewCheckpoints.reviewChanges({
        workspaceId: session.workspaceSessionId,
        root: ws.root,
        since: "last_shown",
        markReviewed: false,
      });
      if (current.snapshotCommit !== currentPending.snapshotCommit) {
        throw new WorkflowError(
          `Workspace snapshot changed since submission ${input.submissionId}; cannot approve a stale submission. Submit a fresh review.`,
          "stale_submission",
          409,
        );
      }
    }

    // P1 #4: validate allowedNextActions against the known action-class
    // enum so a typo becomes an explicit error instead of a silent denial.
    if (input.allowedNextActions !== undefined) {
      const parsed = allowedNextActionsSchema.safeParse(input.allowedNextActions);
      if (!parsed.success) {
        throw new WorkflowError(
          "allowedNextActions contains an invalid action class.",
          "bad_request",
          400,
        );
      }
    }
    // P0 #2: default remediation actions when omitted (changes_requested).
    const resolvedAllowed = resolveAllowedNextActions(input);

    const nextStatus =
      input.verdict === "approve"
        ? "approved"
        : input.verdict === "reject"
          ? "rejected"
          : "changes_requested";

    // ALL writes happen inside a single transaction so a crash cannot leave a
    // session with feedback but no continuation (which would strand the agent).
    // Mirrors submitForReview()'s transactional shape (line 135).
    const publishQueue: EventStoreEvent[] = [];
    const appendWorkflowEvent = (event: Parameters<typeof eventStore.appendEvent>[0]) => {
      const appended = eventStore.appendEvent(event, { publish: false });
      publishQueue.push(appended);
      return appended;
    };
    const result = db.sqlite.transaction(() => {
      // 1. Insert feedback + advance session.
      const feedback = workSessions.submitFeedback({
        workSessionId: input.sessionId,
        submissionId: input.submissionId,
        verdict: input.verdict,
        comments: input.comments,
        requiredActions: input.requiredActions,
        allowedNextActions: resolvedAllowed,
        reviewerId: input.reviewerId,
      });

      const correlatedRun = agentRegistry.getRunByWorkSessionId(input.sessionId);
      if (correlatedRun) {
        agentRegistry.updateRun(correlatedRun.runId, { status: nextStatus });
      }

      // 2. Emit feedback event.
      const feedbackEvent = appendWorkflowEvent({
        type: "review.feedback.provided",
        sessionId: input.sessionId,
        payload: {
          feedbackId: feedback.id,
          submissionId: input.submissionId,
          reviewedDiffHash: currentPending.diffSha256,
          verdict: input.verdict,
          comments: input.comments,
          requiredActions: input.requiredActions,
          allowedNextActions: resolvedAllowed,
          reviewerId: input.reviewerId,
        },
      });

      // 3. Terminal verdicts: emit canonical terminal event.
      if (input.verdict !== "changes_requested") {
        const terminalEvent =
          input.verdict === "approve" ? "agent.run.approved" : "agent.run.rejected";
        appendWorkflowEvent({
          type: terminalEvent,
          sessionId: input.sessionId,
          payload: { runId: correlatedRun?.runId, verdict: input.verdict },
        });
      }

      // 4. Changes requested: create continuation + emit.
      let continuationId: string | undefined;
      let createdContinuation;
      if (input.verdict === "changes_requested") {
        createdContinuation = continuationManager.create({
          sessionId: input.sessionId,
          reviewId: feedback.id,
          feedbackEventId: feedbackEvent.id,
          verdict: input.verdict,
          requiredActions: input.requiredActions,
          allowedNextActions: resolvedAllowed,
          reviewedDiffHash: currentPending.diffSha256,
          feedbackSummary: input.comments,
        });
        continuationId = createdContinuation.id;

        appendWorkflowEvent({
          type: "continuation.created",
          sessionId: input.sessionId,
          payload: { continuationId: createdContinuation.id, runId: correlatedRun?.runId },
        });
      }

      return {
        feedback,
        feedbackEvent,
        correlatedRun,
        continuationId,
        createdContinuation,
      };
    })();
    eventStore.publishEvents(publishQueue);

    return {
      status: nextStatus,
      verdict: input.verdict,
      submissionId: input.submissionId,
      runId: result.correlatedRun?.runId,
      continuationId: result.continuationId,
      feedbackEventId: result.feedbackEvent.id,
    };
  }

  function cancelSession(input: CancelSessionInput): { status: string } {
    const session = workSessions.get(input.sessionId);
    if (!session) {
      throw new WorkflowError(`Session not found: ${input.sessionId}`, "not_found", 404);
    }
    if (TERMINAL_STATUSES.has(session.status)) {
      return { status: session.status };
    }

    const publishQueue: EventStoreEvent[] = [];
    const appendWorkflowEvent = (event: Parameters<typeof eventStore.appendEvent>[0]) => {
      const appended = eventStore.appendEvent(event, { publish: false });
      publishQueue.push(appended);
      return appended;
    };
    db.sqlite.transaction(() => {
      workSessions.updateStatus(input.sessionId, "cancelled");
      const correlatedRun = agentRegistry.getRunByWorkSessionId(input.sessionId);
      if (correlatedRun) {
        agentRegistry.updateRun(correlatedRun.runId, { status: "cancelled" });
      }
      appendWorkflowEvent({
        type: "agent.run.cancelled",
        sessionId: input.sessionId,
        payload: { reason: input.reason ?? "cancelled" },
      });
    })();
    eventStore.publishEvents(publishQueue);

    return { status: "cancelled" };
  }

  return {
    submitForReview,
    provideFeedback,
    cancelSession,
  };
}
