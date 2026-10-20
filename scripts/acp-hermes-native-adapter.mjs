#!/usr/bin/env node
// Native Hermes ACP bridge.
//
// This adapter registers `hermes-agent` as an HTTP ACP peer for Kontrol, but
// executes turns through Hermes's native ACP stdio server via
// scripts/hermes-native-runner.py. It is separate from acp-crush-adapter.mjs on
// purpose: Hermes must not be represented as a CRUSH-style subprocess wrapper.

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clearAgentIdentity, identityHeaders, loadAgentIdentity, saveAgentIdentity } from "./lib/acp-agent-identity.mjs";
import { readJsonBody, truncateUtf8Tail, writeAdapterError } from "./lib/adapter-http.mjs";
import { buildToolEnvironment } from "./lib/tool-environment.mjs";
import { signWorkerToken, TOKEN_TTL_MS } from "./lib/acp-worker-token.mjs";
import { adapterStatePath, atomicWriteJson, prepareOwnedChild, processStartToken, readJsonOr, reconcileOwnedProcesses, terminateProcessGroup } from "./lib/managed-agent-process.mjs";
import { applyWorkspaceLeaseRenewal, workspaceLeaseDeadline, workspaceLeaseDeadlineReached } from "./lib/workspace-lease.mjs";
import { formatHermesAcpAttempts, hermesAcpCandidates, selectHermesAcpEntry } from "./lib/hermes-acp-entry.mjs";
import { acknowledgeAdapterDispatchReceipt, adapterDispatchFingerprint, findAdapterDispatchReceipt, isTerminalAdapterDispatchStatus, loadAdapterDispatchReceipts, reconcileAdapterDispatchReceipts, recordAdapterDispatchReceipt } from "./lib/adapter-dispatch-receipts.mjs";
const readOnlyModuleUrl = process.env.KONTROL_ARTIFACT_PATH
  ? pathToFileURL(resolve(process.env.KONTROL_ARTIFACT_PATH, "read-only-execution.mjs"))
  : new URL("./lib/read-only-execution.mjs", import.meta.url);
const readOnlyExecutionModule = await import(readOnlyModuleUrl);
const boundedWriteModuleUrl = process.env.KONTROL_ARTIFACT_PATH
  ? pathToFileURL(resolve(process.env.KONTROL_ARTIFACT_PATH, "bounded-file-write.mjs"))
  : new URL("./lib/bounded-file-write.mjs", import.meta.url);
const boundedFileWriteModule = await import(boundedWriteModuleUrl);
const { validateBoundedFileWriteDispatchRequest } = boundedFileWriteModule;
const {
  buildReadOnlySandboxCommand,
  probeReadOnlyExecutionSandbox,
  readOnlyWorkerEnvironment,
  resolveExecutablePath,
  validateReadOnlyDispatchRequest,
} = readOnlyExecutionModule;

const KONTROL_ACP_URL = process.env.KONTROL_ACP_URL || "http://127.0.0.1:7676/acp";
const KONTROL_MCP_URL = process.env.KONTROL_MCP_URL || KONTROL_ACP_URL.replace(/\/acp$/, "/mcp");
const AGENT_SECRET = process.env.KONTROL_ACP_AGENT_SECRET;
const ADAPTER_SECRET = process.env.KONTROL_ACP_ADAPTER_SECRET;
const HERMES_BIN = process.env.HERMES_BIN || "hermes";
const HERMES_BIN_EXPLICIT = Boolean(process.env.HERMES_BIN);
const HERMES_ACP_BIN = process.env.HERMES_ACP_BIN;
const HERMES_AGENT_ROOT = process.env.HERMES_AGENT_ROOT || detectHermesAgentRoot() || process.cwd();
const ADAPTER_PORT = Number(process.env.HERMES_ACP_ADAPTER_PORT || process.env.ACP_ADAPTER_PORT || "9911");
const ADAPTER_HOST = process.env.HERMES_ACP_ADAPTER_HOST || "127.0.0.1";
const RUNNER = fileURLToPath(new URL("./hermes-native-runner.py", import.meta.url));
const HERMES_ACP_COMPAT_PATH = fileURLToPath(new URL("./hermes-acp-compat", import.meta.url));
const DEADMAN_IDLE_MS = positiveDuration(process.env.KONTROL_HERMES_DEADMAN_IDLE_MS, 5 * 60_000);
const MAX_RUN_MS = positiveDuration(process.env.KONTROL_HERMES_MAX_RUN_SECONDS, 2 * 60 * 60) * 1000;
const FINAL_OUTPUT_BYTES = 2 * 1024 * 1024;
const OWNED_PROCESSES_PATH = process.env.KONTROL_HERMES_OWNED_PROCESSES
  || adapterStatePath("hermes", "owned-processes.json");
const DISPATCH_RECEIPTS_PATH = process.env.KONTROL_HERMES_DISPATCH_RECEIPTS
  || adapterStatePath("hermes", "dispatch-receipts.json");
const TERMINAL_SPOOL_PATH = process.env.KONTROL_HERMES_TERMINAL_SPOOL
  || adapterStatePath("hermes", "terminal-spool.json");
const EVENT_SPOOL_PATH = process.env.KONTROL_HERMES_EVENT_SPOOL
  || adapterStatePath("hermes", "event-spool.json");
const EVENT_SPOOL_MAX_EVENTS = 512;
const HERMES_READ_ONLY_PACKAGES = Object.freeze([
  "agent",
  "acp_adapter",
  "gateway",
  "hermes_cli",
  "offblock",
  "plugins",
  "providers",
  "tools",
  "tui_gateway",
]);
const HERMES_READ_ONLY_ROOT_MODULES = Object.freeze([
  "batch_runner.py",
  "cli.py",
  "hermes_bootstrap.py",
  "hermes_constants.py",
  "hermes_logging.py",
  "hermes_state.py",
  "hermes_state_common.py",
  "hermes_state_portability.py",
  "hermes_state_schema.py",
  "hermes_state_search.py",
  "hermes_time.py",
  "mcp_serve.py",
  "mini_swe_runner.py",
  "model_tools.py",
  "registration_lifecycle.py",
  "run_agent.py",
  "toolset_distributions.py",
  "toolsets.py",
  "trajectory_compressor.py",
  "utils.py",
]);

if (process.argv.includes("--validate-imports")) {
  console.log("[hermes-native] import validation ok");
  process.exit(0);
}

