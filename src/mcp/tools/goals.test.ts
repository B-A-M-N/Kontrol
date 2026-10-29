import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { loadConfig } from "../../config.js";
import { createGoalStore } from "../../goal-store.js";
import { openDatabase } from "../../db/client.js";
import { createWorkspaceStore } from "../../workspace-store.js";
import { registerGoalTools } from "./goals.js";

const stateDir = await mkdtemp(join(tmpdir(), "kontrol-goal-tools-test-"));
const rootA = join(stateDir, "workspace-a");
const rootB = join(stateDir, "workspace-b");
const config = loadConfig({
  KONTROL_ALLOWED_ROOTS: stateDir,
  KONTROL_TOOL_MODE: "codex",
  KONTROL_WIDGETS: "off",
  KONTROL_OAUTH_OWNER_TOKEN: "goal-tools-test-owner-token-with-sufficient-entropy",
  PORT: "1",
});
const db = openDatabase(stateDir);
const workspaceStore = createWorkspaceStore(db);
const goalStore = createGoalStore(db);
const workspaceA = workspaceStore.createSession({ id: "goal-workspace-a", root: rootA });
const workspaceB = workspaceStore.createSession({ id: "goal-workspace-b", root: rootB });
const workspaces = { getWorkspace(id: string) {
  const workspace = workspaceStore.getSession(id);
  if (!workspace) throw new Error("Unknown workspace");
  return workspace;
} } as any;
const server = new McpServer({ name: "goal-tools-test", version: "1.0.0" });
const client = new Client({ name: "goal-tools-test-client", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
registerGoalTools(server, config, workspaces, goalStore);

try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const descriptors = await client.listTools();
  assert.deepEqual(
    descriptors.tools.filter((tool) => tool.name.endsWith("_goal")).map((tool) => tool.name).sort(),
    ["create_goal", "get_goal", "update_goal"],
  );

  const missing = await client.callTool({ name: "get_goal", arguments: { workspaceId: workspaceA.id } });
  assert.equal((missing.structuredContent as { goal: unknown }).goal, null);
  const created = await client.callTool({ name: "create_goal", arguments: {
    workspaceId: workspaceA.id,
    objective: "  verify durable workspace goal workflow  ",
  } });
  assert.equal(created.isError, undefined);
  const firstGoal = (created.structuredContent as { goal: { goalId: string; objective: string; status: string } }).goal;
  assert.equal(firstGoal.objective, "verify durable workspace goal workflow");
  assert.equal(firstGoal.status, "active");

  const otherWorkspace = await client.callTool({ name: "get_goal", arguments: { workspaceId: workspaceB.id } });
  assert.equal((otherWorkspace.structuredContent as { goal: unknown }).goal, null,
    "workspace goals are isolated by workspace identity");
  const rejectedDuplicate = await client.callTool({ name: "create_goal", arguments: {
    workspaceId: workspaceA.id,
    objective: "replace active goal",
  } });
  assert.equal(rejectedDuplicate.isError, true, "active goals cannot be silently overwritten");

  const blocked = await client.callTool({ name: "update_goal", arguments: { workspaceId: workspaceA.id, status: "blocked" } });
  assert.equal((blocked.structuredContent as { goal: { status: string } }).goal.status, "blocked");
  const completed = await client.callTool({ name: "update_goal", arguments: { workspaceId: workspaceA.id, status: "complete" } });
  const completedGoal = (completed.structuredContent as { goal: { status: string; completedAt?: string } }).goal;
  assert.equal(completedGoal.status, "complete");
  assert.ok(completedGoal.completedAt);

  goalStore.close?.();
  const reopened = createGoalStore(db);
  try {
    assert.equal(reopened.getGoal(workspaceA.id)?.goalId, firstGoal.goalId,
      "goal identity and completed state survive store reconstruction");
    assert.equal(reopened.getGoal(workspaceA.id)?.status, "complete");
  } finally {
    reopened.close?.();
  }

  const unknown = await client.callTool({ name: "get_goal", arguments: { workspaceId: "unknown-workspace" } });
  assert.equal(unknown.isError, true, "goal tools require a currently open workspace");
} finally {
  await Promise.all([client.close(), server.close()]);
  goalStore.close?.();
  workspaceStore.close?.();
  db.close();
  await rm(stateDir, { recursive: true, force: true });
}

console.log("mcp/tools/goals.test.ts: API lifecycle, workspace isolation, and persistence passed");
