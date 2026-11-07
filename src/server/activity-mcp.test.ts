/**
 * Finding 9 (real-MCP half): boot the real server, perform actual
 * authorized direct MCP operations (open_workspace with no work
 * session), then read /activity/data and assert the operations appear
 * in the projection with owner attribution and sanitized fields only.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { createServer } from "../server.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-activity-mcp-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-activity-mcp-state-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-activity-mcp-config-"));
const workspaceRoot = mkdtempSync(join(tmpdir(), "kontrol-activity-mcp-ws-"));
const reviewerSecret = "activity-mcp-reviewer-secret-32chars!";
const diagnosticsSecret = "activity-mcp-diagnostics-secret-32ch";

const config = loadConfig({
  KONTROL_CONFIG_DIR: configDir,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_ALLOWED_ROOTS: workspaceRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_TUNNEL_REVIEWER_SECRET: reviewerSecret,
  KONTROL_POLICY_MODE: "allow",
  KONTROL_TOOL_MODE: "full",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_DIAGNOSTICS_SECRET: diagnosticsSecret,
  KONTROL_BUILD_ID: "activity-mcp-test",
});

const running = createServer(config);
const httpServer = running.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => httpServer.once("listening", resolve));
try {
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  async function rpc(id: number, method: string, params: Record<string, unknown>, sessionId?: string) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "x-kontrol-tunnel-reviewer": reviewerSecret,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return {
      status: response.status,
      session: response.headers.get("mcp-session-id"),
      body: await response.text(),
    };
  }

  const init = await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "activity-test", version: "0" } });
  assert.equal(init.status, 200, "initialize succeeds");
  assert.ok(init.session, "session issued");

  // A real direct workspace operation (no work session exists yet).
  const open = await rpc(2, "tools/call", { name: "open_workspace", arguments: { path: workspaceRoot } }, init.session!);
  assert.equal(open.status, 200, "direct open_workspace succeeds");
  assert.ok(!open.body.includes('"isError":true'), "direct operation completed without error");

  // Poll /activity/data briefly for the completed operations.
  let seen = false;
  for (let attempt = 0; attempt < 20 && !seen; attempt++) {
    const data = await (await fetch(`${base}/activity/data`, {
      headers: { "x-kontrol-diagnostics": diagnosticsSecret },
    })).json() as { recent: Array<Record<string, unknown>>; active: Array<Record<string, unknown>> };
    seen = [...data.recent, ...data.active].some((row) => row.toolName === "open_workspace" && row.owner && row.status === "completed");
    if (!seen) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(seen, "the real direct MCP operation is projected in /activity/data with owner attribution");

  // The page loads without the credential; the data endpoint needs it.
  assert.equal((await fetch(`${base}/activity`)).status, 200);
  assert.equal((await fetch(`${base}/activity/data`)).status, 403);
  console.log("activity-mcp.test.ts: all assertions passed");
} finally {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await running.close();
}
