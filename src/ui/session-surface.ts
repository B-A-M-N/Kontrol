/**
 * Session-surface render components: the composed work-session view, session
 * switcher, approval gate banner, direct-approval attention surfacing,
 * open-message surface, activity timeline, agent submit bar, and the legacy
 * review card. Extracted verbatim from ui/workspace-app.tsx (P1.4); mutable
 * app state (selection, attention, agent bar, DOM caches) is reached through
 * an explicit host binding installed at boot.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isAgentRunCard,
  isReviewTool,
  summaryNumber,
  type ToolResultCard,
} from "./card-types.js";
import { element, agentIcon, iconSvg, stableDomId } from "./ui-dom.js";
import { humanizeStatus } from "./ui-format.js";
import { isLiveAgentSession, relativeSessionAge } from "./session-view-helpers.js";
import { sessionCategory } from "./session-view-helpers.js";
import { approvalCenterId, isApprovalCenterId } from "./approval-center.js";
import { ensureWorkSessionView, workSessionViews } from "./session-views.js";
import type {
  AgentActivityEvent,
  PolicyApprovalView,
  ReviewSubmissionView,
  WorkSessionViewState,
} from "./session-view-types.js";
import { approvalAttentionDecision, initialApprovalAttentionState } from "./approval-attention.js";
import {
  getStructuredContent,
  AmbiguousMutationError,
} from "./server-tool-call.js";
import {
  currentPayloadContainerElement,
  ensureSurface,
  hasMountedPayload,
  renderPayloadIfNeeded,
  renderSummaryBadge,
  setPayloadContainer,
  unmountPayload,
} from "./payload-mount.js";
import {
  legacyFeedbackState,
  legacyReviewKey,
  renderFeedbackFormForSession,
  renderFeedbackFormForSubmission,
  renderFeedbackSubmitted,
  renderFeedbackSubmittedGlobal,
  renderPolicyApproval,
} from "./review-feedback.js";
import { eventLabel, renderMissionPanel } from "./mission-panel.js";
import {
  hydrateWorkSessionSnapshot,
  loadHistoricalPendingReviews,
  queueSessionRehydration,
} from "./session-hydration.js";
import type { ApprovalAttentionState } from "./approval-attention.js";
import type {
  LegacyReviewDom,
  WorkSessionDom,
} from "./session-view-types.js";
import type { ToolDisplay } from "./tool-display.js";

export interface SessionSurfaceHost {
  getApp(): App | null;
  scheduleRender(): void;
  uiMutationsAllowed(): boolean;
  newClientMutationId(): string;
  getActiveWorkspaceId(): string | null;
  getSelectedWorkSessionId(): string | null;
  setSelectedWorkSessionId(v: string | null): void;
  getApprovalAttention(): ApprovalAttentionState;
  setApprovalAttention(v: ApprovalAttentionState): void;
  getApprovalAttentionReturnSessionId(): string | null;
  setPendingApprovalReturnSessionId(v: string | null): void;
  approvalAttentionDelivered: Set<string>;
  getCurrentWorkSessionDom(): WorkSessionDom | null;
  setCurrentWorkSessionDom(v: WorkSessionDom | null): void;
  getCurrentLegacyReviewDom(): LegacyReviewDom | null;
  setCurrentLegacyReviewDom(v: LegacyReviewDom | null): void;
  replaceSurfaceChildren(...children: HTMLElement[]): void;
  appendSurface(child: HTMLElement): void;
  surfaceContains(el: HTMLElement): boolean;
  getExpanded(): boolean;
  setExpanded(v: boolean): void;
  getReviewFilesExpanded(): boolean;
  setReviewFilesExpanded(v: boolean): void;
  getAgentBar(): HTMLElement | null;
  setAgentBar(v: HTMLElement | null): void;
  messageMutationOutcomeUnknown: Set<string>;
  rehydrationPromise(): Promise<void> | null;
  reconnect(reason: unknown): Promise<void>;
  queueSessionRehydration(): void;
  callServerToolChecked(request: { name: string; arguments: Record<string, unknown> }): Promise<CallToolResult>;
  selectWorkSession(workSessionId: string): void;
  setSelectionAttention(workSessionId: string, isCenter: (id: string | null | undefined) => boolean): void;
  reviewerInputHasFocus(): boolean;
  getLastSuccessfulHydrationAt(): string | null;
  connected(): boolean;
  connectionState(): string;
  render(): void;
  historicalPendingReviewsLoaded(): boolean;
  reviewCardFromSubmission(submission: ReviewSubmissionView, sessionId: string): ToolResultCard;
  getLastToolCard(): ToolResultCard | null;
  getErrorMessage(): string | null;
  setLastToolCard(v: ToolResultCard | null): void;
  setErrorMessage(v: string | null): void;
}

// Pre-boot renders (uiTestMode drives render paths before boot installs the
// real host) still need the surface attached to the document root.
function fallbackSurfaceRoot(): HTMLElement {
  return document.querySelector<HTMLElement>("#app") ?? document.body;
}

const unsetSurfaceHost: SessionSurfaceHost = new Proxy({} as SessionSurfaceHost, {
  get(_target, prop) {
    if (prop === "approvalAttentionDelivered" || prop === "messageMutationOutcomeUnknown") return new Set();
    if (prop === "getCurrentWorkSessionDom" || prop === "getCurrentLegacyReviewDom"
      || prop === "getAgentBar" || prop === "getSelectedWorkSessionId" || prop === "getActiveWorkspaceId"
      || prop === "getLastToolCard") return () => null;
    if (prop === "getApprovalAttention") return () => initialApprovalAttentionState;
    if (prop === "replaceSurfaceChildren") {
      return (...children: HTMLElement[]) => { fallbackSurfaceRoot().replaceChildren(...children); };
    }
    if (prop === "appendSurface") {
      return (child: HTMLElement) => { fallbackSurfaceRoot().append(child); };
    }
    if (prop === "surfaceContains") {
      return (el: HTMLElement) => fallbackSurfaceRoot().contains(el);
    }
    return () => undefined;
  },
});

let host: SessionSurfaceHost = unsetSurfaceHost;

// The agent submit bar is rebuilt per surface attachment; module-owned cache.
let agentBar: HTMLElement | null = null;
export function setSessionSurfaceHost(next: SessionSurfaceHost): void {
  host = next;
}

export function renderWorkSessionView(view: WorkSessionViewState): void {
  ensureSurface(`session:${view.workSessionId}`);
  const dom = host.getCurrentWorkSessionDom() ?? createWorkSessionDom(view.workSessionId);
  host.setCurrentWorkSessionDom(dom);

  dom.titleStatus.textContent = isApprovalCenterId(view.workSessionId)
    ? "Approval Center"
    : view.title ?? "Coding agent task";
  dom.statusBadge.textContent = humanizeStatus(view.status);
  dom.meta.replaceChildren();
  const primaryMeta = element("div", {
    className: "agent-meta-primary",
    text: `${humanizeStatus(view.lifecycle ?? view.status)}${view.updatedAt ? ` · updated ${relativeSessionAge(view.updatedAt)}` : ""}`,
  });
  dom.meta.append(primaryMeta);
  if (view.lastHeartbeatAt) {
    const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(view.lastHeartbeatAt)) / 1000));
    dom.meta.append(element("span", {
      className: `agent-meta-row heartbeat-status${isLiveAgentSession(view) ? " live" : " stale"}`,
      text: isLiveAgentSession(view) ? `● Agent connected · heartbeat ${ageSeconds}s ago` : `Last heartbeat · ${ageSeconds}s ago`,
    }));
  } else {
    dom.meta.append(element("span", {
      className: "agent-meta-row heartbeat-status stale",
      text: "Agent heartbeat unavailable",
    }));
  }
      const details = element("details", { className: "agent-details" });
  details.append(element("summary", { text: "Session details" }));
  if (view.workspaceSessionId) details.append(element("span", { className: "agent-meta-row", text: `workspace session: ${view.workspaceSessionId}` }));
  if (view.workSessionId) details.append(element("span", { className: "agent-meta-row", text: `work session: ${view.workSessionId}` }));
  if (view.runId) details.append(element("span", { className: "agent-meta-row", text: `run: ${view.runId}` }));
  if (view.lifecycle) details.append(element("span", { className: "agent-meta-row", text: `lifecycle: ${humanizeStatus(view.lifecycle)}` }));
  dom.meta.append(details);
  const hydrationAt = host.getLastSuccessfulHydrationAt();
  if (hydrationAt) {
    dom.meta.append(element("span", {
      className: "agent-meta-row",
      text: `state synced · ${new Date(hydrationAt).toLocaleTimeString()}`,
    }));
  }
  if (!host.connected()) {
    dom.section.querySelector(":scope > .connection-banner")?.remove();
    const banner = element("div", { className: "session-notice warning connection-banner", role: "status" });
    banner.append(element("span", { text: host.connectionState() === "RECONNECTING" ? "Connection interrupted. Showing last known state while reconnecting." : "Host connection is unavailable. Mutations are paused." }));
    dom.section.prepend(banner);
  } else {
    dom.section.querySelector(":scope > .connection-banner")?.remove();
  }

  renderSessionSwitcher(dom.sessionSwitcher);
  renderSessionNotice(dom.notice, view);
  // P0.3: a direct approval must be discoverable on every current surface.
  // When the reviewer's focus is inside an input/textarea, focus is preserved
  // and the high-priority banner carries the action instead.
  renderSessionApprovalGateBanner(dom, view);
  const missionKey = `${view.missionLoading ? "loading" : "ready"}:${view.missionError ?? ""}:${view.mission ? JSON.stringify(view.mission) : "none"}`;
  if (dom.mission.dataset.stateKey !== missionKey) {
    dom.mission.replaceChildren();
    if (view.missionLoading) {
      dom.mission.append(element("div", { className: "status muted", text: "Loading supervision state…" }));
    } else if (view.mission) {
      dom.mission.append(renderMissionPanel(view));
    } else if (view.missionError) {
      dom.mission.append(element("div", { className: "status error", text: `Supervision state could not be loaded: ${view.missionError}` }));
    }
    dom.mission.dataset.stateKey = missionKey;
  }

  renderOpenMessages(dom.messages, view);
  renderActivityIncrementally(dom, view);
  dom.approvals.replaceChildren();
  if (view.policyApprovals.size > 0) {
    dom.approvals.append(element("div", { className: "agent-activity-header", text: "Policy approvals" }));
    const approvals = element("div", { className: "approval-list" });
    for (const approval of view.policyApprovals.values()) approvals.append(renderPolicyApproval(view, approval));
    dom.approvals.append(approvals);
  }

  const submission = view.activeSubmissionId ? view.submissions.get(view.activeSubmissionId) : undefined;
  if (submission) {
    dom.review.hidden = false;
    dom.reviewTitle.textContent = `Review submission #${submission.submissionNumber}`;
    const submissionCard = host.reviewCardFromSubmission(submission, view.workSessionId);
    if (submission.patch) {
      dom.reviewPayload.removeAttribute("data-loading-key");
      setPayloadContainer(dom.reviewPayload);
      renderPayloadIfNeeded(submissionCard);
    } else {
      const loadingKey = `loading:${submission.submissionId}`;
      if (dom.reviewPayload.dataset.loadingKey !== loadingKey) {
        if (currentPayloadContainerElement() === dom.reviewPayload && hasMountedPayload()) unmountPayload();
        dom.reviewPayload.replaceChildren(element("div", { className: "status muted", text: "Loading review details…" }));
        dom.reviewPayload.dataset.loadingKey = loadingKey;
      }
      setPayloadContainer(dom.reviewPayload);
    }
    const fbState = view.feedbackStateBySubmission.get(submission.submissionId) ?? "idle";
    const feedbackKey = `${submission.submissionId}:${fbState}:${view.feedbackErrorBySubmission.get(submission.submissionId) ?? ""}:${view.mission ? "mission" : "review"}`;
    if (dom.reviewFeedbackKey !== feedbackKey) {
      dom.reviewFeedback.replaceChildren(
        fbState === "submitted"
          ? renderFeedbackSubmitted(view)
          : renderFeedbackFormForSubmission(view, submission),
      );
      dom.reviewFeedbackKey = feedbackKey;
    }
  } else {
    dom.review.hidden = false;
    dom.reviewTitle.textContent = "Review status";
    if (currentPayloadContainerElement() === dom.reviewPayload) unmountPayload();
    setPayloadContainer(dom.reviewPayload);
    dom.reviewPayload.replaceChildren();
    dom.reviewPayload.removeAttribute("data-loading-key");
    if (view.status === "awaiting_review") dom.reviewPayload.append(element("div", { className: "empty muted", text: "Awaiting review submission…" }));
    else dom.review.hidden = true;
    dom.reviewFeedback.replaceChildren();
    dom.reviewFeedbackKey = undefined;
  }

  if (!dom.main.isConnected) {
    host.replaceSurfaceChildren(dom.main);
  }
  maybeAppendAgentBar();
}

export function createWorkSessionDom(workSessionId: string): WorkSessionDom {
  const main = element("main", { className: "shell workspace-surface" });
  const sessionSwitcher = element("nav", { className: "session-switcher", ariaLabel: "Work sessions" });
  const section = element("section", { className: "tool-card agent" });
  const header = element("div", { className: "review-header" });
  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.innerHTML = agentIcon();
  const titleGroup = element("div", { className: "review-title-group" });
  const titleStatus = element("span", { className: "tool-label" });
  titleGroup.append(element("span", { className: "tool-title", text: "Coding Agent Run" }), titleStatus);
  const statusBadge = element("span", { className: "tool-badge" });
  header.append(icon, titleGroup, statusBadge);
  const meta = element("div", { className: "agent-meta" });
  const notice = element("div", { className: "session-notice", hidden: true });
  const mission = element("div", { className: "mission-slot" });
  const messages = element("div", { className: "message-slot" });
  const activityHeader = element("div", { className: "agent-activity-header", text: "Agent activity" });
  const activity = element("ul", { className: "agent-activity" });
  const approvals = element("div", { className: "approval-slot" });
  const review = element("section", { className: "session-review" });
  const reviewTitle = element("div", { className: "agent-activity-header" });
  const reviewPayload = element("div", { className: "review-payload" });
  const reviewFeedback = element("div", { className: "review-feedback" });
  review.append(reviewTitle, reviewPayload, reviewFeedback);
  section.append(header, meta, notice, mission, messages, activityHeader, activity, approvals, review);
  main.append(sessionSwitcher, section);
  return {
    workSessionId,
    main,
    sessionSwitcher,
    section,
    titleStatus,
    statusBadge,
    meta,
    notice,
    mission,
    messages,
    activity,
    activitySeqs: new Set(),
    approvals,
    review,
    reviewTitle,
    reviewPayload,
    reviewFeedback,
  };
}

export function renderSessionSwitcher(container: HTMLElement): void {
  container.replaceChildren();
  // P0.4/P0.5: the approval center and every session button are workspace-
  // scoped. Only views of the active workspace are offered for selection.
  const approvalCenter = host.getActiveWorkspaceId() ? workSessionViews.get(approvalCenterId(host.getActiveWorkspaceId())) : undefined;
  const sessions = [...workSessionViews.values()]
    .filter((view) => !isApprovalCenterId(view.workSessionId))
    .filter((view) => view.workspaceSessionId === host.getActiveWorkspaceId())
    .sort((a, b) => {
      const at = Date.parse(a.updatedAt ?? "") || 0;
      const bt = Date.parse(b.updatedAt ?? "") || 0;
      return bt - at || b.lastSeq - a.lastSeq;
    });
  if (approvalCenter && approvalCenter.policyApprovals.size > 0) {
    const button = element("button", {
      className: `session-switcher-item${host.getSelectedWorkSessionId() === approvalCenter.workSessionId ? " selected" : ""}`,
      type: "button",
      text: `Workspace approvals · ${approvalCenter.policyApprovals.size}`,
      ariaPressed: String(host.getSelectedWorkSessionId() === approvalCenter.workSessionId),
    });
    button.dataset.focusKey = `session:${approvalCenter.workSessionId}`;
    button.addEventListener("click", () => selectWorkSession(approvalCenter.workSessionId));
    container.append(button);
  }
  if (host.getActiveWorkspaceId() && !host.historicalPendingReviewsLoaded()) {
    const history = element("button", {
      className: "session-switcher-item history-action",
      type: "button",
      text: "Load older pending reviews",
      ariaLabel: "Load older pending reviews",
      disabled: !host.uiMutationsAllowed(),
    });
    history.dataset.focusKey = "session-history";
    history.addEventListener("click", () => { void loadHistoricalPendingReviews(); });
    container.append(history);
  }
  if (sessions.length < 2 && !approvalCenter?.policyApprovals.size) return;
  for (const view of sessions) {
    const label = view.title ?? humanizeStatus(view.status);
    const category = sessionCategory(view);
    const updatedAt = view.updatedAt ? relativeSessionAge(view.updatedAt) : "";
    const button = element("button", {
      className: `session-switcher-item${view.workSessionId === host.getSelectedWorkSessionId() ? " selected" : ""}`,
      type: "button",
      text: `${category} · ${label} · ${view.submittedBy ?? "agent"}${updatedAt ? ` · ${updatedAt}` : ""}`,
      ariaPressed: String(view.workSessionId === host.getSelectedWorkSessionId()),
      title: `${view.workSessionId}${view.submittedBy ? ` · ${view.submittedBy}` : ""}`,
    });
    button.dataset.focusKey = `session:${view.workSessionId}`;
    button.addEventListener("click", () => selectWorkSession(view.workSessionId));
    container.append(button);
  }
}

/** P0.3: prominent in-surface "Needs approval" banner for direct approvals. */
export function renderSessionApprovalGateBanner(dom: WorkSessionDom, view: WorkSessionViewState): void {
  const center = host.getActiveWorkspaceId() ? workSessionViews.get(approvalCenterId(host.getActiveWorkspaceId())) : undefined;
  const banner = dom.section.querySelector<HTMLElement>(":scope > .approval-gate");
  if (!center || center.policyApprovals.size === 0) {
    banner?.remove();
    return;
  }
  // The banner must not cover the selected work session's own approvals.
  if (view.policyApprovals.size > 0) {
    banner?.remove();
    return;
  }
  if (banner && banner.dataset.approvalCount === String(center.policyApprovals.size)) return;
  banner?.remove();
  const gate = element("div", { className: "session-notice warning approval-gate", role: "alert" });
  gate.dataset.approvalCount = String(center.policyApprovals.size);
  const review = element("button", {
    className: "notice-action approval-gate-action",
    type: "button",
    text: `Needs approval — ${center.policyApprovals.size} pending operation${center.policyApprovals.size === 1 ? "" : "s"}`,
    ariaLabel: "Open workspace approvals",
  });
  review.addEventListener("click", () => selectWorkSession(center.workSessionId));
  gate.append(
    element("span", { className: "approval-gate-message", text: "A direct MCP operation is blocked and waiting for your decision." }),
    review,
  );
  dom.section.prepend(gate);
}

