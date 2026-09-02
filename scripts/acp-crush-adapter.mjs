#!/usr/bin/env node
// acp-crush-adapter.mjs
//
// ACP HTTP adapter that exposes the CRUSH CLI as an ACP-style HTTP
// endpoint. Kontrol dispatches work to it via POST /runs. The adapter
// spawns the coding agent, captures its output, and reports lifecycle
// events back to Kontrol.
//
// Usage:
//   node scripts/acp-crush-adapter.mjs
//
// Required env:
//   KONTROL_ACP_AGENT_SECRET: agent secret for registration/heartbeat
//   KONTROL_ACP_ADAPTER_SECRET: adapter secret for incoming /runs auth
//
// Optional:
//   CRUSH_BIN: path to the CRUSH CLI runner (used when ACP_AGENT_BIN=crush;
//              default: crush from PATH)
//   AGENT_CWD: fallback cwd only used if NO workspace_root is supplied AND the
//              registration is a smoke test. Real dispatches REQUIRE a valid
//              workspace_root (fail-closed, see validateWorkspaceRoot).

import { spawn } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { signWorkerToken, TOKEN_TTL_MS } from "./lib/acp-worker-token.mjs";
import { clearAgentIdentity, identityHeaders, loadAgentIdentity, saveAgentIdentity } from "./lib/acp-agent-identity.mjs";
import { readJsonBody, truncateUtf8Tail, writeAdapterError } from "./lib/adapter-http.mjs";
import { adapterStatePath, atomicWriteJson, processStartToken, reconcileOwnedProcesses, terminateProcessGroup } from "./lib/managed-agent-process.mjs";

const KONTROL_ACP_URL = process.env.KONTROL_ACP_URL || "http://127.0.0.1:7676/acp";
const AGENT_SECRET = process.env.KONTROL_ACP_AGENT_SECRET;
const ADAPTER_SECRET = process.env.KONTROL_ACP_ADAPTER_SECRET;
const AGENT_BIN = (process.env.ACP_AGENT_BIN || "crush").toLowerCase();
if (AGENT_BIN !== "crush") {
  throw new Error(
    `Unsupported ACP_AGENT_BIN=${AGENT_BIN}. This HTTP adapter only wraps the CRUSH CLI. ` +
    "Hermes must be integrated through its native `hermes acp` stdio server, not this subprocess adapter.",
  );
}
const CRUSH_BIN = process.env.CRUSH_BIN || "crush";
// Fallback cwd ONLY used when a dispatch carries no workspace_root at all (which
// Kontrol does not normally send — it always passes workspace_root). Kept for
// the synthetic smoke path. Never substituted for an invalid/mismatched root:
// a bad root is rejected (P0 #6), it is not redirected to another repo.
const AGENT_CWD = process.env.AGENT_CWD || process.cwd();
export const REGISTERED_AGENT_NAME = "cli-coding-agent";
export const SMOKE_LIFECYCLE_EVENTS = ["started", "completed"];
const HEARTBEAT_INTERVAL_MS = 55_000;
// Per-run heartbeat to Kontrol while a worker is active. Keeps the worker
// lease (workerLeaseUntil) alive so the durable Ralphie form survives a
// worker that blocks inside await_review_feedback for longer than the
// lease window. Cleared on spawn error / process exit.
const RUN_HEARTBEAT_MS = 10_000;
const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPLAY_STORE_PATH = process.env.ACP_ADAPTER_REPLAY_STORE || adapterStatePath("crush", "replay.json");
const OWNED_PROCESSES_PATH = process.env.KONTROL_CRUSH_OWNED_PROCESSES
  || process.env.KONTROL_ACP_OWNED_PROCESSES
  || adapterStatePath("crush", "owned-processes.json");
export const OUTPUT_TAIL_BYTES = 64 * 1024;
/** @deprecated Protocol budgets are bytes; retained for adapter compatibility. */
export const OUTPUT_TAIL_CHARS = OUTPUT_TAIL_BYTES;
// Telemetry stays bounded to a tail, but the authoritative final result gets
// its own larger budget so an expanded completion summary is not lost.
export const FINAL_OUTPUT_BYTES = 2 * 1024 * 1024;
/** @deprecated Protocol budgets are bytes; retained for adapter compatibility. */
export const FINAL_OUTPUT_CHARS = FINAL_OUTPUT_BYTES;

// Dedicated port variable — must NOT share the generic PORT that kontrol
// server reads, or the adapter collides with :7676 on boot.
const ADAPTER_PORT = parseInt(process.env.ACP_ADAPTER_PORT || "9877", 10);
const ADAPTER_HOST = process.env.ACP_ADAPTER_HOST || "127.0.0.1";

