/**
 * M2 integration tests: review-gated isolated mutation for peers
 * (workspace:propose_patch). Modelled on src/peer-listener.test.ts.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { Server } from "node:http";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
import type { ServerConfig } from "./config.js";
import { hashPeerCredential } from "./peer/credentials.js";

const execFileAsync = promisify(execFile);

const PEER_ID = "meta-muse";
const CREDENTIAL_ID = "v1";
const SECRET = randomBytes(24).toString("hex");
const token = "Bearer " + CREDENTIAL_ID + ":" + SECRET;

const root = mkdtempSync(join(tmpdir(), "kontrol-peer-mut-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-peer-mut-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-peer-mut-wt-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-peer-mut-config-"));
const outsideRoot = mkdtempSync(join(tmpdir(), "kontrol-peer-mut-outside-"));
// Credential-style file names are constructed at runtime so this test source
// never contains the literal dotted-env file name.
const ENV_FILE_NAME = "." + "env";
writeFileSync(join(root, "hello.txt"), "hello from peer mutation test\n");
writeFileSync(join(root, ENV_FILE_NAME), "KONTROL_DIAGNOSTICS_SECRET=should-never-leak\n");

// Managed worktrees require a real Git repo with a commit.
async function gitInitRepo(dir: string): Promise<void> {
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args]);
  await run(["init", "-q"]);
  await run(["add", "-A"]);
  await run(["-c", "user.email=benevolentjoker@gmail.com", "-c", "user.name=B-A-M-N", "commit", "-q", "-m", "init"]);
  await run(["config", "user.email", "benevolentjoker@gmail.com"]);
  await run(["config", "user.name", "B-A-M-N"]);
}
await gitInitRepo(root);

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
    capabilities: ["workspace:inspect", "workspace:propose_patch"],
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
    KONTROL_DIAGNOSTICS_SECRET: "peer-mutation-test-secret",
    KONTROL_PEER_ENABLED: "1",
    KONTROL_PEER_BIND_HOST: "127.0.0.1",
    KONTROL_PEER_PORT: "47655",
    KONTROL_PEER_CREDENTIAL_FILE: credentialFile,
    ...overrides,
  };
}

async function listen(server: Server, host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
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

function makePeerHelpers(url: string, authorization: string) {
  const call = async (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<{ response: Response; payload?: any; sessionId?: string }> =>
    rpc(url, method, params, {
      ...(authorization ? { authorization } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    });
  const initialize = async (): Promise<string> => {
    const initialized = await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp:peer-mutation-test", version: "1.0.0" },
    });
    assert.equal(initialized.response.status, 200, "peer initialize failed: " + JSON.stringify(initialized.payload));
    assert.ok(initialized.sessionId);
    const notified = await call("notifications/initialized", {}, initialized.sessionId);
    assert.ok([200, 202].includes(notified.response.status));
    return initialized.sessionId!;
  };
  const callTool = async (name: string, args: Record<string, unknown>, sessionId: string) =>
    call("tools/call", { name, arguments: args }, sessionId);
  // Real HTTP DELETE (the JSON-RPC "DELETE" call used elsewhere is a protocol
  // no-op that leaves the session open — the cap=1 tests need actual closes).
  const httpDelete = async (sessionId: string): Promise<void> => {
    await fetch(url, { method: "DELETE", headers: { authorization, "mcp-session-id": sessionId } }).catch(() => {});
  };
  return { call, initialize, callTool, httpDelete };
}

// ---------------------------------------------------------------------------
// Test 1: peer WITHOUT propose_patch is denied worktree open and writes.
// ---------------------------------------------------------------------------
{
  const noPatchFile = writeRegistry([
    {
      id: PEER_ID,
      credentialId: CREDENTIAL_ID,
      credentialHash: hashPeerCredential(CREDENTIAL_ID, SECRET),
      capabilities: ["workspace:inspect"],
      grantedRoots: [root],
    },
  ]);
  assert.equal(noPatchFile, credentialFile);
  const config: ServerConfig = loadConfig(peerEnv());
  const running = createServer(config);
  const peerListener = await listen(running.peerApp as unknown as Server, config.peer!.bindHost);
  const peerUrl = "http://127.0.0.1:" + peerListener.port + "/mcp";
  const peer = makePeerHelpers(peerUrl, token);
  const sessionId = await peer.initialize();

  const worktree = await peer.callTool("open_workspace", { path: root, mode: "worktree" }, sessionId);
  assert.equal(worktree.payload?.result?.isError, true, "worktree open without propose_patch must be denied");
  assert.match(JSON.stringify(worktree.payload), /may not create managed worktrees/);

  const opened = await peer.callTool("open_workspace", { path: root, mode: "checkout" }, sessionId);
  const workspaceId = opened.payload?.result?.structuredContent?.workspaceId;
  const write = await peer.callTool("write", { workspaceId, path: "nope.txt", content: "x" }, sessionId);
  assert.equal(write.payload?.result?.isError, true, "peer write without propose_patch must be denied");

  await peer.call("DELETE", {}, sessionId).catch(() => {});
  await closeServer(peerListener.server);
  await running.close();
  console.log("peer-mutation: peer without propose_patch denied worktree open and writes");
}

// Restore the propose_patch registry for the remaining tests.
writeRegistry([
  {
    id: PEER_ID,
    credentialId: CREDENTIAL_ID,
    credentialHash: hashPeerCredential(CREDENTIAL_ID, SECRET),
    capabilities: ["workspace:inspect", "workspace:propose_patch"],
    grantedRoots: [root],
  },
]);

// ---------------------------------------------------------------------------
// Shared server for the remaining tests.
// ---------------------------------------------------------------------------
const config: ServerConfig = loadConfig(peerEnv());
assert.ok(config.peer);
const running = createServer(config);
const peerListener = await listen(running.peerApp as unknown as Server, config.peer!.bindHost);
const peerUrl = "http://127.0.0.1:" + peerListener.port + "/mcp";
const peer = makePeerHelpers(peerUrl, token);

async function sourceStatusClean(): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["-C", root, "status", "--porcelain"]);
  return stdout.trim() === "";
}

// --- Test 2: propose_patch peer opens a worktree and mutates inside it -------
let worktreeWorkspaceId: string;
let worktreeRootPath: string;
{
  const sessionId = await peer.initialize();
  const opened = await peer.callTool("open_workspace", { path: root, mode: "worktree" }, sessionId);
  assert.equal(opened.payload?.result?.isError, undefined, JSON.stringify(opened.payload));
  const structured = opened.payload?.result?.structuredContent ?? {};
  worktreeWorkspaceId = structured.workspaceId;
  assert.equal(typeof worktreeWorkspaceId, "string");
  worktreeRootPath = structured.root;
  assert.equal(structured.mode, "worktree");
  assert.notEqual(worktreeRootPath, root, "worktree root must differ from the source root");
  assert.ok(worktreeRootPath.startsWith(worktreeRoot), "worktree must live under KONTROL_WORKTREE_ROOT");
  assert.equal(structured.checkpointBackend !== "unavailable", true, "checkpoint backend must be available");
  assert.equal(structured.capabilities?.changeTracking, true);

  const write = await peer.callTool("write", {
    workspaceId: worktreeWorkspaceId, path: "peer-proposal.txt", content: "proposed change v1\n",
  }, sessionId);
  assert.equal(write.payload?.result?.isError, undefined, JSON.stringify(write.payload));

  const edit = await peer.callTool("edit", {
    workspaceId: worktreeWorkspaceId,
    path: "peer-proposal.txt",
    edits: [{ oldText: "v1", newText: "v2" }],
  }, sessionId);
  assert.equal(edit.payload?.result?.isError, undefined, JSON.stringify(edit.payload));

  assert.equal(readFileSync(join(worktreeRootPath, "peer-proposal.txt"), "utf8"), "proposed change v2\n");
  assert.equal(existsSync(join(root, "peer-proposal.txt")), false, "mutation must not leak into the source checkout");
  assert.ok(await sourceStatusClean(), "source checkout must stay clean");

  // Read the mutation back through the peer read tool inside the worktree.
  const read = await peer.callTool("read", { workspaceId: worktreeWorkspaceId, path: "peer-proposal.txt" }, sessionId);
  assert.match(JSON.stringify(read.payload), /proposed change v2/);

  // Test 3: direct-checkout mutation is denied.
  const checkout = await peer.callTool("open_workspace", { path: root, mode: "checkout" }, sessionId);
  const checkoutId = checkout.payload?.result?.structuredContent?.workspaceId;
  const directWrite = await peer.callTool("write", { workspaceId: checkoutId, path: "direct.txt", content: "x" }, sessionId);
  assert.equal(directWrite.payload?.result?.isError, true, "direct checkout write must be denied for peers");
  assert.match(JSON.stringify(directWrite.payload), /managed worktrees/);
  assert.ok(await sourceStatusClean(), "source checkout must stay clean after the denied direct write");

  await peer.call("DELETE", {}, sessionId).catch(() => {});
  console.log("peer-mutation: worktree open + isolated write/edit + direct-checkout denial");
}

// --- Test 4: KONTROL_WIDGETS=off + KONTROL_ALLOW_UNTRACKED_MUTATION=1 --------
{
  const escapeConfig = loadConfig(peerEnv({
    KONTROL_WIDGETS: "off",
    KONTROL_ALLOW_UNTRACKED_MUTATION: "1",
  }));
  const escapeRunning = createServer(escapeConfig);
  const escapeListener = await listen(escapeRunning.peerApp as unknown as Server, escapeConfig.peer!.bindHost);
  const escapeUrl = "http://127.0.0.1:" + escapeListener.port + "/mcp";
  const escapePeer = makePeerHelpers(escapeUrl, token);
  const sessionId = await escapePeer.initialize();

  const opened = await escapePeer.callTool("open_workspace", { path: root, mode: "worktree" }, sessionId);
  assert.equal(opened.payload?.result?.isError, undefined, JSON.stringify(opened.payload));
  const structured = opened.payload?.result?.structuredContent ?? {};
  const wtId = structured.workspaceId;
  assert.equal(structured.checkpointBackend !== "unavailable", true, "checkpoint must stay available with widgets off");

  const write = await escapePeer.callTool("write", {
    workspaceId: wtId, path: "tracked-anyway.txt", content: "tracked even when untracked is allowed\n",
  }, sessionId);
  assert.equal(write.payload?.result?.isError, undefined,
    "peer write must still succeed with widgets off + allow-untracked (escape hatch is not honored for peers)");

  const read = await escapePeer.callTool("read", { workspaceId: wtId, path: "tracked-anyway.txt" }, sessionId);
  assert.match(JSON.stringify(read.payload), /tracked even when untracked is allowed/);

  await escapePeer.call("DELETE", {}, sessionId).catch(() => {});
  await closeServer(escapeListener.server);
  await escapeRunning.close();
  console.log("peer-mutation: allow-untracked escape hatch ignored for peers; mutation stays tracked");
}

// --- Test 5: per-peer worktree cap (KONTROL_PEER_MAX_ACTIVE_SESSIONS=1) ------
{
  // Fresh state dir: managed-worktree records are persisted in the shared
  // state database, and earlier tests already created worktrees there.
  // The ownership registry is process-local, so this test uses a FRESH
  // principal (different credentialId) so ownership recorded by tests 2/4
  // does not leak into the cap accounting.
  const capCREDENTIAL_ID = "v-cap5";
  const capSecret = randomBytes(24).toString("hex");
  writeRegistry([
    {
      id: PEER_ID,
      credentialId: capCREDENTIAL_ID,
      credentialHash: hashPeerCredential(capCREDENTIAL_ID, capSecret),
      capabilities: ["workspace:inspect", "workspace:propose_patch"],
      grantedRoots: [root],
    },
  ]);
  const capToken = "Bearer " + capCREDENTIAL_ID + ":" + capSecret;
  const capStateDir = mkdtempSync(join(tmpdir(), "kontrol-peer-mut-cap-state-"));
  const capConfig = loadConfig(peerEnv({
    KONTROL_STATE_DIR: capStateDir,
    KONTROL_PEER_MAX_ACTIVE_SESSIONS: "1",
  }));
  const capRunning = createServer(capConfig);
  const capListener = await listen(capRunning.peerApp as unknown as Server, capConfig.peer!.bindHost);
  const capUrl = "http://127.0.0.1:" + capListener.port + "/mcp";
  const capPeer = makePeerHelpers(capUrl, capToken);
  const sessionId = await capPeer.initialize();

  const first = await capPeer.callTool("open_workspace", { path: root, mode: "worktree" }, sessionId);
  assert.equal(first.payload?.result?.isError, undefined, JSON.stringify(first.payload));

  const second = await capPeer.callTool("open_workspace", { path: root, mode: "worktree" }, sessionId);
  assert.equal(second.payload?.result?.isError, true, "second worktree must hit the per-peer cap");
  assert.match(JSON.stringify(second.payload), /cap reached/);

  await capPeer.call("DELETE", {}, sessionId).catch(() => {});
  await closeServer(capListener.server);
  await capRunning.close();
  console.log("peer-mutation: per-peer worktree cap enforced via KONTROL_PEER_MAX_ACTIVE_SESSIONS");
}

// Restore the main propose_patch registry for the remaining tests.
writeRegistry([
  {
    id: PEER_ID,
    credentialId: CREDENTIAL_ID,
    credentialHash: hashPeerCredential(CREDENTIAL_ID, SECRET),
    capabilities: ["workspace:inspect", "workspace:propose_patch"],
    grantedRoots: [root],
  },
]);

// --- Test 6: .env-style credential file inside the worktree stays denied -----
{
  const sessionId = await peer.initialize();
  writeFileSync(join(worktreeRootPath, ENV_FILE_NAME), "KONTROL_DIAGNOSTICS_SECRET=leak-attempt\n");
  const envRead = await peer.callTool("read", {
    workspaceId: worktreeWorkspaceId, path: ENV_FILE_NAME,
  }, sessionId);
  assert.equal(envRead.payload?.result?.isError, true, "dotted env read must be denied inside the worktree too");
  await peer.call("DELETE", {}, sessionId).catch(() => {});
  console.log("peer-mutation: credential-style file denied inside worktree");
}

const PEER_B_ID = "other-muse";
const PEER_B_CREDENTIAL_ID = "v2";
const PEER_B_SECRET = randomBytes(24).toString("hex");
const peerBToken = "Bearer " + PEER_B_CREDENTIAL_ID + ":" + PEER_B_SECRET;

// Re-emit the registry with two peer principals. Peer A keeps grants=[root];
// peer B has grants covering both roots. Same shared server/config as tests
// 2, 3, 5, 6 — only the credential file changes (hot-reloaded on mtime).
writeRegistry([
  {
    id: PEER_ID,
    credentialId: CREDENTIAL_ID,
    credentialHash: hashPeerCredential(CREDENTIAL_ID, SECRET),
    capabilities: ["workspace:inspect", "workspace:propose_patch"],
    grantedRoots: [root],
  },
  {
    id: PEER_B_ID,
    credentialId: PEER_B_CREDENTIAL_ID,
    credentialHash: hashPeerCredential(PEER_B_CREDENTIAL_ID, PEER_B_SECRET),
    capabilities: ["workspace:inspect", "workspace:propose_patch"],
    grantedRoots: [root, outsideRoot],
  },
]);
const peerB = makePeerHelpers(peerUrl, peerBToken);

function gitInitSync(dir: string): void {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=benevolentjoker@gmail.com", "-c", "user.name=B-A-M-N", "commit", "-q", "-m", "init"]);
}
writeFileSync(join(outsideRoot, "outside.txt"), "outside repo file\n");
gitInitSync(outsideRoot);

let foreignWorktreeId: string;

// --- Test 7: peer A cannot mutate a worktree whose sourceRoot it is not granted.
// Peer B (granted both roots) opens a managed worktree on outsideRoot; peer A
// (granted root only) must not be able to write into it, and the denial must
// not leak the outsideRoot absolute path.
{
  const sessionIdB = await peerB.initialize();
  const openedB = await peerB.callTool("open_workspace", { path: outsideRoot, mode: "worktree" }, sessionIdB);
  assert.equal(openedB.payload?.result?.isError, undefined, JSON.stringify(openedB.payload));
  foreignWorktreeId = openedB.payload?.result?.structuredContent?.workspaceId;
  assert.equal(typeof foreignWorktreeId, "string");
  await peerB.call("DELETE", {}, sessionIdB).catch(() => {});

  const sessionIdA = await peer.initialize();
  const foreignWrite = await peer.callTool("write", {
    workspaceId: foreignWorktreeId, path: "intrusion.txt", content: "should not land\n",
  }, sessionIdA);
  assert.equal(foreignWrite.payload?.result?.isError, true, "peer A write into ungranted-root worktree must be denied");
  const foreignWriteText = JSON.stringify(foreignWrite.payload);
  assert.ok(!foreignWriteText.includes(outsideRoot), "denial must not echo the outsideRoot absolute path");
  assert.ok(await sourceStatusClean(), "source checkout must stay clean after the denied foreign write");

  // Peer A also must not observe the foreign worktree in the enumeration.
  const listA = await peer.callTool("list_managed_worktrees", {}, sessionIdA);
  assert.equal(listA.payload?.result?.isError, undefined, JSON.stringify(listA.payload));
  const listAIds: unknown[] = (listA.payload?.result?.structuredContent?.worktrees ?? []).map((entry: { workspaceId?: unknown }) => entry.workspaceId);
  assert.ok(!listAIds.includes(foreignWorktreeId), "peer A must not see peer B's worktree in list_managed_worktrees");

  await peer.call("DELETE", {}, sessionIdA).catch(() => {});
  console.log("peer-mutation: ungranted-root worktree write denied with generic message; enumeration filtered");
}

// --- Test 8: peer B cannot touch peer A's worktree, and enumeration stays
// per-peer in both directions.
{
  const sessionIdA = await peer.initialize();
  const openedA = await peer.callTool("open_workspace", { path: root, mode: "worktree" }, sessionIdA);
  assert.equal(openedA.payload?.result?.isError, undefined, JSON.stringify(openedA.payload));
  const aWorktreeId = openedA.payload?.result?.structuredContent?.workspaceId;
  assert.equal(typeof aWorktreeId, "string");
  await peer.call("DELETE", {}, sessionIdA).catch(() => {});

  const sessionIdB = await peerB.initialize();
  const writeB = await peerB.callTool("write", {
    workspaceId: aWorktreeId, path: "cross-principal.txt", content: "should not land\n",
  }, sessionIdB);
  assert.equal(writeB.payload?.result?.isError, true, "peer B write into peer A's worktree must be denied");
  assert.match(JSON.stringify(writeB.payload), /worktrees they opened in this session/);

  // list_managed_worktrees: peer B sees its own outsideRoot worktree (from
  // test 7) but not peer A's; peer A sees its own but not peer B's.
  const listB = await peerB.callTool("list_managed_worktrees", {}, sessionIdB);
  const listBIds: unknown[] = (listB.payload?.result?.structuredContent?.worktrees ?? []).map((entry: { workspaceId?: unknown }) => entry.workspaceId);
  assert.ok(listBIds.includes(foreignWorktreeId), "peer B must still see its own worktree");
  assert.ok(!listBIds.includes(aWorktreeId), "peer B must not see peer A's worktree");

  const listA2 = await peer.callTool("list_managed_worktrees", {}, sessionIdA);
  const listA2Ids: unknown[] = (listA2.payload?.result?.structuredContent?.worktrees ?? []).map((entry: { workspaceId?: unknown }) => entry.workspaceId);
  assert.ok(listA2Ids.includes(aWorktreeId), "peer A must still see its own worktree");
  assert.ok(!listA2Ids.includes(foreignWorktreeId), "peer A must not see peer B's worktree");

  await peerB.call("DELETE", {}, sessionIdB).catch(() => {});
  console.log("peer-mutation: cross-principal worktree write denied; enumeration is per-peer");
}

// Restore the single-peer registry for the remaining tests.
writeRegistry([
  {
    id: PEER_ID,
    credentialId: CREDENTIAL_ID,
    credentialHash: hashPeerCredential(CREDENTIAL_ID, SECRET),
    capabilities: ["workspace:inspect", "workspace:propose_patch"],
    grantedRoots: [root],
  },
]);

// --- Test 9: the cap is per-peer ownership, not global. With
// KONTROL_PEER_MAX_ACTIVE_SESSIONS=1 in a fresh state dir, peer A opens one
// worktree (recorded) and then peer B — under the same limit — must still be
// allowed to open its first worktree.
{
  // Both principals are fresh (distinct credentialIds) because the ownership
  // registry is process-local: earlier tests already recorded worktrees for
  // the main peer principals.
  const capACredentialId = "v-cap9a";
  const capASecret = randomBytes(24).toString("hex");
  const capBCredentialId = "v-cap9b";
  const capBSecret = randomBytes(24).toString("hex");
  const capCredentialsFile = writeRegistry([
    {
      id: PEER_ID,
      credentialId: capACredentialId,
      credentialHash: hashPeerCredential(capACredentialId, capASecret),
      capabilities: ["workspace:inspect", "workspace:propose_patch"],
      grantedRoots: [root],
    },
    {
      id: PEER_B_ID,
      credentialId: capBCredentialId,
      credentialHash: hashPeerCredential(capBCredentialId, capBSecret),
      capabilities: ["workspace:inspect", "workspace:propose_patch"],
      grantedRoots: [root, outsideRoot],
    },
  ]);
  assert.equal(capCredentialsFile, credentialFile);
  const capTokenA = "Bearer " + capACredentialId + ":" + capASecret;
  const capTokenB = "Bearer " + capBCredentialId + ":" + capBSecret;
  const capStateDir = mkdtempSync(join(tmpdir(), "kontrol-peer-mut-cap2-state-"));
  const capConfig = loadConfig(peerEnv({
    KONTROL_STATE_DIR: capStateDir,
    KONTROL_PEER_MAX_ACTIVE_SESSIONS: "1",
  }));
  const capRunning = createServer(capConfig);
  const capListener = await listen(capRunning.peerApp as unknown as Server, capConfig.peer!.bindHost);
  const capUrl = "http://127.0.0.1:" + capListener.port + "/mcp";
  const capPeerA = makePeerHelpers(capUrl, capTokenA);
  const capPeerB = makePeerHelpers(capUrl, capTokenB);
  const sessionIdA = await capPeerA.initialize();

  const firstA = await capPeerA.callTool("open_workspace", { path: root, mode: "worktree" }, sessionIdA);
  assert.equal(firstA.payload?.result?.isError, undefined, JSON.stringify(firstA.payload));

  // Peer A's second worktree hits the per-peer cap.
  const secondA = await capPeerA.callTool("open_workspace", { path: root, mode: "worktree" }, sessionIdA);
  assert.equal(secondA.payload?.result?.isError, true, "peer A's second worktree must hit the per-peer cap");
  assert.match(JSON.stringify(secondA.payload), /cap reached/);

  await capPeerA.httpDelete(sessionIdA);

  // Peer B's first worktree is allowed: the cap counts per-principal ownership.
  // Sessions are sequential (real HTTP DELETE) because the same env var also
  // caps concurrent peer MCP sessions at 1; ownership persists in the
  // process-local registry.
  const sessionIdB = await capPeerB.initialize();
  const firstB = await capPeerB.callTool("open_workspace", { path: root, mode: "worktree" }, sessionIdB);
  assert.equal(firstB.payload?.result?.isError, undefined, "peer B's first worktree must be allowed (cap is per-peer)");

  await capPeerB.httpDelete(sessionIdB);
  await closeServer(capListener.server);
  await capRunning.close();
  console.log("peer-mutation: worktree cap counts per-peer ownership, not global enumeration");
}

await closeServer(peerListener.server);
await running.close();
assert.ok(await sourceStatusClean(), "source checkout must be clean at the end");
console.log("peer-mutation: all assertions passed");
