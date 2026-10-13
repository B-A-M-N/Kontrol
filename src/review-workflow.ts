import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { DatabaseHandle } from "./db/client.js";
import type { EventStoreEvent } from "./event-log.js";

// Type-only imports (erased at runtime, so no circular-dependency risk).
import type { ContinuationManager, CreateContinuationInput } from "./continuation.js";
import type { AgentRegistryManager } from "./acp-registry.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { ReviewCheckpointManager, ReviewFile, WorkspaceSnapshot, WorkspaceSnapshotKind } from "./review-checkpoints.js";
import type { CheckpointCoverage } from "./checkpoint-coverage.js";
import type { MissionLedger } from "./mission-ledger.js";
import type { DispatchOutbox } from "./dispatch-outbox.js";

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
      | "review_round_limit"
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
  changedFiles?: ReviewFile[];
  additions?: number;
  removals?: number;
  diffSha256?: string;
  snapshotKind?: WorkspaceSnapshotKind;
  snapshotRef?: string;
  /** @deprecated Legacy Git projection retained for old clients. */
  snapshotCommit?: string;
}

export interface SubmitForReviewResult {
  submissionId: string;
  submissionNumber: number;
  diffSha256?: string;
  reviewEpoch: number;
  status: string;
  runId?: string;
  /** P1 (audit): structured mutations this submission's diff cannot represent. */
  coverage?: CheckpointCoverage;
  handoffId?: string;
  handoffStatus?: string;
  roundNumber?: number;
  routeLimitReached?: boolean;
}

/**
 * Trusted invocation origin for the authoritative review workflow. Public tool
 * arguments may describe a reviewer for audit purposes but can never select
 * this identity: each adapter supplies it from its authenticated transport or
 * the server-owned supervisor runtime.
 */
export type ReviewInvocationOrigin = "authenticated_reviewer" | "internal_supervisor";

export interface ProvideFeedbackInput {
  sessionId: string;
  submissionId: string;
  diffSha256?: string;
  reviewEpoch?: number;
  verdict: WorkflowVerdict;
  comments?: string;
  requiredActions?: string[];
  allowedNextActions?: string[];
  /** Display/audit label only; never an authority selector. */
  reviewerId?: string;
  /**
   * Server-established invocation origin. Required for every feedback commit;
   * public arguments cannot supply supervisor authority.
   */
  invocationOrigin: ReviewInvocationOrigin;
  /** Authenticated reviewer context from the transport; not a client token. */
  reviewerOwnerContextId?: string;
  completionReportSha256?: string;
  /**
   * P1 (audit): explicit reviewer acknowledgment that a submission whose
   * checkpoint coverage is incomplete (mutations into excluded/ignored trees)
   * may still be approved. Ordinary approvals of such submissions are refused;
   * only an approval carrying this flag can pass, and the acceptance is
   * recorded in the feedback event payload.
   */
  acceptIncompleteCoverage?: boolean;
}

export interface ProvideFeedbackResult {
  status: string;
  verdict: WorkflowVerdict;
  submissionId: string;
  runId?: string;
  continuationId?: string;
  feedbackEventId?: string;
  handoffId?: string;
  handoffRevision?: number;
  handoffStatus?: string;
}

export interface CancelSessionInput {
  sessionId: string;
  reason?: string;
  /** Exact adapter event identity, supplied only when finalizing a current ACP attempt. */
  adapterEvent?: {
    id: string;
    runId: string;
    remoteRunId: string;
    attemptNumber: number;
    dispatchIdempotencyKey: string;
  };
}

export interface ReviewWorkflowService {
  submitForReview(input: SubmitForReviewInput): Promise<SubmitForReviewResult>;
  provideFeedback(input: ProvideFeedbackInput): Promise<ProvideFeedbackResult>;
  cancelSession(input: CancelSessionInput): { status: string };
  finalizeCancellation(input: CancelSessionInput): { status: string };
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
  /** Optional durable dispatch outbox for continuation redrive. */
  dispatchOutbox?: DispatchOutbox;
  reviewRoutes?: import("./review-handoff/route-store.js").ReviewRouteStore;
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
  const { workSessions, eventStore, continuationManager, agentRegistry, db, workspaces, reviewCheckpoints, missionLedger, dispatchOutbox } = deps;
  const reviewRoutes = deps.reviewRoutes;

