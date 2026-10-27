import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const { FilesystemSnapshotStore } = await import(pathToFileURL(resolve("src/filesystem-snapshot-store.ts")).href);
const manifestCount = Number(process.env.KONTROL_SNAPSHOT_ACCOUNTING_MANIFESTS ?? 10_000);
const rounds = Number(process.env.KONTROL_SNAPSHOT_ACCOUNTING_ROUNDS ?? 3);
if (!Number.isSafeInteger(manifestCount) || manifestCount < 1 || !Number.isSafeInteger(rounds) || rounds < 2) {
  throw new Error("Manifest count must be positive and rounds must be at least 2.");
}

const storeRoot = await mkdtemp(join(tmpdir(), "kontrol-snapshot-accounting-bench-"));
const store = new FilesystemSnapshotStore({ storeRoot, limits: { orphanGraceMs: 0 } });
const roots = [];
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

try {
  await mkdir(join(storeRoot, "manifests"), { recursive: true });
  for (let index = 0; index < manifestCount; index++) {
    const content = Buffer.from(`snapshot-accounting-blob-${index}`);
    const blobHash = sha256(content);
    const manifestRef = `fs:sha256:${sha256(`snapshot-accounting-manifest-${index}`)}`;
    await mkdir(join(storeRoot, "blobs", blobHash.slice(0, 2)), { recursive: true });
    await writeFile(store.blobPath(blobHash), content);
    await writeFile(store.manifestPath(manifestRef), JSON.stringify({
      version: 1,
      entries: [{ path: `file-${index}.txt`, type: "file", sha256: blobHash, size: content.length, executable: false }],
    }));
    roots.push({ ref: manifestRef, terminal: false });
  }

  const separateMs = [];
  const combinedMs = [];
  let expectedStats;
  let expectedReachability;
  for (let round = 0; round < rounds; round++) {
    const separateStartedAt = performance.now();
    const stats = await store.storeStats();
    const reachable = await store.estimateReachableBytes(() => roots);
    separateMs.push(performance.now() - separateStartedAt);
    if (!expectedStats) expectedStats = stats;
    if (!expectedReachability) expectedReachability = reachable;
    assert.deepEqual(stats, expectedStats, "separate inventory results remain stable");
    assert.deepEqual(reachable, expectedReachability, "separate reachability results remain stable");

    const combinedStartedAt = performance.now();
    const combined = await store.storeStatsWithReachability(() => roots);
    combinedMs.push(performance.now() - combinedStartedAt);
    assert.deepEqual(combined.stats, stats, "combined stats exactly match the existing stats path");
    assert.deepEqual(combined.reachable, reachable, "combined reachability exactly matches the existing estimate");
  }

  console.log(JSON.stringify({
    fixture: "synthetic filesystem snapshot store; every manifest and blob is live",
    manifestCount,
    blobCount: manifestCount,
    rounds,
    separateMedianMs: median(separateMs),
    combinedMedianMs: median(combinedMs),
    speedup: median(separateMs) / median(combinedMs),
    exactStatsAndReachabilityPreserved: true,
    duplicateWalksAvoided: ["blob inventory", "manifest directory inventory", "reachable blob stat"],
  }));
} finally {
  await store.close();
  await rm(storeRoot, { recursive: true, force: true });
}
