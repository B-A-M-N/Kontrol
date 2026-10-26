/**
 * M3 peer job HTTP routes mounted under /peer. Authentication is already
 * applied by the peer-app middleware (req.peerPrincipal is the ONLY trusted
 * identity); a caller-supplied peerId is never honored. Mutating routes
 * fence on exact peer + attempt + token + generation, and EVERY job route
 * requires the corresponding owner-granted job:* capability.
 */
import express, { type Express, type Request, type Response } from "express";
import { createPeerJobsService } from "./service.js";
import { enforcePeerJobsCap } from "./service.js";
import { validateResultReceipt } from "./service.js";
import { openPeerJobStore, setPeerJobStoreSingleton, getPeerJobStore } from "./store.js";
import { PeerJobError } from "./contracts.js";
import type { PeerJob, PeerJobResultReceipt } from "./contracts.js";
import { createPeerArtifactStore } from "./artifacts.js";
import { createPeerJobResultProcessor } from "./result-processor.js";
import type { WorkspaceRegistry } from "../../workspaces.js";
import type { ReviewCheckpointManager } from "../../review-checkpoints.js";
import type { WorkSessionManager } from "../../work-sessions/index.js";
import type { ReviewWorkflowService } from "../../review-workflow.js";
import type { EventStore } from "../../event-log.js";
import type { DispatchOutbox, OutboxClaim } from "../../dispatch-outbox.js";
import type { MissionLedger } from "../../mission-ledger.js";
import type { DatabaseHandle } from "../../db/client.js";
import type { ServerConfig } from "../../config.js";
import type { LoggingConfig } from "../../logger.js";
import type { PeerCredentialRegistry } from "../auth.js";
import type { PeerServerConfig } from "../config-types.js";
import type { PeerCapability } from "../config-types.js";
import { authorizePeerAction } from "../principal.js";

export interface PeerJobRouteDeps {
  registry: PeerCredentialRegistry;
  config: ServerConfigForJobs;
  logging: LoggingConfig;
  /** Returns true while the process is shutting down (claims refused with 503). */
  isShuttingDown?: () => boolean;
  /** Production reaper interval. Defaults to 30_000ms. */
  reapIntervalMs?: number;
  workspaces?: WorkspaceRegistry;
  workSessions?: WorkSessionManager;
  reviewCheckpoints?: ReviewCheckpointManager;
  reviewWorkflow?: ReviewWorkflowService;
  eventStore?: EventStore;
  dispatchOutbox?: DispatchOutbox;
  missionLedger?: MissionLedger;
  database?: DatabaseHandle;
  serverConfig?: ServerConfig;
}

interface ServerConfigForJobs {
  stateDir: string;
  peer: PeerServerConfig;
}

