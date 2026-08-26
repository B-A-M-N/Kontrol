#!/usr/bin/env node
// Long-lived local process supervisor. It owns only the Kontrol tmux sessions
// named by start-all.sh and uses stateful failure thresholds so one transient
// tunnel timeout does not restart the whole stack.
import { existsSync, mkdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_INTERVAL_MS = 5_000;
const FAILURE_THRESHOLD = 3;
const ESCALATION_RESTART_THRESHOLD = 3;
const PROBE_TIMEOUT_MS = 1_500;

function readServerIdentity(stateDir) {
  try { return JSON.parse(readFileSync(join(stateDir, "server.identity.json"), "utf8")); }
  catch { return undefined; }
}

function processIsLive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 1) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

export class FailureTracker {
  constructor(name) {
    this.name = name;
    this.consecutiveFailures = 0;
    this.restartCount = 0;
    this.restartFailures = 0;
    this.lastHealthyAt = undefined;
    this.lastRestartReason = undefined;
    this.lastExternalProbeResult = undefined;
  }

  record(result, now = new Date().toISOString()) {
    this.lastExternalProbeResult = result;
    if (result.ok) {
      this.consecutiveFailures = 0;
      this.restartFailures = 0;
      this.lastHealthyAt = now;
      return;
    }
    this.consecutiveFailures += 1;
  }

  noteRestart(reason) {
    this.restartCount += 1;
    this.lastRestartReason = reason;
  }

  noteRestartFailure() {
    this.restartFailures += 1;
  }

