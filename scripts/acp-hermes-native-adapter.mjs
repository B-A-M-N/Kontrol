#!/usr/bin/env node
// Native Hermes ACP bridge.
//
// This adapter registers `hermes-agent` as an HTTP ACP peer for Kontrol, but
// executes turns by spawning Hermes's native `hermes acp` stdio server through
// scripts/hermes-native-runner.py. It is separate from acp-crush-adapter.mjs on
// purpose: Hermes must not be represented as a CRUSH-style subprocess wrapper.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { clearAgentIdentity, identityHeaders, loadAgentIdentity, saveAgentIdentity } from "./lib/acp-agent-identity.mjs";
import { readJsonBody, truncateUtf8Tail, writeAdapterError } from "./lib/adapter-http.mjs";

const KONTROL_ACP_URL = process.env.KONTROL_ACP_URL || "http://127.0.0.1:7676/acp";
const AGENT_SECRET = process.env.KONTROL_ACP_AGENT_SECRET;
const ADAPTER_SECRET = process.env.KONTROL_ACP_ADAPTER_SECRET;
const HERMES_BIN = process.env.HERMES_BIN || "hermes";
const HERMES_AGENT_ROOT = process.env.HERMES_AGENT_ROOT || detectHermesAgentRoot() || process.cwd();
const ADAPTER_PORT = Number(process.env.HERMES_ACP_ADAPTER_PORT || process.env.ACP_ADAPTER_PORT || "9911");
const ADAPTER_HOST = process.env.HERMES_ACP_ADAPTER_HOST || "127.0.0.1";
const RUNNER = new URL("./hermes-native-runner.py", import.meta.url).pathname;
const HERMES_ACP_COMPAT_PATH = new URL("./hermes-acp-compat", import.meta.url).pathname;
const DEADMAN_IDLE_MS = positiveDuration(process.env.KONTROL_HERMES_DEADMAN_IDLE_MS, 5 * 60_000);
const MAX_RUN_MS = positiveDuration(process.env.KONTROL_HERMES_MAX_RUN_SECONDS, 2 * 60 * 60) * 1000;
const FINAL_OUTPUT_BYTES = 2 * 1024 * 1024;

if (process.argv.includes("--validate-imports")) {
  console.log("[hermes-native] import validation ok");
  process.exit(0);
}

if (!AGENT_SECRET || !ADAPTER_SECRET) {
  console.error("[hermes-native] KONTROL_ACP_AGENT_SECRET and KONTROL_ACP_ADAPTER_SECRET are required");
  process.exit(1);
}

const check = spawnSync(HERMES_BIN, ["acp", "--check"], {
  encoding: "utf8",
  env: {
    ...process.env,
    HERMES_AGENT_ROOT,
    PYTHONPATH: withHermesPythonPath(process.env.PYTHONPATH),
  },
});
if (check.status !== 0) {
  console.error("[hermes-native] hermes acp --check failed; refusing to register hermes-agent");
  console.error((check.stderr || check.stdout || "").trim());
  process.exit(1);
}

const PYTHON_BIN = resolveHermesPython();
let degraded = PYTHON_BIN === null;
const active = new Map();
let agentIdentity = null;

if (degraded) {
  console.error("[hermes-native] starting in DEGRADED mode — Hermes runs will be rejected until fixed");
  console.error("Set HERMES_NATIVE_PYTHON to the Hermes virtualenv Python, e.g. /path/to/hermes-agent/.venv/bin/python");
} else {
  try {
    await registerAgentWithRetry();
    setInterval(() => heartbeat().catch((err) => console.warn("[hermes-native] heartbeat:", err.message)), 55_000);
  } catch (err) {
    degraded = true;
    console.error(`[hermes-native] starting in DEGRADED mode — agent registration failed: ${err.message}`);
    console.error("Hermes runs will be rejected until Kontrol is reachable and registration succeeds.");
  }
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[hermes-native] request error:", err);
    writeAdapterError(res, err);
  });
}).listen(ADAPTER_PORT, ADAPTER_HOST, () => {
  console.log(`[hermes-native] listening on ${ADAPTER_HOST}:${ADAPTER_PORT}`);
});

