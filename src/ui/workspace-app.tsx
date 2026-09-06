import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isEditTool,
  isExpandableCard,
  isPatchTool,
  isReadTool,
  isReviewTool,
  isSearchTool,
  isShellTool,
  isToolName,
  isToolResultCard,
  isAgentRunCard,
  isWriteTool,
  payloadText,
  summaryNumber,
  type AgentToolEvent,
  type HostContext,
  type PatchOperation,
  type ToolName,
  type ToolResultCard,
} from "./card-types.js";
import { getPatchDisplayParts } from "./patch-display.js";
import {
  approvalAttentionDecision,
  initialApprovalAttentionState,
  selectionChanged,
  workspaceTransitioned,
  type ApprovalAttentionState,
} from "./approval-attention.js";
import type { ReviewFile } from "../review-submission.js";
import {
  type AgentActivityEvent,
  type AgentMessageView,
  type FeedbackState,
  type MissionPacketView,
  type PolicyApprovalView,
  type PendingApprovalRecord,
  type ReviewSubmissionView,
  type WorkSessionViewState,
} from "./session-view-types.js";
// P1.4: the view-state types moved to session-view-types.ts; re-exported so
// existing `from "./workspace-app.js"` importers keep working.
export type {
  AgentActivityEvent,
  AgentMessageView,
  FeedbackState,
  MissionPacketView,
  PolicyApprovalView,
  PendingApprovalRecord,
  ReviewSubmissionView,
  WorkspaceSurfaceSession,
  WorkSessionViewState,
} from "./session-view-types.js";
import {
  agentIcon,
  checkCircleIcon,
  editIcon,
  element,
  fileIcon,
  filePlusIcon,
  filesIcon,
  folderIcon,
  listIcon,
  reviewIcon,
  searchIcon,
  stableDomId,
  terminalIcon,
  iconSvg,
} from "./ui-dom.js";
import {
  formatAgentsFilesForPayload,
  getToolDisplay,
  getToolLabel,
  toolNameFromMeta,
  workspacePayloadText,
  type ToolDisplay,
} from "./tool-display.js";
import { formatElapsed, humanizeStatus } from "./ui-format.js";
import { approvalCenterId, isApprovalCenterId } from "./approval-center.js";
import { relativeSessionAge, sessionCategory } from "./session-view-helpers.js";
import {
  fetchReviewDiff,
  hydrateWorkSessionSnapshot,
  loadHistoricalPendingReviews,
  queueSessionRehydration,
  reconcileAuthoritativeApprovals,
  rehydrateActiveSessions,
  refreshMission,
  setHydrationHost,
  watchWorkspaceEvents,
} from "./session-hydration.js";
import {
  reduceWorkSessionEvent,
  setReducerHost,
  workspaceEventTargetSessionId,
} from "./workspace-event-reducer.js";
import {
  eventLabel,
  renderMissionPanel,
  setMissionHost,
} from "./mission-panel.js";
import {
  legacyFeedbackState,
  legacyReviewKey,
  parsePolicyApprovalOptions,
  renderApprovalCenterCard,
  renderFeedbackFormForSession,
  renderFeedbackFormForSubmission,
  renderFeedbackSubmitted,
  renderFeedbackSubmittedGlobal,
  renderPolicyApproval,
  reviewCardFromSubmission,
  setFeedbackHost,
} from "./review-feedback.js";
import {
  compareSubmissionAuthority,
  ensureWorkSessionView,
  mergePendingApproval,
  noteSubmission,
  workSessionViews,
} from "./session-views.js";
import {
  AmbiguousMutationError,
  cardFromMeta,
  callServerToolChecked,
  getStructuredContent,
  setServerToolHost,
} from "./server-tool-call.js";

interface MountedPayload {
  update(options: {
    card: ToolResultCard;
    hostContext?: HostContext;
    errorMessage?: string | null;
    visibleFileCount?: number;
  }): void;
  unmount(): void;
}

// ── Work-session view model ───────────────────────────
// A run is a long-lived workflow, not a succession of unrelated single cards.
// Each delegated task owns a WorkSessionViewState that composes the run header,
// the live activity timeline, and the current review submission + feedback.

let app: App | null = null;
let connected = false;
let connectionError: string | null = null;
type ConnectionState = "CONNECTING" | "CONNECTED" | "DEGRADED" | "RECONNECTING" | "DISCONNECTED";
let connectionState: ConnectionState = "CONNECTING";
let reconnectPromise: Promise<void> | null = null;
let bootPromise: Promise<void> | null = null;
let hostContext: HostContext | undefined;

// Durable UI state.
let activeWorkspaceId: string | null = null;
const snapshotHydrations = new Map<string, Promise<void>>();
let selectedWorkSessionId: string | null = null;
// P0.3: the surface the reviewer was on before a direct approval pulled them
// into the approval center; restored once every center approval resolves.
// Decision logic lives in approval-attention.ts; pendingApprovalReturnSessionId
// mirrors approvalAttention for the render paths.
let pendingApprovalReturnSessionId: string | null = null;
let approvalAttention: ApprovalAttentionState = initialApprovalAttentionState;
// Approvals whose "new" attention decision already ran; the workspace event
// stream can redeliver the same row after reconnect and must not re-yank.
const approvalAttentionDelivered = new Set<string>();
const workspaceApprovalConfirmations = new Set<string>();
// A message mutation that lost its response is intentionally not made
// clickable again until the authoritative session projection has been
// refreshed. This keeps a transport retry from becoming a second mutation.
const messageMutationOutcomeUnknown = new Set<string>();
// P1: approval-recovery control-plane health. Rehydration stays resilient,
// but the exact failure mode must stay visible instead of silently swallowed.
type ApprovalRecoveryState = "healthy" | "degraded" | "forbidden" | "disconnected";
let approvalRecoveryState: ApprovalRecoveryState = "healthy";
let lastToolCard: ToolResultCard | null = null;
let rehydrationPromise: Promise<void> | null = null;
let rehydrationRequested = false;
let lastSuccessfulHydrationAt: string | null = null;
let historicalPendingReviewsLoaded = false;

