/**
 * Durable scheduled-job runtime (S02).
 *
 * The scheduler is a TRIGGER, not a second supervisor: it decides when a job
 * is due and hands it to the canonical ACP dispatch path. SQLite remains the
 * authoritative job record; the process timer only provides a bounded wakeup.
 */
import { createDispatchOutbox } from "../dispatch-outbox.js";
import { createHash } from "node:crypto";
import type { DispatchOutbox, OutboxClaim } from "../dispatch-outbox.js";
import type { DatabaseHandle } from "../db/client.js";
import type { EventStore, EventStoreEvent } from "../event-log.js";
import type { ScheduledJob, ScheduledJobStore } from "./scheduled-job-store.js";
import type { ReadOnlyExecutionReceipt } from "../acp-gateway.js";

export interface ScheduledDispatchOutcome {
  status: "dispatched" | "blocked" | "failed" | "uncertain";
  workSessionId?: string;
  runId?: string;
  dispatchId?: string;
  remoteRunId?: string;
  attemptNumber?: number;
  executionReceipt?: ReadOnlyExecutionReceipt;
  reason?: string;
}

export interface ScheduledJobRuntime {
  start(): void;
  stop(): void;
  drainOnce(): Promise<void>;
  wake(): void;
  reconcileJob(jobId: string): Promise<ScheduledJob | undefined>;
  getMetrics(): {
    oldestDueJobAgeMs: number;
    uncertainLaunches: number;
    oldestUnreconciledAttemptAgeMs: number;
    acceptedDispatchesLastMinute: number;
    cancellationRequests: number;
    operatorInterventionJobs: number;
    recentDrainFailures: number;
    lastDrainFailureAt?: string;
    lastDrainFailurePhase?: string;
    lastDrainFailureClass?: string;
    lastDrainFailureFingerprint?: string;
    lastDrainFailureRecurrenceCount?: number;
    serviceability: { status: "healthy" | "degraded"; reasons: string[] };
  };
}

/** Reconciliation outcome for an interrupted external dispatch attempt. */
export interface ScheduledDispatchReconciliationOutcome {
  /** Accepted: attach the original run/session and continue tracking it. */
  status: "accepted" | "unstarted" | "unresolved" | "operator_intervention" | "terminal";
  workSessionId?: string;
  runId?: string;
  remoteRunId?: string;
  dispatchId?: string;
  attemptNumber?: number;
  executionReceipt?: ReadOnlyExecutionReceipt;
  terminalStatus?: "completed" | "failed" | "cancelled";
  reason?: string;
}

export interface ScheduledCancellationReconciliationOutcome {
  state: "waiting" | "not_dispatched" | "worker_active" | "termination_acknowledged" | "remote_missing" | "worker_stopped" | "worker_cancelled" | "unknown";
  reason?: string;
}

export interface ScheduledJobRuntimeOptions {
  database: DatabaseHandle;
  jobs: ScheduledJobStore;
  events?: EventStore;
  dispatchOutbox?: DispatchOutbox;
  /**
   * Authorized dispatch hook. Returns the resulting job-relevant status plus
   * the durable work-session correlation and any real failure reason, so the
   * recorded job carries its evidence rather than only a status word.
   */
  dispatch?: (jobId: string, attempt: { dispatchId: string }) => Promise<ScheduledDispatchOutcome>;
  /** Query the authoritative run registry for an interrupted dispatch attempt. */
  reconcileDispatch?: (input: {
    jobId: string;
    dispatchAttemptId: string;
    dispatchId: string;
  }) => Promise<ScheduledDispatchReconciliationOutcome>;
  reconcileCancellation?: (job: ScheduledJob) => Promise<ScheduledCancellationReconciliationOutcome>;
  schedulerInstanceId?: string;
  leaseMs?: number;
  pollMs?: number;
  dispatchConcurrency?: number;
}

