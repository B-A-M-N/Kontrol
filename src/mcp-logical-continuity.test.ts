import assert from "node:assert/strict";
import { LogicalContinuityIndex } from "./mcp-logical-continuity.js";

const index = new LogicalContinuityIndex({
  retentionMs: 100,
  maxEntries: 4,
  maxDetachedTransports: 2,
});

const first = index.attach({
  identity: "conversation:alpha",
  source: "conversation",
  transportId: "transport-a",
  at: 0,
});
assert.equal(first.reconnect, false);
assert.equal(first.activeTransportCount, 1);

// A second live transport gets isolated state; continuity metadata must not
// turn the two MCP transports into one shared request/authorization context.
const duplicate = index.attach({
  identity: "conversation:alpha",
  source: "conversation",
  transportId: "transport-b",
  at: 1,
});
assert.equal(duplicate.reconnect, false);
assert.equal(duplicate.activeTransportCount, 2);

assert.equal(index.detach("conversation:alpha", "transport-a", 2), true);
const reconnect = index.attach({
  identity: "conversation:alpha",
  source: "conversation",
  transportId: "transport-c",
  at: 3,
});
assert.equal(reconnect.reconnect, true);
assert.equal(reconnect.predecessorTransportId, "transport-a");
assert.equal(reconnect.activeTransportCount, 2);

// Generic clientInfo fallback identities are never passed to this index by
// the server. If a caller did provide one, the type itself makes the trust
// boundary explicit rather than silently treating it as durable continuity.
assert.equal(index.detach("conversation:alpha", "transport-b", 4), true);
assert.equal(index.detach("conversation:alpha", "transport-c", 5), true);
assert.equal(index.snapshot(50)[0]?.detachedTransportCount, 2);
assert.equal(index.sweep(106), 1);
assert.equal(index.size(), 0);

const expiredIdentities: string[] = [];
const cleanupIndex = new LogicalContinuityIndex({
  retentionMs: 10,
  maxEntries: 4,
  onExpire: (identity) => expiredIdentities.push(identity),
});
cleanupIndex.attach({
  identity: "conversation:cleanup",
  source: "conversation",
  transportId: "transport-cleanup",
  at: 0,
});
cleanupIndex.detach("conversation:cleanup", "transport-cleanup", 1);
assert.equal(cleanupIndex.sweep(11), 1);
assert.deepEqual(expiredIdentities, ["conversation:cleanup"], "continuity expiry must notify the owner cleanup boundary");

console.log("mcp-logical-continuity.test.ts: all assertions passed");
