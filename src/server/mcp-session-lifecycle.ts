/**
 * MCP session metrics, timing samples, capacity-rejection accounting, memory
 * pressure, and the session finalize/reap lifecycle. Extracted verbatim from
 * src/server.ts (P1.2); the createServer closures become an explicit
 * dependency object.
 */
import type { ServerConfig } from "../config.js";
import type { LogicalContinuityIndex } from "../mcp-logical-continuity.js";
import { mcpSessionIdleReason, mcpSessionIdleTtl } from "../mcp-session-policy.js";
import { logEvent, sessionIdPrefix } from "../logger.js";
import type { ProcessSessionManager } from "../process-sessions.js";
import type { Transport } from "../mcp/workspace-server.js";
import {
  resolveMcpMemoryBudget,
  type McpSessionClientMetrics,
  type McpSessionMetrics,
  type McpSessionState,
  type McpSessionWindowKind,
  type McpTimingSample,
  type PhaseTimingSample,
  type WorkspaceAppResourceMetrics,
} from "./mcp-session-state.js";

export interface McpSessionLifecycleDeps {
  readonly config: ServerConfig;
  cancelPolicyWaitersForSession(sessionId: string, requestId?: string): number;
  readonly mcpSessions: Map<string, McpSessionState>;
  readonly transports: Map<string, Transport>;
  readonly logicalContinuity: LogicalContinuityIndex;
  readonly processSessions: ProcessSessionManager;
  readonly workspaceAppResourceMetrics: WorkspaceAppResourceMetrics;
}

export interface McpSessionLifecycle {
  readonly metrics: McpSessionMetrics;
  readonly capacityRejectionsByTool: Map<string, number>;
  readonly capacityRejectionsByWeight: Map<number, number>;
  readonly reaper: NodeJS.Timeout;
  readonly memorySampler: NodeJS.Timeout;
  recordMcpTiming(sample: Omit<McpTimingSample, "at">): void;
  recordPhaseTiming(phase: string, durationMs: number): void;
  lastCapacityRejection(): { tool?: string; weight: number; requestId?: string; at: string } | undefined;
  recordMcpCapacityRejection(toolName: string | undefined, weight: number, requestId?: string): void;
  mapNumberCounts<TKey extends string | number>(values: Map<TKey, number>): Record<string, number>;
  mcpSseDiagnostics(): { active: number; byClient: Record<string, number> };
  timingQuantiles(samples: number[]): { count: number; p50: number; p95: number; p99: number };
  mcpTimingDiagnostics(waiterActive: number): Record<string, unknown>;
  sessionWindowMetrics(windowMs: number, now?: number): ReturnType<typeof buildSessionWindowMetrics>;
  recordMcpSessionEnd(state: McpSessionState, reason: string, now?: number): void;
  recordMcpSessionCreated(logicalClientId: string, at?: number): void;
  recordMcpWindowEvent(kind: McpSessionWindowKind, at?: number): void;
  mcpSessionReuseMetrics(): Record<string, unknown>;
  estimateMcpSessionMemoryCost(): { bytesPerSession: number; peakRss: number; peakCount: number };
  trackMcpSessionMemory(): void;
  getMemoryPressureState(): { level: "low" | "moderate" | "high"; effectiveHardCap: number; effectiveSoftCap: number };
  finalizeMcpSession(
    sessionId: string,
    reason: "client_closed" | "server_shutdown" | "expired",
    options?: { transport?: Transport; evictionReason?: string; at?: number },
  ): boolean;
  reapIdleMcpSessions(forceClientId?: string): void;
}

function buildSessionWindowMetrics(events: Array<{ at: number; kind: McpSessionWindowKind }>, windowMs: number, now: number) {
  const cutoff = now - windowMs;
  const windowEvents = events.filter((event) => event.at >= cutoff);
  const sessionsCreated = windowEvents.filter((event) => event.kind === "created").length;
  const toolCalls = windowEvents.filter((event) => event.kind === "tool").length;
  return {
    sessionsCreated,
    sessionsClosed: windowEvents.filter((event) => event.kind === "closed").length,
    sessionsExpired: windowEvents.filter((event) => event.kind === "expired").length,
    toolCalls,
    sessionsPerToolCall: sessionsCreated / Math.max(toolCalls, 1),
  };
}