export function selectWorkSession(workSessionId: string): void {
  if (!workSessionViews.has(workSessionId)) return;
  // P0.5: another workspace's views (including its approval center) are
  // never selectable while a different workspace is active.
  const target = workSessionViews.get(workSessionId)!;
  if (isApprovalCenterId(workSessionId) ? workSessionId !== approvalCenterId(host.getActiveWorkspaceId()) : target.workspaceSessionId !== host.getActiveWorkspaceId()) {
    return;
  }
  // A reviewer-driven selection out of the approval center cancels the
  // pending auto-return; only an automatic switch owns the return slot.
  host.setSelectionAttention(workSessionId, isApprovalCenterId);
  host.setPendingApprovalReturnSessionId(host.getApprovalAttentionReturnSessionId());
  host.setSelectedWorkSessionId(workSessionId);
  if (isApprovalCenterId(workSessionId)) {
    host.render();
    return;
  }
  const view = workSessionViews.get(workSessionId)!;
  void hydrateWorkSessionSnapshot(view)
    .then(() => host.scheduleRender())
    .catch((error) => {
      view.notice = { tone: "warning", message: `Session details could not be loaded: ${error instanceof Error ? error.message : String(error)}` };
      host.scheduleRender();
    });
  host.scheduleRender();
}

/**
 * P0.3: surface a NEW direct approval without destroying active reviewer
 * input. When a reviewer is typing, focus is retained and the
 * always-rendered "Needs approval" banner carries the action; otherwise the
 * workspace approval center is selected automatically and the previous
 * non-approval surface is remembered so it can be restored when the last
 * pending approval resolves. Decision logic lives in approval-attention.ts.
 */