if (!AGENT_SECRET || !ADAPTER_SECRET) {
  console.error("[hermes-native] KONTROL_ACP_AGENT_SECRET and KONTROL_ACP_ADAPTER_SECRET are required");
  process.exit(1);
}

function hermesCheckEnvironment() {
  return buildToolEnvironment(process.env, {
    overrides: {
      HERMES_AGENT_ROOT,
      PYTHONPATH: withHermesPythonPath(process.env.PYTHONPATH),
    },
  });
}

// Current upstream exposes `hermes-acp`; older installations may still only
// provide `hermes acp`. Probe once and retain the exact successful command so
// confined and ordinary launches use the same entry point.
const hermesBinPath = resolveHermesBinaryPath();
const hermesAcpSelection = selectHermesAcpEntry(
  hermesAcpCandidates({ hermesAcpBin: HERMES_ACP_BIN, hermesBin: HERMES_BIN, hermesBinPath, hermesBinExplicit: HERMES_BIN_EXPLICIT }),
  (entry) => spawnSync(entry.command, [...entry.args, "--check"], {
    encoding: "utf8",
    env: hermesCheckEnvironment(),
  }),
);
if (!hermesAcpSelection.entry) {
  console.error("[hermes-native] no supported Hermes ACP entry point passed --check; refusing to register hermes-agent");
  console.error(formatHermesAcpAttempts(hermesAcpSelection.attempts));
  process.exit(1);
}
const HERMES_ACP_ENTRY = hermesAcpSelection.entry;
console.log(`[hermes-native] using Hermes ACP entry: ${HERMES_ACP_ENTRY.command} ${HERMES_ACP_ENTRY.args.join(" ")}`.trim());

const PYTHON_BIN = resolveHermesPython();
let degraded = PYTHON_BIN === null;
const active = new Map();
const ownedProcesses = new Map();
const dispatchReceipts = await loadAdapterDispatchReceipts(DISPATCH_RECEIPTS_PATH);
const pendingTerminalSpool = new Map();
const pendingEventSpool = new Map();
let agentIdentity = null;
const adapterGenerationId = process.env.KONTROL_LAUNCH_GENERATION_ID || "unknown";
let reconciliationComplete = false;
let orphanProcessesTerminated = 0;

const reconciliation = await reconcileOwnedProcesses(OWNED_PROCESSES_PATH, "hermes-native");
orphanProcessesTerminated = reconciliation.terminated;
reconciliationComplete = true;
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
      lastError: "Adapter restarted and confirmed its detached Hermes worker stopped before a terminal result was recorded.",
    });
  }
}
for (const entry of await readJsonOr(TERMINAL_SPOOL_PATH, [])) {
  if (entry?.runId && entry.payload) pendingTerminalSpool.set(entry.runId, entry);
}
for (const entry of await readJsonOr(EVENT_SPOOL_PATH, [])) {
  if (entry?.event_id && entry?.runId) pendingEventSpool.set(entry.event_id, entry);
}

if (degraded) {
  console.error("[hermes-native] starting in DEGRADED mode — Hermes runs will be rejected until fixed");
  console.error("Set HERMES_NATIVE_PYTHON to the Hermes virtualenv Python, e.g. /path/to/hermes-agent/.venv/bin/python");
} else {
  try {
    await registerAgentWithRetry();
    for (const record of recoveredRuns) await reportRecoveredRun(record);
    setInterval(() => heartbeat().catch((err) => console.warn("[hermes-native] heartbeat:", err.message)), 55_000);
  } catch (err) {
    degraded = true;
    console.error(`[hermes-native] starting in DEGRADED mode — agent registration failed: ${err.message}`);
    console.error("Hermes runs will be rejected until Kontrol is reachable and registration succeeds.");
  }
}

const httpServer = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[hermes-native] request error:", err);
    writeAdapterError(res, err);
  });
}).listen(ADAPTER_PORT, ADAPTER_HOST, () => {
  console.log(`[hermes-native] listening on ${ADAPTER_HOST}:${ADAPTER_PORT}`);
});

