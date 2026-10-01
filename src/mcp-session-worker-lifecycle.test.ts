import assert from "node:assert/strict";
import { createMcpSessionLifecycle } from "./server/mcp-session-lifecycle.js";
import { loadConfig } from "./config.js";
import { LogicalContinuityIndex } from "./mcp-logical-continuity.js";
import { ProcessSessionManager } from "./process-sessions.js";
import type { McpSessionState } from "./server/mcp-session-state.js";

const config = loadConfig({
  KONTROL_ALLOWED_ROOTS: "/tmp",
  KONTROL_WORKTREE_ROOT: "/tmp/kontrol-worker-lifecycle-worktrees",
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_POLICY_MODE: "allow",
  KONTROL_MCP_SESSION_SOFT_CAP: "1",
  KONTROL_MCP_SESSION_HARD_CAP: "2",
  KONTROL_MCP_SESSION_MAX_PER_CLIENT: "2",
  KONTROL_MCP_SESSION_RECLAIM_GRACE_MS: "1",
  PORT: "1",
});
const now = Date.now();
const state: McpSessionState = { sessionId: "worker-session", sessionLabel: "mcp:client/worker-session", logicalClientId: "mcp:client", identitySource: "conversation", authenticatedRole: "worker", authSource: "worker_token", workSessionId: "work-session", createdAt: now, lastTransportActivityAt: now - 2 * 86_400_000, lastApplicationActivityAt: now - 2 * 86_400_000, inFlightRequests: 0, requestCount: 1, notificationCount: 0, toolCallCount: 1, resourceReadCount: 0, activeLongPollCount: 0, activeSseStreams: 0, activePolicyWaiters: 0, closing: false, closed: false, endRecorded: false, durableWorkerSession: true };
const idleClient: McpSessionState = { sessionId: "idle-client-session", sessionLabel: "mcp:client/idle-client", logicalClientId: "mcp:idle-client", identitySource: "conversation", authenticatedRole: "client", authSource: "anonymous", createdAt: now, lastTransportActivityAt: now - 2 * 86_400_000, lastApplicationActivityAt: now, inFlightRequests: 0, requestCount: 2, notificationCount: 0, toolCallCount: 2, resourceReadCount: 0, activeLongPollCount: 0, activeSseStreams: 0, activePolicyWaiters: 0, closing: false, closed: false, endRecorded: false, durableWorkerSession: false };
const sessions = new Map([[state.sessionId, state], [idleClient.sessionId, idleClient]]);
let workActive = true;
const lifecycle = createMcpSessionLifecycle({ config, cancelPolicyWaitersForSession: () => 0, mcpSessions: sessions, transports: new Map(), mcpServers: new Map(), logicalContinuity: new LogicalContinuityIndex(), processSessions: new ProcessSessionManager({ childEnvironmentAllowlist: [] }), workspaceAppResourceMetrics: { currentHashed: 0, openAiCompatibility: 0, legacyKontrol: 0, servedTotal: 0, lastDurationMs: 0, maxDurationMs: 0, admissionRejections: 0, active: 0, maxActive: 0, lastWireBytes: 0, lastEventLoopDelayMs: 0, maxEventLoopDelayMs: 0 } as any, isDurableWorkerSessionActive: (candidate) => candidate.sessionId === state.sessionId && workActive, clearWorkspaceSessionState: () => {} });
assert.equal(state.durableWorkerSession, true, "worker-bound session is durable");
lifecycle.reapIdleMcpSessions();
assert.equal(sessions.has(state.sessionId), true, "active worker work remains protected past the transport TTL");
assert.equal(sessions.has(idleClient.sessionId), false, "soft-cap reclaim may evict an idle client but not the active worker");
workActive = false;
lifecycle.reapIdleMcpSessions();
assert.equal(sessions.has(state.sessionId), false, "terminal worker work eventually becomes ordinary idle-session cleanup");
clearInterval(lifecycle.reaper); clearInterval(lifecycle.memorySampler);
console.log("mcp-session-worker-lifecycle.test.ts: all assertions passed");
