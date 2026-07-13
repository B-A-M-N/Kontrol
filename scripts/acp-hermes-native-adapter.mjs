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
import { delimiter, isAbsolute } from "node:path";
import { realpath, stat } from "node:fs/promises";

const KONTROL_ACP_URL = process.env.KONTROL_ACP_URL || "http://127.0.0.1:7676/acp";
const AGENT_SECRET = process.env.KONTROL_ACP_AGENT_SECRET;
const ADAPTER_SECRET = process.env.KONTROL_ACP_ADAPTER_SECRET;
const HERMES_BIN = process.env.HERMES_BIN || "hermes";
const HERMES_AGENT_ROOT = process.env.HERMES_AGENT_ROOT || process.cwd();
const ADAPTER_PORT = Number(process.env.HERMES_ACP_ADAPTER_PORT || process.env.ACP_ADAPTER_PORT || "9911");
const ADAPTER_HOST = process.env.HOST || "127.0.0.1";
const RUNNER = new URL("./hermes-native-runner.py", import.meta.url).pathname;
const HERMES_ACP_COMPAT_PATH = new URL("./hermes-acp-compat", import.meta.url).pathname;

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
const active = new Map();
let agentId = null;

await registerAgentWithRetry();
setInterval(() => heartbeat().catch((err) => console.warn("[hermes-native] heartbeat:", err.message)), 55_000);

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[hermes-native] request error:", err);
    writeJson(res, 500, { error: { message: String(err?.message || err) } });
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
  const res = await fetch(`${KONTROL_ACP_URL}/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify({
      name: "hermes-agent",
      url: `http://${ADAPTER_HOST}:${ADAPTER_PORT}`,
      description: "Native Hermes ACP stdio bridge with HTTP approval bridge",
      role: "agent",
      capabilities: ["native-acp", "streaming", "tool-events", "http-approval-bridge", "review-barrier"],
      ttlSeconds: 90,
    }),
  });
  if (!res.ok) throw new Error(`registration failed ${res.status}: ${await res.text()}`);
  const json = await res.json();
  agentId = json.id;
  console.log(`[hermes-native] registered as hermes-agent (id=${agentId})`);
}

async function heartbeat() {
  if (!agentId) return;
  const res = await fetch(`${KONTROL_ACP_URL}/agents/${agentId}/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${AGENT_SECRET}` },
  });
  if (res.status === 404) await registerAgentWithRetry();
}

async function handle(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};

  if (req.method === "GET" && req.url === "/health") {
    return writeJson(res, 200, { ok: true, agent: "hermes-agent", active: active.size, native: true });
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
  if (body.smoke_test) {
    return writeJson(res, 202, { run_id: "hermes-native-smoke", smoke_test: true, native: true, accepted: true });
  }

  const workspaceRoot = await validateWorkspaceRoot(body.workspace_root);
  const run = {
    remoteRunId: `hermes_${randomUUID().slice(0, 8)}`,
    devRunId: body.parent_run_id || body.run_id,
    workSessionId: body.session_id,
    workspaceSessionId: body.workspace_session_id,
    task: extractTask(body.input),
    workspaceRoot,
    child: null,
    finalized: false,
    pendingPermissions: new Map(),
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
      }),
    },
  });
  run.child = child;

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
    active.delete(run.remoteRunId);
    if (run.finalized) return;
    run.finalized = true;
    void reportEvent(run, "failed", err.message);
  });
  child.on("exit", (code, signal) => {
    clearInterval(heartbeatTimer);
    if (stdoutBuffer.trim()) handleRunnerLine(run, stdoutBuffer);
    active.delete(run.remoteRunId);
    if (run.finalized) return;
    run.finalized = true;
    if (code === 0) reportEvent(run, "completed");
    else reportEvent(run, "failed", signal ? `terminated by ${signal}` : `exit code ${code}`);
  });

  return writeJson(res, 202, { run_id: run.remoteRunId, remote_run_id: run.remoteRunId, accepted: true, mode: body.mode || "async" });
}

function handleRunnerLine(run, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return reportOutput(run, line, "stdout"); }
  if (msg.type === "raw_update") return reportRawUpdate(run, msg.params);
  if (msg.type === "raw_request") return reportRawRequest(run, msg);
  if (msg.type === "permission_request") return handlePermissionRequest(run, msg);
  if (msg.type === "event") {
    const text = msg.data?.text || msg.data?.error || JSON.stringify(msg.data || {});
    return reportOutput(run, text, msg.eventType);
  }
  if (msg.type === "complete") {
    if (msg.thoughtText) reportOutput(run, msg.thoughtText, "thought");
    if (msg.responseText) reportOutput(run, msg.responseText, "message");
    return;
  }
  if (msg.type === "error") return reportOutput(run, msg.error || "Hermes ACP error", "error");
}

function reportRawUpdate(run, params) {
  const update = params?.update && typeof params.update === "object" ? params.update : {};
  const updateType = String(update.sessionUpdate || update.type || update.kind || "unknown");
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
    headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}` },
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
      return;
    }
    const decision = await fetchApprovalDecision(approvalId);
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
    return;
  }
}

async function fetchApprovalDecision(approvalId) {
  const res = await fetch(`${KONTROL_ACP_URL}/approvals/${approvalId}/decision`, {
    headers: { authorization: `Bearer ${AGENT_SECRET}` },
  }).catch(() => undefined);
  if (!res?.ok) return undefined;
  return res.json().catch(() => undefined);
}

function sendPermissionResponse(run, requestId, response) {
  if (!run.child?.stdin?.writable) return;
  run.child.stdin.write(JSON.stringify({
    type: "permission_response",
    requestId,
    approved: response.approved === true,
    optionId: response.optionId,
  }) + "\n");
}

async function reportEvent(run, type, errorMessage) {
  await fetch(`${KONTROL_ACP_URL}/runs/${run.devRunId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify({
      type,
      remote_run_id: run.remoteRunId,
      work_session_id: run.workSessionId,
      payload: errorMessage ? { error: errorMessage } : {},
    }),
  }).catch(() => {});
}

function cancelRun(run, reason) {
  run.finalized = true;
  active.delete(run.remoteRunId);
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
  void reportEvent(run, "cancelled", reason);
}

function reportOutput(run, text, channel) {
  if (!text) return;
  return reportStructured(run, "output_delta", { text, channel });
}

function reportStructured(run, type, payload) {
  void fetch(`${KONTROL_ACP_URL}/runs/${run.devRunId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify({
      type,
      remote_run_id: run.remoteRunId,
      work_session_id: run.workSessionId,
      payload,
    }),
  }).catch(() => {});
}

function safeEnv() {
  const allowed = ["HOME", "PATH", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "HERMES_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"];
  const env = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function resolveHermesPython() {
  const candidates = [
    process.env.HERMES_NATIVE_PYTHON,
    `${HERMES_AGENT_ROOT}/.venv/bin/python`,
    `${HERMES_AGENT_ROOT}/venv/bin/python`,
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
  process.exit(1);
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