  async function submitForReview(input: SubmitForReviewInput): Promise<SubmitForReviewResult> {
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

    // P1 (audit): classify the structured mutations recorded since the last
    // checkpoint advance against the ACTIVE backend. A nonempty uncovered set
    // means this diff LOOKS complete while omitting real edits (excluded
    // trees, git-ignored material). The record travels with the submission so
    // approval can be gated on it and the UI can name the paths.
    let coverage: CheckpointCoverage | undefined;
    if (reviewCheckpoints && typeof reviewCheckpoints.checkpointCoverage === "function") {
      try {
        coverage = await reviewCheckpoints.checkpointCoverage({
          workspaceId: session.workspaceSessionId,
          root: workspaces?.getWorkspace(session.workspaceSessionId)?.root ?? "",
          workSessionId: session.id,
        });
        if (coverage && coverage.uncoveredPaths.length === 0) coverage = undefined;
      } catch {
        // Classification is advisory at submission time (the paths were already
        // recorded); approval still fails closed below on any recorded-but-
        // unclassifiable state because coverage stays undefined while mutations
        // remain tracked.
      }
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
      // The round budget is authoritative at submission admission. This check is
      // This outer transaction establishes the deferred read frame. The nested
      // immediate submission transaction is where concurrent submissions race.
      const admissionRoute = reviewRoutes?.getRouteBySession(input.workSessionId);
      if (admissionRoute && admissionRoute.status !== "disabled" && admissionRoute.completedReviewRounds >= admissionRoute.maxReviewRounds) {
        throw new WorkflowError(
          `Review round limit reached (${admissionRoute.completedReviewRounds}/${admissionRoute.maxReviewRounds}); extend the budget explicitly to submit again.`,
          "review_round_limit",
          409,
        );
      }
      // A paused automated route must not silently admit an automatic-looking
      // submission without a recoverable handoff. This blocks before mutation;
      // the operator can resume the route and resubmit.
      if (admissionRoute?.status === "paused") {
        throw new WorkflowError(
          `Review loop is paused for session ${input.workSessionId}; resume the loop or disable it before submitting.`,
          "conflict",
          409,
        );
      }
      const submission = workSessions.submitForReview({
        workSessionId: input.workSessionId,
        diff: input.diff,
        message: input.message,
        summaryJson: input.summaryJson,
        files: input.changedFiles,
        diffSha256: input.diffSha256,
        snapshotKind: input.snapshotKind,
        snapshotRef: input.snapshotRef,
        snapshotCommit: input.snapshotCommit,
        coverage,
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
          uncoveredPaths: coverage?.uncoveredPaths ?? [],
        },
      });

      let handoff: import("./review-handoff/route-store.js").ReviewHandoff | undefined;
      if (reviewRoutes) {
        const route = reviewRoutes.getRouteBySession(input.workSessionId);
        if (route?.status === "active") {
          handoff = reviewRoutes.createHandoff({
            routeId: route.id,
            workSessionId: input.workSessionId,
            submissionId: submission.id,
            reviewEpoch: submission.reviewEpoch,
            snapshotKind: input.snapshotKind ?? "git",
            snapshotRef: input.snapshotRef ?? input.snapshotCommit ?? "",
            diffSha256: input.diffSha256 ?? "",
            roundNumber: route.completedReviewRounds + 1,
          });
        }
      }
      if (handoff) {
        appendWorkflowEvent({
          type: "review.handoff.created",
          sessionId: input.workSessionId,
          payload: {
            handoffId: handoff.id,
            submissionId: handoff.submissionId,
            reviewEpoch: handoff.reviewEpoch,
            roundNumber: handoff.roundNumber,
            status: handoff.status,
            routeId: handoff.routeId,
            routeEpoch: handoff.routeEpoch,
          },
        });
      }
      return { submission, runId: correlatedRun?.runId, handoff };
    })();
    eventStore.publishEvents(publishQueue);

    return {
      submissionId: result.submission.id,
      submissionNumber: result.submission.submissionNumber,
      diffSha256: result.submission.diffSha256,
      reviewEpoch: result.submission.reviewEpoch,
      status: "awaiting_review",
      runId: result.runId,
      coverage,
      handoffId: result.handoff?.id,
      handoffStatus: result.handoff?.status,
      roundNumber: result.handoff?.roundNumber,
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

    // R06: authoritative review-route enforcement. When a route governs this
    // work session, feedback must be bound to the exact, currently-claimed
    // handoff for the targeted submission. The MCP tool handler applies the
    // same check, but this is the single canonical chokepoint (also reached by
    // the ACP HTTP transport and the mission tools), so no path can bypass it.
    // A trusted internal supervisor invocation is authorized by the server-owned
    // runtime, not by any display/audit reviewerId. Autonomous corrections are
    // governed by the mission/autonomy policy and never impersonate a reviewer.
    if (reviewRoutes && input.invocationOrigin !== "internal_supervisor") {
      const route = reviewRoutes.getRouteBySession(input.sessionId);
      if (route?.status === "active") {
        const submissions = workSessions.getSubmissions(input.sessionId);
        const target = submissions.find((candidate: { id?: string }) => candidate.id === input.submissionId)
          ?? submissions[submissions.length - 1];
        const handoff = target?.id ? reviewRoutes.getHandoffBySubmission(input.sessionId, target.id, target.reviewEpoch) : undefined;
        if (input.reviewerOwnerContextId
          && handoff?.claimedByOwnerContextId !== input.reviewerOwnerContextId) {
          throw new WorkflowError(
            "Review routing conflict: this reviewer did not claim the handoff.",
            "conflict",
            409,
          );
        }
        const claimedHandoff = handoff && handoff.status === "claimed";
        if (!claimedHandoff) {
          throw new WorkflowError(
            "Review routing conflict: this submission has no claimed review handoff.",
            "conflict",
            409,
          );
        }
        // R02/E-toggle: the handoff's route epoch must still match the current
        // route. A mode/route change increments routeEpoch, so feedback claimed
        // under the previous route cannot be committed after the destination
        // changed — the reviewer must re-claim against the current route.
        if (handoff!.routeEpoch !== route.routeEpoch) {
          throw new WorkflowError(
            "Review routing conflict: the claimed handoff belongs to a superseded route epoch.",
            "conflict",
            409,
          );
        }
      }
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

    // P1 (audit): refuse an ordinary approval of a submission whose diff does
    // not represent every structured mutation (paths inside checkpoint-excluded
    // trees, or git-ignored material for git workspaces). Approval requires an
    // explicit acceptIncompleteCoverage acknowledgment, which is recorded in
    // the feedback event. Rejections/changes-requests are never gated: a
    // reviewer must always be able to refuse incomplete work.
    if (input.verdict === "approve" && currentPending.coverage && currentPending.coverage.uncoveredPaths.length > 0 && !input.acceptIncompleteCoverage) {
      throw new WorkflowError(
        `Submission ${input.submissionId} has mutations the review checkpoint cannot represent: `
        + `${currentPending.coverage.uncoveredPaths.join(", ")}. `
        + "Review those paths out-of-band and re-approve with acceptIncompleteCoverage to accept the incomplete coverage explicitly.",
        "conflict",
        409,
      );
    }

    // P0 #4 / P0 #5 / P1 #1: approval must require the workspace to
    // still equal the EXACT snapshot the submission was captured against.
    // Centralized here so BOTH the MCP and ACP transports enforce
    // identical checks (the ACP reviewer endpoint previously skipped it).
    // Scoped to approval only: a reviewer must still be able to reject or
    // request changes on a stale/changed workspace.
    if (session.completionPolicy === "webui_approval_required" && input.verdict === "approve") {
      const pendingSnapshot: WorkspaceSnapshot | undefined = currentPending.snapshotKind && currentPending.snapshotRef
        ? { kind: currentPending.snapshotKind, ref: currentPending.snapshotRef, createdAt: currentPending.createdAt }
        : currentPending.snapshotCommit
          ? { kind: "git", ref: currentPending.snapshotCommit, createdAt: currentPending.createdAt }
          : undefined;
      const missionApproval = missionLedger?.canApprove(input.sessionId, {
        submissionId: currentPending.id,
        snapshotCommit: currentPending.snapshotCommit,
        reviewEpoch: currentPending.reviewEpoch,
      });
      if (missionApproval && !missionApproval.allowed) {
        throw new WorkflowError(
          `Mission approval predicate failed: ${missionApproval.reasons.join("; ")}`,
          "conflict",
          409,
        );
      }
      const expectedReportHash = missionLedger?.getCompletionReportHash(input.sessionId, {
        submissionId: currentPending.id,
        snapshotCommit: currentPending.snapshotCommit,
        reviewEpoch: currentPending.reviewEpoch,
      });
      if (expectedReportHash && input.completionReportSha256 !== expectedReportHash) {
        throw new WorkflowError("Completion report hash is missing or stale for this approval.", "stale_submission", 409);
      }
      if (!workspaces || !reviewCheckpoints) {
        throw new WorkflowError(
          "Workspace/review-checkpoint service unavailable; cannot verify submission snapshot.",
          "server_error",
          500,
        );
      }
      const ws = workspaces.getWorkspace(session.workspaceSessionId);
      // A snapshot commit is a synthetic commit over the current tree.  Its
      // parent depends on the checkpoint used when it was created, so asking
      // for a new `workspace_open` snapshot can produce a different commit ID
      // even when the tree is byte-for-byte identical.  Compare the live tree
      // with the submitted snapshot directly instead.
      if (!pendingSnapshot) {
        throw new WorkflowError(
          `Submission ${input.submissionId} has no bound workspace snapshot.`,
          "stale_submission",
          409,
        );
      }
      const currentMatches = typeof reviewCheckpoints.assertSnapshotMatches === "function"
        ? await reviewCheckpoints.assertSnapshotMatches({
            workspaceId: session.workspaceSessionId,
            root: ws.root,
            expected: pendingSnapshot,
          })
        : (await reviewCheckpoints.reviewChangesAgainstCommit({
            workspaceId: session.workspaceSessionId,
            root: ws.root,
            baselineCommit: pendingSnapshot.ref,
          })).summary.files === 0;
      if (!currentMatches) {
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
      // Revalidate route binding immediately before writing. The earlier
      // preflight is outside the transaction and cannot protect this interval.
      if (reviewRoutes && input.invocationOrigin !== "internal_supervisor") {
        const currentRoute = reviewRoutes.getRouteBySession(input.sessionId);
        if (currentRoute?.status === "active") {
          const currentHandoff = reviewRoutes.getHandoffBySubmission(input.sessionId, input.submissionId, currentPending.reviewEpoch);
          if (!currentHandoff || currentHandoff.status !== "claimed" || currentHandoff.routeEpoch !== currentRoute.routeEpoch) {
            throw new WorkflowError("Review routing conflict: stale claim at feedback commit.", "conflict", 409);
          }
          if (input.reviewerOwnerContextId !== currentHandoff.claimedByOwnerContextId) {
            throw new WorkflowError("Review routing conflict: this reviewer did not claim the handoff.", "conflict", 409);
          }
        }
      }
      // 1. Insert feedback + advance session.
      // Bind handoff completion to the same transaction: every governed
      // feedback entry point reaches this authority, so the route projection
      // cannot lag behind actual review state.
      let committedHandoff: import("./review-handoff/route-store.js").ReviewHandoff | undefined;
      if (reviewRoutes && input.invocationOrigin !== "internal_supervisor") {
        const currentRoute = reviewRoutes.getRouteBySession(input.sessionId);
        if (currentRoute?.status === "active") {
          const currentHandoff = reviewRoutes.getHandoffBySubmission(input.sessionId, input.submissionId, currentPending.reviewEpoch);
          if (!currentHandoff || currentHandoff.status !== "claimed" || currentHandoff.routeEpoch !== currentRoute.routeEpoch) {
            throw new WorkflowError("Review routing conflict: stale handoff at feedback commit.", "conflict", 409);
          }
          if (currentHandoff.claimedByOwnerContextId !== input.reviewerOwnerContextId) {
            throw new WorkflowError("Review routing conflict: this reviewer did not claim the handoff.", "conflict", 409);
          }
          committedHandoff = reviewRoutes.markHandoffStatus({
            handoffId: currentHandoff.id,
            expectedRevision: currentHandoff.revision,
            nextStatus: "feedback_committed",
            completed: true,
          });
        }
      }
      const feedback = workSessions.submitFeedback({
        workSessionId: input.sessionId,
        submissionId: input.submissionId,
        verdict: input.verdict,
        comments: input.comments,
        requiredActions: input.requiredActions,
        allowedNextActions: resolvedAllowed,
        reviewerId: input.reviewerId,
        completionReportSha256: input.completionReportSha256,
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
          // P1 (audit): durable audit trail of an explicit incomplete-coverage
          // acceptance (and which paths it covered).
          ...(input.verdict === "approve" && currentPending.coverage?.uncoveredPaths.length
            ? { acceptedIncompleteCoverage: true, uncoveredPaths: currentPending.coverage.uncoveredPaths }
            : {}),
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
        dispatchOutbox?.enqueue({
          eventType: "continuation.ready",
          aggregateId: createdContinuation.id,
          aggregateRevision: createdContinuation.reviewEpoch,
          payload: {
            sessionId: input.sessionId,
            runId: correlatedRun?.runId,
            continuationId: createdContinuation.id,
            revision: createdContinuation.reviewEpoch,
          },
        });
      }

      return {
        feedback,
        feedbackEvent,
        correlatedRun,
        continuationId,
        createdContinuation,
        committedHandoff,
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
      handoffId: result.committedHandoff?.id,
      handoffRevision: result.committedHandoff?.revision,
      handoffStatus: result.committedHandoff?.status,
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
    if (session.status === "cancelling") return { status: "cancelling" };

    const publishQueue: EventStoreEvent[] = [];
    let finalizeImmediately = false;
    const appendWorkflowEvent = (event: Parameters<typeof eventStore.appendEvent>[0]) => {
      const appended = eventStore.appendEvent(event, { publish: false });
      publishQueue.push(appended);
      return appended;
    };
    db.sqlite.transaction(() => {
      workSessions.updateStatus(input.sessionId, "cancelling");
      const supersededContinuations = continuationManager.supersedeForSession(
        input.sessionId,
        input.reason ?? "session cancelled",
      );
      const correlatedRun = agentRegistry.getRunByWorkSessionId(input.sessionId);
      if (correlatedRun) {
        const dispatchAttempt = agentRegistry.getLatestDispatchAttemptForRun?.(correlatedRun.runId);
        // Missing attempt metadata is an unknown legacy/in-flight state, not
        // evidence that the adapter never received a launch. Only a durable
        // not-started/rejected record permits immediate finalization when the
        // run has no remote identifier.
        const dispatchDefinitelyNotStarted = dispatchAttempt
          ? ["unstarted", "rejected"].includes(dispatchAttempt.status)
          : false;
        agentRegistry.updateRun(correlatedRun.runId, { status: "cancelling" });
        dispatchOutbox?.enqueue({
          eventType: "worker.cancellation.requested",
          aggregateId: input.sessionId,
          aggregateRevision: session.reviewEpoch,
          payload: { runId: correlatedRun.runId, reason: input.reason ?? "cancelled" },
        });
        // A missing remote ID is not proof that an in-flight/uncertain launch
        // never reached the adapter. Keep the session fenced until dispatch
        // reconciliation or a cancellation event resolves it.
        finalizeImmediately = !correlatedRun.remoteRunId && dispatchDefinitelyNotStarted;
      } else {
        // No durable remote attempt exists, so there is no worker process whose
        // stop must be awaited; the lease can be released immediately.
        finalizeImmediately = true;
      }
      appendWorkflowEvent({
        type: "agent.run.cancellation_requested",
        sessionId: input.sessionId,
        payload: { reason: input.reason ?? "cancelled", supersededContinuations },
      });
    })();
    eventStore.publishEvents(publishQueue);

    return finalizeImmediately ? finalizeCancellation(input) : { status: "cancelling" };
  }

  function finalizeCancellation(input: CancelSessionInput): { status: string } {
    const session = workSessions.get(input.sessionId);
    if (!session) throw new WorkflowError(`Session not found: ${input.sessionId}`, "not_found", 404);
    if (TERMINAL_STATUSES.has(session.status)) return { status: session.status };

    const publishQueue: EventStoreEvent[] = [];
    const appendWorkflowEvent = (event: Parameters<typeof eventStore.appendEvent>[0]) => {
      const appended = eventStore.appendEvent(event, { publish: false });
      publishQueue.push(appended);
      return appended;
    };
    db.sqlite.transaction(() => {
      workSessions.updateStatus(input.sessionId, "cancelled");
      const correlatedRun = agentRegistry.getRunByWorkSessionId(input.sessionId);
      const latestAttempt = correlatedRun
        ? agentRegistry.getLatestDispatchAttemptForRun(correlatedRun.runId)
        : undefined;
      const adapterEventMatches = Boolean(
        input.adapterEvent
        && correlatedRun
        && latestAttempt
        && correlatedRun.runId === input.adapterEvent.runId
        && correlatedRun.remoteRunId === input.adapterEvent.remoteRunId
        && latestAttempt.attemptNumber === input.adapterEvent.attemptNumber
        && latestAttempt.remoteRunId === input.adapterEvent.remoteRunId
        && latestAttempt.dispatchIdempotencyKey === input.adapterEvent.dispatchIdempotencyKey,
      );
      if (correlatedRun) {
        agentRegistry.updateRun(correlatedRun.runId, { status: "cancelled", finishedAt: new Date().toISOString(), workerLeaseUntil: null });
      }
      const cancellation = dispatchOutbox?.listByAggregate(input.sessionId).find((event) => event.eventType === "worker.cancellation.requested" && ["pending", "claimed"].includes(event.status));
      // F01: completion is fenced. A pending cancellation has no claimant and
      // is resolved by CAS on its durable identity (status + revision) rather
      // than an owner token; a claimed one is resolved by its live token.
      if (cancellation) {
        if (cancellation.status === "claimed" && cancellation.claimedBy && cancellation.claimToken) {
          dispatchOutbox?.markCompleted({ eventId: cancellation.id, claimOwner: cancellation.claimedBy, claimToken: cancellation.claimToken });
        } else {
          db.sqlite
            .prepare("update dispatch_outbox set status = 'completed', completed_at = ? where id = ? and status = 'pending'")
            .run(new Date().toISOString(), cancellation.id);
        }
      }
      appendWorkflowEvent({
        ...(adapterEventMatches && input.adapterEvent ? { id: input.adapterEvent.id } : {}),
        type: "agent.run.cancelled",
        sessionId: input.sessionId,
        payload: {
          reason: input.reason ?? "cancelled",
          ...(adapterEventMatches && input.adapterEvent ? {
            runId: input.adapterEvent.runId,
            remoteRunId: input.adapterEvent.remoteRunId,
            attemptNumber: input.adapterEvent.attemptNumber,
            dispatchId: input.adapterEvent.dispatchIdempotencyKey,
          } : {}),
        },
      });
    })();
    eventStore.publishEvents(publishQueue);
    return { status: "cancelled" };
  }

  return {
    submitForReview,
    provideFeedback,
    cancelSession,
    finalizeCancellation,
  };
}
