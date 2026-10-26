/**
 * PR-B integration tests: the public OAuth MCP listener (P0-02) plus the
 * listener-kind session fence (P0-03) and Host/proxy-policy wiring (P0-04).
 * Modelled on src/peer-listener.test.ts: real createServer() instances, real
 * OAuth token issuance through the same provider the server uses, and real
 * HTTP against listeners bound to ephemeral loopback ports.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import net from "node:net";
import http from "node:http";
import type { Server } from "node:http";
import { createServer, runServer } from "../server.js";
import { loadConfig } from "../config.js";
import type { ServerConfig } from "../config.js";
import { SingleUserOAuthProvider } from "../oauth-provider.js";
import { hashPeerCredential } from "../peer/credentials.js";
import {
  createPublicMcpApp,
  edgeAuthorizeAttemptCheck,
  edgeRateLimitCheck,
  isOAuthSurfacePath,
  publicClientLogFields,
  publicHostMatches,
  publicMcpAllowedHosts,
  publicTrustProxyValue,
  redactIpPrefix,
} from "./public-mcp-app.js";
import type { IngressProfile } from "../ingress/types.js";
import { runtimeLockPath } from "../runtime-lock.js";
import { chmodSync, existsSync, utimesSync } from "node:fs";
import { createServer as createNetServer, connect } from "node:net";

const root = mkdtempSync(join(tmpdir(), "kontrol-public-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-public-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-public-wt-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-public-config-"));
// Funnel-style FQDN origin. The enabled owner_public ingress profile must
// equal the canonical publicBaseUrl origin (PR-A one-canonical rule), and a
// tailscale_funnel origin must carry a funnel port — so both use :8443.
const PUBLIC_BASE = "https://kontrol.example.test:8443";
const CANONICAL_MCP_URL = new URL("/mcp", PUBLIC_BASE).href;
const OWNER_TOKEN = "public-oauth-owner-token-that-is-long-enough";
writeFileSync(join(root, "hello.txt"), "hello from kontrol public listener test\n");

// Peer credential fixture (same harness pattern as peer-listener.test.ts /
// peer-failures.test.ts) so the peer listener runs in the same process.
const PEER_ID = "meta-muse";
const PEER_CREDENTIAL_ID = "v1";
const PEER_SECRET = randomBytes(24).toString("hex");
const peerToken = "Bearer " + PEER_CREDENTIAL_ID + ":" + PEER_SECRET;
const peerCredentialFile: string = (() => {
  const file = join(configDir, "public-mcp-peer-registry.json");
  writeFileSync(file, JSON.stringify({
    version: 1,
    peers: [{
      id: PEER_ID,
      credentialId: PEER_CREDENTIAL_ID,
      credentialHash: hashPeerCredential(PEER_CREDENTIAL_ID, PEER_SECRET),
      capabilities: ["workspace:inspect"],
      grantedRoots: [root],
    }],
  }, null, 2));
  chmodSync(file, 0o600);
  const future = new Date(Date.now() + 5_000);
  utimesSync(file, future, future);
  return file;
})();

function publicEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    KONTROL_CONFIG_DIR: configDir,
    KONTROL_ALLOWED_ROOTS: root,
    KONTROL_STATE_DIR: stateDir,
    KONTROL_WORKTREE_ROOT: worktreeRoot,
    KONTROL_AUTH_MODE: "oauth",
    KONTROL_OAUTH_OWNER_TOKEN: OWNER_TOKEN,
    KONTROL_PUBLIC_BASE_URL: PUBLIC_BASE,
    KONTROL_ACP_ENABLED: "false",
    KONTROL_POLICY_MODE: "allow",
    KONTROL_LOG_LEVEL: "error",
    KONTROL_LOG_REQUESTS: "0",
    KONTROL_PUBLIC_MCP_ENABLED: "1",
    // Peer listener enabled in the same process so P2-5 fence coverage can
    // prove peer-created sessions are rejected on the public listener.
    KONTROL_PEER_ENABLED: "1",
    KONTROL_PEER_BIND_HOST: "127.0.0.1",
    KONTROL_PEER_PORT: "47755",
    KONTROL_PEER_CREDENTIAL_FILE: peerCredentialFile,
    KONTROL_INGRESS_PROFILES: JSON.stringify([
      {
        id: "funnel-1",
        kind: "https_bridge",
        audience: "owner_public",
        externalOrigin: PUBLIC_BASE,
        target: "public_oauth_listener",
        enabled: true,
        allowedHosts: ["kontrol.example.test:8443"],
      },
    ]),
    ...overrides,
  };
}

async function listen(server: Server, host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  // `server` here is an Express app (passed as `app as unknown as Server`);
  // app.listen() returns the underlying node:http Server — wait on that.
  const httpServer = server.listen(0, host);
  await new Promise<void>((resolveListening) => httpServer.once("listening", resolveListening));
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  return { server: httpServer as unknown as Server, port: address.port };
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server || !server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

let nextId = 0;
async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ response: Response; payload?: any; sessionId?: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  });
  const text = await response.text();
  const data = text.trim().split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return {
    response,
    payload: data || text.trim() ? JSON.parse(data || text) : undefined,
    sessionId: response.headers.get("mcp-session-id") ?? undefined,
  };
}

function requestWithHost(
  port: number,
  path: string,
  host: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host, ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Raw-socket request: the only way to put two Host headers on one request. */