// NOTE: the "secret required" guard lives inside main() so this module can be
// imported for unit tests without KONTROL_ACP_* secrets present.
if (process.argv.includes("--validate-imports")) {
  console.log("[adapter] import validation ok");
  process.exit(0);
}

// Runner registry
const activeProcesses = new Map(); // pid -> { child, run }
const activeBySession = new Map(); // workSessionId -> run
const replayByDispatchKey = new Map(); // `${devRunId}:${continuationId}` -> accepted response
const ownedProcesses = new Map(); // remoteRunId -> durable detached-child identity
let agentIdentity = null;
let shuttingDown = false;
const adapterGenerationId = process.env.KONTROL_LAUNCH_GENERATION_ID || "unknown";
let reconciliationComplete = false;
let orphanProcessesTerminated = 0;

async function main() {
  if (!AGENT_SECRET) {
    console.error("[adapter] ERROR: KONTROL_ACP_AGENT_SECRET is required");
    process.exit(1);
  }
  if (!ADAPTER_SECRET) {
    console.error("[adapter] ERROR: KONTROL_ACP_ADAPTER_SECRET is required");
    process.exit(1);
  }
  const reconciliation = await reconcileOwnedProcesses(OWNED_PROCESSES_PATH, "adapter");
  orphanProcessesTerminated = reconciliation.terminated;
  reconciliationComplete = true;
  await loadReplayStore();
  agentIdentity = await registerAgent();
  startHeartbeat();

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("[adapter] request error:", err);
      try { writeAdapterError(res, err); } catch { /* ignore */ }
    });
  });
  server.listen(ADAPTER_PORT, ADAPTER_HOST, () => {
    console.log(`[adapter] listening on ${ADAPTER_HOST}:${ADAPTER_PORT}`);
  });
}

async function registerAgent() {
  // withRetry returns a boolean (fire-and-forget), but registration needs the
  // actual Response to read the created agent id — so fetch directly here.
  let identity = agentIdentity || await loadAgentIdentity(REGISTERED_AGENT_NAME);
  let lastErr = "";
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${KONTROL_ACP_URL}/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(identity) },
      body: JSON.stringify({
        name: REGISTERED_AGENT_NAME,
        url: `http://${ADAPTER_HOST}:${ADAPTER_PORT}`,
        description: `ACP adapter wrapping the ${AGENT_BIN} coding agent`,
        role: "agent",
        capabilities: ["file-read", "file-write", "shell", "submit-review", `agent:${AGENT_BIN}`],
        ttlSeconds: Math.max(60, Math.floor(HEARTBEAT_INTERVAL_MS / 1000) + 30),
      }),
    });
    if (res.ok) {
      const json = await res.json();
      const credential = typeof json.agentCredential === "string" ? json.agentCredential : identity?.agentCredential;
      if (typeof json.id !== "string" || !credential) throw new Error("registration response did not include a usable agent identity");
      const next = { agentId: json.id, agentCredential: credential };
      await saveAgentIdentity(REGISTERED_AGENT_NAME, next);
      console.log(`[adapter] registered as ${json.name} (id=${json.id})`);
      return next;
    }
    lastErr = await res.text().catch(() => "");
    if (res.status === 404 && identity) {
      await clearAgentIdentity(REGISTERED_AGENT_NAME);
      identity = undefined;
      agentIdentity = null;
      continue;
    }
    console.warn(`[adapter] register attempt ${i + 1} failed (${res.status}): ${lastErr}`);
    await sleep(1000 * Math.pow(2, i));
  }
  throw new Error(`Registration failed: ${lastErr}`);
}

function startHeartbeat() {
  const tick = async () => {
    if (shuttingDown) return;
    try {
      const res = await fetch(`${KONTROL_ACP_URL}/agents/${agentIdentity?.agentId}/heartbeat`, {
        method: "POST",
        headers: { authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(agentIdentity) },
      });
      if (res.status === 404) {
        console.warn("[adapter] heartbeat 404 — re-registering");
        agentIdentity = null;
        agentIdentity = await registerAgent();
      }
    } catch (err) {
      console.warn("[adapter] heartbeat failed:", err.message);
    }
  };
  setInterval(tick, HEARTBEAT_INTERVAL_MS);
}

