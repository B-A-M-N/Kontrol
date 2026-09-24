#!/usr/bin/env node
// Black-box MCP transport regression for a local origin or a running
// Secure MCP Tunnel endpoint. It deliberately opens a fresh MCP transport,
// starts a GET SSE stream, runs a concurrent tool call, disconnects only the
// SSE response, and then proves the same session remains usable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
function has(name) { return args.includes(name); }
const dualSession = has("--dual");

const target = option("--url", "http://127.0.0.1:7676");
const workspacePath = resolve(option("--workspace", process.cwd()));
const cycles = Math.max(1, Number(option("--cycles", dualSession ? "25" : "3")));
const buildMetaPath = option("--build-meta", undefined);
const expectedMcpVersion = option("--expected-mcp-version", undefined);
const diagnosticsSecret = option("--diagnostics-secret", process.env.KONTROL_DIAGNOSTICS_SECRET);
const toolName = option("--tool-name", "bash");
const toolCommand = option("--tool-command", "sleep 0.25; printf tunnel-regression-ok");
const url = `${target.replace(/\/$/, "")}/mcp`;
const diagnosticsUrl = `${target.replace(/\/$/, "")}/diagnostics`;

if (!Number.isInteger(cycles) || cycles < 1) throw new Error("--cycles must be a positive integer");
let expectedVersion = expectedMcpVersion;
if (!expectedVersion && buildMetaPath) {
  const meta = JSON.parse(readFileSync(resolve(buildMetaPath), "utf8"));
  if (typeof meta.version === "string" && typeof meta.contentSha256 === "string") {
    expectedVersion = `${meta.version}+${meta.contentSha256}`;
  }
}

let requestId = 0;
function decode(text) {
  const trimmed = text.trim();
  const data = trimmed.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return JSON.parse(data || trimmed);
}

async function rpc(method, params, sessionId) {
  const isNotification = method.startsWith("notifications/");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(isNotification ? {} : { id: ++requestId }),
      method,
      params,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  const payload = text.trim() ? decode(text) : undefined;
  assert.ok(isNotification ? [200, 202].includes(response.status) : response.status === 200,
    `${method} returned HTTP ${response.status}: ${text}`);
  if (isNotification) {
    assert.equal(payload, undefined, `notification ${method} unexpectedly returned a JSON-RPC response`);
  } else {
    assert.ok(!payload?.error, `${method}: ${payload?.error?.message ?? "JSON-RPC error"}`);
  }
  return {
    response,
    payload,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
  };
}

async function call(name, arguments_, sessionId) {
  const result = await rpc("tools/call", { name, arguments: arguments_ }, sessionId);
  assert.notEqual(result.payload?.result?.isError, true,
    `${name} returned an MCP tool error: ${JSON.stringify(result.payload)}`);
  return result.payload?.result;
}

async function openSession(cycle) {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp:tunnel-regression", version: "1.0.0" },
  });
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, `cycle ${cycle} initialize did not return mcp-session-id`);
  if (expectedVersion) {
    assert.equal(initialized.payload?.result?.serverInfo?.version, expectedVersion,
      `cycle ${cycle} server version does not match immutable build metadata`);
  }
  const notification = await rpc("notifications/initialized", {}, sessionId);
  assert.ok([200, 202].includes(notification.response.status));
  return sessionId;
}

async function openSse(sessionId) {
  const controller = new AbortController();
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      "mcp-session-id": sessionId,
    },
    signal: controller.signal,
  });
  assert.equal(response.status, 200, `GET SSE returned HTTP ${response.status}`);
  return { controller, response };
}

async function disconnectSse(stream) {
  stream.controller.abort();
  await stream.response.body?.cancel().catch(() => {});
}

