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
  options?: Array<{
    id: string;
    label: string;
    effect: "approve" | "deny" | "changes_requested";
    scope?: "once" | "work_session" | "workspace";
  }>;
  uiState?: "idle" | "submitting" | "resolved" | "error";
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

type FeedbackState = "idle" | "submitting" | "submitted" | "error";

interface WorkSessionViewState {
  workspaceSessionId: string;
  workSessionId: string;
  runId: string;
  title?: string;
  submittedBy?: string;
  status: string;
  updatedAt?: string;
  lifecycle?: string;
  runtimeState?: string;
  unresolvedMessageCount: number;
  pendingApprovalCount: number;
  lastSeq: number;
  lastHeartbeatAt?: string;
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
let hostContext: HostContext | undefined;

// Durable UI state.
let activeWorkspaceId: string | null = null;
const workSessionViews = new Map<string, WorkSessionViewState>();
const snapshotHydrations = new Map<string, Promise<void>>();
let selectedWorkSessionId: string | null = null;
let lastToolCard: ToolResultCard | null = null;
let rehydrationPromise: Promise<void> | null = null;
let rehydrationRequested = false;

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

if (!uiTestMode) void boot();

async function boot(): Promise<void> {
  render();

  app = new App(
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
      const newWorkspaceId = structured.workspaceId;
      if (activeWorkspaceId !== newWorkspaceId) {
        workspaceWatcherGeneration += 1;
        workspaceEventCursor = 0;
      }
      activeWorkspaceId = newWorkspaceId;
      // P0 #3: When workspace becomes known, trigger rehydration.
      queueSessionRehydration();
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
          activeWorkspaceId = workspaceSessionId;
          workspaceWatcherGeneration += 1;
          workspaceEventCursor = 0;
          queueSessionRehydration();
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
    workspaceWatcherGeneration += 1;
    unmountPayload();
    currentLegacyReviewDom = null;
    currentWorkSessionDom = null;
    agentBar = null;
    app = null;
    return {};
  };

  try {
    await app.connect();
    const initialContext = app.getHostContext();
    if (initialContext) hostContext = initialContext;
    applyHostContext();
    connected = true;
    // Rehydrate any sessions that were already live before this WebUI (re)loaded.
    // Without this, sessions only appear reactively when a fresh tool card
    // arrives — so a reload silently drops in-flight and awaiting-review work.
    queueSessionRehydration();
  } catch (connectError) {
    connectionError = connectError instanceof Error
      ? connectError.message
      : String(connectError);
  }

  render();
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
      view.lifecycle = s.lifecycle;
      view.runtimeState = s.runtimeState;
      view.unresolvedMessageCount = s.unresolvedMessageCount;
      view.pendingApprovalCount = s.pendingApprovalCount;
      view.lastSeq = s.lastSeq;
      view.latestFeedback = s.latestFeedback;
      if (s.latestSubmission) {
        view.activeSubmissionId = s.latestSubmission.submissionId;
        view.submissions.set(s.latestSubmission.submissionId, {
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
    // If nothing is selected yet, surface the most recently updated session.
    // If the previous selection disappeared, choose the newest remaining one.
    if (sessions.length && (!selectedWorkSessionId || !workSessionViews.has(selectedWorkSessionId))) {
      selectedWorkSessionId = sessions[0].sessionId;
    }

    // Pending tool approvals are durable, but direct client calls do not
    // belong to a work-session snapshot. Rehydrate them explicitly so a UI
    // reconnect cannot miss the live approval event and strand the caller.
    const directApprovals: PendingApprovalRecord[] = [];
    try {
      const approvalResult = await callServerToolChecked({
        name: "list_pending_approvals",
        arguments: { workspaceId },
      });
      if (!app || activeWorkspaceId !== workspaceId) return;
      const pending = getStructuredContent<{ approvals?: PendingApprovalRecord[] }>(approvalResult)?.approvals ?? [];
      for (const approval of pending) {
        const target = approval.workSessionId
          ? ensureWorkSessionView(approval.workSessionId, approval.workspaceSessionId ?? workspaceId, "")
          : undefined;
        if (target) mergePendingApproval(target, approval, workspaceId);
        else directApprovals.push(approval);
      }
    } catch {
      // Approval visibility must not prevent the rest of the workspace from
      // rehydrating. The live watcher remains the fallback for new requests.
    }
    if (directApprovals.length > 0) {
      const selected = selectedWorkSessionId ? workSessionViews.get(selectedWorkSessionId) : undefined;
      const target = selected ?? ensureWorkSessionView("__approval_center__", workspaceId, "");
      for (const approval of directApprovals) mergePendingApproval(target, approval, workspaceId);
      if (!selected) selectedWorkSessionId = target.workSessionId;
    }
    const selected = selectedWorkSessionId ? workSessionViews.get(selectedWorkSessionId) : undefined;
    if (selected && selected.workSessionId !== "__approval_center__") await hydrateWorkSessionSnapshot(selected);
    if (!app || activeWorkspaceId !== workspaceId) return;
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
    while (rehydrationRequested && activeWorkspaceId && app) {
      rehydrationRequested = false;
      await rehydrateActiveSessions();
    }
  })().finally(() => {
    rehydrationPromise = null;
    if (rehydrationRequested) queueSessionRehydration();
  });
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
      lastSeq: number;
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
      }>;
      agentMessages?: Array<{ messageId: string; kind: string; author?: string; title?: string; body?: string; status?: string; runId?: string; createdAt?: string }>;
    }>(snapResult);
    if (!snap) return;