async function handleRequest(req, res) {
  const url = req.url || "";
  const method = req.method || "";

  if (url === "/health" && method === "GET") {
    const ready = reconciliationComplete && !shuttingDown;
    return writeJson(res, ready ? 200 : 503, {
      ok: ready,
      ready,
      lifecycle: ready ? "READY" : "STARTING_RECONCILIATION",
      reconciled: reconciliationComplete,
      orphanProcessesTerminated,
      workers: activeProcesses.size,
      generationId: adapterGenerationId,
    });
  }

  if (url === "/runs" && method === "POST") {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${ADAPTER_SECRET}`) {
      console.warn(`[/runs] unauthorized adapter secret`);
      return res.writeHead(401).end(JSON.stringify({ error: { code: "unauthorized", message: "invalid adapter secret" } }));
    }
    const body = await readJsonBody(req);
    return handleRunRequest(req, res, body);
  }

  const cancelMatch = url.match(/^\/runs\/([^/]+)\/cancel$/);
  if (cancelMatch && method === "POST") {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${ADAPTER_SECRET}`) {
      return res.writeHead(401).end(JSON.stringify({ error: { code: "unauthorized", message: "invalid adapter secret" } }));
    }
    const remoteRunId = decodeURIComponent(cancelMatch[1]);
    const cancelled = cancelActiveRun(remoteRunId, "cancelled by Kontrol");
    if (!cancelled) {
      return writeJson(res, 404, { error: { code: "not_found", message: `active run not found: ${remoteRunId}` } });
    }
    return writeJson(res, 202, { run_id: remoteRunId, status: "cancelled" });
  }

  // Event reporting endpoint (Kontrol calls this for terminal events)
  const eventMatch = url.match(/^\/runs\/([^/]+)\/events$/);
  if (eventMatch && method === "POST") {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${AGENT_SECRET}`) {
      return res.writeHead(401).end();
    }
    return res.writeHead(202).end();
  }

  return res.writeHead(404).end(JSON.stringify({ error: { code: "not_found" } }));
}

async function handleRunRequest(req, res, body) {
  const devRunId = body.parent_run_id || body.run_id || `dev_${randomUUID()}`;
  const workspaceSessionId = body.workspace_session_id;
  // The Kontrol-owned work session (review/work-session) id. This is what binds
  // the worker to a specific review — distinct from workspace_session_id.
  const workSessionId = body.session_id;
  const agentId = body.agent_id;
  const continuationId = body.continuation_id;
  const task = extractTask(body.input);
  const token = body.token;
  const mode = body.mode;
  const workspaceRootRaw = body.workspace_root;
  const dispatchKey = continuationId ? `${devRunId}:${continuationId}` : undefined;
  const smokeTest = body.smoke_test === true || body?.metadata?.kontrol_smoke_test === true;

  if (!smokeTest && !task.trim()) {
    return writeJson(res, 400, { error: { code: "invalid_task", message: "ACP task must be non-empty" } });
  }

  console.log(`[/runs] dispatch runId=${devRunId} ws=${workspaceSessionId} wss=${workSessionId} taskBytes=${Buffer.byteLength(task, "utf8")}`);

  if (dispatchKey) {
    pruneReplayStore();
    const replay = replayByDispatchKey.get(dispatchKey);
    if (replay) {
      return writeJson(res, 202, { ...replay.response, replayed: true });
    }
  }

  // Idempotent reject on duplicate work session
  if (workSessionId && activeBySession.has(workSessionId)) {
    const existing = activeBySession.get(workSessionId);
    return writeJson(res, 409, {
      error: { code: "conflict", message: "A worker is already running for this work session" },
      run_id: existing.remoteRunId,
      work_session_id: workSessionId,
    });
  }

  const run = {
    remoteRunId: "crush_" + randomUUID().slice(0, 8),
    devRunId,
    workspaceSessionId,
    workSessionId,
    agentId,
    continuationId,
    workspaceRoot: null, // set below; validateWorkspaceRoot throws on bad input
    task,
    mode,
    token,
    workspaceLeaseNonce: body.workspace_lease_nonce,
    startedAt: Date.now(),
    finalized: false,
    stdout: "",
    stderr: "",
    finalOutput: "",
    lastActivityAt: Date.now(), // P2 #27: output liveness for the stuck-process detector
    sendChain: Promise.resolve(),
    outputBuffers: new Map(),
    outputTimers: new Map(),
    syntheticSmoke: false,
  };

  if (smokeTest) {
    // Synthetic smoke: never spawns a real process, so no workspace root is
    // required. Validate (best-effort) if one was supplied, else use AGENT_CWD.
    try {
      run.workspaceRoot = await validateWorkspaceRoot(workspaceRootRaw);
    } catch {
      run.workspaceRoot = AGENT_CWD;
    }
    run.remoteRunId = "smoke_" + randomUUID().slice(0, 8);
    run.stdout = "KONTROL_ADAPTER_SMOKE_OK";
    // A smoke request exercises the same lifecycle reporting path as a real
    // dispatch. It is synthetic, so it is not put into the terminal spool and
    // has no retry backoff when the supplied parent run is only a probe id.
    run.syntheticSmoke = true;
    for (const lifecycle of SMOKE_LIFECYCLE_EVENTS) await reportEvent(run, lifecycle);
    run.finalized = true;
    console.log(`[run ${run.remoteRunId}] synthetic smoke accepted cwd=${run.workspaceRoot} bin=${resolveAgentBin()}`);
    return writeJson(res, 202, {
      run_id: run.remoteRunId,
      remote_run_id: run.remoteRunId,
      accepted: true,
      mode: mode || "async",
      smoke_test: true,
      agent_bin: resolveAgentBin(),
    });
  }

  // P0 #6: resolve + validate the workspace root BEFORE spawning. Invalid or
  // missing roots throw InvalidWorkspaceRootError -> 400 (fail closed), never a
  // fallback to another repository.
  try {
    run.workspaceRoot = await validateWorkspaceRoot(workspaceRootRaw);
  } catch (err) {
    if (err instanceof InvalidWorkspaceRootError) {
      console.warn(`[/runs] rejecting dispatch: ${err.message}`);
      return writeJson(res, 400, { error: { code: "invalid_workspace_root", message: err.message } });
    }
    throw err;
  }

  // Issue a signed worker token so Kontrol can authenticate this worker's role
  // + bound session WITHOUT trusting client-supplied attribution headers. A worker
  // that omits/forges this token is treated as a (reviewer-role) client instead.
  if (workSessionId) {
    run.workerToken = signWorkerToken({
      role: "worker",
      workSessionId,
      workspaceSessionId: workspaceSessionId ?? "",
      runId: devRunId,
      continuationId,
      workspaceLeaseNonce: body.workspace_lease_nonce,
      exp: Date.now() + TOKEN_TTL_MS,
    }, AGENT_SECRET);
  }

  try {
    const child = spawnAgent(run);
    activeProcesses.set(child.pid, { child, run });
    run.childPid = child.pid;
    ownedProcesses.set(run.remoteRunId, {
      remoteRunId: run.remoteRunId,
      workSessionId: run.workSessionId,
      workspaceSessionId: run.workspaceSessionId,
      kontrolRunId: run.devRunId,
      pid: child.pid,
      processGroupId: child.pid,
      processStartToken: processStartToken(child.pid),
      workspaceRoot: run.workspaceRoot,
      adapterGenerationId,
      commandIdentity: `${CRUSH_BIN} run --debug --quiet`,
      startedAt: run.startedAt,
    });
    try {
      await saveOwnedProcesses();
    } catch (error) {
      const ownership = {
        pid: child.pid,
        processStartToken: processStartToken(child.pid),
      };
      activeProcesses.delete(child.pid);
      ownedProcesses.delete(run.remoteRunId);
      try { await terminateProcessGroup(ownership, 5_000); } catch { /* report the original persistence failure */ }
      throw new Error(`cannot durably record child ownership: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Per-run heartbeat (P1 #7): Kontrol writes workerLeaseUntil on each
    // heartbeat, so a long-lived worker does not appear to have leaked its
    // lease. Cleared on spawn error / exit.
    const heartbeatTimer = setInterval(() => {
      void reportEvent(run, "heartbeat");
      // P0 #5: zero-output idle is a SUSPECT signal, not authoritative proof
      // of a wedged process — a legitimate long test can be quiet. Two
      // bounded signals drive termination, both via terminateRun() so the
      // child is confirmed dead BEFORE the terminal event releases the lease:
      //   1. KONTROL_CRUSH_STUCK_IDLE_MS (default 60m): generous output-idle
      //      window; a run that exceeds it is treated as stuck.
      //   2. KONTROL_CRUSH_MAX_RUN_MS (default 24h): absolute emergency
      //      ceiling regardless of activity — the runaway backstop.
      const idleMs = Date.now() - (run.lastActivityAt ?? run.startedAt);
      const stuckAfterMs = Number(process.env.KONTROL_CRUSH_STUCK_IDLE_MS) > 0 ? Number(process.env.KONTROL_CRUSH_STUCK_IDLE_MS) : 60 * 60_000;
      const ceilingMs = Number(process.env.KONTROL_CRUSH_MAX_RUN_MS) > 0 ? Number(process.env.KONTROL_CRUSH_MAX_RUN_MS) : 24 * 60 * 60_000;
      const totalMs = Date.now() - run.startedAt;
      if (!run.finalized && !run.terminating) {
        if (totalMs > ceilingMs) {
          console.error(`[run ${run.remoteRunId}] emergency run ceiling exceeded after ${Math.round(totalMs / 60000)}m`);
          terminateRun(run, `emergency ceiling: run exceeded ${Math.round(ceilingMs / 60000)}m`);
        } else if (idleMs > stuckAfterMs) {
          console.warn(`[run ${run.remoteRunId}] stuck-process detector: no output activity for ${Math.round(idleMs / 1000)}s`);
          terminateRun(run, `stuck: no output activity for ${Math.round(idleMs / 1000)}s (exceeds KONTROL_CRUSH_STUCK_IDLE_MS)`);
        }
      }
    }, RUN_HEARTBEAT_MS);
    const stopHeartbeat = () => clearInterval(heartbeatTimer);

    child.on("spawn", () => {
      console.log(`[run ${run.remoteRunId}] spawned pid=${child.pid} cwd=${run.workspaceRoot}`);
      reportEvent(run, "started");
    });

    child.on("error", (err) => {
      console.error(`[run ${run.remoteRunId}] spawn error:`, err.message);
      stopHeartbeat();
      if (workSessionId && activeBySession.get(workSessionId) === run) activeBySession.delete(workSessionId);
      ownedProcesses.delete(run.remoteRunId);
      void saveOwnedProcesses().catch((error) => console.warn(`[adapter] failed to persist child ownership cleanup: ${error.message}`));
      if (!run.terminating) void finalizeRun(run, "failed", err.message);
    });

    child.on("exit", (code, signal) => {
      stopHeartbeat();
      activeProcesses.delete(child.pid);
      ownedProcesses.delete(run.remoteRunId);
      void saveOwnedProcesses().catch((error) => console.warn(`[adapter] failed to persist child ownership cleanup: ${error.message}`));
      // Key by workSessionId (the review/work-session id), consistent with the
      // duplicate-dispatch check at the top of handleRunRequest.
      if (workSessionId && activeBySession.get(workSessionId) === run) {
        activeBySession.delete(workSessionId);
      }
      if (run.finalized || run.terminating) return;
      if (code === 0) {
        void finalizeRun(run, "completed");
      } else {
        // A nonzero exit is an execution/infrastructure failure, NOT a protocol
        // violation. Report it as `failed` (which Kontrol persists) rather
        // than the unsupported `exited` type that Kontrol would reject with
        // HTTP 400 and silently strand the work session.
        void finalizeRun(
          run,
          "failed",
          signal ? `terminated by ${signal}` : `exit code ${code}`,
          { exitCode: code, signal },
        );
      }
    });

    child.stdout.on("data", (d) => {
      const text = d.toString();
      run.lastActivityAt = Date.now();
      run.stdout = appendBoundedOutput(run.stdout, text);
      run.finalOutput = appendBoundedOutput(run.finalOutput, text, FINAL_OUTPUT_CHARS);
      reportOutputDelta(run, text, "stdout");
    });
    child.stderr.on("data", (d) => {
      const text = d.toString();
      run.lastActivityAt = Date.now();
      run.stderr = appendBoundedOutput(run.stderr, text);
      reportOutputDelta(run, text, "stderr");
    });

    if (workSessionId) {
      activeBySession.set(workSessionId, run);
    }

    const acceptedResponse = {
      run_id: run.remoteRunId,
      remote_run_id: run.remoteRunId,
      accepted: true,
      mode: mode || "sync",
    };
    if (dispatchKey) {
      replayByDispatchKey.set(dispatchKey, { response: acceptedResponse, createdAt: Date.now() });
      void saveReplayStore();
    }
    return writeJson(res, 202, acceptedResponse);
  } catch (err) {
    return writeJson(res, 500, { error: { message: err.message } });
  }
}

