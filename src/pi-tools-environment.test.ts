/**
 * ENV-01 regression: ordinary MCP `bash` must not observe the server
 * environment.  `ProcessSessionManager` (exec_command) was already sanitized;
 * this pins the ordinary shell path, which inherited the host environment
 * wholesale before the spawnHook fix in pi-tools.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShellTool } from "./pi-tools.js";

// These must look real enough to be caught if inherited; intentionally not
// real credentials.
const POLLUTED_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
  TERM: "dumb",
  KONTROL_ACP_WORKER_SECRET: "pollution-canary-worker",
  KONTROL_RUNTIME_LOCK_TOKEN: "pollution-canary-lock",
  ACP_REVIEWER_TOKEN: "pollution-canary-reviewer",
  OAUTH_ACCESS_TOKEN: "pollution-canary-oauth",
  DEPLOY_TUNNEL_URL: "pollution-canary-tunnel",
  REVIEWER_PASSWORD: "pollution-canary-password",
  API_SECRET_KEY: "pollution-canary-secret",
  SIGNING_CREDENTIAL: "pollution-canary-credential",
  TLS_PRIVATE_KEY: "pollution-canary-key",
};

const cwd = mkdtempSync(join(tmpdir(), "kontrol-shell-env-test-"));

// buildChildEnvironment reads the server (this test process's) environment at
// call time, so the benign allowlisted variable must exist there to prove
// pass-through.
process.env.PROJECT_FLAG = "visible";

async function shellOut(command: string): Promise<string> {
  const response = await runShellTool(
    { command, timeout: 30 },
    { cwd, root: cwd, childEnvironmentAllowlist: [] },
  );
  assert.equal(response.isError, undefined, `command failed: ${command}\n${JSON.stringify(response.content)}`);
  return response.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

// 1. Full `env` dump must contain no sensitive namespace and no canary value.
const fullEnv = await shellOut("env");
const benignCanaries = new Set([POLLUTED_ENV.PATH, POLLUTED_ENV.HOME, "dumb"]);
for (const canary of Object.values(POLLUTED_ENV)) {
  if (canary === undefined || benignCanaries.has(canary)) continue;
  assert.ok(!fullEnv.includes(canary), `shell environment leaked canary value: ${canary}`);
}
for (const pattern of [/^KONTROL_/m, /^ACP_/m, /^OAUTH_/m, /TUNNEL/i, /REVIEWER/i, /TOKEN/i, /SECRET/i, /PASSWORD/i, /CREDENTIAL/i, /PRIVATE_KEY/i]) {
  const lines = fullEnv.split("\n").filter((l) => pattern.test(l) && /^[A-Z_]+=/.test(l));
  assert.deepEqual(lines, [], `shell environment leaked sensitive variable(s): ${lines.join("; ")}`);
}

// 2. Benign variables and explicit allowlist entries still pass through.
assert.ok(/PATH=/.test(fullEnv), "PATH must remain available");
const withAllowlist = await runShellTool(
  { command: "echo $PROJECT_FLAG", timeout: 30 },
  { cwd, root: cwd, childEnvironmentAllowlist: ["PROJECT_FLAG"] },
);
assert.equal(
  withAllowlist.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim(),
  "visible",
  "allowlisted benign variable should pass through",
);

// 3. Shell still actually executes (guards against an over-sanitized env
//    breaking the shell itself).
const echo = await shellOut("echo kontrol-$((40+2))");
assert.ok(echo.includes("kontrol-42"), "shell must remain functional");

console.log("pi-tools-environment.test.ts: all assertions passed");
