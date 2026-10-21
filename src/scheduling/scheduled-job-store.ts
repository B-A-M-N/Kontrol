import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { DatabaseHandle } from "../db/client.js";
import type { DispatchOutbox } from "../dispatch-outbox.js";
import {
  scheduledJobs,
  scheduledJobAttempts,
  scheduledJobReportFinalizations,
  scheduledJobReports,
  scheduledJobVerifications,
  type ScheduledJobRow,
} from "../db/schema.js";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lte, lt, sql } from "drizzle-orm";
import type { EventStoreEvent } from "../event-log.js";
import { projectScheduledJobLifecycleEvent } from "./scheduled-job-lifecycle.js";
import { redactString, redactedPreview } from "../redaction.js";

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
  executionMode: "read_only_audit" | "bounded_file_write";
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
  listDispatchAttempts?(jobId: string, limit?: number): ScheduledDispatchAttemptDiagnostic[];
  getWorkerFailureEvidence?(jobId: string): WorkerFailureEvidence | undefined;
  persistReport(jobId: string, runId: string, reportText: string): ScheduledJobReport;
  getReport(jobId: string, reportSha256: string): ScheduledJobReport | undefined;
  getReportForAttempt(jobId: string, runId: string, attemptNumber: number): ScheduledJobReport | undefined;
  getReportFinalization(jobId: string, runId: string, attemptNumber: number): ScheduledJobReportFinalization | undefined;
  reconcilePendingReportFinalizations(limit?: number): number;
  claimVerificationExecution(input: ScheduledVerificationClaimInput): { execution: ScheduledVerificationExecution; owner: boolean };
  completeVerificationExecution(input: { executionId: string; reportText: string }): ScheduledVerificationExecution;
  failVerificationExecution(input: { executionId: string; reason: string }): ScheduledVerificationExecution | undefined;
  getVerificationReport(jobId: string, reportSha256: string): ScheduledVerificationExecution | undefined;
  getLatestVerificationExecution(input: Omit<ScheduledVerificationClaimInput, "requestKey" | "requestFingerprint" | "clientMutationId" | "executionIdentity" | "deadlineAt">): ScheduledVerificationExecution | undefined;
  reconcileStaleVerificationExecutions(limit?: number, now?: string): number;
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
    blocker?: {
      kind: "temporary_dependency" | "permanent_configuration";
      reason: string;
      nextEligibleAt?: string;
      lastAttemptedAgent?: string;
      failureClass?: string;
      probeResult?: Record<string, unknown>;
    };
  }): ScheduledJob;
  retryBlockedJob(input: { jobId: string; expectedRevision?: number }): ScheduledJob;
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
    agentName?: string;
    lastError?: string;
    failureClass?: string;
    probeResult?: Record<string, unknown>;
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
  /** Bind the newly created logical work session before the worker is launched. */
  bindWorkSession(input: { jobId: string; dispatchAttemptId: string; workSessionId: string }): ScheduledJob;
  /** Bind the ACP run/attempt identity before the adapter can start the worker. */
  bindAcpAttempt(input: {
    jobId: string;
    dispatchAttemptId: string;
    workSessionId: string;
    dispatchIdempotencyKey: string;
    runId: string;
    attemptNumber: number;
  }): void;
  /** Durable bounded-write publication intent recorded before destination mutation. */
  recordPublicationIntent(input: { jobId: string; intent: Record<string, unknown> }): void;
  /** Durable bounded-write artifact publication receipt bound to its intent. */
  recordReconcileProbe(input: { jobId: string; attemptId: string; evidence: string; now?: string }): void;
  recordPublicationReceipt(input: { jobId: string; receipt: Record<string, unknown> }): void;
  recordPublicationFailure(input: { jobId: string; receiptId: string; outcome: "rejected" | "conflict"; reason: string }): void;
  listPendingPublicationIntents(limit?: number): Array<{
    jobId: string;
    workSessionId: string;
    workspaceRoot: string;
    attemptId: string;
    attemptNumber: number;
    intent: Record<string, unknown>;
  }>;
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
  /** Server-bound ACP attempt number when the active attempt has started. */
  attemptNumber?: number;
  /** ACP execution identity exposed only with the active work-session lookup. */
  acpRunId?: string;
  dispatchIdempotencyKey?: string;
  lifecycleEventCursor: number;
  cancellationRequestId?: string;
  cancellationPreviousStatus?: string;
  cancellationRequestedAt?: string;
  cancellationLastAttemptAt?: string;
  cancellationLastConfirmedState?: string;
  maxRuntimeMs: number;
  dispatchRetryCount: number;
  dispatchNextEligibleAt?: string;
  dispatchLastAttemptedAgent?: string;
  dispatchBlockerKind?: "temporary_dependency" | "permanent_configuration";
  lastError?: string;
  terminalAt?: string;
  blockedAt?: string;
  operatorInterventionAt?: string;
  lastStateChangedAt?: string;
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
  publicationReceipts?: Array<Record<string, unknown>>;
  workerExecutionOutcome?: "completed" | "failed" | "failed_protocol" | "cancelled";
  workerExecutionAt?: string;
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

export interface ScheduledDispatchAttemptDiagnostic {
  attemptId: string;
  dispatchId: string;
  startedAt: string;
  completedAt?: string;
  selectedAgent?: string;
  transportStatus: string;
  runId?: string;
  attemptNumber?: number;
  failureClass?: string;
  failureReason?: string;
  probeResult?: Record<string, unknown>;
  nextEligibleAt?: string;
}

export interface WorkerFailureEvidence {
  phase: "admission" | "spawn" | "execution" | "reporting";
  category: string;
  reason?: string;
  exitCode?: number;
  signal?: string;
  sanitizedStderrTail?: string;
  eventId?: string;
  runId: string;
  attemptNumber: number;
}

function boundedFailureDiagnosticTail(value: unknown, maxBytes = 4_000): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const redacted = redactString(value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""));
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.byteLength <= maxBytes) return redacted;
  return new TextDecoder().decode(bytes.subarray(-maxBytes)).replace(/^\uFFFD/, "");
}

export interface ScheduledJobReport {
  id: string;
  jobId: string;
  runId: string;
  reportSha256: string;
  reportText: string;
  createdAt: string;
}

export interface ScheduledJobReportFinalization {
  id: string;
  jobId: string;
  runId: string;
  attemptNumber: number;
  eventId: string;
  status: "pending" | "completed" | "no_output" | "unavailable";
  reportSha256?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledVerificationClaimInput {
  jobId: string;
  requestKey: string;
  requestFingerprint: string;
  clientMutationId?: string;
  executionIdentity: string;
  workSessionId: string;
  submissionId: string;
  reviewEpoch: number;
  snapshotKind: "git" | "filesystem";
  snapshotRef: string;
  commandFingerprint: string;
  policyFingerprint: string;
  deadlineAt: string;
}

export interface ScheduledVerificationExecution {
  id: string;
  jobId: string;
  requestKey: string;
  requestFingerprint: string;
  clientMutationId?: string;
  executionIdentity: string;
  workSessionId: string;
  submissionId: string;
  reviewEpoch: number;
  snapshotKind: "git" | "filesystem";
  snapshotRef: string;
  commandFingerprint: string;
  policyFingerprint: string;
  status: "running" | "completed" | "failed";
  deadlineAt: string;
  reportSha256?: string;
  reportText?: string;
  failureReason?: string;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
}

function scheduledReportRunKey(runId: string, attemptNumber: number): string {
  return `${runId}#attempt:${attemptNumber}`;
}

const nonEmptyString = z.string().trim().min(1).max(1024);

const scheduledJobRequestSchema = z.object({
  principalId: nonEmptyString,
  ownerContextId: nonEmptyString,
  projectId: nonEmptyString,
  workspaceRoot: nonEmptyString,
  runAt: z.string().datetime({ offset: true }),
  instructionJson: z.record(z.string(), z.unknown()),
  executionMode: z.enum(["read_only_audit", "bounded_file_write"]),
  policySnapshotJson: z.record(z.string(), z.unknown()),
  maxRuntimeMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1_000),
});

