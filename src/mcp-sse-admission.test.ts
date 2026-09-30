import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
import { startMcpSseHeartbeat, type McpSseHeartbeatResponse } from "./server/mcp-sse-heartbeat.js";
import { WORKSPACE_APP_URI } from "./workspace-app-resource.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-mcp-sse-admission-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-mcp-sse-admission-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-mcp-sse-admission-worktrees-"));
writeFileSync(join(root, "marker.txt"), "sse-admission-ok\n");

const config = loadConfig({
  KONTROL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "kontrol-mcp-sse-admission-config-")),
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_POLICY_MODE: "allow",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_LOG_REQUESTS: "0",
  KONTROL_MCP_MAX_INFLIGHT: "4",
  KONTROL_MCP_MAX_INFLIGHT_PER_SESSION: "4",
  KONTROL_MCP_MAX_QUEUE: "1",
  KONTROL_MCP_ADMISSION_TIMEOUT_MS: "50",
  KONTROL_MCP_SESSION_REAPER_INTERVAL_MS: "1000",
  KONTROL_MCP_SSE_HEARTBEAT_MS: "10",
  KONTROL_DIAGNOSTICS_SECRET: "sse-admission-test-secret",
});

const running = createServer(config);
const httpServer = running.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => httpServer.once("listening", resolve));
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}/mcp`;

let nextId = 0;
type SseStream = { controller: AbortController; response: Response };
type SseSession = { sessionId: string; workspaceId: string; stream?: SseStream };

function parseRpc(text: string): any {
  const data = text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return JSON.parse(data || text);
}

async function rpc(method: string, params: Record<string, unknown>, sessionId?: string): Promise<{ response: Response; payload?: any; sessionId?: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  });
  const text = await response.text();
  return {
    response,
    payload: text.trim() ? parseRpc(text) : undefined,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
  };
}

async function openSession(): Promise<SseSession> {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp:sse-admission-test", version: "1.0.0" },
  });
  assert.equal(initialized.response.status, 200);
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "initialize did not return mcp-session-id");
  const notification = await rpc("notifications/initialized", {}, sessionId);
  assert.ok([200, 202].includes(notification.response.status));
  const opened = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: root, mode: "checkout" },
  }, sessionId);
  assert.equal(opened.response.status, 200, JSON.stringify(opened.payload));
  const workspaceResult = opened.payload?.result?.structuredContent ?? opened.payload?.result;
  assert.equal(workspaceResult?.versionControl, "none", "ordinary non-Git checkout uses filesystem tracking");
  assert.equal(workspaceResult?.checkpointBackend, "filesystem", "ordinary non-Git checkout advertises its checkpoint backend");
  assert.equal(workspaceResult?.capabilities?.changeTracking, true, "non-Git checkout retains change tracking");
  assert.equal(workspaceResult?.capabilities?.managedWorktree, false, "ordinary non-Git checkout is not treated as a managed worktree");
  const workspaceId = workspaceResult?.workspaceId;
  assert.equal(typeof workspaceId, "string", `open_workspace did not return a workspaceId: ${JSON.stringify(opened.payload)}`);
  return { sessionId, workspaceId };
}

async function openSse(sessionId: string): Promise<SseStream> {
  const controller = new AbortController();
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "text/event-stream", "mcp-session-id": sessionId },
    signal: controller.signal,
  });
  assert.equal(response.status, 200, `sessionful GET returned HTTP ${response.status}`);
  return { controller, response };
}

async function closeSse(sessionId: string, stream: SseStream): Promise<void> {
  stream.controller.abort();
  await stream.response.body?.cancel().catch(() => {});
  // Reconnect churn creates fresh transports; explicitly terminate those
  // sessions so the test exercises stream loss without accumulating the
  // intentionally retained session records.
  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": sessionId } }).catch(() => {});
}

async function diagnostics(): Promise<any> {
  const response = await fetch(new URL("/diagnostics", url), {
    headers: { "x-kontrol-diagnostics": "sse-admission-test-secret" },
  });
  assert.equal(response.status, 200);
  return await response.json() as any;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for MCP SSE state to settle");
}

class RepeatedBackpressureResponse extends EventEmitter implements McpSseHeartbeatResponse {
  readonly destroyed = false;
  readonly writableEnded = false;
  writes = 0;

  write(_chunk: string): boolean {
    this.writes++;
    return this.writes >= 3;
  }
}

async function waitForHeartbeatState(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("timed out waiting for repeated SSE backpressure recovery");
}

const backpressureResponse = new RepeatedBackpressureResponse();
let heartbeatStalls = 0;
let heartbeatDrains = 0;
const stopTestHeartbeat = startMcpSseHeartbeat(
  backpressureResponse,
  2,
  () => heartbeatStalls++,
  () => heartbeatDrains++,
);
await waitForHeartbeatState(() => heartbeatStalls === 1);
backpressureResponse.emit("drain");
await waitForHeartbeatState(() => heartbeatStalls === 2);
backpressureResponse.emit("drain");
await waitForHeartbeatState(() => backpressureResponse.writes >= 3);
assert.equal(heartbeatDrains, 2, "the same SSE response must recover from repeated drain events");
stopTestHeartbeat();
assert.equal(backpressureResponse.listenerCount("drain"), 0, "stopping the heartbeat removes its drain listener");

const sessions: SseSession[] = [];
try {
  // Three persistent SSE transports consume three slots in the old design.
  // With maxInflight=4, a lightweight read could still pass there, but the
  // weight-3 exec_command/bash path failed with a misleading capacity error.
  for (let index = 0; index < 3; index++) {
    const session = await openSession();
    session.stream = await openSse(session.sessionId);
    sessions.push(session);
  }

  // Verify the heartbeat is a real SSE comment at the byte level. A literal
  // backslash-n sequence sends bytes but cannot delimit an SSE event.
  const heartbeatReader = sessions[0].stream!.response.body?.getReader();
  assert.ok(heartbeatReader, "standalone SSE response must expose a readable stream");
  const heartbeatChunk = await Promise.race([
    heartbeatReader!.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for SSE heartbeat")), 1_000)),
  ]);
  assert.equal(heartbeatChunk.done, false, "heartbeat stream must remain open after the keep-alive");
  const heartbeatText = new TextDecoder().decode(heartbeatChunk.value);
  assert.match(heartbeatText, /^: kontrol-heartbeat\n\n/, "heartbeat must contain actual SSE newline delimiters");
  assert.doesNotMatch(heartbeatText, /\\n/, "heartbeat must not contain escaped backslash-n bytes");
  heartbeatReader!.releaseLock();
  // A subsequent SSE-delimited MCP response remains parseable after the
  // comment heartbeat; this catches a framing change that would poison the
  // next event even though the keep-alive bytes themselves were sent.
  const subsequentEvent = await rpc("tools/list", {}, sessions[0].sessionId);
  assert.equal(subsequentEvent.response.status, 200, JSON.stringify(subsequentEvent.payload));
  assert.ok(subsequentEvent.payload?.result?.tools, "subsequent SSE event must parse into a tool catalog");
  await sessions[0].stream!.response.body?.cancel().catch(() => {});
  sessions[0].stream = undefined;

  await waitFor(async () => (await diagnostics()).mcpSessionMetrics.activeSseStreams === 2);
  let snapshot = await diagnostics();
  assert.equal(snapshot.mcpSessionMetrics.activeSseStreams, 2);
  assert.deepEqual(snapshot.mcpSessionMetrics.activeSseStreamsByClient, { "mcp:mcp:sse-admission-test@1.0.0": 2 });
  assert.equal(snapshot.mcpSessionMetrics.inFlight, 0, "persistent SSE must not count as finite in-flight execution");
  assert.equal(snapshot.mcpSessionMetrics.executionAdmission.activeWeight, 0, "persistent SSE must not consume execution weight");
  assert.equal(snapshot.mcpSessionMetrics.executionAdmission.availableWeight, 4);

  const concurrentResourceReads = await Promise.all([
    rpc("resources/read", { uri: WORKSPACE_APP_URI }, sessions[0].sessionId),
    rpc("resources/read", { uri: WORKSPACE_APP_URI }, sessions[0].sessionId),
  ]);
  assert.ok(
    concurrentResourceReads.every((result) => result.response.status === 200 || result.response.status === 503),
    JSON.stringify(concurrentResourceReads.map((result) => ({ status: result.response.status, error: result.payload?.error }))),
  );
  assert.ok(concurrentResourceReads.some((result) => result.response.status === 200), "at least one concurrent resource read must complete");
  snapshot = await diagnostics();
  assert.equal(snapshot.mcpSessionMetrics.inFlight, 0, "concurrent Workspace App resource reads must release session execution counts");

  const read = await rpc("tools/call", {
    name: "read",
    arguments: { workspaceId: sessions[0].workspaceId, path: "marker.txt" },
  }, sessions[0].sessionId);
  assert.equal(read.response.status, 200, JSON.stringify(read.payload));
  assert.notEqual(read.payload?.result?.isError, true, "read failed while SSE streams were open");

  const bash = await rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId: sessions[0].workspaceId, command: "printf sse-admission-ok", timeout: 10 },
  }, sessions[0].sessionId);
  assert.equal(bash.response.status, 200, JSON.stringify(bash.payload));
  assert.notEqual(bash.payload?.result?.isError, true, `weighted shell execution failed while SSE streams were open: ${JSON.stringify(bash.payload)}`);

  snapshot = await diagnostics();
  assert.equal(snapshot.mcpSessionMetrics.activeSseStreams, 2);
  assert.equal(snapshot.mcpSessionMetrics.executionAdmission.activeWeight, 0);
  assert.equal(snapshot.mcpSessionMetrics.executionAdmission.capacityRejectionsByTool.bash ?? 0, 0);

  const slowBash = rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId: sessions[0].workspaceId, command: "sleep 0.5; printf admission-ok", timeout: 5 },
  }, sessions[0].sessionId);
  await waitFor(async () => (await diagnostics()).mcpSessionMetrics.executionAdmission.activeWeight === 3);
  const rejectedBash = await rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId: sessions[0].workspaceId, command: "printf should-not-run", timeout: 5 },
  }, sessions[0].sessionId);
  assert.equal(rejectedBash.response.status, 503, "a request denied by execution admission should return capacity exhaustion");
  snapshot = await diagnostics();
  assert.equal(snapshot.mcpSessionMetrics.inFlight, 1, "admission rejection must release its session count while the admitted request remains active");
  const slowBashResult = await slowBash;
  assert.equal(slowBashResult.response.status, 200, JSON.stringify(slowBashResult.payload));
  await waitFor(async () => (await diagnostics()).mcpSessionMetrics.inFlight === 0);
  snapshot = await diagnostics();
  assert.equal(snapshot.mcpSessionMetrics.executionAdmission.capacityRejectionsByTool.bash ?? 0, 1);

  for (const session of sessions) {
    if (session.stream) await closeSse(session.sessionId, session.stream);
    session.stream = undefined;
  }
  await waitFor(async () => (await diagnostics()).mcpSessionMetrics.activeSseStreams === 0);

  // Reconnect churn must not make execution capacity disappear. This models
  // the WebUI's initialize -> GET SSE -> resource/tool call -> disconnect
  // cycle rather than only proving one isolated transport.
  for (let index = 0; index < 256; index++) {
    const session = await openSession();
    const stream = await openSse(session.sessionId);
    const resource = await rpc("resources/read", { uri: WORKSPACE_APP_URI }, session.sessionId);
    assert.equal(resource.response.status, 200, `resource read failed during churn at ${index}`);
    const tool = await rpc("tools/call", {
      name: "read",
      arguments: { workspaceId: session.workspaceId, path: "marker.txt" },
    }, session.sessionId);
    assert.equal(tool.response.status, 200, `tool call failed during churn at ${index}`);
    assert.notEqual(tool.payload?.result?.isError, true, `tool call returned an error during churn at ${index}`);
    await closeSse(session.sessionId, stream);
    if (index % 32 === 31) {
      await waitFor(async () => (await diagnostics()).mcpSessionMetrics.activeSseStreams === 0);
      snapshot = await diagnostics();
      assert.equal(snapshot.mcpSessionMetrics.executionAdmission.availableWeight, 4, `execution capacity drifted at churn ${index}`);
      assert.equal(snapshot.mcpSessionMetrics.executionAdmission.activeWeight, 0, `execution permit leaked at churn ${index}`);
      assert.equal(snapshot.mcpSessionMetrics.inFlight, 0, `session execution accounting drifted at churn ${index}`);
    }
  }

  await waitFor(async () => (await diagnostics()).mcpSessionMetrics.activeSseStreams === 0);
  snapshot = await diagnostics();
  assert.equal(snapshot.mcpSessionMetrics.executionAdmission.activeWeight, 0);
  assert.equal(snapshot.mcpSessionMetrics.executionAdmission.availableWeight, 4);
  assert.equal(snapshot.mcpSessionMetrics.admission.execution.activeWeight, 0);
  assert.equal(snapshot.mcpSessionMetrics.admission.execution.availableWeight, 4);
  assert.equal(snapshot.mcpSessionMetrics.inFlight, 0, "resource and tool churn must leave no phantom in-flight requests");
  console.log("mcp-sse-admission.test.ts: all assertions passed");
} finally {
  for (const session of sessions) {
    if (session.stream) await closeSse(session.sessionId, session.stream);
  }
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
