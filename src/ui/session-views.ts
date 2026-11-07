/**
 * Session-view store: the per-work-session projection state
 * (WorkSessionViewState instances) plus the monotonic submission/approval
 * merge rules. Extracted verbatim from ui/workspace-app.tsx (P1.4); the
 * module-level `workSessionViews` map is the single owner of that state and
 * render helpers receive views by reference.
 */
import type {
  ApprovalOutcomeRecord,
  PendingApprovalRecord,
  ReviewSubmissionView,
  WorkSessionViewState,
} from "./session-view-types.js";

export const workSessionViews = new Map<string, WorkSessionViewState>();

/** Bounded recent-outcome history for resolved approvals (newest last). */
export const MAX_RECENT_APPROVAL_OUTCOMES = 5;

export function recordApprovalOutcome(view: WorkSessionViewState, entry: ApprovalOutcomeRecord): void {
  const history = view.recentApprovalOutcomes ?? (view.recentApprovalOutcomes = []);
  const at = history.findIndex((existing) => existing.approvalId === entry.approvalId);
  if (at >= 0) history.splice(at, 1);
  history.push(entry);
  while (history.length > MAX_RECENT_APPROVAL_OUTCOMES) history.shift();
}

export function ensureWorkSessionView(workSessionId: string, workspaceSessionId: string, runId: string): WorkSessionViewState {
  let view = workSessionViews.get(workSessionId);
  if (!view) {
    view = {
      workspaceSessionId,
      workSessionId,
      runId,
      status: "in_progress",
      lastSeq: 0,
      unresolvedMessageCount: 0,
      pendingApprovalCount: 0,
      activity: [],
      submissions: new Map(),
      policyApprovals: new Map(),
      recentApprovalOutcomes: [],
      policyGrants: new Map(),
      policyGrantsLoaded: false,
      openMessages: new Map(),
      browserTurnStatus: new Map(),
      feedbackStateBySubmission: new Map(),
      feedbackErrorBySubmission: new Map(),
    };
    workSessionViews.set(workSessionId, view);
  } else {
    if (workspaceSessionId) view.workspaceSessionId = workspaceSessionId;
    if (runId) view.runId = runId;
  }
  return view;
}

/** Keep submission selection monotonic across overlapping event, snapshot, and
 * detail-fetch responses. Review epoch is the primary authority; submission
 * number breaks ties within an epoch. */
export function noteSubmission(view: WorkSessionViewState, submission: ReviewSubmissionView): void {
  const existing = view.submissions.get(submission.submissionId);
  if (!existing || compareSubmissionAuthority(submission, existing) >= 0) {
    view.submissions.set(submission.submissionId, submission);
  }
  const active = view.activeSubmissionId ? view.submissions.get(view.activeSubmissionId) : undefined;
  if (!active || compareSubmissionAuthority(submission, active) >= 0) {
    view.activeSubmissionId = submission.submissionId;
  }
}

/** Outcomes that close an approval: a later pending listing for the same
 * approvalId is stale data, never a reopenable decision. "unknown" is
 * deliberately absent — it records no commitment. */
const COMMITTED_APPROVAL_OUTCOMES: ReadonlySet<string> = new Set([
  "approved_pending_retry",
  "executed",
  "authorization_consumed",
  "denied",
  "expired",
  "cancelled",
]);

export function mergePendingApproval(view: WorkSessionViewState, approval: PendingApprovalRecord, fallbackWorkspaceId: string): void {
  // A refresh must never overwrite a more recent committed decision with
  // stale pending data: once the reviewer committed (or the server reported
  // a terminal state), the card stays closed and the outcome stands.
  const committed = (view.recentApprovalOutcomes ?? []).some(
    (entry) => entry.approvalId === approval.approvalId && COMMITTED_APPROVAL_OUTCOMES.has(entry.outcome),
  );
  if (committed) return;
  // A hydration refresh must not clobber a local decision still in flight: a
  // record the user is submitting (or whose outcome is unknown after an
  // interruption) keeps its UI state until the outcome is known.
  const existing = view.policyApprovals.get(approval.approvalId);
  const inFlight = existing?.uiState === "submitting" || existing?.uiState === "outcome_unknown"
    ? { uiState: existing.uiState, error: existing.error, clientMutationId: existing.clientMutationId, clientMutationDecision: existing.clientMutationDecision }
    : {};
  view.policyApprovals.set(approval.approvalId, {
    approvalId: approval.approvalId,
    workspaceId: approval.workspaceId ?? approval.workspaceSessionId ?? fallbackWorkspaceId,
    workSessionId: approval.workSessionId,
    kind: approval.kind,
    title: approval.title,
    description: approval.description,
    risk: approval.risk,
    tool: approval.tool ?? "tool",
    path: approval.path,
    command: approval.command,
    options: approval.options,
    origin: approval.origin,
    conversationId: approval.conversationId,
    orphanedAt: approval.orphanedAt,
    reattachDeadline: approval.reattachDeadline,
    liveWaiterCount: approval.liveWaiterCount,
    requestedAt: approval.requestedAt,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    ...inFlight,
  });
  view.pendingApprovalCount = view.policyApprovals.size;
}

export function compareSubmissionAuthority(
  left: Pick<ReviewSubmissionView, "submissionNumber" | "reviewEpoch">,
  right: Pick<ReviewSubmissionView, "submissionNumber" | "reviewEpoch">,
): number {
  if (left.reviewEpoch !== undefined && right.reviewEpoch !== undefined) {
    return left.reviewEpoch - right.reviewEpoch || left.submissionNumber - right.submissionNumber;
  }
  return left.submissionNumber - right.submissionNumber
    || (left.reviewEpoch === undefined ? 0 : 1) - (right.reviewEpoch === undefined ? 0 : 1);
}
