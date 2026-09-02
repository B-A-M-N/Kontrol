import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const script = readFileSync("start-all.sh", "utf8");

assert.match(script, /CRUSH_CLI_BIN="\$\{CRUSH_BIN:-\$\{HOME\}\/Crush-ACP\/crush\}"/);
assert.match(script, /\$CRUSH_CLI_BIN" run --help/);
assert.match(script, /Run a single prompt in non-interactive mode/);
assert.match(script, /Do not use crush-acp; it is the ACP\/TUI transport binary\./);
assert.match(script, /node --check scripts\/acp-hermes-native-adapter\.mjs/);
assert.match(script, /node --check scripts\/kontrol-supervisor\.mjs/);
assert.match(script, /node --check scripts\/probe-kontrol-readiness\.mjs/);
assert.match(script, /python3 -m py_compile scripts\/hermes-native-runner\.py/);
assert.match(script, /KONTROL_SKIP_PREFLIGHT_TESTS:-false/);
assert.match(script, /STARTUP_PROFILE" == "release"[\s\S]*export KONTROL_RELEASE_MODE=true/);
assert.match(script, /else STARTUP_PROFILE="dev-fast"; fi/);
assert.match(script, /PREFLIGHT_LOG=/);
assert.match(script, /npm --silent test 2>&1 \| tee "\$PREFLIGHT_LOG"/);
const smokeCurlStart = script.indexOf("response=\$(curl");
const smokeCurlEnd = script.indexOf('if echo "\$response"', smokeCurlStart);
const smokeCurl = script.slice(smokeCurlStart, smokeCurlEnd);
const smokeContinuation = 'KONTROL_ACP_ADAPTER_SECRET:-}" ' + "\\" + "\n      --data \"\$body\"";
const doubleSmokeContinuation = 'KONTROL_ACP_ADAPTER_SECRET:-}" ' + "\\\\" + "\n";
assert.ok(smokeCurl.includes(smokeContinuation), "CRUSH smoke body must remain attached to curl");
assert.ok(!smokeCurl.includes(doubleSmokeContinuation), "CRUSH smoke curl must not contain a double line-continuation");
assert.match(script, /core-readyz/);
assert.match(script, /KONTROL_ACP_AGENTS/);
assert.match(script, /kontrol-supervisor/);
assert.match(script, /scripts\/kontrol-tunnel\.sh/);
const tunnelScript = readFileSync("scripts/kontrol-tunnel.sh", "utf8");
assert.match(tunnelScript, /KONTROL_TUNNEL_PROFILE/);
assert.match(tunnelScript, /KONTROL_TUNNEL_ID/);
assert.match(tunnelScript, /"--harpoon\.hosts-include-loopback=\$\{KONTROL_HARPOON_INCLUDE_LOOPBACK:-false\}"/);
assert.match(tunnelScript, /health\.listen-addr 127\.0\.0\.1:0/);
assert.match(tunnelScript, /mcp\.extra-headers/);
assert.match(tunnelScript, /ENV_FILE="\$\{KONTROL_ENV_FILE:-\$DESKTOP_PWD\/\.env\}"/);
assert.match(tunnelScript, /source "\$ENV_FILE"/);
assert.match(script, /kontrol-tunnel\.sh" --doctor/);
const effectiveTunnelArgs = execFileSync("bash", ["scripts/kontrol-tunnel.sh", "--print-effective-args"], {
  encoding: "utf8",
  env: { ...process.env, KONTROL_HARPOON_INCLUDE_LOOPBACK: "false" },
}).trim().split(/\r?\n/);
assert.ok(effectiveTunnelArgs.includes("--harpoon.hosts-include-loopback=false"));
assert.ok(!effectiveTunnelArgs.includes("--harpoon.hosts-include-loopback"));
assert.match(script, /-c "\$DESKTOP_PWD"/);
assert.match(script, /KONTROL_SERVER_LOG/);
assert.match(script, /EFFECTIVE_STATE_DIR=.*loadConfig\(\)\.stateDir/);
assert.match(script, /export KONTROL_STATE_DIR="\$EFFECTIVE_STATE_DIR"/);
assert.ok(
  script.indexOf('export KONTROL_STATE_DIR="$EFFECTIVE_STATE_DIR"') <
    script.indexOf('DATABASE_MIGRATION_RECORD_PATH="$KONTROL_STATE_DIR/'),
  "migration journal path must be derived only after the resolved state directory is exported",
);
assert.match(script, /KONTROL_ENV_FILE/);
assert.match(script, /server exited before readiness/);
assert.match(script, /Kontrol server log:/);
assert.match(script, /kontrol-adapter-crush/);
assert.match(script, /kontrol-adapter-hermes/);
assert.match(script, /kontrol-adapter-hermes\.log/);
assert.match(script, /Recent adapter log/);
assert.match(script, /HERMES_ACP_ADAPTER_PORT:-9911/);
assert.match(script, /HERMES_ACP_COMPAT_PATH="\$DESKTOP_PWD\/scripts\/hermes-acp-compat"/);
assert.match(script, /PYTHONPATH="\$HERMES_ACP_COMPAT_PATH:\$\{PYTHONPATH:-\}" "\$\{HERMES_BIN:-hermes\}" acp --check/);
assert.match(script, /node scripts\/acp-hermes-native-adapter\.mjs/);
assert.match(script, /probe-kontrol-readiness\.mjs/);
assert.match(script, /EFFECTIVE_BASH_POLICY=.*KONTROL_POLICY_TOOL_BASH:-.*KONTROL_POLICY_MODE:-ask/);
assert.match(script, /EFFECTIVE_BASH_POLICY,,.*allow/);
assert.match(script, /readyz/);
assert.match(script, /rollback/);
assert.match(script, /send-keys.*C-c/);
assert.match(script, /cli-coding-agent/);
assert.ok(script.includes('R="000"'));
assert.match(script, /127\.0\.0\.1:8080\/readyz/);
assert.match(script, /tunnel MCP readiness failed/);
const serviceScript = readFileSync("scripts/kontrol-user-service.sh", "utf8");
assert.match(serviceScript, /Type=simple/);
assert.match(serviceScript, /WorkingDirectory="\$\{ROOT_DIR\}"/);
assert.match(serviceScript, /candidate_result=.*KONTROL_BUILD_RESULT_PATH/);
assert.match(serviceScript, /SELECTED_ARTIFACT_PATH=\"\$\(readlink -f -- \"\$\{ROOT_DIR\}\/dist\"/);
assert.match(serviceScript, /\"\$\{ROOT_DIR\}\/releases\/\"\*/);
assert.match(serviceScript, /ExecStart=\/usr\/bin\/env node "\$\{SELECTED_ARTIFACT_PATH\}\/cli\.js" serve/);
assert.match(serviceScript, /upgrade\)/);
assert.match(serviceScript, /previously installed unit/);
assert.doesNotMatch(serviceScript, /ExecStart=.*start-all\.sh/);
assert.doesNotMatch(script, /mcp\.extra-headers.*Authorization/);
assert.doesNotMatch(script, /mcp\.discovery-extra-headers.*Authorization/);
assert.match(script, /node scripts\/probe-workspace-app\.mjs --url/);
const readinessProbe = readFileSync("scripts/probe-kontrol-readiness.mjs", "utf8");
assert.match(readinessProbe, /jsonOrText/);
assert.match(readinessProbe, /args\.includes\("--probe-bash"\)/);
assert.match(readinessProbe, /if \(probeBash\)/);
assert.match(readFileSync("restart-kontrol.sh", "utf8"), /node|start-all/);

console.log("start-all.test.mjs: all assertions passed");
