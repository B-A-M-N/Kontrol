import { eq, and, desc, lt, ne, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workspaceProjects,
  workspaceSessions,
  type WorkspaceSessionRow,
} from "./db/schema.js";

export type WorkspaceMode = "checkout" | "worktree";

export interface WorkspaceSession {
  id: string;
  projectId?: string;
  root: string;
  status: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  retiredAt?: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface ManagedWorktreeCursor {
  createdAt: string;
  id: string;
}

export interface ManagedWorktreePage {
  worktrees: WorkspaceSession[];
  nextCursor?: ManagedWorktreeCursor;
}

interface RawWorkspaceSessionRow {
  id: string;
  project_id: string | null;
  root: string;
  status: string;
  mode: string;
  source_root: string | null;
  base_ref: string | null;
  base_sha: string | null;
  managed: string;
  retired_at: string | null;
  created_at: string;
  last_used_at: string;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  touchSession(id: string): void;
  /** P0 #4: find most recent workspace for a canonical root (durability across restarts). */
  getLatestByCanonicalRoot(root: string, mode?: WorkspaceMode): WorkspaceSession | undefined;
  listByCanonicalRoot(root: string): WorkspaceSession[];
  countManagedWorktrees(sourceRoot?: string): number;
  listManagedWorktrees(input?: { includeRemoved?: boolean; limit?: number; before?: ManagedWorktreeCursor }): ManagedWorktreePage;
  listExpiredRetiredManagedWorktrees(retiredBefore: string, after?: { retiredAt: string; id: string }, limit?: number): WorkspaceSession[];
  retireManagedWorktree(id: string, runningProcesses?: number): { retired: boolean; blockers?: { workSessions: number; pendingReviews: number; pendingApprovals: number; runningProcesses?: number }; session?: WorkspaceSession };
  canRemoveRetiredManagedWorktree(id: string): boolean;
  markManagedWorktreeRemoved(id: string): boolean;
  getProjectIdForSession(id: string): string | undefined;
  close?(): void;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;
  /** P1 #8: in-memory cache of lastUsedAt to debounce SQLite writes. */
  private readonly lastUsedAtCache = new Map<string, number>();
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly FLUSH_INTERVAL_MS = 30_000;

  constructor(stateDirOrHandle: string | DatabaseHandle) {
    this.database =
      typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;
    // P1 #8: periodically flush the lastUsedAt cache to SQLite so reads
    // during shutdown still see current values.
    this.flushInterval = setInterval(() => this.flushLastUsedAtCache(), SqliteWorkspaceStore.FLUSH_INTERVAL_MS);
    this.flushInterval.unref?.();
  }

  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const projectRoot = input.mode === "worktree" && input.sourceRoot ? input.sourceRoot : input.root;
    const projectId = this.ensureProject(projectRoot, now);
    const session: WorkspaceSession = {
      id: input.id,
      projectId,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      managed: input.managed ?? false,
      createdAt: now,
      lastUsedAt: now,
    };

    this.database.db
      .insert(workspaceSessions)
      .values({
        id: session.id,
        projectId: session.projectId ?? null,
        root: session.root,
        status: session.status,
        mode: session.mode,
        sourceRoot: session.sourceRoot ?? null,
        baseRef: session.baseRef ?? null,
        baseSha: session.baseSha ?? null,
        managed: String(session.managed),
        retiredAt: null,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
      })
      .run();

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  /** P0 #4: find the most recently used workspace session for a canonical root. */
  getLatestByCanonicalRoot(root: string, mode?: WorkspaceMode): WorkspaceSession | undefined {
    const project = this.database.db
      .select({ id: workspaceProjects.id })
      .from(workspaceProjects)
      .where(eq(workspaceProjects.canonicalRoot, root))
      .get();
    const condition = project
      ? (mode ? and(eq(workspaceSessions.projectId, project.id), eq(workspaceSessions.mode, mode), eq(workspaceSessions.status, "active")) : and(eq(workspaceSessions.projectId, project.id), eq(workspaceSessions.status, "active")))
      : (mode ? and(eq(workspaceSessions.root, root), eq(workspaceSessions.mode, mode), eq(workspaceSessions.status, "active")) : and(eq(workspaceSessions.root, root), eq(workspaceSessions.status, "active")));
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(condition)
      .orderBy(desc(workspaceSessions.lastUsedAt))
      .limit(1)
      .get();
    return row ? rowToWorkspaceSession(row) : undefined;
  }

