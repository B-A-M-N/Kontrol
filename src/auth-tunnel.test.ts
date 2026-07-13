import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "devdesktop-auth-test-"));
const baseEnv = {
  DEVDESKTOP_CONFIG_DIR: emptyConfigDir,
  DEVDESKTOP_ALLOWED_ROOTS: process.cwd(),
  DEVDESKTOP_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

// --- default mode is oauth and still requires the OAuth owner token ---
{
  const cfg = loadConfig(baseEnv);
  assert.equal(cfg.authMode, "oauth");
}

// --- oauth mode without an owner token is rejected ---
assert.throws(
  () => loadConfig({ ...baseEnv, DEVDESKTOP_OAUTH_OWNER_TOKEN: undefined }),
  /owner.?token/i,
);

// --- invalid DEVDESKTOP_AUTH_MODE is rejected ---
assert.throws(
  () => loadConfig({ ...baseEnv, DEVDESKTOP_AUTH_MODE: "bogus" }),
  /Invalid DEVDESKTOP_AUTH_MODE/,
);

// --- tunnel mode requires a loopback HOST at startup ---
assert.throws(
  () => loadConfig({ ...baseEnv, DEVDESKTOP_AUTH_MODE: "tunnel", HOST: "0.0.0.0" }),
  /loopback/i,
);

// --- tunnel mode on a loopback HOST loads and drops the OAuth owner token ---
{
  const noOauthEnv = {
    ...baseEnv,
    DEVDESKTOP_OAUTH_OWNER_TOKEN: undefined,
    DEVDESKTOP_AUTH_MODE: "tunnel",
    HOST: "127.0.0.1",
  };
  const cfg = loadConfig(noOauthEnv);
  assert.equal(cfg.authMode, "tunnel");
  assert.equal(cfg.oauth.ownerToken, "");
}

// --- config: tunnel bearer token parses + validates length ---
{
  assert.equal(loadConfig(baseEnv).tunnelToken, undefined);
  const cfg = loadConfig({ ...baseEnv, DEVDESKTOP_TUNNEL_TOKEN: "test-token-that-is-long-enough" });
  assert.equal(cfg.tunnelToken, "test-token-that-is-long-enough");
}
assert.throws(
  () => loadConfig({ ...baseEnv, DEVDESKTOP_TUNNEL_TOKEN: "short" }),
  /at least 16 characters/,
);

// --- the inlined review WebUI is a single self-contained file ---
{
  const htmlPath = fileURLToPath(new URL("../dist/ui/workspace-app.html", import.meta.url));
  assert.equal(existsSync(htmlPath), true, "dist/ui/workspace-app.html must exist (run `npm run build:app`)");
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
}

// --- /mcp bearer gate with DEVDESKTOP_TUNNEL_TOKEN ---
{
  const token = "test-bearer-that-is-long-enough";
  // Boot a server in tunnel mode WITH a token; expect 401 without it and 200 with it.
  const { createServer } = await import("./server.js");
  const tokenEnv = {
    ...baseEnv,
    DEVDESKTOP_AUTH_MODE: "tunnel",
    HOST: "127.0.0.1",
    PORT: "7691",
    DEVDESKTOP_TUNNEL_TOKEN: token,
    DEVDESKTOP_ACP_SHARED_SECRET: "test-acp-secret-shared-for-bearer-gate",
  };
  const tokenConfig = loadConfig(tokenEnv);
  tokenConfig.publicBaseUrl = "http://127.0.0.1:7691";
  const { app } = createServer(tokenConfig);
  const server = app.listen(7691, "127.0.0.1");
  try {
    const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const noAuth = await fetch("http://127.0.0.1:7691/mcp", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" }, body: initBody });
    assert.equal(noAuth.status, 401, "missing bearer must be 401");
    const badAuth = await fetch("http://127.0.0.1:7691/mcp", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": "Bearer wrong-token-value-123456789" }, body: initBody });
    assert.equal(badAuth.status, 401, "wrong bearer must be 401");
    const good = await fetch("http://127.0.0.1:7691/mcp", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": `Bearer ${token}` }, body: initBody });
    assert.equal(good.status, 200, "correct bearer must be 200");
  } finally {
    server.close();
  }
}

console.log("auth-tunnel.test.ts: all assertions passed");
process.exit(0);
