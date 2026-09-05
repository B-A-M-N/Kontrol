import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "./db/client.js";
import { createEventStore } from "./event-log.js";
import { createContinuationManager } from "./continuation.js";
import { createAgentRegistryManager } from "./acp-registry.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createWorkSessionManager } from "./work-sessions.js";
import { createReviewWorkflowService, WorkflowError } from "./review-workflow.js";

const state = mkdtempSync(join(tmpdir(), "kontrol-review-workflow-fs-"));
const root = mkdtempSync(join(tmpdir(), "kontrol-review-workflow-root-"));
writeFileSync(join(root, "tracked.txt"), "baseline\n");
const db = openDatabase(state);
db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, ?, 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-fs-review", root);
const workSessions = createWorkSessionManager(db);
const eventStore = createEventStore(db);
const continuations = createContinuationManager(db);
const agents = createAgentRegistryManager(db);
// orphanGraceMs 0 makes GC deterministic in the retention block below.
const checkpoints = createReviewCheckpointManager({ snapshotStoreRoot: join(state, "snapshots"), snapshotLimits: { orphanGraceMs: 0 } });
const workspaces = { getWorkspace: () => ({ id: "ws-fs-review", root, mode: "checkout" }) } as any;
const workflow = createReviewWorkflowService({ workSessions, eventStore, continuationManager: continuations, agentRegistry: agents, db, workspaces, reviewCheckpoints: checkpoints });
const session = workSessions.create({ workspaceSessionId: "ws-fs-review", submittedBy: "worker", completionPolicy: "webui_approval_required" });
const baseline = await checkpoints.reviewChanges({ workspaceId: "ws-fs-review", root, since: "workspace_open", markReviewed: false });
writeFileSync(join(root, "tracked.txt"), "submitted\n");
const submittedSnapshot = await checkpoints.reviewChangesAgainstSnapshot({ workspaceId: "ws-fs-review", root, baseline: baseline.snapshot });
const submission = workflow.submitForReview({
  workSessionId: session.id,
  diff: submittedSnapshot.patch,
  changedFiles: submittedSnapshot.files,
  snapshotKind: submittedSnapshot.snapshotKind,
  snapshotRef: submittedSnapshot.snapshotRef,
  snapshotCommit: submittedSnapshot.snapshotRef,
});

writeFileSync(join(root, "tracked.txt"), "changed-after-review\n");
await assert.rejects(
  () => workflow.provideFeedback({ sessionId: session.id, submissionId: submission.submissionId, verdict: "approve", comments: "approve", reviewerId: "webui" }),
  (error: unknown) => error instanceof WorkflowError && error.code === "stale_submission",
);

// --- GC pinning: while a submission is active (nonterminal work session), its
// filesystem snapshot ref must survive reachability GC and stay materializable.
// The listDbSnapshots root collector mirrors the production server query over
// work_session_submissions (joined to owning work_session for terminal status).
{
  const store = checkpoints.getSnapshotStore();
  // The durable reference GC pins is the snapshot_ref persisted in
  // work_session_submissions (the workflow's returned submission object does
  // not expose it, but the DB row — what the collector reads — does).
  const submittedRow = db.sqlite.prepare("select snapshot_ref as ref from work_session_submissions where id = ?").get(submission.submissionId) as { ref: string | null };
  const storeRef = submittedRow.ref!;
  assert.match(storeRef, /^fs:sha256:/);
  // Sanity: submitted snapshot manifest + blob exist before GC.
  assert.equal(existsSync(store.manifestPath(storeRef)), true, "submitted manifest present pre-GC");

  const listDbSnapshots = () => {
    const rows = db.sqlite
      .prepare(
        "select wss.snapshot_ref as ref, ws.status as status from work_session_submissions wss left join work_sessions ws on ws.id = wss.work_session_id where wss.snapshot_kind = 'filesystem' and wss.snapshot_ref is not null",
      )
      .all() as Array<{ ref: string; status: string | null }>;
    const terminal = new Set(["approved", "rejected", "cancelled", "failed", "failed_protocol"]);
    return rows.map((r) => ({ ref: r.ref, terminal: r.status !== null && terminal.has(r.status) }));
  };

  // Also pin a junk/unsubmitted snapshot so GC has actual garbage to reclaim,
  // proving the collector is selective (keeps the submission, drops the junk).
  writeFileSync(join(root, "garbage.txt"), "unreferenced\n");
  const junk = await checkpoints.reviewChanges({ workspaceId: "ws-fs-review", root, since: "workspace_open", markReviewed: false });
  const junkRef = junk.snapshotRef;
  // Don't push junk into work_session_submissions: it stays unreferenced.
  const before = await store.storeStats();
  assert.ok(before.blobs >= 2, "at least submitted + garbage blobs");

  let hasMore = true;
  while (hasMore) {
    const out = await store.gcSlice({ budgetMs: 1000, pageSize: 100, dryRun: false, listDbSnapshots });
    hasMore = out.hasMore;
  }

  // The submitted (DB-rooted) snapshot and its blob are retained and materializable.
  assert.equal(existsSync(store.manifestPath(storeRef)), true, "submitted manifest survives GC");
  const subManifest = await store.readManifest({ kind: "filesystem", ref: storeRef, createdAt: new Date(0).toISOString() });
  assert.ok(subManifest.entries.length >= 1, "submitted manifest has entries");
  for (const e of subManifest.entries) {
    if (e.type !== "file") continue;
    assert.equal(existsSync(store.blobPath(e.sha256)), true, `submitted blob ${e.sha256.slice(0, 12)} survives GC`);
  }
  // The junk (unreferenced) snapshot is reclaimed.
  assert.equal(existsSync(store.manifestPath(junkRef)), false, "unreferenced junk manifest reclaimed");
  const after = await store.storeStats();
  assert.ok(after.blobs < before.blobs, "GC reclaimed the unreferenced blob");
}

workSessions.close();
agents.close();
eventStore.close();
db.close();
console.log("review-workflow.filesystem: stale approval rejected");
