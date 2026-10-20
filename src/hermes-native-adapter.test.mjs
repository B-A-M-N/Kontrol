import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hermesAcpCandidates, selectHermesAcpEntry } from "../scripts/lib/hermes-acp-entry.mjs";

const adapter = readFileSync("scripts/acp-hermes-native-adapter.mjs", "utf8");
const runner = readFileSync("scripts/hermes-native-runner.py", "utf8");

assert.match(adapter, /resolveHermesPython/);
assert.doesNotMatch(adapter, /acp_adapter\.client/);
assert.match(adapter, /from acp\.core import connect_to_agent/);
assert.match(adapter, /HERMES_ACP_BIN/);
assert.match(adapter, /HERMES_ACP_COMPAT_PATH/);
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
assert.match(adapter, /bindFiles: \[\s*\{ source: hermesExecutable, target: hermesSandboxCommand \}/,
  "Hermes exposes only its selected CLI executable rather than the containing credential-capable directory");
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

console.log("hermes-native-adapter.test.mjs: all assertions passed");