  listByCanonicalRoot(root: string): WorkspaceSession[] {
    const project = this.database.db
      .select({ id: workspaceProjects.id })
      .from(workspaceProjects)
      .where(eq(workspaceProjects.canonicalRoot, root))
      .get();
    const rows = this.database.db
      .select()
      .from(workspaceSessions)
      .where(project ? eq(workspaceSessions.projectId, project.id) : eq(workspaceSessions.root, root))
      .orderBy(desc(workspaceSessions.lastUsedAt))
      .all();
    return rows.map(rowToWorkspaceSession);
  }

  countManagedWorktrees(sourceRoot?: string): number {
    const conditions = [eq(workspaceSessions.mode, "worktree"), eq(workspaceSessions.managed, "true")];
    if (sourceRoot) {
      const project = this.database.db.select({ id: workspaceProjects.id })
        .from(workspaceProjects).where(eq(workspaceProjects.canonicalRoot, sourceRoot)).get();
      if (!project) return 0;
      conditions.push(eq(workspaceSessions.projectId, project.id));
    }
    const row = this.database.db.select({ count: sql<number>`count(*)` })
      .from(workspaceSessions)
      .where(and(...conditions, sql`${workspaceSessions.status} != 'removed'`))
      .get();
    return row?.count ?? 0;
  }

