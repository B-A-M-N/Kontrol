import assert from "node:assert/strict";
import { createMcpSessionLifecycle } from "./mcp-session-lifecycle.js";
import { loadConfig } from "../config.js";
import { LogicalContinuityIndex } from "../mcp-logical-continuity.js";
import { ProcessSessionManager } from "../process-sessions.js";

const config = loadConfig({
  KONTROL_ALLOWED_ROOTS: "/tmp",
  KONTROL_WORKTREE_ROOT: "/tmp/kontrol-metrics-worktrees",
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_POLICY_MODE: "allow",
  KONTROL_MCP_CLIENT_METRICS_HISTORY_LIMIT: "64",
  PORT: "1",
});
const lifecycle = createMcpSessionLifecycle({
  config,
  cancelPolicyWaitersForSession: () => 0,
  mcpSessions: new Map(),
  transports: new Map(),
  mcpServers: new Map(),
  logicalContinuity: new LogicalContinuityIndex(),
  processSessions: new ProcessSessionManager({ childEnvironmentAllowlist: [] }),
  workspaceAppResourceMetrics: {} as any,
  clearWorkspaceSessionState: () => undefined,
});

const startAndEnd = (client: string, toolCalls: number, lifetimeMs: number) => {
  const createdAt = Date.now();
  lifecycle.recordMcpSessionCreated(client, createdAt);
  lifecycle.recordMcpSessionEnd({
    logicalClientId: client,
    sessionId: `${client}-session`,
    createdAt,
    toolCallCount: toolCalls,
    endRecorded: false,
    closed: false,
  } as any, "client_closed", createdAt + lifetimeMs);
};

// Fill the historical sample, then make the last 10,000 observations differ
// from the lifetime population so mean numerator and denominator must agree.
for (let index = 0; index < 90_000; index++) startAndEnd(`client-${index}`, 1, 10);
for (let index = 90_000; index < 100_000; index++) startAndEnd(`client-${index}`, 0, 10);
assert.equal(lifecycle.metrics.clients.size, 64, "inactive client metric memory plateaus at the configured history limit");
assert.equal(lifecycle.metrics.retiredClientCount, 99_936);
assert.equal(lifecycle.metrics.retiredClientTotals.sessionsClosed + lifecycle.metrics.retiredClientTotals.sessionsExpired, 99_936,
  "retired client counters are folded into lifetime totals before rows are removed");

startAndEnd("repeat-client", 0, 10);
startAndEnd("repeat-client", 0, 30);
const repeatedMetrics = (lifecycle.mcpSessionReuseMetrics() as any).perClient.find((entry: any) => entry.client === "repeat-client");
assert.equal(repeatedMetrics.averageLifetimeMs, 20, "per-client lifetime average divides by that client's completed sessions");
const summary = lifecycle.mcpSessionReuseMetrics();
assert.equal(summary.zeroToolSessions, 10_002);
assert.equal(summary.singleToolSessions, 90_000);
assert.equal(summary.toolCallsPerSessionMean, 0,
  "global rolling mean uses both numerator and denominator from the capped 10,000-sample population");

for (let index = 0; index < 100; index++) lifecycle.recordMcpSessionCreated(`active-${index}`);
assert.equal(lifecycle.metrics.retainedHistoricalClientCount, 64, "adding active clients does not consume the historical retention budget");
assert.equal(lifecycle.metrics.clients.size, 164, "active clients remain exact even when their count exceeds the history cap");
assert.equal((lifecycle.mcpSessionReuseMetrics() as any).perClient.filter((entry: any) => entry.client.startsWith("active-")).length, 100);

clearInterval(lifecycle.reaper);
clearInterval(lifecycle.memorySampler);
console.log("mcp-session-metrics.test.ts: bounded retention and aggregate assertions passed");
