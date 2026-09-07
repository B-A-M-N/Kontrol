/**
 * P1 (audit): checkpoint coverage end-to-end through the review workflow.
 *
 * A structured mutation into an excluded tree (node_modules) must ride along
 * with the submission as a coverage record; the workflow must refuse an
 * ordinary approval, accept only an explicit acceptIncompleteCoverage
 * approval, and record the acceptance in the feedback event payload.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "./db/client.js";
import { createEventStore } from "./event-log.js";
import { createContinuationManager } from "./continuation.js";
import { createAgentRegistryManager } from "./acp-registry.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createWorkSessionManager } from "./work-sessions.js";
import { createReviewWorkflowService, WorkflowError } from "./review-workflow.js";

const state = mkdtempSync(join(tmpdir(), "kontrol-review-coverage-"));
const root = mkdtempSync(join(tmpdir(), "kontrol-review-coverage-root-"));
writeFileSync(join(root, "app.ts"), "export {};\n");
mkdirSync(join(root, "node_modules"), { recursive: true });
const db = openDatabase(state);
db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, ?, 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-coverage-e2e", root);
const workSessions = createWorkSessionManager(db);
const eventStore = createEventStore(db);
const continuations = createContinuationManager(db);
const agents = createAgentRegistryManager(db);
const checkpoints = createReviewCheckpointManager({ snapshotStoreRoot: join(state, "snapshots") });
const workspaces = { getWorkspace: () => ({ id: "ws-coverage-e2e", root, mode: "checkout" }) } as any;
const workflow = createReviewWorkflowService({ workSessions, eventStore, continuationManager: continuations, agentRegistry: agents, db, workspaces, reviewCheckpoints: checkpoints });
const session = workSessions.create({ workspaceSessionId: "ws-coverage-e2e", submittedBy: "worker", completionPolicy: "webui_approval_required" });

// The worker edits a covered file AND one inside node_modules.
writeFileSync(join(root, "app.ts"), "export const x = 1;\n");
writeFileSync(join(root, "node_modules", "patched.js"), "hidden edit\n");
await checkpoints.recordMutations({
  workspaceId: "ws-coverage-e2e",
  root,
  paths: [join(root, "app.ts"), join(root, "node_modules", "patched.js")],
});

// Bind the approval to the tree EXACTLY as it stands right now so the
// snapshot-staleness gate and the coverage gate are tested independently.
const boundSnapshot = await checkpoints.reviewChanges({
  workspaceId: "ws-coverage-e2e",
  root,
  since: "workspace_open",
  markReviewed: false,
});
const submitted = await workflow.submitForReview({
  workSessionId: session.id,
  diff: "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-export {}\n+export const x = 1;\n",
  snapshotKind: boundSnapshot.snapshotKind,
  snapshotRef: boundSnapshot.snapshotRef,
});

// The submission carries the coverage record naming ONLY the uncovered path.
assert.ok(submitted.coverage, "submission carries a coverage record");
assert.deepEqual(submitted.coverage.uncoveredPaths, ["node_modules/patched.js"]);
assert.equal(submitted.coverage.backend, "filesystem");
const persisted = db.sqlite.prepare("select coverage_json from work_session_submissions where id = ?").get(submitted.submissionId) as { coverage_json: string | null };
assert.ok(persisted.coverage_json, "coverage_json persisted");
assert.equal((JSON.parse(persisted.coverage_json) as { uncoveredPaths: string[] }).uncoveredPaths[0], "node_modules/patched.js");
const reloaded = workSessions.getSubmissions(session.id).find((s) => s.id === submitted.submissionId);
assert.deepEqual(reloaded?.coverage?.uncoveredPaths, ["node_modules/patched.js"], "coverage round-trips through the row mapper");
const diffSha = submitted.diffSha256!;
const epoch = submitted.reviewEpoch;

// Ordinary approval is REFUSED.
await assert.rejects(
  () => workflow.provideFeedback({
    sessionId: session.id,
    submissionId: submitted.submissionId,
    diffSha256: diffSha,
    reviewEpoch: epoch,
    verdict: "approve",
    comments: "ship it",
    reviewerId: "webui",
  }),
  (error: unknown) => {
    assert.ok(error instanceof WorkflowError && error.code === "conflict");
    assert.match(error.message, /cannot represent/);
    assert.match(error.message, /node_modules\/patched\.js/);
    return true;
  },
);

// The session is still awaiting_review — the refusal consumed nothing.
assert.equal(workSessions.get(session.id)?.status, "awaiting_review");

// Explicit acceptance approves, and the feedback event records the acceptance
// with the exact path list for audit.
await workflow.provideFeedback({
  sessionId: session.id,
  submissionId: submitted.submissionId,
  diffSha256: diffSha,
  reviewEpoch: epoch,
  verdict: "approve",
  comments: "hidden path reviewed out-of-band",
  reviewerId: "webui",
  acceptIncompleteCoverage: true,
});
assert.equal(workSessions.get(session.id)?.status, "approved");
const feedbackEvent = db.sqlite
  .prepare("select payload from event_log where type = 'review.feedback.provided' and session_id = ? order by seq desc limit 1")
  .get(session.id) as { payload: string };
const payload = JSON.parse(feedbackEvent.payload) as { acceptedIncompleteCoverage?: boolean; uncoveredPaths?: string[] };
assert.equal(payload.acceptedIncompleteCoverage, true);
assert.deepEqual(payload.uncoveredPaths, ["node_modules/patched.js"]);

// Control: a fully-covered submission needs no acknowledgment.
{
  const session2 = workSessions.create({ workspaceSessionId: "ws-coverage-e2e", submittedBy: "worker", completionPolicy: "webui_approval_required" });
  await checkpoints.clearRecordedMutations({ workspaceId: "ws-coverage-e2e" });
  const clean = await workflow.submitForReview({
    workSessionId: session2.id,
    diff: "nothing",
    snapshotKind: boundSnapshot.snapshotKind,
    snapshotRef: boundSnapshot.snapshotRef,
  });
  assert.equal(clean.coverage, undefined, "no coverage record when everything is representable");
  await workflow.provideFeedback({
    sessionId: session2.id,
    submissionId: clean.submissionId,
    diffSha256: clean.diffSha256!,
    reviewEpoch: clean.reviewEpoch,
    verdict: "approve",
    reviewerId: "webui",
  });
  assert.equal(workSessions.get(session2.id)?.status, "approved");
}

// Rejection / changes-requested are never gated by coverage.
{
  const session3 = workSessions.create({ workspaceSessionId: "ws-coverage-e2e", submittedBy: "worker", completionPolicy: "webui_approval_required" });
  writeFileSync(join(root, "node_modules", "patched.js"), "hidden edit 2\n");
  await checkpoints.recordMutations({ workspaceId: "ws-coverage-e2e", root, paths: [join(root, "node_modules", "patched.js")] });
  const flagged = await workflow.submitForReview({
    workSessionId: session3.id,
    diff: "x",
    snapshotKind: boundSnapshot.snapshotKind,
    snapshotRef: boundSnapshot.snapshotRef,
  });
  assert.ok(flagged.coverage);
  await workflow.provideFeedback({
    sessionId: session3.id,
    submissionId: flagged.submissionId,
    diffSha256: flagged.diffSha256!,
    reviewEpoch: flagged.reviewEpoch,
    verdict: "reject",
    comments: "not this",
    reviewerId: "webui",
  });
  assert.equal(workSessions.get(session3.id)?.status, "rejected");
}

workSessions.close();
agents.close();
eventStore.close();
db.close();
console.log("review-workflow.coverage: gate + explicit acceptance + audit trail passed");
