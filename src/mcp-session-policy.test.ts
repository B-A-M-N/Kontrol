import assert from "node:assert/strict";
import { mcpSessionIdleReason, mcpSessionIdleTtl } from "./mcp-session-policy.js";

const config = {
  mcpUnusedSessionIdleMs: 120_000,
  mcpEphemeralSessionIdleMs: 300_000,
  mcpReusableSessionIdleMs: 900_000,
};

// initialize + notifications/initialized + one tools/call has requestCount >=
// 2, but it remains an ephemeral one-tool session.
assert.equal(mcpSessionIdleTtl({ toolCallCount: 1, activeLongPollCount: 0, durableWorkerSession: false }, config), 300_000);
assert.equal(mcpSessionIdleReason({ toolCallCount: 1, activeLongPollCount: 0, durableWorkerSession: false }), "ephemeral_idle");

assert.equal(mcpSessionIdleTtl({ toolCallCount: 0, activeLongPollCount: 0, durableWorkerSession: false }, config), 120_000);
assert.equal(mcpSessionIdleReason({ toolCallCount: 0, activeLongPollCount: 0, durableWorkerSession: false }), "unused_idle");

assert.equal(mcpSessionIdleTtl({ toolCallCount: 2, activeLongPollCount: 0, durableWorkerSession: false }, config), 900_000);
assert.equal(mcpSessionIdleReason({ toolCallCount: 2, activeLongPollCount: 0, durableWorkerSession: false }), "normal_idle");

assert.equal(mcpSessionIdleTtl({ toolCallCount: 1, activeLongPollCount: 0, durableWorkerSession: true }, config), 900_000);
assert.equal(mcpSessionIdleTtl({ toolCallCount: 1, activeLongPollCount: 1, durableWorkerSession: false }, config), Number.POSITIVE_INFINITY);

console.log("mcp-session-policy.test.ts: all assertions passed");