async function registerAgentWithRetry() {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await registerAgent();
      return;
    } catch (err) {
      lastError = err;
      console.warn(`[hermes-native] registration attempt ${attempt} failed: ${err.message}`);
      await sleep(Math.min(1000 * attempt, 5000));
    }
  }
  throw lastError;
}

async function registerAgent() {
  let identity = agentIdentity || await loadAgentIdentity("hermes-agent");
  const res = await fetch(`${KONTROL_ACP_URL}/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(identity) },
    body: JSON.stringify({
      name: "hermes-agent",
      url: `http://${ADAPTER_HOST}:${ADAPTER_PORT}`,
      description: "Native Hermes ACP stdio bridge with HTTP approval bridge",
      role: "agent",
      capabilities: ["native-acp", "streaming", "tool-events", "http-approval-bridge", "review-barrier"],
      ttlSeconds: 90,
    }),
  });
  if (!res.ok) {
    if (res.status === 404 && identity) {
      await clearAgentIdentity("hermes-agent");
      agentIdentity = null;
      return registerAgent();
    }
    throw new Error(`registration failed ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const credential = typeof json.agentCredential === "string" ? json.agentCredential : identity?.agentCredential;
  if (typeof json.id !== "string" || !credential) throw new Error("registration response did not include a usable agent identity");
  agentIdentity = { agentId: json.id, agentCredential: credential };
  await saveAgentIdentity("hermes-agent", agentIdentity);
  console.log(`[hermes-native] registered as hermes-agent (id=${agentIdentity.agentId})`);
}

async function heartbeat() {
  if (!agentIdentity) return;
  const res = await fetch(`${KONTROL_ACP_URL}/agents/${agentIdentity.agentId}/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(agentIdentity) },
  });
  if (res.status === 404) {
    agentIdentity = null;
    await registerAgentWithRetry();
  }
}

