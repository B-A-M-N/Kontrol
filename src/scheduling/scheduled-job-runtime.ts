/**
 * Durable scheduled-job runtime (S02).
 *
 * The scheduler is a TRIGGER, not a second supervisor: it decides when a job
 * is due and hands it to the canonical ACP dispatch path. SQLite remains the
 * authoritative job record; the process timer only provides a bounded wakeup.
 */
import { createDispatchOutbox } from "../dispatch-outbox.js";
import type { DispatchOutbox, OutboxClaim } from "../dispatch-outbox.js";
import type { DatabaseHandle } from "../db/client.js";
import type { ScheduledJobStore } from "./scheduled-job-store.js";

export interface ScheduledDispatchOutcome {
  status: "dispatched" | "blocked" | "failed" | "uncertain";
  workSessionId?: string;
  reason?: string;
}

export interface ScheduledJobRuntime {
  start(): void;
  stop(): void;
  drainOnce(): Promise<void>;
  wake(): void;
}

export interface ScheduledJobRuntimeOptions {
  database: DatabaseHandle;
  jobs: ScheduledJobStore;
  dispatchOutbox?: DispatchOutbox;
  /**
   * Authorized dispatch hook. Returns the resulting job-relevant status plus
   * the durable work-session correlation and any real failure reason, so the
   * recorded job carries its evidence rather than only a status word.
   */
  dispatch?: (jobId: string) => Promise<ScheduledDispatchOutcome>;
  schedulerInstanceId?: string;
  leaseMs?: number;
  pollMs?: number;
}

export function createScheduledJobRuntime(options: ScheduledJobRuntimeOptions): ScheduledJobRuntime {
  const database = options.database;
  const jobs = options.jobs;
  const dispatchOutbox = options.dispatchOutbox ?? createDispatchOutbox(database);
  const schedulerInstanceId = options.schedulerInstanceId ?? "kontrol-scheduler";
  const leaseMs = options.leaseMs ?? 60_000;
  const pollMs = options.pollMs ?? 5_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let currentDrain: Promise<void> | null = null;

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
  function reconcileNonterminalJobs(): void {
    const rows = database.sqlite
      .prepare("select id, revision, run_at from scheduled_jobs where status in ('pending','due','reconciling')")
      .all() as Array<{ id: string; revision: number; run_at: string }>;
    const now = new Date().toISOString();
    for (const row of rows) {
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

  async function runDrain(): Promise<void> {
    try {
      dispatchOutbox.reapExpiredClaims(leaseMs);
      for (;;) {
        const event = dispatchOutbox.claimNext(schedulerInstanceId, leaseMs, ["scheduled_job.due"]);
        if (!event) break;
        const claim: OutboxClaim = { eventId: event.id, claimOwner: event.claimedBy ?? "", claimToken: event.claimToken ?? "" };
        try {
          let job = jobs.get(event.aggregateId);
          if (!job) {
            dispatchOutbox.markCompleted(claim);
            continue;
          }
          // Only a pending or already-due job is dispatchable. Anything else
          // (running, terminal, cancelled) means the trigger is stale.
          if (job.status !== "pending" && job.status !== "due") {
            dispatchOutbox.markCompleted(claim);
            continue;
          }
          if (job.status === "pending") {
            if (Date.parse(job.runAt) > Date.now()) {
              // Not due yet — leave pending and re-arm under the same logical key.
              dispatchOutbox.release(claim, Math.max(250, Date.parse(job.runAt) - Date.now()), "scheduled job is not yet due");
              continue;
            }
            const revision = markDue(job.id);
            if (revision === undefined) {
              // A concurrent transition won; let the other owner proceed.
              dispatchOutbox.markCompleted(claim);
              continue;
            }
            job = jobs.get(job.id) ?? job;
          }
          if (!options.dispatch) {
            dispatchOutbox.markCompleted(claim);
            continue;
          }
          const dispatchClaim = jobs.claimDispatch({
            jobId: job.id,
            expectedRevision: job.revision,
            dispatcherInstanceId: schedulerInstanceId,
            leaseMs,
          });
          const outcome = await options.dispatch(job.id);
          // Only advance the durable job state when the CAS revision still
          // matches what we observed; a concurrent cancellation wins.
          const current = jobs.get(job.id);
          if (outcome.status === "dispatched" || outcome.status === "uncertain" || outcome.status === "failed") {
            jobs.completeDispatch({
              jobId: job.id,
              dispatchAttemptId: dispatchClaim.attemptId,
              expectedRevision: dispatchClaim.revision,
              outcome: outcome.status,
              workSessionId: outcome.workSessionId,
              lastError: outcome.reason,
            });
          } else {
            jobs.releaseDispatch({
              jobId: job.id,
              dispatchAttemptId: dispatchClaim.attemptId,
              expectedRevision: dispatchClaim.revision,
            });
            dispatchOutbox.release(claim, 1000, outcome.reason ?? "scheduled dispatch blocked before launch");
            continue;
          }
          dispatchOutbox.markCompleted(claim);
        } catch (error) {
          // If the error happened after a durable dispatch claim was created,
          // the job stays in dispatching and the next startup reconciliation
          // must handle it as an accepted-or-uncertain external launch.
          dispatchOutbox.markFailed(claim, error instanceof Error ? error.message : String(error), 5_000);
        }
      }
    } catch {
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

  return {
    start() {
      stopped = false;
      reconcileNonterminalJobs();
      void drainOnce();
      scheduleNext();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    drainOnce,
    wake() {
      void drainOnce();
    },
  };
}