function rawSocketStatus(port: number, rawRequest: string): Promise<{ statusLine: string; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(rawRequest);
    });
    let data = "";
    sock.on("data", (chunk) => { data += chunk.toString(); });
    sock.on("end", () => {
      const [statusLine = "", ...rest] = data.split("\r\n");
      resolve({ statusLine: statusLine!, body: rest.join("\n") });
    });
    sock.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Pure helpers: allowlist builder, host matching, redaction, proxy context.
// ---------------------------------------------------------------------------
{
  const allowlistConfig: ServerConfig = loadConfig(publicEnv());
  assert.deepEqual(
    publicMcpAllowedHosts(allowlistConfig),
    ["kontrol.example.test", "kontrol.example.test:8443", "127.0.0.1", "localhost", "[::1]"],
    "public allowlist = enabled owner_public profile hosts + canonical hostname + loopback, deduped",
  );
  // F3-C: a secure_tunnel_listener profile hosts must NOT join the public
  // allowlist even with the right audience.
  {
    const tunnelProfile: IngressProfile = {
      id: "tunnel-1",
      kind: "secure_mcp_tunnel",
      audience: "owner_public",
      externalOrigin: PUBLIC_BASE,
      target: "secure_tunnel_listener",
      enabled: true,
      managedByKontrol: false,
      allowedHosts: ["tunnel-relay.example.test"],
    };
    const publicProfile: IngressProfile = {
      id: "funnel-1",
      kind: "https_bridge",
      audience: "owner_public",
      externalOrigin: PUBLIC_BASE,
      target: "public_oauth_listener",
      enabled: true,
      managedByKontrol: false,
      allowedHosts: ["kontrol.example.test:8443"],
    };
    const withTunnel = {
      ...allowlistConfig,
      ingress: { profiles: [tunnelProfile] },
    };
    assert.equal(
      publicMcpAllowedHosts(withTunnel).includes("tunnel-relay.example.test"),
      false,
      "secure_tunnel_listener profile hosts are excluded from the public allowlist",
    );
    const withBoth = {
      ...allowlistConfig,
      ingress: { profiles: [tunnelProfile, publicProfile] },
    };
    assert.equal(
      publicMcpAllowedHosts(withBoth).includes("kontrol.example.test:8443"),
      true,
      "public_oauth_listener profile hosts join the public allowlist",
    );
  }
  const allowlist = publicMcpAllowedHosts(allowlistConfig);
  // External authorities match configured ports exactly; only loopback may
  // carry the ephemeral port of a local probe.
  assert.equal(publicHostMatches("kontrol.example.test", allowlist), true);
  assert.equal(publicHostMatches("kontrol.example.test:8443", allowlist), true);
  assert.equal(publicHostMatches("kontrol.example.test:8444", allowlist), false, "unexpected external Host ports are rejected");
  assert.equal(publicHostMatches("127.0.0.1", allowlist), true);
  assert.equal(publicHostMatches("127.0.0.1:7678", allowlist), true, "loopback probes on the bind port pass");
  assert.equal(publicHostMatches("[::1]", allowlist), true);
  assert.equal(publicHostMatches("[::1]", allowlist), true, "bracketed IPv6 resolves to the same entry");
  assert.equal(publicHostMatches("[::1]:8443", allowlist), true);
  assert.equal(publicHostMatches("evil.example.test", allowlist), false);
  assert.equal(publicHostMatches("127.0.0.2", allowlist), false);

  assert.equal(redactIpPrefix("198.51.100.7"), "198.51.100.x");
  assert.equal(redactIpPrefix("::ffff:203.0.113.9"), "203.0.113.x", "IPv4-mapped form is reduced before redaction");
  assert.equal(redactIpPrefix(undefined), undefined);

  // Spoof resistance (P0-04): with the default direct policy the forwarded
  // header is reported rejected and the SOCKET address remains the source.
  const direct = publicClientLogFields({
    remoteAddress: "127.0.0.1",
    headers: { "x-forwarded-for": "1.2.3.4" },
    policy: { mode: "direct" },
  });
  assert.deepEqual(direct, { clientIpPrefix: "127.0.0.x", rejectedForwarded: true });
  const noHeaders = publicClientLogFields({
    remoteAddress: "::ffff:203.0.113.5",
    headers: {},
    policy: { mode: "direct" },
  });
  assert.deepEqual(noHeaders, { clientIpPrefix: "203.0.113.x", rejectedForwarded: false });
  console.log("public-mcp: allowlist/host-match/redaction/proxy-context pure helpers hold");
}