  listManagedWorktrees(input: { includeRemoved?: boolean; limit?: number; before?: ManagedWorktreeCursor } = {}): ManagedWorktreePage {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 32)));
    const conditions = [eq(workspaceSessions.mode, "worktree"), eq(workspaceSessions.managed, "true")];
    if (!input.includeRemoved) conditions.push(ne(workspaceSessions.status, "removed"));
    if (input.before) {
      conditions.push(or(
        lt(workspaceSessions.createdAt, input.before.createdAt),
        and(eq(workspaceSessions.createdAt, input.before.createdAt), lt(workspaceSessions.id, input.before.id)),
      )!);
    }
    const rows = this.database.db.select().from(workspaceSessions).where(and(...conditions))
      .orderBy(desc(workspaceSessions.createdAt), desc(workspaceSessions.id)).limit(limit + 1).all();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      worktrees: page.map(rowToWorkspaceSession),
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : undefined,
    };
  }

  listExpiredRetiredManagedWorktrees(retiredBefore: string, after?: { retiredAt: string; id: string }, limit = 1): WorkspaceSession[] {
    const boundedLimit = Math.max(1, Math.min(16, Math.trunc(limit)));
    const rows = after
      ? this.database.sqlite.prepare(`
          select * from workspace_sessions
           where mode = 'worktree' and managed = 'true' and status = 'retired'
             and retired_at is not null and retired_at <= ?
             and (retired_at > ? or (retired_at = ? and id > ?))
           order by retired_at asc, id asc limit ?
        `).all(retiredBefore, after.retiredAt, after.retiredAt, after.id, boundedLimit) as RawWorkspaceSessionRow[]
      : this.database.sqlite.prepare(`
          select * from workspace_sessions
           where mode = 'worktree' and managed = 'true' and status = 'retired'
             and retired_at is not null and retired_at <= ?
           order by retired_at asc, id asc limit ?
        `).all(retiredBefore, boundedLimit) as RawWorkspaceSessionRow[];
    return rows.map((row) => rowToWorkspaceSession({
      id: row.id,
      projectId: row.project_id,
      root: row.root,
      status: row.status,
      mode: row.mode,
      sourceRoot: row.source_root,
      baseRef: row.base_ref,
      baseSha: row.base_sha,
      managed: row.managed,
      retiredAt: row.retired_at,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    } as WorkspaceSessionRow));
  }

  retireManagedWorktree(id: string, runningProcesses = 0): { retired: boolean; blockers?: { workSessions: number; pendingReviews: number; pendingApprovals: number; runningProcesses?: number }; session?: WorkspaceSession } {
    const now = new Date().toISOString();
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.database.sqlite.prepare(`
        select id, mode, managed, status, retired_at
          from workspace_sessions
         where id = ?
      `).get(id) as { id: string; mode: string; managed: string; status: string; retired_at?: string | null } | undefined;
      if (!row || row.mode !== "worktree" || row.managed !== "true") {
        throw new Error(`Workspace ${id} is not a managed worktree`);
      }
      if (row.status !== "active") {
        return { retired: false, session: this.getSession(id) };
      }
      const workSessions = (this.database.sqlite.prepare(`
        select count(*) as count from work_sessions
         where workspace_session_id = ?
           and status not in ('approved', 'rejected', 'cancelled', 'failed', 'failed_protocol')
      `).get(id) as { count: number }).count;
      const pendingReviews = (this.database.sqlite.prepare(`
        select count(*) as count
          from work_session_submissions submissions
          join work_sessions sessions on sessions.id = submissions.work_session_id
         where sessions.workspace_session_id = ? and submissions.status = 'pending'
      `).get(id) as { count: number }).count;
      const pendingApprovals = (this.database.sqlite.prepare(`
        select count(*) as count from approval_requests
         where workspace_session_id = ? and status = 'pending'
      `).get(id) as { count: number }).count;
      const blockers = { workSessions, pendingReviews, pendingApprovals, ...(runningProcesses > 0 ? { runningProcesses } : {}) };
      if (workSessions + pendingReviews + pendingApprovals + runningProcesses > 0) return { retired: false, blockers };
      this.database.sqlite.prepare(`
        update workspace_sessions set status = 'retired', retired_at = ?, last_used_at = ?
         where id = ? and status = 'active'
      `).run(now, now, id);
      return { retired: true, session: this.getSession(id) };
    });
    return transaction.immediate();
  }

  markManagedWorktreeRemoved(id: string): boolean {
    return this.database.sqlite.transaction(() => {
      if (!this.canRemoveRetiredManagedWorktree(id)) return false;
      const result = this.database.sqlite.prepare(`
        update workspace_sessions set status = 'removed'
         where id = ? and mode = 'worktree' and managed = 'true' and status = 'retired'
      `).run(id);
      return result.changes === 1;
    }).immediate();
  }

  canRemoveRetiredManagedWorktree(id: string): boolean {
    const session = this.getSession(id);
    if (!session || session.mode !== "worktree" || !session.managed || session.status !== "retired") return false;
    const workSessions = (this.database.sqlite.prepare(`
      select count(*) as count from work_sessions
       where workspace_session_id = ?
         and status not in ('approved', 'rejected', 'cancelled', 'failed', 'failed_protocol')
    `).get(id) as { count: number }).count;
    const pendingReviews = (this.database.sqlite.prepare(`
      select count(*) as count
        from work_session_submissions submissions
        join work_sessions sessions on sessions.id = submissions.work_session_id
       where sessions.workspace_session_id = ? and submissions.status = 'pending'
    `).get(id) as { count: number }).count;
    const pendingApprovals = (this.database.sqlite.prepare(`
      select count(*) as count from approval_requests
       where workspace_session_id = ? and status = 'pending'
    `).get(id) as { count: number }).count;
    const otherActiveSession = (this.database.sqlite.prepare(`
      select count(*) as count from workspace_sessions
       where root = ? and id != ? and status = 'active'
    `).get(session.root, id) as { count: number }).count;
    return workSessions + pendingReviews + pendingApprovals + otherActiveSession === 0;
  }

  getProjectIdForSession(id: string): string | undefined {
    const row = this.database.db
      .select({ projectId: workspaceSessions.projectId })
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .get();
    return row?.projectId ?? undefined;
  }

  private ensureProject(canonicalRoot: string, now: string): string {
    const existing = this.database.db
      .select()
      .from(workspaceProjects)
      .where(eq(workspaceProjects.canonicalRoot, canonicalRoot))
      .get();
    if (existing) {
      this.database.db.update(workspaceProjects).set({ lastUsedAt: now }).where(eq(workspaceProjects.id, existing.id)).run();
      return existing.id;
    }
    const id = `project_${createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 24)}`;
    this.database.db.insert(workspaceProjects).values({ id, canonicalRoot, createdAt: now, lastUsedAt: now }).run();
    return id;
  }

  /** P1 #8: debounce writes by caching lastUsedAt in memory and flushing periodically. */
  touchSession(id: string): void {
    const now = Date.now();
    const last = this.lastUsedAtCache.get(id);
    // Only update the cache; SQLite write happens on flush.
    if (last && now - last < SqliteWorkspaceStore.FLUSH_INTERVAL_MS) {
      return;
    }
    this.lastUsedAtCache.set(id, now);
  }

  private flushLastUsedAtCache(): void {
    if (this.lastUsedAtCache.size === 0) return;
    const entries = [...this.lastUsedAtCache.entries()];
    this.lastUsedAtCache.clear();
    const now = new Date().toISOString();
    for (const [id] of entries) {
      try {
        this.database.db
          .update(workspaceSessions)
          .set({ lastUsedAt: now })
          .where(eq(workspaceSessions.id, id))
          .run();
      } catch {
        /* non-critical */
      }
    }
  }

  // P1 #11: Don't close shared DB handle - server owns it
  close(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.flushLastUsedAtCache();
    // Database is owned by the server, not by this manager
  }
}

export function createWorkspaceStore(stateDirOrHandle: string | DatabaseHandle): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDirOrHandle);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    projectId: row.projectId ?? undefined,
    root: row.root,
    status: row.status,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    managed: row.managed === "true",
    retiredAt: row.retiredAt ?? undefined,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}
