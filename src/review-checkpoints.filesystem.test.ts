import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewCheckpointManager } from "./review-checkpoints.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-review-fs-"));
const storeRoot = mkdtempSync(join(tmpdir(), "kontrol-review-fs-store-"));
const outside = mkdtempSync(join(tmpdir(), "kontrol-review-fs-outside-"));
writeFileSync(join(outside, "secret.txt"), "must not be captured through the link\n");
mkdirSync(join(root, "nested"));
writeFileSync(join(root, "tracked.txt"), "before\n");
symlinkSync(join(outside, "secret.txt"), join(root, "external-link"));

const manager = createReviewCheckpointManager({ snapshotStoreRoot: storeRoot });
const workspaceId = "plain-workspace";
const info = await manager.getSnapshotInfo({ workspaceId, root });
assert.deepEqual(info, { kind: "filesystem", available: true, diagnostic: undefined });
const baseline = await manager.reviewChanges({ workspaceId, root, since: "workspace_open", markReviewed: false });
assert.equal(baseline.snapshotKind, "filesystem");
assert.match(baseline.snapshotRef, /^fs:sha256:[a-f0-9]{64}$/);

writeFileSync(join(root, "tracked.txt"), "after\nline two\n");
writeFileSync(join(root, "added.txt"), "new\n");
writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
writeFileSync(join(root, "large.txt"), "x".repeat(200_000));

const sessionDiff = await manager.reviewChangesAgainstSnapshot({ workspaceId, root, baseline: baseline.snapshot });
assert.deepEqual(sessionDiff.files.map((file) => file.path), ["added.txt", "binary.bin", "large.txt", "tracked.txt"]);
assert.ok(sessionDiff.files.every((file) => file.type === "new" || file.type === "change"));
assert.match(sessionDiff.patch, /Binary files a\/binary\.bin and b\/binary\.bin differ/);
assert.match(sessionDiff.patch, /filesystem diff truncated|old file truncated|new file truncated/);
assert.ok(sessionDiff.summary.files >= 4);

const sessionBaseline = await manager.reviewChanges({ workspaceId, root, since: "work_session", workSessionId: "session-a", markReviewed: false });
await manager.commitReviewedSnapshot({ workspaceId, root, workSessionId: "session-a", snapshot: sessionBaseline.snapshot });
assert.equal(await manager.assertSnapshotMatches({ workspaceId, root, expected: sessionBaseline.snapshot }), true);
writeFileSync(join(root, "tracked.txt"), "later\n");
assert.equal(await manager.assertSnapshotMatches({ workspaceId, root, expected: sessionBaseline.snapshot }), false);

await manager.commitReviewedSnapshot({ workspaceId, root, workSessionId: "session-a", snapshot: await manager.reviewChanges({ workspaceId, root, since: "work_session", workSessionId: "session-a", markReviewed: false }).then((result) => result.snapshot) });
await import("node:fs/promises").then(({ rm }) => rm(join(root, "added.txt")));
const deletion = await manager.reviewChanges({ workspaceId, root, since: "work_session", workSessionId: "session-a", markReviewed: false });
assert.equal(deletion.files.find((file) => file.path === "added.txt")?.type, "deleted");

const materialized = mkdtempSync(join(tmpdir(), "kontrol-review-fs-materialized-"));
await manager.materializeSnapshot({ workspaceId, root, snapshot: sessionDiff.snapshot, destination: materialized });
assert.equal(await readFile(join(materialized, "tracked.txt"), "utf8"), "after\nline two\n");
assert.equal((await stat(join(materialized, "external-link"))).isFile(), true);

console.log("review-checkpoints.filesystem: all assertions passed");

