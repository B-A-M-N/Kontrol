#!/usr/bin/env node
/**
 * Tunnel-path reviewer qualification.
 *
 * A local authenticated probe (scripts/probe-kontrol-readiness.mjs) can pass
 * while the real ChatGPT connection remains an ordinary `client`, because it
 * supplies the reviewer credential directly. This probe closes that gap as
 * far as localhost can:
 *
 * 1. Config proof: the installed kontrol-tunnel.service unit carries the
 *    X-Kontrol-Tunnel-Reviewer header args, so the next tunnel start
 *    forwards reviewer authority.
 * 2. Live-tunnel report: whether the RUNNING tunnel-client process carries
 *    the header (informational — expected false until the fixed unit is
 *    deployed and kontrol-tunnel.service is restarted).
 * 3. Server proof: a fresh MCP session presenting x-kontrol-tunnel-reviewer
 *    can perform a reviewer-only read (get_workspace_session_surface).
 * 4. Gate proof: the same call without the header is denied with a role
 *    error (the gate is real, not vacuous).
 *
 * What this still does NOT prove: actual packet traversal of the OpenAI
 * tunnel origin (workspace-authorized; not reachable from localhost). After
 * deploying the fixed unit and restarting only kontrol-tunnel.service, open a
 * FRESH ChatGPT MCP connection and confirm the approval center loads — an
 * existing client session is not promoted by later header changes.
 *
 * The reviewer secret is read from the environment only and never printed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}
const mcpUrl = args.get("--mcp-url") ?? "http://127.0.0.1:7676/mcp";
const workspacePath = resolve(args.get("--workspace-path") ?? join(here, ".."));
const unitFile = args.get("--unit-file")
  ?? join(process.env.HOME ?? "~", ".config/systemd/user/kontrol-tunnel.service");
const reviewerSecret = args.get("--reviewer-secret")
  ?? process.env.KONTROL_TUNNEL_REVIEWER_SECRET
  ?? process.env.KONTROL_ACP_REVIEWER_SECRET;
const timeoutMs = Number(args.get("--timeout-ms") ?? 10_000);

const receipt = {
  mcpUrl,
  unitFile,
  unitHasReviewerHeader: false,
  liveTunnelForwardsReviewer: null,
  reviewerReadOk: false,
  anonymousDenied: false,
};

function decode(text) {
  const trimmed = text.trim();
  const data = trimmed.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return JSON.parse(data || trimmed);
}

// 1. Config proof: installed unit must forward reviewer authority.
assert.ok(existsSync(unitFile), `tunnel unit not found at ${unitFile}; regenerate it with \`kontrol service install\``);
const unitText = readFileSync(unitFile, "utf8");
receipt.unitHasReviewerHeader = unitText.includes("X-Kontrol-Tunnel-Reviewer");
console.log(`${receipt.unitHasReviewerHeader ? "PASS" : "FAIL"} installed unit ${receipt.unitHasReviewerHeader ? "carries" : "MISSING"} X-Kontrol-Tunnel-Reviewer header`);
assert.ok(receipt.unitHasReviewerHeader, "installed kontrol-tunnel.service does not forward reviewer authority; regenerate it after fixing serviceComponents");

// 2. Live-tunnel report (informational until the fixed unit is restarted).
try {
  const pids = execFileSync("pgrep", ["-f", "tunnel-client run"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const forwarding = pids.filter((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("X-Kontrol-Tunnel-Reviewer");
    } catch { return false; }
  });
  receipt.liveTunnelForwardsReviewer = pids.length > 0 && forwarding.length === pids.length;
  console.log(`INFO running tunnel-client pids: ${pids.join(",") || "none"}; forwarding reviewer header: ${String(receipt.liveTunnelForwardsReviewer)}`);
} catch {
  console.log("INFO live tunnel process inspection unavailable on this platform");
}

async function rpc(headers, method, params, { withSession = true, sessionState } = {}) {
  const requestHeaders = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...headers,
  };
  if (withSession && sessionState.id) requestHeaders["mcp-session-id"] = sessionState.id;
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = decode(await response.text());
  if (method === "initialize" && response.headers.get("mcp-session-id")) {
    sessionState.id = response.headers.get("mcp-session-id");
  }
  return payload;
}

async function openSession(extraHeaders) {
  const sessionState = { id: undefined };
  const initialized = await rpc(extraHeaders, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tunnel-reviewer-probe", version: "1" },
  }, { withSession: false, sessionState });
  assert.ok(!initialized.error, `initialize failed: ${JSON.stringify(initialized.error)}`);
  assert.ok(sessionState.id, "initialize did not return an MCP session id");
  await rpc(extraHeaders, "notifications/initialized", {}, { sessionState });
  return sessionState;
}

async function reviewerOnlyRead(extraHeaders) {
  const sessionState = await openSession(extraHeaders);
  const opened = await rpc(extraHeaders, "tools/call", {
    name: "open_workspace",
    arguments: { path: workspacePath },
  }, { sessionState });
  assert.ok(!opened.error, `open_workspace failed: ${JSON.stringify(opened.error)}`);
  const workspaceId = opened.result?.structuredContent?.workspaceId;
  assert.ok(workspaceId, `open_workspace returned no workspaceId: ${JSON.stringify(opened).slice(0, 300)}`);
  return rpc(extraHeaders, "tools/call", {
    name: "get_workspace_session_surface",
    arguments: { workspaceId, filter: "all", limit: 1 },
  }, { sessionState });
}

// 3. Server proof: header session can perform the reviewer-only read.
assert.ok(reviewerSecret, "no reviewer secret: set KONTROL_TUNNEL_REVIEWER_SECRET or KONTROL_ACP_REVIEWER_SECRET in the environment");
const authed = await reviewerOnlyRead({ "x-kontrol-tunnel-reviewer": reviewerSecret });
const authedText = JSON.stringify(authed).slice(0, 300);
assert.ok(!authed.error, `reviewer-header session got a JSON-RPC error: ${authedText}`);
assert.notEqual(authed.result?.isError, true, `reviewer-header session was denied the reviewer-only read: ${authedText}`);
receipt.reviewerReadOk = true;
console.log("PASS fresh session with x-kontrol-tunnel-reviewer performed get_workspace_session_surface");

// 4. Gate proof: headerless session is denied the same read.
const anon = await reviewerOnlyRead({});
const anonText = JSON.stringify(anon);
receipt.anonymousDenied = anon.error?.message?.includes("different role")
  || anonText.includes("requires a different role")
  || anon.result?.isError === true;
console.log(`${receipt.anonymousDenied ? "PASS" : "FAIL"} headerless session ${receipt.anonymousDenied ? "denied reviewer-only read (gate is real)" : `WAS NOT DENIED: ${anonText.slice(0, 300)}`}`);
assert.ok(receipt.anonymousDenied, "headerless session was not denied the reviewer-only read; the role gate may be vacuous");

console.log(JSON.stringify({ tunnelReviewerQualification: receipt }, null, 2));
