/**
 * MaintenanceCoordinator: the periodic bounded maintenance loop (event
 * compaction, approval expiry, mutation-receipt reconciliation, filesystem
 * snapshot GC + stale session-pin pruning, DB checkpoint).
 *
 * Extracted verbatim from server.ts's createServer closure (P0 refactor). The
 * coordinator owns its timer and stats; createServer consumes
 * `maintenance.stats` for /diagnostics and calls `maintenance.stop()` on
 * shutdown.
 */
import { performance } from "node:perf_hooks";
import { logEvent } from "../logger.js";
import type { ServerConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import type { FilesystemSnapshotStore } from "../filesystem-snapshot-store.js";
import type { ReviewCheckpointManager } from "../review-checkpoints.js";

/** Canonical terminal work-session statuses (shared with server.ts). */
export const terminalWorkSessionStatuses = new Set(["approved", "rejected", "cancelled", "failed", "failed_protocol"]);

export interface MaintenanceDeps {
  config: ServerConfig;
  db?: DatabaseHandle;
  workSessions: {
    reconcileRuntimeStates(cursor: string | undefined, pageSize: number): { hasMore: boolean; nextAfterId?: string };
    listSessionIdsNeedingCompaction(cursor: string | undefined, pageSize: number): string[];
    get(workSessionId: string): { id: string } | undefined;
  };
  approvalRequests: {
    expirePending(reason: undefined, pageSize: number): Array<{ approvalId: string; workSessionId?: string }>;
  };
  eventStore: {
    appendEvent(event: { type: string; sessionId: string; payload: Record<string, unknown> }, opts?: { publish?: boolean }): unknown;
    compactSessionEvents(sessionId: string, opts: { retentionDays: number; maxRows: number }): number;
  };
  mutationReceipts: {
    reconcile(opts: { limit: number }): { pendingSample: unknown[]; pendingHasMore: boolean; deletedCompleted: number };
  };
  reviewCheckpoints: Pick<ReviewCheckpointManager, "getSnapshotStore">;
}

export function createMaintenanceCoordinator(deps: MaintenanceDeps) {
  const { config, db, workSessions, approvalRequests, eventStore, mutationReceipts, reviewCheckpoints } = deps;
  const reportMaintenanceFailure = (scope: string, error: unknown, fields: Record<string, unknown> = {}) => {
    const detail = error instanceof Error ? error.message : String(error);
    logEvent(config.logging, "error", "maintenance_failure", { scope, detail, ...fields });
    console.error(`[kontrol] maintenance failure (${scope}): ${detail}`);
  };

  // P1 #23: Periodic maintenance loop — event compaction, stale approval
  // reconciliation, and DB checkpoint. Runs every 5 minutes. Compaction is
  // deliberately chunked and yielded between sessions: a large historical
  // telemetry backlog must not monopolize the serving isolate.
  const MAINTENANCE_INTERVAL_MS = config.maintenanceIntervalMs;
  const MAINTENANCE_BUDGET_MS = config.maintenanceBudgetMs;
  const MAINTENANCE_PAGE_SIZE = 100;
  const COMPACT_PAGE_SIZE = 500;
  const COMPACT_BATCH_SIZE = 250;
  let maintenanceStopped = false;
  let maintenanceRunning = false;
  let runtimeReconciliationCursor: string | undefined;
  let compactionCursor: string | undefined;
  const maintenanceStats: {
    running: boolean;
    backlog: boolean;
    cycles: number;
    lastStartedAt?: string;
    lastCompletedAt?: string;
    lastDurationMs: number;
    maxDurationMs: number;
    compactedRows: number;
    pendingMutationReceipts: number;
    lastError?: string;
  } = {
    running: false,
    backlog: false,
    cycles: 0,
    lastDurationMs: 0,
    maxDurationMs: 0,
    compactedRows: 0,
    pendingMutationReceipts: 0,
  };

  // P0 #2: Durable filesystem snapshot roots held in SQLite. A submitted
  // snapshot may no longer be a current baseline yet still be required for
  // approval or immutable mission verification — so GC must root from these
  // tables, not just from the manifest directory.
  const collectFsSnapshotDbRoots = (): Array<{ ref: string; terminal?: boolean }> => {
    if (!db) return [];
    const roots: Array<{ ref: string; terminal?: boolean }> = [];
    try {
      const sqlite = db.sqlite;
      // work_session_submissions, terminal by owning work_session.status.
      const submissions = sqlite.prepare(
        "select wss.snapshot_ref as ref, ws.status as status from work_session_submissions wss left join work_sessions ws on ws.id = wss.work_session_id where wss.snapshot_kind = 'filesystem' and wss.snapshot_ref is not null",
      ).all() as Array<{ ref?: string; status?: string }>;
      for (const row of submissions) {
        if (row.ref) roots.push({ ref: row.ref, terminal: row.status ? terminalWorkSessionStatuses.has(row.status) : undefined });
      }
      // mission_evidence, mission_completion_reports: always strong pins.
      for (const table of ["mission_evidence", "mission_completion_reports"]) {
        const rows = sqlite.prepare(
          `select snapshot_ref as ref from ${table} where snapshot_kind = 'filesystem' and snapshot_ref is not null`,
        ).all() as Array<{ ref?: string }>;
        for (const row of rows) if (row.ref) roots.push({ ref: row.ref });
      }
      // supervisor_runs.last_snapshot_ref.
      const runs = sqlite.prepare(
        "select last_snapshot_ref as ref from supervisor_runs where last_snapshot_kind = 'filesystem' and last_snapshot_ref is not null",
      ).all() as Array<{ ref?: string }>;
      for (const row of runs) if (row.ref) roots.push({ ref: row.ref });
    } catch (error) {
      // A failed DB query must never abort maintenance: report and return an
      // empty root set so only the manifest/baseline roots are honored.
      reportMaintenanceFailure("snapshot_gc_db_roots", error);
    }
    return roots;
  };

  const snapshotGcSlice = async (
    store: FilesystemSnapshotStore,
    budgetMs: number,
    pageSize: number,
  ): Promise<{ result?: unknown; hasMore?: boolean; error?: string }> => {
    try {
      const { result, hasMore } = await store.gcSlice({
        budgetMs,
        pageSize,
        listDbSnapshots: collectFsSnapshotDbRoots,
        dryRun: false,
      });
      return { result, hasMore };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };

  // P1: Drop workspace-session baseline pins whose key is no longer a
  // nonterminal work session (terminal or gone). This is what lets GC actually
  // reclaim the blobs those stale pins were rooting.
  const pruneStaleSessionBaselines = async (): Promise<void> => {
    if (!db) return;
    const store = reviewCheckpoints.getSnapshotStore();
    try {
      const rows = db.sqlite.prepare(
        "select ws.id as work_session_id, ws.status as status, ws.workspace_session_id as wsid from work_sessions ws",
      ).all() as Array<{ work_session_id: string; status: string; wsid: string }>;
      const nonterminalByWorkspace = new Map<string, Set<string>>();
      for (const row of rows) {
        if (row.status && terminalWorkSessionStatuses.has(row.status)) continue;
        let set = nonterminalByWorkspace.get(row.wsid);
        if (!set) {
          set = new Set();
          nonterminalByWorkspace.set(row.wsid, set);
        }
        set.add(row.work_session_id);
      }
      for (const [workspaceId, nonterminal] of nonterminalByWorkspace) {
        await store.pruneSessionBaselines(workspaceId, nonterminal);
      }
    } catch (error) {
      reportMaintenanceFailure("snapshot_gc_prune_pins", error);
    }
  };

  const runMaintenanceCycle = (): void => {
    if (maintenanceStopped || maintenanceRunning) return;
    maintenanceRunning = true;
    maintenanceStats.running = true;
    maintenanceStats.cycles++;
    maintenanceStats.lastStartedAt = new Date().toISOString();
    maintenanceStats.lastError = undefined;
    const startedAt = performance.now();
    let page: string[] = [];
    let pageIndex = 0;
    let runtimeReconciliationDone = false;
    let approvalExpiryDone = false;
    let mutationReceiptReconciliationDone = false;
    let snapshotGcDone = false;

    const finish = (backlog: boolean): void => {
      const durationMs = Math.round(performance.now() - startedAt);
      maintenanceStats.running = false;
      maintenanceStats.backlog = backlog;
      maintenanceStats.lastDurationMs = durationMs;
      maintenanceStats.maxDurationMs = Math.max(maintenanceStats.maxDurationMs, durationMs);
      maintenanceStats.lastCompletedAt = new Date().toISOString();
      maintenanceRunning = false;
    };

    const step = async (): Promise<void> => {
      if (maintenanceStopped) {
        finish(false);
        return;
      }
      // Every expensive operation is a bounded batch. Stop the cycle at the
      // wall-clock budget and leave the cursor for the next maintenance tick.
      if (performance.now() - startedAt >= MAINTENANCE_BUDGET_MS) {
        finish(true);
        return;
      }
      try {
        // Every maintenance class advances in bounded pages. A page is still
        // synchronous SQLite work, but it cannot turn a large historical
        // database into an unbounded serving-thread sweep.
        if (!runtimeReconciliationDone) {
          const runtimePage = workSessions.reconcileRuntimeStates(runtimeReconciliationCursor, MAINTENANCE_PAGE_SIZE);
          runtimeReconciliationCursor = runtimePage.hasMore ? runtimePage.nextAfterId : undefined;
          runtimeReconciliationDone = !runtimePage.hasMore;
          setImmediate(step);
          return;
        }

        if (!approvalExpiryDone) {
          const expiredApprovals = approvalRequests.expirePending(undefined, MAINTENANCE_PAGE_SIZE);
          for (const approval of expiredApprovals) {
            const session = approval.workSessionId ? workSessions.get(approval.workSessionId) : undefined;
            if (!session) continue;
            try {
              eventStore.appendEvent({
                type: "recovery.approval.expired",
                sessionId: session.id,
                payload: { approvalId: approval.approvalId, reason: "approval timed out during maintenance" },
              }, { publish: false });
            } catch (error) {
              reportMaintenanceFailure("approval_expiry_event", error, { approvalId: approval.approvalId, sessionId: session.id });
            }
          }
          // An exactly full page may have another page behind it. Ask again on
          // the next yielded step; the second empty page closes the scan.
          approvalExpiryDone = expiredApprovals.length < MAINTENANCE_PAGE_SIZE;
          setImmediate(step);
          return;
        }

        if (!mutationReceiptReconciliationDone) {
          const receiptMaintenance = mutationReceipts.reconcile({ limit: MAINTENANCE_PAGE_SIZE });
          maintenanceStats.pendingMutationReceipts = receiptMaintenance.pendingSample.length
            + (receiptMaintenance.pendingHasMore ? MAINTENANCE_PAGE_SIZE : 0);
          // Pending rows are an inspection result, not a deletion cursor:
          // they remain until an operator reconciles the authoritative
          // mutation outcome. Only completed-row pruning determines whether
          // another bounded page is needed.
          mutationReceiptReconciliationDone = receiptMaintenance.deletedCompleted < MAINTENANCE_PAGE_SIZE;
          if (!mutationReceiptReconciliationDone) {
            setImmediate(step);
            return;
          }
        }

        if (!snapshotGcDone) {
          // P0 #2: Filesystem snapshot reachability GC, bounded by the same
          // wall-clock budget as the other maintenance classes. One gcSlice is
          // advanced per yielded step; if it reports more work, the next cycle
          // resumes (never monopolizing the serving thread).
          const store = reviewCheckpoints.getSnapshotStore();
          const slice = await snapshotGcSlice(store, MAINTENANCE_BUDGET_MS, MAINTENANCE_PAGE_SIZE);
          if (slice.error) {
            maintenanceStats.lastError = slice.error;
            reportMaintenanceFailure("snapshot_gc", slice.error);
            // Advance past the failing GC class so a corrupt store cannot wedge
            // all future maintenance; it is retried next cycle.
            snapshotGcDone = true;
            setImmediate(step);
            return;
          }
          const wasDone = snapshotGcDone;
          snapshotGcDone = !slice.hasMore;
          // Once a full GC pass completes, drop stale session baseline pins so
          // the blobs they rooted become reclaimable.
          if (!wasDone && snapshotGcDone) await pruneStaleSessionBaselines();
          setImmediate(step);
          return;
        }

        if (pageIndex >= page.length) {
          page = workSessions.listSessionIdsNeedingCompaction(compactionCursor, COMPACT_PAGE_SIZE);
          pageIndex = 0;
          if (page.length === 0) {
            // A complete pass starts over on the next cycle; an interrupted
            // pass retains its cursor across cycles so it cannot repeatedly
            // rescan the same prefix after a budget expiry.
            compactionCursor = undefined;
            finish(false);
            return;
          }
        }

        const sessionId = page[pageIndex];
        const removed = eventStore.compactSessionEvents(sessionId, {
          retentionDays: 7,
          maxRows: COMPACT_BATCH_SIZE,
        });
        maintenanceStats.compactedRows += removed;
        // Keep the cursor on this session while a bounded batch indicates
        // more historical telemetry remains. This avoids skipping rows while
        // still yielding to the HTTP server after every transaction.
        if (removed < COMPACT_BATCH_SIZE) {
          compactionCursor = sessionId;
          pageIndex++;
        }
      } catch (error) {
        maintenanceStats.lastError = error instanceof Error ? error.message : String(error);
        reportMaintenanceFailure("maintenance_cycle", error);
        pageIndex++;
      }
      setImmediate(step);
    };
    step();
  };
  const maintenanceTimer = setInterval(runMaintenanceCycle, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref?.();

  /** Stop the loop: no further cycles start; an in-flight cycle finishes its
   * current bounded step. */
  function stop(): void {
    maintenanceStopped = true;
    clearInterval(maintenanceTimer);
  }

  /** Seed the runtime-reconciliation cursor from startup recovery, so the
   * next maintenance cycle resumes where the startup pass left off instead of
   * rescanning the same prefix. */
  function resumeRuntimeReconciliationFrom(cursor: string | undefined): void {
    runtimeReconciliationCursor = cursor;
  }

  return { stats: maintenanceStats, stop, collectFsSnapshotDbRoots, resumeRuntimeReconciliationFrom };
}