// View-local UI state (replaced the previous globals).
let expanded = false;
let reviewFilesExpanded = false;
let errorMessage: string | null = null;
let currentPayload: MountedPayload | null = null;
let currentPayloadContainer: HTMLElement | null = null;
let currentPayloadCard: ToolResultCard | null = null;
let currentPayloadKind: "heavy" | "review" | null = null;
let currentPayloadKey: string | null = null;
let payloadLoadingKey: string | null = null;
let payloadLoadGeneration = 0;
let renderedSurfaceKey: string | null = null;
let agentBar: HTMLElement | null = null;

interface WorkSessionDom {
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

interface LegacyReviewDom {
  key: string;
  main: HTMLElement;
  body: HTMLElement;
  actions: HTMLElement;
  feedback: HTMLElement;
  feedbackKey?: string;
}

let currentWorkSessionDom: WorkSessionDom | null = null;
let currentLegacyReviewDom: LegacyReviewDom | null = null;

let renderQueued = false;

interface FocusSnapshot {
  key: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
}

function captureFocusSnapshot(): FocusSnapshot | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !appRoot.contains(active)) return undefined;
  const key = active.dataset.focusKey;
  if (!key) return undefined;
  const selectable = active as HTMLInputElement | HTMLTextAreaElement;
  return {
    key,
    selectionStart: "selectionStart" in selectable ? selectable.selectionStart : undefined,
    selectionEnd: "selectionEnd" in selectable ? selectable.selectionEnd : undefined,
  };
}

function restoreFocusSnapshot(snapshot: FocusSnapshot | undefined): void {
  if (!snapshot) return;
  const target = [...appRoot.querySelectorAll<HTMLElement>("[data-focus-key]")]
    .find((candidate) => candidate.dataset.focusKey === snapshot.key);
  if (!target || target.hasAttribute("disabled")) return;
  target.focus({ preventScroll: true });
  const selectable = target as HTMLInputElement | HTMLTextAreaElement;
  if (snapshot.selectionStart !== undefined && "setSelectionRange" in selectable) {
    try { selectable.setSelectionRange(snapshot.selectionStart ?? 0, snapshot.selectionEnd ?? snapshot.selectionStart ?? 0); } catch { /* non-text controls */ }
  }
}

let heartbeatRefreshTimer: ReturnType<typeof setInterval> | undefined;

function syncHeartbeatRefreshTimer(): void {
  const view = selectedWorkSessionId ? workSessionViews.get(selectedWorkSessionId) : undefined;
  if (view?.lastHeartbeatAt && !heartbeatRefreshTimer) {
    heartbeatRefreshTimer = setInterval(() => scheduleRender(), 5_000);
    heartbeatRefreshTimer.unref?.();
  } else if (!view?.lastHeartbeatAt && heartbeatRefreshTimer) {
    clearInterval(heartbeatRefreshTimer);
    heartbeatRefreshTimer = undefined;
  }
}

function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  const flush = () => {
    renderQueued = false;
    renderNow();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else setTimeout(flush, 0);
}

// One generation-controlled workspace watcher multiplexes all sessions. A
// parked review therefore does not reserve its own long-poll connection.
let workspaceWatcherGeneration = 0;
let workspaceEventCursor = 0;

const uiTestMode = Boolean((globalThis as { __KONTROL_UI_TEST_MODE__?: boolean }).__KONTROL_UI_TEST_MODE__);
const maybeAppRoot = typeof document === "undefined" ? null : document.querySelector<HTMLElement>("#app");
if (!maybeAppRoot && !uiTestMode) {
  throw new Error("Missing #app root element.");
}
const appRoot = maybeAppRoot ?? document.createElement("div");

type UiTestAppFactory = () => App;
const uiTestAppFactory = (globalThis as {
  __KONTROL_UI_TEST_APP_FACTORY__?: UiTestAppFactory;
}).__KONTROL_UI_TEST_APP_FACTORY__;

if (!uiTestMode) void boot();

async function boot(): Promise<void> {
  if (bootPromise) return bootPromise;
  bootPromise = bootInternal().finally(() => { bootPromise = null; });
  return bootPromise;
}