export function createMcpSessionLifecycle(deps: McpSessionLifecycleDeps): McpSessionLifecycle {
  const { config, mcpSessions, transports, logicalContinuity, processSessions, workspaceAppResourceMetrics } = deps;
  const mcpSessionMetrics: McpSessionMetrics = {
    created: 0,
    evicted: 0,
    closed: 0,
    expired: 0,
    inFlight: 0,
    clients: new Map(),
    windowEvents: [],
    completedToolCounts: [],
  };
  const mcpTimingSamples: McpTimingSample[] = [];
  const phaseTimingSamples: PhaseTimingSample[] = [];
  const mcpCapacityRejectionsByTool = new Map<string, number>();
  const mcpCapacityRejectionsByWeight = new Map<number, number>();
  let lastMcpCapacityRejection: { tool?: string; weight: number; requestId?: string; at: string } | undefined;

  function recordMcpTiming(sample: Omit<McpTimingSample, "at">): void {
    mcpTimingSamples.push({ at: Date.now(), ...sample });
    if (mcpTimingSamples.length > 2_000) mcpTimingSamples.splice(0, mcpTimingSamples.length - 2_000);
    recordPhaseTiming("mcp.admission_wait", sample.admissionWaitMs);
    if (sample.serverCreateMs > 0) recordPhaseTiming("mcp.server_setup_total", sample.serverCreateMs);
    if (sample.transportConnectMs > 0) recordPhaseTiming("mcp.transport_connect", sample.transportConnectMs);
    if (sample.handlerMs > 0) recordPhaseTiming("mcp.handler", sample.handlerMs);
    recordPhaseTiming("mcp.request_total", sample.totalMs);
  }

  function recordPhaseTiming(phase: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    phaseTimingSamples.push({ at: Date.now(), phase, durationMs });
    if (phaseTimingSamples.length > 5_000) phaseTimingSamples.splice(0, phaseTimingSamples.length - 5_000);
  }

  function recordMcpCapacityRejection(toolName: string | undefined, weight: number, requestId?: string): void {
    const toolKey = toolName || "rpc";
    mcpCapacityRejectionsByTool.set(toolKey, (mcpCapacityRejectionsByTool.get(toolKey) ?? 0) + 1);
    mcpCapacityRejectionsByWeight.set(weight, (mcpCapacityRejectionsByWeight.get(weight) ?? 0) + 1);
    lastMcpCapacityRejection = { tool: toolName, weight, requestId, at: new Date().toISOString() };
  }

  function mapNumberCounts<TKey extends string | number>(values: Map<TKey, number>): Record<string, number> {
    return Object.fromEntries([...values.entries()].map(([key, count]) => [String(key), count]));
  }

  function mcpSseDiagnostics(): { active: number; byClient: Record<string, number> } {
    const byClient = new Map<string, number>();
    let active = 0;
    for (const state of mcpSessions.values()) {
      if (state.activeSseStreams <= 0) continue;
      active += state.activeSseStreams;
      byClient.set(state.logicalClientId, (byClient.get(state.logicalClientId) ?? 0) + state.activeSseStreams);
    }
    return { active, byClient: mapNumberCounts(byClient) };
  }

  function timingQuantiles(samples: number[]): { count: number; p50: number; p95: number; p99: number } {
    if (samples.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0 };
    const ordered = [...samples].sort((a, b) => a - b);
    const percentile = (fraction: number) => ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))];
    return {
      count: ordered.length,
      p50: Math.round(percentile(0.5)),
      p95: Math.round(percentile(0.95)),
      p99: Math.round(percentile(0.99)),
    };
  }

  function mcpTimingDiagnostics(waiterActive: number): Record<string, unknown> {
    const recent = mcpTimingSamples.filter((sample) => sample.at >= Date.now() - 15 * 60_000);
    const initialization = recent.filter((sample) => sample.serverCreateMs > 0);
    const requests = recent.filter((sample) => sample.serverCreateMs === 0);
    const by = (field: keyof Pick<McpTimingSample, "admissionWaitMs" | "serverCreateMs" | "transportConnectMs" | "handlerMs" | "totalMs">) =>
      timingQuantiles(requests.map((sample) => sample[field]));
    const initBy = (field: "serverCreateMs" | "transportConnectMs" | "totalMs") =>
      timingQuantiles(initialization.map((sample) => sample[field]));
    const phaseCutoff = Date.now() - 15 * 60_000;
    const phaseGroups = new Map<string, number[]>();
    for (const sample of phaseTimingSamples) {
      if (sample.at < phaseCutoff) continue;
      const values = phaseGroups.get(sample.phase) ?? [];
      values.push(sample.durationMs);
      phaseGroups.set(sample.phase, values);
    }
    const phaseTimings = Object.fromEntries(
      [...phaseGroups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([phase, values]) => [phase, timingQuantiles(values)]),
    );
    return {
      windowMs: 15 * 60_000,
      requests: requests.length,
      totalMs: by("totalMs"),
      admissionWaitMs: by("admissionWaitMs"),
      initialization: {
        count: initialization.length,
        serverCreateMs: initBy("serverCreateMs"),
        transportConnectMs: initBy("transportConnectMs"),
        totalMs: initBy("totalMs"),
      },
      handlerMs: by("handlerMs"),
      waiterRequests: requests.filter((sample) => sample.admissionClass === "waiter").length,
      executionRequests: requests.filter((sample) => sample.admissionClass === "execution").length,
      streamRequests: requests.filter((sample) => sample.admissionClass === "stream").length,
      eventWaiterCount: waiterActive,
      waiterDurationMs: timingQuantiles(recent.filter((sample) => sample.admissionClass === "waiter").map((sample) => sample.totalMs)),
      streamDurationMs: timingQuantiles(recent.filter((sample) => sample.admissionClass === "stream").map((sample) => sample.totalMs)),
      phaseTimings,
    };
  }

  function clientMcpMetrics(logicalClientId: string): McpSessionClientMetrics {
    let metrics = mcpSessionMetrics.clients.get(logicalClientId);
    if (!metrics) {
      metrics = {
        sessionsCreated: 0,
        currentSessions: 0,
        sessionsClosed: 0,
        sessionsExpired: 0,
        zeroToolSessions: 0,
        singleToolSessions: 0,
        multiToolSessions: 0,
        totalToolCalls: 0,
        totalLifetimeMs: 0,
        oldestIdleMs: 0,
      };
      mcpSessionMetrics.clients.set(logicalClientId, metrics);
    }
    return metrics;
  }

  function recordMcpWindowEvent(kind: McpSessionWindowKind, at = Date.now()): void {
    mcpSessionMetrics.windowEvents.push({ at, kind });
    const cutoff = at - 15 * 60_000;
    while (mcpSessionMetrics.windowEvents.length > 0 && mcpSessionMetrics.windowEvents[0].at < cutoff) {
      mcpSessionMetrics.windowEvents.shift();
    }
  }

  function sessionWindowMetrics(windowMs: number, now = Date.now()) {
    return buildSessionWindowMetrics(mcpSessionMetrics.windowEvents, windowMs, now);
  }

  function recordMcpSessionEnd(state: McpSessionState, reason: string, now = Date.now()): void {
    if (state.endRecorded) return;
    state.endRecorded = true;
    state.closed = true;
    const metrics = clientMcpMetrics(state.logicalClientId);
    metrics.currentSessions = Math.max(0, metrics.currentSessions - 1);
    metrics.totalLifetimeMs += Math.max(0, now - state.createdAt);
    metrics.totalToolCalls += state.toolCallCount;
    metrics.oldestIdleMs = 0;
    if (state.toolCallCount === 0) metrics.zeroToolSessions++;
    else if (state.toolCallCount === 1) metrics.singleToolSessions++;
    else metrics.multiToolSessions++;
    mcpSessionMetrics.completedToolCounts.push(state.toolCallCount);
    if (mcpSessionMetrics.completedToolCounts.length > 10_000) mcpSessionMetrics.completedToolCounts.shift();
    if (reason === "expired") {
      mcpSessionMetrics.expired++;
      metrics.sessionsExpired++;
      recordMcpWindowEvent("expired", now);
    } else {
      mcpSessionMetrics.closed++;
      metrics.sessionsClosed++;
      recordMcpWindowEvent("closed", now);
    }
  }

  function recordMcpSessionCreated(logicalClientId: string, at = Date.now()): void {
    const metrics = clientMcpMetrics(logicalClientId);
    metrics.sessionsCreated++;
    metrics.currentSessions++;
    mcpSessionMetrics.created++;
    recordMcpWindowEvent("created", at);
  }

  function completedToolPercentile(percentile: number): number {
    if (mcpSessionMetrics.completedToolCounts.length === 0) return 0;
    const sorted = [...mcpSessionMetrics.completedToolCounts].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)] ?? 0;
  }

  function mcpSessionReuseMetrics() {
    const now = Date.now();
    const completed = mcpSessionMetrics.closed + mcpSessionMetrics.expired;
    const perClient = [...mcpSessionMetrics.clients.entries()].map(([client, metrics]) => {
      let currentZeroToolSessions = 0;
      let currentSingleToolSessions = 0;
      let currentMultiToolSessions = 0;
      let oldestIdleMs = 0;
      for (const state of mcpSessions.values()) {
        if (state.logicalClientId !== client) continue;
        if (state.toolCallCount === 0) currentZeroToolSessions++;
        else if (state.toolCallCount === 1) currentSingleToolSessions++;
        else currentMultiToolSessions++;
        oldestIdleMs = Math.max(oldestIdleMs, now - state.lastApplicationActivityAt);
      }
      return {
        client,
        sessionsCreated: metrics.sessionsCreated,
        currentSessions: metrics.currentSessions,
        sessionsClosed: metrics.sessionsClosed,
        sessionsExpired: metrics.sessionsExpired,
        singleToolSessions: metrics.singleToolSessions,
        multiToolSessions: metrics.multiToolSessions,
        unusedSessions: metrics.zeroToolSessions,
        currentZeroToolSessions,
        currentSingleToolSessions,
        currentMultiToolSessions,
        averageToolCallsPerSession: metrics.sessionsCreated > 0 ? metrics.totalToolCalls / metrics.sessionsCreated : 0,
        averageLifetimeMs: completed > 0 ? metrics.totalLifetimeMs / completed : 0,
        oldestIdleMs,
      };
    });
    const clientTotals = [...mcpSessionMetrics.clients.values()].reduce((totals, metrics) => ({
      zeroToolSessions: totals.zeroToolSessions + metrics.zeroToolSessions,
      singleToolSessions: totals.singleToolSessions + metrics.singleToolSessions,
      multiToolSessions: totals.multiToolSessions + metrics.multiToolSessions,
    }), { zeroToolSessions: 0, singleToolSessions: 0, multiToolSessions: 0 });
    return {
      sessionsCreated: mcpSessionMetrics.created,
      sessionsClosed: mcpSessionMetrics.closed,
      sessionsExpired: mcpSessionMetrics.expired,
      zeroToolSessions: clientTotals.zeroToolSessions,
      singleToolSessions: clientTotals.singleToolSessions,
      multiToolSessions: clientTotals.multiToolSessions,
      toolCallsPerSessionMean: completed > 0 ? mcpSessionMetrics.completedToolCounts.reduce((sum, count) => sum + count, 0) / completed : 0,
      toolCallsPerSessionP50: completedToolPercentile(0.5),
      toolCallsPerSessionP95: completedToolPercentile(0.95),
      windows: {
        last1m: sessionWindowMetrics(60_000, now),
        last5m: sessionWindowMetrics(5 * 60_000, now),
        last15m: sessionWindowMetrics(15 * 60_000, now),
      },
      perClient,
    };
  }

  // P1 #33: Memory pressure tracking for adaptive caps
  const mcpSessionBaseRss = process.memoryUsage().rss;
  let mcpSessionPeakRss = mcpSessionBaseRss;
  let mcpSessionCountAtPeak = 0;
  let mcpSessionBytesPerSessionEstimate = 5_700_000;

  function estimateMcpSessionMemoryCost() {
    return {
      bytesPerSession: mcpSessionBytesPerSessionEstimate,
      peakRss: mcpSessionPeakRss,
      peakCount: mcpSessionCountAtPeak,
    };
  }

  function trackMcpSessionMemory() {
    const current = process.memoryUsage();
    if (mcpSessions.size > mcpSessionCountAtPeak) {
      mcpSessionPeakRss = current.rss;
      mcpSessionCountAtPeak = mcpSessions.size;
      const delta = Math.max(0, current.rss - mcpSessionBaseRss);
      mcpSessionBytesPerSessionEstimate = Math.max(1_000_000, Math.round(delta / mcpSessions.size));
    }
  }

  function getMemoryPressureState() {
    trackMcpSessionMemory();
    const totalRss = process.memoryUsage().rss;
    // P1 #24: configurable deployment budget instead of a magic 2 GB. Prefer
    // an explicit KONTROL_MCP_MEMORY_BUDGET_BYTES; otherwise use a fraction
    // of the container/host ceiling when cgroup limits expose one.
    const rssLimit = resolveMcpMemoryBudget(config.mcpMemoryBudgetBytes);
    if (totalRss > rssLimit * 0.8) {
      return { level: "high" as const, effectiveHardCap: Math.min(config.mcpSessionHardCap, 100), effectiveSoftCap: Math.min(config.mcpSessionSoftCap, 75) };
    }
    if (totalRss > rssLimit * 0.5) {
      return { level: "moderate" as const, effectiveHardCap: Math.min(config.mcpSessionHardCap, 150), effectiveSoftCap: Math.min(config.mcpSessionSoftCap, 100) };
    }
    return { level: "low" as const, effectiveHardCap: config.mcpSessionHardCap, effectiveSoftCap: config.mcpSessionSoftCap };
  }

  const mcpSessionHasActiveResponsibility = (state: McpSessionState): boolean => (
    state.inFlightRequests > 0
    || state.activeLongPollCount > 0
    || state.activeSseStreams > 0
    || state.activePolicyWaiters > 0
    || state.closing
    || state.closed
  );

  /**
   * Single cleanup primitive for a terminated MCP transport. Both the normal
   * close callback and the reaper must run the same steps — waiter
   * cancellation, continuity detach, direct process ownership cleanup, metric
   * recording, and map deletion — or a transport whose `sessionId` property is
   * unavailable at close time leaks a session record until its TTL. Callers
   * that hold the transport pass `transport` so it can be closed after the
   * maps are updated.
   */
  const finalizeMcpSession = (
    sessionId: string,
    reason: "client_closed" | "server_shutdown" | "expired",
    options: { transport?: Transport; evictionReason?: string; at?: number } = {},
  ): boolean => {
    const now = options.at ?? Date.now();
    const state = mcpSessions.get(sessionId);
    if (!state) {
      transports.delete(sessionId);
      return false;
    }
    if (reason === "expired" && mcpSessionHasActiveResponsibility(state)) return false;
    state.closing = true;
    transports.delete(sessionId);
    recordMcpSessionEnd(state, reason, now);
    if (state.identitySource !== "client_info_fallback") {
      logicalContinuity.detach(state.logicalClientId, state.sessionId, now);
    }
    deps.cancelPolicyWaitersForSession(sessionId, reason === "expired" ? "session_expired" : "transport_closed");
    mcpSessions.delete(sessionId);
    // Direct ephemeral commands belong to the transport and die with it.
    // Work-session commands belong to the durable work session and survive a
    // transient MCP reconnect/eviction. The close callback may run after the
    // maps are deleted, so ownership cleanup must not depend on it.
    if (!state.durableWorkerSession) {
      void processSessions.terminateByOwner(sessionId).catch((error) => {
        logEvent(config.logging, "warn", "mcp_session_process_cleanup_failed", {
          sessionIdPrefix: sessionIdPrefix(sessionId),
          reason: reason === "expired" ? "session_expired" : "transport_closed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    if (reason === "expired") {
      mcpSessionMetrics.evicted++;
      void options.transport?.close().catch(() => {});
      logEvent(config.logging, "info", "mcp_session_expired", {
        sessionIdPrefix: sessionIdPrefix(sessionId),
        logicalClientId: state.logicalClientId,
        ageMs: now - state.createdAt,
        idleMs: now - state.lastApplicationActivityAt,
        requestCount: state.requestCount,
        notificationCount: state.notificationCount,
        toolCallCount: state.toolCallCount,
        resourceReadCount: state.resourceReadCount,
        lastRpcMethod: state.lastRpcMethod,
        lastToolName: state.lastToolName,
        reason: options.evictionReason ?? "bounded",
        sessionLabel: state.sessionLabel,
        conversationId: state.conversationId,
      });
      return true;
    }
    logEvent(config.logging, "info", "mcp_session_closed", {
      sessionIdPrefix: sessionIdPrefix(sessionId),
      logicalClientId: state.logicalClientId,
      sessionLabel: state.sessionLabel,
      conversationId: state.conversationId,
      ageMs: now - state.createdAt,
      idleMs: now - state.lastApplicationActivityAt,
      requestCount: state.requestCount,
      notificationCount: state.notificationCount,
      toolCallCount: state.toolCallCount,
      resourceReadCount: state.resourceReadCount,
      lastRpcMethod: state.lastRpcMethod,
      lastToolName: state.lastToolName,
      closeReason: reason,
    });
    return true;
  };

  const reapIdleMcpSessions = (forceClientId?: string) => {
    const pressure = getMemoryPressureState();
    const now = Date.now();
    logicalContinuity.sweep(now);
    // Phase 1: evict sessions with active requests (never evict in-flight)
    // Phase 2: evict provisional one-tool sessions after their model-turn
    // grace window. One completed tool is not treated as immediate completion.
    // Phase 3: evict reusable sessions past their normal TTL.
    // Phase 4: if still over soft cap, LRU evict idle sessions
    const toEvict: string[] = [];
    const evictionReasons = new Map<string, string>();
    const queueEviction = (id: string, reason: string) => {
      if (evictionReasons.has(id)) return;
      toEvict.push(id);
      evictionReasons.set(id, reason);
    };
    const clientCounts = new Map<string, number>();

    for (const [id, state] of mcpSessions) {
      const idle = now - state.lastApplicationActivityAt;
      const ttl = mcpSessionIdleTtl(state, config);

      if (mcpSessionHasActiveResponsibility(state)) continue;

      if (idle >= ttl) {
        queueEviction(id, mcpSessionIdleReason(state));
      } else if (state.identitySource !== "client_info_fallback") {
        // Generic clientInfo name/version labels are not a trustworthy client
        // boundary. They participate only in the global LRU/memory bound, not
        // in the per-client lifetime cap.
        clientCounts.set(state.logicalClientId, (clientCounts.get(state.logicalClientId) ?? 0) + 1);
      }
    }

    // Admission at the per-client cap must not become a 503 wall when the
    // client has accumulated idle transports. Reclaim exactly the number of
    // sessions the new connection needs: zero-tool first, then one-tool, then
    // the oldest idle reusable non-worker transports. Active requests, SSE
    // streams, long polls, policy waiters, and worker-bound transports remain
    // protected. Without the multi-tool tier a client that had already filled
    // its quota with healthy reusable sessions could never connect again
    // until the 24h reusable TTL elapsed.
    if (forceClientId) {
      const currentClientCount = [...mcpSessions.values()].filter((state) => state.logicalClientId === forceClientId).length;
      const alreadyQueued = [...evictionReasons.keys()].filter((id) => mcpSessions.get(id)?.logicalClientId === forceClientId).length;
      const needed = Math.max(0, currentClientCount - config.mcpSessionMaxPerClient + 1 - alreadyQueued);
      if (needed > 0) {
        const eligible = [...mcpSessions.values()]
          .filter((state) => (
            state.logicalClientId === forceClientId
            && !state.durableWorkerSession
            && !mcpSessionHasActiveResponsibility(state)
            && !evictionReasons.has(state.sessionId)
          ));
        const byIdle = (a: McpSessionState, b: McpSessionState) => a.lastApplicationActivityAt - b.lastApplicationActivityAt;
        const zeroTool = eligible.filter((state) => state.toolCallCount === 0).sort(byIdle);
        const oneTool = eligible.filter((state) => state.toolCallCount === 1).sort(byIdle);
        const reusable = eligible.filter((state) => state.toolCallCount > 1).sort(byIdle);
        for (const state of [...zeroTool, ...oneTool, ...reusable].slice(0, needed)) {
          queueEviction(state.sessionId, "per_client_limit");
        }
      }
    }

    // Per-client limit: evict oldest idle sessions beyond limit
    for (const [id, state] of mcpSessions) {
      if (toEvict.includes(id)) continue;
      if (state.identitySource === "client_info_fallback") continue;
      if (mcpSessionHasActiveResponsibility(state)) continue;
      const count = clientCounts.get(state.logicalClientId) ?? 0;
      if (count > config.mcpSessionMaxPerClient) {
        queueEviction(id, "per_client_limit");
        clientCounts.set(state.logicalClientId, count - 1);
      }
    }

    // Adaptive soft cap: evict true LRU idle sessions before the hard cap.
    const softExcess = mcpSessions.size - toEvict.length - pressure.effectiveSoftCap;
    if (softExcess > 0) {
      const candidates: Array<{ id: string; lastApplicationActivityAt: number }> = [];
      for (const [id, state] of mcpSessions) {
        if (toEvict.includes(id)) continue;
        if (mcpSessionHasActiveResponsibility(state)) continue;
        candidates.push({ id, lastApplicationActivityAt: state.lastApplicationActivityAt });
      }
      candidates.sort((a, b) => a.lastApplicationActivityAt - b.lastApplicationActivityAt);
      for (let i = 0; i < Math.min(softExcess, candidates.length); i++) {
        queueEviction(candidates[i].id, "soft_cap_lru");
      }
    }

    for (const id of toEvict) {
      const transport = transports.get(id);
      // Recheck inside finalizeMcpSession: no active request/stream/waiter may
      // be reaped on eligibility evidence gathered before this pass.
      finalizeMcpSession(id, "expired", {
        transport,
        evictionReason: evictionReasons.get(id),
        at: now,
      });
    }
  };

  const reaper = setInterval(reapIdleMcpSessions, config.mcpSessionReaperIntervalMs);
  reaper.unref?.();
  const memorySampler = setInterval(trackMcpSessionMemory, 30_000);
  memorySampler.unref?.();

  return {
    metrics: mcpSessionMetrics,
    capacityRejectionsByTool: mcpCapacityRejectionsByTool,
    capacityRejectionsByWeight: mcpCapacityRejectionsByWeight,
    reaper,
    memorySampler,
    recordMcpTiming,
    recordPhaseTiming,
    lastCapacityRejection: () => lastMcpCapacityRejection,
    recordMcpCapacityRejection,
    mapNumberCounts,
    mcpSseDiagnostics,
    timingQuantiles,
    mcpTimingDiagnostics,
    sessionWindowMetrics,
    recordMcpSessionEnd,
    recordMcpSessionCreated,
    recordMcpWindowEvent,
    mcpSessionReuseMetrics,
    estimateMcpSessionMemoryCost,
    trackMcpSessionMemory,
    getMemoryPressureState,
    finalizeMcpSession,
    reapIdleMcpSessions,
  };
}
