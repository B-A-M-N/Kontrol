import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { createWorkSessionManager } from "./work-sessions/index.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { createPolicyEngine, type ToolApprovalRequest } from "./policy.js";
import { loadConfig } from "./config.js";
import { brandWorkspaceId } from "./branded.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-owner-approval-"));
const database = openDatabase(join(root, "state"));
const workspaceStore = new SqliteWorkspaceStore(database);
const workspace = workspaceStore.createSession({ id: "workspace-owner-approval", root });
const workSessions = createWorkSessionManager(database);
const policy = createPolicyEngine({ defaultMode: "ask", toolRules: { bash: "ask" }, pathRules: [] });
const a: ToolApprovalRequest = {
  id: "approval-a", principalId: "conversation:a", ownerContextId: "conversation:a", workspaceId: brandWorkspaceId(workspace.id),
  approvalKey: "bash", waiterKey: "operation:a", origin: "direct_mcp", tool: "bash", requestedAt: new Date().toISOString(),
};
const b: ToolApprovalRequest = {
  id: "approval-b", principalId: "conversation:b", ownerContextId: "conversation:b", workspaceId: brandWorkspaceId(workspace.id),
  approvalKey: "bash", waiterKey: "operation:b", origin: "direct_mcp", tool: "bash", requestedAt: new Date().toISOString(),
};
policy.addPending(a);
policy.addPending(b);
const ownerA = policy.getPendingApprovals(workspace.id).filter((row) => row.ownerContextId === "conversation:a");
const ownerB = policy.getPendingApprovals(workspace.id).filter((row) => row.ownerContextId === "conversation:b");
assert.deepEqual(ownerA.map((row) => row.id), ["approval-a"]);
assert.deepEqual(ownerB.map((row) => row.id), ["approval-b"]);
assert.equal(ownerA[0]?.conversationId, undefined, "approval cards do not need to leak conversation metadata into the model result");
workSessions.close();
workspaceStore.close?.();
console.log("owner-scoped-approval.test.ts: all assertions passed");
