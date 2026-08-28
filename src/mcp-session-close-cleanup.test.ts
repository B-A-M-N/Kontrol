// P1 — transport close cleanup must use the callback-bound session ID.
//
// `onsessioninitialized` captured the assigned session ID when the transport
// was created, but `transport.onclose` re-read `transport?.sessionId`, which
// the SDK is not required to expose at close time. When it is unavailable the
// close callback silently skipped waiter cancellation, continuity detach,
// process ownership cleanup, metric recording, and both map deletions, so the
// session record leaked until its 24h TTL. Cleanup is centralized in one
// finalizeMcpSession(sessionId, reason) primitive used by both the normal
// close path and the reaper, and the close path prefers the callback-bound ID.
//
// The observable contract from the outside: after a transport closes, its
// session disappears from the diagnostics session list (map cleanup ran) and
// its logical continuity record shows the detach, even when the transport's
// own sessionId property is no longer populated.

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

  // A raw socket loss (SSE body cancelled) exercises the same cleanup path
  // without an orderly DELETE, which is the shape that most often left the
  // transport's own sessionId property unavailable.
  const socketLoss = await openSession("close-socket-loss");
  const stream = await fetch(url, {
    headers: { accept: "text/event-stream", "mcp-session-id": socketLoss },
  });
  assert.equal(stream.status, 200);
  await stream.body?.cancel();
  await waitFor(async () => !hasSession(await diagnostics(), socketLoss),
    4_000, "socket-loss close to clean up the session record");
  const afterSocketLoss = await diagnostics();
  assert.ok(!hasSession(afterSocketLoss, socketLoss),
    `socket-loss close must clean up via the callback-bound ID; sessions: ${JSON.stringify(afterSocketLoss.mcpSessionMetrics?.sessions?.map((s: any) => s.sessionLabel))}`);
  assert.ok((afterSocketLoss.mcpSessionMetrics?.logicalContinuity?.records ?? []).some(
    (record: any) => record.identity === "conversation:close-socket-loss" && record.activeTransportCount === 0,
  ), "socket-loss close must detach logical continuity");

  // A closed transport is genuinely gone: further requests are unknown-session.
  const stale = await rpc("tools/list", {}, socketLoss, "close-socket-loss");
  assert.equal(stale.response.status, 404, "a cleaned-up session must not still resolve requests");

  console.log("mcp-session-close-cleanup.test.ts: all assertions passed");
} finally {
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
