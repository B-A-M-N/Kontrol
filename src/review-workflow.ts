import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import type { DatabaseHandle } from "./db/client.js";
import type { EventStoreEvent } from "./event-log.js";

// Type-only imports (erased at runtime, so no circular-dependency risk).
import type { ContinuationManager, CreateContinuationInput } from "./continuation.js";
import type { AgentRegistryManager } from "./acp-registry.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { ReviewCheckpointManager, ReviewFile, WorkspaceSnapshot, WorkspaceSnapshotKind } from "./review-checkpoints.js";
import type { CheckpointCoverage } from "./checkpoint-coverage.js";
import { reviewCoverageApprovalBlock } from "./review-coverage-policy.js";
import { withFileMutationLock, workspaceMutationLockKey } from "./mutation-version.js";
import type { MissionLedger } from "./mission-ledger.js";
import type { DispatchOutbox } from "./dispatch-outbox.js";
import { reviewThreads, reviewThreadMessages } from "./db/schema.js";
import { createReviewPacket } from "./review-thread/review-packet.js";

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
  coverageStatus: CheckpointCoverage["status"];
  coverage: CheckpointCoverage;
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
  /** Authenticated principal from the active reviewer transport. */
  reviewerPrincipalId?: string;
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
  /** Stop processes from the reviewed attempt before a correction continuation
   * becomes dispatchable. The callback must reject if shutdown is unconfirmed. */
  interruptWorkSessionForCorrection?: (workSessionId: string) => Promise<void>;
  reviewBrowserJobs?: import("./review-thread/reviewer-job-store.js").ReviewerJobStore;
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
  const { workSessions, eventStore, continuationManager, agentRegistry, db, workspaces, reviewCheckpoints, missionLedger, dispatchOutbox, reviewBrowserJobs } = deps;
  const reviewRoutes = deps.reviewRoutes;

  interface ApprovalLeaseView {
    workSessionId: string;
    workspaceSessionId: string;
    leaseKind: string;
    ownerInstanceId?: string;
  }

  /**
   * Lease-fenced approval. Approval is the moment the reviewed tree becomes
   * authoritative, so it must not proceed while the checkout lease says a
   * *different* authority owns the workspace:
   *  - a `modify` lease held by the reviewed session itself is legitimate
   *    ownership and remains supported;
   *  - a `modify` lease held by any other work session blocks approval;
   *  - a `cleanup_pending` fence blocks approval even for its own session
   *    (terminal cleanup is not mutation authority and the tree may still
   *    be draining);
   *  - a `peer_job` reservation blocks approval (owned by the peer
   *    processor, never by the reviewed worker);
   *  - no active lease is the ordinary post-worker state and is allowed.
   * The check is read-only: approval neither acquires nor releases the lease
   * (acquisition belongs to dispatch, release to verified termination /
   * peer processing), and the same predicate is re-evaluated inside the
   * feedback transaction so the commit itself is fenced.
   */
  function approvalLeaseBlock(
    lease: ApprovalLeaseView | undefined,
    sessionId: string,
    workspaceSessionId: string,
  ): string | undefined {
    if (!lease) return undefined;
    if (lease.leaseKind === "cleanup_pending") {
      return `Approval blocked: the checkout lease for this workspace is cleanup-pending (work session ${lease.workSessionId}); terminal cleanup must finish before approval.`;
    }
    if (lease.leaseKind === "peer_job") {
      return `Approval blocked: the checkout lease is a peer-job reservation (${lease.ownerInstanceId ?? lease.workSessionId}); the peer processor must release it before approval.`;
    }
    if (lease.leaseKind !== "modify") {
      return `Approval blocked: the checkout lease has an unrecognized kind (${lease.leaseKind}).`;
    }
    if (lease.workspaceSessionId !== workspaceSessionId) {
      return `Approval blocked: the checkout lease belongs to workspace ${lease.workspaceSessionId}, not ${workspaceSessionId}.`;
    }
    if (lease.workSessionId !== sessionId) {
      return `Approval blocked: the checkout lease is held by work session ${lease.workSessionId}, not the reviewed session ${sessionId}.`;
    }
    return undefined;
  }

  /** Canonical checkout root for lease fencing, or undefined when the
   * workspace/lease services are not wired (legacy harnesses). Production
   * always wires both, so fencing always applies there. */
  async function resolveApprovalLeaseRoot(session: { id: string; workspaceSessionId: string }): Promise<string | undefined> {
    if (!workspaces || typeof workspaces.getWorkspace !== "function"
      || typeof workSessions.getActiveWorkspaceLease !== "function") return undefined;
    const ws = workspaces.getWorkspace(session.workspaceSessionId);
    if (!ws?.root) return undefined;
    try {
      return await realpath(ws.root);
    } catch {
      throw new WorkflowError(
        `Cannot resolve the checkout root for session ${session.id}; approval is blocked until the workspace is available.`,
        "server_error",
        500,
      );
    }
  }

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
    let coverage: CheckpointCoverage = {
      status: "unknown",
      backend: "unknown",
      uncoveredPaths: [],
      reasons: ["Coverage was not classified before submission."],
      assessedAt: new Date().toISOString(),
      errorCode: "coverage_unavailable",
    };
    if (reviewCheckpoints && typeof reviewCheckpoints.checkpointCoverage === "function") {
      try {
        coverage = await reviewCheckpoints.checkpointCoverage({
          workspaceId: session.workspaceSessionId,
          root: workspaces?.getWorkspace(session.workspaceSessionId)?.root ?? "",
          workSessionId: session.id,
        });
      } catch (error) {
        // Persist uncertainty explicitly. A missing record is never interpreted
        // as proof that the snapshot represents every mutation.
        const code = (error as { code?: unknown } | undefined)?.code;
        coverage = {
          status: "unknown",
          backend: "unknown",
          uncoveredPaths: [],
          reasons: ["Coverage classification failed; the submission requires a new successful assessment."],
          assessedAt: new Date().toISOString(),
          errorCode: typeof code === "string" && /^[A-Za-z0-9_:-]{1,80}$/.test(code) ? code : "classification_failed",
        };
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
      if (admissionRoute && admissionRoute.status !== "disabled" && admissionRoute.admittedReviewRounds >= admissionRoute.maxReviewRounds) {
        throw new WorkflowError(
          `Review round limit reached (${admissionRoute.admittedReviewRounds}/${admissionRoute.maxReviewRounds}); extend the budget explicitly to submit again.`,
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
          uncoveredPaths: coverage.uncoveredPaths,
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
            snapshotKind: submission.snapshotKind ?? input.snapshotKind ?? "git",
            snapshotRef: submission.snapshotRef ?? input.snapshotRef ?? input.snapshotCommit ?? "",
            diffSha256: submission.diffSha256,
            roundNumber: route.admittedReviewRounds + 1,
          });
          const session = workSessions.get(input.workSessionId);
          const run = agentRegistry.getRunByWorkSessionId(input.workSessionId);
          let missionPacket: unknown;
          try { missionPacket = missionLedger?.getPacket(input.workSessionId); } catch { /* ordinary sessions have no mission packet */ }
          const priorFeedback = db.sqlite.prepare(`
            select submission_id as submissionId, verdict, comments,
                   required_actions_json as requiredActionsJson, created_at as createdAt
              from work_session_feedback
             where work_session_id = ? and submission_id != ?
             order by created_at desc limit 10
          `).all(input.workSessionId, submission.id).map((row: any) => ({
            submissionId: row.submissionId,
            verdict: row.verdict,
            comments: row.comments ?? undefined,
            requiredActions: (() => { try { return JSON.parse(row.requiredActionsJson ?? "[]") as string[]; } catch { return []; } })(),
            createdAt: row.createdAt,
          })).reverse();
          const reviewPacket = createReviewPacket({ session, submission, roundNumber: handoff.roundNumber, objective: run?.inputPreview, mission: missionPacket, priorFeedback });
          const payloadJson = JSON.stringify(reviewPacket);
          reviewRoutes.setReviewPacket({
            handoffId: handoff.id,
            payloadJson,
            payloadSha256: createHash("sha256").update(payloadJson).digest("hex"),
          });
          const currentRoute = reviewRoutes.getRouteBySession(input.workSessionId);
          const message = db.db.select().from(reviewThreadMessages).where(eq(reviewThreadMessages.handoffId, handoff.id)).get();
          const thread = message && db.db.select().from(reviewThreads).where(eq(reviewThreads.id, message.threadId)).get();
          if (currentRoute?.deliveryTransport === "native_cdp" && thread?.status === "active"
            && thread.conversationBindingStatus === "bound" && message?.status === "queued") {
            dispatchOutbox?.enqueue({
              eventType: "reviewer.browser_turn.ready",
              aggregateId: message.id,
              aggregateRevision: message.revision,
              payload: { messageId: message.id, threadId: thread.id, profileId: currentRoute.browserProfileId, routeEpoch: currentRoute.routeEpoch, revision: message.revision },
            });
          }
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
      coverageStatus: coverage.status,
      coverage,
      handoffId: result.handoff?.id,
      handoffStatus: result.handoff?.status,
      roundNumber: result.handoff?.roundNumber,
    };
  }

  /**
   * Approval entry point. For approve verdicts the exact-snapshot check,
   * the fresh coverage revalidation, and the feedback commit all run inside
   * the shared workspace-mutation boundary (the same key structured
   * mutations serialize on), so a concurrent structured mutation cannot
   * land between validation and commit. The boundary is in-process only:
   * after a restart the approval simply re-runs from scratch, and the
   * feedback commit remains a single SQLite transaction, so no
   * half-applied approval can survive. Shell mutations cannot be keyed by
   * path; they are fenced by the checkout lease check inside the inner
   * implementation instead. Rejection and changes-requested never take
   * the boundary: a reviewer must always be able to refuse work.
   */
  async function provideFeedback(input: ProvideFeedbackInput): Promise<ProvideFeedbackResult> {
    if (input.verdict !== "approve") return provideFeedbackInner(input);
    const session = workSessions.get(input.sessionId);
    if (!session || !workspaces || typeof workspaces.getWorkspace !== "function") {
      return provideFeedbackInner(input);
    }
    let keys: string[] | undefined;
    try {
      const ws = workspaces.getWorkspace(session.workspaceSessionId);
      if (ws?.root) {
        keys = [workspaceMutationLockKey(ws.root)];
        const canonical = await realpath(ws.root).catch(() => undefined);
        if (canonical && canonical !== ws.root) keys.push(workspaceMutationLockKey(canonical));
      }
    } catch {
      // The inner implementation surfaces workspace errors with the same
      // semantics as before; run it directly so error shapes are unchanged.
      return provideFeedbackInner(input);
    }
    if (!keys) return provideFeedbackInner(input);
    return withFileMutationLock(keys, () => provideFeedbackInner(input));
  }

  async function provideFeedbackInner(input: ProvideFeedbackInput): Promise<ProvideFeedbackResult> {
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
      if (route) {
        if (route.status === "disabled" || route.status === "closed") {
          throw new WorkflowError("Review routing is disabled or closed; this handoff cannot accept feedback.", "conflict", 409);
        }
        const submissions = workSessions.getSubmissions(input.sessionId);
        const target = submissions.find((candidate: { id?: string }) => candidate.id === input.submissionId);
        const handoff = target?.id ? reviewRoutes.getHandoffBySubmission(input.sessionId, target.id, target.reviewEpoch) : undefined;
        if (!target || !handoff || handoff.status !== "claimed"
          || !handoff.claimExpiresAt || Date.parse(handoff.claimExpiresAt) <= Date.now()
          || handoff.routeEpoch !== route.routeEpoch
          || !input.reviewerOwnerContextId
          || !input.reviewerPrincipalId
          || handoff.claimedByOwnerContextId !== input.reviewerOwnerContextId
          || handoff.claimedByPrincipalId !== input.reviewerPrincipalId) {
          throw new WorkflowError(
            "Review routing conflict: feedback requires the current reviewer claim for the exact submission and route epoch.",
            "conflict",
            409,
          );
        }
        if (route.status === "paused" && !handoff.claimedAt) {
          throw new WorkflowError(
            "Review routing is paused; only an already-claimed review may finish.",
            "conflict",
            409,
          );
        }
        // R02/E-toggle: the handoff's route epoch must still match the current
        // route. A mode/route change increments routeEpoch, so feedback claimed
        // under the previous route cannot be committed after the destination
        // changed — the reviewer must re-claim against the current route.
        if (handoff.routeEpoch !== route.routeEpoch) {
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
    if (input.verdict === "approve") {
      const coverageBlock = reviewCoverageApprovalBlock(
        currentPending.coverage,
        input.acceptIncompleteCoverage === true,
      );
      if (coverageBlock) throw new WorkflowError(`Submission ${input.submissionId}: ${coverageBlock}`, "conflict", 409);
    }

    // Lease fence (approve only): a conflicting checkout lease blocks
    // approval before any snapshot work, and is re-checked inside the
    // feedback transaction below so the commit cannot slip past a lease
    // that changed during validation. Rejection and changes-requested are
    // never lease-gated: a reviewer must always be able to refuse work.
    let approvalLeaseRoot: string | undefined;
    if (input.verdict === "approve") {
      approvalLeaseRoot = await resolveApprovalLeaseRoot(session);
      if (approvalLeaseRoot) {
        const leaseBlock = approvalLeaseBlock(
          workSessions.getActiveWorkspaceLease(approvalLeaseRoot),
          input.sessionId,
          session.workspaceSessionId,
        );
        if (leaseBlock) throw new WorkflowError(leaseBlock, "conflict", 409);
      }
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

    // Approval-time coverage revalidation (approve only): persisted
    // submission coverage is stale once mutations can occur after
    // submission. Re-assess live coverage now — inside the shared
    // workspace-mutation boundary held by the provideFeedback wrapper,
    // and before the feedback transaction commits — and gate on the fresh
    // result. A classifier failure is durable unknown evidence, never a
    // complete assessment. Harnesses without a coverage classifier keep
    // the persisted-evidence behavior.
    let approvalCoverage = currentPending.coverage;
    if (input.verdict === "approve" && reviewCheckpoints
      && typeof reviewCheckpoints.checkpointCoverage === "function" && workspaces) {
      const wsForCoverage = workspaces.getWorkspace(session.workspaceSessionId);
      try {
        approvalCoverage = await reviewCheckpoints.checkpointCoverage({
          workspaceId: session.workspaceSessionId,
          root: wsForCoverage.root,
          workSessionId: session.id,
        });
      } catch (error) {
        const code = (error as { code?: unknown } | undefined)?.code;
        approvalCoverage = {
          status: "unknown",
          backend: "unknown",
          uncoveredPaths: [],
          reasons: ["Coverage revalidation failed at approval; the submission requires a new successful assessment."],
          assessedAt: new Date().toISOString(),
          errorCode: typeof code === "string" && /^[A-Za-z0-9_:-]{1,80}$/.test(code) ? code : "classification_failed",
        };
      }
      const freshBlock = reviewCoverageApprovalBlock(
        approvalCoverage,
        input.acceptIncompleteCoverage === true,
      );
      if (freshBlock) throw new WorkflowError(`Submission ${input.submissionId}: ${freshBlock}`, "conflict", 409);
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

    // A command from the reviewed attempt may still be running. Stop and
    // confirm its process tree before committing any continuation. Until the
    // transaction below changes the session state, the action guard continues
    // to block new edits and commands. Failure leaves review state untouched.
    if (input.verdict === "changes_requested" && deps.interruptWorkSessionForCorrection) {
      try {
        await deps.interruptWorkSessionForCorrection(input.sessionId);
      } catch (error) {
        throw new WorkflowError(
          `Cannot request changes until the prior work-session processes are confirmed stopped: ${error instanceof Error ? error.message : String(error)}`,
          "conflict",
          409,
        );
      }
    }

    const allowedNextActionsSource = input.verdict !== "changes_requested"
      ? "not_applicable"
      : input.allowedNextActions !== undefined
        ? "reviewer_explicit"
        : "server_default";

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
      // Lease fence re-check inside the atomic commit: the preflight above
      // ran before asynchronous snapshot/coverage validation, so a lease
      // acquired in that window must abort this commit, not be approved
      // past. Throwing here rolls back the whole feedback write.
      if (input.verdict === "approve" && approvalLeaseRoot) {
        const leaseBlock = approvalLeaseBlock(
          workSessions.getActiveWorkspaceLease(approvalLeaseRoot),
          input.sessionId,
          session.workspaceSessionId,
        );
        if (leaseBlock) throw new WorkflowError(leaseBlock, "conflict", 409);
      }
      // Revalidate route binding immediately before writing. The earlier
      // preflight is outside the transaction and cannot protect this interval.
      if (reviewRoutes && input.invocationOrigin !== "internal_supervisor") {
        const currentRoute = reviewRoutes.getRouteBySession(input.sessionId);
        if (currentRoute) {
          if (currentRoute.status === "disabled" || currentRoute.status === "closed") {
            throw new WorkflowError("Review routing was disabled or closed before feedback commit.", "conflict", 409);
          }
          const currentHandoff = reviewRoutes.getHandoffBySubmission(input.sessionId, input.submissionId, currentPending.reviewEpoch);
          if (!currentHandoff || currentHandoff.status !== "claimed" || !currentHandoff.claimExpiresAt
            || Date.parse(currentHandoff.claimExpiresAt) <= Date.now() || currentHandoff.routeEpoch !== currentRoute.routeEpoch) {
            throw new WorkflowError("Review routing conflict: stale claim at feedback commit.", "conflict", 409);
          }
          if (!input.reviewerOwnerContextId || input.reviewerOwnerContextId !== currentHandoff.claimedByOwnerContextId
            || !input.reviewerPrincipalId || input.reviewerPrincipalId !== currentHandoff.claimedByPrincipalId) {
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
        if (currentRoute) {
          if (currentRoute.status === "disabled" || currentRoute.status === "closed") {
            throw new WorkflowError("Review routing was disabled or closed before feedback commit.", "conflict", 409);
          }
          const currentHandoff = reviewRoutes.getHandoffBySubmission(input.sessionId, input.submissionId, currentPending.reviewEpoch);
          if (!currentHandoff || currentHandoff.status !== "claimed" || !currentHandoff.claimExpiresAt
            || Date.parse(currentHandoff.claimExpiresAt) <= Date.now() || currentHandoff.routeEpoch !== currentRoute.routeEpoch) {
            throw new WorkflowError("Review routing conflict: stale handoff at feedback commit.", "conflict", 409);
          }
          if (currentHandoff.claimedByOwnerContextId !== input.reviewerOwnerContextId
            || !input.reviewerPrincipalId || currentHandoff.claimedByPrincipalId !== input.reviewerPrincipalId) {
            throw new WorkflowError("Review routing conflict: this reviewer did not claim the handoff.", "conflict", 409);
          }
          committedHandoff = reviewRoutes.markHandoffStatus({
            handoffId: currentHandoff.id,
            expectedRevision: currentHandoff.revision,
            nextStatus: "feedback_committed",
            completed: true,
          });
          reviewBrowserJobs?.settleForFeedback({ handoffId: currentHandoff.id, routeEpoch: currentHandoff.routeEpoch });
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
      // Audit union: an explicit acceptance covers the uncovered paths
      // documented at submission (persisted evidence) plus any uncovered
      // paths the fresh approval-time revalidation found. Either source
      // alone can require the acceptance; the union is what was accepted.
      const acceptedCoveragePaths = input.verdict === "approve" && input.acceptIncompleteCoverage === true
        ? [...new Set([
            ...(currentPending.coverage.status === "incomplete" ? currentPending.coverage.uncoveredPaths : []),
            ...(approvalCoverage.status === "incomplete" ? approvalCoverage.uncoveredPaths : []),
          ])]
        : [];
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
          ...(acceptedCoveragePaths.length > 0
            ? { acceptedIncompleteCoverage: true, uncoveredPaths: acceptedCoveragePaths }
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
          allowedNextActionsSource: input.allowedNextActions !== undefined ? "reviewer_explicit" : "server_default",
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
      if (input.verdict !== "changes_requested") reviewRoutes?.closeThreadForSession(input.sessionId);

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
      reviewRoutes?.closeThreadForSession(input.sessionId);
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
