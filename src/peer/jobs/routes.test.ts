/**
 * M3 routes tests: full HTTP flow over an express app with the REAL
 * PeerCredentialRegistry + peer auth middleware (fixture pattern from
 * src/peer-listener.test.ts). Covers capability enforcement, shutdown 503,
 * URL/attempt correlation 404s, real idempotency/conflict on duplicate
 * results, instructions delivery, scoped-404, and the production reaper
 * factory. Style: plain tsx script with node:assert/strict.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import express from "express";
import { PeerCredentialRegistry, createPeerAuthMiddleware } from "../auth.js";
import { hashPeerCredential } from "../credentials.js";
import { openPeerJobStore, setPeerJobStoreSingleton } from "./store.js";
import { createPeerJobReaper, reconcilePeerJobWorkspaceReservations, registerPeerJobRoutes } from "./routes.js";
import { manifestSha256 } from "./service.js";

const PEER_ID = "meta-muse";
const OTHER_PEER_ID = "other-peer";
const CAP_PEER_ID = "inspect-only-peer";
const CREDENTIAL_ID = "v1";
const SECRET = randomBytes(24).toString("hex");
const token = "Bearer " + CREDENTIAL_ID + ":" + SECRET;

const configDir = mkdtempSync(join(tmpdir(), "peer-jobs-routes-config-"));
const stateDir = mkdtempSync(join(tmpdir(), "peer-jobs-routes-state-"));
const grantedRoot = mkdtempSync(join(tmpdir(), "peer-jobs-routes-root-"));

function writeRegistry(peers: unknown[]): string {
  const file = join(configDir, "peer-fixture-registry.json");
  writeFileSync(file, JSON.stringify({ version: 1, peers }, null, 2));
  chmodSync(file, 0o600);
  const future = new Date(Date.now() + 5_000);
  utimesSync(file, future, future);
  return file;
}

const fullCaps = ["workspace:inspect", "job:claim", "job:complete", "job:cancel_ack"];

const credentialFile = writeRegistry([
  {
    id: PEER_ID,
    credentialId: CREDENTIAL_ID,
    credentialHash: hashPeerCredential(CREDENTIAL_ID, SECRET),
    capabilities: fullCaps,
    grantedRoots: [grantedRoot],
  },
]);

const logging = { level: "silent" as const, format: "json" as const, requests: false, assets: false, toolCalls: false, shellCommands: false };

const registry = PeerCredentialRegistry.open(credentialFile);
const store = openPeerJobStore(stateDir, logging);
setPeerJobStoreSingleton(store);

// Restart reconciliation may see a durable review/terminal result whose
// workspace lease release was interrupted by a process crash. Clear only
// leases still owned by that exact peer job, retaining uncertain fences.
{
  const releases: Array<{ workSessionId: string; leaseNonce: string }> = [];
  const leases = new Map([
    ["work-review", { leaseKind: "peer_job", ownerInstanceId: "peer-job:job-review", leaseNonce: "review-nonce" }],
    ["work-uncertain", { leaseKind: "peer_job", ownerInstanceId: "peer-job:job-uncertain", leaseNonce: "uncertain-nonce" }],
    ["work-replaced", { leaseKind: "peer_job", ownerInstanceId: "peer-job:newer-job", leaseNonce: "replacement-nonce" }],
  ]);
  const workSessions = {
    getWorkspaceLeaseForSession: (workSessionId: string) => leases.get(workSessionId),
    releaseWorkspaceLeaseForSession: (workSessionId: string, leaseNonce: string) => {
      releases.push({ workSessionId, leaseNonce });
      return true;
    },
  };
  reconcilePeerJobWorkspaceReservations(workSessions as any, [
    { jobId: "job-review", workSessionId: "work-review", status: "awaiting_review" },
    { jobId: "job-uncertain", workSessionId: "work-uncertain", status: "awaiting_reconciliation" },
    { jobId: "job-replaced", workSessionId: "work-replaced", status: "completed" },
  ] as any);
  assert.deepEqual(releases, [{ workSessionId: "work-review", leaseNonce: "review-nonce" }],
    "startup releases only stale reservations for durable review/terminal jobs, never uncertain or replacement leases");
}

// The shutdown flag is mutable so the SAME app exercises both the open and
// the shutting-down claim path.
let shuttingDown = false;

const app = express();
app.use("/peer", createPeerAuthMiddleware(registry, { logging: { level: "error" } }));
app.use("/peer", express.json({ limit: 65536 }));
const jobsClose = registerPeerJobRoutes(app, {
  registry,
  config: {
    stateDir,
    peer: {
      enabled: true,
      bindHost: "127.0.0.1",
      port: 0,
      credentialFile,
      maxActiveSessions: 8,
      maxClaimedJobs: 8,
      requestBytesLimit: 65536,
      allowedPeers: [],
    },
  },
  logging,
  isShuttingDown: () => shuttingDown,
});

const httpServer = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => httpServer.once("listening", resolve));
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const port = address.port;
const base = "http://127.0.0.1:" + port;

async function post(path: string, body: unknown, authorization: string = token): Promise<{ status: number; payload: any }> {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  return { status: response.status, payload: text ? JSON.parse(text) : undefined };
}

async function putArtifact(jobId: string, attemptId: string, claimToken: string, path: string, bytes: Buffer): Promise<{ status: number; payload: any }> {
  const response = await fetch(base + `/peer/jobs/${jobId}/artifacts`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      authorization: token,
      "x-peer-attempt-id": attemptId,
      "x-peer-claim-token": claimToken,
      "x-peer-artifact-path": path,
    },
    body: new Blob([Uint8Array.from(bytes)]),
  });
  const text = await response.text();
  return { status: response.status, payload: text ? JSON.parse(text) : undefined };
}

async function get(path: string, authorization: string = token): Promise<{ status: number; payload: any }> {
  const response = await fetch(base + path, { headers: { authorization } });
  const text = await response.text();
  return { status: response.status, payload: text ? JSON.parse(text) : undefined };
}

/** Poll until the predicate holds (registry hot-reload is mtime-based). */
async function waitFor(description: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(predicate(), "timed out waiting for: " + description);
}