// ---------------------------------------------------------------------------
// Regression: a config WITHOUT publicMcp builds no public listener.
// ---------------------------------------------------------------------------
{
  const disabledConfig = loadConfig(publicEnv({ KONTROL_PUBLIC_MCP_ENABLED: "" }));
  assert.equal(disabledConfig.publicMcp, undefined, "publicMcp must be undefined unless explicitly enabled");
  const disabled = createServer(disabledConfig);
  assert.equal(disabled.publicApp, undefined, "no public app when the feature is disabled");
  await disabled.close();
  console.log("public-mcp: feature disabled keeps startup unchanged");
}

// ---------------------------------------------------------------------------
// Main server: oauth + public listener + enabled funnel profile.
// ---------------------------------------------------------------------------
const config: ServerConfig = loadConfig(publicEnv());
assert.deepEqual(
  config.publicMcp,
  { enabled: true, port: 7678, bindHost: "127.0.0.1", edgeOAuthSurfaceMaxPerMinute: 60, edgeMcpMaxPerMinute: 240, edgeAuthorizeMaxAttemptsPerWindow: 20 },
  "enabled + oauth mode parses port/bindHost defaults",
);

// Issue a real owner access token through the SAME provider/store the server
// uses (share the SQLite OAuth store on stateDir). Mirrors peer-listener.test.ts.
const issuingProvider = new SingleUserOAuthProvider(
  config.oauth,
  new URL("/mcp", config.publicBaseUrl),
  stateDir,
);
const redirectUri = "http://127.0.0.1/oauth/callback";
const oauthClient = await issuingProvider.clientsStore.registerClient?.({
  redirect_uris: [redirectUri],
  client_name: "public-listener audit",
});
assert.ok(oauthClient, "oauth client must register");
const authorizationCode = "public-audit-" + randomBytes(8).toString("hex");
issuingProvider["codes"].set(authorizationCode, {
  clientId: oauthClient.client_id,
  params: {
    redirectUri,
    codeChallenge: "public-audit-challenge",
    scopes: ["kontrol"],
    resource: new URL("/mcp", config.publicBaseUrl),
  },
  expiresAtMs: Date.now() + 60_000,
});
const oauthTokens = await issuingProvider.exchangeAuthorizationCode(
  oauthClient,
  authorizationCode,
  undefined,
  redirectUri,
  new URL("/mcp", config.publicBaseUrl),
);
issuingProvider.close();
const ownerAccessToken = `Bearer ${oauthTokens.access_token}`;

const running = createServer(config);
assert.ok(running.publicApp, "public app exists when enabled");
const ownerListener = await listen(running.app as unknown as Server);
const publicListener = await listen(running.publicApp as unknown as Server);
const ownerUrl = "http://127.0.0.1:" + ownerListener.port + "/mcp";
const publicUrl = "http://127.0.0.1:" + publicListener.port + "/mcp";

// Narrow createPublicMcpApp contract: refuses a config without publicMcp.
assert.throws(
  () => createPublicMcpApp({
    config: disabledConfigSnapshot(),
    oauthProvider: null as never,
    resourceServerUrl: new URL("/mcp", "https://kontrol.example.test:8443"),
    bearerAuth: (() => {}) as never,
    handleMcpRequest: () => {},
  }),
  /requires config\.publicMcp/,
);

function disabledConfigSnapshot(): ServerConfig {
  return { ...config, publicMcp: undefined };
}

// ---------------------------------------------------------------------------
// Edge limiter end-to-end: a low-cap app 429s the request after the cap.
// ---------------------------------------------------------------------------
{
  // The SDK router needs a real provider instance. F3-F: use an ISOLATED
  // state dir so this block never contends with the live server's provider
  // on the shared SQLite store.
  const lowCapStateDir = mkdtempSync(join(tmpdir(), "kontrol-lowcap-state-"));
  const lowCapProvider = new SingleUserOAuthProvider(
    config.oauth,
    new URL("/mcp", config.publicBaseUrl),
    lowCapStateDir,
  );
  const lowCapApp = createPublicMcpApp({
    config: { ...config, publicMcp: { ...config.publicMcp!, port: 7999, bindHost: "127.0.0.1" } },
    oauthProvider: lowCapProvider,
    resourceServerUrl: new URL("/mcp", config.publicBaseUrl),
    bearerAuth: (() => {}) as never,
    handleMcpRequest: () => {},
    edgeOAuthSurfaceMaxPerMinute: 1000,
    edgeMcpMaxPerMinute: 3,
  });
  const lowCapListener = await listen(lowCapApp.app as unknown as Server);
  try {
    const url = "http://127.0.0.1:" + lowCapListener.port + "/healthz";
    const statuses: number[] = [];
    let capBody: { error?: { code?: string } } | undefined;
    for (let i = 0; i < 4; i++) {
      const response = await fetch(url);
      statuses.push(response.status);
      if (response.status === 429) {
        capBody = await response.json() as { error?: { code?: string } };
      } else {
        await response.body?.cancel();
      }
    }
    assert.deepEqual(statuses, [200, 200, 200, 429], "the request after the cap is 429 end-to-end over HTTP");
    assert.equal(capBody?.error?.code, "rate_limited", "the cap 429 body carries the rate_limited code");
  } finally {
    lowCapListener.server.close();
    lowCapListener.server.closeAllConnections?.();
    lowCapProvider.close();
  }
}

