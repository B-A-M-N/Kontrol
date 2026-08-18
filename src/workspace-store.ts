import { eq, and, desc } from "drizzle-orm";
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
  createdAt: string;
  lastUsedAt: string;
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
      ? (mode ? and(eq(workspaceSessions.projectId, project.id), eq(workspaceSessions.mode, mode)) : eq(workspaceSessions.projectId, project.id))
      : (mode ? and(eq(workspaceSessions.root, root), eq(workspaceSessions.mode, mode)) : eq(workspaceSessions.root, root));
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
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}
