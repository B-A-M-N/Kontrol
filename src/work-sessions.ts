import { createHash, randomUUID } from "node:crypto";
import { eq, and, desc, gte, inArray, or, sql } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workSessions,
  workspaceLeases,
  workSessionSubmissions,
  workSessionFeedback,
  workSessionToolEvents,
  acpRuns,
  workspaceSessions,
  type WorkSessionRow,
  type WorkspaceLeaseRow,
  type WorkSessionSubmissionRow,
  type WorkSessionFeedbackRow,
  type WorkSessionToolEventRow,
} from "./db/schema.js";

export type WorkSessionStatus =
  | "in_progress"
  | "cancelling"
  | "drafting"
  | "awaiting_review"
  | "in_review"
  | "review_in_progress"
  | "resuming"
  | "changes_requested"
  | "approved"
  | "rejected"
  | "stale"
  | "cancelled"
  | "failed"
  | "failed_protocol";

export type SubmissionVerdict = "approve" | "changes_requested" | "reject";
export type CompletionPolicy = "agent_completion" | "webui_approval_required";

export interface WorkSession {
  id: string;
  projectId?: string;
  workspaceSessionId: string;
  status: WorkSessionStatus;
  completionPolicy: CompletionPolicy;
  reviewEpoch: number;
  submittedBy: string;
  title?: string;
  lastConsumedFeedbackId?: string;
  createdAt: string;
  updatedAt: string;
  latestSubmission?: WorkSessionSubmission;
  latestFeedback?: WorkSessionFeedback;
  /** P1 #7: lifecycle classification for UI grouping. */
  lifecycle: WorkSessionLifecycle;
  runtimeState: WorkSessionRuntimeState;
}

/** Compact workspace-level projection used by the WebUI session picker. */
export interface WorkspaceSessionSurfaceEntry {
  sessionId: string;
  workspaceSessionId: string;
  status: string;
  lifecycle: WorkSessionLifecycle;
  runtimeState: WorkSessionRuntimeState;
  title?: string;
  submittedBy: string;
  updatedAt: string;
  runId?: string;
  hasMission: boolean;
  missionStatus?: string;
  missionCycleNumber?: number;
  missionMaxCycles?: number;
  lastSeq: number;
  submissionCount: number;
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
  latestFeedback?: {
    id: string;
    submissionId?: string;
    verdict: string;
    comments?: string;
    reviewerId?: string;
  };
}

/** P1 #7: lifecycle classification distinguishing live work from stale/orphaned sessions. */
export type WorkSessionLifecycle =
  | "active_worker"      // worker is actively running (has live run + recent heartbeat)
  | "awaiting_review"    // submitted, waiting for reviewer
  | "resumable"         // changes_requested, worker can resume
  | "detached"          // worker exited but session is still open
  | "stale"             // in_progress but no living run/heartbeat for >1h
  | "archived"          // terminal (approved/rejected/cancelled/failed)
  | "pending";          // in_progress but not yet classified

export type WorkSessionRuntimeState = "running" | "parked" | "detached" | "stale" | "orphaned" | "archived" | "pending";

export interface WorkSessionSubmission {
  id: string;
  workSessionId: string;
  submissionNumber: number;
  diff?: string;
  diffSha256?: string;
  /** Exact working-tree snapshot commit the diff was captured against. */
  snapshotCommit?: string;
  reviewEpoch: number;
  message?: string;
  summaryJson?: string;
  status: "pending" | "reviewed";
  createdAt: string;
  feedback?: WorkSessionFeedback;
  /** Aggregate diff stats from the review checkpoint. */
  additions?: number;
  removals?: number;
}

export interface WorkSessionFeedback {
  id: string;
  workSessionId: string;
  submissionId: string;
  verdict: SubmissionVerdict;
  comments?: string;
  filesJson?: string;
  requiredActionsJson?: string;
  allowedNextActionsJson?: string;
  reviewerId?: string;
  completionReportSha256?: string;
  createdAt: string;
}

export interface ToolEvent {
  id: string;
  workSessionId: string;
  workspaceSessionId?: string;
  tool: string;
  inputJson: string;
  outputSummary?: string;
  path?: string;
  success: boolean;
  elapsedMs: number;
  createdAt: string;
}

