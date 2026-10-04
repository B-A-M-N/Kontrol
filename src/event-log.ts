import { createHash, randomUUID } from "node:crypto";
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
  /** True for a committed event or a receipt committed to durable ingress. */
  durable: boolean;
  /** Present on an ingress receipt that has not yet been materialized in event_log. */
  receipt?: boolean;
  ingressReceipt?: boolean;
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
  eventIds: Set<string>;
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
  publish: boolean;
}

interface WorkspaceEventScope {
  workspaceSessionId: string;
  projectId: string;
}

export type EventPredicate = (event: EventStoreEvent) => boolean;

export type EventStoreTimingCallback = (phase: string, durationMs: number) => void;

export interface EventStore {
 appendEvent(input: {
   id?: string;
   type: string;
   sessionId: string;
   workspaceSessionId?: string;
   payload: Record<string, unknown>;
 }, opts?: { publish?: boolean }): EventStoreEvent;

 publishEvents(events: EventStoreEvent[]): void;

 getEventsForSession(sessionId: string): EventStoreEvent[];

 /** Exact adapter event lookup for idempotent retry handling. */
 getEventById(eventId: string): EventStoreEvent | undefined;

 /** Durably persist an adapter telemetry fragment before acknowledging it. */
 appendTelemetryIngress(input: {
   id?: string;
   type: string;
   sessionId: string;
   workspaceSessionId?: string;
   payload: Record<string, unknown>;
 }, opts?: { publish?: boolean }): { eventId: string; duplicate: boolean };

 /** Materialize pending ingress rows into coalesced event-log events. */
 flushTelemetryIngress(sessionId?: string): number;

