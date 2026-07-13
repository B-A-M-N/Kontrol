import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

/**
 * EventStore — append-only event log for the Ralphie Muntz Loop.
 *
 * Canonical source of truth for review lifecycle events. State projections
 * (work_sessions, work_session_feedback) are derived from this log.
 *
 * Subscribers react to events; they do not own the loop. The waiter pattern
 * (waitForEvent) is one subscriber among many — useful for live unblocking,
 * but not required for correctness. Events persist regardless of whether
 * anyone is listening.
 */

export interface EventStoreEvent {
  id: string;
  seq: number;
  type: string;
  sessionId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type EventPredicate = (event: EventStoreEvent) => boolean;

export interface EventStore {
  appendEvent(input: {
    type: string;
    sessionId: string;
    payload: Record<string, unknown>;
  }, opts?: { publish?: boolean }): EventStoreEvent;

  publishEvents(events: EventStoreEvent[]): void;

  getEventsForSession(sessionId: string): EventStoreEvent[];

  /**
   * Durable events strictly after a given seq. Used by the blocking
   * await_work_session_events tool to fetch what was missed since the last poll
   * without re-fetching already-seen events.
   */
  getEventsAfter(sessionId: string, afterSeq: number, limit?: number): EventStoreEvent[];

  /**
   * Block until one or more events arrive after `afterSeq`. Resolves with the
   * durable events. Ordering: subscribe FIRST, then query durable events after
   * afterSeq; if events already exist they are returned immediately (no race
   * window); otherwise the call remains subscribed and resolves when the next
   * matching event arrives or the connection-liveness timeout elapses.
   */
  waitForEventsAfter(
    sessionId: string,
    afterSeq: number,
    timeoutMs: number,
  ): Promise<EventStoreEvent[]>;

  getLatestEvent(sessionId: string, type?: string): EventStoreEvent | undefined;

  subscribe(sessionId: string, callback: (event: EventStoreEvent) => void): () => void;

  /** Subscribe to events from ALL sessions (used by the singleton dispatcher). */
  subscribeAll(callback: (event: EventStoreEvent) => void): () => void;

  waitForEvent(
    sessionId: string,
    type?: string,
    predicateOrTimeout?: unknown,
    maybeTimeoutMs?: number,
  ): Promise<EventStoreEvent | null>;

  /**
   * Sequence-anchored durable waiter. Subscribe FIRST, then query durable
   * events after afterSeq; return immediately if a matching event exists,
   * otherwise remain subscribed until one arrives or timeout.
   */
  waitForMatchingEventAfter(
    sessionId: string,
    afterSeq: number,
    predicate: EventPredicate,
    timeoutMs: number,
  ): Promise<EventStoreEvent | null>;

