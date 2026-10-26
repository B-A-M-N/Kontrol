/**
 * M5 tests for src/peer/peer-tools.ts (list_peer_status): role gating,
 * secret exclusion, honest labels, peerId filtering, disabled config.
 * Style: plain tsx script with node:assert/strict, fakeServer harness like
 * src/bridge-flow.test.ts.
 */
import assert from "node:assert/strict";
import { registerPeerStatusTool } from "./peer-tools.js";
import type { PeerStatusToolDeps } from "./peer-tools.js";
import type { PeerDescriptor } from "./config-types.js";
import type { PeerJob, PeerAttempt, PeerJobResultReceipt } from "./jobs/contracts.js";

function fakeServer(): {
  registerTool: (n: string, c: unknown, h: (a: any) => any) => undefined;
  handlers: Map<string, (a: any) => any>;
  configs: Map<string, any>;
} {
  const handlers = new Map<string, (a: any) => any>();
  const configs = new Map<string, any>();
  return {
    registerTool: (name, cfg, handler) => {
      configs.set(name, cfg);
      handlers.set(name, handler);
    },
    handlers,
    configs,
  };
}

const descriptor: PeerDescriptor = {
  id: "meta-muse",
  credentialId: "v1",
  credentialHash: "a".repeat(64),
  capabilities: ["workspace:inspect", "job:claim"],
  grantedRoots: ["/home/you/projects/demo"],
};

function jobFixture(overrides: Partial<PeerJob>): PeerJob {
  return {
    jobId: "job_a",
    peerId: "meta-muse",
    workspaceSessionId: "ws_test",
    workSessionId: "wsess_test",
    repositoryId: "/repo",
    baseRevision: "0".repeat(40),
    taskClass: "read_only_audit",
    instructionHash: "h",
    instructions: "SECRET-INSTRUCTION-BODY",
    allowedOutputs: ["out"],
    maxRuntimeMs: 1000,
    maxArtifactBytes: 100,
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function attemptFixture(overrides: Partial<PeerAttempt>): PeerAttempt {
  return {
    attemptId: "att_a",
    jobId: "job_a",
    claimToken: "0".repeat(64),
    claimOwnerPeerId: "meta-muse",
    generation: 1,
    createdAt: "2026-01-01T00:00:01.000Z",
    leaseExpiresAt: "2026-01-01T00:01:01.000Z",
    outcomeCertainty: "unknown",
    status: "active",
    ...overrides,
  };
}

function receiptFixture(attemptId: string): PeerJobResultReceipt {
  return {
    jobId: "job_a",
    attemptId,
    actorClass: "muse_vm_process",
    baseRevision: "0".repeat(40),
    manifestSha256: "m",
    files: [],
    totalBytes: 0,
    terminalState: "succeeded",
  };
}

interface StoreFixture {
  stateDir: string;
  jobsByPeer: Map<string, PeerJob[]>;
  attemptsByJob: Map<string, PeerAttempt[]>;
  pageLimits: number[];
  attemptReads: number;
  listJobsForPeer: (peerId: string, opts?: { includeTerminal?: boolean }) => PeerJob[];
  listJobsForPeerPage: (peerId: string, input: { includeTerminal?: boolean; after?: { createdAt: string; jobId: string }; limit: number }) => PeerJob[];
  getAttemptSummaryForJob: (jobId: string) => { latest?: PeerAttempt; latestReceipt?: PeerAttempt };
  listAttemptsForJob: (jobId: string) => PeerAttempt[];
}

function storeFixture(jobs: PeerJob[], attempts: PeerAttempt[]): StoreFixture {
  const jobsByPeer = new Map<string, PeerJob[]>();
  for (const job of jobs) {
    jobsByPeer.set(job.peerId, [...(jobsByPeer.get(job.peerId) ?? []), job]);
  }
  const attemptsByJob = new Map<string, PeerAttempt[]>();
  for (const attempt of attempts) {
    attemptsByJob.set(attempt.jobId, [...(attemptsByJob.get(attempt.jobId) ?? []), attempt]);
  }
  const pageLimits: number[] = [];
  let attemptReads = 0;
  return {
    stateDir: "/tmp/fixture",
    jobsByPeer,
    attemptsByJob,
    pageLimits,
    get attemptReads() { return attemptReads; },
    listJobsForPeer: (peerId) => jobsByPeer.get(peerId) ?? [],
    listJobsForPeerPage: (peerId, input) => {
      pageLimits.push(input.limit);
      return (jobsByPeer.get(peerId) ?? [])
        .filter((job) => !input.after || job.createdAt > input.after.createdAt
          || (job.createdAt === input.after.createdAt && job.jobId > input.after.jobId))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId))
        .slice(0, input.limit);
    },
    getAttemptSummaryForJob: (jobId) => {
      attemptReads += 1;
      const attempts = attemptsByJob.get(jobId) ?? [];
      return {
        latest: [...attempts].sort((a, b) => b.generation - a.generation)[0],
        latestReceipt: [...attempts].filter((attempt) => attempt.receipt !== undefined).sort((a, b) => b.generation - a.generation)[0],
      };
    },
    listAttemptsForJob: (jobId) => (attemptsByJob.get(jobId) ?? []).map((attempt) => ({ ...attempt })),
  };
}

