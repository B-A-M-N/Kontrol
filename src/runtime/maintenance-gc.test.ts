/**
 * P0: maintenance's snapshot-GC class must fail closed when the durable root
 * set cannot be enumerated. "Could not determine what is live" must degrade
 * into "reclaim nothing this cycle" — never into an implicit empty root set.
 *
 * End to end through the real coordinator: an injected DB failure (closed
 * handle, the failure a crashed/restarted deployment actually produces) makes
 * the pre-slice probe throw; the cycle must mark the degraded stats, skip the
 * GC slice entirely, and delete nothing. A subsequent healthy cycle reclaims
 * unpinned garbage while the DB-rooted submission survives.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { workspaceSessions, workSessions, workSessionSubmissions } from "../db/schema.js";
import { FilesystemSnapshotStore } from "../filesystem-snapshot-store.js";
import { createMaintenanceCoordinator, terminalWorkSessionStatuses } from "./maintenance.js";

function makeRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const baseConfig = {
  maintenanceIntervalMs: 5, // drive cycles from wall-clock ticks
  maintenanceBudgetMs: 5_000,
  logging: { level: "error", format: "text" },
} as never;

// Shared fixture: a real DB (submission-rooted snapshot) + a real store with
// one DB-rooted manifest and one unpinned manifest.
async function makeFixture() {
  const stateDir = makeRoot("kontrol-maint-gc-state-");
  const storeRoot = join(stateDir, "workspace-snapshots");
  const workspaceRoot = makeRoot("kontrol-maint-gc-ws-");
  const db = openDatabase(stateDir);
  const store = new FilesystemSnapshotStore({ storeRoot, limits: { orphanGraceMs: 0, retainPerWorkspace: 0 } });

  writeFileSync(join(workspaceRoot, "submitted.txt"), "submitted-content\n");
  const submitted = await store.capture(workspaceRoot);
  writeFileSync(join(workspaceRoot, "extra.txt"), "extra-content\n");
  const garbage = await store.capture(workspaceRoot);

  // Root the submission in SQLite: workspace + nonterminal work session + a
  // filesystem submission row. This is exactly the durable root the collector
  // must find (or refuse to GC without).
  const now = new Date().toISOString();
  db.db.insert(workspaceSessions).values({ id: "wss_maint_gc", root: "/tmp/kontrol-maint-gc-root", createdAt: now, lastUsedAt: now }).run();
  db.db.insert(workSessions).values({
    id: "ws_maint_gc", workspaceSessionId: "wss_maint_gc", status: "in_progress", runtimeState: "running",
    submittedBy: "test", createdAt: now, updatedAt: now,
  }).run();
  db.db.insert(workSessionSubmissions).values({
    id: "wssub_maint_gc", workSessionId: "ws_maint_gc", submissionNumber: 1,
    snapshotKind: "filesystem", snapshotRef: submitted.ref, reviewEpoch: 1, status: "pending", createdAt: now,
  }).run();

  const stubDeps = (handle: typeof db) => ({
    config: baseConfig,
    db: handle,
    workSessions: {
      reconcileRuntimeStates: () => ({ hasMore: false }),
      listSessionIdsNeedingCompaction: () => [] as string[],
      get: () => undefined,
    },
    approvalRequests: { expirePending: () => [] as never[] },
    eventStore: {
      appendEvent: () => undefined,
      compactSessionEvents: () => 0,
    },
    mutationReceipts: { reconcile: () => ({ pendingSample: [] as never[], pendingHasMore: false, deletedCompleted: 0 }) },
    reviewCheckpoints: { getSnapshotStore: () => store },
  });

  return {
    stateDir, store, db, stubDeps,
    submittedRef: submitted.ref,
    garbageRef: garbage.ref,
    async cleanup() {
      await store.close();
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}

{
  const fx = await makeFixture();

  // --- Phase A: injected DB failure (closed handle) ---
  fx.db.close(); // prepare() on a closed handle throws — a real DB outage

  const degraded = createMaintenanceCoordinator(fx.stubDeps(fx.db));
  await new Promise((resolve) => setTimeout(resolve, 80));
  degraded.stop();

  assert.equal(degraded.stats.snapshotRootsDegraded, true, "degraded flag set when root enumeration fails");
  assert.ok(degraded.stats.snapshotRootsLastError, "degraded error detail recorded");
  assert.equal(existsSync(fx.store.manifestPath(fx.garbageRef)), true, "fail-closed: garbage manifest NOT reclaimed while roots unknown");
  assert.equal(existsSync(fx.store.manifestPath(fx.submittedRef)), true, "submission manifest preserved");
  const statsDuringFailure = await fx.store.storeStats();
  const manifestsDuringFailure = statsDuringFailure.manifests;
  assert.equal(manifestsDuringFailure, 2, "zero manifests removed across degraded cycles");

  // --- Phase B: recovery — a healthy handle on the same store/DB ---
  const healthyDb = openDatabase(fx.stateDir);
  const healthy = createMaintenanceCoordinator(fx.stubDeps(healthyDb));
  await new Promise((resolve) => setTimeout(resolve, 120));
  healthy.stop();

  assert.equal(healthy.stats.snapshotRootsDegraded, false, "recovered cycle clears the degraded flag");
  assert.equal(existsSync(fx.store.manifestPath(fx.garbageRef)), false, "healthy cycle reclaims unpinned garbage");
  assert.equal(existsSync(fx.store.manifestPath(fx.submittedRef)), true, "DB-rooted submission survives healthy GC");
  const statsAfter = await fx.store.storeStats();
  assert.equal(statsAfter.manifests, 1, "exactly the DB-rooted manifest remains");

  healthyDb.close();
  await fx.cleanup();
}

// ---- Shared terminal-status set contract ----
{
  for (const status of ["approved", "rejected", "cancelled", "failed", "failed_protocol"]) {
    assert.ok(terminalWorkSessionStatuses.has(status), `terminal status ${status} registered`);
  }
  assert.ok(!terminalWorkSessionStatuses.has("in_progress"), "in_progress is not terminal");
  assert.ok(!terminalWorkSessionStatuses.has("awaiting_review"), "awaiting_review is not terminal");
}

console.log("runtime/maintenance-gc: all assertions passed");
