import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { DatabaseHandle } from "../db/client.js";
import type { DispatchOutbox } from "../dispatch-outbox.js";
import { scheduledJobs, scheduledJobAttempts, type ScheduledJobRow } from "../db/schema.js";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";

export const schedulingOperation = "schedule_scheduled_job";

export type ScheduledJobStatus =
  | "pending"
  | "due"
  | "dispatching"
  | "running"
  | "uncertain_dispatch"
  | "reconciling"
  | "awaiting_approval"
  | "completed"
  | "blocked"
  | "failed"
  | "cancellation_requested"
  | "cancelled";

export interface ScheduledJobInput {
  principalId: string;
  ownerContextId: string;
  projectId: string;
  workspaceRoot: string;
  runAt: string;
  instructionJson: unknown;
  executionMode: "read_only_audit";
  policySnapshotJson: unknown;
  agentName?: string;
  workSessionId?: string;
  maxRuntimeMs: number;
  clientMutationId?: string;
}

export interface ScheduledStateTransition {
  jobId: string;
  expectedRevision: number;
  nextStatus: ScheduledJobStatus;
  workSessionId?: string | null;
  lastError?: string | null;
}

export interface DispatchClaim {
  jobId: string;
  attemptId: string;
  dispatchId: string;
  leaseExpiresAt: string;
  revision: number;
}

export interface ScheduledJobStore {
  create(input: ScheduledJobInput): ScheduledJob;
  get(jobId: string): ScheduledJob | undefined;
  listForOwner(ownerContextId: string, limit?: number): ScheduledJob[];
  transition(input: ScheduledStateTransition): ScheduledJob;
  /** Atomically fence one external dispatch attempt. */
  claimDispatch(input: {
    jobId: string;
    expectedRevision: number;
    dispatchAttemptId?: string;
    dispatcherInstanceId: string;
    leaseMs?: number;
  }): DispatchClaim;
  /** Release an unstarted claim back to due. */
  releaseDispatch(input: { jobId: string; dispatchAttemptId: string; expectedRevision: number }): ScheduledJob;
  /** Mark a dispatched claim uncertain or failed. */
  completeDispatch(input: {
    jobId: string;
    dispatchAttemptId: string;
    expectedRevision: number;
    outcome: "dispatched" | "uncertain" | "failed";
    workSessionId?: string;
    lastError?: string;
  }): ScheduledJob;
  close(): void;
}

export interface ScheduledJob {
  id: string;
  principalId: string;
  ownerContextId: string;
  projectId: string;
  workspaceRoot: string;
  runAt: string;
  instructionJson: Record<string, unknown>;
  executionMode: string;
  policySnapshotJson: Record<string, unknown>;
  agentName?: string;
  status: ScheduledJobStatus;
  revision: number;
  workSessionId?: string;
  maxRuntimeMs: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

const nonEmptyString = z.string().trim().min(1).max(1024);

const scheduledJobRequestSchema = z.object({
  principalId: nonEmptyString,
  ownerContextId: nonEmptyString,
  projectId: nonEmptyString,
  workspaceRoot: nonEmptyString,
  runAt: z.string().datetime({ offset: true }),
  instructionJson: z.record(z.string(), z.unknown()),
  executionMode: z.literal("read_only_audit"),
  policySnapshotJson: z.record(z.string(), z.unknown()),
  maxRuntimeMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1_000),
});

