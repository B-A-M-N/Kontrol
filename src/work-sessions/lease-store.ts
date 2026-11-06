/**
 * WorkspaceLeaseStore: checkout-modify lease acquire/renew/release
 *
 * Extracted from SqliteWorkSessionManager (P1 god-object decomposition).
 * Ordinary acquisition renews the same owner without changing its nonce;
 * explicit same-session takeover rotates the fence transactionally. Shares
 * the caller's DatabaseHandle.
 */
import { randomUUID } from "node:crypto";
import { eq, and, gte, ne, sql } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client.js";
import { workspaceLeases } from "../db/schema.js";
import type { WorkspaceLease, WorkspaceLeaseResult } from "./types.js";
import { rowToWorkspaceLease } from "./internal.js";
import { findLinuxProcessSessionRunnerOwners, linuxProcessOwnerInstanceId, parseLinuxProcessOwnerInstanceId, linuxProcessIdentity } from "../process-session-runner.js";

function reconcileResolvedCleanupLeases(db: DatabaseHandle): void {
  if (process.platform !== "linux") return;
  const pending = db.sqlite.prepare("select work_session_id as workSessionId, owner_instance_id as ownerInstanceId from workspace_leases where lease_kind = 'cleanup_pending'")
    .all() as Array<{ workSessionId: string; ownerInstanceId: string }>;
  const parsed = pending.map((lease) => ({ lease, owner: parseLinuxProcessOwnerInstanceId(lease.ownerInstanceId) }))
    .filter((entry): entry is { lease: typeof pending[number]; owner: { pid: number; identity: string } } => entry.owner !== undefined);
  const deadOwners = [...new Map(parsed
    .filter(({ owner }) => linuxProcessIdentity(owner.pid) !== owner.identity)
    .map(({ owner }) => [`${owner.pid}:${owner.identity}`, owner])).values()];
  const runners = findLinuxProcessSessionRunnerOwners(deadOwners);
  for (const lease of pending) {
    const owner = parseLinuxProcessOwnerInstanceId(lease.ownerInstanceId);
    if (!owner) continue; // Legacy or malformed ownership remains fenced.
    if (linuxProcessIdentity(owner.pid) === owner.identity) continue;
    if (runners.has(`${owner.pid}:${owner.identity}`)) continue;
    db.sqlite.prepare("delete from workspace_leases where work_session_id = ? and owner_instance_id = ? and lease_kind = 'cleanup_pending'")
      .run(lease.workSessionId, lease.ownerInstanceId);
  }
}

