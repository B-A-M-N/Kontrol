import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-mcp-session-reuse-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-mcp-session-reuse-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-mcp-session-reuse-worktrees-"));
const config = loadConfig({
  KONTROL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "kontrol-mcp-session-reuse-config-")),
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_LOG_REQUESTS: "0",
  // Leave enough setup grace for the first notification, while keeping the
  // useful one-tool session TTL short enough for this regression to finish.
  KONTROL_MCP_UNUSED_SESSION_IDLE_MS: "10000",
  KONTROL_MCP_EPHEMERAL_SESSION_IDLE_MS: "5000",
  KONTROL_MCP_REUSABLE_SESSION_IDLE_MS: "10000",
  KONTROL_MCP_SESSION_REAPER_INTERVAL_MS: "25",
  KONTROL_MCP_SESSION_MAX_PER_CLIENT: "20",
  KONTROL_DIAGNOSTICS_SECRET: "session-reuse-test-secret",
});

const running = createServer(config);
const httpServer = running.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => httpServer.once("listening", resolve));
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}/mcp`;

let nextId = 0;
async function rpc(method: string, params: Record<string, unknown>, sessionId?: string, conversationId?: string): Promise<{ response: Response; payload?: any; sessionId?: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(conversationId ? { "x-kontrol-conversation-id": conversationId } : {}),
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
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
  };
}

async function notify(method: string, sessionId: string, conversationId?: string): Promise<void> {
  const result = await rpc(method, {}, sessionId, conversationId);
  assert.ok(result.response.status === 202 || result.response.status === 200, `${method} returned HTTP ${result.response.status}`);
}

async function openSession(conversationId?: string): Promise<{ sessionId: string; workspaceId: string }> {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp:openai-mcp", version: "1.0.0" },
  }, undefined, conversationId);
  assert.equal(initialized.response.status, 200);
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "initialize did not return mcp-session-id");
  await notify("notifications/initialized", sessionId, conversationId);
  const opened = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: root, mode: "checkout" },
  }, sessionId, conversationId);
  assert.equal(opened.response.status, 200);
  assert.equal(opened.payload?.error, undefined, JSON.stringify(opened.payload));
  const workspaceId = opened.payload?.result?.structuredContent?.workspaceId ?? opened.payload?.result?.workspaceId;
  assert.equal(typeof workspaceId, "string", `open_workspace did not return a workspaceId: ${JSON.stringify(opened.payload)}`);
  return { sessionId, workspaceId };
}

async function closeSession(sessionId: string): Promise<void> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId },
  });
  assert.ok([200, 202, 204].includes(response.status), `DELETE returned HTTP ${response.status}`);
}

async function diagnostics(): Promise<any> {
  const response = await fetch(new URL("/diagnostics", url), {
    headers: { "x-kontrol-diagnostics": "session-reuse-test-secret" },
  });
  assert.equal(response.status, 200);
  return await response.json() as any;
}

try {
  // A reused client keeps one transport and the second useful operation makes
  // it a reusable multi-tool session instead of an ephemeral one-tool session.
  const reusable = await openSession("review-a");
  const mismatch = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: root, mode: "checkout" },
  }, reusable.sessionId, "review-b");
  assert.equal(mismatch.response.status, 403, "a session must reject a different explicit conversation context");
  const secondCall = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: root, mode: "checkout" },
  }, reusable.sessionId, "review-a");
  assert.equal(secondCall.response.status, 200);

  const before = await diagnostics();
  const beforeReuse = before.mcpSessionMetrics.reuse;
  const labels = before.mcpSessionMetrics.sessions.map((session: any) => session.sessionLabel);
  assert.equal(new Set(labels).size, labels.length, "MCP session labels must be unique even for the same logical client");
  assert.ok(labels.some((label: string) => label.startsWith("conversation:review-a/mcp:")));
  assert.ok(beforeReuse.perClient.some((client: any) => client.currentMultiToolSessions >= 1));

  // Remove the reusable fixture, then reproduce the live one-session-per-tool
  // pattern sequentially. The 21st initialization must reclaim the oldest
  // idle one-tool transport instead of returning a per-client-cap 503.
  await closeSession(reusable.sessionId);
  const ephemeral = [];
  for (let index = 0; index < 20; index++) {
    ephemeral.push(await openSession(index % 2 === 0 ? "review-b" : "review-c"));
  }
  assert.equal(new Set(ephemeral.map(({ sessionId }) => sessionId)).size, 20);
  const twentyFirst = await openSession("review-cap-21");
  assert.ok(twentyFirst.sessionId);
  const capSnapshot = await diagnostics();
  const capReuse = capSnapshot.mcpSessionMetrics.reuse;
  const capSingleToolSessions = capReuse.perClient.reduce((sum: number, client: any) => sum + client.currentSingleToolSessions, 0);
  assert.ok(capSnapshot.mcpSessionMetrics.sessions.some((session: any) => session.sessionLabel.startsWith("conversation:review-b/mcp:")));
  assert.ok(capSingleToolSessions + capReuse.singleToolSessions >= 20);
  assert.ok(capReuse.sessionsExpired >= 1, "cap admission did not reclaim an idle ephemeral session");
  assert.ok(capSnapshot.totalMcpSessions <= 20, "per-client cap was exceeded instead of reclaiming an idle session");

  await new Promise((resolve) => setTimeout(resolve, 5300));
  const after = await diagnostics();
  const afterReuse = after.mcpSessionMetrics.reuse;
  assert.equal(afterReuse.perClient.reduce((sum: number, client: any) => sum + client.currentSingleToolSessions, 0), 0);
  assert.ok(afterReuse.sessionsExpired >= 20, `expected ephemeral sessions to expire: ${JSON.stringify(afterReuse)}`);

  console.log("mcp-session-reuse.test.ts: all assertions passed");
} finally {
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
