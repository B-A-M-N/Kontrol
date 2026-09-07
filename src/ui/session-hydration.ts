/**
 * Session hydration + durable-event watching: scoped rehydration of the
 * active workspace, snapshot hydration with de-dup, review-diff fetches,
 * mission refresh, authoritative approval reconciliation, and the single
 * await_workspace_events watcher loop. Extracted verbatim from
 * ui/workspace-app.tsx (P1.4); module-level mutable cells became explicit
 * host accessors so this module owns no hidden state beyond the
 * in-flight-hydration de-dup map it was given.
 */
import { approvalCenterId, isApprovalCenterId } from "./approval-center.js";
import {
  ensureWorkSessionView,
  mergePendingApproval,
  noteSubmission,
  workSessionViews,
} from "./session-views.js";
import type {
  AgentActivityEvent,
  MissionPacketView,
  PendingApprovalRecord,
  PolicyApprovalView,
  ReviewSubmissionView,
  WorkspaceSurfaceSession,
  WorkSessionViewState,
} from "./session-view-types.js";
import {
  reduceWorkSessionEvent,
  workspaceEventTargetSessionId,
} from "./workspace-event-reducer.js";
import { callServerToolChecked, getStructuredContent } from "./server-tool-call.js";

import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface HydrationHost {
  getApp(): App | null;
  scheduleRender(): void;
  getActiveWorkspaceId(): string | null;
  getSelectedWorkSessionId(): string | null;
  setSelectedWorkSessionId(v: string | null): void;
  workspaceWatcherGeneration(): number;
  bumpWorkspaceWatcherGeneration(): void;
  workspaceEventCursor(): number;
  setWorkspaceEventCursor(v: number): void;
  rehydrationRequested(): boolean;
  setRehydrationRequested(v: boolean): void;
  rehydrationPromise(): Promise<void> | null;
  setRehydrationPromise(v: Promise<void> | null): void;
  lastSuccessfulHydrationAt(): string | null;
  setLastSuccessfulHydrationAt(v: string | null): void;
  historicalPendingReviewsLoaded(): boolean;
  setHistoricalPendingReviewsLoaded(v: boolean): void;
  approvalRecoveryState(): "healthy" | "degraded" | "forbidden" | "disconnected";
  setApprovalRecoveryState(v: "healthy" | "degraded" | "forbidden" | "disconnected"): void;
  approvalAttentionDelivered: Set<string>;
  setErrorMessage(v: string | null): void;
  render(): void;
  connected(): boolean;
  noteHydrationFailure(message: string): void;
  messageMutationOutcomeUnknown: Set<string>;
  surfaceNewDirectApproval(workspaceId: string, approvalId: string): void;
  maybeRestoreAfterApprovalResolved(workspaceId: string, approvalId?: string): void;
  uiMutationsAllowed(): boolean;
}

const unsetHost: HydrationHost = new Proxy({} as HydrationHost, {
  get(_target, prop) {
    if (prop === "approvalAttentionDelivered" || prop === "messageMutationOutcomeUnknown") return new Set();
    return () => undefined;
  },
});

let host: HydrationHost = unsetHost;
export function setHydrationHost(next: HydrationHost): void {
  host = next;
}

const snapshotHydrations = new Map<string, Promise<void>>();

