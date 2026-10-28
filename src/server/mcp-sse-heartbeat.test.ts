import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startMcpSseHeartbeat } from "./mcp-sse-heartbeat.js";

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writes: boolean[] = [];
  write(): boolean { return this.writes.shift() ?? true; }
  destroy(): void { this.destroyed = true; this.emit("close"); }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await wait(10);
  }
  return true;
}

const stuck = new FakeResponse();
stuck.writes = [false];
let timedOut: any;
let timedOutAt = 0;
let stalledAt = 0;
const stopStuck = startMcpSseHeartbeat(stuck, 5, () => { stalledAt = performance.now(); }, () => {}, undefined, {
  maxStallMs: 20,
  onStallTimeout: (details) => { timedOut = details; timedOutAt = performance.now(); },
});
assert.equal(await waitFor(() => stuck.destroyed, 1_000), true, "a permanently stalled response is destroyed within a bounded deadline");
assert.ok(timedOutAt - stalledAt >= 20, "the response is not destroyed before its configured stall deadline");
assert.ok(timedOutAt - stalledAt < 1_000, "the stall timeout remains bounded under runner scheduling delays");
assert.equal(timedOut.consecutiveStallCount, 1);
assert.equal(stuck.listenerCount("drain"), 0, "timeout removes the drain listener");
stopStuck();

const recovered = new FakeResponse();
recovered.writes = [false, true];
let stalls = 0;
let drains = 0;
const stopRecovered = startMcpSseHeartbeat(recovered, 5, () => { stalls += 1; }, () => { drains += 1; }, undefined, { maxStallMs: 50 });
await wait(8);
recovered.emit("drain");
await wait(8);
assert.equal(stalls, 1);
assert.equal(drains, 1);
assert.equal(recovered.destroyed, false, "drain before deadline recovers the stream");
stopRecovered();
assert.equal(recovered.listenerCount("drain"), 0);

const closed = new FakeResponse();
closed.writes = [false];
const stopClosed = startMcpSseHeartbeat(closed, 5, () => {}, () => {}, undefined, { maxStallMs: 50 });
await wait(8);
closed.destroy();
stopClosed();
await wait(60);
assert.equal(closed.destroyed, true);
assert.equal(closed.listenerCount("drain"), 0, "socket close cleanup is safe before stall expiry");

console.log("mcp-sse-heartbeat.test.ts: bounded stall and cleanup assertions passed");
