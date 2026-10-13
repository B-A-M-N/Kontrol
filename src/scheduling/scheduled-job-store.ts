import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { DatabaseHandle } from "../db/client.js";
import type { DispatchOutbox } from "../dispatch-outbox.js";
import { scheduledJobs, scheduledJobAttempts, scheduledJobReports, type ScheduledJobRow } from "../db/schema.js";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { EventStoreEvent } from "../event-log.js";
import { projectScheduledJobLifecycleEvent } from "./scheduled-job-lifecycle.js";

export const schedulingOperation = "schedule_scheduled_job";

export type ScheduledJobStatus =
  | "pending"
  | "due"
  | "dispatching"
  | "running"
  | "uncertain_dispatch"
  | "operator_intervention"
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
  expectedSourceStatuses: ScheduledJobStatus[];
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
  getByWorkSessionId(workSessionId: string): ScheduledJob | undefined;
  listForOwner(ownerContextId: string, limit?: number, afterJobId?: string): ScheduledJob[];
  listForPrincipal(principalId: string, limit?: number, afterJobId?: string): ScheduledJob[];
  listCancellationTargets(afterJobId?: string, limit?: number): ScheduledJob[];
  requestCancellation(input: { jobId: string; expectedRevision: number; requestId: string; reason?: string }): ScheduledJob;
  claimCancellationAttempt(input: { jobId: string; requestId: string; minimumIntervalMs: number }): boolean;
  recordCancellationEvidence(input: { jobId: string; requestId: string; state: "not_dispatched" | "worker_active" | "termination_acknowledged" | "remote_missing" | "worker_stopped" | "worker_cancelled" | "unknown"; lastError?: string }): ScheduledJob;
  finalizeCancellation(input: { jobId: string; requestId: string; lastConfirmedState: "not_dispatched" | "remote_missing" | "worker_stopped" | "worker_cancelled"; reason?: string }): ScheduledJob;
  getAttempt(jobId: string, attemptId?: string): ScheduledJobAttempt | undefined;
  persistReport(jobId: string, runId: string, reportText: string): ScheduledJobReport;
  getReport(jobId: string, reportSha256: string): ScheduledJobReport | undefined;
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
  releaseDispatch(input: {
    jobId: string;
    dispatchAttemptId: string;
    expectedRevision: number;
    dispatcherInstanceId: string;
  }): ScheduledJob;
  /** Mark a dispatched claim uncertain or failed. */
  completeDispatch(input: {
    jobId: string;
    dispatchAttemptId: string;
    expectedRevision: number;
    outcome: "dispatched" | "uncertain" | "failed";
    dispatcherInstanceId: string;
    workSessionId?: string;
    acpRunId?: string;
    acpDispatchId?: string;
    acpAttemptNumber?: number;
    acpRemoteRunId?: string;
    executionReceipt?: object;
    lastError?: string;
  }): ScheduledJob;
  /** Resolve an uncertain launch after authoritative run/adapter evidence. */
  resolveDispatch(input: {
    jobId: string;
    dispatchAttemptId: string;
    expectedRevision: number;
    resolution: "accepted" | "unstarted" | "failed" | "completed" | "cancelled" | "operator_intervention";
    workSessionId?: string;
    acpRunId?: string;
    acpDispatchId?: string;
    acpAttemptNumber?: number;
    acpRemoteRunId?: string;
    executionReceipt?: object;
    lastError?: string;
  }): ScheduledJob;
  /** Atomically project a durable lifecycle event and advance its sequence cursor. */
  projectEvent(event: EventStoreEvent): ScheduledJob | undefined;
  listProjectionTargets(afterJobId?: string, limit?: number): ScheduledJob[];
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
  activeDispatchAttemptId?: string;
  lifecycleEventCursor: number;
  cancellationRequestId?: string;
  cancellationPreviousStatus?: string;
  cancellationRequestedAt?: string;
  cancellationLastAttemptAt?: string;
  cancellationLastConfirmedState?: string;
  maxRuntimeMs: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledJobAttempt {
  id: string;
  jobId: string;
  dispatchId: string;
  startedAt: string;
  executionStartedAt?: string;
  executionActiveSince?: string;
  activeRuntimeMs: number;
  executionStoppedAt?: string;
  executionReceipt?: Record<string, unknown>;
  completedAt?: string;
  transportStatus: string;
  dispatcherInstanceId?: string;
  leaseExpiresAt?: string;
  agentName?: string;
  acpRunId?: string;
  acpDispatchId?: string;
  acpAttemptNumber?: number;
  acpRemoteRunId?: string;
  outcome?: string;
}

