/**
 * WorkSessionManager façade
 *
 * Extracted from work-sessions.ts (P1 god-object decomposition). The façade
 * wires the domain stores over ONE shared DatabaseHandle and preserves the
 * exact WorkSessionManager interface external consumers already use. The
 * review-transition transactions stay whole inside the review store; the
 * façade adds only cross-store orchestration (lease release on terminal
 * status, terminal callbacks).
 */
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import type {
  RuntimeReconciliationPage,
  ToolEvent,
  WorkSession,
  WorkSessionFeedback,
  WorkSessionStatus,
  WorkSessionSubmission,
  WorkspaceLease,
  WorkspaceLeaseResult,
  WorkspaceSessionSurfaceCursor,
  WorkspaceSessionSurfaceEntry,
  CompletionPolicy,
  SubmissionVerdict,
} from "./types.js";
import type { ReviewFile, WorkspaceSnapshotKind } from "../review-checkpoints.js";
import { createWorkSessionStore } from "./session-store.js";
import { createWorkspaceLeaseStore } from "./lease-store.js";
import { createReviewSubmissionStore } from "./review-store.js";
import { createWorkSessionToolEventStore } from "./tool-event-store.js";
import { createWorkSessionQueries } from "./queries.js";
import { reconcileRuntimeStates } from "./runtime-state.js";
import { workspaceSessions } from "../db/schema.js";
import { eq } from "drizzle-orm";

export interface WorkSessionManager {
  create(input: {
    workspaceSessionId: string;
    submittedBy: string;
    title?: string;
    completionPolicy?: CompletionPolicy;
  }): WorkSession;
  get(id: string): WorkSession | undefined;
  listByWorkspace(workspaceSessionId: string, limit?: number): WorkSession[];
  updateStatus(id: string, status: WorkSessionStatus): void;
  acquireWorkspaceLease(input: {
    canonicalRoot: string;
    workspaceSessionId: string;
    workSessionId: string;
    ownerInstanceId?: string;
    ttlMs?: number;
  }): WorkspaceLeaseResult;
  releaseWorkspaceLeasesForSession(workSessionId: string): number;
  renewWorkspaceLeaseForSession(workSessionId: string, ttlMs?: number, leaseNonce?: string): number;
  getWorkspaceLeaseForSession(workSessionId: string): WorkspaceLease | undefined;
  submitForReview(input: {
    workSessionId: string;
    diff?: string;
    diffSha256?: string;
    snapshotCommit?: string;
    snapshotKind?: WorkspaceSnapshotKind;
    snapshotRef?: string;
    message?: string;
    summaryJson?: string;
    files?: ReviewFile[];
  }): WorkSessionSubmission;
  submitFeedback(input: {
    workSessionId: string;
    submissionId: string;
    verdict: SubmissionVerdict;
    comments?: string;
    filesJson?: string;
    requiredActions?: string[];
    allowedNextActions?: string[];
    reviewerId?: string;
    completionReportSha256?: string;
  }): WorkSessionFeedback;
  logToolEvent(input: {
    workSessionId: string;
    workspaceSessionId: string;
    tool: string;
    inputJson: string;
    outputSummary?: string;
    path?: string;
    success: boolean;
    elapsedMs: number;
  }): ToolEvent;
  /** P2 #54: Compact recent summary (default 50). */
  getRecentToolEvents(workSessionId: string, limit?: number): ToolEvent[];
  /** P2 #54: Full history with pagination. */
  listToolEvents(workSessionId: string, afterId?: string, limit?: number): ToolEvent[];
  /** @deprecated Use getRecentToolEvents() or listToolEvents() */
  getToolEvents(workSessionId: string, limit?: number): ToolEvent[];
  getSubmissions(workSessionId: string): WorkSessionSubmission[];
  getLatestSubmission(workSessionId: string): WorkSessionSubmission | undefined;
  getLatestFeedback(workSessionId: string): WorkSessionFeedback | undefined;
  countFeedback(workSessionId: string): number;
  markFeedbackConsumed(workSessionId: string, feedbackId: string): void;
  getLatestFeedbackAfter(workSessionId: string, afterFeedbackId?: string): WorkSessionFeedback | undefined;
  listPendingReviews(workspaceSessionId?: string, limit?: number): WorkSession[];
  listActiveWorkSessions(workspaceSessionId?: string, limit?: number): WorkSession[];
  listLiveWorkSessions(workspaceSessionId?: string, limit?: number): WorkSession[];
  listRecoverableWorkSessions(workspaceSessionId?: string, limit?: number): WorkSession[];
  listStaleWorkSessions(workspaceSessionId?: string, limit?: number): WorkSession[];
  /** Reconcile one bounded page of runtime state. */
  reconcileRuntimeStates(afterSessionId?: string, limit?: number): RuntimeReconciliationPage;
  countActiveWorkSessions(): number;
  countPendingReviews(): number;
  /** P1 #23: List all work sessions (including terminal) for maintenance. */
  listAllWorkSessions(workspaceSessionId?: string, limit?: number): WorkSession[];
  /** Compact projection variants used by bridge discovery without N+1 enrichment. */
  getWorkspaceSessionSurface(
    workspaceSessionId?: string,
    limit?: number,
    filter?: "all" | "pending_review" | "stale_pending_review" | "live",
    after?: WorkspaceSessionSurfaceCursor,
  ): WorkspaceSessionSurfaceEntry[];
  getWorkspaceEventCursor(workspaceSessionId?: string): number;
  /** P2 #10: Active-session projection with all needed fields in one query. */
  listActiveWorkSessionsProjection(workspaceSessionId?: string): Array<{
    sessionId: string;
    workspaceSessionId: string;
    status: string;
    title?: string;
    submittedBy: string;
    updatedAt: string;
    submissionCount: number;
  }>;
  /**
   * P1 #18: bounded cursor page of session IDs eligible for telemetry
   * compaction (terminal sessions, or parked/stale reviews). Returns only
   * IDs — no full projection hydration — so the five-minute maintenance
   * loop never sweeps unbounded sessions at once.
   */
  listSessionIdsNeedingCompaction(afterSessionId?: string, limit?: number): string[];
  close(): void;
}