  snapshot() {
    return {
      consecutiveFailures: this.consecutiveFailures,
      restartCount: this.restartCount,
      restartFailures: this.restartFailures,
      lastHealthyAt: this.lastHealthyAt,
      lastRestartReason: this.lastRestartReason,
      lastExternalProbeResult: this.lastExternalProbeResult,
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

function restartSession(name, root, command) {
  if (hasTmuxSession(name)) {
    spawnSync("tmux", ["send-keys", "-t", name, "C-c"], { stdio: "ignore" });
    spawnSync("sleep", ["2"], { stdio: "ignore" });
    if (hasTmuxSession(name)) spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
  }
  tmux(["new-session", "-d", "-s", name, "-c", root, launchCommand(root, command)]);
}

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
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
  const results = await Promise.all(urls.map(async (url) => ({ url, ...(await probeFn(url)) })));
  return { ok: results.every((result) => result.ok), results };
}

export function adapterHealthReady(health) {
  return health?.ok === true
    && health.ready === true
    && health.reconciled === true
    && health.lifecycle === "READY";
}

function writeStatus(statusFile, status) {
  mkdirSync(resolve(statusFile, ".."), { recursive: true });
  const temporary = `${statusFile}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(status, null, 2));
  renameSync(temporary, statusFile);
}

function buildComponents({ kontrolUrl, tunnelUrl, agents, crushPort, hermesPort, startCrush, startHermes, generationId, expectedBuildId }) {
  const identityEnv = `export KONTROL_LAUNCH_GENERATION_ID=${shellQuote(generationId)} KONTROL_EXPECTED_BUILD_ID=${shellQuote(expectedBuildId)};`;
  const components = {
    kontrol: {
      tracker: new FailureTracker("kontrol"),
      urls: [`${kontrolUrl}/healthz`, `${kontrolUrl}/core-readyz`],
      session: "kontrol-server",
      command: `set -a; source .env; set +a; ${identityEnv} exec node dist/cli.js serve`,
    },
    operational: {
      tracker: new FailureTracker("operational"),
      urls: [`${kontrolUrl}/readyz`],
      session: undefined,
      command: undefined,
    },
    tunnel: {
      tracker: new FailureTracker("tunnel"),
      urls: [`${tunnelUrl}/healthz`, `${tunnelUrl}/readyz`],
      session: "kontrol-tunnel",
      command: "exec scripts/kontrol-tunnel.sh",
    },
  };
  if (startCrush) {
    components.crush = {
      tracker: new FailureTracker("crush"),
      urls: [`http://127.0.0.1:${crushPort}/health`],
      requireReadyHealth: true,
      session: "kontrol-adapter-crush",
      command: `set -a; source .env; set +a; ${identityEnv} exec env ACP_AGENT_BIN=crush PORT=${Number(crushPort)} node scripts/acp-crush-adapter.mjs`,
    };
  }
  if (startHermes) {
    components.hermes = {
      tracker: new FailureTracker("hermes"),
      urls: [`http://127.0.0.1:${hermesPort}/health`],
      requireReadyHealth: true,
      session: "kontrol-adapter-hermes",
      command: `set -a; source .env; set +a; ${identityEnv} exec env HERMES_ACP_ADAPTER_PORT=${Number(hermesPort)} node scripts/acp-hermes-native-adapter.mjs`,
    };
  }
  for (const agent of agents) {
    const name = `agent:${agent.name}`;
    components[name] = {
      tracker: new FailureTracker(name),
      urls: [`${String(agent.url).replace(/\/$/, "")}/health`],
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
  const agents = parseAgentSpecs(arg("--agents", ""));
  const crushPort = arg("--crush-port", process.env.ACP_ADAPTER_PORT || "9877");
  const hermesPort = arg("--hermes-port", process.env.HERMES_ACP_ADAPTER_PORT || "9911");
  const startCrush = arg("--start-crush", "false") === "true";
  const startHermes = arg("--start-hermes", "false") === "true";
  const intervalMs = Number(arg("--interval-ms", process.env.KONTROL_SUPERVISOR_INTERVAL_MS || DEFAULT_INTERVAL_MS));
  const components = buildComponents({ kontrolUrl, tunnelUrl, agents, crushPort, hermesPort, startCrush, startHermes, generationId, expectedBuildId });
  const startedAt = new Date().toISOString();
  let stopping = false;
  let recovering = false;

  const status = (state, externalProbeResult) => ({
    ok: state === "healthy",
    state,
    pid: process.pid,
    startedAt,
    updatedAt: new Date().toISOString(),
    lastHealthyAt: Object.values(components).map(({ tracker }) => tracker.lastHealthyAt).filter(Boolean).sort().at(-1),
    consecutiveFailures: Object.values(components).reduce((sum, { tracker }) => sum + tracker.consecutiveFailures, 0),
    restartCount: Object.values(components).reduce((sum, { tracker }) => sum + tracker.restartCount, 0),
    lastRestartReason: Object.values(components).map(({ tracker }) => tracker.lastRestartReason).filter(Boolean).at(-1),
    lastExternalProbeResult: externalProbeResult,
    generationId,
    expectedBuildId: expectedBuildId || undefined,
    serverIdentity: readServerIdentity(stateDir),
    components: Object.fromEntries(Object.entries(components).map(([name, component]) => [name, component.tracker.snapshot()])),
  });

  async function restart(name, reason) {
    const component = components[name];
    if (!component || !component.session || !component.command) return;
    component.tracker.noteRestart(reason);
    restartSession(component.session, root, component.command);
  }

  async function recover(name, reason) {
    if (recovering) return;
    recovering = true;
    try {
      if (name === "operational") {
        const failedAdapter = ["crush", "hermes"].find((dependency) => components[dependency]?.tracker.consecutiveFailures > 0);
        if (failedAdapter) {
          await restart(failedAdapter, `operational readiness traced to ${failedAdapter}`);
        } else if (components.kontrol.tracker.consecutiveFailures > 0) {
          await restart("kontrol", reason);
        }
        // If every dependency is healthy, an aggregate readiness failure is
        // not evidence that the core process should be restarted. Preserve the
        // degraded status for diagnosis instead of creating a restart storm.
        return;
      }
      await restart(name, reason);
      if (name === "tunnel") return;
      if (name === "kontrol") {
        // A KONTROL restart invalidates the adapter registration view. Restart
        // adapters in the same dependency chain, then reconnect the tunnel.
        for (const dependency of ["crush", "hermes", "tunnel"]) {
          if (components[dependency]) await restart(dependency, `dependency chain after ${name} recovery`);
        }
      }
    } finally {
      recovering = false;
    }
  }

  async function tick() {
    const results = {};
    let healthy = true;
    const probeComponent = async ([name, component]) => {
      let result = await allHealthy(name, component.urls);
      if (result.ok && component.requireReadyHealth) {
        const health = result.results.find((entry) => entry.body !== undefined)?.body;
        if (!adapterHealthReady(health)) {
          result = {
            ...result,
            ok: false,
            healthError: "adapter health did not prove reconciled READY state",
          };
        }
      }
      if (name === "kontrol" && result.ok) {
        const identity = readServerIdentity(stateDir);
        const identityMatches = Boolean(identity)
          && (generationId === "unknown" || identity.generationId === generationId)
          && (!expectedBuildId || identity.buildId === expectedBuildId)
          && processIsLive(identity.pid);
        result = {
          ...result,
          ok: identityMatches,
          identity: identity ? {
            instanceId: identity.instanceId,
            pid: identity.pid,
            generationId: identity.generationId,
            buildId: identity.buildId,
            live: processIsLive(identity.pid),
          } : undefined,
          identityError: identityMatches ? undefined : "server identity does not match this launch generation/build",
        };
      }
      component.tracker.record(result);
      results[name] = result;
      if (!result.ok) healthy = false;
    };

    // Probe worker/tunnel/core dependencies first and in parallel. Aggregate
    // /readyz is evaluated only after those concrete failure identities are
    // recorded, so it cannot cause a core restart merely because a worker is
    // down or because aggregate readiness is lagging one supervisor tick.
    const dependencyEntries = Object.entries(components).filter(([name]) => name !== "operational");
    await Promise.all(dependencyEntries.map(probeComponent));
    if (components.operational) await probeComponent(["operational", components.operational]);

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
      if (!component || !result || result.ok || component.tracker.consecutiveFailures < FAILURE_THRESHOLD) continue;
      try {
        await recover(name, `${FAILURE_THRESHOLD} consecutive failed probes`);
        component.tracker.consecutiveFailures = 0;
      } catch (error) {
        component.tracker.noteRestartFailure();
        component.tracker.lastExternalProbeResult = {
          ...result,
          recoveryError: error instanceof Error ? error.message : String(error),
        };
      }
      if (component.tracker.restartFailures >= ESCALATION_RESTART_THRESHOLD && name !== "kontrol" && name !== "operational") {
        try {
          await recover("kontrol", `${name} restart threshold exceeded`);
        } catch (error) {
          components.kontrol.tracker.noteRestartFailure();
          components.kontrol.tracker.lastExternalProbeResult = { ok: false, recoveryError: error instanceof Error ? error.message : String(error) };
        }
      }
    }
    const state = healthy ? "healthy" : recovering ? "recovering" : "degraded";
    writeStatus(statusFile, status(state, results.tunnel));
  }

  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  writeStatus(statusFile, status("starting"));
  while (!stopping) {
    await tick();
    if (!stopping) await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  writeStatus(statusFile, status("stopped"));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch((error) => { console.error(`[kontrol-supervisor] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
