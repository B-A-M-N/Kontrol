import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const adapter = readFileSync("scripts/acp-stdio-duplex-adapter.mjs", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

assert.match(adapter, /dist\/acp-duplex\.js/);
assert.match(adapter, /createAcpDuplex/);
assert.match(adapter, /session\/request_permission|requestPermission/);
assert.match(adapter, /permission\.requested/);
assert.match(adapter, /approvals\/\$\{approvalId\}\/decision/);
assert.match(adapter, /ACP_STDIO_COMMAND/);
assert.match(adapter, /ACP_STDIO_DISPATCH_METHOD/);
assert.match(adapter, /run\.conn\.request\("initialize"/);
assert.match(adapter, /run\.conn\.request\("session\/new"/);
assert.match(adapter, /prompt: \[\{ type: "text", text: run\.task \}\]/);
assert.match(adapter, /validateReadOnlyDispatchRequest/);
assert.match(adapter, /probeReadOnlyExecutionSandbox/);
assert.match(adapter, /read_only_execution_grant/);
assert.match(adapter, /recordAdapterDispatchReceipt\([^\n]+, "dispatching"/);
assert.match(adapter, /prepareOwnedChild\(agentLaunch\.command/);
assert.ok(adapter.indexOf('"dispatching", {') < adapter.indexOf("prepareOwnedChild(agentLaunch.command"), "dispatch admission is durable before creating a gated owner process");
assert.ok(adapter.indexOf('launchState: "start_requested"') < adapter.indexOf("await launchGate.start()"), "start intent is durable before the worker launch gate opens");
assert.match(adapter, /validateReadOnlyDispatchRequest\(body, workspaceRoot, ADAPTER_SECRET\)/,
  "the generic ACP adapter verifies signed read-only execution authority before child launch");
assert.match(adapter, /executionReceipt: run\.readOnlyExecutionReceipt/,
  "the generic adapter persists the correlated execution receipt for recovery");
assert.ok(adapter.indexOf("await launchGate.start()") < adapter.indexOf('run.remoteRunId, "running"'), "acceptance is persisted after the worker process starts");
assert.match(adapter, /duplex-json-rpc/);
assert.match(adapter, /reverse-permissions/);
assert.ok(adapter.includes("url.match(/^\\/runs\\/([^/]+)\\/cancel$/)"));
assert.match(adapter, /process\.kill\(-run\.child\.pid, "SIGTERM"\)/);

assert.ok(
  pkg.files.includes("scripts/acp-stdio-duplex-adapter.mjs"),
  "stdio duplex adapter is included in the published package",
);
assert.match(pkg.scripts["test:adapters"], /acp-stdio-duplex-adapter\.mjs/);
assert.match(pkg.scripts["test:adapters"], /acp-stdio-duplex-adapter\.test\.mjs/);

console.log("acp-stdio-duplex-adapter.test.mjs: all assertions passed");
