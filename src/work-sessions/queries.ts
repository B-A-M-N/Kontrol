/**
 * WorkSessionQueries: list/count projections over work_sessions
 *
 * Extracted verbatim from SqliteWorkSessionManager (P1 god-object
 * decomposition). Every read-model the control plane serves — pending/live/
 * recoverable/stale listings, counts, the compact WebUI session surface,
 * event cursors, and the compaction-eligibility scan — lives here. Shares the
 * caller's DatabaseHandle.
 */
import { eq, and, desc, inArray, or, sql } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client.js";
import {
  workSessions,
  workSessionSubmissions,
} from "../db/schema.js";
import type {
  WorkspaceSessionSurfaceCursor,
  WorkspaceSessionSurfaceEntry,
  WorkSession,
  WorkSessionRuntimeState,
  WorkSessionStatus,
} from "./types.js";
import { lifecycleForRuntimeState } from "./internal.js";

export function createWorkSessionQueries(db: DatabaseHandle, deps: {
  projectIdForWorkspace(workspaceSessionId: string): string | undefined;
  enrichSession(row: import("../db/schema.js").WorkSessionRow): WorkSession;
}) {
  const { projectIdForWorkspace, enrichSession } = deps;

  return {

    listPendingReviews(workspaceSessionId?: string, limit = 20): WorkSession[] {
      const statusFilter = sql`${workSessions.status} IN ('awaiting_review', 'review_in_progress')
        and ${workSessions.runtimeState} <> 'stale'
        and datetime(${workSessions.updatedAt}) >= datetime('now', '-30 days')`;
      const projectId = workspaceSessionId ? projectIdForWorkspace(workspaceSessionId) : undefined;
      const condition = workspaceSessionId
        ? and(statusFilter, projectId ? eq(workSessions.projectId, projectId) : eq(workSessions.workspaceSessionId, workspaceSessionId))
        : statusFilter;

      const rows = db.db
        .select()
        .from(workSessions)
        .where(condition)
        .orderBy(desc(workSessions.updatedAt))
        .limit(limit)
        .all();

      return rows.map((row) => enrichSession(row));
    },

    listActiveWorkSessions(workspaceSessionId?: string, limit = 50): WorkSession[] {
      return this.listLiveWorkSessions(workspaceSessionId, limit);
    },

    listLiveWorkSessions(workspaceSessionId?: string, limit = 50): WorkSession[] {
      const liveState = or(
        sql`${workSessions.runtimeState} = 'running'`,
        sql`${workSessions.runtimeState} = 'pending' AND ${workSessions.status} IN ('in_progress', 'drafting', 'resuming') AND datetime(${workSessions.updatedAt}) >= datetime('now', '-1 hour')`,
      );
      const projectId = workspaceSessionId ? projectIdForWorkspace(workspaceSessionId) : undefined;
      const condition = workspaceSessionId
        ? and(liveState, projectId ? eq(workSessions.projectId, projectId) : eq(workSessions.workspaceSessionId, workspaceSessionId))
        : liveState;
      const rows = db.db
        .select()
        .from(workSessions)
        .where(condition)
        .orderBy(desc(workSessions.updatedAt))
        .limit(limit)
        .all();

      return rows.map((row) => enrichSession(row));
    },

    listRecoverableWorkSessions(workspaceSessionId?: string, limit = 50): WorkSession[] {
      const recoverableState = sql`${workSessions.runtimeState} IN ('detached', 'stale', 'orphaned')`;
      const projectId = workspaceSessionId ? projectIdForWorkspace(workspaceSessionId) : undefined;
      const condition = workspaceSessionId
        ? and(recoverableState, projectId ? eq(workSessions.projectId, projectId) : eq(workSessions.workspaceSessionId, workspaceSessionId))
        : recoverableState;
      const rows = db.db.select().from(workSessions).where(condition).orderBy(desc(workSessions.updatedAt)).limit(limit).all();
      return rows.map((row) => enrichSession(row));
    },

    listStaleWorkSessions(workspaceSessionId?: string, limit = 50): WorkSession[] {
      const staleState = sql`${workSessions.runtimeState} IN ('stale', 'orphaned')`;
      const projectId = workspaceSessionId ? projectIdForWorkspace(workspaceSessionId) : undefined;
      const condition = workspaceSessionId
        ? and(staleState, projectId ? eq(workSessions.projectId, projectId) : eq(workSessions.workspaceSessionId, workspaceSessionId))
        : staleState;
      const rows = db.db.select().from(workSessions).where(condition).orderBy(desc(workSessions.updatedAt)).limit(limit).all();
      return rows.map((row) => enrichSession(row));
    },

    listAllWorkSessions(workspaceSessionId?: string, limit = 200): WorkSession[] {
      const condition = workspaceSessionId
        ? eq(workSessions.workspaceSessionId, workspaceSessionId)
        : undefined;

      const rows = db.db
        .select()
        .from(workSessions)
        .where(condition ?? sql`1=1`)
        .orderBy(desc(workSessions.updatedAt))
        .limit(limit)
        .all();

      return rows.map((row) => enrichSession(row));
    },

    getWorkspaceSessionSurface(
      workspaceSessionId?: string,
      limit = 50,
      filter: "all" | "pending_review" | "stale_pending_review" | "live" = "all",
      after?: WorkspaceSessionSurfaceCursor,
    ): WorkspaceSessionSurfaceEntry[] {
      const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
      const projectId = workspaceSessionId ? projectIdForWorkspace(workspaceSessionId) : undefined;
      const scopeSql = workspaceSessionId
        ? projectId ? "ws.project_id = ?" : "ws.workspace_session_id = ?"
        : "1 = 1";
      const scopeParam = workspaceSessionId ? (projectId ?? workspaceSessionId) : undefined;
      const rows = db.sqlite.prepare(`
        select
          ws.id as session_id,
          ws.workspace_session_id,
          ws.status,
          ws.runtime_state,
          ws.title,
          ws.submitted_by,
          ws.updated_at,
          (select ar.run_id from acp_runs ar where ar.work_session_id = ws.id order by ar.created_at desc, ar.run_id desc limit 1) as run_id,
          (select ar.last_heartbeat_at from acp_runs ar where ar.work_session_id = ws.id order by ar.created_at desc, ar.run_id desc limit 1) as last_heartbeat_at,
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
          (select f.id from work_session_feedback f join work_session_submissions s on s.id = f.submission_id where f.work_session_id = ws.id order by s.submission_number desc, s.review_epoch desc, f.id desc limit 1) as latest_feedback_id,
          (select f.submission_id from work_session_feedback f join work_session_submissions s on s.id = f.submission_id where f.work_session_id = ws.id order by s.submission_number desc, s.review_epoch desc, f.id desc limit 1) as latest_feedback_submission_id,
          (select f.verdict from work_session_feedback f join work_session_submissions s on s.id = f.submission_id where f.work_session_id = ws.id order by s.submission_number desc, s.review_epoch desc, f.id desc limit 1) as latest_feedback_verdict,
          (select f.comments from work_session_feedback f join work_session_submissions s on s.id = f.submission_id where f.work_session_id = ws.id order by s.submission_number desc, s.review_epoch desc, f.id desc limit 1) as latest_feedback_comments,
          (select f.reviewer_id from work_session_feedback f join work_session_submissions s on s.id = f.submission_id where f.work_session_id = ws.id order by s.submission_number desc, s.review_epoch desc, f.id desc limit 1) as latest_feedback_reviewer_id
        from work_sessions ws
        where ${scopeSql}
          ${after ? "and (ws.updated_at < ? or (ws.updated_at = ? and ws.id < ?))" : ""}
          and ${filter === "pending_review"
            ? "ws.status in ('awaiting_review', 'review_in_progress') and ws.runtime_state <> 'stale' and datetime(ws.updated_at) >= datetime('now', '-30 days')"
            : filter === "stale_pending_review"
              ? "ws.status in ('awaiting_review', 'review_in_progress') and datetime(ws.updated_at) < datetime('now', '-30 days')"
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
          lastHeartbeatAt: typeof row.last_heartbeat_at === "string" ? row.last_heartbeat_at : undefined,
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
    },

    getWorkspaceEventCursor(workspaceSessionId?: string): number {
      if (!workspaceSessionId) {
        const row = db.sqlite.prepare("select coalesce(max(seq), 0) as seq from event_log").get() as { seq?: number } | undefined;
        return Number(row?.seq ?? 0);
      }
      const projectId = projectIdForWorkspace(workspaceSessionId);
      const row = db.sqlite.prepare(`
        select coalesce(max(el.seq), 0) as seq
        from event_log el
        where el.workspace_session_id = ?
           or el.workspace_session_id in (select id from workspace_sessions where project_id = ?)
      `).get(workspaceSessionId, projectId ?? workspaceSessionId) as { seq?: number } | undefined;
      return Number(row?.seq ?? 0);
    },

    countActiveWorkSessions(): number {
      const result = db.db
        .select({ count: sql<number>`count(*)` })
        .from(workSessions)
        .where(or(
          sql`${workSessions.runtimeState} = 'running'`,
          sql`${workSessions.runtimeState} = 'pending' AND ${workSessions.status} IN ('in_progress', 'drafting', 'resuming') AND datetime(${workSessions.updatedAt}) >= datetime('now', '-1 hour')`,
        ))
        .get();
      return result?.count ?? 0;
    },

    countPendingReviews(): number {
      const result = db.db
        .select({ count: sql<number>`count(*)` })
        .from(workSessions)
        .where(sql`${workSessions.status} IN ('awaiting_review', 'review_in_progress')
          and ${workSessions.runtimeState} <> 'stale'
          and datetime(${workSessions.updatedAt}) >= datetime('now', '-30 days')`)
        .get();
      return result?.count ?? 0;
    }

    /** P2 #10: Active-session projection with all needed fields in one query. */,

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
      const projectId = workspaceSessionId ? projectIdForWorkspace(workspaceSessionId) : undefined;
      const condition = workspaceSessionId
        ? and(liveState, projectId ? eq(workSessions.projectId, projectId) : eq(workSessions.workspaceSessionId, workspaceSessionId))
        : liveState;

      const rows = db.db
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
     */,

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

      const rows = db.db
        .select({ id: workSessions.id })
        .from(workSessions)
        .where(condition)
        .orderBy(workSessions.id)
        .limit(boundedLimit)
        .all();
      return rows.map((row) => row.id);
    },
  };
}

export type WorkSessionQueries = ReturnType<typeof createWorkSessionQueries>;