async function bootInternal(): Promise<void> {
  render();

  setServerToolHost({
    getApp: () => app,
    reconnect: (reason) => reconnectApp(reason),
  });

  setHydrationHost({
    getApp: () => app,
    scheduleRender: () => scheduleRender(),
    getActiveWorkspaceId: () => activeWorkspaceId,
    getSelectedWorkSessionId: () => selectedWorkSessionId,
    setSelectedWorkSessionId: (v) => { selectedWorkSessionId = v; },
    workspaceWatcherGeneration: () => workspaceWatcherGeneration,
    bumpWorkspaceWatcherGeneration: () => { workspaceWatcherGeneration += 1; },
    workspaceEventCursor: () => workspaceEventCursor,
    setWorkspaceEventCursor: (v) => { workspaceEventCursor = v; },
    rehydrationRequested: () => rehydrationRequested,
    setRehydrationRequested: (v) => { rehydrationRequested = v; },
    rehydrationPromise: () => rehydrationPromise,
    setRehydrationPromise: (v) => { rehydrationPromise = v; },
    lastSuccessfulHydrationAt: () => lastSuccessfulHydrationAt,
    setLastSuccessfulHydrationAt: (v) => { lastSuccessfulHydrationAt = v; },
    historicalPendingReviewsLoaded: () => historicalPendingReviewsLoaded,
    setHistoricalPendingReviewsLoaded: (v) => { historicalPendingReviewsLoaded = v; },
    approvalRecoveryState: () => approvalRecoveryState,
    setApprovalRecoveryState: (v) => { approvalRecoveryState = v; },
    approvalAttentionDelivered,
    setErrorMessage: (v) => { errorMessage = v; },
    render: () => render(),
    connected: () => connected,
    noteHydrationFailure: (message) => {
      connectionState = connected ? "DEGRADED" : "RECONNECTING";
      connectionError = message;
      render();
    },
    messageMutationOutcomeUnknown,
    surfaceNewDirectApproval,
    maybeRestoreAfterApprovalResolved,
    uiMutationsAllowed,
  });

  setReducerHost({
    getApp: () => app,
    getActiveWorkspaceId: () => activeWorkspaceId,
    messageMutationOutcomeUnknown,
    refreshMission,
    callServerToolChecked,
    render: () => render(),
    setErrorMessage: (v) => { errorMessage = v; },
  });

  setMissionHost({
    scheduleRender: () => scheduleRender(),
    newClientMutationId,
    callServerToolChecked,
    getApp: () => app,
    refreshMission,
  });

  setFeedbackHost({
    getApp: () => app,
    render: () => render(),
    scheduleRender: () => scheduleRender(),
    uiMutationsAllowed,
    newClientMutationId,
    activateWorkspace,
    renderEmpty,
    hydrateWorkSessionSnapshot: (view) => hydrateWorkSessionSnapshot(view),
    workspaceApprovalConfirmations,
    getActiveWorkspaceId: () => activeWorkspaceId,
    getSelectedWorkSessionId: () => selectedWorkSessionId,
    setSelectedWorkSessionId: (v) => { selectedWorkSessionId = v; },
    setLastToolCard: (v) => { lastToolCard = v; },
  });

  app = uiTestAppFactory?.() ?? new App(
      { name: "kontrol-tool-cards", version: "0.4.0" },
      {},
    );

  app.ontoolresult = (result) => {
    const structuredContent = getStructuredContent<Partial<ToolResultCard>>(result);
    const metaCard = cardFromMeta(result);
    const structured = metaCard
      ? { ...structuredContent, ...metaCard }
      : structuredContent;
    const tool = toolNameFromMeta(result);

    if (!tool || !isToolResultCard(structured)) {
      lastToolCard = null;
      selectedWorkSessionId = null;
      expanded = false;
      reviewFilesExpanded = false;
      errorMessage = "No result card is available for this tool result.";
      render();
      return;
    }

    // open_workspace carries the currently opened workspace ID.
    if (tool === "open_workspace" && structured.workspaceId) {
      activateWorkspace(structured.workspaceId);
    }

    // P0.2: any tool result that carries a workspace ID bootstraps workspace
    // context — not just open_workspace. A freshly (re)mounted tool-card
    // iframe can otherwise receive a valid approval_required bash/write/edit
    // result while activeWorkspaceId is still null, and without an active
    // workspace the app never starts rehydration, pending-approval listing,
    // or the event watcher: the model sees "approval required" while the
    // reviewer sees nothing. The invariant is that an approval result alone
    // must be sufficient to surface the approval UI.
    const resultWorkspaceId = structured.workspaceId;
    if (
      typeof resultWorkspaceId === "string" &&
      resultWorkspaceId.length > 0 &&
      activeWorkspaceId !== resultWorkspaceId
    ) {
      activateWorkspace(resultWorkspaceId);
    }

    // P0.2: merge a policy-blocked approval_required result into the workspace
    // approval center immediately, using the data already on the card, rather
    // than waiting for watcher event replay or the next rehydration to
    // reconcile with list_pending_approvals.
    if (structured.status === "approval_required" && resultWorkspaceId) {
      const approvalId = (structured as { approvalId?: string }).approvalId;
      if (typeof approvalId === "string" && approvalId.length > 0) {
        const centerId = approvalCenterId(resultWorkspaceId);
        const center = ensureWorkSessionView(centerId, resultWorkspaceId, "");
        mergePendingApproval(center, {
          approvalId,
          workspaceId: resultWorkspaceId,
          workspaceSessionId: resultWorkspaceId,
          kind: (structured as { kind?: string }).kind,
          title: (structured as { title?: string }).title,
          tool: tool,
          path: structured.path,
          command: (structured as { command?: string }).command,
          origin: "direct_mcp",
        }, resultWorkspaceId);
        surfaceNewDirectApproval(resultWorkspaceId, approvalId);
        scheduleRender();
      }
    }

    // Agent run (submit_to_coding_agent) and review (submit_for_review) cards
    // drive the work-session view model.
    if (tool === "submit_to_coding_agent" || isReviewTool(tool)) {
      const wsId =
        (structured as { workSessionId?: string }).workSessionId ??
        (structured as { summary?: { sessionId?: string } }).summary?.sessionId;

      if (wsId) {
        const workspaceSessionId = (structured as { workspaceSessionId?: string }).workspaceSessionId;
        if (workspaceSessionId && activeWorkspaceId !== workspaceSessionId) {
          activateWorkspace(workspaceSessionId);
        }
        ensureWorkSessionView(
          wsId,
          workspaceSessionId ?? activeWorkspaceId ?? "",
          (structured as { runId?: string }).runId ?? "",
        );
        selectWorkSession(wsId);
        lastToolCard = null;
        expanded = false;
        reviewFilesExpanded = false;
        errorMessage = null;
        scheduleRender();
        return;
      }
    }

    // Any other tool result is a transient card. It must not discard the active
    // work-session selection; session recovery and supervision should remain
    // anchored even when unrelated tool cards arrive.
    lastToolCard = { ...structured, tool };
    expanded = false;
    reviewFilesExpanded = false;
    errorMessage = null;
    render();
  };

  app.onhostcontextchanged = (ctx) => {
    hostContext = { ...hostContext, ...ctx };
    applyHostContext();
    renderPayloadIfNeeded();
  };

  app.onteardown = async () => {
    connected = false;
    connectionState = "DISCONNECTED";
    workspaceWatcherGeneration += 1;
    unmountPayload();
    currentLegacyReviewDom = null;
    currentWorkSessionDom = null;
    agentBar = null;
    app = null;
    return {};
  };

  await connectWithRetry();
  render();
}

async function connectWithRetry(reason?: unknown): Promise<void> {
  let retryDelayMs = 1_000;
  while (app && !connected) {
    connectionState = retryDelayMs === 1_000 && !reason ? "CONNECTING" : "RECONNECTING";
    render();
    try {
      await app.connect();
      const initialContext = app.getHostContext();
      if (initialContext) hostContext = initialContext;
      applyHostContext();
      connected = true;
      connectionState = "CONNECTED";
      connectionError = null;
      // Rehydrate any sessions that were already live before this WebUI
      // (re)loaded. The same path is used after a transport reconnect.
      queueSessionRehydration();
      return;
    } catch (connectErrorValue) {
      connectionState = "RECONNECTING";
      connectionError = connectErrorValue instanceof Error
        ? connectErrorValue.message
        : String(connectErrorValue);
      render();
      const jitter = Math.floor(Math.random() * Math.min(500, retryDelayMs / 2));
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs + jitter));
      retryDelayMs = Math.min(30_000, retryDelayMs * 2);
      reason = undefined;
    }
  }
  throw new Error("The MCP host connection is unavailable.");
}

