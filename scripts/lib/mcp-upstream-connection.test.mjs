import assert from "node:assert/strict";
import { McpUpstreamConnection } from "./mcp-upstream-connection.mjs";

let available = true;
const clients = [];
const states = [];
const manager = new McpUpstreamConnection({
  createClient() {
    const client = {
      onclose: null,
      async connect() {
        clients.push(client);
        if (!available) throw new Error("upstream unavailable");
      },
      async close() {},
    };
    return { client, transport: {} };
  },
  onState: (state) => states.push(state),
  baseDelayMs: 1,
  maxDelayMs: 2,
  recoveryWindowMs: 100,
  maxAttempts: 4,
  random: () => 0,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

await manager.start();
assert.equal(manager.state, "READY");
const firstClient = manager.requireClient();
available = false;
firstClient.onclose();
assert.throws(() => manager.requireClient(), /upstream is reconnecting|upstream is degraded/);
await new Promise((resolve) => setTimeout(resolve, 3));
available = true;
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(manager.state, "READY");
assert.notEqual(manager.requireClient(), firstClient, "recovery creates a new upstream client and session");
assert.ok(states.includes("DEGRADED"));
assert.ok(states.includes("RECONNECTING"));
await manager.close();
assert.equal(manager.state, "STOPPED");

const offline = new McpUpstreamConnection({
  createClient() {
    return { client: { async connect() { throw new Error("offline"); }, async close() {} }, transport: {} };
  },
  maxAttempts: 4,
  baseDelayMs: 10_000,
  recoveryWindowMs: 10_000,
});
await offline.start();
const closeStartedAt = Date.now();
await offline.close();
assert.ok(Date.now() - closeStartedAt < 250, "shutdown cancels an in-flight reconnect backoff immediately");
assert.equal(offline.state, "STOPPED");

const candidate = { id: "endpoint-a" };
const qualificationOrder = [];
const qualified = new McpUpstreamConnection({
  createClient() {
    return {
      candidate,
      client: {
        async connect() { qualificationOrder.push("connect"); },
        async close() {},
      },
      transport: {},
    };
  },
  async prepareCandidate(selected) { assert.equal(selected, candidate); qualificationOrder.push("prepare"); },
  async qualifyClient(_client, selected) { assert.equal(selected, candidate); qualificationOrder.push("qualify"); },
  onConnectResult(selected, ok) { assert.equal(selected, candidate); assert.equal(ok, true); qualificationOrder.push("result"); },
});
await qualified.start();
assert.equal(qualified.state, "READY");
assert.deepEqual(qualificationOrder, ["prepare", "connect", "qualify", "result"], "resource preflight and MCP qualification must precede READY");
await qualified.close();
console.log("mcp-upstream-connection.test.mjs: recovery and shutdown assertions passed");
