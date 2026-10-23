import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { FilesystemSnapshotStore } = await import(pathToFileURL(resolve("src/filesystem-snapshot-store.ts")).href);

function percentile(values, rate) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * rate) - 1)];
}

const budgetMs = 250;
for (const manifestCount of [100, 1_000, 10_000]) {
  for (const terminalPercent of [0, 10, 50, 100]) {
    const storeRoot = await mkdtemp(join(tmpdir(), `kontrol-snapshot-gc-${manifestCount}-`));
    const store = new FilesystemSnapshotStore({
      storeRoot,
      limits: { orphanGraceMs: 0, retentionMs: 0, retainPerWorkspace: 10 },
    });
    const manifestsPath = join(storeRoot, "manifests");
    await mkdir(manifestsPath, { recursive: true });
    const roots = [];
    const terminalCount = Math.floor(manifestCount * terminalPercent / 100);
    const expiredAt = new Date(0).toISOString();
    const manifestBody = JSON.stringify({ version: 1, entries: [] });
    const bodyDigest = createHash("sha256").update(manifestBody).digest("hex");
    for (let index = 0; index < manifestCount; index++) {
      const suffix = `${index.toString(16).padStart(64, "0")}`;
      const ref = `fs:sha256:${suffix}`;
      await writeFile(store.manifestPath(ref), manifestBody);
      if (index < terminalCount) roots.push({ ref, terminal: true, terminalAt: expiredAt });
      else roots.push({ ref, terminal: false });
    }

    const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
    eventLoopDelay.enable();
    eventLoopDelay.reset();
    const sliceDurationsMs = [];
    let expiredManifests = 0;
    let hasMore = true;
    let slices = 0;
    try {
      while (hasMore) {
        const startedAt = performance.now();
        const slice = await store.gcSlice({
          budgetMs,
          pageSize: 100,
          dryRun: false,
          listDbSnapshots: () => roots,
        });
        sliceDurationsMs.push(performance.now() - startedAt);
        expiredManifests += slice.result.manifestsExpired;
        hasMore = slice.hasMore;
        slices++;
      }
    } finally {
      eventLoopDelay.disable();
      await store.close();
    }

    const remainingManifests = (await readdir(manifestsPath)).length;
    const expectedRemaining = manifestCount - terminalCount + Math.min(terminalCount, 10);
    const expectedExpired = terminalCount - Math.min(terminalCount, 10);
    console.log(JSON.stringify({
      manifestCount,
      budgetMs,
      manifestEntriesPerFile: 0,
      rootSource: "in-memory synthetic callback; SQLite root-query cost excluded",
      terminalPercent,
      slices,
      maxSliceMs: Math.max(...sliceDurationsMs),
      p95SliceMs: percentile(sliceDurationsMs, 0.95),
      maxEventLoopDelayMs: eventLoopDelay.max / 1e6,
      expiredManifests,
      expectedExpired,
      remainingManifests,
      expectedRemaining,
      budgetExceeded: sliceDurationsMs.some((duration) => duration > budgetMs),
      bodySha256: bodyDigest,
    }));
    if (remainingManifests !== expectedRemaining || expiredManifests !== expectedExpired) {
      await rm(storeRoot, { recursive: true, force: true });
      throw new Error(`GC retained ${remainingManifests}/${expectedRemaining} manifests and expired ${expiredManifests}/${expectedExpired}.`);
    }
    await rm(storeRoot, { recursive: true, force: true });
  }
}