// Normalize the ACP `input` (string OR [{role, parts:[{content}]}]) into the
// plain task string CRUSH expects. Without this, the array shape that
// callRemoteAgent() sends would be coerced to "[object Object]".
export function extractTask(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) {
    throw new Error("ACP input must be a string or message array");
  }
  return input
    .flatMap((message) =>
      Array.isArray(message?.parts)
        ? message.parts
            .map((part) => (typeof part?.content === "string" ? part.content : ""))
            .filter(Boolean)
        : [],
    )
    .join("\n");
}

// Exported so it can be unit-tested without spawning the model. The installed
// CRUSH build does not support `--no-color`; it supports `--quiet`, and the
// adapter already suppresses ANSI via NO_COLOR=1 in workerEnvironment().
export function buildCrushArgs() {
  return ["run", "--debug", "--quiet"];
}

export function buildAgentArgs() {
  return buildCrushArgs();
}

export function resolveAgentBin() {
  return CRUSH_BIN;
}

export function appendBoundedOutput(current, next, limit = OUTPUT_TAIL_CHARS) {
  const combined = `${current ?? ""}${next ?? ""}`;
  return truncateUtf8Tail(combined, limit);
}

function spawnAgent(run) {
  const bin = resolveAgentBin();
  const args = buildAgentArgs();
  console.log(`[run ${run.remoteRunId}] launching ${CRUSH_BIN} ${args.slice(0, 3).join(" ")} ...`);
  const child = spawn(bin, args, {
    cwd: run.workspaceRoot,
    env: workerEnvironment(run),
    detached: true,
  });
  child.stdin.end(run.task);
  return child;
}

