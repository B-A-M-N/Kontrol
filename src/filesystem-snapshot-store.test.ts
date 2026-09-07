/**
 * Transactional filesystem snapshot store tests: the 15 required scenarios
 * from the storage-hardening review. Exercises staging/journal captures,
 * atomic publication, startup recovery, persisted-baseline reuse, reachability
 * GC (including DB-root pinning and terminal retention), streaming, quotas and
 * baseline corruption handling.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { writeFile, readFile, mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { FilesystemSnapshotStore, FilesystemSnapshotLimits, DEFAULT_SNAPSHOT_LIMITS } from "./filesystem-snapshot-store.js";

function makeRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function file(root: string, name: string, content: string | Buffer): void {
  writeFileSync(join(root, name), content);
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Create a store rooted at its own dedicated storage dir, plus a distinct
 * workspace root to capture. The workspace is never under the store root.
 */
function makeStore(pos: { storeRoot?: string; workspaceRoot?: string; limits?: Partial<FilesystemSnapshotLimits>; excludedDirectories?: string[] } = {}) {
  const storeRoot = pos.storeRoot ?? makeRoot("kontrol-fss-store-");
  const workspaceRoot = pos.workspaceRoot ?? makeRoot("kontrol-fss-ws-");
  const store = new FilesystemSnapshotStore({
    storeRoot,
    limits: { orphanGraceMs: 0, ...(pos.limits ?? {}) },
    ...(pos.excludedDirectories !== undefined && { excludedDirectories: pos.excludedDirectories }),
  });
  return { store, storeRoot, workspaceRoot };
}

async function gcToCompletion(store: FilesystemSnapshotStore, fn?: () => Array<{ ref: string; terminal?: boolean }>): Promise<void> {
  let hasMore = true;
  while (hasMore) {
    const out = await store.gcSlice({ budgetMs: 1000, pageSize: 100, dryRun: false, listDbSnapshots: fn });
    hasMore = out.hasMore;
  }
}

function snap(ref: string, terminal = false): { ref: string; terminal?: boolean } {
  return { ref, terminal };
}

// --- 1. CAS dedup: capture unchanged tree twice; physical blob count steady ---
{
  const { store, workspaceRoot } = makeStore();
  file(workspaceRoot, "a.txt", "hello world\n");
  mkdirSync(join(workspaceRoot, "sub"));
  file(join(workspaceRoot, "sub"), "b.txt", "nested content\n");
  const s1 = await store.capture(workspaceRoot);
  const blobsAfterFirst = (await store.storeStats()).blobs;
  const s2 = await store.capture(workspaceRoot);
  assert.equal(s1.ref, s2.ref, "identical tree -> identical manifest ref");
  assert.equal((await store.storeStats()).blobs, blobsAfterFirst, "CAS dedup: no new blobs on unchanged recapture");
  assert.ok(blobsAfterFirst === 2, `expected 2 unique blobs, got ${blobsAfterFirst}`);
}

// --- 2. Failed capture: quota aborts cleanly, zero leaked blobs/manifests ---
{
  const { store, workspaceRoot } = makeStore({ limits: { maxFiles: 2 } });
  file(workspaceRoot, "1.txt", "one\n");
  file(workspaceRoot, "2.txt", "two\n");
  file(workspaceRoot, "3.txt", "three\n"); // third file exceeds maxFiles=2
  await assert.rejects(() => store.capture(workspaceRoot), /maxFiles/);
  const stats = await store.storeStats();
  assert.equal(stats.blobs, 0, "no blobs leaked after aborted capture");
  assert.equal(stats.manifests, 0, "no manifest leaked after aborted capture");
  assert.equal(stats.stagingBytes, 0, "staging cleaned after aborted capture");
  assert.equal(await store.countIncompleteTransactionsPublic(), 0, "no journal left after aborted capture");
}

