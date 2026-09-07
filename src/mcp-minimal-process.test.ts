// Regression: minimal-mode bash must detach child lifetime from the MCP
// request, recover through a trusted reconnect, and not launch twice when a
// response is lost and the caller retries the same mutation ID.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-minimal-process-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-minimal-process-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-minimal-process-worktrees-"));
const config = loadConfig({
  KONTROL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "kontrol-minimal-process-config-")),
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_TOOL_MODE: "minimal",
  KONTROL_POLICY_MODE: "allow",
  KONTROL_POLICY_TOOL_BASH: "allow",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_LOG_REQUESTS: "0",
  KONTROL_DIAGNOSTICS_SECRET: "minimal-process-secret",
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
  return { response, payload: text.trim() ? parseRpc(text) : undefined, sessionId: response.headers.get("mcp-session-id") ?? options.sessionId };
}

async function openSession(conversationId: string): Promise<{ sessionId: string; workspaceId: string }> {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "minimal-process-test", version: "1.0.0" },
  }, { conversationId });
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.payload));
  assert.ok(initialized.sessionId);
  const sessionId = initialized.sessionId;
  await rpc("notifications/initialized", {}, { sessionId, conversationId });
  const opened = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: root, mode: "checkout" },
  }, { sessionId, conversationId });
  assert.equal(opened.response.status, 200, JSON.stringify(opened.payload));
  const workspaceId = opened.payload?.result?.structuredContent?.workspaceId;
  assert.equal(typeof workspaceId, "string", JSON.stringify(opened.payload));
  return { sessionId, workspaceId };
}

async function dropTransport(sessionId: string): Promise<void> {
  const stream = await fetch(url, { headers: { accept: "text/event-stream", "mcp-session-id": sessionId } });
  // Aborting the in-flight lost-response POST may already have torn down the
  // old transport before this explicit stream probe runs. Either result is a
  // transport loss; the trusted conversation reconnect below is the assertion
  // that durable process ownership survived it.
  assert.ok([200, 404].includes(stream.status), `unexpected transport status ${stream.status}`);
  await stream.body?.cancel();
}

async function lostLaunch(
  sessionId: string,
  conversationId: string,
  workspaceId: string,
  command: string,
  clientMutationId: string,
): Promise<void> {
  const controller = new AbortController();
  const request = fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "x-kontrol-conversation-id": conversationId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++nextId,
      method: "tools/call",
      params: { name: "bash", arguments: { workspaceId, command, timeout: 60, clientMutationId } },
    }),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50).unref?.();
  await request.then(() => undefined, () => undefined);
}

const marker = join(root, "minimal-process-runs.txt");
const node = JSON.stringify(process.execPath);
const command = `${node} -e 'setTimeout(() => require("node:fs").appendFileSync(${JSON.stringify(marker)}, "run\\n"), 20000)'`;
const conversationId = "minimal-process-conversation";
const clientMutationId = "minimal-process-launch-1";

try {
  const initial = await openSession(conversationId);
  await lostLaunch(initial.sessionId, conversationId, initial.workspaceId, command, clientMutationId);
  await dropTransport(initial.sessionId);
  // Let the detached launch finish its bounded yield and commit the receipt
  // before the retry; the child itself remains alive for later polling.
  await new Promise((resolve) => setTimeout(resolve, 5_500));

  const reconnected = await openSession(conversationId);
  const retried = await rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId: reconnected.workspaceId, command, timeout: 60, clientMutationId },
  }, { sessionId: reconnected.sessionId, conversationId });
  assert.equal(retried.response.status, 200, JSON.stringify(retried.payload));
  assert.notEqual(retried.payload?.result?.isError, true, JSON.stringify(retried.payload));
  const sessionId = retried.payload?.result?.structuredContent?.sessionId;
  assert.equal(typeof sessionId, "string", `retry must recover the original running process: ${JSON.stringify(retried.payload)}`);
  assert.equal(retried.payload?.result?.structuredContent?.running, true, JSON.stringify(retried.payload));

  let finished = false;
  for (let attempt = 0; attempt < 8 && !finished; attempt++) {
    const polled = await rpc("tools/call", {
      name: "poll_process",
      arguments: { workspaceId: reconnected.workspaceId, sessionId, yieldTimeMs: 2_000 },
    }, { sessionId: reconnected.sessionId, conversationId });
    assert.equal(polled.response.status, 200, JSON.stringify(polled.payload));
    assert.notEqual(polled.payload?.result?.isError, true, JSON.stringify(polled.payload));
    finished = polled.payload?.result?.structuredContent?.running === false;
  }
  assert.equal(finished, true, "poll_process must observe child completion");
  assert.equal(readFileSync(marker, "utf8"), "run\n", "lost-response retry must not launch a second child");
  console.log("mcp-minimal-process.test.ts: all assertions passed");
} finally {
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