export function surfaceNewDirectApproval(workspaceId: string, approvalId: string): void {
  const centerId = approvalCenterId(workspaceId);
  if (!workSessionViews.has(centerId)) return;
  const center = workSessionViews.get(centerId)!;
  // Duplicate watcher delivery of one approval would otherwise re-yank the
  // reviewer; the reducer's seq guard dedupes the row, and a row count above
  // one means this delivery is a replay of an earlier approval, not a NEW one.
  if (!host.approvalAttentionDelivered.has(approvalId)) {
    host.approvalAttentionDelivered.add(approvalId);
    const decision = approvalAttentionDecision(
      host.getApprovalAttention(),
      {
        isNewApproval: true,
        isApprovalResolved: false,
        pendingApprovalCount: center.policyApprovals.size,
        selectedSessionId: host.getSelectedWorkSessionId(),
        reviewerInputHasFocus: host.reviewerInputHasFocus(),
      },
      centerId,
    );
    host.setApprovalAttention(decision.next);
    host.setPendingApprovalReturnSessionId(host.getApprovalAttentionReturnSessionId());
    if (decision.selectSessionId) selectWorkSession(decision.selectSessionId);
  }
}

/**
 * P0.3: restore the pre-approval surface once the last pending approval of
 * the active workspace resolves, but only when the reviewer is still looking
 * at the approval center we auto-switched to — a reviewer who navigated
 * elsewhere has already made their choice about where to be.
 */
