/**
 * M3 owner-side enqueue E2E: the owner MCP listener can enqueue_peer_job for
 * a registry-granted peer; the peer's MCP catalog NEVER contains the tool
 * (and calling it by name is denied); the peer receives the instructions
 * verbatim over the HTTP job protocol and returns a validated result.
 * Harness pattern: src/peer-listener.test.ts.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
import type { ServerConfig } from "./config.js";
import { hashPeerCredential } from "./peer/credentials.js";
import { manifestSha256 } from "./peer/jobs/service.js";

const PEER_ID = "meta-muse";
const CREDENTIAL_ID = "v1";
const SECRET = randomBytes(24).toString("hex");
const token = "Bearer " + CREDENTIAL_ID + ":" + SECRET;
const INSTRUCTIONS = "say the nonce potato";
const expectedInstructionHash = createHash("sha256").update(INSTRUCTIONS, "utf8").digest("hex");

const root = mkdtempSync(join(tmpdir(), "kontrol-enqueue-root-"));
const outsideRoot = mkdtempSync(join(tmpdir(), "kontrol-enqueue-outside-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-enqueue-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-enqueue-worktrees-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-enqueue-config-"));

writeFileSync(join(root, "hello.txt"), "hello from enqueue e2e\n");

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
    capabilities: ["workspace:inspect", "job:claim", "job:complete"],
    grantedRoots: [root],
  },
]);

const config: ServerConfig = loadConfig({
  KONTROL_CONFIG_DIR: configDir,
  KONTROL_ALLOWED_ROOTS: root + "," + outsideRoot,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_POLICY_MODE: "allow",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_LOG_LEVEL_FALLBACK: "error",
  KONTROL_PEER_ENABLED: "1",
  KONTROL_PEER_BIND_HOST: "127.0.0.1",
  KONTROL_PEER_PORT: "47661",
  KONTROL_PEER_CREDENTIAL_FILE: credentialFile,
  KONTROL_PEER_MAX_CLAIMED_JOBS: "1",
});
assert.ok(config.peer, "peer config parsed when enabled");

const running = createServer(config);
assert.ok(running.peerApp, "peer app exists when enabled");

async function listen(server: Server, host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  const httpServer = server.listen(0, host);
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  return { server: httpServer as unknown as Server, port: address.port };
}

// Like peer-listener.test.ts, listen the peerApp on an EPHEMERAL port via
// listen() — the config peer port is only used by runServer(); createServer
// never binds it, so awaiting config.peer.port would connect to nothing.
const peerListener = await listen(running.peerApp as unknown as Server, config.peer!.bindHost);
const peerBase = "http://127.0.0.1:" + peerListener.port;

const ownerListener = await listen(running.app as unknown as Server);
const ownerUrl = "http://127.0.0.1:" + ownerListener.port + "/mcp";

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

async function initialize(url: string, name: string, headers: Record<string, string> = {}): Promise<string> {
  const initialized = await rpc(url, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name, version: "1.0.0" },
  }, headers);
  assert.equal(initialized.response.status, 200, "initialize failed: " + JSON.stringify(initialized.payload));
  assert.ok(initialized.sessionId);
  const notified = await rpc(url, "notifications/initialized", {}, {
    ...headers,
    "mcp-session-id": initialized.sessionId!,
  });
  assert.ok([200, 202].includes(notified.response.status));
  return initialized.sessionId!;
}

async function deleteSession(url: string, sessionId: string, headers: Record<string, string> = {}): Promise<void> {
  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": sessionId, ...headers } });
}

// --- Sessions ------------------------------------------------------------------
const ownerSession = await initialize(ownerUrl, "kontrol-enqueue-owner");

const peerHeaders = { authorization: token };
const peerMcpUrl = peerBase + "/mcp";
const peerSession = await initialize(peerMcpUrl, "mcp:meta-muse", peerHeaders);

// --- Catalog isolation: peers never see enqueue_peer_job; owners do -------------
{
  const listed = await rpc(ownerUrl, "tools/list", {}, { "mcp-session-id": ownerSession });
  assert.equal(listed.response.status, 200);
  const ownerNames: string[] = (listed.payload?.result?.tools ?? []).map((tool: { name: string }) => tool.name);
  assert.ok(ownerNames.includes("enqueue_peer_job"), "owner catalog includes enqueue_peer_job");

  const peerListed = await rpc(peerMcpUrl, "tools/list", {}, { ...peerHeaders, "mcp-session-id": peerSession });
  assert.equal(peerListed.response.status, 200);
  const peerNames: string[] = (peerListed.payload?.result?.tools ?? []).map((tool: { name: string }) => tool.name);
  assert.ok(!peerNames.includes("enqueue_peer_job"), "peer catalog must NOT include enqueue_peer_job");
  console.log("enqueue-e2e: enqueue_peer_job owner-only in catalogs");
}

// --- Peer-role MCP call of enqueue_peer_job -> denial despite hidden catalog ----
{
  const attempt = await rpc(peerMcpUrl, "tools/call", {
    name: "enqueue_peer_job",
    arguments: { peerId: PEER_ID, repositoryId: root, baseRevision: "a".repeat(40), taskClass: "read_only_audit", instructions: "x", allowedOutputs: ["*"] },
  }, { ...peerHeaders, "mcp-session-id": peerSession });
  assert.equal(attempt.response.status, 200);
  assert.equal(attempt.payload?.result?.isError, true, "peer-role enqueue call must be denied");
  assert.match(JSON.stringify(attempt.payload), /[Ff]orbidden/);
  console.log("enqueue-e2e: peer-role enqueue_peer_job call denied (belt-and-braces)");
}

// --- Owner enqueue happy path ----------------------------------------------------
const enqueueArgs = {
  peerId: PEER_ID,
  repositoryId: root,
  baseRevision: "0123456789abcdef0123456789abcdef01234567",
  taskClass: "read_only_audit",
  instructions: INSTRUCTIONS,
  allowedOutputs: ["out/"],
};
let jobId: string;
{
  const response = await rpc(ownerUrl, "tools/call", { name: "enqueue_peer_job", arguments: enqueueArgs }, { "mcp-session-id": ownerSession });
  assert.equal(response.payload?.result?.isError, undefined, JSON.stringify(response.payload));
  const text = response.payload?.result?.content?.[0]?.text ?? "";
  const created = JSON.parse(text) as { jobId: string; status: string; maxRuntimeMs: number; maxArtifactBytes: number };
  assert.match(created.jobId, /^job_/);
  assert.equal(created.status, "pending");
  assert.equal(created.maxRuntimeMs, 600_000, "default maxRuntimeMs");
  assert.equal(created.maxArtifactBytes, 1_048_576, "default maxArtifactBytes");
  jobId = created.jobId;
  console.log("enqueue-e2e: owner enqueued job " + jobId + " with defaults");
}

// --- Peer HTTP: commands poll shows the job with matching instructionHash --------
{
  const commands = await fetch(peerBase + "/peer/commands", { headers: { authorization: token } });
  assert.equal(commands.status, 200);
  const payload = await commands.json() as { pendingJobs: number; commands: Array<{ jobId: string; instructionHash: string }> };
  assert.equal(payload.pendingJobs, 1);
  assert.equal(payload.commands[0].jobId, jobId);
  assert.equal(payload.commands[0].instructionHash, expectedInstructionHash);
  console.log("enqueue-e2e: /peer/commands shows the enqueued job with matching instructionHash");
}

// --- Peer HTTP: claim returns the verbatim instructions ---------------------------
let attemptId: string;
let claimToken: string;
{
  const claim = await fetch(peerBase + "/peer/jobs/claim", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: token },
    body: JSON.stringify({}),
  });
  assert.equal(claim.status, 200);
  const payload = await claim.json() as { job: { jobId: string }; attempt: { attemptId: string; claimToken: string }; instructions: string };
  assert.equal(payload.job.jobId, jobId);
  assert.equal(payload.instructions, INSTRUCTIONS, "claim delivers the exact instruction bytes sent by the owner");
  attemptId = payload.attempt.attemptId;
  claimToken = payload.attempt.claimToken;
  console.log("enqueue-e2e: claim delivered instructions verbatim");
}

// --- Peer HTTP: started, then result within allowedOutputs -------------------------
{
  const started = await fetch(peerBase + "/peer/jobs/" + jobId + "/started", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: token },
    body: JSON.stringify({ attemptId, claimToken }),
  });
  assert.equal(started.status, 200, await started.clone().text());

  const files = [{ path: "out/nonce.json", sha256: "a".repeat(64), bytes: 5 }];
  const result = await fetch(peerBase + "/peer/jobs/" + jobId + "/result", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: token },
    body: JSON.stringify({
      attemptId,
      claimToken,
      receipt: {
        jobId,
        attemptId,
        actorClass: "muse_vm_process",
        baseRevision: enqueueArgs.baseRevision,
        manifestSha256: manifestSha256(enqueueArgs.baseRevision, files),
        files,
        totalBytes: 5,
        terminalState: "succeeded",
        summary: "nonce reported",
      },
    }),
  });
  assert.equal(result.status, 200, await result.clone().text());
  const payload = await result.json() as { job: { status: string } };
  assert.equal(payload.job.status, "result_received");
  console.log("enqueue-e2e: result within allowedOutputs -> result_received");
}

// --- Owner enqueue denials ----------------------------------------------------------
{
  async function enqueueError(arguments_: Record<string, unknown>, label: string): Promise<void> {
    const response = await rpc(ownerUrl, "tools/call", { name: "enqueue_peer_job", arguments: arguments_ }, { "mcp-session-id": ownerSession });
    assert.equal(response.payload?.result?.isError, true, label + " must be an isError denial");
    console.log("enqueue-e2e: " + label + " denied");
  }
  // Unknown peer.
  await enqueueError({ ...enqueueArgs, peerId: "no-such-peer" }, "unknown peerId");
  // Granted-root violation: peer has only `root`.
  await enqueueError({ ...enqueueArgs, repositoryId: outsideRoot }, "ungranted repositoryId");
  // Outside the server's allowed roots entirely.
  await enqueueError({ ...enqueueArgs, repositoryId: "/definitely/not/allowed" }, "repositoryId outside allowed roots");
  // Cap exceeded: job1 is result_received (not active), so enqueue job2 OK…
  const second = await rpc(ownerUrl, "tools/call", {
    name: "enqueue_peer_job",
    arguments: { ...enqueueArgs, baseRevision: "b".repeat(40) },
  }, { "mcp-session-id": ownerSession });
  assert.equal(second.payload?.result?.isError, undefined, "second enqueue fits the cap");
  // …then a third exceeds KONTROL_PEER_MAX_CLAIMED_JOBS=1.
  const third = await rpc(ownerUrl, "tools/call", {
    name: "enqueue_peer_job",
    arguments: { ...enqueueArgs, baseRevision: "c".repeat(40) },
  }, { "mcp-session-id": ownerSession });
  assert.equal(third.payload?.result?.isError, true, "cap exceeded must be an isError denial");
  assert.match(JSON.stringify(third.payload), /maximum number of active jobs/);
  console.log("enqueue-e2e: per-peer job cap enforced on the owner enqueue path");
}

await deleteSession(ownerUrl, ownerSession);
await deleteSession(peerMcpUrl, peerSession, peerHeaders);
await new Promise<void>((resolve) => ownerListener.server.close(() => resolve()));
await new Promise<void>((resolve) => peerListener.server.close(() => resolve()));
await running.close();
console.log("src/peer-jobs-enqueue.test.ts: all assertions passed");