    const snapshotIsCurrent = snap.lastSeq >= hydrationStartSeq && snap.lastSeq >= view.lastSeq;
    if (snapshotIsCurrent) {
      view.status = snap.status;
      view.runId = snap.runId ?? view.runId;
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
        workSessionId: view.workSessionId,
      });
    }
    view.pendingApprovalCount = view.policyApprovals.size;
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
    if (snap.latestSubmission) {
      view.activeSubmissionId = snap.latestSubmission.submissionId;
      const existingSubmission = view.submissions.get(snap.latestSubmission.submissionId);
      view.submissions.set(snap.latestSubmission.submissionId, {
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

function renderNow(): void {

  if (connectionError) {
    renderEmpty(connectionError, "error");
    return;
  }
  if (!connected) {
    renderEmpty("Connecting to host...");
    return;
  }

  const view = selectedWorkSessionId ? workSessionViews.get(selectedWorkSessionId) : undefined;
  if (view) {
    renderWorkSessionView(view);
    return;
  }

  if (!lastToolCard) {
    renderEmpty(errorMessage ?? "Waiting for a tool result.", errorMessage ? "error" : "muted");
    return;
  }

  const card = lastToolCard;
  ensureSurface(`tool:${card.tool}`);
  const display = getToolDisplay(card);
  if (card.tool === "open_approval_center") {
    renderApprovalCenterCard(card, display);
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

  dom.titleStatus.textContent = view.workSessionId === "__approval_center__"
    ? "Approval Center"
    : view.title ?? view.status;
  dom.statusBadge.textContent = view.status;
  dom.meta.replaceChildren();
  if (view.workspaceSessionId) dom.meta.append(element("span", { className: "agent-meta-row", text: `workspace: ${view.workspaceSessionId}` }));
  if (view.workSessionId) dom.meta.append(element("span", { className: "agent-meta-row", text: `session: ${view.workSessionId}` }));
  if (view.runId) dom.meta.append(element("span", { className: "agent-meta-row", text: `run: ${view.runId}` }));
  if (view.lifecycle) dom.meta.append(element("span", { className: "agent-meta-row", text: `lifecycle: ${view.lifecycle}` }));
  if (view.lastHeartbeatAt) {
    const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(view.lastHeartbeatAt)) / 1000));
    dom.meta.append(element("span", { className: "agent-meta-row heartbeat-status", text: `● Agent connected · ${ageSeconds}s ago` }));
  }

  renderSessionSwitcher(dom.sessionSwitcher);
  renderSessionNotice(dom.notice, view);
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
  const sessions = [...workSessionViews.values()]
    .filter((view) => view.workSessionId !== "__approval_center__")
    .sort((a, b) => {
      const at = Date.parse(a.updatedAt ?? "") || 0;
      const bt = Date.parse(b.updatedAt ?? "") || 0;
      return bt - at || b.lastSeq - a.lastSeq;
    });
  if (sessions.length < 2) return;
  for (const view of sessions) {
    const label = view.title ?? view.status;
    const category = sessionCategory(view);
    const updatedAt = view.updatedAt ? relativeSessionAge(view.updatedAt) : "";
    const button = element("button", {
      className: `session-switcher-item${view.workSessionId === selectedWorkSessionId ? " selected" : ""}`,
      type: "button",
      text: `${category} · ${label} · ${view.submittedBy ?? "agent"}${updatedAt ? ` · ${updatedAt}` : ""}`,
      ariaPressed: String(view.workSessionId === selectedWorkSessionId),
      title: `${view.workSessionId}${view.submittedBy ? ` · ${view.submittedBy}` : ""}`,
    });
    button.addEventListener("click", () => selectWorkSession(view.workSessionId));
    container.append(button);
  }
}

function sessionCategory(view: WorkSessionViewState): string {
  if (view.openMessages.size > 0 || view.unresolvedMessageCount > 0 || view.policyApprovals.size > 0 || view.pendingApprovalCount > 0) {
    return "Needs input";
  }
  if (["awaiting_review", "review_in_progress", "changes_requested"].includes(view.status)) {
    return "Needs review";
  }
  if (["stale", "archived"].includes(view.runtimeState ?? "") || ["approved", "rejected", "cancelled", "failed", "failed_protocol"].includes(view.status)) {
    return "Historical";
  }
  return "Running";
}

function relativeSessionAge(value: string): string {
  const ageMs = Math.max(0, Date.now() - Date.parse(value));
  if (!Number.isFinite(ageMs)) return "";
  if (ageMs < 60_000) return `${Math.max(1, Math.round(ageMs / 1000))}s ago`;
  if (ageMs < 60 * 60_000) return `${Math.round(ageMs / 60_000)}m ago`;
  return `${Math.round(ageMs / (60 * 60_000))}h ago`;
}

function selectWorkSession(workSessionId: string): void {
  if (!workSessionViews.has(workSessionId)) return;
  selectedWorkSessionId = workSessionId;
  const view = workSessionViews.get(workSessionId)!;
  void hydrateWorkSessionSnapshot(view)
    .then(() => scheduleRender())
    .catch((error) => {
      view.notice = { tone: "warning", message: `Session details could not be loaded: ${error instanceof Error ? error.message : String(error)}` };
      scheduleRender();
    });
  scheduleRender();
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
    .map((message) => `${message.messageId}:${message.status}:${message.title ?? ""}:${message.body ?? ""}`)
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
    reply.rows = 2;
    reply.placeholder = "Reply to the agent…";
    const resolve = element("button", { className: "feedback-btn approve", type: "button", text: "Reply / Resolve" });
    resolve.addEventListener("click", () => {
      if (!app) return;
      resolve.disabled = true;
      void callServerToolChecked({
        name: "resolve_agent_message",
        arguments: { sessionId: view.workSessionId, messageId: message.messageId, reply: reply.value.trim() || undefined },
      }).then(() => {
        view.openMessages.delete(message.messageId);
        view.unresolvedMessageCount = view.openMessages.size;
        view.notice = { tone: "success", message: "Reply sent to the agent." };
        scheduleRender();
      }).catch((error) => {
        resolve.disabled = false;
        view.notice = { tone: "error", message: `Could not resolve agent request: ${error instanceof Error ? error.message : String(error)}` };
        scheduleRender();
      });
    });
    card.append(reply, resolve);
    container.append(card);
  }
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
    panel.append(element("div", { className: "approval-detail", text: `Supervisor: ${run.status} · cycle ${run.cycleNumber}/${run.maxCycles} · ${run.autonomyMode} · ${run.approvalMode}${run.repeatedFailureCount ? ` · repeated failure ${run.repeatedFailureCount}` : ""}` }));
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
      void callServerToolChecked({ name: run.status === "paused" ? "resume_supervisor_run" : "pause_supervisor_run", arguments: { workSessionId: view.workSessionId, expectedRevision: run.revision } })
        .then(() => refreshMission(view))
        .catch((error) => { view.notice = { tone: "error", message: `Supervisor control failed: ${error instanceof Error ? error.message : String(error)}` }; scheduleRender(); });
    });
    panel.append(control);
    if (run.status === "awaiting_human") {
      const redrive = element("button", { className: "feedback-btn changes", type: "button", text: "Redrive stalled supervisor action" });
      redrive.addEventListener("click", () => {
        if (!app) return;
        redrive.setAttribute("disabled", "true");
        void callServerToolChecked({ name: "redrive_supervisor_run", arguments: { workSessionId: view.workSessionId, expectedRevision: run.revision } })
          .then(() => refreshMission(view))
          .catch((error) => { view.notice = { tone: "error", message: `Supervisor redrive failed: ${error instanceof Error ? error.message : String(error)}` }; scheduleRender(); });
      });
      panel.append(redrive);
    }
  }
  const progress = packet.criteria.map((criterion) => `${criterion.status === "verified" ? "✓" : "○"} ${criterion.description} — ${criterion.status}${criterion.dependsOnCriterionIds?.length ? ` · depends on ${criterion.dependsOnCriterionIds.join(", ")}` : ""}`);
  for (const item of progress) panel.append(element("div", { className: "approval-detail", text: item }));
  const blockers = packet.approval.reasons;
  if (blockers.length) {
    panel.append(element("div", { className: "feedback-error", text: `Mission approval blocked: ${blockers.join("; ")}` }));
  } else {
    panel.append(element("div", { className: "feedback-submitted", text: "Mission evidence is complete and approval is available." }));
  }
  const openFindings = packet.findings.filter((finding) => !["verified_resolved", "waived"].includes(finding.status));
  for (const finding of openFindings) {
    panel.append(element("div", { className: "approval-detail", text: `${finding.severity} ${finding.scope}: ${finding.description}` }));
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
      void callServerToolChecked({ name: "run_mission_verification", arguments: { workSessionId: view.workSessionId } })
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
  form.append(element("label", { className: "feedback-label", text: "Next bounded work order" }));
  const instructions = document.createElement("textarea");
  instructions.className = "feedback-textarea";
  instructions.rows = 3;
  instructions.placeholder = "State the exact corrective work and required verification.";
  const finding = document.createElement("textarea");
  finding.className = "feedback-textarea";
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
        const isApprovalEvent = event.type === "policy.approval_requested"
          || event.type === "approval.requested"
          || event.type === "policy.approval.provided"
          || event.type === "approval.resolved";
        const eventWorkSessionId = typeof event.payload?.workSessionId === "string"
          ? event.payload.workSessionId
          : undefined;
        const targetSessionId = eventWorkSessionId
          ?? (isApprovalEvent && selectedWorkSessionId ? selectedWorkSessionId : event.sessionId);
        if (!workSessionViews.has(targetSessionId)) {
          // Correlation is enough to create a lightweight view immediately;
          // reduce the triggering event before the full snapshot arrives.
          ensureWorkSessionView(targetSessionId, event.workspaceSessionId ?? workspaceId, "");
          reduceWorkSessionEvent(targetSessionId, event);
          queueSessionRehydration();
          continue;
        }
        reduceWorkSessionEvent(targetSessionId, event);
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
  view.updatedAt = event.createdAt;

  // Heartbeats are connection health, not user activity. Keep the timestamp
  // available to the status surface without filling the primary timeline.
  if (event.type === "agent.run.heartbeat") {
    view.lastHeartbeatAt = event.createdAt;
    return;
  }

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
          view2.submissions.set(submissionId, {
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
          });
          view2.activeSubmissionId = submissionId;
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
          arguments: { task, workspaceSessionId: activeWorkspaceId },
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
          status.textContent = `Dispatch failed: ${err instanceof Error ? err.message : String(err)}`;
        })
        .finally(() => btn.removeAttribute("disabled"));
    });

    agentBar.append(input, btn, status);
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
  const feedbackKey = `${legacyKey}:${legacyState?.submitted ? "submitted" : "form"}:${legacyState?.submitting ? "submitting" : "idle"}:${legacyState?.error ?? ""}`;
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