function workerEnvironment(run) {
  const allowed = [
    "HOME",
    "PATH",
    "SHELL",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "CODEX_HOME",
    "CRUSH_HOME",
    "KONTROL_BRIDGE_URL",
    "KONTROL_BRIDGE_ENV",
  ];
  const env = {};
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  env.KONTROL_WORKSPACE_SESSION_ID = run.workspaceSessionId || "";
  if (run.workSessionId) env.KONTROL_WORK_SESSION_ID = run.workSessionId;
  if (run.devRunId) env.KONTROL_PARENT_RUN_ID = run.devRunId;
  if (run.continuationId) env.KONTROL_CONTINUATION_ID = run.continuationId;
  if (run.workspaceLeaseNonce) env.KONTROL_WORKSPACE_LEASE_NONCE = run.workspaceLeaseNonce;
  if (run.workerToken) env.KONTROL_WORKER_TOKEN = run.workerToken;
  return env;
}

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  return res.end(JSON.stringify(body));
}

async function loadReplayStore() {
  try {
    const parsed = JSON.parse(await readFile(REPLAY_STORE_PATH, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value.createdAt === "number" && value.response) {
        replayByDispatchKey.set(key, value);
      }
    }
    pruneReplayStore();
  } catch {
    // Missing or corrupt replay state just starts a fresh bounded window.
  }
}

