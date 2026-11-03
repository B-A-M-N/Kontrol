import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const readText = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const script = readText("start-all.sh");

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
assert.match(
  script,
  /if ! start_beta_soak_monitor; then[\s\S]*--qualify did not start the soak monitor; qualification is not running[\s\S]*exit 1\n\s+fi/,
  "qualification mode must fail when it cannot start the soak monitor",
);
assert.match(script, /KONTROL_BETA_SOAK_HOURS:-1/,
  "the continuity workload defaults to a short run instead of consuming the 12-hour uptime window");
assert.match(script, /String\(Math\.max\(requested, minimum\)\)/,
  "the soak runner must honor its configured duration without a hard-coded 12-hour floor");
assert.match(script, /scripts\/kontrol-tunnel\.sh/);
const tunnelScript = readText("scripts/kontrol-tunnel.sh");
assert.match(tunnelScript, /KONTROL_TUNNEL_PROFILE/);
assert.match(tunnelScript, /KONTROL_TUNNEL_ID/);
assert.match(tunnelScript, /"--harpoon\.hosts-include-loopback=\$\{KONTROL_HARPOON_INCLUDE_LOOPBACK:-false\}"/);
assert.match(tunnelScript, /health\.listen-addr 127\.0\.0\.1:0/);
assert.match(tunnelScript, /mcp\.extra-headers/);
assert.match(tunnelScript, /ENV_FILE="\$\{KONTROL_ENV_FILE:-\$DESKTOP_PWD\/\.env\}"/);
assert.match(tunnelScript, /source "\$ENV_FILE"/);
assert.match(script, /kontrol-tunnel\.sh" --doctor/);
const tunnelTestDir = mkdtempSync(join(tmpdir(), "kontrol-start-all-tunnel-"));
const tunnelTestEnvFile = join(tunnelTestDir, "empty.env");
writeFileSync(tunnelTestEnvFile, "");
let effectiveTunnelArgs;
try {
  effectiveTunnelArgs = execFileSync("bash", ["scripts/kontrol-tunnel.sh", "--print-effective-args"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      KONTROL_ENV_FILE: tunnelTestEnvFile,
      KONTROL_CONFIG_DIR: tunnelTestDir,
      KONTROL_AUTH_MODE: "oauth",
      KONTROL_HARPOON_INCLUDE_LOOPBACK: "false",
      KONTROL_POLICY_MODE: "allow",
      KONTROL_TUNNEL_REVIEWER_SECRET: "test-reviewer-secret",
    },
  }).trim().split(/\r?\n/);
} finally {
  rmSync(tunnelTestDir, { recursive: true, force: true });
}
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
assert.match(script, /HERMES_ACP_CHECK_COMMAND=\(\)/);
assert.match(script, /HERMES_ACP_BIN:-/);
assert.match(script, /hermes-acp/);
assert.match(script, /PYTHONPATH="\$HERMES_ACP_COMPAT_PATH:\$\{PYTHONPATH:-\}" "\$\{HERMES_ACP_CHECK_COMMAND\[@\]\}" --check/);
assert.match(script, /node scripts\/acp-hermes-native-adapter\.mjs/);
assert.match(script, /probe-kontrol-readiness\.mjs/);
assert.match(script, /effective-policy --json/);
assert.match(script, /toolRules/);
assert.match(script, /readyz/);
assert.match(script, /rollback/);
assert.match(script, /send-keys.*C-c/);
assert.match(script, /cli-coding-agent/);
assert.ok(script.includes('R="000"'));
assert.match(script, /127\.0\.0\.1:8080\/readyz/);
assert.match(script, /tunnel MCP readiness failed/);
const serviceScript = readFileSync("scripts/kontrol-user-service.sh", "utf8");
const serviceSource = readFileSync("src/service.ts", "utf8");
assert.match(serviceScript, /exec node "\$CLI" service/);
assert.match(serviceSource, /export async function runServiceCommand/);
assert.match(serviceSource, /Type=simple/);
assert.match(serviceSource, /restoreDeploymentDatabaseBackup/);
assert.match(serviceSource, /systemdQuote/);
assert.match(serviceSource, /deployment\.\$\{deploymentId\}\.json/);
assert.doesNotMatch(serviceSource, /node --import tsx|src\/config\.ts|read -r .*ARTIFACT/);
assert.doesNotMatch(serviceScript, /ExecStart=.*start-all\.sh/);
assert.doesNotMatch(script, /mcp\.extra-headers.*Authorization/);
assert.doesNotMatch(script, /mcp\.discovery-extra-headers.*Authorization/);
assert.match(script, /WORKSPACE_APP_PROBE_ARGS=\(--url/);
assert.match(script, /node scripts\/probe-workspace-app\.mjs "\$\{WORKSPACE_APP_PROBE_ARGS\[@\]\}"/);
const readinessProbe = readFileSync("scripts/probe-kontrol-readiness.mjs", "utf8");
assert.match(readinessProbe, /await jsonOrText\(reviewerReadiness\)/, "reviewer readiness must await the async body");
assert.match(readinessProbe, /REQUIRED_INSPECTION_TOOLS/, "readiness must use the canonical eight-tool registry");
assert.match(readinessProbe, /git_status.*git_log.*git_diff.*git_show/s, "readiness must exercise all Git inspection tools");
assert.match(readinessProbe, /open_approval_center/, "ask-capable readiness must exercise the reviewer approval center");
assert.match(readinessProbe, /reviewerHeaderName[\s\S]*x-kontrol-tunnel-reviewer[\s\S]*x-kontrol-reviewer-token/,
  "readiness must use the tunnel-specific reviewer assertion header in tunnel mode");
assert.match(readinessProbe, /\[reviewerHeaderName\]: reviewerToken/,
  "reviewer readiness sends the selected credential only in its matching authority header");
assert.match(readinessProbe, /--rpc-timeout-ms/,
  "readiness RPC timeout is configurable for large but bounded workspace inspections");
assert.match(readinessProbe, /jsonOrText/);
assert.match(readinessProbe, /args\.includes\("--probe-bash"\)/);
assert.match(readinessProbe, /if \(probeBash\)/);
assert.match(readinessProbe, /readOnlyInspection: true/,
  "the optional Bash readiness probe must use the checkpoint-independent inspection path");
assert.match(readinessProbe, /inputSchema\?\.properties\?\.readOnlyInspection/,
  "readiness must reject a stale Bash tool schema without read-only inspection support");
assert.match(readFileSync("restart-kontrol.sh", "utf8"), /node|start-all/);

// P0.1: the tunnel reviewer-secret guard is behavioral. An ask-capable
// tunnel must refuse to start without a reviewer credential, while a
// non-interactive policy must start without one. A regex asserting the
// script contains the guard cannot catch an inverted conditional.
function runTunnelArgs(envOverrides) {
  const dir = mkdtempSync(join(tmpdir(), "kontrol-tunnel-guard-"));
  const envFile = join(dir, "empty.env");
  writeFileSync(envFile, "");
  try {
    const stdout = execFileSync("bash", ["scripts/kontrol-tunnel.sh", "--print-effective-args"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        KONTROL_ENV_FILE: envFile,
        KONTROL_CONFIG_DIR: dir,
        KONTROL_AUTH_MODE: "tunnel",
        KONTROL_HARPOON_INCLUDE_LOOPBACK: "false",
        ...envOverrides,
      },
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stderr: String(error.stderr ?? error.message) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const withSecret = runTunnelArgs({ KONTROL_POLICY_MODE: "ask", KONTROL_TUNNEL_REVIEWER_SECRET: "guard-test-secret" });
  assert.equal(withSecret.ok, true, "ask-capable tunnel with a reviewer secret must start");
  assert.ok(withSecret.stdout.includes("X-Kontrol-Tunnel-Reviewer"), "started tunnel must forward the reviewer assertion");

  const askWithoutSecret = runTunnelArgs({ KONTROL_POLICY_MODE: "ask" });
  assert.equal(askWithoutSecret.ok, false, "ask-capable tunnel without a reviewer secret must refuse startup");
  assert.match(askWithoutSecret.stderr, /reviewer credential/, "refusal must name the missing reviewer credential");

  const nonInteractive = runTunnelArgs({ KONTROL_POLICY_MODE: "allow" });
  assert.equal(nonInteractive.ok, true, "non-interactive policy must start without a reviewer credential");
  assert.ok(!nonInteractive.stdout.includes("X-Kontrol-Tunnel-Reviewer"), "no reviewer assertion without a configured secret");
}
{
  // P0.2: the reviewer credential resolves from the dedicated variable, the
  // legacy ACP secret, or the 0600 auth file — and the asserted header always
  // names the dedicated variable (the server's first-precedence credential).
  const dedicatedOnly = runTunnelArgs({ KONTROL_POLICY_MODE: "ask", KONTROL_TUNNEL_REVIEWER_SECRET: "dedicated-secret" });
  assert.equal(dedicatedOnly.ok, true, "dedicated tunnel secret must start an ask-capable tunnel");
  assert.ok(dedicatedOnly.stdout.includes("env:KONTROL_TUNNEL_REVIEWER_SECRET"), "header must reference the dedicated variable");
  const bothDifferent = runTunnelArgs({
    KONTROL_POLICY_MODE: "ask",
    KONTROL_TUNNEL_REVIEWER_SECRET: "dedicated-secret",
    KONTROL_ACP_REVIEWER_SECRET: "legacy-secret",
  });
  assert.equal(bothDifferent.ok, true, "tunnel must start when both secrets are set");
  assert.ok(bothDifferent.stdout.includes("env:KONTROL_TUNNEL_REVIEWER_SECRET"), "header must follow server precedence (dedicated first)");
  assert.ok(!bothDifferent.stdout.includes("env:KONTROL_ACP_REVIEWER_SECRET"), "header must not reference the losing credential");
}
{
  // P0.2: auth-file-only deployment. The launcher must resolve the reviewer
  // secret from the 0600 auth file instead of assuming a legacy variable.
  const dir = mkdtempSync(join(tmpdir(), "kontrol-tunnel-authfile-"));
  const envFile = join(dir, "empty.env");
  writeFileSync(envFile, "");
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ tunnelReviewerSecret: "auth-file-secret" }));
  let result;
  try {
    result = runTunnelArgs({ KONTROL_POLICY_MODE: "ask", KONTROL_CONFIG_DIR: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(result.ok, true, "auth-file reviewer secret must satisfy the ask-capable guard");
  assert.ok(result.stdout.includes("env:KONTROL_TUNNEL_REVIEWER_SECRET"), "header must reference the dedicated variable");
}

console.log("start-all.test.mjs: all assertions passed");