export interface WorkSessionManagerOptions {
  onTerminal?: (workSessionId: string) => void;
}

export function createWorkSessionManager(
  stateDirOrHandle: string | DatabaseHandle,
  options: WorkSessionManagerOptions = {},
): WorkSessionManager {
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;
  const ownsDatabase = typeof stateDirOrHandle === "string";

  const leases = createWorkspaceLeaseStore(database);
  const sessions = createWorkSessionStore({
    db: database,
    releaseWorkspaceLeasesForSession: (workSessionId) => leases.releaseWorkspaceLeasesForSession(workSessionId),
    onTerminal: options.onTerminal,
  });
  const reviews = createReviewSubmissionStore(database, {
    releaseWorkspaceLeasesForSession: (workSessionId) => leases.releaseWorkspaceLeasesForSession(workSessionId),
  });
  const toolEvents = createWorkSessionToolEventStore(database);
  const queries = createWorkSessionQueries(database, {
    projectIdForWorkspace: (workspaceSessionId) => sessionsProjectId(database, workspaceSessionId),
    enrichSession: (row) => sessions.enrichSession(row),
  });

  return {
    create: (input) => sessions.create(input),
    get: (id) => sessions.get(id),
    listByWorkspace: (workspaceSessionId, limit) => sessions.listByWorkspace(workspaceSessionId, limit),
    updateStatus: (id, status) => sessions.updateStatus(id, status),
    acquireWorkspaceLease: (input) => leases.acquireWorkspaceLease(input),
    releaseWorkspaceLeasesForSession: (workSessionId) => leases.releaseWorkspaceLeasesForSession(workSessionId),
    renewWorkspaceLeaseForSession: (workSessionId, ttlMs, leaseNonce) =>
      leases.renewWorkspaceLeaseForSession(workSessionId, ttlMs, leaseNonce),
    getWorkspaceLeaseForSession: (workSessionId) => leases.getWorkspaceLeaseForSession(workSessionId),
    submitForReview: (input) => reviews.submitForReview(input),
    submitFeedback: (input) => reviews.submitFeedback(input),
    logToolEvent: (input) => toolEvents.logToolEvent(input),
    getRecentToolEvents: (workSessionId, limit) => toolEvents.getRecentToolEvents(workSessionId, limit),
    listToolEvents: (workSessionId, afterId, limit) => toolEvents.listToolEvents(workSessionId, afterId, limit),
    getToolEvents: (workSessionId, limit) => toolEvents.getToolEvents(workSessionId, limit),
    getSubmissions: (workSessionId) => reviews.getSubmissions(workSessionId),
    getLatestSubmission: (workSessionId) => reviews.getLatestSubmission(workSessionId),
    getLatestFeedback: (workSessionId) => reviews.getLatestFeedback(workSessionId),
    countFeedback: (workSessionId) => reviews.countFeedback(workSessionId),
    markFeedbackConsumed: (workSessionId, feedbackId) => reviews.markFeedbackConsumed(workSessionId, feedbackId),
    getLatestFeedbackAfter: (workSessionId, afterFeedbackId) => reviews.getLatestFeedbackAfter(workSessionId, afterFeedbackId),
    listPendingReviews: (workspaceSessionId, limit) => queries.listPendingReviews(workspaceSessionId, limit),
    listActiveWorkSessions: (workspaceSessionId, limit) => queries.listActiveWorkSessions(workspaceSessionId, limit),
    listLiveWorkSessions: (workspaceSessionId, limit) => queries.listLiveWorkSessions(workspaceSessionId, limit),
    listRecoverableWorkSessions: (workspaceSessionId, limit) => queries.listRecoverableWorkSessions(workspaceSessionId, limit),
    listStaleWorkSessions: (workspaceSessionId, limit) => queries.listStaleWorkSessions(workspaceSessionId, limit),
    listAllWorkSessions: (workspaceSessionId, limit) => queries.listAllWorkSessions(workspaceSessionId, limit),
    reconcileRuntimeStates: (afterSessionId, limit) => reconcileRuntimeStates(database, afterSessionId, limit),
    countActiveWorkSessions: () => queries.countActiveWorkSessions(),
    countPendingReviews: () => queries.countPendingReviews(),
    getWorkspaceSessionSurface: (workspaceSessionId, limit, filter, after) =>
      queries.getWorkspaceSessionSurface(workspaceSessionId, limit, filter, after),
    getWorkspaceEventCursor: (workspaceSessionId) => queries.getWorkspaceEventCursor(workspaceSessionId),
    listActiveWorkSessionsProjection: (workspaceSessionId) => queries.listActiveWorkSessionsProjection(workspaceSessionId),
    listSessionIdsNeedingCompaction: (afterSessionId, limit) => queries.listSessionIdsNeedingCompaction(afterSessionId, limit),
    // P2 #56: Only close the DB handle if this manager opened it
    close(): void {
      if (ownsDatabase) {
        database.close();
      }
    },
  };
}

function sessionsProjectId(db: DatabaseHandle, workspaceSessionId: string): string | undefined {
  const row = db.db.select({ projectId: workspaceSessions.projectId })
    .from(workspaceSessions)
    .where(eq(workspaceSessions.id, workspaceSessionId))
    .get();
  return row?.projectId ?? undefined;
}
