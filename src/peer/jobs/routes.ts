/**
 * M3 peer job HTTP routes mounted under /peer. Authentication is already
 * applied by the peer-app middleware (req.peerPrincipal is the ONLY trusted
 * identity); a caller-supplied peerId is never honored. Mutating routes
 * fence on exact peer + attempt + token + generation, and EVERY job route
 * requires the corresponding owner-granted job:* capability.
 */
import type { Express, Request, Response } from "express";
import { createPeerJobsService } from "./service.js";
import { enforcePeerJobsCap } from "./service.js";
import { validateResultReceipt } from "./service.js";
import { openPeerJobStore, setPeerJobStoreSingleton, getPeerJobStore } from "./store.js";
import { PeerJobError } from "./contracts.js";
import type { PeerJob, PeerJobResultReceipt } from "./contracts.js";
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

export interface PeerJobRoutesHandle {
  close(): void;
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
 * for tests). Store lifecycle binds to the process; the durable sidecar
 * makes restart safe. Returns a close() for explicit teardown in tests.
 */
export function registerPeerJobRoutes(app: Express, deps: PeerJobRouteDeps): PeerJobRoutesHandle {
  let store = getPeerJobStore();
  if (!store) {
    store = openPeerJobStore(deps.config.stateDir, deps.logging);
    setPeerJobStoreSingleton(store);
  }
  const jobStore: NonNullable<typeof store> = store;  const service = createPeerJobsService({
    store,
    config: { peer: { maxClaimedJobs: deps.config.peer.maxClaimedJobs } },
    logging: deps.logging,
  });
  const reaper = createPeerJobReaper(jobStore, deps.reapIntervalMs ?? 30_000);
  reaper.start();

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
        job: claimed.job,
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
      res.status(200).json({ job });
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
      const { job: updated, idempotent } = jobStore.completeAttempt(attemptId, claimToken, peerId, receipt, Date.now());
      res.status(200).json({ job: updated, ...(idempotent ? { idempotent: true } : {}) });
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
      res.status(200).json({ job });
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
      res.status(200).json({ job });
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
        res.status(200).json({ job: updated });
        return;
      }
      // No active attempt presented: cancel the unclaimed/requested job.
      const updated = jobStore.cancelUnclaimedJob(job.jobId, Date.now());
      res.status(200).json({ job: updated });
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
      res.status(200).json({ job });
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

  return {
    close() {
      reaper.stop();
      if (getPeerJobStore() === jobStore) {
        jobStore.close();
        setPeerJobStoreSingleton(undefined);
      }
    },
  };
}

// Re-export for test convenience.
export { openPeerJobStore, getPeerJobStore, enforcePeerJobsCap, validateResultReceipt };