// ---------------------------------------------------------------------------
// F2-1: the OAuth surface 429s under its own low cap, with the error body.
// ---------------------------------------------------------------------------
{
  const oauthStateDir = mkdtempSync(join(tmpdir(), "kontrol-oauthcap-state-"));
  const oauthCapProvider = new SingleUserOAuthProvider(
    config.oauth,
    new URL("/mcp", config.publicBaseUrl),
    oauthStateDir,
  );
  const oauthCapApp = createPublicMcpApp({
    config: { ...config, publicMcp: { ...config.publicMcp!, port: 7998, bindHost: "127.0.0.1" } },
    oauthProvider: oauthCapProvider,
    resourceServerUrl: new URL("/mcp", config.publicBaseUrl),
    bearerAuth: (() => {}) as never,
    handleMcpRequest: () => {},
    edgeOAuthSurfaceMaxPerMinute: 2,
    edgeMcpMaxPerMinute: 1000,
    edgeAuthorizeMaxAttemptsPerWindow: 1000,
  });
  const oauthCapListener = await listen(oauthCapApp.app as unknown as Server);
  try {
    const url = "http://127.0.0.1:" + oauthCapListener.port + "/.well-known/oauth-protected-resource/mcp";
    const statuses: number[] = [];
    let limitedBody: { error?: { code?: string } } | undefined;
    for (let i = 0; i < 3; i++) {
      const response = await fetch(url);
      statuses.push(response.status);
      if (response.status === 429) {
        limitedBody = await response.json() as { error?: { code?: string } };
      } else {
        await response.body?.cancel();
      }
    }
    assert.deepEqual(statuses, [200, 200, 429], "the OAuth surface 429s under its own cap");
    assert.equal(limitedBody?.error?.code, "rate_limited", "the 429 body carries the rate_limited code");
  } finally {
    oauthCapListener.server.close();
    oauthCapListener.server.closeAllConnections?.();
    oauthCapProvider.close();
  }
}

// ---------------------------------------------------------------------------
// F2-1 + F3-D: authorize-attempt sliding-window throttle (unit) + classifier
// coverage, including the Express-5 path variants that must classify the same.
// ---------------------------------------------------------------------------
{
  const attemptStore = new Map<string, { timestamps: number[]; lastSeenAtMs: number }>();
  // Under the cap: allowed. The window is SLIDING, so feed timestamps that
  // spread the 3 attempts across it.
  assert.equal(edgeAuthorizeAttemptCheck(attemptStore, "k", 1000, 3, 60_000), true, "first attempt allowed");
  assert.equal(edgeAuthorizeAttemptCheck(attemptStore, "k", 20_000, 3, 60_000), true, "second attempt allowed");
  assert.equal(edgeAuthorizeAttemptCheck(attemptStore, "k", 40_000, 3, 60_000), true, "third attempt allowed");
  // The 4th attempt INSIDE the window (any 60s span now holds 3) is denied.
  assert.equal(edgeAuthorizeAttemptCheck(attemptStore, "k", 55_000, 3, 60_000), false, "attempt inside a full sliding window is denied");
  // A different key is unaffected.
  assert.equal(edgeAuthorizeAttemptCheck(attemptStore, "k2", 55_000, 3, 60_000), true, "throttle is per key");
  // Attempts age out: by 61_000 the first attempt (t=1000) has left every
  // window-length span (61_000 - 1000 >= 60_000).
  assert.equal(edgeAuthorizeAttemptCheck(attemptStore, "k", 61_000, 3, 60_000), true, "attempts outside the sliding window no longer count");
  // Classifier: OAuth endpoints in, everything else out — INCLUDING the
  // Express-5 path variants (case-insensitive, optional trailing slash) that
  // reach the same handlers via router.use.
  for (const path of ["/authorize", "/token", "/register", "/revoke", "/.well-known/oauth-authorization-server",
    "/authorize/", "/AUTHORIZE", "/Authorize", "/authorize//", "/TOKEN", "/.WELL-KNOWN/oauth-protected-resource/mcp"]) {
    assert.equal(isOAuthSurfacePath(path), true, path + " is OAuth surface");
  }
  for (const path of ["/mcp", "/healthz", "/anything-else", "/authorizex", "/tokenize"]) {
    assert.equal(isOAuthSurfacePath(path), false, path + " is not OAuth surface");
  }
  console.log("public-mcp: authorize-attempt sliding-window throttle + classifier hold");
}