async function handle(req, res) {
  if (req.method === "GET" && req.url === "/health") {
    return writeJson(res, 200, { ok: !degraded, degraded, agent: "hermes-agent", active: active.size, native: true });
  }
  const cancelMatch = (req.url || "").match(/^\/runs\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelMatch) {
    if ((req.headers.authorization || "") !== `Bearer ${ADAPTER_SECRET}`) {
      return writeJson(res, 401, { error: { code: "unauthorized" } });
    }
    const remoteRunId = decodeURIComponent(cancelMatch[1]);
    const run = active.get(remoteRunId);
    if (!run) {
      return writeJson(res, 404, { error: { code: "not_found", message: `active run not found: ${remoteRunId}` } });
    }
    cancelRun(run, "cancelled by Kontrol");
    return writeJson(res, 202, { run_id: remoteRunId, status: "cancelled" });
  }
  if (req.method !== "POST" || req.url !== "/runs") {
    return writeJson(res, 404, { error: { code: "not_found" } });
  }
  if ((req.headers.authorization || "") !== `Bearer ${ADAPTER_SECRET}`) {
    return writeJson(res, 401, { error: { code: "unauthorized" } });
  }
  const body = await readJsonBody(req);
  if (degraded) {
    return writeJson(res, 503, { error: { code: "degraded", message: "Hermes adapter is degraded: no Python interpreter found" } });
  }
  if (body.smoke_test) {
    return writeJson(res, 202, { run_id: "hermes-native-smoke", smoke_test: true, native: true, accepted: true });
  }

  const workspaceRoot = await validateWorkspaceRoot(body.workspace_root);
  const run = {
    remoteRunId: `hermes_${randomUUID().slice(0, 8)}`,
    devRunId: body.parent_run_id || body.run_id,
    workSessionId: body.session_id,
    workspaceSessionId: body.workspace_session_id,
    agentId: body.agent_id,
    task: extractTask(body.input),
    workspaceRoot,
    child: null,
    lifecycle: "STARTING",
    finalized: false,
    explicitCompletion: false,
    pendingPermissions: new Map(),
    activeChildOperations: new Set(),
    lastRunnerActivityAt: Date.now(),
    absoluteDeadlineAt: Date.now() + MAX_RUN_MS,
    sawAgentMessage: false,
    sendChain: Promise.resolve(),
    deliveryErrors: [],
    terminalOutcome: null,
    finalOutput: "",
  };
  if (run.workSessionId && hasActiveSession(run.workSessionId)) {
    return writeJson(res, 409, { error: { code: "duplicate_session", message: `work session already active: ${run.workSessionId}` } });
  }
  active.set(run.remoteRunId, run);
  reportEvent(run, "started");
  const heartbeatTimer = setInterval(() => reportEvent(run, "heartbeat"), 20_000);

  const child = spawn(PYTHON_BIN, [RUNNER], {
    cwd: workspaceRoot,
    detached: true,
    env: {
      ...safeEnv(),
      HERMES_AGENT_ROOT,
      PYTHONPATH: withHermesPythonPath(process.env.PYTHONPATH),
      KONTROL_HERMES_NATIVE_INPUT: JSON.stringify({
        command: HERMES_BIN,
        args: ["acp"],
        cwd: workspaceRoot,
        task: run.task,
        runId: run.remoteRunId,
        maxRunSeconds: Math.floor(MAX_RUN_MS / 1000),
      }),
    },
  });
  run.child = child;
  run.lifecycle = "RUNNING";

  // P1 #11: The Python runner is the authoritative turn-end detector.
  // It emits {"type":"complete"} when the turn is done. The JS adapter
  // does NOT independently decide "turn completed" — that was the duplicate
  // 20-second heuristic. The deadman timer is a periodic idle-activity
  // check, NOT a wall-clock run limit — a healthy long-running task must
  // never be killed merely because it has been running for a long time.
  run.deadmanTimer = setInterval(() => {
    if (run.finalized) return;
    if (Date.now() >= run.absoluteDeadlineAt) {
      const elapsedMs = Date.now() - (run.absoluteDeadlineAt - MAX_RUN_MS);
      console.warn(`[hermes-native] absolute run ceiling for ${run.remoteRunId} — ${elapsedMs}ms elapsed`);
      finalizeRun(run, "failed", `absolute run ceiling exceeded — ${Math.round(elapsedMs / 1000)}s`);
      terminateChild(run, "absolute run ceiling");
      return;
    }
    // A permission request or explicitly reported child operation is
    // meaningful activity even when Hermes is quiet while it runs. The
    // absolute ceiling remains the final safety boundary for a wedged child.
    if (run.pendingPermissions.size > 0 || run.activeChildOperations.size > 0) return;
    const idleMs = Date.now() - run.lastRunnerActivityAt;
    if (idleMs > DEADMAN_IDLE_MS) {
      console.warn(`[hermes-native] deadman idle timeout for ${run.remoteRunId} — ${idleMs}ms since last runner event`);
      finalizeRun(run, "failed", `deadman idle timeout — no runner event for ${Math.round(idleMs / 1000)}s`);
      terminateChild(run, "deadman idle timeout");
    }
  }, 30_000).unref?.();

  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      handleRunnerLine(run, line);
    }
  });
  child.stderr.on("data", (chunk) => reportOutput(run, String(chunk), "stderr"));
  child.on("error", (err) => {
    clearInterval(heartbeatTimer);
    clearInterval(run.deadmanTimer);
    if (run.finalized) return;
    finalizeRun(run, "failed", err.message);
  });
  child.on("exit", (code, signal) => {
    clearInterval(heartbeatTimer);
    if (stdoutBuffer.trim()) handleRunnerLine(run, stdoutBuffer);
    if (run.finalized) return;
    if (code === 0 && !run.explicitCompletion) {
      // A clean process exit is not proof that the ACP turn completed. The
      // runner must emit its authoritative complete frame; otherwise the
      // review workflow would incorrectly advance on a truncated protocol.
      finalizeRun(run, "failed", "protocol_incomplete: runner exited without an explicit complete event");
    } else if (code === 0) {
      finalizeRun(run, "completed");
    } else {
      finalizeRun(run, "failed", signal ? `terminated by ${signal}` : `exit code ${code}`);
    }
  });

  return writeJson(res, 202, { run_id: run.remoteRunId, remote_run_id: run.remoteRunId, accepted: true, mode: body.mode || "async" });
}

