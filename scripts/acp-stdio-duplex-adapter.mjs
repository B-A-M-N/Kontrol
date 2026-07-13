#!/usr/bin/env node
// Generic stdio ACP duplex adapter.
//
// This adapter is for agents that speak newline-delimited JSON-RPC over
// stdin/stdout. It wires the reusable dist/acp-duplex.js transport into the
// same Kontrol HTTP adapter contract used by the CRUSH and Hermes adapters:
//
//   Kontrol ─HTTP /runs→ this adapter ─stdio JSON-RPC→ ACP agent
//   ACP agent ─session/request_permission→ this adapter ─HTTP approval→ Kontrol
//
// The adapter is intentionally opt-in because ACP agent start methods differ.
// Configure ACP_STDIO_DISPATCH_METHOD and, if needed, ACP_STDIO_ARGS_JSON for
// the target agent.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { realpath, stat } from "node:fs/promises";

const KONTROL_ACP_URL = process.env.KONTROL_ACP_URL || "http://127.0.0.1:7676/acp";
const AGENT_SECRET = process.env.KONTROL_ACP_AGENT_SECRET;
const ADAPTER_SECRET = process.env.KONTROL_ACP_ADAPTER_SECRET;
const ADAPTER_HOST = process.env.HOST || "127.0.0.1";
const ADAPTER_PORT = Number(process.env.ACP_STDIO_ADAPTER_PORT || process.env.ACP_ADAPTER_PORT || "9921");
const AGENT_NAME = process.env.ACP_STDIO_AGENT_NAME || "stdio-duplex-agent";
const AGENT_DESCRIPTION = process.env.ACP_STDIO_AGENT_DESCRIPTION || "Generic stdio ACP duplex adapter";
const AGENT_COMMAND = process.env.ACP_STDIO_COMMAND;
const AGENT_ARGS = parseJsonArray(process.env.ACP_STDIO_ARGS_JSON) ?? [];
const DISPATCH_METHOD = process.env.ACP_STDIO_DISPATCH_METHOD || "session/prompt";

const VALIDATE_IMPORTS = process.argv.includes("--validate-imports");

const { createAcpDuplex } = await import(new URL("../dist/acp-duplex.js", import.meta.url));
if (VALIDATE_IMPORTS) {
  console.log("[stdio-duplex] import validation ok");
  process.exit(0);
}

if (!AGENT_SECRET || !ADAPTER_SECRET) {
  console.error("[stdio-duplex] KONTROL_ACP_AGENT_SECRET and KONTROL_ACP_ADAPTER_SECRET are required");
  process.exit(1);
}
if (!AGENT_COMMAND) {
  console.error("[stdio-duplex] ACP_STDIO_COMMAND is required");
  process.exit(1);
}

const active = new Map();
let agentId = null;

await registerAgentWithRetry();
setInterval(() => heartbeat().catch((err) => console.warn("[stdio-duplex] heartbeat:", err.message)), 55_000);

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[stdio-duplex] request error:", err);
    writeJson(res, 500, { error: { message: String(err?.message || err) } });
  });
}).listen(ADAPTER_PORT, ADAPTER_HOST, () => {
  console.log(`[stdio-duplex] listening on ${ADAPTER_HOST}:${ADAPTER_PORT} as ${AGENT_NAME}`);
});

async function registerAgentWithRetry() {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await registerAgent();
      return;
    } catch (err) {
      lastError = err;
      console.warn(`[stdio-duplex] registration attempt ${attempt} failed: ${err.message}`);
      await sleep(Math.min(1000 * attempt, 5000));
    }
  }
  throw lastError;
}