interface PeerJobRequest extends Request {
  // peerPrincipal is set by the peer auth middleware on /peer routes.
  peerPrincipal?: import("../principal.js").PeerPrincipal;
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function handleJobError(res: Response, error: unknown): void {
  if (error instanceof PeerJobError) {
    fail(res, error.httpStatus, error.code, error.message);
    return;
  }
  throw error;
}

/**
 * Authenticate via the FULL trusted principal (never caller-supplied data)
 * and enforce the owner-granted capability. Returns the authenticated peerId.
 */
function requireCapability(req: PeerJobRequest, capability: PeerCapability): string {
  const principal = req.peerPrincipal;
  if (!principal || typeof principal.peerId !== "string" || principal.peerId.length === 0) {
    throw new PeerJobError("unauthorized_peer", "Peer authentication required", 401);
  }
  if (!authorizePeerAction(principal, capability)) {
    throw new PeerJobError("peer_capability_denied", `Peer ${principal.peerId} lacks the ${capability} capability`, 403);
  }
  return principal.peerId;
}

interface AttemptCredentials {
  attemptId?: unknown;
  claimToken?: unknown;
}

function fenceCredentials(body: AttemptCredentials): { attemptId: string; claimToken: string } {
  if (typeof body.attemptId !== "string" || typeof body.claimToken !== "string") {
    throw new PeerJobError("invalid_fence", "attemptId and claimToken are required", 422);
  }
  return { attemptId: body.attemptId, claimToken: body.claimToken };
}

/** Keep owner-side workspace/review identities private from peer transports. */
function peerJobProjection(job: PeerJob): Omit<PeerJob, "workSessionId" | "workspaceSessionId" | "resultProcessing"> {
  const { workSessionId: _workSessionId, workspaceSessionId: _workspaceSessionId, resultProcessing: _resultProcessing, ...peerView } = job;
  return peerView;
}

function releasePeerJobWorkspaceReservation(
  workSessions: PeerJobRouteDeps["workSessions"],
  job: PeerJob,
): void {
  if (!workSessions || !job.workSessionId) return;
  const lease = workSessions.getWorkspaceLeaseForSession(job.workSessionId);
  if (lease?.leaseKind === "peer_job" && lease.ownerInstanceId === `peer-job:${job.jobId}`) {
    workSessions.releaseWorkspaceLeaseForSession(job.workSessionId, lease.leaseNonce);
  }
}

/**
 * Startup repair for the crash window after a durable review/terminal
 * transition but before its workspace reservation was released. Uncertain
 * and reconciliation states deliberately keep their reservation fenced.
 */
export function reconcilePeerJobWorkspaceReservations(
  workSessions: PeerJobRouteDeps["workSessions"],
  jobs: readonly PeerJob[],
): void {
  for (const job of jobs) {
    if (job.status === "awaiting_review" || job.status === "completed" || job.status === "failed"
      || job.status === "cancelled" || job.status === "review_changes_requested") {
      releasePeerJobWorkspaceReservation(workSessions, job);
    }
  }
}

export interface PeerJobRoutesHandle {
  close(): Promise<void>;
}

/**
 * Production reaper: periodically sweeps expired attempt leases. Exported so
 * tests can drive the same callback deterministically via reapNow() instead
 * of waiting on wall-clock lease expiry.
 */
export function createPeerJobReaper(store: import("./store.js").PeerJobStore, intervalMs: number): {
  start(): void;
  stop(): void;
  /** One synchronous sweep; `now` defaults to Date.now() (tests may inject a clock). */
  reapNow(now?: number): Array<{ job: PeerJob; attempt: import("./contracts.js").PeerAttempt }>;
} {
  let timer: NodeJS.Timeout | undefined;
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        try {
          store.reapExpiredLeases(Date.now());
        } catch {
          // reapExpiredLeases is bounded and fail-operational; persistence
          // errors are logged inside the store.
        }
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    reapNow(now = Date.now()) {
      return store.reapExpiredLeases(now);
    },
  };
}

/**
 * Mount the /peer job routes on the app. The store is opened on the first
 * call and kept as a module-level singleton (accessible via getPeerJobStore
 * for tests). Store lifecycle binds to the process and its shared SQLite
 * database. Returns a close() for explicit teardown in tests.
 */