export function maybeRestoreAfterApprovalResolved(workspaceId: string, approvalId?: string): void {
  if (approvalId) host.approvalAttentionDelivered.delete(approvalId);
  const center = workSessionViews.get(approvalCenterId(workspaceId));
  const decision = approvalAttentionDecision(
    host.getApprovalAttention(),
    {
      isNewApproval: false,
      isApprovalResolved: true,
      pendingApprovalCount: center?.policyApprovals.size ?? 0,
      selectedSessionId: host.getSelectedWorkSessionId(),
      reviewerInputHasFocus: false,
    },
    approvalCenterId(workspaceId),
  );
  host.setApprovalAttention(decision.next);
  host.setPendingApprovalReturnSessionId(host.getApprovalAttentionReturnSessionId());
  if (decision.selectSessionId) selectWorkSession(decision.selectSessionId);
}

export function renderSessionNotice(container: HTMLElement, view: WorkSessionViewState): void {
  const notice = view.notice ?? (view.feedbackMessage
    ? {
      tone: /failed|error|interrupted|could not/i.test(view.feedbackMessage) ? "error" as const : "info" as const,
      message: view.feedbackMessage,
    }
    : undefined);
  if (!notice) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }
  container.hidden = false;
  container.className = `session-notice ${notice.tone}`;
  container.replaceChildren(element("span", { text: notice.message }));
  if (notice.action) {
    const action = element("button", { className: "notice-action", type: "button", text: notice.action.label });
    action.addEventListener("click", notice.action.run);
    container.append(action);
  }
}

