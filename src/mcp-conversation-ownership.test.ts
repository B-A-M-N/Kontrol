// P0/P1 — cross-conversation logical ownership.
//
// A conversation identifier partitions an ALREADY-AUTHENTICATED principal;
// it must never broaden authorization. Two conversations of the same trusted
// client (here: one shared client-instance identity) must not touch each
// other's direct process sessions, while a fresh transport for the SAME
// conversation retains ownership across a reconnect.
//
// All assertions exercise the public MCP surface — no internal hooks.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-conversation-ownership-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-conversation-ownership-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-conversation-ownership-worktrees-"));
const config = loadConfig({
  KONTROL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "kontrol-conversation-ownership-config-")),
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_TOOL_MODE: "codex",
  KONTROL_POLICY_MODE: "allow",
  KONTROL_POLICY_TOOL_BASH: "allow",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_LOG_REQUESTS: "0",
  KONTROL_DIAGNOSTICS_SECRET: "conversation-ownership-secret",
});

const running = createServer(config);
const httpServer = running.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => httpServer.once("listening", resolve));
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}/mcp`;

// One trusted client-instance identity shared by every transport, so both
// conversations authenticate as the same principal. Only the conversation
// header differs — exactly the deployment shape this regression protects.
const instanceId = "conversation-ownership-instance";

let nextId = 0;
async function rpc(
  method: string,
  params: Record<string, unknown>,
  options: { sessionId?: string; conversationId?: string } = {},
): Promise<{ response: Response; payload?: any; sessionId?: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-kontrol-client-instance": instanceId,
      ...(options.conversationId ? { "x-kontrol-conversation-id": options.conversationId } : {}),
      ...(options.sessionId ? { "mcp-session-id": options.sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  });
  const text = await response.text();
  const data = text.trim().split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return {
    response,
    payload: data || text.trim() ? JSON.parse(data || text) : undefined,
    sessionId: response.headers.get("mcp-session-id") ?? options.sessionId,
  };
}

async function openSession(conversationId: string): Promise<{ sessionId: string; workspaceId: string }> {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "conversation-ownership-client", version: "1.0.0" },
  }, { conversationId });
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.payload));
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "initialize did not return mcp-session-id");
  const notification = await rpc("notifications/initialized", {}, { sessionId, conversationId });
  assert.ok([200, 202].includes(notification.response.status));
  const opened = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: root, mode: "checkout" },
  }, { sessionId, conversationId });
  assert.equal(opened.response.status, 200, JSON.stringify(opened.payload));
  const workspaceId = opened.payload?.result?.structuredContent?.workspaceId
    ?? opened.payload?.result?.workspaceId;
  assert.equal(typeof workspaceId, "string");
  return { sessionId, workspaceId };
}

function resultText(payload: any): string {
  return [
    payload?.result?.structuredContent?.result,
    ...(payload?.result?.content ?? []).map((entry: any) => entry.text ?? ""),
    payload?.error?.message,
  ].filter((entry) => typeof entry === "string").join("\n");
}

const node = JSON.stringify(process.execPath);
const interactiveCommand = `${node} -e "process.stdin.once('data', data => { console.log('continued:' + data.toString().trim()); process.exit(0); })"`;

async function diagnostics(): Promise<any> {
  const response = await fetch(new URL("/diagnostics", url), {
    headers: { "x-kontrol-diagnostics": "conversation-ownership-secret" },
  });
  assert.equal(response.status, 200);
  return await response.json() as any;
}

try {
  const conversationA = await openSession("ownership-conversation-a");
  const started = await rpc("tools/call", {
    name: "exec_command",
    arguments: { workspaceId: conversationA.workspaceId, cmd: interactiveCommand, yieldTimeMs: 5 },
  }, { sessionId: conversationA.sessionId, conversationId: "ownership-conversation-a" });
  assert.equal(started.response.status, 200, JSON.stringify(started.payload));
  assert.notEqual(started.payload?.result?.isError, true, JSON.stringify(started.payload));
  const processId = started.payload?.result?.structuredContent?.sessionId;
  assert.equal(typeof processId, "string", `exec_command did not return a process session: ${JSON.stringify(started.payload)}`);

  // The two conversations are separate logical owners even though they share
  // one authenticated client-instance principal.
  const diag = await diagnostics();
  const logicalIds = new Set(diag.mcpSessionMetrics.sessions
    .filter((session: any) => typeof session.logicalClientId === "string")
    .map((session: any) => session.logicalClientId));
  assert.ok(
    logicalIds.has(`instance:${instanceId}|conversation:ownership-conversation-a`),
    `conversation A must own a partitioned logical identity; saw ${[...logicalIds].join(", ")}`,
  );

  const conversationB = await openSession("ownership-conversation-b");
  const denied = await rpc("tools/call", {
    name: "write_stdin",
    arguments: { workspaceId: conversationA.workspaceId, sessionId: processId, chars: "wrong-owner\n", yieldTimeMs: 100 },
  }, { sessionId: conversationB.sessionId, conversationId: "ownership-conversation-b" });
  assert.equal(denied.response.status, 200, JSON.stringify(denied.payload));
  assert.equal(denied.payload?.result?.isError, true,
    `conversation B must not write to conversation A's process: ${JSON.stringify(denied.payload)}`);
  assert.match(resultText(denied.payload), /owned by another client|Unknown process session/);

  // A fresh transport for the SAME conversation retains ownership.
  const conversationAFresh = await openSession("ownership-conversation-a");
  assert.notEqual(conversationAFresh.sessionId, conversationA.sessionId);
  const continued = await rpc("tools/call", {
    name: "write_stdin",
    arguments: { workspaceId: conversationA.workspaceId, sessionId: processId, chars: "hello\n", yieldTimeMs: 2_000 },
  }, { sessionId: conversationAFresh.sessionId, conversationId: "ownership-conversation-a" });
  assert.equal(continued.response.status, 200, JSON.stringify(continued.payload));
  assert.notEqual(continued.payload?.result?.isError, true, JSON.stringify(continued.payload));
  assert.match(resultText(continued.payload), /continued:hello/);

  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": conversationAFresh.sessionId } });
  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": conversationB.sessionId } });
  console.log("mcp-conversation-ownership.test.ts: all assertions passed");
} finally {
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