function rowToJob(row: ScheduledJobRow): ScheduledJob {
  return {
    id: row.id,
    principalId: row.principalId,
    ownerContextId: row.ownerContextId,
    projectId: row.projectId,
    workspaceRoot: row.workspaceRoot,
    runAt: row.runAt,
    instructionJson: JSON.parse(row.instructionJson) as Record<string, unknown>,
    executionMode: row.executionMode,
    policySnapshotJson: JSON.parse(row.policySnapshotJson),
    agentName: row.agentName ?? undefined,
    status: row.status as ScheduledJobStatus,
    revision: row.revision,
    workSessionId: row.workSessionId ?? undefined,
    maxRuntimeMs: row.maxRuntimeMs,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function canonicalRequest(input: {
  principalId: string;
  ownerContextId: string;
  projectId: string;
  workspaceRoot: string;
  runAt: string;
  instructionJson: unknown;
  executionMode: string;
  policySnapshotJson: unknown;
  agentName?: string;
  maxRuntimeMs: number;
}): Record<string, unknown> {
  return {
    agentName: input.agentName ?? null,
    executionMode: input.executionMode,
    instructionJson: input.instructionJson,
    maxRuntimeMs: input.maxRuntimeMs,
    ownerContextId: input.ownerContextId,
    policySnapshotJson: input.policySnapshotJson,
    principalId: input.principalId,
    projectId: input.projectId,
    runAt: input.runAt,
    workspaceRoot: input.workspaceRoot,
  };
}

function canonicalFingerprint(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createScheduledJobStore(
  database: DatabaseHandle,
  dispatchOutbox: DispatchOutbox,
): ScheduledJobStore {
  const select = database.db.select().from(scheduledJobs);

  function get(jobId: string): ScheduledJob | undefined {
    const row = select.where(eq(scheduledJobs.id, jobId)).limit(1).all()[0];
    return row ? rowToJob(row) : undefined;
  }

  function commitJob(input: ScheduledJobInput): ScheduledJob {
    const request = scheduledJobRequestSchema.parse({
      principalId: input.principalId,
      ownerContextId: input.ownerContextId,
      projectId: input.projectId,
      workspaceRoot: input.workspaceRoot,
      runAt: input.runAt,
      instructionJson: input.instructionJson,
      executionMode: input.executionMode,
      policySnapshotJson: input.policySnapshotJson,
      maxRuntimeMs: input.maxRuntimeMs,
    });
    const id = `sched_${randomUUID()}`;
    const now = new Date().toISOString();
    database.sqlite.transaction(() => {
      database.db.insert(scheduledJobs).values({
        id,
        principalId: request.principalId,
        ownerContextId: request.ownerContextId,
        projectId: request.projectId,
        workspaceRoot: request.workspaceRoot,
        runAt: request.runAt,
        instructionJson: JSON.stringify(request.instructionJson),
        executionMode: request.executionMode,
        policySnapshotJson: JSON.stringify(request.policySnapshotJson),
        agentName: input.agentName ?? null,
        status: "pending",
        revision: 1,
        workSessionId: input.workSessionId ?? null,
        maxRuntimeMs: request.maxRuntimeMs,
        clientMutationId: input.clientMutationId ?? null,
        requestFingerprint: input.clientMutationId ? canonicalFingerprint(canonicalRequest(input)) : "{}",
        createdAt: now,
        updatedAt: now,
      }).run();
      dispatchOutbox.enqueue({
        eventType: "scheduled_job.due",
        aggregateId: id,
        aggregateRevision: 1,
        availableAt: request.runAt,
        payload: { scheduledJobId: id, revision: 1 },
      });
    })();
    const created = get(id);
    if (!created) throw new Error("Scheduled job commit could not be read back.");
    return created;
  }

  function create(input: ScheduledJobInput): ScheduledJob {
    if (input.clientMutationId) {
      const canonical = canonicalRequest(input);
      const prior = database.db.select().from(scheduledJobs)
        .where(and(
          eq(scheduledJobs.principalId, input.principalId),
          eq(scheduledJobs.clientMutationId, input.clientMutationId),
        ))
        .limit(1)
        .all()[0];
      if (prior) {
        if (prior.requestFingerprint === canonicalFingerprint(canonical)) return rowToJob(prior);
        throw new Error("clientMutationId was already used with different scheduling request content.");
      }
    }
    return commitJob(input);
  }

  function claimDispatch(input: {
    jobId: string;
    expectedRevision: number;
    dispatchAttemptId?: string;
    dispatcherInstanceId: string;
    leaseMs?: number;
  }): DispatchClaim {
    const now = Date.now();
    const leaseExpiresAt = new Date(now + (input.leaseMs ?? 60_000)).toISOString();
    const attemptId = input.dispatchAttemptId ?? `scha_${randomUUID()}`;
    const dispatchId = `disp_${randomUUID()}`;
    const claim = database.sqlite.transaction(() => {
      const updated = database.db.update(scheduledJobs)
        .set({ status: "dispatching", revision: input.expectedRevision + 1, updatedAt: new Date(now).toISOString() })
        .where(and(
          eq(scheduledJobs.id, input.jobId),
          eq(scheduledJobs.revision, input.expectedRevision),
          eq(scheduledJobs.status, "due"),
        ))
        .run();
      if (updated.changes !== 1) throw new Error(`Scheduled dispatch claim conflict for ${input.jobId}.`);
      database.db.insert(scheduledJobAttempts).values({
        id: attemptId,
        jobId: input.jobId,
        dispatchId,
        startedAt: new Date(now).toISOString(),
        agentName: null,
        acpRunId: null,
        outcome: null,
      }).run();
      const row = database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, input.jobId)).get();
      if (!row) throw new Error(`Scheduled job disappeared after dispatch claim: ${input.jobId}`);
      return row.revision;
    })();
    return { jobId: input.jobId, attemptId, dispatchId, leaseExpiresAt, revision: claim };
  }

  function releaseDispatch(input: { jobId: string; dispatchAttemptId: string; expectedRevision: number }): ScheduledJob {
    const next = database.db.transaction(() => {
      database.db.update(scheduledJobs)
        .set({ status: "due", revision: input.expectedRevision + 1, updatedAt: new Date().toISOString() })
        .where(and(
          eq(scheduledJobs.id, input.jobId),
          eq(scheduledJobs.revision, input.expectedRevision),
          eq(scheduledJobs.status, "dispatching"),
        ))
        .run();
      database.db.update(scheduledJobAttempts)
        .set({ completedAt: new Date().toISOString(), outcome: "released" })
        .where(and(
          eq(scheduledJobAttempts.id, input.dispatchAttemptId),
          eq(scheduledJobAttempts.jobId, input.jobId),
        ))
        .run();
      return database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, input.jobId)).get();
    });
    if (!next) throw new Error(`Scheduled job disappeared during dispatch release: ${input.jobId}`);
    return rowToJob(next);
  }

  function completeDispatch(input: {
    jobId: string;
    dispatchAttemptId: string;
    expectedRevision: number;
    outcome: "dispatched" | "uncertain" | "failed";
    workSessionId?: string;
    lastError?: string;
  }): ScheduledJob {
    const nextStatus = input.outcome === "dispatched" ? "running" : input.outcome === "uncertain" ? "uncertain_dispatch" : "failed";
    const now = new Date().toISOString();
    database.sqlite.transaction(() => {
      database.db.update(scheduledJobs)
        .set({
          status: nextStatus,
          revision: input.expectedRevision + 1,
          workSessionId: input.workSessionId ?? null,
          lastError: input.lastError ?? null,
          updatedAt: now,
        })
        .where(and(
          eq(scheduledJobs.id, input.jobId),
          eq(scheduledJobs.revision, input.expectedRevision),
          eq(scheduledJobs.status, "dispatching"),
        ))
        .run();
      database.db.update(scheduledJobAttempts)
        .set({ completedAt: now, outcome: input.outcome })
        .where(and(
          eq(scheduledJobAttempts.id, input.dispatchAttemptId),
          eq(scheduledJobAttempts.jobId, input.jobId),
        ))
        .run();
      const row = database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, input.jobId)).get();
      if (!row) throw new Error(`Scheduled job disappeared after dispatch completion: ${input.jobId}`);
      return row.revision;
    })();
    const next = get(input.jobId);
    if (!next) throw new Error(`Scheduled job disappeared during dispatch completion: ${input.jobId}`);
    return next;
  }

  function transition(input: ScheduledStateTransition): ScheduledJob {
    const now = new Date().toISOString();
    const updated = database.db.update(scheduledJobs)
      .set({
        status: input.nextStatus,
        revision: input.expectedRevision + 1,
        workSessionId: input.workSessionId === undefined ? undefined : input.workSessionId,
        lastError: input.lastError === undefined ? undefined : input.lastError,
        updatedAt: now,
      })
      .where(and(
        eq(scheduledJobs.id, input.jobId),
        eq(scheduledJobs.revision, input.expectedRevision),
      ))
      .run();
    if (updated.changes !== 1) throw new Error(`Scheduled job state transition conflict for ${input.jobId}.`);
    const next = get(input.jobId);
    if (!next) throw new Error(`Scheduled job disappeared during transition: ${input.jobId}`);
    return next;
  }

  return {
    create,
    get,
    listForOwner(ownerContextId: string, limit = 100) {
      return database.db.select().from(scheduledJobs)
        .where(eq(scheduledJobs.ownerContextId, ownerContextId))
        .orderBy(scheduledJobs.runAt)
        .all().slice(0, limit).map(rowToJob);
    },
    transition,
    claimDispatch,
    releaseDispatch,
    completeDispatch,
    close() {
      database.close();
    },
  } as ScheduledJobStore;
}

export type { ScheduledJobInput as ScheduledJobInputAlias };
