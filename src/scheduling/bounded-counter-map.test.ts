import assert from "node:assert/strict";
import { BoundedCounterMap } from "./bounded-counter-map.js";

const counters = new BoundedCounterMap(256);
for (let index = 0; index < 100_000; index++) counters.set(`failure-${index}`, index + 1, index);
assert.equal(counters.size, 256, "historical failure fingerprints stay within the configured in-memory bound");

counters.set("repeat", 1, 200_000);
assert.equal(counters.get("repeat", 200_010, 300_000), 1);
counters.set("repeat", 2, 200_010);
assert.equal(counters.get("repeat", 200_020, 300_000), 2, "recent repeated fingerprints retain their recurrence count");
assert.equal(counters.get("repeat", 500_011, 300_000), undefined, "expired fingerprints no longer affect a later recurrence window");
console.log("bounded-counter-map.test.ts: retention and recurrence assertions passed");
