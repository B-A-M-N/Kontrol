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
  /** P1 (audit): present only when the diff cannot represent every structured
   * mutation — the UI must name these paths and gate ordinary approval. */
  coverage?: { status: "complete" | "incomplete" | "unknown"; backend: "git" | "filesystem" | "unknown"; uncoveredPaths: string[]; reasons: string[]; assessedAt: string; errorCode?: string };
};

export type ApprovalOutcome =
  | "approved_pending_retry"
  // "executed" requires an execution receipt tied to the operation; approval
  // consumption alone must use "authorization_consumed". No producer emits
  // "executed" yet.
  | "executed"
  | "authorization_consumed"
  | "denied"
  | "expired"
  | "cancelled"
  | "unknown";

export interface ApprovalOutcomeRecord {
  approvalId: string;
  title?: string;
  outcome: ApprovalOutcome;
  detail: string;
}

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
  /**
   * Stable idempotency key for the in-flight approval decision. Bound to
   * the exact {approvalId, decision} pair (see clientMutationDecision):
   * generated once per decision attempt and retained until the outcome is
   * known, so a retry of the identical decision resends the identical
   * mutation instead of minting a second one. A changed decision always
   * mints a distinct key — the server rejects a reused key with different
   * request content as a conflict.
   */
  clientMutationId?: string;
  /** The decision the stored clientMutationId was minted for. */
  clientMutationDecision?: string;
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

export interface PolicyGrantView {
  id: string;
  principalId: string;
  scope: "work_session" | "workspace";
  scopeId: string;
  approvalKey: string;
  createdAt: string;
  expiresAt?: string;
  reviewerId?: string;
  uiState?: "idle" | "revoking" | "error";
  error?: string;
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
  replyId?: string;
  replyStatus?: string;
  replyBody?: string;
  replyDeliveryAttemptNumber?: number;
  replyDestinationAgentId?: string;
  replyDestinationAgentName?: string;
}

export interface MissionPacketView {
  supervisor?: { id: string; status: string; resumeStatus?: string | null; revision: number; cycleNumber: number; maxCycles: number; autonomyMode: string; approvalMode: string; repeatedFailureCount?: number; repeatedFailureFingerprintLimit?: number; stagnantCycleCount?: number; progressJson?: string | null; stallReason?: string | null; updatedAt?: string; deadlineAt?: string; lastError?: string };
  mission?: { id: string; objective: string; desiredOutcome?: string; correctionRounds?: number; maxCorrectionRounds?: number };
  criteria: Array<{ id: string; description: string; priority: string; status: string; verificationType?: string; verificationCommand?: string; runtimeProbe?: { url: string; method?: string; expectedStatus?: number; bodyIncludes?: string }; dependsOnCriterionIds?: string[] }>;
  criterionStates?: Array<{ criterionId: string; status: string; staleReason?: string; dependenciesSatisfied: boolean }>;
  findings: Array<{ id: string; description: string; severity: string; scope: string; status: string; requiredAction?: string; requiredVerification?: string[] }>;
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
  agentPtys?: Array<{
    processSessionId: string;
    agentName: string;
    processGeneration: number;
    outputCursor: number;
    status: "attached" | "detached" | "exited" | "lost";
    createdAt: string;
    finishedAt?: string;
  }>;
  reviewLoop?: {
    routeId: string;
    reviewThreadId?: string;
    reviewThreadStatus?: string;
    status: string;
    mode: string;
    completedReviewRounds: number;
    admittedReviewRounds: number;
    maxReviewRounds: number;
    roundNumber?: number;
    handoffId?: string;
    handoffStatus?: string;
    deliveryTransport?: string;
    browserProfileId?: string;
    conversation?: {
      key?: string;
      url?: string;
      bindingStatus?: string;
      bindingRevision?: number;
      browserGeneration?: number;
    };
    deliveryMessage?: { messageId: string; kind: string; status: string; updatedAt: string };
    browserAttempt?: {
      attemptId: string;
      status: string;
      attemptNumber: number;
      errorCode?: string;
      submittedAt?: string;
      generationStartedAt?: string;
      generationFinishedAt?: string;
    };
  };
  lifecycle?: string;
  runtimeState?: string;
  unresolvedMessageCount: number;
  pendingApprovalCount: number;
  lastSeq: number;
  activity: AgentActivityEvent[];
  submissions: Map<string, ReviewSubmissionView>;
  policyApprovals: Map<string, PolicyApprovalView>;
  /**
   * Recently resolved approvals, newest last, bounded in
   * recordApprovalOutcome. Terminal cards are deleted from policyApprovals,
   * so without this the reviewer could never distinguish "approved, retry
   * the original call" from "operation completed". "executing" is
   * deliberately absent: this surface cannot observe execution, only the
   * decision, its consumption, and the server-reported terminal state.
   */
  recentApprovalOutcomes: ApprovalOutcomeRecord[];
  policyGrants: Map<string, PolicyGrantView>;
  policyGrantsLoaded: boolean;
  policyGrantsError?: string;
  /** Open agent→WebUI questions/blockers awaiting a reviewer reply. */
  openMessages: Map<string, AgentMessageView>;
  /** Latest durable browser-turn status per attempt (human-visible continuity). */
  browserTurnStatus: Map<string, { status: string; updatedAt: string }>;
  activeSubmissionId?: string;
  feedbackStateBySubmission: Map<string, FeedbackState>;
  feedbackErrorBySubmission: Map<string, string>;
  feedbackMessage?: string;
  latestFeedback?: { id: string; submissionId?: string; verdict: string; comments?: string; reviewerId?: string };
  notice?: {
    tone: "error" | "warning" | "success" | "info";
    message: string;
    /** Owner boundary for narrowly scoped lifecycle cleanup. */
    owner?: "workspace-watcher" | "selected-session-transport";
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
