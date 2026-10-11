import { createDispatchOutbox } from "../dispatch-outbox.js";
import type { DispatchOutbox, OutboxClaim } from "../dispatch-outbox.js";
import type { DatabaseHandle } from "../db/client.js";

export interface ScheduledJobRuntime {
  start(): void;
  stop(): void;
  drainOnce(): Promise<void>;
  wake(): void;
}

export interface ScheduledJobRuntimeOptions {
  database: DatabaseHandle;
  dispatchOutbox?: DispatchOutbox;
  schedulerInstanceId?: string;
  leaseMs?: number;
  pollMs?: number;
}

export function createScheduledJobRuntime(options: ScheduledJobRuntimeOptions): ScheduledJobRuntime {
  const database = options.database;
  const dispatchOutbox = options.dispatchOutbox ?? createDispatchOutbox(database);
  const schedulerInstanceId = options.schedulerInstanceId ?? "kontrol-scheduler";
  const leaseMs = options.leaseMs ?? 60_000;
  const pollMs = options.pollMs ?? 5_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function markDue(jobId: string): void {
    database.sqlite.prepare("update scheduled_jobs set status = 'due', revision = revision + 1, updated_at = ? where id = ? and status = 'pending'").run(new Date().toISOString(), jobId);
  }

  async function drainOnce(): Promise<void> {
    if (stopped) return;
    dispatchOutbox.reapExpiredClaims(leaseMs);
    for (;;) {
      const event = dispatchOutbox.claimNext(schedulerInstanceId, leaseMs, ["scheduled_job.due"]);
      if (!event) break;
      const claim: OutboxClaim = { eventId: event.id, claimOwner: event.claimedBy ?? "", claimToken: event.claimToken ?? "" };
      try {
        const row = database.sqlite.prepare("select revision from scheduled_jobs where id = ?").get(event.aggregateId) as { revision?: number } | undefined;
        if (!row) {
          dispatchOutbox.markCompleted(claim);
          continue;
        }
        markDue(event.aggregateId);
        dispatchOutbox.markCompleted(claim);
      } catch (error) {
        dispatchOutbox.markFailed(claim, error instanceof Error ? error.message : String(error), 5_000);
      }
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
  } as ScheduledJobRuntime;
}