function handleRunnerLine(run, line) {
  run.lastRunnerActivityAt = Date.now();
  let msg;
  try { msg = JSON.parse(line); } catch { return reportOutput(run, line, "stdout"); }
  if (msg.type === "raw_update") return reportRawUpdate(run, msg.params);
  if (msg.type === "raw_request") return reportRawRequest(run, msg);
  if (msg.type === "permission_request") return handlePermissionRequest(run, msg);
  if (msg.type === "event") {
    noteChildOperation(run, msg.eventType, msg.data);
    const text = msg.data?.text || msg.data?.error || JSON.stringify(msg.data || {});
    return reportOutput(run, text, msg.eventType);
  }
  if (msg.type === "complete") {
    if (msg.thoughtText) reportOutput(run, msg.thoughtText, "thought");
    if (msg.responseText) reportOutput(run, msg.responseText, "message");
    // P1 #11: Runner emitted explicit completion — finalize the turn.
    // The runner is the authoritative turn-end detector, not a timer.
    run.explicitCompletion = true;
    finalizeRun(run, "completed", msg.stopReason);
    return;
  }
  if (msg.type === "error") return reportOutput(run, msg.error || "Hermes ACP error", "error");
}

function reportRawUpdate(run, params) {
  const update = params?.update && typeof params.update === "object" ? params.update : {};
  const updateType = String(update.sessionUpdate || update.type || update.kind || "unknown");
  noteChildOperation(run, updateType, update);
  if (updateType === "agent_message_chunk") {
    return reportOutput(run, textFromContent(update.content), "message");
  }
  if (updateType === "agent_thought_chunk") {
    return reportStructured(run, "thought_delta", { text: textFromContent(update.content), raw: update });
  }
  if (updateType === "usage_update") {
    return reportStructured(run, "output_delta", { channel: "usage", text: JSON.stringify(update), raw: update });
  }
  if (updateType === "tool_call") {
    const status = String(update.status || update.toolCallStatus || "");
    if (status === "completed") return reportStructured(run, "tool_completed", toolPayload(update));
    if (status === "failed") return reportStructured(run, "tool_failed", toolPayload(update));
    return reportStructured(run, "tool_started", toolPayload(update));
  }
  if (updateType === "plan") {
    return reportStructured(run, "plan_updated", { raw: update, text: textFromContent(update.content) });
  }
  if (updateType.includes("tool") && updateType.includes("start")) return reportStructured(run, "tool_started", toolPayload(update));
  if (updateType.includes("tool") && (updateType.includes("complete") || updateType.includes("end"))) return reportStructured(run, "tool_completed", toolPayload(update));
  if (updateType.includes("tool") && updateType.includes("fail")) return reportStructured(run, "tool_failed", toolPayload(update));
  if (updateType.includes("plan") || updateType.includes("todo")) return reportStructured(run, "plan_updated", { raw: update, text: textFromContent(update.content) });
  return reportOutput(run, JSON.stringify(update), `acp:${updateType}`);
}

function reportRawRequest(run, msg) {
  if (msg.method === "session/request_permission") {
    return reportStructured(run, "permission.requested", {
      title: "Hermes permission requested",
      description: JSON.stringify(msg.params || {}),
      options: [
        { id: "approve_once", label: "Approve once", effect: "approve", scope: "once" },
        { id: "deny", label: "Deny", effect: "deny", scope: "once" },
      ],
      raw: msg.params || {},
    });
  }
  return reportOutput(run, JSON.stringify(msg.params || {}), msg.method || "acp:request");
}

