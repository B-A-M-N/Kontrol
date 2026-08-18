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

const timeoutAdmission = new McpAdmission(1, 1, 1);
const held = await timeoutAdmission.acquire("held", 100);
assert.ok(held);
assert.equal(await timeoutAdmission.acquire("waiting", 5), null, "queued requests have a bounded wait");
held();
timeoutAdmission.close();
assert.equal(timeoutAdmission.getStats().queued, 0);

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

console.log("server-admission.test.ts: all assertions passed");