const legacyFeedbackState = new Map<string, { submitted: boolean; submitting: boolean; error?: string }>();

function legacyReviewKey(card: ToolResultCard): string {
  return String(card.summary?.submissionId ?? `${card.summary?.sessionId ?? "unknown"}:${card.tool}`);
}

function renderFeedbackFormForSession(sessionId: string, card: ToolResultCard): HTMLElement {
  const container = element("div", { className: "feedback-form" });
  const label = element("label", { className: "feedback-label", text: "Review feedback" });
  const textarea = document.createElement("textarea");
  textarea.className = "feedback-textarea";
  textarea.placeholder = "Tell the agent what to fix, or leave blank for a clean approve/reject.";
  textarea.rows = 3;

  const state = legacyFeedbackState.get(legacyReviewKey(card)) ?? { submitted: false, submitting: false };
  if (state.error) {
    container.append(element("div", { className: "feedback-error", text: state.error }));
  }

  const buttonRow = element("div", { className: "feedback-buttons" });

  const makeButton = (verdict: string, text: string, cls: string): HTMLButtonElement => {
    const btn = element("button", { className: `feedback-btn ${cls}`, type: "button", text });
    // P1 #11: disable verdict buttons while a submission is in flight so the
    // reviewer cannot double-submit or fire overlapping feedback calls.
    if (state.submitting) btn.disabled = true;
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
      error: "Failed to submit feedback: " + (err instanceof Error ? err.message : String(err)),
    });
    scheduleRender();
  }
}