export function renderOpenMessages(container: HTMLElement, view: WorkSessionViewState): void {
  const stateKey = [...view.openMessages.values()]
    .map((message) => `${message.messageId}:${message.status}:${message.title ?? ""}:${message.body ?? ""}:${host.messageMutationOutcomeUnknown.has(message.messageId) ? "unknown" : "ready"}`)
    .join("|");
  if (container.dataset.stateKey === stateKey) return;
  container.replaceChildren();
  container.dataset.stateKey = stateKey;
  if (view.openMessages.size === 0) return;
  container.append(element("div", { className: "message-heading", text: "Needs your input" }));
  for (const message of view.openMessages.values()) {
    const card = element("article", { className: "agent-message blocker" });
    card.append(
      element("div", { className: "message-kind", text: message.kind.replace(/_/g, " ") }),
      element("div", { className: "message-title", text: message.title ?? "Agent request" }),
      element("div", { className: "message-body", text: message.body ?? "No details provided." }),
      element("div", { className: "message-meta", text: `${message.author ?? "agent"}${message.runId ? ` · ${message.runId}` : ""}${message.createdAt ? ` · ${new Date(message.createdAt).toLocaleString()}` : ""}` }),
    );
    const reply = document.createElement("textarea");
    reply.className = "message-reply";
    reply.id = stableDomId(`message-reply-${message.messageId}`);
    reply.dataset.focusKey = `message-reply:${message.messageId}`;
    reply.rows = 2;
    reply.placeholder = "Reply to the agent…";
    const replyLabel = element("label", { className: "feedback-label", text: "Reply to agent", htmlFor: reply.id });
    const messageUnknown = host.messageMutationOutcomeUnknown.has(message.messageId);
    const resolve = element("button", {
      className: "feedback-btn approve",
      type: "button",
      text: "Reply / Resolve",
      disabled: messageUnknown || !host.uiMutationsAllowed(),
    });
    resolve.addEventListener("click", () => {
      if (!host.getApp()) return;
      resolve.disabled = true;
      void host.callServerToolChecked({
        name: "resolve_agent_message",
        arguments: { sessionId: view.workSessionId, messageId: message.messageId, reply: reply.value.trim() || undefined, clientMutationId: host.newClientMutationId() },
      }).then(() => {
        view.openMessages.delete(message.messageId);
        view.unresolvedMessageCount = view.openMessages.size;
        view.notice = { tone: "success", message: "Reply sent to the agent." };
        host.scheduleRender();
      }).catch((error) => {
        if (error instanceof AmbiguousMutationError) {
          host.messageMutationOutcomeUnknown.add(message.messageId);
          view.notice = { tone: "warning", message: "Agent reply outcome is unknown. Refresh the session before trying again." };
        } else {
          resolve.disabled = false;
          view.notice = { tone: "error", message: `Could not resolve agent request: ${error instanceof Error ? error.message : String(error)}` };
        }
        host.scheduleRender();
      });
    });
    card.append(replyLabel, reply, resolve);
    if (messageUnknown) {
      const refresh = element("button", {
        className: "notice-action",
        type: "button",
        text: "Refresh session state",
        disabled: !host.uiMutationsAllowed(),
      });
      refresh.addEventListener("click", () => { void reconcileMessageOutcome(view, message.messageId); });
      card.append(element("div", { className: "feedback-error", text: "Reply outcome is unknown after a connection interruption. Refresh authoritative session state before trying again." }), refresh);
    }
    container.append(card);
  }
}

