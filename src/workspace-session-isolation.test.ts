import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { WorkspaceRegistry } from "./workspaces.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "kontrol-workspace-session-isolation-")));
try {
  const nested = join(root, "nested");
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await writeFile(join(nested, "AGENTS.md"), "nested instructions\n");
  await writeFile(join(nested, "file.txt"), "hello\n");

  const config = loadConfig({
    KONTROL_ALLOWED_ROOTS: root,
    KONTROL_WORKTREE_ROOT: join(root, ".kontrol", "worktrees"),
    KONTROL_AGENT_DIR: join(root, ".pi", "agent"),
    KONTROL_OAUTH_OWNER_TOKEN: "workspace-session-isolation-token-that-is-long-enough",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const tabA = await registry.openWorkspace(root, "mcp-session-a");
  const tabB = await registry.openWorkspace(root, "mcp-session-b");

  assert.equal(tabA.workspace.id, tabB.workspace.id, "tabs share the canonical project workspace record");
  assert.equal(tabA.workspace.root, tabB.workspace.root);
  assert.notEqual(tabA.agentsFiles, tabB.agentsFiles, "tab-specific instruction snapshots are separate arrays");

  const nestedPath = join(nested, "file.txt");
  const loadedA = await registry.loadApplicableInstructions(tabA.workspace, nestedPath, "mcp-session-a");
  assert.equal(loadedA.length, 1, "tab A loads the nested instruction");
  const loadedB = await registry.loadApplicableInstructions(tabB.workspace, nestedPath, "mcp-session-b");
  assert.equal(loadedB.length, 1, "tab B independently loads the same nested instruction");
  assert.deepEqual(await registry.loadApplicableInstructions(tabA.workspace, nestedPath, "mcp-session-a"), loadedA,
    "discovery remains unacknowledged until the owning tool succeeds");
  registry.acknowledgeApplicableInstructions(tabA.workspace, loadedA, "mcp-session-a");
  assert.deepEqual(await registry.loadApplicableInstructions(tabA.workspace, nestedPath, "mcp-session-a"), [],
    "acknowledged instructions are cached only inside tab A");
  assert.equal((await registry.loadApplicableInstructions(tabB.workspace, nestedPath, "mcp-session-b")).length, 1,
    "acknowledging tab A does not acknowledge tab B instructions");

  const stateA = registry.getSessionState(tabA.workspace, "mcp-session-a");
  const stateB = registry.getSessionState(tabB.workspace, "mcp-session-b");
  assert.notEqual(stateA, stateB, "conversation state objects are not shared");
  stateA.activatedSkillDirs.add("/tmp/tab-a-skill");
  assert.equal(stateB.activatedSkillDirs.has("/tmp/tab-a-skill"), false,
    "activated skill directories do not cross tabs");

  registry.setActiveSession(tabA.workspace.id, "work-a", "mcp-session-a");
  registry.setActiveSession(tabB.workspace.id, "work-b", "mcp-session-b");
  assert.equal(registry.getCurrentWorkSessionId(tabA.workspace.id, "mcp-session-a"), "work-a");
  assert.equal(registry.getCurrentWorkSessionId(tabB.workspace.id, "mcp-session-b"), "work-b");
  assert.equal(registry.getCurrentWorkSessionId(tabA.workspace.id, "mcp-session-b"), "work-b",
    "each tab reads only its own active work-session attribution");

  registry.clearSessionState("mcp-session-a");
  assert.equal(registry.getCurrentWorkSessionId(tabA.workspace.id, "mcp-session-a"), undefined,
    "closing a tab clears its conversation state");
  assert.equal(registry.getCurrentWorkSessionId(tabB.workspace.id, "mcp-session-b"), "work-b",
    "closing one tab preserves another tab's state");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("workspace-session-isolation.test.ts: all assertions passed");