function makeJob(overrides: Record<string, unknown> = {}): ReturnType<typeof store.createJob> {
  return store.createJob({
    peerId: PEER_ID,
    workspaceSessionId: "ws_peer_job_test",
    workSessionId: "wsess_peer_job_test",
    repositoryId: grantedRoot,
    baseRevision: "0123456789abcdef0123456789abcdef01234567",
    taskClass: "read_only_audit",
    instructionHash: createHash("sha256").update("do the audit").digest("hex"),
    instructions: "do the audit",
    allowedOutputs: ["out/"],
    maxRuntimeMs: 60_000,
    maxArtifactBytes: 4096,
    ...overrides,
  });
}

// --- Authenticate + empty commands --------------------------------------------
{
  const commands = await get("/peer/commands");
  assert.equal(commands.status, 200);
  assert.deepEqual(commands.payload, { pendingJobs: 0, commands: [] });
  console.log("routes: authenticated empty /peer/commands");
}

// --- Job injection via store directly (no HTTP create route) -------------------
const job = makeJob();

// --- Commands poll shows the pending job (does NOT mutate) ---------------------
{
  const commands = await get("/peer/commands");
  assert.equal(commands.status, 200);
  assert.equal(commands.payload.pendingJobs, 1);
  assert.equal(commands.payload.commands[0].jobId, job.jobId);
  assert.equal(commands.payload.commands[0].taskClass, "read_only_audit");
  // Still pending after polling.
  assert.equal(store.getJob(job.jobId)?.status, "pending", "commands poll does not mutate");
  console.log("routes: /peer/commands poll-friendly, non-mutating");
}

