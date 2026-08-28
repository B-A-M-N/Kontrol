#!/usr/bin/env node
// End-to-end readiness probe for the local KONTROL control plane.
// This intentionally exercises the same boundary that Devdesktop uses:
// initialize -> discover_agents -> open_workspace -> read -> bash.
import assert from "node:assert/strict";
import { resolve } from "node:path";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const url = flag("--url", "http://127.0.0.1:7676/mcp");
const workspace = resolve(flag("--workspace", process.cwd()));
const skipDiscover = args.includes("--skip-discover");
const probeBash = args.includes("--probe-bash");
const agentSpecs = args
  .map((value, index) => value === "--agent" ? args[index + 1] : undefined)
  .filter(Boolean)
  .map((value) => {
    const separator = value.indexOf("=");
    if (separator < 1 || separator === value.length - 1) throw new Error(`Invalid --agent ${value}; expected name=url`);
    return { name: value.slice(0, separator), url: value.slice(separator + 1) };
  });
if (!url || !workspace) throw new Error("usage: probe-kontrol-readiness.mjs --url URL --workspace PATH [--agent name=url]");

const token = process.env.KONTROL_TUNNEL_TOKEN;
const reviewerToken = process.env.KONTROL_ACP_REVIEWER_SECRET;
let requestId = 0;
let sessionId;

function decode(text) {
  const trimmed = text.trim();
  const data = trimmed.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return JSON.parse(data || trimmed);
}

async function jsonOrText(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text: text.trim() };
  }
}

async function rpc(method, params, { withSession = true } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (reviewerToken) headers["x-kontrol-reviewer-token"] = reviewerToken;
  if (withSession && sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = decode(await response.text());
  if (method === "initialize") sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  assert.equal(response.status, 200, `${method} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  assert.ok(!payload.error, `${method}: ${payload.error?.message ?? "JSON-RPC error"}`);
  return payload.result;
}

async function callTool(name, arguments_) {
  const result = await rpc("tools/call", { name, arguments: arguments_ });
  assert.notEqual(result?.isError, true, `${name} returned an MCP tool error: ${JSON.stringify(result)}`);
  return result?.structuredContent ?? result;
}

const healthUrl = new URL("/healthz", url);
const readyUrl = new URL("/readyz", url);
const health = await (async () => {
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3_000) });
  const body = await jsonOrText(response);
  assert.equal(response.status, 200, `healthz returned HTTP ${response.status}`);
  return body;
})();
assert.deepEqual(health, { ok: true, name: "kontrol" }, "liveness must not disclose runtime/build details");

if (agentSpecs.length > 0) {
  readyUrl.searchParams.set("agents", agentSpecs.map((agent) => `${agent.name}=${agent.url}`).join(","));
}
const readyResponse = await fetch(readyUrl, { signal: AbortSignal.timeout(3_000) });
const readyBody = await jsonOrText(readyResponse);
assert.equal(readyResponse.status, 200, `readyz returned HTTP ${readyResponse.status}: ${JSON.stringify(readyBody)}`);
assert.ok(readyBody.ready === true || readyBody.text === "ready", "KONTROL/tunnel is not ready");

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "kontrol-readiness-probe", version: "1" },
}, { withSession: false });
assert.ok(sessionId, "initialize did not provide an MCP session id");

const discovered = skipDiscover ? { agents: [] } : await callTool("discover_agents", {});
const agents = discovered?.agents ?? [];
for (const expected of agentSpecs) {
  const actual = agents.find((agent) => agent.name === expected.name);
  assert.ok(actual, `required agent ${expected.name} was not discovered`);
  assert.equal(actual.url, expected.url, `agent ${expected.name} registered the wrong URL`);
  assert.equal(actual.alive, true, `agent ${expected.name} is not alive`);
  assert.notEqual(actual.healthy, false, `agent ${expected.name} failed its health probe`);
}

const opened = await callTool("open_workspace", { path: workspace, mode: "checkout" });
assert.ok(opened?.workspaceId, "open_workspace did not return workspaceId");
const read = await callTool("read", { workspaceId: opened.workspaceId, path: "package.json", limit: 5 });
assert.ok(typeof read?.result === "string" || JSON.stringify(read).includes("@b-a-m-n/kontrol"), "read did not return the fixture file");
if (probeBash) {
  const bash = await callTool("bash", { workspaceId: opened.workspaceId, command: "pwd", timeout: 10 });
  assert.ok(typeof bash?.result === "string" || JSON.stringify(bash).includes(workspace), "bash did not execute in the opened workspace");
}

// P1: prove the REVIEWER path, not just the worker path. An ask-capable
// deployment whose WebUI transport cannot open the approval center is a
// deadlocked control plane — the model blocks on approvals no surface can
// resolve. The readiness contract therefore requires a separate
// reviewer-authoritized MCP session to operate the approval center whenever
// the effective policy can produce approvals (any `ask` posture, including
// the secure baseline). Without reviewer credentials configured, an
// ask-capable policy fails here instead of at the first blocked tool call.
const reviewerReadiness = await fetch(readyUrl, { signal: AbortSignal.timeout(3_000) });
const askCapable = jsonOrText(reviewerReadiness).approvalInteractive === true;
if (askCapable) {
  const reviewerToken =
    process.env.KONTROL_TUNNEL_REVIEWER_SECRET ?? process.env.KONTROL_ACP_REVIEWER_SECRET;
  assert.ok(reviewerToken, "ask-capable policy requires KONTROL_TUNNEL_REVIEWER_SECRET (or KONTROL_ACP_REVIEWER_SECRET) for the reviewer readiness path");

  let reviewerSessionId;
  let reviewerRequestId = 0;
  const reviewerRpc = async (method, params, { withSession = true } = {}) => {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-kontrol-reviewer-token": reviewerToken,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (withSession && reviewerSessionId) headers["mcp-session-id"] = reviewerSessionId;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++reviewerRequestId, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = decode(await response.text());
    if (method === "initialize") {
      reviewerSessionId = response.headers.get("mcp-session-id") ?? reviewerSessionId;
    }
    assert.equal(response.status, 200, `reviewer ${method} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
    assert.ok(!payload.error, `reviewer ${method}: ${payload.error?.message ?? "JSON-RPC error"}`);
    return payload.result;
  };

  await reviewerRpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "kontrol-readiness-reviewer-probe", version: "1" },
  }, { withSession: false });
  assert.ok(reviewerSessionId, "reviewer initialize did not provide an MCP session id");
  await reviewerRpc("notifications/initialized", {}, {});
  const approvalCenter = await reviewerRpc("tools/call", { name: "open_approval_center", arguments: {} });
  assert.notEqual(approvalCenter?.isError, true,
    `open_approval_center failed with reviewer authority: ${JSON.stringify(approvalCenter)}`);

  await fetch(url, {
    method: "DELETE",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "mcp-session-id": reviewerSessionId },
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {});
}

if (sessionId) {
  await fetch(url, {
    method: "DELETE",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "mcp-session-id": sessionId },
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {});
}

console.log(JSON.stringify({ ok: true, buildId: health.build?.buildId, workspace, agents: agents.map((agent) => ({ name: agent.name, url: agent.url, healthy: agent.healthy })) }));