async function handlePermissionRequest(run, msg) {
  const requestId = String(msg.requestId || "");
  if (!requestId) return;
  const toolCall = msg.toolCall && typeof msg.toolCall === "object" ? msg.toolCall : {};
  const options = normalizePermissionOptions(msg.options);
  const title = String(toolCall.title || "Hermes permission requested");
  const command = typeof toolCall.rawInput?.command === "string"
    ? toolCall.rawInput.command
    : typeof toolCall.raw_input?.command === "string"
      ? toolCall.raw_input.command
      : undefined;
  const approval = await createKontrolApproval(run, {
    title,
    description: textFromContent(toolCall.content) || undefined,
    command,
    options,
    raw: { toolCall, options: msg.options },
  });
  if (!approval?.approval_id) {
    return sendPermissionResponse(run, requestId, { approved: false });
  }
  run.pendingPermissions.set(requestId, approval.approval_id);
  refreshOperationActivity(run);
  reportStructured(run, "output_delta", {
    channel: "permission",
    text: `Hermes requested permission: ${title}`,
    approvalId: approval.approval_id,
  });
  void waitForApprovalResolution(run, requestId, approval.approval_id, options);
}

async function createKontrolApproval(run, payload) {
  const res = await fetch(`${KONTROL_ACP_URL}/runs/${run.devRunId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(agentIdentity) },
    body: JSON.stringify({
      type: "permission.requested",
      remote_run_id: run.remoteRunId,
      work_session_id: run.workSessionId,
      // Create-only: return the approval_id immediately. The adapter parks for
      // the decision on GET /approvals/:id/decision (no fail-closed timeout).
      payload: { ...payload, wait: false },
    }),
  }).catch(() => undefined);
  if (!res?.ok) return undefined;
  return res.json().catch(() => undefined);
}

async function waitForApprovalResolution(run, requestId, approvalId, options) {
  // Park on the server's long-poll decision endpoint. There is NO fail-closed
  // timeout: a human may step away for hours and (like the CLI coding agents)
  // the tool call simply keeps waiting. Each long-poll returns either a decision
  // or `still_pending`, in which case we re-park. We only give up if the run
  // itself dies (session cancelled / worker gone).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!active.has(run.remoteRunId)) {
      sendPermissionResponse(run, requestId, { approved: false });
      run.pendingPermissions.delete(requestId);
      refreshOperationActivity(run);
      return;
    }
    const decision = await fetchApprovalDecision(run, approvalId);
    if (!decision) {
      // Transient error reaching the server — back off briefly and re-park.
      await sleep(2000);
      continue;
    }
    if (decision.still_pending || decision.status === "pending") {
      continue; // long-poll window elapsed with no human decision → re-park
    }
    const optionId = typeof decision.option_id === "string" ? decision.option_id : undefined;
    const option = options.find((candidate) => candidate.id === optionId);
    // Approve only when the human approved AND the chosen option is an allow.
    const approved = decision.decision === "approve" && (option ? option.effect === "approve" : true);
    sendPermissionResponse(run, requestId, { approved, optionId });
    run.pendingPermissions.delete(requestId);
    refreshOperationActivity(run);
    return;
  }
}

async function fetchApprovalDecision(run, approvalId) {
  const res = await fetch(`${KONTROL_ACP_URL}/approvals/${approvalId}/decision`, {
    headers: { authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(agentIdentity) },
  }).catch(() => undefined);
  if (!res?.ok) return undefined;
  return res.json().catch(() => undefined);
}

function sendPermissionResponse(run, requestId, response) {
  if (run.lifecycle !== "RUNNING" || !run.child?.stdin?.writable) return;
  run.child.stdin.write(JSON.stringify({
    type: "permission_response",
    requestId,
    approved: response.approved === true,
    optionId: response.optionId,
  }) + "\n");
}

function noteChildOperation(run, eventType, data) {
  const type = String(eventType || "").toLowerCase();
  const update = data && typeof data === "object" ? data : {};
  if (!type.includes("tool") && !type.includes("command") && !type.includes("terminal")) return;
  const explicitId = update.toolCallId || update.tool_call_id || update.toolCall?.id || update.tool_call?.id || update.id;
  const id = String(explicitId || type);
  const status = String(update.status || update.toolCallStatus || "").toLowerCase();
  const starting = type.includes("start") || type.includes("requested") || (type === "tool_call" && !["completed", "failed", "cancelled", "canceled"].includes(status));
  const terminal = type.includes("complete") || type.includes("end") || type.includes("finish") || type.includes("fail") || type.includes("cancel") || ["completed", "failed", "cancelled", "canceled"].includes(status);
  if (starting) {
    run.activeChildOperations.add(id);
  } else if (terminal) {
    if (explicitId) run.activeChildOperations.delete(id);
    else run.activeChildOperations.delete(run.activeChildOperations.values().next().value);
  }
  refreshOperationActivity(run);
}

function refreshOperationActivity(run) {
  if (run.pendingPermissions.size > 0 || run.activeChildOperations.size > 0) {
    run.lastRunnerActivityAt = Date.now();
  }
}

function reportEvent(run, type, errorMessage, { allowFinalizing = false } = {}) {
  const terminal = type === "completed" || type === "failed" || type === "cancelled";
  const payload = {
    payload: {
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(terminal && run.finalOutput ? { final_output: run.finalOutput } : {}),
    },
  };
  return enqueueRunEvent(run, type, payload.payload, {
    allowFinalizing,
    terminal: type === "completed" || type === "failed" || type === "cancelled",
  });
}

async function withRetry(fn, { retries = 2, backoff = 500 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fn();
      if (res.ok) return true;
    } catch { /* retry */ }
    if (attempt < retries) await new Promise(r => setTimeout(r, backoff * (attempt + 1)));
  }
  return false;
}

function cancelRun(run, reason) {
  if (run.lifecycle === "FINALIZING" || run.lifecycle === "TERMINAL") return;
  finalizeRun(run, "cancelled", reason);
  terminateChild(run, reason);
}

function terminateChild(run, reason) {
  if (run.child?.pid) {
    try {
      process.kill(-run.child.pid, "SIGTERM");
    } catch {
      try { run.child.kill("SIGTERM"); } catch { /* ignore */ }
    }
    setTimeout(() => {
      try {
        process.kill(-run.child.pid, "SIGKILL");
      } catch {
        try { run.child.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }, 1500).unref?.();
  }
}

// P0 #3: Coalesce high-volume telemetry (output_delta, thought_delta) into
// batched POSTs. Hermes can emit thousands of individual token/thought events
// per turn; each previously triggered an independent HTTP POST + SQLite INSERT.
// Now we accumulate these into buffers and flush on a short interval (250ms)
// or when ~4KB of data has accumulated, whichever comes first.

const COALESCE_INTERVAL_MS = 250;
const COALESCE_MAX_BYTES = 4096;

function coalescedReport(run, type, payload) {
  if (!run.coalesceBuffers) {
    run.coalesceBuffers = new Map();
    run.coalesceTimers = new Map();
  }
  if (type === "output_delta" || type === "thought_delta") {
    // Accumulate into a buffer; flush periodically.
    let entry = run.coalesceBuffers.get(type);
    if (!entry) {
      entry = { bytes: 0, items: [] };
      run.coalesceBuffers.set(type, entry);
    }
    const itemJson = JSON.stringify(payload);
    entry.items.push(payload);
    entry.bytes += Buffer.byteLength(itemJson, "utf8");

    // Flush immediately if buffer is large enough.
    if (entry.bytes >= COALESCE_MAX_BYTES) {
      flushCoalesced(run, type);
      return;
    }
    // Otherwise schedule a flush if one isn't already pending.
    if (!run.coalesceTimers.has(type)) {
      run.coalesceTimers.set(type, setTimeout(() => {
        run.coalesceTimers.delete(type);
        flushCoalesced(run, type);
      }, COALESCE_INTERVAL_MS));
    }
    return;
  }
  // Non-ephemeral events are sent immediately.
  return sendEvent(run, type, payload);
}

function flushCoalesced(run, type, allowFinalizing = false) {
  const buffers = run.coalesceBuffers;
  const timers = run.coalesceTimers;
  if (!buffers || !timers) return;
  const entry = buffers.get(type);
  if (!entry || entry.items.length === 0) return;
  buffers.delete(type);
  const timer = timers.get(type);
  if (timer) {
    clearTimeout(timer);
    timers.delete(type);
  }
  // P1 #29: Produce a stable aggregate payload that downstream consumers
  // (WebUI, event log) can understand — not raw { coalesced, items }.
  const texts = entry.items.map((item) => item.text ?? "").filter(Boolean);
  const channels = [...new Set(entry.items.map((item) => item.channel).filter(Boolean))];
  const aggregated = texts.join("");
  void enqueueRunEvent(run, type, {
    text: aggregated,
    channel: channels[0] ?? (type === "thought_delta" ? "thought" : "message"),
    coalesced: true,
    count: entry.items.length,
    channels,
  }, { allowFinalizing });
}

// P1 #12: Flush ALL coalesced buffers before terminal event
function flushAllCoalesced(run) {
  if (!run.coalesceBuffers) return;
  for (const type of [...run.coalesceBuffers.keys()]) {
    flushCoalesced(run, type, true);
  }
}

// P1 #12: Ordered event delivery queue
function enqueueRunEvent(run, type, payload, { allowFinalizing = false, terminal = false } = {}) {
  if ((run.lifecycle === "FINALIZING" || run.lifecycle === "TERMINAL") && !allowFinalizing) {
    return Promise.resolve(false);
  }
  const delivery = run.sendChain
    .catch((error) => recordDeliveryError(run, error))
    .then(async () => {
      const acknowledged = await withRetry(() => fetch(`${KONTROL_ACP_URL}/runs/${run.devRunId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(agentIdentity) },
        body: JSON.stringify({
          type,
          remote_run_id: run.remoteRunId,
          work_session_id: run.workSessionId,
          payload,
        }),
      }), terminal ? { retries: 3, backoff: 2000 } : { retries: 0, backoff: 0 });
      if (!acknowledged) throw new Error(`event delivery failed: ${type}`);
      return true;
    })
    .catch((error) => {
      recordDeliveryError(run, error);
      return false;
    });
  run.sendChain = delivery;
  return delivery;
}

