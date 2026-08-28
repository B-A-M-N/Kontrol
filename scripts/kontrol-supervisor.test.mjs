import assert from "node:assert/strict";
import { adapterHealthReady, allHealthy, classifyTunnelFailure, classifyTunnelProbeFailure, createRecoveryEngine, FailureTracker, parseAgentSpecs, processIsLive, shouldRecoverComponent } from "./kontrol-supervisor.mjs";

assert.equal(processIsLive(process.pid), true, "the current supervisor test process must be live");
assert.equal(processIsLive(999_999_999), false, "a nonexistent PID must not be treated as live");

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
tracker.record({ ok: true, degraded: true }, "2026-08-18T00:00:03.000Z");
assert.equal(tracker.consecutiveFailures, 0, "non-restartable readiness degradation does not trigger a process restart");
tracker.record({ ok: true, degraded: true, restartable: true }, "2026-08-18T00:00:04.000Z");
assert.equal(tracker.consecutiveFailures, 1, "restartable adapter degradation enters the failure budget");
tracker.noteRestart("three consecutive failures");
assert.equal(tracker.restartCount, 1);
assert.equal(tracker.totalRestartCount, 1);
tracker.noteRestart("second recovery");
assert.equal(tracker.totalRestartCount, 2, "lifetime restart evidence must survive rolling-window reset semantics");

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

assert.equal(classifyTunnelFailure({ ok: true, degraded: true, readiness: { ok: false, results: [{ status: 429, body: { error: "rate limited" } }] } }), "transient");
assert.equal(classifyTunnelFailure({ ok: true, degraded: true, readiness: { ok: false, results: [{ status: 404, body: { error: "route not registered" } }] } }), "stale_route");
assert.equal(classifyTunnelFailure({ ok: true, degraded: true, readiness: { ok: false, results: [{ status: 403, body: { error: "forbidden" } }] } }), "fatal_auth");
assert.deepEqual(
  classifyTunnelProbeFailure({ ok: false, status: 0, results: [{ status: 0, error: "timeout" }] }),
  { restartable: true, failureClass: "local_liveness" },
  "a dead local tunnel daemon must consume the local restart budget",
);
assert.deepEqual(
  classifyTunnelProbeFailure({ ok: true, degraded: true, readiness: { ok: false, results: [{ status: 429, body: { error: "rate limited" } }] } }),
  { restartable: false, failureClass: "transient" },
  "upstream throttling must degrade without restarting a healthy tunnel daemon",
);
assert.deepEqual(
  classifyTunnelProbeFailure({ ok: true, degraded: true, readiness: { ok: false, results: [{ status: 404, body: { error: "route not registered" } }] } }),
  { restartable: true, failureClass: "stale_route" },
  "a stale route permits bounded local reconciliation",
);
const tunnelThrottle = new FailureTracker("tunnel");
tunnelThrottle.record({ ok: false, status: 429, restartable: false });
tunnelThrottle.record({ ok: false, status: 429, restartable: false });
tunnelThrottle.record({ ok: false, status: 429, restartable: false });
assert.equal(tunnelThrottle.consecutiveFailures, 0, "control-plane throttling must not consume the local tunnel restart budget");
const staleRoute = { tracker: new FailureTracker("tunnel") };
staleRoute.tracker.consecutiveFailures = 3;
assert.equal(shouldRecoverComponent(staleRoute, { ok: true, degraded: true, restartable: true }), true, "stale tunnel registration should permit a bounded local reconciliation restart");
const staleTunnelComponent = {
  tracker: new FailureTracker("tunnel"),
  session: "kontrol-tunnel",
  command: "tunnel-command",
};
staleTunnelComponent.tracker.consecutiveFailures = 3;
let staleTunnelRestarts = 0;
const staleTunnelRecovery = createRecoveryEngine({
  components: { tunnel: staleTunnelComponent },
  probeComponent: async () => ({ ok: true, degraded: false, status: 200 }),
  restart: async () => { staleTunnelRestarts += 1; },
  sleepFn: async () => {},
  restartBackoffBaseMs: 0,
});
await staleTunnelRecovery.recover("tunnel", "stale registration");
assert.equal(staleTunnelRestarts, 1, "stale tunnel registration recovery must restart only the tunnel and wait for readiness");
assert.equal(staleTunnelComponent.tracker.state, "recovered");

