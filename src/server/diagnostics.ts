/**
 * Loopback-only authenticated /diagnostics endpoint and snapshot-store
 * telemetry. Extracted verbatim from src/server.ts (P1.2); the createServer
 * closures become an explicit dependency object.
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "../config.js";
import { LATEST_SCHEMA_VERSION } from "../db/migrations.js";
import { requestIp, sessionIdPrefix } from "../logger.js";
import type { McpSessionLifecycle } from "./mcp-session-lifecycle.js";
import type { McpPolicyWaiterRegistry } from "./policy-waiters.js";
import type { McpSessionState, WorkspaceAppResourceMetrics } from "./mcp-session-state.js";
import type { McpAdmission } from "./mcp-admission.js";
import type { Request, Response } from "express";
import { toolListCacheDiagnostics } from "../mcp-tool-list-cache.js";

export interface DiagnosticsDeps {
  readonly config: ServerConfig;
  readonly mcpSessions: Map<string, McpSessionState>;
  readonly mcpAdmission: McpAdmission;
  readonly mcpWaiterAdmission: McpAdmission;
  readonly sessionLifecycle: McpSessionLifecycle;
  readonly policyWaiters: McpPolicyWaiterRegistry;
  readonly workspaceAppResourceMetrics: WorkspaceAppResourceMetrics;
  readonly logicalContinuity: { size(): number; snapshot(): unknown };
  readonly startupRecovery: Record<string, unknown>;
  readonly databaseIntegrity: unknown;
  readonly maintenanceStats: Record<string, unknown>;
  snapshotStoreDiagnostics(): Promise<Record<string, unknown>>;
  degradedAuditSnapshot(): Record<string, unknown>;
  processSessionMetrics(): unknown;
  countActiveWorkSessions(): number;
  countPendingReviews(): number;
  countAliveAgents(): number;
  listPendingApprovals(): Array<{ kind: string; origin?: string; approvalId: string; reattachDeadline?: string }>;
  sqlite(): { prepare?: (sql: string) => { get?: () => unknown } } | undefined;
}

export async function handleDiagnostics(deps: DiagnosticsDeps, req: Request, res: Response): Promise<unknown> {
  const { config, mcpSessions, mcpAdmission, mcpWaiterAdmission, sessionLifecycle } = deps;
  const ip = requestIp(req, config.logging.trustProxy) || "";
  if (ip && !ip.startsWith("127.") && !ip.startsWith("::1") && ip !== "::ffff:127.0.0.1") {
    return res.status(403).json({ ok: false, error: "Forbidden: diagnostics is loopback-only" });
  }
  if (!config.diagnosticsSecret) {
    return res.status(404).json({ ok: false, error: "Diagnostics disabled" });
  }
  // Credentials are header-only. Query-string secrets leak through browser
  // history, proxy logs, and referrer metadata.
  const provided = req.header("x-kontrol-diagnostics") || "";
  const expected = config.diagnosticsSecret;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(403).json({ ok: false, error: "Forbidden: valid X-Kontrol-Diagnostics credential required" });
  }
  try {
    const sqlite = deps.sqlite();
    let dbSizeBytes = 0;
    let walSizeBytes = 0;
    let eventLogCount = 0;
    let outputDeltaCount = 0;
    let thoughtDeltaCount = 0;
    let schemaVersion = 1;
    if (sqlite && sqlite.prepare) {
      try {
        // P1 #47: Use filesystem stat for accurate DB + WAL size
        const dbPath = join(config.stateDir, "kontrol.sqlite");
        try {
          const st = statSync(dbPath);
          dbSizeBytes = st.size;
        } catch { /* ignore */ }
        try {
          const st = statSync(`${dbPath}-wal`);
          walSizeBytes = st.size;
        } catch { /* ignore */ }
      } catch { /* ignore */ }
      try {
        const r = sqlite.prepare("select count(*) as c from event_log").get?.();
        eventLogCount = typeof r === "object" && r !== null && "c" in r ? (r as { c: number }).c : 0;
        const od = sqlite.prepare("select count(*) as c from event_log where type = 'agent.run.output_delta'").get?.();
        outputDeltaCount = typeof od === "object" && od !== null && "c" in od ? (od as { c: number }).c : 0;
        const td = sqlite.prepare("select count(*) as c from event_log where type = 'agent.run.thought_delta'").get?.();
        thoughtDeltaCount = typeof td === "object" && td !== null && "c" in td ? (td as { c: number }).c : 0;
      } catch { /* ignore */ }
      // P1 #48: Query actual schema version
      try {
        const sv = sqlite.prepare("select max(version) as v from kontrol_schema_migrations").get?.();
        schemaVersion = typeof sv === "object" && sv !== null && "v" in sv ? (sv as { v: number }).v : 1;
      } catch { schemaVersion = 1; }
    }

    // P1 #49: Use cheap count APIs instead of expensive hydration
    const activeWorkSessions = deps.countActiveWorkSessions();
    const pendingReviews = deps.countPendingReviews();
    const activeAcps = deps.countAliveAgents();
    const totalMcpSessions = mcpSessions?.size ?? 0;
    const executionAdmission = mcpAdmission.getStats();
    const waiterAdmission = mcpWaiterAdmission.getStats();
    const sse = sessionLifecycle.mcpSseDiagnostics();

    // P0 #2: Comprehensive session/heap metrics
    const memUsage = process.memoryUsage();
    const supervisorStatus = (() => {
      try {
        return JSON.parse(readFileSync(join(config.stateDir, "supervisor-status.json"), "utf8")) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })();
    const generationRecord = (() => {
      try {
        return JSON.parse(readFileSync(join(config.stateDir, "generation.json"), "utf8")) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })();
    const mcpMetrics = {
      created: sessionLifecycle.metrics.created,
      evicted: sessionLifecycle.metrics.evicted,
      current: totalMcpSessions,
      inFlight: [...mcpSessions.values()].reduce((sum, s) => sum + s.inFlightRequests, 0),
      activeLongPolls: [...mcpSessions.values()].reduce((sum, s) => sum + s.activeLongPollCount, 0),
      activePolicyWaiters: [...mcpSessions.values()].reduce((sum, s) => sum + s.activePolicyWaiters, 0),
      activeSseStreams: sse.active,
      activeSseStreamsByClient: sse.byClient,
      policyWaiters: deps.policyWaiters.diagnostics(deps.listPendingApprovals),
      admission: {
        execution: executionAdmission,
        waiter: waiterAdmission,
      },
        executionAdmission: {
          ...executionAdmission,
          capacityRejectionsByTool: sessionLifecycle.mapNumberCounts(sessionLifecycle.capacityRejectionsByTool),
          capacityRejectionsByWeight: sessionLifecycle.mapNumberCounts(sessionLifecycle.capacityRejectionsByWeight),
          lastRejection: sessionLifecycle.lastCapacityRejection(),
      },
      waiterAdmission,
      timing: sessionLifecycle.mcpTimingDiagnostics(mcpWaiterAdmission.getStats().active),
      toolListDescriptorCache: toolListCacheDiagnostics()[0]?.metrics ?? { hits: 0, misses: 0 },
      workspaceAppResources: { ...deps.workspaceAppResourceMetrics },
      memoryPressure: sessionLifecycle.getMemoryPressureState(),
      memoryEstimate: sessionLifecycle.estimateMcpSessionMemoryCost(),
      reuse: sessionLifecycle.mcpSessionReuseMetrics(),
      policy: {
        unusedSessionIdleMs: config.mcpUnusedSessionIdleMs,
        ephemeralSessionIdleMs: config.mcpEphemeralSessionIdleMs,
        reusableSessionIdleMs: config.mcpReusableSessionIdleMs,
        sessionReaperIntervalMs: config.mcpSessionReaperIntervalMs,
        logicalContinuityRetentionMs: config.mcpLogicalContinuityRetentionMs,
        sessionMaxPerClient: config.mcpSessionMaxPerClient,
        sessionSoftCap: config.mcpSessionSoftCap,
        sessionHardCap: config.mcpSessionHardCap,
      },
      // Each entry is a separate transport/context. The aggregate logical
      // client label is deliberately not used as an ownership key.
      sessions: [...mcpSessions.values()]
        .sort((a, b) => a.lastApplicationActivityAt - b.lastApplicationActivityAt)
        .map((state) => ({
          sessionIdPrefix: sessionIdPrefix(state.sessionId),
          sessionLabel: state.sessionLabel,
          logicalClientId: state.logicalClientId,
          identitySource: state.identitySource,
          authenticatedRole: state.authenticatedRole,
          authSource: state.authSource,
          conversationId: state.conversationId,
          createdAt: new Date(state.createdAt).toISOString(),
          lastTransportActivityAt: new Date(state.lastTransportActivityAt).toISOString(),
          lastApplicationActivityAt: new Date(state.lastApplicationActivityAt).toISOString(),
          ageMs: Date.now() - state.createdAt,
          idleMs: Date.now() - state.lastApplicationActivityAt,
          transportIdleMs: Date.now() - state.lastTransportActivityAt,
          requestCount: state.requestCount,
          notificationCount: state.notificationCount,
          toolCallCount: state.toolCallCount,
          resourceReadCount: state.resourceReadCount,
          activeLongPollCount: state.activeLongPollCount,
          activeSseStreams: state.activeSseStreams,
          activePolicyWaiters: state.activePolicyWaiters,
          inFlightRequests: state.inFlightRequests,
          durableWorkerSession: state.durableWorkerSession,
          lastRpcMethod: state.lastRpcMethod,
          lastToolName: state.lastToolName,
        })),
      perClient: Object.entries([...mcpSessions.values()].reduce((acc, s) => {
        acc[s.logicalClientId] = (acc[s.logicalClientId] || 0) + 1;
        return acc;
      }, {} as Record<string, number>)).map(([client, count]) => ({ client, count })),
      // P1: approval continuity qualification needs to see whether real
      // connector traffic relies on the untrusted clientInfo fallback, which
      // cannot reattach a one-shot approval retry after a transport
      // replacement. Aggregate per identity source, not per session.
      identitySources: [...mcpSessions.values()].reduce((acc, s) => {
        acc[s.identitySource] = (acc[s.identitySource] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      logicalContinuity: {
        count: deps.logicalContinuity.size(),
        records: deps.logicalContinuity.snapshot(),
      },
    };

    // P1 #51: Report embedded build metadata (immutable artifact identity)
    // rather than the working tree state.
    let buildMeta: Record<string, unknown> | undefined;
    try {
      const metaPath = join(dirname(fileURLToPath(import.meta.url)), "build-meta.json");
      buildMeta = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch { /* ignore */ }

    return res.json({
      ok: true,
      name: "kontrol",
      // P0.3: build identity comes from the resolved deployment context,
      // never from an ambient process.env read inside a route handler.
      build: buildMeta ?? config.expectedBuildId ?? "dev",
      buildMeta,
      schema: schemaVersion,
      schemaExpected: LATEST_SCHEMA_VERSION,
      degradedAudit: deps.degradedAuditSnapshot(),
      dbSizeBytes,
      walSizeBytes,
      eventLogCount,
      outputDeltaCount,
      thoughtDeltaCount,
      activeWorkSessions,
      pendingReviews,
      activeAcps,
      processSessions: deps.processSessionMetrics(),
      totalMcpSessions,
      mcpSessionMetrics: mcpMetrics,
      startupRecovery: deps.startupRecovery,
      databaseIntegrity: deps.databaseIntegrity,
      maintenance: { ...deps.maintenanceStats },
      snapshotStore: await deps.snapshotStoreDiagnostics(),
      generation: generationRecord,
      supervisor: supervisorStatus,
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      rss: memUsage.rss,
      external: memUsage.external,
      uptimeMs: Math.round(performance.now()),
      memoryUsage: memUsage,
      pid: process.pid,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
