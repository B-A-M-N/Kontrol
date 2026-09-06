/**
 * Shared view-state value types for the workspace app session surfaces.
 * Extracted verbatim from ui/workspace-app.tsx (P1.4) so stores, render
 * helpers, and the composition module share one definition.
 */
import type { ReviewFile } from "../review-submission.js";

export interface AgentActivityEvent {
  seq: number;
  id: string;
  durable?: boolean;
  type: string;
  sessionId: string;
  workspaceSessionId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type ReviewSubmissionView = {
  submissionId: string;
  sessionId: string;
  submissionNumber: number;
  reviewEpoch?: number;
  status: string;
  diffSha256?: string;
  patch: string;
  files: ReviewFile[];
  fileCount: number;
  additions: number;
  removals: number;
  message?: string;
  createdAt?: string;
};

export interface PolicyApprovalView {
  approvalId: string;
  workspaceId?: string;
  workSessionId?: string;
  kind?: string;
  title?: string;
  description?: string;
  risk?: string;
  tool: string;
  path?: string;
  command?: string;
  approvalKey?: string;
  matchedPattern?: string;
  origin?: "direct_mcp" | "work_session";
  conversationId?: string;
  orphanedAt?: string;
  reattachDeadline?: string;
  liveWaiterCount?: number;
  requestedAt?: string;
  createdAt?: string;
  expiresAt?: string;
  options?: Array<{
    id: string;
    label: string;
    effect: "approve" | "deny" | "changes_requested";
    scope?: "once" | "work_session" | "workspace";
  }>;
  uiState?: "idle" | "submitting" | "resolved" | "error" | "outcome_unknown";
  error?: string;
}

export interface PendingApprovalRecord {
  approvalId: string;
  workspaceId?: string;
  workspaceSessionId?: string;
  workSessionId?: string;
  kind?: string;
  title?: string;
  description?: string;
  risk?: string;
  tool?: string;
  path?: string;
  command?: string;
  options?: PolicyApprovalView["options"];
  origin?: PolicyApprovalView["origin"];
  conversationId?: string;
  orphanedAt?: string;
  reattachDeadline?: string;
  liveWaiterCount?: number;
  requestedAt?: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface AgentMessageView {
  messageId: string;
  kind: string;
  author?: string;
  title?: string;
  body?: string;
  status: string;
  runId?: string;
  createdAt?: string;
}

export interface MissionPacketView {
  supervisor?: { id: string; status: string; resumeStatus?: string | null; revision: number; cycleNumber: number; maxCycles: number; autonomyMode: string; approvalMode: string; repeatedFailureCount?: number; repeatedFailureFingerprintLimit?: number; stagnantCycleCount?: number; progressJson?: string | null; stallReason?: string | null; updatedAt?: string; deadlineAt?: string; lastError?: string };
  mission?: { id: string; objective: string; desiredOutcome?: string; correctionRounds?: number; maxCorrectionRounds?: number };
  criteria: Array<{ id: string; description: string; priority: string; status: string; verificationType?: string; verificationCommand?: string; dependsOnCriterionIds?: string[] }>;
  findings: Array<{ id: string; description: string; severity: string; scope: string; status: string; requiredAction?: string }>;
  workOrders: Array<{ id: string; objectiveForThisTurn: string; status: string }>;
  evidence: Array<{ id: string; criterionId?: string; status: string; source?: string; command?: string }>;
  completionReports?: Array<{ id: string; status: string; reportSha256: string; createdAt: string }>;
  approval: { allowed: boolean; reasons: string[] };
}

export type FeedbackState = "idle" | "submitting" | "submitted" | "error" | "outcome_unknown";

export interface WorkSessionViewState {
  workspaceSessionId: string;
  workSessionId: string;
  runId: string;
  title?: string;
  submittedBy?: string;
  status: string;
  updatedAt?: string;
  lastHeartbeatAt?: string;
  lifecycle?: string;
  runtimeState?: string;
  unresolvedMessageCount: number;
  pendingApprovalCount: number;
  lastSeq: number;
  activity: AgentActivityEvent[];
  submissions: Map<string, ReviewSubmissionView>;
  policyApprovals: Map<string, PolicyApprovalView>;
  /** Open agent→WebUI questions/blockers awaiting a reviewer reply. */
  openMessages: Map<string, AgentMessageView>;
  activeSubmissionId?: string;
  feedbackStateBySubmission: Map<string, FeedbackState>;
  feedbackErrorBySubmission: Map<string, string>;
  feedbackMessage?: string;
  latestFeedback?: { id: string; submissionId?: string; verdict: string; comments?: string; reviewerId?: string };
  notice?: {
    tone: "error" | "warning" | "success" | "info";
    message: string;
    action?: { label: string; run: () => void };
  };
  mission?: MissionPacketView;
  missionLoading?: boolean;
  missionError?: string;
}

export interface WorkspaceSurfaceSession {
  sessionId: string;
  workspaceSessionId: string;
  status: string;
  title?: string;
  submittedBy?: string;
  runId?: string;
  lastSeq: number;
  updatedAt: string;
  lastHeartbeatAt?: string;
  lifecycle: string;
  runtimeState: string;
  hasMission: boolean;
  missionStatus?: string;
  missionCycleNumber?: number;
  missionMaxCycles?: number;
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
  latestFeedback?: { id: string; submissionId?: string; verdict: string; comments?: string; reviewerId?: string };
}

export interface WorkSessionDom {
  workSessionId: string;
  main: HTMLElement;
  sessionSwitcher: HTMLElement;
  section: HTMLElement;
  titleStatus: HTMLElement;
  statusBadge: HTMLElement;
  meta: HTMLElement;
  notice: HTMLElement;
  mission: HTMLElement;
  messages: HTMLElement;
  messageKey?: string;
  activity: HTMLUListElement;
  activitySeqs: Set<number>;
  approvals: HTMLElement;
  review: HTMLElement;
  reviewTitle: HTMLElement;
  reviewPayload: HTMLElement;
  reviewFeedback: HTMLElement;
  reviewFeedbackKey?: string;
}

export interface LegacyReviewDom {
  key: string;
  main: HTMLElement;
  body: HTMLElement;
  actions: HTMLElement;
  feedback: HTMLElement;
  feedbackKey?: string;
}
