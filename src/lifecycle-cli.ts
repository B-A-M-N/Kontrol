#!/usr/bin/env node
/**
 * Lifecycle CLI: thin executable over src/lifecycle-coordinator.ts so the
 * shell entrypoints (start-all.sh, stop-all.sh) delegate backend decisions
 * instead of reimplementing them. Exit codes: 0 = proceed/done, 3 = start
 * or takeover refused (conflicting/unknown owner), 1 = error.
 */
import { spawnSync } from "node:child_process";
import {
  MANAGED_TMUX_SESSIONS,
  buildLifecycleManifest,
  decideStackStart,
  isManagedTmuxSession,
  liveProbes,
  planFencedTakeover,
  resolveActiveBackend,
  stopOrder,
} from "./lifecycle-coordinator.js";
import { readServiceComponents, servicePaths } from "./service.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function cmdResolveBackend(args: string[]): number {
  const format = args.includes("--format=shell") ? "shell" : "json";
  const coreUnitArg = args.find((a) => a.startsWith("--core-unit="));
  const paths = servicePaths(process.env);
  const snapshot = resolveActiveBackend(liveProbes, coreUnitArg?.slice("--core-unit=".length) ?? paths.serviceName);
  if (format === "shell") {
    console.log(`LIFECYCLE_BACKEND=${shellQuote(snapshot.backend)}`);
    console.log(`LIFECYCLE_SYSTEMD_UNITS=${shellQuote(snapshot.systemdUnits.join(" "))}`);
    console.log(`LIFECYCLE_TMUX_SESSIONS=${shellQuote(snapshot.tmuxSessions.join(" "))}`);
    console.log(`LIFECYCLE_PROBE_ERRORS=${shellQuote(snapshot.probeErrors.join("; "))}`);
  } else {
    console.log(JSON.stringify(snapshot));
  }
  return 0;
}

function cmdCheckStart(args: string[]): number {
  const backendArg = args.find((a) => a.startsWith("--backend="))?.slice("--backend=".length);
  if (backendArg !== "systemd" && backendArg !== "tmux") {
    console.error("lifecycle-cli check-start --backend=systemd|tmux");
    return 1;
  }
  if (args.includes("--takeover") || process.env.KONTROL_TAKEOVER_AUTHORIZED === "1") {
    console.error("takeover is not a check-start flag: run `lifecycle-cli takeover-stack --to=systemd|tmux` first");
    return 1;
  }
  const paths = servicePaths(process.env);
  const active = resolveActiveBackend(liveProbes, paths.serviceName);
  const decision = decideStackStart({ requested: backendArg, active });
  if (decision.ok) {
    console.log(JSON.stringify({ ok: true, backend: backendArg, active }));
    return 0;
  }
  console.error(decision.reason);
  console.log(JSON.stringify({ ok: false, backend: backendArg, active, reason: decision.reason }));
  return 3;
}

/**
 * Fenced takeover transaction: stop the conflicting owner and verify it is
 * gone, without starting anything. Mixed and unknown backends are refused:
 * the operator must resolve those explicitly. Exit 0 only when the
 * requested backend observes a clear stack.
 */
function cmdTakeoverStack(args: string[]): number {
  const toArg = args.find((a) => a.startsWith("--to="))?.slice("--to=".length);
  if (toArg !== "systemd" && toArg !== "tmux") {
    console.error("lifecycle-cli takeover-stack --to=systemd|tmux");
    return 1;
  }
  const paths = servicePaths(process.env);
  const active = resolveActiveBackend(liveProbes, paths.serviceName);
  const plan = planFencedTakeover({ requested: toArg, active });
  if (plan.status === "refused") {
    console.error(plan.reason);
    return 3;
  }
  if (plan.status === "clear") {
    console.log(JSON.stringify({ tookOver: false, backend: toArg, active }));
    return 0;
  }
  console.error(`takeover: stopping conflicting ${plan.stopBackend} stack (${plan.owned.join(", ")})`);
  const stopExit = plan.stopBackend === "systemd" ? cmdStopSystemdStack() : cmdStopTmuxStack();
  if (stopExit !== 0) {
    console.error("takeover: conflicting stack did not stop; refusing to proceed");
    return 1;
  }
  const after = resolveActiveBackend(liveProbes, paths.serviceName);
  const recheck = decideStackStart({ requested: toArg, active: after });
  if (!recheck.ok) {
    console.error(`takeover: stack still owned after stop: ${recheck.reason}`);
    return 1;
  }
  console.log(JSON.stringify({ tookOver: true, backend: toArg, stopped: plan.owned }));
  return 0;
}