async function diagnostics() {
  if (!diagnosticsSecret) return undefined;
  const response = await fetch(diagnosticsUrl, {
    headers: { "x-kontrol-diagnostics": diagnosticsSecret },
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200, `diagnostics returned HTTP ${response.status}`);
  return response.json();
}

async function qualifyDualSession(cycle) {
  let a = await openSession(cycle * 2);
  let b = await openSession(cycle * 2 + 1);
  try {
    const openedA = await call("open_workspace", { path: workspacePath, mode: "checkout" }, a);
    const openedB = await call("open_workspace", { path: workspacePath, mode: "checkout" }, b);
    const workspaceA = (openedA?.structuredContent ?? openedA).workspaceId;
    const workspaceB = (openedB?.structuredContent ?? openedB).workspaceId;
    assert.equal(typeof workspaceA, "string");
    assert.equal(typeof workspaceB, "string");
    const resourcesA = await rpc("resources/list", {}, a);
    const resourcesB = await rpc("resources/list", {}, b);
    const resourceA = (resourcesA.payload?.result?.resources ?? []).find((resource) => typeof resource.uri === "string" && resource.mimeType === "text/html;profile=mcp-app");
    const resourceB = (resourcesB.payload?.result?.resources ?? []).find((resource) => typeof resource.uri === "string" && resource.mimeType === "text/html;profile=mcp-app");
    assert.ok(resourceA?.uri && resourceB?.uri, "both tabs must discover the Workspace App resource");
    const widgetA = await rpc("resources/read", { uri: resourceA.uri }, a);
    const widgetB = await rpc("resources/read", { uri: resourceB.uri }, b);
    assert.equal(widgetA.response.status, 200);
    assert.equal(widgetB.response.status, 200);
    const [readA, grepA, readB, grepB] = await Promise.all([
      call("read", { workspaceId: workspaceA, path: "package.json" }, a),
      call("grep", { workspaceId: workspaceA, pattern: "kontrol", path: "package.json" }, a),
      call("read", { workspaceId: workspaceB, path: "package.json" }, b),
      call("grep", { workspaceId: workspaceB, pattern: "kontrol", path: "package.json" }, b),
    ]);
    assert.ok(readA && grepA && readB && grepB, "both tabs must complete interleaved reads/searches");
    const streamA = await openSse(a);
    const streamB = await openSse(b);
    await disconnectSse(streamA);
    const bAfterA = await rpc("tools/list", {}, b);
    assert.equal(bAfterA.response.status, 200, "B must remain live after A SSE disconnect");
    const bRead = await call("read", { workspaceId: workspaceB, path: "package.json" }, b);
    assert.ok(bRead, "B must keep reading after A disconnect");
    await fetch(url, { method: "DELETE", headers: { "mcp-session-id": a }, signal: AbortSignal.timeout(3_000) }).catch(() => {});
    a = await openSession(cycle * 2 + 2);
    const aReconnect = await rpc("tools/list", {}, a);
    assert.equal(aReconnect.response.status, 200, "A reconnect must establish a fresh usable transport");
    await disconnectSse(streamB);
    const aAfterB = await rpc("tools/list", {}, a);
    assert.equal(aAfterB.response.status, 200, "A must remain live after B SSE disconnect");
    const aRead = await call("read", { workspaceId: workspaceA, path: "package.json" }, a);
    assert.ok(aRead, "A must keep reading after B disconnect");
  } finally {
    await fetch(url, { method: "DELETE", headers: { "mcp-session-id": a }, signal: AbortSignal.timeout(3_000) }).catch(() => {});
    await fetch(url, { method: "DELETE", headers: { "mcp-session-id": b }, signal: AbortSignal.timeout(3_000) }).catch(() => {});
  }
}

if (dualSession) {
  for (let cycle = 0; cycle < cycles; cycle++) await qualifyDualSession(cycle);
  console.log(JSON.stringify({ ok: true, url, dualSession: true, cycles, requiredTools: ["read", "grep", "glob", "ls", "poll_process"] }));
  process.exit(0);
}

for (let cycle = 0; cycle < cycles; cycle++) {
  const sessionId = await openSession(cycle);
  const listed = await rpc("tools/list", {}, sessionId);
  const names = new Set((listed.payload?.result?.tools ?? []).map((tool) => tool.name));
  for (const required of ["read", "grep", "glob", "ls", "poll_process"]) {
    assert.ok(names.has(required), `cycle ${cycle} tools/list is missing ${required}`);
  }

  const opened = await call("open_workspace", { path: workspacePath, mode: "checkout" }, sessionId);
  const structured = opened?.structuredContent ?? opened;
  const workspaceId = structured?.workspaceId;
  assert.equal(typeof workspaceId, "string", `cycle ${cycle} open_workspace did not return workspaceId`);

  const stream = await openSse(sessionId);
  const concurrent = call(toolName, {
    workspaceId,
    command: toolCommand,
    timeout: 10,
  }, sessionId);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  await disconnectSse(stream);

  const completed = await concurrent;
  assert.ok(completed, `cycle ${cycle} concurrent call did not complete after SSE disconnect`);
  const afterDisconnect = await rpc("tools/list", {}, sessionId);
  assert.equal(afterDisconnect.response.status, 200, `cycle ${cycle} session was lost after SSE disconnect`);
  const afterNames = new Set((afterDisconnect.payload?.result?.tools ?? []).map((tool) => tool.name));
  for (const required of ["read", "grep", "glob", "ls", "poll_process"]) {
    assert.ok(afterNames.has(required), `cycle ${cycle} post-disconnect tools/list is missing ${required}`);
  }

  const snapshot = await diagnostics();
  if (snapshot) {
    assert.equal(snapshot.mcpSessionMetrics?.activeSseStreams, 0,
      `cycle ${cycle} retained an SSE stream after disconnect`);
    const session = (snapshot.mcpSessionMetrics?.sessions ?? []).find((candidate) => candidate.sessionLabel?.endsWith(`/mcp:${sessionId.slice(0, 8)}`));
    assert.ok(session, `cycle ${cycle} session disappeared after SSE disconnect`);
  }

  await fetch(url, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId },
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {});
}

console.log(JSON.stringify({ ok: true, url, cycles, requiredTools: ["read", "grep", "glob", "ls", "poll_process"] }));