function recordDeliveryError(run, error) {
  const message = error instanceof Error ? error.message : String(error);
  run.deliveryErrors.push({ at: new Date().toISOString(), message });
  if (run.deliveryErrors.length > 50) run.deliveryErrors.shift();
  console.warn(`[hermes-native] event delivery: ${message}`);
}

function sendEvent(run, type, payload) {
  return enqueueRunEvent(run, type, payload);
}

function finalizeRun(run, status, stopReason) {
  if (run.terminalOutcome) return run.terminalOutcome;
  const outcome = { status, stopReason };
  run.terminalOutcome = outcome;
  run.lifecycle = "FINALIZING";
  run.finalized = true;
  clearInterval(run.deadmanTimer);
  // P1 #12: Flush coalesced telemetry BEFORE terminal event
  flushAllCoalesced(run);
  void run.sendChain
    .then(() => reportEvent(run, status, stopReason, { allowFinalizing: true }))
    .finally(() => {
      active.delete(run.remoteRunId);
      run.lifecycle = "TERMINAL";
    });
  return outcome;
}

function reportOutput(run, text, channel) {
  if (!text) return;
  if (channel === "message") run.sawAgentMessage = true;
  if (channel === "message") run.finalOutput = appendBoundedOutput(run.finalOutput, text, FINAL_OUTPUT_BYTES);
  return coalescedReport(run, "output_delta", { text, channel });
}

