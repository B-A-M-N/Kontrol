/**
 * M3 owner-side enqueue E2E: the owner MCP listener can enqueue_peer_job for
 * a registry-granted peer; the peer's MCP catalog NEVER contains the tool
 * (and calling it by name is denied); the peer receives the instructions
 * verbatim over the HTTP job protocol and returns a validated result.
 * Harness pattern: src/peer-listener.test.ts.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
import type { ServerConfig } from "./config.js";
import { hashPeerCredential } from "./peer/credentials.js";
import { manifestSha256 } from "./peer/jobs/service.js";
import { createPeerJobResultProcessor } from "./peer/jobs/result-processor.js";
import { getPeerJobStore } from "./peer/jobs/store.js";
import type { PeerJob } from "./peer/jobs/contracts.js";
import { createWorkSessionManager } from "./work-sessions/index.js";

const PEER_ID = "meta-muse";
const CREDENTIAL_ID = "v1";
const SECRET = randomBytes(24).toString("hex");
const REVIEWER_SECRET = randomBytes(24).toString("hex");
const token = "Bearer " + CREDENTIAL_ID + ":" + SECRET;
const INSTRUCTIONS = "say the nonce potato";
const expectedInstructionHash = createHash("sha256").update(INSTRUCTIONS, "utf8").digest("hex");

const realTempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const root = realTempDir("kontrol-enqueue-root-");
const outsideRoot = realTempDir("kontrol-enqueue-outside-");
const stateDir = realTempDir("kontrol-enqueue-state-");
const worktreeRoot = realTempDir("kontrol-enqueue-worktrees-");
const configDir = realTempDir("kontrol-enqueue-config-");

writeFileSync(join(root, "hello.txt"), "hello from enqueue e2e\n");
execFileSync("git", ["init", "-q"], { cwd: root });
execFileSync("git", ["add", "--", "hello.txt"], { cwd: root });
const authorIdent = execFileSync("git", ["var", "GIT_AUTHOR_IDENT"], { encoding: "utf8" }).trim();
const authorMatch = /^(.*) <([^<>]+)> \d+ [+-]\d{4}$/.exec(authorIdent);
assert.ok(authorMatch, "the test environment provides its configured Git identity");
execFileSync("git", ["-c", `user.name=${authorMatch[1]}`, "-c", `user.email=${authorMatch[2]}`, "commit", "-m", "peer job baseline", "-q"], { cwd: root });
const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

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
  KONTROL_ACP_ENABLED: "true",
  KONTROL_ACP_AGENT_SECRET: randomBytes(24).toString("hex"),
  KONTROL_ACP_REVIEWER_SECRET: REVIEWER_SECRET,
  KONTROL_ACP_ADAPTER_SECRET: randomBytes(24).toString("hex"),
  KONTROL_TUNNEL_REVIEWER_SECRET: REVIEWER_SECRET,
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
const reviewerHeaders = { "x-kontrol-tunnel-reviewer": REVIEWER_SECRET };
const reviewerSession = await initialize(ownerUrl, "kontrol-enqueue-reviewer", reviewerHeaders);
const testWorkSessions = createWorkSessionManager(stateDir);

async function createBoundTarget(): Promise<{ workspaceSessionId: string; workSessionId: string; workspaceRoot: string }> {
  const opened = await rpc(ownerUrl, "tools/call", {
    name: "open_workspace",
    arguments: { path: root, mode: "worktree", baseRef: baseRevision },
  }, { "mcp-session-id": ownerSession });
  assert.equal(opened.payload?.result?.isError, undefined, JSON.stringify(opened.payload));
  const workspaceSessionId = opened.payload?.result?.structuredContent?.workspaceId as string | undefined;
  const workspaceRoot = opened.payload?.result?.structuredContent?.root as string | undefined;
  assert.ok(workspaceSessionId, "open_workspace returns managed-worktree workspaceId");
  assert.ok(workspaceRoot, "open_workspace returns the exact managed-worktree root");
  const workSession = testWorkSessions.create({
    workspaceSessionId,
    submittedBy: "peer-job-e2e",
    title: "Peer job integration test",
    completionPolicy: "webui_approval_required",
  });
  return { workspaceSessionId, workSessionId: workSession.id, workspaceRoot };
}

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
    arguments: { peerId: PEER_ID, repositoryId: root, workspaceSessionId: "ws_peer", workSessionId: "wsess_peer", baseRevision, taskClass: "read_only_audit", instructions: "x", allowedOutputs: ["*"] },
  }, { ...peerHeaders, "mcp-session-id": peerSession });
  assert.equal(attempt.response.status, 200);
  assert.equal(attempt.payload?.result?.isError, true, "peer-role enqueue call must be denied");
  assert.match(JSON.stringify(attempt.payload), /[Ff]orbidden/);
  console.log("enqueue-e2e: peer-role enqueue_peer_job call denied (belt-and-braces)");
}

// --- Owner enqueue happy path ----------------------------------------------------
const enqueueTarget = await createBoundTarget();
const { workspaceRoot: enqueueWorkspaceRoot, ...enqueueTargetArgs } = enqueueTarget;
const enqueueArgs = {
  peerId: PEER_ID,
  repositoryId: root,
  baseRevision,
  ...enqueueTargetArgs,
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
  const reservation = testWorkSessions.getWorkspaceLeaseForSession(enqueueTarget.workSessionId);
  assert.equal(reservation?.leaseKind, "peer_job", "enqueue durably reserves the exact worktree for peer execution and staging");
  assert.equal(reservation?.ownerInstanceId, `peer-job:${jobId}`);
  const normalWorkerLease = testWorkSessions.acquireWorkspaceLease({
    canonicalRoot: reservation!.canonicalRoot,
    workspaceSessionId: enqueueTarget.workspaceSessionId,
    workSessionId: enqueueTarget.workSessionId,
  });
  assert.equal(normalWorkerLease.acquired, false, "even the same work session cannot start a worker through a peer-job reservation");
  const afterRestart = createWorkSessionManager(stateDir);
  try {
    assert.equal(afterRestart.getWorkspaceLeaseForSession(enqueueTarget.workSessionId)?.leaseNonce, reservation?.leaseNonce,
      "the peer-job checkout reservation survives opening a fresh SQLite work-session manager");
  } finally {
    afterRestart.close();
  }
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

  const artifactBytes = Buffer.from("nonce", "utf8");
  const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  const artifactPath = "out/nonce.json";
  const files = [{ path: artifactPath, sha256: artifactSha256, bytes: artifactBytes.byteLength }];
  const uploaded = await fetch(peerBase + "/peer/jobs/" + jobId + "/artifacts", {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      authorization: token,
      "x-peer-attempt-id": attemptId,
      "x-peer-claim-token": claimToken,
      "x-peer-artifact-path": files[0]!.path,
    },
    body: new Blob([Uint8Array.from(artifactBytes)]),
  });
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  // Force the durable result processor into its ambiguous local-recovery state:
  // a crash-left temp path exists but its bytes do not match this exact receipt.
  // The peer has already uploaded the correct immutable artifact bytes, so an
  // owner retry must be able to recover without relaunching the remote job.
  const temporaryPath = join(enqueueWorkspaceRoot, `${artifactPath}.${artifactSha256}.peer.tmp`);
  mkdirSync(join(enqueueWorkspaceRoot, "out"), { recursive: true });
  writeFileSync(temporaryPath, "conflicting temporary bytes");
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
  console.log("enqueue-e2e: uploaded artifact bytes match the accepted result receipt");
  const reconciliationDeadline = Date.now() + 10_000;
  let processed: any;
  while (Date.now() < reconciliationDeadline) {
    const response = await rpc(ownerUrl, "tools/call", {
      name: "list_peer_status",
      arguments: { peerId: PEER_ID },
    }, { "mcp-session-id": ownerSession });
    processed = response.payload?.result?.structuredContent?.jobs?.find((job: { jobId: string }) => job.jobId === jobId);
    if (processed?.status === "awaiting_reconciliation") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(processed?.status, "awaiting_reconciliation", JSON.stringify(processed));
  assert.equal(processed.resultProcessingFailure, "artifact_temporary_conflict",
    "the owner status projection exposes the classified local recovery reason");
  rmSync(temporaryPath);
  const retry = await rpc(ownerUrl, "tools/call", {
    name: "reconcile_peer_job_result",
    arguments: {
      jobId,
      expectedFailure: "artifact_temporary_conflict",
      clientMutationId: "peer-result-local-retry-1",
    },
  }, { "mcp-session-id": ownerSession });
  assert.equal(retry.payload?.result?.isError, undefined, JSON.stringify(retry.payload));
  assert.equal(retry.payload?.result?.structuredContent?.status, "result_received");
  assert.equal(retry.payload?.result?.structuredContent?.retryRevision, 1);
  assert.match(retry.payload?.result?.structuredContent?.message ?? "", /reviewer approval remains required/);
  const retryAgain = await rpc(ownerUrl, "tools/call", {
    name: "reconcile_peer_job_result",
    arguments: {
      jobId,
      expectedFailure: "artifact_temporary_conflict",
      clientMutationId: "peer-result-local-retry-1",
    },
  }, { "mcp-session-id": ownerSession });
  assert.deepEqual(retryAgain.payload?.result?.structuredContent, retry.payload?.result?.structuredContent,
    "an identical mutation retry returns its original recovery receipt");
  assert.equal(getPeerJobStore()?.listAttemptsForJob(jobId).length, 1,
    "local result reconciliation never launches a second remote peer attempt");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await rpc(ownerUrl, "tools/call", {
      name: "list_peer_status",
      arguments: { peerId: PEER_ID },
    }, { "mcp-session-id": ownerSession });
    processed = response.payload?.result?.structuredContent?.jobs?.find((job: { jobId: string }) => job.jobId === jobId);
    if (processed?.status === "awaiting_review") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(processed?.status, "awaiting_review", JSON.stringify(processed));
  assert.ok(processed.submissionId, "peer result is linked to an existing review submission");
  assert.equal(processed.snapshotKind, "git");
  assert.equal(processed.verificationStatus, "not_configured", "absence of a mission verifier is visible and never claimed as verified");
  assert.equal(testWorkSessions.getWorkspaceLeaseForSession(enqueueTarget.workSessionId), undefined,
    "successful staging releases only after the review submission and verification receipt are durable");
  console.log("enqueue-e2e: owner retries exact stored receipt; result stages a local snapshot and submits to review");

  const submission = testWorkSessions.getSubmissions(enqueueTarget.workSessionId).find((item) => item.id === processed.submissionId);
  assert.ok(submission, "peer result submission remains available to the reviewer");
  const feedback = await rpc(ownerUrl, "tools/call", {
    name: "provide_review_feedback",
    arguments: {
      sessionId: enqueueTarget.workSessionId,
      submissionId: submission.id,
      diffSha256: submission.diffSha256,
      reviewEpoch: submission.reviewEpoch,
      verdict: "approve",
      comments: "Peer result reviewed and accepted.",
    },
  }, { ...reviewerHeaders, "mcp-session-id": reviewerSession });
  assert.equal(feedback.payload?.result?.isError, undefined, JSON.stringify(feedback.payload));
  assert.equal(feedback.payload?.result?.structuredContent?.status, "approved", JSON.stringify(feedback.payload));
  const committed = testWorkSessions.getLatestFeedback(enqueueTarget.workSessionId);
  assert.equal(committed?.submissionId, submission.id, "review workflow durably committed feedback for the exact submission");
  assert.equal(committed?.verdict, "approve");
  const reviewDeadline = Date.now() + 5_000;
  while (Date.now() < reviewDeadline) {
    const response = await rpc(ownerUrl, "tools/call", {
      name: "list_peer_status",
      arguments: { peerId: PEER_ID },
    }, { "mcp-session-id": ownerSession });
    processed = response.payload?.result?.structuredContent?.jobs?.find((job: { jobId: string }) => job.jobId === jobId);
    if (processed?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(processed?.status, "completed", JSON.stringify(processed));
  assert.equal(processed.reviewVerdict, "approve", "peer job terminal state is bound to committed reviewer feedback");
  console.log("enqueue-e2e: committed reviewer approval finalizes the peer job");

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
  await enqueueError({
    ...enqueueArgs,
    ...(await createBoundTarget()),
    taskClass: "propose_patch",
  }, "propose_patch without a mission verification contract");
  // Cap exceeded: job1 is result_received (not active), so enqueue job2 OK…
  const second = await rpc(ownerUrl, "tools/call", {
    name: "enqueue_peer_job",
    arguments: { ...enqueueArgs, ...(await createBoundTarget()) },
  }, { "mcp-session-id": ownerSession });
  assert.equal(second.payload?.result?.isError, undefined, "second enqueue fits the cap");
  // …then a third exceeds KONTROL_PEER_MAX_CLAIMED_JOBS=1.
  const third = await rpc(ownerUrl, "tools/call", {
    name: "enqueue_peer_job",
    arguments: { ...enqueueArgs, ...(await createBoundTarget()) },
  }, { "mcp-session-id": ownerSession });
  assert.equal(third.payload?.result?.isError, true, "cap exceeded must be an isError denial");
  assert.match(JSON.stringify(third.payload), /maximum number of active jobs/);
  console.log("enqueue-e2e: per-peer job cap enforced on the owner enqueue path");
}

// --- Concurrent results targeting one worktree are serialized ---------------
{
  const resultRoot = mkdtempSync(join(tmpdir(), "kontrol-peer-result-lock-"));
  const bytesByJob = new Map([["job_lock_a", Buffer.from("a")], ["job_lock_b", Buffer.from("b")]]);
  const jobs = new Map<string, PeerJob>();
  const attempts = new Map<string, any[]>();
  for (const [jobId, filePath, bytes, workspaceSessionId, workSessionId] of [
    ["job_lock_a", "a.txt", bytesByJob.get("job_lock_a")!, "workspace_lock", "work_lock_a"],
    ["job_lock_b", "b.txt", bytesByJob.get("job_lock_b")!, "workspace_lock_alias", "work_lock_b"],
  ] as const) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const receipt = {
      jobId,
      attemptId: `${jobId}_attempt`,
      actorClass: "muse_vm_process" as const,
      baseRevision: "base",
      manifestSha256: "f".repeat(64),
      files: [{ path: filePath, sha256, bytes: bytes.byteLength }],
      totalBytes: bytes.byteLength,
      terminalState: "succeeded" as const,
    };
    jobs.set(jobId, {
      jobId,
      peerId: PEER_ID,
      workSessionId,
      workspaceSessionId,
      repositoryId: "repo",
      baseRevision: "base",
      taskClass: "propose_patch",
      instructionHash: "0".repeat(64),
      instructions: "",
      allowedOutputs: ["*"],
      maxRuntimeMs: 1000,
      maxArtifactBytes: 100,
      status: "result_received",
      createdAt: new Date().toISOString(),
    });
    attempts.set(jobId, [{ attemptId: receipt.attemptId, receipt }]);
  }
  const missingReceiptJob: PeerJob = {
    jobId: "job_lock_missing_receipt",
    peerId: PEER_ID,
    workSessionId: "work_lock_missing_receipt",
    workspaceSessionId: "workspace_lock_alias",
    repositoryId: "repo",
    baseRevision: "base",
    taskClass: "propose_patch",
    instructionHash: "0".repeat(64),
    instructions: "",
    allowedOutputs: ["*"],
    maxRuntimeMs: 1000,
    maxArtifactBytes: 100,
    status: "result_received",
    createdAt: new Date().toISOString(),
  };
  jobs.set(missingReceiptJob.jobId, missingReceiptJob);
  const fakeStore = {
    getJob: (jobId: string) => jobs.get(jobId),
    listAttemptsForJob: (jobId: string) => attempts.get(jobId) ?? [],
    markStaging: (jobId: string, receiptSha256: string) => {
      const job = jobs.get(jobId)!;
      job.status = "staging";
      job.resultProcessing = { receiptSha256, updatedAt: new Date().toISOString() };
      return job;
    },
    markAwaitingReview: (jobId: string, value: any) => {
      const job = jobs.get(jobId)!;
      job.status = "awaiting_review";
      job.resultProcessing = { ...value, updatedAt: new Date().toISOString() };
      return job;
    },
    recordVerification: () => undefined,
    markAwaitingReconciliation: (jobId: string, failure: string) => {
      const job = jobs.get(jobId)!;
      job.status = "awaiting_reconciliation";
      job.resultProcessing = { ...job.resultProcessing, failure, updatedAt: new Date().toISOString() };
      return job;
    },
  };
  let concurrentSnapshots = 0;
  let maxConcurrentSnapshots = 0;
  let submissionNumber = 0;
  const processor = createPeerJobResultProcessor({
    store: fakeStore as any,
    artifacts: { readReceipt: (job: PeerJob) => {
      const attempt = attempts.get(job.jobId)![0];
      const path = attempt.receipt.files[0].path;
      return new Map([[path, bytesByJob.get(job.jobId)!]]);
    } } as any,
    workspaces: { getWorkspace: (workspaceSessionId: string) => ({
      id: workspaceSessionId,
      root: resultRoot,
      mode: "worktree",
      sourceRoot: "repo",
      worktree: { managed: true, baseSha: "base" },
    }) } as any,
    workSessions: {
      get: (workSessionId: string) => ({
        workspaceSessionId: workSessionId === "work_lock_a" ? "workspace_lock" : "workspace_lock_alias",
        status: "in_progress",
      }),
      getSubmissions: () => [],
      acquireWorkspaceLease: (input: any) => ({ acquired: true, lease: {
        ...input,
        leaseKind: "peer_job",
        ownerInstanceId: input.ownerInstanceId,
        leaseNonce: `nonce-${input.ownerInstanceId}`,
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
      } }),
      releaseWorkspaceLeaseForSession: () => true,
    } as any,
    reviewCheckpoints: {
      reviewChangesAgainstCommit: async () => {
        concurrentSnapshots += 1;
        maxConcurrentSnapshots = Math.max(maxConcurrentSnapshots, concurrentSnapshots);
        await new Promise((resolve) => setTimeout(resolve, 15));
        concurrentSnapshots -= 1;
        return {
          files: [],
          patch: "fixture patch",
          summary: { additions: 1, removals: 0 },
          snapshotKind: "git",
          snapshotRef: "snapshot",
        };
      },
    } as any,
    reviewWorkflow: { submitForReview: async () => ({ submissionId: `submission_${++submissionNumber}`, reviewEpoch: submissionNumber }) } as any,
  });
  try {
    await Promise.all([processor.process(jobs.get("job_lock_a")!), processor.process(jobs.get("job_lock_b")!)]);
    assert.equal(maxConcurrentSnapshots, 1, "peer receipt processing for one managed worktree never overlaps");
    assert.equal(jobs.get("job_lock_a")?.status, "awaiting_review");
    assert.equal(jobs.get("job_lock_b")?.status, "awaiting_review");
    await processor.process(missingReceiptJob);
    assert.equal(missingReceiptJob.status, "awaiting_reconciliation",
      "a result without its required durable receipt becomes an explicit recovery state instead of silently keeping a workspace reservation");
    assert.equal(missingReceiptJob.resultProcessing?.failure, "result_receipt_missing");
    console.log("enqueue-e2e: workspace aliases for one worktree stage serially");
  } finally {
    rmSync(resultRoot, { recursive: true, force: true });
  }
}

await deleteSession(ownerUrl, ownerSession);
await deleteSession(peerMcpUrl, peerSession, peerHeaders);
await new Promise<void>((resolve) => ownerListener.server.close(() => resolve()));
await new Promise<void>((resolve) => peerListener.server.close(() => resolve()));
await running.close();
testWorkSessions.close();
console.log("src/peer-jobs-enqueue.test.ts: all assertions passed");