export async function reconcileMessageOutcome(view: WorkSessionViewState, messageId: string): Promise<void> {
  if (!host.getApp() || !host.uiMutationsAllowed()) return;
  try {
    await hydrateWorkSessionSnapshot(view);
    if (!view.openMessages.has(messageId)) {
      host.messageMutationOutcomeUnknown.delete(messageId);
      view.notice = { tone: "success", message: "The agent reply was committed." };
    } else {
      view.notice = { tone: "warning", message: "The agent request is still open. No reply was committed; keep it paused until you are ready." };
    }
  } catch (error) {
    view.notice = { tone: "warning", message: `Reply outcome still needs reconciliation: ${error instanceof Error ? error.message : String(error)}` };
  }
  host.render();
}

export function renderActivityIncrementally(dom: WorkSessionDom, view: WorkSessionViewState): void {
  const visible = view.activity.slice(-50);
  const visibleSeqs = new Set(visible.map((event) => event.seq));
  const existingBySeq = new Map<number, HTMLElement>();
  for (const child of [...dom.activity.children]) {
    const seq = Number((child as HTMLElement).dataset.eventSeq);
    if (Number.isFinite(seq)) existingBySeq.set(seq, child as HTMLElement);
  }
  for (const child of [...dom.activity.children]) {
    const seq = Number((child as HTMLElement).dataset.eventSeq);
    if (Number.isFinite(seq) && !visibleSeqs.has(seq)) child.remove();
  }
  if (visible.length === 0) {
    if (!dom.activity.querySelector(".activity-empty")) dom.activity.append(element("li", { className: "agent-event muted activity-empty", text: "No activity yet." }));
    return;
  }
  dom.activity.querySelector(".activity-empty")?.remove();
  for (const event of visible) {
    const existing = existingBySeq.get(event.seq);
    if (existing) {
      // Adjacent output/thought events are coalesced into the original event
      // sequence. Refresh that row in place so the coalesced text is visible
      // without replacing the surrounding activity DOM.
      existing.className = event.payload?.success === false ? "agent-event failed" : "agent-event";
      existing.textContent = eventLabel(event);
      existing.title = String(event.payload?.outputSummary ?? event.payload?.text ?? event.payload?.description ?? "");
      continue;
    }
    if (dom.activitySeqs.has(event.seq)) continue;
    const item = element("li", {
      className: event.payload?.success === false ? "agent-event failed" : "agent-event",
      text: eventLabel(event),
      title: String(event.payload?.outputSummary ?? event.payload?.text ?? event.payload?.description ?? ""),
    });
    item.dataset.eventSeq = String(event.seq);
    dom.activity.append(item);
    dom.activitySeqs.add(event.seq);
  }
  for (const seq of [...dom.activitySeqs]) if (!visibleSeqs.has(seq)) dom.activitySeqs.delete(seq);
}

