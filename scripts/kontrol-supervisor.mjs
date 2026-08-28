#!/usr/bin/env node
// Long-lived local process supervisor. It owns only the Kontrol tmux sessions
// named by start-all.sh and uses stateful failure thresholds so one transient
// tunnel timeout does not restart the whole stack.
import { existsSync, mkdirSync, renameSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_INTERVAL_MS = 5_000;
const FAILURE_THRESHOLD = 3;
const ESCALATION_RESTART_THRESHOLD = 3;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const LOCAL_LIVENESS_TIMEOUT_MS = 1_000;
const CORE_READINESS_TIMEOUT_MS = 3_000;
const TUNNEL_READINESS_TIMEOUT_MS = 10_000;
const RECOVERY_TIMEOUT_MS = 60_000;
const RESTART_BACKOFF_BASE_MS = 2_000;
const RESTART_BUDGET = 5;

function readServerIdentity(stateDir) {
  try { return JSON.parse(readFileSync(join(stateDir, "server.identity.json"), "utf8")); }
  catch { return undefined; }
}

export function processIsLive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 1) return false;
  const numericPid = Number(pid);
  try {
    // kill(pid, 0) succeeds for zombies. A zombie cannot own a serving
    // generation, so treating it as live would make the supervisor trust a
    // stale runtime lock and skip recovery indefinitely.
    const stat = readFileSync(`/proc/${numericPid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen >= 0 && stat.slice(closingParen + 2).trim().split(/\s+/)[0] === "Z") return false;
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function processStartToken(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen >= 0) {
      const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
      if (fields[19]) return `proc:${fields[19]}`;
    }
  } catch { /* best effort on non-Linux */ }
  return undefined;
}

function assertRuntimeLock(stateDir, token) {
  const record = readFileSync(join(stateDir, "runtime.lock"), "utf8");
  const lock = JSON.parse(record);
  if (lock.lockToken !== token || !processIsLive(Number(lock.launcherPid))) {
    throw new Error("Kontrol supervisor runtime lock is missing, stale, or owned by another generation.");
  }
  const actualToken = processStartToken(Number(lock.launcherPid));
  if (actualToken && lock.launcherStartToken !== actualToken) {
    throw new Error("Kontrol supervisor runtime lock PID was reused by another process.");
  }
  return lock;
}

function releaseRuntimeLock(stateDir, token) {
  if (!token) return;
  const lockPath = join(stateDir, "runtime.lock");
  const guardPath = `${lockPath}.guard`;
  const guard = { token: `guard_${randomUUID()}`, pid: process.pid, startToken: processStartToken(process.pid) };
  const releaseGuard = () => {
    try {
      const current = JSON.parse(readFileSync(guardPath, "utf8"));
      if (current.token === guard.token) unlinkSync(guardPath);
    } catch { /* another compliant contender reclaimed it */ }
  };

  // Match runtime-lock.ts: lock replacement and release share an O_EXCL
  // arbitration guard. A supervisor may be exiting while a new launcher is
  // reclaiming its stale record; an unguarded unlink could erase that owner.
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        writeFileSync(guardPath, `${JSON.stringify(guard)}\n`, { flag: "wx", mode: 0o600 });
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") return;
        let current;
        try { current = JSON.parse(readFileSync(guardPath, "utf8")); } catch { /* stale/malformed guard */ }
        if (current && current.pid !== process.pid && current.startToken && processIsLive(Number(current.pid))) {
          if (Date.now() >= deadline) return;
          spawnSync("sleep", ["0.01"], { stdio: "ignore" });
          continue;
        }
        const reclaimPath = `${guardPath}.reclaim-${guard.token}`;
        try {
          renameSync(guardPath, reclaimPath);
          rmSync(reclaimPath, { force: true });
        } catch { /* another contender won the stale-guard race */ }
      }
    }

    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      if (lock.lockToken === token && Number(lock.launcherPid) === process.pid) rmSync(lockPath, { force: true });
    } catch { /* the launcher may already have reconciled the stale lock */ }
  } finally {
    releaseGuard();
  }
}

export class FailureTracker {
  constructor(name) {
    this.name = name;
    this.consecutiveFailures = 0;
    this.restartCount = 0;
    this.totalRestartCount = 0;
    this.restartFailures = 0;
    this.totalRestartFailures = 0;
    this.lastHealthyAt = undefined;
    this.lastRestartReason = undefined;
    this.lastExternalProbeResult = undefined;
    this.state = "starting";
    this.restartWindowStartedAt = 0;
  }

  record(result, now = new Date().toISOString()) {
    this.lastExternalProbeResult = result;
    const healthy = result.ok && !result.degraded;
    // A failed external dependency probe is not automatically a local
    // process failure. Tunnel control-plane throttling/auth outages are
    // explicitly non-restartable; only a local daemon loss or a classified
    // stale registration may consume the restart budget.
    const restartableFailure = result.restartable === false
      ? false
      : (!result.ok || result.restartable === true);
    if (healthy) {
      this.consecutiveFailures = 0;
      this.restartFailures = 0;
      this.lastHealthyAt = now;
      this.state = "healthy";
      return;
    }
    if (this.state === "circuit_open") return;
    if (restartableFailure) this.consecutiveFailures += 1;
    else this.consecutiveFailures = 0;
    this.state = "degraded";
  }

  noteRestart(reason) {
    const now = Date.now();
    if (!this.restartWindowStartedAt || now - this.restartWindowStartedAt > 15 * 60_000) {
      this.restartWindowStartedAt = now;
      this.restartCount = 0;
    }
    this.restartCount += 1;
    this.totalRestartCount += 1;
    this.lastRestartReason = reason;
    this.state = "starting";
  }

  noteRestartFailure() {
    this.restartFailures += 1;
    this.totalRestartFailures += 1;
    this.state = this.restartFailures >= ESCALATION_RESTART_THRESHOLD ? "circuit_open" : "failed";
  }

  snapshot() {
    return {
      consecutiveFailures: this.consecutiveFailures,
      restartCount: this.restartCount,
      totalRestartCount: this.totalRestartCount,
      restartFailures: this.restartFailures,
      totalRestartFailures: this.totalRestartFailures,
      lastHealthyAt: this.lastHealthyAt,
      lastRestartReason: this.lastRestartReason,
      lastExternalProbeResult: this.lastExternalProbeResult,
      state: this.state,
    };
  }
}

export function parseAgentSpecs(value = "") {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1 || separator === entry.length - 1) throw new Error(`Invalid agent spec: ${entry}`);
    return { name: entry.slice(0, separator), url: entry.slice(separator + 1) };
  });
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function originFromUrl(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

function tmux(args) {
  const result = spawnSync("tmux", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "tmux failed").trim());
}

function hasTmuxSession(name) {
  return spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" }).status === 0;
}

function launchCommand(root, command) {
  // Component commands may contain an environment prelude and their own
  // final `exec`. Do not prepend another exec here: `exec set -a` and
  // `exec exec ...` make restart-only recovery fail even when startup passed.
  return `set -euo pipefail; cd -- ${shellQuote(root)}; ${command}`;
}

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function restartSession(name, root, command) {
  if (hasTmuxSession(name)) {
    spawnSync("tmux", ["send-keys", "-t", name, "C-c"], { stdio: "ignore" });
    spawnSync("sleep", ["2"], { stdio: "ignore" });
    if (hasTmuxSession(name)) spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
  }
  tmux(["new-session", "-d", "-s", name, "-c", root, launchCommand(root, command)]);
}

async function probe(url, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body;
    if ((response.headers.get("content-type") || "").includes("application/json")) {
      body = await response.json().catch(() => undefined);
    }
    return { ok: response.status === 200, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function allHealthy(component, urls, probeFn = probe) {
  const results = await Promise.all(urls.map(async (entry) => {
    const url = typeof entry === "string" ? entry : entry.url;
    const timeoutMs = typeof entry === "string" ? DEFAULT_PROBE_TIMEOUT_MS : entry.timeoutMs;
    return { url, ...(await probeFn(url, timeoutMs)) };
  }));
  return { ok: results.every((result) => result.ok), results };
}

export function adapterHealthReady(health) {
  return health?.ok === true
    && health.ready === true
    && health.reconciled === true
    && health.lifecycle === "READY";
}

/**
 * Classify tunnel-client readiness failures without confusing remote control
 * plane state with local process death. The daemon's /healthz and /readyz
 * responses may include a structured detail or an error string; keep this
 * classifier deliberately tolerant of both forms because tunnel-client is an
 * independently released dependency.
 */
export function classifyTunnelFailure(result) {
  if (!result) return undefined;
  const entries = [
    ...(Array.isArray(result.results) ? result.results : []),
    ...(Array.isArray(result.readiness?.results) ? result.readiness.results : []),
  ];
  const statuses = entries.map((entry) => Number(entry?.status)).filter((status) => Number.isFinite(status));
  const detail = entries
    .map((entry) => entry?.body ?? entry?.error)
    .filter((value) => value !== undefined)
    .map((value) => typeof value === "string" ? value : JSON.stringify(value))
    .join(" ")
    .toLowerCase();
  if (statuses.some((status) => status === 401 || status === 403) || /unauthori[sz]|forbidden|api key|credential/.test(detail)) {
    return "fatal_auth";
  }
  if (statuses.includes(404) || /stale route|route (?:not )?found|not registered|registration.*(?:missing|stale)/.test(detail)) {
    return "stale_route";
  }
  if (statuses.some((status) => status === 408 || status === 425 || status === 429 || status >= 500) || /timeout|temporar|rate limit|unreachable|connection reset|control plane/.test(detail)) {
    return "transient";
  }
  return undefined;
}

/**
 * Classify the two independent tunnel failure domains. Local daemon liveness
 * is restartable; an upstream control-plane failure is normally degraded and
 * must not churn a healthy local tunnel process. A stale route is the one
 * upstream condition for which a bounded local reconciliation restart helps.
 */
export function classifyTunnelProbeFailure(result) {
  if (!result?.ok) return { restartable: true, failureClass: "local_liveness" };
  if (!result.readiness?.ok) {
    const failureClass = classifyTunnelFailure(result.readiness);
    if (!failureClass) return { restartable: false, failureClass: "upstream_degraded" };
    return {
      restartable: failureClass === "stale_route",
      failureClass,
    };
  }
  return undefined;
}

export function shouldRecoverComponent(component, result, failureThreshold = FAILURE_THRESHOLD) {
  if (!component || !result) return false;
  if (result.ok && !result.restartable) return false;
  if (component.tracker.state === "circuit_open") return false;
  return component.tracker.consecutiveFailures >= failureThreshold;
}

/**
 * Recovery orchestration is injectable so lifecycle tests can exercise the
 * real ordering/readiness/budget behavior without starting tmux sessions.
 * `probeComponent` must return the same `{ ok, degraded }` result used by the
 * production probe path; `restart` owns the actual stop/launch operation.
 */
export function createRecoveryEngine({
  components,
  probeComponent,
  restart,
  sleepFn = sleep,
  now = () => Date.now(),
  recoveryTimeoutMs = RECOVERY_TIMEOUT_MS,
  restartBackoffBaseMs = RESTART_BACKOFF_BASE_MS,
  restartBudget = RESTART_BUDGET,
}) {
  let stopping = false;
  let recovering = false;

  async function waitForReady(name, component) {
    const deadline = now() + recoveryTimeoutMs;
    let delayMs = 250;
    let lastResult;
    while (now() < deadline && !stopping) {
      lastResult = await probeComponent([name, component], false);
      if (lastResult.ok && !lastResult.degraded) return lastResult;
      await sleepFn(delayMs);
      delayMs = Math.min(2_000, delayMs * 2);
    }
    throw new Error(`${name} did not become ready within ${recoveryTimeoutMs}ms: ${JSON.stringify(lastResult)}`);
  }

  async function restartAndWait(name, reason) {
    const component = components[name];
    if (!component || !component.session || !component.command) return;
    if (component.tracker.state === "circuit_open") {
      throw new Error(`${name} restart circuit is open; manual intervention is required`);
    }
    if (component.tracker.restartCount >= restartBudget) {
      component.tracker.state = "circuit_open";
      throw new Error(`${name} restart budget exhausted (${restartBudget} restarts in the current window)`);
    }
    component.tracker.noteRestart(reason);
    await sleepFn(Math.min(10_000, restartBackoffBaseMs * Math.max(0, component.tracker.restartCount - 1)));
    await restart(name, component);
    component.tracker.state = "waiting_ready";
    try {
      await waitForReady(name, component);
      component.tracker.consecutiveFailures = 0;
      component.tracker.restartFailures = 0;
      component.tracker.state = "recovered";
    } catch (error) {
      component.tracker.noteRestartFailure();
      throw error;
    }
  }

  async function recover(name, reason) {
    if (recovering) return;
    recovering = true;
    try {
      if (name === "operational") {
        const failedAdapter = ["crush", "hermes"].find((dependency) => components[dependency]?.tracker.consecutiveFailures > 0);
        if (failedAdapter) {
          await restartAndWait(failedAdapter, `operational readiness traced to ${failedAdapter}`);
        } else if (components.kontrol?.tracker.consecutiveFailures > 0) {
          await restartAndWait("kontrol", reason);
        }
        return;
      }
      await restartAndWait(name, reason);
      if (name === "kontrol") {
        for (const dependency of ["crush", "hermes", "tunnel"]) {
          // A dependency whose own circuit is open is already known to need
          // operator intervention. Do not turn that downstream condition into
          // a second failed core recovery; leave its state visible and let the
          // recovered core serve degraded readiness while it remains isolated.
          if (components[dependency] && components[dependency].tracker.state !== "circuit_open") {
            await restartAndWait(dependency, `dependency chain after ${name} recovery`);
          }
        }
      }
    } finally {
      recovering = false;
    }
  }

  return {
    recover,
    restartAndWait,
    waitForReady,
    setStopping(value) { stopping = value; },
    isRecovering() { return recovering; },
  };
}

function writeStatus(statusFile, status) {
  mkdirSync(resolve(statusFile, ".."), { recursive: true });
  const temporary = `${statusFile}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(status, null, 2));
  renameSync(temporary, statusFile);
}