export function registerPeerJobRoutes(app: Express, deps: PeerJobRouteDeps): PeerJobRoutesHandle {
  let store = getPeerJobStore();
  if (!store) {
    store = openPeerJobStore(deps.config.stateDir, deps.logging, deps.database);
    setPeerJobStoreSingleton(store);
  }
  const jobStore: NonNullable<typeof store> = store;  const service = createPeerJobsService({
    store,
    config: { peer: { maxClaimedJobs: deps.config.peer.maxClaimedJobs } },
    logging: deps.logging,
  });
  const reaper = createPeerJobReaper(jobStore, deps.reapIntervalMs ?? 30_000);
  const artifacts = createPeerArtifactStore(deps.config.stateDir);
  const resultProcessor = deps.workspaces && deps.workSessions && deps.reviewCheckpoints && deps.reviewWorkflow
    ? createPeerJobResultProcessor({
        store: jobStore,
        artifacts,
        workspaces: deps.workspaces,
        workSessions: deps.workSessions,
        reviewCheckpoints: deps.reviewCheckpoints,
        reviewWorkflow: deps.reviewWorkflow,
        missionLedger: deps.missionLedger,
        serverConfig: deps.serverConfig,
      })
    : undefined;
  const reviewSubscriptions = new Map<string, () => void>();
  const pendingResultTasks = new Set<Promise<void>>();
  let closePromise: Promise<void> | undefined;
  let drainingResultOutbox: Promise<void> | undefined;
  let resultOutboxRecoveryTimer: NodeJS.Timeout | undefined;
  reaper.start();

  function reconcileReview(jobId: string): void {
    if (!deps.workSessions) return;
    const job = jobStore.getJob(jobId);
    const processing = job?.resultProcessing;
    if (!job || job.status !== "awaiting_review" || !job.workSessionId || !processing?.submissionId || processing.reviewEpoch === undefined) return;
    const submission = deps.workSessions.getSubmissions(job.workSessionId).find((candidate) => candidate.id === processing.submissionId);
    const feedback = deps.workSessions.getLatestFeedback(job.workSessionId);
    if (!submission || submission.reviewEpoch !== processing.reviewEpoch || !feedback
      || feedback.submissionId !== submission.id || feedback.workSessionId !== job.workSessionId) return;
    try {
      jobStore.finalizeReview(job.jobId, {
        submissionId: submission.id,
        reviewEpoch: submission.reviewEpoch,
        feedbackId: feedback.id,
        verdict: feedback.verdict,
      }, Date.now());
    } catch {
      // A mismatched or stale feedback record is not authority to finalize.
    }
  }

  function trackReviewJob(job: PeerJob): void {
    if (!deps.eventStore || !job.workSessionId || job.status !== "awaiting_review") return;
    if (!reviewSubscriptions.has(job.jobId)) {
      const unsubscribe = deps.eventStore.subscribe(job.workSessionId, (event) => {
        if (event.type === "review.feedback.provided") reconcileReview(job.jobId);
      });
      reviewSubscriptions.set(job.jobId, unsubscribe);
    }
    reconcileReview(job.jobId);
  }

  const resultEventType = "peer_job.result_received";
  const resultRetryEventType = "peer_job.result_retry";
  async function drainResultOutbox(): Promise<void> {
    if (!deps.dispatchOutbox || !resultProcessor || drainingResultOutbox) return drainingResultOutbox;
    drainingResultOutbox = (async () => {
      const workerId = `peer-result-${process.pid}`;
      for (;;) {
        const event = deps.dispatchOutbox!.claimNext(workerId, 600_000, [resultEventType, resultRetryEventType]);
        if (!event) break;
        const claim: OutboxClaim = { eventId: event.id, claimOwner: workerId, claimToken: event.claimToken! };
        try {
          const job = jobStore.getJob(event.aggregateId);
          if (job && (job.status === "result_received" || job.status === "staging")) {
            await resultProcessor!.process(job);
            const current = jobStore.getJob(job.jobId);
            if (current) trackReviewJob(current);
          }
          deps.dispatchOutbox!.markCompleted(claim);
        } catch (error) {
          deps.dispatchOutbox!.release(claim, 1_000, error instanceof Error ? error.message : String(error));
          break;
        }
      }
    })().finally(() => { drainingResultOutbox = undefined; });
    return drainingResultOutbox;
  }

  const unsubscribeResultOutbox = deps.dispatchOutbox?.subscribe(() => {
    void drainResultOutbox();
  }, [resultEventType, resultRetryEventType]);

  // A process may exit after claiming a result event. The claim is durable,
  // so the startup drain alone cannot see it until its lease is reclaimed.
  // Reap only claims whose persisted expiry is already in the past, then run
  // the same idempotent drain. The outbox's CAS rotates the claim token, so a
  // late prior claimant cannot complete the recovered event.
  function recoverExpiredResultOutboxClaims(): void {
    if (!deps.dispatchOutbox || !resultProcessor) return;
    try {
      deps.dispatchOutbox.reapExpiredClaims(0);
      void drainResultOutbox();
    } catch {
      // Keep the durable event available for a later bounded recovery tick.
    }
  }

  if (deps.dispatchOutbox && resultProcessor) {
    resultOutboxRecoveryTimer = setInterval(
      recoverExpiredResultOutboxClaims,
      Math.max(1_000, deps.reapIntervalMs ?? 30_000),
    );
    resultOutboxRecoveryTimer.unref?.();
  }

  function enqueueResultEvent(job: PeerJob, attemptId: string): void {
    if (!deps.dispatchOutbox) return;
    const attempt = jobStore.getAttempt(attemptId);
    if (!attempt) return;
    const retryRevision = job.resultProcessing?.retryRevision ?? 0;
    const eventType = retryRevision > 0 ? resultRetryEventType : resultEventType;
    const aggregateRevision = retryRevision > 0 ? retryRevision : attempt.generation;
    if (deps.dispatchOutbox.hasLogical(eventType, job.jobId, aggregateRevision)) return;
    deps.dispatchOutbox.enqueue({
      eventType,
      aggregateId: job.jobId,
      aggregateRevision,
      payload: { jobId: job.jobId, attemptId, generation: attempt.generation, retryRevision },
    });
  }

  function processDirectly(job: PeerJob): void {
    if (!resultProcessor) return;
    const task = resultProcessor.process(job).then(() => {
      const current = jobStore.getJob(job.jobId);
      if (current) trackReviewJob(current);
    }).catch(() => { /* durable job state remains available for inspection */ });
    pendingResultTasks.add(task);
    void task.finally(() => pendingResultTasks.delete(task));
  }

  /**
   * URL/attempt correlation (fail-closed, no existence leak): resolve the
   * SCOPED job first, then require the presented attempt to belong to it.
   * Cross-peer attempts and foreign attempts answer 404, never 403.
   */
  function resolveJobAndAttempt(jobId: string, peerId: string, attemptId: string): { job: PeerJob; attempt: import("./contracts.js").PeerAttempt } {
    const job = jobStore.getJob(jobId);
    if (!job || job.peerId !== peerId) {
      // Scoped 404: no existence leak across peers.
      throw new PeerJobError("job_not_found", "Job not found", 404);
    }
    const attempt = jobStore.getAttempt(attemptId);
    if (!attempt || attempt.jobId !== job.jobId) {
      throw new PeerJobError("job_attempt_mismatch", "Attempt does not belong to this job", 404);
    }
    return { job, attempt };
  }

  app.post("/peer/jobs/claim", (req: PeerJobRequest, res: Response) => {
    try {
      const peerId = requireCapability(req, "job:claim");
      if (deps.isShuttingDown?.()) {
        fail(res, 503, "shutting_down", "Peer job claims are refused during shutdown");
        return;
      }
      const body = (req.body ?? {}) as { taskClass?: unknown };
      const taskClassFilter = typeof body.taskClass === "string" ? body.taskClass : undefined;
      const now = Date.now();
      // Claim the oldest matching pending job for THIS peer only.
      const claimed = jobStore.claimNextJob(peerId, now, { taskClass: taskClassFilter });
      if (!claimed) {
        res.status(204).json({ claimed: false });
        return;
      }
      res.status(200).json({
        job: peerJobProjection(claimed.job),
        attempt: {
          attemptId: claimed.attempt.attemptId,
          claimToken: claimed.attempt.claimToken,
          leaseExpiresAt: claimed.attempt.leaseExpiresAt,
        },
        instructions: claimed.job.instructions,
      });
    } catch (error) {
      handleJobError(res, error);
    }
  });

  app.post("/peer/jobs/:jobId/started", (req: PeerJobRequest, res: Response) => {
    try {
      const peerId = requireCapability(req, "job:claim");
      const { attemptId, claimToken } = fenceCredentials(req.body ?? {});
      const remoteExecutionId =
        typeof (req.body as { remoteExecutionId?: unknown }).remoteExecutionId === "string"
          ? (req.body as { remoteExecutionId: string }).remoteExecutionId
          : undefined;
      resolveJobAndAttempt(String(req.params.jobId), peerId, attemptId);
      const { job } = jobStore.markStarted(attemptId, claimToken, peerId, Date.now(), remoteExecutionId);
      res.status(200).json({ job: peerJobProjection(job) });
    } catch (error) {
      handleJobError(res, error);
    }
  });

  app.post("/peer/jobs/:jobId/renew", (req: PeerJobRequest, res: Response) => {
    try {
      const peerId = requireCapability(req, "job:claim");
      const { attemptId, claimToken } = fenceCredentials(req.body ?? {});
      const body = req.body as { leaseMs?: unknown };
      const leaseMs = typeof body.leaseMs === "number" ? body.leaseMs : 60_000;
      resolveJobAndAttempt(String(req.params.jobId), peerId, attemptId);
      const { attempt } = jobStore.renewLease(attemptId, claimToken, peerId, Date.now(), leaseMs);
      res.status(200).json({ leaseExpiresAt: attempt.leaseExpiresAt });
    } catch (error) {
      handleJobError(res, error);
    }
  });

  // Artifact bytes travel separately from the JSON receipt so the receiver
  // can enforce the listener's byte cap and hash actual content before a
  // receipt is accepted. The claim token stays in an auth header, not a URL.
  app.put(
    "/peer/jobs/:jobId/artifacts",
    express.raw({ type: "application/octet-stream", limit: deps.config.peer.requestBytesLimit }),
    (req: PeerJobRequest, res: Response) => {
      try {
        const peerId = requireCapability(req, "job:complete");
        const attemptId = req.header("x-peer-attempt-id") ?? "";
        const claimToken = req.header("x-peer-claim-token") ?? "";
        const path = req.header("x-peer-artifact-path") ?? "";
        if (!attemptId || !claimToken || !path) {
          throw new PeerJobError("invalid_fence", "x-peer-attempt-id, x-peer-claim-token, and x-peer-artifact-path are required", 422);
        }
        if (!Buffer.isBuffer(req.body)) {
          throw new PeerJobError("invalid_artifact_body", "Content-Type must be application/octet-stream", 415);
        }
        const { job } = jobStore.authorizeAttempt(String(req.params.jobId), attemptId, claimToken, peerId, Date.now());
        const result = artifacts.put({ job, attemptId, path, bytes: req.body });
        res.status(200).json(result);
      } catch (error) {
        handleJobError(res, error);
      }
    },
  );

  app.post("/peer/jobs/:jobId/result", (req: PeerJobRequest, res: Response) => {
    try {
      const peerId = requireCapability(req, "job:complete");
      const { attemptId, claimToken } = fenceCredentials(req.body ?? {});
      const receipt = (req.body as { receipt?: PeerJobResultReceipt }).receipt;
      if (!receipt || typeof receipt !== "object") {
        throw new PeerJobError("invalid_receipt", "receipt is required", 422);
      }
      const { job, attempt } = resolveJobAndAttempt(String(req.params.jobId), peerId, attemptId);
      // Idempotency and conflicts are decided INSIDE the store by canonical
      // comparison of the stored receipt — the HTTP layer never shortcuts.
      validateResultReceipt(job, attempt, receipt);
      if (receipt.terminalState === "succeeded") {
        // The manifest is only a claim until every declared byte is present
        // in private durable staging and re-hashes to the declared content.
        artifacts.readReceipt(job, attemptId, receipt);
      }
      const { job: updated, idempotent } = jobStore.completeAttempt(attemptId, claimToken, peerId, receipt, Date.now());
      if (updated.status === "result_received" && resultProcessor) {
        if (deps.dispatchOutbox) enqueueResultEvent(updated, attemptId);
        else processDirectly(updated);
      } else if (["completed", "failed", "cancelled", "review_changes_requested"].includes(updated.status)) {
        releasePeerJobWorkspaceReservation(deps.workSessions, updated);
      }
      res.status(200).json({ job: peerJobProjection(updated), ...(idempotent ? { idempotent: true } : {}) });
    } catch (error) {
      handleJobError(res, error);
    }
  });

  app.post("/peer/jobs/:jobId/not-started", (req: PeerJobRequest, res: Response) => {
    try {
      const peerId = requireCapability(req, "job:claim");
      const { attemptId, claimToken } = fenceCredentials(req.body ?? {});
      resolveJobAndAttempt(String(req.params.jobId), peerId, attemptId);
      const { job } = jobStore.markNotStarted(attemptId, claimToken, peerId, Date.now());
      res.status(200).json({ job: peerJobProjection(job) });
    } catch (error) {
      handleJobError(res, error);
    }
  });

  app.post("/peer/jobs/:jobId/fail", (req: PeerJobRequest, res: Response) => {
    try {
      const peerId = requireCapability(req, "job:claim");
      const { attemptId, claimToken } = fenceCredentials(req.body ?? {});
      const body = req.body as { reason?: unknown };
      const reason = typeof body.reason === "string" && body.reason.length > 0 ? body.reason : "unspecified";
      resolveJobAndAttempt(String(req.params.jobId), peerId, attemptId);
      const { job } = jobStore.failAttempt(attemptId, claimToken, peerId, reason, Date.now());
      res.status(200).json({ job: peerJobProjection(job) });
    } catch (error) {
      handleJobError(res, error);
    }
  });

  app.post("/peer/jobs/:jobId/cancel-ack", (req: PeerJobRequest, res: Response) => {
    try {
      const peerId = requireCapability(req, "job:cancel_ack");
      const body = (req.body ?? {}) as AttemptCredentials;
      const job = jobStore.getJob(String(req.params.jobId));
      if (!job || job.peerId !== peerId) {
        fail(res, 404, "job_not_found", "Job not found");
        return;
      }
      if (typeof body.attemptId === "string" && typeof body.claimToken === "string") {
        const attempt = jobStore.getAttempt(body.attemptId);
        if (!attempt || attempt.jobId !== job.jobId) {
          fail(res, 404, "job_attempt_mismatch", "Attempt does not belong to this job");
          return;
        }
        const { job: updated } = jobStore.cancelAck(body.attemptId, body.claimToken, peerId, Date.now());
        releasePeerJobWorkspaceReservation(deps.workSessions, updated);
        res.status(200).json({ job: peerJobProjection(updated) });
        return;
      }
      // No active attempt presented: cancel the unclaimed/requested job.
      const updated = jobStore.cancelUnclaimedJob(job.jobId, Date.now());
      releasePeerJobWorkspaceReservation(deps.workSessions, updated);
      res.status(200).json({ job: peerJobProjection(updated) });
    } catch (error) {
      handleJobError(res, error);
    }
  });

  app.get("/peer/jobs/:jobId/status", (req: PeerJobRequest, res: Response) => {
    try {
      const peerId = requireCapability(req, "job:claim");
      const job: PeerJob | undefined = jobStore.getJob(String(req.params.jobId));
      if (!job || job.peerId !== peerId) {
        // Scoped 404 — never leak the existence of another peer's job.
        fail(res, 404, "job_not_found", "Job not found");
        return;
      }
      res.status(200).json({ job: peerJobProjection(job) });
    } catch (error) {
      handleJobError(res, error);
    }
  });

  app.get("/peer/jobs/:jobId/instructions", (req: PeerJobRequest, res: Response) => {
    try {
      const peerId = requireCapability(req, "job:claim");
      const job: PeerJob | undefined = jobStore.getJob(String(req.params.jobId));
      if (!job || job.peerId !== peerId) {
        // Scoped 404 — no existence leak across peers.
        fail(res, 404, "job_not_found", "Job not found");
        return;
      }
      res.status(200).json({ instructions: job.instructions });
    } catch (error) {
      handleJobError(res, error);
    }
  });

  app.get("/peer/commands", (req: PeerJobRequest, res: Response) => {
    try {
      const peerId = requireCapability(req, "job:claim");
      const pendingJobs = jobStore.listJobsForPeer(peerId).filter((job) => job.status === "pending");
      res.status(200).json({
        pendingJobs: pendingJobs.length,
        commands: pendingJobs.map((job) => ({
          jobId: job.jobId,
          taskClass: job.taskClass,
          repositoryId: job.repositoryId,
          baseRevision: job.baseRevision,
          instructionHash: job.instructionHash,
          maxRuntimeMs: job.maxRuntimeMs,
          maxArtifactBytes: job.maxArtifactBytes,
        })),
      });
    } catch (error) {
      handleJobError(res, error);
    }
  });

  // Durable SQLite results survive process restarts. Reconcile the only
  // retry-safe states on startup; a result already in awaiting_reconciliation
  // requires owner inspection and is never silently replayed.
  if (resultProcessor) {
    for (const peer of deps.config.peer.allowedPeers) {
      for (const job of jobStore.listJobsForPeer(peer.id, { includeTerminal: true })) {
        reconcilePeerJobWorkspaceReservations(deps.workSessions, [job]);
        if ((job.status === "result_received" || job.status === "staging") && deps.dispatchOutbox) {
          const attempt = [...jobStore.listAttemptsForJob(job.jobId)].reverse().find((candidate) => candidate.receipt?.terminalState === "succeeded");
          if (attempt) enqueueResultEvent(job, attempt.attemptId);
        } else if (job.status === "result_received" || job.status === "staging") {
          processDirectly(job);
        } else if (job.status === "awaiting_review" && job.resultProcessing?.verificationStatus === undefined) {
          // Repair legacy/interrupted rows whose review link was persisted
          // before the verification receipt. The processor reuses the exact
          // receipt and existing snapshot/submission, then fills only that
          // missing verification field.
          processDirectly(job);
        }
        const current = jobStore.getJob(job.jobId);
        if (current) trackReviewJob(current);
      }
    }
    if (deps.dispatchOutbox) {
      recoverExpiredResultOutboxClaims();
      void drainResultOutbox();
    }
  }

  return {
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        reaper.stop();
        if (resultOutboxRecoveryTimer) {
          clearInterval(resultOutboxRecoveryTimer);
          resultOutboxRecoveryTimer = undefined;
        }
        unsubscribeResultOutbox?.();
        if (drainingResultOutbox) await drainingResultOutbox;
        if (pendingResultTasks.size > 0) await Promise.allSettled([...pendingResultTasks]);
        for (const unsubscribe of reviewSubscriptions.values()) unsubscribe();
        reviewSubscriptions.clear();
        if (getPeerJobStore() === jobStore) {
          jobStore.close();
          setPeerJobStoreSingleton(undefined);
        }
      })();
      return closePromise;
    },
  };
}

// Re-export for test convenience.
export { openPeerJobStore, getPeerJobStore, enforcePeerJobsCap, validateResultReceipt };