// --- claim -> started -> renew -> result ---------------------------------------
const claim = await post("/peer/jobs/claim", {});
assert.equal(claim.status, 200, JSON.stringify(claim.payload));
assert.equal(claim.payload.job.jobId, job.jobId);
assert.match(claim.payload.attempt.claimToken, /^[a-f0-9]{64}$/);
assert.equal(claim.payload.instructions, "do the audit", "claim response carries the instruction payload");
assert.equal(claim.payload.job.workspaceSessionId, undefined, "peer claim does not disclose owner workspace identity");
assert.equal(claim.payload.job.workSessionId, undefined, "peer claim does not disclose owner work-session identity");
const { attemptId, claimToken } = claim.payload.attempt;

// GET instructions returns the same payload.
{
  const fetched = await get("/peer/jobs/" + job.jobId + "/instructions");
  assert.equal(fetched.status, 200, JSON.stringify(fetched.payload));
  assert.equal(fetched.payload.instructions, "do the audit");
  console.log("routes: GET /peer/jobs/:jobId/instructions returns the payload");
}

const started = await post("/peer/jobs/" + job.jobId + "/started", { attemptId, claimToken });
assert.equal(started.status, 200, JSON.stringify(started.payload));
assert.equal(started.payload.job.status, "running");

const renewed = await post("/peer/jobs/" + job.jobId + "/renew", { attemptId, claimToken, leaseMs: 30_000 });
assert.equal(renewed.status, 200, JSON.stringify(renewed.payload));
assert.ok(Date.parse(renewed.payload.leaseExpiresAt) > Date.now());

const reportBytes = Buffer.from("report\n", "utf8");
const files = [{ path: "out/report.json", sha256: createHash("sha256").update(reportBytes).digest("hex"), bytes: reportBytes.byteLength }];
const upload = await putArtifact(job.jobId, attemptId, claimToken, files[0]!.path, reportBytes);
assert.equal(upload.status, 200, JSON.stringify(upload.payload));
assert.equal(upload.payload.sha256, files[0]!.sha256);
const result = await post("/peer/jobs/" + job.jobId + "/result", {
  attemptId,
  claimToken,
  receipt: {
    jobId: job.jobId,
    attemptId,
    actorClass: "muse_vm_process",
    baseRevision: job.baseRevision,
    manifestSha256: manifestSha256(job.baseRevision, files),
    files,
    totalBytes: 7,
    terminalState: "succeeded",
    summary: "audit done",
  },
});
assert.equal(result.status, 200, JSON.stringify(result.payload));
assert.equal(result.payload.job.status, "result_received");

const status = await get("/peer/jobs/" + job.jobId + "/status");
assert.equal(status.status, 200);
assert.equal(status.payload.job.status, "result_received");
assert.equal(status.payload.job.resultProcessing, undefined, "peer status does not disclose owner review references");
console.log("routes: full claim/started/renew/result/status flow");

// --- A manifest cannot claim bytes that were not uploaded ------------------------
{
  const missingJob = makeJob({ baseRevision: "b".repeat(40) });
  const missingClaim = await post("/peer/jobs/claim", {});
  assert.equal(missingClaim.payload.job.jobId, missingJob.jobId);
  const missingAttempt = missingClaim.payload.attempt as { attemptId: string; claimToken: string };
  await post(`/peer/jobs/${missingJob.jobId}/started`, missingAttempt);
  const missingBytesReceipt = await post(`/peer/jobs/${missingJob.jobId}/result`, {
    ...missingAttempt,
    receipt: {
      jobId: missingJob.jobId,
      attemptId: missingAttempt.attemptId,
      actorClass: "muse_vm_process",
      baseRevision: missingJob.baseRevision,
      manifestSha256: manifestSha256(missingJob.baseRevision, files),
      files,
      totalBytes: reportBytes.byteLength,
      terminalState: "succeeded",
    },
  });
  assert.equal(missingBytesReceipt.status, 422);
  assert.equal(missingBytesReceipt.payload.error.code, "artifact_missing_or_mismatched");
  console.log("routes: manifest-only success rejected without matching artifact bytes");
}

