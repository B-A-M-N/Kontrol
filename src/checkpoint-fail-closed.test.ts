/**
 * REVIEW-01 / P0.4 / P0.5 invariants:
 *  - ordinary `bash` crosses the same checkpoint-readiness barrier as
 *    write/edit/apply_patch/exec_command (REVIEW-01);
 *  - when no usable checkpoint backend exists, mutation fails CLOSED with a
 *    distinct `checkpoint_unavailable` status (never silent untracked mutation);
 *  - open_workspace reports the AUTHORITATIVE backend state, not a
 *    git-eligibility prediction;
 *  - the explicit operator opt-in KONTROL_ALLOW_UNTRACKED_MUTATION=1 restores
 *    the old continue-anyway behavior as a deliberate, visible choice.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, WorkspaceMutationBlockedError } from "./mcp/workspace-server.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { loadConfig } from "./config.js";

// A healthy non-Git workspace: the filesystem backend must initialize.
const healthyRoot = mkdtempSync(join(tmpdir(), "kontrol-checkpoint-healthy-"));
writeFileSync(join(healthyRoot, "README.md"), "healthy\n");

// A poisoned workspace: the snapshot store root is a file, so the filesystem
// backend cannot persist anything and initialization must fail.
const poisonedRoot = mkdtempSync(join(tmpdir(), "kontrol-checkpoint-poisoned-"));
writeFileSync(join(poisonedRoot, "README.md"), "poisoned\n");
const blockedStoreRoot = mkdtempSync(join(tmpdir(), "kontrol-checkpoint-blocked-store-"));
const storeAsFile = join(blockedStoreRoot, "store");
writeFileSync(storeAsFile, "not a directory");

const stateDir = mkdtempSync(join(tmpdir(), "kontrol-checkpoint-state-"));
const healthyStoreRoot = mkdtempSync(join(tmpdir(), "kontrol-checkpoint-healthy-store-"));

function baseEnv(): Record<string, string> {
  return {
    KONTROL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "kontrol-checkpoint-config-")),
    KONTROL_ALLOWED_ROOTS: `${healthyRoot},${poisonedRoot}`,
    KONTROL_STATE_DIR: stateDir,
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_ACP_ENABLED: "false",
    KONTROL_POLICY_MODE: "allow",
    KONTROL_LOG_LEVEL: "error",
    KONTROL_WIDGETS: "changes",
  };
}

async function startClient(env: Record<string, string>, snapshotStoreRoot: string = healthyStoreRoot) {
  const config = loadConfig(env);
  const workspaces = new WorkspaceRegistry(config);
  const checkpoints = createReviewCheckpointManager({ snapshotStoreRoot });
  const processSessions = new ProcessSessionManager({ childEnvironmentAllowlist: [] });
  const server = createMcpServer(
    config,
    workspaces,
    checkpoints,
    processSessions,
  );
  const client = new Client({ name: "checkpoint-fail-closed-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    workspaces,
    close: async () => {
      await client.close();
      await server.close();
      await checkpoints.drain();
    },
  };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  return await client.callTool({ name, arguments: args });
}

// ── Healthy workspace: bash crosses the barrier and succeeds ──
{
  const { client, close } = await startClient(baseEnv());
  const opened = await callTool(client, "open_workspace", { path: healthyRoot, mode: "checkout" });
  const structured = (opened as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
  assert.equal(structured.checkpointBackend, "filesystem", "healthy non-Git workspace reports its real filesystem backend");
  assert.equal((structured.capabilities as Record<string, unknown> | undefined)?.changeTracking, true, "healthy workspace tracks changes");

  const shell = await callTool(client, "bash", { workspaceId: structured.workspaceId, command: "echo barrier-crossed" });
  const shellStructured = (shell as { structuredContent?: Record<string, unknown>; isError?: boolean }).structuredContent ?? {};
  assert.notEqual(shell.isError, true, `bash succeeds once the baseline is ready: ${JSON.stringify(shellStructured)}`);
  await close();
}

// ── Poisoned workspace: open_workspace reports unavailable; mutation fails closed ──
{
  const { client, close } = await startClient(baseEnv(), storeAsFile);
  const opened = await callTool(client, "open_workspace", { path: poisonedRoot, mode: "checkout" });
  const structured = (opened as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
  assert.equal(
    structured.checkpointBackend,
    "unavailable",
    `open_workspace reports the authoritative backend state, not a prediction: ${JSON.stringify(structured)}`,
  );
  assert.equal((structured.capabilities as Record<string, unknown> | undefined)?.changeTracking, false, "changeTracking is false when no backend is usable");

  const workspaceId = structured.workspaceId as string;

  // Ordinary bash now crosses the barrier (P0.4) and is refused (P0.5).
  for (const [tool, args] of [
    ["bash", { workspaceId, command: "echo should-not-run" }],
    ["write", { workspaceId, path: "new.txt", content: "nope" }],
    ["edit", { workspaceId, path: "README.md", edits: [{ oldText: "poisoned", newText: "nope" }] }],
  ] as Array<[string, Record<string, unknown>]>) {
    const result = await callTool(client, tool, args);
    const toolStructured = (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
    assert.equal(
      toolStructured.status,
      "checkpoint_unavailable",
      `${tool} must fail closed with checkpoint_unavailable: ${JSON.stringify(toolStructured)}`,
    );
    assert.equal((result as { isError?: boolean }).isError, true, `${tool} block is an explicit error`);
  }
  assert.equal(
    existsSync(join(poisonedRoot, "new.txt")),
    false,
    "the blocked write must not have reached the filesystem",
  );
  await close();
}

// ── Explicit operator opt-in restores continue-anyway, visibly ──
{
  const env = baseEnv();
  env.KONTROL_ALLOW_UNTRACKED_MUTATION = "1";
  const { client, close } = await startClient(env);
  const opened = await callTool(client, "open_workspace", { path: poisonedRoot, mode: "checkout" });
  const structured = (opened as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
  const workspaceId = structured.workspaceId as string;
  const shell = await callTool(client, "bash", { workspaceId, command: "echo untracked-ok" });
  assert.notEqual(
    (shell as { isError?: boolean }).isError,
    true,
    "explicit KONTROL_ALLOW_UNTRACKED_MUTATION=1 permits the mutation",
  );
  await close();
}

// ── The error class is exported for server-level mapping ──
{
  const error = new WorkspaceMutationBlockedError("ws", "blocked");
  assert.equal(error.code, "checkpoint_unavailable");
}

mkdirSync(join(healthyRoot, "keep"), { recursive: true }); // keep dirs alive until here
rmSync(healthyRoot, { recursive: true, force: true });
rmSync(poisonedRoot, { recursive: true, force: true });
rmSync(blockedStoreRoot, { recursive: true, force: true });

console.log("checkpoint-fail-closed.test.ts: all assertions passed");
