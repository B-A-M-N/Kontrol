import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// P1 hardening: an unusable ACP_STDIO_ADAPTER_PORT must fail fast at adapter
// startup — before registration — instead of throwing from .listen() later.
async function runAdapterOnce(extraEnv) {
  const child = spawn(process.execPath, ["scripts/acp-stdio-duplex-adapter.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      KONTROL_ACP_AGENT_SECRET: "agent-secret",
      KONTROL_ACP_ADAPTER_SECRET: "adapter-secret",
      ACP_STDIO_COMMAND: "/bin/true",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  clearTimeout(timeout);
  return { exitCode, stderr };
}

{
  const { exitCode, stderr } = await runAdapterOnce({ ACP_STDIO_ADAPTER_PORT: "not-a-port" });
  assert.equal(exitCode, 1, "a non-numeric adapter port exits non-zero at startup");
  assert.match(stderr, /ACP_STDIO_ADAPTER_PORT must be a TCP port 1-65535/, "the failure names the port requirement");
}

{
  const { exitCode, stderr } = await runAdapterOnce({ ACP_STDIO_ADAPTER_PORT: "70000" });
  assert.equal(exitCode, 1, "an out-of-range adapter port exits non-zero at startup");
  assert.match(stderr, /got: 70000/, "the failure echoes the rejected value");
}

{
  const { exitCode, stderr } = await runAdapterOnce({ ACP_STDIO_AGENT_NAME: "   " });
  assert.equal(exitCode, 1, "a blank agent name exits non-zero at startup");
  assert.match(stderr, /ACP_STDIO_AGENT_NAME must not be blank/, "the failure names the agent name requirement");
}

console.log("acp-stdio-config-validation.test.mjs: all assertions passed");
