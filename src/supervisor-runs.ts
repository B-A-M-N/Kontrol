import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { supervisorRuns } from "./db/schema.js";

export type SupervisorStatus = "created" | "planning" | "dispatch_pending" | "worker_active" | "awaiting_submission" | "verification_pending" | "verifying" | "evaluation_pending" | "correction_pending" | "approval_pending" | "awaiting_human" | "paused" | "completed" | "failed" | "cancelled";
export type AutonomyMode = "manual" | "verify_only" | "correction_auto" | "full";
export type ApprovalMode = "human_required" | "policy_auto" | "fully_automatic";
const TERMINAL = new Set<SupervisorStatus>(["completed", "failed", "cancelled"]);

export interface SupervisorRuns {
  create(input: { missionId: string; workSessionId: string; workspaceSessionId: string; maxCycles?: number; maxWallTimeMs?: number; autonomyMode?: AutonomyMode; approvalMode?: ApprovalMode }): ReturnType<typeof row>;
  getByWorkSession(workSessionId: string): ReturnType<typeof row> | undefined;
  transition(input: { id: string; expectedStatus: SupervisorStatus; expectedRevision: number; nextStatus: SupervisorStatus; cycleNumber?: number; lastProcessedEventSeq?: number; lastSubmissionId?: string; lastSnapshotCommit?: string; nextActionAt?: string; lastError?: string; lease?: { ownerInstanceId: string; leaseNonce: string } }): ReturnType<typeof row> | undefined;
  claim(id: string, instanceId: string, leaseMs: number): ReturnType<typeof row> | undefined;
  renew(id: string, instanceId: string, leaseNonce: string, leaseMs: number): ReturnType<typeof row> | undefined;
  release(id: string, instanceId: string, leaseNonce?: string): void;
  pause(id: string, expectedRevision: number): ReturnType<typeof row> | undefined;
  resume(id: string, expectedRevision: number): ReturnType<typeof row> | undefined;
  noteFailure(id: string, instanceId: string, error: string, leaseNonce?: string): void;
  noteFailureFingerprint(id: string, instanceId: string, fingerprint: string, leaseNonce?: string): number;
  releaseExpiredClaims(): number;
  listRecoverable(): Array<ReturnType<typeof row>>;
  close(): void;
}

