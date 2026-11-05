import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { createApprovalRequestManager } from "./approval-requests.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { genericApprovalScope } from "./policy-tools.js";

// P0: a generic approval recorded as approved must carry a usable
// one-shot scope, or the authorization barrier can never consume it.
// Full sequence: request -> approve -> scope=once persisted ->
// exact operation consumes once -> second consumption refused.
{
  const root = mkdtempSync(join(tmpdir(), "kontrol-approval-scope-once-"));
  const database = openDatabase(root);
  const workspaceStore = new SqliteWorkspaceStore(database);
  const workspace = workspaceStore.createSession({ id: "ws-scope-once", root: "/tmp/scope-once" });
  const approvals = createApprovalRequestManager(database);

  try {
    const created = approvals.create({
      kind: "tool",
      workspaceSessionId: workspace.id,
      principalId: "principal-scope",
      title: "one-shot op",
      waiterKey: "waiter-scope-once",
      options: [{ id: "approve", label: "Approve", effect: "approve" }],
    });

    // The generic branch derives scope from the server-validated
    // option, never from an arbitrary client-supplied scope.
    assert.equal(genericApprovalScope(created.options[0]!), "once");

    // This is the exact call shape the fixed generic branch makes.
    const resolved = approvals.resolve(created.approvalId, {
      status: "approved",
      optionId: "approve",
      effect: "approve",
      scope: genericApprovalScope(created.options[0]!),
      reviewerId: "reviewer-1",
    });
    assert.equal(resolved?.status, "approved");
    assert.equal((resolved?.resolution as { scope?: string } | undefined)?.scope, "once");
    assert.equal((resolved?.resolution as { reviewerId?: string } | undefined)?.reviewerId, "reviewer-1");

    assert.equal(approvals.consumeApprovedOperation("waiter-scope-once"), true,
      "first retry of the exact operation must consume the approval");
    assert.equal(approvals.consumeApprovedOperation("waiter-scope-once"), false,
      "a second consumption must be refused: one-shot means once");
  } finally {
    approvals.close();
    workspaceStore.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// Scope/option consistency is enforced in resolve(): a requested
// scope that does not match the selected option is refused, never
// silently converted. Denials carry no scope.
{
  const root = mkdtempSync(join(tmpdir(), "kontrol-approval-scope-mismatch-"));
  const database = openDatabase(root);
  const workspaceStore = new SqliteWorkspaceStore(database);
  const workspace = workspaceStore.createSession({ id: "ws-scope-mismatch", root: "/tmp/scope-mismatch" });
  const approvals = createApprovalRequestManager(database);

  try {
    const narrow = approvals.create({
      kind: "tool",
      workspaceSessionId: workspace.id,
      principalId: "principal-mismatch",
      title: "narrow option",
      options: [{ id: "approve", label: "Approve", effect: "approve" }],
    });
    assert.throws(
      () => approvals.resolve(narrow.approvalId, {
        status: "approved", optionId: "approve", effect: "approve", scope: "workspace",
      }),
      /scope/i,
      "a workspace scope on an option that promises no breadth must be refused",
    );
    assert.equal(approvals.get(narrow.approvalId)?.status, "pending",
      "refused resolution must leave the request pending");

    const denied = approvals.create({
      kind: "tool",
      workspaceSessionId: workspace.id,
      principalId: "principal-mismatch",
      title: "denied option",
      waiterKey: "waiter-denied",
      options: [
        { id: "approve", label: "Approve", effect: "approve" },
        { id: "deny", label: "Deny", effect: "deny" },
      ],
    });
    const resolvedDenied = approvals.resolve(denied.approvalId, {
      status: "denied", optionId: "deny", effect: "deny", reviewerId: "reviewer-1",
    });
    assert.equal(resolvedDenied?.status, "denied");
    assert.equal(approvals.consumeApprovedOperation("waiter-denied"), false,
      "a denial must never authorize the operation");
  } finally {
    approvals.close();
    workspaceStore.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("approval-scope-once.test.ts: all assertions passed");