// --- Manager-level scenario 11 (mutation-before-baseline barrier) ---
// `awaitWorkspaceReady` must not resolve until the initial filesystem baseline
// is fully established and persisted. Any mutation issued AFTER readiness is
// therefore necessarily ordered after the baseline, so it can never be
// swallowed into top-of-workspace.
{
  const wsRoot = mkdtempSync(join(tmpdir(), "kontrol-mutation-barrier-ws-"));
  const wsStore = mkdtempSync(join(tmpdir(), "kontrol-mutation-barrier-store-"));
  writeFileSync(join(wsRoot, "seed.txt"), "stable\n");
  const mgr = createReviewCheckpointManager({ snapshotStoreRoot: wsStore });

  // Order probe: init-done MUST precede ready (awaitWorkspaceReady blocks on
  // initialization completion, not merely its start).
  const order: string[] = [];
  const initP = mgr.initializeWorkspace({ workspaceId: "barrier-ws", root: wsRoot }).then(() => order.push("init-done"));
  await mgr.awaitWorkspaceReady({ workspaceId: "barrier-ws", root: wsRoot });
  order.push("ready");
  await initP;
  assert.deepEqual(order, ["init-done", "ready"], "awaitWorkspaceReady waits for initialization to finish");

  // Capture the seed-only snapshot as the reference baseline BEFORE mutating.
  const seedBase = await mgr.reviewChanges({ workspaceId: "barrier-ws", root: wsRoot, since: "workspace_open", markReviewed: false });
  assert.match(seedBase.snapshotRef, /^fs:sha256:/);

  // Now that readiness AND the seed baseline are established, a mutation is
  // strictly after the baseline: it must surface as a change, never be baked in.
  writeFileSync(join(wsRoot, "post-ready.txt"), "after baseline\n");
  const diff = await mgr.reviewChangesAgainstSnapshot({ workspaceId: "barrier-ws", root: wsRoot, baseline: seedBase.snapshot });
  assert.ok(
    diff.files.some((f) => f.path === "post-ready.txt" && f.type === "new"),
    "mutation after readiness reported as a change, not baked into the baseline",
  );
  assert.ok(
    diff.files.every((f) => f.path !== "seed.txt"),
    "pre-baseline seed is not reported as changed",
  );

  await mgr.drain();
}

// --- Manager-level scenario 6 (persisted-baseline reuse) ---
// Recreating the manager must load the persisted baseline without a fresh
// capture of a mutated tree, so a readiness barrier after restart sees the
// ORIGINAL baseline (design boundary), and no stray blob is created.
{
  const wsRoot = mkdtempSync(join(tmpdir(), "kontrol-reuse-ws-"));
  const wsStore = mkdtempSync(join(tmpdir(), "kontrol-reuse-store-"));
  writeFileSync(join(wsRoot, "tracked.txt"), "v1\n");
  const mgr1 = createReviewCheckpointManager({ snapshotStoreRoot: wsStore });
  await mgr1.awaitWorkspaceReady({ workspaceId: "reuse-ws", root: wsRoot });
  // `reviewChanges` captures the current tree; capture it BEFORE the mutation
  // so base1.ref equals the seed-only (open) baseline's content.
  const base1 = await mgr1.reviewChanges({ workspaceId: "reuse-ws", root: wsRoot, since: "workspace_open", markReviewed: false });
  const store = mgr1.getSnapshotStore();
  const persisted1 = await store.loadBaselines("reuse-ws");
  assert.equal(persisted1?.open.ref, base1.snapshotRef, "open baseline holds the initial seed capture");
  const blobsAfterInit = (await store.storeStats()).blobs;
  await mgr1.drain();

  // Mutate the workspace, then restart the manager.
  writeFileSync(join(wsRoot, "tracked.txt"), "v2\n");
  const mgr2 = createReviewCheckpointManager({ snapshotStoreRoot: wsStore });
  await mgr2.awaitWorkspaceReady({ workspaceId: "reuse-ws", root: wsRoot });
  const store2 = mgr2.getSnapshotStore();
  // Reuse proof: no unused capture happened on init (blob count unchanged) and
  // the persisted open baseline is still the ORIGINAL seed capture, not a
  // fresh capture of the mutated tree.
  assert.equal((await store2.storeStats()).blobs, blobsAfterInit, "no unused recapture blob on reinit with a valid persisted baseline");
  const persisted2 = await store2.loadBaselines("reuse-ws");
  assert.equal(persisted2?.open.ref, base1.snapshotRef, "reinit reuses the persisted open baseline (seed tree), not a recapture of the v2 tree");
  // The v2 mutation is NOT the baseline content.
  assert.notEqual(persisted2?.open.ref, (await mgr2.reviewChanges({ workspaceId: "reuse-ws", root: wsRoot, since: "last_review", markReviewed: false })).snapshotRef);
  await mgr2.drain();
}

console.log("review-checkpoints.filesystem: extension scenarios passed");