export function createWorkspaceLeaseStore(db: DatabaseHandle) {
  return {
    acquireWorkspaceLease(input: {
      canonicalRoot: string;
      workspaceSessionId: string;
      workSessionId: string;
      ownerInstanceId?: string;
      ttlMs?: number;
      takeover?: boolean;
      leaseKind?: "modify" | "peer_job" | "cleanup_pending";
    }): WorkspaceLeaseResult {
      const now = new Date();
      const nowIso = now.toISOString();
      const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 60 * 60 * 1000)).toISOString();
      const ownerInstanceId = input.ownerInstanceId ?? linuxProcessOwnerInstanceId(process.pid) ?? process.pid.toString();

      return db.db.transaction(() => {
        reconcileResolvedCleanupLeases(db);
        db.db
          .delete(workspaceLeases)
          .where(sql`${workspaceLeases.expiresAt} < ${nowIso} and ${workspaceLeases.leaseKind} not in ('peer_job', 'cleanup_pending')`)
          .run();

        const existing = db.db
          .select()
          .from(workspaceLeases)
          .where(eq(workspaceLeases.canonicalRoot, input.canonicalRoot))
          .get();

        const requestedLeaseKind = input.leaseKind ?? "modify";
        if (existing?.leaseKind === "cleanup_pending") {
          // A cleanup-pending fence is non-acquirable for ordinary mutations by
          // ANY work-session identity, including the fenced session itself.
          // The reconciler above is the only path that clears it, and only
          // after verified process termination.
          return {
            acquired: false as const,
            conflictingWorkSessionId: existing.workSessionId,
            workspaceSessionId: existing.workspaceSessionId,
            expiresAt: existing.expiresAt,
            durableRecovery: true,
          };
        }
        if (existing?.leaseKind === "peer_job") {
          // A peer result reservation is a checkout-wide fence. Same-session
          // ACP workers cannot renew through it; only the matching durable
          // peer-job owner may idempotently renew/recover the reservation.
          if (
            requestedLeaseKind !== "peer_job" ||
            existing.workSessionId !== input.workSessionId ||
            existing.workspaceSessionId !== input.workspaceSessionId ||
            existing.ownerInstanceId !== ownerInstanceId
          ) {
            return {
              acquired: false as const,
              conflictingWorkSessionId: existing.workSessionId,
              workspaceSessionId: existing.workspaceSessionId,
              expiresAt: existing.expiresAt,
              durableRecovery: true,
            };
          }
        } else if (requestedLeaseKind === "peer_job" && existing) {
          // Do not reserve a checkout while any ordinary worker owns it,
          // including a worker attached to the same logical work session.
          return {
            acquired: false as const,
            conflictingWorkSessionId: existing.workSessionId,
            workspaceSessionId: existing.workspaceSessionId,
            expiresAt: existing.expiresAt,
            durableRecovery: existing.leaseKind === "peer_job" || existing.leaseKind === "cleanup_pending",
          };
        }

        if (existing && existing.workSessionId !== input.workSessionId) {
          return {
            acquired: false as const,
            conflictingWorkSessionId: existing.workSessionId,
            workspaceSessionId: existing.workspaceSessionId,
            expiresAt: existing.expiresAt,
            durableRecovery: existing.leaseKind === "peer_job" || existing.leaseKind === "cleanup_pending",
          };
        }

        if (existing) {
          db.db
            .update(workspaceLeases)
            .set({
              heartbeatAt: nowIso,
              expiresAt,
              ...(requestedLeaseKind === "peer_job" ? { ownerInstanceId, leaseKind: "peer_job" } : {}),
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
              leaseKind: requestedLeaseKind,
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
          ne(workspaceLeases.leaseKind, "cleanup_pending"),
        ))
        .run();
      return result.changes > 0;
    },

    markWorkspaceLeaseCleanupPending(workSessionId: string): number {
      // A peer-job reservation is owned by the peer job, not by the (now
      // terminal) worker session. Converting it to cleanup_pending would let
      // the reconciler delete it once its owner instance looks "resolved",
      // destroying the durable peer fence. Peer reservations stay peer_job
      // until the peer processor releases them by nonce.
      const result = db.db.update(workspaceLeases)
        .set({ leaseKind: "cleanup_pending" })
        .where(and(
          eq(workspaceLeases.workSessionId, workSessionId),
          ne(workspaceLeases.leaseKind, "peer_job"),
        ))
        .run();
      return result.changes;
    },

    releaseWorkspaceLeasesForSession(workSessionId: string): number {
      // Never deletes a peer-job reservation: those are released only by the
      // peer processor through the nonce-checked path.
      const result = db.sqlite
        .prepare("delete from workspace_leases where work_session_id = ? and lease_kind != 'peer_job'")
        .run(workSessionId);
      return result.changes;
    },

    releaseWorkspaceLeaseForSession(workSessionId: string, leaseNonce: string): boolean {
      if (!leaseNonce) return false;
      // Verified-recovery-only: a cleanup-pending fence cannot be cleared by
      // an ordinary nonce-checked release either.
      const result = db.sqlite
        .prepare("delete from workspace_leases where work_session_id = ? and lease_nonce = ? and lease_kind != 'cleanup_pending'")
        .run(workSessionId, leaseNonce);
      return result.changes > 0;
    },

    /**
     * Best-effort rollback release for unverified call sites (dispatch
     * rollback, continuation failure). Never deletes a cleanup-pending fence —
     * the fence outlives the rollback until verified termination clears it.
     */
    releaseUnfencedWorkspaceLeasesForSession(workSessionId: string): number {
      const result = db.sqlite
        .prepare("delete from workspace_leases where work_session_id = ? and lease_kind not in ('cleanup_pending', 'peer_job')")
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
          // A cleanup-pending fence is never renewable; only verified
          // recovery clears it.
          ne(workspaceLeases.leaseKind, "cleanup_pending"),
        ))
        .run();
      return result.changes;
    },

    getActiveWorkspaceLease(canonicalRoot: string): WorkspaceLease | undefined {
      reconcileResolvedCleanupLeases(db);
      const nowIso = new Date().toISOString();
      const lease = db.db
        .select()
        .from(workspaceLeases)
        .where(and(
          eq(workspaceLeases.canonicalRoot, canonicalRoot),
          // Durable recovery reservations never degrade by expiry alone.
          // Parentheses are load-bearing: AND binds tighter than OR in SQL.
          sql`(${workspaceLeases.leaseKind} in ('peer_job', 'cleanup_pending') or ${gte(workspaceLeases.expiresAt, nowIso)})`,
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