async function reconnectApp(reason: unknown): Promise<void> {
  if (reconnectPromise) return reconnectPromise;
  reconnectPromise = (async () => {
    if (!app) throw new Error("The MCP host connection is unavailable.");
    connected = false;
    workspaceWatcherGeneration += 1;
    await connectWithRetry(reason);
  })().finally(() => {
    reconnectPromise = null;
  });
  return reconnectPromise;
}

/**
 * Make a workspace the active projection target: drop selections that belong
 * to another workspace, and restart the event watcher generation so the
 * durable cursor is rebuilt for the new workspace.
 */
function activateWorkspace(newWorkspaceId: string): void {
  if (activeWorkspaceId !== newWorkspaceId) {
    activeWorkspaceId = newWorkspaceId;
    historicalPendingReviewsLoaded = false;
    // P0.5 isolation invariant: a workspace transition must start on the
    // new workspace's own surface. Old-workspace state is kept internally
    // for a fast return but can never render under the new selection.
    invalidateSelectionForWorkspaceTransition();
    workspaceWatcherGeneration += 1;
    workspaceEventCursor = 0;
  }
  // P0 #3: When workspace becomes known, trigger rehydration.
  queueSessionRehydration();
}

/**
 * P0.5 isolation invariant: on a workspace transition, drop the selection if
 * it belongs to another workspace (including another workspace's approval
 * center). Rehydration selects the newest session of the new workspace.
 * Old-workspace state stays in memory for a fast return but is unselectable
 * while another workspace is active.
 */
function invalidateSelectionForWorkspaceTransition(): void {
  approvalAttention = workspaceTransitioned(approvalAttention);
  pendingApprovalReturnSessionId = approvalAttention.returnSessionId;
  if (!selectedWorkSessionId) return;
  if (isApprovalCenterId(selectedWorkSessionId)) {
    selectedWorkSessionId = null;
    return;
  }
  const view = workSessionViews.get(selectedWorkSessionId);
  if (!view || view.workspaceSessionId !== activeWorkspaceId) selectedWorkSessionId = null;
}

function reviewerInputHasFocus(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
}

function applyHostContext(): void {
  if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  if (hostContext?.styles?.variables) {
    applyHostStyleVariables(hostContext.styles.variables);
  }
  if (hostContext?.styles?.css?.fonts) {
    applyHostFonts(hostContext.styles.css.fonts);
  }
  const insets = hostContext?.safeAreaInsets;
  if (!insets) return;
  document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
}

function render(): void {
  scheduleRender();
}

function uiMutationsAllowed(): boolean {
  // A reconnect is not complete when the MCP socket is back: the durable
  // workspace/session projection must be refreshed first. Keep every mutation
  // disabled during that handoff so a user cannot race an authoritative
  // reconciliation with a second click.
  return connected && connectionState === "CONNECTED" && Boolean(app) && !rehydrationPromise;
}

