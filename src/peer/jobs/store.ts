/**
 * M3 peer job store: single-process authoritative in-memory state with a
 * DURABLE sidecar. Every state transition appends the full snapshot to
 * stateDir/peer-jobs.json via atomic temp-write+rename; the store is loaded
 * at open and a corrupt/missing file starts empty (logged, never fatal).
 *
 * Store lifecycle binds to the process (module-level singleton opened on the
 * first registerPeerJobRoutes call); the durable sidecar makes restart safe.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoggingConfig } from "../../logger.js";
import { logEvent } from "../../logger.js";
import { PeerJobError } from "./contracts.js";
import { normalizeAllowedOutputs } from "./service.js";
import type {
  PeerAttempt,
  PeerJob,
  PeerJobResultReceipt,
} from "./contracts.js";

const SIDECAR_FILE = "peer-jobs.json";
const LEASE_MS = 60_000;

interface PeerJobStoreSnapshot {
  version: 1;
  jobs: PeerJob[];
  attempts: PeerAttempt[];
}

interface StoreLogSink {
  log(level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>): void;
}

function loggingSink(logging: LoggingConfig): StoreLogSink {
  return {
    log(level, event, fields = {}) {
      logEvent({ ...logging, format: "json", requests: false, assets: false, toolCalls: false, shellCommands: false } as LoggingConfig, level, event, fields);
    },
  };
}

export interface PeerJobStore {
  readonly stateDir: string;
  createJob(input: Omit<PeerJob, "jobId" | "status" | "createdAt"> & { peerId: string }): PeerJob;
  getJob(jobId: string): PeerJob | undefined;
  listJobsForPeer(peerId: string, opts?: { includeTerminal?: boolean }): PeerJob[];
  getAttempt(attemptId: string): PeerAttempt | undefined;
  /** Read-only projection: shallow copy of the attempts for a job, newest last. Never hands out live mutable internals. */
  listAttemptsForJob(jobId: string): PeerAttempt[];
  claimNextJob(peerId: string, now: number, opts?: { taskClass?: string }): { job: PeerJob; attempt: PeerAttempt } | undefined;
  markStarted(attemptId: string, claimToken: string, peerId: string, now: number, remoteExecutionId?: string): { job: PeerJob; attempt: PeerAttempt };
  /** Peer affirmatively reports it never began the claimed attempt (fenced). */
  markNotStarted(attemptId: string, claimToken: string, peerId: string, now: number): { job: PeerJob; attempt: PeerAttempt };
  renewLease(attemptId: string, claimToken: string, peerId: string, now: number, leaseMs: number): { job: PeerJob; attempt: PeerAttempt };
  completeAttempt(attemptId: string, claimToken: string, peerId: string, receipt: PeerJobResultReceipt, now: number): { job: PeerJob; attempt: PeerAttempt; idempotent: boolean };
  failAttempt(attemptId: string, claimToken: string, peerId: string, reason: string, now: number): { job: PeerJob; attempt: PeerAttempt };
  requestCancel(jobId: string, now: number): PeerJob;
  cancelAck(attemptId: string, claimToken: string, peerId: string, now: number): { job: PeerJob; attempt: PeerAttempt };
  cancelUnclaimedJob(jobId: string, now: number): PeerJob;
  reapExpiredLeases(now: number, limit?: number): Array<{ job: PeerJob; attempt: PeerAttempt }>;
  restartReconciliation(): void;
  close(): void;
}