export interface WorkspaceLease {
  canonicalRoot: string;
  workspaceSessionId: string;
  workSessionId: string;
  leaseKind: "modify";
  ownerInstanceId: string;
  /** Per-acquisition fencing token. A valid owner with an old nonce is stale. */
  leaseNonce: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface WorkspaceSessionSurfaceCursor {
  updatedAt: string;
  sessionId: string;
}

export type WorkspaceLeaseResult =
  | { acquired: true; lease: WorkspaceLease }
  | { acquired: false; conflictingWorkSessionId: string; workspaceSessionId: string; expiresAt: string };

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
    message?: string;
    summaryJson?: string;
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
  reconcileRuntimeStates(): { reconciled: number; markedStale: number };
  countActiveWorkSessions(): number;
  countPendingReviews(): number;
  /** P1 #23: List all work sessions (including terminal) for maintenance. */
  listAllWorkSessions(workspaceSessionId?: string, limit?: number): WorkSession[];
  /** Compact projection variants used by bridge discovery without N+1 enrichment. */
  getWorkspaceSessionSurface(
    workspaceSessionId?: string,
    limit?: number,
    filter?: "all" | "pending_review" | "live",
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

export function createWorkSessionManager(
  stateDirOrHandle: string | DatabaseHandle,
): WorkSessionManager {
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;
  return new SqliteWorkSessionManager(database, typeof stateDirOrHandle === "string");
}

class SqliteWorkSessionManager implements WorkSessionManager {
  private readonly database: DatabaseHandle;
  private readonly ownsDatabase: boolean;

  constructor(database: DatabaseHandle, ownsDatabase: boolean) {
    this.database = database;
    this.ownsDatabase = ownsDatabase;
  }

  create(input: { workspaceSessionId: string; submittedBy: string; title?: string; completionPolicy?: CompletionPolicy }): WorkSession {
    const now = new Date().toISOString();
    const projectId = this.projectIdForWorkspace(input.workspaceSessionId);
    const session: WorkSession = {
      id: `wsess_${randomUUID()}`,
      projectId,
      workspaceSessionId: input.workspaceSessionId,
      status: "in_progress",
      completionPolicy: input.completionPolicy ?? "agent_completion",
      reviewEpoch: 0,
      submittedBy: input.submittedBy,
      title: input.title,
      createdAt: now,
      updatedAt: now,
      lifecycle: "pending",
      runtimeState: "pending",
    };

    this.database.db
      .insert(workSessions)
      .values({
        id: session.id,
        projectId: session.projectId ?? null,
        workspaceSessionId: session.workspaceSessionId,
        status: session.status,
        runtimeState: session.runtimeState,
        runtimeClassifiedAt: now,
        completionPolicy: session.completionPolicy,
        reviewEpoch: session.reviewEpoch,
        submittedBy: session.submittedBy,
        title: session.title ?? null,
        lastConsumedFeedbackId: null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })
      .run();

    return session;
  }

  get(id: string): WorkSession | undefined {
    const row = this.database.db.select().from(workSessions).where(eq(workSessions.id, id)).get();
    if (!row) return undefined;
    return this.enrichSession(row);
  }

  listByWorkspace(workspaceSessionId: string, limit = 10): WorkSession[] {
    const projectId = this.projectIdForWorkspace(workspaceSessionId);
    const rows = this.database.db
      .select()
      .from(workSessions)
      .where(projectId ? eq(workSessions.projectId, projectId) : eq(workSessions.workspaceSessionId, workspaceSessionId))
      .orderBy(desc(workSessions.updatedAt))
      .limit(limit)
      .all();
    return rows.map((row) => this.enrichSession(row));
  }

  updateStatus(id: string, status: WorkSessionStatus): void {
    const now = new Date().toISOString();
    const runtimeState = isTerminalStatus(status)
      ? "archived"
      : status === "awaiting_review" || status === "review_in_progress"
        ? "parked"
        : status === "changes_requested"
          ? "detached"
          : "pending";
    this.database.db
      .update(workSessions)
      .set({ status, runtimeState, runtimeClassifiedAt: now, updatedAt: now })
      .where(eq(workSessions.id, id))
      .run();
    if (isTerminalStatus(status)) {
      this.releaseWorkspaceLeasesForSession(id);
    }
  }

  acquireWorkspaceLease(input: {
    canonicalRoot: string;
    workspaceSessionId: string;
    workSessionId: string;
    ownerInstanceId?: string;
    ttlMs?: number;
  }): WorkspaceLeaseResult {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 60 * 60 * 1000)).toISOString();
    const ownerInstanceId = input.ownerInstanceId ?? process.pid.toString();

    return this.database.db.transaction(() => {
      this.database.db
        .delete(workspaceLeases)
        .where(sql`${workspaceLeases.expiresAt} < ${nowIso}`)
        .run();

      const existing = this.database.db
        .select()
        .from(workspaceLeases)
        .where(eq(workspaceLeases.canonicalRoot, input.canonicalRoot))
        .get();

      if (existing && existing.workSessionId !== input.workSessionId) {
        return {
          acquired: false as const,
          conflictingWorkSessionId: existing.workSessionId,
          workspaceSessionId: existing.workspaceSessionId,
          expiresAt: existing.expiresAt,
        };
      }

      if (existing) {
        const leaseNonce = randomUUID();
        this.database.db
          .update(workspaceLeases)
          .set({ heartbeatAt: nowIso, expiresAt, ownerInstanceId, leaseNonce })
          .where(eq(workspaceLeases.canonicalRoot, input.canonicalRoot))
          .run();
      } else {
        const leaseNonce = randomUUID();
        this.database.db
          .insert(workspaceLeases)
          .values({
            canonicalRoot: input.canonicalRoot,
            workspaceSessionId: input.workspaceSessionId,
            workSessionId: input.workSessionId,
            leaseKind: "modify",
            ownerInstanceId,
            leaseNonce,
            acquiredAt: nowIso,
            heartbeatAt: nowIso,
            expiresAt,
          })
          .run();
      }

      const lease = this.database.db
        .select()
        .from(workspaceLeases)
        .where(eq(workspaceLeases.canonicalRoot, input.canonicalRoot))
        .get();
      if (!lease) throw new Error("Workspace lease acquisition failed");
      return { acquired: true as const, lease: rowToWorkspaceLease(lease) };
    });
  }

  releaseWorkspaceLeasesForSession(workSessionId: string): number {
    const result = this.database.sqlite
      .prepare("delete from workspace_leases where work_session_id = ?")
      .run(workSessionId);
    return result.changes;
  }

