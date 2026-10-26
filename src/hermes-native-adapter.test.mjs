import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hermesAcpCandidates, selectHermesAcpEntry } from "../scripts/lib/hermes-acp-entry.mjs";
import { classifyHermesStopReason } from "../scripts/lib/hermes-stop-reason.mjs";

const adapter = readFileSync("scripts/acp-hermes-native-adapter.mjs", "utf8");
const runner = readFileSync("scripts/hermes-native-runner.py", "utf8");

assert.match(adapter, /resolveHermesPython/);
assert.doesNotMatch(adapter, /acp_adapter\.client/);
assert.match(adapter, /from acp\.core import connect_to_agent/);
assert.match(adapter, /HERMES_ACP_BIN/);
assert.match(adapter, /HERMES_ACP_COMPAT_PATH/);
assert.match(adapter, /join\(dirname\(RUNNER\), "lib", "mcp_http_session\.py"\)/,
  "the confined Hermes runtime projects the bounded-write MCP session helper beside its runner");
assert.match(adapter, /hermes-acp-compat/);
assert.match(adapter, /HERMES_AGENT_ROOT\}\/\.venv\/bin\/python/);
assert.match(adapter, /HERMES_AGENT_ROOT\}\/venv\/bin\/python/);
assert.match(adapter, /"http-approval-bridge"/);
assert.doesNotMatch(adapter, /"permissions"/);
assert.match(adapter, /raw_update/);
assert.match(adapter, /permission_request/);
assert.match(adapter, /permission_response/);
assert.match(adapter, /waitForApprovalResolution/);
assert.match(adapter, /provide_policy_approval|approval_id|resolution/);
assert.match(adapter, /tool_started/);
assert.match(adapter, /tool_completed/);
assert.match(adapter, /plan_updated/);
assert.match(adapter, /stdoutBuffer/);
assert.match(adapter, /setInterval\(\(\) => reportEvent\(run, "heartbeat"\)/);
assert.match(adapter, /duplicate_session/);
assert.match(adapter, /explicitCompletion/);
assert.match(adapter, /classifyHermesStopReason\(msg\.stopReason\)/);
assert.match(adapter, /protocol_incomplete/);
assert.match(adapter, /runner exited without an explicit complete event/);
assert.match(adapter, /lifecycle: "STARTING"/);
assert.match(adapter, /run\.lifecycle = "FINALIZING"/);
assert.match(adapter, /flushAllCoalesced\(run\)/);
assert.match(adapter, /terminateRun\(run, reason, "cancelled"\)/);
assert.match(adapter, /reconcileOwnedProcesses/);
assert.match(adapter, /terminal-spool/);
assert.match(adapter, /KONTROL_HERMES_DEADMAN_IDLE_MS/);
assert.match(adapter, /KONTROL_HERMES_MAX_RUN_SECONDS/);
assert.match(adapter, /provider-sessions\.json/);
assert.match(adapter, /body\.continuation_id && !existingProviderBinding/,
  "Hermes continuations fail before launch when no provider session was persisted");
assert.match(adapter, /continuation_session_binding_conflict/,
  "Hermes provider sessions are fenced to their original work session, agent, workspace, and provider generation");
assert.match(adapter, /persistHermesProviderSession/);
assert.match(adapter, /activeChildOperations/);
assert.match(adapter, /absoluteDeadlineAt/);
assert.match(adapter, /workspaceLeaseNonce: body\.workspace_lease_nonce/);
assert.match(adapter, /terminateProcessGroup/);
assert.match(adapter, /could not confirm process group .* dead/);
assert.match(adapter, /KONTROL_WORKSPACE_LEASE_NONCE/);
assert.match(adapter, /prepareOwnedChild\(hermesLaunch\.command/);
assert.ok(adapter.indexOf('launchState: "start_requested"') < adapter.indexOf("await launchGate.start()"),
  "Hermes start intent is durable before opening the worker launch gate");
assert.ok(adapter.indexOf("await launchGate.start()") < adapter.indexOf('run.remoteRunId, "running"'),
  "Hermes acceptance is persisted only after the agent child has spawned");
assert.match(adapter, /validateReadOnlyDispatchRequest\(body, workspaceRoot, ADAPTER_SECRET, agentIdentity\?\.agentId\)/,
  "Hermes verifies the server-signed read-only grant before preparing a child");
assert.match(adapter, /const hermesRuntimeBindFiles = \[\s*\{ source: hermesExecutable, target: hermesSandboxCommand \},\s*hermesPythonBindFile,\s*\]/,
  "Hermes exposes only its selected CLI and sibling Python executables rather than the containing credential-capable directory");
assert.match(adapter, /run\.readOnlyBindFiles = hermesRuntimeBindFiles/);
assert.match(adapter, /executionReceipt: run\.readOnlyExecutionReceipt/,
  "Hermes persists the correlated read-only receipt with its durable dispatch record");
assert.match(adapter, /!run\.readOnlyAudit && !run\.boundedFileWrite && \(!run\.workspaceLeaseNonce/,
  "read-only Hermes dispatch does not require a mutation lease");

assert.match(runner, /from acp\.core import connect_to_agent/);
assert.match(runner, /asyncio\.create_subprocess_exec/);
assert.match(runner, /session_update\(self, session_id: str, update/);
assert.match(runner, /FileSystemCapabilities\(write_text_file=True\)/);
assert.match(runner, /KontrolACPClient/);
assert.match(runner, /request_permission/);
assert.match(runner, /permission_request/);
assert.match(runner, /permission_response/);
assert.match(runner, /RequestPermissionResponse/);
assert.match(runner, /connection\.load_session\(cwd=spec\.get\("cwd"\) or os\.getcwd\(\), session_id=provider_session_id, mcp_servers=\[\]\)/,
  "Hermes continuations load the exact persisted provider session");
assert.match(runner, /continuation_session_unsupported/);
assert.match(runner, /continuation_session_missing/);
assert.match(runner, /session_binding_ack/);
assert.ok(runner.indexOf('"type": "session_binding"') < runner.indexOf("connection.prompt("),
  "initial Hermes sessions are durably acknowledged by Kontrol before the first prompt executes");
assert.match(runner, /"raw_update"/);
assert.match(runner, /"raw_request"/);
assert.match(runner, /public ACP Python SDK/);
assert.doesNotMatch(runner, /hermes_idle_completion_fallback/);
assert.doesNotMatch(runner, /stop_reason="idle_end_turn"/);
assert.match(runner, /max_run_seconds/);
assert.match(runner, /absolute run ceiling/);
assert.match(adapter, /function enqueueRunEvent\(run, type, payload/);
assert.match(adapter, /adapterStatePath\("hermes", "terminal-spool\.json"\)/);
assert.match(adapter, /deliveryErrors/);
assert.match(adapter, /terminalOutcome/);
assert.match(adapter, /flushCoalesced\(run, type, true\)/);
assert.doesNotMatch(adapter, /stdoutBuffer \+= chunk;\s*stdoutBuffer \+= chunk;/);
assert.match(adapter, /run\.stderrTail = truncateUtf8Tail\(`\$\{run\.stderrTail\}\$\{text\}`,\s*FAILURE_DIAGNOSTIC_BYTES\)/,
  "Hermes retains a bounded stderr tail for terminal failure receipts");
assert.match(adapter, /run\.childExit = \{ code, signal \}/,
  "Hermes records child exit metadata even when termination is already in progress");
assert.match(adapter, /exit_code: exitCode/);
assert.match(adapter, /stderr: truncateUtf8Tail\(stderr, FAILURE_DIAGNOSTIC_BYTES\)/,
  "Hermes sends bounded diagnostics with the terminal failure event");
assert.match(adapter, /const hermesSandboxPython = join\(dirname\(hermesSandboxCommand\), "python"\)/,
  "Hermes console-script launchers receive their sibling Python interpreter inside Bubblewrap");
assert.match(adapter, /source: pythonExecutable, target: hermesSandboxPython/);
assert.match(adapter, /Hermes ACP launcher sandbox preflight failed/,
  "the exact confined ACP launcher is checked before an accepted worker dispatch");
assert.match(adapter, /hermesPythonRuntimeRootFor\(pythonExecutable\)/,
  "the confined Hermes runtime resolves the runtime root of the selected interpreter");
assert.match(adapter, /PYTHONHOME: hermesPythonRuntimeRoot/,
  "a relocated Hermes interpreter finds its standard library through PYTHONHOME inside Bubblewrap");

// A probe failure message reaches the 503 body and therefore a
// scheduled-job receipt. Neither probe may put child stderr, a spawn error
// message, or a path into that message.
assert.doesNotMatch(adapter, /runtimeProbeResult\.stderr\?\.trim\(\)/,
  "the runtime probe stderr never becomes the error detail");
assert.doesNotMatch(adapter, /launcherProbeResult\.error\?\.message/,
  "the launcher probe spawn error never becomes the error detail");
assert.match(adapter, /probeFailureCategory\(runtimeProbeResult\)/,
  "the runtime probe failure reports a stable category");
assert.match(adapter, /probeFailureCategory\(launcherProbeResult\)/,
  "the launcher probe failure reports a stable category");
const runtimeProbeThrow = adapter.split("\n").find((line) => line.includes("Hermes read-only runtime probe failed:"));
assert.ok(runtimeProbeThrow !== undefined, "the runtime probe failure throws a typed error");
assert.ok(runtimeProbeThrow.includes("${category}"), "the runtime probe error message carries the category");
assert.ok(!runtimeProbeThrow.includes("stderr"), "the runtime probe error message carries no stderr");
assert.ok(!runtimeProbeThrow.includes("detail"), "the runtime probe error message carries no raw detail");
const launcherProbeThrow = adapter.split("\n").find((line) => line.includes("Hermes ACP launcher sandbox preflight failed:"));
assert.ok(launcherProbeThrow !== undefined, "the launcher probe failure throws a typed error");
assert.ok(launcherProbeThrow.includes("${category}"), "the launcher probe error message carries the category");
assert.ok(!launcherProbeThrow.includes("stderr"), "the launcher probe error message carries no stderr");
assert.match(adapter, /import \{ hermesPythonRuntimeRootFor, isSystemHermesPath \} from "\.\/lib\/hermes-python-runtime\.mjs"/,
  "the runtime-root resolution is the shared, behaviorally tested module");

const currentCandidates = hermesAcpCandidates({
  hermesBin: "hermes",
  hermesBinPath: "/opt/hermes/bin/hermes",
});
assert.deepEqual(currentCandidates.slice(0, 2).map(({ command, args }) => ({ command, args })), [
  { command: "/opt/hermes/bin/hermes-acp", args: [] },
  { command: "hermes-acp", args: [] },
], "the upstream standalone ACP entry is preferred to the compatibility subcommand");
assert.deepEqual(currentCandidates.at(-1), {
  command: "hermes",
  args: ["acp"],
  mode: "subcommand",
  source: "legacy subcommand",
});

const explicitCandidates = hermesAcpCandidates({ hermesAcpBin: "/custom/hermes-acp", hermesBin: "hermes" });
assert.deepEqual(explicitCandidates, [{
  command: "/custom/hermes-acp",
  args: [],
  mode: "standalone",
  source: "HERMES_ACP_BIN",
}], "an explicit ACP executable is authoritative");

const selected = selectHermesAcpEntry(currentCandidates, (entry) => ({
  status: entry.mode === "standalone" && entry.command === "hermes-acp" ? 0 : 2,
}));
assert.equal(selected.entry?.command, "hermes-acp", "entry selection continues through missing sibling executables");
assert.equal(selected.attempts.length, 2);
const legacy = selectHermesAcpEntry(currentCandidates, (entry) => ({ status: entry.mode === "subcommand" ? 0 : 127 }));
assert.deepEqual(legacy.entry?.args, ["acp"], "older Hermes installs remain supported when the standalone command is absent");
const explicitLegacy = hermesAcpCandidates({
  hermesBin: "/fixture/hermes-test-double",
  hermesBinPath: "/fixture/hermes-test-double",
  hermesBinExplicit: true,
});
assert.deepEqual(explicitLegacy.slice(0, 2).map(({ command, args }) => ({ command, args })), [
  { command: "/fixture/hermes-acp", args: [] },
  { command: "/fixture/hermes-test-double", args: ["acp"] },
], "an explicit HERMES_BIN does not get shadowed by an unrelated hermes-acp on PATH");

assert.deepEqual(classifyHermesStopReason("end_turn"), { status: "completed", message: undefined });
assert.equal(classifyHermesStopReason("cancelled").status, "cancelled");
for (const reason of ["error", "refusal", "max_tokens", "max_turn_requests", "unknown_future_reason", undefined]) {
  assert.equal(classifyHermesStopReason(reason).status, "failed", `${reason} cannot advance a work session as successful`);
}

console.log("hermes-native-adapter.test.mjs: all assertions passed");
