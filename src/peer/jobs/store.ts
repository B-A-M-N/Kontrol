/**
 * M3 peer job store backed by the shared Kontrol SQLite database. The legacy
 * JSON sidecar is imported once and retained as migration evidence.
 *
 * Store lifecycle binds to the process (module-level singleton opened on the
 * first registerPeerJobRoutes call); SQLite records survive restart.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, type DatabaseHandle } from "../../db/client.js";
import type { LoggingConfig } from "../../logger.js";
import { logEvent } from "../../logger.js";
import { PeerJobError } from "./contracts.js";
import { normalizeAllowedOutputs } from "./service.js";
import type {
  PeerAttempt,
  PeerJob,
  PeerJobResultReceipt,
} from "./contracts.js";

const LEGACY_SIDECAR_FILE = "peer-jobs.json";
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
  createJob(input: Omit<PeerJob, "jobId" | "status" | "createdAt"> & { peerId: string; jobId?: string }): PeerJob;
  getJob(jobId: string): PeerJob | undefined;
  getLatestJobForWorkSession(peerId: string, workSessionId: string, excludeJobId?: string): PeerJob | undefined;
  listJobsForPeer(peerId: string, opts?: { includeTerminal?: boolean }): PeerJob[];
  listJobsForPeerPage(peerId: string, input: {
    includeTerminal?: boolean;
    after?: { createdAt: string; jobId: string };
    limit: number;
  }): PeerJob[];
  getAttemptSummaryForJob(jobId: string): { latest?: PeerAttempt; latestReceipt?: PeerAttempt };
  getAttempt(attemptId: string): PeerAttempt | undefined;
  /** Read-only authorization fence for bounded artifact uploads. */
  authorizeAttempt(jobId: string, attemptId: string, claimToken: string, peerId: string, now: number): { job: PeerJob; attempt: PeerAttempt };
  /** Read-only projection: shallow copy of the attempts for a job, newest last. Never hands out live mutable internals. */
  listAttemptsForJob(jobId: string): PeerAttempt[];
  claimNextJob(peerId: string, now: number, opts?: { taskClass?: string }): { job: PeerJob; attempt: PeerAttempt } | undefined;
  markStarted(attemptId: string, claimToken: string, peerId: string, now: number, remoteExecutionId?: string): { job: PeerJob; attempt: PeerAttempt };
  /** Peer affirmatively reports it never began the claimed attempt (fenced). */
  markNotStarted(attemptId: string, claimToken: string, peerId: string, now: number): { job: PeerJob; attempt: PeerAttempt };
  renewLease(attemptId: string, claimToken: string, peerId: string, now: number, leaseMs: number): { job: PeerJob; attempt: PeerAttempt };
  completeAttempt(attemptId: string, claimToken: string, peerId: string, receipt: PeerJobResultReceipt, now: number): { job: PeerJob; attempt: PeerAttempt; idempotent: boolean };
  markStaging(jobId: string, receiptSha256: string, now: number): PeerJob;
  markAwaitingReview(jobId: string, input: {
    receiptSha256: string;
    submissionId: string;
    reviewEpoch: number;
    snapshotKind: "git" | "filesystem";
    snapshotRef: string;
    diffSha256: string;
    verificationStatus?: "passed" | "failed" | "inconclusive" | "not_configured";
    verificationEvidenceSha256?: string;
  }, now: number): PeerJob;
  recordVerification(jobId: string, input: { submissionId: string; reviewEpoch: number; status: "passed" | "failed" | "inconclusive" | "not_configured"; evidenceSha256?: string }, now: number): PeerJob;
  markAwaitingReconciliation(jobId: string, reason: string, now: number): PeerJob;
  retryResultProcessing(jobId: string, expectedFailure: string, now: number): PeerJob;
  finalizeReview(jobId: string, input: { submissionId: string; reviewEpoch: number; feedbackId: string; verdict: "approve" | "changes_requested" | "reject" }, now: number): PeerJob;
  failAttempt(attemptId: string, claimToken: string, peerId: string, reason: string, now: number): { job: PeerJob; attempt: PeerAttempt };
  requestCancel(jobId: string, now: number): PeerJob;
  cancelAck(attemptId: string, claimToken: string, peerId: string, now: number): { job: PeerJob; attempt: PeerAttempt };
  cancelUnclaimedJob(jobId: string, now: number): PeerJob;
  reapExpiredLeases(now: number, limit?: number): Array<{ job: PeerJob; attempt: PeerAttempt }>;
  restartReconciliation(): void;
  close(): void;
}

