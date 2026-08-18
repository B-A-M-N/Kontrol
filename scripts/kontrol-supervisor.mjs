#!/usr/bin/env node
// Long-lived local process supervisor. It owns only the Kontrol tmux sessions
// named by start-all.sh and uses stateful failure thresholds so one transient
// tunnel timeout does not restart the whole stack.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_INTERVAL_MS = 5_000;
const FAILURE_THRESHOLD = 3;
const ESCALATION_RESTART_THRESHOLD = 3;
const PROBE_TIMEOUT_MS = 1_500;

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
    return { ok: response.status === 200, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

async function allHealthy(component, urls) {
  const results = [];
  for (const url of urls) results.push({ url, ...(await probe(url)) });
  return { ok: results.every((result) => result.ok), results };
}

function writeStatus(statusFile, status) {
  mkdirSync(resolve(statusFile, ".."), { recursive: true });
  const temporary = `${statusFile}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(status, null, 2));
  renameSync(temporary, statusFile);
}

function buildComponents({ kontrolUrl, tunnelUrl, agents, crushPort, hermesPort, startCrush, startHermes }) {
  const components = {
    kontrol: {
      tracker: new FailureTracker("kontrol"),
      urls: [`${kontrolUrl}/healthz`, `${kontrolUrl}/core-readyz`],
      session: "kontrol-server",
      command: "set -a; source .env; set +a; exec node dist/cli.js serve",
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
      session: "kontrol-adapter-crush",
      command: `set -a; source .env; set +a; exec env ACP_AGENT_BIN=crush PORT=${Number(crushPort)} node scripts/acp-crush-adapter.mjs`,
    };
  }
  if (startHermes) {
    components.hermes = {
      tracker: new FailureTracker("hermes"),
      urls: [`http://127.0.0.1:${hermesPort}/health`],
      session: "kontrol-adapter-hermes",
      command: `set -a; source .env; set +a; exec env HERMES_ACP_ADAPTER_PORT=${Number(hermesPort)} node scripts/acp-hermes-native-adapter.mjs`,
    };
  }
  void agents;
  return components;
}

async function main() {
  const root = resolve(arg("--root", process.cwd()));
  const kontrolUrl = originFromUrl(arg("--kontrol-url", "http://127.0.0.1:7676"));
  const tunnelUrl = arg("--tunnel-url", "http://127.0.0.1:8080").replace(/\/$/, "");
  const statusFile = resolve(arg("--status-file", join(process.env.KONTROL_STATE_DIR || join(root, ".kontrol-state"), "supervisor-status.json")));
  const agents = parseAgentSpecs(arg("--agents", ""));
  const crushPort = arg("--crush-port", process.env.ACP_ADAPTER_PORT || "9877");
  const hermesPort = arg("--hermes-port", process.env.HERMES_ACP_ADAPTER_PORT || "9911");
  const startCrush = arg("--start-crush", "false") === "true";
  const startHermes = arg("--start-hermes", "false") === "true";
  const intervalMs = Number(arg("--interval-ms", process.env.KONTROL_SUPERVISOR_INTERVAL_MS || DEFAULT_INTERVAL_MS));
  const components = buildComponents({ kontrolUrl, tunnelUrl, agents, crushPort, hermesPort, startCrush, startHermes });
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
        await restart(failedAdapter ?? "kontrol", failedAdapter ? `operational readiness traced to ${failedAdapter}` : reason);
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
    for (const [name, component] of Object.entries(components)) {
      const result = await allHealthy(name, component.urls);
      component.tracker.record(result);
      results[name] = result;
      if (!result.ok) healthy = false;
      if (!result.ok && component.tracker.consecutiveFailures >= FAILURE_THRESHOLD) {
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
  writeStatus(status("stopped"));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch((error) => { console.error(`[kontrol-supervisor] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