// ---------------------------------------------------------------------------
// F2-1 end-to-end: repeated 401s on the OAuth surface trip the failure
// throttle (429) even though the success cap is high.
// ---------------------------------------------------------------------------
{
  const throttleStateDir = mkdtempSync(join(tmpdir(), "kontrol-throttle-state-"));
  const throttleProvider = new SingleUserOAuthProvider(
    config.oauth,
    new URL("/mcp", config.publicBaseUrl),
    throttleStateDir,
  );
  const throttleApp = createPublicMcpApp({
    config: { ...config, publicMcp: { ...config.publicMcp!, port: 7997, bindHost: "127.0.0.1" } },
    oauthProvider: throttleProvider,
    resourceServerUrl: new URL("/mcp", config.publicBaseUrl),
    bearerAuth: (() => {}) as never,
    handleMcpRequest: () => {},
    edgeOAuthSurfaceMaxPerMinute: 1000,
    edgeMcpMaxPerMinute: 1000,
    edgeAuthorizeMaxAttemptsPerWindow: 3,
  });
  const throttleListener = await listen(throttleApp.app as unknown as Server);
  try {
    const lockBase = "http://127.0.0.1:" + throttleListener.port;
    // Register a real client through the open registration endpoint so the
    // authorize flow reaches the owner-token check.
    const reg = await fetch(lockBase + "/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "lockout-e2e", redirect_uris: ["http://127.0.0.1:8765/callback"] }),
    });
    assert.equal(reg.status, 201, "open client registration succeeds");
    const registered = await reg.json() as { client_id?: string };
    assert.ok(registered.client_id, "registration returns a client_id");

    // POST /authorize with a WRONG owner token: the provider answers 401 and
    // records a brute-force failure (src/oauth-provider.ts recordFailure) --
    // the provider-recorded failure path the throttle bounds. The throttle
    // counts ATTEMPTS at admission, so the 4th POST inside the window is 429
    // from the edge before the provider is ever consulted (attempts 1-3 still
    // reach the provider and produce 401).
    const form = new URLSearchParams({
      response_type: "code",
      client_id: registered.client_id!,
      redirect_uri: "http://127.0.0.1:8765/callback",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      resource: new URL("/mcp", config.publicBaseUrl).href,
      owner_token: "not-the-owner-token",
    });
    const url = lockBase + "/authorize";
    const statuses: number[] = [];
    let throttleBody: { error?: { code?: string } } | undefined;
    for (let i = 0; i < 6; i++) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      statuses.push(response.status);
      if (response.status === 429) {
        throttleBody = await response.json() as { error?: { code?: string } };
      } else {
        await response.body?.cancel();
      }
    }
    assert.deepEqual(statuses, [401, 401, 401, 429, 429, 429], "repeated authorize attempts trip the edge throttle end-to-end");
    assert.equal(throttleBody?.error?.code, "rate_limited", "the throttle 429 body carries the rate_limited code");
    assert.equal(throttleProvider.publicGlobalFailureCount, 3, "only provider-reached public failures enter the public budget");
    assert.equal(throttleProvider.globalFailureCount, 0, "public failures do not consume the owner failure budget");
    assert.equal(throttleProvider.isLockedOut("owner-client|127.0.0.1"), false, "public attempts cannot lock owner authorization");

    // P2-1 regression: Express 5 path variants reach the SAME provider
    // handler (router.use mount, case-insensitive, trailing slash optional),
    // so the throttle must classify them identically — a variant POST must
    // be 429 (throttled), never a fresh 401 from the provider.
    for (const variant of ["/authorize/", "/AUTHORIZE", "/authorize//"]) {
      const variantResponse = await fetch(lockBase + variant, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      assert.equal(variantResponse.status, 429, "path variant " + variant + " is throttled like /authorize");
      // Parse the JSON body: this pins the 429 to OUR edge throttle (JSON
      // rate_limited) rather than a provider-side per-key 429 (HTML).
      const variantBody = await variantResponse.json() as { error?: { code?: string } };
      assert.equal(variantBody?.error?.code, "rate_limited", "path variant " + variant + " is edge-throttled");
    }
  } finally {
    throttleListener.server.close();
    throttleListener.server.closeAllConnections?.();
    throttleProvider.close();
  }
}

// ---------------------------------------------------------------------------
// App surface: only OAuth /mcp + liveness; everything else 404.
// ---------------------------------------------------------------------------
{
  const health = await fetch(publicUrl.replace(/\/mcp$/, "/healthz"));
  assert.equal(health.status, 200);
  const healthBody = await health.json() as { ok?: unknown; name?: string };
  assert.equal(healthBody.ok, true, "public /healthz is boolean-only liveness");

  const unauth = await fetch(publicUrl);
  assert.equal(unauth.status, 401, "unauthenticated GET /mcp is rejected by the real SDK bearer middleware");
  assert.ok(unauth.headers.get("www-authenticate"), "401 carries a WWW-Authenticate challenge");
  await unauth.body?.cancel();

  for (const path of ["/acp", "/diagnostics", "/mcp-app-assets/anything", "/peer/healthz"]) {
    const response = await fetch(publicUrl.replace(/\/mcp$/, path));
    assert.equal(response.status, 404, `public listener must not serve ${path}`);
    await response.body?.cancel();
  }

  // RFC 9728 path-specific protected-resource metadata (the SDK mounts the
  // bare path only when the resource has no /mcp suffix — same as the owner
  // app's router construction).
  const metadata = await fetch(publicUrl.replace(/\/mcp$/, "/.well-known/oauth-protected-resource/mcp"));
  assert.equal(metadata.status, 200);
  const metadataBody = await metadata.json() as { resource?: string };
  assert.equal(metadataBody.resource, CANONICAL_MCP_URL, "resource metadata advertises the canonical /mcp URL");
  console.log("public-mcp: narrow surface (health, 401 SDK bearer, 404s, discovery) holds");
}