function appendBoundedOutput(current, next, limit) {
  const combined = `${current ?? ""}${next ?? ""}`;
  return truncateUtf8Tail(combined, limit);
}

function reportStructured(run, type, payload) {
  return coalescedReport(run, type, payload);
}

function safeEnv() {
  const allowed = ["HOME", "PATH", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "HERMES_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"];
  const env = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function positiveDuration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveHermesPython() {
  const candidates = [
    process.env.HERMES_NATIVE_PYTHON,
    `${HERMES_AGENT_ROOT}/.venv/bin/python`,
    `${HERMES_AGENT_ROOT}/venv/bin/python`,
    detectHermesPython(),
    "python3",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["-c", "import acp; import acp_adapter.client; assert hasattr(acp, 'connect_to_agent'); assert hasattr(acp, 'Client')"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HERMES_AGENT_ROOT,
        PYTHONPATH: withHermesPythonPath(process.env.PYTHONPATH),
      },
    });
    if (result.status === 0) {
      console.log(`[hermes-native] using Python: ${candidate}`);
      return candidate;
    }
  }
  console.error("[hermes-native] no Python interpreter can import Hermes ACP modules");
  console.error("Set HERMES_NATIVE_PYTHON to the Hermes virtualenv Python, e.g. /path/to/hermes-agent/.venv/bin/python");
  return null;
}