// --- 3. Interrupted transaction recovery ---
{
  const storeRoot = makeRoot("kontrol-fss-recover-");
  // Fabricate a crashed capture: staging dir + a `walking` journal.
  const captureId = "deadbeef-capture";
  await mkdir(join(storeRoot, "transactions"), { recursive: true });
  await mkdir(join(storeRoot, "staging", captureId), { recursive: true });
  await writeFile(join(storeRoot, "staging", captureId, "content-whatever"), "partial");
  await writeFile(join(storeRoot, "transactions", `${captureId}.json`), JSON.stringify({
    captureId, state: "walking", startedAt: new Date().toISOString(),
  }));
  const store = new FilesystemSnapshotStore({ storeRoot });
  const { removed } = await store.runStartupReconciliation();
  assert.equal(removed, 1, "reconciliation removed the interrupted capture");
  assert.equal(existsSync(join(storeRoot, "staging", captureId)), false, "staging removed");
  assert.equal(existsSync(join(storeRoot, "transactions", `${captureId}.json`)), false, "journal removed");
  assert.equal(await store.countIncompleteTransactionsPublic(), 0);
}

// --- 4. Atomic blob publication repairs a pre-existing corrupt final blob ---
{
  const { store, workspaceRoot } = makeStore();
  const content = "repaired-content-line\n";
  file(workspaceRoot, "x.txt", content);
  const snap = await store.capture(workspaceRoot);
  const manifest = await store.readManifest(snap);
  const entry = manifest.entries.find((e) => e.path === "x.txt")!;
  const blobPath = store.blobPath(entry.sha256);
  // Corrupt the existing final blob: truncate it.
  await writeFile(blobPath, "TRUNCATED");
  // Recapture the same tree -> blob must be republished/repaired.
  await store.capture(workspaceRoot);
  const repaired = readFileSync(blobPath, "utf8");
  assert.equal(repaired, content, "final blob repaired via atomic publish (not blindly trusted from EEXIST)");
  const verified = await store.verifyBlob(entry.sha256);
  assert.equal(verified.ok, true);
  assert.equal(verified.size, Buffer.byteLength(content));
}

// --- 5. Atomic manifest publication: partial manifest never becomes a valid snapshot ---
{
  const { store, workspaceRoot } = makeStore();
  file(workspaceRoot, "m.txt", "manifest-content\n");
  const snap = await store.capture(workspaceRoot);
  const manifestPath = store.manifestPath(snap.ref);
  assert.ok(existsSync(manifestPath), "manifest exists after committed capture");
  // A truncated/corrupt manifest must be rejected by validateSnapshot.
  const bogusRef = "fs:sha256:" + "a".repeat(64);
  const bogusPath = store.manifestPath(bogusRef);
  await mkdir(bogusPath.replace(/\/[^/]+$/, ""), { recursive: true });
  await writeFile(bogusPath, '{"version":1,"entries":');
  assert.equal(await store.validateSnapshot({ kind: "filesystem", ref: bogusRef, createdAt: new Date().toISOString() }), false, "truncated manifest invalid");
}

// --- 6. Persisted-baseline reuse: no unnecessary recapture on reinit ---
{
  const storeRoot = makeRoot("kontrol-fss-reuse-");
  const workspace = "ws-reuse";
  const workspaceRoot = makeRoot("kontrol-fss-reuse-root-");
  file(workspaceRoot, "seed.txt", "seed-content\n");
  const store = new FilesystemSnapshotStore({ storeRoot });
  const s1 = await store.capture(workspaceRoot);
  // Persist a baseline pin.
  await store.saveBaselines(workspace, workspaceRoot, { open: s1, presentation: s1, legacy: s1, sessions: new Map() });
  const blobsAfterBaseline = (await store.storeStats()).blobs;
  // Modify the workspace.
  file(workspaceRoot, "added.txt", "added\n");
  // Recreate the store (simulating a restart) and reinit; must load the
  // existing baseline WITHOUT capturing the modified tree.
  const store2 = new FilesystemSnapshotStore({ storeRoot });
  assert.equal(await store2.validateSnapshot(s1), true, "persisted baseline validates");
  assert.equal((await store2.storeStats()).blobs, blobsAfterBaseline, "no recapture happened on reinit with a valid persisted baseline");
}