/** Stop exactly the managed tmux sessions with graceful SIGINT first. */
function cmdStopTmuxStack(): number {
  const failures: string[] = [];
  for (const session of MANAGED_TMUX_SESSIONS) {
    const has = spawnSync("tmux", ["has-session", "-t", `=${session}`], { stdio: "ignore" });
    if (has.status !== 0) continue;
    spawnSync("tmux", ["send-keys", "-t", `=${session}`, "C-c"], { stdio: "ignore" });
  }
  const deadline = Date.now() + 10_000;
  const survivors = (): string[] => {
    // Only managed sessions are ever owned: unrelated sessions and
    // prefix-lookalikes must never be signaled, killed, or reported.
    const probed = liveProbes.listTmuxSessions();
    const names = probed.status === "ok" ? probed.names : [...MANAGED_TMUX_SESSIONS];
    return names.filter(isManagedTmuxSession);
  };
  let remaining = survivors();
  while (remaining.length > 0 && Date.now() < deadline) {
    // Sleep-based drain: yielding the event loop instead of spinning.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    remaining = survivors();
  }
  for (const session of remaining) {
    const killed = spawnSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
    if (killed.status !== 0) failures.push(`tmux kill-session ${session} failed`);
  }
  remaining = survivors();
  if (remaining.length > 0) failures.push(`still alive after stop: ${remaining.join(", ")}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`stop-tmux-stack: ${failure}`);
    return 1;
  }
  console.log(JSON.stringify({ stopped: [...MANAGED_TMUX_SESSIONS] }));
  return 0;
}

function cmdStopSystemdStack(): number {
  const paths = servicePaths(process.env);
  const components = readServiceComponents(process.env);
  const manifest = buildLifecycleManifest({ coreServiceName: paths.serviceName, components });
  const failures: string[] = [];
  // Reverse dependency order: adapters/tunnel drain before the core, then
  // the aggregate target so nothing is left half-owned.
  for (const component of [...stopOrder(manifest), { name: "target", systemdUnit: "kontrol.target" } as const]) {
    const result = spawnSync("systemctl", ["--user", "stop", component.systemdUnit], { encoding: "utf8" });
    if (result.status !== 0 && !/not loaded|could not be found|not-found/i.test(String(result.stderr ?? ""))) {
      failures.push(`${component.systemdUnit}: ${String(result.stderr ?? result.error ?? "stop failed").trim()}`);
    }
  }
  const probed = liveProbes.listActiveSystemdUnits();
  if (probed.status === "unavailable") {
    failures.push(`could not verify shutdown: ${probed.reason}`);
  } else {
    const remaining = probed.names.filter((unit) =>
      manifest.some((c) => c.systemdUnit === unit) || unit === "kontrol.target",
    );
    if (remaining.length > 0) failures.push(`still active after stop: ${remaining.join(", ")}`);
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`stop-systemd-stack: ${failure}`);
    return 1;
  }
  console.log(JSON.stringify({ stopped: manifest.map((c) => c.systemdUnit).concat("kontrol.target") }));
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
if (command === "resolve-backend") process.exit(cmdResolveBackend(rest));
if (command === "check-start") process.exit(cmdCheckStart(rest));
if (command === "takeover-stack") process.exit(cmdTakeoverStack(rest));
if (command === "stop-systemd-stack") process.exit(cmdStopSystemdStack());
if (command === "stop-tmux-stack") process.exit(cmdStopTmuxStack());
console.error("Usage: lifecycle-cli resolve-backend|check-start|takeover-stack|stop-systemd-stack|stop-tmux-stack");
process.exit(1);