function resolveHermesBinaryPath() {
  if (isAbsolute(HERMES_BIN) && existsSync(HERMES_BIN)) {
    return realpathSync(HERMES_BIN);
  }
  const which = spawnSync("which", [HERMES_BIN], { encoding: "utf8" });
  if (which.status === 0) {
    const p = which.stdout.trim();
    if (p) return realpathSync(p);
  }
  return null;
}

function detectHermesAgentRoot() {
  try {
    const resolved = resolveHermesBinaryPath();
    if (!resolved) return null;
    const binDir = dirname(resolved);
    const venvDir = dirname(binDir);
    const root = dirname(venvDir);
    if (existsSync(join(root, "acp")) || existsSync(join(root, "acp_adapter"))) {
      return root;
    }
  } catch {}
  return null;
}

function detectHermesPython() {
  try {
    const resolved = resolveHermesBinaryPath();
    if (!resolved) return null;
    const firstLine = readFileSync(resolved, "utf8").split("\n")[0];
    if (firstLine.startsWith("#!")) {
      const interpreter = firstLine.slice(2).trim().split(/\s+/)[0];
      if (interpreter && /python3?$/.test(interpreter)) {
        return interpreter;
      }
    }
  } catch {}
  return null;
}

function withHermesPythonPath(existing) {
  return [HERMES_ACP_COMPAT_PATH, HERMES_AGENT_ROOT, existing].filter(Boolean).join(delimiter);
}

function hasActiveSession(workSessionId) {
  for (const run of active.values()) {
    if (run.workSessionId === workSessionId) return true;
  }
  return false;
}

function toolPayload(update) {
  return {
    id: update.toolCallId || update.tool_call_id || update.id,
    tool: update.title || update.name || update.toolName || update.tool_name,
    status: update.status,
    content: update.content,
    locations: update.locations,
    raw: update,
  };
}

function textFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (typeof content.text === "string") return content.text;
  if (Array.isArray(content)) return content.map(textFromContent).filter(Boolean).join("\n");
  if (typeof content === "object") {
    if (typeof content.content === "string") return content.content;
    if (typeof content.value === "string") return content.value;
  }
  return "";
}

function normalizePermissionOptions(value) {
  if (!Array.isArray(value)) return [
    { id: "allow_once", label: "Allow once", effect: "approve", scope: "once" },
    { id: "deny", label: "Deny", effect: "deny", scope: "once" },
  ];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const id = String(entry.optionId || entry.option_id || entry.id || "");
    if (!id) return [];
    const kind = String(entry.kind || "");
    const label = String(entry.name || entry.label || id);
    const effect = kind.startsWith("allow") || id.startsWith("allow") ? "approve" : "deny";
    const scope = kind.includes("always") || id.includes("always")
      ? "workspace"
      : id.includes("session")
        ? "work_session"
        : "once";
    return [{ id, label, effect, scope }];
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTask(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  return input.flatMap((m) => Array.isArray(m?.parts) ? m.parts.map((p) => typeof p?.content === "string" ? p.content : "") : []).filter(Boolean).join("\n");
}

async function validateWorkspaceRoot(raw) {
  if (!raw || typeof raw !== "string" || !isAbsolute(raw)) throw new Error("workspace_root must be an absolute directory");
  const real = await realpath(raw);
  const info = await stat(real);
  if (!info.isDirectory()) throw new Error(`workspace_root is not a directory: ${real}`);
  return real;
}

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