function deps(overrides: Partial<PeerStatusToolDeps> & { principalRole: PeerStatusToolDeps["principalRole"] }): PeerStatusToolDeps {
  return { config: { peer: undefined }, store: undefined, ...overrides };
}

function register(d: PeerStatusToolDeps) {
  const server = fakeServer();
  registerPeerStatusTool(server as any, d);
  return server.handlers.get("list_peer_status")!;
}

function registerTool(d: PeerStatusToolDeps, name: string) {
  const server = fakeServer();
  registerPeerStatusTool(server as any, d);
  return server.handlers.get(name)!;
}

// --- (a) owner (client) role, full output with injected store fixture ---------
{
  const jobPending = jobFixture({ jobId: "job_pending", status: "pending" });
  const jobAwaiting = jobFixture({ jobId: "job_awaiting", status: "awaiting_reconciliation", cancelRequestedAt: "2026-01-01T00:00:02.000Z" });
  const attemptWithReceipt = attemptFixture({
    jobId: "job_awaiting",
    attemptId: "att_receipt",
    generation: 2,
    status: "completed",
    outcomeCertainty: "terminal_verified",
    receipt: receiptFixture("att_receipt"),
  });
  const attemptExpired = attemptFixture({ jobId: "job_awaiting", attemptId: "att_expired", generation: 1, status: "expired" });
  const store = storeFixture([jobPending, jobAwaiting], [attemptExpired, attemptWithReceipt]);
  const handler = register(deps({ principalRole: "client", config: { peer: { enabled: true, bindHost: "127.0.0.1", port: 7677, credentialFile: "/x", maxActiveSessions: 1, maxClaimedJobs: 1, requestBytesLimit: 1, allowedPeers: [descriptor] } as any }, store: store as any }));
  const result = await handler({});
  assert.ok(!result.isError, JSON.stringify(result));
  const out = result.structuredContent;
  assert.equal(out.peer.enabled, true);
  assert.equal(out.peer.bindHost, "127.0.0.1");
  assert.equal(out.peer.port, 7677);
  assert.equal(out.peers.length, 1);
  assert.deepEqual(out.peers[0], { id: "meta-muse", credentialId: "v1", capabilities: ["workspace:inspect", "job:claim"], grantedRoots: ["/home/you/projects/demo"] });
  assert.equal((out.peers[0] as Record<string, unknown>).credentialHash, undefined, "credentialHash must never appear");
  assert.equal(out.jobs.length, 2);
  const pendingRow = out.jobs.find((job: any) => job.jobId === "job_pending");
  const awaitingRow = out.jobs.find((job: any) => job.jobId === "job_awaiting");
  assert.equal(pendingRow.displayHint, "awaiting_peer_poll (requires Muse-side pickup)");
  assert.equal(pendingRow.actorClass, undefined);
  assert.equal(awaitingRow.displayHint, "requires_owner_reconciliation");
  assert.equal(awaitingRow.actorClass, "muse_vm_process", "actorClass from newest receipt");
  assert.equal(awaitingRow.outcomeCertainty, "terminal_verified", "certainty from latest attempt");
  assert.equal(awaitingRow.cancelRequestedAt, "2026-01-01T00:00:02.000Z", "owner projection exposes the durable cancellation request time");
  assert.equal(out.counts.pending, 1);
  assert.equal(out.counts.awaitingReconciliation, 1);
  assert.equal(out.counts.staging, 0, "staging counted explicitly (0 today)");
  assert.equal(out.counts.awaitingReview, 0, "awaiting_review counted explicitly (0 today)");
  assert.match(result.content[0].text, /Peer listener: enabled; 1 enrolled peer\(s\); 2 active job\(s\) in this page\./);
}

