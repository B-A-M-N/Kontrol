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
  // This suite exercises transport/session plumbing, not the approval
  // boundary; the ask baseline would also trip the tunnel reviewer gate.
  KONTROL_POLICY_MODE: "allow",
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

async function closeSessionIfPresent(sessionId: string): Promise<void> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId },
  });
  assert.ok([200, 202, 204, 404].includes(response.status), `DELETE returned HTTP ${response.status}`);
}

async function diagnostics(): Promise<any> {
  const response = await fetch(new URL("/diagnostics", url), {
    headers: { "x-kontrol-diagnostics": "session-reuse-test-secret" },
  });
  assert.equal(response.status, 200);
  return await response.json() as any;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for MCP continuity state");
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

  const firstToolList = await rpc("tools/list", {}, reusable.sessionId, "review-a");
  assert.equal(firstToolList.response.status, 200);
  assert.ok(Array.isArray(firstToolList.payload?.result?.tools));
  assert.ok(firstToolList.payload.result.tools.length > 0);

  const before = await diagnostics();
  const beforeReuse = before.mcpSessionMetrics.reuse;
  const labels = before.mcpSessionMetrics.sessions.map((session: any) => session.sessionLabel);
  assert.equal(new Set(labels).size, labels.length, "MCP session labels must be unique even for the same logical client");
  assert.ok(labels.some((label: string) => label.startsWith("conversation:review-a/mcp:")));
  assert.ok(beforeReuse.perClient.some((client: any) => client.currentMultiToolSessions >= 1));

  // A transport loss does not require the host to reuse an expired MCP
  // session ID. A fresh initialize with the same trusted conversation gets a
  // new isolated transport while the server-side continuity index records the
  // predecessor and reconnect.
  const reconnectBefore = await openSession("reconnect-a");
  await closeSession(reconnectBefore.sessionId);
  await waitFor(async () => (await diagnostics()).mcpSessionMetrics.logicalContinuity.records.some(
    (record: any) => record.identity === "conversation:reconnect-a" && record.detachedTransportCount >= 1,
  ));
  const reconnectAfter = await openSession("reconnect-a");
  assert.notEqual(reconnectAfter.sessionId, reconnectBefore.sessionId);
  const durableReadAfterReconnect = await rpc("tools/call", {
    name: "read",
    arguments: { workspaceId: reconnectBefore.workspaceId, path: "missing-after-reconnect.txt" },
  }, reconnectAfter.sessionId, "reconnect-a");
  assert.equal(durableReadAfterReconnect.response.status, 200, "a fresh MCP initialize must retain access to the explicit durable workspace ID");
  assert.notEqual(durableReadAfterReconnect.payload?.error?.code, -32001, JSON.stringify(durableReadAfterReconnect.payload));
  const continuitySnapshot = await diagnostics();
  const continuityRecord = continuitySnapshot.mcpSessionMetrics.logicalContinuity.records.find(
    (record: any) => record.identity === "conversation:reconnect-a",
  );
  assert.equal(continuityRecord?.source, "conversation");
  assert.ok((continuityRecord?.reconnectCount ?? 0) >= 1);
  assert.equal(continuityRecord?.activeTransportCount, 1);
  await closeSession(reconnectAfter.sessionId);

  // Meaningful application traffic keeps one MCP transport reusable past both
  // the one-tool and reusable idle cutoffs. The reaper must not mistake age
  // for idleness or create a replacement transport behind the caller's back.
  const sustained = await openSession("sustained-a");
  const sustainedSecondTool = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: root, mode: "checkout" },
  }, sustained.sessionId, "sustained-a");
  assert.equal(sustainedSecondTool.response.status, 200);
  const sustainedCreated = (await diagnostics()).mcpSessionMetrics.created;
  for (let index = 0; index < 3; index++) {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const sustainedRead = await rpc("tools/list", {}, sustained.sessionId, "sustained-a");
    assert.equal(sustainedRead.response.status, 200, `same transport failed on sustained reuse ${index}`);
  }
  const sustainedSnapshot = await diagnostics();
  assert.equal(sustainedSnapshot.mcpSessionMetrics.created, sustainedCreated, "reaper must not replace an actively reused transport");
  assert.ok(sustainedSnapshot.mcpSessionMetrics.sessions.some(
    (session: any) => session.sessionLabel.endsWith(`/mcp:${sustained.sessionId.slice(0, 8)}`),
  ));
  await closeSession(sustained.sessionId);

  // Exercise an actual long-lived transport socket loss, not only an orderly
  // MCP DELETE. Closing the SSE body must detach the disposable transport so
  // a fresh initialize can be recognized as a reconnect.
  const socketSession = await openSession("socket-loss-a");
  const sse = await fetch(url, {
    headers: { accept: "text/event-stream", "mcp-session-id": socketSession.sessionId },
  });
  assert.equal(sse.status, 200);
  await sse.body?.cancel();
  await waitFor(async () => (await diagnostics()).mcpSessionMetrics.logicalContinuity.records.some(
    (record: any) => record.identity === "conversation:socket-loss-a" && record.detachedTransportCount >= 1,
  ));
  const socketReconnect = await openSession("socket-loss-a");
  assert.notEqual(socketReconnect.sessionId, socketSession.sessionId);
  await closeSession(socketReconnect.sessionId);

  // An active SSE response remains protected even after the reusable idle TTL;
  // once it closes, genuine idleness becomes eligible for the normal reaper.
  const sseProtected = await openSession("sse-ttl-a");
  const protectedStream = await fetch(url, {
    headers: { accept: "text/event-stream", "mcp-session-id": sseProtected.sessionId },
  });
  assert.equal(protectedStream.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  const protectedSnapshot = await diagnostics();
  const protectedLabel = (session: any) => session.sessionLabel.endsWith(`/mcp:${sseProtected.sessionId.slice(0, 8)}`);
  assert.ok(protectedSnapshot.mcpSessionMetrics.sessions.some(protectedLabel), "active SSE must not be reaped past its idle TTL");
  await protectedStream.body?.cancel();
  await waitFor(async () => !(await diagnostics()).mcpSessionMetrics.sessions.some(protectedLabel), 3_000);

  // Remove the reusable fixture, then reproduce the live one-session-per-tool
  // pattern without a trustworthy instance/conversation header. The 21st
  // initialization must not evict an unrelated transport merely because all
  // share the generic clientInfo name/version fallback.
  await closeSessionIfPresent(reusable.sessionId);
  const ephemeral = [];
  for (let index = 0; index < 20; index++) {
    ephemeral.push(await openSession());
  }
  assert.equal(new Set(ephemeral.map(({ sessionId }) => sessionId)).size, 20);
  const twentyFirst = await openSession();
  assert.ok(twentyFirst.sessionId);
  const secondToolList = await rpc("tools/list", {}, twentyFirst.sessionId);
  assert.equal(secondToolList.response.status, 200);
  const capSnapshot = await diagnostics();
  const capReuse = capSnapshot.mcpSessionMetrics.reuse;
  const capSingleToolSessions = capReuse.perClient.reduce((sum: number, client: any) => sum + client.currentSingleToolSessions, 0);
  assert.ok(capSnapshot.mcpSessionMetrics.sessions.some((session: any) => session.identitySource === "client_info_fallback"));
  assert.ok(capSnapshot.mcpSessionMetrics.logicalContinuity.records.every(
    (record: any) => record.source !== "client_info_fallback",
  ), "generic clientInfo fallback must not create logical continuity records");
  assert.ok(capSingleToolSessions + capReuse.singleToolSessions >= 20);
  // A global LRU/memory bound may still reclaim one session, but the generic
  // fallback must not be treated as a single trustworthy client owner for
  // the aggressive per-client eviction policy.
  assert.ok(capSnapshot.totalMcpSessions <= config.mcpSessionHardCap);
  assert.ok(capSnapshot.mcpSessionMetrics.toolListDescriptorCache.hits >= 1, "static tools/list descriptor cache was not reused");
  const timing = capSnapshot.mcpSessionMetrics.timing;
  assert.ok(timing.initialization.totalMs.p95 < 1_000, `MCP initialization regression exceeded 1s p95: ${JSON.stringify(timing.initialization)}`);
  assert.ok(timing.phaseTimings["mcp.tool_registration"], "tool-registration timing is exposed");
  assert.ok(timing.phaseTimings["mcp.response"], "response timing is exposed");

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