export async function rehydrateActiveSessions(): Promise<void> {
  if (!host.getApp()) return;
  // P0 #2: scoped rehydration. Only rehydrate sessions within the current
  // workspace. Never globally auto-rehydrate before the workspace is known.
  // P0 #1: use server-side snapshot + resume from lastSeq instead of replaying
  // the entire event log from seq 0.
  const workspaceId = host.getActiveWorkspaceId();
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
    if (!host.getApp() || host.getActiveWorkspaceId() !== workspaceId) return;
    const sessions = [...pagedSessions.values()].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
    host.setWorkspaceEventCursor(Math.max(host.workspaceEventCursor(), surfaceLastSeq));

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
    const currentSelection = host.getSelectedWorkSessionId();
    if (sessions.length
      && (!currentSelection
        || !recoveredSessionIds.has(currentSelection)
        || workSessionViews.get(currentSelection)?.workspaceSessionId !== workspaceId
        || isApprovalCenterId(currentSelection))) {
      host.setSelectedWorkSessionId(sessions[0].sessionId);
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
      if (!host.getApp() || host.getActiveWorkspaceId() !== workspaceId) return;
      host.setApprovalRecoveryState("healthy");
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
      host.setApprovalRecoveryState(/forbidden|reviewer authority|requires reviewer/i.test(message)
        ? "forbidden"
        : host.connected()
          ? "degraded"
          : "disconnected");
    }
    if (directApprovals.length > 0) {
      const target = ensureWorkSessionView(approvalCenterId(workspaceId), workspaceId, "");
      for (const approval of directApprovals) mergePendingApproval(target, approval, workspaceId);
    }
    const selectionNow = host.getSelectedWorkSessionId();
    const selected = selectionNow ? workSessionViews.get(selectionNow) : undefined;
    if (selected && !isApprovalCenterId(selected.workSessionId)) await hydrateWorkSessionSnapshot(selected);
    if (!host.getApp() || host.getActiveWorkspaceId() !== workspaceId) return;
    host.setLastSuccessfulHydrationAt(new Date().toISOString());
    host.bumpWorkspaceWatcherGeneration();
    void watchWorkspaceEvents(workspaceId, host.workspaceEventCursor(), host.workspaceWatcherGeneration());
    host.scheduleRender();
  } catch (error) {
    // A workspace switch or teardown can invalidate this run while one of the
    // recovery calls is in flight. Do not paint its error over the new app
    // context; the queued run for the current workspace owns that state.
    if (!host.getApp() || host.getActiveWorkspaceId() !== workspaceId) return;
    const selectionNow = host.getSelectedWorkSessionId();
    const selected = selectionNow ? workSessionViews.get(selectionNow) : undefined;
    if (selected) {
      selected.notice = {
        tone: "warning",
        message: `Session recovery is incomplete: ${error instanceof Error ? error.message : String(error)}`,
      };
    } else {
      host.setErrorMessage(`Session recovery is incomplete: ${error instanceof Error ? error.message : String(error)}`);
    }
    host.scheduleRender();
    throw error;
  }
}


export function queueSessionRehydration(): void {
  if (!host.getActiveWorkspaceId() || !host.getApp()) return;
  host.setRehydrationRequested(true);
  if (host.rehydrationPromise()) return;

  const localPromise = (async () => {
    // Coalesce boot, workspace-result, and event-triggered requests while
    // guaranteeing that only one snapshot/cursor handoff owns the watcher at
    // a time. If the workspace changes during a run, the next iteration uses
    // the new workspace instead of letting stale results win the race.
    let retryDelayMs = 1_000;
    while (host.rehydrationRequested() && host.getActiveWorkspaceId() && host.getApp()) {
      host.setRehydrationRequested(false);
      try {
        await rehydrateActiveSessions();
        retryDelayMs = 1_000;
      } catch (error) {
        if (!host.getApp() || !host.getActiveWorkspaceId()) return;
        host.setRehydrationRequested(true);
        host.noteHydrationFailure(error instanceof Error ? error.message : String(error));
        const jitter = Math.floor(Math.random() * Math.min(500, retryDelayMs / 2));
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs + jitter));
        retryDelayMs = Math.min(30_000, retryDelayMs * 2);
      }
    }
  })().finally(() => {
    host.setRehydrationPromise(null);
    if (host.rehydrationRequested()) queueSessionRehydration();
  });
}


