// Real wall-clock stable-beta soak runner.
//
// This intentionally does not choose a default duration. Operators must make
// the time commitment explicit (for example --hours 12), and the report keeps
// enough counters to distinguish a clean run from an interrupted or partially
// reachable run. Every MCP transport opened by the soak is closed; continuity
// is exercised by opening a fresh transport on each iteration.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const hours = Number(option("--hours"));
if (!Number.isFinite(hours) || hours <= 0) {
  throw new Error("Usage: beta-soak.mjs --hours HOURS [--url URL] [--interval-ms MS] [--report PATH] [--conversation ID] [--workspace-path PATH] [--build-id BUILD_ID] [--diagnostics-secret SECRET] [--tunnel-url URL]");
}
const baseUrl = String(option("--url", "http://127.0.0.1:7676")).replace(/\/$/, "");
const intervalMs = Math.max(250, Number(option("--interval-ms", "5000")));
const reportPath = resolve(String(option("--report", `${root}/beta-soak.json`)));
const conversationId = String(option("--conversation", `beta-soak-${process.pid}`));
const workspacePath = option("--workspace-path");
const readPath = String(option("--read-path", "AGENTS.md"));
const diagnosticsSecret = option("--diagnostics-secret", process.env.KONTROL_DIAGNOSTICS_SECRET);
const tunnelUrl = String(option("--tunnel-url", process.env.KONTROL_BETA_TUNNEL_URL ?? "http://127.0.0.1:8080")).replace(/\/$/, "");
const expectedBuildId = option("--build-id", process.env.KONTROL_BETA_BUILD_ID);
const skipDiagnostics = process.argv.includes("--skip-diagnostics");
const skipTunnel = process.argv.includes("--skip-tunnel");
const deadline = Date.now() + hours * 60 * 60_000;
let stopping = false;

const report = {
  kind: "kontrol-beta-wall-clock-soak",
  startedAt: new Date().toISOString(),
  requestedHours: hours,
  targetUrl: baseUrl,
  intervalMs,
  conversationId,
  expectedBuildId,
  status: "running",
  iterations: 0,
  successes: 0,
  failures: 0,
  transientFailures: 0,
  staleRouteFailures: 0,
  latencyMs: [],
  transportDrops: 0,
  reconnects: 0,
  tunnelChecks: 0,
  tunnelFailures: 0,
  tunnelLastError: undefined,
  monitoring: {
    diagnosticsRequired: !skipDiagnostics,
    tunnelRequired: !skipTunnel,
    tunnelUrl: skipTunnel ? undefined : tunnelUrl,
  },
  snapshots: { started: undefined, finished: undefined },
  assertions: {},
  lastError: undefined,
};

