/**
 * Review feedback + policy approval surfaces: legacy (tool-card) feedback,
 * submission-scoped feedback, and the per-approval policy cards. Extracted
 * verbatim from ui/workspace-app.tsx (P1.4). Mutable app state (active
 * workspace, confirmation memory, last card, mutation allowance) is reached
 * through an explicit host binding installed at boot, keeping this module's
 * state ownership explicit.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import type { ToolResultCard } from "./card-types.js";
import { element, stableDomId } from "./ui-dom.js";
import { formatElapsed } from "./ui-format.js";
import {
  AmbiguousMutationError,
  callServerToolChecked,
  getStructuredContent,
} from "./server-tool-call.js";
import { approvalCenterId } from "./approval-center.js";
import { ensureWorkSessionView, mergePendingApproval, workSessionViews } from "./session-views.js";
import type {
  MissionPacketView,
  PolicyApprovalView,
  PendingApprovalRecord,
  ReviewSubmissionView,
  WorkSessionViewState,
} from "./session-view-types.js";
import type { ReviewFile } from "../review-submission.js";

export interface FeedbackHost {
  hydrateWorkSessionSnapshot(view: WorkSessionViewState): Promise<void>;
  getApp(): App | null;
  render(): void;
  scheduleRender(): void;
  uiMutationsAllowed(): boolean;
  newClientMutationId(): string;
  activateWorkspace(workspaceId: string): void;
  renderEmpty(message: string, tone: "muted" | "error"): void;
  workspaceApprovalConfirmations: Set<string>;
  getActiveWorkspaceId(): string | null;
  getSelectedWorkSessionId(): string | null;
  setSelectedWorkSessionId(v: string | null): void;
  setLastToolCard(v: ToolResultCard | null): void;
}

let host: FeedbackHost;
export function setFeedbackHost(next: FeedbackHost): void {
  host = next;
}

export function reviewCardFromSubmission(submission: ReviewSubmissionView, sessionId: string): ToolResultCard {
  return {
    tool: "submit_for_review",
    workSessionId: sessionId,
    summary: {
      submissionId: submission.submissionId,
      submissionNumber: submission.submissionNumber,
      reviewEpoch: submission.reviewEpoch,
      diffSha256: submission.diffSha256,
      additions: submission.additions,
      removals: submission.removals,
    },
    files: submission.files.map((file) => ({
      path: file.path,
      previousPath: file.previousPath,
      operation: file.operation === "add" || file.operation === "update" || file.operation === "delete" || file.operation === "move"
        ? file.operation
        : undefined,
      type: file.type,
      additions: file.additions,
      removals: file.removals,
    })),
    payload: { patch: submission.patch },
  };
}

export const legacyFeedbackState = new Map<string, { submitted: boolean; submitting: boolean; outcomeUnknown?: boolean; error?: string }>();

export function legacyReviewKey(card: ToolResultCard): string {
  return String(card.summary?.submissionId ?? `${card.summary?.sessionId ?? "unknown"}:${card.tool}`);
}

export function renderFeedbackFormForSession(sessionId: string, card: ToolResultCard): HTMLElement {
  const container = element("div", { className: "feedback-form" });
  const textareaId = stableDomId(`legacy-feedback-${legacyReviewKey(card)}`);
  const label = element("label", { className: "feedback-label", text: "Review feedback", htmlFor: textareaId });
  const textarea = document.createElement("textarea");
  textarea.className = "feedback-textarea";
  textarea.id = textareaId;
  textarea.dataset.focusKey = `legacy-feedback:${legacyReviewKey(card)}`;
  textarea.placeholder = "Tell the agent what to fix, or leave blank for a clean approve/reject.";
  textarea.rows = 3;

  const state = legacyFeedbackState.get(legacyReviewKey(card)) ?? { submitted: false, submitting: false };
  if (state.error) {
    container.append(element("div", { className: "feedback-error", text: state.error }));
  }
  if (state.outcomeUnknown) {
    const refresh = element("button", { className: "notice-action", type: "button", text: "Refresh review status", disabled: state.submitting || !host.uiMutationsAllowed() });
    refresh.addEventListener("click", () => { void reconcileLegacyFeedbackOutcome(sessionId, card); });
    container.append(element("div", { className: "feedback-error", text: "Feedback outcome is unknown after a connection interruption. Refresh before trying again." }), refresh);
  }

  const buttonRow = element("div", { className: "feedback-buttons" });

  const makeButton = (verdict: string, text: string, cls: string): HTMLButtonElement => {
    const btn = element("button", { className: `feedback-btn ${cls}`, type: "button", text });
    // P1 #11: disable verdict buttons while a submission is in flight so the
    // reviewer cannot double-submit or fire overlapping feedback calls.
    if (state.submitting || state.outcomeUnknown || !host.uiMutationsAllowed()) btn.disabled = true;
    btn.addEventListener("click", () => {
      submitFeedbackForSession(sessionId, card, verdict, textarea.value.trim() || undefined);
    });
    return btn;
  };

  buttonRow.append(
    makeButton("approve", "Approve", "approve"),
    makeButton("changes_requested", "Request Changes", "changes"),
    makeButton("reject", "Reject", "reject"),
  );

  container.append(label, textarea, buttonRow);
  return container;
}

export async function submitFeedbackForSession(sessionId: string, card: ToolResultCard, verdict: string, comments?: string): Promise<void> {
  if (!sessionId || !host.getApp()) return;
  if (verdict === "changes_requested" && !comments?.trim()) {
    legacyFeedbackState.set(legacyReviewKey(card), { submitted: false, submitting: false, error: "Request Changes requires concrete instructions for the agent." });
    host.scheduleRender();
    return;
  }
  const key = legacyReviewKey(card);
  legacyFeedbackState.set(key, { submitted: false, submitting: true });
  host.scheduleRender();
  try {
    await callServerToolChecked({
      name: "provide_review_feedback",
      arguments: {
        sessionId,
        submissionId: typeof card.summary?.submissionId === "string" ? card.summary.submissionId : undefined,
        diffSha256: typeof card.summary?.diffSha256 === "string" ? card.summary.diffSha256 : undefined,
        reviewEpoch: typeof card.summary?.reviewEpoch === "number" ? card.summary.reviewEpoch : undefined,
        verdict,
        comments,
        clientMutationId: host.newClientMutationId(),
      },
    });
    legacyFeedbackState.set(key, { submitted: true, submitting: false });
    host.scheduleRender();
  } catch (err) {
    // P1 #11: surface the transport / worker execution failure instead of
    // swallowing it — the reviewer needs to know the feedback did not land.
    legacyFeedbackState.set(key, {
      submitted: false,
      submitting: false,
      outcomeUnknown: err instanceof AmbiguousMutationError,
      error: err instanceof AmbiguousMutationError
        ? "Feedback outcome is unknown after a connection interruption. Refresh authoritative review state before trying again."
        : "Failed to submit feedback: " + (err instanceof Error ? err.message : String(err)),
    });
    host.scheduleRender();
  }
}

export async function reconcileLegacyFeedbackOutcome(sessionId: string, card: ToolResultCard): Promise<void> {
  const key = legacyReviewKey(card);
  const current = legacyFeedbackState.get(key) ?? { submitted: false, submitting: false, outcomeUnknown: true };
  legacyFeedbackState.set(key, { ...current, submitting: true });
  host.render();
  try {
    const view = ensureWorkSessionView(sessionId, host.getActiveWorkspaceId() ?? "", "");
    await host.hydrateWorkSessionSnapshot(view);
    const expectedSubmissionId = typeof card.summary?.submissionId === "string" ? card.summary.submissionId : undefined;
    if (expectedSubmissionId && view.latestFeedback?.submissionId === expectedSubmissionId) {
      legacyFeedbackState.set(key, { submitted: true, submitting: false });
    } else {
      legacyFeedbackState.set(key, {
        submitted: false,
        submitting: false,
        outcomeUnknown: true,
        error: "Authoritative review state does not confirm this feedback yet. Keep the action paused and refresh again later.",
      });
    }
  } catch (error) {
    legacyFeedbackState.set(key, {
      submitted: false,
      submitting: false,
      outcomeUnknown: true,
      error: `Review reconciliation did not complete: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  host.render();
}

export function renderFeedbackSubmittedGlobal(): HTMLElement {
  return element("div", { className: "feedback-submitted", text: "Feedback submitted. The waiting agent has been notified." });
}

export function renderApprovalCenterCard(card: ToolResultCard): void {
  const approvals = Array.isArray(card.summary?.approvals)
    ? card.summary.approvals as Array<Record<string, unknown>>
    : [];
  const inferredWorkspaceId = host.getActiveWorkspaceId()
    ?? (typeof approvals[0]?.workspaceId === "string" ? approvals[0].workspaceId : undefined)
    ?? (typeof approvals[0]?.workspaceSessionId === "string" ? approvals[0].workspaceSessionId : undefined);
  if (!inferredWorkspaceId) {
    host.renderEmpty("Approval center requires a workspace context.", "error");
    return;
  }
  if (host.getActiveWorkspaceId() !== inferredWorkspaceId) host.activateWorkspace(inferredWorkspaceId);
  const center = ensureWorkSessionView(approvalCenterId(inferredWorkspaceId), inferredWorkspaceId, "");
  center.policyApprovals.clear();
  for (const approval of approvals) {
    mergePendingApproval(center, {
      approvalId: String(approval.id ?? approval.approvalId ?? ""),
      workspaceId: typeof approval.workspaceId === "string" ? approval.workspaceId : inferredWorkspaceId,
      workspaceSessionId: typeof approval.workspaceSessionId === "string" ? approval.workspaceSessionId : inferredWorkspaceId,
      workSessionId: typeof approval.workSessionId === "string" ? approval.workSessionId : undefined,
      kind: typeof approval.kind === "string" ? approval.kind : undefined,
      title: typeof approval.title === "string" ? approval.title : undefined,
      description: typeof approval.description === "string" ? approval.description : undefined,
      risk: typeof approval.risk === "string" ? approval.risk : undefined,
      tool: typeof approval.tool === "string" ? approval.tool : undefined,
      path: typeof approval.path === "string" ? approval.path : undefined,
      command: typeof approval.command === "string" ? approval.command : undefined,
      origin: approval.origin === "direct_mcp" || approval.origin === "work_session" ? approval.origin : undefined,
      conversationId: typeof approval.conversationId === "string" ? approval.conversationId : undefined,
      orphanedAt: typeof approval.orphanedAt === "string" ? approval.orphanedAt : undefined,
      reattachDeadline: typeof approval.reattachDeadline === "string" ? approval.reattachDeadline : undefined,
      liveWaiterCount: typeof approval.liveWaiterCount === "number" ? approval.liveWaiterCount : undefined,
      requestedAt: typeof approval.requestedAt === "string" ? approval.requestedAt : undefined,
      createdAt: typeof approval.createdAt === "string" ? approval.createdAt : undefined,
      expiresAt: typeof approval.expiresAt === "string" ? approval.expiresAt : undefined,
      options: parsePolicyApprovalOptions(approval.options),
    }, inferredWorkspaceId);
  }
  center.pendingApprovalCount = center.policyApprovals.size;
  host.setSelectedWorkSessionId(center.workSessionId);
  host.setLastToolCard(null);
  host.scheduleRender();
}

// ── Work-session feedback form ────────────────────────

export function renderFeedbackFormForSubmission(view: WorkSessionViewState, submission: ReviewSubmissionView): HTMLElement {
  const container = element("div", { className: "feedback-form" });
  const textareaId = stableDomId(`feedback-${submission.submissionId}`);
  const label = element("label", { className: "feedback-label", text: "Review feedback", htmlFor: textareaId });
  const textarea = document.createElement("textarea");
  textarea.className = "feedback-textarea";
  textarea.id = textareaId;
  textarea.dataset.focusKey = `feedback:${submission.submissionId}`;
  textarea.placeholder = "Tell the agent what to fix, or leave blank for a clean approve/reject.";
  textarea.rows = 3;

  const submissionId = submission.submissionId;
  const state = view.feedbackStateBySubmission.get(submissionId);
  const isSubmitting = state === "submitting";
  const isError = state === "error";
  const outcomeUnknown = state === "outcome_unknown";

  if (isError && view.feedbackErrorBySubmission.get(submissionId)) {
    container.append(element("div", { className: "feedback-error", text: view.feedbackErrorBySubmission.get(submissionId) ?? "" }));
  }
  if (outcomeUnknown) {
    container.append(element("div", { className: "feedback-error", text: "Feedback outcome is unknown after a connection interruption. Refresh authoritative session state before trying again." }));
    const refresh = element("button", { className: "notice-action", type: "button", text: "Refresh session state", disabled: !host.uiMutationsAllowed() });
    refresh.addEventListener("click", () => { void reconcileFeedbackOutcome(view, submissionId); });
    container.append(refresh);
  }

  const buttonRow = element("div", { className: "feedback-buttons" });

  const makeButton = (verdict: string, text: string, cls: string): HTMLButtonElement => {
    const btn = element("button", { className: `feedback-btn ${cls}`, type: "button", text });
    // P1 #11: disable verdict buttons while a submission is in flight.
    if (isSubmitting || outcomeUnknown || !host.uiMutationsAllowed()) btn.disabled = true;
    btn.addEventListener("click", () => {
      submitFeedbackForSubmission(view, submission, verdict, textarea.value.trim() || undefined);
    });
    return btn;
  };

  buttonRow.append(
    makeButton("approve", view.mission ? "Check Mission Approval" : "Approve", "approve"),
    makeButton("changes_requested", "Request Changes", "changes"),
    makeButton("reject", "Reject", "reject"),
  );

  container.append(label, textarea, buttonRow);
  return container;
}

export async function submitFeedbackForSubmission(view: WorkSessionViewState, submission: ReviewSubmissionView, verdict: string, comments?: string): Promise<void> {
  if (!host.getApp()) return;
  const submissionId = submission.submissionId;
  if (verdict === "changes_requested" && !comments?.trim()) {
    view.feedbackStateBySubmission.set(submissionId, "error");
    view.feedbackErrorBySubmission.set(submissionId, "Request Changes requires concrete instructions for the agent.");
    host.render();
    return;
  }
  view.feedbackStateBySubmission.set(submissionId, "submitting");
  view.feedbackErrorBySubmission.delete(submissionId);
  host.render();
  try {
    if (verdict === "approve" && view.mission) {
      const result = await callServerToolChecked({
        name: "approve_supervised_work",
        arguments: { workSessionId: view.workSessionId, comments, clientMutationId: host.newClientMutationId() },
      });
      const approval = getStructuredContent<{ approved?: boolean; reasons?: string[]; packet?: MissionPacketView }>(result);
      if (!approval?.approved) {
        throw new Error(approval?.reasons?.join("; ") || "Mission approval remains blocked.");
      }
      if (approval.packet) view.mission = approval.packet;
    } else {
      await callServerToolChecked({
        name: "provide_review_feedback",
        arguments: {
          sessionId: view.workSessionId,
          submissionId,
          diffSha256: submission.diffSha256,
          reviewEpoch: submission.reviewEpoch,
          verdict,
          comments,
          clientMutationId: host.newClientMutationId(),
        },
      });
    }
    view.feedbackStateBySubmission.set(submissionId, "submitted");
    view.feedbackMessage = "Feedback submitted. The waiting agent has been notified.";
  } catch (err) {
    // P1 #11: surface the transport / worker execution failure instead of
    // leaving the reviewer blind.
    view.feedbackStateBySubmission.set(submissionId, err instanceof AmbiguousMutationError ? "outcome_unknown" : "error");
    view.feedbackErrorBySubmission.set(
      submissionId,
      "Failed to submit feedback: " + (err instanceof Error ? err.message : String(err)),
    );
  }
  host.render();
}

export async function reconcileFeedbackOutcome(view: WorkSessionViewState, submissionId: string): Promise<void> {
  if (!host.getApp() || !host.uiMutationsAllowed()) return;
  try {
    await host.hydrateWorkSessionSnapshot(view);
    if (view.latestFeedback?.submissionId === submissionId) {
      view.feedbackStateBySubmission.set(submissionId, "submitted");
      view.feedbackErrorBySubmission.delete(submissionId);
    } else {
      view.feedbackStateBySubmission.set(submissionId, "outcome_unknown");
      view.feedbackErrorBySubmission.set(submissionId, "The session is refreshed, but this feedback outcome is still not authoritative. Do not submit again until the review state is confirmed.");
    }
  } catch (error) {
    view.feedbackStateBySubmission.set(submissionId, "outcome_unknown");
    view.feedbackErrorBySubmission.set(submissionId, `Review state refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  host.render();
}

export function renderFeedbackSubmitted(view: WorkSessionViewState): HTMLElement {
  return element("div", { className: "feedback-submitted", text: view.feedbackMessage ?? "Feedback submitted. The waiting agent has been notified." });
}

export function renderPolicyApproval(view: WorkSessionViewState, approval: PolicyApprovalView): HTMLElement {
  const item = element("div", { className: "approval-card" });
  const title = element("div", { className: "approval-title", text: approval.title ?? approval.tool });
  const workspace = approval.workspaceId ?? host.getActiveWorkspaceId() ?? view.workspaceSessionId;
  const source = approval.origin === "work_session"
    ? `Work session${approval.workSessionId ? ` · ${approval.workSessionId}` : ""}`
    : `Direct MCP${approval.conversationId ? ` · ${approval.conversationId}` : ""}`;
  const lifecycle = approval.orphanedAt
    ? ` · orphaned ${new Date(approval.orphanedAt).toLocaleString()}${approval.reattachDeadline ? ` · reattach until ${new Date(approval.reattachDeadline).toLocaleString()}` : ""}`
    : approval.liveWaiterCount !== undefined
      ? ` · ${approval.liveWaiterCount} live waiter${approval.liveWaiterCount === 1 ? "" : "s"}`
      : "";
  const requestedAt = approval.requestedAt ?? approval.createdAt;
  const requestedMs = requestedAt ? Date.parse(requestedAt) : Number.NaN;
  const age = Number.isFinite(requestedMs)
    ? ` · age ${formatElapsed(Math.max(0, Date.now() - requestedMs))}`
    : "";
  const expiresMs = approval.expiresAt ? Date.parse(approval.expiresAt) : Number.NaN;
  const expired = Number.isFinite(expiresMs) && expiresMs <= Date.now();
  const reattachDeadlineMs = approval.reattachDeadline ? Date.parse(approval.reattachDeadline) : Number.NaN;
  const reattachExpired = Boolean(approval.orphanedAt) && Number.isFinite(reattachDeadlineMs) && reattachDeadlineMs <= Date.now();
  const expiry = Number.isFinite(expiresMs)
    ? expired ? " · expired" : ` · expires ${new Date(expiresMs).toLocaleString()}`
    : "";
  const metadata = element("div", {
    className: "approval-meta",
    text: `${source} · workspace ${workspace ?? "unknown"} · ${approval.tool}${approval.risk ? ` · risk ${approval.risk}` : ""}${age}${expiry}${lifecycle}`,
  });
  const detail = element("div", {
    className: "approval-detail",
    text: approval.description ?? approval.command ?? approval.path ?? approval.matchedPattern ?? approval.approvalKey ?? approval.approvalId,
  });
  const buttons = element("div", { className: "feedback-buttons" });
  if (expired || reattachExpired) {
    item.append(title, metadata, detail, element("div", {
      className: "feedback-error",
      text: expired
        ? "This approval has expired and is no longer actionable. Refresh the workspace state."
        : "This detached approval can no longer be reattached. Refresh the workspace state.",
    }));
    return item;
  }
  const suppliedOptions = approval.options;
  const invalidOptions = suppliedOptions?.some((option) => option.scope === "work_session" && !approval.workSessionId) ?? false;
  if (!suppliedOptions?.length || invalidOptions) {
    item.append(element("div", {
      className: "feedback-error",
      text: invalidOptions
        ? "Approval options are inconsistent with the bound work session. No action is available until the server refreshes this request."
        : "Approval options were not supplied by the server. No action is available (fail-closed).",
    }));
    if (approval.error) item.append(element("div", { className: "feedback-error", text: approval.error }));
    return item;
  }
  const options = suppliedOptions.filter((option) => option.scope !== "work_session" || Boolean(approval.workSessionId));
  if (options.length === 0) {
    item.append(element("div", { className: "feedback-error", text: "No valid approval option is available for this request." }));
    return item;
  }
  const makeButton = (option: NonNullable<PolicyApprovalView["options"]>[number]): HTMLButtonElement => {
    const cls = option.effect === "deny" ? "reject" : option.effect === "changes_requested" ? "changes" : "approve";
    const confirmationKey = `${approval.approvalId}:${option.id}`;
    const needsConfirmation = option.scope === "workspace" && !host.workspaceApprovalConfirmations.has(confirmationKey);
    const btn = element("button", {
      className: `feedback-btn ${cls}${option.scope === "workspace" ? " broad-scope" : ""}`,
      type: "button",
      text: needsConfirmation ? `Confirm ${option.label}` : option.label,
      disabled: !host.uiMutationsAllowed() || approval.uiState === "submitting" || approval.uiState === "outcome_unknown",
    });
    btn.dataset.focusKey = `approval:${approval.approvalId}:${option.id}`;
    const scopeDescription = option.scope === "workspace"
      ? "Applies to matching operations across this workspace."
      : option.scope === "work_session"
        ? "Applies only to this work session."
        : option.scope === "once"
          ? "Applies to this operation only."
          : "The server did not provide a reusable scope for this action; its consequence is server-defined.";
    buttons.append(element("span", { className: "approval-option-help", text: scopeDescription }));
    btn.addEventListener("click", () => {
      if (option.scope === "workspace" && !host.workspaceApprovalConfirmations.has(confirmationKey)) {
        host.workspaceApprovalConfirmations.add(confirmationKey);
        host.render();
        return;
      }
      void submitPolicyApproval(view, approval.approvalId, option.id);
    });
    return btn;
  };
  // Keep consequence descriptions adjacent to their controls so a broad grant
  // cannot be mistaken for an approve-once action.
  const optionRows = options.map((option) => {
    const row = element("div", { className: "approval-option" });
    const before = buttons.children.length;
    const button = makeButton(option);
    const help = buttons.lastElementChild;
    if (help) buttons.removeChild(help);
    row.append(button);
    if (help) row.append(help);
    void before;
    return row;
  });
  buttons.append(...optionRows);
  item.append(title, metadata, detail, buttons);
  if (approval.uiState === "outcome_unknown") {
    const refresh = element("button", { className: "notice-action", type: "button", text: "Refresh approval status", disabled: !host.uiMutationsAllowed() });
    refresh.addEventListener("click", () => { void reconcilePolicyApproval(view, approval.approvalId); });
    item.append(element("div", { className: "feedback-error", text: "Approval outcome is unknown after a connection interruption. Refresh the authoritative pending state before trying again." }), refresh);
  }
  if (approval.error) item.append(element("div", { className: "feedback-error", text: approval.error }));
  return item;
}

export async function submitPolicyApproval(
  view: WorkSessionViewState,
  approvalId: string,
  decision: string,
): Promise<void> {
  if (!host.getApp()) return;
  const approval = view.policyApprovals.get(approvalId);
  if (approval) {
    approval.uiState = "submitting";
    approval.error = undefined;
  }
  host.render();
  try {
    await callServerToolChecked({
      name: "provide_policy_approval",
      arguments: { approvalId, decision, clientMutationId: host.newClientMutationId() },
    });
    const latest = view.policyApprovals.get(approvalId);
    if (latest) latest.uiState = "resolved";
    view.policyApprovals.delete(approvalId);
  } catch (err) {
    const latest = view.policyApprovals.get(approvalId);
    if (latest) {
      latest.uiState = err instanceof AmbiguousMutationError ? "outcome_unknown" : "error";
      latest.error = err instanceof AmbiguousMutationError
        ? "Approval outcome is unknown after a connection interruption. Refresh authoritative approval state before trying again."
        : "Failed to submit approval: " + (err instanceof Error ? err.message : String(err));
    }
  }
  host.render();
}

export async function reconcilePolicyApproval(view: WorkSessionViewState, approvalId: string): Promise<void> {
  if (!host.getApp() || !host.uiMutationsAllowed()) return;
  try {
    const result = await callServerToolChecked({
      name: "list_pending_approvals",
      arguments: { workspaceId: view.workspaceSessionId },
    });
    const pending = getStructuredContent<{ approvals?: PendingApprovalRecord[] }>(result)?.approvals ?? [];
    const current = pending.find((entry) => entry.approvalId === approvalId);
    if (!current) {
      view.policyApprovals.delete(approvalId);
      view.pendingApprovalCount = view.policyApprovals.size;
    } else {
      mergePendingApproval(view, current, view.workspaceSessionId);
      const refreshed = view.policyApprovals.get(approvalId);
      if (refreshed) {
        refreshed.uiState = "idle";
        refreshed.error = undefined;
      }
    }
  } catch (error) {
    const current = view.policyApprovals.get(approvalId);
    if (current) current.error = `Approval status refresh failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  host.render();
}

export function parsePolicyApprovalOptions(value: unknown): PolicyApprovalView["options"] {
  if (!Array.isArray(value)) return undefined;
  const options = value.flatMap((entry): NonNullable<PolicyApprovalView["options"]> => {
    if (!entry || typeof entry !== "object") return [];
    const obj = entry as Record<string, unknown>;
    if (typeof obj.id !== "string" || typeof obj.label !== "string") return [];
    if (obj.effect !== "approve" && obj.effect !== "deny" && obj.effect !== "changes_requested") return [];
    return [{
      id: obj.id,
      label: obj.label,
      effect: obj.effect,
      scope: obj.scope === "once" || obj.scope === "work_session" || obj.scope === "workspace" ? obj.scope : undefined,
    }];
  });
  return options.length ? options : undefined;
}