function newClientMutationId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.();
  return `ui_${randomUUID ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
}

function isLiveAgentSession(view: WorkSessionViewState): boolean {
  // A recent heartbeat alone is not proof that a worker still owns the live
  // lease. Review, queued, and parked states are intentionally reported as a
  // last heartbeat even when their underlying process has not exited yet.
  const activeStatuses = new Set(["in_progress", "resuming"]);
  const activeLifecycles = new Set(["running", "in_progress", "resuming"]);
  const heartbeatAge = view.lastHeartbeatAt ? Date.now() - Date.parse(view.lastHeartbeatAt) : Number.POSITIVE_INFINITY;
  return activeStatuses.has(view.status)
    && (!view.lifecycle || activeLifecycles.has(view.lifecycle))
    && view.runtimeState === "running"
    && Number.isFinite(heartbeatAge)
    && heartbeatAge >= 0
    && heartbeatAge <= 45_000;
}

function renderNow(): void {
  const focus = captureFocusSnapshot();
  try {
    renderNowInternal();
  } finally {
    restoreFocusSnapshot(focus);
    syncHeartbeatRefreshTimer();
  }
}

function renderNowInternal(): void {
  const view = selectedWorkSessionId ? workSessionViews.get(selectedWorkSessionId) : undefined;
  // P0.5 isolation invariant: a selection from another workspace must never
  // render here, even if its view is still resident for a fast return.
  const selectedViewIsCurrentWorkspace = view && (view.workspaceSessionId === activeWorkspaceId
    || (isApprovalCenterId(view.workSessionId) && view.workSessionId === approvalCenterId(activeWorkspaceId)));
  // Preserve the last authoritative projection while a transport reconnects.
  // The projection is read-only until the connection is healthy again; wiping
  // it here made a short tunnel flap look like data loss and encouraged users
  // to repeat mutations whose outcome was still unknown.
  if (selectedViewIsCurrentWorkspace) {
    if (isApprovalCenterId(view.workSessionId)) {
      renderApprovalCenterView(view);
      return;
    }
    renderWorkSessionView(view);
    return;
  }

  if (!connected) {
    if (connectionError && connectionState === "DISCONNECTED") {
      renderConnectionError(connectionError);
    } else {
      renderEmpty(connectionState === "RECONNECTING" ? `Reconnecting to host… ${connectionError ?? ""}` : "Connecting to host...");
    }
    return;
  }

  if (!lastToolCard) {
    if (renderWorkspaceApprovalGate()) return;
    renderEmpty(errorMessage ?? "Waiting for a tool result.", errorMessage ? "error" : "muted");
    return;
  }

  const card = lastToolCard;
  ensureSurface(`tool:${card.tool}`);
  const display = getToolDisplay(card);
  if (card.tool === "open_approval_center") {
    renderApprovalCenterCard(card);
    return;
  }
  if (isReviewTool(card.tool)) {
    renderReviewCard(card, display);
    return;
  }

  const expandable = isExpandableCard(card);
  const main = element("main", { className: "shell" });
  const section = element("section", { className: `tool-card ${display.tone}` });
  const button = element("button", {
    className: "tool-header",
    type: "button",
    ariaExpanded: String(expanded),
    disabled: !expandable,
  });

  if (expandable) {
    button.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
  }

  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.innerHTML = display.icon;

  const toolMain = element("span", { className: "tool-main" });
  const title = element("span", { className: "tool-title", text: display.title });
  const label = element("span", {
    className: "tool-label",
    text: display.label,
    title: display.label,
  });
  toolMain.append(title, label);

  button.append(
    icon,
    toolMain,
    renderSummaryBadge(card),
    renderChevron(expanded, expandable),
  );
  section.append(button);

  if (expanded) {
    const body = element("div", { className: "tool-body" });
    currentPayloadContainer = body;
    section.append(body);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  maybeAppendAgentBar();
  renderPayloadIfNeeded();
}

function renderEmpty(message: string, tone: "muted" | "error" = "muted"): void {
  ensureSurface(`empty:${tone}:${message}`);
  const main = element("main", { className: "shell" });
  main.append(element("section", { className: `empty ${tone}`, text: message }));
  appRoot.replaceChildren(main);
  maybeAppendAgentBar();
}

function renderConnectionError(message: string): void {
  ensureSurface(`connection-error:${message}`);
  const main = element("main", { className: "shell" });
  const section = element("section", { className: "empty error" });
  section.append(element("div", { text: message }));
  const retry = element("button", { className: "notice-action", type: "button", text: "Reconnect" });
  retry.addEventListener("click", () => {
    retry.disabled = true;
    if (app) {
      void reconnectApp(message).catch(() => undefined);
    } else {
      void boot().catch(() => undefined);
    }
  });
  section.append(retry);
  main.append(section);
  appRoot.replaceChildren(main);
  maybeAppendAgentBar();
}

function renderApprovalCenterView(view: WorkSessionViewState): void {
  // P0.5: only the active workspace's approval center can render. A center
  // selected under another workspace falls back to the gated empty surface
  // instead of leaking that workspace's direct approvals.
  if (view.workSessionId !== approvalCenterId(activeWorkspaceId)) {
    if (renderWorkspaceApprovalGate()) return;
    renderEmpty(errorMessage ?? "Waiting for a tool result.", errorMessage ? "error" : "muted");
    return;
  }
  ensureSurface("approval-center");
  const main = element("main", { className: "shell" });
  const section = element("section", { className: "tool-card agent" });
  section.append(
    element("div", { className: "tool-title", text: "Workspace approvals" }),
    element("div", { className: "tool-label", text: `${view.policyApprovals.size} pending direct MCP operation(s)` }),
  );
  if (view.policyApprovals.size === 0 && approvalRecoveryState === "healthy") {
    section.append(element("div", { className: "empty muted", text: "No pending approvals." }));
  } else if (view.policyApprovals.size === 0) {
    section.append(element("div", { className: "empty muted", text: "No pending approvals." }));
    section.append(renderApprovalRecoveryIndicator());
  } else {
    const list = element("div", { className: "approval-list" });
    for (const approval of view.policyApprovals.values()) list.append(renderPolicyApproval(view, approval));
    section.append(list);
    if (approvalRecoveryState !== "healthy") section.append(renderApprovalRecoveryIndicator());
  }
  main.append(section);
  appRoot.replaceChildren(main);
  maybeAppendAgentBar();
}

/** P1: explicit approval-recovery health indicator with a manual retry. */
function renderApprovalRecoveryIndicator(): HTMLElement {
  const indicator = element("div", { className: "session-notice warning", role: "status" });
  const message = approvalRecoveryState === "forbidden"
    ? "Reviewer authorization failed: approval recovery is unavailable."
    : approvalRecoveryState === "disconnected"
      ? "Approval recovery unavailable: the host connection is down."
      : "Approval recovery unavailable: pending approvals may be stale.";
  indicator.append(element("span", { text: message }));
  const retry = element("button", { className: "notice-action", type: "button", text: "Retry" });
  retry.addEventListener("click", () => {
    approvalRecoveryState = "healthy";
    queueSessionRehydration();
    scheduleRender();
  });
  indicator.append(retry);
  return indicator;
}

/**
 * P0.3: prominent "Needs approval" banner shown in every current Kontrol
 * surface while a direct approval for the active workspace is pending but
 * not currently displayed. Returns true when the banner was rendered into a
 * standalone gated surface.
 */
function renderWorkspaceApprovalGate(): boolean {
  const center = activeWorkspaceId ? workSessionViews.get(approvalCenterId(activeWorkspaceId)) : undefined;
  if (!activeWorkspaceId || !center || center.policyApprovals.size === 0) return false;
  const main = element("main", { className: "shell" });
  const section = element("section", { className: "session-notice warning approval-gate", role: "alert" });
  const review = element("button", {
    className: "notice-action approval-gate-action",
    type: "button",
    text: `Needs approval — ${center.policyApprovals.size} pending operation${center.policyApprovals.size === 1 ? "" : "s"}`,
    ariaLabel: "Open workspace approvals",
  });
  review.addEventListener("click", () => selectWorkSession(center.workSessionId));
  section.append(
    element("span", { className: "approval-gate-message", text: "A direct MCP operation is blocked and waiting for your decision." }),
    review,
  );
  main.append(section);
  appRoot.replaceChildren(main);
  maybeAppendAgentBar();
  return true;
}

function ensureSurface(key: string): void {
  if (renderedSurfaceKey === key) return;
  unmountPayload();
  currentWorkSessionDom = null;
  renderedSurfaceKey = key;
}

function renderSummaryBadge(card: ToolResultCard): HTMLElement {
  const badge = element("span", { className: "tool-badge", ariaHidden: "true" });
  if (isReviewTool(card.tool)) {
    const files = summaryNumber(card.summary, "files") ?? card.files?.length ?? 0;
    badge.textContent = files > 0 ? `${files} file${files === 1 ? "" : "s"}` : "review";
  } else if (card.summary?.status) {
    badge.textContent = String(card.summary.status);
  } else if (card.path) {
    badge.textContent = card.path.split("/").pop() ?? card.path;
  } else {
    badge.textContent = card.tool;
  }
  return badge;
}

function unmountPayload(): void {
  payloadLoadGeneration += 1;
  if (currentPayload) {
    try {
      currentPayload.unmount();
    } catch {
      /* ignore */
    }
    currentPayload = null;
  }
  if (currentPayloadContainer) {
    currentPayloadContainer.replaceChildren();
  }
  currentPayloadContainer = null;
  currentPayloadCard = null;
  currentPayloadKind = null;
  currentPayloadKey = null;
  payloadLoadingKey = null;
}

function renderPayloadIfNeeded(
  payloadCard?: ToolResultCard | null,
  visibleFileCount?: number,
): void {
  const target = currentPayloadContainer;
  if (!target) return;
  const card = payloadCard === undefined ? currentPayloadCard ?? lastToolCard : payloadCard;
  if (!card) return;
  currentPayloadCard = card;

  const kind = isReviewTool(card.tool) ? "review" : "heavy";
  // The renderer identity is the selected card/submission, not its mutable
  // payload. Content and theme updates must flow through update(); remounting
  // Pierre on every output fragment loses scroll position and focus.
  const identity = isReviewTool(card.tool)
    ? String(card.summary?.submissionId ?? card.workSessionId ?? card.path ?? card.tool)
    : String(card.path ?? card.workSessionId ?? card.tool);
  const key = `${kind}:${card.tool}:${identity}`;
  if (currentPayloadContainer === target && currentPayload && currentPayloadKind === kind && currentPayloadKey === key) {
    currentPayload.update({ card, hostContext, errorMessage, visibleFileCount });
    return;
  }

  if (currentPayloadContainer === target && !currentPayload && payloadLoadingKey === key) return;

  if (currentPayloadContainer !== target || currentPayloadKind !== kind || currentPayloadKey !== key) {
    if (currentPayload) {
      try { currentPayload.unmount(); } catch { /* ignore renderer teardown failures */ }
      currentPayload = null;
    }
    currentPayloadContainer = target;
    currentPayloadKind = kind;
    currentPayloadKey = key;
    payloadLoadingKey = key;
    target.replaceChildren(element("div", { className: "status muted", text: "Loading rich payload…" }));
    const generation = ++payloadLoadGeneration;
    const options = { card, hostContext, errorMessage, visibleFileCount };
    void (kind === "review"
      ? import("./review-payload.js").then(({ mountReviewPayload }) => mountReviewPayload(target, options))
      : import("./heavy-payload.js").then(({ mountHeavyPayload }) => mountHeavyPayload(target, options)))
      .then((mounted) => {
        if (generation !== payloadLoadGeneration || currentPayloadContainer !== target || currentPayloadKey !== key) {
          try { mounted.unmount(); } catch { /* ignore stale renderer teardown failures */ }
          return;
        }
        currentPayload = mounted;
        payloadLoadingKey = null;
        // Host theme or card payload may have changed while the lazy module was
        // loading. Apply the newest values without another mount.
        mounted.update({ card: currentPayloadCard ?? card, hostContext, errorMessage, visibleFileCount });
      })
      .catch((error) => {
        if (generation !== payloadLoadGeneration || currentPayloadContainer !== target || currentPayloadKey !== key) return;
        currentPayload = null;
        payloadLoadingKey = null;
        target.replaceChildren(element("pre", {
          className: "text-payload fallback",
          text: payloadText(card.payload) || card.payload?.patch || `Rich renderer failed: ${error instanceof Error ? error.message : String(error)}`,
        }));
      });
  }
}

// ── Composed work-session view ───────────────────────

function renderWorkSessionView(view: WorkSessionViewState): void {
  ensureSurface(`session:${view.workSessionId}`);
  const dom = currentWorkSessionDom ?? createWorkSessionDom(view.workSessionId);
  currentWorkSessionDom = dom;

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
  if (lastSuccessfulHydrationAt) {
    dom.meta.append(element("span", {
      className: "agent-meta-row",
      text: `state synced · ${new Date(lastSuccessfulHydrationAt).toLocaleTimeString()}`,
    }));
  }
  if (!connected) {
    dom.section.querySelector(":scope > .connection-banner")?.remove();
    const banner = element("div", { className: "session-notice warning connection-banner", role: "status" });
    banner.append(element("span", { text: connectionState === "RECONNECTING" ? "Connection interrupted. Showing last known state while reconnecting." : "Host connection is unavailable. Mutations are paused." }));
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
    const submissionCard = reviewCardFromSubmission(submission, view.workSessionId);
    if (submission.patch) {
      dom.reviewPayload.removeAttribute("data-loading-key");
      currentPayloadContainer = dom.reviewPayload;
      renderPayloadIfNeeded(submissionCard);
    } else {
      const loadingKey = `loading:${submission.submissionId}`;
      if (dom.reviewPayload.dataset.loadingKey !== loadingKey) {
        if (currentPayloadContainer === dom.reviewPayload && currentPayload) unmountPayload();
        dom.reviewPayload.replaceChildren(element("div", { className: "status muted", text: "Loading review details…" }));
        dom.reviewPayload.dataset.loadingKey = loadingKey;
      }
      currentPayloadContainer = dom.reviewPayload;
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
    if (currentPayloadContainer === dom.reviewPayload) unmountPayload();
    currentPayloadContainer = dom.reviewPayload;
    dom.reviewPayload.replaceChildren();
    dom.reviewPayload.removeAttribute("data-loading-key");
    if (view.status === "awaiting_review") dom.reviewPayload.append(element("div", { className: "empty muted", text: "Awaiting review submission…" }));
    else dom.review.hidden = true;
    dom.reviewFeedback.replaceChildren();
    dom.reviewFeedbackKey = undefined;
  }

  if (!dom.main.isConnected) {
    appRoot.replaceChildren(dom.main);
  }
  maybeAppendAgentBar();
}

function createWorkSessionDom(workSessionId: string): WorkSessionDom {
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

function renderSessionSwitcher(container: HTMLElement): void {
  container.replaceChildren();
  // P0.4/P0.5: the approval center and every session button are workspace-
  // scoped. Only views of the active workspace are offered for selection.
  const approvalCenter = activeWorkspaceId ? workSessionViews.get(approvalCenterId(activeWorkspaceId)) : undefined;
  const sessions = [...workSessionViews.values()]
    .filter((view) => !isApprovalCenterId(view.workSessionId))
    .filter((view) => view.workspaceSessionId === activeWorkspaceId)
    .sort((a, b) => {
      const at = Date.parse(a.updatedAt ?? "") || 0;
      const bt = Date.parse(b.updatedAt ?? "") || 0;
      return bt - at || b.lastSeq - a.lastSeq;
    });
  if (approvalCenter && approvalCenter.policyApprovals.size > 0) {
    const button = element("button", {
      className: `session-switcher-item${selectedWorkSessionId === approvalCenter.workSessionId ? " selected" : ""}`,
      type: "button",
      text: `Workspace approvals · ${approvalCenter.policyApprovals.size}`,
      ariaPressed: String(selectedWorkSessionId === approvalCenter.workSessionId),
    });
    button.dataset.focusKey = `session:${approvalCenter.workSessionId}`;
    button.addEventListener("click", () => selectWorkSession(approvalCenter.workSessionId));
    container.append(button);
  }
  if (activeWorkspaceId && !historicalPendingReviewsLoaded) {
    const history = element("button", {
      className: "session-switcher-item history-action",
      type: "button",
      text: "Load older pending reviews",
      ariaLabel: "Load older pending reviews",
      disabled: !uiMutationsAllowed(),
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
      className: `session-switcher-item${view.workSessionId === selectedWorkSessionId ? " selected" : ""}`,
      type: "button",
      text: `${category} · ${label} · ${view.submittedBy ?? "agent"}${updatedAt ? ` · ${updatedAt}` : ""}`,
      ariaPressed: String(view.workSessionId === selectedWorkSessionId),
      title: `${view.workSessionId}${view.submittedBy ? ` · ${view.submittedBy}` : ""}`,
    });
    button.dataset.focusKey = `session:${view.workSessionId}`;
    button.addEventListener("click", () => selectWorkSession(view.workSessionId));
    container.append(button);
  }
}

/** P0.3: prominent in-surface "Needs approval" banner for direct approvals. */
function renderSessionApprovalGateBanner(dom: WorkSessionDom, view: WorkSessionViewState): void {
  const center = activeWorkspaceId ? workSessionViews.get(approvalCenterId(activeWorkspaceId)) : undefined;
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

function selectWorkSession(workSessionId: string): void {
  if (!workSessionViews.has(workSessionId)) return;
  // P0.5: another workspace's views (including its approval center) are
  // never selectable while a different workspace is active.
  const target = workSessionViews.get(workSessionId)!;
  if (isApprovalCenterId(workSessionId) ? workSessionId !== approvalCenterId(activeWorkspaceId) : target.workspaceSessionId !== activeWorkspaceId) {
    return;
  }
  // A reviewer-driven selection out of the approval center cancels the
  // pending auto-return; only an automatic switch owns the return slot.
  approvalAttention = selectionChanged(approvalAttention, workSessionId, isApprovalCenterId);
  pendingApprovalReturnSessionId = approvalAttention.returnSessionId;
  selectedWorkSessionId = workSessionId;
  if (isApprovalCenterId(workSessionId)) {
    render();
    return;
  }
  const view = workSessionViews.get(workSessionId)!;
  void hydrateWorkSessionSnapshot(view)
    .then(() => scheduleRender())
    .catch((error) => {
      view.notice = { tone: "warning", message: `Session details could not be loaded: ${error instanceof Error ? error.message : String(error)}` };
      scheduleRender();
    });
  scheduleRender();
}

/**
 * P0.3: surface a NEW direct approval without destroying active reviewer
 * input. When a reviewer is typing, focus is retained and the
 * always-rendered "Needs approval" banner carries the action; otherwise the
 * workspace approval center is selected automatically and the previous
 * non-approval surface is remembered so it can be restored when the last
 * pending approval resolves. Decision logic lives in approval-attention.ts.
 */
function surfaceNewDirectApproval(workspaceId: string, approvalId: string): void {
  const centerId = approvalCenterId(workspaceId);
  if (!workSessionViews.has(centerId)) return;
  const center = workSessionViews.get(centerId)!;
  // Duplicate watcher delivery of one approval would otherwise re-yank the
  // reviewer; the reducer's seq guard dedupes the row, and a row count above
  // one means this delivery is a replay of an earlier approval, not a NEW one.
  if (!approvalAttentionDelivered.has(approvalId)) {
    approvalAttentionDelivered.add(approvalId);
    const decision = approvalAttentionDecision(
      approvalAttention,
      {
        isNewApproval: true,
        isApprovalResolved: false,
        pendingApprovalCount: center.policyApprovals.size,
        selectedSessionId: selectedWorkSessionId,
        reviewerInputHasFocus: reviewerInputHasFocus(),
      },
      centerId,
    );
    approvalAttention = decision.next;
    pendingApprovalReturnSessionId = approvalAttention.returnSessionId;
    if (decision.selectSessionId) selectWorkSession(decision.selectSessionId);
  }
}

/**
 * P0.3: restore the pre-approval surface once the last pending approval of
 * the active workspace resolves, but only when the reviewer is still looking
 * at the approval center we auto-switched to — a reviewer who navigated
 * elsewhere has already made their choice about where to be.
 */
function maybeRestoreAfterApprovalResolved(workspaceId: string, approvalId?: string): void {
  if (approvalId) approvalAttentionDelivered.delete(approvalId);
  const center = workSessionViews.get(approvalCenterId(workspaceId));
  const decision = approvalAttentionDecision(
    approvalAttention,
    {
      isNewApproval: false,
      isApprovalResolved: true,
      pendingApprovalCount: center?.policyApprovals.size ?? 0,
      selectedSessionId: selectedWorkSessionId,
      reviewerInputHasFocus: false,
    },
    approvalCenterId(workspaceId),
  );
  approvalAttention = decision.next;
  pendingApprovalReturnSessionId = approvalAttention.returnSessionId;
  if (decision.selectSessionId) selectWorkSession(decision.selectSessionId);
}

function renderSessionNotice(container: HTMLElement, view: WorkSessionViewState): void {
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

function renderOpenMessages(container: HTMLElement, view: WorkSessionViewState): void {
  const stateKey = [...view.openMessages.values()]
    .map((message) => `${message.messageId}:${message.status}:${message.title ?? ""}:${message.body ?? ""}:${messageMutationOutcomeUnknown.has(message.messageId) ? "unknown" : "ready"}`)
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
    const messageUnknown = messageMutationOutcomeUnknown.has(message.messageId);
    const resolve = element("button", {
      className: "feedback-btn approve",
      type: "button",
      text: "Reply / Resolve",
      disabled: messageUnknown || !uiMutationsAllowed(),
    });
    resolve.addEventListener("click", () => {
      if (!app) return;
      resolve.disabled = true;
      void callServerToolChecked({
        name: "resolve_agent_message",
        arguments: { sessionId: view.workSessionId, messageId: message.messageId, reply: reply.value.trim() || undefined, clientMutationId: newClientMutationId() },
      }).then(() => {
        view.openMessages.delete(message.messageId);
        view.unresolvedMessageCount = view.openMessages.size;
        view.notice = { tone: "success", message: "Reply sent to the agent." };
        scheduleRender();
      }).catch((error) => {
        if (error instanceof AmbiguousMutationError) {
          messageMutationOutcomeUnknown.add(message.messageId);
          view.notice = { tone: "warning", message: "Agent reply outcome is unknown. Refresh the session before trying again." };
        } else {
          resolve.disabled = false;
          view.notice = { tone: "error", message: `Could not resolve agent request: ${error instanceof Error ? error.message : String(error)}` };
        }
        scheduleRender();
      });
    });
    card.append(replyLabel, reply, resolve);
    if (messageUnknown) {
      const refresh = element("button", {
        className: "notice-action",
        type: "button",
        text: "Refresh session state",
        disabled: !uiMutationsAllowed(),
      });
      refresh.addEventListener("click", () => { void reconcileMessageOutcome(view, message.messageId); });
      card.append(element("div", { className: "feedback-error", text: "Reply outcome is unknown after a connection interruption. Refresh authoritative session state before trying again." }), refresh);
    }
    container.append(card);
  }
}

async function reconcileMessageOutcome(view: WorkSessionViewState, messageId: string): Promise<void> {
  if (!app || !uiMutationsAllowed()) return;
  try {
    await hydrateWorkSessionSnapshot(view);
    if (!view.openMessages.has(messageId)) {
      messageMutationOutcomeUnknown.delete(messageId);
      view.notice = { tone: "success", message: "The agent reply was committed." };
    } else {
      view.notice = { tone: "warning", message: "The agent request is still open. No reply was committed; keep it paused until you are ready." };
    }
  } catch (error) {
    view.notice = { tone: "warning", message: `Reply outcome still needs reconciliation: ${error instanceof Error ? error.message : String(error)}` };
  }
  render();
}

function renderActivityIncrementally(dom: WorkSessionDom, view: WorkSessionViewState): void {
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

function renderAgentSubmitBar(): HTMLElement {
  if (!agentBar) {
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
      void reconnectApp("refreshing dispatch outcome")
        .then(async () => {
          queueSessionRehydration();
          if (rehydrationPromise) await rehydrationPromise;
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
      if (!task || !app) return;
      if (!activeWorkspaceId) {
        status.textContent = "Open a workspace before dispatching a coding agent.";
        return;
      }
      status.textContent = "Dispatching…";
      btn.setAttribute("disabled", "true");
      void callServerToolChecked({
          name: "submit_to_coding_agent",
          arguments: { task, workspaceSessionId: activeWorkspaceId, clientMutationId: newClientMutationId() },
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
          selectedWorkSessionId = dispatch.workSessionId;
          lastToolCard = null;
          expanded = false;
          reviewFilesExpanded = false;
          errorMessage = null;
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

function maybeAppendAgentBar(): void {
  if (connected) appRoot.append(renderAgentSubmitBar());
}

// ── Legacy review card (non-work-session review surfaces) ──

function renderReviewCard(card: ToolResultCard, display: ToolDisplay): void {
  const surfaceKey = `review:${card.tool}:${String(card.summary?.submissionId ?? card.summary?.sessionId ?? "")}`;
  ensureSurface(surfaceKey);

  const files = card.files ?? [];
  const summary = card.summary ?? {};
  const visibleFiles = reviewFilesExpanded ? files : files.slice(0, 3);
  const hiddenCount = Math.max(0, files.length - visibleFiles.length);
  let dom = currentLegacyReviewDom;
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
    currentLegacyReviewDom = dom;
  }

  dom.actions.replaceChildren();
  if (hiddenCount > 0) {
    const showMore = element("button", {
      className: "review-action",
      type: "button",
      text: `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`,
    });
    showMore.addEventListener("click", () => {
      reviewFilesExpanded = true;
      render();
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

  currentPayloadContainer = dom.body;
  if (!dom.main.isConnected) appRoot.replaceChildren(dom.main);
  renderPayloadIfNeeded(card, visibleFiles.length);
  maybeAppendAgentBar();
}

function renderChevron(isExpanded: boolean, visible: boolean): HTMLElement {
  const chevron = element("span", {
    className: visible ? `chevron ${isExpanded ? "expanded" : ""}` : "chevron",
    ariaHidden: "true",
  });
  if (visible) {
    chevron.innerHTML = iconSvg('<path d="m6 9 6 6 6-6" />');
  }
  return chevron;
}

function setPayloadLoading(container: HTMLElement, loading: boolean): void {
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
export { AmbiguousMutationError } from "./server-tool-call.js";

// Kept behind an explicit global test switch so jsdom can exercise the same
// incremental workspace surface without opening an MCP transport. Production
// boot remains side-effectful only in the browser entrypoint above.
export const __workspaceAppTest = {
  ensureWorkSessionView,
  renderWorkSessionView,
  reduceWorkSessionEvent,
  workspaceEventTargetSessionId,
  boot,
  callServerToolChecked,
  getConnectionState: () => connectionState,
  getLastSuccessfulHydrationAt: () => lastSuccessfulHydrationAt,
  getWorkSessionView: (sessionId: string) => workSessionViews.get(sessionId),
  getActiveWorkspaceId: () => activeWorkspaceId,
  getSelectedWorkSessionId: () => selectedWorkSessionId,
  activateWorkspace,
  surfaceNewDirectApproval,
  surfaceNewDirectApprovalResolved: (workspaceId: string) => maybeRestoreAfterApprovalResolved(workspaceId),
  selectWorkSession,
  reconcileAuthoritativeApprovals,
};