export function createSupervisorRuns(stateDirOrHandle: string | DatabaseHandle): SupervisorRuns {
  const database = typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;
  const now = () => new Date().toISOString();
  function getByWorkSession(workSessionId: string) { const value = database.db.select().from(supervisorRuns).where(eq(supervisorRuns.workSessionId, workSessionId)).get(); return value ? row(value) : undefined; }
  return {
    create(input) {
      const existing = getByWorkSession(input.workSessionId); if (existing) return existing;
      const time = now(); const id = `sup_${randomUUID()}`;
      const maxWallTimeMs = Math.max(60_000, Math.min(input.maxWallTimeMs ?? 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000));
      database.db.insert(supervisorRuns).values({ id, missionId: input.missionId, workSessionId: input.workSessionId, workspaceSessionId: input.workspaceSessionId, maxCycles: input.maxCycles ?? 10, deadlineAt: new Date(Date.now() + maxWallTimeMs).toISOString(), autonomyMode: input.autonomyMode ?? "manual", approvalMode: input.approvalMode ?? "human_required", createdAt: time, updatedAt: time }).run();
      return getByWorkSession(input.workSessionId)!;
    }, getByWorkSession,
    transition(input) {
      if (TERMINAL.has(input.expectedStatus) && input.nextStatus !== input.expectedStatus) return undefined;
      const changes: Record<string, unknown> = { status: input.nextStatus, resumeStatus: null, revision: input.expectedRevision + 1, updatedAt: now() };
      if (input.cycleNumber !== undefined) changes.cycleNumber = input.cycleNumber;
      if (input.lastProcessedEventSeq !== undefined) changes.lastProcessedEventSeq = input.lastProcessedEventSeq;
      if (input.lastSubmissionId !== undefined) changes.lastSubmissionId = input.lastSubmissionId;
      if (input.lastSnapshotCommit !== undefined) changes.lastSnapshotCommit = input.lastSnapshotCommit;
      if (input.nextActionAt !== undefined) changes.nextActionAt = input.nextActionAt;
      if (input.lastError !== undefined) changes.lastError = input.lastError;
      const leasePredicate = input.lease
        ? and(
            eq(supervisorRuns.ownerInstanceId, input.lease.ownerInstanceId),
            eq(supervisorRuns.leaseNonce, input.lease.leaseNonce),
            // A stale owner cannot commit after its lease has elapsed. The
            // deadline check is separate below so an expired mission can only
            // be moved to a human-gated state by an unleased recovery path.
            sql`${supervisorRuns.leaseExpiresAt} > ${now()}`,
          )
        : undefined;
      const deadlinePredicate = input.lease && input.nextStatus !== "awaiting_human"
        ? sql`(${supervisorRuns.deadlineAt} is null or ${supervisorRuns.deadlineAt} > ${now()})`
        : undefined;
      const updated = database.db.update(supervisorRuns).set(changes as any).where(and(
        eq(supervisorRuns.id, input.id),
        eq(supervisorRuns.status, input.expectedStatus),
        eq(supervisorRuns.revision, input.expectedRevision),
        leasePredicate,
        deadlinePredicate,
      )).run();
      if (!updated.changes) return undefined; const value = database.db.select().from(supervisorRuns).where(eq(supervisorRuns.id, input.id)).get(); return value ? row(value) : undefined;
    },
    claim(id, instanceId, leaseMs) {
      const current = database.db.select().from(supervisorRuns).where(eq(supervisorRuns.id, id)).get();
      if (!current || TERMINAL.has(current.status as SupervisorStatus)) return undefined;
      const currentTime = now();
      if (current.deadlineAt && Date.parse(current.deadlineAt) <= Date.now()) return undefined;
      const nonce = randomUUID();
      const expires = new Date(Math.min(
        Date.now() + leaseMs,
        current.deadlineAt ? Date.parse(current.deadlineAt) : Date.now() + leaseMs,
      )).toISOString();
      const updated = database.db.update(supervisorRuns).set({ ownerInstanceId: instanceId, leaseNonce: nonce, leaseExpiresAt: expires, heartbeatAt: currentTime, updatedAt: currentTime }).where(and(
        eq(supervisorRuns.id, id),
        or(isNull(supervisorRuns.ownerInstanceId), lt(supervisorRuns.leaseExpiresAt, currentTime)),
        sql`(${supervisorRuns.deadlineAt} is null or ${supervisorRuns.deadlineAt} > ${currentTime})`,
      )).run();
      if (!updated.changes) return undefined;
      const value = database.db.select().from(supervisorRuns).where(eq(supervisorRuns.id, id)).get();
      return value ? row(value) : undefined;
    },
    renew(id, instanceId, leaseNonce, leaseMs) {
      const current = database.db.select().from(supervisorRuns).where(eq(supervisorRuns.id, id)).get();
      if (!current || current.ownerInstanceId !== instanceId || current.leaseNonce !== leaseNonce || TERMINAL.has(current.status as SupervisorStatus)) return undefined;
      const currentTime = now();
      if (current.deadlineAt && Date.parse(current.deadlineAt) <= Date.now()) return undefined;
      const expires = new Date(Math.min(
        Date.now() + leaseMs,
        current.deadlineAt ? Date.parse(current.deadlineAt) : Date.now() + leaseMs,
      )).toISOString();
      const updated = database.db.update(supervisorRuns).set({ leaseExpiresAt: expires, heartbeatAt: currentTime, updatedAt: currentTime }).where(and(
        eq(supervisorRuns.id, id),
        eq(supervisorRuns.ownerInstanceId, instanceId),
        eq(supervisorRuns.leaseNonce, leaseNonce),
        sql`${supervisorRuns.leaseExpiresAt} > ${currentTime}`,
      )).run();
      if (!updated.changes) return undefined;
      const value = database.db.select().from(supervisorRuns).where(eq(supervisorRuns.id, id)).get();
      return value ? row(value) : undefined;
    },
    release(id, instanceId, leaseNonce) {
      database.db.update(supervisorRuns).set({ ownerInstanceId: null, leaseNonce: null, leaseExpiresAt: null, updatedAt: now() }).where(and(
        eq(supervisorRuns.id, id),
        eq(supervisorRuns.ownerInstanceId, instanceId),
        leaseNonce ? eq(supervisorRuns.leaseNonce, leaseNonce) : undefined,
      )).run();
    },
    pause(id, expectedRevision) {
      const existing = database.db.select().from(supervisorRuns).where(eq(supervisorRuns.id, id)).get();
      if (!existing || TERMINAL.has(existing.status as SupervisorStatus) || existing.revision !== expectedRevision || existing.status === "paused") return undefined;
      const updated = database.db.update(supervisorRuns).set({ status: "paused", resumeStatus: existing.status, revision: expectedRevision + 1, updatedAt: now() }).where(and(eq(supervisorRuns.id, id), eq(supervisorRuns.revision, expectedRevision), eq(supervisorRuns.status, existing.status))).run();
      if (!updated.changes) return undefined; const value = database.db.select().from(supervisorRuns).where(eq(supervisorRuns.id, id)).get(); return value ? row(value) : undefined;
    },
    resume(id, expectedRevision) {
      const existing = database.db.select().from(supervisorRuns).where(eq(supervisorRuns.id, id)).get();
      if (!existing || existing.status !== "paused" || existing.revision !== expectedRevision || !existing.resumeStatus) return undefined;
      const updated = database.db.update(supervisorRuns).set({ status: existing.resumeStatus, resumeStatus: null, revision: expectedRevision + 1, updatedAt: now() }).where(and(eq(supervisorRuns.id, id), eq(supervisorRuns.status, "paused"), eq(supervisorRuns.revision, expectedRevision))).run();
      if (!updated.changes) return undefined; const value = database.db.select().from(supervisorRuns).where(eq(supervisorRuns.id, id)).get(); return value ? row(value) : undefined;
    },
    noteFailure(id, instanceId, error, leaseNonce) {
      database.db.update(supervisorRuns).set({ failureCount: sql`${supervisorRuns.failureCount} + 1`, lastError: error.slice(0, 4_000), heartbeatAt: now(), updatedAt: now() }).where(and(eq(supervisorRuns.id, id), eq(supervisorRuns.ownerInstanceId, instanceId), leaseNonce ? eq(supervisorRuns.leaseNonce, leaseNonce) : undefined)).run();
    },
    noteFailureFingerprint(id, instanceId, fingerprint, leaseNonce) {
      const current = database.db.select().from(supervisorRuns).where(and(eq(supervisorRuns.id, id), eq(supervisorRuns.ownerInstanceId, instanceId), leaseNonce ? eq(supervisorRuns.leaseNonce, leaseNonce) : undefined)).get();
      if (!current) return 0;
      const count = current.lastFailureFingerprint === fingerprint ? current.repeatedFailureCount + 1 : 1;
      database.db.update(supervisorRuns).set({ lastFailureFingerprint: fingerprint, repeatedFailureCount: count, updatedAt: now() }).where(and(eq(supervisorRuns.id, id), eq(supervisorRuns.ownerInstanceId, instanceId), leaseNonce ? eq(supervisorRuns.leaseNonce, leaseNonce) : undefined)).run();
      return count;
    },
    releaseExpiredClaims() { return database.db.update(supervisorRuns).set({ ownerInstanceId: null, leaseNonce: null, leaseExpiresAt: null }).where(lt(supervisorRuns.leaseExpiresAt, now())).run().changes; },
    listRecoverable() { return database.db.select().from(supervisorRuns).all().filter((value) => !TERMINAL.has(value.status as SupervisorStatus)).map(row); },
    close() {},
  };
}
function row(value: typeof supervisorRuns.$inferSelect) { return { ...value, status: value.status as SupervisorStatus, resumeStatus: value.resumeStatus as SupervisorStatus | null, autonomyMode: value.autonomyMode as AutonomyMode, approvalMode: value.approvalMode as ApprovalMode }; }