// ---------------------------------------------------------------------------
// Host policy: exact allowlist, spoofed Host rejected, duplicate Host rejected.
// ---------------------------------------------------------------------------
{
  const spoofed = await requestWithHost(publicListener.port, "/healthz", "evil.example.test");
  assert.equal(spoofed.status, 403, "Host outside the allowlist is rejected");
  assert.match(spoofed.body, /forbidden_host/);

  const allowedFqdn = await requestWithHost(publicListener.port, "/healthz", "kontrol.example.test");
  assert.equal(allowedFqdn.status, 200, "funnel-profile FQDN passes host validation");

  const allowedFqdnMcp = await requestWithHost(publicListener.port, "/mcp", "kontrol.example.test");
  assert.equal(allowedFqdnMcp.status, 401, "allowed Host proceeds past the host gate to the OAuth bearer gate");

  // Two Host headers on the wire: raw socket, because http.fetch/request
  // clients normalize or refuse duplicate host entries.
  const dup = await rawSocketStatus(
    publicListener.port,
    "GET /healthz HTTP/1.1\r\nHost: kontrol.example.test\r\nHost: evil.example.test\r\nConnection: close\r\n\r\n",
  );
  assert.match(dup.statusLine, /^HTTP\/1\.1 403\b/, "duplicate Host headers are rejected outright");
  assert.match(dup.body, /forbidden_host/);
  console.log("public-mcp: host policy (spoofed, allowed FQDN, duplicate Host) holds");
}

// ---------------------------------------------------------------------------
// Listener-kind session fence (P0-03), both directions, real sessions.
// ---------------------------------------------------------------------------
{
  const initParams = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp:public-listener-test", version: "1.0.0" } };
  const publicInit = await rpc(publicUrl, "initialize", initParams, { authorization: ownerAccessToken });
  assert.equal(publicInit.response.status, 200, "valid token initializes on the public listener");
  assert.ok(publicInit.sessionId);
  const ownerInit = await rpc(ownerUrl, "initialize", initParams, { authorization: ownerAccessToken });
  assert.equal(ownerInit.response.status, 200, "valid token initializes on the owner listener");
  assert.ok(ownerInit.sessionId);

  // Positive controls: each session works on its own listener.
  const publicSelf = await rpc(publicUrl, "tools/list", {}, { authorization: ownerAccessToken, "mcp-session-id": publicInit.sessionId! });
  assert.equal(publicSelf.response.status, 200, "owner_public session works on the public listener");
  const ownerSelf = await rpc(ownerUrl, "tools/list", {}, { authorization: ownerAccessToken, "mcp-session-id": ownerInit.sessionId! });
  assert.equal(ownerSelf.response.status, 200, "owner session works on the owner listener");

  // Cross-listener resume is fenced in both directions.
  const publicSessionOnOwner = await rpc(ownerUrl, "tools/list", {}, {
    authorization: ownerAccessToken,
    "mcp-session-id": publicInit.sessionId!,
  });
  assert.equal(publicSessionOnOwner.response.status, 403, "owner_public session cannot attach from the owner listener");
  assert.match(
    JSON.stringify(publicSessionOnOwner.payload),
    /MCP session belongs to another listener/,
  );
  const ownerSessionOnPublic = await rpc(publicUrl, "tools/list", {}, {
    authorization: ownerAccessToken,
    "mcp-session-id": ownerInit.sessionId!,
  });
  assert.equal(ownerSessionOnPublic.response.status, 403, "owner session cannot attach from the public listener");
  assert.match(
    JSON.stringify(ownerSessionOnPublic.payload),
    /MCP session belongs to another listener/,
  );

  await fetch(ownerUrl, { method: "DELETE", headers: { "mcp-session-id": ownerInit.sessionId!, authorization: ownerAccessToken } }).catch(() => {});
  await fetch(publicUrl, { method: "DELETE", headers: { "mcp-session-id": publicInit.sessionId!, authorization: ownerAccessToken } }).catch(() => {});
  console.log("public-mcp: listener-kind fence holds in both directions");

  // P2-5 (1): a PEER-created session presented on the public listener → 403.
  const peerInitParams = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp:meta-muse", version: "1.0.0" } };
  assert.ok(running.peerApp, "peer app must exist for the tri-listener fence coverage");
  const peerListener = await listen(running.peerApp as unknown as Server);
  const peerUrl = "http://127.0.0.1:" + peerListener.port + "/mcp";
  let peerSessionId: string | undefined;
  try {
    const peerInit = await rpc(peerUrl, "initialize", peerInitParams, { authorization: peerToken });
    assert.equal(peerInit.response.status, 200, "peer initialize with the peer credential succeeds");
    peerSessionId = peerInit.sessionId;
    assert.ok(peerSessionId);
    const peerSessionOnPublic = await rpc(publicUrl, "tools/list", {}, {
      authorization: ownerAccessToken,
      "mcp-session-id": peerSessionId,
    });
    assert.equal(peerSessionOnPublic.response.status, 403, "peer session cannot attach from the public listener");
    // The identity fence legitimately fires BEFORE the listener fence for
    // peer-to-public: logicalClientId derives from the peer principal and
    // cannot match a public OAuth client id (not constructible across
    // principals). The LISTENER fence itself is proven by the
    // owner-to-public cases above (exact message asserted there); this
    // case proves the peer->public pair is fail-closed under whichever
    // fence precedes - pinned to the message that actually fires.
    assert.match(
      JSON.stringify(peerSessionOnPublic.payload),
      /MCP session belongs to another client/,
    );

    // P2-5 (2): GET/SSE resume of a foreign-listener session → 403 before any
    // SSE opens. Fresh owner session (the earlier fence block deleted its own).
    const freshOwnerInit = await rpc(ownerUrl, "initialize", initParams, { authorization: ownerAccessToken });
    assert.equal(freshOwnerInit.response.status, 200);
    assert.ok(freshOwnerInit.sessionId);
    try {
      const sseResume = await fetch(publicUrl, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          authorization: ownerAccessToken,
          "mcp-session-id": freshOwnerInit.sessionId!,
        },
      });
      assert.equal(sseResume.status, 403, "GET/SSE resume of an owner session on the public listener is fenced");
      await sseResume.body?.cancel();

      // P2-5 (3): DELETE with a foreign-listener session id → 403.
      const foreignDelete = await fetch(publicUrl, {
        method: "DELETE",
        headers: { authorization: ownerAccessToken, "mcp-session-id": freshOwnerInit.sessionId! },
      });
      assert.equal(foreignDelete.status, 403, "DELETE of an owner session id on the public listener is fenced");
      await foreignDelete.body?.cancel();
    } finally {
      await fetch(ownerUrl, { method: "DELETE", headers: { "mcp-session-id": freshOwnerInit.sessionId!, authorization: ownerAccessToken } }).catch(() => {});
    }

    console.log("public-mcp: fence covers peer→public, GET/SSE resume, and DELETE paths");
  } finally {
    if (peerSessionId) {
      await fetch(peerUrl, { method: "DELETE", headers: { "mcp-session-id": peerSessionId, authorization: peerToken } }).catch(() => {});
    }
    await closeServer(peerListener.server);
  }
}