function renderFeedbackSubmittedGlobal(): HTMLElement {
  return element("div", { className: "feedback-submitted", text: "Feedback submitted. The waiting agent has been notified." });
}

function renderApprovalCenterCard(card: ToolResultCard, display: ToolDisplay): void {
  ensureSurface("approval-center");
  const main = element("main", { className: "shell" });
  const section = element("section", { className: "tool-card agent" });
  const header = element("div", { className: "review-header" });
  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.innerHTML = display.icon;
  const titleGroup = element("div", { className: "review-title-group" });
  titleGroup.append(
    element("span", { className: "tool-title", text: "Approval Center" }),
    element("span", { className: "tool-label", text: `${String(card.summary?.count ?? 0)} pending` }),
  );
  header.append(icon, titleGroup, renderSummaryBadge(card));
  section.append(header);

  const approvals = Array.isArray(card.summary?.approvals)
    ? card.summary.approvals as Array<Record<string, unknown>>
    : [];
  if (approvals.length === 0) {
    section.append(element("div", { className: "empty muted", text: "No pending approvals." }));
  } else {
    const list = element("div", { className: "approval-list" });
    const tempView = ensureWorkSessionView("__approval_center__", "", "");
    for (const approval of approvals) {
      list.append(renderPolicyApproval(tempView, {
        approvalId: String(approval.id ?? ""),
        workspaceId: typeof approval.workspaceId === "string" ? approval.workspaceId : undefined,
        workSessionId: typeof approval.workSessionId === "string" ? approval.workSessionId : undefined,
        tool: String(approval.tool ?? "tool"),
        path: typeof approval.path === "string" ? approval.path : undefined,
        command: typeof approval.command === "string" ? approval.command : undefined,
        options: parsePolicyApprovalOptions(approval.options),
      }));
    }
    section.append(list);
  }
  main.append(section);
  appRoot.replaceChildren(main);
}

