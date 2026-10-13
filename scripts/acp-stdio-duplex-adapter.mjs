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
// The default path performs the ACP v1 initialize -> session/new ->
// session/prompt handshake. A custom dispatch method remains available for
// known nonstandard ACP-compatible wrappers.

import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { clearAgentIdentity, identityHeaders, loadAgentIdentity, saveAgentIdentity } from "./lib/acp-agent-identity.mjs";
import { readJsonBody } from "./lib/adapter-http.mjs";
import { adapterStatePath, atomicWriteJson, prepareOwnedChild, processStartToken, reconcileOwnedProcesses, terminateProcessGroup } from "./lib/managed-agent-process.mjs";
import { adapterDispatchFingerprint, findAdapterDispatchReceipt, isTerminalAdapterDispatchStatus, loadAdapterDispatchReceipts, reconcileAdapterDispatchReceipts, recordAdapterDispatchReceipt } from "./lib/adapter-dispatch-receipts.mjs";
import { workspaceLeaseDeadline } from "./lib/workspace-lease.mjs";
const readOnlyModuleUrl = process.env.KONTROL_ARTIFACT_PATH
  ? pathToFileURL(resolve(process.env.KONTROL_ARTIFACT_PATH, "read-only-execution.mjs"))
  : new URL("./lib/read-only-execution.mjs", import.meta.url);
const readOnlyExecutionModule = await import(readOnlyModuleUrl);
const {
  buildReadOnlySandboxCommand,
  probeReadOnlyExecutionSandbox,
  readOnlyWorkerEnvironment,
  resolveExecutablePath,
  validateReadOnlyDispatchRequest,
} = readOnlyExecutionModule;

const KONTROL_ACP_URL = process.env.KONTROL_ACP_URL || "http://127.0.0.1:7676/acp";
const AGENT_SECRET = process.env.KONTROL_ACP_AGENT_SECRET;
const ADAPTER_SECRET = process.env.KONTROL_ACP_ADAPTER_SECRET;
const ADAPTER_HOST = process.env.ACP_STDIO_ADAPTER_HOST || "127.0.0.1";
const ADAPTER_PORT = Number(process.env.ACP_STDIO_ADAPTER_PORT || process.env.ACP_ADAPTER_PORT || "9921");
const AGENT_NAME = process.env.ACP_STDIO_AGENT_NAME || "stdio-duplex-agent";
const AGENT_DESCRIPTION = process.env.ACP_STDIO_AGENT_DESCRIPTION || "Generic stdio ACP duplex adapter";
const AGENT_COMMAND = process.env.ACP_STDIO_COMMAND;
const AGENT_ARGS = parseJsonArray(process.env.ACP_STDIO_ARGS_JSON) ?? [];
const DISPATCH_METHOD = process.env.ACP_STDIO_DISPATCH_METHOD;
const DISPATCH_RECEIPTS_PATH = process.env.KONTROL_STDIO_DISPATCH_RECEIPTS || adapterStatePath("stdio-duplex", "dispatch-receipts.json");
const OWNED_PROCESSES_PATH = process.env.KONTROL_STDIO_OWNED_PROCESSES || adapterStatePath("stdio-duplex", "owned-processes.json");
const dispatchReceipts = await loadAdapterDispatchReceipts(DISPATCH_RECEIPTS_PATH);

const VALIDATE_IMPORTS = process.argv.includes("--validate-imports");

const acpDuplexModuleUrl = process.env.KONTROL_ARTIFACT_PATH
  ? pathToFileURL(resolve(process.env.KONTROL_ARTIFACT_PATH, "acp-duplex.js"))
  : new URL("../dist/acp-duplex.js", import.meta.url);
const { createAcpDuplex } = await import(acpDuplexModuleUrl);
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
const ownedProcesses = new Map();
let agentIdentity = null;

const reconciliation = await reconcileOwnedProcesses(OWNED_PROCESSES_PATH, "stdio-duplex");
await reconcileAdapterDispatchReceipts(DISPATCH_RECEIPTS_PATH, dispatchReceipts, reconciliation.records);
const recoveredRuns = reconciliation.records.filter((record) => record?.dispatchIdempotencyKey && record?.kontrolRunId
  && findAdapterDispatchReceipt(dispatchReceipts, record.dispatchIdempotencyKey)?.status !== "unstarted");
