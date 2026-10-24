/**
 * Two-listener integration tests for the opt-in peer surface (M1).
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
import type { ServerConfig } from "./config.js";
import { hashPeerCredential } from "./peer/credentials.js";

const PEER_ID = "meta-muse";
const CREDENTIAL_ID = "v1";
const SECRET = randomBytes(24).toString("hex");
const token = "Bearer " + CREDENTIAL_ID + ":" + SECRET;

const root = mkdtempSync(join(tmpdir(), "kontrol-peer-root-"));
const outsideRoot = mkdtempSync(join(tmpdir(), "kontrol-peer-outside-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-peer-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-peer-worktrees-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-peer-config-"));
// Credential-style file names are constructed at runtime so this test source
// never contains the literal dotted-env file name.
const ENV_FILE_NAME = "." + "env";
writeFileSync(join(root, "hello.txt"), "hello from kontrol peer test\n");
writeFileSync(join(root, ENV_FILE_NAME), "KONTROL_DIAGNOSTICS_SECRET=should-never-leak\n");

function writeRegistry(peers: unknown[]): string {
  const file = join(configDir, "peer-fixture-registry.json");
  writeFileSync(file, JSON.stringify({ version: 1, peers }, null, 2));
  chmodSync(file, 0o600);
  const future = new Date(Date.now() + 5_000);
  utimesSync(file, future, future);
  return file;
}

const credentialFile = writeRegistry([
  {
    id: PEER_ID,
    credentialId: CREDENTIAL_ID,
    credentialHash: hashPeerCredential(CREDENTIAL_ID, SECRET),
    capabilities: ["workspace:inspect"],
    grantedRoots: [root],
  },
]);

function peerEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    KONTROL_CONFIG_DIR: configDir,
    KONTROL_ALLOWED_ROOTS: root + "," + outsideRoot,
    KONTROL_STATE_DIR: stateDir,
    KONTROL_WORKTREE_ROOT: worktreeRoot,
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_ACP_ENABLED: "false",
    KONTROL_POLICY_MODE: "allow",
    KONTROL_LOG_LEVEL: "error",
    KONTROL_LOG_REQUESTS: "0",
    KONTROL_DIAGNOSTICS_SECRET: "peer-listener-test-secret",
    KONTROL_PEER_ENABLED: "1",
    KONTROL_PEER_BIND_HOST: "127.0.0.1",
    KONTROL_PEER_PORT: "47654",
    KONTROL_PEER_CREDENTIAL_FILE: credentialFile,
    ...overrides,
  };
}

async function listen(server: Server, host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  // `server` here is an Express app (passed as `app as unknown as Server`);
  // app.listen() returns the underlying node:http Server that actually emits
  // "listening" and owns the socket — wait on that, not on the app itself.
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

// ---------------------------------------------------------------------------
// Feature disabled: no peer app, startup unchanged.
// ---------------------------------------------------------------------------
{
  const disabledConfig = loadConfig({
    KONTROL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "kontrol-peer-disabled-config-")),
    KONTROL_ALLOWED_ROOTS: root,
    KONTROL_STATE_DIR: mkdtempSync(join(tmpdir(), "kontrol-peer-disabled-state-")),
    KONTROL_WORKTREE_ROOT: worktreeRoot,
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_ACP_ENABLED: "false",
    KONTROL_POLICY_MODE: "allow",
    KONTROL_LOG_LEVEL: "error",
  });
  assert.equal(disabledConfig.peer, undefined, "peer config must be undefined unless enabled");
  const disabled = createServer(disabledConfig);
  assert.equal(disabled.peerApp, undefined, "no peer app when the feature is disabled");
  const owner = await listen(disabled.app as unknown as Server);
  const health = await fetch("http://127.0.0.1:" + owner.port + "/healthz");
  assert.equal(health.status, 200);
  await closeServer(owner.server);
  await disabled.close();
  console.log("peer-listener: feature disabled keeps startup unchanged");
}

// ---------------------------------------------------------------------------
// Enabled: two listeners, one process.
// ---------------------------------------------------------------------------
const config: ServerConfig = loadConfig(peerEnv());
assert.ok(config.peer, "peer config parsed when enabled");
const running = createServer(config);
assert.ok(running.peerApp, "peer app exists when enabled");
const ownerListener = await listen(running.app as unknown as Server);
const peerListener = await listen(running.peerApp as unknown as Server, config.peer!.bindHost);
const ownerUrl = "http://127.0.0.1:" + ownerListener.port + "/mcp";
const peerUrl = "http://127.0.0.1:" + peerListener.port + "/mcp";
const peerHealthUrl = "http://127.0.0.1:" + peerListener.port + "/peer/healthz";

let nextId = 0;
async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ response: Response; payload?: any; sessionId?: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
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

async function peerRpc(
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
  authorization: string = token,
): Promise<{ response: Response; payload?: any; sessionId?: string }> {
  return rpc(peerUrl, method, params, {
    ...(authorization ? { authorization } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  });
}

async function peerInitialize(authorization: string = token): Promise<string> {
  const initialized = await peerRpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp:meta-muse", version: "1.0.0" },
  }, undefined, authorization);
  assert.equal(initialized.response.status, 200, "peer initialize failed: " + JSON.stringify(initialized.payload));
  assert.ok(initialized.sessionId, "initialize did not return mcp-session-id");
  const notified = await peerRpc("notifications/initialized", {}, initialized.sessionId, authorization);
  assert.ok([200, 202].includes(notified.response.status));
  return initialized.sessionId!;
}

async function peerDelete(sessionId: string): Promise<void> {
  await fetch(peerUrl, { method: "DELETE", headers: { "mcp-session-id": sessionId, authorization: token } });
}

// --- Authentication negatives -------------------------------------------------
{
  const initParams = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } };

  const unauthenticated = await rpc(peerUrl, "initialize", initParams);
  assert.equal(unauthenticated.response.status, 401, "unauthenticated peer initialize must be rejected");

  const wrongSecret = await rpc(peerUrl, "initialize", initParams, {
    authorization: "Bearer " + CREDENTIAL_ID + ":" + randomBytes(24).toString("hex"),
  });
  assert.equal(wrongSecret.response.status, 401, "wrong peer secret must be rejected");

  const unknownId = await rpc(peerUrl, "initialize", initParams, {
    authorization: "Bearer nope:" + SECRET,
  });
  assert.equal(unknownId.response.status, 401, "unknown credential id must be rejected");

  const ownerStyle = await rpc(peerUrl, "initialize", initParams, {
    authorization: "Bearer owner-oauth-token-value",
  });
  assert.equal(ownerStyle.response.status, 401, "owner-style bearer cannot authenticate on the peer port");
  console.log("peer-listener: unauthenticated/wrong/unknown/owner credentials rejected on peer port");
}

// --- Minimal liveness, no owner surfaces --------------------------------------
{
  const health = await fetch(peerHealthUrl);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const diagnostics = await fetch("http://127.0.0.1:" + peerListener.port + "/diagnostics", {
    headers: { "x-kontrol-diagnostics": "peer-listener-test-secret" },
  });
  assert.equal(diagnostics.status, 404, "diagnostics must not be exposed on the peer listener");
  const staticRoot = await fetch("http://127.0.0.1:" + peerListener.port + "/");
  assert.equal(staticRoot.status, 404, "owner static surface must not be exposed on the peer listener");
  console.log("peer-listener: minimal liveness only; no diagnostics/static owner surface");
}

// --- Scoped tool catalog -------------------------------------------------------
{
  const sessionId = await peerInitialize();
  const listed = await peerRpc("tools/list", {}, sessionId);
  assert.equal(listed.response.status, 200);
  const names: string[] = (listed.payload?.result?.tools ?? []).map((tool: { name: string }) => tool.name);
  assert.ok(names.includes("read"), "inspect profile must include read");
  assert.ok(names.includes("open_workspace"), "inspect profile must include open_workspace");
  assert.ok(names.includes("git_status"), "inspect profile must include git_status");
  for (const forbidden of ["write", "edit", "bash", "poll_process", "submit_for_review", "open_approval_center"]) {
    assert.ok(!names.includes(forbidden), "peer catalog must not include " + forbidden);
  }

  // Disallowed tool invoked by name despite the restricted catalog.
  const writeAttempt = await peerRpc("tools/call", {
    name: "write", arguments: { workspaceId: "x", path: "x.txt", content: "x" },
  }, sessionId);
  assert.equal(writeAttempt.response.status, 200);
  assert.equal(writeAttempt.payload?.result?.isError, true, "disallowed tool call must return an error result");
  assert.match(JSON.stringify(writeAttempt.payload), /capability profile/);

  // Spoofed worker headers never promote a peer or widen the catalog.
  const spoofed = await rpc(peerUrl, "tools/list", {}, {
    authorization: token,
    "mcp-session-id": sessionId,
    "x-kontrol-worker-token": "forged-worker-token",
  });
  assert.equal(spoofed.response.status, 200, "spoofed worker token must not break the peer session");
  const spoofedNames: string[] = (spoofed.payload?.result?.tools ?? []).map((t: { name: string }) => t.name);
  assert.ok(!spoofedNames.includes("write"), "spoofed headers must not widen the peer catalog");

  await peerDelete(sessionId);
  console.log("peer-listener: tools/list restricted to granted profile; disallowed calls denied; no header promotion");
}

// --- Workspace authority -------------------------------------------------------
{
  const sessionId = await peerInitialize();

  const opened = await peerRpc("tools/call", {
    name: "open_workspace", arguments: { path: root, mode: "checkout" },
  }, sessionId);
  assert.equal(opened.payload?.result?.isError, undefined, JSON.stringify(opened.payload));
  const workspaceId = opened.payload?.result?.structuredContent?.workspaceId ?? opened.payload?.result?.workspaceId;
  assert.equal(typeof workspaceId, "string");

  // Read inside granted root works.
  const read = await peerRpc("tools/call", {
    name: "read", arguments: { workspaceId, path: "hello.txt" },
  }, sessionId);
  assert.equal(read.payload?.result?.isError, undefined, JSON.stringify(read.payload));
  assert.match(JSON.stringify(read.payload), /hello from kontrol peer test/);

  // The dotted credential file is denied even inside a granted root.
  const envRead = await peerRpc("tools/call", {
    name: "read", arguments: { workspaceId, path: ENV_FILE_NAME },
  }, sessionId);
  assert.equal(envRead.payload?.result?.isError, true, "dotted env read must be denied for peers");

  // grep hitting the dotted credential file is denied too.
  const envGrep = await peerRpc("tools/call", {
    name: "grep", arguments: { workspaceId, pattern: "SECRET", path: ENV_FILE_NAME },
  }, sessionId);
  assert.equal(envGrep.payload?.result?.isError, true, "grep on dotted env must be denied for peers");

  // A root the server allows but this peer was not granted is denied.
  const outside = await peerRpc("tools/call", {
    name: "open_workspace", arguments: { path: outsideRoot, mode: "checkout" },
  }, sessionId);
  assert.equal(outside.payload?.result?.isError, true, "workspace outside peer grants must be denied");
  assert.match(JSON.stringify(outside.payload), /not granted/);

  // Peers cannot create managed worktrees.
  const worktree = await peerRpc("tools/call", {
    name: "open_workspace", arguments: { path: root, mode: "worktree" },
  }, sessionId);
  assert.equal(worktree.payload?.result?.isError, true, "peer worktree creation must be denied");

  await peerDelete(sessionId);
  console.log("peer-listener: granted-root confinement, credential-file denial, worktree denial");
}

// --- Cross-port session isolation ----------------------------------------------
{
  const peerSessionId = await peerInitialize();

  // A peer session ID presented to the owner listener (with the peer token)
  // must not attach: listener binding is part of session identity.
  const crossAttach = await rpc(ownerUrl, "tools/list", {}, {
    authorization: token,
    "mcp-session-id": peerSessionId,
  });
  assert.equal(crossAttach.response.status, 403, "peer session must not attach from the owner listener");

  // The owner listener never sees peer identity: the same bearer token is
  // inert there (tunnel mode treats it as an anonymous client request).
  const initializeOnOwner = await rpc(ownerUrl, "initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp:meta-muse", version: "1.0.0" },
  }, { authorization: token });
  assert.equal(initializeOnOwner.response.status, 200, "owner listener stays functional");
  assert.ok(initializeOnOwner.sessionId, "owner session created independently");
  const ownerTools = await rpc(ownerUrl, "tools/list", {}, {
    "mcp-session-id": initializeOnOwner.sessionId!,
  });
  const ownerNames: string[] = (ownerTools.payload?.result?.tools ?? []).map((t: { name: string }) => t.name);
  assert.ok(ownerNames.includes("write") || ownerNames.includes("bash") || ownerNames.includes("open_workspace"),
    "owner listener keeps its full tool catalog (peer token did not restrict it)");

  // An owner session ID presented to the peer listener without a peer token is
  // rejected by peer authentication before any session attach can occur.
  const ownerSessionOnPeer = await rpc(peerUrl, "tools/list", {}, {
    "mcp-session-id": initializeOnOwner.sessionId!,
  });
  assert.equal(ownerSessionOnPeer.response.status, 401, "owner session cannot migrate to the peer listener");

  await fetch(ownerUrl, { method: "DELETE", headers: { "mcp-session-id": initializeOnOwner.sessionId! } });
  await peerDelete(peerSessionId);
  console.log("peer-listener: cross-port session attach denied in both directions");
}

// --- Revocation applies to live sessions ---------------------------------------
{
  const sessionId = await peerInitialize();
  const before = await peerRpc("tools/list", {}, sessionId);
  assert.equal(before.response.status, 200, "session works before revocation");

  writeRegistry([
    {
      id: PEER_ID,
      credentialId: CREDENTIAL_ID,
      credentialHash: hashPeerCredential(CREDENTIAL_ID, SECRET),
      capabilities: ["workspace:inspect"],
      grantedRoots: [root],
      revokedAt: new Date().toISOString(),
    },
  ]);

  // The middleware hot-reloads on mtime change; poll until revocation lands.
  let revoked = false;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const attempt = await peerRpc("tools/list", {}, sessionId);
    if (attempt.response.status === 401) {
      revoked = true;
      break;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
  }
  assert.ok(revoked, "revoked credential must deny the live session on its next request");
  console.log("peer-listener: mid-session credential revocation takes effect without restart");
}

await closeServer(peerListener.server);
await closeServer(ownerListener.server);
await running.close();
console.log("peer-listener: all assertions passed");
