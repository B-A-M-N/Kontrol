import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lt, lte, notInArray, or } from "drizzle-orm";
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
  /** Fencing token minted by the successful claim CAS. Present only while the
   * event is owned by an active claim; required for release/complete/fail. */
  claimToken?: string;
  /** Claim odometer (observability). Bumped on every claim. */
  attemptCount: number;
  /** Genuine dispatch failures. Drives backoff + dead-lettering. */
  failureCount: number;
  availableAt: string;
  claimedBy?: string;
  claimExpiresAt?: string;
  lastError?: string;
  createdAt: string;
  completedAt?: string;
}

/** Fencing identity for a claimed outbox event. */
export interface OutboxClaim {
  eventId: string;
  claimOwner: string;
  claimToken: string;
}

export interface DispatchOutbox {
  enqueue(input: {
    eventType: string;
    aggregateId: string;
    aggregateRevision?: number;
    payload?: Record<string, unknown>;
    availableAt?: string;
  }): DispatchOutboxEvent;

  /** Wake in-process consumers after a durable event is committed. Consumers
   * must still reconcile the database on startup; notifications are hints. */
  subscribe(listener: (event: DispatchOutboxEvent) => void, eventTypes?: string[]): () => void;

  /** Atomically claim the next available event for this worker. CAS on status. */
  claimNext(workerId: string, leaseMs: number, eventTypes?: string[], excludeAggregateIds?: string[]): DispatchOutboxEvent | null;

  /** Reap expired claims back to pending. Returns count requeued. */
  reapExpiredClaims(leaseMs: number): number;

  /**
   * F01 fencing: every claimed-event transition must present the exact
   * `claimToken` minted by the claiming claimNext(). The CAS also requires the
   * row to still be `claimed`, owned by `claimOwner`, and unexpired, so a
   * stale claimant whose lease lapsed and whose event was re-claimed by a
   * different worker cannot release, complete, or dead-letter foreign work.
   * Each returns true only when exactly one row was transitioned.
   */
  release(claim: OutboxClaim, retryDelayMs?: number, note?: string): boolean;

  markCompleted(claim: OutboxClaim): boolean;

  markFailed(claim: OutboxClaim, error: string, retryDelayMs: number): boolean;

  get(id: string): DispatchOutboxEvent | undefined;
  listByAggregate(aggregateId: string): DispatchOutboxEvent[];

  listPending(limit?: number, eventTypes?: string[]): DispatchOutboxEvent[];

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
  const listeners = new Set<{ listener: (event: DispatchOutboxEvent) => void; eventTypes?: Set<string> }>();

  function notify(event: DispatchOutboxEvent): void {
    for (const entry of listeners) {
      if (entry.eventTypes && !entry.eventTypes.has(event.eventType)) continue;
      try { entry.listener(event); } catch { /* durable enqueue must not depend on an observer */ }
    }
  }

  function subscribe(listener: (event: DispatchOutboxEvent) => void, eventTypes?: string[]): () => void {
    const entry = { listener, eventTypes: eventTypes ? new Set(eventTypes) : undefined };
    listeners.add(entry);
    return () => { listeners.delete(entry); };
  }

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

