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

// P0.3: cross-conversation provide_policy_approval denial through the real
// MCP handler path. A reviewer bound to conversation B must not decide an
// approval owned by conversation A; workers and plain clients must be
// rejected by the role gate before any ownership check.
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

const root = mkdtempSync(join(tmpdir(), "kontrol-cross-conv-approval-"));
const database = openDatabase(root);
const workspaceStore = new SqliteWorkspaceStore(database);
const workspace = workspaceStore.createSession({ id: "ws-cross-conv", root: "/tmp/cross-conv" });
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

const created = approvalRequests.create({
  kind: "agent_permission",
  workspaceSessionId: workspace.id,
  ownerContextId: "conversation:conv-a",
  principalId: "principal-a",
  title: "cross-conversation guarded op",
  waiterKey: "waiter-cross-conv",
});

const serverB = reviewerServer("conv-b");
const foreign = await serverB.handlers.get("provide_policy_approval")!({
  approvalId: created.approvalId,
  decision: "deny",
  reason: "reviewer B must not decide A's approval",
});
assert.equal(foreign?.isError, true, "cross-conversation decision must be rejected");
assert.match(
  JSON.stringify(foreign?.content ?? ""),
  /another conversation/,
  "rejection must name the conversation-ownership reason",
);
assert.equal(
  approvalRequests.get(created.approvalId)?.status,
  "pending",
  "rejected foreign decision must leave the approval pending",
);

// Worker self-approval and plain-client decisions never reach ownership.
const worker = reviewerServer("conv-a", "worker");
const selfApprove = await worker.handlers.get("provide_policy_approval")!({
  approvalId: created.approvalId,
  decision: "approve",
});
assert.equal(selfApprove?.isError, true, "worker must not approve");
assert.match(JSON.stringify(selfApprove?.content ?? ""), /reviewer authority/);

const client = reviewerServer("conv-a", "client");
const clientList = await client.handlers.get("list_pending_approvals")!({});
assert.equal(clientList?.isError, true, "client must not enumerate approvals");
assert.match(JSON.stringify(clientList?.content ?? ""), /reviewer authority/);

// The owning conversation's reviewer decides; the one-shot grant is usable
// exactly once through the real handler path.
const serverA = reviewerServer("conv-a");
const decided = await serverA.handlers.get("provide_policy_approval")!({
  approvalId: created.approvalId,
  decision: "approve",
});
assert.notEqual(decided?.isError, true, `owning reviewer decision must succeed: ${JSON.stringify(decided)}`);
const resolved = approvalRequests.get(created.approvalId);
assert.equal(resolved?.status, "approved");
assert.equal(
  (resolved?.resolution as { scope?: string } | undefined)?.scope,
  "once",
  "approved generic decision persists a consumable once scope",
);
assert.equal(approvalRequests.consumeApprovedOperation("waiter-cross-conv"), true);
assert.equal(approvalRequests.consumeApprovedOperation("waiter-cross-conv"), false);

approvalRequests.close();
workspaceStore.close();
database.close();
rmSync(root, { recursive: true, force: true });
console.log("cross-conversation-approval.test.ts: all assertions passed");