function buildComponents({ kontrolUrl, tunnelUrl, agents, crushPort, hermesPort, startCrush, startHermes, generationId, expectedBuildId, artifactPath, runtimeLockToken }) {
  const identityEnv = `export KONTROL_LAUNCH_GENERATION_ID=${shellQuote(generationId)} KONTROL_EXPECTED_BUILD_ID=${shellQuote(expectedBuildId)} KONTROL_RUNTIME_LOCK_TOKEN=${shellQuote(runtimeLockToken || "")} KONTROL_ARTIFACT_PATH=${shellQuote(artifactPath)};`;
  const environmentFile = process.env.KONTROL_ENV_FILE || ".env";
  const environmentPrelude = `set -a; source ${shellQuote(environmentFile)}; set +a;`;
  const components = {
    kontrol: {
      tracker: new FailureTracker("kontrol"),
      urls: [{ url: `${kontrolUrl}/healthz`, timeoutMs: LOCAL_LIVENESS_TIMEOUT_MS }],
      readinessUrls: [{ url: `${kontrolUrl}/core-readyz`, timeoutMs: CORE_READINESS_TIMEOUT_MS }],
      session: "kontrol-server",
      command: `${environmentPrelude} ${identityEnv} exec node ${shellQuote(join(artifactPath, "cli.js"))} serve`,
    },
    operational: {
      tracker: new FailureTracker("operational"),
      urls: [{ url: `${kontrolUrl}/readyz`, timeoutMs: CORE_READINESS_TIMEOUT_MS }],
      session: undefined,
      command: undefined,
    },
    tunnel: {
      tracker: new FailureTracker("tunnel"),
      urls: [{ url: `${tunnelUrl}/healthz`, timeoutMs: DEFAULT_PROBE_TIMEOUT_MS }],
      readinessUrls: [{ url: `${tunnelUrl}/readyz`, timeoutMs: TUNNEL_READINESS_TIMEOUT_MS }],
      session: "kontrol-tunnel",
      command: "exec scripts/kontrol-tunnel.sh",
    },
  };
  if (startCrush) {
    components.crush = {
      tracker: new FailureTracker("crush"),
      urls: [{ url: `http://127.0.0.1:${crushPort}/health`, timeoutMs: DEFAULT_PROBE_TIMEOUT_MS }],
      requireReadyHealth: true,
      session: "kontrol-adapter-crush",
      command: `${environmentPrelude} ${identityEnv} exec env ACP_AGENT_BIN=crush PORT=${Number(crushPort)} node scripts/acp-crush-adapter.mjs`,
    };
  }
  if (startHermes) {
    components.hermes = {
      tracker: new FailureTracker("hermes"),
      urls: [{ url: `http://127.0.0.1:${hermesPort}/health`, timeoutMs: DEFAULT_PROBE_TIMEOUT_MS }],
      requireReadyHealth: true,
      session: "kontrol-adapter-hermes",
      command: `${environmentPrelude} ${identityEnv} exec env HERMES_ACP_ADAPTER_PORT=${Number(hermesPort)} node scripts/acp-hermes-native-adapter.mjs`,
    };
  }
  for (const agent of agents) {
    const name = `agent:${agent.name}`;
    components[name] = {
      tracker: new FailureTracker(name),
      urls: [{ url: `${String(agent.url).replace(/\/$/, "")}/health`, timeoutMs: DEFAULT_PROBE_TIMEOUT_MS }],
      session: undefined,
      command: undefined,
    };
  }
  return components;
}