// ── Work-session feedback form ────────────────────────

function renderFeedbackFormForSubmission(view: WorkSessionViewState, submission: ReviewSubmissionView): HTMLElement {
  const container = element("div", { className: "feedback-form" });
  const label = element("label", { className: "feedback-label", text: "Review feedback" });
  const textarea = document.createElement("textarea");
  textarea.className = "feedback-textarea";
  textarea.placeholder = "Tell the agent what to fix, or leave blank for a clean approve/reject.";
  textarea.rows = 3;

  const submissionId = submission.submissionId;
  const state = view.feedbackStateBySubmission.get(submissionId);
  const isSubmitting = state === "submitting";
  const isError = state === "error";

  if (isError && view.feedbackErrorBySubmission.get(submissionId)) {
    container.append(element("div", { className: "feedback-error", text: view.feedbackErrorBySubmission.get(submissionId) ?? "" }));
  }

  const buttonRow = element("div", { className: "feedback-buttons" });

  const makeButton = (verdict: string, text: string, cls: string): HTMLButtonElement => {
    const btn = element("button", { className: `feedback-btn ${cls}`, type: "button", text });
    // P1 #11: disable verdict buttons while a submission is in flight.
    if (isSubmitting) btn.disabled = true;
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
  view.feedbackStateBySubmission.set(submissionId, "submitting");
  view.feedbackErrorBySubmission.delete(submissionId);
  render();
  try {
    if (verdict === "approve" && view.mission) {
      const result = await callServerToolChecked({
        name: "approve_supervised_work",
        arguments: { workSessionId: view.workSessionId, comments },
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
        },
      });
    }
    view.feedbackStateBySubmission.set(submissionId, "submitted");
    view.feedbackMessage = "Feedback submitted. The waiting agent has been notified.";
  } catch (err) {
    // P1 #11: surface the transport / worker execution failure instead of
    // leaving the reviewer blind.
    view.feedbackStateBySubmission.set(submissionId, "error");
    view.feedbackErrorBySubmission.set(
      submissionId,
      "Failed to submit feedback: " + (err instanceof Error ? err.message : String(err)),
    );
  }
  render();
}