  close(): void;
}

type Subscriber = (event: EventStoreEvent) => void;

export function createEventStore(
  stateDirOrHandle: string | DatabaseHandle,
): EventStore {
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;
  const subscribers = new Map<string, Set<Subscriber>>();
  const globalSubscribers = new Set<Subscriber>();

  function appendEvent(input: {
    type: string;
    sessionId: string;
    payload: Record<string, unknown>;
  }, opts: { publish?: boolean } = {}): EventStoreEvent {
    const now = new Date().toISOString();
    const id = randomUUID();

    database.sqlite
      .prepare(
        `insert into event_log (id, type, session_id, payload, created_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run(id, input.type, input.sessionId, JSON.stringify(input.payload), now);

    const seq = (database.sqlite.prepare("select last_insert_rowid() as seq").get() as { seq: number }).seq;

    const event: EventStoreEvent = {
      id,
      seq,
      type: input.type,
      sessionId: input.sessionId,
      payload: input.payload,
      createdAt: now,
    };

    if (opts.publish !== false) publish(event);
    return event;
  }

  function getEventsForSession(sessionId: string): EventStoreEvent[] {
    const rows = database.sqlite
      .prepare(
        `select id, seq, type, session_id, payload, created_at
         from event_log
         where session_id = ?
         order by seq`,
      )
      .all(sessionId) as Array<{
      id: string;
      seq: number;
      type: string;
      session_id: string;
      payload: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      type: row.type,
      sessionId: row.session_id,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  function getEventsAfter(sessionId: string, afterSeq: number, limit = 500): EventStoreEvent[] {
    const rows = database.sqlite
      .prepare(
        `select id, seq, type, session_id, payload, created_at
         from event_log
         where session_id = ? and seq > ?
         order by seq
         limit ?`,
      )
      .all(sessionId, afterSeq, limit) as Array<{
      id: string;
      seq: number;
      type: string;
      session_id: string;
      payload: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      type: row.type,
      sessionId: row.session_id,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  function waitForEventsAfter(
    sessionId: string,
    afterSeq: number,
    timeoutMs: number,
  ): Promise<EventStoreEvent[]> {
    return new Promise((resolve) => {
      let resolved = false;

      let timeout: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;

      const finish = (events: EventStoreEvent[]) => {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        if (unsubscribe) unsubscribe();
        resolve(events);
      };

      // Subscribe FIRST so a concurrently-published event cannot be lost between
      // the query below and the subscription.
      unsubscribe = subscribe(sessionId, (event) => {
        if (resolved) return;
        if (event.seq > afterSeq) finish(getEventsAfter(sessionId, afterSeq));
      });

      // Query durable events after afterSeq. Return immediately if present.
      const existing = getEventsAfter(sessionId, afterSeq);
      if (existing.length > 0) {
        finish(existing);
        return;
      }

      timeout = setTimeout(() => finish([]), timeoutMs);
    });
  }

  function waitForMatchingEventAfter(
    sessionId: string,
    afterSeq: number,
    predicate: EventPredicate,
    timeoutMs: number,
  ): Promise<EventStoreEvent | null> {
    return new Promise((resolve) => {
      let resolved = false;

      let timeout: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;

      const finish = (event: EventStoreEvent | null) => {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        if (unsubscribe) unsubscribe();
        resolve(event);
      };

      // Subscribe first so a concurrently-published event cannot be lost
      // between the query below and the subscription.
      unsubscribe = subscribe(sessionId, (event) => {
        if (resolved) return;
        if (event.seq > afterSeq && predicate(event)) {
          finish(event);
        }
      });

      // Re-query durable events after the subscription: something may have
      // been published between the subscribe and the original check.
      const events = getEventsAfter(sessionId, afterSeq);
      for (const event of events) {
        if (predicate(event)) {
          finish(event);
          return;
        }
      }

      timeout = setTimeout(() => finish(null), timeoutMs);
    });
  }

  function getLatestEvent(sessionId: string, type?: string): EventStoreEvent | undefined {
    const whereClause = type ? "where session_id = ? and type = ?" : "where session_id = ?";
    const params = type ? [sessionId, type] : [sessionId];

    const row = database.sqlite
      .prepare(
        `select id, seq, type, session_id, payload, created_at
         from event_log
         ${whereClause}
         order by seq desc
         limit 1`,
      )
      .get(...params) as
      | {
          id: string;
          seq: number;
          type: string;
          session_id: string;
          payload: string;
          created_at: string;
        }
      | undefined;

    if (!row) return undefined;
    return {
      id: row.id,
      seq: row.seq,
      type: row.type,
      sessionId: row.session_id,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at,
    };
  }

  function subscribe(sessionId: string, callback: Subscriber): () => void {
    if (!subscribers.has(sessionId)) {
      subscribers.set(sessionId, new Set());
    }
    subscribers.get(sessionId)!.add(callback);

    return () => {
      const set = subscribers.get(sessionId);
      if (!set) return;
      set.delete(callback);
      if (set.size === 0) subscribers.delete(sessionId);
    };
  }

  function publish(event: EventStoreEvent): void {
    const set = subscribers.get(event.sessionId);
    if (set && set.size > 0) {
      for (const callback of set) callback(event);
    }
    for (const callback of globalSubscribers) {
      callback(event);
    }
  }

  function waitForEvent(
    sessionId: string,
    type?: string,
    predicateOrTimeout?: unknown,
    maybeTimeoutMs?: number,
  ): Promise<EventStoreEvent | null> {
    const typeFilter = type;
    let predicateFilter: EventPredicate | undefined;
    let waitTimeoutMs = 300_000;

    if (typeof predicateOrTimeout === "function") {
      predicateFilter = predicateOrTimeout as EventPredicate;
      if (typeof maybeTimeoutMs === "number") {
        waitTimeoutMs = maybeTimeoutMs;
      }
    } else if (typeof predicateOrTimeout === "number") {
      waitTimeoutMs = predicateOrTimeout;
    }

    return new Promise((resolve) => {
      let resolved = false;

      let timeout: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;

      const finish = (event: EventStoreEvent | null) => {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        if (unsubscribe) unsubscribe();
        resolve(event);
      };

      unsubscribe = subscribe(sessionId, (event) => {
        if (resolved) return;
        if (typeFilter && event.type !== typeFilter) return;
        if (predicateFilter && !predicateFilter(event)) return;
        finish(event);
      });

      timeout = setTimeout(() => finish(null), waitTimeoutMs);
    });
  }

  function subscribeAll(callback: Subscriber): () => void {
    globalSubscribers.add(callback);
    return () => {
      globalSubscribers.delete(callback);
    };
  }

  function close(): void {
    subscribers.clear();
    globalSubscribers.clear();
    database.close();
  }

  return {
    appendEvent,
    publishEvents: (events) => {
      for (const event of events) publish(event);
    },
    getEventsForSession,
    getEventsAfter,
    waitForEventsAfter,
    getLatestEvent,
    subscribe,
    subscribeAll,
    waitForEvent,
    waitForMatchingEventAfter,
    close,
  };
}
