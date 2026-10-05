import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
import {
  fingerprintToolCatalog,
  TOOL_CATALOG_ACK_CAPABILITY,
  TOOL_CATALOG_ACK_METHOD,
} from "./mcp/tool-catalog-handshake.js";

const workspaceRoot = mkdtempSync(join(tmpdir(), "kontrol-catalog-ack-workspace-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-catalog-ack-state-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-catalog-ack-config-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-catalog-ack-worktrees-"));
mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(join(workspaceRoot, "README.md"), "catalog ack test\n");
const diagnosticsSecret = "catalog-ack-test-diagnostics-secret";
const config = loadConfig({
  KONTROL_CONFIG_DIR: configDir,
  KONTROL_ALLOWED_ROOTS: workspaceRoot,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_POLICY_MODE: "allow",
  KONTROL_TOOL_MODE: "full",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_DIAGNOSTICS_SECRET: diagnosticsSecret,
  KONTROL_MCP_REQUIRE_TOOL_CATALOG_ACK: "1",
});

const running = createServer(config);
const httpServer = running.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => httpServer.once("listening", resolve));
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}/mcp`;
let nextId = 0;

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
  const body = await response.text();
  const eventData = body.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim()).join("\n");
  return {
    response,
    payload: body.trim() ? JSON.parse(eventData || body) : undefined,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
  };
}

async function notification(method: string, params: Record<string, unknown>, sessionId: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
  });
}

try {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { extensions: { [TOOL_CATALOG_ACK_CAPABILITY]: { contractVersion: 1 } } },
    clientInfo: { name: "catalog-ack-http-test", version: "1.0.0" },
  });
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.payload));
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "initialize must return the MCP session ID");
  await notification("notifications/initialized", {}, sessionId);

  const beforeAck = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: workspaceRoot, mode: "checkout" },
  }, sessionId);
  assert.equal(beforeAck.response.status, 200);
  assert.equal(beforeAck.payload?.id, nextId, "strict-mode rejection must correlate to the originating JSON-RPC request");
  assert.equal(beforeAck.payload?.error?.code, -32012, JSON.stringify(beforeAck.payload));

  const listed = await rpc("tools/list", {}, sessionId);
  assert.equal(listed.response.status, 200, JSON.stringify(listed.payload));
  const fingerprint = fingerprintToolCatalog(listed.payload?.result);
  assert.ok(fingerprint, "server catalog must produce a canonical fingerprint");
  const serverVersion = initialized.payload?.result?.serverInfo?.version;
  const ackResponse = await notification(TOOL_CATALOG_ACK_METHOD, {
    contractVersion: 1,
    serverVersion,
    hostCatalogSha256: fingerprint.sha256,
    hostToolCount: fingerprint.toolCount,
  }, sessionId);
  assert.ok([200, 202].includes(ackResponse.status), `ack notification returned HTTP ${ackResponse.status}`);

  const opened = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: workspaceRoot, mode: "checkout" },
  }, sessionId);
  assert.equal(opened.response.status, 200, JSON.stringify(opened.payload));
  assert.notEqual(opened.payload?.result?.isError, true, JSON.stringify(opened.payload));

  const diagnosticsResponse = await fetch(new URL("/diagnostics", url), {
    headers: { "x-kontrol-diagnostics": diagnosticsSecret },
  });
  assert.equal(diagnosticsResponse.status, 200);
  const diagnostics = await diagnosticsResponse.json() as any;
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  const session = diagnostics.mcpSessionMetrics.sessions.find((item: any) => item.sessionIdSha256 === sessionHash);
  assert.equal(session?.toolCatalogHandshake?.status, "accepted");
  assert.equal(session?.toolCatalogHandshake?.serverCatalogSha256, fingerprint.sha256);
  assert.equal(session?.toolCatalogHandshake?.hostCatalogSha256, fingerprint.sha256);

  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": sessionId } }).catch(() => {});
  console.log("mcp-tool-catalog-http.test.ts: strict-mode handshake passed");
} finally {
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  rmSync(worktreeRoot, { recursive: true, force: true });
}