async function main() {
  const root = resolve(arg("--root", process.cwd()));
  const kontrolUrl = originFromUrl(arg("--kontrol-url", "http://127.0.0.1:7676"));
  const tunnelUrl = arg("--tunnel-url", "http://127.0.0.1:8080").replace(/\/$/, "");
  const statusFile = resolve(arg("--status-file", join(process.env.KONTROL_STATE_DIR || join(root, ".kontrol-state"), "supervisor-status.json")));
  const stateDir = resolve(arg("--state-dir", process.env.KONTROL_STATE_DIR || join(root, ".kontrol-state")));
  const generationId = arg("--generation-id", process.env.KONTROL_LAUNCH_GENERATION_ID || "unknown");
  const expectedBuildId = arg("--expected-build-id", process.env.KONTROL_EXPECTED_BUILD_ID || "");
  const artifactPath = resolve(arg("--artifact-path", process.env.KONTROL_ARTIFACT_PATH || join(root, "dist")));
  const runtimeLockToken = arg("--runtime-lock-token", process.env.KONTROL_RUNTIME_LOCK_TOKEN || "");
  if (runtimeLockToken) assertRuntimeLock(stateDir, runtimeLockToken);
  else throw new Error("Kontrol supervisor requires KONTROL_RUNTIME_LOCK_TOKEN for the active generation.");
  const agents = parseAgentSpecs(arg("--agents", ""));
  const crushPort = arg("--crush-port", process.env.ACP_ADAPTER_PORT || "9877");
  const hermesPort = arg("--hermes-port", process.env.HERMES_ACP_ADAPTER_PORT || "9911");
  const startCrush = arg("--start-crush", "false") === "true";
  const startHermes = arg("--start-hermes", "false") === "true";
  const intervalMs = Number(arg("--interval-ms", process.env.KONTROL_SUPERVISOR_INTERVAL_MS || DEFAULT_INTERVAL_MS));
  const components = buildComponents({ kontrolUrl, tunnelUrl, agents, crushPort, hermesPort, startCrush, startHermes, generationId, expectedBuildId, artifactPath, runtimeLockToken });
  const startedAt = new Date().toISOString();
  let stopping = false;

  const status = (state, externalProbeResult) => ({
    ok: state === "healthy",
    state,
    pid: process.pid,
    startedAt,
    updatedAt: new Date().toISOString(),
    lastHealthyAt: Object.values(components).map(({ tracker }) => tracker.lastHealthyAt).filter(Boolean).sort().at(-1),
    consecutiveFailures: Object.values(components).reduce((sum, { tracker }) => sum + tracker.consecutiveFailures, 0),
    restartCount: Object.values(components).reduce((sum, { tracker }) => sum + tracker.restartCount, 0),
    totalRestartCount: Object.values(components).reduce((sum, { tracker }) => sum + tracker.totalRestartCount, 0),
    totalRestartFailures: Object.values(components).reduce((sum, { tracker }) => sum + tracker.totalRestartFailures, 0),
    lastRestartReason: Object.values(components).map(({ tracker }) => tracker.lastRestartReason).filter(Boolean).at(-1),
    lastExternalProbeResult: externalProbeResult,
    generationId,
    expectedBuildId: expectedBuildId || undefined,
    serverIdentity: readServerIdentity(stateDir),
    generation: (() => {
      try { return JSON.parse(readFileSync(join(stateDir, "generation.json"), "utf8")); }
      catch { return undefined; }
    })(),
    components: Object.fromEntries(Object.entries(components).map(([name, component]) => [name, component.tracker.snapshot()])),
  });

  async function probeComponent([name, component], record = true) {
    let result = await allHealthy(name, component.urls);
    if (result.ok && component.readinessUrls) {
      const readiness = await allHealthy(`${name}-readiness`, component.readinessUrls);
      result = {
        ...result,
        degraded: !readiness.ok,
        readiness,
      };
    }
    if (result.ok && component.requireReadyHealth) {
      const health = result.results.find((entry) => entry.body !== undefined)?.body;
      if (!adapterHealthReady(health)) {
        result = {
          ...result,
          degraded: true,
          restartable: true,
          healthError: "adapter health is live but has not proved reconciled READY state",
        };
      }
    }
    if (name === "kontrol" && result.ok) {
      const identity = readServerIdentity(stateDir);
      const identityMatches = Boolean(identity)
        && (generationId === "unknown" || identity.generationId === generationId)
        && (!expectedBuildId || identity.buildId === expectedBuildId)
        && (!identity.artifactPath || resolve(identity.artifactPath) === artifactPath)
        && processIsLive(identity.pid);
      const identityStartMatches = Boolean(identity)
        && (!identity.processStartTime || !identity.processStartTime.startsWith("proc:")
          || processStartToken(identity.pid) === identity.processStartTime);
      result = {
        ...result,
        ok: identityMatches && identityStartMatches,
        identity: identity ? {
          instanceId: identity.instanceId,
          pid: identity.pid,
          generationId: identity.generationId,
          buildId: identity.buildId,
          artifactPath: identity.artifactPath,
          processStartTime: identity.processStartTime,
          live: processIsLive(identity.pid),
        } : undefined,
        identityError: identityMatches && identityStartMatches ? undefined : "server identity does not match this launch generation/build/start token",
      };
    }
    if (name === "tunnel") {
      const tunnelFailure = classifyTunnelProbeFailure(result);
      if (tunnelFailure) {
        result = {
          ...result,
          // A tunnel daemon that is alive but cannot currently reach its
          // control plane is degraded, not dead. A stale local registration
          // is the one case where restarting the same configured daemon is a
          // useful bounded reconciliation attempt.
          ...(result.ok ? { degraded: true } : {}),
          restartable: tunnelFailure.restartable,
          failureClass: tunnelFailure.failureClass,
        };
      }
    }
    if (record) component.tracker.record(result);
    return result;
  }

  const recovery = createRecoveryEngine({
    components,
    probeComponent,
    restart: (_name, component) => restartSession(component.session, root, component.command),
  });

  async function tick() {
    const results = {};
    let healthy = true;

    // Probe worker/tunnel/core dependencies first and in parallel. Aggregate
    // /readyz is evaluated only after those concrete failure identities are
    // recorded, so it cannot cause a core restart merely because a worker is
    // down or because aggregate readiness is lagging one supervisor tick.
    const dependencyEntries = Object.entries(components).filter(([name]) => name !== "operational");
    const dependencyResults = await Promise.all(dependencyEntries.map(async (entry) => [entry[0], await probeComponent(entry)]));
    for (const [name, result] of dependencyResults) {
      results[name] = result;
      if (!result.ok || result.degraded) healthy = false;
    }
    if (components.operational) {
      const operationalResult = await probeComponent(["operational", components.operational]);
      results.operational = operationalResult;
      if (!operationalResult.ok || operationalResult.degraded) healthy = false;
    }

    // Probe results are complete before any recovery starts. This preserves
    // the exact dependency identity for /readyz failures and prevents one
    // parallel probe from clearing a sibling's failure state mid-recovery.
    const recoveryOrder = [
      ...Object.keys(components).filter((name) => name !== "operational"),
      ...(components.operational ? ["operational"] : []),
    ];
    for (const name of recoveryOrder) {
      const component = components[name];
      const result = results[name];
      if (!shouldRecoverComponent(component, result)) continue;
      try {
        await recovery.recover(name, `${FAILURE_THRESHOLD} consecutive failed probes`);
      } catch (error) {
        component.tracker.lastExternalProbeResult = {
          ...result,
          recoveryError: error instanceof Error ? error.message : String(error),
        };
      }
      // Downstream restart failure is not evidence that the core process is
      // dead. Keep the dependency degraded/circuit-open and avoid restarting
      // a healthy core, which only compounds the outage.
    }
    const state = healthy ? "healthy" : recovery.isRecovering() ? "recovering" : "degraded";
    writeStatus(statusFile, status(state, results.tunnel));
  }

  process.once("SIGINT", () => { stopping = true; recovery.setStopping(true); });
  process.once("SIGTERM", () => { stopping = true; recovery.setStopping(true); });
  writeStatus(statusFile, status("starting"));
  while (!stopping) {
    await tick();
    if (!stopping) await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  writeStatus(statusFile, status("stopped"));
  releaseRuntimeLock(stateDir, runtimeLockToken);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch((error) => { console.error(`[kontrol-supervisor] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