function renderFeedbackSubmitted(view: WorkSessionViewState): HTMLElement {
  return element("div", { className: "feedback-submitted", text: view.feedbackMessage ?? "Feedback submitted. The waiting agent has been notified." });
}

function renderPolicyApproval(view: WorkSessionViewState, approval: PolicyApprovalView): HTMLElement {
  const item = element("div", { className: "approval-card" });
  const title = element("div", { className: "approval-title", text: approval.title ?? approval.tool });
  const detail = element("div", {
    className: "approval-detail",
    text: approval.description ?? approval.command ?? approval.path ?? approval.matchedPattern ?? approval.approvalKey ?? approval.approvalId,
  });
  const buttons = element("div", { className: "feedback-buttons" });
  const options = approval.options?.length
    ? approval.options
    : [
      { id: "approve", label: "Approve Once", effect: "approve" as const, scope: "once" as const },
      { id: "approve_session", label: "Approve Session", effect: "approve" as const, scope: "work_session" as const },
      { id: "approve_workspace", label: "Approve Workspace", effect: "approve" as const, scope: "workspace" as const },
      { id: "deny", label: "Deny", effect: "deny" as const },
  ];
  const makeButton = (option: NonNullable<PolicyApprovalView["options"]>[number]): HTMLButtonElement => {
    const cls = option.effect === "deny" ? "reject" : option.effect === "changes_requested" ? "changes" : "approve";
    const btn = element("button", { className: `feedback-btn ${cls}`, type: "button", text: option.label });
    if (approval.uiState === "submitting") btn.setAttribute("disabled", "true");
    btn.addEventListener("click", () => {
      void submitPolicyApproval(view, approval.approvalId, option.id);
    });
    return btn;
  };
  buttons.append(...options.map(makeButton));
  item.append(title, detail, buttons);
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
      arguments: { approvalId, decision },
    });
    const latest = view.policyApprovals.get(approvalId);
    if (latest) latest.uiState = "resolved";
    view.policyApprovals.delete(approvalId);
  } catch (err) {
    const latest = view.policyApprovals.get(approvalId);
    if (latest) {
      latest.uiState = "error";
      latest.error = "Failed to submit approval: " + (err instanceof Error ? err.message : String(err));
    }
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

async function callServerToolChecked(request: ServerToolRequest): Promise<CallToolResult> {
  if (!app) throw new Error("The MCP host connection is unavailable.");
  const result = await app.callServerTool(request);
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
  if (options.role !== undefined) node.setAttribute("role", options.role);
  if (options.hidden !== undefined) node.hidden = options.hidden;
  if (options.disabled !== undefined && "disabled" in node) {
    (node as HTMLButtonElement).disabled = options.disabled;
  }
  return node;
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
};
