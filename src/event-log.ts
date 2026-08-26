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
  /** True for a committed event; false marks a non-durable telemetry receipt. */
  durable: boolean;
  /** Present only on the synchronous receipt returned for buffered telemetry. */
  receipt?: boolean;
  type: string;
  sessionId: string;
  workspaceSessionId?: string;
  workspaceProjectId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface TelemetryBuffer {
  sessionId: string;
  type: string;
  items: Array<Record<string, unknown>>;
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
  publish: boolean;
}

export type EventPredicate = (event: EventStoreEvent) => boolean;

export type EventStoreTimingCallback = (phase: string, durationMs: number) => void;

export interface EventStore {
 appendEvent(input: {
   type: string;
   sessionId: string;
   workspaceSessionId?: string;
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

 /** Return a single workspace/project event stream using the global event seq cursor. */
 getWorkspaceEventsAfter(workspaceId: string, afterSeq: number, limit?: number): EventStoreEvent[];

 /**
  * P1 #9: Count events by type for a session, grouped by event type.
  * Used by diagnostics to show how much of the event log is telemetry vs workflow.
  */
 countEventsByType(sessionId: string): Record<string, number>;

 /**
  * P1 #9 / P2: Compact the event log for a completed session by replacing
  * high-volume telemetry events (output_delta, thought_delta) with a single
  * coalesced checkpoint. This preserves the audit trail (tool lifecycle,
  * review events, state changes) while dramatically reducing row count.
  * Returns the number of rows removed.
  */
 compactSessionEvents(sessionId: string, opts?: { retentionDays?: number }): number;

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

 /** Event-driven workspace/project waiter; one waiter can multiplex many sessions. */
 waitForWorkspaceEventsAfter(
   workspaceId: string,
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
    signal?: AbortSignal,
  ): Promise<EventStoreEvent | null>;

  close(): void;
}

type Subscriber = (event: EventStoreEvent) => void;

export function createEventStore(
  stateDirOrHandle: string | DatabaseHandle,
  onTiming?: EventStoreTimingCallback,
): EventStore {
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;
  const subscribers = new Map<string, Set<Subscriber>>();
  const globalSubscribers = new Set<Subscriber>();
  const workspaceSubscribers = new Map<string, Set<Subscriber>>();
  const telemetryBuffers = new Map<string, TelemetryBuffer>();
  const TELEMETRY_FLUSH_INTERVAL_MS = 250;
  const TELEMETRY_MAX_BYTES = 16 * 1024;
  const MAX_TRACKED_AGENT_SESSIONS = 2048;
  const lastAgentEventAt = new Map<string, number>();

  function recordTiming(phase: string, startedAt: number): void {
    try {
      onTiming?.(phase, performance.now() - startedAt);
    } catch {
      // Diagnostics must never make the event ledger unavailable.
    }
  }

  function isHighVolumeTelemetry(type: string): boolean {
    return type === "agent.run.output_delta" || type === "agent.run.thought_delta";
  }

  function resolveWorkspaceCorrelation(
    sessionId: string,
    explicitWorkspaceSessionId?: string,
  ): { workspaceSessionId?: string; projectId?: string } {
    if (explicitWorkspaceSessionId) {
      const row = database.sqlite.prepare("select id, project_id from workspace_sessions where id = ?").get(explicitWorkspaceSessionId) as { id: string; project_id?: string | null } | undefined;
      return row ? { workspaceSessionId: row.id, projectId: row.project_id ?? undefined } : { workspaceSessionId: explicitWorkspaceSessionId };
    }
    const workSession = database.sqlite.prepare("select ws.workspace_session_id, wss.project_id from work_sessions ws left join workspace_sessions wss on wss.id = ws.workspace_session_id where ws.id = ?").get(sessionId) as { workspace_session_id?: string; project_id?: string | null } | undefined;
    if (workSession?.workspace_session_id) return { workspaceSessionId: workSession.workspace_session_id, projectId: workSession.project_id ?? undefined };
    const workspace = database.sqlite.prepare("select id, project_id from workspace_sessions where id = ?").get(sessionId) as { id: string; project_id?: string | null } | undefined;
    return workspace ? { workspaceSessionId: workspace.id, projectId: workspace.project_id ?? undefined } : {};
  }

  function projectIdForWorkspaceSession(workspaceSessionId?: string): string | undefined {
    if (!workspaceSessionId) return undefined;
    const row = database.sqlite.prepare("select project_id from workspace_sessions where id = ?").get(workspaceSessionId) as { project_id?: string | null } | undefined;
    return row?.project_id ?? undefined;
  }

  function insertEvent(input: {
    type: string;
    sessionId: string;
    workspaceSessionId?: string;
    payload: Record<string, unknown>;
    publish: boolean;
  }): EventStoreEvent {
    const startedAt = performance.now();
    const now = new Date().toISOString();
    const id = randomUUID();
    const correlation = resolveWorkspaceCorrelation(input.sessionId, input.workspaceSessionId);

    database.sqlite
      .prepare(
        `insert into event_log (id, type, session_id, workspace_session_id, payload, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.type, input.sessionId, correlation.workspaceSessionId ?? null, JSON.stringify(input.payload), now);

    const seq = (database.sqlite.prepare("select last_insert_rowid() as seq").get() as { seq: number }).seq;
    const event: EventStoreEvent = {
      id,
      seq,
      durable: true,
      type: input.type,
      sessionId: input.sessionId,
      workspaceSessionId: correlation.workspaceSessionId,
      workspaceProjectId: correlation.projectId,
      payload: input.payload,
      createdAt: now,
    };
    recordTiming("sqlite.commit", startedAt);
    if (input.type.startsWith("agent.") || input.type.startsWith("worker.")) {
      const eventNow = performance.now();
      const previous = lastAgentEventAt.get(input.sessionId);
      recordTiming(previous === undefined ? "agent.time_to_first_event" : "agent.event_interval", previous === undefined ? startedAt : previous);
      if (previous === undefined && lastAgentEventAt.size >= MAX_TRACKED_AGENT_SESSIONS) {
        const oldest = lastAgentEventAt.keys().next().value as string | undefined;
        if (oldest) lastAgentEventAt.delete(oldest);
      }
      lastAgentEventAt.set(input.sessionId, eventNow);
    }
    if (input.publish) publish(event);
    return event;
  }

  function flushTelemetry(key: string): void {
    const buffer = telemetryBuffers.get(key);
    if (!buffer || buffer.items.length === 0) return;
    telemetryBuffers.delete(key);
    if (buffer.timer) clearTimeout(buffer.timer);

    const text = buffer.items
      .map((item) => typeof item.text === "string" ? item.text : "")
      .join("");
    const channels = [...new Set(buffer.items
      .map((item) => typeof item.channel === "string" ? item.channel : undefined)
      .filter((channel): channel is string => Boolean(channel)))];
    insertEvent({
      type: buffer.type,
      sessionId: buffer.sessionId,
      publish: buffer.publish,
      payload: {
        text,
        channel: channels[0] ?? (buffer.type === "agent.run.thought_delta" ? "thought" : "message"),
        channels,
        coalesced: true,
        count: buffer.items.length,
      },
    });
  }

  function flushTelemetryForSession(sessionId: string): void {
    for (const [key, buffer] of telemetryBuffers) {
      if (buffer.sessionId === sessionId) flushTelemetry(key);
    }
  }

  function queueTelemetry(input: {
    type: string;
    sessionId: string;
    payload: Record<string, unknown>;
    publish: boolean;
  }): EventStoreEvent {
    const key = `${input.sessionId}\0${input.type}`;
    let buffer = telemetryBuffers.get(key);
    if (!buffer) {
      buffer = {
        sessionId: input.sessionId,
        type: input.type,
        items: [],
        bytes: 0,
        publish: input.publish,
      };
      telemetryBuffers.set(key, buffer);
    }
    buffer.items.push(input.payload);
    buffer.bytes += Buffer.byteLength(JSON.stringify(input.payload), "utf8");
    buffer.publish ||= input.publish;
    if (buffer.bytes >= TELEMETRY_MAX_BYTES) {
      flushTelemetry(key);
    } else if (!buffer.timer) {
      buffer.timer = setTimeout(() => flushTelemetry(key), TELEMETRY_FLUSH_INTERVAL_MS);
      buffer.timer.unref?.();
    }

    // Callers receive an explicit non-durable receipt while the fragment is
    // buffered. It is never published or exposed by durable cursor readers.
    return {
      id: randomUUID(),
      seq: 0,
      durable: false,
      receipt: true,
      type: input.type,
      sessionId: input.sessionId,
      payload: input.payload,
      createdAt: new Date().toISOString(),
    };
  }

  function appendEvent(input: {
    type: string;
    sessionId: string;
    payload: Record<string, unknown>;
  }, opts: { publish?: boolean } = {}): EventStoreEvent {
    if (isHighVolumeTelemetry(input.type)) {
      return queueTelemetry({
        ...input,
        publish: opts.publish !== false,
      });
    }
    // Keep durable sequence order meaningful: a workflow event that follows a
    // fragment must never overtake the buffered transcript preceding it.
    flushTelemetryForSession(input.sessionId);
    return insertEvent({
      ...input,
      publish: opts.publish !== false,
    });
  }

  function getEventsForSession(sessionId: string): EventStoreEvent[] {
    const rows = database.sqlite
      .prepare(
        `select id, seq, type, session_id, workspace_session_id, payload, created_at
         from event_log
         where session_id = ?
         order by seq`,
      )
      .all(sessionId) as Array<{
      id: string;
      seq: number;
      type: string;
      session_id: string;
      workspace_session_id?: string | null;
      payload: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      durable: true,
      type: row.type,
      sessionId: row.session_id,
      workspaceSessionId: row.workspace_session_id ?? undefined,
      workspaceProjectId: projectIdForWorkspaceSession(row.workspace_session_id ?? undefined),
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  function getEventsAfter(sessionId: string, afterSeq: number, limit = 500): EventStoreEvent[] {
    const rows = database.sqlite
      .prepare(
        `select id, seq, type, session_id, workspace_session_id, payload, created_at
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
      workspace_session_id?: string | null;
      payload: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      durable: true,
      type: row.type,
      sessionId: row.session_id,
      workspaceSessionId: row.workspace_session_id ?? undefined,
      workspaceProjectId: projectIdForWorkspaceSession(row.workspace_session_id ?? undefined),
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  function getWorkspaceEventsAfter(workspaceId: string, afterSeq: number, limit = 500): EventStoreEvent[] {
    const rows = database.sqlite
      .prepare(
        `select el.id, el.seq, el.type, el.session_id, el.workspace_session_id, el.payload, el.created_at
         from event_log el
         where (
           el.workspace_session_id = ?
           or el.workspace_session_id in (select id from workspace_sessions where project_id = ?)
         ) and el.seq > ?
         order by el.seq
         limit ?`,
      )
      .all(workspaceId, workspaceId, afterSeq, limit) as Array<{
      id: string;
      seq: number;
      type: string;
      session_id: string;
      workspace_session_id?: string | null;
      payload: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      durable: true,
      type: row.type,
      sessionId: row.session_id,
      workspaceSessionId: row.workspace_session_id ?? undefined,
      workspaceProjectId: projectIdForWorkspaceSession(row.workspace_session_id ?? undefined),
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

  function waitForWorkspaceEventsAfter(
    workspaceId: string,
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
        unsubscribe?.();
        resolve(events);
      };

      // Subscribe only to the relevant workspace/project before querying so a
      // concurrent event cannot be missed without waking unrelated waiters.
      unsubscribe = subscribeWorkspace(workspaceId, (event) => {
        if (resolved || event.seq <= afterSeq) return;
        const events = getWorkspaceEventsAfter(workspaceId, afterSeq);
        if (events.length > 0) finish(events);
      });

      const existing = getWorkspaceEventsAfter(workspaceId, afterSeq);
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
    signal?: AbortSignal,
  ): Promise<EventStoreEvent | null> {
    return new Promise((resolve) => {
      let resolved = false;

      let timeout: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      const abort = () => finish(null);

      const finish = (event: EventStoreEvent | null) => {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        if (unsubscribe) unsubscribe();
        signal?.removeEventListener("abort", abort);
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

      if (signal?.aborted) {
        finish(null);
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      if (Number.isFinite(timeoutMs)) timeout = setTimeout(() => finish(null), timeoutMs);
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
      durable: true,
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
    const workspaceKeys = [event.workspaceSessionId, event.workspaceProjectId].filter((key): key is string => Boolean(key));
    const notified = new Set<Subscriber>();
    for (const key of workspaceKeys) {
      for (const callback of workspaceSubscribers.get(key) ?? []) {
        if (notified.has(callback)) continue;
        notified.add(callback);
        callback(event);
      }
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

  function subscribeWorkspace(workspaceId: string, callback: Subscriber): () => void {
    const keys = new Set<string>([workspaceId]);
    const workspace = database.sqlite.prepare("select id, project_id from workspace_sessions where id = ?").get(workspaceId) as { id: string; project_id?: string | null } | undefined;
    if (workspace?.project_id) keys.add(workspace.project_id);
    const project = database.sqlite.prepare("select project_id from workspace_sessions where id = ?").get(workspaceId) as { project_id?: string | null } | undefined;
    if (!project?.project_id) {
      const byProject = database.sqlite.prepare("select project_id from workspace_sessions where project_id = ? limit 1").get(workspaceId) as { project_id?: string | null } | undefined;
      if (byProject?.project_id) keys.add(byProject.project_id);
    }
    for (const key of keys) {
      if (!workspaceSubscribers.has(key)) workspaceSubscribers.set(key, new Set());
      workspaceSubscribers.get(key)!.add(callback);
    }
    return () => {
      for (const key of keys) {
        const set = workspaceSubscribers.get(key);
        if (!set) continue;
        set.delete(callback);
        if (set.size === 0) workspaceSubscribers.delete(key);
      }
    };
  }

  function countEventsByType(sessionId: string): Record<string, number> {
    const rows = database.sqlite
      .prepare(
        `select type, count(*) as count
         from event_log
         where session_id = ?
         group by type`,
      )
      .all(sessionId) as Array<{ type: string; count: number }>;

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.type] = row.count;
    }
    return result;
  }

  /**
   * P2 compaction: Replace high-volume telemetry events with a single checkpoint.
   * Preserves all workflow events (tool lifecycle, review, state changes, etc.)
   * and drops/replaces output_delta and thought_delta with a summary row.
   */
  function compactSessionEvents(sessionId: string, opts: { retentionDays?: number } = {}): number {
    const retentionDays = opts.retentionDays ?? 7;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    flushTelemetryForSession(sessionId);

    // Deletion and its audit checkpoint are one SQLite transaction. A crash
    // cannot leave the session compacted without the durable marker that
    // explains what was removed.
    const compact = database.sqlite.transaction(() => {
      const deleteResult = database.sqlite
        .prepare(
          `delete from event_log
           where session_id = ?
           and type in ('agent.run.output_delta', 'agent.run.thought_delta')
           and created_at < ?`,
        )
        .run(sessionId, cutoff);

      if (deleteResult.changes > 0) {
        insertEvent({
          type: "agent.run.transcript_checkpoint",
          sessionId,
          publish: false,
          payload: {
            compacted: true,
            originalTelemetryCount: deleteResult.changes,
            cutoff,
            compactedAt: new Date().toISOString(),
          },
        });
      }
      return deleteResult.changes;
    });
    const startedAt = performance.now();
    const removed = compact();
    recordTiming("sqlite.compaction_commit", startedAt);
    return removed;
  }

  function close(): void {
    for (const key of [...telemetryBuffers.keys()]) flushTelemetry(key);
    subscribers.clear();
    globalSubscribers.clear();
    workspaceSubscribers.clear();
    lastAgentEventAt.clear();
    // P1 #11: Don't close shared DB handle - server owns it
  }

  return {
    appendEvent,
    publishEvents: (events) => {
      for (const event of events) publish(event);
    },
    getEventsForSession,
    getEventsAfter,
    getWorkspaceEventsAfter,
    countEventsByType,
    compactSessionEvents,
    waitForEventsAfter,
    waitForWorkspaceEventsAfter,
    getLatestEvent,
    subscribe,
    subscribeAll,
    waitForEvent,
    waitForMatchingEventAfter,
    close,
  };
}
