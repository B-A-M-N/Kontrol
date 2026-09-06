/**
 * Session-view store: the per-work-session projection state
 * (WorkSessionViewState instances) plus the monotonic submission/approval
 * merge rules. Extracted verbatim from ui/workspace-app.tsx (P1.4); the
 * module-level `workSessionViews` map is the single owner of that state and
 * render helpers receive views by reference.
 */
import type {
  PendingApprovalRecord,
  ReviewSubmissionView,
  WorkSessionViewState,
} from "./session-view-types.js";

export const workSessionViews = new Map<string, WorkSessionViewState>();

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
      openMessages: new Map(),
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

export function mergePendingApproval(view: WorkSessionViewState, approval: PendingApprovalRecord, fallbackWorkspaceId: string): void {
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