export interface ScheduledJobReport {
  id: string;
  jobId: string;
  runId: string;
  reportSha256: string;
  reportText: string;
  createdAt: string;
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
    activeDispatchAttemptId: row.activeDispatchAttemptId ?? undefined,
    lifecycleEventCursor: row.lifecycleEventCursor,
    cancellationRequestId: row.cancellationRequestId ?? undefined,
    cancellationPreviousStatus: row.cancellationPreviousStatus ?? undefined,
    cancellationRequestedAt: row.cancellationRequestedAt ?? undefined,
    cancellationLastAttemptAt: row.cancellationLastAttemptAt ?? undefined,
    cancellationLastConfirmedState: row.cancellationLastConfirmedState ?? undefined,
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

  function getByWorkSessionId(workSessionId: string): ScheduledJob | undefined {
    const row = select.where(eq(scheduledJobs.workSessionId, workSessionId)).limit(1).all()[0];
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
        .set({
          status: "dispatching",
          revision: input.expectedRevision + 1,
          activeDispatchAttemptId: attemptId,
          updatedAt: new Date(now).toISOString(),
        })
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
        dispatcherInstanceId: input.dispatcherInstanceId,
        leaseExpiresAt,
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

  function releaseDispatch(input: {
    jobId: string;
    dispatchAttemptId: string;
    expectedRevision: number;
    dispatcherInstanceId: string;
  }): ScheduledJob {
    const now = new Date().toISOString();
    const next = database.sqlite.transaction(() => {
      const current = database.db.select().from(scheduledJobs)
        .where(eq(scheduledJobs.id, input.jobId)).limit(1).all()[0];
      const cancellationPending = current?.status === "cancellation_requested" && Boolean(current.cancellationRequestId);
      const nextStatus = cancellationPending ? "cancellation_requested" : "due";
      const jobUpdate = database.db.update(scheduledJobs)
        .set({
          status: nextStatus,
          revision: (current?.revision ?? input.expectedRevision) + 1,
          activeDispatchAttemptId: null,
          ...(cancellationPending ? { cancellationLastConfirmedState: "not_dispatched" } : {}),
          updatedAt: now,
        })
        .where(and(
          eq(scheduledJobs.id, input.jobId),
          eq(scheduledJobs.revision, current?.revision ?? input.expectedRevision),
          sql`${scheduledJobs.status} in ('dispatching','cancellation_requested')`,
          eq(scheduledJobs.activeDispatchAttemptId, input.dispatchAttemptId),
        ))
        .run();
      const attemptUpdate = database.db.update(scheduledJobAttempts)
        .set({ completedAt: now, transportStatus: "unstarted", outcome: null })
        .where(and(
          eq(scheduledJobAttempts.id, input.dispatchAttemptId),
          eq(scheduledJobAttempts.jobId, input.jobId),
          eq(scheduledJobAttempts.dispatcherInstanceId, input.dispatcherInstanceId),
          isNull(scheduledJobAttempts.completedAt),
          isNull(scheduledJobAttempts.outcome),
        ))
        .run();
      if (jobUpdate.changes !== 1 || attemptUpdate.changes !== 1) {
        throw new Error(`Scheduled dispatch release conflict for ${input.jobId} attempt ${input.dispatchAttemptId}.`);
      }
      const row = database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, input.jobId)).get();
      if (!row) throw new Error(`Scheduled job disappeared during dispatch release: ${input.jobId}`);
      return row;
    })();
    return rowToJob(next);
  }

  function completeDispatch(input: {
    jobId: string;
    dispatchAttemptId: string;
    expectedRevision: number;
    outcome: "dispatched" | "uncertain" | "failed";
    dispatcherInstanceId: string;
    workSessionId?: string;
    acpRunId?: string;
    acpDispatchId?: string;
    acpAttemptNumber?: number;
    acpRemoteRunId?: string;
    executionReceipt?: object;
    lastError?: string;
  }): ScheduledJob {
    const nextStatus = input.outcome === "dispatched" ? "running" : input.outcome === "uncertain" ? "uncertain_dispatch" : "failed";
    const uncertain = input.outcome === "uncertain";
    const now = new Date().toISOString();
    const next = database.sqlite.transaction(() => {
      const current = database.db.select().from(scheduledJobs)
        .where(eq(scheduledJobs.id, input.jobId)).limit(1).all()[0];
      const cancellationPending = current?.status === "cancellation_requested" && Boolean(current.cancellationRequestId);
      const lifecycleAdvanced = Boolean(current
        && current.activeDispatchAttemptId === input.dispatchAttemptId
        && (current.status === "awaiting_approval"
          || (current.status === "running" && current.lifecycleEventCursor > 0)));
      if (!current || current.activeDispatchAttemptId !== input.dispatchAttemptId
        || (!cancellationPending && !lifecycleAdvanced && (current.status !== "dispatching" || current.revision !== input.expectedRevision))) {
        throw new Error(`Scheduled dispatch completion conflict for ${input.jobId} attempt ${input.dispatchAttemptId}.`);
      }
      const effectiveStatus = cancellationPending ? "cancellation_requested"
        : lifecycleAdvanced ? current.status
          : nextStatus;
      const jobUpdate = database.db.update(scheduledJobs)
        .set({
          status: effectiveStatus,
          revision: current.revision + 1,
          activeDispatchAttemptId: input.outcome === "failed" ? null : input.dispatchAttemptId,
          workSessionId: input.workSessionId ?? undefined,
          ...(cancellationPending && input.outcome === "failed"
            ? { cancellationLastConfirmedState: "not_dispatched" }
            : {}),
          lastError: input.lastError ?? null,
          updatedAt: now,
        })
        .where(and(
          eq(scheduledJobs.id, input.jobId),
          eq(scheduledJobs.revision, current.revision),
          sql`${scheduledJobs.status} in ('dispatching','running','awaiting_approval','cancellation_requested')`,
          eq(scheduledJobs.activeDispatchAttemptId, input.dispatchAttemptId),
        ))
        .run();
      const attemptUpdate = database.db.update(scheduledJobAttempts)
        .set({
          completedAt: input.outcome === "failed" ? now : null,
          transportStatus: input.outcome === "dispatched" ? "accepted" : uncertain ? "uncertain" : "rejected",
          outcome: null,
          acpRunId: input.acpRunId ?? null,
          acpDispatchId: input.acpDispatchId ?? null,
          acpAttemptNumber: input.acpAttemptNumber ?? null,
          acpRemoteRunId: input.acpRemoteRunId ?? null,
          executionReceiptJson: input.executionReceipt ? JSON.stringify(input.executionReceipt) : null,
        })
        .where(and(
          eq(scheduledJobAttempts.id, input.dispatchAttemptId),
          eq(scheduledJobAttempts.jobId, input.jobId),
          eq(scheduledJobAttempts.dispatcherInstanceId, input.dispatcherInstanceId),
          isNull(scheduledJobAttempts.completedAt),
        ))
        .run();
      if (jobUpdate.changes !== 1 || attemptUpdate.changes !== 1) {
        throw new Error(`Scheduled dispatch completion conflict for ${input.jobId} attempt ${input.dispatchAttemptId}.`);
      }
      const row = database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, input.jobId)).get();
      if (!row) throw new Error(`Scheduled job disappeared after dispatch completion: ${input.jobId}`);
      return row;
    })();
    return rowToJob(next);
  }

  function resolveDispatch(input: {
    jobId: string;
    dispatchAttemptId: string;
    expectedRevision: number;
    resolution: "accepted" | "unstarted" | "failed" | "completed" | "cancelled" | "operator_intervention";
    workSessionId?: string;
    acpRunId?: string;
    acpDispatchId?: string;
    acpAttemptNumber?: number;
    acpRemoteRunId?: string;
    executionReceipt?: object;
    lastError?: string;
  }): ScheduledJob {
    const now = new Date().toISOString();
    const terminal = ["failed", "completed", "cancelled"].includes(input.resolution);
    const nextStatus = input.resolution === "accepted" ? "running"
      : input.resolution === "unstarted" ? "due"
        : input.resolution === "failed" ? "failed"
          : input.resolution === "completed" ? "completed"
            : input.resolution === "cancelled" ? "cancelled"
              : "operator_intervention";
    const transportStatus = input.resolution === "accepted" || (terminal && input.acpRunId)
      ? "accepted"
      : input.resolution === "unstarted" ? "unstarted"
        : input.resolution === "failed" ? "rejected"
          : input.resolution === "operator_intervention" ? "uncertain"
            : "accepted";
    const executionOutcome = terminal ? input.resolution : null;
    const next = database.sqlite.transaction(() => {
      const current = database.db.select().from(scheduledJobs)
        .where(eq(scheduledJobs.id, input.jobId)).limit(1).all()[0];
      const cancellationPending = current?.status === "cancellation_requested" && Boolean(current.cancellationRequestId);
      const remainsCancelling = cancellationPending && ["accepted", "unstarted", "operator_intervention"].includes(input.resolution);
      const effectiveNextStatus = remainsCancelling
        ? "cancellation_requested"
        : nextStatus;
      const jobUpdate = database.db.update(scheduledJobs).set({
        status: effectiveNextStatus,
        revision: input.expectedRevision + 1,
        activeDispatchAttemptId: ["accepted", "operator_intervention"].includes(input.resolution) ? input.dispatchAttemptId : null,
        workSessionId: input.workSessionId ?? undefined,
        ...(cancellationPending && input.resolution === "unstarted"
          ? { cancellationLastConfirmedState: "not_dispatched" }
          : {}),
        lastError: input.lastError ?? (cancellationPending ? current?.lastError ?? null : null),
        updatedAt: now,
      }).where(and(
        eq(scheduledJobs.id, input.jobId),
        eq(scheduledJobs.revision, input.expectedRevision),
        eq(scheduledJobs.activeDispatchAttemptId, input.dispatchAttemptId),
        sql`${scheduledJobs.status} in ('dispatching','uncertain_dispatch','operator_intervention','cancellation_requested')`,
      )).run();
      const attemptUpdate = database.db.update(scheduledJobAttempts).set({
        completedAt: terminal || input.resolution === "unstarted" ? now : null,
        transportStatus,
        outcome: executionOutcome,
        acpRunId: input.acpRunId ?? undefined,
        acpDispatchId: input.acpDispatchId ?? undefined,
        acpAttemptNumber: input.acpAttemptNumber ?? undefined,
        acpRemoteRunId: input.acpRemoteRunId ?? undefined,
        executionReceiptJson: input.executionReceipt ? JSON.stringify(input.executionReceipt) : undefined,
      }).where(and(
        eq(scheduledJobAttempts.id, input.dispatchAttemptId),
        eq(scheduledJobAttempts.jobId, input.jobId),
        isNull(scheduledJobAttempts.completedAt),
      )).run();
      if (jobUpdate.changes !== 1 || attemptUpdate.changes !== 1) {
        throw new Error(`Scheduled dispatch reconciliation conflict for ${input.jobId} attempt ${input.dispatchAttemptId}.`);
      }
      const row = database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, input.jobId)).get();
      if (!row) throw new Error(`Scheduled job disappeared during dispatch reconciliation: ${input.jobId}`);
      return row;
    })();
    return rowToJob(next);
  }

  function projectEvent(event: EventStoreEvent): ScheduledJob | undefined {
    if (!event.durable || event.seq <= 0 || !event.sessionId) return undefined;
    const next = database.sqlite.transaction(() => {
      const row = database.db.select().from(scheduledJobs)
        .where(eq(scheduledJobs.workSessionId, event.sessionId))
        .orderBy(asc(scheduledJobs.createdAt))
        .limit(1)
        .get();
      if (!row || event.seq <= row.lifecycleEventCursor) return row;
      const currentStatus = row.status as ScheduledJobStatus;
      let activeAttempt = row.activeDispatchAttemptId
        ? database.db.select().from(scheduledJobAttempts).where(eq(scheduledJobAttempts.id, row.activeDispatchAttemptId)).limit(1).get()
        : undefined;
      const eventAttemptNumber = typeof event.payload.attemptNumber === "number" && Number.isInteger(event.payload.attemptNumber)
        ? event.payload.attemptNumber
        : undefined;
      const eventRunId = typeof event.payload.runId === "string" ? event.payload.runId : undefined;
      const eventDispatchId = typeof event.payload.dispatchId === "string" ? event.payload.dispatchId : undefined;
      const eventRemoteRunId = typeof event.payload.remoteRunId === "string" ? event.payload.remoteRunId : undefined;
      // The ACP HTTP boundary has already authenticated the worker and checked
      // its attempt against the registry. Persist a strictly newer attempt
      // identity monotonically so a delayed older exit cannot stop it later.
      const bindsInitialAttempt = Boolean(activeAttempt && !activeAttempt.acpRunId
        && eventRunId && eventDispatchId === activeAttempt.dispatchId && eventAttemptNumber);
      const advancesAttempt = Boolean(activeAttempt && eventAttemptNumber && eventRunId === activeAttempt.acpRunId
        && (!activeAttempt.acpAttemptNumber || eventAttemptNumber > activeAttempt.acpAttemptNumber)
        && eventDispatchId);
      if (activeAttempt && eventAttemptNumber && eventRunId && eventDispatchId && (bindsInitialAttempt || advancesAttempt)) {
        database.db.update(scheduledJobAttempts).set({
          acpRunId: bindsInitialAttempt ? eventRunId : undefined,
          acpDispatchId: eventDispatchId,
          acpAttemptNumber: eventAttemptNumber,
          acpRemoteRunId: eventRemoteRunId ?? null,
        }).where(eq(scheduledJobAttempts.id, activeAttempt.id)).run();
        activeAttempt = database.db.select().from(scheduledJobAttempts).where(eq(scheduledJobAttempts.id, activeAttempt.id)).limit(1).get();
      }
      const projection = projectScheduledJobLifecycleEvent(currentStatus, event, {
        requestedAt: row.cancellationRequestedAt ?? undefined,
        previousStatus: row.cancellationPreviousStatus ?? undefined,
      }, activeAttempt ? {
        dispatchId: activeAttempt.acpDispatchId ?? activeAttempt.dispatchId,
        runId: activeAttempt.acpRunId ?? undefined,
        attemptNumber: activeAttempt.acpAttemptNumber ?? undefined,
        remoteRunId: activeAttempt.acpRemoteRunId ?? undefined,
      } : {});
      const eventAt = Date.parse(event.createdAt);
      if (activeAttempt && Number.isFinite(eventAt) && (projection.executionStarted || projection.executionPaused || projection.executionStopped || projection.finalWorkerOutcome)) {
        if (projection.executionStarted) {
          database.db.update(scheduledJobAttempts).set({
            executionStartedAt: activeAttempt.executionStartedAt ?? event.createdAt,
            executionActiveSince: activeAttempt.executionActiveSince ?? event.createdAt,
            executionStoppedAt: null,
          }).where(eq(scheduledJobAttempts.id, activeAttempt.id)).run();
        } else {
          const activeSince = activeAttempt.executionActiveSince ? Date.parse(activeAttempt.executionActiveSince) : Number.NaN;
          const additionalRuntime = Number.isFinite(activeSince) ? Math.max(0, eventAt - activeSince) : 0;
          database.db.update(scheduledJobAttempts).set({
            activeRuntimeMs: Math.max(0, Number(activeAttempt.activeRuntimeMs ?? 0)) + additionalRuntime,
            executionActiveSince: null,
            executionStoppedAt: event.createdAt,
          }).where(eq(scheduledJobAttempts.id, activeAttempt.id)).run();
        }
        activeAttempt = database.db.select().from(scheduledJobAttempts).where(eq(scheduledJobAttempts.id, activeAttempt.id)).limit(1).get();
      }
      const updated = database.db.update(scheduledJobs).set({
        status: projection.nextStatus,
        revision: projection.nextStatus ? row.revision + 1 : row.revision,
        activeDispatchAttemptId: projection.finalWorkerOutcome ? null : undefined,
        lifecycleEventCursor: event.seq,
        lastError: projection.lastError ?? (projection.nextStatus ? null : undefined),
        updatedAt: new Date().toISOString(),
      }).where(and(
        eq(scheduledJobs.id, row.id),
        eq(scheduledJobs.revision, row.revision),
        lt(scheduledJobs.lifecycleEventCursor, event.seq),
      )).run();
      if (updated.changes !== 1) throw new Error(`Scheduled event projection conflict for ${row.id} at event ${event.seq}.`);

      if (projection.executionStopped || projection.finalWorkerOutcome) {
        const runId = typeof event.payload.runId === "string" ? event.payload.runId : undefined;
        const completedAt = new Date().toISOString();
        database.sqlite.prepare(`
          update scheduled_job_attempts
             set completed_at = coalesce(completed_at, ?),
                 outcome = case when ? is null then outcome else ? end,
                 transport_status = case when transport_status = 'uncertain' then 'accepted' else transport_status end,
                 acp_run_id = coalesce(acp_run_id, ?)
             where id = ?
        `).run(
          completedAt,
          projection.finalWorkerOutcome ?? null,
          projection.finalWorkerOutcome ?? null,
          runId ?? null,
          activeAttempt?.id ?? "",
        );
      }

      return database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, row.id)).get();
    })();
    return next ? rowToJob(next) : undefined;
  }

  function listProjectionTargets(afterJobId = "", limit = 100): ScheduledJob[] {
    return database.db.select().from(scheduledJobs)
      .where(and(
        gt(scheduledJobs.id, afterJobId),
        sql`${scheduledJobs.status} in ('running','uncertain_dispatch','awaiting_approval','cancellation_requested','operator_intervention')`,
        sql`${scheduledJobs.workSessionId} is not null`,
      ))
      .orderBy(asc(scheduledJobs.id))
      .limit(Math.max(1, Math.min(500, limit)))
      .all()
      .map(rowToJob);
  }

  function listCancellationTargets(afterJobId = "", limit = 100): ScheduledJob[] {
    return database.db.select().from(scheduledJobs)
      .where(and(eq(scheduledJobs.status, "cancellation_requested"), gt(scheduledJobs.id, afterJobId)))
      .orderBy(asc(scheduledJobs.id))
      .limit(Math.max(1, Math.min(500, limit)))
      .all()
      .map(rowToJob);
  }

  function requestCancellation(input: { jobId: string; expectedRevision: number; requestId: string; reason?: string }): ScheduledJob {
    const now = new Date().toISOString();
    const next = database.sqlite.transaction(() => {
      const current = database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, input.jobId)).limit(1).all()[0];
      if (!current) throw new Error(`Unknown scheduled job: ${input.jobId}`);
      if (current.status === "cancelled" || current.status === "cancellation_requested") return current;
      if (["completed", "failed"].includes(current.status)) {
        throw new Error(`Scheduled job ${input.jobId} is already ${current.status}.`);
      }
      const canCancel = ["pending", "due", "dispatching", "running", "uncertain_dispatch", "operator_intervention", "reconciling", "awaiting_approval", "blocked"].includes(current.status);
      if (!canCancel || current.revision !== input.expectedRevision) {
        throw new Error(`Scheduled job cancellation conflict for ${input.jobId}.`);
      }
      const knownIdle = !current.activeDispatchAttemptId && !current.workSessionId;
      const updated = database.db.update(scheduledJobs).set({
        status: "cancellation_requested",
        revision: current.revision + 1,
        cancellationRequestId: input.requestId,
        cancellationPreviousStatus: current.status,
        cancellationRequestedAt: now,
        cancellationLastConfirmedState: knownIdle ? "not_dispatched" : "unknown",
        cancellationLastAttemptAt: null,
        lastError: input.reason ?? "Cancellation requested; waiting for worker-state confirmation.",
        updatedAt: now,
      }).where(and(eq(scheduledJobs.id, input.jobId), eq(scheduledJobs.revision, input.expectedRevision))).run();
      if (updated.changes !== 1) throw new Error(`Scheduled job cancellation conflict for ${input.jobId}.`);
      return database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, input.jobId)).get()!;
    })();
    return rowToJob(next);
  }

  function claimCancellationAttempt(input: { jobId: string; requestId: string; minimumIntervalMs: number }): boolean {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const before = new Date(nowMs - Math.max(0, input.minimumIntervalMs)).toISOString();
    const result = database.db.update(scheduledJobs).set({
      cancellationLastAttemptAt: now,
      revision: sql`${scheduledJobs.revision} + 1`,
      updatedAt: now,
    }).where(and(
      eq(scheduledJobs.id, input.jobId),
      eq(scheduledJobs.status, "cancellation_requested"),
      eq(scheduledJobs.cancellationRequestId, input.requestId),
      sql`(${scheduledJobs.cancellationLastAttemptAt} is null or ${scheduledJobs.cancellationLastAttemptAt} <= ${before})`,
    )).run();
    return result.changes === 1;
  }

  function recordCancellationEvidence(input: {
    jobId: string;
    requestId: string;
    state: "not_dispatched" | "worker_active" | "termination_acknowledged" | "remote_missing" | "worker_stopped" | "worker_cancelled" | "unknown";
    lastError?: string;
  }): ScheduledJob {
    const now = new Date().toISOString();
    const updated = database.db.update(scheduledJobs).set({
      cancellationLastConfirmedState: input.state,
      lastError: input.lastError ?? null,
      revision: sql`${scheduledJobs.revision} + 1`,
      updatedAt: now,
    }).where(and(
      eq(scheduledJobs.id, input.jobId),
      eq(scheduledJobs.status, "cancellation_requested"),
      eq(scheduledJobs.cancellationRequestId, input.requestId),
    )).run();
    if (updated.changes !== 1) throw new Error(`Scheduled cancellation evidence conflict for ${input.jobId}.`);
    const row = get(input.jobId);
    if (!row) throw new Error(`Scheduled job disappeared while recording cancellation evidence: ${input.jobId}`);
    return row;
  }

  function finalizeCancellation(input: {
    jobId: string;
    requestId: string;
    lastConfirmedState: "not_dispatched" | "remote_missing" | "worker_stopped" | "worker_cancelled";
    reason?: string;
  }): ScheduledJob {
    const now = new Date().toISOString();
    const next = database.sqlite.transaction(() => {
      const updated = database.db.update(scheduledJobs).set({
        status: "cancelled",
        revision: sql`${scheduledJobs.revision} + 1`,
        activeDispatchAttemptId: null,
        cancellationLastConfirmedState: input.lastConfirmedState,
        lastError: input.reason ?? "Scheduled job cancellation confirmed.",
        updatedAt: now,
      }).where(and(
        eq(scheduledJobs.id, input.jobId),
        eq(scheduledJobs.status, "cancellation_requested"),
        eq(scheduledJobs.cancellationRequestId, input.requestId),
        eq(scheduledJobs.cancellationLastConfirmedState, input.lastConfirmedState),
      )).run();
      if (updated.changes !== 1) throw new Error(`Scheduled job cancellation is not confirmed for ${input.jobId}.`);
      database.db.update(scheduledJobAttempts).set({ completedAt: now, outcome: "cancelled" })
        .where(and(eq(scheduledJobAttempts.jobId, input.jobId), isNull(scheduledJobAttempts.completedAt))).run();
      return database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, input.jobId)).get()!;
    })();
    return rowToJob(next);
  }

  function getAttempt(jobId: string, attemptId?: string): ScheduledJobAttempt | undefined {
    const row = attemptId
      ? database.db.select().from(scheduledJobAttempts)
        .where(and(eq(scheduledJobAttempts.jobId, jobId), eq(scheduledJobAttempts.id, attemptId))).limit(1).all()[0]
      : database.db.select().from(scheduledJobAttempts)
        .where(eq(scheduledJobAttempts.jobId, jobId))
        .orderBy(desc(scheduledJobAttempts.startedAt), desc(scheduledJobAttempts.id))
        .limit(1).all()[0];
    let executionReceipt: Record<string, unknown> | undefined;
    if (row?.executionReceiptJson) {
      try {
        const parsed: unknown = JSON.parse(row.executionReceiptJson);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) executionReceipt = parsed as Record<string, unknown>;
      } catch { /* corrupt optional receipt remains visibly absent */ }
    }
    return row ? {
      id: row.id,
      jobId: row.jobId,
      dispatchId: row.dispatchId,
      startedAt: row.startedAt,
      executionStartedAt: row.executionStartedAt ?? undefined,
      executionActiveSince: row.executionActiveSince ?? undefined,
      activeRuntimeMs: row.activeRuntimeMs ?? 0,
      executionStoppedAt: row.executionStoppedAt ?? undefined,
      executionReceipt,
      completedAt: row.completedAt ?? undefined,
      transportStatus: row.transportStatus,
      dispatcherInstanceId: row.dispatcherInstanceId ?? undefined,
      leaseExpiresAt: row.leaseExpiresAt ?? undefined,
      agentName: row.agentName ?? undefined,
      acpRunId: row.acpRunId ?? undefined,
      acpDispatchId: row.acpDispatchId ?? undefined,
      acpAttemptNumber: row.acpAttemptNumber ?? undefined,
      acpRemoteRunId: row.acpRemoteRunId ?? undefined,
      outcome: row.outcome ?? undefined,
    } : undefined;
  }

  function persistReport(jobId: string, runId: string, reportText: string): ScheduledJobReport {
    if (!get(jobId)) throw new Error(`Unknown scheduled job: ${jobId}`);
    if (!runId.trim()) throw new Error("Scheduled report requires a correlated ACP run ID.");
    if (Buffer.byteLength(reportText, "utf8") > 8 * 1024 * 1024) {
      throw new Error("Scheduled report exceeds the 8 MiB immutable artifact limit.");
    }
    const reportSha256 = createHash("sha256").update(reportText, "utf8").digest("hex");
    const now = new Date().toISOString();
    database.sqlite.transaction(() => {
      database.db.insert(scheduledJobReports).values({
        id: `sched_report_${randomUUID()}`,
        jobId,
        runId,
        reportSha256,
        reportText,
        createdAt: now,
      }).onConflictDoNothing({ target: [scheduledJobReports.jobId, scheduledJobReports.runId] }).run();
      const existing = database.db.select().from(scheduledJobReports).where(and(
        eq(scheduledJobReports.jobId, jobId),
        eq(scheduledJobReports.runId, runId),
      )).limit(1).get();
      if (!existing || existing.reportSha256 !== reportSha256) {
        throw new Error("Scheduled ACP report changed after its immutable artifact was recorded.");
      }
    })();
    const row = database.db.select().from(scheduledJobReports).where(and(
      eq(scheduledJobReports.jobId, jobId),
      eq(scheduledJobReports.runId, runId),
    )).limit(1).get();
    if (!row) throw new Error("Scheduled report artifact could not be persisted.");
    return row;
  }

  function getReport(jobId: string, reportSha256: string): ScheduledJobReport | undefined {
    const row = database.db.select().from(scheduledJobReports).where(and(
      eq(scheduledJobReports.jobId, jobId),
      eq(scheduledJobReports.reportSha256, reportSha256),
    )).limit(1).get();
    return row ?? undefined;
  }

  function transition(input: ScheduledStateTransition): ScheduledJob {
    if (input.nextStatus === "cancellation_requested" || input.nextStatus === "cancelled") {
      throw new Error("Scheduled cancellation states must use the durable cancellation state machine.");
    }
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
        ...(input.expectedSourceStatuses.length
          ? [sql`${scheduledJobs.status} in ${input.expectedSourceStatuses}`]
          : []),
      ))
      .run();
    if (updated.changes !== 1) throw new Error(`Scheduled job state transition conflict or illegal source status for ${input.jobId}.`);
    const next = get(input.jobId);
    if (!next) throw new Error(`Scheduled job disappeared during transition: ${input.jobId}`);
    return next;
  }

  return {
    create,
    get,
    getByWorkSessionId,
    listForOwner(ownerContextId: string, limit = 100, afterJobId = "") {
      return database.db.select().from(scheduledJobs)
        .where(and(eq(scheduledJobs.ownerContextId, ownerContextId), gt(scheduledJobs.id, afterJobId)))
        .orderBy(asc(scheduledJobs.id))
        .limit(Math.max(1, Math.min(200, limit)))
        .all().map(rowToJob);
    },
    listForPrincipal(principalId: string, limit = 100, afterJobId = "") {
      return database.db.select().from(scheduledJobs)
        .where(and(eq(scheduledJobs.principalId, principalId), gt(scheduledJobs.id, afterJobId)))
        .orderBy(asc(scheduledJobs.id))
        .limit(Math.max(1, Math.min(200, limit)))
        .all().map(rowToJob);
    },
    listCancellationTargets,
    requestCancellation,
    claimCancellationAttempt,
    recordCancellationEvidence,
    finalizeCancellation,
    getAttempt,
    persistReport,
    getReport,
    transition,
    claimDispatch,
    releaseDispatch,
    completeDispatch,
    resolveDispatch,
    projectEvent,
    listProjectionTargets,
    close() {
      database.close();
    },
  } as ScheduledJobStore;
}

export type { ScheduledJobInput as ScheduledJobInputAlias };