// --- Idempotent duplicate result (through the store comparison) ------------------
{
  const repeat = await post("/peer/jobs/" + job.jobId + "/result", {
    attemptId,
    claimToken,
    receipt: {
      jobId: job.jobId,
      attemptId,
      actorClass: "muse_vm_process",
      baseRevision: job.baseRevision,
      manifestSha256: manifestSha256(job.baseRevision, files),
      files,
      totalBytes: 7,
      terminalState: "succeeded",
      summary: "audit done",
    },
  });
  assert.equal(repeat.status, 200, "identical duplicate result is idempotent");
  assert.equal(repeat.payload.job.status, "result_received");
  assert.equal(repeat.payload.idempotent, true);
  console.log("routes: idempotent duplicate result (store deep-compare)");
}

// --- Conflicting duplicate result -> 409 ------------------------------------------
{
  const conflict = await post("/peer/jobs/" + job.jobId + "/result", {
    attemptId,
    claimToken,
    receipt: {
      jobId: job.jobId,
      attemptId,
      actorClass: "muse_vm_process",
      baseRevision: job.baseRevision,
      manifestSha256: manifestSha256(job.baseRevision, files),
      files,
      totalBytes: 7,
      terminalState: "succeeded",
      summary: "DIFFERENT outcome claim",
    },
  });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.payload));
  assert.equal(conflict.payload.error.code, "conflicting_result");
  console.log("routes: conflicting duplicate result -> 409 conflicting_result");
}

// --- URL/attempt correlation: foreign attempt -> 404 job_attempt_mismatch ----------
{
  const otherJob = makeJob({ baseRevision: "f".repeat(40) });
  const otherClaim = await post("/peer/jobs/claim", {});
  assert.equal(otherClaim.status, 200);
  assert.equal(otherClaim.payload.job.jobId, otherJob.jobId);
  const otherAttempt = otherClaim.payload.attempt;
  const mismatch = await post("/peer/jobs/" + job.jobId + "/started", {
    attemptId: otherAttempt.attemptId,
    claimToken: otherAttempt.claimToken,
  });
  assert.equal(mismatch.status, 404, "attempt from another job must not complete this one");
  assert.equal(mismatch.payload.error.code, "job_attempt_mismatch");
  // Same for renew, fail, result, not-started.
  const renewMismatch = await post("/peer/jobs/" + job.jobId + "/renew", { attemptId: otherAttempt.attemptId, claimToken: otherAttempt.claimToken });
  assert.equal(renewMismatch.status, 404);
  const failMismatch = await post("/peer/jobs/" + job.jobId + "/fail", { attemptId: otherAttempt.attemptId, claimToken: otherAttempt.claimToken });
  assert.equal(failMismatch.status, 404);
  const resultMismatch = await post("/peer/jobs/" + job.jobId + "/result", {
    attemptId: otherAttempt.attemptId,
    claimToken: otherAttempt.claimToken,
    receipt: { jobId: job.jobId, attemptId: otherAttempt.attemptId, actorClass: "muse_vm_process", baseRevision: job.baseRevision, manifestSha256: manifestSha256(job.baseRevision, []), files: [], totalBytes: 0, terminalState: "succeeded" },
  });
  assert.equal(resultMismatch.status, 404);
  const notStartedMismatch = await post("/peer/jobs/" + job.jobId + "/not-started", { attemptId: otherAttempt.attemptId, claimToken: otherAttempt.claimToken });
  assert.equal(notStartedMismatch.status, 404);
  console.log("routes: URL/attempt correlation -> 404 job_attempt_mismatch on started/renew/fail/result/not-started");

  // not-started happy path on the correct URL/attempt pair.
  const notStarted = await post("/peer/jobs/" + otherJob.jobId + "/not-started", {
    attemptId: otherAttempt.attemptId,
    claimToken: otherAttempt.claimToken,
  });
  assert.equal(notStarted.status, 200, JSON.stringify(notStarted.payload));
  console.log("routes: POST /peer/jobs/:jobId/not-started honest report accepted");
}