function pruneReplayStore() {
  const cutoff = Date.now() - REPLAY_WINDOW_MS;
  for (const [key, value] of replayByDispatchKey) {
    if (!value?.createdAt || value.createdAt < cutoff) replayByDispatchKey.delete(key);
  }
}

async function saveReplayStore() {
  pruneReplayStore();
  const obj = Object.fromEntries(replayByDispatchKey);
  try {
    await atomicWriteJson(REPLAY_STORE_PATH, obj);
  } catch (err) {
    console.warn(`[adapter] failed to persist replay store: ${err.message}`);
  }
}

async function saveOwnedProcesses() {
  await atomicWriteJson(OWNED_PROCESSES_PATH, [...ownedProcesses.values()]);
}

// P0 #6: fail closed on an invalid/missing workspace root. A malformed or stale
// workspace id must NEVER be redirected to another repository (e.g. the Kontrol
// checkout). If Kontrol does not send a root, or the resolved path is not a
// real directory, reject the dispatch instead of executing elsewhere.
export class InvalidWorkspaceRootError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidWorkspaceRootError";
    this.code = "invalid_workspace_root";
  }
}

import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";

export async function validateWorkspaceRoot(workspaceRootRaw) {
  // Reject relative paths BEFORE resolve() — resolve() would silently turn a
  // relative input into an absolute path under cwd, defeating the check.
  if (!workspaceRootRaw || typeof workspaceRootRaw !== "string") {
    throw new InvalidWorkspaceRootError(
      "workspace_root is required for a real dispatch; refusing to substitute another directory",
    );
  }
  if (!isAbsolute(workspaceRootRaw)) {
    throw new InvalidWorkspaceRootError(`workspace_root must be absolute: ${workspaceRootRaw}`);
  }
  let real;
  try {
    real = await realpath(workspaceRootRaw);
  } catch {
    throw new InvalidWorkspaceRootError(`workspace_root does not resolve: ${workspaceRootRaw}`);
  }
  let info;
  try {
    info = await stat(real);
  } catch {
    throw new InvalidWorkspaceRootError(`workspace_root stat failed: ${real}`);
  }
  if (!info.isDirectory()) {
    throw new InvalidWorkspaceRootError(`workspace_root is not a directory: ${real}`);
  }
  return real;
}

async function finalizeRun(run, status, error, details) {
  if (run.finalized) {
    console.log(`[run ${run.remoteRunId}] already finalized, skip: ${status}`);
    return;
  }
  run.finalized = true;
  console.log(`[run ${run.remoteRunId}] finalize: ${status}${error ? `: ${error}` : ""}`);

  flushAllOutput(run);
  // Output telemetry and the terminal event share one ordered queue. This
  // prevents a final result from overtaking chunks that were already emitted
  // by CRUSH, and bounds request pressure on Kontrol.
  await run.sendChain;
  await reportEvent(run, status, error, details);
}

