import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { createEventStore } from "./event-log.js";
import { createApprovalRequestManager } from "./approval-requests.js";
import { createPolicyEngine } from "./policy.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { registerPolicyTools } from "./policy-tools.js";

// P0.2 item 3: get_approval_status reports exact terminal status and
// one-shot consumption through the real handler path, gated by reviewer
// role and conversation ownership. Reviewers query here instead of
// inferring outcomes from absence in list_pending_approvals.
function fakeServer(): {
  registerTool: (n: string, c: unknown, h: (a: any) => any) => undefined;
  handlers: Map<string, (a: any) => any>;
} {
  const handlers = new Map<string, (a: any) => any>();
  return {
    registerTool: (name, _cfg, handler) => {
      handlers.set(name, handler);
      return undefined;
    },
    handlers,
  };
}

const root = mkdtempSync(join(tmpdir(), "kontrol-approval-status-"));
const database = openDatabase(root);
const workspaceStore = new SqliteWorkspaceStore(database);
const workspace = workspaceStore.createSession({ id: "ws-approval-status", root: "/tmp/approval-status" });
const eventStore = createEventStore(database);
const policyEngine = createPolicyEngine({ defaultMode: "ask", toolRules: {}, pathRules: [] });
const approvalRequests = createApprovalRequestManager(database);

function reviewerServer(conversationId: string, role: "reviewer" | "worker" | "client" = "reviewer") {
  const server = fakeServer();
  registerPolicyTools(server as any, {
    eventStore,
    policyEngine,
    approvalRequests,
    principalRole: role,
    principalId: `test-${role}`,
    connectionContext: { conversationId, mcpSessionId: `sess-${conversationId}-${role}` } as any,
  });
  return server;
}

const serverA = reviewerServer("conv-a");
const statusOf = (approvalId: string) =>
  serverA.handlers.get("get_approval_status")!({ approvalId }).then((r: any) => r.structuredContent.approval);

// Pending durable row reports pending with no consumption.
const pending = approvalRequests.create({
  kind: "agent_permission",
  workspaceSessionId: workspace.id,
  ownerContextId: "conversation:conv-a",
  principalId: "principal-a",
  title: "status probe op",
  waiterKey: "waiter-status-probe",
});
assert.equal((await statusOf(pending.approvalId)).status, "pending");
assert.equal((await statusOf(pending.approvalId)).found, true);
assert.equal((await statusOf(pending.approvalId)).consumed, false);

// Approved via the generic handler path: scope + reviewer persist, then the
// exact operation consumes once and the endpoint shows it.
const decided = await serverA.handlers.get("provide_policy_approval")!({
  approvalId: pending.approvalId,
  decision: "approve",
});
assert.notEqual(decided?.isError, true);
const approved = await statusOf(pending.approvalId);
assert.equal(approved.status, "approved");
assert.equal(approved.scope, "once");
assert.equal(approved.reviewerId, "test-reviewer");
assert.equal(approved.consumed, false, "approved but not yet retried: not consumed");
assert.equal(approvalRequests.consumeApprovedOperation("waiter-status-probe"), true);
const consumed = await statusOf(pending.approvalId);
assert.equal(consumed.status, "approved");
assert.equal(consumed.consumed, true, "the retry consumed the one-shot grant");
assert.ok(typeof consumed.consumedAt === "string", "consumption carries a timestamp");

// Denied rows report denied and never consume.
const deniedRow = approvalRequests.create({
  kind: "agent_permission",
  workspaceSessionId: workspace.id,
  ownerContextId: "conversation:conv-a",
  principalId: "principal-a",
  title: "denied probe op",
  waiterKey: "waiter-status-denied",
});
await serverA.handlers.get("provide_policy_approval")!({ approvalId: deniedRow.approvalId, decision: "deny" });
const denied = await statusOf(deniedRow.approvalId);
assert.equal(denied.status, "denied");
assert.equal(denied.consumed, false);
assert.equal(approvalRequests.consumeApprovedOperation("waiter-status-denied"), false);

// Unknown ids are explicit, not errors.
const missing = await statusOf("apr_does_not_exist");
assert.equal(missing.found, false);
assert.equal(missing.status, "unknown");

// Role gate: workers and clients cannot read approval status.
for (const role of ["worker", "client"] as const) {
  const other = reviewerServer("conv-a", role);
  const result = await other.handlers.get("get_approval_status")!({ approvalId: pending.approvalId });
  assert.equal(result?.isError, true, `${role} must be denied`);
  assert.match(JSON.stringify(result?.content ?? ""), /reviewer authority/);
}

// Conversation isolation: reviewer B cannot read A's approval.
const serverB = reviewerServer("conv-b");
const foreign = await serverB.handlers.get("get_approval_status")!({ approvalId: pending.approvalId });
assert.equal(foreign?.isError, true, "cross-conversation status reads are forbidden");
assert.match(JSON.stringify(foreign?.content ?? ""), /another conversation/);

approvalRequests.close();
workspaceStore.close();
database.close();
rmSync(root, { recursive: true, force: true });
console.log("approval-status.test.ts: all assertions passed");
