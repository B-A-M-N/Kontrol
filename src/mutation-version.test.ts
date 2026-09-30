import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp/workspace-server.js";
import { loadConfig } from "./config.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { WorkspaceRegistry } from "./workspaces.js";

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

async function openHarness(root: string, mode: "full" | "codex") {
  const harnessRoot = mkdtempSync(join(tmpdir(), `kontrol-mutation-version-${mode}-`));
  const config = loadConfig({
    KONTROL_CONFIG_DIR: join(harnessRoot, "config"),
    KONTROL_ALLOWED_ROOTS: root,
    KONTROL_STATE_DIR: join(harnessRoot, "state"),
    KONTROL_WORKTREE_ROOT: join(harnessRoot, "worktrees"),
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_ACP_ENABLED: "false",
    KONTROL_POLICY_MODE: "allow",
    KONTROL_WIDGETS: "off",
    KONTROL_TOOL_MODE: mode,
    KONTROL_LOG_LEVEL: "error",
  });
  const workspaces = new WorkspaceRegistry(config);
  const checkpoints = createReviewCheckpointManager({ snapshotStoreRoot: join(harnessRoot, "snapshots") });
  const processSessions = new ProcessSessionManager({ childEnvironmentAllowlist: [] });
  const server = createMcpServer(config, workspaces, checkpoints, processSessions);
  const client = new Client({ name: `mutation-version-${mode}`, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const opened = await client.callTool({ name: "open_workspace", arguments: { path: root, mode: "checkout" } });
  const workspaceId = String((opened.structuredContent as { workspaceId: string }).workspaceId);
  return {
    client,
    server,
    checkpoints,
    workspaceId,
    cleanup: async () => {
      await client.close();
      await server.close();
      await checkpoints.drain();
      rmSync(harnessRoot, { recursive: true, force: true });
    },
  };
}

const root = mkdtempSync(join(tmpdir(), "kontrol-mutation-version-root-"));
try {
  const editPath = join(root, "guarded.txt");
  const writePath = join(root, "write-guarded.txt");
  writeFileSync(editPath, "original\n");
  writeFileSync(writePath, "before\n");

  const full = await openHarness(root, "full");
  try {
    const readResult = await full.client.callTool({
      name: "read",
      arguments: { workspaceId: full.workspaceId, path: "guarded.txt" },
    }) as ToolResult;
    const originalVersion = String(readResult.structuredContent?.contentSha256);
    assert.match(originalVersion, /^[a-f0-9]{64}$/);

    await writeFile(editPath, "original\nchanged by another tab\n");
    const staleEdit = await full.client.callTool({
      name: "edit",
      arguments: {
        workspaceId: full.workspaceId,
        path: "guarded.txt",
        edits: [{ oldText: "original\n", newText: "edited\n" }],
        expectedContentSha256: originalVersion,
      },
    }) as ToolResult;
    assert.equal(staleEdit.isError, true);
    assert.equal(staleEdit.structuredContent?.status, "file_version_conflict");
    assert.equal(await readFile(editPath, "utf8"), "original\nchanged by another tab\n");

    const currentRead = await full.client.callTool({
      name: "read",
      arguments: { workspaceId: full.workspaceId, path: "guarded.txt" },
    }) as ToolResult;
    const currentVersion = String(currentRead.structuredContent?.contentSha256);
    const freshEdit = await full.client.callTool({
      name: "edit",
      arguments: {
        workspaceId: full.workspaceId,
        path: "guarded.txt",
        edits: [{ oldText: "original\nchanged by another tab\n", newText: "resolved\n" }],
        expectedContentSha256: currentVersion,
      },
    }) as ToolResult;
    assert.notEqual(freshEdit.isError, true);
    assert.match(String(freshEdit.structuredContent?.contentSha256), /^[a-f0-9]{64}$/);

    await writeFile(editPath, "race\n");
    const raceRead = await full.client.callTool({
      name: "read",
      arguments: { workspaceId: full.workspaceId, path: "guarded.txt" },
    }) as ToolResult;
    const raceVersion = String(raceRead.structuredContent?.contentSha256);
    const [raceA, raceB] = await Promise.all([
      full.client.callTool({
        name: "edit",
        arguments: {
          workspaceId: full.workspaceId,
          path: "guarded.txt",
          edits: [{ oldText: "race\n", newText: "winner-a\n" }],
          expectedContentSha256: raceVersion,
        },
      }),
      full.client.callTool({
        name: "edit",
        arguments: {
          workspaceId: full.workspaceId,
          path: "guarded.txt",
          edits: [{ oldText: "race\n", newText: "winner-b\n" }],
          expectedContentSha256: raceVersion,
        },
      }),
    ]) as [ToolResult, ToolResult];
    assert.equal([raceA, raceB].filter((result) => result.isError !== true).length, 1, "same-version concurrent edits have one winner");
    assert.equal([raceA, raceB].filter((result) => result.structuredContent?.status === "file_version_conflict").length, 1, "same-version concurrent edits report one conflict");

    const writeRead = await full.client.callTool({
      name: "read",
      arguments: { workspaceId: full.workspaceId, path: "write-guarded.txt" },
    }) as ToolResult;
    const writeVersion = String(writeRead.structuredContent?.contentSha256);
    await writeFile(writePath, "written by another tab\n");
    const staleWrite = await full.client.callTool({
      name: "write",
      arguments: {
        workspaceId: full.workspaceId,
        path: "write-guarded.txt",
        content: "should not win\n",
        expectedContentSha256: writeVersion,
      },
    }) as ToolResult;
    assert.equal(staleWrite.isError, true);
    assert.equal(staleWrite.structuredContent?.status, "file_version_conflict");
    assert.equal(await readFile(writePath, "utf8"), "written by another tab\n");
  } finally {
    await full.cleanup();
  }

  const codex = await openHarness(root, "codex");
  try {
    await writeFile(editPath, "one\n");
    const readResult = await codex.client.callTool({
      name: "read",
      arguments: { workspaceId: codex.workspaceId, path: "guarded.txt" },
    }) as ToolResult;
    const originalVersion = String(readResult.structuredContent?.contentSha256);
    await writeFile(editPath, "one\nchanged by another tab\n");
    const stalePatch = await codex.client.callTool({
      name: "apply_patch",
      arguments: {
        workspaceId: codex.workspaceId,
        patch: "*** Begin Patch\n*** Update File: guarded.txt\n@@\n-one\n+two\n*** End Patch",
        expectedContentSha256ByPath: { "guarded.txt": originalVersion },
      },
    }) as ToolResult;
    assert.equal(stalePatch.isError, true);
    assert.equal(stalePatch.structuredContent?.status, "file_version_conflict");
    assert.equal(await readFile(editPath, "utf8"), "one\nchanged by another tab\n");
  } finally {
    await codex.cleanup();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("mutation-version.test.ts: all assertions passed");