function persist() {
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
  const temporary = `${reportPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, reportPath);
}

function classifyFailure(error) {
  const status = error?.status;
  const normalizedStatus = Number.isInteger(status) ? status : 0;
  if (normalizedStatus === 404) report.staleRouteFailures++;
  else if (normalizedStatus === 429 || normalizedStatus >= 500 || normalizedStatus === 0) report.transientFailures++;
}

async function requestAt(origin, path, init = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} from ${path}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function request(path, init = {}) {
  return requestAt(baseUrl, path, init);
}

async function diagnostics() {
  if (skipDiagnostics) return undefined;
  if (!diagnosticsSecret) throw new Error("stable-beta soak requires KONTROL_DIAGNOSTICS_SECRET or --diagnostics-secret (use --skip-diagnostics only for transport-only diagnostics)");
  const response = await request("/diagnostics", { headers: { "x-kontrol-diagnostics": diagnosticsSecret } });
  return await response.json();
}

function summarizeDiagnostics(value) {
  if (!value) return undefined;
  const supervisor = value.supervisor;
  const components = supervisor?.components ?? {};
  const componentRestartCount = (name) => Number(components[name]?.totalRestartCount ?? components[name]?.restartCount ?? 0);
  return {
    diagnosticsContract: Boolean(
      value.buildMeta
      && value.databaseIntegrity
      && value.maintenance
      && value.mcpSessionMetrics
      && value.processSessions,
    ),
    pid: value.pid,
    buildId: value.buildMeta?.buildId ?? value.build?.buildId,
    gitSha: value.buildMeta?.gitSha,
    gitDirty: value.buildMeta?.gitDirty,
    schema: value.schema,
    schemaExpected: value.schemaExpected,
    databaseIntegrity: value.databaseIntegrity ? {
      ok: value.databaseIntegrity.ok,
      status: value.databaseIntegrity.status,
      timedOut: value.databaseIntegrity.timedOut,
    } : undefined,
    supervisor: supervisor ? {
      state: supervisor.state,
      totalRestartCount: Number(supervisor.totalRestartCount ?? supervisor.restartCount ?? 0),
      totalRestartFailures: Number(supervisor.totalRestartFailures ?? 0),
      coreRestarts: componentRestartCount("kontrol"),
      tunnelRestarts: componentRestartCount("tunnel"),
      adapterRestarts: componentRestartCount("crush") + componentRestartCount("hermes"),
    } : undefined,
    sessions: {
      current: Number(value.mcpSessionMetrics?.current ?? value.totalMcpSessions ?? 0),
      logicalContinuity: Number(value.mcpSessionMetrics?.logicalContinuity?.count ?? 0),
      activePolicyWaiters: Number(value.mcpSessionMetrics?.policyWaiters?.activePolicyWaiters ?? 0),
      pendingApprovalRows: Number(value.mcpSessionMetrics?.policyWaiters?.pendingApprovalRows ?? 0),
      orphanedPendingApprovals: Number(value.mcpSessionMetrics?.policyWaiters?.orphanedPendingApprovals ?? 0),
      // P1: approval continuity qualification. A session whose identity
      // degrades to client_info_fallback cannot reattach a one-shot approval
      // retry after a transport replacement, so the soak must record what the
      // real connector traffic actually resolved to.
      identitySources: value.mcpSessionMetrics?.identitySources ?? {},
    },
    processSessions: value.processSessions ? {
      running: Number(value.processSessions.running ?? 0),
      total: Number(value.processSessions.total ?? 0),
    } : undefined,
    maintenance: value.maintenance ? {
      backlog: Boolean(value.maintenance.backlog),
      lastError: value.maintenance.lastError,
      maxDurationMs: Number(value.maintenance.maxDurationMs ?? 0),
    } : undefined,
    dbSizeBytes: Number(value.dbSizeBytes ?? 0),
    walSizeBytes: Number(value.walSizeBytes ?? 0),
    generation: value.generation ? {
      status: value.generation.status,
      activeBuildId: value.generation.activeBuildId,
    } : undefined,
  };
}

async function collectSnapshot() {
  const value = await diagnostics();
  const summary = summarizeDiagnostics(value);
  if (summary) {
    report.snapshots.last = summary;
    report.monitoring.max = report.monitoring.max ?? {};
    for (const key of ["current", "logicalContinuity", "activePolicyWaiters", "pendingApprovalRows", "orphanedPendingApprovals"]) {
      report.monitoring.max[`sessions.${key}`] = Math.max(report.monitoring.max[`sessions.${key}`] ?? 0, summary.sessions[key]);
    }
    if (summary.supervisor) {
      for (const key of ["totalRestartCount", "totalRestartFailures", "coreRestarts", "tunnelRestarts", "adapterRestarts"]) {
        report.monitoring.max[`supervisor.${key}`] = Math.max(report.monitoring.max[`supervisor.${key}`] ?? 0, summary.supervisor[key]);
      }
    }
  }
  return summary;
}

function parseRpc(text) {
  const data = text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return JSON.parse(data || text);
}

async function rpc(method, params, sessionId) {
  const response = await request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-kontrol-conversation-id": conversationId,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: `${process.pid}-${report.iterations}`, method, params }),
  });
  const payload = parseRpc(await response.text());
  if (payload.error) {
    const error = new Error(payload.error.message ?? `JSON-RPC ${payload.error.code ?? "error"}`);
    error.status = response.status;
    throw error;
  }
  return { payload, sessionId: response.headers.get("mcp-session-id") ?? sessionId };
}

async function closeSession(sessionId) {
  if (!sessionId) return;
  try {
    await request("/mcp", { method: "DELETE", headers: { "mcp-session-id": sessionId } });
  } catch (error) {
    // A disconnected transport is itself one of the conditions this soak is
    // measuring. Do not turn cleanup of an already-dead session into a second
    // iteration failure.
    if (error?.status !== 404) throw error;
  }
}

async function dropTransport(sessionId) {
  const response = await request("/mcp", {
    headers: { accept: "text/event-stream", "mcp-session-id": sessionId },
  });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} from SSE transport`);
    error.status = response.status;
    throw error;
  }
  await response.body?.cancel();
}

