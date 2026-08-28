import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { DEVDESKTOP_WORKSPACE_APP_URI, LEGACY_WORKSPACE_APP_URI, OPENAI_WORKSPACE_APP_URI, WORKSPACE_APP_URI } from "./workspace-app-resource.js";

function parseJsonRpcResponse(body: string): unknown {
  const data = body
    .split("\n")
    .find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : body);
}

const emptyConfigDir = mkdtempSync(join(tmpdir(), "kontrol-auth-test-"));
const baseEnv = {
  KONTROL_CONFIG_DIR: emptyConfigDir,
  KONTROL_STATE_DIR: join(emptyConfigDir, "state"),
  KONTROL_WORKTREE_ROOT: join(emptyConfigDir, "worktrees"),
  KONTROL_ALLOWED_ROOTS: process.cwd(),
  KONTROL_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

// --- default mode is oauth and still requires the OAuth owner token ---
{
  const cfg = loadConfig(baseEnv);
  assert.equal(cfg.authMode, "oauth");
}

// --- oauth mode without an owner token is rejected ---
assert.throws(
  () => loadConfig({ ...baseEnv, KONTROL_OAUTH_OWNER_TOKEN: undefined }),
  /owner.?token/i,
);

// --- invalid KONTROL_AUTH_MODE is rejected ---
assert.throws(
  () => loadConfig({ ...baseEnv, KONTROL_AUTH_MODE: "bogus" }),
  /Invalid KONTROL_AUTH_MODE/,
);

// --- tunnel mode requires a loopback HOST at startup ---
assert.throws(
  () => loadConfig({ ...baseEnv, KONTROL_AUTH_MODE: "tunnel", HOST: "0.0.0.0" }),
  /loopback/i,
);

// --- tunnel mode on a loopback HOST loads and drops the OAuth owner token ---
{
  const noOauthEnv = {
    ...baseEnv,
    KONTROL_OAUTH_OWNER_TOKEN: undefined,
    KONTROL_AUTH_MODE: "tunnel",
    HOST: "127.0.0.1",
    // The ask baseline needs reviewer authority in tunnel mode (startup
    // gate); this minimal deployment asserts it through the tunnel secret.
    KONTROL_TUNNEL_REVIEWER_SECRET: "auth-tunnel-reviewer-secret-long-enough",
  };
  const cfg = loadConfig(noOauthEnv);
  assert.equal(cfg.authMode, "tunnel");
  assert.equal(cfg.oauth.ownerToken, "");
}

// --- legacy tunnel bearer token is retained for migration diagnostics only ---
{
  assert.equal(loadConfig(baseEnv).tunnelToken, undefined);
  const cfg = loadConfig({ ...baseEnv, KONTROL_TUNNEL_TOKEN: "test-token-that-is-long-enough" });
  assert.equal(cfg.tunnelToken, "test-token-that-is-long-enough");
}
assert.equal(loadConfig({ ...baseEnv, KONTROL_TUNNEL_TOKEN: "short" }).authMode, "oauth");

// --- the inlined review WebUI is a single self-contained file ---
{
  let uiRoot = fileURLToPath(new URL("../dist", import.meta.url));
  let temporaryUiRoot: string | undefined;
  const existingHtmlPath = join(uiRoot, "ui/workspace-app.html");
  const existingHtml = existsSync(existingHtmlPath) ? readFileSync(existingHtmlPath, "utf8") : "";
  if (!existingHtml.includes('<main id="app"')) {
    // The runtime suite intentionally builds UI candidates in an isolated
    // temporary tree and the launcher tests may remove the mutable dist
    // projection. Keep this security test self-contained instead of relying
    // on whichever prior test happened to leave dist/ behind.
    temporaryUiRoot = mkdtempSync(join(tmpdir(), "kontrol-auth-ui-"));
    execFileSync("npm", ["run", "--silent", "build:app"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, KONTROL_BUILD_OUTPUT_DIR: temporaryUiRoot },
      stdio: "ignore",
    });
    uiRoot = temporaryUiRoot;
  }
  const htmlPath = join(uiRoot, "ui/workspace-app.html");
  assert.equal(existsSync(htmlPath), true, "built UI candidate must contain workspace-app.html");
  const html = readFileSync(htmlPath, "utf8");
  assert.equal(html.includes('<main id="app"'), true, "expected the diff card markup");
  assert.equal(
    /<script[^>]*src=["']\.\/assets\//.test(html),
    false,
    "WebUI must inline its JS (no external ./assets script tag)",
  );
  assert.equal(
    /<link[^>]*href=["']\.\/assets\//.test(html),
    false,
    "WebUI must inline its CSS (no external ./assets link tag)",
  );
  if (temporaryUiRoot) rmSync(temporaryUiRoot, { recursive: true, force: true });
}

// --- tunnel mode never installs a second Kontrol bearer gate ---
{
  const token = "test-bearer-that-is-long-enough";
  // Boot a server in tunnel mode WITH a legacy token; missing and stale
  // Authorization headers must still reach MCP.
  const { createServer } = await import("./server.js");
  const tokenEnv = {
    ...baseEnv,
    KONTROL_AUTH_MODE: "tunnel",
    HOST: "127.0.0.1",
    PORT: "7691",
    KONTROL_TUNNEL_TOKEN: token,
    KONTROL_ACP_SHARED_SECRET: "test-acp-secret-shared-for-bearer-gate",
    KONTROL_ACP_AGENT_SECRET: "test-acp-agent-secret-that-is-long-enough-123",
    KONTROL_ACP_REVIEWER_SECRET: "test-acp-reviewer-secret-that-is-long-enough-123",
    KONTROL_ACP_ADAPTER_SECRET: "test-acp-adapter-secret-that-is-long-enough-123",
  };
  const tokenConfig = loadConfig(tokenEnv);
  tokenConfig.publicBaseUrl = "http://127.0.0.1:7691";
  const { app } = createServer(tokenConfig);
  const server = app.listen(7691, "127.0.0.1");
  try {
    const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const noAuth = await fetch("http://127.0.0.1:7691/mcp", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" }, body: initBody });
    assert.equal(noAuth.status, 200, "tunnel mode must not require a local bearer");
    const badAuth = await fetch("http://127.0.0.1:7691/mcp", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": "Bearer wrong-token-value-123456789" }, body: initBody });
    assert.equal(badAuth.status, 200, "stale local Authorization must not create a second gate");
    const good = await fetch("http://127.0.0.1:7691/mcp", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": `Bearer ${token}` }, body: initBody });
    assert.equal(good.status, 200, "correct bearer must be 200");
    const reviewer = await fetch("http://127.0.0.1:7691/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Kontrol-Tunnel-Reviewer": tokenConfig.tunnelReviewerSecret!,
      },
      body: initBody,
    });
    assert.equal(reviewer.status, 200, "managed tunnel reviewer assertion must initialize");
    const reviewerSessionId = reviewer.headers.get("mcp-session-id");
    assert.ok(reviewerSessionId, "reviewer initialize must return a session id");
    const approvalCenter = await fetch("http://127.0.0.1:7691/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "mcp-session-id": reviewerSessionId,
        "X-Kontrol-Tunnel-Reviewer": tokenConfig.tunnelReviewerSecret!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "open_approval_center", arguments: {} } }),
    });
    assert.equal(approvalCenter.status, 200);
    const approvalPayload = parseJsonRpcResponse(await approvalCenter.text()) as { result?: { isError?: boolean } };
    assert.notEqual(approvalPayload.result?.isError, true, "tunnel reviewer may open the approval center");
    const forgedReviewer = await fetch("http://127.0.0.1:7691/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Kontrol-Tunnel-Reviewer": "forged-reviewer-secret-that-must-not-work",
      },
      body: initBody,
    });
    assert.equal(forgedReviewer.status, 200, "forged reviewer assertion must not block MCP initialization");
    const forgedReviewerSessionId = forgedReviewer.headers.get("mcp-session-id");
    assert.ok(forgedReviewerSessionId, "forged reviewer initialize must still return a client session");
    const forgedApproval = await fetch("http://127.0.0.1:7691/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "mcp-session-id": forgedReviewerSessionId,
        "X-Kontrol-Tunnel-Reviewer": "forged-reviewer-secret-that-must-not-work",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 98, method: "tools/call", params: { name: "open_approval_center", arguments: {} } }),
    });
    const forgedApprovalPayload = parseJsonRpcResponse(await forgedApproval.text()) as { result?: { isError?: boolean } };
    assert.equal(forgedApprovalPayload.result?.isError, true, "forged tunnel reviewer assertions must not grant reviewer authority");
    const plainApproval = await fetch("http://127.0.0.1:7691/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": good.headers.get("mcp-session-id")! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "open_approval_center", arguments: {} } }),
    });
    const plainApprovalPayload = parseJsonRpcResponse(await plainApproval.text()) as { result?: { isError?: boolean } };
    assert.equal(plainApprovalPayload.result?.isError, true, "plain tunnel clients must not become reviewers");
    const emptyPostProbe = await fetch("http://127.0.0.1:7691/mcp", { method: "POST" });
    assert.equal(emptyPostProbe.status, 202, "tunnel empty POST probes must not become application 400s");
    const getProbe = await fetch("http://127.0.0.1:7691/mcp");
    assert.equal(getProbe.status, 200, "tunnel sessionless GET probes must not become application 400s");
    const resourceRead = await fetch("http://127.0.0.1:7691/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: WORKSPACE_APP_URI } }),
    });
    assert.equal(resourceRead.status, 200, "authenticated sessionless resource reads support WebUI template loading");
    const resourcePayload = parseJsonRpcResponse(await resourceRead.text()) as { result?: { contents?: unknown[] } };
    const resource = resourcePayload.result?.contents?.[0] as { uri?: string; mimeType?: string; text?: string } | undefined;
    assert.equal(resource?.uri, WORKSPACE_APP_URI);
    assert.equal(resource?.mimeType, "text/html;profile=mcp-app");
    assert.equal(typeof resource?.text, "string");
    assert.equal(resource?.text?.includes('<main id="app"'), true);

    // A host may cache a template hash from a previous build and send the
    // read over the already-initialized MCP session. That request must not
    // fall through to the per-session registry, which only knows this build's
    // current hash.
    const goodSessionId = good.headers.get("mcp-session-id");
    assert.ok(goodSessionId, "initialize must return an MCP session id");
    const staleResourceUri = "ui://kontrol/workspace-app-6fa984c4ceb8.html";
    const staleResourceRead = await fetch("http://127.0.0.1:7691/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": `Bearer ${token}`,
        "mcp-session-id": goodSessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: staleResourceUri } }),
    });
    assert.equal(staleResourceRead.status, 200, "stale template hashes must work on an existing session");
    const stalePayload = parseJsonRpcResponse(await staleResourceRead.text()) as { result?: { contents?: unknown[] } };
    const staleResource = stalePayload.result?.contents?.[0] as { uri?: string; mimeType?: string; text?: string } | undefined;
    assert.equal(staleResource?.uri, staleResourceUri);
    assert.equal(staleResource?.mimeType, "text/html;profile=mcp-app");
    assert.equal(typeof staleResource?.text, "string");

    const openAiResourceRead = await fetch("http://127.0.0.1:7691/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: OPENAI_WORKSPACE_APP_URI } }),
    });
    assert.equal(openAiResourceRead.status, 200, "authenticated sessionless OpenAI compatibility resource reads support template loading");
    const openAiPayload = parseJsonRpcResponse(await openAiResourceRead.text()) as { result?: { contents?: unknown[] } };
    const openAiResource = openAiPayload.result?.contents?.[0] as { uri?: string; mimeType?: string; text?: string } | undefined;
    assert.equal(openAiResource?.uri, OPENAI_WORKSPACE_APP_URI);
    assert.equal(openAiResource?.mimeType, "text/html+skybridge");
    assert.equal(typeof openAiResource?.text, "string");

    const legacyResourceRead = await fetch("http://127.0.0.1:7691/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: LEGACY_WORKSPACE_APP_URI } }),
    });
    assert.equal(legacyResourceRead.status, 200);
    const legacyPayload = parseJsonRpcResponse(await legacyResourceRead.text()) as { result?: { contents?: unknown[] } };
    const legacyResource = legacyPayload.result?.contents?.[0] as { uri?: string; mimeType?: string } | undefined;
    assert.equal(legacyResource?.uri, LEGACY_WORKSPACE_APP_URI);
    assert.equal(legacyResource?.mimeType, "text/html+skybridge");

    const devDesktopRead = await fetch("http://127.0.0.1:7691/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: DEVDESKTOP_WORKSPACE_APP_URI } }),
    });
    assert.equal(devDesktopRead.status, 200);
    const devDesktopPayload = parseJsonRpcResponse(await devDesktopRead.text()) as { result?: { contents?: unknown[] } };
    const devDesktopResource = devDesktopPayload.result?.contents?.[0] as { uri?: string; mimeType?: string } | undefined;
    assert.equal(devDesktopResource?.uri, DEVDESKTOP_WORKSPACE_APP_URI);
    assert.equal(devDesktopResource?.mimeType, "text/html+skybridge");
  } finally {
    server.close();
  }
}

console.log("auth-tunnel.test.ts: all assertions passed");
process.exit(0);