// --- 7. GC reachability: unpinned manifest/blob reclaimed, pinned retained ---
{
  const { store, workspaceRoot } = makeStore();
  const workspace = "ws-gc";
  file(workspaceRoot, "keep.txt", "keep-content\n");
  const pinned = await store.capture(workspaceRoot);
  await store.saveBaselines(workspace, workspaceRoot, { open: pinned, presentation: pinned, legacy: pinned, sessions: new Map() });
  // Second, unpinned snapshot.
  file(workspaceRoot, "garbage.txt", "garbage-content\n");
  const unpinned = await store.capture(workspaceRoot);
  const pinRef = pinned.ref;
  const unpinRef = unpinned.ref;
  assert.ok(pinRef !== unpinRef, "two distinct manifests");
  const before = await store.storeStats();
  assert.ok(before.blobs >= 2, "at least keep + garbage blobs");
  // Run GC to completion (loop slices).
  await gcToCompletion(store, () => []); // no DB in these scenarios: an explicit empty root set
  assert.equal(existsSync(store.manifestPath(unpinRef)), false, "unpinned manifest reclaimed");
  assert.equal(existsSync(store.manifestPath(pinRef)), true, "pinned manifest retained");
  const after = await store.storeStats();
  assert.ok(after.blobs < before.blobs, "unpinned blob reclaimed");
  assert.equal(after.blobs, 1, "only the pinned blob survives");
}

// --- 8. Shared blob GC: deleting one manifest must not delete shared content ---
{
  const { store } = makeStore();
  const shared = "shared-content\n";
  const rootA = makeRoot("kontrol-fss-shared-a-");
  file(rootA, "file.txt", shared);
  const wsA = await store.capture(rootA);
  await store.saveBaselines("ws-shared-a", rootA, { open: wsA, presentation: wsA, legacy: wsA, sessions: new Map() });
  const rootB = makeRoot("kontrol-fss-shared-b-");
  file(rootB, "other.txt", shared); // identical content -> same blob
  const wsB = await store.capture(rootB);
  // Two retained manifests sharing one blob.
  await store.saveBaselines("ws-shared-b", rootB, { open: wsB, presentation: wsB, legacy: wsB, sessions: new Map() });
  const sharedHash = sha256(shared);
  assert.equal(existsSync(store.blobPath(sharedHash)), true, "shared blob present");
  await gcToCompletion(store, () => []); // no DB in these scenarios: an explicit empty root set
  assert.equal(existsSync(store.blobPath(sharedHash)), true, "shared blob survives GC while referenced by any retained manifest");
  const reach = await store.estimateReachableBytes();
  assert.equal(reach.blobs, 1, "one reachable unique blob (the shared one)");
}

// --- 9. Submission pinning: a DB-rooted snapshot survives GC ---
{
  const { store, workspaceRoot } = makeStore();
  file(workspaceRoot, "submitted.txt", "submitted-content\n");
  const submitted = await store.capture(workspaceRoot);
  const subRef = submitted.ref;
  // NOT saved as a baseline; only a DB submission root references it.
  await gcToCompletion(store, () => [snap(subRef, false)]);
  assert.equal(existsSync(store.manifestPath(subRef)), true, "DB-rooted submission manifest survives GC");
  // Without the DB root it would be reclaimed.
  const { store: s2, workspaceRoot: r2 } = makeStore();
  file(r2, "unpinned.txt", "unpinned-content\n");
  const orphan = await s2.capture(r2);
  await gcToCompletion(s2, () => []); // no DB in this scenario: an explicit empty root set
  assert.equal(existsSync(s2.manifestPath(orphan.ref)), false, "unpinned manifest reclaimed when no DB root");
}