for (const record of recoveredRuns) {
  const receipt = findAdapterDispatchReceipt(dispatchReceipts, record.dispatchIdempotencyKey);
  if (!isTerminalAdapterDispatchStatus(receipt?.status)) {
    await recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, record.dispatchIdempotencyKey, record.remoteRunId, "failed", {
      requestFingerprint: receipt?.requestFingerprint ?? record.requestFingerprint,
      workSessionId: receipt?.workSessionId ?? record.workSessionId,
      workspaceSessionId: receipt?.workspaceSessionId ?? record.workspaceSessionId,
      agentId: receipt?.agentId ?? record.agentId,
      attemptNumber: receipt?.attemptNumber ?? record.attemptNumber,
      lastError: "Adapter restarted and confirmed its detached ACP child stopped before a terminal receipt was recorded.",
    });
  }
}
await registerAgentWithRetry();
for (const record of recoveredRuns) await reportRecoveredRun(record);
setInterval(() => heartbeat().catch((err) => console.warn("[stdio-duplex] heartbeat:", err.message)), 55_000);

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[stdio-duplex] request error:", err);
    writeJson(res, Number.isInteger(err?.status) ? err.status : 500, {
      error: {
        code: typeof err?.code === "string" ? err.code : "internal_error",
        message: String(err?.message || err),
      },
    });
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
  let identity = agentIdentity || await loadAgentIdentity(AGENT_NAME);
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
    headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(identity) },
    body: JSON.stringify({
      name: AGENT_NAME,
      url: `http://${ADAPTER_HOST}:${ADAPTER_PORT}`,
      description: AGENT_DESCRIPTION,
      role: "agent",
      capabilities,
      ttlSeconds: 90,
    }),
  });
  if (!res.ok) {
    if (res.status === 404 && identity) {
      await clearAgentIdentity(AGENT_NAME);
      agentIdentity = null;
      return registerAgent();
    }
    throw new Error(`registration failed ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const credential = typeof json.agentCredential === "string" ? json.agentCredential : identity?.agentCredential;
  if (typeof json.id !== "string" || !credential) throw new Error("registration response did not include a usable agent identity");
  agentIdentity = { agentId: json.id, agentCredential: credential };
  await saveAgentIdentity(AGENT_NAME, agentIdentity);
  console.log(`[stdio-duplex] registered ${AGENT_NAME} (id=${agentIdentity.agentId})`);
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
  const url = req.url || "";
  if (req.method === "GET" && url === "/health") {
    return writeJson(res, 200, {
      ok: true,
      ready: true,
      agent: AGENT_NAME,
      active: active.size,
      duplex: true,
      dispatchMethod: DISPATCH_METHOD || "session/prompt",
      protocolMode: DISPATCH_METHOD ? "custom" : "acp-v1",
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

  const dispatchLookup = url.match(/^\/runs\/by-dispatch-id\/([^/]+)$/);
  if (req.method === "GET" && dispatchLookup) {
    if (!authorized(req)) return writeJson(res, 401, { error: { code: "unauthorized" } });
    const key = decodeURIComponent(dispatchLookup[1]);
    const activeRun = [...active.values()].find((run) => run.dispatchIdempotencyKey === key);
    const receipt = findAdapterDispatchReceipt(dispatchReceipts, key);
    const remoteRunId = activeRun?.remoteRunId ?? receipt?.remoteRunId;
    if (remoteRunId) return writeJson(res, 200, {
      run_id: remoteRunId,
      remote_run_id: remoteRunId,
      accepted: activeRun ? activeRun.launchState === "running" : !["dispatching", "unstarted"].includes(receipt?.status),
      status: activeRun ? activeRun.launchState === "running" ? "running" : "uncertain" : receipt?.status ?? "uncertain",
      dispatch_idempotency_key: key,
      ...(activeRun?.readOnlyExecutionReceipt ?? receipt?.executionReceipt
        ? { execution_receipt: activeRun?.readOnlyExecutionReceipt ?? receipt.executionReceipt }
        : {}),
      ...(receipt?.authoritativelyUnstarted ? { authoritatively_unstarted: true } : {}),
    });
    return writeJson(res, 404, { error: { code: "not_found" } });
  }

  if (req.method !== "POST" || url !== "/runs") return writeJson(res, 404, { error: { code: "not_found" } });
  if (!authorized(req)) return writeJson(res, 401, { error: { code: "unauthorized" } });

  const body = await readJsonBody(req);
  const requestFingerprint = adapterDispatchFingerprint(body);
  const dispatchIdempotencyKey = typeof body.dispatch_idempotency_key === "string" && body.dispatch_idempotency_key.length > 0
    ? body.dispatch_idempotency_key
    : undefined;
  if (dispatchIdempotencyKey) {
    const receipt = findAdapterDispatchReceipt(dispatchReceipts, dispatchIdempotencyKey);
    if (receipt) {
      if (!receipt.requestFingerprint || receipt.requestFingerprint !== requestFingerprint) {
        return writeJson(res, 409, { error: { code: receipt.requestFingerprint ? "dispatch_idempotency_conflict" : "dispatch_fingerprint_unavailable", message: "The original dispatch key is already bound to different or unverifiable request content." } });
      }
      const activeRun = [...active.values()].find((item) => item.dispatchIdempotencyKey === dispatchIdempotencyKey);
      const knownStatus = activeRun ? "running" : receipt.status === "dispatching" ? "uncertain" : receipt.status;
      return writeJson(res, 202, {
        run_id: receipt.remoteRunId,
        remote_run_id: receipt.remoteRunId,
        accepted: !["uncertain", "unstarted"].includes(knownStatus),
        status: knownStatus,
        dispatch_idempotency_key: dispatchIdempotencyKey,
        ...(receipt.executionReceipt ? { execution_receipt: receipt.executionReceipt } : {}),
        ...(receipt.authoritativelyUnstarted ? { authoritatively_unstarted: true } : {}),
        replayed: true,
      });
    }
  }
  if (body.smoke_test) {
    return writeJson(res, 202, { run_id: "stdio-duplex-smoke", smoke_test: true, duplex: true, accepted: true, status: "completed" });
  }
  const task = extractTask(body.input);
  if (!task.trim()) {
    return writeJson(res, 400, { error: { code: "invalid_task", message: "ACP task must be non-empty" } });
  }

  const workspaceRoot = await validateWorkspaceRoot(body.workspace_root);
  const readOnlyAuthorization = validateReadOnlyDispatchRequest(body, workspaceRoot, ADAPTER_SECRET);
  if (readOnlyAuthorization.readOnly && !readOnlyAuthorization.valid) {
    return writeJson(res, 403, { error: { code: "read_only_grant_invalid", message: "A valid Kontrol-issued read-only execution grant is required." } });
  }
  const leaseDeadlineAt = workspaceLeaseDeadline(body.workspace_lease_expires_at);
  if (body.session_id && !readOnlyAuthorization.readOnly
    && (!body.workspace_lease_nonce || !Number.isFinite(leaseDeadlineAt) || Date.now() >= leaseDeadlineAt)) {
    return writeJson(res, 409, {
      error: { code: "workspace_lease_lost", message: "A live workspace mutation lease nonce and expiry are required before a modifying worker can start." },
    });
  }
  const run = {
    remoteRunId: `stdio_${randomUUID().slice(0, 8)}`,
    devRunId: body.parent_run_id || body.run_id,
    workSessionId: body.session_id,
    workspaceSessionId: body.workspace_session_id,
    agentId: body.agent_id,
    attemptNumber: body.attempt_number,
    dispatchIdempotencyKey,
    workspaceRoot,
    workspaceLeaseNonce: body.workspace_lease_nonce,
    workspaceLeaseExpiresAt: body.workspace_lease_expires_at,
    readOnlyAudit: readOnlyAuthorization.readOnly,
    readOnlyExecutionGrant: readOnlyAuthorization.grant,
    task,
    launchState: "dispatching",
    child: null,
    conn: null,
    finalized: false,
    authoritativeCompletion: false,
  };
  if (run.workSessionId && [...active.values()].some((item) => item.workSessionId === run.workSessionId)) {
    const existing = [...active.values()].find((item) => item.workSessionId === run.workSessionId);
    return writeJson(res, 409, {
      error: { code: "duplicate_session", message: `A worker is already running for this work session: ${run.workSessionId}` },
      run_id: existing.remoteRunId,
      remote_run_id: existing.remoteRunId,
      work_session_id: run.workSessionId,
      dispatch_idempotency_key: existing.dispatchIdempotencyKey,
    });
  }

  if (run.readOnlyAudit) {
    const executable = resolveExecutablePath(AGENT_COMMAND);
    if (!executable) {
      return writeJson(res, 503, { error: { code: "sandbox_unavailable", message: "The configured ACP executable cannot be resolved for confined execution." } });
    }
    try {
      probeReadOnlyExecutionSandbox({ workspaceRoot });
      run.readOnlySandbox = buildReadOnlySandboxCommand({
        workspaceRoot,
        executable,
        args: AGENT_ARGS,
        env: readOnlyWorkerEnvironment(process.env),
        toolchainPaths: process.env.KONTROL_VERIFY_TOOLCHAIN_PATHS,
      });
    } catch (error) {
      if (error?.code === "sandbox_unavailable") {
        return writeJson(res, 503, { error: { code: "sandbox_unavailable", message: error.message } });
      }
      throw error;
    }
    run.readOnlyExecutionReceipt = {
      issuer: "kontrol",
      work_session_id: run.workSessionId,
      workspace_session_id: run.workspaceSessionId,
      parent_run_id: run.devRunId,
      remote_run_id: run.remoteRunId,
      attempt_number: run.attemptNumber,
      dispatch_idempotency_key: dispatchIdempotencyKey,
      grant_expires_at: run.readOnlyExecutionGrant.expiresAt,
      grant_fingerprint: createHash("sha256").update(run.readOnlyExecutionGrant.signature).digest("hex"),
      confinement: "bubblewrap-read-only-workspace-no-network",
    };
  }

  const agentLaunch = {
    command: run.readOnlySandbox?.command ?? AGENT_COMMAND,
    args: run.readOnlySandbox?.args ?? AGENT_ARGS,
    env: run.readOnlySandbox?.env ?? safeEnv(),
  };

  // Persist the idempotency claim before process creation. After a crash,
  // "dispatching" is uncertainty and is never permission to launch a second
  // child for the same key.
  if (dispatchIdempotencyKey) {
    await recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, dispatchIdempotencyKey, run.remoteRunId, "dispatching", {
      launchGateVersion: 1,
      parentRunId: run.devRunId,
      attemptNumber: run.attemptNumber,
      workSessionId: run.workSessionId,
      workspaceSessionId: run.workspaceSessionId,
      workspaceRoot,
      agentId: run.agentId,
      requestFingerprint,
      executionReceipt: run.readOnlyExecutionReceipt,
      intendedChild: {
        command: agentLaunch.command,
        cwd: workspaceRoot,
        argsSha256: createHash("sha256").update(JSON.stringify(agentLaunch.args)).digest("hex"),
      },
    });
  }
  active.set(run.remoteRunId, run);
  const heartbeatTimer = setInterval(() => reportEvent(run, "heartbeat"), 20_000);

  try {
    const launchGate = await prepareOwnedChild(agentLaunch.command, agentLaunch.args, {
      cwd: workspaceRoot,
      env: agentLaunch.env,
    });
    run.launchGate = launchGate;
    run.child = launchGate.child;
    const stream = childDuplexStream(run.child);
    run.conn = createAcpDuplex(stream, createKontrolHttpHandler(run));
    run.child.stderr.setEncoding("utf8");
    run.child.stderr.on("data", (chunk) => reportStructured(run, "output_delta", { channel: "stderr", text: String(chunk) }));
    const onChildExit = (code, signal) => {
      clearInterval(heartbeatTimer);
      active.delete(run.remoteRunId);
      ownedProcesses.delete(run.remoteRunId);
      void atomicWriteJson(OWNED_PROCESSES_PATH, [...ownedProcesses.values()]).catch((err) => console.error("[stdio-duplex] ownership cleanup failed:", err));
      if (run.finalized) return;
      run.finalized = true;
      const terminalStatus = code === 0 && run.authoritativeCompletion ? "completed" : "failed";
      if (run.dispatchIdempotencyKey) void recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, run.dispatchIdempotencyKey, run.remoteRunId, terminalStatus).catch((err) => console.error("[stdio-duplex] receipt finalization failed:", err));
      if (terminalStatus === "completed") reportEvent(run, "completed");
      else reportEvent(run, "failed", code === 0
        ? "protocol_incomplete: ACP turn ended without an authoritative result"
        : signal ? `terminated by ${signal}` : `exit code ${code}`);
    };
    run.child.on("exit", (code, signal) => {
      if (!run.acceptancePersisted) {
        run.pendingExit = [code, signal];
        return;
      }
      onChildExit(code, signal);
    });

    const ownership = {
      remoteRunId: run.remoteRunId,
      workSessionId: run.workSessionId,
      workspaceSessionId: run.workspaceSessionId,
      kontrolRunId: run.devRunId,
      dispatchIdempotencyKey,
      attemptNumber: run.attemptNumber,
      requestFingerprint,
      pid: run.child.pid,
      processGroupId: run.child.pid,
      processStartToken: processStartToken(run.child.pid),
      launchState: "prepared",
      workspaceRoot,
      readOnlyExecutionGrant: run.readOnlyExecutionGrant,
      startedAt: Date.now(),
    };
    ownedProcesses.set(run.remoteRunId, ownership);
    try {
      await atomicWriteJson(OWNED_PROCESSES_PATH, [...ownedProcesses.values()]);
    } catch (error) {
      run.finalized = true;
      ownedProcesses.delete(run.remoteRunId);
      launchGate.abort();
      const stopped = await terminateProcessGroup(ownership, 5_000).catch(() => false);
      if (stopped && dispatchIdempotencyKey) {
        await recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, dispatchIdempotencyKey, run.remoteRunId, "unstarted", {
          authoritativelyUnstarted: true,
          lastError: "Worker launch gate was closed because durable process ownership could not be recorded.",
        }).catch(() => {});
      }
      throw new Error(`cannot durably record ACP child ownership: ${error instanceof Error ? error.message : String(error)}`);
    }
    run.launchState = "start_requested";
    ownership.launchState = "start_requested";
    await atomicWriteJson(OWNED_PROCESSES_PATH, [...ownedProcesses.values()]);
    if (dispatchIdempotencyKey) {
      await recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, dispatchIdempotencyKey, run.remoteRunId, "dispatching", {
        launchState: "start_requested",
      });
    }
    run.launchOpenRequested = true;
    await launchGate.start();
    let receipt;
    if (dispatchIdempotencyKey) {
      receipt = await recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, dispatchIdempotencyKey, run.remoteRunId, "running", {
        pid: run.child.pid,
        launchState: "worker_started",
      });
    }
    run.acceptancePersisted = true;
    run.launchState = "running";
    reportEvent(run, "started");
    if (run.pendingExit) onChildExit(...run.pendingExit);

    if (!run.finalized) void dispatchTurn(run).catch((err) => {
      if (run.finalized) return;
      run.finalized = true;
      active.delete(run.remoteRunId);
      clearInterval(heartbeatTimer);
      if (run.dispatchIdempotencyKey) {
        void recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, run.dispatchIdempotencyKey, run.remoteRunId, "failed").catch(() => {});
      }
      reportEvent(run, "failed", err instanceof Error ? err.message : String(err));
      try { run.conn?.close(); } catch { /* ignore */ }
      try { run.child?.kill("SIGTERM"); } catch { /* ignore */ }
    });
    return writeJson(res, 202, {
      run_id: run.remoteRunId,
      remote_run_id: run.remoteRunId,
      accepted: true,
      status: receipt?.status === "dispatching" ? "running" : receipt?.status ?? "running",
      ...(dispatchIdempotencyKey ? { dispatch_idempotency_key: dispatchIdempotencyKey } : {}),
      mode: body.mode || "async",
      duplex: true,
      ...(run.readOnlyExecutionReceipt ? { execution_receipt: run.readOnlyExecutionReceipt } : {}),
    });
  } catch (error) {
    active.delete(run.remoteRunId);
    clearInterval(heartbeatTimer);
    if (run.child?.pid && !run.launchOpenRequested && !run.finalized) {
      run.finalized = true;
      run.launchGate?.abort();
      const stopped = await terminateProcessGroup({
        pid: run.child.pid,
        processGroupId: run.child.pid,
        processStartToken: processStartToken(run.child.pid),
      }, 5_000).catch(() => false);
      if (stopped) {
        ownedProcesses.delete(run.remoteRunId);
        await atomicWriteJson(OWNED_PROCESSES_PATH, [...ownedProcesses.values()]).catch(() => {});
      } else {
        await atomicWriteJson(OWNED_PROCESSES_PATH, [...ownedProcesses.values()]).catch(() => {});
      }
      if (dispatchIdempotencyKey) {
        await recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, dispatchIdempotencyKey, run.remoteRunId, "unstarted", {
          authoritativelyUnstarted: true,
          lastError: `Worker launch gate closed before start: ${error instanceof Error ? error.message : String(error)}`,
        }).catch(() => {});
      }
    } else if (!run.child && !run.launchOpenRequested && dispatchIdempotencyKey
      && findAdapterDispatchReceipt(dispatchReceipts, dispatchIdempotencyKey)?.status === "dispatching") {
      await recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, dispatchIdempotencyKey, run.remoteRunId, "unstarted", {
        authoritativelyUnstarted: true,
        lastError: `Owned launch gate failed before worker creation: ${error instanceof Error ? error.message : String(error)}`,
      }).catch(() => {});
    } else if (run.child?.pid && run.launchOpenRequested && !run.acceptancePersisted && !run.finalized) {
      run.finalized = true;
      try { run.conn?.close(); } catch { /* ignore */ }
      const ownership = ownedProcesses.get(run.remoteRunId) ?? {
        pid: run.child.pid,
        processGroupId: run.child.pid,
        processStartToken: processStartToken(run.child.pid),
      };
      const stopped = await terminateProcessGroup(ownership, 5_000).catch(() => false);
      if (stopped) {
        let terminalReceiptPersisted = true;
        if (dispatchIdempotencyKey) {
          try {
            await recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, dispatchIdempotencyKey, run.remoteRunId, "failed", {
              lastError: `Worker started but acceptance could not be durably recorded: ${error instanceof Error ? error.message : String(error)}`,
            });
          } catch { terminalReceiptPersisted = false; }
        }
        if (terminalReceiptPersisted) {
          ownedProcesses.delete(run.remoteRunId);
          await atomicWriteJson(OWNED_PROCESSES_PATH, [...ownedProcesses.values()]).catch(() => {});
          await reportEvent(run, "failed", "Worker stopped because durable acceptance could not be recorded.");
        }
      }
    } else if (run.child?.pid && !run.finalized) {
      cancelRun(run, "adapter could not confirm worker launch outcome");
    }
    throw error;
  }
}

async function dispatchTurn(run) {
  let method = DISPATCH_METHOD;
  let params;
  if (!method) {
    const initialization = await run.conn.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "kontrol", title: "Kontrol ACP Adapter", version: "1" },
    });
    if (!initialization || initialization.protocolVersion !== 1) {
      throw new Error("ACP agent did not negotiate protocol version 1.");
    }
    const session = await run.conn.request("session/new", {
      cwd: run.readOnlyAudit ? "/workspace" : run.workspaceRoot,
      mcpServers: [],
    });
    if (!session || typeof session.sessionId !== "string" || session.sessionId.trim().length === 0) {
      throw new Error("ACP agent returned no sessionId from session/new.");
    }
    run.acpSessionId = session.sessionId;
    method = "session/prompt";
    params = {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: run.task }],
    };
  } else {
    params = {
      sessionId: run.workSessionId ?? run.workspaceSessionId,
      workspaceSessionId: run.workspaceSessionId,
      workSessionId: run.workSessionId,
      runId: run.remoteRunId,
      cwd: run.workspaceRoot,
      prompt: run.task,
      input: run.task,
    };
  }
  const result = await run.conn.request(method, params);
  reportStructured(run, "output_delta", {
    channel: "result",
    text: typeof result === "string" ? result : JSON.stringify(result),
    raw: result,
  });
  run.authoritativeCompletion = true;
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
    headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(agentIdentity) },
    body: JSON.stringify({
      type: "permission.requested",
      remote_run_id: run.remoteRunId,
      work_session_id: run.workSessionId,
      attempt_number: run.attemptNumber,
      workspace_lease_nonce: run.workspaceLeaseNonce,
      ...(run.readOnlyExecutionGrant ? { read_only_execution_grant: run.readOnlyExecutionGrant } : {}),
      payload,
    }),
  }).catch(() => undefined);
  if (!res?.ok) return undefined;
  return res.json().catch(() => undefined);
}

async function waitForApprovalDecision(run, approvalId, signal) {
  while (!signal.aborted && active.has(run.remoteRunId)) {
    const res = await fetch(`${KONTROL_ACP_URL}/approvals/${approvalId}/decision`, {
      headers: { authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(agentIdentity) },
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
  if (run.dispatchIdempotencyKey) {
    void recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, run.dispatchIdempotencyKey, run.remoteRunId, "cancelled")
      .catch((error) => console.error("[stdio-duplex] cancellation receipt failed:", error));
  }
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

async function reportRecoveredRun(record) {
  if (!record?.kontrolRunId || !record?.remoteRunId) return;
  await fetch(`${KONTROL_ACP_URL}/runs/${record.kontrolRunId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(agentIdentity) },
    body: JSON.stringify({
      type: "failed",
      remote_run_id: record.remoteRunId,
      work_session_id: record.workSessionId,
      attempt_number: record.attemptNumber,
      ...(record.readOnlyExecutionGrant ? { read_only_execution_grant: record.readOnlyExecutionGrant } : {}),
      payload: { error: "Adapter restarted and confirmed the detached ACP worker stopped; its turn result is unavailable." },
    }),
  }).catch((error) => console.warn("[stdio-duplex] recovered-run event delivery failed:", error.message));
}

