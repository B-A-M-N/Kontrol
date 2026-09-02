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

interface ToolDisplay {
  icon: string;
  title: string;
  label: string;
  tone: string;
}

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

interface AgentActivityEvent {
  seq: number;
  id: string;
  durable?: boolean;
  type: string;
  sessionId: string;
  workspaceSessionId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

type ReviewSubmissionView = {
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

interface PolicyApprovalView {
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

interface PendingApprovalRecord {
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

interface AgentMessageView {
  messageId: string;
  kind: string;
  author?: string;
  title?: string;
  body?: string;
  status: string;
  runId?: string;
  createdAt?: string;
}

interface MissionPacketView {
  supervisor?: { id: string; status: string; resumeStatus?: string | null; revision: number; cycleNumber: number; maxCycles: number; autonomyMode: string; approvalMode: string; repeatedFailureCount?: number; repeatedFailureFingerprintLimit?: number; stagnantCycleCount?: number; progressJson?: string | null; stallReason?: string | null; updatedAt?: string; deadlineAt?: string; lastError?: string };
  mission?: { id: string; objective: string; desiredOutcome?: string; correctionRounds?: number; maxCorrectionRounds?: number };
  criteria: Array<{ id: string; description: string; priority: string; status: string; verificationType?: string; verificationCommand?: string; dependsOnCriterionIds?: string[] }>;
  findings: Array<{ id: string; description: string; severity: string; scope: string; status: string; requiredAction?: string }>;
  workOrders: Array<{ id: string; objectiveForThisTurn: string; status: string }>;
  evidence: Array<{ id: string; criterionId?: string; status: string; source?: string; command?: string }>;
  completionReports?: Array<{ id: string; status: string; reportSha256: string; createdAt: string }>;
  approval: { allowed: boolean; reasons: string[] };
}

type FeedbackState = "idle" | "submitting" | "submitted" | "error" | "outcome_unknown";

interface WorkSessionViewState {
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

interface WorkspaceSurfaceSession {
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
const workSessionViews = new Map<string, WorkSessionViewState>();
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
const APPROVAL_CENTER_PREFIX = "__approval_center__:";
// P0.4: the approval center is workspace-scoped. One global pseudo-session
// would let workspace A's direct approvals render under workspace B after a
// reconnect re-tagged the shared view's workspaceSessionId.
function approvalCenterId(workspaceId: string | null | undefined): string {
  return `${APPROVAL_CENTER_PREFIX}${workspaceId ?? ""}`;
}
function isApprovalCenterId(workSessionId: string | null | undefined): boolean {
  return typeof workSessionId === "string" && workSessionId.startsWith(APPROVAL_CENTER_PREFIX);
}
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
 * On connect/reconnect, ask the server for one compact workspace projection,
 * then rebuild each view from its durable snapshot and tail cursor. Stale and
 * detached history is not silently presented as current work.
 */
async function rehydrateActiveSessions(): Promise<void> {
  if (!app) return;
  // P0 #2: scoped rehydration. Only rehydrate sessions within the current
  // workspace. Never globally auto-rehydrate before the workspace is known.
  // P0 #1: use server-side snapshot + resume from lastSeq instead of replaying
  // the entire event log from seq 0.
  const workspaceId = activeWorkspaceId;
  if (!workspaceId) return;

  try {
    const pagedSessions = new Map<string, WorkspaceSurfaceSession>();
    let surfaceLastSeq = 0;
    const loadSurface = async (filter: "all" | "pending_review" | "live", pageSize: number, maxPages: number): Promise<void> => {
      let afterUpdatedAt: string | undefined;
      let afterSessionId: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const surfaceResult = await callServerToolChecked({
          name: "get_workspace_session_surface",
          arguments: {
            workspaceId,
            filter,
            limit: pageSize,
            ...(afterUpdatedAt && afterSessionId ? { afterUpdatedAt, afterSessionId } : {}),
          },
        });
        const surfaceContent = getStructuredContent<{ lastSeq?: number; sessions: WorkspaceSurfaceSession[] }>(surfaceResult);
        surfaceLastSeq = Math.max(surfaceLastSeq, surfaceContent?.lastSeq ?? 0);
        const pageSessions = surfaceContent?.sessions ?? [];
        for (const session of pageSessions) pagedSessions.set(session.sessionId, session);
        if (pageSessions.length < pageSize) break;
        const last = pageSessions[pageSessions.length - 1];
        if (!last || (last.updatedAt === afterUpdatedAt && last.sessionId === afterSessionId)) break;
        afterUpdatedAt = last.updatedAt;
        afterSessionId = last.sessionId;
      }
    };
    // Hydrate the live control-plane surface completely, but keep detached
    // history bounded to the visible recent window. Older history is an
    // explicit load-more concern, not startup work.
    // P1 #33: live/pending hydration is capped at a realistic ceiling
    // (500 sessions each) so a reconnect after long downtime cannot rebuild
    // tens of thousands of views; the cap is far above any real concurrent
    // control-plane surface and exposes "older available" via truncation.
    const HYDRATION_MAX_SESSIONS = 500;
    await loadSurface("live", 50, HYDRATION_MAX_SESSIONS / 50);
    await loadSurface("pending_review", 50, HYDRATION_MAX_SESSIONS / 50);
    await loadSurface("all", 25, 1);
    if (!app || activeWorkspaceId !== workspaceId) return;
    const sessions = [...pagedSessions.values()].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
    workspaceEventCursor = Math.max(workspaceEventCursor, surfaceLastSeq);

    for (const s of sessions) {
      const view = ensureWorkSessionView(s.sessionId, s.workspaceSessionId, s.runId ?? "");
      view.status = s.status;
      view.title = s.title;
      view.submittedBy = s.submittedBy;
      view.updatedAt = s.updatedAt;
      view.lastHeartbeatAt = s.lastHeartbeatAt;
      view.lifecycle = s.lifecycle;
      view.runtimeState = s.runtimeState;
      view.unresolvedMessageCount = s.unresolvedMessageCount;
      view.pendingApprovalCount = s.pendingApprovalCount;
      view.lastSeq = s.lastSeq;
      view.latestFeedback = s.latestFeedback;
      if (s.latestSubmission) {
        const surfaceSubmission: ReviewSubmissionView = {
          submissionId: s.latestSubmission.submissionId,
          sessionId: s.sessionId,
          submissionNumber: s.latestSubmission.submissionNumber,
          reviewEpoch: s.latestSubmission.reviewEpoch,
          diffSha256: s.latestSubmission.diffSha256,
          status: s.latestSubmission.status,
          files: [],
          patch: "",
          fileCount: 0,
          additions: s.latestSubmission.additions,
          removals: s.latestSubmission.removals,
        };
        noteSubmission(view, surfaceSubmission);
      }
    }
    // If nothing is selected yet, surface the most recently updated session.
    // If the previous selection disappeared, choose the newest remaining one.
    // P0.5: a selection belonging to another workspace (or another
    // workspace's approval center) is not a valid fallback either.
    const recoveredSessionIds = new Set(sessions.map((session) => session.sessionId));
    if (sessions.length
      && (!selectedWorkSessionId
        || !recoveredSessionIds.has(selectedWorkSessionId)
        || workSessionViews.get(selectedWorkSessionId)?.workspaceSessionId !== workspaceId
        || isApprovalCenterId(selectedWorkSessionId))) {
      selectedWorkSessionId = sessions[0].sessionId;
    }

    // Pending tool approvals are durable, but direct client calls do not
    // belong to a work-session snapshot. Rehydrate them explicitly so a UI
    // reconnect cannot miss the live approval event and strand the caller.
    // P0: the server listing is the authoritative pending set. A server-side
    // resolution whose response event died on the transport (e.g. Approve
    // committed, response lost, callServerToolChecked correctly refusing to
    // re-mutate) must remove the stale local card, not resurrect it.
    const directApprovals: PendingApprovalRecord[] = [];
    try {
      const approvalResult = await callServerToolChecked({
        name: "list_pending_approvals",
        arguments: { workspaceId },
      });
      if (!app || activeWorkspaceId !== workspaceId) return;
      approvalRecoveryState = "healthy";
      const pending = getStructuredContent<{ approvals?: PendingApprovalRecord[] }>(approvalResult)?.approvals ?? [];
      const serverApprovalIds = new Set(pending.map((approval) => approval.approvalId));
      reconcileAuthoritativeApprovals(pending, serverApprovalIds, workspaceId);
      for (const approval of pending) {
        const target = approval.workSessionId
          ? ensureWorkSessionView(approval.workSessionId, approval.workspaceSessionId ?? workspaceId, "")
          : ensureWorkSessionView(approvalCenterId(workspaceId), workspaceId, "");
        if (target) mergePendingApproval(target, approval, workspaceId);
        else directApprovals.push(approval);
      }
    } catch (approvalError) {
      // Approval visibility must not prevent the rest of the workspace from
      // rehydrating. The live watcher remains the fallback for new requests,
      // but P1: the exact recovery failure is surfaced as control-plane
      // state instead of being silently discarded.
      const message = approvalError instanceof Error ? approvalError.message : String(approvalError);
      approvalRecoveryState = /forbidden|reviewer authority|requires reviewer/i.test(message)
        ? "forbidden"
        : connected
          ? "degraded"
          : "disconnected";
    }
    if (directApprovals.length > 0) {
      const target = ensureWorkSessionView(approvalCenterId(workspaceId), workspaceId, "");
      for (const approval of directApprovals) mergePendingApproval(target, approval, workspaceId);
    }
    const selected = selectedWorkSessionId ? workSessionViews.get(selectedWorkSessionId) : undefined;
    if (selected && !isApprovalCenterId(selected.workSessionId)) await hydrateWorkSessionSnapshot(selected);
    if (!app || activeWorkspaceId !== workspaceId) return;
    lastSuccessfulHydrationAt = new Date().toISOString();
    workspaceWatcherGeneration += 1;
    void watchWorkspaceEvents(workspaceId, workspaceEventCursor, workspaceWatcherGeneration);
    scheduleRender();
  } catch (error) {
    // A workspace switch or teardown can invalidate this run while one of the
    // recovery calls is in flight. Do not paint its error over the new app
    // context; the queued run for the current workspace owns that state.
    if (!app || activeWorkspaceId !== workspaceId) return;
    const selected = selectedWorkSessionId ? workSessionViews.get(selectedWorkSessionId) : undefined;
    if (selected) {
      selected.notice = {
        tone: "warning",
        message: `Session recovery is incomplete: ${error instanceof Error ? error.message : String(error)}`,
      };
    } else {
      errorMessage = `Session recovery is incomplete: ${error instanceof Error ? error.message : String(error)}`;
    }
    scheduleRender();
    throw error;
  }
}

function queueSessionRehydration(): void {
  if (!activeWorkspaceId || !app) return;
  rehydrationRequested = true;
  if (rehydrationPromise) return;

  rehydrationPromise = (async () => {
    // Coalesce boot, workspace-result, and event-triggered requests while
    // guaranteeing that only one snapshot/cursor handoff owns the watcher at
    // a time. If the workspace changes during a run, the next iteration uses
    // the new workspace instead of letting stale results win the race.
    let retryDelayMs = 1_000;
    while (rehydrationRequested && activeWorkspaceId && app) {
      rehydrationRequested = false;
      try {
        await rehydrateActiveSessions();
        retryDelayMs = 1_000;
      } catch (error) {
        if (!app || !activeWorkspaceId) return;
        rehydrationRequested = true;
        connectionState = connected ? "DEGRADED" : "RECONNECTING";
        connectionError = error instanceof Error ? error.message : String(error);
        render();
        const jitter = Math.floor(Math.random() * Math.min(500, retryDelayMs / 2));
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs + jitter));
        retryDelayMs = Math.min(30_000, retryDelayMs * 2);
      }
    }
  })().finally(() => {
    rehydrationPromise = null;
    if (rehydrationRequested) queueSessionRehydration();
  });
}

/**
 * P0: reconcile every mutable approval projection for this workspace against
 * the authoritative server pending set. Approvals that the server no longer
 * reports (resolved while the response transport was down) are removed;
 * those still pending are refreshed in place. Old-workspace centers are left
 * untouched — only the rehydrated workspace is reconciled.
 */
function reconcileAuthoritativeApprovals(
  pending: PendingApprovalRecord[],
  serverApprovalIds: Set<string>,
  workspaceId: string,
): void {
  const center = workSessionViews.get(approvalCenterId(workspaceId));
  if (center) {
    for (const approvalId of [...center.policyApprovals.keys()]) {
      if (!serverApprovalIds.has(approvalId)) {
        center.policyApprovals.delete(approvalId);
        // An approval the server no longer lists can never be "new" again;
        // drop its attention-delivery record so the set cannot grow unboundedly.
        approvalAttentionDelivered.delete(approvalId);
      }
    }
    center.pendingApprovalCount = center.policyApprovals.size;
  }
  for (const view of workSessionViews.values()) {
    if (isApprovalCenterId(view.workSessionId) && view !== center) continue;
    if (view.workspaceSessionId !== workspaceId) continue;
    let changed = false;
    for (const approvalId of [...view.policyApprovals.keys()]) {
      if (!serverApprovalIds.has(approvalId)) {
        view.policyApprovals.delete(approvalId);
        changed = true;
      }
    }
    if (changed) view.pendingApprovalCount = view.policyApprovals.size;
    view.pendingApprovalCount = Math.max(view.pendingApprovalCount, pending.filter(
      (approval) => approval.workSessionId === view.workSessionId,
    ).length);
  }
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

async function hydrateWorkSessionSnapshot(view: WorkSessionViewState): Promise<void> {
  if (!app) return;
  const existing = snapshotHydrations.get(view.workSessionId);
  if (existing) return existing;

  const hydration = (async () => {
    const hydrationStartSeq = view.lastSeq;
    view.missionLoading = true;
    view.missionError = undefined;
    scheduleRender();
    const snapResult = await callServerToolChecked({
      name: "get_work_session_snapshot",
      arguments: { sessionId: view.workSessionId },
    });
    const snap = getStructuredContent<{
      sessionId: string;
      workspaceSessionId: string;
      status: string;
      runId?: string;
      lastHeartbeatAt?: string;
      lastSeq: number;
      recentActivity?: AgentActivityEvent[];
      hasMission: boolean;
      latestSubmission?: { submissionId: string; submissionNumber: number; status: string; additions: number; removals: number; diffSha256?: string; reviewEpoch?: number };
      latestFeedback?: { id: string; submissionId?: string; verdict: string; comments?: string; reviewerId?: string };
      missionSummary?: { objective?: string; status?: string; cycleNumber?: number; maxCycles?: number };
      pendingApprovals?: Array<{
        approvalId: string;
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
      }>;
      agentMessages?: Array<{ messageId: string; kind: string; author?: string; title?: string; body?: string; status?: string; runId?: string; createdAt?: string }>;
    }>(snapResult);
    if (!snap) return;

    const snapshotIsCurrent = snap.lastSeq >= hydrationStartSeq && snap.lastSeq >= view.lastSeq;
    if (snapshotIsCurrent) {
      view.status = snap.status;
      view.runId = snap.runId ?? view.runId;
      view.lastHeartbeatAt = snap.lastHeartbeatAt;
      if (snap.recentActivity) {
        view.activity = snap.recentActivity.slice(-200);
      }
    }
    // A delayed snapshot must never rewind a cursor advanced by the live
    // watcher. Mutable snapshot fields are likewise stale when its boundary
    // is older than an event already reduced into this view.
    view.lastSeq = Math.max(view.lastSeq, snap.lastSeq);
    if (!snapshotIsCurrent) return;
    view.latestFeedback = snap.latestFeedback;
    if (snap.latestFeedback?.submissionId) {
      view.feedbackStateBySubmission.set(snap.latestFeedback.submissionId, "submitted");
    }
    view.policyApprovals.clear();
    for (const approval of snap.pendingApprovals ?? []) {
      view.policyApprovals.set(approval.approvalId, {
        approvalId: approval.approvalId,
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
        workSessionId: view.workSessionId,
      });
    }
    view.pendingApprovalCount = view.policyApprovals.size;
    const previousOpenMessageIds = new Set(view.openMessages.keys());
    view.openMessages.clear();
    for (const message of snap.agentMessages ?? []) {
      if (message.status && message.status !== "open") continue;
      if (message.kind !== "clarification_request" && message.kind !== "blocker") continue;
      view.openMessages.set(message.messageId, {
        messageId: message.messageId,
        kind: message.kind,
        author: message.author,
        title: message.title,
        body: message.body,
        status: message.status ?? "open",
        runId: message.runId,
        createdAt: message.createdAt,
      });
    }
    view.unresolvedMessageCount = view.openMessages.size;
    for (const messageId of previousOpenMessageIds) {
      if (!view.openMessages.has(messageId)) messageMutationOutcomeUnknown.delete(messageId);
    }
    if (snap.latestSubmission) {
      const existingSubmission = view.submissions.get(snap.latestSubmission.submissionId);
      noteSubmission(view, {
        ...existingSubmission,
        submissionId: snap.latestSubmission.submissionId,
        sessionId: view.workSessionId,
        submissionNumber: snap.latestSubmission.submissionNumber,
        reviewEpoch: snap.latestSubmission.reviewEpoch,
        diffSha256: snap.latestSubmission.diffSha256,
        status: snap.latestSubmission.status,
        files: existingSubmission?.files ?? [],
        patch: existingSubmission?.patch ?? "",
        fileCount: existingSubmission?.fileCount ?? 0,
        additions: snap.latestSubmission.additions,
        removals: snap.latestSubmission.removals,
      });
      if (!existingSubmission?.patch) void fetchReviewDiff(view.workSessionId, snap.latestSubmission.submissionId);
    }
    if (snap.hasMission) {
      view.missionLoading = true;
      void refreshMission(view);
    } else {
      view.missionLoading = false;
      view.mission = undefined;
      view.missionError = undefined;
    }
    scheduleRender();
  })().catch((error) => {
    view.missionLoading = false;
    view.missionError = error instanceof Error ? error.message : String(error);
    scheduleRender();
    throw error;
  });
  snapshotHydrations.set(view.workSessionId, hydration);
  try {
    await hydration;
  } finally {
    snapshotHydrations.delete(view.workSessionId);
  }
}

async function fetchReviewDiff(sessionId: string, submissionId: string): Promise<void> {
  if (!app) return;
  try {
    const result = await callServerToolChecked({
      name: "get_review_submission",
      arguments: { sessionId, submissionId },
    });
    const content = getStructuredContent<{
      submissionId: string;
      patch: string;
      additions: number;
      removals: number;
      files: ReviewSubmissionView["files"];
        }>(result);
    if (!content?.patch) {
      const view = workSessionViews.get(sessionId);
      if (view) {
        view.notice = {
          tone: "warning",
          message: "Review details could not be loaded.",
          action: {
            label: "Retry",
            run: () => {
              view.notice = { tone: "info", message: "Retrying review details…" };
              scheduleRender();
              void fetchReviewDiff(sessionId, submissionId);
            },
          },
        };
        scheduleRender();
      }
      return;
    }
    const view = workSessionViews.get(sessionId);
    if (view && content) {
      const sub = view.submissions.get(submissionId);
      if (sub) {
        sub.patch = content.patch;
        sub.additions = content.additions;
        sub.removals = content.removals;
        sub.files = content.files ?? [];
        render();
      }
    }
  } catch (error) {
    const view = workSessionViews.get(sessionId);
    if (view) {
      view.notice = {
        tone: "error",
        message: `Review details could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        action: {
          label: "Retry",
          run: () => {
            view.notice = { tone: "info", message: "Retrying review details…" };
            scheduleRender();
            void fetchReviewDiff(sessionId, submissionId);
          },
        },
      };
      scheduleRender();
    }
  }
}

async function refreshMission(view: WorkSessionViewState): Promise<void> {
  if (!app) return;
  try {
    const result = await callServerToolChecked({
      name: "inspect_supervised_work",
      arguments: { workSessionId: view.workSessionId },
    });
    const content = getStructuredContent<{ packet?: MissionPacketView }>(result);
    if (content?.packet?.mission) {
      view.mission = content.packet;
      view.missionLoading = false;
      view.missionError = undefined;
      scheduleRender();
    } else {
      view.missionLoading = false;
      view.missionError = "No supervision packet was returned.";
      scheduleRender();
    }
  } catch (error) {
    view.missionLoading = false;
    view.missionError = error instanceof Error ? error.message : String(error);
    scheduleRender();
  }
}

function ensureWorkSessionView(workSessionId: string, workspaceSessionId: string, runId: string): WorkSessionViewState {
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
function noteSubmission(view: WorkSessionViewState, submission: ReviewSubmissionView): void {
  const existing = view.submissions.get(submission.submissionId);
  if (!existing || compareSubmissionAuthority(submission, existing) >= 0) {
    view.submissions.set(submission.submissionId, submission);
  }
  const active = view.activeSubmissionId ? view.submissions.get(view.activeSubmissionId) : undefined;
  if (!active || compareSubmissionAuthority(submission, active) >= 0) {
    view.activeSubmissionId = submission.submissionId;
  }
}

function mergePendingApproval(view: WorkSessionViewState, approval: PendingApprovalRecord, fallbackWorkspaceId: string): void {
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

function humanizeStatus(status: string): string {
  const labels: Record<string, string> = {
    in_progress: "Working",
    awaiting_review: "Awaiting review",
    review_in_progress: "In review",
    changes_requested: "Changes requested",
    continuation_queued: "Resume queued",
    awaiting_resume: "Awaiting resume",
    resuming: "Resuming",
    approved: "Approved",
    rejected: "Rejected",
    cancelled: "Cancelled",
    cancelling: "Cancelling",
    failed: "Failed",
    failed_protocol: "Protocol failure",
    stale: "Historical",
    archived: "Archived",
  };
  return labels[status] ?? status.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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

function compareSubmissionAuthority(
  left: Pick<ReviewSubmissionView, "submissionNumber" | "reviewEpoch">,
  right: Pick<ReviewSubmissionView, "submissionNumber" | "reviewEpoch">,
): number {
  if (left.reviewEpoch !== undefined && right.reviewEpoch !== undefined) {
    return left.reviewEpoch - right.reviewEpoch || left.submissionNumber - right.submissionNumber;
  }
  return left.submissionNumber - right.submissionNumber
    || (left.reviewEpoch === undefined ? 0 : 1) - (right.reviewEpoch === undefined ? 0 : 1);
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

async function loadHistoricalPendingReviews(): Promise<void> {
  const workspaceId = activeWorkspaceId;
  if (!workspaceId || !uiMutationsAllowed()) return;
  try {
    const result = await callServerToolChecked({
      name: "get_workspace_session_surface",
      arguments: { workspaceId, filter: "stale_pending_review", limit: 100 },
    });
    const surface = getStructuredContent<{ sessions?: WorkspaceSurfaceSession[] }>(result)?.sessions ?? [];
    for (const s of surface) {
      const view = ensureWorkSessionView(s.sessionId, s.workspaceSessionId, s.runId ?? "");
      view.status = s.status;
      view.title = s.title;
      view.submittedBy = s.submittedBy;
      view.updatedAt = s.updatedAt;
      view.lastHeartbeatAt = s.lastHeartbeatAt;
      view.lifecycle = s.lifecycle;
      view.runtimeState = s.runtimeState;
      view.unresolvedMessageCount = s.unresolvedMessageCount;
      view.pendingApprovalCount = s.pendingApprovalCount;
      view.lastSeq = Math.max(view.lastSeq, s.lastSeq);
      view.latestFeedback = s.latestFeedback;
      if (s.latestSubmission) {
        noteSubmission(view, {
          submissionId: s.latestSubmission.submissionId,
          sessionId: s.sessionId,
          submissionNumber: s.latestSubmission.submissionNumber,
          reviewEpoch: s.latestSubmission.reviewEpoch,
          diffSha256: s.latestSubmission.diffSha256,
          status: s.latestSubmission.status,
          files: [],
          patch: "",
          fileCount: 0,
          additions: s.latestSubmission.additions,
          removals: s.latestSubmission.removals,
        });
      }
    }
    historicalPendingReviewsLoaded = true;
    lastSuccessfulHydrationAt = new Date().toISOString();
  } catch (error) {
    errorMessage = `Older reviews could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
  }
  scheduleRender();
}

function sessionCategory(view: WorkSessionViewState): string {
  if (view.openMessages.size > 0 || view.unresolvedMessageCount > 0 || view.policyApprovals.size > 0 || view.pendingApprovalCount > 0) {
    return "Needs input";
  }
  if (["awaiting_review", "review_in_progress", "changes_requested"].includes(view.status)
    || ["awaiting_review", "review_in_progress", "changes_requested"].includes(view.lifecycle ?? "")) {
    return "Needs review";
  }
  if (["stale", "archived", "detached", "orphaned", "parked"].includes(view.runtimeState ?? "")
    || ["approved", "rejected", "cancelled", "failed", "failed_protocol"].includes(view.status)) {
    return "Historical";
  }
  return humanizeStatus(view.status);
}

function relativeSessionAge(value: string): string {
  const ageMs = Math.max(0, Date.now() - Date.parse(value));
  if (!Number.isFinite(ageMs)) return "";
  if (ageMs < 60_000) return `${Math.max(1, Math.round(ageMs / 1000))}s ago`;
  if (ageMs < 60 * 60_000) return `${Math.round(ageMs / 60_000)}m ago`;
  return `${Math.round(ageMs / (60 * 60_000))}h ago`;
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

function reviewCardFromSubmission(submission: ReviewSubmissionView, sessionId: string): ToolResultCard {
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

function renderMissionPanel(view: WorkSessionViewState): HTMLElement {
  const packet = view.mission!;
  const panel = element("section", { className: "approval-card" });
  panel.append(element("div", { className: "approval-title", text: "Supervised mission" }));
  panel.append(element("div", { className: "approval-detail", text: packet.mission?.objective ?? "Mission contract" }));
  if (packet.supervisor) {
    const run = packet.supervisor;
    panel.append(element("div", { className: "approval-detail", text: `Supervisor: ${humanizeStatus(run.status)} · cycle ${run.cycleNumber}/${run.maxCycles} · ${humanizeStatus(run.autonomyMode)} · ${humanizeStatus(run.approvalMode)}${run.repeatedFailureCount ? ` · repeated failure ${run.repeatedFailureCount}` : ""}` }));
    let progress: { blockingFindingCount?: number; failedCriterionCount?: number; passedCriterionCount?: number; failingVerificationCount?: number; unresolvedRequiredActions?: number } | undefined;
    if (run.progressJson) {
      try { progress = JSON.parse(run.progressJson) as typeof progress; } catch { /* tolerate an older/corrupt projection */ }
    }
    if (progress) {
      const requiredTotal = (progress.failedCriterionCount ?? 0) + (progress.passedCriterionCount ?? 0);
      const criteriaText = requiredTotal > 0 ? `${progress.passedCriterionCount ?? 0}/${requiredTotal} criteria passing` : "criteria pending";
      const repeatedText = run.repeatedFailureFingerprintLimit
        ? ` · repeated failure ${run.repeatedFailureCount ?? 0}/${run.repeatedFailureFingerprintLimit}`
        : "";
      panel.append(element("div", { className: "approval-detail", text: `Convergence: ${progress.blockingFindingCount ?? 0} blockers · ${criteriaText} · ${progress.failingVerificationCount ?? 0} verification failures · ${progress.unresolvedRequiredActions ?? 0} required actions${repeatedText}` }));
    }
    if (run.stallReason) panel.append(element("div", { className: "feedback-error", text: `Supervision paused: ${run.stallReason}` }));
    if (run.updatedAt) panel.append(element("div", { className: "approval-detail", text: `Last supervisor progress: ${new Date(run.updatedAt).toLocaleString()}` }));
    if (run.deadlineAt) panel.append(element("div", { className: "approval-detail", text: `Autonomous deadline: ${new Date(run.deadlineAt).toLocaleString()}` }));
    if (run.lastError) panel.append(element("div", { className: "feedback-error", text: `Supervisor error: ${run.lastError}` }));
    const control = element("button", { className: "feedback-btn changes", type: "button", text: run.status === "paused" ? "Resume supervisor" : "Pause supervisor" });
    control.addEventListener("click", () => {
      if (!app) return;
      control.setAttribute("disabled", "true");
      void callServerToolChecked({ name: run.status === "paused" ? "resume_supervisor_run" : "pause_supervisor_run", arguments: { workSessionId: view.workSessionId, expectedRevision: run.revision, clientMutationId: newClientMutationId() } })
        .then(() => refreshMission(view))
        .catch((error) => { view.notice = { tone: "error", message: `Supervisor control failed: ${error instanceof Error ? error.message : String(error)}` }; scheduleRender(); });
    });
    panel.append(control);
    if (run.status === "awaiting_human") {
      const redrive = element("button", { className: "feedback-btn changes", type: "button", text: "Redrive stalled supervisor action" });
      redrive.addEventListener("click", () => {
        if (!app) return;
        redrive.setAttribute("disabled", "true");
        void callServerToolChecked({ name: "redrive_supervisor_run", arguments: { workSessionId: view.workSessionId, expectedRevision: run.revision, clientMutationId: newClientMutationId() } })
          .then(() => refreshMission(view))
          .catch((error) => { view.notice = { tone: "error", message: `Supervisor redrive failed: ${error instanceof Error ? error.message : String(error)}` }; scheduleRender(); });
      });
      panel.append(redrive);
    }
  }
  const progress = packet.criteria.map((criterion) => `${criterion.status === "verified" ? "✓" : "○"} ${criterion.description} — ${humanizeStatus(criterion.status)}${criterion.dependsOnCriterionIds?.length ? ` · depends on ${criterion.dependsOnCriterionIds.join(", ")}` : ""}`);
  for (const item of progress) panel.append(element("div", { className: "approval-detail", text: item }));
  const blockers = packet.approval.reasons;
  if (blockers.length) {
    panel.append(element("div", { className: "feedback-error", text: `Mission approval blocked: ${blockers.join("; ")}` }));
  } else {
    panel.append(element("div", { className: "feedback-submitted", text: "Mission evidence is complete and approval is available." }));
  }
  const openFindings = packet.findings.filter((finding) => !["verified_resolved", "waived"].includes(finding.status));
  for (const finding of openFindings) {
    panel.append(element("div", { className: "approval-detail", text: `${humanizeStatus(finding.severity)} · ${humanizeStatus(finding.scope)}: ${finding.description}` }));
  }
  for (const report of packet.completionReports ?? []) {
    panel.append(element("div", { className: report.status === "passed" ? "approval-detail" : "feedback-error", text: `Final integration: ${report.status} · report ${report.reportSha256.slice(0, 12)}` }));
  }
  const refresh = element("button", { className: "feedback-btn changes", type: "button", text: "Refresh mission" });
  refresh.addEventListener("click", () => { void refreshMission(view); });
  panel.append(refresh);
  if (packet.criteria.some((criterion) => criterion.verificationCommand)) {
    const verify = element("button", { className: "feedback-btn approve", type: "button", text: "Run declared verification" });
    verify.addEventListener("click", () => {
      if (!app) return;
      verify.setAttribute("disabled", "true");
      void callServerToolChecked({ name: "run_mission_verification", arguments: { workSessionId: view.workSessionId, clientMutationId: newClientMutationId() } })
        .then(() => refreshMission(view))
        .catch((error) => { view.notice = { tone: "error", message: `Verification failed: ${error instanceof Error ? error.message : String(error)}` }; scheduleRender(); });
    });
    panel.append(verify);
  }
  if (view.activeSubmissionId && !packet.approval.allowed) panel.append(renderMissionCorrectionForm(view));
  return panel;
}

function renderMissionCorrectionForm(view: WorkSessionViewState): HTMLElement {
  const packet = view.mission!;
  const form = element("div", { className: "feedback-form" });
  const instructionsId = stableDomId(`mission-instructions-${view.workSessionId}`);
  const findingId = stableDomId(`mission-finding-${view.workSessionId}`);
  form.append(element("label", { className: "feedback-label", text: "Next bounded work order", htmlFor: instructionsId }));
  const instructions = document.createElement("textarea");
  instructions.className = "feedback-textarea";
  instructions.id = instructionsId;
  instructions.dataset.focusKey = `mission-instructions:${view.workSessionId}`;
  instructions.rows = 3;
  instructions.placeholder = "State the exact corrective work and required verification.";
  const finding = document.createElement("textarea");
  finding.className = "feedback-textarea";
  finding.id = findingId;
  finding.dataset.focusKey = `mission-finding:${view.workSessionId}`;
  finding.rows = 2;
  finding.placeholder = "Optional new blocking finding (recorded durably).";
  form.append(instructions, finding);
  const selectedCriteria = packet.criteria.filter((criterion) => criterion.priority === "required" && criterion.status !== "verified");
  if (selectedCriteria.length) form.append(element("div", { className: "approval-detail", text: `Targets: ${selectedCriteria.map((criterion) => criterion.description).join("; ")}` }));
  const submit = element("button", { className: "feedback-btn changes", type: "button", text: "Dispatch correction round" });
  submit.addEventListener("click", () => {
    const comments = instructions.value.trim();
    if (!comments || !app) return;
    submit.setAttribute("disabled", "true");
    void callServerToolChecked({
      name: "continue_supervised_work",
      arguments: {
        workSessionId: view.workSessionId,
        comments,
        findings: finding.value.trim() ? [{
          description: finding.value.trim(), requiredAction: comments, severity: "blocker", scope: "in_scope",
        }] : undefined,
        workOrder: {
          objectiveForThisTurn: comments,
          acceptanceCriterionIds: selectedCriteria.map((criterion) => criterion.id),
          requiredActions: [comments],
          requiredVerification: selectedCriteria.map((criterion) => criterion.verificationCommand).filter(Boolean),
        },
        clientMutationId: newClientMutationId(),
      },
    }).then((result) => {
      const content = getStructuredContent<{ packet?: MissionPacketView }>(result);
      if (content?.packet) view.mission = content.packet;
      view.notice = { tone: "success", message: "Correction round queued." };
      scheduleRender();
    }).catch((error) => {
      view.notice = { tone: "error", message: `Correction dispatch failed: ${error instanceof Error ? error.message : String(error)}` };
      scheduleRender();
    });
  });
  form.append(submit);
  return form;
}

function eventLabel(e: AgentActivityEvent): string {
  switch (e.type) {
    case "agent.run.started": return "run started";
    case "agent.run.output_delta": return String(e.payload?.text ?? "output").slice(-160);
    case "agent.run.thought_delta": return `thought: ${String(e.payload?.text ?? "").slice(-120)}`;
    case "agent.tool.started": return `→ ${String(e.payload?.tool ?? "tool")}`;
    case "agent.tool.completed": return `✓ ${String(e.payload?.tool ?? "tool")}${e.payload?.path ? " · " + e.payload.path : ""}`;
    case "agent.tool.failed": return `✗ ${String(e.payload?.tool ?? "tool")}${e.payload?.path ? " · " + e.payload.path : ""}`;
    case "agent.plan.updated": return "plan updated";
    case "worker.turn.completed": return "worker turn completed";
    case "worker.turn.completed_review_submitted": return "review barrier created";
    case "worker.attempt.exited": return "worker exited; review still open";
    case "review.submitted": return `submitted #${String(e.payload?.submissionNumber ?? "")}`;
    case "review.feedback.provided": return `feedback: ${String(e.payload?.verdict ?? "")}`;
    case "agent.run.approved": return "approved";
    case "agent.run.rejected": return "rejected";
    case "agent.run.failed": return "failed";
    case "agent.run.cancellation_requested": return "cancellation requested";
    case "agent.run.cancelled": return "cancelled";
    case "continuation.created": return "continuation queued";
    case "continuation.delivered": return "continuation delivered";
    case "agent.message.posted": {
      const kind = String(e.payload?.kind ?? "message");
      const title = e.payload?.title ? `: ${String(e.payload.title)}` : "";
      return `${kind.replace(/_/g, " ")}${title}`;
    }
    case "agent.message.resolved": return "message resolved";
    case "session.handoff": return `handed off → ${String(e.payload?.toAgent ?? "agent")}`;
    case "policy.approval_requested": return `approval needed: ${String(e.payload?.tool ?? "tool")}`;
    case "policy.approval.provided":
    case "approval.resolved":
      return "approval resolved";
    default: return e.type;
  }
}

// ── Event-driven watcher (replaces the 2.5s poll) ──

function workspaceEventTargetSessionId(event: AgentActivityEvent): string {
  const isApprovalEvent = event.type === "policy.approval_requested"
    || event.type === "approval.requested"
    || event.type === "policy.approval.provided"
    || event.type === "approval.resolved";
  const eventWorkSessionId = typeof event.payload?.workSessionId === "string"
    ? event.payload.workSessionId
    : undefined;
  // Direct approvals have no work-session authority. Keep them in the
  // workspace-scoped approval center (P0.4) even when another work session is
  // selected; fall back to the watcher's workspace since the event itself
  // only carries its own workspaceSessionId.
  if (eventWorkSessionId) return eventWorkSessionId;
  if (isApprovalEvent) return approvalCenterId(event.workspaceSessionId ?? activeWorkspaceId ?? "");
  return event.sessionId;
}

async function watchWorkspaceEvents(workspaceId: string, initialSeq: number, generation: number): Promise<void> {
  let cursor = initialSeq;
  // P1 #34: bounded exponential backoff with jitter. Resets after any
  // successful response so steady-state polling latency is unaffected.
  let retryDelayMs = 1_000;
  const MAX_RETRY_DELAY_MS = 30_000;
  while (app && workspaceWatcherGeneration === generation && activeWorkspaceId === workspaceId) {
    try {
      const result = await callServerToolChecked({
        name: "await_workspace_events",
        arguments: { workspaceId, afterSeq: cursor, timeoutMs: 55000 },
      });
      if (workspaceWatcherGeneration !== generation || activeWorkspaceId !== workspaceId) return;
      retryDelayMs = 1_000;
      const content = getStructuredContent<{
        events: AgentActivityEvent[];
        nextSeq: number;
      }>(result);
      if (!content) continue;
      for (const event of content.events) {
        const targetSessionId = workspaceEventTargetSessionId(event);
        if (!workSessionViews.has(targetSessionId)) {
          // Correlation is enough to create a lightweight view immediately;
          // reduce the triggering event before the full snapshot arrives.
          ensureWorkSessionView(targetSessionId, event.workspaceSessionId ?? workspaceId, "");
          reduceWorkSessionEvent(targetSessionId, event);
          // P0.3: a brand-new direct approval must surface immediately — the
          // lightweight view was just created for it.
          if (event.type === "policy.approval_requested" && targetSessionId === approvalCenterId(workspaceId)) {
            surfaceNewDirectApproval(workspaceId, String(event.payload?.approvalId ?? ""));
          }
          queueSessionRehydration();
          continue;
        }
        reduceWorkSessionEvent(targetSessionId, event);
        // P0.3: a new approval arrives (auto-switch), or the last one
        // resolves (restore the pre-approval surface).
        if (event.type === "policy.approval_requested" && targetSessionId === approvalCenterId(workspaceId)) {
          surfaceNewDirectApproval(workspaceId, String(event.payload?.approvalId ?? ""));
        } else if ((event.type === "policy.approval.provided" || event.type === "approval.resolved")
          && targetSessionId === approvalCenterId(workspaceId)) {
          maybeRestoreAfterApprovalResolved(workspaceId, String(event.payload?.approvalId ?? "") || undefined);
        }
      }
      cursor = Math.max(cursor, content.nextSeq);
      workspaceEventCursor = cursor;
      scheduleRender();
    } catch (error) {
      if (workspaceWatcherGeneration !== generation) return;
      const selected = selectedWorkSessionId ? workSessionViews.get(selectedWorkSessionId) : undefined;
      if (selected) {
        selected.notice = {
          tone: "warning",
          message: `Workspace activity connection interrupted: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      scheduleRender();
      // P1 #34: exponential backoff with jitter instead of a flat 1s retry.
      const jitter = Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs + jitter));
      retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, retryDelayMs * 2);
    }
  }
}

function reduceWorkSessionEvent(sessionId: string, event: AgentActivityEvent): void {
  const view = workSessionViews.get(sessionId);
  if (!view) return;
  // The server's snapshot+cursor handoff and reconnects are deliberately
  // idempotent. Never duplicate an already-applied durable event if a host
  // retries a tool call or returns an overlapping page.
  if (event.seq > 0 && event.seq <= view.lastSeq) return;
  view.lastSeq = Math.max(view.lastSeq, event.seq);

  // Heartbeats are connection health, not user activity. Keep the timestamp
  // available to the status surface without filling the primary timeline.
  if (event.type === "agent.run.heartbeat") {
    view.lastHeartbeatAt = event.createdAt;
    return;
  }
  view.updatedAt = event.createdAt;

  // Coalesce adjacent transcript fragments so a fast agent does not turn each
  // 250ms flush into a separate visible activity row.
  const previous = view.activity.at(-1);
  if (previous && previous.type === event.type && (event.type === "agent.run.output_delta" || event.type === "agent.run.thought_delta")) {
    previous.payload = {
      ...previous.payload,
      text: `${String(previous.payload?.text ?? "")}${String(event.payload?.text ?? "")}`.slice(-4000),
    };
    previous.createdAt = event.createdAt;
  } else {
    view.activity.push(event);
    if (view.activity.length > 200) view.activity.shift();
  }

  if (event.type === "review.submitted") {
    const submissionId = String(event.payload?.submissionId ?? "");
    view.status = "awaiting_review";
    void refreshMission(view);
    // Auto-fetch the full submission card from the agent's submit_for_review
    // invocation (which occurred in CRUSH's MCP connection, not this iframe).
    if (submissionId && app) {
      // Install an immediate placeholder so a newer review cannot be hidden
      // behind a slow detail fetch. The async response below is still guarded
      // by the same (reviewEpoch, submissionNumber) authority tuple.
      noteSubmission(view, {
        submissionId,
        sessionId,
        submissionNumber: Number(event.payload?.submissionNumber ?? 0),
        reviewEpoch: typeof event.payload?.reviewEpoch === "number" ? event.payload.reviewEpoch : undefined,
        status: "pending",
        files: [],
        patch: "",
        fileCount: 0,
        additions: Number(event.payload?.additions ?? 0),
        removals: Number(event.payload?.removals ?? 0),
        diffSha256: typeof event.payload?.diffSha256 === "string" ? event.payload.diffSha256 : undefined,
      });
      void callServerToolChecked({ name: "get_review_submission", arguments: { sessionId, submissionId } })
        .then((res) => {
          const sc = getStructuredContent<{
            submissionId: string;
            status: string;
            files: ReviewSubmissionView["files"];
            fileCount: number;
            patch: string;
            additions: number;
            removals: number;
            submissionNumber: number;
            diffSha256?: string;
            reviewEpoch?: number;
          } & { summary?: ReviewSubmissionView }>(res);
          if (!sc) return;
          const card = (res as { _meta?: { card?: { summary?: ReviewSubmissionView; files?: ReviewSubmissionView["files"]; payload?: { patch: string } } } })._meta?.card;
          const view2 = workSessionViews.get(sessionId);
          if (!view2) return;
          const fetchedSubmission: ReviewSubmissionView = {
            submissionId,
            sessionId,
            submissionNumber: Number(event.payload?.submissionNumber ?? sc.submissionNumber ?? 0),
            reviewEpoch: typeof card?.summary?.reviewEpoch === "number"
              ? card.summary.reviewEpoch
              : typeof sc.reviewEpoch === "number" ? sc.reviewEpoch : undefined,
            status: sc.status,
            files: sc.files ?? card?.files ?? [],
            patch: sc.patch ?? card?.payload?.patch ?? "",
            fileCount: Number(sc.fileCount ?? sc.files?.length ?? card?.files?.length ?? 0),
            additions: card?.summary?.additions ?? sc.additions ?? 0,
            removals: card?.summary?.removals ?? sc.removals ?? 0,
            message: card?.summary?.message,
            diffSha256: typeof card?.summary?.diffSha256 === "string"
              ? card.summary.diffSha256
              : typeof sc.diffSha256 === "string" ? sc.diffSha256 : undefined,
          };
          noteSubmission(view2, fetchedSubmission);
          render();
        })
        .catch((err) => {
          // P1 #11: surface the failure to load submission details rather than
          // silently leaving a blank card (which would mask a worker/transport
          // failure).
          const failedView = workSessionViews.get(sessionId);
          if (failedView) {
            failedView.notice = {
              tone: "error",
              message: "Failed to load submission details: " + (err instanceof Error ? err.message : String(err)),
            };
          } else {
            errorMessage = "Failed to load submission details: " + (err instanceof Error ? err.message : String(err));
          }
          render();
        });
    }
  } else if (event.type === "review.feedback.provided") {
    const sid = String(event.payload?.submissionId ?? view.activeSubmissionId ?? "");
    if (sid && view.submissions.has(sid)) view.feedbackStateBySubmission.set(sid, "submitted");
    const verdict = String(event.payload?.verdict ?? "");
    if (verdict === "changes_requested") view.status = "changes_requested";
    else if (verdict === "approve") view.status = "approved";
    else if (verdict === "reject") view.status = "rejected";
    view.feedbackMessage = "Feedback submitted. The waiting agent has been notified.";
  } else if (event.type === "continuation.created") {
    view.status = "continuation_queued";
  } else if (event.type === "continuation.delivered") {
    view.status = "resuming";
  } else if (event.type === "continuation.superseded") {
    view.status = "awaiting_resume";
  } else if (event.type === "worker.attempt.failed" || event.type === "worker.attempt.exited") {
    view.status = "awaiting_resume";
  } else if (event.type === "agent.run.failed_protocol") {
    view.status = "failed_protocol";
  } else if (event.type === "agent.run.approved") {
    view.status = "approved";
  } else if (event.type === "agent.run.rejected") {
    view.status = "rejected";
  } else if (event.type === "agent.run.cancellation_requested") {
    view.status = "cancelling";
  } else if (event.type === "agent.run.failed" || event.type === "agent.run.cancelled") {
    view.status = event.type === "agent.run.failed" ? "failed" : "cancelled";
  } else if (event.type === "policy.approval_requested" || event.type === "approval.requested") {
    const approvalId = String(event.payload?.approvalId ?? "");
    if (approvalId) {
      view.policyApprovals.set(approvalId, {
        approvalId,
        workspaceId: typeof event.payload?.workspaceId === "string" ? event.payload.workspaceId : undefined,
        workSessionId: typeof event.payload?.workSessionId === "string" ? event.payload.workSessionId : undefined,
        tool: String(event.payload?.tool ?? "tool"),
        path: typeof event.payload?.path === "string" ? event.payload.path : undefined,
        command: typeof event.payload?.command === "string" ? event.payload.command : undefined,
        approvalKey: typeof event.payload?.approvalKey === "string" ? event.payload.approvalKey : undefined,
        matchedPattern: typeof event.payload?.matchedPattern === "string" ? event.payload.matchedPattern : undefined,
        origin: event.payload?.origin === "work_session" ? "work_session" : "direct_mcp",
        conversationId: typeof event.payload?.conversationId === "string" ? event.payload.conversationId : undefined,
        requestedAt: typeof event.payload?.requestedAt === "string" ? event.payload.requestedAt : event.createdAt,
        expiresAt: typeof event.payload?.expiresAt === "string" ? event.payload.expiresAt : undefined,
        options: parsePolicyApprovalOptions(event.payload?.options),
      });
      view.pendingApprovalCount = view.policyApprovals.size;
    }
  } else if (event.type === "policy.approval.provided" || event.type === "approval.resolved") {
    const approvalId = String(event.payload?.approvalId ?? "");
    if (approvalId) {
      view.policyApprovals.delete(approvalId);
      view.pendingApprovalCount = view.policyApprovals.size;
    }
  } else if (event.type === "agent.message.posted") {
    const messageId = String(event.payload?.messageId ?? "");
    const kind = String(event.payload?.kind ?? "note");
    // Only gating kinds (questions/blockers) go into the open-messages tray;
    // findings/artifacts/notes remain in the activity feed as records.
    if (messageId && String(event.payload?.status ?? "") === "open" && (kind === "clarification_request" || kind === "blocker")) {
      view.openMessages.set(messageId, {
        messageId,
        kind,
        author: typeof event.payload?.author === "string" ? event.payload.author : undefined,
        title: typeof event.payload?.title === "string" ? event.payload.title : undefined,
        body: typeof event.payload?.body === "string" ? event.payload.body : undefined,
        status: "open",
        runId: typeof event.payload?.runId === "string" ? event.payload.runId : undefined,
        createdAt: typeof event.payload?.createdAt === "string" ? event.payload.createdAt : event.createdAt,
      });
      view.unresolvedMessageCount = view.openMessages.size;
    }
  } else if (event.type === "agent.message.resolved") {
    const messageId = String(event.payload?.messageId ?? "");
    if (messageId) {
      view.openMessages.delete(messageId);
      messageMutationOutcomeUnknown.delete(messageId);
      view.unresolvedMessageCount = view.openMessages.size;
    }
  } else if (event.type === "session.handoff") {
    // Run identity and durable state are unchanged; only the agent handling the
    // next resume differs, so we just surface a notice.
    const toAgent = String(event.payload?.toAgent ?? "");
    view.notice = { tone: "info", message: `Session handed off to ${toAgent || "another agent"}.` };
  }
}

// ── Agent submit bar ─────────────────────────────────

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

const legacyFeedbackState = new Map<string, { submitted: boolean; submitting: boolean; outcomeUnknown?: boolean; error?: string }>();

function legacyReviewKey(card: ToolResultCard): string {
  return String(card.summary?.submissionId ?? `${card.summary?.sessionId ?? "unknown"}:${card.tool}`);
}

function renderFeedbackFormForSession(sessionId: string, card: ToolResultCard): HTMLElement {
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
    const refresh = element("button", { className: "notice-action", type: "button", text: "Refresh review status", disabled: state.submitting || !uiMutationsAllowed() });
    refresh.addEventListener("click", () => { void reconcileLegacyFeedbackOutcome(sessionId, card); });
    container.append(element("div", { className: "feedback-error", text: "Feedback outcome is unknown after a connection interruption. Refresh before trying again." }), refresh);
  }

  const buttonRow = element("div", { className: "feedback-buttons" });

  const makeButton = (verdict: string, text: string, cls: string): HTMLButtonElement => {
    const btn = element("button", { className: `feedback-btn ${cls}`, type: "button", text });
    // P1 #11: disable verdict buttons while a submission is in flight so the
    // reviewer cannot double-submit or fire overlapping feedback calls.
    if (state.submitting || state.outcomeUnknown || !uiMutationsAllowed()) btn.disabled = true;
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

async function submitFeedbackForSession(sessionId: string, card: ToolResultCard, verdict: string, comments?: string): Promise<void> {
  if (!sessionId || !app) return;
  if (verdict === "changes_requested" && !comments?.trim()) {
    legacyFeedbackState.set(legacyReviewKey(card), { submitted: false, submitting: false, error: "Request Changes requires concrete instructions for the agent." });
    scheduleRender();
    return;
  }
  const key = legacyReviewKey(card);
  legacyFeedbackState.set(key, { submitted: false, submitting: true });
  scheduleRender();
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
        clientMutationId: newClientMutationId(),
      },
    });
    legacyFeedbackState.set(key, { submitted: true, submitting: false });
    scheduleRender();
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
    scheduleRender();
  }
}

async function reconcileLegacyFeedbackOutcome(sessionId: string, card: ToolResultCard): Promise<void> {
  const key = legacyReviewKey(card);
  const current = legacyFeedbackState.get(key) ?? { submitted: false, submitting: false, outcomeUnknown: true };
  legacyFeedbackState.set(key, { ...current, submitting: true });
  render();
  try {
    const view = ensureWorkSessionView(sessionId, activeWorkspaceId ?? "", "");
    await hydrateWorkSessionSnapshot(view);
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
  render();
}

function renderFeedbackSubmittedGlobal(): HTMLElement {
  return element("div", { className: "feedback-submitted", text: "Feedback submitted. The waiting agent has been notified." });
}

function renderApprovalCenterCard(card: ToolResultCard): void {
  const approvals = Array.isArray(card.summary?.approvals)
    ? card.summary.approvals as Array<Record<string, unknown>>
    : [];
  const inferredWorkspaceId = activeWorkspaceId
    ?? (typeof approvals[0]?.workspaceId === "string" ? approvals[0].workspaceId : undefined)
    ?? (typeof approvals[0]?.workspaceSessionId === "string" ? approvals[0].workspaceSessionId : undefined);
  if (!inferredWorkspaceId) {
    renderEmpty("Approval center requires a workspace context.", "error");
    return;
  }
  if (activeWorkspaceId !== inferredWorkspaceId) activateWorkspace(inferredWorkspaceId);
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
  selectedWorkSessionId = center.workSessionId;
  lastToolCard = null;
  scheduleRender();
}

// ── Work-session feedback form ────────────────────────

function renderFeedbackFormForSubmission(view: WorkSessionViewState, submission: ReviewSubmissionView): HTMLElement {
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
    const refresh = element("button", { className: "notice-action", type: "button", text: "Refresh session state", disabled: !uiMutationsAllowed() });
    refresh.addEventListener("click", () => { void reconcileFeedbackOutcome(view, submissionId); });
    container.append(refresh);
  }

  const buttonRow = element("div", { className: "feedback-buttons" });

  const makeButton = (verdict: string, text: string, cls: string): HTMLButtonElement => {
    const btn = element("button", { className: `feedback-btn ${cls}`, type: "button", text });
    // P1 #11: disable verdict buttons while a submission is in flight.
    if (isSubmitting || outcomeUnknown || !uiMutationsAllowed()) btn.disabled = true;
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

async function submitFeedbackForSubmission(view: WorkSessionViewState, submission: ReviewSubmissionView, verdict: string, comments?: string): Promise<void> {
  if (!app) return;
  const submissionId = submission.submissionId;
  if (verdict === "changes_requested" && !comments?.trim()) {
    view.feedbackStateBySubmission.set(submissionId, "error");
    view.feedbackErrorBySubmission.set(submissionId, "Request Changes requires concrete instructions for the agent.");
    render();
    return;
  }
  view.feedbackStateBySubmission.set(submissionId, "submitting");
  view.feedbackErrorBySubmission.delete(submissionId);
  render();
  try {
    if (verdict === "approve" && view.mission) {
      const result = await callServerToolChecked({
        name: "approve_supervised_work",
        arguments: { workSessionId: view.workSessionId, comments, clientMutationId: newClientMutationId() },
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
          clientMutationId: newClientMutationId(),
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
  render();
}

async function reconcileFeedbackOutcome(view: WorkSessionViewState, submissionId: string): Promise<void> {
  if (!app || !uiMutationsAllowed()) return;
  try {
    await hydrateWorkSessionSnapshot(view);
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
  render();
}

function renderFeedbackSubmitted(view: WorkSessionViewState): HTMLElement {
  return element("div", { className: "feedback-submitted", text: view.feedbackMessage ?? "Feedback submitted. The waiting agent has been notified." });
}

function renderPolicyApproval(view: WorkSessionViewState, approval: PolicyApprovalView): HTMLElement {
  const item = element("div", { className: "approval-card" });
  const title = element("div", { className: "approval-title", text: approval.title ?? approval.tool });
  const workspace = approval.workspaceId ?? activeWorkspaceId ?? view.workspaceSessionId;
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
    const needsConfirmation = option.scope === "workspace" && !workspaceApprovalConfirmations.has(confirmationKey);
    const btn = element("button", {
      className: `feedback-btn ${cls}${option.scope === "workspace" ? " broad-scope" : ""}`,
      type: "button",
      text: needsConfirmation ? `Confirm ${option.label}` : option.label,
      disabled: !uiMutationsAllowed() || approval.uiState === "submitting" || approval.uiState === "outcome_unknown",
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
      if (option.scope === "workspace" && !workspaceApprovalConfirmations.has(confirmationKey)) {
        workspaceApprovalConfirmations.add(confirmationKey);
        render();
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
    const refresh = element("button", { className: "notice-action", type: "button", text: "Refresh approval status", disabled: !uiMutationsAllowed() });
    refresh.addEventListener("click", () => { void reconcilePolicyApproval(view, approval.approvalId); });
    item.append(element("div", { className: "feedback-error", text: "Approval outcome is unknown after a connection interruption. Refresh the authoritative pending state before trying again." }), refresh);
  }
  if (approval.error) item.append(element("div", { className: "feedback-error", text: approval.error }));
  return item;
}

async function submitPolicyApproval(
  view: WorkSessionViewState,
  approvalId: string,
  decision: string,
): Promise<void> {
  if (!app) return;
  const approval = view.policyApprovals.get(approvalId);
  if (approval) {
    approval.uiState = "submitting";
    approval.error = undefined;
  }
  render();
  try {
    await callServerToolChecked({
      name: "provide_policy_approval",
      arguments: { approvalId, decision, clientMutationId: newClientMutationId() },
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
  render();
}

async function reconcilePolicyApproval(view: WorkSessionViewState, approvalId: string): Promise<void> {
  if (!app || !uiMutationsAllowed()) return;
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
  render();
}

function parsePolicyApprovalOptions(value: unknown): PolicyApprovalView["options"] {
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

function workspacePayloadText(card: ToolResultCard): string {
  const agentsFiles = card.agentsFiles ?? [];
  const availableAgentsFiles = card.availableAgentsFiles ?? [];
  const skills = card.skills ?? [];
  const lines = [
    card.workspaceId ? `Workspace: ${card.workspaceId}` : undefined,
    card.root ? `Root: ${card.root}` : undefined,
    skills.length > 0
      ? `Skills: ${skills.map((skill) => skill.name ?? skill.path ?? "unnamed").join(", ")}`
      : "Skills: none",
    availableAgentsFiles.length > 0
      ? `Nested instructions: ${availableAgentsFiles.map((file) => file.path ?? "unknown").join(", ")}`
      : undefined,
    agentsFiles.length > 0
      ? `\n${formatAgentsFilesForPayload(agentsFiles)}`
      : "\nAGENTS.md: none loaded",
  ].filter((line): line is string => typeof line === "string");
  return lines.join("\n");
}

function formatAgentsFilesForPayload(
  agentsFiles: NonNullable<ToolResultCard["agentsFiles"]>,
): string {
  return agentsFiles
    .map((file) => {
      const path = file.path ?? "AGENTS.md";
      const content = file.content?.trim();
      return content ? `${path}\n\n${content}` : `${path}\n\nNo content loaded.`;
    })
    .join("\n\n");
}

function getPatchToolDisplay(card: ToolResultCard, label: string): ToolDisplay {
  const display = getPatchDisplayParts(card);
  return {
    icon: patchIcon(display.iconOperation),
    title: display.title,
    label,
    tone: display.tone,
  };
}

function patchIcon(operation: PatchOperation | undefined): string {
  if (operation === "add") return filePlusIcon();
  if (operation === "delete") return fileIcon();
  if (operation === "move") return filesIcon();
  return editIcon();
}

function getToolDisplay(card: ToolResultCard): ToolDisplay {
  const label = getToolLabel(card);
  switch (card.tool) {
    case "open_workspace":
      return { icon: folderIcon(), title: "Workspace", label, tone: "workspace" };
    case "read":
      return { icon: fileIcon(), title: "Read File", label, tone: "read" };
    case "write":
      return { icon: filePlusIcon(), title: "Write File", label, tone: "write" };
    case "edit":
      return { icon: editIcon(), title: "Edit File", label, tone: "edit" };
    case "apply_patch":
      return getPatchToolDisplay(card, label);
    case "grep":
      return { icon: searchIcon(), title: "Grep", label, tone: "search" };
    case "glob":
      return { icon: filesIcon(), title: "Glob", label, tone: "search" };
    case "ls":
      return { icon: listIcon(), title: "List Directory", label, tone: "directory" };
    case "bash":
      return { icon: terminalIcon(), title: "Bash", label, tone: "shell" };
    case "exec_command":
      return { icon: terminalIcon(), title: "Exec Command", label, tone: "shell" };
    case "write_stdin":
      return { icon: terminalIcon(), title: "Process Session", label, tone: "shell" };
    case "show_changes":
      return { icon: reviewIcon(), title: "Show Changes", label, tone: "review" };
    case "submit_for_review":
      return { icon: reviewIcon(), title: "Review Submission", label, tone: "review" };
    case "submit_to_coding_agent":
      return { icon: agentIcon(), title: "Coding Agent", label, tone: "agent" };
    case "open_approval_center":
      return { icon: reviewIcon(), title: "Approval Center", label, tone: "agent" };
  }
}

function getToolLabel(card: ToolResultCard): string {
  if (isShellTool(card.tool)) {
    return String(card.summary?.command ?? card.summary?.sessionId ?? card.path ?? card.tool);
  }
  if (isReviewTool(card.tool)) {
    const count = Number(card.summary?.files ?? card.files?.length ?? 0);
    return count === 0 ? "No changes since last review" : `${count} changed ${count === 1 ? "file" : "files"}`;
  }
  if (card.path) return card.path;
  if (card.root) return card.root;
  if (isSearchTool(card.tool)) {
    return String(card.summary?.pattern ?? card.tool);
  }
  return card.tool;
}

function toolNameFromMeta(result: CallToolResult): ToolName | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const tool = meta?.tool;
  return isToolName(tool) ? tool : undefined;
}

type ServerToolRequest = Parameters<App["callServerTool"]>[0];

export class AmbiguousMutationError extends Error {
  readonly operation: string;

  constructor(operation: string, cause?: unknown) {
    super(`The ${operation} mutation may have committed, but its response was lost. Refresh authoritative state before retrying.`);
    this.name = "AmbiguousMutationError";
    this.operation = operation;
    if (cause !== undefined) this.cause = cause;
  }
}

type ServerToolRetryMode = "safe" | "reconcile" | "never";
interface ServerToolCallOptions { retry?: ServerToolRetryMode }

const SAFE_RETRY_TOOLS = new Set([
  "get_workspace_session_surface",
  "list_pending_approvals",
  "get_work_session_snapshot",
  "get_review_submission",
  "inspect_supervised_work",
  "await_workspace_events",
]);

const RECONCILE_ONLY_TOOLS = new Set([
  "resolve_agent_message",
  "redrive_supervisor_run",
  "run_mission_verification",
  "continue_supervised_work",
  "submit_to_coding_agent",
  "pause_supervisor_run",
  "resume_supervisor_run",
  "provide_review_feedback",
  "approve_supervised_work",
  "provide_policy_approval",
]);

const NEVER_RETRY_TOOLS = new Set([
  "cancel_work_session",
]);

function retryModeForServerTool(name: string, explicit?: ServerToolRetryMode): ServerToolRetryMode {
  if (explicit) return explicit;
  if (SAFE_RETRY_TOOLS.has(name)) return "safe";
  if (RECONCILE_ONLY_TOOLS.has(name)) return "reconcile";
  if (NEVER_RETRY_TOOLS.has(name)) return "never";
  return "never";
}

async function callServerToolChecked(request: ServerToolRequest, options: ServerToolCallOptions = {}): Promise<CallToolResult> {
  if (!app) throw new Error("The MCP host connection is unavailable.");
  let result: CallToolResult;
  try {
    result = await app.callServerTool(request);
  } catch (transportError) {
    // A transient host/tunnel failure should get one deterministic reconnect
    // and rehydration attempt before the caller sees a permanent error.
    const retryMode = retryModeForServerTool(String(request.name), options.retry);
    try {
      await reconnectApp(transportError);
    } catch (reconnectError) {
      if (retryMode !== "safe") throw new AmbiguousMutationError(String(request.name), reconnectError);
      throw reconnectError;
    }
    if (!app) {
      if (retryMode !== "safe") throw new AmbiguousMutationError(String(request.name), transportError);
      throw transportError;
    }
    if (retryMode !== "safe") {
      throw new AmbiguousMutationError(String(request.name), transportError);
    }
    result = await app.callServerTool(request);
  }
  if (!result.isError) return result;
  const message = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  throw new Error(message || "The server rejected the tool call.");
}

function cardFromMeta(result: CallToolResult): Partial<ToolResultCard> | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const metaCard = meta?.card;
  return metaCard && typeof metaCard === "object" ? metaCard : undefined;
}

function getStructuredContent<T>(result: CallToolResult): T | undefined {
  return result.structuredContent as T | undefined;
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return "<1s";
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    type?: string;
    title?: string;
    ariaHidden?: string;
    ariaExpanded?: string;
    ariaLabel?: string;
    ariaPressed?: string;
    ariaLive?: string;
    htmlFor?: string;
    dataFocusKey?: string;
    role?: string;
    hidden?: boolean;
    disabled?: boolean;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type !== undefined && "type" in node) node.setAttribute("type", options.type);
  if (options.title !== undefined) node.title = options.title;
  if (options.ariaHidden !== undefined) node.setAttribute("aria-hidden", options.ariaHidden);
  if (options.ariaExpanded !== undefined) node.setAttribute("aria-expanded", options.ariaExpanded);
  if (options.ariaLabel !== undefined) node.setAttribute("aria-label", options.ariaLabel);
  if (options.ariaPressed !== undefined) node.setAttribute("aria-pressed", options.ariaPressed);
  if (options.ariaLive !== undefined) node.setAttribute("aria-live", options.ariaLive);
  if (options.htmlFor !== undefined && "htmlFor" in node) (node as HTMLLabelElement).htmlFor = options.htmlFor;
  if (options.dataFocusKey !== undefined) node.dataset.focusKey = options.dataFocusKey;
  if (options.role !== undefined) node.setAttribute("role", options.role);
  if (options.hidden !== undefined) node.hidden = options.hidden;
  if (options.disabled !== undefined && "disabled" in node) {
    (node as HTMLButtonElement).disabled = options.disabled;
  }
  return node;
}

function stableDomId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
}

function iconSvg(children: string): string {
  return `<svg aria-hidden="true" class="icon-svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8">${children}</svg>`;
}

function folderIcon(): string {
  return iconSvg('<path d="M3 7.5h6l2 2h10" /><path d="M3 7.5v10A2.5 2.5 0 0 0 5.5 20h13a2.5 2.5 0 0 0 2.5-2.5v-8H3" />');
}
function fileIcon(): string {
  return iconSvg('<path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /><path d="M9 13h6" /><path d="M9 17h4" />');
}
function filePlusIcon(): string {
  return iconSvg('<path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /><path d="M12 12v6" /><path d="M9 15h6" />');
}
function editIcon(): string {
  return iconSvg('<path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" />');
}
function searchIcon(): string {
  return iconSvg('<circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" />');
}
function filesIcon(): string {
  return iconSvg('<path d="M8 7V4h9l4 4v10h-3" /><path d="M12 4v5h5" /><path d="M4 7h9l4 4v10H4z" /><path d="M13 7v5h4" />');
}
function checkCircleIcon(): string {
  return '<svg aria-hidden="true" class="badge-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="8" cy="8" r="6" /><path d="m5.5 8 1.7 1.7 3.4-3.5" /></svg>';
}
function listIcon(): string {
  return iconSvg('<path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" />');
}
function terminalIcon(): string {
  return iconSvg('<path d="m5 7 5 5-5 5" /><path d="M12 17h7" />');
}
function agentIcon(): string {
  return iconSvg('<circle cx="12" cy="8" r="3.2" /><path d="M5 20a7 7 0 0 1 14 0" />');
}
function reviewIcon(): string {
  return iconSvg('<path d="M5 4h14v16H5z" /><path d="M8 8h8" /><path d="M8 12h5" /><path d="M8 16h7" />');
}

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