let shuttingDown = false;
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  httpServer.close();
  await Promise.all([...active.values()].map((run) => terminateRun(run, "adapter shutdown", "cancelled")));
  await flushEventSpools();
  process.exit(0);
}

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
      capabilities: ["native-acp", "streaming", "tool-events", "http-approval-bridge", "review-barrier", "scheduled:read_only_audit", "scheduled:bounded_file_write"],
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
    const ready = reconciliationComplete && !degraded && !shuttingDown;
    return writeJson(res, ready ? 200 : 503, {
      ok: ready,
      ready,
      lifecycle: ready ? "READY" : degraded ? "DEGRADED" : "STARTING_RECONCILIATION",
      reconciled: reconciliationComplete,
      orphanProcessesTerminated,
      degraded,
      agent: "hermes-agent",
      active: active.size,
      native: true,
      generationId: adapterGenerationId,
      executionCapabilities: {
        read_only_audit: {
          supported: true,
          grantPolicy: "kontrol_signed_attempt_bound",
          confinementAvailable: Boolean(resolveExecutablePath("bwrap") && resolveExecutablePath("prlimit")),
          executableAvailable: Boolean(PYTHON_BIN && resolveExecutablePath(PYTHON_BIN) && resolveExecutablePath(HERMES_ACP_ENTRY.command) && existsSync(RUNNER)),
          cliInputContract: "hermes_public_acp_v1_session_prompt",
          networkPolicies: ["disabled", "host"],
        },
        bounded_file_write: {
          supported: true,
          grantPolicy: "kontrol_signed_attempt_bound",
          confinementAvailable: Boolean(resolveExecutablePath("bwrap") && resolveExecutablePath("prlimit")),
          executableAvailable: Boolean(PYTHON_BIN && resolveExecutablePath(PYTHON_BIN) && resolveExecutablePath(HERMES_ACP_ENTRY.command) && existsSync(RUNNER)),
          cliInputContract: "hermes_public_acp_v1_session_prompt",
          networkPolicies: ["disabled", "host"],
        },
      },
    });
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
  const dispatchLookup = (req.url || "").match(/^\/runs\/by-dispatch-id\/([^/]+)$/);
  if (req.method === "GET" && dispatchLookup) {
    if ((req.headers.authorization || "") !== `Bearer ${ADAPTER_SECRET}`) {
      return writeJson(res, 401, { error: { code: "unauthorized" } });
    }
    const key = decodeURIComponent(dispatchLookup[1]);
    const activeRun = [...active.values()].find((run) => run.dispatchIdempotencyKey === key);
    const receipt = findAdapterDispatchReceipt(dispatchReceipts, key);
    const remoteRunId = activeRun?.remoteRunId ?? receipt?.remoteRunId;
    if (remoteRunId) {
      const status = activeRun
        ? activeRun.lifecycle === "RUNNING" ? "running" : "uncertain"
        : receipt?.status ?? "uncertain";
      return writeJson(res, 200, {
        run_id: remoteRunId,
        remote_run_id: remoteRunId,
        accepted: !["dispatching", "uncertain", "unstarted"].includes(status),
        status: status === "dispatching" ? "uncertain" : status,
        dispatch_idempotency_key: key,
        ...(activeRun?.readOnlyExecutionReceipt ?? receipt?.executionReceipt
          ? { execution_receipt: activeRun?.readOnlyExecutionReceipt ?? receipt.executionReceipt }
          : {}),
        ...(receipt?.authoritativelyUnstarted ? { authoritatively_unstarted: true } : {}),
      });
    }
    return writeJson(res, 404, { error: { code: "not_found" } });
  }
  if (req.method !== "POST" || req.url !== "/runs") {
    return writeJson(res, 404, { error: { code: "not_found" } });
  }
  if ((req.headers.authorization || "") !== `Bearer ${ADAPTER_SECRET}`) {
    return writeJson(res, 401, { error: { code: "unauthorized" } });
  }
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
      return writeJson(res, 202, {
        worker_token: run.workerToken,
      run_id: receipt.remoteRunId,
        remote_run_id: receipt.remoteRunId,
        accepted: !["dispatching", "unstarted"].includes(receipt.status),
        status: receipt.status === "dispatching" ? "uncertain" : receipt.status,
        dispatch_idempotency_key: dispatchIdempotencyKey,
        ...(receipt.executionReceipt ? { execution_receipt: receipt.executionReceipt } : {}),
        ...(receipt.authoritativelyUnstarted ? { authoritatively_unstarted: true } : {}),
        replayed: true,
      });
    }
  }
  if (degraded) {
    return writeJson(res, 503, { error: { code: "degraded", message: "Hermes adapter is degraded: no Python interpreter found" } });
  }
  if (body.smoke_test) {
    return writeJson(res, 202, { run_id: "hermes-native-smoke", smoke_test: true, native: true, accepted: true, status: "completed" });
  }
  const task = extractTask(body.input);
  if (!task.trim()) {
    return writeJson(res, 400, { error: { code: "invalid_task", message: "ACP task must be non-empty" } });
  }

  const workspaceRoot = await validateWorkspaceRoot(body.workspace_root);
  const requestedMaxRuntimeMs = Number(body.scheduled_execution_policy?.maxRuntimeMs);
  const runMaxRuntimeMs = Number.isSafeInteger(requestedMaxRuntimeMs) && requestedMaxRuntimeMs > 0
    ? Math.min(MAX_RUN_MS, requestedMaxRuntimeMs)
    : MAX_RUN_MS;
  const readOnlyAuthorization = validateReadOnlyDispatchRequest(body, workspaceRoot, ADAPTER_SECRET, agentIdentity?.agentId);
  if (readOnlyAuthorization.readOnly && !readOnlyAuthorization.valid) {
    return writeJson(res, 403, { error: { code: "read_only_grant_invalid", message: "A valid Kontrol-issued read-only execution grant is required." } });
  }
  const boundedWriteAuthorization = validateBoundedFileWriteDispatchRequest(body, ADAPTER_SECRET, agentIdentity?.agentId);
  if (boundedWriteAuthorization.boundedWrite && !boundedWriteAuthorization.valid) {
    return writeJson(res, 403, { error: { code: "bounded_file_write_grant_invalid", message: "A valid Kontrol-issued bounded file-write grant is required." } });
  }
  const run = {
    remoteRunId: `hermes_${randomUUID().slice(0, 8)}`,
    devRunId: body.parent_run_id || body.run_id,
    workSessionId: body.session_id,
    workspaceSessionId: body.workspace_session_id,
    agentId: body.agent_id,
    dispatchIdempotencyKey,
    attemptNumber: body.attempt_number,
    requestFingerprint,
    task,
    workspaceRoot,
    readOnlyAudit: readOnlyAuthorization.readOnly && !boundedWriteAuthorization.boundedWrite,
    boundedFileWrite: boundedWriteAuthorization.boundedWrite,
    workerToken: null,
    boundedFileWriteGrant: boundedWriteAuthorization.grant,
    readOnlyExecutionGrant: readOnlyAuthorization.grant,
    workspaceLeaseNonce: body.workspace_lease_nonce,
    workspaceLeaseExpiresAt: body.workspace_lease_expires_at,
    workspaceLeaseDeadlineAt: workspaceLeaseDeadline(body.workspace_lease_expires_at),
    maxRunMs: runMaxRuntimeMs,
    startedAt: Date.now(),
    child: null,
    lifecycle: "STARTING",
    finalized: false,
    explicitCompletion: false,
    pendingPermissions: new Map(),
    activeChildOperations: new Set(),
    lastRunnerActivityAt: Date.now(),
    absoluteDeadlineAt: Date.now() + runMaxRuntimeMs,
    sawAgentMessage: false,
    sendChain: Promise.resolve(),
    deliveryErrors: [],
    eventSequence: 0,
    terminalOutcome: null,
    finalOutput: "",
  };
  if (run.workSessionId && hasActiveSession(run.workSessionId)) {
    const existing = [...active.values()].find((item) => item.workSessionId === run.workSessionId);
    return writeJson(res, 409, {
      error: { code: "duplicate_session", message: `work session already active: ${run.workSessionId}` },
      ...(existing ? { run_id: existing.remoteRunId, remote_run_id: existing.remoteRunId } : {}),
      work_session_id: run.workSessionId,
      ...(existing?.dispatchIdempotencyKey ? { dispatch_idempotency_key: existing.dispatchIdempotencyKey } : {}),
    });
  }
  if (run.workSessionId) {
    run.workerToken = signWorkerToken({
      role: "worker",
      workSessionId: run.workSessionId,
      workspaceSessionId: run.workspaceSessionId ?? "",
      runId: run.devRunId,
      exp: Date.now() + TOKEN_TTL_MS,
    }, AGENT_SECRET);
  }
  const execution = run.boundedFileWrite
    ? {
      mode: "bounded_file_write",
      grant: run.boundedFileWriteGrant,
      networkPolicy: run.boundedFileWriteGrant?.networkPolicy,
      grantFingerprint: run.boundedFileWriteGrant
        ? createHash("sha256").update(run.boundedFileWriteGrant.signature).digest("hex")
        : undefined,
    }
    : {
      mode: "read_only_audit",
      grant: run.readOnlyExecutionGrant,
      networkPolicy: run.readOnlyExecutionGrant?.networkPolicy,
      grantFingerprint: run.readOnlyExecutionGrant
        ? createHash("sha256").update(run.readOnlyExecutionGrant.signature).digest("hex")
        : undefined,
    };
  if (!execution.grant || !execution.networkPolicy || !execution.grantFingerprint) {
    return writeJson(res, 403, {
      error: { code: "execution_grant_incomplete", message: "A complete signed execution grant is required for confined Hermes execution." },
    });
  }
  if (run.boundedFileWrite && execution.networkPolicy !== "host") {
    return writeJson(res, 503, {
      error: {
        code: "sandbox_control_plane_unavailable",
        message: "Hermes bounded writes require the explicitly configured host network policy until Kontrol provides a local IPC transport inside an isolated network namespace.",
      },
    });
  }
  run.execution = execution;
  if (run.workSessionId && !run.readOnlyAudit && !run.boundedFileWrite && (!run.workspaceLeaseNonce || workspaceLeaseDeadlineReached(run))) {
    return writeJson(res, 409, {
      error: { code: "workspace_lease_lost", message: "A live workspace lease nonce and expiry are required before a worker can start." },
    });
  }
  if (run.readOnlyAudit || run.boundedFileWrite) {
    try {
      const pythonExecutable = resolveExecutablePath(PYTHON_BIN);
      const hermesExecutable = resolveExecutablePath(HERMES_ACP_ENTRY.command);
      if (!pythonExecutable || !hermesExecutable) {
        throw Object.assign(new Error("Hermes Python or selected ACP executable cannot be resolved for confined execution."), { code: "sandbox_unavailable" });
      }
      run.readOnlyRuntimeProjection = prepareHermesReadOnlyRuntime();
      copyFileSync(RUNNER, join(run.readOnlyRuntimeProjection, "hermes-native-runner.py"));
      copyFileSync(join(HERMES_ACP_COMPAT_PATH, "sitecustomize.py"), join(run.readOnlyRuntimeProjection, "sitecustomize.py"));
      const pythonRuntimeRoot = dirname(dirname(pythonExecutable));
      const hermesSandboxCommand = `/opt/kontrol/hermes-bin/${basename(hermesExecutable)}`;
      const configuredToolchains = (process.env.KONTROL_VERIFY_TOOLCHAIN_PATHS ?? "").split(delimiter).filter(Boolean).map((path) => resolve(path));
      const pythonUsesSystemRuntime = pythonExecutable.startsWith("/usr/") || pythonExecutable.startsWith("/bin/");
      if (!pythonUsesSystemRuntime && !configuredToolchains.some((path) => pythonRuntimeRoot === path || pythonRuntimeRoot.startsWith(path + "/"))) {
        throw Object.assign(new Error("Hermes Python runtime must be explicitly approved in KONTROL_VERIFY_TOOLCHAIN_PATHS."), { code: "sandbox_unavailable" });
      }
      run.readOnlySandbox = buildReadOnlySandboxCommand({
        workspaceRoot,
        executable: pythonExecutable,
        executableTarget: pythonUsesSystemRuntime ? undefined : pythonExecutable,
        args: ["/opt/kontrol/hermes-runtime/hermes-native-runner.py"],
        env: {
          ...readOnlyWorkerEnvironment(process.env),
          HERMES_AGENT_ROOT: "/opt/kontrol/hermes-runtime",
          PYTHONPATH: "/opt/kontrol/hermes-runtime",
          PATH: `/opt/kontrol/bin:/opt/kontrol/hermes-bin:/usr/local/bin:/usr/bin:/bin`,
          KONTROL_WORKSPACE_SESSION_ID: run.workspaceSessionId || "",
          KONTROL_WORK_SESSION_ID: run.workSessionId || "",
          KONTROL_PARENT_RUN_ID: run.devRunId || "",
          ...(run.execution.mode === "bounded_file_write" ? { KONTROL_BOUNDED_FILE_WRITE: "1" } : { KONTROL_READ_ONLY_EXECUTION: "1" }),
          KONTROL_MCP_URL,
          KONTROL_WORKER_TOKEN: run.workerToken,
          KONTROL_HERMES_NATIVE_INPUT: JSON.stringify({
            command: hermesSandboxCommand,
            args: HERMES_ACP_ENTRY.args,
            cwd: "/workspace",
            task: run.task,
            runId: run.remoteRunId,
            maxRunSeconds: Math.floor(run.maxRunMs / 1000),
          }),
        },
        toolchainPaths: configuredToolchains,
        networkPolicy: run.execution.networkPolicy,
        bindMounts: [
          { source: run.readOnlyRuntimeProjection, target: "/opt/kontrol/hermes-runtime" },
        ],
        bindFiles: [
          { source: hermesExecutable, target: hermesSandboxCommand },
        ],
      });
      run.readOnlyBindMounts = [
        { source: run.readOnlyRuntimeProjection, target: "/opt/kontrol/hermes-runtime" },
      ];
      run.readOnlyBindFiles = [{ source: hermesExecutable, target: hermesSandboxCommand }];
      probeReadOnlyExecutionSandbox({
        workspaceRoot,
        toolchainPaths: configuredToolchains,
        bindMounts: run.readOnlyBindMounts,
        bindFiles: run.readOnlyBindFiles,
        networkPolicy: run.execution.networkPolicy,
      });
      const runtimeProbe = buildReadOnlySandboxCommand({
        workspaceRoot,
        executable: pythonExecutable,
        executableTarget: pythonUsesSystemRuntime ? undefined : pythonExecutable,
        args: ["-c", "import acp; from acp.core import connect_to_agent; from acp.schema import ClientCapabilities, FileSystemCapabilities, Implementation, TextContentBlock; import acp_adapter.entry; import acp_adapter.server"],
        env: {
          HERMES_AGENT_ROOT: "/opt/kontrol/hermes-runtime",
          PYTHONPATH: "/opt/kontrol/hermes-runtime",
          PATH: "/opt/kontrol/bin:/opt/kontrol/hermes-bin:/usr/local/bin:/usr/bin:/bin",
        },
        toolchainPaths: configuredToolchains,
        bindMounts: run.readOnlyBindMounts,
        bindFiles: run.readOnlyBindFiles,
        networkPolicy: run.execution.networkPolicy,
      });
      const runtimeProbeResult = spawnSync(runtimeProbe.command, runtimeProbe.args, {
        encoding: "utf8",
        timeout: 10_000,
        env: runtimeProbe.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (runtimeProbeResult.error || runtimeProbeResult.status !== 0) {
        const detail = runtimeProbeResult.error?.message ?? runtimeProbeResult.stderr?.trim() ?? `exit ${runtimeProbeResult.status}`;
        throw Object.assign(new Error(`Hermes read-only runtime probe failed: ${detail}`), { code: "sandbox_unavailable" });
      }
      run.readOnlyExecutionReceipt = {
        mode: run.execution.mode,
        execution_grant: run.execution.grant,
        issuer: "kontrol",
        work_session_id: run.workSessionId,
        workspace_session_id: run.workspaceSessionId,
        parent_run_id: run.devRunId,
        remote_run_id: run.remoteRunId,
        attempt_number: run.attemptNumber,
        dispatch_idempotency_key: dispatchIdempotencyKey,
        grant_expires_at: run.execution.grant.expiresAt,
        grant_fingerprint: run.execution.grantFingerprint,
        network_policy: run.execution.networkPolicy,
        confinement: run.execution.networkPolicy === "host" ? "bubblewrap-read-only-workspace-host-network" : "bubblewrap-read-only-workspace-no-network",
      };
    } catch (error) {
      removeHermesReadOnlyRuntime(run);
      if (error?.code === "sandbox_unavailable") {
        return writeJson(res, 503, { error: { code: "sandbox_unavailable", message: error.message } });
      }
      throw error;
    }
  }
  const hermesLaunch = {
    command: run.readOnlySandbox?.command ?? PYTHON_BIN,
    args: run.readOnlySandbox?.args ?? [RUNNER],
    env: run.readOnlySandbox?.env ?? {
      ...safeEnv(),
      HERMES_AGENT_ROOT,
      PYTHONPATH: withHermesPythonPath(process.env.PYTHONPATH),
      KONTROL_WORKSPACE_SESSION_ID: run.workspaceSessionId || "",
      KONTROL_WORK_SESSION_ID: run.workSessionId || "",
      KONTROL_PARENT_RUN_ID: run.devRunId || "",
      KONTROL_WORKSPACE_LEASE_NONCE: run.workspaceLeaseNonce || "",
      KONTROL_HERMES_NATIVE_INPUT: JSON.stringify({
        command: HERMES_ACP_ENTRY.command,
        args: HERMES_ACP_ENTRY.args,
        cwd: workspaceRoot,
        task: run.task,
        runId: run.remoteRunId,
        maxRunSeconds: Math.floor(MAX_RUN_MS / 1000),
      }),
    },
  };
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
        command: hermesLaunch.command,
        cwd: workspaceRoot,
        argsSha256: createHash("sha256").update(JSON.stringify(hermesLaunch.args)).digest("hex"),
      },
    });
  }
  let launchGate;
  try {
    launchGate = await prepareOwnedChild(hermesLaunch.command, hermesLaunch.args, {
      cwd: workspaceRoot,
      env: hermesLaunch.env,
    });
  } catch (error) {
    if (dispatchIdempotencyKey) {
      await recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, dispatchIdempotencyKey, run.remoteRunId, "unstarted", {
        authoritativelyUnstarted: true,
        lastError: `Owned launch gate failed before the worker could start: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    throw error;
  }
  run.launchGate = launchGate;
  const child = launchGate.child;
  run.child = child;
  ownedProcesses.set(run.remoteRunId, {
    remoteRunId: run.remoteRunId,
    workSessionId: run.workSessionId,
    workspaceSessionId: run.workspaceSessionId,
    kontrolRunId: run.devRunId,
    dispatchIdempotencyKey: run.dispatchIdempotencyKey,
    attemptNumber: run.attemptNumber,
    requestFingerprint: run.requestFingerprint,
    readOnlyExecutionGrant: run.readOnlyExecutionGrant,
    pid: child.pid,
    processGroupId: child.pid,
    processStartToken: processStartToken(child.pid),
    launchState: "prepared",
    workspaceRoot,
    adapterGenerationId,
    commandIdentity: hermesLaunch.command,
    startedAt: run.startedAt,
  });
  try {
    await saveOwnedProcesses();
  } catch (error) {
    const ownership = {
      pid: child.pid,
      processStartToken: processStartToken(child.pid),
    };
    active.delete(run.remoteRunId);
    ownedProcesses.delete(run.remoteRunId);
    launchGate.abort();
    try { await terminateProcessGroup(ownership, 5_000); } catch { /* report the original persistence failure */ }
    if (dispatchIdempotencyKey) {
      await recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, dispatchIdempotencyKey, run.remoteRunId, "unstarted", {
        authoritativelyUnstarted: true,
        lastError: "Worker launch gate was closed because durable process ownership could not be recorded.",
      }).catch(() => {});
    }
    throw new Error(`cannot durably record child ownership: ${error instanceof Error ? error.message : String(error)}`);
  }
  const ownership = ownedProcesses.get(run.remoteRunId);
  ownership.launchState = "start_requested";
  try {
    await saveOwnedProcesses();
  } catch (error) {
    launchGate.abort();
    const stopped = await terminateProcessGroup(ownership, 5_000).catch(() => false);
    if (stopped) {
      ownedProcesses.delete(run.remoteRunId);
      await saveOwnedProcesses().catch(() => {});
    } else {
      await saveOwnedProcesses().catch(() => {});
    }
    if (stopped && dispatchIdempotencyKey) {
      await recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, dispatchIdempotencyKey, run.remoteRunId, "unstarted", {
        authoritativelyUnstarted: true,
        lastError: "Worker launch gate was closed because durable start intent could not be recorded.",
      }).catch(() => {});
    }
    throw new Error(`cannot durably record launch intent: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (dispatchIdempotencyKey) {
    try {
      await recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, dispatchIdempotencyKey, run.remoteRunId, "dispatching", {
        launchState: "start_requested",
      });
    } catch (error) {
      launchGate.abort();
      const stopped = await terminateProcessGroup(ownership, 5_000).catch(() => false);
      if (stopped) {
        ownedProcesses.delete(run.remoteRunId);
        await saveOwnedProcesses().catch(() => {});
        await recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, dispatchIdempotencyKey, run.remoteRunId, "unstarted", {
          authoritativelyUnstarted: true,
          lastError: "Worker launch gate was closed because the durable start marker could not be recorded.",
        }).catch(() => {});
      }
      throw error;
    }
  }
  active.set(run.remoteRunId, run);
  const heartbeatTimer = setInterval(() => reportEvent(run, "heartbeat"), 20_000);
  run.leaseWatchdogTimer = setInterval(() => {
    if (!run.readOnlyAudit && workspaceLeaseDeadlineReached(run) && !run.finalized && !run.terminating) {
      void terminateRun(run, "workspace lease renewal deadline elapsed", "failed");
    }
  }, 1_000);
  run.leaseWatchdogTimer.unref?.();

  // P1 #11: The Python runner is the authoritative turn-end detector.
  // It emits {"type":"complete"} when the turn is done. The JS adapter
  // does NOT independently decide "turn completed" — that was the duplicate
  // 20-second heuristic. The deadman timer is a periodic idle-activity
  // check, NOT a wall-clock run limit — a healthy long-running task must
  // never be killed merely because it has been running for a long time.
  run.deadmanTimer = setInterval(() => {
    if (run.finalized) return;
    if (Date.now() >= run.absoluteDeadlineAt) {
      const elapsedMs = Date.now() - (run.absoluteDeadlineAt - run.maxRunMs);
      console.warn(`[hermes-native] absolute run ceiling for ${run.remoteRunId} — ${elapsedMs}ms elapsed`);
      void terminateRun(run, `absolute run ceiling exceeded — ${Math.round(elapsedMs / 1000)}s`, "failed");
      return;
    }
    // A permission request or explicitly reported child operation is
    // meaningful activity even when Hermes is quiet while it runs. The
    // absolute ceiling remains the final safety boundary for a wedged child.
    if (run.pendingPermissions.size > 0 || run.activeChildOperations.size > 0) return;
    const idleMs = Date.now() - run.lastRunnerActivityAt;
    if (idleMs > DEADMAN_IDLE_MS) {
      console.warn(`[hermes-native] deadman idle timeout for ${run.remoteRunId} — ${idleMs}ms since last runner event`);
      void terminateRun(run, `deadman idle timeout — no runner event for ${Math.round(idleMs / 1000)}s`, "failed");
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
  const handleChildError = (err) => {
    clearInterval(heartbeatTimer);
    clearInterval(run.leaseWatchdogTimer);
    clearInterval(run.deadmanTimer);
    ownedProcesses.delete(run.remoteRunId);
    void saveOwnedProcesses().catch((error) => console.warn(`[hermes-native] failed to persist child ownership cleanup: ${error.message}`));
    if (run.finalized || run.terminating) return;
    void finalizeRun(run, "failed", err.message);
  };
  child.on("error", (err) => {
    if (!run.acceptancePersisted) {
      run.pendingChildError = err;
      return;
    }
    handleChildError(err);
  });
  const handleChildExit = (code, signal) => {
    clearInterval(heartbeatTimer);
    clearInterval(run.leaseWatchdogTimer);
    if (stdoutBuffer.trim()) handleRunnerLine(run, stdoutBuffer);
    ownedProcesses.delete(run.remoteRunId);
    void saveOwnedProcesses().catch((error) => console.warn(`[hermes-native] failed to persist child ownership cleanup: ${error.message}`));
    if (run.finalized || run.terminating) return;
    if (code === 0 && !run.explicitCompletion) {
      // A clean process exit is not proof that the ACP turn completed. The
      // runner must emit its authoritative complete frame; otherwise the
      // review workflow would incorrectly advance on a truncated protocol.
      void finalizeRun(run, "failed", "protocol_incomplete: runner exited without an explicit complete event");
    } else if (code === 0) {
      void finalizeRun(run, "completed");
    } else {
      void finalizeRun(run, "failed", signal ? `terminated by ${signal}` : `exit code ${code}`);
    }
  };
  child.on("exit", (code, signal) => {
    if (!run.acceptancePersisted) {
      run.pendingChildExit = [code, signal];
      return;
    }
    handleChildExit(code, signal);
  });

  let acceptedReceipt;
  run.launchOpenRequested = true;
  try {
    await launchGate.start();
  } catch (error) {
    await terminateRun(run, `worker launch outcome could not be confirmed: ${error instanceof Error ? error.message : String(error)}`, "failed");
    throw error;
  }
  if (dispatchIdempotencyKey) {
    try {
      acceptedReceipt = await recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, dispatchIdempotencyKey, run.remoteRunId, "running", {
        pid: child.pid,
        launchState: "worker_started",
      });
    } catch (error) {
      await terminateRun(run, "adapter could not persist accepted dispatch receipt", "failed");
      return writeJson(res, 500, { error: { code: "receipt_persistence_failed", message: error instanceof Error ? error.message : String(error) } });
    }
  }
  run.acceptancePersisted = true;
  reportEvent(run, "started");
  run.lifecycle = "RUNNING";
  if (run.pendingChildError) handleChildError(run.pendingChildError);
  else if (run.pendingChildExit) handleChildExit(...run.pendingChildExit);
  const acceptedStatus = acceptedReceipt?.status ?? "running";
  return writeJson(res, 202, {
    worker_token: run.workerToken,
    run_id: run.remoteRunId,
    remote_run_id: run.remoteRunId,
    accepted: true,
    status: acceptedStatus,
    ...(dispatchIdempotencyKey ? { dispatch_idempotency_key: dispatchIdempotencyKey } : {}),
    mode: body.mode || "async",
    ...(run.readOnlyExecutionReceipt ? { execution_receipt: run.readOnlyExecutionReceipt } : {}),
  });
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
    void terminateRun(run, msg.stopReason || "Hermes reported completion", "completed");
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
    if (status === "completed") {
      const payload = toolPayload(update);
      return reportStructured(run, "tool_completed", { ...payload, rawOutput: update.raw_output ?? update.rawOutput });
    }
    if (status === "failed") return reportStructured(run, "tool_failed", toolPayload(update));
    return reportStructured(run, "tool_started", toolPayload(update));
  }
  if (updateType === "plan") {
    return reportStructured(run, "plan_updated", { raw: update, text: textFromContent(update.content) });
  }
  if (updateType.includes("tool") && updateType.includes("start")) return reportStructured(run, "tool_started", toolPayload(update));
  if (updateType === "tool_call_update" || updateType.includes("tool") && (updateType.includes("complete") || updateType.includes("end"))) {
    const payload = toolPayload(update);
    return reportStructured(run, "tool_completed", { ...payload, rawOutput: update.raw_output ?? update.rawOutput });
  }
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
  const options = normalizePermissionOptions(msg.options).map((option) => run.readOnlyAudit
    ? { ...option, scope: "once" }
    : option);
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
      attempt_number: run.attemptNumber,
      workspace_lease_nonce: run.workspaceLeaseNonce,
      ...(run.readOnlyExecutionGrant ? { read_only_execution_grant: run.readOnlyExecutionGrant } : {}),
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
      payload: { error: "Adapter restarted and confirmed its detached Hermes worker stopped; its turn result is unavailable." },
    }),
  }).catch((error) => console.warn(`[hermes-native] recovered-run event delivery failed: ${error.message}`));
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
  void terminateRun(run, reason, "cancelled");
}

