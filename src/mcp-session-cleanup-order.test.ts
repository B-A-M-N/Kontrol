import assert from "node:assert/strict";
import { createMcpSessionLifecycle } from "./server/mcp-session-lifecycle.js";
import { loadConfig } from "./config.js";
import { LogicalContinuityIndex } from "./mcp-logical-continuity.js";
import { ProcessSessionManager } from "./process-sessions.js";
import type { McpSessionState } from "./server/mcp-session-state.js";

const now = Date.now();
const config = loadConfig({
  KONTROL_ALLOWED_ROOTS: "/tmp",
  KONTROL_WORKTREE_ROOT: "/tmp/kontrol-cleanup-order-worktrees",
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_POLICY_MODE: "allow",
  PORT: "1",
});
const state: McpSessionState = {
  sessionId: "session-cleanup-order",
  sessionLabel: "mcp:client/mcp:session-cleanup-order",
  logicalClientId: "mcp:client",
  identitySource: "conversation",
  authenticatedRole: "client",
  authSource: "anonymous",
  conversationId: "conversation-cleanup-order",
  createdAt: now - 10_000,
  lastTransportActivityAt: now,
  lastApplicationActivityAt: now,
  inFlightRequests: 0,
  requestCount: 2,
  notificationCount: 0,
  toolCallCount: 1,
  resourceReadCount: 0,
  activeLongPollCount: 0,
  activeSseStreams: 1,
  activePolicyWaiters: 0,
  closing: false,
  closed: false,
  endRecorded: false,
  durableWorkerSession: false,
};
const sessions = new Map([[state.sessionId, state]]);
let clearCount = 0;
const lifecycle = createMcpSessionLifecycle({
  config,
  cancelPolicyWaitersForSession: () => 0,
  mcpSessions: sessions,
  transports: new Map(),
  logicalContinuity: new LogicalContinuityIndex(),
  processSessions: new ProcessSessionManager({ childEnvironmentAllowlist: [] }),
  workspaceAppResourceMetrics: {
    currentHashed: 0,
    openAiCompatibility: 0,
    legacyKontrol: 0,
    devDesktopMigration: 0,
    servedTotal: 0,
    lastDurationMs: 0,
    maxDurationMs: 0,
    admissionRejections: 0,
    active: 0,
    maxActive: 0,
    lastWireBytes: 0,
    lastEventLoopDelayMs: 0,
    maxEventLoopDelayMs: 0,
  } as any,
  clearWorkspaceSessionState: () => { clearCount += 1; },
});

assert.equal(lifecycle.finalizeMcpSession(state.sessionId, "expired"), false,
  "an active SSE stream must prevent expiration finalization");
assert.equal(clearCount, 0, "rejected expiration must not clear active workspace state");
assert.equal(sessions.has(state.sessionId), true, "rejected expiration must retain the session");
state.activeSseStreams = 0;
assert.equal(lifecycle.finalizeMcpSession(state.sessionId, "expired"), true,
  "an inactive session must finalize");
assert.equal(clearCount, 1, "successful finalization must clear workspace state");
assert.equal(sessions.has(state.sessionId), false, "successful finalization removes the session");
clearInterval(lifecycle.reaper);
clearInterval(lifecycle.memorySampler);
console.log("mcp-session-cleanup-order.test.ts: all assertions passed");