/**
 * P0 #4/#5: idempotent process termination used by stuck detection,
 * cancellation, and shutdown. The invariant is: the terminal event is only
 * emitted AFTER the child process group is confirmed dead. A failed logical
 * session with a released checkout lease must never leave a live coding-agent
 * process behind that could still modify the workspace.
 *
 * Sequence: SIGTERM process group -> bounded grace -> SIGKILL process group
 * -> confirm exit -> finalizeRun (terminal event).
 */
function terminateRun(run, reason, finalStatus = "failed") {
  if (run.finalized) {
    return Promise.resolve();
  }
  if (run.terminationPromise) {
    if (!run.finalized) console.warn(`[run ${run.remoteRunId}] terminate already in progress`);
    return run.terminationPromise;
  }
  run.terminating = true;
  run.terminationPromise = (async () => {
    const entry = run.childPid !== undefined ? activeProcesses.get(run.childPid) : undefined;
    const child = entry?.child;
    if (child) {
      const pid = child.pid;
      console.warn(`[run ${run.remoteRunId}] terminating process group ${pid}: ${reason}`);
      const graceMs = Number(process.env.KONTROL_CRUSH_TERMINATE_GRACE_MS) > 0
        ? Number(process.env.KONTROL_CRUSH_TERMINATE_GRACE_MS)
        : 5_000;
      const ownership = ownedProcesses.get(run.remoteRunId) ?? {
        pid,
        processGroupId: pid,
        processStartToken: processStartToken(pid),
      };
      const terminated = await terminateProcessGroup(ownership, graceMs);
      if (!terminated) {
        // Never publish a terminal event while a detached worker may still be
        // mutating the checkout. Leave the run fenced and retry the same
        // termination state machine; a later retry may succeed after a
        // transient process/cgroup race clears.
        console.error(`[run ${run.remoteRunId}] could not confirm process group ${pid} dead; terminal event withheld`);
        run.terminationPromise = null;
        setTimeout(() => {
          if (!run.finalized) void terminateRun(run, reason, finalStatus);
        }, 1_000).unref?.();
        return false;
      }
    }
    ownedProcesses.delete(run.remoteRunId);
    try {
      await saveOwnedProcesses();
    } catch (error) {
      console.error(`[adapter] failed to persist child ownership cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
    await finalizeRun(run, finalStatus, reason);
  })();
  return run.terminationPromise;
}

function cancelActiveRun(remoteRunId, reason) {
  for (const [pid, entry] of activeProcesses.entries()) {
    if (entry.run.remoteRunId !== remoteRunId) continue;
    const { run } = entry;
    void terminateRun(run, reason, "cancelled");
    return true;
  }
  return false;
}

async function reportEvent(run, type, errorMessage, details) {
  const terminal = type === "completed" || type === "failed" || type === "cancelled";
  return enqueueRunEvent(run, {
    remote_run_id: run.remoteRunId,
    work_session_id: run.workSessionId,
    type,
    payload: {
      status: type,
      exit_code: details?.exitCode,
      signal: details?.signal,
      elapsed: Date.now() - run.startedAt,
      stdout: run.stdout.slice(-2000),
      stderr: run.stderr.slice(-2000),
      ...(terminal && run.finalOutput ? { final_output: run.finalOutput } : {}),
      message: errorMessage || "",
    },
  }, terminal);
}

function enqueueRunEvent(run, event, terminal = false) {
  const durableTerminal = terminal && !run.syntheticSmoke
    ? spoolTerminalEvent(run.devRunId, event)
    : Promise.resolve();
  const delivery = run.sendChain
    .catch(() => undefined)
    .then(async () => {
      await durableTerminal;
      const success = await withRetry(() =>
        fetch(`${KONTROL_ACP_URL}/runs/${run.devRunId}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(agentIdentity) },
          body: JSON.stringify(event),
        }),
        terminal && !run.syntheticSmoke ? { retries: 3, backoff: 2000 } : { retries: 0, backoff: 0 },
      );
      if (!success) {
        console.error(`[run ${run.remoteRunId}] failed to report ${event.type}`);
        return false;
      }
      if (terminal) {
        pendingTerminalSpool.delete(run.devRunId);
        void saveTerminalSpool().catch((error) => console.warn(`[adapter] failed to persist terminal spool cleanup: ${error.message}`));
      }
      console.log(`[run ${run.remoteRunId}] reported ${event.type}`);
      return true;
    });
  run.sendChain = delivery.catch((error) => {
    console.error(`[run ${run.remoteRunId}] event delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  });
  return run.sendChain;
}

// ── P1 #12: terminal-event spool ─────────────────────────────
const SPOOL_PATH = process.env.KONTROL_CRUSH_TERMINAL_SPOOL
  || process.env.KONTROL_ACP_TERMINAL_SPOOL
  || adapterStatePath("crush", "terminal-spool.json");
const SPOOL_MAX_EVENTS = 100;
const pendingTerminalSpool = new Map();

function loadTerminalSpool() {
  try {
    const parsed = JSON.parse(readFileSync(SPOOL_PATH, "utf8"));
    if (Array.isArray(parsed)) for (const entry of parsed) pendingTerminalSpool.set(entry.runId, entry);
  } catch { /* empty or unreadable spool starts fresh */ }
}

async function saveTerminalSpool() {
  const entries = [...pendingTerminalSpool.values()].slice(-SPOOL_MAX_EVENTS);
  await atomicWriteJson(SPOOL_PATH, entries);
}

function spoolTerminalEvent(runId, payload) {
  pendingTerminalSpool.set(runId, { runId, payload, spooledAt: Date.now() });
  console.warn(`[run ${runId}] terminal event spooled for redrive (${pendingTerminalSpool.size} pending)`);
  return saveTerminalSpool();
}

async function flushTerminalSpool() {
  if (pendingTerminalSpool.size === 0) return;
  for (const [runId, entry] of [...pendingTerminalSpool]) {
    try {
      const res = await fetch(`${KONTROL_ACP_URL}/runs/${entry.runId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(agentIdentity) },
        body: JSON.stringify(entry.payload),
      });
      if (res.ok || res.status === 404 /* run already reconciled */) {
        pendingTerminalSpool.delete(runId);
        await saveTerminalSpool();
        console.log(`[spool] delivered spooled terminal event for ${entry.runId}`);
      }
    } catch { /* server still down; retry next cycle */ }
  }
}

