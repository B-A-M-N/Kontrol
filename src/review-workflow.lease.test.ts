/**
 * Lease-fenced approval: approval must be refused while the checkout lease is
 * not legitimately owned by the reviewed work session.
 *
 * Matrix (approve verdict only; reject/changes_requested stay available):
 *  - conflicting modify lease (another work session)        -> blocked
 *  - matching-owner modify lease (the reviewed session)     -> allowed
 *  - cleanup-pending lease (even owned by reviewed session) -> blocked
 *  - peer-job reservation                                   -> blocked
 *  - no lease                                               -> allowed (control)
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { openDatabase } from "./db/client.js";
import { createEventStore } from "./event-log.js";
import { createContinuationManager } from "./continuation.js";
import { createAgentRegistryManager } from "./acp-registry.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createWorkSessionManager } from "./work-sessions.js";
import { createReviewWorkflowService, WorkflowError } from "./review-workflow.js";

const state = mkdtempSync(join(tmpdir(), "kontrol-review-lease-"));
const root = mkdtempSync(join(tmpdir(), "kontrol-review-lease-root-"));
writeFileSync(join(root, "app.ts"), "export {};\n");
const canonicalRoot = realpathSync(root);
const db = openDatabase(state);
db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, ?, 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-lease", root);
const workSessions = createWorkSessionManager(db);
const eventStore = createEventStore(db);
const continuations = createContinuationManager(db);
const agents = createAgentRegistryManager(db);
const checkpoints = createReviewCheckpointManager({ snapshotStoreRoot: join(state, "snapshots") });
const workspaces = { getWorkspace: () => ({ id: "ws-lease", root, mode: "checkout" }) } as any;
const workflow = createReviewWorkflowService({ workSessions, eventStore, continuationManager: continuations, agentRegistry: agents, db, workspaces, reviewCheckpoints: checkpoints });

const boundSnapshot = await checkpoints.reviewChanges({
  workspaceId: "ws-lease",
  root,
  since: "workspace_open",
  markReviewed: false,
});

async function submitFresh() {
  const session = workSessions.create({ workspaceSessionId: "ws-lease", submittedBy: "worker", completionPolicy: "webui_approval_required" });
  const submitted = await workflow.submitForReview({
    workSessionId: session.id,
    diff: "diff",
    snapshotKind: boundSnapshot.snapshotKind,
    snapshotRef: boundSnapshot.snapshotRef,
  });
  await checkpoints.commitReviewedSnapshot({
    workspaceId: "ws-lease",
    root,
    workSessionId: session.id,
    snapshot: boundSnapshot.snapshot,
  });
  return { session, submitted };
}

function approveArgs(sessionId: string, submitted: { submissionId: string; diffSha256?: string; reviewEpoch: number }, verdict: "approve" | "reject" | "changes_requested") {
  return {
    sessionId,
    submissionId: submitted.submissionId,
    diffSha256: submitted.diffSha256,
    reviewEpoch: submitted.reviewEpoch,
    verdict,
    comments: "lease matrix",
    reviewerId: "webui",
    invocationOrigin: "authenticated_reviewer" as const,
  };
}

function feedbackCount(sessionId: string): number {
  return (db.sqlite.prepare("select count(*) as count from work_session_feedback where work_session_id = ?").get(sessionId) as { count: number }).count;
}

function assertLeaseBlocked(error: unknown): boolean {
  assert.ok(error instanceof WorkflowError, `expected WorkflowError, got ${String(error)}`);
  assert.equal((error as WorkflowError).code, "conflict");
  assert.match((error as WorkflowError).message, /checkout lease/i);
  return true;
}

// 1. Conflicting modify lease owned by another work session blocks approval,
//    writes no feedback, and leaves rejection available.
{
  const { session, submitted } = await submitFresh();
  const other = workSessions.create({ workspaceSessionId: "ws-lease", submittedBy: "other-worker" });
  const acquired = workSessions.acquireWorkspaceLease({
    canonicalRoot,
    workspaceSessionId: "ws-lease",
    workSessionId: other.id,
  });
  assert.equal(acquired.acquired, true, "conflicting lease setup acquired");
  await assert.rejects(() => workflow.provideFeedback(approveArgs(session.id, submitted, "approve")), assertLeaseBlocked);
  assert.equal(workSessions.get(session.id)?.status, "awaiting_review", "blocked approval consumes nothing");
  assert.equal(feedbackCount(session.id), 0, "blocked approval writes no feedback");
  await workflow.provideFeedback(approveArgs(session.id, submitted, "reject"));
  assert.equal(workSessions.get(session.id)?.status, "rejected", "rejection remains available while approval is lease-blocked");
  workSessions.releaseWorkspaceLeasesForSession(other.id);
}

// 2. Matching-owner modify lease (the reviewed session itself) allows approval.
{
  const { session, submitted } = await submitFresh();
  const acquired = workSessions.acquireWorkspaceLease({
    canonicalRoot,
    workspaceSessionId: "ws-lease",
    workSessionId: session.id,
  });
  assert.equal(acquired.acquired, true, "matching lease setup acquired");
  await workflow.provideFeedback(approveArgs(session.id, submitted, "approve"));
  assert.equal(workSessions.get(session.id)?.status, "approved", "legitimate ownership by the reviewed session is supported");
  workSessions.releaseWorkspaceLeasesForSession(session.id);
}

// 3. Cleanup-pending lease blocks approval even when owned by the reviewed
//    session: a terminal-cleanup fence is not mutation authority and the
//    workspace may still be draining.
{
  const { session, submitted } = await submitFresh();
  const acquired = (workSessions as any).acquireWorkspaceLease({
    canonicalRoot,
    workspaceSessionId: "ws-lease",
    workSessionId: session.id,
    leaseKind: "cleanup_pending",
  });
  assert.equal(acquired.acquired, true, "cleanup-pending lease setup acquired");
  const active = workSessions.getActiveWorkspaceLease(canonicalRoot);
  assert.equal(active?.leaseKind, "cleanup_pending", "cleanup-pending fence is the active lease");
  await assert.rejects(() => workflow.provideFeedback(approveArgs(session.id, submitted, "approve")), assertLeaseBlocked);
  assert.equal(workSessions.get(session.id)?.status, "awaiting_review");
  assert.equal(feedbackCount(session.id), 0);
  // Changes-requested remains available while approval is blocked. It needs
  // the correction interrupt only when configured; here no callback is wired.
  await workflow.provideFeedback(approveArgs(session.id, submitted, "changes_requested"));
  assert.equal(workSessions.get(session.id)?.status, "changes_requested");
  // The fence itself is not cleared by review feedback: only verified
  // recovery/termination may clear a cleanup-pending lease.
  assert.equal(workSessions.getActiveWorkspaceLease(canonicalRoot)?.leaseKind, "cleanup_pending", "review feedback does not clear the cleanup fence");
  // Simulate verified termination clearing the fence before the next case.
  workSessions.releaseWorkspaceLeasesForSession(session.id);
  assert.equal(workSessions.getActiveWorkspaceLease(canonicalRoot), undefined);
}

// 4. Peer-job reservation blocks approval: the reservation is owned by the
//    peer processor, not by the reviewed worker session.
{
  const { session, submitted } = await submitFresh();
  const peerSession = workSessions.create({ workspaceSessionId: "ws-lease", submittedBy: "peer" });
  const acquired = workSessions.acquireWorkspaceLease({
    canonicalRoot,
    workspaceSessionId: "ws-lease",
    workSessionId: peerSession.id,
    ownerInstanceId: "peer-job:lease-matrix",
    leaseKind: "peer_job",
  });
  assert.equal(acquired.acquired, true, "peer-job lease setup acquired");
  await assert.rejects(() => workflow.provideFeedback(approveArgs(session.id, submitted, "approve")), assertLeaseBlocked);
  assert.equal(workSessions.get(session.id)?.status, "awaiting_review");
  assert.equal(feedbackCount(session.id), 0);
  await workflow.provideFeedback(approveArgs(session.id, submitted, "reject"));
  assert.equal(workSessions.get(session.id)?.status, "rejected", "rejection remains available under a peer-job reservation");
  // Terminalization of the reviewed session must not delete the peer fence.
  assert.equal(workSessions.getActiveWorkspaceLease(canonicalRoot)?.leaseKind, "peer_job", "peer reservation survives reviewed-session terminalization");
  workSessions.releaseWorkspaceLeaseForSession(peerSession.id, (workSessions.getWorkspaceLeaseForSession(peerSession.id) as any)?.leaseNonce ?? "");
}

// 5. Control: no lease at all allows approval (existing behavior preserved).
{
  assert.equal(workSessions.getActiveWorkspaceLease(canonicalRoot), undefined, "no active lease before control case");
  const { session, submitted } = await submitFresh();
  await workflow.provideFeedback(approveArgs(session.id, submitted, "approve"));
  assert.equal(workSessions.get(session.id)?.status, "approved");
}

workSessions.close();
agents.close();
eventStore.close();
db.close();
console.log("review-workflow.lease: conflicting/matching/cleanup-pending/peer-job matrix passed");