 /** Prune at most `limit` committed ingress receipts older than `cutoff`. Pending receipts are never eligible. */
 pruneCommittedTelemetryIngress(cutoff: string, limit: number): number;

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
 compactSessionEvents(sessionId: string, opts?: { retentionDays?: number; maxRows?: number }): number;

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
    signal?: AbortSignal,
 ): Promise<EventStoreEvent[]>;

 /** Event-driven workspace/project waiter; one waiter can multiplex many sessions. */
 waitForWorkspaceEventsAfter(
   workspaceId: string,
   afterSeq: number,
   timeoutMs: number,
   signal?: AbortSignal,
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
  const TELEMETRY_INGRESS_BATCH_SIZE = 512;
  let telemetryIngressTimer: ReturnType<typeof setTimeout> | undefined;
  let telemetryIngressFlushRunning = false;
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

  function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  }

  function telemetryPayloadHash(input: { type: string; sessionId: string; workspaceSessionId?: string; payload: Record<string, unknown> }): string {
    return createHash("sha256").update(stableJson({
      type: input.type,
      sessionId: input.sessionId,
      workspaceSessionId: input.workspaceSessionId ?? "",
      payload: input.payload,
    })).digest("hex");
  }

  function hasPendingTelemetryIngress(sessionId?: string): boolean {
    const row = sessionId
      ? database.sqlite.prepare("select 1 as found from telemetry_ingress where status = 'pending' and session_id = ? limit 1").get(sessionId)
      : database.sqlite.prepare("select 1 as found from telemetry_ingress where status = 'pending' limit 1").get();
    return Boolean(row);
  }

  function scheduleTelemetryIngressFlush(delayMs = TELEMETRY_FLUSH_INTERVAL_MS): void {
    if (telemetryIngressTimer || telemetryIngressFlushRunning || !hasPendingTelemetryIngress()) return;
    telemetryIngressTimer = setTimeout(() => {
      telemetryIngressTimer = undefined;
      flushTelemetryIngressBatch();
      if (hasPendingTelemetryIngress()) scheduleTelemetryIngressFlush();
    }, delayMs);
    telemetryIngressTimer.unref?.();
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

  function resolveWorkspaceEventScope(workspaceOrProjectId: string): WorkspaceEventScope {
    const workspace = database.sqlite
      .prepare("select id, project_id from workspace_sessions where id = ?")
      .get(workspaceOrProjectId) as { id: string; project_id?: string | null } | undefined;
    if (workspace) {
      return {
        workspaceSessionId: workspace.id,
        projectId: workspace.project_id ?? workspace.id,
      };
    }
    return {
      workspaceSessionId: workspaceOrProjectId,
      projectId: workspaceOrProjectId,
    };
  }

  function insertEvent(input: {
    id?: string;
    type: string;
    sessionId: string;
    workspaceSessionId?: string;
    payload: Record<string, unknown>;
    publish: boolean;
  }): EventStoreEvent {
    const startedAt = performance.now();
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    const correlation = resolveWorkspaceCorrelation(input.sessionId, input.workspaceSessionId);

    try {
      database.sqlite
        .prepare(
          `insert into event_log (id, type, session_id, workspace_session_id, payload, created_at)
           values (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.type, input.sessionId, correlation.workspaceSessionId ?? null, JSON.stringify(input.payload), now);
    } catch (error) {
      const existing = getEventLogById(id);
      if (existing) return existing;
      throw error;
    }

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

  function appendTelemetryIngress(input: {
    id?: string;
    type: string;
    sessionId: string;
    workspaceSessionId?: string;
    payload: Record<string, unknown>;
  }, opts: { publish?: boolean } = {}): { eventId: string; duplicate: boolean } {
    if (!isHighVolumeTelemetry(input.type)) {
      throw new Error(`Telemetry ingress does not accept event type ${input.type}`);
    }
    const eventId = input.id ?? randomUUID();
    const payloadJson = JSON.stringify(input.payload);
    const payloadSha256 = telemetryPayloadHash(input);
    const existing = database.sqlite.prepare(`
      select session_id, workspace_session_id, type, payload_sha256
        from telemetry_ingress
       where event_id = ?
    `).get(eventId) as { session_id: string; workspace_session_id?: string | null; type: string; payload_sha256: string } | undefined;
    if (existing) {
      if (existing.session_id !== input.sessionId
        || (existing.workspace_session_id ?? undefined) !== input.workspaceSessionId
        || existing.type !== input.type
        || existing.payload_sha256 !== payloadSha256) {
        throw new Error(`Adapter event id ${eventId} was reused with different telemetry content`);
      }
      return { eventId, duplicate: true };
    }
    database.sqlite.prepare(`
      insert into telemetry_ingress
        (event_id, session_id, workspace_session_id, type, payload_json, payload_sha256, publish, status, received_at)
      values (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      eventId,
      input.sessionId,
      input.workspaceSessionId ?? null,
      input.type,
      payloadJson,
      payloadSha256,
      opts.publish === false ? 0 : 1,
      new Date().toISOString(),
    );
    scheduleTelemetryIngressFlush();
    return { eventId, duplicate: false };
  }

  function flushTelemetryIngressBatch(sessionId?: string): number {
    if (telemetryIngressFlushRunning) return 0;
    telemetryIngressFlushRunning = true;
    try {
      const rows = (sessionId
        ? database.sqlite.prepare(`
            select sequence, event_id, session_id, workspace_session_id, type, payload_json, publish
              from telemetry_ingress
             where status = 'pending' and session_id = ?
             order by sequence
             limit ?
          `).all(sessionId, TELEMETRY_INGRESS_BATCH_SIZE)
        : database.sqlite.prepare(`
            select sequence, event_id, session_id, workspace_session_id, type, payload_json, publish
              from telemetry_ingress
             where status = 'pending'
             order by sequence
             limit ?
          `).all(TELEMETRY_INGRESS_BATCH_SIZE)) as Array<{
            sequence: number;
            event_id: string;
            session_id: string;
            workspace_session_id?: string | null;
            type: string;
            payload_json?: string | null;
            publish: number;
          }>;
      if (rows.length === 0) return 0;

      // Preserve ingress chronology. Only adjacent rows with the same
      // session/workspace/type may be coalesced; a Map keyed by type would
      // move later output fragments ahead of interleaved thought events.
      const groups: Array<Array<(typeof rows)[number]>> = [];
      let activeKey: string | undefined;
      for (const row of rows) {
        const key = `${row.session_id}\0${row.workspace_session_id ?? ""}\0${row.type}`;
        let group = groups[groups.length - 1];
        if (!group || key !== activeKey) {
          group = [];
          groups.push(group);
          activeKey = key;
        }
        group.push(row);
      }
      for (const group of groups) {
        const first = group[0]!;
        const fragments = group.map((row) => row.payload_json ? JSON.parse(row.payload_json) as Record<string, unknown> : {});
        const channels = [...new Set(fragments
          .map((fragment) => typeof fragment.channel === "string" ? fragment.channel : undefined)
          .filter((channel): channel is string => Boolean(channel)))];
        const payload = {
          text: fragments.map((fragment) => typeof fragment.text === "string" ? fragment.text : "").join(""),
          channel: channels[0] ?? (first.type === "agent.run.thought_delta" ? "thought" : "message"),
          channels,
          coalesced: true,
          count: fragments.length,
        };
        const shouldPublish = group.some((row) => row.publish !== 0);
        const transaction = database.sqlite.transaction(() => {
          const event = insertEvent({
            type: first.type,
            sessionId: first.session_id,
            workspaceSessionId: first.workspace_session_id ?? undefined,
            payload,
            publish: false,
          });
          const update = database.sqlite.prepare(`
            update telemetry_ingress
               set status = 'committed', event_log_id = ?, payload_json = null, committed_at = ?
             where event_id = ? and status = 'pending'
          `);
          const committedAt = new Date().toISOString();
          for (const row of group) update.run(event.id, committedAt, row.event_id);
          return event;
        });
        const event = transaction();
        if (shouldPublish) publish(event);
      }
      return rows.length;
    } finally {
      telemetryIngressFlushRunning = false;
    }
  }

  function flushTelemetryIngress(sessionId?: string): number {
    let flushed = 0;
    let batch: number;
    do {
      batch = flushTelemetryIngressBatch(sessionId);
      flushed += batch;
    } while (batch > 0);
    return flushed;
  }

  function pruneCommittedTelemetryIngress(cutoff: string, limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Telemetry ingress prune limit must be a positive safe integer");
    }
    const result = database.sqlite.prepare(`
      delete from telemetry_ingress
       where sequence in (
         select sequence
           from telemetry_ingress
          where status = 'committed'
            and committed_at is not null
            and committed_at < ?
          order by committed_at, sequence
          limit ?
       )
    `).run(cutoff, limit);
    return result.changes;
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
      id: buffer.eventIds.size === 1 ? [...buffer.eventIds][0] : undefined,
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
    id?: string;
    type: string;
    sessionId: string;
    payload: Record<string, unknown>;
    publish: boolean;
  }): EventStoreEvent {
    const key = `${input.sessionId}\0${input.type}`;
    if (input.id) {
      const existing = getEventById(input.id);
      if (existing) return existing;
    }
    let buffer = telemetryBuffers.get(key);
    if (!buffer) {
      buffer = {
        sessionId: input.sessionId,
        type: input.type,
        items: [],
        eventIds: new Set<string>(),
        bytes: 0,
        publish: input.publish,
      };
      telemetryBuffers.set(key, buffer);
    }
    if (input.id && buffer.eventIds.has(input.id)) {
      return { id: input.id, seq: 0, durable: false, receipt: true, type: input.type, sessionId: input.sessionId, payload: input.payload, createdAt: new Date().toISOString() };
    }
    buffer.items.push({ ...input.payload, ...(input.id ? { eventId: input.id } : {}) });
    if (input.id) buffer.eventIds.add(input.id);
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
    id?: string;
    type: string;
    sessionId: string;
    workspaceSessionId?: string;
    payload: Record<string, unknown>;
  }, opts: { publish?: boolean } = {}): EventStoreEvent {
    if (isHighVolumeTelemetry(input.type)) {
      if (input.id) {
        appendTelemetryIngress(input, opts);
        return {
          id: input.id,
          seq: 0,
          durable: true,
          receipt: true,
          ingressReceipt: true,
          type: input.type,
          sessionId: input.sessionId,
          workspaceSessionId: input.workspaceSessionId,
          payload: input.payload,
          createdAt: new Date().toISOString(),
        };
      }
      return queueTelemetry({
        ...input,
        publish: opts.publish !== false,
      });
    }
    // Keep durable sequence order meaningful: a workflow event that follows a
    // fragment must never overtake the buffered transcript preceding it.
    flushTelemetryIngress(input.sessionId);
    flushTelemetryForSession(input.sessionId);
    return insertEvent({
      ...input,
      publish: opts.publish !== false,
    });
  }

  function getEventLogById(eventId: string): EventStoreEvent | undefined {
    const row = database.sqlite
      .prepare("select id, seq, type, session_id, workspace_session_id, payload, created_at from event_log where id = ? limit 1")
      .get(eventId) as { id: string; seq: number; type: string; session_id: string; workspace_session_id?: string | null; payload: string; created_at: string } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      seq: row.seq,
      durable: true,
      type: row.type,
      sessionId: row.session_id,
      workspaceSessionId: row.workspace_session_id ?? undefined,
      workspaceProjectId: projectIdForWorkspaceSession(row.workspace_session_id ?? undefined),
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at,
    };
  }

  function getEventById(eventId: string): EventStoreEvent | undefined {
    const committed = getEventLogById(eventId);
    if (committed) return committed;
    const ingress = database.sqlite.prepare(`
      select event_id, session_id, workspace_session_id, type, payload_json, status,
             event_log_id, received_at
        from telemetry_ingress
       where event_id = ?
       limit 1
    `).get(eventId) as {
      event_id: string;
      session_id: string;
      workspace_session_id?: string | null;
      type: string;
      payload_json?: string | null;
      status: string;
      event_log_id?: string | null;
      received_at: string;
    } | undefined;
    if (!ingress) return undefined;
    const materialized = ingress.event_log_id ? getEventLogById(ingress.event_log_id) : undefined;
    if (materialized) {
      return {
        ...materialized,
        id: ingress.event_id,
        receipt: true,
        ingressReceipt: true,
      };
    }
    return {
      id: ingress.event_id,
      seq: 0,
      durable: true,
      receipt: true,
      ingressReceipt: true,
      type: ingress.type,
      sessionId: ingress.session_id,
      workspaceSessionId: ingress.workspace_session_id ?? undefined,
      payload: ingress.payload_json ? JSON.parse(ingress.payload_json) as Record<string, unknown> : {},
      createdAt: ingress.received_at,
    };
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
    const scope = resolveWorkspaceEventScope(workspaceId);
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
      .all(scope.workspaceSessionId, scope.projectId, afterSeq, limit) as Array<{
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
    signal?: AbortSignal,
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
        signal?.removeEventListener("abort", abort);
        resolve(events);
      };
      const abort = () => finish([]);

      if (signal?.aborted) {
        finish([]);
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });

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
    signal?: AbortSignal,
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
        signal?.removeEventListener("abort", abort);
        resolve(events);
      };
      const abort = () => finish([]);

      if (signal?.aborted) {
        finish([]);
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });

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
    const invokeSubscriber = (callback: Subscriber, scope: string): void => {
      try {
        callback(event);
      } catch (error) {
        try {
          console.error(`[kontrol] event subscriber failed (${scope})`, error);
        } catch {
          // Diagnostics must never make a committed event look unsuccessful.
        }
      }
    };

    const set = subscribers.get(event.sessionId);
    if (set && set.size > 0) {
      for (const callback of set) invokeSubscriber(callback, `session:${event.sessionId}`);
    }
    const workspaceKeys = [event.workspaceSessionId, event.workspaceProjectId].filter((key): key is string => Boolean(key));
    const notified = new Set<Subscriber>();
    for (const key of workspaceKeys) {
      for (const callback of workspaceSubscribers.get(key) ?? []) {
        if (notified.has(callback)) continue;
        notified.add(callback);
        invokeSubscriber(callback, `workspace:${key}`);
      }
    }
    for (const callback of globalSubscribers) {
      invokeSubscriber(callback, "global");
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
    const scope = resolveWorkspaceEventScope(workspaceId);
    const keys = new Set<string>([scope.workspaceSessionId, scope.projectId]);
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
  function compactSessionEvents(sessionId: string, opts: { retentionDays?: number; maxRows?: number } = {}): number {
    const retentionDays = opts.retentionDays ?? 7;
    const maxRows = Math.max(1, Math.min(500, Math.trunc(opts.maxRows ?? 500)));
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    flushTelemetryForSession(sessionId);

    // Deletion and its audit checkpoint are one SQLite transaction. A crash
    // cannot leave the session compacted without the durable marker that
    // explains what was removed.
    const compact = database.sqlite.transaction(() => {
      const deleteResult = database.sqlite
        .prepare(
          `delete from event_log
           where seq in (
             select seq from event_log
              where session_id = ?
                and type in ('agent.run.output_delta', 'agent.run.thought_delta')
                and created_at < ?
              order by seq
              limit ?
           )`,
        )
        .run(sessionId, cutoff, maxRows);

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
    if (telemetryIngressTimer) clearTimeout(telemetryIngressTimer);
    telemetryIngressTimer = undefined;
    flushTelemetryIngress();
    for (const key of [...telemetryBuffers.keys()]) flushTelemetry(key);
    subscribers.clear();
    globalSubscribers.clear();
    workspaceSubscribers.clear();
    lastAgentEventAt.clear();
    // P1 #11: Don't close shared DB handle - server owns it
  }

  // Reconcile crash-interrupted ingress rows before the store accumulates new
  // traffic. Each timer turn is bounded; shutdown and ordering barriers drain.
  scheduleTelemetryIngressFlush(0);

  return {
    appendEvent,
    appendTelemetryIngress,
    flushTelemetryIngress,
    pruneCommittedTelemetryIngress,
    publishEvents: (events) => {
      for (const event of events) publish(event);
    },
    getEventsForSession,
    getEventById,
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