loadTerminalSpool();
setInterval(() => void flushTerminalSpool(), 30_000).unref?.();

function reportOutputDelta(run, text, channel = "stdout") {
  if (!text || run.finalized) return Promise.resolve(false);
  const bounded = truncateUtf8Tail(String(text), OUTPUT_COALESCE_MAX_BYTES);
  let entry = run.outputBuffers.get(channel);
  if (!entry) {
    entry = { text: "", bytes: 0, count: 0 };
    run.outputBuffers.set(channel, entry);
  }
  entry.text += bounded;
  entry.bytes += Buffer.byteLength(bounded, "utf8");
  entry.count += 1;
  if (entry.bytes >= OUTPUT_COALESCE_MAX_BYTES) return flushOutput(run, channel);
  if (!run.outputTimers.has(channel)) {
    run.outputTimers.set(channel, setTimeout(() => {
      run.outputTimers.delete(channel);
      void flushOutput(run, channel);
    }, OUTPUT_COALESCE_INTERVAL_MS));
  }
  return Promise.resolve(true);
}

const OUTPUT_COALESCE_INTERVAL_MS = 250;
const OUTPUT_COALESCE_MAX_BYTES = 4096;

function flushOutput(run, channel) {
  const entry = run.outputBuffers.get(channel);
  if (!entry) return Promise.resolve(false);
  run.outputBuffers.delete(channel);
  const timer = run.outputTimers.get(channel);
  if (timer) {
    clearTimeout(timer);
    run.outputTimers.delete(channel);
  }
  return enqueueRunEvent(run, {
    remote_run_id: run.remoteRunId,
    work_session_id: run.workSessionId || undefined,
    type: "output_delta",
    payload: { text: entry.text, channel, coalesced: true, count: entry.count },
  }, false);
}

function flushAllOutput(run) {
  for (const channel of [...run.outputBuffers.keys()]) flushOutput(run, channel, true);
  for (const timer of run.outputTimers.values()) clearTimeout(timer);
  run.outputTimers.clear();
}

async function withRetry(fn, { retries = 2, backoff = 500 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fn();
      if (r.ok) return true;
      if (i === retries) return false;
    } catch (err) {
      console.warn(`[retry ${i + 1}] ${err.message}`);
    }
    await sleep(backoff * Math.pow(2, i));
  }
  return false;
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[adapter] shutting down...");
  await Promise.all([...activeProcesses.values()].map(({ run }) => terminateRun(run, "adapter shutdown", "cancelled")));
  await flushTerminalSpool();
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only auto-start when executed as the entry point (not when imported by a unit
// test). This lets src/acp-adapter.test.mjs import the pure builders and the
// fail-closed root validator without spinning up the HTTP server / registering
// an agent.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error("[adapter] fatal:", err);
    process.exit(1);
  });
}