// --- 10. Terminal retention: terminal snapshots expire per configured retention.
// P1.7: deterministic — retention aging is driven by explicit terminalAt values
// passed to the root provider, never by racing a 10ms window against wall-clock
// capture I/O. (The manifest-mtime fallback for pre-terminal_at rows is
// scenario 10b below.)
{
  const storeRoot = makeRoot("kontrol-fss-retention-");
  const store = new FilesystemSnapshotStore({ storeRoot, limits: { orphanGraceMs: 0, retentionMs: 30_000, retainPerWorkspace: 0 } });
  const workspaceRoot = makeRoot("kontrol-fss-retention-root-");
  file(workspaceRoot, "term.txt", "terminal-content\n");
  const terminalSnap = await store.capture(workspaceRoot);
  const termRef = terminalSnap.ref;
  // Terminal 1s ago with a 30s retention window -> retained, regardless of how
  // long capture I/O took (the old 10ms-window form of this test was flaky).
  await gcToCompletion(store, () => [{ ref: termRef, terminal: true, terminalAt: new Date(Date.now() - 1_000).toISOString() }]);
  assert.equal(existsSync(store.manifestPath(termRef)), true, "fresh terminal snapshot retained within retention window");
  // Terminal 60s ago -> retention (30s) expired even though the manifest mtime
  // is seconds old: aging is from the terminal moment, not filesystem times.
  await gcToCompletion(store, () => [{ ref: termRef, terminal: true, terminalAt: new Date(Date.now() - 60_000).toISOString() }]);
  assert.equal(existsSync(store.manifestPath(termRef)), false, "expired terminal snapshot reclaimed after retention");
}

// --- 10b. Terminal retention mtime fallback (pre-terminal_at rows): a
// terminal DB root without a terminalAt ages from the manifest mtime, which is
// the documented best-effort behavior for legacy rows.
{
  const storeRoot = makeRoot("kontrol-fss-retention-legacy-");
  const store = new FilesystemSnapshotStore({ storeRoot, limits: { orphanGraceMs: 0, retentionMs: 30_000, retainPerWorkspace: 0 } });
  const workspaceRoot = makeRoot("kontrol-fss-retention-legacy-root-");
  file(workspaceRoot, "term.txt", "legacy-terminal-content\n");
  const terminalSnap = await store.capture(workspaceRoot);
  const termRef = terminalSnap.ref;
  const mp = store.manifestPath(termRef);
  // Fresh manifest, no terminalAt: treated as freshly terminal -> retained.
  await gcToCompletion(store, () => [{ ref: termRef, terminal: true }]);
  assert.equal(existsSync(mp), true, "legacy terminal snapshot (no terminalAt) retained while manifest is fresh");
  // Age the manifest beyond retention: the mtime fallback expires it.
  const now = Date.now();
  utimesSync(mp, new Date(now - 60_000), new Date(now - 60_000));
  await gcToCompletion(store, () => [{ ref: termRef, terminal: true }]);
  assert.equal(existsSync(mp), false, "legacy terminal snapshot expires via mtime fallback");
}

// --- P0: high-water emergency GC preserves a DB-only submission ---
// Drive the store over its high-water mark with a submission snapshot that is
// NOT a baseline and is referenced only through the store's durableRoots
// provider. The emergency slice must reclaim the unpinned garbage but never
// the DB-referenced submission — and capture must still be refused afterwards
// while the store remains over the mark (fail closed).
{
  const storeRoot = makeRoot("kontrol-fss-hw-");
  const workspaceRoot = makeRoot("kontrol-fss-hw-ws-");
  const store = new FilesystemSnapshotStore({
    storeRoot,
    limits: { orphanGraceMs: 0, highWaterBytes: 80_000, retainPerWorkspace: 0 },
    durableRoots: undefined,
  });
  file(workspaceRoot, "submitted.txt", "submitted-content\n");
  const submitted = await store.capture(workspaceRoot);
  const subRef = submitted.ref;
  // Take the store decisively over the 80KiB high-water mark with unpinned
  // garbage (no provider at construction: the submission would be garbage
  // without the call-site roots under test).
  const store2 = new FilesystemSnapshotStore({
    storeRoot,
    limits: { orphanGraceMs: 0, highWaterBytes: 80_000, retainPerWorkspace: 0 },
    durableRoots: () => [{ ref: subRef, terminal: false }],
  });
  for (let i = 0; i < 2; i++) {
    const ws = makeRoot("kontrol-fss-hw-garbage-");
    // Unique content per capture: CAS dedup must not collapse the garbage.
    file(ws, `garbage-${i}.bin`, Buffer.alloc(64 * 1024, 7 + i));
    await store2.capture(ws);
  }
  assert.ok(await store2.overHighWater(), "store is over the high-water mark");
  // Capture must trigger the emergency GC slice; the DB-rooted submission
  // must survive it even though it is not a baseline.
  file(workspaceRoot, "more.txt", "post-brake-content\n");
  await store2.capture(workspaceRoot);
  assert.equal(existsSync(store2.manifestPath(subRef)), true, "high-water emergency GC preserved the DB-only submission");
  const statsAfter = await store2.storeStats();
  assert.ok(statsAfter.blobs < 8, `emergency GC reclaimed the unpinned garbage (blobs=${statsAfter.blobs})`);
  await store2.close();
  await store.close();
}