async function checkTunnel() {
  if (skipTunnel) return;
  report.tunnelChecks += 2;
  try {
    await requestAt(tunnelUrl, "/healthz");
    await requestAt(tunnelUrl, "/readyz");
  } catch (error) {
    report.tunnelFailures++;
    report.tunnelLastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

async function iteration() {
  const started = Date.now();
  let sessionId;
  try {
    await request("/healthz");
    await request("/core-readyz");
    await request("/readyz");
    await checkTunnel();
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "kontrol-beta-soak", version: "1" },
    });
    sessionId = initialized.sessionId;
    if (!sessionId) throw new Error("initialize did not return mcp-session-id");
    await rpc("notifications/initialized", {}, sessionId);
    await rpc("tools/list", {}, sessionId);
    if (workspacePath) {
      const opened = await rpc("tools/call", {
        name: "open_workspace",
        arguments: { path: workspacePath, mode: "checkout" },
      }, sessionId);
      const workspaceId = opened.payload?.result?.structuredContent?.workspaceId;
      if (!workspaceId) throw new Error("open_workspace returned no workspaceId");
      await rpc("tools/call", {
        name: "read",
        arguments: { workspaceId, path: readPath },
      }, sessionId);
    }
    // Every tenth iteration deliberately drops the live SSE transport before
    // opening a fresh MCP transport with the same trusted conversation. This
    // catches route/session continuity regressions that orderly DELETE misses.
    if (report.iterations > 0 && report.iterations % 10 === 0) {
      await dropTransport(sessionId);
      report.transportDrops++;
      sessionId = undefined;
      const reconnected = await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "kontrol-beta-soak", version: "1" },
      });
      sessionId = reconnected.sessionId;
      if (!sessionId) throw new Error("reconnect initialize did not return mcp-session-id");
      report.reconnects++;
      await rpc("notifications/initialized", {}, sessionId);
      await rpc("tools/list", {}, sessionId);
    }
    await collectSnapshot();
    report.successes++;
  } catch (error) {
    report.failures++;
    report.lastError = error instanceof Error ? error.message : String(error);
    classifyFailure(error);
    console.error(`[beta-soak] iteration ${report.iterations + 1} failed: ${report.lastError}`);
  } finally {
    try { await closeSession(sessionId); } catch (error) {
      report.lastError = `session cleanup: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  report.iterations++;
  report.latencyMs.push(Date.now() - started);
  if (report.latencyMs.length > 10_000) report.latencyMs.shift();
  persist();
}

function stop() {
  stopping = true;
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

if (!skipDiagnostics) {
  try {
    report.snapshots.started = await collectSnapshot();
  } catch (error) {
    report.status = "failed";
    report.lastError = `initial diagnostics: ${error instanceof Error ? error.message : String(error)}`;
    report.finishedAt = new Date().toISOString();
    persist();
    console.error(`[beta-soak] FAILED before first iteration: ${report.lastError}`);
    process.exit(1);
  }
}
persist();
console.log(`[beta-soak] running for ${hours}h against ${baseUrl}; report=${reportPath}`);
while (!stopping && Date.now() < deadline) {
  await iteration();
  if (!stopping && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
}

report.finishedAt = new Date().toISOString();
try {
  report.snapshots.finished = await collectSnapshot();
} catch (error) {
  report.failures++;
  report.lastError = `final diagnostics: ${error instanceof Error ? error.message : String(error)}`;
}
const startedSnapshot = report.snapshots.started;
const finishedSnapshot = report.snapshots.finished;
if (startedSnapshot && finishedSnapshot) {
  const startSupervisor = startedSnapshot.supervisor ?? {};
  const finishSupervisor = finishedSnapshot.supervisor ?? {};
  const delta = (key) => Number(finishSupervisor[key] ?? 0) - Number(startSupervisor[key] ?? 0);
  report.assertions = {
    noUnexpectedCoreRestarts: delta("coreRestarts") === 0,
    noUnexpectedSupervisorRestarts: delta("totalRestartCount") === 0,
    noUnexpectedTunnelRestarts: delta("tunnelRestarts") === 0,
    noUnexpectedAdapterRestarts: delta("adapterRestarts") === 0,
    noRestartFailures: delta("totalRestartFailures") === 0,
    noOrphanedApprovals: finishedSnapshot.sessions.orphanedPendingApprovals === 0,
    noPendingApprovalRows: finishedSnapshot.sessions.pendingApprovalRows === 0,
    noLivePolicyWaiters: finishedSnapshot.sessions.activePolicyWaiters === 0,
    noLeakedProcessSessions: (finishedSnapshot.processSessions?.running ?? 0) === 0,
    diagnosticsContract: finishedSnapshot.diagnosticsContract === true,
    tunnelEndpointsHealthy: report.tunnelFailures === 0 && report.tunnelChecks > 0,
    databaseIntegrityHealthy: finishedSnapshot.databaseIntegrity?.ok === true
      && finishedSnapshot.databaseIntegrity?.status === "healthy"
      && finishedSnapshot.databaseIntegrity?.timedOut !== true,
    noMaintenanceError: !finishedSnapshot.maintenance?.lastError,
    schemaConsistent: finishedSnapshot.schema === finishedSnapshot.schemaExpected,
    buildIdentityConsistent: Boolean(finishedSnapshot.buildId)
      && (!report.expectedBuildId || finishedSnapshot.buildId === report.expectedBuildId)
      && (!startedSnapshot.buildId || startedSnapshot.buildId === finishedSnapshot.buildId),
    sourceIdentityConsistent: (!startedSnapshot.gitSha || !finishedSnapshot.gitSha || startedSnapshot.gitSha === finishedSnapshot.gitSha)
      && (finishedSnapshot.gitDirty === undefined || Number(finishedSnapshot.gitDirty) === 0),
    continuityBounded: finishedSnapshot.sessions.logicalContinuity
      <= startedSnapshot.sessions.logicalContinuity + 1,
    // P1: real connector traffic must carry trusted conversation correlation.
    // Every session the soak created should resolve to a trusted identity
    // source; a client_info_fallback session here means approval continuity
    // degraded to an untrusted fingerprint and one-shot approvals could
    // re-prompt after a transport replacement.
    approvalContinuityCapable: Number(
      finishedSnapshot.sessions.identitySources?.client_info_fallback ?? 0,
    ) === 0
      && Number(finishedSnapshot.sessions.current ?? 0) > 0,
  };
}
report.status = stopping ? "interrupted" : (report.failures === 0 ? "passed" : "failed");
if (Object.keys(report.assertions).length > 0 && !Object.values(report.assertions).every(Boolean)) report.status = "failed";
report.p95LatencyMs = report.latencyMs.length > 0
  ? [...report.latencyMs].sort((a, b) => a - b)[Math.min(report.latencyMs.length - 1, Math.floor(report.latencyMs.length * 0.95))]
  : null;
persist();
console.log(`[beta-soak] ${report.status.toUpperCase()} iterations=${report.iterations} successes=${report.successes} failures=${report.failures}`);
if (report.status !== "passed") process.exitCode = 1;
