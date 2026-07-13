import { createHash, randomUUID } from "node:crypto";
import { eq, and, desc, gte, sql } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workSessions,
  workspaceLeases,
  workSessionSubmissions,
  workSessionFeedback,
  workSessionToolEvents,
  type WorkSessionRow,
  type WorkspaceLeaseRow,
  type WorkSessionSubmissionRow,
  type WorkSessionFeedbackRow,
  type WorkSessionToolEventRow,
} from "./db/schema.js";

export type WorkSessionStatus =
  | "in_progress"
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
}

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
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
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
  /**
   * Renew the checkout lease(s) held by a still-working session, extending
   * expiry from a worker heartbeat. Returns the number of leases renewed (0 if
   * the session holds none). Unlike acquireWorkspaceLease this never seizes or
   * transfers ownership — it only pushes out expiry for leases this session
   * already owns, so a long-running worker's checkout is not pruned out from
   * under it.
   */
  renewWorkspaceLeaseForSession(workSessionId: string, ttlMs?: number): number;
  submitForReview(input: {
    workSessionId: string;
    diff?: string;
    diffSha256?: string;
    /** Exact working-tree snapshot commit the diff was captured against. */
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
  getToolEvents(workSessionId: string, limit?: number): ToolEvent[];
  getSubmissions(workSessionId: string): WorkSessionSubmission[];
  markFeedbackConsumed(workSessionId: string, feedbackId: string): void;
  getLatestFeedbackAfter(workSessionId: string, afterFeedbackId?: string): WorkSessionFeedback | undefined;
  listPendingReviews(workspaceSessionId?: string, limit?: number): WorkSession[];
  /**
   * All non-terminal work sessions (optionally scoped to a workspace), most
   * recently updated first. Unlike listPendingReviews (which only surfaces
   * sessions awaiting a reviewer), this returns every session the WebUI must
   * rehydrate on reconnect — including ones the worker is still driving
   * (in_progress / resuming) or ones sent back for changes. The WebUI replays
   * each returned session's event log from seq 0 to rebuild its view.
   */
  listActiveWorkSessions(workspaceSessionId?: string, limit?: number): WorkSession[];
  close(): void;
}

export function createWorkSessionManager(
  stateDirOrHandle: string | DatabaseHandle,
): WorkSessionManager {
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;
  return new SqliteWorkSessionManager(database);
}

class SqliteWorkSessionManager implements WorkSessionManager {
  private readonly database: DatabaseHandle;

  constructor(database: DatabaseHandle) {
    this.database = database;
  }

  create(input: { workspaceSessionId: string; submittedBy: string; title?: string; completionPolicy?: CompletionPolicy }): WorkSession {
    const now = new Date().toISOString();
    const session: WorkSession = {
      id: `wsess_${randomUUID()}`,
      workspaceSessionId: input.workspaceSessionId,
      status: "in_progress",
      completionPolicy: input.completionPolicy ?? "agent_completion",
      reviewEpoch: 0,
      submittedBy: input.submittedBy,
      title: input.title,
      createdAt: now,
      updatedAt: now,
    };

    this.database.db
      .insert(workSessions)
      .values({
        id: session.id,
        workspaceSessionId: session.workspaceSessionId,
        status: session.status,
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
    const rows = this.database.db
      .select()
      .from(workSessions)
      .where(eq(workSessions.workspaceSessionId, workspaceSessionId))
      .orderBy(desc(workSessions.updatedAt))
      .limit(limit)
      .all();
    return rows.map((row) => this.enrichSession(row));
  }

  updateStatus(id: string, status: WorkSessionStatus): void {
    const now = new Date().toISOString();
    this.database.db
      .update(workSessions)
      .set({ status, updatedAt: now })
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
        this.database.db
          .update(workspaceLeases)
          .set({ heartbeatAt: nowIso, expiresAt, ownerInstanceId })
          .where(eq(workspaceLeases.canonicalRoot, input.canonicalRoot))
          .run();
      } else {
        this.database.db
          .insert(workspaceLeases)
          .values({
            canonicalRoot: input.canonicalRoot,
            workspaceSessionId: input.workspaceSessionId,
            workSessionId: input.workSessionId,
            leaseKind: "modify",
            ownerInstanceId,
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

  renewWorkspaceLeaseForSession(workSessionId: string, ttlMs?: number): number {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + (ttlMs ?? 60 * 60 * 1000)).toISOString();
    // Scoped to this session's own leases: a renewal must never resurrect a
    // lease that already expired and was (or is about to be) taken by another
    // session. Guard on the current owner AND on not-yet-expired so a stale
    // heartbeat arriving after eviction is a no-op rather than a silent seizure.
    const result = this.database.db
      .update(workspaceLeases)
      .set({ heartbeatAt: nowIso, expiresAt })
      .where(and(
        eq(workspaceLeases.workSessionId, workSessionId),
        gte(workspaceLeases.expiresAt, nowIso),
      ))
      .run();
    return result.changes;
  }

  submitForReview(input: {
    workSessionId: string;
    diff?: string;
    diffSha256?: string;
    /** Exact working-tree snapshot commit the diff was captured against. */
    snapshotCommit?: string;
    message?: string;
    summaryJson?: string;
  }): WorkSessionSubmission {
    const session = this.get(input.workSessionId);
    if (!session) throw new Error(`Work session not found: ${input.workSessionId}`);

    const submissions = this.getSubmissions(input.workSessionId);
    const submissionNumber = submissions.length + 1;
    const reviewEpoch = session.reviewEpoch + 1;
    const diffSha256 = input.diffSha256 ?? sha256(input.diff ?? "");
    const now = new Date().toISOString();

    const submission: WorkSessionSubmission = {
      id: `wssub_${randomUUID()}`,
      workSessionId: input.workSessionId,
      submissionNumber,
      diff: input.diff,
      diffSha256,
      snapshotCommit: input.snapshotCommit,
      reviewEpoch,
      message: input.message,
      summaryJson: input.summaryJson,
      status: "pending",
      createdAt: now,
    };

    this.database.db.transaction(() => {
      this.database.db
        .insert(workSessionSubmissions)
        .values({
          id: submission.id,
          workSessionId: submission.workSessionId,
          submissionNumber: submission.submissionNumber,
          diff: submission.diff ?? null,
          diffSha256: submission.diffSha256 ?? null,
          snapshotCommit: submission.snapshotCommit ?? null,
          reviewEpoch: submission.reviewEpoch,
          message: submission.message ?? null,
          summaryJson: submission.summaryJson ?? null,
          status: submission.status,
          createdAt: submission.createdAt,
        })
        .run();

      this.database.db
        .update(workSessions)
        .set({ status: "awaiting_review", reviewEpoch, updatedAt: now })
        .where(eq(workSessions.id, input.workSessionId))
        .run();
    });

    return submission;
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
      createdAt: now,
    };

    const nextStatus: WorkSessionStatus =
      input.verdict === "approve"
        ? "approved"
        : input.verdict === "reject"
          ? "rejected"
          : "changes_requested";

    this.database.db.transaction(() => {
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
        .set({ status: nextStatus, updatedAt: now })
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
    const event: ToolEvent = {
      id: `wste_${randomUUID()}`,
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

    this.database.db
      .insert(workSessionToolEvents)
      .values({
        id: event.id,
        workSessionId: event.workSessionId,
        workspaceSessionId: event.workspaceSessionId ?? null,
        tool: event.tool,
        inputJson: event.inputJson,
        outputSummary: event.outputSummary ?? null,
        path: event.path ?? null,
        success: event.success ? 1 : 0,
        elapsedMs: event.elapsedMs,
        createdAt: event.createdAt,
      })
      .run();

    return event;
  }

  getToolEvents(workSessionId: string, limit = 500): ToolEvent[] {
    return this.database.db
      .select()
      .from(workSessionToolEvents)
      .where(eq(workSessionToolEvents.workSessionId, workSessionId))
      .orderBy(desc(workSessionToolEvents.createdAt))
      .limit(limit)
      .all()
      .map(rowToToolEvent);
  }

  getSubmissions(workSessionId: string): WorkSessionSubmission[] {
    const rows = this.database.db
      .select()
      .from(workSessionSubmissions)
      .where(eq(workSessionSubmissions.workSessionId, workSessionId))
      .orderBy(workSessionSubmissions.submissionNumber)
      .all();

    return rows.map((row) => {
      const feedbackRow = this.database.db
        .select()
        .from(workSessionFeedback)
        .where(eq(workSessionFeedback.submissionId, row.id))
        .get();

      return {
        ...rowToSubmission(row),
        feedback: feedbackRow ? rowToFeedback(feedbackRow) : undefined,
      };
    });
  }

  markFeedbackConsumed(workSessionId: string, feedbackId: string): void {
    this.database.db
      .update(workSessions)
      .set({ lastConsumedFeedbackId: feedbackId, updatedAt: new Date().toISOString() })
      .where(eq(workSessions.id, workSessionId))
      .run();
  }

  getLatestFeedbackAfter(workSessionId: string, afterFeedbackId?: string): WorkSessionFeedback | undefined {
    if (afterFeedbackId) {
      const anchorRow = this.database.db
        .select()
        .from(workSessionFeedback)
        .where(eq(workSessionFeedback.id, afterFeedbackId))
        .get();

      if (!anchorRow) {
        const row = this.database.db
          .select()
          .from(workSessionFeedback)
          .where(eq(workSessionFeedback.workSessionId, workSessionId))
          .orderBy(desc(workSessionFeedback.createdAt))
          .limit(1)
          .get();
        return row ? rowToFeedback(row) : undefined;
      }

      const row = this.database.db
        .select()
        .from(workSessionFeedback)
        .where(
          and(
            eq(workSessionFeedback.workSessionId, workSessionId),
            sql`${workSessionFeedback.createdAt} > ${anchorRow.createdAt}`,
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
    const statusFilter = sql`${workSessions.status} IN ('awaiting_review', 'review_in_progress')`;
    const condition = workspaceSessionId
      ? and(statusFilter, eq(workSessions.workspaceSessionId, workspaceSessionId))
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
    // Non-terminal = anything the WebUI can still act on or watch. Kept in sync
    // with review-workflow's TERMINAL_STATUSES by exclusion so a newly-added
    // live status is included by default rather than silently dropped.
    const terminal = ["approved", "rejected", "cancelled", "failed", "failed_protocol"];
    const notTerminal = sql`${workSessions.status} NOT IN (${sql.join(terminal.map((s) => sql`${s}`), sql`, `)})`;
    const condition = workspaceSessionId
      ? and(notTerminal, eq(workSessions.workspaceSessionId, workspaceSessionId))
      : notTerminal;

    const rows = this.database.db
      .select()
      .from(workSessions)
      .where(condition)
      .orderBy(desc(workSessions.updatedAt))
      .limit(limit)
      .all();

    return rows.map((row) => this.enrichSession(row));
  }

  close(): void {
    this.database.close();
  }

  private enrichSession(row: WorkSessionRow): WorkSession {
    const submissions = this.getSubmissions(row.id);
    const latestSubmission = submissions[submissions.length - 1];

    return {
      id: row.id,
      workspaceSessionId: row.workspaceSessionId,
      status: row.status as WorkSessionStatus,
      completionPolicy: (row.completionPolicy as CompletionPolicy | undefined) ?? "agent_completion",
      reviewEpoch: row.reviewEpoch ?? 0,
      submittedBy: row.submittedBy,
      title: row.title ?? undefined,
      lastConsumedFeedbackId: row.lastConsumedFeedbackId ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      latestSubmission,
      latestFeedback: latestSubmission?.feedback,
    };
  }
}

function rowToWorkspaceLease(row: WorkspaceLeaseRow): WorkspaceLease {
  return {
    canonicalRoot: row.canonicalRoot,
    workspaceSessionId: row.workspaceSessionId,
    workSessionId: row.workSessionId,
    leaseKind: "modify",
    ownerInstanceId: row.ownerInstanceId,
    acquiredAt: row.acquiredAt,
    heartbeatAt: row.heartbeatAt,
    expiresAt: row.expiresAt,
  };
}

function isTerminalStatus(status: WorkSessionStatus): boolean {
  return status === "approved" || status === "rejected" || status === "cancelled" || status === "failed" || status === "failed_protocol";
}

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
