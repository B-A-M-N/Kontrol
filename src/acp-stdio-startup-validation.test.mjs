import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// P1 hardening: a misconfigured ACP_STDIO_COMMAND must fail fast at
// adapter startup — before registration — instead of failing every dispatch.
const child = spawn(process.execPath, ["scripts/acp-stdio-duplex-adapter.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    KONTROL_ACP_AGENT_SECRET: "agent-secret",
    KONTROL_ACP_ADAPTER_SECRET: "adapter-secret",
    ACP_STDIO_COMMAND: "/nonexistent/kontrol-agent-binary",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
const exitCode = await new Promise((resolve) => child.once("exit", resolve));
clearTimeout(timeout);
assert.equal(exitCode, 1, "an unresolvable agent executable exits non-zero at startup");
assert.match(stderr, /does not resolve to an executable file/, "the failure names the unresolvable command");
assert.match(stderr, /nonexistent\/kontrol-agent-binary/);
console.log("acp-stdio-startup-validation.test.mjs: all assertions passed");
