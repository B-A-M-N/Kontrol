// P1 — transport close cleanup must use the callback-bound session ID, while
// individual HTTP/SSE response loss must not close the shared MCP transport.
//
// Explicit DELETE, shutdown, and expiry terminate a session through the
// callback-bound ID. A client closing one GET SSE response only ends that
// request; subsequent POSTs and reconnects on the same session remain valid.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-session-close-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-session-close-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-session-close-worktrees-"));
const config = loadConfig({
  KONTROL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "kontrol-session-close-config-")),
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  // Close-cleanup suite: not exercising the approval boundary.
  KONTROL_POLICY_MODE: "allow",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_LOG_REQUESTS: "0",
  KONTROL_MCP_REUSABLE_SESSION_IDLE_MS: "3600000",
  KONTROL_MCP_SESSION_REAPER_INTERVAL_MS: "60000",
  KONTROL_DIAGNOSTICS_SECRET: "session-close-test-secret",
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

async function openSession(conversationId?: string): Promise<string> {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "session-close-client", version: "1.0.0" },
  }, undefined, conversationId);
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.payload));
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "initialize did not return mcp-session-id");
  const notification = await rpc("notifications/initialized", {}, sessionId, conversationId);
  assert.ok([200, 202].includes(notification.response.status));
  return sessionId;
}

async function diagnostics(): Promise<any> {
  const response = await fetch(new URL("/diagnostics", url), {
    headers: { "x-kontrol-diagnostics": "session-close-test-secret" },
  });
  assert.equal(response.status, 200);
  return await response.json() as any;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4_000, label = "predicate"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(`timed out waiting for ${label} after ${timeoutMs}ms`);
}

function hasSession(diag: any, sessionId: string): boolean {
  return (diag.mcpSessionMetrics?.sessions ?? []).some(
    (session: any) => typeof session.sessionLabel === "string" && session.sessionLabel.endsWith(`/mcp:${sessionId.slice(0, 8)}`),
  );
}

try {
  // An orderly MCP DELETE drives transport.close() -> onclose. Cleanup must
  // remove the session from the map using the callback-bound ID.
  const orderly = await openSession("close-orderly");
  const withOrderly = await diagnostics();
  assert.ok(hasSession(withOrderly, orderly), "session is registered before close");
  const deleteOrderly = await fetch(url, { method: "DELETE", headers: { "mcp-session-id": orderly } });
  assert.ok([200, 202, 204].includes(deleteOrderly.status), `DELETE returned ${deleteOrderly.status}`);
  await waitFor(async () => !(await diagnostics()).totalMcpSessions || !hasSession(await diagnostics(), orderly),
    4_000, "orderly close to clean up the session record");
  const afterOrderly = await diagnostics();
  assert.ok(!hasSession(afterOrderly, orderly),
    `close must delete the session map entry via the callback-bound ID; sessions: ${JSON.stringify(afterOrderly.mcpSessionMetrics?.sessions?.map((s: any) => s.sessionLabel))}`);
  assert.ok((afterOrderly.mcpSessionMetrics?.logicalContinuity?.records ?? []).some(
    (record: any) => record.identity === "conversation:close-orderly" && record.activeTransportCount === 0,
  ), "close must detach logical continuity for the closed transport");

  // Closing one GET SSE response is not session termination. The shared MCP
  // transport remains usable for other concurrent requests and reconnects.
  const socketLoss = await openSession("close-socket-loss");
  const stream = await fetch(url, {
    headers: { accept: "text/event-stream", "mcp-session-id": socketLoss },
  });
  assert.equal(stream.status, 200);
  await stream.body?.cancel();
  await waitFor(async () => (await diagnostics()).mcpSessionMetrics.activeSseStreams === 0,
    4_000, "socket-loss stream accounting to settle");
  const afterSocketLoss = await diagnostics();
  assert.ok(hasSession(afterSocketLoss, socketLoss), "SSE disconnect must not remove the MCP session");
  const afterDisconnect = await rpc("tools/list", {}, socketLoss, "close-socket-loss");
  assert.equal(afterDisconnect.response.status, 200, "tools/list must succeed after an SSE disconnect");
  assert.ok(afterDisconnect.payload?.result?.tools, "tools/list must return the session tool catalog");

  // A stream disconnect while a POST is executing must not destroy the
  // transport underneath that request. The command completes and the same
  // session can still service a later call.
  const concurrentSession = await openSession("close-concurrent-post");
  const concurrentWorkspace = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: root, mode: "checkout" },
  }, concurrentSession);
  assert.equal(concurrentWorkspace.response.status, 200, JSON.stringify(concurrentWorkspace.payload));
  const concurrentWorkspaceId = (concurrentWorkspace.payload?.result?.structuredContent ?? concurrentWorkspace.payload?.result)?.workspaceId;
  assert.equal(typeof concurrentWorkspaceId, "string");
  const concurrentStream = await fetch(url, {
    headers: { accept: "text/event-stream", "mcp-session-id": concurrentSession },
  });
  assert.equal(concurrentStream.status, 200);
  const pendingPost = rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId: concurrentWorkspaceId, command: "sleep 1; printf concurrent-post-ok", timeout: 5 },
  }, concurrentSession);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await concurrentStream.body?.cancel();
  const completedPost = await pendingPost;
  assert.equal(completedPost.response.status, 200, JSON.stringify(completedPost.payload));
  assert.notEqual(completedPost.payload?.result?.isError, true, JSON.stringify(completedPost.payload));
  const afterConcurrent = await rpc("tools/list", {}, concurrentSession, "close-concurrent-post");
  assert.equal(afterConcurrent.response.status, 200, "concurrent POST must leave the session usable");

  // Explicit DELETE remains the terminal session-close path.
  for (const sessionId of [socketLoss, concurrentSession]) {
    const deleted = await fetch(url, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
    assert.ok([200, 202, 204].includes(deleted.status), `DELETE returned ${deleted.status}`);
    await waitFor(async () => !hasSession(await diagnostics(), sessionId), 4_000, "explicit session close");
  }

  console.log("mcp-session-close-cleanup.test.ts: all assertions passed");
} finally {
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
