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
  WorkSessionDom,
  WorkSessionViewState,
  LegacyReviewDom,
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
import type { LegacyReviewDom, WorkSessionDom } from "./session-view-types.js";
import { formatElapsed, humanizeStatus } from "./ui-format.js";
import { approvalCenterId, isApprovalCenterId } from "./approval-center.js";
import { relativeSessionAge, sessionCategory } from "./session-view-helpers.js";
import {
  currentPayloadContainerElement,
  hasMountedPayload,
  setPayloadContainer,
  ensureSurface,
  renderPayloadIfNeeded,
  renderSummaryBadge,
  setPayloadMountHost,
  unmountPayload,
} from "./payload-mount.js";
import {
  maybeAppendAgentBar,
  maybeRestoreAfterApprovalResolved,
  renderChevron,
  renderReviewCard,
  renderWorkSessionView,
  selectWorkSession,
  setSessionSurfaceHost,
  surfaceNewDirectApproval,
} from "./session-surface.js";
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
let agentBar: HTMLElement | null = null;

let currentWorkSessionDom: WorkSessionDom | null = null;
let renderedSurfaceKey: string | null = null;
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

// Host bindings are installed at module scope, not inside boot(): the
// DOM test harness (and any uiTestMode embedder) drives render/reducer paths
// directly without booting a transport.
  setServerToolHost({
    getApp: () => app,
    reconnect: (reason) => reconnectApp(reason),
  });

  setSessionSurfaceHost({
    getApp: () => app,
    scheduleRender: () => scheduleRender(),
    uiMutationsAllowed,
    newClientMutationId,
    getActiveWorkspaceId: () => activeWorkspaceId,
    getSelectedWorkSessionId: () => selectedWorkSessionId,
    setSelectedWorkSessionId: (v) => { selectedWorkSessionId = v; },
    getApprovalAttention: () => approvalAttention,
    setApprovalAttention: (v) => { approvalAttention = v; },
    getApprovalAttentionReturnSessionId: () => approvalAttention.returnSessionId,
    setPendingApprovalReturnSessionId: (v) => { pendingApprovalReturnSessionId = v; },
    approvalAttentionDelivered,
    getCurrentWorkSessionDom: () => currentWorkSessionDom,
    setCurrentWorkSessionDom: (v) => { currentWorkSessionDom = v; },
    getCurrentLegacyReviewDom: () => currentLegacyReviewDom,
    setCurrentLegacyReviewDom: (v) => { currentLegacyReviewDom = v; },
    replaceSurfaceChildren: (...children) => { appRoot.replaceChildren(...children); },
    appendSurface: (child) => { appRoot.append(child); },
    surfaceContains: (el) => appRoot.contains(el),
    getExpanded: () => expanded,
    setExpanded: (v) => { expanded = v; },
    getReviewFilesExpanded: () => reviewFilesExpanded,
    setReviewFilesExpanded: (v) => { reviewFilesExpanded = v; },
    getAgentBar: () => agentBar,
    setAgentBar: (v) => { agentBar = v; },
    messageMutationOutcomeUnknown,
    rehydrationPromise: () => rehydrationPromise,
    reconnect: (reason) => reconnectApp(reason),
    queueSessionRehydration,
    callServerToolChecked,
    selectWorkSession,
    setSelectionAttention: (workSessionId, isCenter) => {
      approvalAttention = selectionChanged(approvalAttention, workSessionId, isCenter);
      pendingApprovalReturnSessionId = approvalAttention.returnSessionId;
    },
    reviewerInputHasFocus,
    getLastSuccessfulHydrationAt: () => lastSuccessfulHydrationAt,
    connected: () => connected,
    connectionState: () => connectionState,
    render: () => render(),
    historicalPendingReviewsLoaded: () => historicalPendingReviewsLoaded,
    reviewCardFromSubmission,
    getLastToolCard: () => lastToolCard,
    setLastToolCard: (v) => { lastToolCard = v; },
    getErrorMessage: () => errorMessage,
    setErrorMessage: (v) => { errorMessage = v; },
  });

  setPayloadMountHost({
    getLastToolCard: () => lastToolCard,
    getHostContext: () => hostContext,
    getErrorMessage: () => errorMessage,
    renderedSurfaceKey: () => renderedSurfaceKey,
    setRenderedSurfaceKey: (v) => { renderedSurfaceKey = v; },
    setCurrentWorkSessionDom: (v) => { currentWorkSessionDom = v as WorkSessionDom | null; },
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

if (!uiTestMode) void boot();

async function boot(): Promise<void> {
  if (bootPromise) return bootPromise;
  bootPromise = bootInternal().finally(() => { bootPromise = null; });
  return bootPromise;
}

async function bootInternal(): Promise<void> {
  render();

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
    setPayloadContainer(body);
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

// ── Composed work-session view ───────────────────────

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