const readinessOnly = { tracker: new FailureTracker("kontrol") };
readinessOnly.tracker.consecutiveFailures = 3;
assert.equal(shouldRecoverComponent(readinessOnly, { ok: true, degraded: true }), false, "readiness degradation is not a core process restart predicate");
assert.equal(shouldRecoverComponent(readinessOnly, { ok: false, status: 0 }), true, "repeated liveness failure is restartable");
readinessOnly.tracker.state = "circuit_open";
assert.equal(shouldRecoverComponent(readinessOnly, { ok: false, status: 0 }), false, "circuit-open components are not churned");

// Exercise the actual recovery state machine with injected process/probe
// boundaries. A successful tmux launch is not enough: the restart is only
// recovered after readiness is observed.
const core = {
  tracker: new FailureTracker("kontrol"),
  session: "kontrol-server",
  command: "core-command",
};
core.tracker.consecutiveFailures = 3;
let coreProbes = 0;
let coreRestarts = 0;
const recovery = createRecoveryEngine({
  components: { kontrol: core },
  probeComponent: async () => {
    coreProbes += 1;
    return coreProbes === 1 ? { ok: false, status: 0 } : { ok: true, degraded: false, status: 200 };
  },
  restart: async () => { coreRestarts += 1; },
  sleepFn: async () => {},
  restartBackoffBaseMs: 0,
  recoveryTimeoutMs: 1_000,
});
await recovery.recover("kontrol", "test recovery");
assert.equal(coreRestarts, 1);
assert.equal(coreProbes, 2, "recovery waits for a ready probe after launch");
assert.equal(core.tracker.consecutiveFailures, 0, "failure count resets only after readiness");
assert.equal(core.tracker.state, "recovered");

const failing = {
  tracker: new FailureTracker("failing"),
  session: "failing-session",
  command: "failing-command",
};
failing.tracker.consecutiveFailures = 3;
let fakeNow = 0;
const failedRecovery = createRecoveryEngine({
  components: { failing },
  probeComponent: async () => ({ ok: false, status: 503 }),
  restart: async () => {},
  sleepFn: async (ms) => { fakeNow += ms; },
  now: () => fakeNow,
  restartBackoffBaseMs: 0,
  recoveryTimeoutMs: 10,
  restartBudget: 5,
});
for (let attempt = 0; attempt < 3; attempt++) {
  await assert.rejects(failedRecovery.recover("failing", "test failure"), /did not become ready/);
}
assert.equal(failing.tracker.state, "circuit_open", "repeated failed recovery opens the circuit");

// A core recovery must not fail just because a downstream component is already
// circuit-open. The dependency remains degraded for operator intervention;
// the core still completes its own readiness-gated recovery.
const recoveredCore = {
  tracker: new FailureTracker("kontrol"),
  session: "kontrol-server",
  command: "core-command",
};
const blockedDependency = {
  tracker: new FailureTracker("crush"),
  session: "crush-session",
  command: "crush-command",
};
blockedDependency.tracker.state = "circuit_open";
recoveredCore.tracker.consecutiveFailures = 3;
let recoveryOrder = [];
const coreWithBlockedDependency = createRecoveryEngine({
  components: { kontrol: recoveredCore, crush: blockedDependency },
  probeComponent: async ([name]) => {
    recoveryOrder.push(`probe:${name}`);
    return { ok: true, degraded: false, status: 200 };
  },
  restart: async (name) => { recoveryOrder.push(`restart:${name}`); },
  sleepFn: async () => {},
  restartBackoffBaseMs: 0,
});
await coreWithBlockedDependency.recover("kontrol", "core liveness failure");
assert.deepEqual(recoveryOrder, ["restart:kontrol", "probe:kontrol"], "core recovery skips a circuit-open dependency");
assert.equal(blockedDependency.tracker.state, "circuit_open");

console.log("kontrol-supervisor.test.mjs: all assertions passed");