async function registerAgent() {
  const capabilities = [
    "native-acp",
    "stdio-json-rpc",
    "duplex-json-rpc",
    "reverse-permissions",
    "review-barrier",
    ...String(process.env.ACP_STDIO_CAPABILITIES || "").split(",").map((s) => s.trim()).filter(Boolean),
  ];
  const res = await fetch(`${KONTROL_ACP_URL}/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify({
      name: AGENT_NAME,
      url: `http://${ADAPTER_HOST}:${ADAPTER_PORT}`,
      description: AGENT_DESCRIPTION,
      role: "agent",
      capabilities,
      ttlSeconds: 90,
    }),
  });
  if (!res.ok) throw new Error(`registration failed ${res.status}: ${await res.text()}`);
  const json = await res.json();
  agentId = json.id;
  console.log(`[stdio-duplex] registered ${AGENT_NAME} (id=${agentId})`);
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
  const url = req.url || "";
  if (req.method === "GET" && url === "/health") {
    return writeJson(res, 200, {
      ok: true,
      agent: AGENT_NAME,
      active: active.size,
      duplex: true,
      dispatchMethod: DISPATCH_METHOD,
    });
  }

  const cancelMatch = url.match(/^\/runs\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelMatch) {
    if (!authorized(req)) return writeJson(res, 401, { error: { code: "unauthorized" } });
    const remoteRunId = decodeURIComponent(cancelMatch[1]);
    const run = active.get(remoteRunId);
    if (!run) return writeJson(res, 404, { error: { code: "not_found", message: `active run not found: ${remoteRunId}` } });
    cancelRun(run, "cancelled by Kontrol");
    return writeJson(res, 202, { run_id: remoteRunId, status: "cancelled" });
  }

  if (req.method !== "POST" || url !== "/runs") return writeJson(res, 404, { error: { code: "not_found" } });
  if (!authorized(req)) return writeJson(res, 401, { error: { code: "unauthorized" } });

  const body = await readJson(req);
  if (body.smoke_test) {
    return writeJson(res, 202, { run_id: "stdio-duplex-smoke", smoke_test: true, duplex: true, accepted: true });
  }

  const workspaceRoot = await validateWorkspaceRoot(body.workspace_root);
  const run = {
    remoteRunId: `stdio_${randomUUID().slice(0, 8)}`,
    devRunId: body.parent_run_id || body.run_id,
    workSessionId: body.session_id,
    workspaceSessionId: body.workspace_session_id,
    workspaceRoot,
    task: extractTask(body.input),
    child: null,
    conn: null,
    finalized: false,
  };
  active.set(run.remoteRunId, run);
  reportEvent(run, "started");
  const heartbeatTimer = setInterval(() => reportEvent(run, "heartbeat"), 20_000);

  try {
    run.child = spawn(AGENT_COMMAND, AGENT_ARGS, {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: safeEnv(),
    });
    const stream = childDuplexStream(run.child);
    run.conn = createAcpDuplex(stream, createKontrolHttpHandler(run));
    run.child.stderr.setEncoding("utf8");
    run.child.stderr.on("data", (chunk) => reportStructured(run, "output_delta", { channel: "stderr", text: String(chunk) }));
    run.child.on("exit", (code, signal) => {
      clearInterval(heartbeatTimer);
      active.delete(run.remoteRunId);
      if (run.finalized) return;
      run.finalized = true;
      if (code === 0) reportEvent(run, "completed");
      else reportEvent(run, "failed", signal ? `terminated by ${signal}` : `exit code ${code}`);
    });

    void dispatchTurn(run).catch((err) => {
      if (run.finalized) return;
      run.finalized = true;
      active.delete(run.remoteRunId);
      clearInterval(heartbeatTimer);
      reportEvent(run, "failed", err instanceof Error ? err.message : String(err));
      try { run.conn?.close(); } catch { /* ignore */ }
      try { run.child?.kill("SIGTERM"); } catch { /* ignore */ }
    });

    return writeJson(res, 202, {
      run_id: run.remoteRunId,
      remote_run_id: run.remoteRunId,
      accepted: true,
      mode: body.mode || "async",
      duplex: true,
    });
  } catch (error) {
    active.delete(run.remoteRunId);
    clearInterval(heartbeatTimer);
    throw error;
  }
}

async function dispatchTurn(run) {
  const result = await run.conn.request(DISPATCH_METHOD, {
    sessionId: run.workSessionId ?? run.workspaceSessionId,
    workspaceSessionId: run.workspaceSessionId,
    workSessionId: run.workSessionId,
    runId: run.remoteRunId,
    cwd: run.workspaceRoot,
    prompt: run.task,
    input: run.task,
  });
  reportStructured(run, "output_delta", {
    channel: "result",
    text: typeof result === "string" ? result : JSON.stringify(result),
    raw: result,
  });
}

