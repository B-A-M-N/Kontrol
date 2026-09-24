import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp/workspace-server.js";
import { loadConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { WorkspaceRegistry } from "./workspaces.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-mcp-workspace-isolation-"));
try {
  await mkdir(join(root, "nested"), { recursive: true });
  await mkdir(join(root, "nested", "unread"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");
  await writeFile(join(root, "nested", "unread", "AGENTS.md"), "unread instructions\n");
  await writeFile(join(root, "nested", "unread", "file.txt"), "before\n");

  const config = loadConfig({
    KONTROL_ALLOWED_ROOTS: root,
    KONTROL_WORKTREE_ROOT: join(root, ".kontrol", "worktrees"),
    KONTROL_AGENT_DIR: join(root, ".pi", "agent"),
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_ACP_ENABLED: "false",
    KONTROL_POLICY_MODE: "allow",
    KONTROL_LOG_LEVEL: "error",
    KONTROL_LOG_REQUESTS: "0",
    KONTROL_TOOL_MODE: "full",
    PORT: "1",
  });
  const workspaces = new WorkspaceRegistry(config);
  const checkpoints = createReviewCheckpointManager({ snapshotStoreRoot: join(root, ".snapshots") });
  const processSessions = new ProcessSessionManager({ childEnvironmentAllowlist: [] });

  async function openTab(name: string) {
    const context = { mcpSessionId: name, conversationId: name };
    const server = createMcpServer(config, workspaces, checkpoints, processSessions, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, context);
    const client = new Client({ name, version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, server, context };
  }

  const tabA = await openTab("tab-a");
  const tabB = await openTab("tab-b");
  try {
    const openedA = await tabA.client.callTool({ name: "open_workspace", arguments: { path: root, mode: "checkout" } });
    const openedB = await tabB.client.callTool({ name: "open_workspace", arguments: { path: root, mode: "checkout" } });
    const workspaceA = (openedA.structuredContent as any).workspaceId;
    const workspaceB = (openedB.structuredContent as any).workspaceId;
    assert.equal(workspaceA, workspaceB, "tabs share the project workspace id");

    const readA = await tabA.client.callTool({ name: "read", arguments: { workspaceId: workspaceA, path: "nested/file.txt" } });
    const readB = await tabB.client.callTool({ name: "read", arguments: { workspaceId: workspaceB, path: "nested/file.txt" } });
    const textA = (readA.content as Array<{ text?: string }>).map((item) => item.text ?? "").join("\n");
    const textB = (readB.content as Array<{ text?: string }>).map((item) => item.text ?? "").join("\n");
    assert.match(textA, /nested instructions/,
      "tab A must independently receive the full nested instruction contents");
    assert.match(textB, /nested instructions/,
      "tab B must independently receive the full nested instruction contents");
    assert.notEqual(workspaces.getSessionState(workspaces.getWorkspace(workspaceA), "tab-a"),
      workspaces.getSessionState(workspaces.getWorkspace(workspaceA), "tab-b"),
      "the two transport contexts must not share state");

    const blockedEdit = await tabA.client.callTool({
      name: "edit",
      arguments: {
        workspaceId: workspaceA,
        path: "nested/unread/file.txt",
        edits: [{ oldText: "before", newText: "changed" }],
      },
    });
    const blocked = blockedEdit.structuredContent as { status?: string; instructionContentHash?: string };
    assert.equal(blocked.status, "instructions_required");
    assert.equal(typeof blocked.instructionContentHash, "string");
    assert.equal(await readFile(join(root, "nested", "unread", "file.txt"), "utf8"), "before\n", "unacknowledged nested instructions must block the mutation");

    const acknowledgedEdit = await tabA.client.callTool({
      name: "edit",
      arguments: {
        workspaceId: workspaceA,
        path: "nested/unread/file.txt",
        edits: [{ oldText: "before", newText: "changed" }],
        instructionContentHash: blocked.instructionContentHash,
      },
    });
    assert.equal(acknowledgedEdit.isError, undefined, "hash-bound instruction retry must succeed");
    assert.equal(await readFile(join(root, "nested", "unread", "file.txt"), "utf8"), "changed\n", "acknowledged instruction retry must apply the intended edit");
  } finally {
    await tabA.client.close();
    await tabB.client.close();
    await tabA.server.close();
    await tabB.server.close();
    await checkpoints.drain();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("workspace-session-mcp-isolation.test.ts: all assertions passed");