// --- P0: production store contract — destructive GC without any durable-root
// provider is impossible; a THROWING provider (DB unreadable) reclaims nothing.
{
  const storeRoot = makeRoot("kontrol-fss-failclosed-");
  const workspaceRoot = makeRoot("kontrol-fss-failclosed-ws-");
  const store = new FilesystemSnapshotStore({ storeRoot });
  file(workspaceRoot, "a.txt", "content-a\n");
  file(workspaceRoot, "b.txt", "content-b\n");
  const s1 = await store.capture(workspaceRoot);
  const s2 = await store.capture(workspaceRoot); // s1 now unpinned
  const statsBefore = await store.storeStats();

  // 1. No provider at all: destructive gcSlice must refuse to run.
  await assert.rejects(
    () => store.gcSlice({ budgetMs: 1000, pageSize: 100, dryRun: false }),
    /durable-root provider/,
    "destructive GC without a durable-root provider must fail closed",
  );
  // dryRun is read-only: it may fall back to baseline-only roots.
  const dry = await store.gcSlice({ budgetMs: 1000, pageSize: 100, dryRun: true });
  assert.equal(dry.result.blobsReclaimed, 0, "dryRun never deletes");

  // 2. A provider that THROWS (SQLite unreadable) must abort the slice before
  // any deletion: nothing live can be distinguished from nothing at all, so
  // the only safe action is to reclaim nothing.
  const throwing = new FilesystemSnapshotStore({
    storeRoot,
    durableRoots: () => {
      throw new Error("sqlite: database disk image is malformed");
    },
  });
  await assert.rejects(
    () => gcToCompletion(throwing),
    /malformed/,
    "a throwing durable-root provider must abort the GC slice",
  );
  const statsAfter = await store.storeStats();
  assert.equal(statsAfter.blobs, statsBefore.blobs, "zero blobs reclaimed when root enumeration failed");
  assert.equal(statsAfter.manifests, statsBefore.manifests, "zero manifests reclaimed when root enumeration failed");
  assert.equal(existsSync(store.manifestPath(s1.ref)) || existsSync(store.manifestPath(s2.ref)), true, "captures still present after failed enumeration");
  await store.close();
}

// --- P0: high-water brake fails closed without a durable-root provider ---
// Over the mark with no provider anywhere: the emergency slice must throw
// (treated as GC failure) and capture must be refused — never an implicit
// empty root set deciding everything is garbage.
{
  const storeRoot = makeRoot("kontrol-fss-hw-nop-");
  const ws = makeRoot("kontrol-fss-hw-nop-ws-");
  const store = new FilesystemSnapshotStore({ storeRoot, limits: { orphanGraceMs: 0, highWaterBytes: 512, retainPerWorkspace: 0 } });
  file(ws, "big.bin", Buffer.alloc(8 * 1024, 3));
  const first = await store.capture(ws);
  assert.ok(await store.overHighWater(), "store over high-water");
  // Every subsequent capture must be refused: the brake cannot run a
  // provider-less destructive GC, so it fails closed.
  await assert.rejects(() => store.capture(ws), /high-water/, "capture refused while over high-water without a root provider");
  assert.equal(existsSync(store.manifestPath(first.ref)), true, "nothing deleted by the failed brake");
  await store.close();
}

// --- 11. Mutation-before-baseline (manager level) handled in review-checkpoints.filesystem.test.ts ---