// ---------------------------------------------------------------------------
// Forwarded-header spoof resistance over real HTTP: XFF never authorizes.
// ---------------------------------------------------------------------------
{
  const withXff = await fetch(publicUrl, {
    headers: { "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "5.6.7.8" },
  });
  assert.equal(withXff.status, 401, "forwarded headers do not change authorization (still bearer-gated 401)");
  await withXff.body?.cancel();
  console.log("public-mcp: forwarded-header spoof resistance holds over HTTP");
}

// ---------------------------------------------------------------------------
// P1-2/P2-2 unit helpers: trust-proxy value + bounded edge limiter.
// ---------------------------------------------------------------------------
{
  // direct mode → never trust.
  assert.equal(publicTrustProxyValue({ mode: "direct" }), false);
  // exact_peers → callback trusts only normalized peers (IPv4-mapped forms
  // normalize identically).
  const policy = trustedProxyPolicy();
  const value = publicTrustProxyValue(policy);
  assert.equal(typeof value, "function");
  const trust = value as (ip: string) => boolean;
  assert.equal(trust("127.0.0.1"), true, "configured peer is trusted");
  assert.equal(trust("::ffff:127.0.0.1"), true, "IPv4-mapped spelling of the peer normalizes to trusted");
  assert.equal(trust("10.9.8.7"), false, "unconfigured address is never trusted");
  console.log("public-mcp: trust-proxy callback is policy-driven and never trust-all");

  // Edge limiter: fixed window blocks after the cap, resets on a fresh window,
  // and prunes bounded volume.
  const store = new Map<string, { timestamps: number[]; lastSeenAtMs: number }>();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i += 1) {
    assert.equal(edgeRateLimitCheck(store, "a", t0 + i, 3), true, `request ${i} within cap allowed`);
  }
  assert.equal(edgeRateLimitCheck(store, "a", t0 + 3, 3), false, "4th request in window blocked (cap 3)");
  assert.equal(edgeRateLimitCheck(store, "b", t0 + 4, 3), true, "other key unaffected");
  assert.equal(edgeRateLimitCheck(store, "a", t0 + 60_001, 3), true, "window reset allows again");
  // Volume bound: many keys stay capped.
  for (let i = 0; i < 2_000; i += 1) edgeRateLimitCheck(store, `key-${i}`, t0 + 60_002 + i, 240);
  assert.ok(store.size <= 1_024, "store is bounded at EDGE_MAX_KEYS");
  console.log("public-mcp: edge limiter window + bounded volume hold");
}

