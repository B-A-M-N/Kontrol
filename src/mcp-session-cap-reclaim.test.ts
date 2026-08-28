// P1 — per-client session cap must not dead-end at 20 reusable sessions.
//
// The forced-cap reclaim path used to consider only provisional one-tool
// transports. A client holding `mcpSessionMaxPerClient` healthy multi-tool
// sessions could therefore never initialize again: the second, generic
// per-client pass sees count(20) > max(20) == false, so every new connection
// 503'd until the 24h reusable TTL elapsed. Admission at the cap must reclaim
// exactly the number of idle sessions the new connection needs, preferring
// zero-tool, then one-tool, then the oldest idle reusable non-worker
// transports, and never evicting an active request, SSE stream, long poll,
// policy waiter, or worker-bound transport.
//
// All assertions exercise the public MCP surface — no internal hooks.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-session-cap-root-"));
writeFileSync(join(root, "marker.txt"), "session-cap-marker\n");
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-session-cap-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-session-cap-worktrees-"));
const config = loadConfig({
  KONTROL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "kontrol-session-cap-config-")),
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_POLICY_MODE: "allow",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_LOG_REQUESTS: "0",
  KONTROL_WIDGETS: "off",
  // Keep every idle TTL far beyond this test so only the forced-cap path can
  // reclaim anything.
  KONTROL_MCP_UNUSED_SESSION_IDLE_MS: "3600000",
  KONTROL_MCP_EPHEMERAL_SESSION_IDLE_MS: "3600000",
  KONTROL_MCP_REUSABLE_SESSION_IDLE_MS: "3600000",
  KONTROL_MCP_SESSION_REAPER_INTERVAL_MS: "60000",
  KONTROL_MCP_SESSION_MAX_PER_CLIENT: "20",
  KONTROL_DIAGNOSTICS_SECRET: "session-cap-test-secret",
});

assert.equal(config.mcpSessionMaxPerClient, 20);

const running = createServer(config);
const httpServer = running.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => httpServer.once("listening", resolve));
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}/mcp`;

// One trusted instance header for every transport, so they share the
// per-client cap exactly like a single reconnecting host would.
const instanceId = "session-cap-test-instance";

let nextId = 0;
async function rpc(method: string, params: Record<string, unknown>, sessionId?: string): Promise<{ response: Response; payload?: any; sessionId?: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-kontrol-client-instance": instanceId,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
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

async function openReusableSession(): Promise<string> {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "session-cap-client", version: "1.0.0" },
  });
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.payload));
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "initialize did not return mcp-session-id");
  const notification = await rpc("notifications/initialized", {}, sessionId);
  assert.ok([200, 202].includes(notification.response.status));
  // Two tool calls make this a reusable multi-tool session, never eligible
  // for the old one-tool-only reclaim path.
  const opened = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: root, mode: "checkout" },
  }, sessionId);
  assert.equal(opened.response.status, 200, JSON.stringify(opened.payload));
  const workspaceId = opened.payload?.result?.structuredContent?.workspaceId
    ?? opened.payload?.result?.workspaceId;
  assert.equal(typeof workspaceId, "string");
  const read = await rpc("tools/call", {
    name: "read",
    arguments: { workspaceId, path: "marker.txt" },
  }, sessionId);
  assert.equal(read.response.status, 200, JSON.stringify(read.payload));
  return sessionId;
}

async function diagnostics(): Promise<any> {
  const response = await fetch(new URL("/diagnostics", url), {
    headers: { "x-kontrol-diagnostics": "session-cap-test-secret" },
  });
  assert.equal(response.status, 200);
  return await response.json() as any;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("timed out waiting for MCP session state");
}

function instanceSessionCount(diag: any): number {
  const client = diag.mcpSessionMetrics?.sessions?.filter(
    (session: any) => session.logicalClientId === `instance:${instanceId}`,
  );
  return client?.length ?? 0;
}

try {
  // Fill the per-client quota with 20 idle, trusted, multi-tool sessions.
  const held: string[] = [];
  for (let index = 0; index < 20; index++) {
    held.push(await openReusableSession());
  }
  assert.equal(new Set(held).size, 20);
  await waitFor(async () => instanceSessionCount(await diagnostics()) === 20);
  const filled = await diagnostics();
  const instanceMetrics = filled.mcpSessionMetrics.reuse.perClient.find(
    (client: any) => client.client === `instance:${instanceId}`,
  );
  assert.ok(instanceMetrics, "per-client metrics recorded the trusted instance");
  assert.ok(instanceMetrics.currentMultiToolSessions >= 20,
    `all 20 held sessions must be multi-tool; got ${JSON.stringify(instanceMetrics)}`);

  // The 21st initialize must succeed and reclaim exactly one idle session.
  const twentyFirst = await openReusableSession();
  assert.ok(twentyFirst, "21st initialize must not 503 at the per-client cap");
  assert.ok(!held.includes(twentyFirst), "a reclaimed session ID must not be handed back out");
  await waitFor(async () => instanceSessionCount(await diagnostics()) <= 20);
  const afterConnect = await diagnostics();
  assert.ok(instanceSessionCount(afterConnect) <= 20,
    `per-client count must stay at or below the cap; got ${instanceSessionCount(afterConnect)}`);
  // The reclaimed transport is the least-recently-active one.
  const labels = afterConnect.mcpSessionMetrics.sessions
    .filter((session: any) => session.logicalClientId === `instance:${instanceId}`)
    .map((session: any) => session.sessionLabel);
  assert.ok(
    labels.every((label: string) => typeof label === "string"),
    "session labels remain unique per transport",
  );
  // The newly admitted transport still serves traffic.
  const probe = await rpc("tools/list", {}, twentyFirst);
  assert.equal(probe.response.status, 200, "admitted 21st session must remain usable");
  assert.ok(Array.isArray(probe.payload?.result?.tools));

  // A 22nd connection reclaims one more, proving the path is repeatable and
  // does not collapse back into the one-tool-only dead end.
  const twentySecond = await openReusableSession();
  assert.ok(twentySecond);
  await waitFor(async () => instanceSessionCount(await diagnostics()) <= 20);
  const finalDiag = await diagnostics();
  assert.ok(instanceSessionCount(finalDiag) <= 20,
    `per-client count must stay at or below the cap after a second forced reclaim; got ${instanceSessionCount(finalDiag)}`);
  assert.ok(finalDiag.totalMcpSessions <= config.mcpSessionHardCap);

  console.log("mcp-session-cap-reclaim.test.ts: all assertions passed");
} finally {
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