async function reportEvent(run, type, errorMessage) {
  await fetch(`${KONTROL_ACP_URL}/runs/${run.devRunId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(agentIdentity) },
    body: JSON.stringify({
      type,
      remote_run_id: run.remoteRunId,
      work_session_id: run.workSessionId,
      attempt_number: run.attemptNumber,
      workspace_lease_nonce: run.workspaceLeaseNonce,
      ...(run.readOnlyExecutionGrant ? { read_only_execution_grant: run.readOnlyExecutionGrant } : {}),
      payload: errorMessage ? { error: errorMessage } : {},
    }),
  }).catch(() => {});
}

function reportStructured(run, type, payload) {
  void fetch(`${KONTROL_ACP_URL}/runs/${run.devRunId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(agentIdentity) },
    body: JSON.stringify({
      type,
      remote_run_id: run.remoteRunId,
      work_session_id: run.workSessionId,
      attempt_number: run.attemptNumber,
      workspace_lease_nonce: run.workspaceLeaseNonce,
      ...(run.readOnlyExecutionGrant ? { read_only_execution_grant: run.readOnlyExecutionGrant } : {}),
      payload,
    }),
  }).catch(() => {});
}

function authorized(req) {
  return (req.headers.authorization || "") === `Bearer ${ADAPTER_SECRET}`;
}

function safeEnv() {
  const allowed = ["HOME", "PATH", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"];
  const env = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...readOnlyWorkerEnvironment(process.env) };
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