function terminateChild(run, reason) {
  const child = run.child;
  if (!child?.pid) return Promise.resolve(true);
  const pid = child.pid;
  console.warn(`[hermes-native] terminating process group ${pid}: ${reason}`);
  const ownership = ownedProcesses.get(run.remoteRunId) ?? {
    pid,
    processGroupId: pid,
    processStartToken: processStartToken(pid),
  };
  return terminateProcessGroup(
    ownership,
    positiveDuration(process.env.KONTROL_HERMES_TERMINATE_GRACE_MS, 5_000),
  );
}

function terminateRun(run, reason, finalStatus = "failed") {
  if (run.terminalOutcome) return Promise.resolve();
  if (run.terminationPromise) return run.terminationPromise;
  run.terminating = true;
  run.lifecycle = "TERMINATING";
  run.terminationPromise = (async () => {
    const terminated = await terminateChild(run, reason);
    if (!terminated) {
      // Terminal state is withheld while the detached child could still be
      // writing to the leased checkout. Retry the same state machine instead
      // of falsely releasing the logical run.
      console.error(`[hermes-native] could not confirm process group ${run.child?.pid ?? "unknown"} dead; terminal event withheld`);
      run.terminationPromise = null;
      setTimeout(() => {
        if (!run.terminalOutcome) void terminateRun(run, reason, finalStatus);
      }, 1_000).unref?.();
      return false;
    }
    ownedProcesses.delete(run.remoteRunId);
    try {
      await saveOwnedProcesses();
    } catch (error) {
      console.warn(`[hermes-native] failed to persist child ownership cleanup: ${error.message}`);
    }
    await finalizeRun(run, finalStatus, reason);
    return true;
  })();
  return run.terminationPromise;
}

