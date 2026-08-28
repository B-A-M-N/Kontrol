import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { createApprovalRequestManager } from "./approval-requests.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-approval-pages-"));
const database = openDatabase(root);
const workspaceStore = new SqliteWorkspaceStore(database);
const workspace = workspaceStore.createSession({ id: "ws-approval-pages", root: "/tmp/approval-pages" });
const approvals = createApprovalRequestManager(database);

try {
  const created = Array.from({ length: 3 }, (_, index) => approvals.create({
    kind: "tool",
    workspaceSessionId: workspace.id,
    principalId: "principal-pages",
    title: `approval-${index}`,
  }));

  const seen: string[] = [];
  let cursor: { createdAt: string; id: string } | undefined;
  let page;
  do {
    page = approvals.listPendingPage(workspace.id, 1, cursor);
    seen.push(...page.requests.map((approval) => approval.approvalId));
    cursor = page.nextBefore;
  } while (page.hasMore);
  assert.deepEqual(new Set(seen), new Set(created.map((approval) => approval.approvalId)), "bounded approval pages must cover each pending row exactly once");
  assert.equal(seen.length, created.length);

  const expired = approvals.create({
    kind: "tool",
    workspaceSessionId: workspace.id,
    principalId: "principal-pages",
    title: "expired",
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const firstExpiry = approvals.expirePending(new Date().toISOString(), 1);
  assert.equal(firstExpiry.length, 1, "expiry must honor its page limit");
  assert.equal(firstExpiry[0]?.approvalId, expired.approvalId);
} finally {
  approvals.close();
  workspaceStore.close();
  database.close();
  rmSync(root, { recursive: true, force: true });
}

// P1 — direct approvals are pending human decisions, not orphans. A direct
// (non-blocking) approval parks no live waiter, so it is born
// pending_human_approval with no orphan metadata and stays decidable for its
// full human TTL — only expiry (or a reviewer decision) resolves it. A
// liveness touch from a retry refreshes the reattachment diagnostic without
// turning the row into an orphan, and a detached caller's window governs
// reattachment classification, never automatic cancellation.
{
  const root = mkdtempSync(join(tmpdir(), "kontrol-approval-lifecycle-"));
  const database = openDatabase(root);
  const workspaceStore = new SqliteWorkspaceStore(database);
  const workspace = workspaceStore.createSession({ id: "ws-approval-lifecycle", root: "/tmp/approval-lifecycle" });
  const SHORT_TTL_MS = 80;
  const GRACE_MS = 40;
  const approvals = createApprovalRequestManager(database, {
    directToolApprovalTtlMs: SHORT_TTL_MS,
    directReattachGraceMs: GRACE_MS,
  });

  try {
    const direct = approvals.create({
      kind: "tool",
      workspaceSessionId: workspace.id,
      principalId: "principal-lifecycle",
      title: "direct bash",
      origin: "direct_mcp",
    });
    assert.equal(direct.orphanedAt ?? null, null,
      "a fresh direct approval must not be marked orphaned at creation");
    assert.equal(direct.reattachDeadline ?? null, null,
      "a fresh direct approval must not carry a reattachment deadline");
    assert.ok(direct.expiresAt, "a direct tool approval must carry its human TTL");

    // A retry (liveness touch) refreshes the reattachment diagnostic but does
    // not manufacture an orphan timestamp.
    approvals.touchDirectApproval(direct.approvalId);
    const touched = approvals.get(direct.approvalId);
    assert.ok(touched, "touched approval must still exist");
    assert.equal(touched.orphanedAt ?? null, null,
      "a liveness touch must not mark the row orphaned");
    assert.ok(touched.reattachDeadline, "a liveness touch refreshes the reattachment diagnostic");

    // Well past the reattachment grace but within the human TTL the row
    // remains pending — the reattachment window is a diagnostic, not a
    // cancellation trigger.
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS + 30));
    const survived = approvals.get(direct.approvalId);
    assert.ok(survived, "the row must survive past its reattachment window");
    assert.equal(survived.status, "pending",
      "the reattachment window must never cancel a pending human decision");

    // The human TTL is what ends an undecided direct approval.
    await new Promise((resolve) => setTimeout(resolve, SHORT_TTL_MS));
    const expiredList = approvals.expirePending();
    assert.ok(expiredList.some((approval) => approval.approvalId === direct.approvalId),
      "the human TTL (expirePending) must be the automatic cancellation path");
    assert.equal(approvals.get(direct.approvalId)?.status, "expired");

    // A detached live waiter records an orphan timestamp at detach time, and
    // that row is classified as an abandoned operation past its window — but
    // resolution still belongs to expiry or a reviewer, never to a timer.
    const detached = approvals.create({
      kind: "tool",
      workspaceSessionId: workspace.id,
      principalId: "principal-lifecycle",
      title: "detached direct bash",
      origin: "direct_mcp",
      liveWaiterId: "waiter-1",
      // Isolate reattach-window semantics from TTL expiry in this block.
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(detached.orphanedAt ?? null, null,
      "an approval with an attached live waiter is not orphaned");
    approvals.detachLiveWaiter(detached.approvalId, "waiter-1");
    const afterDetach = approvals.get(detached.approvalId);
    assert.ok(afterDetach?.orphanedAt, "detaching the live waiter records the orphan timestamp");
    assert.ok(afterDetach.reattachDeadline, "detaching opens a bounded reattachment window");
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS + 60));
    const detachedSurvivor = approvals.get(detached.approvalId);
    assert.equal(detachedSurvivor?.status, "pending",
      "an elapsed reattachment window must not cancel the row either");
    assert.ok((detachedSurvivor?.reattachDeadline ?? "") <= new Date().toISOString(),
      "the detached row is classifiable as an abandoned operation");
  } finally {
    approvals.close();
    workspaceStore.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("approval-requests.test.ts: bounded pending pages and expiry passed");