function createKontrolHttpHandler(run) {
  return {
    async requestPermission(params, signal) {
      const approval = await createKontrolApproval(run, {
        title: describeToolCall(params.toolCall) || "Agent permission requested",
        options: normalizePermissionOptions(params.options),
        raw: params,
        wait: false,
      });
      if (!approval?.approval_id) return { outcome: "cancelled" };
      reportStructured(run, "output_delta", {
        channel: "permission",
        text: `Agent requested permission: ${describeToolCall(params.toolCall) || approval.approval_id}`,
        approvalId: approval.approval_id,
      });
      const decision = await waitForApprovalDecision(run, approval.approval_id, signal);
      if (!decision || decision.decision !== "approve") return { outcome: "cancelled" };
      const options = normalizePermissionOptions(params.options);
      const allow = options.find((o) => o.id === decision.option_id && o.effect === "approve")
        ?? options.find((o) => o.effect === "approve");
      return allow ? { outcome: "selected", optionId: allow.id } : { outcome: "cancelled" };
    },
    sessionUpdate(params) {
      reportStructured(run, "output_delta", { channel: "session/update", text: JSON.stringify(params), raw: params });
    },
  };
}

async function createKontrolApproval(run, payload) {
  const res = await fetch(`${KONTROL_ACP_URL}/runs/${run.devRunId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify({
      type: "permission.requested",
      remote_run_id: run.remoteRunId,
      work_session_id: run.workSessionId,
      payload,
    }),
  }).catch(() => undefined);
  if (!res?.ok) return undefined;
  return res.json().catch(() => undefined);
}

async function waitForApprovalDecision(run, approvalId, signal) {
  while (!signal.aborted && active.has(run.remoteRunId)) {
    const res = await fetch(`${KONTROL_ACP_URL}/approvals/${approvalId}/decision`, {
      headers: { authorization: `Bearer ${AGENT_SECRET}` },
    }).catch(() => undefined);
    if (!res?.ok) {
      await sleep(2000);
      continue;
    }
    const json = await res.json().catch(() => undefined);
    if (!json || json.still_pending || json.status === "pending") continue;
    return json;
  }
  return undefined;
}

function childDuplexStream(child) {
  const lineHandlers = new Set();
  const closeHandlers = new Set();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) for (const cb of lineHandlers) cb(line);
  });
  child.on("close", () => {
    if (buffer.trim()) for (const cb of lineHandlers) cb(buffer);
    for (const cb of closeHandlers) cb();
  });
  return {
    write(line) {
      child.stdin.write(line);
    },
    onLine(cb) {
      lineHandlers.add(cb);
    },
    onClose(cb) {
      closeHandlers.add(cb);
    },
    close() {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    },
  };
}

function cancelRun(run, reason) {
  run.finalized = true;
  active.delete(run.remoteRunId);
  try { run.conn?.cancelInbound(); } catch { /* ignore */ }
  try { run.conn?.close(); } catch { /* ignore */ }
  if (run.child?.pid) {
    try {
      process.kill(-run.child.pid, "SIGTERM");
    } catch {
      try { run.child.kill("SIGTERM"); } catch { /* ignore */ }
    }
    setTimeout(() => {
      try { process.kill(-run.child.pid, "SIGKILL"); } catch { try { run.child.kill("SIGKILL"); } catch { /* ignore */ } }
    }, 1500).unref?.();
  }
  void reportEvent(run, "cancelled", reason);
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

function authorized(req) {
  return (req.headers.authorization || "") === `Bearer ${ADAPTER_SECRET}`;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

function safeEnv() {
  const allowed = ["HOME", "PATH", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"];
  const env = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function normalizePermissionOptions(value) {
  if (!Array.isArray(value)) return [{ id: "allow_once", label: "Allow once", effect: "approve" }, { id: "deny", label: "Deny", effect: "deny" }];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const id = String(entry.optionId || entry.option_id || entry.id || "");
    if (!id) return [];
    const kind = String(entry.kind || "");
    const label = String(entry.name || entry.label || id);
    const effect = kind.startsWith("allow") || id.startsWith("allow") ? "approve" : "deny";
    const scope = kind.includes("always") || id.includes("always") ? "workspace" : id.includes("session") ? "work_session" : "once";
    return [{ id, label, effect, scope }];
  });
}

function describeToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== "object") return undefined;
  return String(toolCall.title || toolCall.name || toolCall.tool || toolCall.kind || "") || undefined;
}

function parseJsonArray(value) {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("ACP_STDIO_ARGS_JSON must be a JSON array of strings");
  }
  return parsed;
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
