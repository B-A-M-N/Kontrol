import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const script = readFileSync("start-all.sh", "utf8");

assert.match(script, /CRUSH_CLI_BIN="\$\{CRUSH_BIN:-\$\{HOME\}\/Crush-ACP\/crush\}"/);
assert.match(script, /\$CRUSH_CLI_BIN" run --help/);
assert.match(script, /Run a single prompt in non-interactive mode/);
assert.match(script, /Do not use crush-acp; it is the ACP\/TUI transport binary\./);
assert.match(script, /node --check scripts\/acp-hermes-native-adapter\.mjs/);
assert.match(script, /node --check scripts\/probe-kontrol-readiness\.mjs/);
assert.match(script, /python3 -m py_compile scripts\/hermes-native-runner\.py/);
assert.match(script, /KONTROL_SKIP_PREFLIGHT_TESTS:-false/);
assert.match(script, /STARTUP_PROFILE" == "release"[\s\S]*export KONTROL_RELEASE_MODE=true/);
assert.match(script, /PREFLIGHT_LOG=/);
assert.match(script, /npm --silent test 2>&1 \| tee "\$PREFLIGHT_LOG"/);
assert.match(script, /core-readyz/);
assert.match(script, /KONTROL_ACP_AGENTS/);
assert.match(script, /kontrol-supervisor/);
assert.match(script, /scripts\/kontrol-tunnel\.sh/);
assert.match(readFileSync("scripts/kontrol-tunnel.sh", "utf8"), /KONTROL_TUNNEL_PROFILE/);
assert.match(readFileSync("scripts/kontrol-tunnel.sh", "utf8"), /KONTROL_TUNNEL_ID/);
assert.match(readFileSync("scripts/kontrol-tunnel.sh", "utf8"), /"--harpoon\.hosts-include-loopback=\$\{KONTROL_HARPOON_INCLUDE_LOOPBACK:-false\}"/);
assert.match(readFileSync("scripts/kontrol-tunnel.sh", "utf8"), /health\.listen-addr 127\.0\.0\.1:0/);
assert.match(script, /kontrol-tunnel\.sh" --doctor/);
const effectiveTunnelArgs = execFileSync("bash", ["scripts/kontrol-tunnel.sh", "--print-effective-args"], {
  encoding: "utf8",
  env: { ...process.env, KONTROL_HARPOON_INCLUDE_LOOPBACK: "false" },
}).trim().split(/\r?\n/);
assert.ok(effectiveTunnelArgs.includes("--harpoon.hosts-include-loopback=false"));
assert.ok(!effectiveTunnelArgs.includes("--harpoon.hosts-include-loopback"));
assert.match(script, /-c "\$DESKTOP_PWD"/);
assert.match(script, /kontrol-adapter-crush/);
assert.match(script, /kontrol-adapter-hermes/);
assert.match(script, /kontrol-adapter-hermes\.log/);
assert.match(script, /Recent adapter log/);
assert.match(script, /HERMES_ACP_ADAPTER_PORT:-9911/);
assert.match(script, /HERMES_ACP_COMPAT_PATH="\$DESKTOP_PWD\/scripts\/hermes-acp-compat"/);
assert.match(script, /PYTHONPATH="\$HERMES_ACP_COMPAT_PATH:\$\{PYTHONPATH:-\}" "\$\{HERMES_BIN:-hermes\}" acp --check/);
assert.match(script, /node scripts\/acp-hermes-native-adapter\.mjs/);
assert.match(script, /probe-kontrol-readiness\.mjs/);
assert.match(script, /readyz/);
assert.match(script, /rollback/);
assert.match(script, /send-keys.*C-c/);
assert.match(script, /cli-coding-agent/);
assert.ok(script.includes('R="000"'));
assert.match(script, /127\.0\.0\.1:8080\/readyz/);
assert.match(script, /tunnel MCP readiness failed/);
assert.match(script, /KONTROL_SYSTEMD_SERVICE:-false/);
assert.match(script, /systemd_shutdown/);
assert.match(script, /while tmux has-session -t kontrol-supervisor/);
const serviceScript = readFileSync("scripts/kontrol-user-service.sh", "utf8");
assert.match(serviceScript, /Type=simple/);
assert.match(serviceScript, /WorkingDirectory="\$\{ROOT_DIR\}"/);
assert.match(serviceScript, /ExecStart=\/usr\/bin\/env node "\$\{ROOT_DIR\}\/dist\/cli\.js" serve/);
assert.doesNotMatch(serviceScript, /ExecStart=.*start-all\.sh/);
assert.doesNotMatch(script, /mcp\.extra-headers.*Authorization/);
assert.doesNotMatch(script, /mcp\.discovery-extra-headers.*Authorization/);
assert.match(script, /node scripts\/probe-workspace-app\.mjs --url/);
assert.match(readFileSync("scripts/probe-kontrol-readiness.mjs", "utf8"), /jsonOrText/);
assert.match(readFileSync("restart-kontrol.sh", "utf8"), /node|start-all/);

console.log("start-all.test.mjs: all assertions passed");