  renewWorkspaceLeaseForSession(workSessionId: string, ttlMs?: number, leaseNonce?: string): number {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + (ttlMs ?? 60 * 60 * 1000)).toISOString();
    const result = this.database.db
      .update(workspaceLeases)
      .set({ heartbeatAt: nowIso, expiresAt })
      .where(and(
        eq(workspaceLeases.workSessionId, workSessionId),
        gte(workspaceLeases.expiresAt, nowIso),
        ...(leaseNonce ? [eq(workspaceLeases.leaseNonce, leaseNonce)] : []),
      ))
      .run();
    return result.changes;
  }

  getWorkspaceLeaseForSession(workSessionId: string): WorkspaceLease | undefined {
    const lease = this.database.db
      .select()
      .from(workspaceLeases)
      .where(eq(workspaceLeases.workSessionId, workSessionId))
      .get();
    return lease ? rowToWorkspaceLease(lease) : undefined;
  }

  submitForReview(input: {
    workSessionId: string;
    diff?: string;
    diffSha256?: string;
    snapshotCommit?: string;
    message?: string;
    summaryJson?: string;
  }): WorkSessionSubmission {
    const diffSha256 = input.diffSha256 ?? sha256(input.diff ?? "");
    const now = new Date().toISOString();
    const submissionId = `wssub_${randomUUID()}`;

    const createSubmission = this.database.sqlite.transaction(() => {
      const session = this.database.sqlite
        .prepare("select review_epoch, status from work_sessions where id = ?")
        .get(input.workSessionId) as { review_epoch: number; status: string } | undefined;
      if (!session) throw new Error(`Work session not found: ${input.workSessionId}`);
      if (!["in_progress", "changes_requested", "resuming"].includes(session.status)) {
        throw new Error(`Work session ${input.workSessionId} is ${session.status}; cannot submit for review.`);
      }

      // Allocate under the same immediate transaction that advances the
      // session epoch. A second writer cannot observe the same max/count and
      // turn a normal concurrency race into a raw unique-index error.
      const latest = this.database.sqlite
        .prepare("select coalesce(max(submission_number), 0) as submission_number from work_session_submissions where work_session_id = ?")
        .get(input.workSessionId) as { submission_number: number };
      const submissionNumber = Number(latest.submission_number) + 1;
      const reviewEpoch = Number(session.review_epoch) + 1;
      this.database.sqlite.prepare(`
        insert into work_session_submissions
          (id, work_session_id, submission_number, diff, diff_sha256, snapshot_commit, review_epoch, message, summary_json, status, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        submissionId,
        input.workSessionId,
        submissionNumber,
        input.diff ?? null,
        diffSha256,
        input.snapshotCommit ?? null,
        reviewEpoch,
        input.message ?? null,
        input.summaryJson ?? null,
        now,
      );
      const updated = this.database.sqlite.prepare(`
        update work_sessions
           set status = 'awaiting_review', runtime_state = 'parked', runtime_classified_at = ?, review_epoch = ?, updated_at = ?
         where id = ? and review_epoch = ? and status in ('in_progress', 'changes_requested', 'resuming')
      `).run(now, reviewEpoch, now, input.workSessionId, session.review_epoch);
      if (updated.changes !== 1) throw new Error("submission changed concurrently");
      return { submissionNumber, reviewEpoch };
    }).immediate();

    return {
      id: submissionId,
      workSessionId: input.workSessionId,
      submissionNumber: createSubmission.submissionNumber,
      diff: input.diff,
      diffSha256,
      snapshotCommit: input.snapshotCommit,
      reviewEpoch: createSubmission.reviewEpoch,
      message: input.message,
      summaryJson: input.summaryJson,
      status: "pending",
      createdAt: now,
    };
  }

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
  }): WorkSessionFeedback {
    const now = new Date().toISOString();
    const feedback: WorkSessionFeedback = {
      id: `wsfb_${randomUUID()}`,
      workSessionId: input.workSessionId,
      submissionId: input.submissionId,
      verdict: input.verdict,
      comments: input.comments,
      filesJson: input.filesJson,
      requiredActionsJson: input.requiredActions ? JSON.stringify(input.requiredActions) : undefined,
      allowedNextActionsJson: input.allowedNextActions ? JSON.stringify(input.allowedNextActions) : undefined,
      reviewerId: input.reviewerId,
      completionReportSha256: input.completionReportSha256,
      createdAt: now,
    };

    const nextStatus: WorkSessionStatus =
      input.verdict === "approve"
        ? "approved"
        : input.verdict === "reject"
          ? "rejected"
          : "changes_requested";

    this.database.db.transaction(() => {
      const submission = this.database.db
        .select({ workSessionId: workSessionSubmissions.workSessionId })
        .from(workSessionSubmissions)
        .where(eq(workSessionSubmissions.id, input.submissionId))
        .get();
      if (!submission) throw new Error(`Submission not found: ${input.submissionId}`);
      if (submission.workSessionId !== input.workSessionId) {
        throw new Error("Submission does not belong to work session");
      }

      this.database.db
        .insert(workSessionFeedback)
        .values({
          id: feedback.id,
          workSessionId: feedback.workSessionId,
          submissionId: feedback.submissionId,
          verdict: feedback.verdict,
          comments: feedback.comments ?? null,
          filesJson: feedback.filesJson ?? null,
          requiredActionsJson: feedback.requiredActionsJson ?? null,
          allowedNextActionsJson: feedback.allowedNextActionsJson ?? null,
          reviewerId: feedback.reviewerId ?? null,
          completionReportSha256: feedback.completionReportSha256 ?? null,
          createdAt: feedback.createdAt,
        })
        .run();

      this.database.db
        .update(workSessionSubmissions)
        .set({ status: "reviewed" })
        .where(eq(workSessionSubmissions.id, input.submissionId))
        .run();

      this.database.db
        .update(workSessions)
        .set({
          status: nextStatus,
          runtimeState: isTerminalStatus(nextStatus) ? "archived" : "detached",
          runtimeClassifiedAt: now,
          updatedAt: now,
        })
        .where(eq(workSessions.id, input.workSessionId))
        .run();
      if (isTerminalStatus(nextStatus)) {
        this.releaseWorkspaceLeasesForSession(input.workSessionId);
      }
    });

    return feedback;
  }

  logToolEvent(input: {
    workSessionId: string;
    workspaceSessionId: string;
    tool: string;
    inputJson: string;
    outputSummary?: string;
    path?: string;
    success: boolean;
    elapsedMs: number;
  }): ToolEvent {
    const now = new Date().toISOString();
    const id = `wste_${randomUUID()}`;
    this.database.db
      .insert(workSessionToolEvents)
      .values({
        id,
        workSessionId: input.workSessionId,
        workspaceSessionId: input.workspaceSessionId,
        tool: input.tool,
        inputJson: input.inputJson,
        outputSummary: input.outputSummary ?? null,
        path: input.path ?? null,
        success: input.success ? 1 : 0,
        elapsedMs: input.elapsedMs,
        createdAt: now,
      })
      .run();
    return {
      id,
      workSessionId: input.workSessionId,
      workspaceSessionId: input.workspaceSessionId,
      tool: input.tool,
      inputJson: input.inputJson,
      outputSummary: input.outputSummary,
      path: input.path,
      success: input.success,
      elapsedMs: input.elapsedMs,
      createdAt: now,
    };
  }

  /** P2 #54: Compact recent summary (default 50). */
  getRecentToolEvents(workSessionId: string, limit = 50): ToolEvent[] {
    const rows = this.database.db
      .select()
      .from(workSessionToolEvents)
      .where(eq(workSessionToolEvents.workSessionId, workSessionId))
      .orderBy(desc(workSessionToolEvents.createdAt))
      .limit(limit)
      .all();
    return rows.map(rowToToolEvent);
  }

  /** P2 #54: Full history with pagination (cursor-based). */
  listToolEvents(workSessionId: string, afterId?: string, limit = 500): ToolEvent[] {
    const baseCondition = eq(workSessionToolEvents.workSessionId, workSessionId);
    if (afterId) {
      const anchor = this.database.db
        .select()
        .from(workSessionToolEvents)
        .where(eq(workSessionToolEvents.id, afterId))
        .get();
      if (!anchor) return [];
      const rows = this.database.db
        .select()
        .from(workSessionToolEvents)
        .where(and(
          baseCondition,
          sql`${workSessionToolEvents.createdAt} < ${anchor.createdAt}`,
        ))
        .orderBy(desc(workSessionToolEvents.createdAt))
        .limit(limit)
        .all();
      return rows.map(rowToToolEvent);
    }
    const rows = this.database.db
      .select()
      .from(workSessionToolEvents)
      .where(baseCondition)
      .orderBy(desc(workSessionToolEvents.createdAt))
      .limit(limit)
      .all();
    return rows.map(rowToToolEvent);
  }

  /** @deprecated Use getRecentToolEvents() or listToolEvents() */
  getToolEvents(workSessionId: string, limit = 50): ToolEvent[] {
    return this.getRecentToolEvents(workSessionId, limit);
  }

  getSubmissions(workSessionId: string): WorkSessionSubmission[] {
    const rows = this.database.db
      .select()
      .from(workSessionSubmissions)
      .where(eq(workSessionSubmissions.workSessionId, workSessionId))
      .orderBy(workSessionSubmissions.submissionNumber)
      .all();
    return rows.map(rowToSubmission);
  }

  getLatestSubmission(workSessionId: string): WorkSessionSubmission | undefined {
    const row = this.database.db
      .select()
      .from(workSessionSubmissions)
      .where(eq(workSessionSubmissions.workSessionId, workSessionId))
      .orderBy(desc(workSessionSubmissions.submissionNumber))
      .limit(1)
      .get();
    return row ? rowToSubmission(row) : undefined;
  }

  getLatestFeedback(workSessionId: string): WorkSessionFeedback | undefined {
    const row = this.database.db
      .select()
      .from(workSessionFeedback)
      .where(eq(workSessionFeedback.workSessionId, workSessionId))
      .orderBy(desc(workSessionFeedback.createdAt))
      .limit(1)
      .get();
    return row ? rowToFeedback(row) : undefined;
  }

  countFeedback(workSessionId: string): number {
    const row = this.database.sqlite
      .prepare("select count(*) as count from work_session_feedback where work_session_id = ?")
      .get(workSessionId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  markFeedbackConsumed(workSessionId: string, feedbackId: string): void {
    const now = new Date().toISOString();
    this.database.db
      .update(workSessions)
      .set({ lastConsumedFeedbackId: feedbackId, updatedAt: now })
      .where(eq(workSessions.id, workSessionId))
      .run();
  }

  getLatestFeedbackAfter(workSessionId: string, afterFeedbackId?: string): WorkSessionFeedback | undefined {
    if (afterFeedbackId) {
      const anchor = this.database.db
        .select()
        .from(workSessionFeedback)
        .where(eq(workSessionFeedback.id, afterFeedbackId))
        .get();
      if (!anchor) {
        // P2 #55: Anchor not found — fall back to latest feedback
        return this.getLatestFeedback(workSessionId);
      }

      const row = this.database.db
        .select()
        .from(workSessionFeedback)
        .where(
          and(
            eq(workSessionFeedback.workSessionId, workSessionId),
            sql`${workSessionFeedback.createdAt} > ${anchor.createdAt}`,
          ),
        )
        .orderBy(desc(workSessionFeedback.createdAt))
        .limit(1)
        .get();

      return row ? rowToFeedback(row) : undefined;
    }

    const row = this.database.db
      .select()
      .from(workSessionFeedback)
      .where(eq(workSessionFeedback.workSessionId, workSessionId))
      .orderBy(desc(workSessionFeedback.createdAt))
      .limit(1)
      .get();

    return row ? rowToFeedback(row) : undefined;
  }

  listPendingReviews(workspaceSessionId?: string, limit = 20): WorkSession[] {
    const statusFilter = sql`${workSessions.status} IN ('awaiting_review', 'review_in_progress')
      and ${workSessions.runtimeState} <> 'stale'
      and datetime(${workSessions.updatedAt}) >= datetime('now', '-30 days')`;
    const projectId = workspaceSessionId ? this.projectIdForWorkspace(workspaceSessionId) : undefined;
    const condition = workspaceSessionId
      ? and(statusFilter, projectId ? eq(workSessions.projectId, projectId) : eq(workSessions.workspaceSessionId, workspaceSessionId))
      : statusFilter;

    const rows = this.database.db
      .select()
      .from(workSessions)
      .where(condition)
      .orderBy(desc(workSessions.updatedAt))
      .limit(limit)
      .all();

    return rows.map((row) => this.enrichSession(row));
  }

  listActiveWorkSessions(workspaceSessionId?: string, limit = 50): WorkSession[] {
    return this.listLiveWorkSessions(workspaceSessionId, limit);
  }

  listLiveWorkSessions(workspaceSessionId?: string, limit = 50): WorkSession[] {
    const liveState = or(
      sql`${workSessions.runtimeState} = 'running'`,
      sql`${workSessions.runtimeState} = 'pending' AND ${workSessions.status} IN ('in_progress', 'drafting', 'resuming') AND datetime(${workSessions.updatedAt}) >= datetime('now', '-1 hour')`,
    );
    const projectId = workspaceSessionId ? this.projectIdForWorkspace(workspaceSessionId) : undefined;
    const condition = workspaceSessionId
      ? and(liveState, projectId ? eq(workSessions.projectId, projectId) : eq(workSessions.workspaceSessionId, workspaceSessionId))
      : liveState;
    const rows = this.database.db
      .select()
      .from(workSessions)
      .where(condition)
      .orderBy(desc(workSessions.updatedAt))
      .limit(limit)
      .all();

    return rows.map((row) => this.enrichSession(row));
  }

  listRecoverableWorkSessions(workspaceSessionId?: string, limit = 50): WorkSession[] {
    const recoverableState = sql`${workSessions.runtimeState} IN ('detached', 'stale', 'orphaned')`;
    const projectId = workspaceSessionId ? this.projectIdForWorkspace(workspaceSessionId) : undefined;
    const condition = workspaceSessionId
      ? and(recoverableState, projectId ? eq(workSessions.projectId, projectId) : eq(workSessions.workspaceSessionId, workspaceSessionId))
      : recoverableState;
    const rows = this.database.db.select().from(workSessions).where(condition).orderBy(desc(workSessions.updatedAt)).limit(limit).all();
    return rows.map((row) => this.enrichSession(row));
  }

  listStaleWorkSessions(workspaceSessionId?: string, limit = 50): WorkSession[] {
    const staleState = sql`${workSessions.runtimeState} IN ('stale', 'orphaned')`;
    const projectId = workspaceSessionId ? this.projectIdForWorkspace(workspaceSessionId) : undefined;
    const condition = workspaceSessionId
      ? and(staleState, projectId ? eq(workSessions.projectId, projectId) : eq(workSessions.workspaceSessionId, workspaceSessionId))
      : staleState;
    const rows = this.database.db.select().from(workSessions).where(condition).orderBy(desc(workSessions.updatedAt)).limit(limit).all();
    return rows.map((row) => this.enrichSession(row));
  }

  listAllWorkSessions(workspaceSessionId?: string, limit = 200): WorkSession[] {
    const condition = workspaceSessionId
      ? eq(workSessions.workspaceSessionId, workspaceSessionId)
      : undefined;

    const rows = this.database.db
      .select()
      .from(workSessions)
      .where(condition ?? sql`1=1`)
      .orderBy(desc(workSessions.updatedAt))
      .limit(limit)
      .all();

    return rows.map((row) => this.enrichSession(row));
  }

  getWorkspaceSessionSurface(
    workspaceSessionId?: string,
    limit = 50,
    filter: "all" | "pending_review" | "live" = "all",
    after?: WorkspaceSessionSurfaceCursor,
  ): WorkspaceSessionSurfaceEntry[] {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const projectId = workspaceSessionId ? this.projectIdForWorkspace(workspaceSessionId) : undefined;
    const scopeSql = workspaceSessionId
      ? projectId ? "ws.project_id = ?" : "ws.workspace_session_id = ?"
      : "1 = 1";
    const scopeParam = workspaceSessionId ? (projectId ?? workspaceSessionId) : undefined;
    const rows = this.database.sqlite.prepare(`
      select
        ws.id as session_id,
        ws.workspace_session_id,
        ws.status,
        ws.runtime_state,
        ws.title,
        ws.submitted_by,
        ws.updated_at,
        (select ar.run_id from acp_runs ar where ar.work_session_id = ws.id order by ar.created_at desc limit 1) as run_id,
        (select 1 from mission_contracts mc where mc.work_session_id = ws.id limit 1) as has_mission,
        (select sr.status from supervisor_runs sr where sr.work_session_id = ws.id limit 1) as mission_status,
        (select sr.cycle_number from supervisor_runs sr where sr.work_session_id = ws.id limit 1) as mission_cycle_number,
        (select sr.max_cycles from supervisor_runs sr where sr.work_session_id = ws.id limit 1) as mission_max_cycles,
        (select coalesce(max(el.seq), 0) from event_log el where el.session_id = ws.id) as last_seq,
        (select count(*) from work_session_submissions s where s.work_session_id = ws.id) as submission_count,
        (select count(*) from agent_messages am where am.work_session_id = ws.id and am.status = 'open') as unresolved_message_count,
        (select count(*) from approval_requests ap where ap.work_session_id = ws.id and ap.status = 'pending') as pending_approval_count,
        (select s.id from work_session_submissions s where s.work_session_id = ws.id order by s.submission_number desc limit 1) as latest_submission_id,
        (select s.submission_number from work_session_submissions s where s.work_session_id = ws.id order by s.submission_number desc limit 1) as latest_submission_number,
        (select s.status from work_session_submissions s where s.work_session_id = ws.id order by s.submission_number desc limit 1) as latest_submission_status,
        (select coalesce(s.diff_sha256, '') from work_session_submissions s where s.work_session_id = ws.id order by s.submission_number desc limit 1) as latest_submission_diff_sha256,
        (select s.review_epoch from work_session_submissions s where s.work_session_id = ws.id order by s.submission_number desc limit 1) as latest_submission_review_epoch,
        (select coalesce(json_extract(s.summary_json, '$.additions'), 0) from work_session_submissions s where s.work_session_id = ws.id order by s.submission_number desc limit 1) as latest_submission_additions,
        (select coalesce(json_extract(s.summary_json, '$.removals'), 0) from work_session_submissions s where s.work_session_id = ws.id order by s.submission_number desc limit 1) as latest_submission_removals,
        (select f.id from work_session_feedback f where f.work_session_id = ws.id order by f.created_at desc limit 1) as latest_feedback_id,
        (select f.submission_id from work_session_feedback f where f.work_session_id = ws.id order by f.created_at desc limit 1) as latest_feedback_submission_id,
        (select f.verdict from work_session_feedback f where f.work_session_id = ws.id order by f.created_at desc limit 1) as latest_feedback_verdict,
        (select f.comments from work_session_feedback f where f.work_session_id = ws.id order by f.created_at desc limit 1) as latest_feedback_comments,
        (select f.reviewer_id from work_session_feedback f where f.work_session_id = ws.id order by f.created_at desc limit 1) as latest_feedback_reviewer_id
      from work_sessions ws
      where ${scopeSql}
        ${after ? "and (ws.updated_at < ? or (ws.updated_at = ? and ws.id < ?))" : ""}
        and ${filter === "pending_review"
          ? "ws.status in ('awaiting_review', 'review_in_progress') and ws.runtime_state <> 'stale' and datetime(ws.updated_at) >= datetime('now', '-30 days')"
          : filter === "live"
            ? "(ws.runtime_state = 'running' or (ws.runtime_state = 'pending' and ws.status in ('in_progress', 'drafting', 'resuming') and datetime(ws.updated_at) >= datetime('now', '-1 hour')))"
            : "(ws.runtime_state in ('running', 'pending', 'detached', 'stale', 'orphaned') or ws.status in ('awaiting_review', 'review_in_progress', 'changes_requested')) and not (ws.status in ('awaiting_review', 'review_in_progress') and datetime(ws.updated_at) < datetime('now', '-30 days'))"}
      order by ws.updated_at desc, ws.id desc
      limit ?
    `).all(...(
      scopeParam
        ? [scopeParam, ...(after ? [after.updatedAt, after.updatedAt, after.sessionId] : []), boundedLimit]
        : [...(after ? [after.updatedAt, after.updatedAt, after.sessionId] : []), boundedLimit]
    )) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const status = String(row.status);
      const runtimeState = String(row.runtime_state) as WorkSessionRuntimeState;
      const latestSubmissionId = typeof row.latest_submission_id === "string" ? row.latest_submission_id : undefined;
      const latestFeedbackId = typeof row.latest_feedback_id === "string" ? row.latest_feedback_id : undefined;
      const latestFeedbackSubmissionId = typeof row.latest_feedback_submission_id === "string" ? row.latest_feedback_submission_id : undefined;
      return {
        sessionId: String(row.session_id),
        workspaceSessionId: String(row.workspace_session_id),
        status,
        lifecycle: lifecycleForRuntimeState(status as WorkSessionStatus, runtimeState),
        runtimeState,
        title: typeof row.title === "string" ? row.title : undefined,
        submittedBy: String(row.submitted_by),
        updatedAt: String(row.updated_at),
        runId: typeof row.run_id === "string" ? row.run_id : undefined,
        hasMission: row.has_mission === 1,
        missionStatus: typeof row.mission_status === "string" ? row.mission_status : undefined,
        missionCycleNumber: typeof row.mission_cycle_number === "number" ? row.mission_cycle_number : undefined,
        missionMaxCycles: typeof row.mission_max_cycles === "number" ? row.mission_max_cycles : undefined,
        lastSeq: Number(row.last_seq ?? 0),
        submissionCount: Number(row.submission_count ?? 0),
        unresolvedMessageCount: Number(row.unresolved_message_count ?? 0),
        pendingApprovalCount: Number(row.pending_approval_count ?? 0),
        latestSubmission: latestSubmissionId ? {
          submissionId: latestSubmissionId,
          submissionNumber: Number(row.latest_submission_number ?? 0),
          status: String(row.latest_submission_status ?? "pending"),
          additions: Number(row.latest_submission_additions ?? 0),
          removals: Number(row.latest_submission_removals ?? 0),
          diffSha256: typeof row.latest_submission_diff_sha256 === "string" && row.latest_submission_diff_sha256 ? row.latest_submission_diff_sha256 : undefined,
          reviewEpoch: typeof row.latest_submission_review_epoch === "number" ? row.latest_submission_review_epoch : undefined,
        } : undefined,
        latestFeedback: latestFeedbackId ? {
          id: latestFeedbackId,
          submissionId: latestFeedbackSubmissionId,
          verdict: String(row.latest_feedback_verdict ?? ""),
          comments: typeof row.latest_feedback_comments === "string" ? row.latest_feedback_comments : undefined,
          reviewerId: typeof row.latest_feedback_reviewer_id === "string" ? row.latest_feedback_reviewer_id : undefined,
        } : undefined,
      } satisfies WorkspaceSessionSurfaceEntry;
    });
  }

  getWorkspaceEventCursor(workspaceSessionId?: string): number {
    if (!workspaceSessionId) {
      const row = this.database.sqlite.prepare("select coalesce(max(seq), 0) as seq from event_log").get() as { seq?: number } | undefined;
      return Number(row?.seq ?? 0);
    }
    const projectId = this.projectIdForWorkspace(workspaceSessionId);
    const row = this.database.sqlite.prepare(`
      select coalesce(max(el.seq), 0) as seq
      from event_log el
      where el.workspace_session_id = ?
         or el.workspace_session_id in (select id from workspace_sessions where project_id = ?)
    `).get(workspaceSessionId, projectId ?? workspaceSessionId) as { seq?: number } | undefined;
    return Number(row?.seq ?? 0);
  }

  countActiveWorkSessions(): number {
    const result = this.database.db
      .select({ count: sql<number>`count(*)` })
      .from(workSessions)
      .where(or(
        sql`${workSessions.runtimeState} = 'running'`,
        sql`${workSessions.runtimeState} = 'pending' AND ${workSessions.status} IN ('in_progress', 'drafting', 'resuming') AND datetime(${workSessions.updatedAt}) >= datetime('now', '-1 hour')`,
      ))
      .get();
    return result?.count ?? 0;
  }

  countPendingReviews(): number {
    const result = this.database.db
      .select({ count: sql<number>`count(*)` })
      .from(workSessions)
      .where(sql`${workSessions.status} IN ('awaiting_review', 'review_in_progress')
        and ${workSessions.runtimeState} <> 'stale'
        and datetime(${workSessions.updatedAt}) >= datetime('now', '-30 days')`)
      .get();
    return result?.count ?? 0;
  }

  /** P2 #10: Active-session projection with all needed fields in one query. */
  listActiveWorkSessionsProjection(workspaceSessionId?: string): Array<{
    sessionId: string;
    workspaceSessionId: string;
    status: string;
    title?: string;
    submittedBy: string;
    updatedAt: string;
    submissionCount: number;
  }> {
    const liveState = or(
      sql`${workSessions.runtimeState} = 'running'`,
      sql`${workSessions.runtimeState} = 'pending' AND ${workSessions.status} IN ('in_progress', 'drafting', 'resuming') AND datetime(${workSessions.updatedAt}) >= datetime('now', '-1 hour')`,
    );
    const projectId = workspaceSessionId ? this.projectIdForWorkspace(workspaceSessionId) : undefined;
    const condition = workspaceSessionId
      ? and(liveState, projectId ? eq(workSessions.projectId, projectId) : eq(workSessions.workspaceSessionId, workspaceSessionId))
      : liveState;

    const rows = this.database.db
      .select({
        sessionId: workSessions.id,
        workspaceSessionId: workSessions.workspaceSessionId,
        status: workSessions.status,
        title: workSessions.title,
        submittedBy: workSessions.submittedBy,
        updatedAt: workSessions.updatedAt,
        submissionCount: sql<number>`(select count(*) from ${workSessionSubmissions} where ${workSessionSubmissions.workSessionId} = ${workSessions.id})`,
      })
      .from(workSessions)
      .where(condition)
      .orderBy(desc(workSessions.updatedAt))
      .limit(50)
      .all();

    return rows.map((row) => ({
      sessionId: row.sessionId,
      workspaceSessionId: row.workspaceSessionId,
      status: row.status,
      title: row.title ?? undefined,
      submittedBy: row.submittedBy,
      updatedAt: row.updatedAt,
      submissionCount: row.submissionCount ?? 0,
    }));
  }

  /**
   * P1 #18: bounded cursor page of session IDs eligible for telemetry
   * compaction — terminal sessions, or parked/stale review sessions. Only
   * IDs are returned so maintenance never hydrates full projections.
   */
  listSessionIdsNeedingCompaction(afterSessionId?: string, limit = 500): string[] {
    const boundedLimit = Math.max(1, Math.min(2_000, Math.trunc(limit)));
    const terminalStatuses = ["approved", "rejected", "cancelled", "failed", "failed_protocol"];
    const compactParked = and(
      sql`${workSessions.runtimeState} IN ('parked', 'stale')`,
      sql`${workSessions.status} IN ('awaiting_review', 'review_in_progress')`,
    );
    const condition = afterSessionId
      ? and(
          or(inArray(workSessions.status, terminalStatuses), compactParked!),
          sql`${workSessions.id} > ${afterSessionId}`,
        )
      : or(inArray(workSessions.status, terminalStatuses), compactParked!);

    const rows = this.database.db
      .select({ id: workSessions.id })
      .from(workSessions)
      .where(condition)
      .orderBy(workSessions.id)
      .limit(boundedLimit)
      .all();
    return rows.map((row) => row.id);
  }

  reconcileRuntimeStates(): { reconciled: number; markedStale: number } {
    const rows = this.database.db.select().from(workSessions).all();
    let reconciled = 0;
    let markedStale = 0;
    const now = new Date().toISOString();
    for (const row of rows) {
      const next = this.runtimeStateFor(row.status as WorkSessionStatus, row.updatedAt, this.latestRunForSession(row.id));
      if (row.runtimeState === next) continue;
      this.database.db.update(workSessions)
        .set({ runtimeState: next, runtimeClassifiedAt: now })
        .where(eq(workSessions.id, row.id))
        .run();
      reconciled++;
      if (next === "stale" || next === "orphaned") markedStale++;
    }
    return { reconciled, markedStale };
  }

  // P2 #56: Only close the DB handle if this manager opened it
  close(): void {
    if (this.ownsDatabase) {
      this.database.close();
    }
  }

  private enrichSession(row: WorkSessionRow): WorkSession {
    const latestSubmission = this.getLatestSubmission(row.id);
    const latestFeedback = this.getLatestFeedback(row.id);
    const status = row.status as WorkSessionStatus;
    const runtimeState = row.runtimeState && row.runtimeState !== "pending"
      ? row.runtimeState as WorkSessionRuntimeState
      : this.runtimeStateFor(status, row.updatedAt, this.latestRunForSession(row.id));

    return {
      id: row.id,
      projectId: row.projectId ?? undefined,
      workspaceSessionId: row.workspaceSessionId,
      status,
      completionPolicy: (row.completionPolicy as CompletionPolicy | undefined) ?? "agent_completion",
      reviewEpoch: row.reviewEpoch ?? 0,
      submittedBy: row.submittedBy,
      title: row.title ?? undefined,
      lastConsumedFeedbackId: row.lastConsumedFeedbackId ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      latestSubmission,
      latestFeedback,
      lifecycle: lifecycleForRuntimeState(status, runtimeState),
      runtimeState,
    };
  }

  private projectIdForWorkspace(workspaceSessionId: string): string | undefined {
    const row = this.database.db.select({ projectId: workspaceSessions.projectId })
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, workspaceSessionId))
      .get();
    return row?.projectId ?? undefined;
  }

  private latestRunForSession(workSessionId: string): {
    status: string;
    lastHeartbeatAt?: string | null;
    workerLeaseUntil?: string | null;
    finishedAt?: string | null;
  } | undefined {
    const row = this.database.db.select({
      status: acpRuns.status,
      lastHeartbeatAt: acpRuns.lastHeartbeatAt,
      workerLeaseUntil: acpRuns.workerLeaseUntil,
      finishedAt: acpRuns.finishedAt,
    }).from(acpRuns)
      .where(eq(acpRuns.workSessionId, workSessionId))
      .orderBy(desc(acpRuns.createdAt))
      .limit(1)
      .get();
    return row;
  }

  private runtimeStateFor(
    status: WorkSessionStatus,
    updatedAt: string,
    run: { status: string; lastHeartbeatAt?: string | null; workerLeaseUntil?: string | null; finishedAt?: string | null } | undefined,
  ): WorkSessionRuntimeState {
    if (isTerminalStatus(status)) return "archived";
    const ageMs = Date.now() - Date.parse(updatedAt);
    if (status === "awaiting_review" || status === "review_in_progress") {
      // A parked review remains durable and recoverable, but month-old review
      // work must not consume the active control-plane surface forever.
      return ageMs > 30 * 24 * 60 * 60 * 1000 ? "stale" : "parked";
    }
    const runActive = Boolean(run && !run.finishedAt && ["created", "in-progress", "running", "working", "awaiting"].includes(run.status));
    const heartbeat = run?.lastHeartbeatAt ? Date.parse(run.lastHeartbeatAt) : 0;
    const lease = run?.workerLeaseUntil ? Date.parse(run.workerLeaseUntil) : 0;
    const recentHeartbeat = heartbeat > 0 && Date.now() - heartbeat <= 2 * 60_000;
    const validLease = lease > Date.now();
    if (runActive && (recentHeartbeat || validLease)) return "running";
    if (ageMs > STALE_THRESHOLD_MS) return "stale";
    return "detached";
  }
}

function rowToWorkspaceLease(row: WorkspaceLeaseRow): WorkspaceLease {
  return {
    canonicalRoot: row.canonicalRoot,
    workspaceSessionId: row.workspaceSessionId,
    workSessionId: row.workSessionId,
    leaseKind: "modify",
    ownerInstanceId: row.ownerInstanceId,
    leaseNonce: row.leaseNonce,
    acquiredAt: row.acquiredAt,
    heartbeatAt: row.heartbeatAt,
    expiresAt: row.expiresAt,
  };
}

function isTerminalStatus(status: WorkSessionStatus): boolean {
  return status === "approved" || status === "rejected" || status === "cancelled" || status === "failed" || status === "failed_protocol";
}

function lifecycleForRuntimeState(status: WorkSessionStatus, runtimeState: WorkSessionRuntimeState): WorkSessionLifecycle {
  if (runtimeState === "archived") return "archived";
  if (status === "awaiting_review" || status === "review_in_progress" || runtimeState === "parked") return "awaiting_review";
  if (status === "changes_requested") return "resumable";
  if (runtimeState === "running") return "active_worker";
  if (runtimeState === "stale") return "stale";
  if (runtimeState === "detached" || runtimeState === "orphaned") return "detached";
  return "pending";
}

/** P1 #7: classify a work session into a lifecycle bucket for UI grouping. */
export function classifyLifecycle(
  status: WorkSessionStatus,
  updatedAt: string,
  hasLiveRun: boolean,
  hasRecentHeartbeat: boolean,
): WorkSessionLifecycle {
  if (isTerminalStatus(status)) return "archived";
  if (status === "awaiting_review") return "awaiting_review";
  if (status === "changes_requested") return "resumable";

  // in_progress / resuming / drafting etc.
  if (hasLiveRun && hasRecentHeartbeat) return "active_worker";
  if (!hasLiveRun && !hasRecentHeartbeat) {
    // P1 #7: stale threshold — no run, no heartbeat for >1h
    const ageMs = Date.now() - new Date(updatedAt).getTime();
    if (ageMs > STALE_THRESHOLD_MS) return "stale";
    return "detached";
  }
  return "pending";
}

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

function rowToSubmission(row: WorkSessionSubmissionRow): WorkSessionSubmission {
  return {
    id: row.id,
    workSessionId: row.workSessionId,
    submissionNumber: row.submissionNumber ?? 1,
    diff: row.diff ?? undefined,
    diffSha256: row.diffSha256 ?? undefined,
    snapshotCommit: row.snapshotCommit ?? undefined,
    reviewEpoch: row.reviewEpoch ?? 1,
    message: row.message ?? undefined,
    summaryJson: row.summaryJson ?? undefined,
    status: (row.status as "pending" | "reviewed") ?? "pending",
    createdAt: row.createdAt,
  };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function rowToFeedback(row: WorkSessionFeedbackRow): WorkSessionFeedback {
  return {
    id: row.id,
    workSessionId: row.workSessionId,
    submissionId: row.submissionId,
    verdict: row.verdict as SubmissionVerdict,
    comments: row.comments ?? undefined,
    filesJson: row.filesJson ?? undefined,
    requiredActionsJson: row.requiredActionsJson ?? undefined,
    allowedNextActionsJson: row.allowedNextActionsJson ?? undefined,
    reviewerId: row.reviewerId ?? undefined,
    completionReportSha256: row.completionReportSha256 ?? undefined,
    createdAt: row.createdAt,
  };
}

function rowToToolEvent(row: WorkSessionToolEventRow): ToolEvent {
  return {
    id: row.id,
    workSessionId: row.workSessionId,
    workspaceSessionId: row.workspaceSessionId ?? undefined,
    tool: row.tool,
    inputJson: row.inputJson,
    outputSummary: row.outputSummary ?? undefined,
    path: row.path ?? undefined,
    success: row.success === 1,
    elapsedMs: row.elapsedMs ?? 0,
    createdAt: row.createdAt,
  };
}
