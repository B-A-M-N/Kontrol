/**
 * Approval-time coverage revalidation: persisted submission coverage is
 * stale evidence. Mutations recorded after submission must be re-assessed
 * at approval time, inside the shared workspace-mutation boundary that
 * structured mutations also serialize on, held through the feedback commit.
 *
 * Matrix:
 *  - post-submission excluded-tree mutation -> fresh incomplete blocks
 *    ordinary approval; explicit acceptance approves and audits fresh paths
 *  - post-submission unknown shell provenance -> fresh unknown blocks even
 *    with the incomplete-coverage acknowledgment; reject stays available
 *  - a structured mutation holding the shared workspace key excludes a
 *    concurrent approval until the mutation completes (and vice versa)
 *  - control: no post-submission mutation -> approval succeeds
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrations.js";
import { createEventStore } from "./event-log.js";
import { createContinuationManager } from "./continuation.js";
import { createAgentRegistryManager } from "./acp-registry.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createWorkSessionManager } from "./work-sessions.js";
import { createReviewWorkflowService, WorkflowError } from "./review-workflow.js";
import { withFileMutationLock, workspaceMutationLockKey } from "./mutation-version.js";

const state = mkdtempSync(join(tmpdir(), "kontrol-fresh-coverage-"));
const root = mkdtempSync(join(tmpdir(), "kontrol-fresh-coverage-root-"));
writeFileSync(join(root, "app.ts"), "export {};\n");
mkdirSync(join(root, "node_modules"), { recursive: true });
const db = openDatabase(state);
db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, ?, 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-fresh", root);
const provenanceDb = new Database(join(state, "provenance.sqlite"));
migrateDatabase(provenanceDb);
const workSessions = createWorkSessionManager(db);
const eventStore = createEventStore(db);
const continuations = createContinuationManager(db);
const agents = createAgentRegistryManager(db);
const checkpoints = createReviewCheckpointManager({ snapshotStoreRoot: join(state, "snapshots"), mutationProvenanceSqlite: provenanceDb });
const workspaces = { getWorkspace: () => ({ id: "ws-fresh", root, mode: "checkout" }) } as any;
const workflow = createReviewWorkflowService({ workSessions, eventStore, continuationManager: continuations, agentRegistry: agents, db, workspaces, reviewCheckpoints: checkpoints });

const boundSnapshot = await checkpoints.reviewChanges({
  workspaceId: "ws-fresh",
  root,
  since: "workspace_open",
  markReviewed: false,
});

async function submitFresh(diff = "diff") {
  const session = workSessions.create({ workspaceSessionId: "ws-fresh", submittedBy: "worker", completionPolicy: "webui_approval_required" });
  const submitted = await workflow.submitForReview({
    workSessionId: session.id,
    diff,
    snapshotKind: boundSnapshot.snapshotKind,
    snapshotRef: boundSnapshot.snapshotRef,
  });
  await checkpoints.commitReviewedSnapshot({
    workspaceId: "ws-fresh",
    root,
    workSessionId: session.id,
    snapshot: boundSnapshot.snapshot,
  });
  return { session, submitted };
}

function feedbackArgs(sessionId: string, submitted: { submissionId: string; diffSha256?: string; reviewEpoch: number }, verdict: "approve" | "reject", extra: Record<string, unknown> = {}) {
  return {
    sessionId,
    submissionId: submitted.submissionId,
    diffSha256: submitted.diffSha256,
    reviewEpoch: submitted.reviewEpoch,
    verdict,
    comments: "fresh coverage matrix",
    reviewerId: "webui",
    invocationOrigin: "authenticated_reviewer" as const,
    ...extra,
  };
}

function feedbackCount(sessionId: string): number {
  return (db.sqlite.prepare("select count(*) as count from work_session_feedback where work_session_id = ?").get(sessionId) as { count: number }).count;
}

// 1. Post-submission excluded-tree mutation: persisted coverage is complete,
//    but fresh assessment is incomplete and gates ordinary approval.
{
  const { session, submitted } = await submitFresh("post-submission excluded");
  assert.equal(submitted.coverageStatus, "complete", "persisted coverage at submission is complete");
  writeFileSync(join(root, "node_modules", "late.js"), "late hidden edit\n");
  await checkpoints.recordMutations({
    workspaceId: "ws-fresh",
    root,
    workSessionId: session.id,
    paths: [join(root, "node_modules", "late.js")],
  });
  await assert.rejects(
    () => workflow.provideFeedback(feedbackArgs(session.id, submitted, "approve")),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError && error.code === "conflict");
      assert.match(error.message, /cannot represent/);
      assert.match(error.message, /node_modules\/late\.js/);
      return true;
    },
  );
  assert.equal(workSessions.get(session.id)?.status, "awaiting_review", "fresh-coverage refusal consumes nothing");
  assert.equal(feedbackCount(session.id), 0);
  // Explicit acceptance of the fresh incomplete coverage approves, and the
  // feedback event audits the fresh (not persisted) path list. The snapshot
  // gate still passes because excluded trees are outside the checkpoint.
  await workflow.provideFeedback(feedbackArgs(session.id, submitted, "approve", { acceptIncompleteCoverage: true }));
  assert.equal(workSessions.get(session.id)?.status, "approved");
  const payload = JSON.parse((db.sqlite.prepare("select payload from event_log where type = 'review.feedback.provided' and session_id = ? order by seq desc limit 1").get(session.id) as { payload: string }).payload) as { acceptedIncompleteCoverage?: boolean; uncoveredPaths?: string[] };
  assert.equal(payload.acceptedIncompleteCoverage, true);
  assert.deepEqual(payload.uncoveredPaths, ["node_modules/late.js"], "audit trail records fresh coverage paths");
}

// 2. Post-submission unknown shell provenance blocks approval even with the
//    incomplete-coverage acknowledgment; rejection stays available.
{
  const { session, submitted } = await submitFresh("post-submission unknown");
  assert.equal(submitted.coverageStatus, "complete");
  const operationId = await checkpoints.beginMutationIntent({ workspaceId: "ws-fresh", root, workSessionId: session.id, paths: [] });
  await checkpoints.resolveMutationIntent({ workspaceId: "ws-fresh", operationId, outcome: "unknown" });
  for (const acceptIncompleteCoverage of [false, true]) {
    await assert.rejects(
      () => workflow.provideFeedback(feedbackArgs(session.id, submitted, "approve", { acceptIncompleteCoverage })),
      (error: unknown) => error instanceof WorkflowError && /coverage is unknown/i.test(error.message),
    );
  }
  assert.equal(feedbackCount(session.id), 0, "unknown-coverage denials write no feedback");
  await workflow.provideFeedback(feedbackArgs(session.id, submitted, "reject"));
  assert.equal(workSessions.get(session.id)?.status, "rejected", "rejection remains available under fresh unknown coverage");
}

// 3. Serialization boundary: while a structured mutation holds the shared
//    workspace key, a concurrent approval cannot complete its
//    snapshot/coverage validation; it proceeds only after the mutation
//    releases the boundary (and then sees the post-mutation tree).
{
  const { session, submitted } = await submitFresh("boundary");
  let releaseMutation!: () => void;
  const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
  let mutationEntered = false;
  const mutationP = withFileMutationLock([workspaceMutationLockKey(root)], async () => {
    mutationEntered = true;
    await mutationGate;
  });
  // Let the mutation acquire the boundary first.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(mutationEntered, true, "mutation holds the shared workspace boundary");
  let approvalSettled = false;
  const approvalP = workflow.provideFeedback(feedbackArgs(session.id, submitted, "approve"))
    .then((result) => { approvalSettled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(approvalSettled, false, "approval validation is excluded while a workspace mutation holds the boundary");
  releaseMutation();
  await mutationP;
  await approvalP;
  assert.equal(workSessions.get(session.id)?.status, "approved", "approval completes once the boundary is released");
}

// 4. Control: no post-submission mutation, approval succeeds on fresh
//    complete coverage.
{
  const { session, submitted } = await submitFresh("control");
  await workflow.provideFeedback(feedbackArgs(session.id, submitted, "approve"));
  assert.equal(workSessions.get(session.id)?.status, "approved");
}

workSessions.close();
agents.close();
eventStore.close();
db.close();
provenanceDb.close();
console.log("review-workflow.fresh-coverage: post-submission revalidation + boundary passed");
