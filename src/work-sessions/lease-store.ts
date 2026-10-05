/**
 * WorkspaceLeaseStore: checkout-modify lease acquire/renew/release
 *
 * Extracted from SqliteWorkSessionManager (P1 god-object decomposition).
 * Ordinary acquisition renews the same owner without changing its nonce;
 * explicit same-session takeover rotates the fence transactionally. Shares
 * the caller's DatabaseHandle.
 */
import { randomUUID } from "node:crypto";
import { eq, and, gte, sql } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client.js";
import { workspaceLeases } from "../db/schema.js";
import type { WorkspaceLease, WorkspaceLeaseResult } from "./types.js";
import { rowToWorkspaceLease } from "./internal.js";

export function createWorkspaceLeaseStore(db: DatabaseHandle) {
  return {
    acquireWorkspaceLease(input: {
      canonicalRoot: string;
      workspaceSessionId: string;
      workSessionId: string;
      ownerInstanceId?: string;
      ttlMs?: number;
      takeover?: boolean;
    }): WorkspaceLeaseResult {
      const now = new Date();
      const nowIso = now.toISOString();
      const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 60 * 60 * 1000)).toISOString();
      const ownerInstanceId = input.ownerInstanceId ?? process.pid.toString();

      return db.db.transaction(() => {
        db.db
          .delete(workspaceLeases)
          .where(sql`${workspaceLeases.expiresAt} < ${nowIso}`)
          .run();

        const existing = db.db
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
          db.db
            .update(workspaceLeases)
            .set({
              heartbeatAt: nowIso,
              expiresAt,
              ...(input.takeover ? { ownerInstanceId, leaseNonce: randomUUID() } : {}),
            })
            .where(eq(workspaceLeases.canonicalRoot, input.canonicalRoot))
            .run();
        } else {
          const leaseNonce = randomUUID();
          db.db
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

        const lease = db.db
          .select()
          .from(workspaceLeases)
          .where(eq(workspaceLeases.canonicalRoot, input.canonicalRoot))
          .get();
        if (!lease) throw new Error("Workspace lease acquisition failed");
        return { acquired: true as const, lease: rowToWorkspaceLease(lease) };
      });
    },

    restoreWorkspaceLeaseForSession(previous: WorkspaceLease, expectedLeaseNonce: string): boolean {
      if (!expectedLeaseNonce || !previous.leaseNonce) return false;
      const result = db.db.update(workspaceLeases)
        .set({
          ownerInstanceId: previous.ownerInstanceId,
          leaseNonce: previous.leaseNonce,
          acquiredAt: previous.acquiredAt,
          heartbeatAt: previous.heartbeatAt,
          expiresAt: previous.expiresAt,
        })
        .where(and(
          eq(workspaceLeases.canonicalRoot, previous.canonicalRoot),
          eq(workspaceLeases.workSessionId, previous.workSessionId),
          eq(workspaceLeases.leaseNonce, expectedLeaseNonce),
        ))
        .run();
      return result.changes > 0;
    },

    releaseWorkspaceLeasesForSession(workSessionId: string): number {
      const result = db.sqlite
        .prepare("delete from workspace_leases where work_session_id = ?")
        .run(workSessionId);
      return result.changes;
    },

    renewWorkspaceLeaseForSession(workSessionId: string, ttlMs: number | undefined, leaseNonce: string): number {
      // A session ID is attribution, not proof that the caller still owns the
      // checkout. Renewal without the acquisition nonce would let a stale
      // worker extend a lease after another owner rotated the fence.
      if (!leaseNonce) return 0;
      const now = new Date();
      const nowIso = now.toISOString();
      const expiresAt = new Date(now.getTime() + (ttlMs ?? 60 * 60 * 1000)).toISOString();
      const result = db.db
        .update(workspaceLeases)
        .set({ heartbeatAt: nowIso, expiresAt })
        .where(and(
          eq(workspaceLeases.workSessionId, workSessionId),
          gte(workspaceLeases.expiresAt, nowIso),
          eq(workspaceLeases.leaseNonce, leaseNonce),
        ))
        .run();
      return result.changes;
    },

    getActiveWorkspaceLease(canonicalRoot: string): WorkspaceLease | undefined {
      const nowIso = new Date().toISOString();
      const lease = db.db
        .select()
        .from(workspaceLeases)
        .where(and(
          eq(workspaceLeases.canonicalRoot, canonicalRoot),
          gte(workspaceLeases.expiresAt, nowIso),
        ))
        .get();
      return lease ? rowToWorkspaceLease(lease) : undefined;
    },

    getWorkspaceLeaseForSession(workSessionId: string): WorkspaceLease | undefined {
      const lease = db.db
        .select()
        .from(workspaceLeases)
        .where(eq(workspaceLeases.workSessionId, workSessionId))
        .get();
      return lease ? rowToWorkspaceLease(lease) : undefined;
    },
  };
}

export type WorkspaceLeaseStore = ReturnType<typeof createWorkspaceLeaseStore>;