/** Exact-path, exact-content output authority for scheduled bounded writes. */
export interface BoundedFileWriteOutputPolicy {
  path: string;
  operation: "create" | "replace";
  expectedSha256?: string;
  overwrite: "deny" | "expected_hash";
  expectedPreviousSha256?: string;
}

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
    dispatchRetryCount: row.dispatchRetryCount ?? 0,
    dispatchNextEligibleAt: row.dispatchNextEligibleAt ?? undefined,
    dispatchLastAttemptedAgent: row.dispatchLastAttemptedAgent ?? undefined,
    dispatchBlockerKind: row.dispatchBlockerKind === "temporary_dependency" || row.dispatchBlockerKind === "permanent_configuration"
      ? row.dispatchBlockerKind
      : undefined,
    lastError: row.lastError ?? undefined,
    terminalAt: row.terminalAt ?? undefined,
    blockedAt: row.blockedAt ?? undefined,
    operatorInterventionAt: row.operatorInterventionAt ?? undefined,
    lastStateChangedAt: row.lastStateChangedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToVerification(row: typeof scheduledJobVerifications.$inferSelect): ScheduledVerificationExecution {
  return {
    id: row.id,
    jobId: row.jobId,
    requestKey: row.requestKey,
    requestFingerprint: row.requestFingerprint,
    clientMutationId: row.clientMutationId ?? undefined,
    executionIdentity: row.executionIdentity,
    workSessionId: row.workSessionId,
    submissionId: row.submissionId,
    reviewEpoch: row.reviewEpoch,
    snapshotKind: row.snapshotKind as "git" | "filesystem",
    snapshotRef: row.snapshotRef,
    commandFingerprint: row.commandFingerprint,
    policyFingerprint: row.policyFingerprint,
    status: row.status as ScheduledVerificationExecution["status"],
    deadlineAt: row.deadlineAt,
    reportSha256: row.reportSha256 ?? undefined,
    reportText: row.reportText ?? undefined,
    failureReason: row.failureReason ?? undefined,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
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

const DEFINITIVE_TERMINAL_JOB_STATUSES = new Set<ScheduledJobStatus>(["completed", "failed", "cancelled"]);

function stateTimestampFields(nextStatus: ScheduledJobStatus, previousStatus: string | undefined, now: string) {
  if (nextStatus === previousStatus) return {};
  return {
    lastStateChangedAt: now,
    ...(nextStatus === "blocked" ? { blockedAt: now } : {}),
    ...(nextStatus === "operator_intervention" ? { operatorInterventionAt: now } : {}),
    ...(DEFINITIVE_TERMINAL_JOB_STATUSES.has(nextStatus)
      ? { terminalAt: sql`coalesce(${scheduledJobs.terminalAt}, ${now})` }
      : {}),
  };
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
    if (!row) return undefined;
    const job = rowToJob(row);
    if (row.activeDispatchAttemptId) {
      const attemptRow = database.db.select().from(scheduledJobAttempts).where(eq(scheduledJobAttempts.id, row.activeDispatchAttemptId)).limit(1).all()[0];
      job.attemptNumber = attemptRow?.acpAttemptNumber ?? undefined;
      job.acpRunId = attemptRow?.acpRunId ?? undefined;
      job.dispatchIdempotencyKey = attemptRow?.acpDispatchId ?? undefined;
    }
    return job;
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
        lastStateChangedAt: now,
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
    const nowIso = new Date(now).toISOString();
    const leaseExpiresAt = new Date(now + (input.leaseMs ?? 60_000)).toISOString();
    const attemptId = input.dispatchAttemptId ?? `scha_${randomUUID()}`;
    const dispatchId = `disp_${randomUUID()}`;
    const claim = database.sqlite.transaction(() => {
      const updated = database.db.update(scheduledJobs)
        .set({
          status: "dispatching",
          revision: input.expectedRevision + 1,
          activeDispatchAttemptId: attemptId,
          updatedAt: nowIso,
          ...stateTimestampFields("dispatching", "due", nowIso),
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
    blocker?: {
      kind: "temporary_dependency" | "permanent_configuration";
      reason: string;
      nextEligibleAt?: string;
      lastAttemptedAgent?: string;
      failureClass?: string;
      probeResult?: Record<string, unknown>;
    };
  }): ScheduledJob {
    const now = new Date().toISOString();
    const next = database.sqlite.transaction(() => {
      const current = database.db.select().from(scheduledJobs)
        .where(eq(scheduledJobs.id, input.jobId)).limit(1).all()[0];
      const cancellationPending = current?.status === "cancellation_requested" && Boolean(current.cancellationRequestId);
      const permanentlyBlocked = input.blocker?.kind === "permanent_configuration";
      const nextStatus = cancellationPending ? "cancellation_requested" : permanentlyBlocked ? "blocked" : "due";
      const jobUpdate = database.db.update(scheduledJobs)
        .set({
          status: nextStatus,
          revision: (current?.revision ?? input.expectedRevision) + 1,
          activeDispatchAttemptId: null,
          ...(input.blocker ? {
            ...(input.blocker.kind === "temporary_dependency" ? { dispatchRetryCount: sql`${scheduledJobs.dispatchRetryCount} + 1` } : {}),
            dispatchNextEligibleAt: input.blocker.kind === "temporary_dependency" ? input.blocker.nextEligibleAt ?? null : null,
            dispatchLastAttemptedAgent: input.blocker.lastAttemptedAgent ?? null,
            dispatchBlockerKind: input.blocker.kind,
            lastError: redactedPreview(input.blocker.reason, 1_000),
          } : {}),
          ...(cancellationPending ? { cancellationLastConfirmedState: "not_dispatched" } : {}),
          updatedAt: now,
          ...stateTimestampFields(nextStatus, current?.status, now),
        })
        .where(and(
          eq(scheduledJobs.id, input.jobId),
          eq(scheduledJobs.revision, current?.revision ?? input.expectedRevision),
          sql`${scheduledJobs.status} in ('dispatching','cancellation_requested')`,
          eq(scheduledJobs.activeDispatchAttemptId, input.dispatchAttemptId),
        ))
        .run();
      const attemptUpdate = database.db.update(scheduledJobAttempts)
        .set({
          completedAt: now,
          transportStatus: "unstarted",
          outcome: null,
          agentName: input.blocker?.lastAttemptedAgent ?? null,
          dispatchFailureClass: input.blocker?.failureClass ?? input.blocker?.kind ?? "released_unstarted",
          dispatchFailureReason: redactedPreview(input.blocker?.reason ?? "Dispatch claim was released before a worker started.", 1_000),
          dispatchProbeResultJson: input.blocker?.probeResult ? JSON.stringify(input.blocker.probeResult).slice(0, 4_000) : null,
          nextEligibleAt: input.blocker?.nextEligibleAt ?? null,
        })
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

  function retryBlockedJob(input: { jobId: string; expectedRevision?: number }): ScheduledJob {
    const now = new Date().toISOString();
    const next = database.sqlite.transaction(() => {
      const current = database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, input.jobId)).limit(1).get();
      if (!current) throw new Error(`Unknown scheduled job: ${input.jobId}`);
      if (current.status !== "blocked") return current;
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        throw new Error(`Scheduled job retry conflict for ${input.jobId}.`);
      }
      const revision = current.revision + 1;
      const changed = database.db.update(scheduledJobs).set({
        status: "due",
        revision,
        dispatchNextEligibleAt: null,
        dispatchBlockerKind: null,
        lastError: null,
        updatedAt: now,
        ...stateTimestampFields("due", current.status, now),
      }).where(and(
        eq(scheduledJobs.id, input.jobId),
        eq(scheduledJobs.revision, current.revision),
        eq(scheduledJobs.status, "blocked"),
      )).run();
      if (changed.changes !== 1) throw new Error(`Scheduled job retry conflict for ${input.jobId}.`);
      dispatchOutbox.enqueue({
        eventType: "scheduled_job.due",
        aggregateId: input.jobId,
        aggregateRevision: revision,
        availableAt: now,
        payload: { scheduledJobId: input.jobId, revision, reviewerRetried: true },
      });
      return database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, input.jobId)).get()!;
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
    agentName?: string;
    lastError?: string;
    failureClass?: string;
    probeResult?: Record<string, unknown>;
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
      const effectiveStatus: ScheduledJobStatus = cancellationPending ? "cancellation_requested"
        : lifecycleAdvanced ? current.status as ScheduledJobStatus
          : nextStatus as ScheduledJobStatus;
      const jobUpdate = database.db.update(scheduledJobs)
        .set({
          status: effectiveStatus,
          revision: current.revision + 1,
          activeDispatchAttemptId: input.outcome === "failed" ? null : input.dispatchAttemptId,
          workSessionId: input.workSessionId ?? undefined,
          ...(cancellationPending && input.outcome === "failed"
            ? { cancellationLastConfirmedState: "not_dispatched" }
            : {}),
          ...(input.agentName ? { dispatchLastAttemptedAgent: input.agentName } : {}),
          dispatchNextEligibleAt: null,
          dispatchBlockerKind: null,
          lastError: input.lastError ? redactedPreview(input.lastError, 1_000) : null,
          updatedAt: now,
          ...stateTimestampFields(effectiveStatus, current.status, now),
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
          agentName: input.agentName ?? null,
          executionReceiptJson: input.executionReceipt ? JSON.stringify(input.executionReceipt) : null,
          dispatchFailureClass: input.failureClass ?? (input.outcome === "dispatched" ? "accepted" : `dispatch_${input.outcome}`),
          dispatchFailureReason: input.outcome === "dispatched" ? null : redactedPreview(input.lastError ?? `Dispatch ${input.outcome}.`, 1_000),
          dispatchProbeResultJson: input.probeResult ? JSON.stringify(input.probeResult).slice(0, 4_000) : null,
          nextEligibleAt: null,
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
        ...stateTimestampFields(effectiveNextStatus, current?.status, now),
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
    // Record the final output separately before projecting it. If the immutable
    // artifact write fails, this durable obligation remains for the bounded
    // scheduler reconciler to retry without a client read.
    recordReportFinalizationObligation(event);
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
            ...(advancesAttempt ? { workerExecutionOutcome: null, workerExecutionAt: null } : {}),
          }).where(eq(scheduledJobAttempts.id, activeAttempt.id)).run();
        } else {
          const activeSince = activeAttempt.executionActiveSince ? Date.parse(activeAttempt.executionActiveSince) : Number.NaN;
          const additionalRuntime = Number.isFinite(activeSince) ? Math.max(0, eventAt - activeSince) : 0;
          database.db.update(scheduledJobAttempts).set({
            activeRuntimeMs: Math.max(0, Number(activeAttempt.activeRuntimeMs ?? 0)) + additionalRuntime,
            executionActiveSince: null,
            executionStoppedAt: event.createdAt,
            ...(projection.workerExecutionOutcome
              ? { workerExecutionOutcome: projection.workerExecutionOutcome, workerExecutionAt: event.createdAt }
              : {}),
          }).where(eq(scheduledJobAttempts.id, activeAttempt.id)).run();
        }
        activeAttempt = database.db.select().from(scheduledJobAttempts).where(eq(scheduledJobAttempts.id, activeAttempt.id)).limit(1).get();
      }
      if (projection.workerExecutionOutcome && activeAttempt) {
        const obligation = database.db.select().from(scheduledJobReportFinalizations).where(and(
          eq(scheduledJobReportFinalizations.jobId, row.id),
          eq(scheduledJobReportFinalizations.runId, eventRunId ?? ""),
          eq(scheduledJobReportFinalizations.attemptNumber, eventAttemptNumber ?? 0),
        )).limit(1).get();
        if (obligation?.status === "pending") {
          const now = new Date().toISOString();
          try {
            finalizeReportObligationWithinTransaction(obligation, now);
          } catch (error) {
            database.db.update(scheduledJobReportFinalizations).set({
              lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
              updatedAt: now,
            }).where(and(
              eq(scheduledJobReportFinalizations.id, obligation.id),
              eq(scheduledJobReportFinalizations.status, "pending"),
            )).run();
          }
        }
      }
      const stateChangedAt = new Date().toISOString();
      const terminalStatus = projection.autonomousCompletion && row.executionMode === "bounded_file_write"
        ? "completed" as ScheduledJobStatus
        : projection.nextStatus;
      const terminalTransition = Boolean(terminalStatus && ["completed", "failed", "cancelled"].includes(terminalStatus));
      const updated = database.db.update(scheduledJobs).set({
        status: terminalStatus,
        revision: terminalTransition ? row.revision + 1 : row.revision,
        activeDispatchAttemptId: terminalTransition ? null : undefined,
        lifecycleEventCursor: event.seq,
        lastError: projection.lastError ?? (projection.nextStatus ? null : undefined),
        updatedAt: stateChangedAt,
        ...(terminalStatus ? stateTimestampFields(terminalStatus, currentStatus, stateChangedAt) : {}),
      }).where(and(
        eq(scheduledJobs.id, row.id),
        eq(scheduledJobs.revision, row.revision),
        lt(scheduledJobs.lifecycleEventCursor, event.seq),
      )).run();
      if (updated.changes !== 1) throw new Error(`Scheduled event projection conflict for ${row.id} at event ${event.seq}.`);

      if (terminalTransition) {
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
        ...stateTimestampFields("cancellation_requested", current.status, now),
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
        ...stateTimestampFields("cancelled", "cancellation_requested", now),
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
    let publicationReceipts: Array<Record<string, unknown>> | undefined;
    if (row?.publicationReceiptsJson) {
      try {
        const parsed: unknown = JSON.parse(row.publicationReceiptsJson);
        if (Array.isArray(parsed)) publicationReceipts = parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
      } catch { /* corrupt optional receipts remain visibly absent */ }
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
      publicationReceipts,
      workerExecutionOutcome: row.workerExecutionOutcome === "completed" || row.workerExecutionOutcome === "failed"
          || row.workerExecutionOutcome === "failed_protocol" || row.workerExecutionOutcome === "cancelled"
        ? row.workerExecutionOutcome
        : undefined,
      workerExecutionAt: row.workerExecutionAt ?? undefined,
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

  function getWorkerFailureEvidence(jobId: string): WorkerFailureEvidence | undefined {
    const job = database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, jobId)).limit(1).all()[0];
    const attempt = getAttempt(jobId);
    if (!job?.workSessionId || !attempt?.acpRunId || !attempt.acpAttemptNumber) return undefined;
    const rows = database.sqlite.prepare(`
      select id, type, payload from event_log
       where session_id = ? and type in ('agent.run.failed','worker.attempt.failed')
       order by seq desc limit 25
    `).all(job.workSessionId) as Array<{ id: string; type: string; payload: string }>;
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        if (payload.runId !== attempt.acpRunId || payload.attemptNumber !== attempt.acpAttemptNumber) continue;
        if (attempt.acpDispatchId && payload.dispatchId !== attempt.acpDispatchId) continue;
        const evidence = payload.workerFailureEvidence as Record<string, unknown> | undefined;
        if (!evidence) {
          // Older terminal events stored raw process diagnostics on the durable
          // work-session event. Project only exact run/attempt matches and
          // sanitize before exposing them through the scheduled receipt.
          const exitCode = typeof payload.exit_code === "number" && Number.isInteger(payload.exit_code)
            ? payload.exit_code
            : undefined;
          const signal = boundedFailureDiagnosticTail(payload.signal, 128);
          const stderr = boundedFailureDiagnosticTail(payload.stderr);
          const reason = boundedFailureDiagnosticTail(payload.reason ?? payload.error ?? payload.message);
          if (exitCode === undefined && !signal && !stderr && !reason) continue;
          return {
            phase: "execution",
            category: reason && /timeout|timed out|deadman|run ceiling/i.test(reason) ? "timeout"
              : reason && /protocol_incomplete/i.test(reason) ? "protocol_failure"
                : signal ? "signal_termination"
                  : exitCode !== undefined && exitCode !== 0 ? "nonzero_exit"
                    : "legacy_worker_failure",
            ...(reason ? { reason } : {}),
            ...(exitCode !== undefined ? { exitCode } : {}),
            ...(signal ? { signal } : {}),
            ...(stderr ? { sanitizedStderrTail: stderr } : {}),
            eventId: row.id.slice(0, 200),
            runId: attempt.acpRunId,
            attemptNumber: attempt.acpAttemptNumber,
          };
        }
        if (evidence.runId !== attempt.acpRunId || evidence.attemptNumber !== attempt.acpAttemptNumber) continue;
        if (evidence.phase !== "execution" && evidence.phase !== "spawn" && evidence.phase !== "admission" && evidence.phase !== "reporting") continue;
        if (typeof evidence.category !== "string") continue;
        return {
          phase: evidence.phase,
          category: evidence.category.slice(0, 120),
          ...(typeof evidence.reason === "string" ? { reason: boundedFailureDiagnosticTail(evidence.reason) } : {}),
          ...(typeof evidence.exitCode === "number" && Number.isInteger(evidence.exitCode) ? { exitCode: evidence.exitCode } : {}),
          ...(typeof evidence.signal === "string" ? { signal: boundedFailureDiagnosticTail(evidence.signal, 128) } : {}),
          ...(typeof evidence.sanitizedStderrTail === "string" ? { sanitizedStderrTail: boundedFailureDiagnosticTail(evidence.sanitizedStderrTail) } : {}),
          ...(typeof evidence.eventId === "string" ? { eventId: evidence.eventId.slice(0, 200) } : {}),
          runId: attempt.acpRunId,
          attemptNumber: attempt.acpAttemptNumber,
        };
      } catch { /* malformed historical telemetry is not failure authority */ }
    }
    return undefined;
  }

  function listDispatchAttempts(jobId: string, requestedLimit = 50): ScheduledDispatchAttemptDiagnostic[] {
    const limit = Math.max(1, Math.min(100, Math.trunc(requestedLimit) || 50));
    const rows = database.sqlite.prepare(`
      select id, dispatch_id, started_at, completed_at, agent_name, transport_status,
             acp_run_id, acp_attempt_number, dispatch_failure_class,
             dispatch_failure_reason, dispatch_probe_result_json, next_eligible_at
        from scheduled_job_attempts
       where job_id = ?
       order by started_at desc, id desc
       limit ?
    `).all(jobId, limit) as Array<{
      id: string; dispatch_id: string; started_at: string; completed_at: string | null;
      agent_name: string | null; transport_status: string; acp_run_id: string | null;
      acp_attempt_number: number | null; dispatch_failure_class: string | null;
      dispatch_failure_reason: string | null; dispatch_probe_result_json: string | null;
      next_eligible_at: string | null;
    }>;
    return rows.reverse().map((row) => {
      let probeResult: Record<string, unknown> | undefined;
      if (row.dispatch_probe_result_json) {
        try {
          const parsed: unknown = JSON.parse(row.dispatch_probe_result_json);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) probeResult = parsed as Record<string, unknown>;
        } catch { /* corrupt optional preflight data remains unavailable */ }
      }
      return {
        attemptId: row.id,
        dispatchId: row.dispatch_id,
        startedAt: row.started_at,
        ...(row.completed_at ? { completedAt: row.completed_at } : {}),
        ...(row.agent_name ? { selectedAgent: row.agent_name } : {}),
        transportStatus: row.transport_status,
        ...(row.acp_run_id ? { runId: row.acp_run_id } : {}),
        ...(row.acp_attempt_number ? { attemptNumber: row.acp_attempt_number } : {}),
        ...(row.dispatch_failure_class ? { failureClass: row.dispatch_failure_class } : {}),
        ...(row.dispatch_failure_reason ? { failureReason: row.dispatch_failure_reason } : {}),
        ...(probeResult ? { probeResult } : {}),
        ...(row.next_eligible_at ? { nextEligibleAt: row.next_eligible_at } : {}),
      };
    });
  }

  function persistReportWithinTransaction(jobId: string, runId: string, reportText: string, now: string): ScheduledJobReport {
    if (!runId.trim()) throw new Error("Scheduled report requires a correlated ACP run ID.");
    if (Buffer.byteLength(reportText, "utf8") > 8 * 1024 * 1024) {
      throw new Error("Scheduled report exceeds the 8 MiB immutable artifact limit.");
    }
    const reportSha256 = createHash("sha256").update(reportText, "utf8").digest("hex");
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
    return existing;
  }

  function persistReport(jobId: string, runId: string, reportText: string): ScheduledJobReport {
    if (!get(jobId)) throw new Error(`Unknown scheduled job: ${jobId}`);
    const now = new Date().toISOString();
    return database.sqlite.transaction(() => persistReportWithinTransaction(jobId, runId, reportText, now))();
  }

  function getReport(jobId: string, reportSha256: string): ScheduledJobReport | undefined {
    const row = database.db.select().from(scheduledJobReports).where(and(
      eq(scheduledJobReports.jobId, jobId),
      eq(scheduledJobReports.reportSha256, reportSha256),
    )).limit(1).get();
    return row ?? undefined;
  }

  function getReportForAttempt(jobId: string, runId: string, attemptNumber: number): ScheduledJobReport | undefined {
    const row = database.db.select().from(scheduledJobReports).where(and(
      eq(scheduledJobReports.jobId, jobId),
      eq(scheduledJobReports.runId, scheduledReportRunKey(runId, attemptNumber)),
    )).limit(1).get();
    return row ?? undefined;
  }

  function getReportFinalization(jobId: string, runId: string, attemptNumber: number): ScheduledJobReportFinalization | undefined {
    const row = database.db.select().from(scheduledJobReportFinalizations).where(and(
      eq(scheduledJobReportFinalizations.jobId, jobId),
      eq(scheduledJobReportFinalizations.runId, runId),
      eq(scheduledJobReportFinalizations.attemptNumber, attemptNumber),
    )).limit(1).get();
    return row ? {
      id: row.id,
      jobId: row.jobId,
      runId: row.runId,
      attemptNumber: row.attemptNumber,
      eventId: row.eventId,
      status: row.status === "completed" || row.status === "no_output" || row.status === "unavailable"
        ? row.status
        : "pending",
      reportSha256: row.reportSha256 ?? undefined,
      lastError: row.lastError ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } : undefined;
  }

  function claimVerificationExecution(input: ScheduledVerificationClaimInput): { execution: ScheduledVerificationExecution; owner: boolean } {
    if (!get(input.jobId)) throw new Error(`Unknown scheduled job: ${input.jobId}`);
    const now = new Date().toISOString();
    const id = `sched_verify_${randomUUID()}`;
    const identityWhere = and(
      eq(scheduledJobVerifications.jobId, input.jobId),
      eq(scheduledJobVerifications.workSessionId, input.workSessionId),
      eq(scheduledJobVerifications.submissionId, input.submissionId),
      eq(scheduledJobVerifications.reviewEpoch, input.reviewEpoch),
      eq(scheduledJobVerifications.snapshotKind, input.snapshotKind),
      eq(scheduledJobVerifications.snapshotRef, input.snapshotRef),
      eq(scheduledJobVerifications.commandFingerprint, input.commandFingerprint),
      eq(scheduledJobVerifications.policyFingerprint, input.policyFingerprint),
      eq(scheduledJobVerifications.status, "running"),
    );
    const findActiveIdentity = () => database.db.select().from(scheduledJobVerifications)
      .where(identityWhere)
      .orderBy(asc(scheduledJobVerifications.createdAt), asc(scheduledJobVerifications.id))
      .limit(1).get();
    const runClaim = () => database.sqlite.transaction(() => {
      const existing = database.db.select().from(scheduledJobVerifications).where(and(
        eq(scheduledJobVerifications.jobId, input.jobId),
        eq(scheduledJobVerifications.requestKey, input.requestKey),
      )).limit(1).get();
      if (existing) {
        if (existing.requestFingerprint !== input.requestFingerprint) {
          throw new Error("Verification idempotency key was already used with different submission or verification content.");
        }
        if (existing.status === "running" && Date.parse(existing.deadlineAt) <= Date.now()) {
          database.db.update(scheduledJobVerifications).set({
            status: "failed",
            failureReason: "Scheduled verification exceeded its active deadline and was reconciled after interruption.",
            finishedAt: now,
          }).where(and(eq(scheduledJobVerifications.id, existing.id), eq(scheduledJobVerifications.status, "running"))).run();
        }
        const refreshed = database.db.select().from(scheduledJobVerifications).where(eq(scheduledJobVerifications.id, existing.id)).get();
        if (!refreshed) throw new Error("Scheduled verification execution disappeared during idempotency lookup.");
        return { execution: rowToVerification(refreshed), owner: false };
      }
      const activeEquivalent = findActiveIdentity();
      if (activeEquivalent) {
        const deadline = Date.parse(activeEquivalent.deadlineAt);
        if (Number.isFinite(deadline) && deadline > Date.now()) {
          return { execution: rowToVerification(activeEquivalent), owner: false };
        }
        database.db.update(scheduledJobVerifications).set({
          status: "failed",
          failureReason: "Scheduled verification exceeded its active deadline and was reconciled after interruption.",
          finishedAt: now,
        }).where(and(
          eq(scheduledJobVerifications.id, activeEquivalent.id),
          eq(scheduledJobVerifications.status, "running"),
        )).run();
      }
      const latestExecution = database.db.select({ createdAt: scheduledJobVerifications.createdAt }).from(scheduledJobVerifications)
        .where(eq(scheduledJobVerifications.jobId, input.jobId))
        .orderBy(desc(scheduledJobVerifications.createdAt), desc(scheduledJobVerifications.id))
        .limit(1).get();
      const createdAt = latestExecution
        ? new Date(Math.max(Date.now(), Date.parse(latestExecution.createdAt) + 1)).toISOString()
        : now;
      database.db.insert(scheduledJobVerifications).values({
        id,
        jobId: input.jobId,
        requestKey: input.requestKey,
        requestFingerprint: input.requestFingerprint,
        clientMutationId: input.clientMutationId ?? null,
        executionIdentity: input.executionIdentity,
        workSessionId: input.workSessionId,
        submissionId: input.submissionId,
        reviewEpoch: input.reviewEpoch,
        snapshotKind: input.snapshotKind,
        snapshotRef: input.snapshotRef,
        commandFingerprint: input.commandFingerprint,
        policyFingerprint: input.policyFingerprint,
        status: "running",
        deadlineAt: input.deadlineAt,
        reportSha256: null,
        reportText: null,
        failureReason: null,
        createdAt,
        startedAt: createdAt,
        finishedAt: null,
      }).run();
      const inserted = database.db.select().from(scheduledJobVerifications).where(eq(scheduledJobVerifications.id, id)).get();
      if (!inserted) throw new Error("Scheduled verification execution could not be read after claim.");
      return { execution: rowToVerification(inserted), owner: true };
    })();
    try {
      return runClaim();
    } catch (error) {
      const sameRequest = database.db.select().from(scheduledJobVerifications).where(and(
        eq(scheduledJobVerifications.jobId, input.jobId),
        eq(scheduledJobVerifications.requestKey, input.requestKey),
      )).limit(1).get();
      if (sameRequest) {
        if (sameRequest.requestFingerprint !== input.requestFingerprint) throw error;
        return { execution: rowToVerification(sameRequest), owner: false };
      }
      // A second process can win the partial unique-index race after this
      // transaction's identity lookup. Reconcile that exact active execution
      // and only mask the insert error when it is still authoritative.
      const concurrent = findActiveIdentity();
      if (concurrent && Date.parse(concurrent.deadlineAt) > Date.now()) {
        return { execution: rowToVerification(concurrent), owner: false };
      }
      throw error;
    }
  }

  function completeVerificationExecution(input: { executionId: string; reportText: string }): ScheduledVerificationExecution {
    if (Buffer.byteLength(input.reportText, "utf8") > 8 * 1024 * 1024) {
      throw new Error("Scheduled verification report exceeds the 8 MiB immutable artifact limit.");
    }
    const reportSha256 = createHash("sha256").update(input.reportText, "utf8").digest("hex");
    const now = new Date().toISOString();
    const result = database.sqlite.transaction(() => {
      const changed = database.db.update(scheduledJobVerifications).set({
        status: "completed",
        reportSha256,
        reportText: input.reportText,
        failureReason: null,
        finishedAt: now,
      }).where(and(
        eq(scheduledJobVerifications.id, input.executionId),
        eq(scheduledJobVerifications.status, "running"),
        gt(scheduledJobVerifications.deadlineAt, now),
      )).run();
      const current = database.db.select().from(scheduledJobVerifications).where(eq(scheduledJobVerifications.id, input.executionId)).get();
      if (!current) return { error: "Scheduled verification execution is unavailable." };
      if (changed.changes !== 1 && !(current.status === "completed" && current.reportSha256 === reportSha256)) {
        if (current.status === "running" && Date.parse(current.deadlineAt) <= Date.now()) {
          database.db.update(scheduledJobVerifications).set({
            status: "failed",
            failureReason: "Scheduled verification exceeded its active deadline.",
            finishedAt: now,
          }).where(and(eq(scheduledJobVerifications.id, current.id), eq(scheduledJobVerifications.status, "running"))).run();
          const failed = database.db.select().from(scheduledJobVerifications).where(eq(scheduledJobVerifications.id, current.id)).get();
          return { error: failed?.failureReason ?? "Scheduled verification exceeded its active deadline." };
        }
        return { error: current.status === "failed" ? current.failureReason ?? "Scheduled verification failed." : "Scheduled verification is no longer eligible to complete." };
      }
      const completed = database.db.select().from(scheduledJobVerifications).where(eq(scheduledJobVerifications.id, input.executionId)).get();
      return completed ? { execution: rowToVerification(completed) } : { error: "Scheduled verification execution disappeared after completion." };
    })();
    if (result.error) throw new Error(result.error);
    return result.execution!;
  }

  function failVerificationExecution(input: { executionId: string; reason: string }): ScheduledVerificationExecution | undefined {
    const now = new Date().toISOString();
    database.db.update(scheduledJobVerifications).set({
      status: "failed",
      failureReason: input.reason.slice(0, 2_000),
      finishedAt: now,
    }).where(and(
      eq(scheduledJobVerifications.id, input.executionId),
      eq(scheduledJobVerifications.status, "running"),
    )).run();
    const row = database.db.select().from(scheduledJobVerifications).where(eq(scheduledJobVerifications.id, input.executionId)).get();
    return row ? rowToVerification(row) : undefined;
  }

  function getVerificationReport(jobId: string, reportSha256: string): ScheduledVerificationExecution | undefined {
    const row = database.db.select().from(scheduledJobVerifications).where(and(
      eq(scheduledJobVerifications.jobId, jobId),
      eq(scheduledJobVerifications.reportSha256, reportSha256),
      eq(scheduledJobVerifications.status, "completed"),
    )).limit(1).get();
    return row ? rowToVerification(row) : undefined;
  }

  function getLatestVerificationExecution(input: Omit<ScheduledVerificationClaimInput, "requestKey" | "requestFingerprint" | "clientMutationId" | "executionIdentity" | "deadlineAt">): ScheduledVerificationExecution | undefined {
    const row = database.db.select().from(scheduledJobVerifications).where(and(
      eq(scheduledJobVerifications.jobId, input.jobId),
      eq(scheduledJobVerifications.workSessionId, input.workSessionId),
      eq(scheduledJobVerifications.submissionId, input.submissionId),
      eq(scheduledJobVerifications.reviewEpoch, input.reviewEpoch),
      eq(scheduledJobVerifications.snapshotKind, input.snapshotKind),
      eq(scheduledJobVerifications.snapshotRef, input.snapshotRef),
      eq(scheduledJobVerifications.commandFingerprint, input.commandFingerprint),
      eq(scheduledJobVerifications.policyFingerprint, input.policyFingerprint),
    )).orderBy(desc(scheduledJobVerifications.createdAt), desc(scheduledJobVerifications.id)).limit(1).get();
    return row ? rowToVerification(row) : undefined;
  }

  function reconcileStaleVerificationExecutions(limit = 25, now = new Date().toISOString()): number {
    const stale = database.db.select({ id: scheduledJobVerifications.id }).from(scheduledJobVerifications).where(and(
      eq(scheduledJobVerifications.status, "running"),
      lte(scheduledJobVerifications.deadlineAt, now),
    )).orderBy(asc(scheduledJobVerifications.deadlineAt), asc(scheduledJobVerifications.id)).limit(Math.max(1, Math.min(250, limit))).all();
    let count = 0;
    for (const row of stale) {
      count += database.db.update(scheduledJobVerifications).set({
        status: "failed",
        failureReason: "Scheduled verification exceeded its active deadline and was reconciled after interruption.",
        finishedAt: now,
      }).where(and(
        eq(scheduledJobVerifications.id, row.id),
        eq(scheduledJobVerifications.status, "running"),
        lte(scheduledJobVerifications.deadlineAt, now),
      )).run().changes;
    }
    return count;
  }

  function recordReportFinalizationObligation(event: EventStoreEvent): void {
    const reportOutcomes = new Set([
      "worker.turn.completed",
      "agent.run.completed",
      "agent.run.failed",
      "agent.run.failed_protocol",
      "agent.run.cancelled",
      "worker.attempt.failed",
      "worker.attempt.exited",
    ]);
    if (!reportOutcomes.has(event.type) || !event.sessionId || !event.id) return;
    const runId = typeof event.payload.runId === "string" ? event.payload.runId : undefined;
    const dispatchId = typeof event.payload.dispatchId === "string" ? event.payload.dispatchId : undefined;
    const attemptNumber = typeof event.payload.attemptNumber === "number" && Number.isInteger(event.payload.attemptNumber)
      ? event.payload.attemptNumber
      : undefined;
    if (!runId || !dispatchId || !attemptNumber || attemptNumber <= 0) return;
    const job = database.db.select().from(scheduledJobs)
      .where(eq(scheduledJobs.workSessionId, event.sessionId)).orderBy(asc(scheduledJobs.createdAt)).limit(1).get();
    if (!job?.activeDispatchAttemptId) return;
    const activeAttempt = database.db.select().from(scheduledJobAttempts)
      .where(and(eq(scheduledJobAttempts.id, job.activeDispatchAttemptId), eq(scheduledJobAttempts.jobId, job.id))).limit(1).get();
    if (!activeAttempt) return;
    const expectedDispatchId = activeAttempt.acpDispatchId ?? activeAttempt.dispatchId;
    const initialBinding = !activeAttempt.acpRunId && runId.length > 0 && dispatchId === expectedDispatchId;
    const advancingAttempt = activeAttempt.acpRunId === runId && attemptNumber > (activeAttempt.acpAttemptNumber ?? 0)
      && dispatchId === expectedDispatchId;
    const sameAttempt = activeAttempt.acpRunId === runId
      && attemptNumber === activeAttempt.acpAttemptNumber
      && dispatchId === expectedDispatchId;
    if (!initialBinding && !advancingAttempt && !sameAttempt) return;
    if (activeAttempt.acpRemoteRunId && event.payload.remoteRunId !== activeAttempt.acpRemoteRunId) return;

    const projection = projectScheduledJobLifecycleEvent(job.status as ScheduledJobStatus, event, {
      requestedAt: job.cancellationRequestedAt ?? undefined,
      previousStatus: job.cancellationPreviousStatus ?? undefined,
    }, {
      dispatchId: expectedDispatchId,
      runId,
      attemptNumber,
      remoteRunId: typeof event.payload.remoteRunId === "string" ? event.payload.remoteRunId : undefined,
    });
    if (!projection.workerExecutionOutcome) return;

    const now = new Date().toISOString();
    const finalOutput = event.payload.final_output;
    const reportText = typeof finalOutput === "string" && finalOutput.length > 0 ? finalOutput : undefined;
    const reportAvailability = reportText
      ? "pending"
      : event.payload.report_availability === "unavailable" ? "unavailable" : "no_output";
    database.db.insert(scheduledJobReportFinalizations).values({
      id: `sched_finalization_${randomUUID()}`,
      jobId: job.id,
      runId,
      attemptNumber,
      eventId: event.id,
      status: reportAvailability,
      reportText: reportText ?? null,
      reportSha256: null,
      lastError: reportText ? null : reportAvailability === "unavailable"
        ? "This execution stopped before an authoritative ACP report was available."
        : "The authoritative ACP prompt response contained no report text.",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({ target: [
      scheduledJobReportFinalizations.jobId,
      scheduledJobReportFinalizations.runId,
      scheduledJobReportFinalizations.attemptNumber,
    ] }).run();
  }

  function finalizeReportObligationWithinTransaction(
    obligation: typeof scheduledJobReportFinalizations.$inferSelect,
    now: string,
  ): void {
    if (obligation.status === "completed" || obligation.reportText === null) return;
    const artifact = persistReportWithinTransaction(
      obligation.jobId,
      scheduledReportRunKey(obligation.runId, obligation.attemptNumber),
      obligation.reportText,
      now,
    );
    database.db.update(scheduledJobReportFinalizations).set({
      status: "completed",
      reportSha256: artifact.reportSha256,
      reportText: null,
      lastError: null,
      updatedAt: now,
    }).where(and(
      eq(scheduledJobReportFinalizations.id, obligation.id),
      eq(scheduledJobReportFinalizations.status, "pending"),
    )).run();
  }

  function reconcilePendingReportFinalizations(limit = 25): number {
    const pending = database.db.select().from(scheduledJobReportFinalizations).where(
      eq(scheduledJobReportFinalizations.status, "pending"),
    ).orderBy(asc(scheduledJobReportFinalizations.updatedAt), asc(scheduledJobReportFinalizations.id))
      .limit(Math.max(1, Math.min(250, limit))).all();
    let finalized = 0;
    for (const obligation of pending) {
      const now = new Date().toISOString();
      try {
        database.sqlite.transaction(() => finalizeReportObligationWithinTransaction(obligation, now))();
        const current = database.db.select({ status: scheduledJobReportFinalizations.status })
          .from(scheduledJobReportFinalizations).where(eq(scheduledJobReportFinalizations.id, obligation.id)).get();
        if (current?.status === "completed") finalized += 1;
      } catch (error) {
        database.db.update(scheduledJobReportFinalizations).set({
          lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
          updatedAt: now,
        }).where(and(
          eq(scheduledJobReportFinalizations.id, obligation.id),
          eq(scheduledJobReportFinalizations.status, "pending"),
        )).run();
      }
    }
    return finalized;
  }

  function transition(input: ScheduledStateTransition): ScheduledJob {
    if (input.nextStatus === "cancellation_requested" || input.nextStatus === "cancelled") {
      throw new Error("Scheduled cancellation states must use the durable cancellation state machine.");
    }
    const now = new Date().toISOString();
    const current = get(input.jobId);
    if (!current) throw new Error(`Unknown scheduled job: ${input.jobId}`);
    const updated = database.db.update(scheduledJobs)
      .set({
        status: input.nextStatus,
        revision: input.expectedRevision + 1,
        workSessionId: input.workSessionId === undefined ? undefined : input.workSessionId,
        lastError: input.lastError === undefined ? undefined : input.lastError,
        updatedAt: now,
        ...stateTimestampFields(input.nextStatus, current.status, now),
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
    listDispatchAttempts,
    getWorkerFailureEvidence,
    persistReport,
    getReport,
    getReportForAttempt,
    getReportFinalization,
    reconcilePendingReportFinalizations,
    claimVerificationExecution,
    completeVerificationExecution,
    failVerificationExecution,
    getVerificationReport,
    getLatestVerificationExecution,
    reconcileStaleVerificationExecutions,
    transition,
    claimDispatch,
    releaseDispatch,
    retryBlockedJob,
    completeDispatch,
    resolveDispatch,
    projectEvent,
    listProjectionTargets,
    recordPublicationIntent(input: { jobId: string; intent: Record<string, unknown> }): void {
      database.sqlite.transaction(() => {
        const job = database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, input.jobId)).limit(1).get();
        if (!job || job.executionMode !== "bounded_file_write" || !job.workSessionId
          || job.workSessionId !== input.intent.workSessionId) {
          throw new Error(`Publication intent is not bound to the active bounded-write job ${input.jobId}.`);
        }
        const attemptId = job.activeDispatchAttemptId;
        if (!attemptId || input.intent.attemptId !== attemptId) {
          throw new Error(`Publication intent is bound to a stale attempt for job ${input.jobId}.`);
        }
        const attempt = database.db.select().from(scheduledJobAttempts)
          .where(and(eq(scheduledJobAttempts.id, attemptId), eq(scheduledJobAttempts.jobId, input.jobId)))
          .limit(1).get();
        if (!attempt || attempt.completedAt || attempt.outcome
          || !Number.isSafeInteger(attempt.acpAttemptNumber)
          || input.intent.attemptNumber !== attempt.acpAttemptNumber
          || !attempt.acpRunId || input.intent.runId !== attempt.acpRunId
          || input.intent.dispatchIdempotencyKey !== attempt.acpDispatchId) {
          throw new Error(`Publication intent does not match the active ACP identity for ${attemptId}.`);
        }
        const path = typeof input.intent.path === "string" ? input.intent.path : undefined;
        const policy = JSON.parse(job.policySnapshotJson) as { allowedOutputs?: Array<Record<string, unknown>> };
        const authorized = policy.allowedOutputs?.find((output) => output?.path === path);
        if (!authorized || authorized.operation !== input.intent.operation
          || typeof input.intent.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.intent.sha256)
          || (authorized.expectedSha256 !== undefined && authorized.expectedSha256 !== input.intent.sha256)
          || (authorized.overwrite === "expected_hash" && authorized.expectedPreviousSha256 !== input.intent.expectedPreviousSha256)
          || (authorized.overwrite === "deny" && input.intent.expectedPreviousSha256 !== undefined)
          || !Number.isSafeInteger(input.intent.bytes) || Number(input.intent.bytes) < 0
          || typeof input.intent.receiptId !== "string" || !input.intent.receiptId
          || input.intent.state !== "pending") {
          throw new Error(`Publication intent is outside the authorized output contract for job ${input.jobId}.`);
        }
        const existing: Array<Record<string, unknown>> = attempt.publicationReceiptsJson
          ? JSON.parse(attempt.publicationReceiptsJson) as Array<Record<string, unknown>>
          : [];
        const duplicate = existing.find((candidate) => candidate.receiptId === input.intent.receiptId);
        if (duplicate) {
          if (JSON.stringify(duplicate) !== JSON.stringify(input.intent)) {
            throw new Error(`Conflicting publication intent ${input.intent.receiptId}.`);
          }
          return;
        }
        existing.push(input.intent);
        const updated = database.db.update(scheduledJobAttempts).set({ publicationReceiptsJson: JSON.stringify(existing) })
          .where(and(
            eq(scheduledJobAttempts.id, attemptId),
            eq(scheduledJobAttempts.jobId, input.jobId),
            eq(scheduledJobAttempts.acpAttemptNumber, input.intent.attemptNumber as number),
            isNull(scheduledJobAttempts.completedAt),
            isNull(scheduledJobAttempts.outcome),
          )).run();
        if (updated.changes !== 1) throw new Error(`Publication intent persistence conflict for attempt ${attemptId}.`);
      })();
    },
    recordPublicationReceipt(input: { jobId: string; receipt: Record<string, unknown> }): void {
      database.sqlite.transaction(() => {
        const job = database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, input.jobId)).limit(1).get();
        if (!job) throw new Error(`Unknown scheduled job for publication receipt: ${input.jobId}`);
        if (job.executionMode !== "bounded_file_write") {
          throw new Error(`Publication receipts are only valid for bounded-write jobs: ${input.jobId}`);
        }
        if (typeof input.receipt?.workSessionId !== "string" || input.receipt?.jobId !== input.jobId) {
          throw new Error(`Publication receipt is not bound to the job and work session for ${input.jobId}`);
        }
        if (input.receipt?.outcome !== "committed" || input.receipt?.readBackVerified !== true) {
          throw new Error("Only committed, read-back-verified publications may be recorded as success evidence.");
        }
        const attemptId = typeof input.receipt.attemptId === "string" ? input.receipt.attemptId : undefined;
        if (!attemptId) throw new Error(`Publication receipt is missing its attempt identity for ${input.jobId}`);
        const row = database.db.select().from(scheduledJobAttempts).where(and(
          eq(scheduledJobAttempts.id, attemptId), eq(scheduledJobAttempts.jobId, input.jobId),
        )).limit(1).get();
        if (!row) throw new Error(`Publication attempt disappeared: ${attemptId}`);
        if (!row.acpRunId || input.receipt.runId !== row.acpRunId
          || !row.acpDispatchId || input.receipt.dispatchIdempotencyKey !== row.acpDispatchId) {
          throw new Error(`Publication receipt ACP identity mismatch for attempt ${attemptId}`);
        }
        const receiptAttemptNumber = typeof input.receipt.attemptNumber === "number" ? input.receipt.attemptNumber : undefined;
        if (!Number.isSafeInteger(receiptAttemptNumber) || row.acpAttemptNumber === null || row.acpAttemptNumber === undefined
          || receiptAttemptNumber !== row.acpAttemptNumber) {
          throw new Error(`Publication receipt attempt number mismatch: ${receiptAttemptNumber} != ${row.acpAttemptNumber}`);
        }
        const receiptPath = typeof input.receipt.path === "string" ? input.receipt.path : undefined;
        const receiptSha256 = typeof input.receipt.sha256 === "string" ? input.receipt.sha256 : undefined;
        const policy = JSON.parse(job.policySnapshotJson) as { allowedOutputs?: Array<Record<string, unknown>> };
        const authorizedOutput = policy.allowedOutputs?.find((output) => output?.path === receiptPath);
        if (!receiptPath || !authorizedOutput || authorizedOutput.operation !== input.receipt.operation) {
          throw new Error(`Publication receipt path or operation is not authorized for job ${input.jobId}`);
        }
        if (!receiptSha256 || !/^[a-f0-9]{64}$/.test(receiptSha256)
          || (authorizedOutput.expectedSha256 !== undefined && authorizedOutput.expectedSha256 !== receiptSha256)
          || !Number.isSafeInteger(input.receipt.bytes) || Number(input.receipt.bytes) < 0) {
          throw new Error(`Publication receipt content proof is invalid for ${receiptPath}`);
        }
        const existing: Array<Record<string, unknown>> = row.publicationReceiptsJson
          ? JSON.parse(row.publicationReceiptsJson) as Array<Record<string, unknown>>
          : [];
        const duplicate = existing.find((candidate) => candidate?.path === receiptPath
          && candidate?.attemptId === attemptId && candidate?.outcome === "committed");
        if (duplicate) {
          if (duplicate.sha256 !== receiptSha256 || duplicate.attemptNumber !== receiptAttemptNumber
            || duplicate.workSessionId !== input.receipt.workSessionId || duplicate.operation !== input.receipt.operation
            || duplicate.bytes !== input.receipt.bytes || duplicate.receiptId !== input.receipt.receiptId
            || duplicate.runId !== input.receipt.runId || duplicate.dispatchIdempotencyKey !== input.receipt.dispatchIdempotencyKey) {
            throw new Error(`Conflicting committed publication receipt for ${receiptPath}`);
          }
          return;
        }
        const intentIndex = existing.findIndex((candidate) => candidate?.receiptId === input.receipt.receiptId && candidate?.state === "pending");
        if (intentIndex < 0) throw new Error(`No durable publication intent exists for receipt ${String(input.receipt.receiptId)}.`);
        const intent = existing[intentIndex];
        if (intent.path !== receiptPath || intent.sha256 !== receiptSha256 || intent.bytes !== input.receipt.bytes
          || intent.operation !== input.receipt.operation || intent.attemptId !== attemptId
          || intent.attemptNumber !== receiptAttemptNumber || intent.workSessionId !== input.receipt.workSessionId
          || intent.runId !== input.receipt.runId || intent.dispatchIdempotencyKey !== input.receipt.dispatchIdempotencyKey) {
          throw new Error(`Publication receipt does not match its durable intent for ${receiptPath}.`);
        }
        if (job.activeDispatchAttemptId !== attemptId && row.completedAt === null && row.outcome === null) {
          throw new Error(`Publication receipt is bound to stale attempt: ${attemptId}`);
        }
        existing[intentIndex] = input.receipt;
        const updated = database.db.update(scheduledJobAttempts).set({ publicationReceiptsJson: JSON.stringify(existing) })
          .where(and(
            eq(scheduledJobAttempts.id, attemptId),
            eq(scheduledJobAttempts.jobId, input.jobId),
            eq(scheduledJobAttempts.acpAttemptNumber, receiptAttemptNumber),
          )).run();
        if (updated.changes !== 1) throw new Error(`Publication receipt persistence conflict for attempt ${attemptId}.`);
      })();
    },
    recordPublicationFailure(input: { jobId: string; receiptId: string; outcome: "rejected" | "conflict"; reason: string }): void {
      database.sqlite.transaction(() => {
        const rows = database.sqlite.prepare(`
          select id, publication_receipts_json as publicationReceiptsJson
            from scheduled_job_attempts
           where job_id = ? and publication_receipts_json is not null
        `).all(input.jobId) as Array<{ id: string; publicationReceiptsJson: string }>;
        for (const row of rows) {
          const receipts = JSON.parse(row.publicationReceiptsJson) as Array<Record<string, unknown>>;
          const index = receipts.findIndex((candidate) => candidate.receiptId === input.receiptId && candidate.state === "pending");
          if (index < 0) continue;
          receipts[index] = { ...receipts[index], state: input.outcome, reason: input.reason.slice(0, 2_000), resolvedAt: new Date().toISOString() };
          database.sqlite.prepare("update scheduled_job_attempts set publication_receipts_json = ? where id = ?").run(JSON.stringify(receipts), row.id);
          return;
        }
      })();
    },
    listPendingPublicationIntents(limit = 25) {
      const boundedLimit = Math.max(1, Math.min(100, limit));
      const rows = database.sqlite.prepare(`
        select job.id as jobId, job.work_session_id as workSessionId, job.workspace_root as workspaceRoot,
               attempt.id as attemptId, attempt.publication_receipts_json as publicationReceiptsJson
          from scheduled_jobs job
          join scheduled_job_attempts attempt on attempt.job_id = job.id
         where job.execution_mode = 'bounded_file_write'
           and instr(attempt.publication_receipts_json, '"state":"pending"') > 0
         order by attempt.started_at, job.id
         limit ?
      `).all(boundedLimit) as Array<{
        jobId: string; workSessionId: string | null; workspaceRoot: string; attemptId: string; publicationReceiptsJson: string;
      }>;
      const pending: Array<{ jobId: string; workSessionId: string; workspaceRoot: string; attemptId: string; attemptNumber: number; intent: Record<string, unknown> }> = [];
      for (const row of rows) {
        if (!row.workSessionId) continue;
        const entries = JSON.parse(row.publicationReceiptsJson) as Array<Record<string, unknown>>;
        for (const intent of entries.filter((candidate) => candidate.state === "pending")) {
          if (!Number.isSafeInteger(intent.attemptNumber)) continue;
          pending.push({ jobId: row.jobId, workSessionId: row.workSessionId, workspaceRoot: row.workspaceRoot, attemptId: row.attemptId, attemptNumber: intent.attemptNumber as number, intent });
          if (pending.length >= boundedLimit) return pending;
        }
      }
      return pending;
    },
    bindWorkSession(input: { jobId: string; dispatchAttemptId: string; workSessionId: string }): ScheduledJob {
      const now = new Date().toISOString();
      const next = database.sqlite.transaction(() => {
        const updated = database.db.update(scheduledJobs).set({
          workSessionId: input.workSessionId,
          updatedAt: now,
        }).where(and(
          eq(scheduledJobs.id, input.jobId),
          eq(scheduledJobs.activeDispatchAttemptId, input.dispatchAttemptId),
          sql`${scheduledJobs.status} in ('dispatching','running','uncertain_dispatch','operator_intervention','cancellation_requested')`,
        )).run();
        if (updated.changes !== 1) {
          throw new Error(`Scheduled work-session binding conflict for ${input.jobId} attempt ${input.dispatchAttemptId}.`);
        }
        return database.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, input.jobId)).limit(1).all()[0];
      })();
      if (!next) throw new Error(`Scheduled job disappeared during work-session binding: ${input.jobId}`);
      return rowToJob(next);
    },
    bindAcpAttempt(input: {
      jobId: string;
      dispatchAttemptId: string;
      workSessionId: string;
      dispatchIdempotencyKey: string;
      runId: string;
      attemptNumber: number;
    }): void {
      if (!input.runId.trim() || !input.dispatchIdempotencyKey.trim()
        || !Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1) {
        throw new Error("ACP attempt identity is invalid.");
      }
      database.sqlite.transaction(() => {
        const job = database.db.select().from(scheduledJobs)
          .where(eq(scheduledJobs.id, input.jobId)).limit(1).get();
        const attempt = database.db.select().from(scheduledJobAttempts)
          .where(and(
            eq(scheduledJobAttempts.id, input.dispatchAttemptId),
            eq(scheduledJobAttempts.jobId, input.jobId),
          )).limit(1).get();
        if (!job || !attempt
          || job.activeDispatchAttemptId !== input.dispatchAttemptId
          || job.status !== "dispatching"
          || job.workSessionId !== input.workSessionId
          || attempt.dispatchId !== input.dispatchIdempotencyKey
          || attempt.completedAt || attempt.outcome) {
          throw new Error(`ACP attempt binding conflict for ${input.jobId} attempt ${input.dispatchAttemptId}.`);
        }
        const existingBinding = attempt.acpRunId !== null || attempt.acpAttemptNumber !== null || attempt.acpDispatchId !== null;
        if (existingBinding) {
          if (attempt.acpRunId === input.runId
            && attempt.acpAttemptNumber === input.attemptNumber
            && attempt.acpDispatchId === input.dispatchIdempotencyKey) return;
          throw new Error(`ACP attempt identity is already bound for ${input.dispatchAttemptId}.`);
        }
        const updated = database.db.update(scheduledJobAttempts).set({
          acpRunId: input.runId,
          acpDispatchId: input.dispatchIdempotencyKey,
          acpAttemptNumber: input.attemptNumber,
        }).where(and(
          eq(scheduledJobAttempts.id, input.dispatchAttemptId),
          eq(scheduledJobAttempts.jobId, input.jobId),
          eq(scheduledJobAttempts.dispatchId, input.dispatchIdempotencyKey),
          isNull(scheduledJobAttempts.acpRunId),
          isNull(scheduledJobAttempts.acpAttemptNumber),
          isNull(scheduledJobAttempts.completedAt),
          isNull(scheduledJobAttempts.outcome),
        )).run();
        if (updated.changes !== 1) {
          throw new Error(`ACP attempt identity could not be bound for ${input.dispatchAttemptId}.`);
        }
      })();
    },
    recordReconcileProbe(input: { jobId: string; attemptId: string; evidence: string; now?: string }): void {
      const now = input.now ?? new Date().toISOString();
      database.sqlite.transaction(() => {
        const row = database.db.select().from(scheduledJobAttempts)
          .where(and(eq(scheduledJobAttempts.id, input.attemptId), eq(scheduledJobAttempts.jobId, input.jobId)))
          .limit(1).all()[0];
        if (!row) return;
        const nextCount = (row.reconcileProbeCount ?? 0) + 1;
        // Capped exponential backoff with bounded jitter: 2^n seconds, max 10 minutes.
        const baseMs = Math.min(2 ** nextCount * 1_000, 600_000);
        const jitterMs = Math.floor(Math.random() * Math.min(baseMs * 0.25, 60_000));
        const nextAt = new Date(Date.parse(now) + baseMs + jitterMs).toISOString();
        database.db.update(scheduledJobAttempts).set({
          reconcileProbeCount: nextCount,
          nextReconcileAt: nextAt,
          lastReconcileEvidence: input.evidence.slice(0, 2_000),
        }).where(eq(scheduledJobAttempts.id, input.attemptId)).run();
      })();
    },

    close() {
      database.close();
    },
  } as ScheduledJobStore;
}

export type { ScheduledJobInput as ScheduledJobInputAlias };