export function renderAgentSubmitBar(): HTMLElement {
  {
    agentBar = element("div", { className: "agent-submit-bar" });

    const input = document.createElement("input");
    input.className = "agent-submit-input";
    input.placeholder = "Send a task to the coding agent…";
    input.setAttribute("aria-label", "Task for coding agent");

    const btn = element("button", { className: "agent-submit-btn", type: "button", text: "Send" });
    const status = element("div", { className: "agent-submit-status", role: "status", ariaLive: "polite" });
    const refresh = element("button", { className: "notice-action", type: "button", text: "Refresh state", hidden: true });
    let dispatchOutcomeUnknown = false;

    refresh.addEventListener("click", () => {
      refresh.disabled = true;
      void host.reconnect("refreshing dispatch outcome")
        .then(async () => {
          host.queueSessionRehydration();
          if (host.rehydrationPromise()) await host.rehydrationPromise();
        })
        .then(() => {
          dispatchOutcomeUnknown = false;
          btn.disabled = false;
          refresh.hidden = true;
          refresh.disabled = false;
          status.textContent = "State refreshed. Confirm the session before sending the task again.";
        })
        .catch((error) => {
          refresh.disabled = false;
          status.textContent = `State refresh did not complete: ${error instanceof Error ? error.message : String(error)}. Keep the dispatch paused.`;
        });
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        btn.click();
      }
    });

    btn.addEventListener("click", () => {
      const task = input.value.trim();
      if (!task || !host.getApp()) return;
      if (!host.getActiveWorkspaceId()) {
        status.textContent = "Open a workspace before dispatching a coding agent.";
        return;
      }
      status.textContent = "Dispatching…";
      btn.setAttribute("disabled", "true");
      void host.callServerToolChecked({
          name: "submit_to_coding_agent",
          arguments: { task, workspaceSessionId: host.getActiveWorkspaceId(), clientMutationId: host.newClientMutationId() },
        })
        .then((result) => {
          const dispatch = getStructuredContent<{
            runId: string;
            remoteRunId?: string;
            workSessionId: string;
            workspaceSessionId: string;
            status: string;
            output: string;
            error?: string;
          }>(result);

          if (!dispatch?.workSessionId) {
            status.textContent = dispatch?.error ?? "Coding-agent dispatch returned no workSessionId.";
            return;
          }

          const view = ensureWorkSessionView(
            dispatch.workSessionId,
            dispatch.workspaceSessionId,
            dispatch.runId,
          );
          view.status = dispatch.status;
          host.setSelectedWorkSessionId(dispatch.workSessionId);
          host.setLastToolCard(null);
          host.setExpanded(false);
          host.setReviewFilesExpanded(false);
          host.setErrorMessage(null);
          input.value = "";
          status.textContent = "Agent is working.";
          selectWorkSession(dispatch.workSessionId);
        })
        .catch((err) => {
          if (err instanceof AmbiguousMutationError) {
            dispatchOutcomeUnknown = true;
            status.textContent = "Dispatch outcome unknown after a connection interruption. Refresh state before retrying.";
            refresh.hidden = false;
          } else {
            status.textContent = `Dispatch failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        })
        .finally(() => { if (!dispatchOutcomeUnknown) btn.removeAttribute("disabled"); });
    });

    agentBar.append(input, btn, status, refresh);
  }
  return agentBar;
}

export function maybeAppendAgentBar(): void {
  if (host.connected()) host.appendSurface(renderAgentSubmitBar());
}

// ── Legacy review card (non-work-session review surfaces) ──

export function renderReviewCard(card: ToolResultCard, display: ToolDisplay): void {
  const surfaceKey = `review:${card.tool}:${String(card.summary?.submissionId ?? card.summary?.sessionId ?? "")}`;
  ensureSurface(surfaceKey);

  const files = card.files ?? [];
  const summary = card.summary ?? {};
  const visibleFiles = host.getReviewFilesExpanded() ? files : files.slice(0, 3);
  const hiddenCount = Math.max(0, files.length - visibleFiles.length);
  let dom = host.getCurrentLegacyReviewDom();
  if (!dom || dom.key !== surfaceKey) {
    const main = element("main", { className: "shell" });
    const section = element("section", { className: "tool-card review" });
    const header = element("div", { className: "review-header" });
    const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
    icon.innerHTML = display.icon;
    const titleGroup = element("div", { className: "review-title-group" });
    titleGroup.append(
      element("span", { className: "tool-title", text: display.title }),
      element("span", { className: "tool-label", text: display.label, title: display.label }),
    );
    header.append(icon, titleGroup, renderSummaryBadge(card));
    const body = element("div", { className: "review-summary" });
    const actions = element("div", { className: "review-actions" });
    const feedback = element("div", { className: "review-feedback" });
    section.append(header, body, actions, feedback);
    main.append(section);
    dom = { key: surfaceKey, main, body, actions, feedback };
    host.setCurrentLegacyReviewDom(dom);
  }

  dom.actions.replaceChildren();
  if (hiddenCount > 0) {
    const showMore = element("button", {
      className: "review-action",
      type: "button",
      text: `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`,
    });
    showMore.addEventListener("click", () => {
      host.setReviewFilesExpanded(true);
      host.render();
    });
    dom.actions.append(showMore);
  }

  const legacyKey = legacyReviewKey(card);
  const legacyState = legacyFeedbackState.get(legacyKey);
  const feedbackKey = `${legacyKey}:${legacyState?.submitted ? "submitted" : "form"}:${legacyState?.submitting ? "submitting" : legacyState?.outcomeUnknown ? "outcome_unknown" : "idle"}:${legacyState?.error ?? ""}`;
  if (dom.feedbackKey !== feedbackKey) {
    dom.feedback.replaceChildren();
    if (card.tool === "submit_for_review" && !legacyState?.submitted && typeof card.summary?.sessionId === "string") {
      dom.feedback.append(renderFeedbackFormForSession(card.summary.sessionId, card));
    } else if (card.tool === "submit_for_review" && legacyState?.submitted) {
      dom.feedback.append(renderFeedbackSubmittedGlobal());
    }
    dom.feedbackKey = feedbackKey;
  }

  setPayloadContainer(dom.body);
  if (!dom.main.isConnected) host.replaceSurfaceChildren(dom.main);
  renderPayloadIfNeeded(card, visibleFiles.length);
  maybeAppendAgentBar();
}

export function renderChevron(isExpanded: boolean, visible: boolean): HTMLElement {
  const chevron = element("span", {
    className: visible ? `chevron ${isExpanded ? "expanded" : ""}` : "chevron",
    ariaHidden: "true",
  });
  if (visible) {
    chevron.innerHTML = iconSvg('<path d="m6 9 6 6 6-6" />');
  }
  return chevron;
}

export function setPayloadLoading(container: HTMLElement, loading: boolean): void {
  const header = container.previousElementSibling;
  const chevron = header?.querySelector<HTMLElement>(".chevron");
  if (!chevron) return;
  chevron.classList.toggle("loading", loading);
  chevron.innerHTML = loading
    ? iconSvg('<circle cx="12" cy="12" r="8" />')
    : iconSvg('<path d="m6 9 6 6 6-6" />');
  const button = header instanceof HTMLButtonElement ? header : null;
  if (button) button.setAttribute("aria-busy", String(loading));
}

// P1.4: AmbiguousMutationError moved to server-tool-call.ts; re-exported so
// the established `import("./workspace-app.js")` test/client surface keeps
// working unchanged.