// --- bounded stable pagination ------------------------------------------------
{
  const jobs = Array.from({ length: 45 }, (_, index) => jobFixture({
    jobId: `job_page_${String(index).padStart(2, "0")}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));
  const fixture = storeFixture(jobs, []);
  const pagedHandler = register(deps({
    principalRole: "client",
    config: { peer: { enabled: true, bindHost: "127.0.0.1", port: 7677, credentialFile: "/x", maxActiveSessions: 1, maxClaimedJobs: 1, requestBytesLimit: 1, allowedPeers: [descriptor] } as any },
    store: fixture as any,
  }));
  const first = await pagedHandler({ limit: 20 });
  assert.equal(first.structuredContent.jobs.length, 20);
  assert.equal(first.structuredContent.pageSize, 20);
  assert.equal(typeof first.structuredContent.nextCursor, "string");
  assert.deepEqual(fixture.pageLimits, [21], "the status tool asks the store for a bounded SQL page plus one lookahead row");
  assert.equal(fixture.attemptReads, 20, "the status tool fetches one bounded latest-attempt summary per returned row");
  const second = await pagedHandler({ limit: 20, cursor: first.structuredContent.nextCursor });
  assert.equal(second.structuredContent.jobs.length, 20);
  assert.equal(second.structuredContent.jobs[0].jobId, "job_page_20");
  assert.notEqual(second.structuredContent.nextCursor, first.structuredContent.nextCursor);
  const third = await pagedHandler({ limit: 20, cursor: second.structuredContent.nextCursor });
  assert.equal(third.structuredContent.jobs.length, 5);
  assert.equal(third.structuredContent.nextCursor, undefined);
  assert.equal((await pagedHandler({ cursor: "not-a-cursor" })).isError, true);
}

// --- (b) reviewer role allowed -------------------------------------------------
{
  const handler = register(deps({ principalRole: "reviewer" }));
  const result = await handler({});
  assert.ok(!result.isError, "reviewer may call list_peer_status");
  assert.deepEqual(result.structuredContent.peer, { enabled: false });
}

// --- (c) peer role denied; worker role denied ----------------------------------
for (const role of ["peer", "worker"] as const) {
  const handler = register(deps({ principalRole: role }));
  const result = await handler({});
  assert.ok(result.isError, `${role} must be denied`);
  assert.match(result.content[0].text, /Forbidden: list_peer_status requires owner or reviewer authority\./);
  const retry = await registerTool(deps({ principalRole: role }), "reconcile_peer_job_result")({ jobId: "job_a", expectedFailure: "temporary" });
  assert.equal(retry.isError, true, `${role} cannot reconcile a peer result`);
}

// --- owner-only local result recovery ---------------------------------------
{
  const job = jobFixture({
    jobId: "job_reconcile",
    status: "awaiting_reconciliation",
    resultProcessing: { failure: "artifact_temporary_conflict", retryRevision: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
  });
  const attempt = attemptFixture({
    jobId: job.jobId,
    attemptId: "att_reconcile",
    status: "completed",
    outcomeCertainty: "terminal_verified",
    receipt: receiptFixture("att_reconcile"),
  });
  const fixture = storeFixture([job], [attempt]);
  const enqueued: Array<Record<string, unknown>> = [];
  const handler = registerTool(deps({
    principalRole: "client",
    store: {
      ...fixture,
      retryResultProcessing: (jobId: string, expectedFailure: string) => {
        assert.equal(jobId, job.jobId);
        assert.equal(expectedFailure, "artifact_temporary_conflict");
        return { ...job, status: "result_received", resultProcessing: { retryRevision: 1, updatedAt: "2026-01-01T00:00:01.000Z" } };
      },
    } as any,
    dispatchOutbox: { enqueue: (event: Record<string, unknown>) => { enqueued.push(event); } } as any,
  }), "reconcile_peer_job_result");
  const result = await handler({ jobId: job.jobId, expectedFailure: "artifact_temporary_conflict", clientMutationId: "retry-once" });
  assert.equal(result.structuredContent.retryRevision, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].eventType, "peer_job.result_retry");
  assert.equal(enqueued[0].aggregateId, job.jobId);
  assert.equal(enqueued[0].aggregateRevision, 1);
  assert.deepEqual(enqueued[0].payload, { jobId: job.jobId, attemptId: attempt.attemptId, generation: attempt.generation, retryRevision: 1 });
}

// --- (d) disabled config --------------------------------------------------------
{
  const handler = register(deps({ principalRole: "client" }));
  const result = await handler({});
  assert.ok(!result.isError);
  assert.deepEqual(result.structuredContent.peer, { enabled: false });
  assert.deepEqual(result.structuredContent.peers, []);
  assert.deepEqual(result.structuredContent.jobs, []);
  assert.deepEqual(result.structuredContent.counts, { pending: 0, claimed: 0, running: 0, awaitingReconciliation: 0, resultReceived: 0, staging: 0, awaitingReview: 0, terminal: 0 });
}

// --- (e) deep scan: no secrets anywhere in the JSON ----------------------------
{
  const job = jobFixture({ status: "result_received" });
  const attempt = attemptFixture({ status: "completed", outcomeCertainty: "terminal_verified", receipt: receiptFixture("att_a") });
  const store = storeFixture([job], [attempt]);
  const handler = register(deps({ principalRole: "client", config: { peer: { enabled: true, bindHost: "127.0.0.1", port: 7677, credentialFile: "/x", maxActiveSessions: 1, maxClaimedJobs: 1, requestBytesLimit: 1, allowedPeers: [descriptor] } as any }, store: store as any }));
  const result = await handler({});
  const json = JSON.stringify(result);
  assert.ok(!json.includes("claimToken"), "no claimToken key");
  assert.ok(!json.includes("0".repeat(64)), "no raw claim token bytes");
  assert.ok(!json.includes("credentialHash"), "no credentialHash key");
  assert.ok(!json.includes("a".repeat(64)), "no credential hash bytes");
  assert.ok(!json.includes("SECRET-INSTRUCTION-BODY"), "no raw instructions");
}

// --- (f) peerId filter + unknown peerId error ----------------------------------
{
  const otherDescriptor: PeerDescriptor = { ...descriptor, id: "other-peer", credentialId: "v2" };
  const jobA = jobFixture({ jobId: "job_a", peerId: "meta-muse" });
  const jobB = jobFixture({ jobId: "job_b", peerId: "other-peer" });
  const store = storeFixture([jobA, jobB], []);
  const handler = register(deps({
    principalRole: "client",
    config: { peer: { enabled: true, bindHost: "127.0.0.1", port: 7677, credentialFile: "/x", maxActiveSessions: 1, maxClaimedJobs: 1, requestBytesLimit: 1, allowedPeers: [descriptor, otherDescriptor] } as any },
    store: store as any,
  }));
  const filtered = await handler({ peerId: "other-peer" });
  assert.equal(filtered.structuredContent.jobs.length, 1);
  assert.equal(filtered.structuredContent.jobs[0].peerId, "other-peer");
  const unknown = await handler({ peerId: "not-enrolled" });
  assert.ok(unknown.isError, "unknown peerId must error");
  assert.match(unknown.content[0].text, /unknown peerId/);
}

// --- (g) displayHint + honest notes --------------------------------------------
{
  const job = jobFixture({ jobId: "job_rr", status: "result_received" });
  const store = storeFixture([job], []);
  const handler = register(deps({ principalRole: "client", config: { peer: { enabled: true, bindHost: "127.0.0.1", port: 7677, credentialFile: "/x", maxActiveSessions: 1, maxClaimedJobs: 1, requestBytesLimit: 1, allowedPeers: [descriptor] } as any }, store: store as any }));
  const result = await handler({});
  const out = result.structuredContent;
  assert.equal(out.jobs[0].displayHint, "receipt accepted; result processing has not completed");
  const notes = out.notes.join("\n");
  assert.match(notes, /actorClass reflects only what the peer reported; muse_vm_process results are never evidence of hosted-Muse-agent \(C3\) execution/);
  assert.match(notes, /peer delivery alone approves nothing\./);
  assert.match(notes, /registry-authoritative — the operator-owned credential registry JSON file that the KONTROL_PEER_CREDENTIAL_FILE environment variable names — and hot-reloads/);
}

// --- read-only registration metadata -------------------------------------------
{
  const server = fakeServer();
  registerPeerStatusTool(server as any, deps({ principalRole: "client" }));
  assert.equal(server.configs.get("list_peer_status").annotations.readOnlyHint, true);
  assert.equal(server.configs.get("list_peer_status").title, "List peer status");
  assert.equal(server.configs.get("reconcile_peer_job_result").annotations.readOnlyHint, false);
  assert.equal(server.configs.get("cancel_peer_job").annotations.destructiveHint, true);
}

// --- owner cancellation is durable and releases only an unclaimed reservation --
{
  const pending = jobFixture({ jobId: "job_cancel_pending", status: "pending", workSessionId: "wsess_pending" });
  const running = jobFixture({ jobId: "job_cancel_running", status: "running", workSessionId: "wsess_running" });
  const jobs = new Map([[pending.jobId, pending], [running.jobId, running]]);
  const released: Array<{ workSessionId: string; nonce: string }> = [];
  const reservation = { leaseKind: "peer_job", ownerInstanceId: `peer-job:${pending.jobId}`, leaseNonce: "nonce_pending" };
  const handler = registerTool(deps({
    principalRole: "client",
    store: {
      getJob: (jobId: string) => jobs.get(jobId),
      cancelUnclaimedJob: (jobId: string, now: number) => {
        const job = jobs.get(jobId)!;
        const updated = { ...job, status: "cancelled", terminalAt: new Date(now).toISOString(), terminalReason: "cancel_requested_unclaimed" } as PeerJob;
        jobs.set(jobId, updated);
        return updated;
      },
      requestCancel: (jobId: string, now: number) => {
        const updated = { ...jobs.get(jobId)!, cancelRequestedAt: new Date(now).toISOString() };
        jobs.set(jobId, updated);
        return updated;
      },
    } as any,
    workSessions: {
      getWorkspaceLeaseForSession: (workSessionId: string) => workSessionId === "wsess_pending" ? reservation : undefined,
      releaseWorkspaceLeaseForSession: (workSessionId: string, nonce: string) => { released.push({ workSessionId, nonce }); return true; },
    } as any,
    now: () => Date.parse("2026-01-02T00:00:00.000Z"),
  }), "cancel_peer_job");
  const cancelled = await handler({ jobId: pending.jobId });
  assert.equal(cancelled.structuredContent.status, "cancelled");
  assert.deepEqual(released, [{ workSessionId: "wsess_pending", nonce: "nonce_pending" }]);
  const requested = await handler({ jobId: running.jobId });
  assert.equal(requested.structuredContent.status, "running");
  assert.equal(requested.structuredContent.cancelRequestedAt, "2026-01-02T00:00:00.000Z");
  assert.match(requested.structuredContent.message, /stays fenced/);

  const peerHandler = registerTool(deps({ principalRole: "peer", store: {} as any }), "cancel_peer_job");
  assert.equal((await peerHandler({ jobId: pending.jobId })).isError, true, "peer role cannot invoke owner cancellation");
}

console.log("peer-tools: all assertions passed");