export function createScheduledJobRuntime(options: ScheduledJobRuntimeOptions): ScheduledJobRuntime {
  const database = options.database;
  const jobs = options.jobs;
  const dispatchOutbox = options.dispatchOutbox ?? createDispatchOutbox(database);
  const schedulerInstanceId = options.schedulerInstanceId ?? "kontrol-scheduler";
  const leaseMs = options.leaseMs ?? 60_000;
  const pollMs = options.pollMs ?? 5_000;
  const dispatchConcurrency = Math.max(1, Math.min(16, options.dispatchConcurrency ?? 4));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let currentDrain: Promise<void> | null = null;
  let unsubscribeEvents: (() => void) | undefined;
  let projectionDrain: Promise<void> | null = null;
  let activeDrainJobId: string | undefined;
  let activeDrainAttemptId: string | undefined;
  const pendingProjectionSessions = new Set<string>();
  let cancellationCursor = "";
  let activeCancellationScan = false;
  let nonterminalCursor = "";
  let deadlineCursor = "";
  let dispatchRecoveryCursor = "";
  let projectionTargetCursor = "";
  const recentDrainFailures: Array<{ at: number; phase: string; failureClass: string; fingerprint: string; recurrenceCount: number }> = [];
  const recurrenceByFingerprint = new Map<string, number>();

  function recordDrainFailure(phase: string, error: unknown, jobId?: string, attemptId?: string): void {
    const message = error instanceof Error ? error.message : String(error);
    const failureClass = error instanceof Error ? error.name || "Error" : "NonErrorThrow";
    const fingerprint = createHash("sha256").update(`${phase}\n${failureClass}\n${message}`).digest("hex");
    let durableRecurrenceCount = 0;
    try {
      const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
      const rows = database.sqlite.prepare(`
        select payload_json from event_log
         where type = 'scheduled_job.scheduler_error' and created_at >= ?
         order by seq desc limit 100
      `).all(cutoff) as Array<{ payload_json: string }>;
      durableRecurrenceCount = rows.reduce((count, row) => {
        try { return count + (JSON.parse(row.payload_json)?.fingerprint === fingerprint ? 1 : 0); }
        catch { return count; }
      }, 0);
    } catch { /* a failing diagnostic read must not stop the scheduler */ }
    const recurrenceCount = Math.max(recurrenceByFingerprint.get(fingerprint) ?? 0, durableRecurrenceCount) + 1;
    recurrenceByFingerprint.set(fingerprint, recurrenceCount);
    const at = Date.now();
    recentDrainFailures.push({ at, phase, failureClass, fingerprint, recurrenceCount });
    while (recentDrainFailures.length > 100) recentDrainFailures.shift();
    let sessionId = "scheduler-runtime";
    if (jobId) {
      try {
        const job = jobs.get(jobId);
        sessionId = job?.workSessionId ?? job?.projectId ?? sessionId;
      } catch {
        // Failure attribution must not recursively fail because the same
        // scheduler database read path is unhealthy. Keep the job ID in the
        // payload and persist under the scheduler-owned fallback session.
      }
    }
    try {
      options.events?.appendEvent({
        type: "scheduled_job.scheduler_error",
        sessionId,
        payload: {
          operationPhase: phase,
          failureClass,
          fingerprint,
          recurrenceCount,
          scheduledJobId: jobId,
          dispatchAttemptId: attemptId,
          retryEligible: true,
          retryAfterMs: pollMs,
          occurredAt: new Date(at).toISOString(),
          message: message.slice(0, 1_000),
        },
      }, { publish: false });
    } catch { /* the scheduler remains alive even if its diagnostic sink fails */ }
  }

  const projectedEventTypes = new Set([
    "agent.run.started",
    "review.submitted",
    "worker.turn.completed",
    "agent.run.completed",
    "agent.run.approved",
    "agent.run.rejected",
    "agent.run.failed",
    "agent.run.failed_protocol",
    "agent.run.cancelled",
    "worker.attempt.failed",
    "worker.attempt.exited",
  ]);

  async function projectSessionEvents(sessionId: string): Promise<void> {
    const eventStore = options.events;
    if (!eventStore) return;
    const job = jobs.getByWorkSessionId(sessionId);
    if (!job || ["completed", "failed", "cancelled", "blocked"].includes(job.status)) return;
    let cursor = job.lifecycleEventCursor;
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const page = eventStore.getEventsAfter(sessionId, cursor, 250);
      if (page.length === 0) return;
      for (const event of page) {
        jobs.projectEvent(event);
        cursor = Math.max(cursor, event.seq);
      }
      if (page.length < 250) return;
    }
  }

  function scheduleProjection(sessionId: string): void {
    if (!options.events || !sessionId) return;
    pendingProjectionSessions.add(sessionId);
    if (projectionDrain) return;
    projectionDrain = (async () => {
      while (pendingProjectionSessions.size > 0) {
        const next = pendingProjectionSessions.values().next().value as string | undefined;
        if (!next) break;
        pendingProjectionSessions.delete(next);
        try {
          await projectSessionEvents(next);
        } catch {
          // Durable replay on the next scheduler pass/startup retries this
          // session; notifications never become the source of truth.
          pendingProjectionSessions.add(next);
          return;
        }
      }
    })().finally(() => { projectionDrain = null; });
  }

  async function reconcileProjectableEvents(): Promise<void> {
    if (!options.events) return;
    const targets = jobs.listProjectionTargets(projectionTargetCursor, 25);
    if (targets.length === 0) {
      projectionTargetCursor = "";
      return;
    }
    for (const job of targets) {
      const previousCursor = projectionTargetCursor;
      projectionTargetCursor = job.id;
      activeDrainJobId = job.id;
      activeDrainAttemptId = job.activeDispatchAttemptId;
      try {
        if (job.workSessionId) await projectSessionEvents(job.workSessionId);
      } catch (error) {
        // Keep the failed target at the head of the next bounded page so a
        // transient projection/read error is retried on the next poll.
        projectionTargetCursor = previousCursor;
        throw error;
      }
    }
    activeDrainJobId = undefined;
    activeDrainAttemptId = undefined;
    if (targets.length < 25) projectionTargetCursor = "";
  }

  // CAS a still-pending job to due. Returns the current revision when the
  // transition happened, otherwise undefined (already due/running/terminal).
  function markDue(jobId: string): number | undefined {
    const now = new Date().toISOString();
    const result = database.sqlite
      .prepare("update scheduled_jobs set status = 'due', revision = revision + 1, updated_at = ? where id = ? and status = 'pending'")
      .run(now, jobId);
    if (result.changes !== 1) return undefined;
    const row = database.sqlite.prepare("select revision from scheduled_jobs where id = ?").get(jobId) as { revision?: number } | undefined;
    return row?.revision;
  }

  /**
   * Startup reconciliation: any nonterminal job whose due event was lost (e.g.
   * the outbox row was deleted or reaped past dead-lettering) is re-armed.
   * The due event itself is idempotent per (jobId, revision) so this never
   * creates duplicate logical executions.
   */
  function reconcileRunningDeadlines(): void {
    const now = Date.now();
    const rows = database.sqlite
      .prepare(`
        select job.id as id, job.revision as revision, job.status as status, job.work_session_id as work_session_id,
               job.max_runtime_ms as max_runtime_ms, attempt.execution_active_since as execution_active_since,
               attempt.active_runtime_ms as active_runtime_ms
          from scheduled_jobs job
          left join scheduled_job_attempts attempt on attempt.id = job.active_dispatch_attempt_id
         where job.status = 'running' and job.id > ?
         order by job.id
         limit 100
      `)
      .all(deadlineCursor) as Array<{ id: string; revision: number; status: string; work_session_id: string | null; max_runtime_ms: number; execution_active_since: string | null; active_runtime_ms: number }>;
    for (const row of rows) {
      deadlineCursor = row.id;
      // Only active worker runtime counts toward maxRuntimeMs. Approval-waiting
      // time is human response time, not worker execution time, and an expired
      // timer must not fabricate a failure while remote work may still run.
      if (!row.status) continue;
      if (!row.execution_active_since) continue;
      const activeSince = Date.parse(row.execution_active_since);
      if (!Number.isFinite(activeSince)) continue;
      const elapsed = Math.max(0, Number(row.active_runtime_ms ?? 0)) + Math.max(0, now - activeSince);
      if (elapsed < row.max_runtime_ms) continue;
      // Local timer expiry alone is not proof that the remote worker stopped.
      // Move to an explicitly reconcilable cancellation request; the canonical
      // remote cancellation path or operator can confirm the terminal result.
      try {
        jobs.requestCancellation({
          jobId: row.id,
          expectedRevision: row.revision,
          requestId: `runtime:${row.id}:deadline`,
          reason: "Scheduled worker runtime exceeded maxRuntimeMs; cancellation requested.",
        });
      } catch {
        // A concurrent terminal/cancel transition wins; never overwrite it.
      }
    }
    if (rows.length < 100) deadlineCursor = "";
  }

  function reconcileNonterminalJobs(): void {
    const rows = database.sqlite
      .prepare("select id, revision, run_at from scheduled_jobs where status in ('pending','due','reconciling') and id > ? order by id limit 100")
      .all(nonterminalCursor) as Array<{ id: string; revision: number; run_at: string }>;
    const now = new Date().toISOString();
    for (const row of rows) {
      nonterminalCursor = row.id;
      const alreadyDue = Date.parse(row.run_at) <= Date.parse(now);
      const status = alreadyDue ? "due" : "pending";
      database.sqlite
        .prepare("update scheduled_jobs set status = ?, updated_at = ? where id = ? and status in ('pending','due','reconciling') and revision = ?")
        .run(status, now, row.id, row.revision);
      // Re-arm the due trigger under the canonical logical key; enqueue() is
      // idempotent for the same (type, aggregateId, revision). Dispatching
      // jobs are intentionally excluded: an expired lease represents a
      // possible accepted launch, not permission to blindly redispatch.
      dispatchOutbox.enqueue({
        eventType: "scheduled_job.due",
        aggregateId: row.id,
        aggregateRevision: row.revision,
        availableAt: row.run_at,
        payload: { scheduledJobId: row.id, revision: row.revision, reconciled: true },
      });
    }
    if (rows.length < 100) nonterminalCursor = "";
  }

  // Interrupted dispatch attempts are reconciled against the authoritative
  // run registry. An expired lease is never proof that remote work did not
  // start; an unresolved attempt remains recoverable rather than being blindly
  // relaunched.
  async function reconcileInterruptedDispatches(): Promise<void> {
    if (!options.reconcileDispatch) return;
    const now = new Date().toISOString();
    const rows = database.sqlite
      .prepare(`
        select job.id as job_id, job.revision as job_revision,
               job.status as job_status,
               attempt.id as attempt_id, attempt.dispatch_id as dispatch_id,
               attempt.lease_expires_at as lease_expires_at
          from scheduled_jobs job
          join scheduled_job_attempts attempt on attempt.id = job.active_dispatch_attempt_id
         where job.status in ('dispatching','uncertain_dispatch','operator_intervention','cancellation_requested')
           and attempt.completed_at is null
           and attempt.transport_status in ('dispatching','uncertain')
           and attempt.id > ?
           and (job.status = 'uncertain_dispatch' or attempt.lease_expires_at is null or attempt.lease_expires_at <= ?)
         order by attempt.id
         limit 100
      `)
      .all(dispatchRecoveryCursor, now) as Array<{ job_id: string; job_revision: number; job_status: string; attempt_id: string; dispatch_id: string; lease_expires_at: string | null }>;
    for (const row of rows) {
      dispatchRecoveryCursor = row.attempt_id;
      try {
        const outcome = await options.reconcileDispatch({
          jobId: row.job_id,
          dispatchAttemptId: row.attempt_id,
          dispatchId: row.dispatch_id,
        });
        if (outcome.status === "accepted") {
          const current = jobs.get(row.job_id);
          if (!current || !["dispatching", "uncertain_dispatch", "operator_intervention", "cancellation_requested"].includes(current.status)) continue;
          jobs.resolveDispatch({
            jobId: row.job_id,
            dispatchAttemptId: row.attempt_id,
            expectedRevision: current.revision,
            resolution: "accepted",
            workSessionId: outcome.workSessionId ?? current.workSessionId,
            acpRunId: outcome.runId,
            acpDispatchId: outcome.dispatchId ?? row.dispatch_id,
            acpAttemptNumber: outcome.attemptNumber,
            acpRemoteRunId: outcome.remoteRunId,
            executionReceipt: outcome.executionReceipt,
            lastError: outcome.reason,
          });
          if (outcome.workSessionId) scheduleProjection(outcome.workSessionId);
        } else if (outcome.status === "terminal") {
          const current = jobs.get(row.job_id);
          if (!current || !["dispatching", "uncertain_dispatch", "operator_intervention", "cancellation_requested"].includes(current.status)) continue;
          jobs.resolveDispatch({
            jobId: row.job_id,
            dispatchAttemptId: row.attempt_id,
            expectedRevision: current.revision,
            resolution: outcome.terminalStatus ?? "failed",
            workSessionId: outcome.workSessionId ?? current.workSessionId,
            acpRunId: outcome.runId,
            acpDispatchId: outcome.dispatchId ?? row.dispatch_id,
            acpAttemptNumber: outcome.attemptNumber,
            acpRemoteRunId: outcome.remoteRunId,
            executionReceipt: outcome.executionReceipt,
            lastError: outcome.reason,
          });
        } else if (outcome.status === "operator_intervention") {
          const current = jobs.get(row.job_id);
          if (!current || !["dispatching", "uncertain_dispatch", "operator_intervention", "cancellation_requested"].includes(current.status)) continue;
          jobs.resolveDispatch({
            jobId: row.job_id,
            dispatchAttemptId: row.attempt_id,
            expectedRevision: current.revision,
            resolution: "operator_intervention",
            workSessionId: outcome.workSessionId ?? current.workSessionId,
            acpRunId: outcome.runId,
            executionReceipt: outcome.executionReceipt,
            lastError: outcome.reason ?? "Dispatch could not be authoritatively reconciled; operator action is required.",
          });
        } else if (outcome.status === "unstarted") {
          const current = jobs.get(row.job_id);
          if (!current || !["dispatching", "uncertain_dispatch", "operator_intervention", "cancellation_requested"].includes(current.status)) continue;
          const released = jobs.resolveDispatch({
            jobId: row.job_id,
            dispatchAttemptId: row.attempt_id,
            expectedRevision: current.revision,
            resolution: "unstarted",
            lastError: outcome.reason,
          });
          if (released.status === "cancellation_requested" && released.cancellationRequestId
            && released.cancellationLastConfirmedState === "not_dispatched") {
            jobs.finalizeCancellation({
              jobId: released.id,
              requestId: released.cancellationRequestId,
              lastConfirmedState: "not_dispatched",
              reason: "Cancellation confirmed before the adapter accepted the dispatch.",
            });
            continue;
          }
          dispatchOutbox.enqueue({
            eventType: "scheduled_job.due",
            aggregateId: row.job_id,
            aggregateRevision: released.revision,
            availableAt: new Date().toISOString(),
            payload: { scheduledJobId: row.job_id, revision: released.revision, reconciledRetry: true },
          });
        } else {
          const current = jobs.get(row.job_id);
          if (!current || current.status === "uncertain_dispatch") continue;
          jobs.transition({
            jobId: row.job_id,
            expectedRevision: current.revision,
            nextStatus: "uncertain_dispatch",
            expectedSourceStatuses: ["dispatching"],
            lastError: outcome.reason ?? "Interrupted dispatch could not be resolved; reconciliation is required.",
          });
        }
      } catch (error) {
        recordDrainFailure("reconcile_dispatch", error, row.job_id, row.attempt_id);
        const current = jobs.get(row.job_id);
          if (current && ["dispatching", "operator_intervention"].includes(current.status)) {
          try {
            jobs.transition({
              jobId: row.job_id,
              expectedRevision: current.revision,
              nextStatus: "uncertain_dispatch",
              expectedSourceStatuses: ["dispatching"],
              lastError: `Dispatch reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          } catch {
            // A concurrent terminal transition wins; startup must not overwrite it.
          }
        }
      }
    }
    if (rows.length < 100) dispatchRecoveryCursor = "";
  }

  async function reconcileCancellations(): Promise<void> {
    if (activeCancellationScan) return;
    activeCancellationScan = true;
    try {
      const jobsPage = jobs.listCancellationTargets(cancellationCursor, 100);
      if (jobsPage.length === 0) {
        cancellationCursor = "";
        return;
      }
      for (const job of jobsPage) {
        cancellationCursor = job.id;
        const requestId = job.cancellationRequestId;
        if (!requestId) continue;
        if (job.cancellationLastConfirmedState === "not_dispatched") {
          try {
            jobs.finalizeCancellation({ jobId: job.id, requestId, lastConfirmedState: "not_dispatched" });
          } catch { /* another lifecycle event or cancellation pass won */ }
          continue;
        }
        if (!options.reconcileCancellation
          || !jobs.claimCancellationAttempt({ jobId: job.id, requestId, minimumIntervalMs: 30_000 })) continue;
        try {
          const outcome = await options.reconcileCancellation(job);
          if (outcome.state === "not_dispatched" || outcome.state === "remote_missing" || outcome.state === "worker_stopped" || outcome.state === "worker_cancelled") {
            jobs.recordCancellationEvidence({ jobId: job.id, requestId, state: outcome.state, lastError: outcome.reason });
            jobs.finalizeCancellation({
              jobId: job.id,
              requestId,
              lastConfirmedState: outcome.state,
              reason: outcome.reason ?? "Worker shutdown confirmed.",
            });
          } else {
            jobs.recordCancellationEvidence({
              jobId: job.id,
              requestId,
              state: outcome.state === "waiting" ? "unknown" : outcome.state,
              lastError: outcome.reason,
            });
          }
        } catch (error) {
          recordDrainFailure("reconcile_cancellation", error, job.id, job.activeDispatchAttemptId);
          try {
            jobs.recordCancellationEvidence({
              jobId: job.id,
              requestId,
              state: "unknown",
              lastError: `Cancellation reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          } catch { /* a terminal event may have resolved cancellation */ }
        }
      }
      if (jobsPage.length < 100) cancellationCursor = "";
    } finally {
      activeCancellationScan = false;
    }
  }

  /** Reviewer-triggered authoritative reconciliation; this path never launches a worker. */
  async function reconcileJob(jobId: string): Promise<ScheduledJob | undefined> {
    const job = jobs.get(jobId);
    if (!job || job.status !== "operator_intervention" || !job.activeDispatchAttemptId || !options.reconcileDispatch) return job;
    const attempt = jobs.getAttempt(job.id, job.activeDispatchAttemptId);
    if (!attempt) return job;
    const outcome = await options.reconcileDispatch({
      jobId: job.id,
      dispatchAttemptId: attempt.id,
      dispatchId: attempt.dispatchId,
    });
    const current = jobs.get(jobId);
    if (!current || current.revision !== job.revision || current.activeDispatchAttemptId !== attempt.id
      || current.status !== "operator_intervention") return current;
    const resolution = outcome.status === "accepted" ? "accepted"
      : outcome.status === "unstarted" ? "unstarted"
        : outcome.status === "terminal" ? outcome.terminalStatus ?? "failed"
          : "operator_intervention";
    const resolved = jobs.resolveDispatch({
      jobId: current.id,
      dispatchAttemptId: attempt.id,
      expectedRevision: current.revision,
      resolution,
      workSessionId: outcome.workSessionId ?? current.workSessionId,
      acpRunId: outcome.runId ?? attempt.acpRunId,
      acpDispatchId: outcome.dispatchId ?? attempt.acpDispatchId ?? attempt.dispatchId,
      acpAttemptNumber: outcome.attemptNumber ?? attempt.acpAttemptNumber,
      acpRemoteRunId: outcome.remoteRunId ?? attempt.acpRemoteRunId,
      executionReceipt: outcome.executionReceipt,
      lastError: outcome.reason,
    });
    if (outcome.workSessionId && outcome.status === "accepted") scheduleProjection(outcome.workSessionId);
    if (outcome.status === "unstarted") {
      dispatchOutbox.enqueue({
        eventType: "scheduled_job.due",
        aggregateId: resolved.id,
        aggregateRevision: resolved.revision,
        availableAt: new Date().toISOString(),
        payload: { scheduledJobId: resolved.id, revision: resolved.revision, reviewerReconciled: true },
      });
    }
    return resolved;
  }

  function drainOnce(): Promise<void> {
    if (stopped) return Promise.resolve();
    // Single-flight: a concurrent drain (e.g. a wake during a long dispatch)
    // joins the in-flight pass instead of being dropped, so an explicit drain
    // is never silently skipped.
    if (currentDrain) return currentDrain;
    currentDrain = runDrain().finally(() => { currentDrain = null; });
    return currentDrain;
  }

  async function processDueEvent(event: { id: string; aggregateId: string; claimedBy?: string; claimToken?: string }): Promise<void> {
    const claim: OutboxClaim = { eventId: event.id, claimOwner: event.claimedBy ?? "", claimToken: event.claimToken ?? "" };
    try {
      let job = jobs.get(event.aggregateId);
      if (!job) {
        dispatchOutbox.markCompleted(claim);
        return;
      }
      if (job.status !== "pending" && job.status !== "due") {
        dispatchOutbox.markCompleted(claim);
        return;
      }
      if (job.status === "pending") {
        if (Date.parse(job.runAt) > Date.now()) {
          dispatchOutbox.release(claim, Math.max(250, Date.parse(job.runAt) - Date.now()), "scheduled job is not yet due");
          return;
        }
        const revision = markDue(job.id);
        if (revision === undefined) {
          dispatchOutbox.markCompleted(claim);
          return;
        }
        job = jobs.get(job.id) ?? job;
      }
      if (!options.dispatch) {
        dispatchOutbox.markCompleted(claim);
        return;
      }
      const dispatchClaim = jobs.claimDispatch({
        jobId: job.id,
        expectedRevision: job.revision,
        dispatcherInstanceId: schedulerInstanceId,
        leaseMs,
      });
      const outcome = await options.dispatch(job.id, { dispatchId: dispatchClaim.dispatchId });
      if (outcome.status === "dispatched" || outcome.status === "uncertain" || outcome.status === "failed") {
        const completed = jobs.completeDispatch({
          jobId: job.id,
          dispatchAttemptId: dispatchClaim.attemptId,
          expectedRevision: dispatchClaim.revision,
          dispatcherInstanceId: schedulerInstanceId,
          outcome: outcome.status,
          workSessionId: outcome.workSessionId,
          acpRunId: outcome.runId,
          acpDispatchId: outcome.dispatchId ?? dispatchClaim.dispatchId,
          acpAttemptNumber: outcome.attemptNumber,
          acpRemoteRunId: outcome.remoteRunId,
          executionReceipt: outcome.executionReceipt,
          lastError: outcome.reason,
        });
        if (completed.status === "cancellation_requested" && completed.cancellationLastConfirmedState === "not_dispatched"
          && completed.cancellationRequestId) {
          jobs.finalizeCancellation({ jobId: completed.id, requestId: completed.cancellationRequestId, lastConfirmedState: "not_dispatched" });
        }
        if (outcome.workSessionId && outcome.status !== "failed") scheduleProjection(outcome.workSessionId);
      } else {
        const released = jobs.releaseDispatch({
          jobId: job.id,
          dispatchAttemptId: dispatchClaim.attemptId,
          expectedRevision: dispatchClaim.revision,
          dispatcherInstanceId: schedulerInstanceId,
        });
        if (released.status === "cancellation_requested" && released.cancellationRequestId
          && released.cancellationLastConfirmedState === "not_dispatched") {
          jobs.finalizeCancellation({ jobId: released.id, requestId: released.cancellationRequestId, lastConfirmedState: "not_dispatched" });
          dispatchOutbox.markCompleted(claim);
          return;
        }
        dispatchOutbox.release(claim, 1000, outcome.reason ?? "scheduled dispatch blocked before launch");
        return;
      }
      dispatchOutbox.markCompleted(claim);
    } catch (error) {
      recordDrainFailure("dispatch_due_event", error, event.aggregateId);
      dispatchOutbox.markFailed(claim, error instanceof Error ? error.message : String(error), 5_000);
    }
  }

  async function runDrain(): Promise<void> {
    let phase = "reconcile_nonterminal_jobs";
    activeDrainJobId = undefined;
    activeDrainAttemptId = undefined;
    try {
      reconcileNonterminalJobs();
      phase = "outbox_claim_reaping";
      dispatchOutbox.reapExpiredClaims(leaseMs);
      phase = "project_lifecycle_events";
      await reconcileProjectableEvents();
      // Replay durable worker events before enforcing deadlines. A completion
      // already in the event log must close the execution window before an
      // overdue timer can request cancellation.
      phase = "execution_deadlines";
      reconcileRunningDeadlines();
      phase = "reconcile_interrupted_dispatches";
      await reconcileInterruptedDispatches();
      phase = "reconcile_cancellations";
      await reconcileCancellations();
      phase = "claim_and_dispatch_due_jobs";
      const dueEvents: Array<{ id: string; aggregateId: string; claimedBy?: string; claimToken?: string }> = [];
      for (let index = 0; index < dispatchConcurrency; index += 1) {
        const event = dispatchOutbox.claimNext(schedulerInstanceId, leaseMs, ["scheduled_job.due"]);
        if (!event) break;
        dueEvents.push(event);
      }
      await Promise.all(dueEvents.map((event) => processDueEvent(event)));
    } catch (error) {
      recordDrainFailure(phase, error, activeDrainJobId, activeDrainAttemptId);
      activeDrainJobId = undefined;
      activeDrainAttemptId = undefined;
      // A drain failure never stops the runtime; the next poll retries.
    }
  }

  function scheduleNext(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void drainOnce().then(() => {
        if (!stopped) scheduleNext();
      });
    }, pollMs);
  }

  function getMetrics(): ScheduledJobRuntime extends { getMetrics(): infer T } ? T : never {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const minuteAgo = new Date(now - 60_000).toISOString();
    const due = database.sqlite.prepare(`
      select min(run_at) as oldest
        from scheduled_jobs
       where status = 'due' or (status = 'pending' and run_at <= ?)
    `).get(nowIso) as { oldest?: string | null } | undefined;
    const unreconciled = database.sqlite.prepare(`
      select min(attempt.started_at) as oldest
        from scheduled_job_attempts attempt
        join scheduled_jobs job on job.active_dispatch_attempt_id = attempt.id
       where job.status in ('dispatching','uncertain_dispatch','cancellation_requested')
         and attempt.completed_at is null
         and attempt.transport_status in ('dispatching','uncertain')
    `).get() as { oldest?: string | null } | undefined;
    const uncertain = database.sqlite.prepare(`
      select count(*) as count
        from scheduled_job_attempts attempt
        join scheduled_jobs job on job.active_dispatch_attempt_id = attempt.id
       where job.status in ('dispatching','uncertain_dispatch','cancellation_requested')
         and attempt.completed_at is null
         and attempt.transport_status = 'uncertain'
    `).get() as { count?: number } | undefined;
    const accepted = database.sqlite.prepare(`
      select count(*) as count from scheduled_job_attempts
       where transport_status = 'accepted' and started_at >= ?
    `).get(minuteAgo) as { count?: number } | undefined;
    const cancellations = database.sqlite.prepare(`
      select count(*) as count from scheduled_jobs where status = 'cancellation_requested'
    `).get() as { count?: number } | undefined;
    const operatorIntervention = database.sqlite.prepare(`
      select count(*) as count from scheduled_jobs where status = 'operator_intervention'
    `).get() as { count?: number } | undefined;
    let durableFailures: Array<{ at: number; phase: string; failureClass: string; fingerprint: string; recurrenceCount: number }> = [];
    try {
      const cutoff = new Date(now - 5 * 60_000).toISOString();
      const rows = database.sqlite.prepare(`
        select created_at, payload_json from event_log
         where type = 'scheduled_job.scheduler_error' and created_at >= ?
         order by seq desc limit 100
      `).all(cutoff) as Array<{ created_at: string; payload_json: string }>;
      durableFailures = rows.flatMap((row) => {
        try {
          const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
          if (typeof payload.fingerprint !== "string") return [];
          return [{
            at: Date.parse(typeof payload.occurredAt === "string" ? payload.occurredAt : row.created_at),
            phase: typeof payload.operationPhase === "string" ? payload.operationPhase : "unknown",
            failureClass: typeof payload.failureClass === "string" ? payload.failureClass : "Error",
            fingerprint: payload.fingerprint,
            recurrenceCount: typeof payload.recurrenceCount === "number" ? payload.recurrenceCount : 1,
          }];
        } catch { return []; }
      });
    } catch { /* the in-memory fallback still exposes current-process failures */ }
    const mergedFailures = new Map<string, (typeof recentDrainFailures)[number]>();
    for (const entry of [...durableFailures, ...recentDrainFailures.filter((item) => now - item.at <= 5 * 60_000)]) {
      mergedFailures.set(`${entry.fingerprint}:${entry.at}`, entry);
    }
    const recent = [...mergedFailures.values()].filter((entry) => now - entry.at <= 5 * 60_000);
    const lastFailure = recent.sort((left, right) => left.at - right.at).at(-1);
    const degradedReasons = [
      ...(recent.length ? [`${recent.length} scheduler phase failure(s) in the last five minutes`] : []),
      ...(Number(uncertain?.count ?? 0) ? [`${Number(uncertain?.count ?? 0)} dispatch launch(es) remain uncertain`] : []),
      ...(due?.oldest && now - Date.parse(due.oldest) > Math.max(120_000, pollMs * 4) ? ["due jobs exceed the scheduler serviceability age"] : []),
      ...(Number(cancellations?.count ?? 0) ? [`${Number(cancellations?.count ?? 0)} cancellation(s) await shutdown evidence`] : []),
      ...(Number(operatorIntervention?.count ?? 0) ? [`${Number(operatorIntervention?.count ?? 0)} job(s) require operator reconciliation`] : []),
    ];
    return {
      oldestDueJobAgeMs: due?.oldest ? Math.max(0, now - Date.parse(due.oldest)) : 0,
      uncertainLaunches: Number(uncertain?.count ?? 0),
      oldestUnreconciledAttemptAgeMs: unreconciled?.oldest ? Math.max(0, now - Date.parse(unreconciled.oldest)) : 0,
      acceptedDispatchesLastMinute: Number(accepted?.count ?? 0),
      cancellationRequests: Number(cancellations?.count ?? 0),
      operatorInterventionJobs: Number(operatorIntervention?.count ?? 0),
      recentDrainFailures: recent.length,
      ...(lastFailure ? {
        lastDrainFailureAt: new Date(lastFailure.at).toISOString(),
        lastDrainFailurePhase: lastFailure.phase,
        lastDrainFailureClass: lastFailure.failureClass,
        lastDrainFailureFingerprint: lastFailure.fingerprint,
        lastDrainFailureRecurrenceCount: lastFailure.recurrenceCount,
      } : {}),
      serviceability: { status: degradedReasons.length ? "degraded" : "healthy", reasons: degradedReasons },
    };
  }

  return {
    start() {
      if (!stopped && timer) return;
      stopped = false;
      if (options.events) {
        // Subscribe before replay. The store's per-job sequence cursor makes
        // overlap between live delivery and replay idempotent.
        unsubscribeEvents = options.events.subscribeAll((event) => {
          if (projectedEventTypes.has(event.type)) scheduleProjection(event.sessionId);
        });
      }
      void drainOnce();
      scheduleNext();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      unsubscribeEvents?.();
      unsubscribeEvents = undefined;
    },
    drainOnce,
    reconcileJob,
    getMetrics,
    wake() {
      void drainOnce();
    },
  };
}