function isTerminalJobStatus(status: PeerJob["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Deterministic JSON (sorted keys, undefined dropped) for receipt comparison. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, fieldValue]) => fieldValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + entries.map(([key, fieldValue]) => JSON.stringify(key) + ":" + canonicalJson(fieldValue)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function assertActiveAttemptForFence(attempt: PeerAttempt, now: number): void {
  if (attempt.status !== "active") {
    throw new PeerJobError("attempt_not_active", `Attempt ${attempt.attemptId} is not active (status ${attempt.status})`);
  }
  if (Date.parse(attempt.leaseExpiresAt) <= now) {
    throw new PeerJobError("lease_expired", `Attempt ${attempt.attemptId} lease expired at ${attempt.leaseExpiresAt}`);
  }
}

export function openPeerJobStore(stateDir: string, logging: LoggingConfig): PeerJobStore {
  const sink = loggingSink(logging);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const sidecarPath = join(stateDir, SIDECAR_FILE);

  let stateCorrupted = false;
  let snapshot: PeerJobStoreSnapshot = { version: 1, jobs: [], attempts: [] };
  if (existsSync(sidecarPath)) {
    try {
      const parsed = JSON.parse(readFileSync(sidecarPath, "utf8")) as PeerJobStoreSnapshot;
      if (parsed.version !== 1 || !Array.isArray(parsed.jobs) || !Array.isArray(parsed.attempts)) {
        throw new Error("unexpected sidecar structure");
      }
      // Legacy sidecar attempts predate the createdAt field: treat the
      // attempt's lease start as the budget clock so old records get a sane
      // clock (no version bump needed).
      snapshot = {
        version: 1,
        jobs: parsed.jobs.map((job) => ({ ...job, instructions: typeof job.instructions === "string" ? job.instructions : "" })),
        attempts: parsed.attempts.map((attempt) => ({
          ...attempt,
          createdAt: typeof attempt.createdAt === "string" ? attempt.createdAt : new Date(Date.parse(attempt.leaseExpiresAt) - LEASE_MS).toISOString(),
        })),
      };
    } catch (error) {
      // An existing unreadable/corrupt sidecar is authoritative evidence that
      // may contain uncertain work. Never reset it to an empty queue: fail
      // closed and require operator recovery.
      const corruptPath = sidecarPath + ".corrupt." + new Date().toISOString().replace(/[:.]/g, "-");
      try {
        renameSync(sidecarPath, corruptPath);
        sink.log("error", "peer_jobs_sidecar_quarantined", { path: corruptPath, error: (error as Error).message });
      } catch {
        sink.log("error", "peer_jobs_sidecar_corrupt", { path: sidecarPath, error: (error as Error).message });
      }
      stateCorrupted = true;
      throw new PeerJobError("peer_jobs_state_corrupt", "Existing peer-job state is unreadable; dispatch is refused to preserve prior evidence.", 503);
    }
  }

  let jobs = snapshot.jobs;
  let attempts = snapshot.attempts;

  let warnedDirFsyncUnavailable = false;

  function persist(): void {
    if (stateCorrupted) throw new PeerJobError("peer_jobs_state_corrupt", "Peer-job state is corrupt; persistence is refused.", 503);
    const payload = JSON.stringify({ version: 1 as const, jobs, attempts });
    const tempPath = sidecarPath + ".tmp." + randomBytes(4).toString("hex");
    // Atomic durable write: mode-0600 temp file, fsync the file BEFORE the
    // rename, then a best-effort directory fsync (some platforms reject
    // directory fsync — warn once and continue; the rename is still atomic).
    const fd = openSync(tempPath, "w", 0o600);
    try {
      writeFileSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, sidecarPath);
    try {
      const dirFd = openSync(stateDir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (error) {
      if (!warnedDirFsyncUnavailable) {
        warnedDirFsyncUnavailable = true;
        sink.log("warn", "peer_jobs_dir_fsync_unavailable", { path: stateDir, error: (error as Error).message });
      }
    }
  }

  function jobOrThrow(jobId: string): PeerJob {
    const job = jobs.find((candidate) => candidate.jobId === jobId);
    if (!job) throw new PeerJobError("job_not_found", `Job ${jobId} not found`, 404);
    return job;
  }

  function fencedAttempt(jobId: string, attemptId: string, claimToken: string, peerId: string): PeerAttempt {
    const job = jobOrThrow(jobId);
    const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
    if (!attempt || attempt.jobId !== job.jobId) {
      throw new PeerJobError("attempt_not_found", `Attempt ${attemptId} not found for job ${jobId}`, 404);
    }
    // Fence: exact peer + token + generation. claimOwnerPeerId is trusted
    // server state; a peer can never touch another peer's attempt.
    if (attempt.claimOwnerPeerId !== peerId) {
      throw new PeerJobError("attempt_forbidden", "Attempt does not belong to this peer", 403);
    }
    if (attempt.claimToken !== claimToken) {
      throw new PeerJobError("claim_token_mismatch", "claimToken does not match the active attempt");
    }
    if (attempt.generation !== jobGeneration(job)) {
      throw new PeerJobError("stale_generation", `Attempt generation ${attempt.generation} is stale`);
    }
    return attempt;
  }

  function jobGeneration(job: PeerJob): number {
    // Generation counts claim cycles for this job.
    return attempts.filter((candidate) => candidate.jobId === job.jobId).length;
  }

  function requeueJobAfterExpiredAttempt(job: PeerJob, attempt: PeerAttempt, now: number): void {
    attempt.status = "expired";
    // Never requeue a job whose prior attempt may have executed.
    if (attempt.outcomeCertainty === "not_started") {
      job.status = "pending";
    } else {
      job.status = "awaiting_reconciliation";
    }
    void now;
  }

  const store: PeerJobStore = {
    stateDir,

    createJob(input) {
      if (stateCorrupted) {
        throw new PeerJobError("peer_jobs_state_corrupt", "Peer-job state is corrupt; dispatch is refused.", 503);
      }
      // Normalize allowedOutputs at creation so every later receipt
      // validation sees canonical relative prefixes ("out/" → "out").
      const job: PeerJob = {
        ...input,
        allowedOutputs: normalizeAllowedOutputs(input.allowedOutputs),
        jobId: "job_" + randomUUID(),
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      jobs.push(job);
      persist();
      return job;
    },

    getJob(jobId) {
      return jobs.find((candidate) => candidate.jobId === jobId);
    },

    listJobsForPeer(peerId, opts) {
      const includeTerminal = opts?.includeTerminal ?? false;
      return jobs.filter(
        (job) => job.peerId === peerId && (includeTerminal || !isTerminalJobStatus(job.status)),
      ).map((job) => ({ ...job }));
    },

    getAttempt(attemptId) {
      return attempts.find((candidate) => candidate.attemptId === attemptId);
    },

    listAttemptsForJob(jobId) {
      return attempts
        .filter((candidate) => candidate.jobId === jobId)
        .map((attempt) => ({ ...attempt, receipt: attempt.receipt ? { ...attempt.receipt } : undefined }));
    },

    claimNextJob(peerId, now, opts) {
      // CAS semantics: claim only from "pending"; peer-scoped — a job is
      // served exclusively to the peer it was assigned to.
      const taskClassFilter = opts?.taskClass;
      const job = jobs
        .filter(
          (candidate) =>
            candidate.peerId === peerId &&
            candidate.status === "pending" &&
            (taskClassFilter === undefined || candidate.taskClass === taskClassFilter),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId))[0];
      if (!job) return undefined;

      const attempt: PeerAttempt = {
        attemptId: "att_" + randomUUID(),
        jobId: job.jobId,
        claimToken: randomBytes(32).toString("hex"),
        claimOwnerPeerId: peerId,
        generation: jobGeneration(job) + 1,
        createdAt: new Date(now).toISOString(),
        leaseExpiresAt: new Date(now + LEASE_MS).toISOString(),
        // Honesty contract: a claim is NOT evidence the peer began work. It
        // stays "unknown" until the peer reports started — or affirmatively
        // reports not-started via markNotStarted — so an unconfirmed claim
        // can never be silently requeued and re-executed.
        outcomeCertainty: "unknown",
        status: "active",
      };
      job.status = "claimed";
      attempts.push(attempt);
      persist();
      return { job, attempt };
    },

    markStarted(attemptId, claimToken, peerId, now, remoteExecutionId) {
      const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
      if (!attempt) throw new PeerJobError("attempt_not_found", `Attempt ${attemptId} not found`, 404);
      const job = jobOrThrow(attempt.jobId);
      fencedAttempt(job.jobId, attemptId, claimToken, peerId);
      if (attempt.status !== "active") {
        throw new PeerJobError("attempt_not_active", `Attempt ${attemptId} is not active (status ${attempt.status})`);
      }
      if (Date.parse(attempt.leaseExpiresAt) <= now) {
        // Lease expired before start: attempt expires; never requeue a job
        // whose prior attempt may have executed (claim certainty "unknown"
        // at best — only an affirmative markNotStarted allows requeue).
        attempt.status = "expired";
        job.status = attempt.outcomeCertainty === "not_started" ? "pending" : "awaiting_reconciliation";
        persist();
        return { job, attempt };
      }
      attempt.executionStartedAt = new Date(now).toISOString();
      attempt.remoteExecutionId = remoteExecutionId;
      attempt.outcomeCertainty = "started";
      job.status = "running";
      persist();
      return { job, attempt };
    },

    markNotStarted(attemptId, claimToken, peerId, now) {
      const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
      if (!attempt) throw new PeerJobError("attempt_not_found", `Attempt ${attemptId} not found`, 404);
      const job = jobOrThrow(attempt.jobId);
      fencedAttempt(job.jobId, attemptId, claimToken, peerId);
      assertActiveAttemptForFence(attempt, now);
      // No contradiction: once the peer declared /started, it cannot flip
      // certainty back to not_started (that would re-expose possibly-executed
      // work to requeue).
      if (attempt.executionStartedAt !== undefined) {
        throw new PeerJobError("not_started_after_started", `Attempt ${attemptId} already reported started; not-started is no longer reportable`, 409);
      }
      // The peer AFFIRMATIVELY reports it never began: only this honest
      // declaration (not a silent lease lapse) makes expiry requeue the job.
      attempt.outcomeCertainty = "not_started";
      persist();
      return { job, attempt };
    },

    renewLease(attemptId, claimToken, peerId, now, leaseMs) {
      if (!Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > 600_000) {
        throw new PeerJobError("invalid_lease", "leaseMs must be a positive number <= 600000", 422);
      }
      const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
      if (!attempt) throw new PeerJobError("attempt_not_found", `Attempt ${attemptId} not found`, 404);
      const job = jobOrThrow(attempt.jobId);
      fencedAttempt(job.jobId, attemptId, claimToken, peerId);
      // Runtime-budget exhaustion is checked BEFORE the lease-expiry fence:
      // the clamped lease expires exactly when the budget does, and the peer
      // must see runtime_budget_exceeded (410), not a generic lease failure.
      // The budget clock starts at /started — or at CLAIM time when the peer
      // never reports started — so a claim-without-start cannot renew
      // indefinitely.
      const budgetStartIso = attempt.executionStartedAt ?? attempt.createdAt
        ?? new Date(Date.parse(attempt.leaseExpiresAt) - LEASE_MS).toISOString();
      {
        const startedAt = Date.parse(budgetStartIso);
        const remaining = job.maxRuntimeMs - (now - startedAt);
        if (remaining <= 0) {
          attempt.status = "expired";
          job.status = attempt.outcomeCertainty === "not_started" ? "pending" : "awaiting_reconciliation";
          persist();
          throw new PeerJobError("runtime_budget_exceeded", `Job ${job.jobId} exceeded its maxRuntimeMs budget (${job.maxRuntimeMs}ms)`, 410);
        }
        if (Date.parse(attempt.leaseExpiresAt) > now) {
          // Dedicated fenced remote-lease extension; never piggybacked on the
          // local reaper lease. The job's maxRuntimeMs budget bounds the lease.
          attempt.leaseExpiresAt = new Date(now + Math.min(leaseMs, remaining)).toISOString();
          attempt.lastHeartbeatAt = new Date(now).toISOString();
          persist();
          return { job, attempt };
        }
      }
      assertActiveAttemptForFence(attempt, now);
      attempt.leaseExpiresAt = new Date(now + leaseMs).toISOString();
      attempt.lastHeartbeatAt = new Date(now).toISOString();
      persist();
      return { job, attempt };
    },

    completeAttempt(attemptId, claimToken, peerId, receipt, now) {
      const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
      if (!attempt) throw new PeerJobError("attempt_not_found", `Attempt ${attemptId} not found`, 404);
      const job = jobOrThrow(attempt.jobId);
      // Identity fence (peer + token + generation) ALWAYS precedes the
      // idempotency branch.
      fencedAttempt(job.jobId, attemptId, claimToken, peerId);
      // Idempotency: a repeated identical complete on an already-completed
      // attempt returns the stored outcome; a DIFFERENT receipt is a
      // conflict, never a silent overwrite.
      if (attempt.status === "completed") {
        if (attempt.receipt !== undefined && canonicalJson(attempt.receipt) === canonicalJson(receipt)) {
          return { job, attempt, idempotent: true };
        }
        throw new PeerJobError("conflicting_result", `Attempt ${attemptId} was already completed with a different receipt`, 409);
      }
      assertActiveAttemptForFence(attempt, now);
      attempt.status = "completed";
      attempt.outcomeCertainty = "terminal_verified";
      attempt.receipt = receipt;
      job.terminalAt = undefined;
      if (receipt.terminalState === "succeeded") {
        job.status = "result_received";
      } else if (receipt.terminalState === "failed") {
        job.status = "failed";
        job.terminalAt = new Date(now).toISOString();
        job.terminalReason = receipt.summary !== undefined
          ? "peer_reported_failure: " + receipt.summary.slice(0, 200)
          : "peer_reported_failure";
      } else {
        job.status = "cancelled";
        job.terminalAt = new Date(now).toISOString();
        job.terminalReason = receipt.summary !== undefined
          ? "peer_reported_cancelled: " + receipt.summary.slice(0, 200)
          : "peer_reported_cancelled";
      }
      persist();
      return { job, attempt, idempotent: false };
    },

    failAttempt(attemptId, claimToken, peerId, reason, now) {
      const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
      if (!attempt) throw new PeerJobError("attempt_not_found", `Attempt ${attemptId} not found`, 404);
      const job = jobOrThrow(attempt.jobId);
      fencedAttempt(job.jobId, attemptId, claimToken, peerId);
      assertActiveAttemptForFence(attempt, now);
      attempt.status = "failed";
      if (attempt.outcomeCertainty === "started" || attempt.outcomeCertainty === "unknown") {
        // Certainty started or unknown means work MAY have happened: never
        // terminate or requeue — reconcile.
        job.status = "awaiting_reconciliation";
      } else {
        // Only an affirmative not-started report allows requeue.
        job.status = "pending";
      }
      persist();
      return { job, attempt };
    },

    requestCancel(jobId, now) {
      const job = jobOrThrow(jobId);
      if (isTerminalJobStatus(job.status)) {
        throw new PeerJobError("job_terminal", `Job ${jobId} is already terminal (${job.status})`, 409);
      }
      job.cancelRequestedAt = new Date(now).toISOString();
      persist();
      return job;
    },

    cancelAck(attemptId, claimToken, peerId, now) {
      const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
      if (!attempt) throw new PeerJobError("attempt_not_found", `Attempt ${attemptId} not found`, 404);
      const job = jobOrThrow(attempt.jobId);
      fencedAttempt(job.jobId, attemptId, claimToken, peerId);
      if (attempt.status !== "active") {
        throw new PeerJobError("attempt_not_active", `Attempt ${attemptId} is not active`);
      }
      attempt.status = "failed";
      job.status = "cancelled";
      job.terminalAt = new Date(now).toISOString();
      job.terminalReason = "cancel_acknowledged";
      persist();
      return { job, attempt };
    },

    cancelUnclaimedJob(jobId, now) {
      const job = jobOrThrow(jobId);
      if (isTerminalJobStatus(job.status)) {
        throw new PeerJobError("job_terminal", `Job ${jobId} is already terminal (${job.status})`, 409);
      }
      const hasActiveAttempt = attempts.some((candidate) => candidate.jobId === jobId && candidate.status === "active");
      if (hasActiveAttempt) {
        throw new PeerJobError("cancel_requires_ack", "Active attempt exists; cancellation requires cancel-ack");
      }
      job.status = "cancelled";
      job.terminalAt = new Date(now).toISOString();
      job.terminalReason = "cancel_requested_unclaimed";
      persist();
      return job;
    },

    reapExpiredLeases(now, limit = 100) {
      // Bounded sweep.
      const reaped: Array<{ job: PeerJob; attempt: PeerAttempt }> = [];
      for (const attempt of attempts) {
        if (reaped.length >= limit) break;
        if (attempt.status !== "active") continue;
        if (Date.parse(attempt.leaseExpiresAt) > now) continue;
        const job = jobs.find((candidate) => candidate.jobId === attempt.jobId);
        if (!job) continue;
        if (job.status !== "claimed" && job.status !== "running") continue;
        requeueJobAfterExpiredAttempt(job, attempt, now);
        reaped.push({ job, attempt });
      }
      if (reaped.length > 0) persist();
      return reaped;
    },

    restartReconciliation() {
      // On boot: any claimed/running job with no active attempt becomes
      // awaiting_reconciliation (never auto-repeat). Attempts persisted as
      // "active" by a previous process are orphaned at boot — no live
      // process holds their lease — so they count as non-active here.
      let changed = false;
      for (const attempt of attempts) {
        if (attempt.status === "active") {
          attempt.status = Date.parse(attempt.leaseExpiresAt) > Date.now() ? "superseded" : "expired";
          changed = true;
        }
      }
      for (const job of jobs) {
        if (job.status !== "claimed" && job.status !== "running") continue;
        const hasActiveAttempt = attempts.some((candidate) => candidate.jobId === job.jobId && candidate.status === "active");
        if (hasActiveAttempt) continue;
        job.status = "awaiting_reconciliation";
        changed = true;
      }
      if (changed) persist();
    },

    close() {
      // Persist a final snapshot; durable sidecar makes restart safe.
      persist();
      jobs = [];
      attempts = [];
    },
  };

  store.restartReconciliation();
  return store;
}

// --- Module-level singleton -------------------------------------------------

let singleton: PeerJobStore | undefined;

export function setPeerJobStoreSingleton(store: PeerJobStore | undefined): void {
  singleton = store;
}

export function getPeerJobStore(): PeerJobStore | undefined {
  return singleton;
}
