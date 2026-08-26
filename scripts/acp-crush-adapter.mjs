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
const HEARTBEAT_INTERVAL_MS = 55_000;
// Per-run heartbeat to Kontrol while a worker is active. Keeps the worker
// lease (workerLeaseUntil) alive so the durable Ralphie form survives a
// worker that blocks inside await_review_feedback for longer than the
// lease window. Cleared on spawn error / process exit.
const RUN_HEARTBEAT_MS = 10_000;
const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPLAY_STORE_PATH = process.env.ACP_ADAPTER_REPLAY_STORE || "/tmp/kontrol-acp-adapter-replay.json";
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
let agentIdentity = null;
let shuttingDown = false;

async function main() {
  if (!AGENT_SECRET) {
    console.error("[adapter] ERROR: KONTROL_ACP_AGENT_SECRET is required");
    process.exit(1);
  }
  if (!ADAPTER_SECRET) {
    console.error("[adapter] ERROR: KONTROL_ACP_ADAPTER_SECRET is required");
    process.exit(1);
  }
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
    return res.writeHead(200).end(JSON.stringify({ ok: true, workers: activeProcesses.size }));
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
    startedAt: Date.now(),
    finalized: false,
    stdout: "",
    stderr: "",
    finalOutput: "",
    lastActivityAt: Date.now(), // P2 #27: output liveness for the stuck-process detector
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
    run.finalized = true; // P1 #14: smoke never reports lifecycle events
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
      exp: Date.now() + TOKEN_TTL_MS,
    }, AGENT_SECRET);
  }

  try {
    const child = spawnAgent(run);
    activeProcesses.set(child.pid, { child, run });
    run.childPid = child.pid;

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
      finalizeRun(run, "failed", err.message);
    });

    child.on("exit", (code, signal) => {
      stopHeartbeat();
      activeProcesses.delete(child.pid);
      // Key by workSessionId (the review/work-session id), consistent with the
      // duplicate-dispatch check at the top of handleRunRequest.
      if (workSessionId && activeBySession.get(workSessionId) === run) {
        activeBySession.delete(workSessionId);
      }
      if (run.finalized) return;
      if (code === 0) {
        finalizeRun(run, "completed");
      } else {
        // A nonzero exit is an execution/infrastructure failure, NOT a protocol
        // violation. Report it as `failed` (which Kontrol persists) rather
        // than the unsupported `exited` type that Kontrol would reject with
        // HTTP 400 and silently strand the work session.
        finalizeRun(
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
      reportOutputDelta(run, text);
    });
    child.stderr.on("data", (d) => {
      const text = d.toString();
      run.lastActivityAt = Date.now();
      run.stderr = appendBoundedOutput(run.stderr, text);
      reportOutputDelta(run, text);
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
    await writeFile(REPLAY_STORE_PATH, JSON.stringify(obj), { mode: 0o600 });
  } catch (err) {
    console.warn(`[adapter] failed to persist replay store: ${err.message}`);
  }
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

function finalizeRun(run, status, error, details) {
  if (run.finalized) {
    console.log(`[run ${run.remoteRunId}] already finalized, skip: ${status}`);
    return;
  }
  run.finalized = true;
  console.log(`[run ${run.remoteRunId}] finalize: ${status}${error ? `: ${error}` : ""}`);

  reportEvent(run, status, error, details);
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
  if (run.finalized || run.terminating) {
    if (!run.finalized) console.warn(`[run ${run.remoteRunId}] terminate already in progress`);
    return;
  }
  run.terminating = true;
  const entry = run.childPid !== undefined ? activeProcesses.get(run.childPid) : undefined;
  const child = entry?.child;
  if (!child) {
    // No live process to reap; safe to emit the terminal event immediately.
    finalizeRun(run, finalStatus, reason);
    return;
  }
  const pid = child.pid;
  console.warn(`[run ${run.remoteRunId}] terminating process group ${pid}: ${reason}`);
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
  const graceMs = Number(process.env.KONTROL_CRUSH_TERMINATE_GRACE_MS) > 0
    ? Number(process.env.KONTROL_CRUSH_TERMINATE_GRACE_MS)
    : 5_000;
  const poll = setInterval(() => {
    let alive = false;
    try { alive = process.kill(-pid, 0); } catch { /* ESRCH: gone */ }
    if (!alive && !activeProcesses.has(pid)) {
      clearInterval(poll);
      clearTimeout(escalate);
      finalizeRun(run, finalStatus, reason);
      return;
    }
  }, 200);
  const escalate = setTimeout(() => {
    clearInterval(poll);
    console.error(`[run ${run.remoteRunId}] SIGTERM ignored — escalating to SIGKILL for process group ${pid}`);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
    // Give the kill a moment, then finalize regardless. Exit handlers will
    // reconcile if the process somehow lingers.
    setTimeout(() => finalizeRun(run, finalStatus, `${reason} (escalated to SIGKILL)`), 500).unref?.();
  }, graceMs);
  escalate.unref?.();
}

function cancelActiveRun(remoteRunId, reason) {
  for (const [pid, entry] of activeProcesses.entries()) {
    if (entry.run.remoteRunId !== remoteRunId) continue;
    const { child, run } = entry;
    if (run.workSessionId && activeBySession.get(run.workSessionId) === run) {
      activeBySession.delete(run.workSessionId);
    }
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }
    finalizeRun(run, "cancelled", reason);
    setTimeout(() => {
      if (activeProcesses.has(pid)) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }
    }, 1500).unref?.();
    return true;
  }
  return false;
}

async function reportEvent(run, type, errorMessage, details) {
  const terminal = type === "completed" || type === "failed" || type === "cancelled";
  const payload = {
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
  };
  const success = await withRetry(() =>
    fetch(`${KONTROL_ACP_URL}/runs/${run.devRunId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(agentIdentity) },
      body: JSON.stringify(payload),
    }),
    { retries: 3, backoff: 2000 },
  );
  if (!success) {
    console.error(`[run ${run.remoteRunId}] failed to report ${type}`);
    if (terminal) {
      // P1 #12: terminal events are authoritative — a Kontrol outage at the
      // moment the worker exits must not lose them. Spool durably (0600) for
      // redrive by the background flush loop.
      spoolTerminalEvent(run.devRunId, payload);
    }
  } else {
    console.log(`[run ${run.remoteRunId}] reported ${type}`);
  }
}

// ── P1 #12: terminal-event spool ─────────────────────────────
const SPOOL_PATH = process.env.KONTROL_ACP_TERMINAL_SPOOL || "/tmp/kontrol-acp-terminal-spool.json";
const SPOOL_MAX_EVENTS = 100;
const pendingTerminalSpool = new Map();

function loadTerminalSpool() {
  try {
    const parsed = JSON.parse(readFileSync(SPOOL_PATH, "utf8"));
    if (Array.isArray(parsed)) for (const entry of parsed) pendingTerminalSpool.set(entry.runId, entry);
  } catch { /* empty or unreadable spool starts fresh */ }
}

async function saveTerminalSpool() {
  try {
    const entries = [...pendingTerminalSpool.values()].slice(-SPOOL_MAX_EVENTS);
    await writeFile(SPOOL_PATH, JSON.stringify(entries), { mode: 0o600 });
  } catch (err) {
    console.warn(`[adapter] failed to persist terminal-event spool: ${err.message}`);
  }
}

function spoolTerminalEvent(runId, payload) {
  pendingTerminalSpool.set(runId, { runId, payload, spooledAt: Date.now() });
  void saveTerminalSpool();
  console.warn(`[run ${runId}] terminal event spooled for redrive (${pendingTerminalSpool.size} pending)`);
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

async function reportOutputDelta(run, text) {
  try {
    const payload = {
      remote_run_id: run.remoteRunId,
      work_session_id: run.workSessionId || undefined,
      type: "output_delta",
      payload: { text: text.slice(-1000) },
    };
    await fetch(`${KONTROL_ACP_URL}/runs/${run.devRunId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(agentIdentity) },
      body: JSON.stringify(payload),
    });
  } catch { /* best effort */ }
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
  for (const { child, run } of activeProcesses.values()) {
    try {
      process.kill(-child.pid, "SIGTERM");
      finalizeRun(run, "cancelled", "adapter shutdown");
    } catch { /* ignore */ }
  }
  await sleep(1500);
  for (const { child } of activeProcesses.values()) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* ignore */ }
  }
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
