import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { adapterHealthReady, allHealthy, classifyTunnelFailure, classifyTunnelProbeFailure, createMcpCanaryRunner, createRecoveryEngine, FailureTracker, parseAgentSpecs, processIsLive, runSupervisorMonitoringLoop, shouldRecoverComponent } from "./kontrol-supervisor.mjs";

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

const cooledCircuit = new FailureTracker("cooled", { circuitCooldownMs: 10 });
cooledCircuit.openCircuit(100);
assert.equal(cooledCircuit.canAttemptRecovery(105), false, "circuit cooldown fences recovery attempts");
assert.equal(cooledCircuit.canAttemptRecovery(110), true, "circuit enters a single half-open recovery window after cooldown");
assert.equal(cooledCircuit.state, "half_open");
cooledCircuit.record({ ok: true, status: 200 }, 111);
assert.equal(cooledCircuit.state, "healthy", "a successful half-open probe closes the circuit");

let canaryNow = 0;
let canaryLaunches = 0;
const canary = createMcpCanaryRunner({
  url: "https://mcp.example.test",
  workspacePath: "/tmp/workspace",
  intervalMs: 1_000,
  timeoutMs: 100,
  now: () => canaryNow,
  spawnFn: () => {
    canaryLaunches += 1;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  },
});
assert.equal(await canary.runIfDue(), true, "the external MCP canary runs immediately when enabled");
assert.equal(canaryLaunches, 1);
assert.equal(canary.snapshot().lastOk, true);
canaryNow = 500;
assert.equal(await canary.runIfDue(), false, "the canary interval suppresses duplicate probes");
canaryNow = 1_000;
assert.equal(await canary.runIfDue(), true, "the canary runs again after its bounded interval");
assert.equal(canary.snapshot().totalRuns, 2);

let credentialedCanaryArgs;
const credentialedCanary = createMcpCanaryRunner({
  url: "https://mcp.example.test",
  workspacePath: "/tmp/workspace",
  authorizationFile: "/tmp/kontrol-canary.authorization",
  spawnFn: (_command, args) => {
    credentialedCanaryArgs = args;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  },
});
assert.equal(await credentialedCanary.runIfDue(), true, "a configured canary authorization file is passed to the probe");
const authorizationFileIndex = credentialedCanaryArgs.indexOf("--authorization-file");
assert.ok(authorizationFileIndex >= 0);
assert.equal(credentialedCanaryArgs[authorizationFileIndex + 1], "/tmp/kontrol-canary.authorization");

const failedCanary = createMcpCanaryRunner({
  url: "https://mcp.example.test",
  workspacePath: "/tmp/workspace",
  intervalMs: 1_000,
  timeoutMs: 100,
  spawnFn: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 7, null));
    return child;
  },
});
assert.equal(await failedCanary.runIfDue(), false, "canary failure is recorded without throwing into component recovery");
assert.equal(failedCanary.snapshot().lastOk, false);
assert.equal(failedCanary.snapshot().totalFailures, 1);

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

// Core recovery must not cascade into healthy dependencies. Each dependency
// gets a fresh post-recovery probe, but only a restartable failed result may
// consume its restart budget.
const healthyCore = {
  tracker: new FailureTracker("kontrol"),
  session: "kontrol-server",
  command: "core-command",
};
const healthyAdapter = {
  tracker: new FailureTracker("crush"),
  session: "crush-session",
  command: "crush-command",
};
const healthyTunnel = {
  tracker: new FailureTracker("tunnel"),
  session: "kontrol-tunnel",
  command: "tunnel-command",
};
healthyCore.tracker.consecutiveFailures = 3;
const healthyDependencyOrder = [];
const healthyDependencyRecovery = createRecoveryEngine({
  components: { kontrol: healthyCore, crush: healthyAdapter, tunnel: healthyTunnel },
  probeComponent: async ([name]) => {
    healthyDependencyOrder.push(`probe:${name}`);
    return { ok: true, degraded: false, status: 200 };
  },
  restart: async (name) => { healthyDependencyOrder.push(`restart:${name}`); },
  sleepFn: async () => {},
  restartBackoffBaseMs: 0,
});
await healthyDependencyRecovery.recover("kontrol", "core liveness failure");
assert.deepEqual(healthyDependencyOrder, [
  "restart:kontrol",
  "probe:kontrol",
  "probe:crush",
  "probe:tunnel",
], "core recovery probes healthy dependencies without restarting them");

// The real monitoring loop must contain a rejected probe/tick and an
// unwritable status file without silently disappearing. It continues to the
// next bounded cycle, then releases ownership on an explicit stop.
let injectedTickCount = 0;
let injectedSleeps = 0;
const monitoringErrors = [];
let monitoringReleased = false;
const recoverableMonitor = runSupervisorMonitoringLoop({
  intervalMs: 0,
  assertOwnership: () => {},
  writeStarting: () => { throw new Error("injected unwritable status"); },
  writeDegraded: () => { throw new Error("injected unwritable degraded status"); },
  tick: async ({ stop }) => {
    injectedTickCount += 1;
    if (injectedTickCount === 1) throw new Error("injected rejected probe");
    stop();
  },
  sleepFn: async () => { injectedSleeps += 1; },
  releaseOwnership: () => { monitoringReleased = true; },
  onError: (message) => monitoringErrors.push(message),
});
const recoverableResult = await recoverableMonitor.promise;
assert.equal(recoverableResult.terminalState, "stopped", "recoverable monitoring faults must not kill the supervisor");
assert.equal(injectedTickCount, 2, "the loop must continue after an unexpected tick exception");
assert.ok(injectedSleeps >= 1, "a failed monitoring cycle must use bounded backoff");
assert.equal(monitoringReleased, true, "a stopped monitoring loop must release ownership");
assert.ok(monitoringErrors.some((message) => message.includes("injected rejected probe")));
assert.ok(monitoringErrors.some((message) => message.includes("status write failed")));

// Runtime-lock/ownership loss is different: it must publish a fatal state,
// stop recovery, and release only through the guarded ownership callback.
let fatalStatus;
let fatalReleased = false;
const fatalMonitor = runSupervisorMonitoringLoop({
  intervalMs: 0,
  assertOwnership: () => { throw new Error("injected ownership loss"); },
  tick: async () => {},
  writeFatal: (error) => { fatalStatus = error; },
  releaseOwnership: () => { fatalReleased = true; },
  onError: () => {},
});
const fatalResult = await fatalMonitor.promise;
assert.equal(fatalResult.terminalState, "fatal");
assert.equal(fatalStatus, "injected ownership loss");
assert.equal(fatalReleased, true, "fatal monitoring must still release through the owner guard");

console.log("kontrol-supervisor.test.mjs: all assertions passed");