function isTerminalJobStatus(status: PeerJob["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "review_changes_requested";
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

export function openPeerJobStore(stateDir: string, logging: LoggingConfig, sharedDatabase?: DatabaseHandle): PeerJobStore {
  const sink = loggingSink(logging);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const sidecarPath = join(stateDir, LEGACY_SIDECAR_FILE);
  const database = sharedDatabase ?? openDatabase(stateDir);
  const ownsDatabase = sharedDatabase === undefined;
  const sqlite = database.sqlite;

  let stateCorrupted = false;
  let closed = false;
  let snapshot: PeerJobStoreSnapshot = { version: 1, jobs: [], attempts: [] };
  const imported = sqlite.prepare("select value from peer_job_store_metadata where key = 'legacy_sidecar_import_v1'").get() as { value: string } | undefined;
  if (!imported && existsSync(sidecarPath)) {
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
      if (ownsDatabase) database.close();
      throw new PeerJobError("peer_jobs_state_corrupt", "Existing peer-job state is unreadable; dispatch is refused to preserve prior evidence.", 503);
    }
  }

  if (!imported) {
    const existingJobs = sqlite.prepare("select count(*) as count from peer_jobs").get() as { count: number };
    const existingAttempts = sqlite.prepare("select count(*) as count from peer_job_attempts").get() as { count: number };
    if (existingJobs.count > 0 || existingAttempts.count > 0) {
      if (ownsDatabase) database.close();
      throw new PeerJobError("peer_jobs_state_corrupt", "Peer-job SQLite rows exist without an import receipt; refusing ambiguous recovery.", 503);
    }
    const importRows = sqlite.transaction(() => {
      const insertJob = sqlite.prepare(`insert into peer_jobs
        (job_id, peer_id, status, created_at, task_class, repository_id, workspace_session_id, work_session_id, record_json)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertAttempt = sqlite.prepare(`insert into peer_job_attempts
        (attempt_id, job_id, status, generation, created_at, lease_expires_at, outcome_certainty, record_json)
        values (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const job of snapshot.jobs) insertJob.run(
        job.jobId, job.peerId, job.status, job.createdAt, job.taskClass, job.repositoryId,
        job.workspaceSessionId ?? null, job.workSessionId ?? null, JSON.stringify(job),
      );
      for (const attempt of snapshot.attempts) insertAttempt.run(
        attempt.attemptId, attempt.jobId, attempt.status, attempt.generation, attempt.createdAt,
        attempt.leaseExpiresAt, attempt.outcomeCertainty, JSON.stringify(attempt),
      );
      sqlite.prepare("insert into peer_job_store_metadata (key, value) values ('legacy_sidecar_import_v1', ?)")
        .run(new Date().toISOString());
    });
    try {
      importRows.immediate();
    } catch (error) {
      if (ownsDatabase) database.close();
      throw new PeerJobError("peer_jobs_state_corrupt", `Peer-job sidecar migration failed; original evidence is preserved: ${error instanceof Error ? error.message : String(error)}`, 503);
    }
  }

  let jobs: PeerJob[];
  let attempts: PeerAttempt[];
  const persistedJobs = new Map<string, string>();
  const persistedAttempts = new Map<string, string>();
  const jobById = new Map<string, PeerJob>();
  const attemptById = new Map<string, PeerAttempt>();
  const attemptsByJob = new Map<string, PeerAttempt[]>();
  try {
    jobs = (sqlite.prepare("select record_json from peer_jobs order by created_at, job_id").all() as Array<{ record_json: string }>)
      .map((row) => JSON.parse(row.record_json) as PeerJob);
    attempts = (sqlite.prepare("select record_json from peer_job_attempts order by created_at, attempt_id").all() as Array<{ record_json: string }>)
      .map((row) => JSON.parse(row.record_json) as PeerAttempt);
  } catch (error) {
    if (ownsDatabase) database.close();
    throw new PeerJobError("peer_jobs_state_corrupt", `Peer-job SQLite state is unreadable; dispatch is refused: ${error instanceof Error ? error.message : String(error)}`, 503);
  }
  for (const job of jobs) {
    const json = JSON.stringify(job);
    jobById.set(job.jobId, job);
    persistedJobs.set(job.jobId, json);
  }
  for (const attempt of attempts) {
    const json = JSON.stringify(attempt);
    attemptById.set(attempt.attemptId, attempt);
    persistedAttempts.set(attempt.attemptId, json);
    const rows = attemptsByJob.get(attempt.jobId) ?? [];
    rows.push(attempt);
    attemptsByJob.set(attempt.jobId, rows);
  }

  function persist(changedJobs: PeerJob[], changedAttempts: PeerAttempt[] = []): void {
    if (stateCorrupted) throw new PeerJobError("peer_jobs_state_corrupt", "Peer-job state is corrupt; persistence is refused.", 503);
    // Callers identify the exact dirty records. SQLite writes remain row-scoped
    // and compare-and-swap fenced without scanning or rewriting a snapshot.
    const updateJob = sqlite.prepare(`update peer_jobs set
      peer_id = ?, status = ?, created_at = ?, task_class = ?, repository_id = ?,
      workspace_session_id = ?, work_session_id = ?, record_json = ?
      where job_id = ? and record_json = ?`);
    const insertJob = sqlite.prepare(`insert into peer_jobs
      (job_id, peer_id, status, created_at, task_class, repository_id, workspace_session_id, work_session_id, record_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const updateAttempt = sqlite.prepare(`update peer_job_attempts set
      job_id = ?, status = ?, generation = ?, created_at = ?, lease_expires_at = ?,
      outcome_certainty = ?, record_json = ? where attempt_id = ? and record_json = ?`);
    const insertAttempt = sqlite.prepare(`insert into peer_job_attempts
      (attempt_id, job_id, status, generation, created_at, lease_expires_at, outcome_certainty, record_json)
      values (?, ?, ?, ?, ?, ?, ?, ?)`);
    const jobJsonUpdates: Array<[string, string]> = [];
    const attemptJsonUpdates: Array<[string, string]> = [];
    try {
      sqlite.transaction(() => {
        for (const job of changedJobs) {
          const json = JSON.stringify(job);
          const previous = persistedJobs.get(job.jobId);
          const result = previous === undefined
            ? insertJob.run(job.jobId, job.peerId, job.status, job.createdAt, job.taskClass, job.repositoryId, job.workspaceSessionId ?? null, job.workSessionId ?? null, json)
            : updateJob.run(job.peerId, job.status, job.createdAt, job.taskClass, job.repositoryId, job.workspaceSessionId ?? null, job.workSessionId ?? null, json, job.jobId, previous);
          if (result.changes !== 1) throw new PeerJobError("peer_job_write_conflict", `Peer job ${job.jobId} changed concurrently; reload authoritative state before retrying.`, 409);
          jobJsonUpdates.push([job.jobId, json]);
        }
        for (const attempt of changedAttempts) {
          const json = JSON.stringify(attempt);
          const previous = persistedAttempts.get(attempt.attemptId);
          const result = previous === undefined
            ? insertAttempt.run(attempt.attemptId, attempt.jobId, attempt.status, attempt.generation, attempt.createdAt, attempt.leaseExpiresAt, attempt.outcomeCertainty, json)
            : updateAttempt.run(attempt.jobId, attempt.status, attempt.generation, attempt.createdAt, attempt.leaseExpiresAt, attempt.outcomeCertainty, json, attempt.attemptId, previous);
          if (result.changes !== 1) throw new PeerJobError("peer_job_attempt_write_conflict", `Peer attempt ${attempt.attemptId} changed concurrently; reload authoritative state before retrying.`, 409);
          attemptJsonUpdates.push([attempt.attemptId, json]);
        }
      }).immediate();
    } catch (error) {
      if (error instanceof PeerJobError) throw error;
      throw new PeerJobError("peer_jobs_persistence_failed", `SQLite peer-job transaction failed: ${error instanceof Error ? error.message : String(error)}`, 503);
    }
    for (const [id, json] of jobJsonUpdates) persistedJobs.set(id, json);
    for (const [id, json] of attemptJsonUpdates) persistedAttempts.set(id, json);
    for (const job of changedJobs) jobById.set(job.jobId, job);
    for (const attempt of changedAttempts) {
      attemptById.set(attempt.attemptId, attempt);
      const rows = attemptsByJob.get(attempt.jobId) ?? [];
      if (!rows.some((row) => row.attemptId === attempt.attemptId)) rows.push(attempt);
      attemptsByJob.set(attempt.jobId, rows);
    }
  }

  function jobOrThrow(jobId: string): PeerJob {
    const job = jobById.get(jobId);
    if (!job) throw new PeerJobError("job_not_found", `Job ${jobId} not found`, 404);
    return job;
  }

  function fencedAttempt(jobId: string, attemptId: string, claimToken: string, peerId: string): PeerAttempt {
    const job = jobOrThrow(jobId);
    const attempt = attemptById.get(attemptId);
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
    return attemptsByJob.get(job.jobId)?.length ?? 0;
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
      const jobId = input.jobId ?? "job_" + randomUUID();
      if (!/^job_[0-9a-f-]{36}$/i.test(jobId)) {
        throw new PeerJobError("invalid_job_id", "Peer job id must be a generated job UUID", 422);
      }
      const job: PeerJob = {
        ...input,
        allowedOutputs: normalizeAllowedOutputs(input.allowedOutputs),
        jobId,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      const prior = jobById.get(jobId);
      if (prior) {
        const identity = (candidate: PeerJob) => ({
          peerId: candidate.peerId,
          workSessionId: candidate.workSessionId,
          workspaceSessionId: candidate.workspaceSessionId,
          schedulerDispatchId: candidate.schedulerDispatchId,
          repositoryId: candidate.repositoryId,
          baseRevision: candidate.baseRevision,
          taskClass: candidate.taskClass,
          instructionHash: candidate.instructionHash,
          instructions: candidate.instructions,
          allowedOutputs: candidate.allowedOutputs,
          maxRuntimeMs: candidate.maxRuntimeMs,
          maxArtifactBytes: candidate.maxArtifactBytes,
        });
        if (canonicalJson(identity(prior)) !== canonicalJson(identity(job))) {
          throw new PeerJobError("peer_job_id_conflict", `Peer job ${jobId} already exists with different immutable request content`, 409);
        }
        // A dispatch retry after response loss returns the current durable job
        // (including any claim/result state) instead of inserting a duplicate.
        return prior;
      }
      jobs.push(job);
      persist([job]);
      return job;
    },

    getJob(jobId) {
      return jobById.get(jobId);
    },

    getLatestJobForWorkSession(peerId, workSessionId, excludeJobId) {
      const row = sqlite.prepare(`
        select record_json from peer_jobs
        where peer_id = ? and work_session_id = ? and (? is null or job_id <> ?)
        order by created_at desc, rowid desc
        limit 1
      `).get(peerId, workSessionId, excludeJobId ?? null, excludeJobId ?? null) as { record_json: string } | undefined;
      return row ? JSON.parse(row.record_json) as PeerJob : undefined;
    },

    listJobsForPeer(peerId, opts) {
      const includeTerminal = opts?.includeTerminal ?? false;
      const rows = includeTerminal
        ? sqlite.prepare("select record_json from peer_jobs where peer_id = ? order by created_at, job_id").all(peerId)
        : sqlite.prepare("select record_json from peer_jobs where peer_id = ? and status not in ('completed','failed','cancelled','review_changes_requested') order by created_at, job_id").all(peerId);
      return (rows as Array<{ record_json: string }>).map((row) => JSON.parse(row.record_json) as PeerJob);
    },

    listJobsForPeerPage(peerId, input) {
      const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
      const clauses = ["peer_id = ?"];
      const params: Array<string | number> = [peerId];
      if (!input.includeTerminal) {
        clauses.push("status not in ('completed','failed','cancelled','review_changes_requested')");
      }
      if (input.after) {
        clauses.push("(created_at > ? or (created_at = ? and job_id > ?))");
        params.push(input.after.createdAt, input.after.createdAt, input.after.jobId);
      }
      params.push(limit);
      const rows = sqlite.prepare(`
        select record_json from peer_jobs
        where ${clauses.join(" and ")}
        order by created_at, job_id
        limit ?
      `).all(...params) as Array<{ record_json: string }>;
      return rows.map((row) => JSON.parse(row.record_json) as PeerJob);
    },

    getAttemptSummaryForJob(jobId) {
      const latestRow = sqlite.prepare(`
        select record_json from peer_job_attempts
        where job_id = ?
        order by generation desc
        limit 1
      `).get(jobId) as { record_json: string } | undefined;
      const receiptRow = sqlite.prepare(`
        select record_json from peer_job_attempts
        where job_id = ? and json_type(record_json, '$.receipt') = 'object'
        order by generation desc
        limit 1
      `).get(jobId) as { record_json: string } | undefined;
      const map = (row: { record_json: string } | undefined) => {
        if (!row) return undefined;
        const attempt = JSON.parse(row.record_json) as PeerAttempt;
        return { ...attempt, receipt: attempt.receipt ? { ...attempt.receipt } : undefined };
      };
      return { latest: map(latestRow), latestReceipt: map(receiptRow) };
    },

    getAttempt(attemptId) {
      return attemptById.get(attemptId);
    },

    authorizeAttempt(jobId, attemptId, claimToken, peerId, now) {
      const job = jobOrThrow(jobId);
      const attempt = fencedAttempt(jobId, attemptId, claimToken, peerId);
      assertActiveAttemptForFence(attempt, now);
      if (job.status !== "claimed" && job.status !== "running") {
        throw new PeerJobError("job_not_active", `Job ${jobId} is not accepting artifacts (status ${job.status})`);
      }
      return { job: { ...job, allowedOutputs: [...job.allowedOutputs] }, attempt: { ...attempt } };
    },

    listAttemptsForJob(jobId) {
      const rows = sqlite.prepare("select record_json from peer_job_attempts where job_id = ? order by created_at, attempt_id").all(jobId) as Array<{ record_json: string }>;
      return rows.map((row) => {
        const attempt = JSON.parse(row.record_json) as PeerAttempt;
        return { ...attempt, receipt: attempt.receipt ? { ...attempt.receipt } : undefined };
      });
    },

    claimNextJob(peerId, now, opts) {
      // CAS semantics: claim only from "pending"; peer-scoped — a job is
      // served exclusively to the peer it was assigned to.
      const taskClassFilter = opts?.taskClass;
      const candidateRow = taskClassFilter === undefined
        ? sqlite.prepare("select record_json from peer_jobs where peer_id = ? and status = 'pending' and json_extract(record_json, '$.cancelRequestedAt') is null and work_session_id is not null and workspace_session_id is not null order by created_at, job_id limit 1").get(peerId) as { record_json: string } | undefined
        : sqlite.prepare("select record_json from peer_jobs where peer_id = ? and status = 'pending' and json_extract(record_json, '$.cancelRequestedAt') is null and work_session_id is not null and workspace_session_id is not null and task_class = ? order by created_at, job_id limit 1").get(peerId, taskClassFilter) as { record_json: string } | undefined;
      const job = candidateRow ? JSON.parse(candidateRow.record_json) as PeerJob : undefined;
      if (!job) return undefined;
      jobById.set(job.jobId, job);
      const localIndex = jobs.findIndex((candidate) => candidate.jobId === job.jobId);
      if (localIndex >= 0) jobs[localIndex] = job;
      else jobs.push(job);

      const generationCount = sqlite.prepare("select count(*) as count from peer_job_attempts where job_id = ?").get(job.jobId) as { count: number };
      const attempt: PeerAttempt = {
        attemptId: "att_" + randomUUID(),
        jobId: job.jobId,
        claimToken: randomBytes(32).toString("hex"),
        claimOwnerPeerId: peerId,
        generation: generationCount.count + 1,
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
      persist([job], [attempt]);
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
        persist([job], [attempt]);
        return { job, attempt };
      }
      attempt.executionStartedAt = new Date(now).toISOString();
      attempt.remoteExecutionId = remoteExecutionId;
      attempt.outcomeCertainty = "started";
      job.status = "running";
      persist([job], [attempt]);
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
      persist([job], [attempt]);
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
          persist([job], [attempt]);
          throw new PeerJobError("runtime_budget_exceeded", `Job ${job.jobId} exceeded its maxRuntimeMs budget (${job.maxRuntimeMs}ms)`, 410);
        }
        if (Date.parse(attempt.leaseExpiresAt) > now) {
          // Dedicated fenced remote-lease extension; never piggybacked on the
          // local reaper lease. The job's maxRuntimeMs budget bounds the lease.
          attempt.leaseExpiresAt = new Date(now + Math.min(leaseMs, remaining)).toISOString();
          attempt.lastHeartbeatAt = new Date(now).toISOString();
          persist([job], [attempt]);
          return { job, attempt };
        }
      }
      assertActiveAttemptForFence(attempt, now);
      attempt.leaseExpiresAt = new Date(now + leaseMs).toISOString();
      attempt.lastHeartbeatAt = new Date(now).toISOString();
      persist([job], [attempt]);
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
      persist([job], [attempt]);
      return { job, attempt, idempotent: false };
    },

    markStaging(jobId, receiptSha256, now) {
      const job = jobOrThrow(jobId);
      if (job.status === "awaiting_review" || job.status === "completed") return { ...job };
      if (job.status !== "result_received" && job.status !== "staging") {
        throw new PeerJobError("invalid_result_transition", `Job ${jobId} cannot enter staging from ${job.status}`);
      }
      if (job.resultProcessing?.receiptSha256 && job.resultProcessing.receiptSha256 !== receiptSha256) {
        throw new PeerJobError("result_receipt_conflict", "Staging receipt identity changed", 409);
      }
      job.status = "staging";
      job.resultProcessing = { ...job.resultProcessing, receiptSha256, failure: undefined, updatedAt: new Date(now).toISOString() };
      persist([job]);
      return { ...job, resultProcessing: { ...job.resultProcessing } };
    },

    markAwaitingReview(jobId, input, now) {
      const job = jobOrThrow(jobId);
      if (job.status === "awaiting_review" && job.resultProcessing?.submissionId === input.submissionId) {
        // Recovery may replay result processing after the submission was
        // committed but before its verification receipt was stored. Fill only
        // the matching missing receipt; never replace evidence already bound
        // to this immutable submission.
        if (job.resultProcessing.verificationStatus === undefined && input.verificationStatus !== undefined) {
          job.resultProcessing = {
            ...job.resultProcessing,
            verificationStatus: input.verificationStatus,
            verificationEvidenceSha256: input.verificationEvidenceSha256,
            updatedAt: new Date(now).toISOString(),
          };
          persist([job]);
        }
        return { ...job, resultProcessing: { ...job.resultProcessing } };
      }
      if (job.status !== "staging" || job.resultProcessing?.receiptSha256 !== input.receiptSha256) {
        throw new PeerJobError("invalid_result_transition", `Job ${jobId} is not staging this receipt`);
      }
      job.status = "awaiting_review";
      job.resultProcessing = { ...input, updatedAt: new Date(now).toISOString() };
      persist([job]);
      return { ...job, resultProcessing: { ...job.resultProcessing } };
    },

    recordVerification(jobId, input, now) {
      const job = jobOrThrow(jobId);
      const processing = job.resultProcessing;
      if (
        job.status !== "awaiting_review" ||
        processing?.submissionId !== input.submissionId ||
        processing.reviewEpoch !== input.reviewEpoch
      ) {
        throw new PeerJobError("verification_identity_mismatch", "Verification does not match the active peer-job submission", 409);
      }
      job.resultProcessing = {
        ...processing,
        verificationStatus: input.status,
        verificationEvidenceSha256: input.evidenceSha256,
        updatedAt: new Date(now).toISOString(),
      };
      persist([job]);
      return { ...job, resultProcessing: { ...job.resultProcessing } };
    },

    markAwaitingReconciliation(jobId, reason, now) {
      const job = jobOrThrow(jobId);
      if (job.status === "awaiting_review" || isTerminalJobStatus(job.status)) return { ...job };
      job.status = "awaiting_reconciliation";
      job.resultProcessing = {
        ...job.resultProcessing,
        failure: reason.slice(0, 1000),
        updatedAt: new Date(now).toISOString(),
      };
      persist([job]);
      return { ...job, resultProcessing: { ...job.resultProcessing } };
    },

    retryResultProcessing(jobId, expectedFailure, now) {
      const job = jobOrThrow(jobId);
      if (job.status !== "awaiting_reconciliation") {
        throw new PeerJobError("peer_job_not_reconcilable", `Job ${jobId} is ${job.status}; only awaiting_reconciliation results can be retried.`, 409);
      }
      if (!expectedFailure || job.resultProcessing?.failure !== expectedFailure) {
        throw new PeerJobError("peer_job_reconciliation_stale", "The observed result-processing failure is stale; refresh peer status before retrying.", 409);
      }
      const successfulAttempt = [...(attemptsByJob.get(jobId) ?? [])].reverse().find((attempt) =>
        attempt.receipt?.terminalState === "succeeded");
      if (!successfulAttempt) {
        throw new PeerJobError("peer_job_result_unavailable", "No successful stored peer receipt is available; local result processing cannot be retried.", 409);
      }
      job.status = "result_received";
      job.resultProcessing = {
        ...job.resultProcessing,
        failure: undefined,
        retryRevision: (job.resultProcessing.retryRevision ?? 0) + 1,
        updatedAt: new Date(now).toISOString(),
      };
      persist([job]);
      return { ...job, resultProcessing: { ...job.resultProcessing } };
    },

    finalizeReview(jobId, input, now) {
      const job = jobOrThrow(jobId);
      if (isTerminalJobStatus(job.status)) return { ...job };
      const processing = job.resultProcessing;
      if (
        job.status !== "awaiting_review" ||
        processing?.submissionId !== input.submissionId ||
        processing.reviewEpoch !== input.reviewEpoch
      ) {
        throw new PeerJobError("review_identity_mismatch", "Reviewer feedback is not bound to this peer job submission and epoch", 409);
      }
      job.resultProcessing = { ...processing, feedbackId: input.feedbackId, reviewVerdict: input.verdict, updatedAt: new Date(now).toISOString() };
      if (input.verdict === "approve") {
        job.status = "completed";
        job.terminalAt = new Date(now).toISOString();
        job.terminalReason = "reviewer_approved";
      } else if (input.verdict === "reject") {
        job.status = "failed";
        job.terminalAt = new Date(now).toISOString();
        job.terminalReason = "reviewer_rejected";
      } else {
        job.status = "review_changes_requested";
        job.terminalAt = new Date(now).toISOString();
        job.terminalReason = "reviewer_requested_changes";
      }
      persist([job]);
      return { ...job, resultProcessing: { ...job.resultProcessing } };
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
      persist([job], [attempt]);
      return { job, attempt };
    },

    requestCancel(jobId, now) {
      const job = jobOrThrow(jobId);
      if (isTerminalJobStatus(job.status)) {
        throw new PeerJobError("job_terminal", `Job ${jobId} is already terminal (${job.status})`, 409);
      }
      if (job.cancelRequestedAt) return { ...job };
      job.cancelRequestedAt = new Date(now).toISOString();
      persist([job]);
      return job;
    },

    cancelAck(attemptId, claimToken, peerId, now) {
      const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
      if (!attempt) throw new PeerJobError("attempt_not_found", `Attempt ${attemptId} not found`, 404);
      const job = jobOrThrow(attempt.jobId);
      fencedAttempt(job.jobId, attemptId, claimToken, peerId);
      if (!job.cancelRequestedAt) {
        throw new PeerJobError("cancel_not_requested", `Job ${job.jobId} has no outstanding cancellation request`, 409);
      }
      const latestAttempt = [...(attemptsByJob.get(job.jobId) ?? [])]
        .sort((a, b) => b.generation - a.generation)[0];
      const reconciledAttemptCancellation = (attempt.status === "expired" || attempt.status === "superseded")
        && job.cancelRequestedAt !== undefined
        && latestAttempt?.attemptId === attempt.attemptId
        && (attempt.outcomeCertainty === "started" || attempt.outcomeCertainty === "unknown");
      if (attempt.status !== "active" && !reconciledAttemptCancellation) {
        throw new PeerJobError("attempt_not_active", `Attempt ${attemptId} is not active`);
      }
      attempt.status = "failed";
      job.status = "cancelled";
      job.terminalAt = new Date(now).toISOString();
      job.terminalReason = "cancel_acknowledged";
      persist([job], [attempt]);
      return { job, attempt };
    },

    cancelUnclaimedJob(jobId, now) {
      const job = jobOrThrow(jobId);
      if (isTerminalJobStatus(job.status)) {
        throw new PeerJobError("job_terminal", `Job ${jobId} is already terminal (${job.status})`, 409);
      }
      if (job.status !== "pending") {
        throw new PeerJobError("cancel_requires_ack", `Job ${jobId} is ${job.status}; cancellation requires an exact peer acknowledgement or reconciliation.`, 409);
      }
      const hasActiveAttempt = attempts.some((candidate) => candidate.jobId === jobId && candidate.status === "active");
      if (hasActiveAttempt) {
        throw new PeerJobError("cancel_requires_ack", "Active attempt exists; cancellation requires cancel-ack");
      }
      job.status = "cancelled";
      job.terminalAt = new Date(now).toISOString();
      job.terminalReason = "cancel_requested_unclaimed";
      persist([job]);
      return job;
    },

    reapExpiredLeases(now, limit = 100) {
      // Bounded indexed sweep over only active attempts whose leases expired.
      const reaped: Array<{ job: PeerJob; attempt: PeerAttempt }> = [];
      const rows = sqlite.prepare(`select record_json from peer_job_attempts
        where status = 'active' and lease_expires_at <= ?
        order by lease_expires_at, attempt_id limit ?`).all(new Date(now).toISOString(), Math.max(1, Math.min(Math.floor(limit), 500))) as Array<{ record_json: string }>;
      for (const row of rows) {
        const attempt = JSON.parse(row.record_json) as PeerAttempt;
        const localAttemptIndex = attempts.findIndex((candidate) => candidate.attemptId === attempt.attemptId);
        if (localAttemptIndex >= 0) attempts[localAttemptIndex] = attempt;
        else attempts.push(attempt);
        attemptById.set(attempt.attemptId, attempt);
        const job = jobById.get(attempt.jobId);
        if (!job) continue;
        if (job.status !== "claimed" && job.status !== "running") continue;
        requeueJobAfterExpiredAttempt(job, attempt, now);
        reaped.push({ job, attempt });
      }
      if (reaped.length > 0) persist([...new Map(reaped.map(({ job }) => [job.jobId, job])).values()], reaped.map(({ attempt }) => attempt));
      return reaped;
    },

    restartReconciliation() {
      // On boot: any claimed/running job with no active attempt becomes
      // awaiting_reconciliation (never auto-repeat). Attempts persisted as
      // "active" by a previous process are orphaned at boot — no live
      // process holds their lease — so they count as non-active here.
      let changed = false;
      const changedJobs: PeerJob[] = [];
      const changedAttempts: PeerAttempt[] = [];
      for (const attempt of attempts) {
        if (attempt.status === "active") {
          attempt.status = Date.parse(attempt.leaseExpiresAt) > Date.now() ? "superseded" : "expired";
          changedAttempts.push(attempt);
          changed = true;
        }
      }
      for (const job of jobs) {
        if (job.status !== "claimed" && job.status !== "running") continue;
        const hasActiveAttempt = attempts.some((candidate) => candidate.jobId === job.jobId && candidate.status === "active");
        if (hasActiveAttempt) continue;
        job.status = "awaiting_reconciliation";
        changedJobs.push(job);
        changed = true;
      }
      if (changed) persist(changedJobs, changedAttempts);
    },

    close() {
      if (closed) return;
      closed = true;
      jobs = [];
      attempts = [];
      jobById.clear();
      attemptById.clear();
      attemptsByJob.clear();
      if (ownsDatabase) database.close();
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
