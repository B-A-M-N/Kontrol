import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { collectDurableSnapshotRoots } from "../src/runtime/snapshot-roots.ts";
import { openDatabase } from "../src/db/client.ts";

const irrelevantRows = Number(process.env.KONTROL_SNAPSHOT_ROOT_BENCH_ROWS ?? 50_000);
const filesystemRoots = Number(process.env.KONTROL_SNAPSHOT_ROOT_BENCH_LIVE_ROOTS ?? 100);
const rounds = Number(process.env.KONTROL_SNAPSHOT_ROOT_BENCH_ROUNDS ?? 9);
if (!Number.isSafeInteger(irrelevantRows) || irrelevantRows < 1
  || !Number.isSafeInteger(filesystemRoots) || filesystemRoots < 1
  || !Number.isSafeInteger(rounds) || rounds < 3) {
  throw new Error("Benchmark row counts must be positive integers and rounds must be at least 3.");
}

const stateDir = await mkdtemp(join(tmpdir(), "kontrol-snapshot-root-bench-"));
const db = openDatabase(stateDir);
try {
  const now = new Date().toISOString();
  db.sqlite.prepare(`
    insert into workspace_sessions (id, root, created_at, last_used_at)
    values ('snapshot-root-bench-workspace', '/tmp/snapshot-root-bench', ?, ?)
  `).run(now, now);
  db.sqlite.prepare(`
    insert into work_sessions (id, workspace_session_id, status, submitted_by, created_at, updated_at)
    values ('snapshot-root-bench-session', 'snapshot-root-bench-workspace', 'in_progress', 'benchmark', ?, ?)
  `).run(now, now);
  const insert = db.sqlite.prepare(`
    insert into work_session_submissions
      (id, work_session_id, submission_number, snapshot_kind, snapshot_ref, status, created_at)
    values (?, 'snapshot-root-bench-session', ?, ?, ?, 'reviewed', ?)
  `);
  db.sqlite.transaction(() => {
    for (let index = 0; index < irrelevantRows + filesystemRoots; index++) {
      const isFilesystem = index >= irrelevantRows;
      insert.run(
        `snapshot-root-bench-${index}`,
        index + 1,
        isFilesystem ? "filesystem" : "git",
        isFilesystem
          ? `fs:sha256:${index.toString(16).padStart(64, "0")}`
          : `git:${index.toString(16).padStart(40, "0")}`,
        now,
      );
    }
  })();

  const indexName = "wss_filesystem_snapshot_roots_idx";
  const measure = () => {
    const samples = [];
    let roots;
    for (let index = 0; index < rounds; index++) {
      const startedAt = performance.now();
      roots = collectDurableSnapshotRoots(db);
      samples.push(performance.now() - startedAt);
    }
    samples.sort((left, right) => left - right);
    return { medianMs: samples[Math.floor(samples.length / 2)], roots };
  };

  db.sqlite.exec(`drop index ${indexName}`);
  const unindexed = measure();
  db.sqlite.exec(`create index ${indexName}
    on work_session_submissions(snapshot_ref, work_session_id)
    where snapshot_kind = 'filesystem' and snapshot_ref is not null`);
  const indexed = measure();
  const queryPlan = db.sqlite.prepare(`explain query plan
    select wss.snapshot_ref as ref, ws.status as status, ws.terminal_at as terminal_at
      from work_session_submissions wss
      left join work_sessions ws on ws.id = wss.work_session_id
     where wss.snapshot_kind = 'filesystem' and wss.snapshot_ref is not null`)
    .all();
  assert.deepEqual(indexed.roots, unindexed.roots, "index preserves the exact durable root set");
  assert.equal(indexed.roots.length, filesystemRoots, "only filesystem snapshots are returned");
  assert.ok(JSON.stringify(queryPlan).includes(indexName), "query planner uses the partial root index");
  console.log(JSON.stringify({
    fixture: "synthetic SQLite; one work session",
    irrelevantGitRows: irrelevantRows,
    filesystemRootRows: filesystemRoots,
    rounds,
    unindexedMedianMs: unindexed.medianMs,
    indexedMedianMs: indexed.medianMs,
    speedup: unindexed.medianMs / indexed.medianMs,
    exactRootSetPreserved: true,
    queryPlan,
  }));
} finally {
  db.close();
  await rm(stateDir, { recursive: true, force: true });
}
