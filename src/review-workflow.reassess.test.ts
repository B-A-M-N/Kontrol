/**
 * Unknown-provenance reassessment: unknown shell mutation provenance must
 * fail closed across resubmission (clearing the checkpoint ledger must not
 * convert unknown to complete). The only recovery is an explicit, audited
 * reassessment by review authority that (a) verifies the live workspace
 * against the inspected snapshot, (b) records a fresh coverage assessment,
 * and (c) preserves the original unknown evidence rows.
 *
 * Matrix:
 *  - unknown provenance -> submission unknown, approval blocked, and a
 *    replacement submission is STILL unknown (no ledger-clear conversion)
 *  - reassessment without reviewer principal -> rejected
 *  - reassessment with pending (unresolved) provenance -> rejected
 *  - reassessment against a stale snapshot -> rejected, still unknown
 *  - reviewer reassessment with matching snapshot -> audited, original
 *    unknown rows preserved, replacement submission approvable
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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

const state = mkdtempSync(join(tmpdir(), "kontrol-reassess-"));
const root = mkdtempSync(join(tmpdir(), "kontrol-reassess-root-"));
writeFileSync(join(root, "app.ts"), "export {};\n");
const db = openDatabase(state);
db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, ?, 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-reassess", root);
const provenanceDb = new Database(join(state, "provenance.sqlite"));
migrateDatabase(provenanceDb);
const workSessions = createWorkSessionManager(db);
const eventStore = createEventStore(db);
const continuations = createContinuationManager(db);
const agents = createAgentRegistryManager(db);
const checkpoints = createReviewCheckpointManager({ snapshotStoreRoot: join(state, "snapshots"), mutationProvenanceSqlite: provenanceDb });
const workspaces = { getWorkspace: () => ({ id: "ws-reassess", root, mode: "checkout" }) } as any;
const workflow = createReviewWorkflowService({ workSessions, eventStore, continuationManager: continuations, agentRegistry: agents, db, workspaces, reviewCheckpoints: checkpoints });

const boundSnapshot = await checkpoints.reviewChanges({
  workspaceId: "ws-reassess",
  root,
  since: "workspace_open",
  markReviewed: false,
});

async function submit(sessionId: string, diff: string) {
  const submitted = await workflow.submitForReview({
    workSessionId: sessionId,
    diff,
    snapshotKind: boundSnapshot.snapshotKind,
    snapshotRef: boundSnapshot.snapshotRef,
  });
  await checkpoints.commitReviewedSnapshot({
    workspaceId: "ws-reassess",
    root,
    workSessionId: sessionId,
    snapshot: boundSnapshot.snapshot,
  });
  return submitted;
}

const session = workSessions.create({ workspaceSessionId: "ws-reassess", submittedBy: "worker", completionPolicy: "webui_approval_required" });

// Unknown shell provenance: pathless intent resolved unknown.
const operationId = await checkpoints.beginMutationIntent({ workspaceId: "ws-reassess", root, workSessionId: session.id, paths: [] });
await checkpoints.resolveMutationIntent({ workspaceId: "ws-reassess", operationId, outcome: "unknown" });

const first = await submit(session.id, "unknown shell work");
assert.equal(first.coverageStatus, "unknown", "unknown provenance submission is unknown");
await assert.rejects(
  () => workflow.provideFeedback({
    sessionId: session.id,
    submissionId: first.submissionId,
    diffSha256: first.diffSha256,
    reviewEpoch: first.reviewEpoch,
    verdict: "approve",
    reviewerId: "webui",
    invocationOrigin: "authenticated_reviewer",
  }),
  (error: unknown) => error instanceof WorkflowError && /coverage is unknown/i.test(error.message),
);

// Reviewer refuses the unknown submission; the worker must not be able to
// launder it by simply resubmitting after the checkpoint ledger cleared.
await workflow.provideFeedback({
  sessionId: session.id,
  submissionId: first.submissionId,
  diffSha256: first.diffSha256,
  reviewEpoch: first.reviewEpoch,
  verdict: "changes_requested",
  comments: "shell provenance unknown; reassess before resubmission",
  reviewerId: "webui",
  invocationOrigin: "authenticated_reviewer",
});
const replacement = await submit(session.id, "resubmission without reassessment");
assert.equal(replacement.coverageStatus, "unknown",
  "resubmission without reassessment remains unknown (no ledger-clear conversion)");

// Reassessment without an authenticated reviewer principal is rejected.
await assert.rejects(
  () => (workflow as any).reassessUnknownProvenance({
    sessionId: session.id,
    snapshotKind: boundSnapshot.snapshotKind,
    snapshotRef: boundSnapshot.snapshotRef,
    reason: "self-authorized",
    invocationOrigin: "authenticated_reviewer",
  }),
  (error: unknown) => error instanceof WorkflowError,
);

// Pending provenance cannot be reassessed: the outcome must resolve first.
const pendingId = await checkpoints.beginMutationIntent({ workspaceId: "ws-reassess", root, workSessionId: session.id, paths: [] });
await assert.rejects(
  () => (workflow as any).reassessUnknownProvenance({
    sessionId: session.id,
    snapshotKind: boundSnapshot.snapshotKind,
    snapshotRef: boundSnapshot.snapshotRef,
    reason: "premature",
    invocationOrigin: "authenticated_reviewer",
    reviewerPrincipalId: "reviewer-1",
  }),
  (error: unknown) => error instanceof WorkflowError && /pending/i.test(error.message),
);
await checkpoints.resolveMutationIntent({ workspaceId: "ws-reassess", operationId: pendingId, outcome: "unknown" });

// Reassessment against a stale snapshot is rejected and converts nothing.
writeFileSync(join(root, "app.ts"), "export const changed = true;\n");
await assert.rejects(
  () => (workflow as any).reassessUnknownProvenance({
    sessionId: session.id,
    snapshotKind: boundSnapshot.snapshotKind,
    snapshotRef: boundSnapshot.snapshotRef,
    reason: "stale inspection",
    invocationOrigin: "authenticated_reviewer",
    reviewerPrincipalId: "reviewer-1",
  }),
  (error: unknown) => error instanceof WorkflowError && /does not match/i.test(error.message),
);
const stillUnknown = await checkpoints.checkpointCoverage({ workspaceId: "ws-reassess", root, workSessionId: session.id });
assert.equal(stillUnknown.status, "unknown", "failed reassessment leaves coverage unknown");

// Restore the inspected tree; the reviewer reassessment now verifies.
writeFileSync(join(root, "app.ts"), "export {};\n");
const reassessed = await (workflow as any).reassessUnknownProvenance({
  sessionId: session.id,
  snapshotKind: boundSnapshot.snapshotKind,
  snapshotRef: boundSnapshot.snapshotRef,
  reason: "inspected live workspace against the submitted snapshot; shell effects bounded to the reviewed tree",
  invocationOrigin: "authenticated_reviewer",
  reviewerPrincipalId: "reviewer-1",
  reviewerOwnerContextId: "owner-1",
});
assert.ok(reassessed.reassessmentId, "reassessment is recorded");
assert.ok(Array.isArray(reassessed.operationIds) && reassessed.operationIds.includes(operationId), "reassessment references the original unknown operation");
assert.equal(reassessed.coverageStatus, "complete", "verified reassessment produces a fresh complete assessment");

// Original unknown evidence is preserved, not deleted or rewritten.
const preserved = provenanceDb.prepare("select state from review_mutation_provenance where operation_id = ?").get(operationId) as { state: string } | undefined;
assert.equal(preserved?.state, "unknown", "original unknown provenance row is preserved");
const reassessmentRow = provenanceDb.prepare("select operation_ids_json, reviewer_principal_id from review_mutation_reassessments where id = ?").get(reassessed.reassessmentId) as { operation_ids_json: string; reviewer_principal_id: string } | undefined;
assert.ok(reassessmentRow, "reassessment row persisted");
assert.ok((JSON.parse(reassessmentRow.operation_ids_json) as string[]).includes(operationId));
assert.equal(reassessmentRow.reviewer_principal_id, "reviewer-1");

// Audit event carries the reassessment identity.
const audit = db.sqlite.prepare("select payload from event_log where type = 'review.coverage.reassessed' and session_id = ?").get(session.id) as { payload: string } | undefined;
assert.ok(audit, "reassessment audit event persisted");
const auditPayload = JSON.parse(audit.payload) as { reassessmentId?: string; reviewerPrincipalId?: string };
assert.equal(auditPayload.reassessmentId, reassessed.reassessmentId);
assert.equal(auditPayload.reviewerPrincipalId, "reviewer-1");

// The original unknown submission stays blocked; a replacement submission
// after reassessment is approvable.
await assert.rejects(
  () => workflow.provideFeedback({
    sessionId: session.id,
    submissionId: replacement.submissionId,
    diffSha256: replacement.diffSha256,
    reviewEpoch: replacement.reviewEpoch,
    verdict: "approve",
    reviewerId: "webui",
    invocationOrigin: "authenticated_reviewer",
  }),
  (error: unknown) => error instanceof WorkflowError && /coverage is unknown/i.test(error.message),
  "the pre-reassessment submission remains unknown-covered",
);
// Return the session to a submittable state without approving the blocked
// replacement; changes-requested is never coverage-gated.
await workflow.provideFeedback({
  sessionId: session.id,
  submissionId: replacement.submissionId,
  diffSha256: replacement.diffSha256,
  reviewEpoch: replacement.reviewEpoch,
  verdict: "changes_requested",
  comments: "pre-reassessment submission superseded by reassessment",
  reviewerId: "webui",
  invocationOrigin: "authenticated_reviewer",
});
const approvable = await submit(session.id, "post-reassessment resubmission");
assert.equal(approvable.coverageStatus, "complete", "replacement submission after reassessment is complete");
await workflow.provideFeedback({
  sessionId: session.id,
  submissionId: approvable.submissionId,
  diffSha256: approvable.diffSha256,
  reviewEpoch: approvable.reviewEpoch,
  verdict: "approve",
  reviewerId: "webui",
  invocationOrigin: "authenticated_reviewer",
});
assert.equal(workSessions.get(session.id)?.status, "approved");

workSessions.close();
agents.close();
eventStore.close();
db.close();
provenanceDb.close();
console.log("review-workflow.reassess: unknown-provenance recovery matrix passed");