function trustedProxyPolicy(): { mode: "exact_peers"; peers: string[]; maxChainLength: number } {
  return { mode: "exact_peers", peers: ["127.0.0.1"], maxChainLength: 5 };
}

// ---------------------------------------------------------------------------
// P2-4: public bind failure via the REAL runServer path rolls back cleanly.
// ---------------------------------------------------------------------------
await runServerPublicBindFailure();

async function runServerPublicBindFailure(): Promise<void> {
  async function freePort(): Promise<number> {
    return new Promise((resolve) => {
      const s = createNetServer();
      s.listen(0, "127.0.0.1", () => {
        const address = s.address() as { port: number };
        s.close(() => resolve(address.port));
      });
    });
  }
  function connectionRefused(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect(port, host);
      const done = (result: boolean) => { socket.destroy(); resolve(result); };
      socket.once("connect", () => done(false));
      socket.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED"));
      socket.setTimeout(2500, () => done(false));
    });
  }

  // Isolated fixture roots/states so this scenario cannot touch the shared
  // harness state above.
  const failRoot = mkdtempSync(join(tmpdir(), "kontrol-public-bind-root-"));
  const failState = mkdtempSync(join(tmpdir(), "kontrol-public-bind-state-"));
  const failWorktrees = mkdtempSync(join(tmpdir(), "kontrol-public-bind-wt-"));
  const failConfig = mkdtempSync(join(tmpdir(), "kontrol-public-bind-config-"));
  const failPeerConfig = mkdtempSync(join(tmpdir(), "kontrol-public-bind-peer-cfg-"));
  const failCredentialFile: string = (() => {
    const file = join(failPeerConfig, "bind-failure-registry.json");
    writeFileSync(file, JSON.stringify({
      version: 1,
      peers: [{
        id: PEER_ID,
        credentialId: PEER_CREDENTIAL_ID,
        credentialHash: hashPeerCredential(PEER_CREDENTIAL_ID, PEER_SECRET),
        capabilities: ["workspace:inspect"],
        grantedRoots: [failRoot],
      }],
    }, null, 2));
    chmodSync(file, 0o600);
    const future = new Date(Date.now() + 5_000);
    utimesSync(file, future, future);
    return file;
  })();

  // Occupy the public MCP port so the THIRD bind must fail.
  const publicPort = await freePort();
  const dummyPublic = createNetServer();
  await new Promise<void>((resolve) => dummyPublic.listen(publicPort, "127.0.0.1", resolve));
  const ownerPort = await freePort();
  const peerPort = await freePort();

  const bindFailConfig = loadConfig({
    KONTROL_CONFIG_DIR: failConfig,
    KONTROL_ALLOWED_ROOTS: failRoot,
    KONTROL_STATE_DIR: failState,
    KONTROL_WORKTREE_ROOT: failWorktrees,
    KONTROL_AUTH_MODE: "oauth",
    KONTROL_OAUTH_OWNER_TOKEN: "public-bind-failure-owner-token-long-enough",
    KONTROL_PUBLIC_BASE_URL: PUBLIC_BASE,
    KONTROL_ACP_ENABLED: "false",
    KONTROL_POLICY_MODE: "allow",
    KONTROL_LOG_LEVEL: "error",
    KONTROL_LOG_REQUESTS: "0",
    KONTROL_PUBLIC_MCP_ENABLED: "1",
    KONTROL_PUBLIC_MCP_PORT: String(publicPort),
    KONTROL_PEER_ENABLED: "1",
    KONTROL_PEER_BIND_HOST: "127.0.0.1",
    KONTROL_PEER_PORT: String(peerPort),
    KONTROL_PEER_CREDENTIAL_FILE: failCredentialFile,
    HOST: "127.0.0.1",
    PORT: String(ownerPort),
  });

  const lockPath = runtimeLockPath(failState);
  let rejected = false;
  try {
    await runServer(bindFailConfig);
  } catch (error) {
    rejected = true;
    assert.match(
      String(error),
      new RegExp("public MCP listener failed to bind"),
      "runServer must reject with the public bind failure",
    );
  }
  assert.equal(rejected, true, "runServer must reject when the public MCP port is occupied");

  // Rollback: owner AND peer listeners closed, runtime lock released, and
  // after the dummy occupier closes, all three ports are free (no orphans).
  assert.equal(await connectionRefused("127.0.0.1", ownerPort), true, "owner listener must not survive the public bind failure");
  assert.equal(await connectionRefused("127.0.0.1", peerPort), true, "peer listener must not survive the public bind failure");
  assert.equal(existsSync(lockPath), false, "runtime.lock must be released after the failed candidate launch");
  await new Promise<void>((resolve) => dummyPublic.close(() => resolve()));
  assert.equal(await connectionRefused("127.0.0.1", publicPort), true, "public port must be free after rollback (no orphan occupier)");
  console.log("public-mcp: runServer public bind failure rolls back owner+peer listeners and runtime lock");
}

await closeServer(publicListener.server);
await closeServer(ownerListener.server);
await running.close();
console.log("public-mcp: all checks passed");