// --- Capability denial: peer with only workspace:inspect gets 403 ------------------
{
  writeRegistry([
    {
      id: CAP_PEER_ID,
      credentialId: CREDENTIAL_ID,
      credentialHash: hashPeerCredential(CREDENTIAL_ID, SECRET),
      capabilities: ["workspace:inspect"],
      grantedRoots: [grantedRoot],
    },
  ]);
  const capToken = token; // same credential id/secret; the peer identity changed.
  let denied = false;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const attempt = await post("/peer/jobs/claim", {}, capToken);
    if (attempt.status === 403) {
      denied = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(denied, "claim without job:claim must be denied with 403");
  const statusDenied = await get("/peer/jobs/" + job.jobId + "/status", capToken);
  assert.equal(statusDenied.status, 403);
  assert.equal(statusDenied.payload.error.code, "peer_capability_denied");
  const resultDenied = await post("/peer/jobs/" + job.jobId + "/result", {
    attemptId,
    claimToken,
    receipt: { jobId: job.jobId, attemptId, actorClass: "muse_vm_process", baseRevision: job.baseRevision, manifestSha256: manifestSha256(job.baseRevision, files), files, totalBytes: 7, terminalState: "succeeded" },
  }, capToken);
  assert.equal(resultDenied.status, 403, "result without job:complete must be denied with 403");
  console.log("routes: capability enforcement — inspect-only peer gets 403 peer_capability_denied on claim/status/result");
}

// --- Wrong-peer status/instructions are scoped 404s ---------------------------------
{
  writeRegistry([
    {
      id: OTHER_PEER_ID,
      credentialId: CREDENTIAL_ID,
      credentialHash: hashPeerCredential(CREDENTIAL_ID, SECRET),
      // job:claim granted so this block isolates SCOPING (not capability).
      capabilities: ["workspace:inspect", "job:claim"],
      grantedRoots: [grantedRoot],
    },
  ]);
  const deadline = Date.now() + 5_000;
  let foreignStatus = 0;
  while (Date.now() < deadline) {
    foreignStatus = (await get("/peer/jobs/" + job.jobId + "/status")).status;
    if (foreignStatus === 404) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(foreignStatus, 404, "wrong-peer status must be a scoped 404");
  const foreignInstructions = await get("/peer/jobs/" + job.jobId + "/instructions");
  assert.equal(foreignInstructions.status, 404, "foreign-peer instructions must be a scoped 404");
  console.log("routes: wrong-peer status/instructions are 404 (no existence leak)");
}

// Restore the original registry for the remaining cases.
writeRegistry([
  {
    id: PEER_ID,
    credentialId: CREDENTIAL_ID,
    credentialHash: hashPeerCredential(CREDENTIAL_ID, SECRET),
    capabilities: fullCaps,
    grantedRoots: [grantedRoot],
  },
]);
{
  const deadline = Date.now() + 5_000;
  let ok = false;
  while (Date.now() < deadline) {
    if ((await get("/peer/commands")).status === 200) {
      ok = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ok, "original peer re-authorized after registry restore");
}

// --- meta_muse_agent receipt is rejected with 422 --------------------------------
{
  const job2 = makeJob({ baseRevision: "2222222222222222222222222222222222222222" });
  const claim2 = await post("/peer/jobs/claim", {});
  assert.equal(claim2.status, 200);
  assert.equal(claim2.payload.job.jobId, job2.jobId);
  const started2 = await post("/peer/jobs/" + job2.jobId + "/started", {
    attemptId: claim2.payload.attempt.attemptId,
    claimToken: claim2.payload.attempt.claimToken,
  });
  assert.equal(started2.status, 200);

  const rejected = await post("/peer/jobs/" + job2.jobId + "/result", {
    attemptId: claim2.payload.attempt.attemptId,
    claimToken: claim2.payload.attempt.claimToken,
    receipt: {
      jobId: job2.jobId,
      attemptId: claim2.payload.attempt.attemptId,
      actorClass: "meta_muse_agent",
      baseRevision: job2.baseRevision,
      manifestSha256: manifestSha256(job2.baseRevision, []),
      files: [],
      totalBytes: 0,
      terminalState: "succeeded",
    },
  });
  assert.equal(rejected.status, 422, "meta_muse_agent receipt must be rejected in M3");
  assert.equal(rejected.payload.error.code, "actor_class_unverified");
  assert.match(rejected.payload.error.message, /C3/);
  console.log("routes: meta_muse_agent receipt rejected with 422 (C3 unclaimed)");
}

// --- Shutdown: claims refused with 503 --------------------------------------------
{
  shuttingDown = true;
  const refused = await post("/peer/jobs/claim", {});
  assert.equal(refused.status, 503, JSON.stringify(refused.payload));
  assert.equal(refused.payload.error.code, "shutting_down");
  shuttingDown = false;
  const recovered = await get("/peer/commands");
  assert.equal(recovered.status, 200, "claims resume after the shutdown flag clears");
  console.log("routes: isShuttingDown -> claim 503, recovers when cleared");
}

// --- Production reaper factory (createPeerJobReaper) --------------------------------
{
  // Build an isolated SQLite-backed store, reopen it, then drive the SAME
  // factory the production route registration uses.
  const reapStateDir = mkdtempSync(join(tmpdir(), "peer-jobs-reaper-"));
  const writer = openPeerJobStore(reapStateDir, logging);
  const reapJob = writer.createJob({
    peerId: PEER_ID,
    workspaceSessionId: "ws_peer_reaper_test",
    workSessionId: "wsess_peer_reaper_test",
    repositoryId: grantedRoot,
    baseRevision: "e".repeat(40),
    taskClass: "read_only_audit",
    instructionHash: createHash("sha256").update("reap").digest("hex"),
    instructions: "reap me",
    allowedOutputs: [],
    maxRuntimeMs: 60_000,
    maxArtifactBytes: 1024,
  });
  const reapClaim = writer.claimNextJob(PEER_ID, Date.now());
  assert.ok(reapClaim);
  writer.close();

  const reaperStore = openPeerJobStore(reapStateDir, logging);
  const reaper = createPeerJobReaper(reaperStore, 25);
  // Boot reconciliation already reconciled the orphaned active attempt, so
  // exercise the factory's delegation on a LIVE claim instead.
  const liveJob = reaperStore.createJob({
    peerId: PEER_ID,
    workspaceSessionId: "ws_peer_reaper_live_test",
    workSessionId: "wsess_peer_reaper_live_test",
    repositoryId: grantedRoot,
    baseRevision: "f".repeat(40),
    taskClass: "read_only_audit",
    instructionHash: createHash("sha256").update("reap live").digest("hex"),
    instructions: "reap me live",
    allowedOutputs: [],
    maxRuntimeMs: 60_000,
    maxArtifactBytes: 1024,
  });
  const liveClaim = reaperStore.claimNextJob(PEER_ID, Date.now());
  assert.ok(liveClaim);
  // A claim's lease lapses with unknown certainty: the factory sweep must
  // route it to awaiting_reconciliation, never requeue.
  const reaped = reaper.reapNow(Date.now() + 120_000);
  assert.ok(reaped.length >= 1, "reapNow delegates to the store sweep");
  assert.equal(reaperStore.getJob(liveJob.jobId)?.status, "awaiting_reconciliation");
  assert.equal(reaperStore.getAttempt(liveClaim.attempt.attemptId)?.status, "expired");
  // start()/stop() drive the production interval without leaking a timer.
  reaper.start();
  reaper.stop();
  reaperStore.close();
  void reapJob;
  console.log("routes: createPeerJobReaper factory — reapNow sweeps, start/stop lifecycle");
}

// --- Revoked credential mid-flow -> 401 -------------------------------------------
{
  writeRegistry([
    {
      id: PEER_ID,
      credentialId: CREDENTIAL_ID,
      credentialHash: hashPeerCredential(CREDENTIAL_ID, SECRET),
      capabilities: fullCaps,
      grantedRoots: [grantedRoot],
      revokedAt: new Date().toISOString(),
    },
  ]);
  let revoked = false;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const attempt = await get("/peer/commands");
    if (attempt.status === 401) {
      revoked = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(revoked, "revoked credential must be rejected with 401");
  console.log("routes: revoked credential mid-flow -> 401");
}

await jobsClose.close();
await new Promise<void>((resolve) => httpServer.close(() => resolve()));
console.log("src/peer/jobs/routes.test.ts: all assertions passed");
