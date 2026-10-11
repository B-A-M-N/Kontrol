import { createDispatchOutbox } from "../dispatch-outbox.js";
import type { DispatchOutbox } from "../dispatch-outbox.js";
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

interface DueEvent {
  id: string;
  aggregateId: string;
  aggregateRevision: number;
  markCompleted(id: string): void;
}

export function createScheduledJobRuntime(options: ScheduledJobRuntimeOptions): ScheduledJobRuntime {
  const database = options.database;
  const dispatchOutbox = options.dispatchOutbox ?? createDispatchOutbox(database);
  const schedulerInstanceId = options.schedulerInstanceId ?? "kontrol-scheduler";
  const leaseMs = options.leaseMs ?? 60_000;
  const pollMs = options.pollMs ?? 5_000;
  const outboxAny = dispatchOutbox as unknown as {
    claimNext(workerId: string, leaseMs: number, eventTypes?: string[]): DueEvent | null;
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function markDue(jobId: string): void {
    database.sqlite.prepare("update scheduled_jobs set status = 'due', revision = revision + 1, updated_at = ? where id = ? and status = 'pending'").run(new Date().toISOString(), jobId);
  }

  async function drainOnce(): Promise<void> {
    if (stopped) return;
    dispatchOutbox.reapExpiredClaims(leaseMs);
    let event: DueEvent | null;
    while ((event = outboxAny.claimNext(schedulerInstanceId, leaseMs, ["scheduled_job.due"])) !== null) {
      try {
        const row = database.sqlite.prepare("select revision from scheduled_jobs where id = ?").get(event.aggregateId) as { revision?: number } | undefined;
        if (!row) {
          dispatchOutbox.markCompleted(event.id);
          continue;
        }
        markDue(event.aggregateId);
        dispatchOutbox.markCompleted(event.id);
        void row;
      } catch (error) {
        dispatchOutbox.markFailed(event.id, error instanceof Error ? error.message : String(error), 5_000);
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
