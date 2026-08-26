import assert from "node:assert/strict";
import { McpAdmission } from "./server.js";

const admission = new McpAdmission(1, 1, 1);
const first = await admission.acquire("session-a", 100);
assert.ok(first);

const queued = admission.acquire("session-a", 100);
assert.deepEqual(admission.getStats(), {
  active: 1,
  queued: 1,
  maxInflight: 1,
  maxInflightPerKey: 1,
  maxQueue: 1,
});

assert.equal(await admission.acquire("session-b", 100), null, "a full queue rejects immediately");
first();
const second = await queued;
assert.ok(second, "a released slot drains the queue");
second();
assert.equal(admission.getStats().active, 0);

// Weighted admission protects lightweight control traffic from a small number
// of expensive repository operations while retaining the request-count stats.
const weightedAdmission = new McpAdmission(4, 4, 2);
const heavy = await weightedAdmission.acquire("session-heavy", 100, 3);
const light = await weightedAdmission.acquire("session-light", 100, 1);
assert.ok(heavy && light);
const weightedQueue = weightedAdmission.acquire("session-next", 100, 2);
assert.equal(weightedAdmission.getStats().active, 2);
assert.equal(weightedAdmission.getStats().queued, 1);
light?.();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(weightedAdmission.getStats().queued, 1, "a queued operation must wait until its full weight is available");
heavy?.();
assert.ok(await weightedQueue, "weighted queue drains after enough capacity is released");
weightedAdmission.close();

const timeoutAdmission = new McpAdmission(1, 1, 1);
const held = await timeoutAdmission.acquire("held", 100);
assert.ok(held);
assert.equal(await timeoutAdmission.acquire("waiting", 5), null, "queued requests have a bounded wait");
held();
timeoutAdmission.close();
assert.equal(timeoutAdmission.getStats().queued, 0);

// A browser/tab/host can disappear while its request is waiting for a slot.
// That waiter must leave immediately instead of occupying the bounded queue
// until the admission deadline and delaying a later reconnect.
const abortAdmission = new McpAdmission(1, 1, 1);
const abortHeld = await abortAdmission.acquire("held", 100);
assert.ok(abortHeld);
const abortController = new AbortController();
const abortedWaiter = abortAdmission.acquire("disconnected", 60_000, 1, abortController.signal);
assert.equal(abortAdmission.getStats().queued, 1);
abortController.abort();
assert.equal(await abortedWaiter, null, "disconnected queued requests are cancelled immediately");
assert.equal(abortAdmission.getStats().queued, 0, "aborted requests do not occupy admission capacity");
abortHeld?.();
abortAdmission.close();

// Reliability fixture: a burst from 1,000 logical clients must remain bounded
// in both active work and queued waiters. The remainder is rejected without
// allocating an unbounded promise backlog.
const burstAdmission = new McpAdmission(32, 8, 128);
const burst = Array.from({ length: 1_000 }, (_, index) => burstAdmission.acquire(`burst-${index}`, 1_000));
await new Promise<void>((resolve) => setImmediate(resolve));
const burstStats = burstAdmission.getStats();
assert.ok(burstStats.active <= 32, "global active admission cap is enforced under a 1,000-client burst");
assert.ok(burstStats.queued <= 128, "global admission queue is bounded under a 1,000-client burst");
const initialLeases = await Promise.all(burst.slice(0, 32));
assert.equal(initialLeases.filter((lease) => typeof lease === "function").length, 32, "the first burst is admitted as bounded leases");
initialLeases.forEach((lease) => lease?.());
burstAdmission.close();

// Long-poll waiters have an independent budget: parked review/event calls do
// not consume execution permits needed by read/edit/bash traffic.
const executionAdmission = new McpAdmission(1, 1, 0);
const waiterAdmission = new McpAdmission(1, 1, 0);
const executionLease = await executionAdmission.acquire("tool-session", 10);
const waiterLease = await waiterAdmission.acquire("ui-session", 10);
assert.ok(executionLease, "execution admission grants normal work");
assert.ok(waiterLease, "waiter admission grants a parked wait independently");
executionLease?.();
waiterLease?.();
executionAdmission.close();
waiterAdmission.close();

console.log("server-admission.test.ts: all assertions passed");