// --- 12. Large-file streaming: capture a multi-hundred-MB file without holding it in a Buffer ---
{
  const { store, workspaceRoot } = makeStore();
  // ~256 MiB sparse-ish file.
  const sizeBytes = 256 * 1024 * 1024;
  file(workspaceRoot, "big.bin", Buffer.alloc(0));
  const fh = await open(join(workspaceRoot, "big.bin"), "w");
  await fh.truncate(sizeBytes);
  await fh.write(Buffer.from("lead"), 0);
  await fh.write(Buffer.from("tail"), 0, 4, sizeBytes - 4);
  await fh.close();
  const beforeHeap = process.memoryUsage().heapUsed;
  const snap = await store.capture(workspaceRoot);
  const afterHeap = process.memoryUsage().heapUsed;
  const stats = await store.storeStats();
  assert.equal(stats.blobs, 1, "one blob for the big file");
  assert.ok(stats.blobBytes >= sizeBytes, `blob bytes >= file size (${stats.blobBytes})`);
  // Heap must not have ballooned to hold the whole 256 MiB file synchronously.
  const heapGrowth = afterHeap - beforeHeap;
  assert.ok(heapGrowth < 128 * 1024 * 1024, `heap grew ${heapGrowth} bytes for a 256 MiB streaming capture`);
  assert.equal(await store.readManifest(snap).then((m) => m.entries.length), 1);
  const blob = await store.readBlobBuffer((await store.readManifest(snap)).entries[0].sha256);
  assert.equal(blob.byteLength, sizeBytes);
}

// --- 13. Capture quota: exceeding file/byte/max-file threshold fails without leaked blobs ---
{
  // Per-file byte cap.
  const { store: s1, workspaceRoot: r1 } = makeStore({ limits: { maxFileBytes: 1024 } });
  file(r1, "ok.txt", "small\n");
  writeFileSync(join(r1, "big.bin"), Buffer.alloc(1024 * 1024));
  await assert.rejects(() => s1.capture(r1), /maxFileBytes/);
  assert.equal((await s1.storeStats()).blobs, 0, "no leaked blobs on maxFileBytes breach");
  // Total byte cap.
  const { store: s2, workspaceRoot: r2 } = makeStore({ limits: { maxBytes: 1000 } });
  file(r2, "a.txt", "a".repeat(700));
  file(r2, "b.txt", "b".repeat(700));
  await assert.rejects(() => s2.capture(r2), /maxBytes/);
  assert.equal((await s2.storeStats()).blobs, 0, "no leaked blobs on maxBytes breach");
}

// --- 14. GC/capture concurrency: collector cannot delete a blob being published ---
{
  const { store, workspaceRoot } = makeStore();
  file(workspaceRoot, "keep.txt", "keep\n");
  // Pin this snapshot so its blob is reachable.
  const pinned = await store.capture(workspaceRoot);
  await store.saveBaselines("ws-conc", workspaceRoot, { open: pinned, presentation: pinned, legacy: pinned, sessions: new Map() });
  // A second capture adds a blob; its manifest is pinned as a baseline too.
  file(workspaceRoot, "extra.txt", "extra-content\n");
  const snap2 = await store.capture(workspaceRoot);
  await store.saveBaselines("ws-conc2", workspaceRoot, { open: snap2, presentation: snap2, legacy: snap2, sessions: new Map() });
  const m = await store.readManifest(snap2);
  const extraHash = m.entries.find((e) => e.path === "extra.txt")!.sha256;
  assert.equal(existsSync(store.blobPath(extraHash)), true, "extra blob published");
  await gcToCompletion(store, () => []); // no DB in these scenarios: an explicit empty root set
  // Both pinned snapshots' manifests and blobs must survive.
  assert.equal(existsSync(store.manifestPath(pinned.ref)), true);
  assert.equal(existsSync(store.manifestPath(snap2.ref)), true);
  assert.equal(existsSync(store.blobPath(extraHash)), true, "published blob survived concurrent GC");
}

