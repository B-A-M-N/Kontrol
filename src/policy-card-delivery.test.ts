// P0.1 / P0.2 — policy-aware widget attachment and renderable blocked cards.
//
// In `changes` widget mode a tool whose effective policy can produce an ask
// outcome must still advertise the Workspace App descriptor, and a blocked
// result must carry the `_meta.tool` / `_meta.card` envelope the app uses to
// render it. Without the descriptor a blocked bash call becomes a dead-end
// approval: the host never mounts the surface that could approve it.
//
// All assertions exercise the public MCP surface — no internal hooks.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-policy-card-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-policy-card-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-policy-card-worktrees-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-policy-card-config-"));
writeFileSync(join(root, "marker.txt"), "policy-card-marker\n");

const reviewerToken = "policy-card-reviewer-token-that-is-long-enough";
const config = loadConfig({
  KONTROL_CONFIG_DIR: configDir,
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_POLICY_MODE: "ask",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_LOG_REQUESTS: "0",
  KONTROL_WIDGETS: "changes",
  KONTROL_OAUTH_OWNER_TOKEN: reviewerToken,
  KONTROL_ACP_REVIEWER_SECRET: reviewerToken,
  KONTROL_DIAGNOSTICS_SECRET: "policy-card-test-secret",
});

assert.equal(config.widgets, "changes", "this regression must run in changes mode");
assert.equal(config.policy.defaultMode, "ask", `policy.defaultMode must be ask; got ${JSON.stringify(config.policy)}`);

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
  opts: { sessionId?: string } = {},
): Promise<{ response: Response; payload?: any; sessionId?: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(opts.sessionId ? { "mcp-session-id": opts.sessionId } : {}),
    "x-kontrol-conversation-id": "policy-card-conversation",
  };
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  });
  const text = await response.text();
  return {
    response,
    payload: text.trim() ? parseRpc(text) : undefined,
    sessionId: response.headers.get("mcp-session-id") ?? opts.sessionId,
  };
}

async function openSession(): Promise<{ sessionId: string; workspaceId: string }> {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "policy-card-test-client", version: "1.0.0" },
  });
  assert.equal(initialized.response.status, 200);
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "initialize did not return mcp-session-id");
  const notification = await rpc("notifications/initialized", {}, { sessionId });
  assert.ok([200, 202].includes(notification.response.status));
  const opened = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: root, mode: "checkout" },
  }, { sessionId });
  assert.equal(opened.response.status, 200, JSON.stringify(opened.payload));
  const workspaceId = opened.payload?.result?.structuredContent?.workspaceId
    ?? opened.payload?.result?.workspaceId;
  assert.equal(typeof workspaceId, "string");
  return { sessionId, workspaceId };
}

try {
  const { sessionId, workspaceId } = await openSession();

  // P0.1: in changes mode the bash descriptor must advertise the Workspace App
  // because its effective policy can produce an ask outcome.
  const tools = await rpc("tools/list", {}, { sessionId });
  assert.equal(tools.response.status, 200);
  const listed: any[] = tools.payload?.result?.tools ?? [];
  assert.ok(listed.length > 0);
  const byName = new Map(listed.map((tool) => [tool.name, tool]));
  const bashTool = byName.get("bash");
  assert.ok(bashTool, "bash tool is registered");
  assert.ok(
    typeof bashTool._meta?.ui?.resourceUri === "string" && bashTool._meta.ui.resourceUri.startsWith("ui://kontrol/workspace-app-"),
    `changes-mode bash descriptor must carry the workspace app _meta; got ${JSON.stringify(bashTool._meta)}`,
  );
  assert.deepEqual(bashTool._meta?.ui?.visibility, ["model"]);
  // A read-only tool whose effective policy is also ask carries it too.
  const readTool = byName.get("read");
  assert.ok(readTool, "read tool is registered");
  assert.ok(
    typeof readTool._meta?.ui?.resourceUri === "string",
    `changes-mode read descriptor must carry the workspace app _meta under ask policy; got ${JSON.stringify(readTool._meta)}`,
  );

  // P0.2: a blocked bash result must expose _meta.tool plus a renderable card.
  const blocked = await rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId, command: "printf policy-card-runs" },
  }, { sessionId });
  assert.equal(blocked.response.status, 200, JSON.stringify(blocked.payload));
  assert.equal(blocked.payload?.result?.structuredContent?.status, "approval_required", JSON.stringify(blocked.payload));
  const meta = blocked.payload?.result?._meta;
  assert.equal(meta?.tool, "bash", `blocked bash must carry _meta.tool; got ${JSON.stringify(meta)}`);
  const card = meta?.card;
  assert.ok(card && typeof card === "object", `blocked bash must carry a _meta.card object; got ${JSON.stringify(meta)}`);
  assert.equal(card.tool, "bash");
  assert.equal(card.workspaceId, workspaceId);
  assert.equal(card.status, "approval_required");
  assert.equal(card.approvalId, blocked.payload?.result?.structuredContent?.approvalId);
  assert.equal(typeof card.approvalId, "string");
  assert.deepEqual(card.payload?.content, blocked.payload?.result?.content,
    "card payload must mirror the model-facing content blocks");
  assert.equal(typeof card.summary?.command, "string");

  // A blocked write carries the same envelope with its own canonical tool name.
  const blockedWrite = await rpc("tools/call", {
    name: "write",
    arguments: { workspaceId, path: "blocked.txt", content: "blocked\n" },
  }, { sessionId });
  assert.equal(blockedWrite.response.status, 200, JSON.stringify(blockedWrite.payload));
  assert.equal(blockedWrite.payload?.result?.structuredContent?.status, "approval_required");
  assert.equal(blockedWrite.payload?.result?._meta?.tool, "write");
  assert.equal(blockedWrite.payload?.result?._meta?.card?.path, "blocked.txt");
  assert.equal(blockedWrite.payload?.result?._meta?.card?.workspaceId, workspaceId);

  console.log("policy-card-delivery.test.ts: all assertions passed");
} finally {
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
