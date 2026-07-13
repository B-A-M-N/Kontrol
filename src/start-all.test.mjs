import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const script = readFileSync("start-all.sh", "utf8");

assert.match(script, /CRUSH_CLI_BIN="\$\{CRUSH_BIN:-\/home\/bamn\/Crush-ACP\/crush\}"/);
assert.match(script, /\$CRUSH_CLI_BIN" run --help/);
assert.match(script, /Run a single prompt in non-interactive mode/);
assert.match(script, /Do not use crush-acp; it is the ACP\/TUI transport binary\./);
assert.match(script, /node --check scripts\/acp-hermes-native-adapter\.mjs/);
assert.match(script, /python3 -m py_compile scripts\/hermes-native-runner\.py/);
assert.match(script, /kontrol-adapter-crush/);
assert.match(script, /kontrol-adapter-hermes/);
assert.match(script, /HERMES_ACP_ADAPTER_PORT:-9911/);
assert.match(script, /HERMES_ACP_COMPAT_PATH="\$DESKTOP_PWD\/scripts\/hermes-acp-compat"/);
assert.match(script, /PYTHONPATH="\$HERMES_ACP_COMPAT_PATH:\$\{PYTHONPATH:-\}" "\$\{HERMES_BIN:-hermes\}" acp --check/);
assert.match(script, /node scripts\/acp-hermes-native-adapter\.mjs/);
assert.match(script, /local kontrol_secret="\$\{KONTROL_ACP_SHARED_SECRET:-\$\{KONTROL_ACP_AGENT_SECRET:-\$\{KONTROL_ACP_REVIEWER_SECRET:-\}\}\}"/);
assert.match(script, /Authorization: Bearer \$\{kontrol_secret\}/);
assert.ok(script.includes('grep -q "\\"name\\":\\"${agent}\\""'));
assert.match(script, /ERROR: \$\{agent\} was not confirmed registered \(last_status=\$\{last_status\}\)\./);
assert.match(script, /last_body=\$\{last_body\}/);
assert.ok(script.includes('R=""'));
assert.ok(script.includes("awk '/^readiness\\{.*\\} / { print $NF; exit }' || true"));
assert.doesNotMatch(script, /grep -rFzaq -- "\$secret"/);
assert.match(script, /cmdline="\$\(tr '\\0' ' ' < "\$f" 2>\/dev\/null \|\| true\)"/);

console.log("start-all.test.mjs: all assertions passed");