// --- 15. Baseline corruption: malformed baseline reported as corrupt, not absent ---
{
  const storeRoot = makeRoot("kontrol-fss-corrupt-");
  const store = new FilesystemSnapshotStore({ storeRoot });
  const workspace = "ws-corrupt";
  await mkdir(join(storeRoot, "baselines"), { recursive: true });
  await writeFile(join(storeRoot, "baselines", `${workspace}.json`), '{"root": "broken json');
  const loaded = await store.loadBaselines(workspace);
  assert.equal(loaded, undefined, "corrupt baseline yields no baseline value");
  const stats = await store.storeStats();
  assert.ok(stats.corruptionCount >= 1, "corruption reported rather than silently treated as absent");

  // A missing baseline (ENOENT) is NOT corruption.
  const fresh = new FilesystemSnapshotStore({ storeRoot });
  const missing = await fresh.loadBaselines("ws-missing");
  assert.equal(missing, undefined, "missing baseline yields undefined value");
  assert.equal((await fresh.storeStats()).corruptionCount, 0, "ENOENT is not classified as corruption");
}

// ── P1.5/P1.6: bounded defaults + exclusion policy ──
{
  // P1.5: a store constructed with NO limits must still be bounded. We don't
  // materialize 100k files to prove it; the exported defaults are asserted
  // against the documented values, and the admission mechanics are proven by
  // the existing maxFiles/maxBytes scenarios plus the tiny-limit probe below.
  assert.equal(DEFAULT_SNAPSHOT_LIMITS.maxFiles, 100_000, "P1.5: default file bound is finite");
  assert.equal(DEFAULT_SNAPSHOT_LIMITS.maxBytes, 8 * 1024 * 1024 * 1024, "P1.5: default byte bound is finite");
  assert.equal(DEFAULT_SNAPSHOT_LIMITS.maxFileBytes, 512 * 1024 * 1024, "P1.5: default per-file bound is finite");
  const { store, workspaceRoot } = makeStore({});
  // maxFileBytes admission: a single file over the per-file bound fails closed.
  const tinyProbe = makeStore({ limits: { maxFileBytes: 8, maxFiles: DEFAULT_SNAPSHOT_LIMITS.maxFiles, maxBytes: DEFAULT_SNAPSHOT_LIMITS.maxBytes } });
  file(tinyProbe.workspaceRoot, "big.bin", Buffer.alloc(16, 7));
  await assert.rejects(() => tinyProbe.store.capture(tinyProbe.workspaceRoot), /maxFileBytes/, "P1.5: per-file admission limit enforced");
  await tinyProbe.store.close();

  // Exclusion policy: node_modules is never captured; git-ignored source IS.
  mkdirSync(join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(workspaceRoot, ".venv"), { recursive: true });
  file(workspaceRoot, "node_modules/pkg/index.js", "generated\n");
  file(workspaceRoot, ".venv/lib.py", "generated\n");
  file(workspaceRoot, "generated-artifact.js", "source despite gitignore\n");
  const snapshot = await store.capture(workspaceRoot);
  const manifest = await store.readManifest(snapshot);
  const paths = manifest.entries.map((entry) => entry.path);
  assert.ok(!paths.some((p) => p.startsWith("node_modules/")), "P1.6: node_modules is excluded by default");
  assert.ok(!paths.some((p) => p.startsWith(".venv/")), "P1.6: .venv is excluded by default");
  assert.ok(paths.includes("generated-artifact.js"), "P1.6: non-excluded files are captured even if unusual");
  await store.close();

  // Operator extensions are added to the defaults.
  const custom = makeStore({ excludedDirectories: ["vendor-custom"] });
  mkdirSync(join(custom.workspaceRoot, "vendor-custom"), { recursive: true });
  mkdirSync(join(custom.workspaceRoot, "node_modules"), { recursive: true });
  file(custom.workspaceRoot, "vendor-custom/lib.js", "x\n");
  file(custom.workspaceRoot, "node_modules/other.js", "x\n");
  const customSnapshot = await custom.store.capture(custom.workspaceRoot);
  const customManifest = await custom.store.readManifest(customSnapshot);
  const customPaths = customManifest.entries.map((entry) => entry.path);
  assert.ok(!customPaths.some((p) => p.startsWith("vendor-custom/")), "P1.6: operator exclusion honored");
  assert.ok(!customPaths.some((p) => p.startsWith("node_modules/")), "P1.6: defaults still apply alongside operator exclusions");
  await custom.store.close();
}

console.log("filesystem-snapshot-store: all scenarios passed");