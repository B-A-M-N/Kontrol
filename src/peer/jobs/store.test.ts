/**
 * M3 store tests for src/peer/jobs/store.ts + service validation: claim CAS,
 * peer scoping, lease fencing, receipt validation (identity, allowedOutputs,
 * canonical hash), reaping, restart reconciliation, cancel-ack, real
 * idempotency/conflict on duplicate results, certainty semantics,
 * runtime budget, instructions durability. Style: plain tsx script with
 * node:assert/strict.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openPeerJobStore } from "./store.js";
import type { PeerJobStore } from "./store.js";
import { PeerJobError } from "./contracts.js";
import type { PeerJob, PeerJobResultReceipt } from "./contracts.js";
import { canonicalManifestJson, canonicalizeManifestPath, manifestSha256, normalizeAllowedOutputs, validateResultReceipt } from "./service.js";

const logging = { level: "silent" as const, format: "json" as const, requests: false, assets: false, toolCalls: false, shellCommands: false };

function newStore(): PeerJobStore {
  const stateDir = mkdtempSync(join(tmpdir(), "peer-jobs-store-"));
  return openPeerJobStore(stateDir, logging);
}

function jobInput(peerId: string, overrides: Partial<PeerJob> = {}): Omit<PeerJob, "jobId" | "status" | "createdAt"> & { peerId: string } {
  return {
    peerId,
    repositoryId: "/tmp/repo",
    baseRevision: "0123456789abcdef0123456789abcdef01234567",
    taskClass: "read_only_audit",
    instructionHash: createHash("sha256").update("instruction").digest("hex"),
    instructions: "instruction",
    allowedOutputs: ["out/"],
    maxRuntimeMs: 60_000,
    maxArtifactBytes: 1024,
    ...overrides,
  } as Omit<PeerJob, "jobId" | "status" | "createdAt"> & { peerId: string };
}

function receiptFor(job: PeerJob, attemptId: string, overrides: Partial<PeerJobResultReceipt> = {}): PeerJobResultReceipt {
  const files = overrides.files ?? [];
  const totalBytes = overrides.totalBytes ?? files.reduce((sum, file) => sum + file.bytes, 0);
  return {
    jobId: job.jobId,
    attemptId,
    actorClass: "muse_vm_process",
    baseRevision: job.baseRevision,
    manifestSha256: manifestSha256(job.baseRevision, files),
    files,
    totalBytes,
    terminalState: "succeeded",
    ...overrides,
  };
}

const NOW = 1_700_000_000_000;

// --- claim CAS: double-claim loses; certainty starts unknown -------------------
{
  const store = newStore();
  const job = store.createJob(jobInput("peer-a"));
  const first = store.claimNextJob("peer-a", NOW);
  assert.ok(first);
  assert.equal(first.job.jobId, job.jobId);
  assert.equal(first.job.status, "claimed");
  assert.equal(first.attempt.generation, 1);
  // Honesty contract: a claim is NOT evidence work began.
  assert.equal(first.attempt.outcomeCertainty, "unknown");
  assert.match(first.attempt.claimToken, /^[a-f0-9]{64}$/);
  assert.equal(store.claimNextJob("peer-a", NOW), undefined, "double-claim loses (CAS from pending only)");
  console.log("store: claim CAS — second claim loses, certainty unknown");
}

// --- peer scoping ------------------------------------------------------------
{
  const store = newStore();
  store.createJob(jobInput("peer-a"));
  assert.equal(store.claimNextJob("peer-b", NOW), undefined, "peer B never claims peer A's job");
  const claimed = store.claimNextJob("peer-a", NOW);
  assert.ok(claimed, "peer A claims its own job");
  assert.equal(claimed.attempt.claimOwnerPeerId, "peer-a");
  console.log("store: peer scoping enforced");
}

// --- renew fencing + expiry honesty ------------------------------------------
{
  const store = newStore();
  const job = store.createJob(jobInput("peer-a"));
  const { attempt } = store.claimNextJob("peer-a", NOW)!;

  // Wrong token is fenced.
  assert.throws(() => store.renewLease(attempt.attemptId, "f".repeat(64), "peer-a", NOW + 1000, 60_000), (error: unknown) =>
    error instanceof PeerJobError && error.code === "claim_token_mismatch",
  );
  // Wrong peer is fenced.
  assert.throws(() => store.renewLease(attempt.attemptId, attempt.claimToken, "peer-b", NOW + 1000, 60_000), (error: unknown) =>
    error instanceof PeerJobError && error.code === "attempt_forbidden",
  );

  // Happy renew extends the lease and records the heartbeat.
  const renewed = store.renewLease(attempt.attemptId, attempt.claimToken, "peer-a", NOW + 1000, 30_000);
  assert.equal(renewed.job.status, "claimed");
  assert.equal(Date.parse(renewed.attempt.leaseExpiresAt), NOW + 1000 + 30_000);
  assert.ok(renewed.attempt.lastHeartbeatAt);

  // Expired UNKNOWN-certainty claim: NEVER requeued — awaiting_reconciliation.
  const expired = store.reapExpiredLeases(NOW + 200_000);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].attempt.status, "expired");
  assert.equal(expired[0].job.status, "awaiting_reconciliation", "unknown certainty never requeues");
  console.log("store: renew fencing + expired-lease honesty semantics");
}
{
  // Fresh store: not-started report then expiry requeues pending.
  const store = newStore();
  const job = store.createJob(jobInput("peer-a"));
  const claim = store.claimNextJob("peer-a", NOW)!;
  store.markNotStarted(claim.attempt.attemptId, claim.attempt.claimToken, "peer-a", NOW);
  const reaped = store.reapExpiredLeases(NOW + 200_000);
  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].job.status, "pending", "affirmative not-started allows requeue on expiry");
  assert.equal(reaped[0].job.jobId, job.jobId);
  console.log("store: markNotStarted enables requeue-on-expiry");
}
{
  // Started attempt expiring goes to awaiting_reconciliation, never requeue.
  const store = newStore();
  const job = store.createJob(jobInput("peer-a"));
  const claim = store.claimNextJob("peer-a", NOW)!;
  store.markStarted(claim.attempt.attemptId, claim.attempt.claimToken, "peer-a", NOW);
  const reaped = store.reapExpiredLeases(NOW + 200_000);
  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].job.status, "awaiting_reconciliation", "started attempt never requeues");
  assert.equal(reaped[0].job.jobId, job.jobId);
  console.log("store: renew fencing + expired-lease honesty semantics");
}

// --- markNotStarted fencing ------------------------------------------------------
{
  const store = newStore();
  store.createJob(jobInput("peer-a"));
  const { attempt } = store.claimNextJob("peer-a", NOW)!;
  // Wrong token fenced.
  assert.throws(() => store.markNotStarted(attempt.attemptId, "f".repeat(64), "peer-a", NOW), (error: unknown) =>
    error instanceof PeerJobError && error.code === "claim_token_mismatch",
  );
  // Wrong peer fenced.
  assert.throws(() => store.markNotStarted(attempt.attemptId, attempt.claimToken, "peer-b", NOW), (error: unknown) =>
    error instanceof PeerJobError && error.code === "attempt_forbidden",
  );
  const marked = store.markNotStarted(attempt.attemptId, attempt.claimToken, "peer-a", NOW);
  assert.equal(marked.attempt.outcomeCertainty, "not_started");
  assert.equal(marked.job.status, "claimed", "not-started report does not itself requeue");
  console.log("store: markNotStarted fenced + honest report");
}

// --- markStarted fencing and lease-expired variants ---------------------------
{
  const store = newStore();
  store.createJob(jobInput("peer-a"));
  const { attempt } = store.claimNextJob("peer-a", NOW)!;
  // Lease expired before markStarted: certainty is unknown → reconcile,
  // never requeue.
  const late = store.markStarted(attempt.attemptId, attempt.claimToken, "peer-a", NOW + 200_000);
  assert.equal(late.job.status, "awaiting_reconciliation");
  assert.equal(store.getAttempt(attempt.attemptId)?.status, "expired");
  console.log("store: markStarted on expired lease expires the attempt and reconciles");
}

// --- canonical manifest paths ---------------------------------------------------
{
  // "./out/a" and "out/a" produce the SAME canonical hash.
  const base = "0123456789abcdef0123456789abcdef01234567";
  const dotted = manifestSha256(base, [{ path: "./out/a", sha256: "a".repeat(64), bytes: 1 }]);
  const plain = manifestSha256(base, [{ path: "out/a", sha256: "a".repeat(64), bytes: 1 }]);
  assert.equal(dotted, plain, "canonical hash over ./out/a equals out/a");
  assert.equal(canonicalizeManifestPath("./out/a"), "out/a");
  assert.equal(canonicalizeManifestPath("out//a"), "out/a");
  assert.throws(() => canonicalizeManifestPath("../evil"), (error: unknown) => error instanceof PeerJobError && error.code === "path_traversal");
  assert.throws(() => canonicalizeManifestPath("/abs"), (error: unknown) => error instanceof PeerJobError && error.code === "path_traversal");
  console.log("store: canonicalizeManifestPath normalizes dot segments; hash is canonical");
}

// --- allowedOutputs enforcement ------------------------------------------------
{
  const store = newStore();
  const job = store.createJob(jobInput("peer-a", { allowedOutputs: ["out/"] }));
  const claim = store.claimNextJob("peer-a", NOW)!;
  store.markStarted(claim.attempt.attemptId, claim.attempt.claimToken, "peer-a", NOW);

  // Prefix violation: "etc/evil" is not covered by "out/".
  assert.throws(
    () => validateResultReceipt(job, claim.attempt, receiptFor(job, claim.attempt.attemptId, { files: [{ path: "etc/evil.txt", sha256: "a".repeat(64), bytes: 1 }] })),
    (error: unknown) => error instanceof PeerJobError && error.code === "output_not_allowed",
  );
  // Entry child OK, exact-entry OK, deeper child OK.
  validateResultReceipt(job, claim.attempt, receiptFor(job, claim.attempt.attemptId, { files: [{ path: "out/report.json", sha256: "a".repeat(64), bytes: 3 }] }));

  // "*" match-all escape.
  const starJob = store.createJob(jobInput("peer-a", { allowedOutputs: ["*"], baseRevision: "2".repeat(40) }));
  const starClaim = store.claimNextJob("peer-a", NOW)!;
  store.markStarted(starClaim.attempt.attemptId, starClaim.attempt.claimToken, "peer-a", NOW);
  validateResultReceipt(starJob, starClaim.attempt, receiptFor(starJob, starClaim.attempt.attemptId, { files: [{ path: "anywhere/anything.bin", sha256: "b".repeat(64), bytes: 2 }] }));

  // Empty allowedOutputs means NO file outputs allowed.
  const emptyJob = store.createJob(jobInput("peer-a", { allowedOutputs: [], baseRevision: "3".repeat(40) }));
  const emptyClaim = store.claimNextJob("peer-a", NOW)!;
  store.markStarted(emptyClaim.attempt.attemptId, emptyClaim.attempt.claimToken, "peer-a", NOW);
  validateResultReceipt(emptyJob, emptyClaim.attempt, receiptFor(emptyJob, emptyClaim.attempt.attemptId, { files: [] }));
  assert.throws(
    () => validateResultReceipt(emptyJob, emptyClaim.attempt, receiptFor(emptyJob, emptyClaim.attempt.attemptId, { files: [{ path: "out/a", sha256: "c".repeat(64), bytes: 1 }] })),
    (error: unknown) => error instanceof PeerJobError && error.code === "output_not_allowed",
  );
  // normalizeAllowedOutputs strips trailing slashes, rejects traversal/absolute.
  assert.deepEqual(normalizeAllowedOutputs(["out/", "reports//x/"]), ["out", "reports/x"]);
  assert.throws(() => normalizeAllowedOutputs(["../evil"]), (error: unknown) => error instanceof PeerJobError && error.code === "path_traversal");
  assert.throws(() => normalizeAllowedOutputs(["/abs"]), (error: unknown) => error instanceof PeerJobError && error.code === "path_traversal");
  console.log("store: allowedOutputs enforced (prefix, *, empty rejects files)");
}

// --- receipt validation --------------------------------------------------------
{
  const store = newStore();
  const job = store.createJob(jobInput("peer-a"));
  const { attempt } = store.claimNextJob("peer-a", NOW)!;
  store.markStarted(attempt.attemptId, attempt.claimToken, "peer-a", NOW);

  const base = receiptFor(job, attempt.attemptId);

  // Identity: receipt.attemptId must equal the attempt being completed.
  assert.throws(
    () => validateResultReceipt(job, attempt, { ...base, attemptId: "att_" + "0".repeat(36) }),
    (error: unknown) => error instanceof PeerJobError && error.code === "attempt_mismatch",
  );
  assert.throws(
    () => validateResultReceipt(job, attempt, { ...base, jobId: "job_other" }),
    (error: unknown) => error instanceof PeerJobError && error.code === "attempt_mismatch",
  );
  // Path traversal: absolute path.
  assert.throws(
    () => validateResultReceipt(job, attempt, { ...base, files: [{ path: "/etc/passwd", sha256: "a".repeat(64), bytes: 1 }], totalBytes: 1 }),
    (error: unknown) => error instanceof PeerJobError && error.code === "path_traversal",
  );
  // Path traversal: ".." segment.
  assert.throws(
    () => validateResultReceipt(job, attempt, { ...base, files: [{ path: "out/../../secret", sha256: "a".repeat(64), bytes: 1 }], totalBytes: 1 }),
    (error: unknown) => error instanceof PeerJobError && error.code === "path_traversal",
  );
  // Backslash path rejected.
  assert.throws(
    () => validateResultReceipt(job, attempt, { ...base, files: [{ path: "out\\evil", sha256: "a".repeat(64), bytes: 1 }], totalBytes: 1 }),
    (error: unknown) => error instanceof PeerJobError && error.code === "path_traversal",
  );
  // Duplicate paths (after normalization).
  assert.throws(
    () =>
      validateResultReceipt(job, attempt, {
        ...base,
        files: [
          { path: "out/a.txt", sha256: "a".repeat(64), bytes: 1 },
          { path: "out//a.txt", sha256: "a".repeat(64), bytes: 1 },
        ],
        totalBytes: 2,
      }),
    (error: unknown) => error instanceof PeerJobError && error.code === "duplicate_manifest_path",
  );
  // Manifest hash mismatch.
  assert.throws(
    () => validateResultReceipt(job, attempt, { ...base, manifestSha256: "b".repeat(64) }),
    (error: unknown) => error instanceof PeerJobError && error.code === "manifest_hash_mismatch",
  );
  // baseRevision mismatch (no silent rebase).
  assert.throws(
    () => validateResultReceipt(job, attempt, { ...base, baseRevision: "ffffffffffffffffffffffffffffffffffffffff" }),
    (error: unknown) => error instanceof PeerJobError && error.code === "base_revision_mismatch",
  );
  // Byte cap exceeded.
  assert.throws(
    () =>
      validateResultReceipt(job, attempt, {
        ...base,
        files: [{ path: "out/big.bin", sha256: "a".repeat(64), bytes: 4096 }],
        totalBytes: 4096,
      }),
    (error: unknown) => error instanceof PeerJobError && error.code === "artifact_bytes_exceeded",
  );
  // totalBytes mismatch.
  assert.throws(
    () =>
      validateResultReceipt(job, attempt, {
        ...base,
        files: [{ path: "out/a.txt", sha256: "a".repeat(64), bytes: 5 }],
        totalBytes: 6,
      }),
    (error: unknown) => error instanceof PeerJobError && error.code === "total_bytes_mismatch",
  );
  // Valid receipt passes (sorted-path canonical manifest is computed here).
  const files = [
    { path: "out/z.txt", sha256: "c".repeat(64), bytes: 3 },
    { path: "out/a.txt", sha256: "a".repeat(64), bytes: 2 },
  ];
  const canonical = canonicalManifestJson(job.baseRevision, files);
  assert.match(canonical, /\[\{"path":"out\/a\.txt"/, "canonical manifest sorts paths");
  validateResultReceipt(job, attempt, receiptFor(job, attempt.attemptId, { files }));
  console.log("store: receipt validation covers identity/traversal/dup/hash/baseRevision/caps");
}

// --- completeAttempt happy path + receipt persistence + real idempotency -------
{
  const store = newStore();
  const job = store.createJob(jobInput("peer-a"));
  const { attempt } = store.claimNextJob("peer-a", NOW)!;
  store.markStarted(attempt.attemptId, attempt.claimToken, "peer-a", NOW);
  const receipt = receiptFor(job, attempt.attemptId);
  const completed = store.completeAttempt(attempt.attemptId, attempt.claimToken, "peer-a", receipt, NOW + 5000);
  assert.equal(completed.job.status, "result_received");
  assert.equal(completed.attempt.status, "completed");
  assert.equal(completed.attempt.outcomeCertainty, "terminal_verified");
  assert.deepEqual(completed.attempt.receipt, receipt, "receipt is persisted on the attempt");

  // Identical duplicate result: idempotent (no throw, flagged).
  const again = store.completeAttempt(attempt.attemptId, attempt.claimToken, "peer-a", receipt, NOW + 6000);
  assert.equal(again.idempotent, true, "identical duplicate result returns the stored outcome");
  assert.equal(again.job.status, "result_received");

  // Conflicting duplicate result: 409-coded error, no silent overwrite.
  const conflicting = { ...receipt, summary: "different" };
  assert.throws(
    () => store.completeAttempt(attempt.attemptId, attempt.claimToken, "peer-a", conflicting, NOW + 7000),
    (error: unknown) => error instanceof PeerJobError && error.code === "conflicting_result" && error.httpStatus === 409,
  );

  // Fence still applies before idempotency: wrong token never sees duplicates.
  assert.throws(
    () => store.completeAttempt(attempt.attemptId, "f".repeat(64), "peer-a", receipt, NOW + 8000),
    (error: unknown) => error instanceof PeerJobError && error.code === "claim_token_mismatch",
  );
  console.log("store: completeAttempt terminal + receipt persisted + real idempotency/conflict");
}

// --- terminalState failed/cancelled mapping -------------------------------------
{
  const store = newStore();
  const jobFail = store.createJob(jobInput("peer-a", { baseRevision: "4".repeat(40) }));
  const claimFail = store.claimNextJob("peer-a", NOW)!;
  store.markStarted(claimFail.attempt.attemptId, claimFail.attempt.claimToken, "peer-a", NOW);
  const doneFail = store.completeAttempt(
    claimFail.attempt.attemptId,
    claimFail.attempt.claimToken,
    "peer-a",
    receiptFor(jobFail, claimFail.attempt.attemptId, { terminalState: "failed", summary: "peer crashed hard" }),
    NOW + 1000,
  );
  assert.equal(doneFail.job.status, "failed");
  assert.ok(doneFail.job.terminalAt);
  assert.match(doneFail.job.terminalReason ?? "", /^peer_reported_failure/);
  assert.match(doneFail.job.terminalReason ?? "", /peer crashed hard/);

  const jobCancel = store.createJob(jobInput("peer-a", { baseRevision: "5".repeat(40) }));
  const claimCancel = store.claimNextJob("peer-a", NOW)!;
  const doneCancel = store.completeAttempt(
    claimCancel.attempt.attemptId,
    claimCancel.attempt.claimToken,
    "peer-a",
    receiptFor(jobCancel, claimCancel.attempt.attemptId, { terminalState: "cancelled", summary: "cancelled by user" }),
    NOW + 1000,
  );
  assert.equal(doneCancel.job.status, "cancelled");
  assert.ok(doneCancel.job.terminalAt);
  assert.match(doneCancel.job.terminalReason ?? "", /^peer_reported_cancelled/);
  assert.match(doneCancel.job.terminalReason ?? "", /cancelled by user/);
  console.log("store: terminalState failed/cancelled mapping with peer_reported_* reasons");
}

// --- failAttempt certainty semantics ------------------------------------------
{
  const store = newStore();
  const jobUnknown = store.createJob(jobInput("peer-a", { baseRevision: "6".repeat(40) }));
  const claimUnknown = store.claimNextJob("peer-a", NOW)!;
  const failedUnknown = store.failAttempt(claimUnknown.attempt.attemptId, claimUnknown.attempt.claimToken, "peer-a", "boom", NOW);
  assert.equal(failedUnknown.job.status, "awaiting_reconciliation", "unknown-certainty failure is never terminal or requeued");

  const jobNotStarted = store.createJob(jobInput("peer-a", { baseRevision: "7".repeat(40) }));
  const claimNotStarted = store.claimNextJob("peer-a", NOW)!;
  store.markNotStarted(claimNotStarted.attempt.attemptId, claimNotStarted.attempt.claimToken, "peer-a", NOW);
  const failedNotStarted = store.failAttempt(claimNotStarted.attempt.attemptId, claimNotStarted.attempt.claimToken, "peer-a", "boom", NOW);
  assert.equal(failedNotStarted.job.status, "pending", "affirmative not-started failure requeues");

  const jobStarted = store.createJob(jobInput("peer-a", { baseRevision: "8".repeat(40) }));
  const claimStarted = store.claimNextJob("peer-a", NOW)!;
  store.markStarted(claimStarted.attempt.attemptId, claimStarted.attempt.claimToken, "peer-a", NOW);
  const failedStarted = store.failAttempt(claimStarted.attempt.attemptId, claimStarted.attempt.claimToken, "peer-a", "boom", NOW);
  assert.equal(failedStarted.job.status, "awaiting_reconciliation", "started failure is uncertain");
  assert.equal(failedStarted.attempt.status, "failed");
  console.log("store: failAttempt certainty semantics (unknown→reconcile, not_started→requeue)");
}

// --- runtime budget: clamp + exceeded ------------------------------------------
{
  const store = newStore();
  const job = store.createJob(jobInput("peer-a", { maxRuntimeMs: 10_000, baseRevision: "9".repeat(40) }));
  const { attempt } = store.claimNextJob("peer-a", NOW)!;
  store.markStarted(attempt.attemptId, attempt.claimToken, "peer-a", NOW);
  // Requested 60s lease at NOW+5s with 10s budget: clamped to 5s remaining.
  const renewed = store.renewLease(attempt.attemptId, attempt.claimToken, "peer-a", NOW + 5_000, 60_000);
  assert.equal(Date.parse(renewed.attempt.leaseExpiresAt), NOW + 10_000, "lease clamped to remaining runtime budget");
  // Exceeded: exhaust the runtime budget → 410; started → awaiting_reconciliation.
  assert.throws(
    () => store.renewLease(attempt.attemptId, attempt.claimToken, "peer-a", NOW + 10_001, 60_000),
    (error: unknown) => error instanceof PeerJobError && error.code === "runtime_budget_exceeded" && error.httpStatus === 410,
  );
  assert.equal(store.getAttempt(attempt.attemptId)?.status, "expired");
  assert.equal(store.getJob(job.jobId)?.status, "awaiting_reconciliation");
  console.log("store: runtime budget clamps lease and expires exhausted attempts with 410");
}

// --- runtime budget covers claims that never report /started --------------------
{
  const store = newStore();
  const job = store.createJob(jobInput("peer-a", { maxRuntimeMs: 10_000, baseRevision: "91".repeat(20) }));
  const { attempt } = store.claimNextJob("peer-a", NOW)!;
  // Claim, then renew WITHOUT ever calling /started: the budget clock is the
  // claim createdAt, so renews cannot extend past maxRuntimeMs.
  assert.equal(attempt.executionStartedAt, undefined);
  const early = store.renewLease(attempt.attemptId, attempt.claimToken, "peer-a", NOW + 4_000, 60_000);
  assert.equal(Date.parse(early.attempt.leaseExpiresAt), NOW + 10_000, "never-started claim lease clamped to the claim-time budget");
  assert.throws(
    () => store.renewLease(attempt.attemptId, attempt.claimToken, "peer-a", NOW + 10_001, 60_000),
    (error: unknown) => error instanceof PeerJobError && error.code === "runtime_budget_exceeded" && error.httpStatus === 410,
  );
  assert.equal(store.getAttempt(attempt.attemptId)?.status, "expired");
  // Certainty is unknown (no started, no affirmative not-started) → reconcile.
  assert.equal(store.getJob(job.jobId)?.status, "awaiting_reconciliation");
  console.log("store: claim-without-start cannot renew indefinitely (claim-time budget clock, unknown → reconcile)");
}

// --- markNotStarted cannot contradict /started -----------------------------------
{
  const store = newStore();
  const job = store.createJob(jobInput("peer-a", { baseRevision: "92".repeat(20) }));
  const { attempt } = store.claimNextJob("peer-a", NOW)!;
  store.markStarted(attempt.attemptId, attempt.claimToken, "peer-a", NOW);
  assert.throws(
    () => store.markNotStarted(attempt.attemptId, attempt.claimToken, "peer-a", NOW + 1000),
    (error: unknown) => error instanceof PeerJobError && error.code === "not_started_after_started" && error.httpStatus === 409,
  );
  assert.equal(store.getAttempt(attempt.attemptId)?.outcomeCertainty, "started", "certainty stays started after a rejected contradiction");
  assert.equal(store.getJob(job.jobId)?.status, "running");
  console.log("store: markNotStarted after /started rejected with 409; certainty unchanged");
}

// --- cancel-ack terminal + unclaimed cancel ------------------------------------
{
  const store = newStore();
  const job = store.createJob(jobInput("peer-a", { baseRevision: "a".repeat(40) }));
  store.requestCancel(job.jobId, NOW);
  const { attempt } = store.claimNextJob("peer-a", NOW)!;
  const acked = store.cancelAck(attempt.attemptId, attempt.claimToken, "peer-a", NOW + 1000);
  assert.equal(acked.job.status, "cancelled");
  assert.equal(acked.attempt.status, "failed");
  assert.equal(acked.job.terminalReason, "cancel_acknowledged");

  const job2 = store.createJob(jobInput("peer-a", { baseRevision: "b".repeat(40) }));
  store.requestCancel(job2.jobId, NOW);
  const cancelled2 = store.cancelUnclaimedJob(job2.jobId, NOW + 1000);
  assert.equal(cancelled2.status, "cancelled", "job with cancelRequestedAt and no active attempt cancels");
  console.log("store: cancel-ack terminal + unclaimed cancel");
}

// --- instructions durability + legacy sidecar tolerance --------------------------
{
  const stateDir = mkdtempSync(join(tmpdir(), "peer-jobs-instructions-"));
  const store = openPeerJobStore(stateDir, logging);
  const job = store.createJob(jobInput("peer-a", { instructions: "say the nonce potato", baseRevision: "c".repeat(40) }));
  store.close();

  const reopened = openPeerJobStore(stateDir, logging);
  assert.equal(reopened.getJob(job.jobId)?.instructions, "say the nonce potato", "instructions round-trip through the sidecar");
  reopened.close();

  // Legacy sidecar job without instructions tolerates open with "" default.
  const legacyStateDir = mkdtempSync(join(tmpdir(), "peer-jobs-legacy-"));
  const legacy = openPeerJobStore(legacyStateDir, logging);
  const legacyJob = legacy.createJob(jobInput("peer-a", { baseRevision: "d".repeat(40) }));
  legacy.close();
  const raw = JSON.parse(readFileSync(join(legacyStateDir, "peer-jobs.json"), "utf8")) as { jobs: Array<Record<string, unknown>> };
  for (const jobRecord of raw.jobs) delete jobRecord.instructions;
  writeFileSync(join(legacyStateDir, "peer-jobs.json"), JSON.stringify(raw));
  const legacyReopened = openPeerJobStore(legacyStateDir, logging);
  const restored = legacyReopened.getJob(legacyJob.jobId);
  assert.ok(restored);
  assert.equal(restored.instructions, "", "legacy sidecar job without instructions defaults to empty");
  legacyReopened.close();
  console.log("store: instructions durability + legacy sidecar tolerance");
}

// --- restartReconciliation ------------------------------------------------------
{
  const stateDir = mkdtempSync(join(tmpdir(), "peer-jobs-restart-"));
  const store = openPeerJobStore(stateDir, logging);
  const job = store.createJob(jobInput("peer-a", { baseRevision: "e".repeat(40) }));
  const { attempt } = store.claimNextJob("peer-a", NOW)!;
  store.markStarted(attempt.attemptId, attempt.claimToken, "peer-a", NOW);
  void job;
  store.close();

  // Reopen: durable sidecar restores state; reconciliation flags the
  // running job with no active attempt as awaiting_reconciliation.
  const reopened = openPeerJobStore(stateDir, logging);
  const restoredJobs = reopened.listJobsForPeer("peer-a", { includeTerminal: true });
  const restored = restoredJobs[0];
  assert.ok(restored, "durable sidecar restores job state");
  assert.equal(restored.status, "awaiting_reconciliation", "claimed/running job with no active attempt reconciles on boot");
  reopened.close();
  console.log("store: restartReconciliation after durable reload");
}

console.log("src/peer/jobs/store.test.ts: all assertions passed");
