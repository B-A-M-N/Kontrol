import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-mcp-process-continuity-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-mcp-process-continuity-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-mcp-process-continuity-worktrees-"));
const config = loadConfig({
  KONTROL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "kontrol-mcp-process-continuity-config-")),
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
  KONTROL_DIAGNOSTICS_SECRET: "mcp-process-continuity-secret",
});

const running = createServer(config);
const httpServer = running.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => httpServer.once("listening", resolve));
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}/mcp`;

let nextId = 0;

function parseRpc(text: string): any {
  const data = text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return JSON.parse(data || text);
}

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
      ...(options.sessionId ? { "mcp-session-id": options.sessionId } : {}),
      ...(options.conversationId ? { "x-kontrol-conversation-id": options.conversationId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  });
  const text = await response.text();
  return {
    response,
    payload: text.trim() ? parseRpc(text) : undefined,
    sessionId: response.headers.get("mcp-session-id") ?? options.sessionId,
  };
}

async function openSession(conversationId?: string): Promise<{ sessionId: string; workspaceId: string }> {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-process-continuity-test", version: "1.0.0" },
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
  assert.equal(opened.payload?.error, undefined, JSON.stringify(opened.payload));
  const workspaceId = opened.payload?.result?.structuredContent?.workspaceId
    ?? opened.payload?.result?.workspaceId;
  assert.equal(typeof workspaceId, "string", `open_workspace did not return a workspaceId: ${JSON.stringify(opened.payload)}`);
  return { sessionId, workspaceId };
}

async function dropTransport(sessionId: string): Promise<void> {
  // A live session GET is the transport's long-lived socket. Cancelling its
  // body simulates a tunnel/client disconnect rather than an orderly DELETE.
  const stream = await fetch(url, {
    headers: { accept: "text/event-stream", "mcp-session-id": sessionId },
  });
  assert.equal(stream.status, 200, `session GET returned HTTP ${stream.status}`);
  await stream.body?.cancel();
}

async function diagnostics(): Promise<any> {
  const response = await fetch(new URL("/diagnostics", url), {
    headers: { "x-kontrol-diagnostics": "mcp-process-continuity-secret" },
  });
  assert.equal(response.status, 200);
  return await response.json() as any;
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
const genericSurvivalMarker = join(root, "generic-process-survived.txt");
const genericInteractiveCommand = `${node} -e "setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(genericSurvivalMarker)}, 'survived'), 500); process.stdin.once('data', () => process.exit(0));"`;

try {
  // A trusted conversation may replace its MCP transport while retaining
  // ownership of a direct interactive process session.
  const conversationA = await openSession("process-continuity-a");
  const started = await rpc("tools/call", {
    name: "exec_command",
    arguments: {
      workspaceId: conversationA.workspaceId,
      cmd: interactiveCommand,
      yieldTimeMs: 5,
    },
  }, { sessionId: conversationA.sessionId, conversationId: "process-continuity-a" });
  assert.equal(started.response.status, 200, JSON.stringify(started.payload));
  assert.notEqual(started.payload?.result?.isError, true, JSON.stringify(started.payload));
  const processId = started.payload?.result?.structuredContent?.sessionId;
  assert.equal(typeof processId, "string", `exec_command did not return a process session: ${JSON.stringify(started.payload)}`);
  assert.equal(started.payload?.result?.structuredContent?.running, true, JSON.stringify(started.payload));

  await dropTransport(conversationA.sessionId);
  const conversationAReconnect = await openSession("process-continuity-a");
  assert.notEqual(conversationAReconnect.sessionId, conversationA.sessionId);

  // A different trusted conversation cannot attach to A's process even though
  // it can open the same durable workspace.
  const conversationB = await openSession("process-continuity-b");
  const sessionDiagnostics = await diagnostics();
  assert.ok(sessionDiagnostics.mcpSessionMetrics.sessions.some(
    (session: any) => session.conversationId === "process-continuity-a" && session.identitySource === "conversation",
  ));
  assert.ok(sessionDiagnostics.mcpSessionMetrics.sessions.some(
    (session: any) => session.conversationId === "process-continuity-b" && session.identitySource === "conversation",
  ));
  const denied = await rpc("tools/call", {
    name: "write_stdin",
    arguments: {
      workspaceId: conversationA.workspaceId,
      sessionId: processId,
      chars: "wrong-owner\n",
      yieldTimeMs: 100,
    },
  }, { sessionId: conversationB.sessionId, conversationId: "process-continuity-b" });
  assert.equal(denied.response.status, 200, JSON.stringify(denied.payload));
  assert.equal(denied.payload?.result?.isError, true, `different trusted identity attached to process: ${JSON.stringify(denied.payload)}`);
  assert.match(resultText(denied.payload), /owned by another client|Unknown process session/);

  const continued = await rpc("tools/call", {
    name: "write_stdin",
    arguments: {
      workspaceId: conversationA.workspaceId,
      sessionId: processId,
      chars: "hello\n",
      yieldTimeMs: 2_000,
    },
  }, { sessionId: conversationAReconnect.sessionId, conversationId: "process-continuity-a" });
  assert.equal(continued.response.status, 200, JSON.stringify(continued.payload));
  assert.notEqual(continued.payload?.result?.isError, true, JSON.stringify(continued.payload));
  assert.match(resultText(continued.payload), /continued:hello/);

  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": conversationAReconnect.sessionId } });
  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": conversationB.sessionId } });

  // Without a trusted continuity identity, the process remains owned by the
  // original MCP transport and is terminated when that transport disappears.
  const generic = await openSession();
  const genericStarted = await rpc("tools/call", {
    name: "exec_command",
    arguments: {
      workspaceId: generic.workspaceId,
      cmd: genericInteractiveCommand,
      yieldTimeMs: 5,
    },
  }, { sessionId: generic.sessionId });
  assert.equal(genericStarted.response.status, 200, JSON.stringify(genericStarted.payload));
  assert.notEqual(genericStarted.payload?.result?.isError, true, JSON.stringify(genericStarted.payload));
  const genericProcessId = genericStarted.payload?.result?.structuredContent?.sessionId;
  assert.equal(typeof genericProcessId, "string", `generic exec_command did not return a process session: ${JSON.stringify(genericStarted.payload)}`);

  await dropTransport(generic.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(existsSync(genericSurvivalMarker), false, "generic transport-owned process survived transport disconnect");
  const genericReconnect = await openSession();
  const genericWrite = await rpc("tools/call", {
    name: "write_stdin",
    arguments: {
      workspaceId: generic.workspaceId,
      sessionId: genericProcessId,
      chars: "must-not-survive\n",
      yieldTimeMs: 100,
    },
  }, { sessionId: genericReconnect.sessionId });
  assert.equal(genericWrite.response.status, 200, JSON.stringify(genericWrite.payload));
  assert.equal(genericWrite.payload?.result?.isError, true, `generic transport-owned process survived disconnect: ${JSON.stringify(genericWrite.payload)}`);
  assert.match(resultText(genericWrite.payload), /Unknown process session|owned by another client/);

  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": genericReconnect.sessionId } });
  console.log("mcp-process-continuity.test.ts: all assertions passed");
} finally {
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
