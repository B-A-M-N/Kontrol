import { randomUUID } from "node:crypto";
import { and, asc, eq, lt, lte, or } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { dispatchOutbox, type DispatchOutboxRow } from "./db/schema.js";

export type OutboxStatus = "pending" | "claimed" | "completed" | "failed" | "dead_lettered";

export interface DispatchOutboxEvent {
  id: string;
  eventType: string;
  aggregateId: string;
  aggregateRevision: number;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attemptCount: number;
  availableAt: string;
  claimedBy?: string;
  claimExpiresAt?: string;
  lastError?: string;
  createdAt: string;
  completedAt?: string;
}

export interface DispatchOutbox {
  enqueue(input: {
    eventType: string;
    aggregateId: string;
    aggregateRevision?: number;
    payload?: Record<string, unknown>;
    availableAt?: string;
  }): DispatchOutboxEvent;

  /** Atomically claim the next available event for this worker. CAS on status. */
  claimNext(workerId: string, leaseMs: number): DispatchOutboxEvent | null;

  /** Reap expired claims back to pending. Returns count requeued. */
  reapExpiredClaims(leaseMs: number): number;

  /** Release a claimed event without recording a failed attempt. */
  release(id: string, retryDelayMs?: number, note?: string): void;

  markCompleted(id: string): void;

  markFailed(id: string, error: string, retryDelayMs: number): void;

  listPending(limit?: number): DispatchOutboxEvent[];

  hasActive(eventType: string, aggregateId: string): boolean;
  hasLogical(eventType: string, aggregateId: string, aggregateRevision?: number): boolean;
  redriveDeadLetter(eventType: string, aggregateId: string, aggregateRevision?: number): DispatchOutboxEvent | null;

  close(): void;
}

