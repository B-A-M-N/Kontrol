import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const adapter = readFileSync("scripts/acp-hermes-native-adapter.mjs", "utf8");
const runner = readFileSync("scripts/hermes-native-runner.py", "utf8");

assert.match(adapter, /resolveHermesPython/);
assert.match(adapter, /import acp; import acp_adapter\.client/);
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

assert.match(runner, /add_observer\(on_raw_event\)/);
assert.match(runner, /DevSpaceACPClient/);
assert.match(runner, /request_permission/);
assert.match(runner, /permission_request/);
assert.match(runner, /permission_response/);
assert.match(runner, /RequestPermissionResponse/);
assert.match(runner, /"raw_update"/);
assert.match(runner, /"raw_request"/);
assert.match(runner, /connects? to ``hermes acp``|hermes acp/);

console.log("hermes-native-adapter.test.mjs: all assertions passed");