async function saveOwnedProcesses() {
  await atomicWriteJson(OWNED_PROCESSES_PATH, [...ownedProcesses.values()]);
}

async function saveTerminalSpool() {
  await atomicWriteJson(TERMINAL_SPOOL_PATH, [...pendingTerminalSpool.values()].slice(-100));
}

async function saveEventSpool() {
  await atomicWriteJson(EVENT_SPOOL_PATH, [...pendingEventSpool.values()].slice(-EVENT_SPOOL_MAX_EVENTS));
}

function spoolTerminalEvent(runId, event) {
  pendingTerminalSpool.set(runId, { runId, payload: event, spooledAt: Date.now() });
  return saveTerminalSpool();
}

function spoolRunEvent(runId, event) {
  pendingEventSpool.set(event.event_id, { ...event, runId, spooledAt: Date.now() });
  return saveEventSpool();
}

async function deliverEvent(runId, event, run) {
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${KONTROL_ACP_URL}/runs/${runId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${AGENT_SECRET}`, ...identityHeaders(agentIdentity) },
        body: JSON.stringify(event),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        if (
          run?.workSessionId &&
          !run.readOnlyAudit &&
          (event.type === "started" || event.type === "heartbeat") &&
          !applyWorkspaceLeaseRenewal(run, body)
        ) return { acknowledged: false, leaseLost: true };
        await acknowledgeTerminalDispatchReceipt(event, body);
        return { acknowledged: true, leaseLost: false };
      }
      if (response.status === 409 && body?.error?.code === "workspace_lease_lost") {
        return { acknowledged: false, leaseLost: true };
      }
    } catch { /* retry transient delivery failures until the local deadline */ }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  return { acknowledged: false, leaseLost: false };
}

async function acknowledgeTerminalDispatchReceipt(event, responseBody) {
  if (!responseBody?.dispatch_receipt_acknowledged
    || !["completed", "failed", "cancelled", "exited"].includes(event?.type)
    || typeof event?.remote_run_id !== "string"
    || typeof event?.attempt_number !== "number"
    || typeof event?.event_id !== "string"
    || typeof responseBody.dispatch_idempotency_key !== "string"
    || responseBody.remote_run_id !== event.remote_run_id
    || responseBody.attempt_number !== event.attempt_number
    || typeof responseBody.event_id !== "string"
    || responseBody.event_id !== event.event_id) return false;
  return acknowledgeAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, {
    dispatchIdempotencyKey: responseBody.dispatch_idempotency_key,
    remoteRunId: event.remote_run_id,
    attemptNumber: event.attempt_number,
    eventId: event.event_id,
  });
}

function scheduleLeaseLossTermination(run) {
  if (run.leaseLossHandled || run.finalized || run.terminating) return;
  run.leaseLossHandled = true;
  // Let the ordered delivery settle before finalizeRun waits on the same queue.
  setTimeout(() => {
    if (!run.finalized && !run.terminating) {
      void terminateRun(run, "Kontrol rejected or stopped acknowledging the workspace lease", "failed");
    }
  }, 0).unref?.();
}

async function flushEventSpools() {
  const entries = [...pendingEventSpool.values()].sort((a, b) => a.event_sequence - b.event_sequence);
  for (const entry of entries) {
    const delivery = await deliverEvent(entry.runId, entry);
    if (delivery.acknowledged || delivery.leaseLost) {
      pendingEventSpool.delete(entry.event_id);
      await saveEventSpool();
      if (delivery.leaseLost) {
        const activeRun = [...active.values()].find((run) => run.devRunId === entry.runId);
        if (activeRun) scheduleLeaseLossTermination(activeRun);
      }
    }
  }
  for (const [runId, entry] of [...pendingTerminalSpool]) {
    if ([...pendingEventSpool.values()].some((event) => event.runId === runId)) continue;
    const delivery = await deliverEvent(runId, entry.payload);
    if (delivery.acknowledged || delivery.leaseLost) {
      pendingTerminalSpool.delete(runId);
      await saveTerminalSpool();
      if (delivery.leaseLost) {
        const activeRun = [...active.values()].find((run) => run.devRunId === runId);
        if (activeRun) scheduleLeaseLossTermination(activeRun);
      }
    }
  }
}

setInterval(() => void flushEventSpools(), 10_000).unref?.();

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
  const event = {
    event_id: `${run.remoteRunId}:${++run.eventSequence}`,
    event_sequence: run.eventSequence,
    type,
    remote_run_id: run.remoteRunId,
    work_session_id: run.workSessionId,
    attempt_number: run.attemptNumber,
    workspace_lease_nonce: run.workspaceLeaseNonce,
    ...(run.readOnlyExecutionGrant ? { read_only_execution_grant: run.readOnlyExecutionGrant } : {}),
    payload,
  };
  // Terminal state is written before network delivery. This makes a short
  // Kontrol restart recoverable even if the adapter process also goes down.
  const durableTerminal = terminal
    ? spoolTerminalEvent(run.devRunId, event)
    : spoolRunEvent(run.devRunId, event);
  const delivery = run.sendChain
    .catch((error) => recordDeliveryError(run, error))
    .then(async () => {
      await durableTerminal;
      const deliveryResult = await deliverEvent(run.devRunId, event, run);
      if (deliveryResult.leaseLost) {
        pendingEventSpool.delete(event.event_id);
        if (terminal) pendingTerminalSpool.delete(run.devRunId);
        await saveEventSpool();
        await saveTerminalSpool();
        scheduleLeaseLossTermination(run);
        console.error(`[hermes-native] Kontrol rejected the workspace lease for ${run.remoteRunId}`);
        return false;
      }
      if (!deliveryResult.acknowledged) throw new Error(`event delivery failed: ${type}`);
      if (!terminal) {
        pendingEventSpool.delete(event.event_id);
        await saveEventSpool();
      } else {
        pendingTerminalSpool.delete(run.devRunId);
        await saveTerminalSpool();
      }
      return true;
    })
    .catch((error) => {
      recordDeliveryError(run, error);
      return false;
    });
  run.sendChain = delivery;
  return run.sendChain;
}

export function createAdapterEvent(run, type, payload) {
  return {
    event_id: `${run.remoteRunId}:${++run.eventSequence}`,
    event_sequence: run.eventSequence,
    type,
    remote_run_id: run.remoteRunId,
    work_session_id: run.workSessionId,
    attempt_number: run.attemptNumber,
    workspace_lease_nonce: run.workspaceLeaseNonce,
    ...(run.readOnlyExecutionGrant ? { read_only_execution_grant: run.readOnlyExecutionGrant } : {}),
    payload,
  };
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

async function finalizeRun(run, status, stopReason) {
  if (run.terminalOutcome) return run.terminalOutcome;
  const outcome = { status, stopReason };
  run.terminalOutcome = outcome;
  run.lifecycle = "FINALIZING";
  run.finalized = true;
  clearInterval(run.deadmanTimer);
  clearInterval(run.leaseWatchdogTimer);
  if (run.dispatchIdempotencyKey) {
    await recordAdapterDispatchReceipt(DISPATCH_RECEIPTS_PATH, dispatchReceipts, run.dispatchIdempotencyKey, run.remoteRunId, status, {
      lastError: status === "completed" ? undefined : stopReason,
    }).catch((error) => console.warn(`[hermes-native] terminal receipt persistence failed: ${error.message}`));
  }
  // P1 #12: Flush coalesced telemetry BEFORE terminal event
  flushAllCoalesced(run);
  // Wait for every queued telemetry frame, including the coalesced buffers
  // flushed above, before emitting the terminal frame. The terminal event is
  // the durable boundary consumed by Kontrol; it must be last.
  await run.sendChain;
  await reportEvent(run, status, stopReason, { allowFinalizing: true });
  active.delete(run.remoteRunId);
  removeHermesReadOnlyRuntime(run);
  run.lifecycle = "TERMINAL";
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

function copyHermesRuntimeTree(source, destination) {
  const excludedDirectories = new Set([
    "__pycache__", ".git", ".crush", "tests", "test", "node_modules", "venv",
    "web", "ui-tui", "evals", "logs", "sessions", "state", "memory",
  ]);
  const excludedFile = /^(?:\.env(?:\..*)?|\.envrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|auth\.json|token\.json|id_(?:rsa|ed25519)|.*\.(?:pem|key|sqlite|db|log))$/i;
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(source)) {
    if (name.startsWith(".")) continue;
    const from = join(source, name);
    const to = join(destination, name);
    let info;
    try { info = lstatSync(from); } catch { continue; }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      if (excludedDirectories.has(name)) continue;
      copyHermesRuntimeTree(from, to);
    } else if (info.isFile() && !excludedFile.test(name)) {
      copyFileSync(from, to);
    }
  }
}

function prepareHermesReadOnlyRuntime() {
  const root = mkdtempSync(join(tmpdir(), `kontrol-hermes-runtime-${randomUUID()}-`));
  try {
    for (const name of HERMES_READ_ONLY_ROOT_MODULES) {
      const source = join(HERMES_AGENT_ROOT, name);
      if (!existsSync(source)) continue;
      const info = lstatSync(source);
      if (info.isFile() && !info.isSymbolicLink()) copyFileSync(source, join(root, name));
    }
    for (const name of HERMES_READ_ONLY_PACKAGES) {
      const source = join(HERMES_AGENT_ROOT, name);
      if (!existsSync(source)) continue;
      const info = lstatSync(source);
      if (info.isDirectory() && !info.isSymbolicLink()) copyHermesRuntimeTree(source, join(root, name));
    }
    if (!existsSync(join(root, "acp_adapter")) || !existsSync(join(root, "agent"))) {
      throw new Error("Hermes read-only runtime projection is missing required ACP or agent modules.");
    }
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function removeHermesReadOnlyRuntime(run) {
  if (!run.readOnlyRuntimeProjection) return;
  rmSync(run.readOnlyRuntimeProjection, { recursive: true, force: true });
  run.readOnlyRuntimeProjection = undefined;
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
    const result = spawnSync(candidate, ["-c", "import acp; from acp.core import connect_to_agent; from acp.schema import ClientCapabilities, FileSystemCapabilities, Implementation, TextContentBlock; import acp_adapter.entry; import acp_adapter.server"], {
      encoding: "utf8",
      // P1.10: explicit allowlist (see the --check spawn above).
      env: buildToolEnvironment(process.env, {
        overrides: {
          HERMES_AGENT_ROOT,
          PYTHONPATH: withHermesPythonPath(process.env.PYTHONPATH),
        },
      }),
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
