import assert from "node:assert/strict";
import { adapterHealthReady, allHealthy, FailureTracker, parseAgentSpecs } from "./kontrol-supervisor.mjs";

const specs = parseAgentSpecs("cli-coding-agent=http://127.0.0.1:9877,hermes-agent=http://127.0.0.1:9911");
assert.deepEqual(specs, [
  { name: "cli-coding-agent", url: "http://127.0.0.1:9877" },
  { name: "hermes-agent", url: "http://127.0.0.1:9911" },
]);

const tracker = new FailureTracker("tunnel");
tracker.record({ ok: false, status: 502 }, "2026-08-18T00:00:00.000Z");
tracker.record({ ok: false, status: 502 }, "2026-08-18T00:00:01.000Z");
assert.equal(tracker.consecutiveFailures, 2);
tracker.record({ ok: true, status: 200 }, "2026-08-18T00:00:02.000Z");
assert.equal(tracker.consecutiveFailures, 0);
assert.equal(tracker.lastHealthyAt, "2026-08-18T00:00:02.000Z");
tracker.noteRestart("three consecutive failures");
assert.equal(tracker.restartCount, 1);

const probeStartedAt = performance.now();
const health = await allHealthy("test", ["a", "b", "c"], async (url) => {
  await new Promise((resolve) => setTimeout(resolve, 35));
  return { ok: url !== "b", status: url === "b" ? 503 : 200 };
});
assert.ok(performance.now() - probeStartedAt < 90, "independent supervisor probes run concurrently");
assert.equal(health.ok, false);
assert.deepEqual(health.results.map((result) => result.status), [200, 503, 200]);
assert.equal(adapterHealthReady({ ok: true, ready: true, reconciled: true, lifecycle: "READY" }), true);
assert.equal(adapterHealthReady({ ok: true, ready: true, reconciled: false, lifecycle: "READY" }), false);
assert.equal(adapterHealthReady({ ok: false, ready: false, reconciled: true, lifecycle: "DEGRADED" }), false);

console.log("kontrol-supervisor.test.mjs: all assertions passed");
