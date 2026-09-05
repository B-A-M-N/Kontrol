/**
 * Work-session domain types
 *
 * Extracted verbatim from work-sessions.ts (P1 god-object decomposition).
 * These declarations are shared by every store and by the manager façade;
 * external consumers keep importing them from "../work-sessions.js".
 */
import type { ReviewFile, WorkspaceSnapshotKind } from "../review-checkpoints.js";

export type WorkSessionStatus =
  | "in_progress"
  | "cancelling"
  | "drafting"
  | "awaiting_review"
  | "in_review"
  | "review_in_progress"
  | "resuming"
  | "changes_requested"
  | "approved"
  | "rejected"
  | "stale"
  | "cancelled"
  | "failed"
  | "failed_protocol";

export type SubmissionVerdict = "approve" | "changes_requested" | "reject";
export type CompletionPolicy = "agent_completion" | "webui_approval_required";

export interface WorkSession {
  id: string;
  projectId?: string;
  workspaceSessionId: string;
  status: WorkSessionStatus;
  completionPolicy: CompletionPolicy;
  reviewEpoch: number;
  submittedBy: string;
  title?: string;
  lastConsumedFeedbackId?: string;
  lastConsumedReviewEpoch: number;
  createdAt: string;
  updatedAt: string;
  latestSubmission?: WorkSessionSubmission;
  latestFeedback?: WorkSessionFeedback;
  /** P1 #7: lifecycle classification for UI grouping. */
  lifecycle: WorkSessionLifecycle;
  runtimeState: WorkSessionRuntimeState;
}

/** Compact workspace-level projection used by the WebUI session picker. */
export interface WorkspaceSessionSurfaceEntry {
  sessionId: string;
  workspaceSessionId: string;
  status: string;
  lifecycle: WorkSessionLifecycle;
  runtimeState: WorkSessionRuntimeState;
  title?: string;
  submittedBy: string;
  updatedAt: string;
  runId?: string;
  lastHeartbeatAt?: string;
  hasMission: boolean;
  missionStatus?: string;
  missionCycleNumber?: number;
  missionMaxCycles?: number;
  lastSeq: number;
  submissionCount: number;
  unresolvedMessageCount: number;
  pendingApprovalCount: number;
  latestSubmission?: {
    submissionId: string;
    submissionNumber: number;
    status: string;
    additions: number;
    removals: number;
    diffSha256?: string;
    reviewEpoch?: number;
  };
  latestFeedback?: {
    id: string;
    submissionId?: string;
    verdict: string;
    comments?: string;
    reviewerId?: string;
  };
}

/** P1 #7: lifecycle classification distinguishing live work from stale/orphaned sessions. */
export type WorkSessionLifecycle =
  | "active_worker"      // worker is actively running (has live run + recent heartbeat)
  | "awaiting_review"    // submitted, waiting for reviewer
  | "resumable"         // changes_requested, worker can resume
  | "detached"          // worker exited but session is still open
  | "stale"             // in_progress but no living run/heartbeat for >1h
  | "archived"          // terminal (approved/rejected/cancelled/failed)
  | "pending";          // in_progress but not yet classified

export type WorkSessionRuntimeState = "running" | "parked" | "detached" | "stale" | "orphaned" | "archived" | "pending";

export interface WorkSessionSubmission {
  id: string;
  workSessionId: string;
  submissionNumber: number;
  diff?: string;
  diffSha256?: string;
  /** Explicit backend-neutral checkpoint identity. */
  snapshotKind?: WorkspaceSnapshotKind;
  snapshotRef?: string;
  /** @deprecated Legacy Git projection retained for old database rows. */
  snapshotCommit?: string;
  reviewEpoch: number;
  message?: string;
  summaryJson?: string;
  /** Structured checkpoint metadata; verification must not parse diff text. */
  files?: ReviewFile[];
  status: "pending" | "reviewed";
  createdAt: string;
  feedback?: WorkSessionFeedback;
  /** Aggregate diff stats from the review checkpoint. */
  additions?: number;
  removals?: number;
}

export interface WorkSessionFeedback {
  id: string;
  workSessionId: string;
  submissionId: string;
  verdict: SubmissionVerdict;
  comments?: string;
  filesJson?: string;
  requiredActionsJson?: string;
  allowedNextActionsJson?: string;
  reviewerId?: string;
  completionReportSha256?: string;
  createdAt: string;
}

export interface ToolEvent {
  id: string;
  workSessionId: string;
  workspaceSessionId?: string;
  tool: string;
  inputJson: string;
  outputSummary?: string;
  path?: string;
  success: boolean;
  elapsedMs: number;
  createdAt: string;
}

export interface WorkspaceLease {
  canonicalRoot: string;
  workspaceSessionId: string;
  workSessionId: string;
  leaseKind: "modify";
  ownerInstanceId: string;
  /** Per-acquisition fencing token. A valid owner with an old nonce is stale. */
  leaseNonce: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface WorkspaceSessionSurfaceCursor {
  updatedAt: string;
  sessionId: string;
}

export interface RuntimeReconciliationPage {
  reconciled: number;
  markedStale: number;
  nextAfterId?: string;
  hasMore: boolean;
}

export type WorkspaceLeaseResult =
  | { acquired: true; lease: WorkspaceLease }
  | { acquired: false; conflictingWorkSessionId: string; workspaceSessionId: string; expiresAt: string };