export function createDispatchOutbox(
  stateDirOrHandle: string | DatabaseHandle,
): DispatchOutbox {
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;

  function enqueue(input: {
    eventType: string;
    aggregateId: string;
    aggregateRevision?: number;
    payload?: Record<string, unknown>;
    availableAt?: string;
  }): DispatchOutboxEvent {
    const now = new Date().toISOString();
    const aggregateRevision = input.aggregateRevision ?? payloadRevision(input.payload) ?? 0;
    const existing = getByLogical(input.eventType, input.aggregateId, aggregateRevision);
    if (existing) return existing;

    const id = `out_${randomUUID()}`;

    database.db
      .insert(dispatchOutbox)
      .values({
        id,
        eventType: input.eventType,
        aggregateId: input.aggregateId,
        aggregateRevision,
        payloadJson: JSON.stringify(input.payload ?? {}),
        status: "pending",
        attemptCount: 0,
        availableAt: input.availableAt ?? now,
        createdAt: now,
      })
      .run();

    return {
      id,
      eventType: input.eventType,
      aggregateId: input.aggregateId,
      aggregateRevision,
      payload: input.payload ?? {},
      status: "pending",
      attemptCount: 0,
      availableAt: input.availableAt ?? now,
      createdAt: now,
    };
  }

  function claimNext(workerId: string, leaseMs: number): DispatchOutboxEvent | null {
    const now = new Date().toISOString();
    const claimExpiresAt = new Date(Date.now() + leaseMs).toISOString();

    const candidate = database.db
      .select()
      .from(dispatchOutbox)
      .where(and(eq(dispatchOutbox.status, "pending"), lte(dispatchOutbox.availableAt, now)))
      .orderBy(asc(dispatchOutbox.availableAt))
      .limit(1)
      .get();

    if (!candidate) return null;

    const updated = database.db
      .update(dispatchOutbox)
      .set({
        status: "claimed",
        claimedBy: workerId,
        claimExpiresAt,
        attemptCount: candidate.attemptCount + 1,
      })
      .where(and(eq(dispatchOutbox.id, candidate.id), eq(dispatchOutbox.status, "pending")))
      .run();

    if (updated.changes === 0) return null;

    return rowToEvent(database.db.select().from(dispatchOutbox).where(eq(dispatchOutbox.id, candidate.id)).get()!);
  }

  function reapExpiredClaims(leaseMs: number): number {
    const cutoff = new Date().toISOString();
    const rows = database.db
      .select()
      .from(dispatchOutbox)
      .where(and(eq(dispatchOutbox.status, "claimed"), lt(dispatchOutbox.claimExpiresAt, cutoff)))
      .all();

    for (const row of rows) {
      database.db
        .update(dispatchOutbox)
        .set({ status: "pending", claimedBy: null, claimExpiresAt: null })
        .where(eq(dispatchOutbox.id, row.id))
        .run();
    }
    return rows.length;
  }

  function release(id: string, retryDelayMs = 0, note?: string): void {
    const availableAt = new Date(Date.now() + retryDelayMs).toISOString();
    database.db
      .update(dispatchOutbox)
      .set({
        status: "pending",
        claimedBy: null,
        claimExpiresAt: null,
        availableAt,
        lastError: note ?? null,
      })
      .where(and(eq(dispatchOutbox.id, id), eq(dispatchOutbox.status, "claimed")))
      .run();
  }

  function markCompleted(id: string): void {
    database.db
      .update(dispatchOutbox)
      .set({ status: "completed", completedAt: new Date().toISOString() })
      .where(eq(dispatchOutbox.id, id))
      .run();
  }

  function markFailed(id: string, error: string, retryDelayMs: number): void {
    const row = database.db.select().from(dispatchOutbox).where(eq(dispatchOutbox.id, id)).get();
    if (!row) return;

    const attempts = row.attemptCount;
    if (attempts >= 3) {
      database.db
        .update(dispatchOutbox)
        .set({ status: "dead_lettered", lastError: error })
        .where(eq(dispatchOutbox.id, id))
        .run();
    } else {
      const availableAt = new Date(Date.now() + retryDelayMs * Math.pow(2, attempts)).toISOString();
      database.db
        .update(dispatchOutbox)
        .set({
          status: "pending",
          claimedBy: null,
          claimExpiresAt: null,
          lastError: error,
          availableAt,
        })
        .where(eq(dispatchOutbox.id, id))
        .run();
    }
  }

  function listPending(limit = 50): DispatchOutboxEvent[] {
    return database.db
      .select()
      .from(dispatchOutbox)
      .where(eq(dispatchOutbox.status, "pending"))
      .orderBy(asc(dispatchOutbox.availableAt))
      .limit(limit)
      .all()
      .map(rowToEvent);
  }

  function hasActive(eventType: string, aggregateId: string): boolean {
    const row = database.db
      .select({ id: dispatchOutbox.id })
      .from(dispatchOutbox)
      .where(and(
        eq(dispatchOutbox.eventType, eventType),
        eq(dispatchOutbox.aggregateId, aggregateId),
        or(eq(dispatchOutbox.status, "pending"), eq(dispatchOutbox.status, "claimed")),
      ))
      .limit(1)
      .get();
    return Boolean(row);
  }

  function hasLogical(eventType: string, aggregateId: string, aggregateRevision = 0): boolean {
    return Boolean(getByLogical(eventType, aggregateId, aggregateRevision));
  }

  function redriveDeadLetter(eventType: string, aggregateId: string, aggregateRevision = 0): DispatchOutboxEvent | null {
    const existing = getByLogical(eventType, aggregateId, aggregateRevision);
    if (!existing || existing.status !== "dead_lettered") return null;
    const now = new Date().toISOString();
    database.db
      .update(dispatchOutbox)
      .set({
        status: "pending",
        attemptCount: 0,
        availableAt: now,
        claimedBy: null,
        claimExpiresAt: null,
        lastError: null,
        completedAt: null,
      })
      .where(eq(dispatchOutbox.id, existing.id))
      .run();
    const row = database.db.select().from(dispatchOutbox).where(eq(dispatchOutbox.id, existing.id)).get();
    return row ? rowToEvent(row) : null;
  }

  function getByLogical(eventType: string, aggregateId: string, aggregateRevision: number): DispatchOutboxEvent | null {
    const row = database.db
      .select()
      .from(dispatchOutbox)
      .where(and(
        eq(dispatchOutbox.eventType, eventType),
        eq(dispatchOutbox.aggregateId, aggregateId),
        eq(dispatchOutbox.aggregateRevision, aggregateRevision),
      ))
      .limit(1)
      .get();
    return row ? rowToEvent(row) : null;
  }

  function close(): void {
    database.close();
  }

  return {
    enqueue,
    claimNext,
    reapExpiredClaims,
    release,
    markCompleted,
    markFailed,
    listPending,
    hasActive,
    hasLogical,
    redriveDeadLetter,
    close,
  };
}

function payloadRevision(payload: Record<string, unknown> | undefined): number | undefined {
  const revision = payload?.revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision >= 0
    ? revision
    : undefined;
}

function rowToEvent(row: DispatchOutboxRow): DispatchOutboxEvent {
  return {
    id: row.id,
    eventType: row.eventType,
    aggregateId: row.aggregateId,
    aggregateRevision: row.aggregateRevision ?? 0,
    payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
    status: row.status as OutboxStatus,
    attemptCount: row.attemptCount ?? 0,
    availableAt: row.availableAt,
    claimedBy: row.claimedBy ?? undefined,
    claimExpiresAt: row.claimExpiresAt ?? undefined,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? undefined,
  };
}