export function reconcileAuthoritativeApprovals(
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
        host.approvalAttentionDelivered.delete(approvalId);
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


export async function hydrateWorkSessionSnapshot(view: WorkSessionViewState): Promise<void> {
  if (!host.getApp()) return;
  const existing = snapshotHydrations.get(view.workSessionId);
  if (existing) return existing;

  const hydration = (async () => {
    const hydrationStartSeq = view.lastSeq;
    view.missionLoading = true;
    view.missionError = undefined;
    host.scheduleRender();
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
      if (!view.openMessages.has(messageId)) host.messageMutationOutcomeUnknown.delete(messageId);
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
    host.scheduleRender();
  })().catch((error) => {
    view.missionLoading = false;
    view.missionError = error instanceof Error ? error.message : String(error);
    host.scheduleRender();
    throw error;
  });
  snapshotHydrations.set(view.workSessionId, hydration);
  try {
    await hydration;
  } finally {
    snapshotHydrations.delete(view.workSessionId);
  }
}


export async function fetchReviewDiff(sessionId: string, submissionId: string): Promise<void> {
  if (!host.getApp()) return;
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
      coverage?: ReviewSubmissionView["coverage"];
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
              host.scheduleRender();
              void fetchReviewDiff(sessionId, submissionId);
            },
          },
        };
        host.scheduleRender();
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
        sub.coverage = content.coverage;
        host.render();
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
            host.scheduleRender();
            void fetchReviewDiff(sessionId, submissionId);
          },
        },
      };
      host.scheduleRender();
    }
  }
}


export async function refreshMission(view: WorkSessionViewState): Promise<void> {
  if (!host.getApp()) return;
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
      host.scheduleRender();
    } else {
      view.missionLoading = false;
      view.missionError = "No supervision packet was returned.";
      host.scheduleRender();
    }
  } catch (error) {
    view.missionLoading = false;
    view.missionError = error instanceof Error ? error.message : String(error);
    host.scheduleRender();
  }
}


export async function loadHistoricalPendingReviews(): Promise<void> {
  const workspaceId = host.getActiveWorkspaceId();
  if (!workspaceId || !host.uiMutationsAllowed()) return;
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
    host.setHistoricalPendingReviewsLoaded(true);
    host.setLastSuccessfulHydrationAt(new Date().toISOString());
  } catch (error) {
    host.setErrorMessage(`Older reviews could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
  }
  host.scheduleRender();
}


export async function watchWorkspaceEvents(workspaceId: string, initialSeq: number, generation: number): Promise<void> {
  let cursor = initialSeq;
  // P1 #34: bounded exponential backoff with jitter. Resets after any
  // successful response so steady-state polling latency is unaffected.
  let retryDelayMs = 1_000;
  const MAX_RETRY_DELAY_MS = 30_000;
  while (host.getApp() && host.workspaceWatcherGeneration() === generation && host.getActiveWorkspaceId() === workspaceId) {
    try {
      const result = await callServerToolChecked({
        name: "await_workspace_events",
        arguments: { workspaceId, afterSeq: cursor, timeoutMs: 55000 },
      });
      if (host.workspaceWatcherGeneration() !== generation || host.getActiveWorkspaceId() !== workspaceId) return;
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
            host.surfaceNewDirectApproval(workspaceId, String(event.payload?.approvalId ?? ""));
          }
          queueSessionRehydration();
          continue;
        }
        reduceWorkSessionEvent(targetSessionId, event);
        // P0.3: a new approval arrives (auto-switch), or the last one
        // resolves (restore the pre-approval surface).
        if (event.type === "policy.approval_requested" && targetSessionId === approvalCenterId(workspaceId)) {
          host.surfaceNewDirectApproval(workspaceId, String(event.payload?.approvalId ?? ""));
        } else if ((event.type === "policy.approval.provided" || event.type === "approval.resolved")
          && targetSessionId === approvalCenterId(workspaceId)) {
          host.maybeRestoreAfterApprovalResolved(workspaceId, String(event.payload?.approvalId ?? "") || undefined);
        }
      }
      cursor = Math.max(cursor, content.nextSeq);
      host.setWorkspaceEventCursor(cursor);
      host.scheduleRender();
    } catch (error) {
      if (host.workspaceWatcherGeneration() !== generation) return;
      const selectionNow = host.getSelectedWorkSessionId();
    const selected = selectionNow ? workSessionViews.get(selectionNow) : undefined;
      if (selected) {
        selected.notice = {
          tone: "warning",
          message: `Workspace activity connection interrupted: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      host.scheduleRender();
      // P1 #34: exponential backoff with jitter instead of a flat 1s retry.
      const jitter = Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs + jitter));
      retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, retryDelayMs * 2);
    }
  }
}