    const event: DispatchOutboxEvent = {
      id,
      eventType: input.eventType,
      aggregateId: input.aggregateId,
      aggregateRevision,
      payload: input.payload ?? {},
      status: "pending",
      attemptCount: 0,
      failureCount: 0,
      availableAt: input.availableAt ?? now,
      createdAt: now,
    };
    queueMicrotask(() => notify(event));
    return event;
  }

  function claimNext(workerId: string, leaseMs: number, eventTypes?: string[], excludeAggregateIds?: string[]): DispatchOutboxEvent | null {
    const now = new Date().toISOString();
    const claimExpiresAt = new Date(Date.now() + leaseMs).toISOString();

    const candidate = database.db
      .select()
      .from(dispatchOutbox)
      .where(and(
        eq(dispatchOutbox.status, "pending"),
        lte(dispatchOutbox.availableAt, now),
        ...(eventTypes?.length ? [inArray(dispatchOutbox.eventType, eventTypes)] : []),
        ...(excludeAggregateIds?.length ? [notInArray(dispatchOutbox.aggregateId, excludeAggregateIds)] : []),
      ))
      .orderBy(asc(dispatchOutbox.availableAt))
      .limit(1)
      .get();

    if (!candidate) return null;

    // Mint a fresh fencing token as part of the claim CAS. The token is the
    // authority for every subsequent transition; reaping clears it so a
    // reclaimed event always carries a token the old holder does not know.
    const claimToken = `clm_${randomUUID()}`;
    const updated = database.db
      .update(dispatchOutbox)
      .set({
        status: "claimed",
        claimedBy: workerId,
        claimExpiresAt,
        claimToken,
        attemptCount: candidate.attemptCount + 1,
      })
      .where(and(eq(dispatchOutbox.id, candidate.id), eq(dispatchOutbox.status, "pending")))
      .run();

    if (updated.changes === 0) return null;

    return rowToEvent(database.db.select().from(dispatchOutbox).where(eq(dispatchOutbox.id, candidate.id)).get()!);
  }

  function reapExpiredClaims(leaseMs: number): number {
    // The CAS uses the still-expired lease observed at selection time. A row
    // reset by another reaper and then freshly claimed has a new owner,
    // token, and lease, so this update intentionally matches zero rows.
    const cutoff = new Date(Date.now() - leaseMs).toISOString();
    const rows = database.db
      .select({
        id: dispatchOutbox.id,
        claimedBy: dispatchOutbox.claimedBy,
        claimToken: dispatchOutbox.claimToken,
        claimExpiresAt: dispatchOutbox.claimExpiresAt,
      })
      .from(dispatchOutbox)
      .where(and(eq(dispatchOutbox.status, "claimed"), lt(dispatchOutbox.claimExpiresAt, cutoff)))
      .all();

    let reaped = 0;
    for (const row of rows) {
      // Clearing the token invalidates the expired holder's fencing identity:
      // it can no longer release/complete/fail the row even if it wakes up.
      const result = database.db
        .update(dispatchOutbox)
        .set({ status: "pending", claimedBy: null, claimExpiresAt: null, claimToken: null })
        .where(and(
          eq(dispatchOutbox.id, row.id),
          eq(dispatchOutbox.status, "claimed"),
          ...(row.claimedBy === null ? [isNull(dispatchOutbox.claimedBy)] : [eq(dispatchOutbox.claimedBy, row.claimedBy)]),
          ...(row.claimToken === null ? [isNull(dispatchOutbox.claimToken)] : [eq(dispatchOutbox.claimToken, row.claimToken)]),
          ...(row.claimExpiresAt === null ? [isNull(dispatchOutbox.claimExpiresAt)] : [eq(dispatchOutbox.claimExpiresAt, row.claimExpiresAt)]),
          lt(dispatchOutbox.claimExpiresAt, cutoff),
        ))
        .run();
      reaped += result.changes;
    }
    return reaped;
  }

  function get(id: string): DispatchOutboxEvent | undefined {
    const value = database.db.select().from(dispatchOutbox).where(eq(dispatchOutbox.id, id)).get();
    return value ? rowToEvent(value) : undefined;
  }

  function listByAggregate(aggregateId: string): DispatchOutboxEvent[] {
    return database.db.select().from(dispatchOutbox).where(eq(dispatchOutbox.aggregateId, aggregateId)).orderBy(asc(dispatchOutbox.createdAt)).all().map(rowToEvent);
  }

  /**
   * Fenced ownership predicate. Requires the live claim identity: the row must
   * still be `claimed`, owned by the presenting `claimOwner`, carry the exact
   * `claimToken`, and have an unexpired lease. A claimant whose lease lapsed
   * and whose event was reaped (token cleared) or re-claimed (token rotated)
   * matches zero rows and therefore cannot mutate the event.
   */
  function fencedClaimWhere(claim: OutboxClaim) {
    return and(
      eq(dispatchOutbox.id, claim.eventId),
      eq(dispatchOutbox.status, "claimed"),
      eq(dispatchOutbox.claimedBy, claim.claimOwner),
      eq(dispatchOutbox.claimToken, claim.claimToken),
      or(isNull(dispatchOutbox.claimExpiresAt), gt(dispatchOutbox.claimExpiresAt, new Date().toISOString())),
    );
  }

  function release(claim: OutboxClaim, retryDelayMs = 0, note?: string): boolean {
    const availableAt = new Date(Date.now() + retryDelayMs).toISOString();
    const result = database.db
      .update(dispatchOutbox)
      .set({
        status: "pending",
        claimedBy: null,
        claimExpiresAt: null,
        claimToken: null,
        availableAt,
        lastError: note ?? null,
      })
      .where(fencedClaimWhere(claim))
      .run();
    return result.changes === 1;
  }

  function markCompleted(claim: OutboxClaim): boolean {
    const result = database.db
      .update(dispatchOutbox)
      .set({ status: "completed", completedAt: new Date().toISOString(), claimToken: null, claimedBy: null, claimExpiresAt: null })
      .where(fencedClaimWhere(claim))
      .run();
    return result.changes === 1;
  }

  function markFailed(claim: OutboxClaim, error: string, retryDelayMs: number): boolean {
    // Read the failure budget only under the fence so a stale holder cannot
    // inflate (or consume) another owner's retry budget.
    const row = database.db.select().from(dispatchOutbox).where(fencedClaimWhere(claim)).get();
    if (!row) return false;

    // Count THIS failure. Dead-lettering and backoff are keyed off genuine
    // failures, not claims — a claim reaped after a dispatcher crash must not
    // consume the failure budget (that was the pre-v21 bug).
    const failures = (row.failureCount ?? 0) + 1;
    if (failures >= 3) {
      const result = database.db
        .update(dispatchOutbox)
        .set({ status: "dead_lettered", failureCount: failures, lastError: error, claimToken: null, claimedBy: null, claimExpiresAt: null })
        .where(fencedClaimWhere(claim))
        .run();
      return result.changes === 1;
    }
    // Backoff exponent is (failures - 1): first retry waits retryDelayMs,
    // second waits 2×, matching the intended geometric schedule.
    const availableAt = new Date(
      Date.now() + retryDelayMs * Math.pow(2, failures - 1),
    ).toISOString();
    const result = database.db
      .update(dispatchOutbox)
      .set({
        status: "pending",
        claimedBy: null,
        claimExpiresAt: null,
        claimToken: null,
        failureCount: failures,
        lastError: error,
        availableAt,
      })
      .where(fencedClaimWhere(claim))
      .run();
    return result.changes === 1;
  }

  function listPending(limit = 50, eventTypes?: string[]): DispatchOutboxEvent[] {
    return database.db
      .select()
      .from(dispatchOutbox)
      .where(and(eq(dispatchOutbox.status, "pending"), ...(eventTypes?.length ? [inArray(dispatchOutbox.eventType, eventTypes)] : [])))
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
    const result = database.sqlite.transaction(() => {
      const update = database.sqlite.prepare(
        `update dispatch_outbox
            set status = 'pending', attempt_count = 0, failure_count = 0,
                available_at = ?, claimed_by = null, claim_expires_at = null,
                claim_token = null, last_error = null, completed_at = null
          where id = ? and status = 'dead_lettered'
            and failure_count = ? and attempt_count = ?`,
      ).run(now, existing.id, existing.failureCount, existing.attemptCount);
      // Re-read inside the same transaction so the caller can never observe
      // a row changed between CAS and projection.
      const row = update.changes === 1
        ? database.db.select().from(dispatchOutbox).where(eq(dispatchOutbox.id, existing.id)).get()
        : undefined;
      return { update, row };
    })();
    if (result.update.changes !== 1) return null;
    const event = result.row ? rowToEvent(result.row) : null;
    if (event) queueMicrotask(() => notify(event));
    return event;
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

  // P1 #11: DB owned by server
  function close(): void { }

  return {
    enqueue,
    subscribe,
    claimNext,
    reapExpiredClaims,
    release,
    markCompleted,
    markFailed,
    get,
    listByAggregate,
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
    failureCount: row.failureCount ?? 0,
    availableAt: row.availableAt,
    claimedBy: row.claimedBy ?? undefined,
    claimExpiresAt: row.claimExpiresAt ?? undefined,
    claimToken: row.claimToken ?? undefined,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? undefined,
  };
}
