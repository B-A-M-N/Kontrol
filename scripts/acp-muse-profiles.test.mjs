#!/usr/bin/env node
// P1 item 7: Muse Code, MuseFI, and OpenMuse run as three independent
// profiles on the generic ACP stdio duplex adapter. This test proves, with
// three live adapter instances and a fixture ACP agent each:
//   1. distinct registration names (muse-code-test / musefi-test /
//      openmuse-test) and ports;
//   2. the experimental gate (MUSE_EXPERIMENTAL_ACP) reaches the agent child
//      only through the adapter child-env allowlist (safeEnv would strip it);
//   3. a dispatch to one profile never reaches the other (no silent reroute);
//   4. dispatch receipts land in per-profile state roots, never a shared file.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Run the adapter from the tree under test, never a hardcoded checkout path.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
import { createServer } from "node:http";

const root = mkdtempSync(join(tmpdir(), "kontrol-muse-profiles-"));
const workspaceRoot = join(root, "workspace");
mkdirSync(workspaceRoot, { recursive: true });

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
  });
});
const [portA, portB, portC] = [await freePort(), await freePort(), await freePort()];
assert.ok(portA > 0 && portB > 0 && portC > 0 && portA !== portB && portB !== portC && portA !== portC, "three distinct loopback ports are available");

// Minimal fixture ACP v1 agent: answers the handshake, records what the
// adapter sends it, and records whether the experimental gate survived.
const fixturePath = join(root, "fixture-agent.mjs");
writeFileSync(fixturePath, `
import { appendFileSync } from "node:fs";
const tag = process.argv[2] || "unknown";
const logPath = process.argv[3];
const envPath = process.argv[4];
let buffer = "";
const note = (record) => { try { appendFileSync(logPath, JSON.stringify({ tag, ...record }) + "\\n"); } catch {} };
try { appendFileSync(envPath, JSON.stringify({ tag, MUSE_EXPERIMENTAL_ACP: process.env.MUSE_EXPERIMENTAL_ACP ?? null }) + "\\n"); } catch {}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }) + "\\n");
    } else if (message.method === "session/new") {
      note({ method: "session/new" });
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: "sess-" + tag } }) + "\\n");
    } else if (message.method === "session/prompt") {
      note({ method: "session/prompt", text: message.params?.prompt?.[0]?.text });
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: "sess-" + tag, stopReason: "end_turn", content: [{ type: "text", text: "done-" + tag }] } }) + "\\n");
      /* persistent: the fixture stays alive after end_turn; the adapter must settle completion and clean up */;
    }
  }
});
`);

// One shell wrapper per profile so the adapter spawns a distinct executable
// path per instance (mirrors ACP_STDIO_COMMAND=<bin> + ARGS_JSON=["acp"]).
const wrapperFor = (tag, logPath, envPath) => {
  const wrapperPath = join(root, `agent-${tag}.sh`);
  writeFileSync(wrapperPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} ${tag} ${JSON.stringify(logPath)} ${JSON.stringify(envPath)}\n`, { mode: 0o755 });
  return wrapperPath;
};

// Stub Kontrol: accept both registrations, answer heartbeats.
const seenRegistrations = [];
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/agents/register") {
      const parsed = JSON.parse(body || "{}");
      seenRegistrations.push(parsed.name);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: `agent-${parsed.name}`, agentCredential: `cred-${parsed.name}` }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = stub.address().port;

const ADAPTER_SECRET = "regression-muse-secret";
const spawnProfile = (tag, port, experimentalGate) => {
  const logPath = join(root, `sessions-${tag}.log`);
  writeFileSync(logPath, "");
  const envPath = join(root, `env-${tag}.log`);
  writeFileSync(envPath, "");
  let adapterOutput = "";
  const child = spawn(process.execPath, ["scripts/acp-stdio-duplex-adapter.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      KONTROL_ACP_AGENT_SECRET: "regression-agent-secret",
      KONTROL_ACP_ADAPTER_SECRET: ADAPTER_SECRET,
      ACP_STDIO_AGENT_NAME: tag,
      ACP_STDIO_COMMAND: wrapperFor(tag, logPath, envPath),
      ACP_STDIO_ADAPTER_PORT: String(port),
      KONTROL_ACP_URL: `http://127.0.0.1:${stubPort}`,
      KONTROL_STATE_DIR: join(root, "state", tag),
      ACP_STDIO_AGENT_ENV_JSON: JSON.stringify(
        experimentalGate === undefined ? {} : { MUSE_EXPERIMENTAL_ACP: experimentalGate },
      ),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { adapterOutput += String(chunk); });
  child.stderr.on("data", (chunk) => { adapterOutput += String(chunk); });
  const outputTail = () => adapterOutput.slice(-1500);
  return { child, logPath, envPath, port, outputTail };
};

const instances = {
  "muse-code-test": spawnProfile("muse-code-test", portA, "on"),
  "musefi-test": spawnProfile("musefi-test", portB, undefined),
  "openmuse-test": spawnProfile("openmuse-test", portC, "on"),
};
const postRuns = async (instance, body) => {
  const res = await fetch(`http://127.0.0.1:${instance.port}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${ADAPTER_SECRET}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};
const dispatchBody = (key, task) => ({
  workspace_root: workspaceRoot,
  parent_run_id: `muse-profile-${key}`,
  agent_id: "profile-test-agent",
  session_id: `profile-session-${key}`,
  workspace_session_id: `profile-workspace-${key}`,
  attempt_number: 1,
  dispatch_idempotency_key: key,
  workspace_lease_nonce: `profile-lease-${key}`,
  workspace_lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
  input: [{ parts: [{ content: task }] }],
});

try {
  const deadline = Date.now() + 20_000;
  for (const instance of Object.values(instances)) {
    for (;;) {
      try {
        const health = await fetch(`http://127.0.0.1:${instance.port}/health`);
        if (health.ok) break;
      } catch { /* starting */ }
      if (Date.now() > deadline) throw new Error("profile adapter did not become healthy in time");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // 1. Distinct registration identities, one per profile.
  assert.deepEqual([...seenRegistrations].sort(), ["muse-code-test", "musefi-test", "openmuse-test"],
    "all three profiles register under their own agent names");

  // 2. Dispatch one task per profile; each fixture agent spawns on demand.
  const taskA = `muse-code probe ${Date.now()}`;
  const taskB = `musefi probe ${Date.now()}`;
  const taskC = `openmuse probe ${Date.now()}`;
  const dispatchedA = await postRuns(instances["muse-code-test"], dispatchBody("muse-isolation-a", taskA));
  assert.equal(dispatchedA.status, 202,
    `muse-code dispatch accepted (got ${dispatchedA.status} ${JSON.stringify(dispatchedA.json).slice(0, 300)}; adapter: ${instances["muse-code-test"].outputTail()})`);
  const dispatchedB = await postRuns(instances["musefi-test"], dispatchBody("muse-isolation-b", taskB));
  assert.equal(dispatchedB.status, 202, `musefi dispatch accepted (got ${dispatchedB.status})`);
  const dispatchedC = await postRuns(instances["openmuse-test"], dispatchBody("muse-isolation-c", taskC));
  assert.equal(dispatchedC.status, 202, `openmuse dispatch accepted (got ${dispatchedC.status})`);
  const promptsSeen = (tag) => readFileSync(instances[tag].logPath, "utf8").split("\n")
    .filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
    .filter((record) => record.method === "session/prompt").map((record) => record.text);
  const waitFor = async (predicate, what) => {
    const end = Date.now() + 15_000;
    for (;;) {
      try { if (predicate()) return; } catch { /* log not written yet */ }
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  await waitFor(() => promptsSeen("muse-code-test").includes(taskA), "the muse-code prompt");
  await waitFor(() => promptsSeen("musefi-test").includes(taskB), "the musefi prompt");
  await waitFor(() => promptsSeen("openmuse-test").includes(taskC), "the openmuse prompt");

  // 3. No silent reroute: each fixture saw only its own profile's task.
  for (const [tag, own, others] of [
    ["muse-code-test", taskA, [taskB, taskC]],
    ["musefi-test", taskB, [taskA, taskC]],
    ["openmuse-test", taskC, [taskA, taskB]],
  ]) {
    assert.ok(promptsSeen(tag).includes(own), `${tag} saw its own dispatch`);
    for (const other of others) {
      assert.ok(!promptsSeen(tag).includes(other), `${tag} never saw another profile's dispatch`);
    }
  }

  // 4. The experimental gate reaches the agent child through the allowlist,
  // per instance: on for muse-code-test, absent for musefi-test.
  const readEnvLog = (tag) => readFileSync(instances[tag].envPath, "utf8").split("\n")
    .filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  assert.equal(readEnvLog("muse-code-test")[0]?.MUSE_EXPERIMENTAL_ACP, "on",
    "allowlisted MUSE_EXPERIMENTAL_ACP=on reaches the muse-code child");
  assert.equal(readEnvLog("musefi-test")[0]?.MUSE_EXPERIMENTAL_ACP, null,
    "an unset gate stays unset for the musefi child (per-instance passthrough, no leakage)");
  assert.equal(readEnvLog("openmuse-test")[0]?.MUSE_EXPERIMENTAL_ACP, "on",
    "allowlisted MUSE_EXPERIMENTAL_ACP=on reaches the openmuse child");

  // 5. Dispatch receipts live in per-profile state roots.
  const receiptsA = join(root, "state", "muse-code-test", "adapters", "stdio-duplex", "dispatch-receipts.json");
  const receiptsB = join(root, "state", "musefi-test", "adapters", "stdio-duplex", "dispatch-receipts.json");
  const receiptsC = join(root, "state", "openmuse-test", "adapters", "stdio-duplex", "dispatch-receipts.json");
  assert.ok(existsSync(receiptsA), "muse-code receipts persist under its own state root");
  assert.ok(readFileSync(receiptsA, "utf8").includes("muse-isolation-a"),
    "the muse-code receipt records the muse-code dispatch key");
  assert.ok(existsSync(receiptsB), "musefi receipts persist under its own state root");
  assert.ok(readFileSync(receiptsB, "utf8").includes("muse-isolation-b"),
    "the musefi receipt records the musefi dispatch key");
  assert.ok(!readFileSync(receiptsB, "utf8").includes("muse-isolation-a"),
    "the musefi receipt store never records the muse-code dispatch key");
  assert.ok(!readFileSync(receiptsA, "utf8").includes("muse-isolation-b"),
    "the muse-code receipt store never records the musefi dispatch key");
  assert.ok(existsSync(receiptsC), "openmuse receipts persist under its own state root");
  assert.ok(readFileSync(receiptsC, "utf8").includes("muse-isolation-c"),
    "the openmuse receipt records the openmuse dispatch key");
  for (const [label, path] of [["muse-code", receiptsA], ["musefi", receiptsB]]) {
    assert.ok(!readFileSync(path, "utf8").includes("muse-isolation-c"),
      `the ${label} receipt store never records the openmuse dispatch key`);
  }
  assert.ok(!readFileSync(receiptsC, "utf8").includes("muse-isolation-a")
    && !readFileSync(receiptsC, "utf8").includes("muse-isolation-b"),
    "the openmuse receipt store never records another profile's dispatch key");

  // 5b. Terminal completion is recorded from the authoritative end_turn
  // while each profile's agent child is still alive: the fixture never
  // exits on its own, so a completed status proves settlement does not
  // wait for process exit.
  const completedBy = async (instance, key) => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const res = await fetch(`http://127.0.0.1:${instance.port}/runs/by-dispatch-id/${key}`, {
        headers: { authorization: `Bearer ${ADAPTER_SECRET}` },
      });
      const body = await res.json();
      if (body.status === "completed") return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  assert.ok(await completedBy(instances["muse-code-test"], "muse-isolation-a"),
    "muse-code run completes while its agent child stays alive");
  assert.ok(await completedBy(instances["musefi-test"], "muse-isolation-b"),
    "musefi run completes while its agent child stays alive");
  assert.ok(await completedBy(instances["openmuse-test"], "muse-isolation-c"),
    "openmuse run completes while its agent child stays alive");

  console.log("acp-muse-profiles.test.mjs: three profiles isolated (names, env, routing, state) — passed");

  // 6. Malformed or credential-bearing agent env is rejected at startup,
  // before any registration or dispatch side effect.
  const badEnvs = [
    ["not-json", "malformed JSON"],
    ['{"MUSE_EXPERIMENTAL_ACP":"on",}', "trailing garbage"],
    ['{"KONTROL_ACP_ADAPTER_SECRET":"x"}', "credential key"],
    ['{"SOME_TOKEN":"x"}', "token-like key"],
    ['{"GOOD_NAME":42}', "non-string value"],
    ['{"lowercase":"x"}', "non-identifier key"],
  ];
  for (const [json, why] of badEnvs) {
    const probe = spawn(process.execPath, ["scripts/acp-stdio-duplex-adapter.mjs", "--validate-imports"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        KONTROL_ACP_AGENT_SECRET: "x",
        KONTROL_ACP_ADAPTER_SECRET: "y",
        ACP_STDIO_COMMAND: wrapperFor("probe", "/dev/null", "/dev/null"),
        ACP_STDIO_AGENT_ENV_JSON: json,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    probe.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const exitCode = await Promise.race([new Promise((resolve) => probe.once("exit", resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error("agent-env probe did not exit")), 10_000))]);
    assert.equal(exitCode, 1, `invalid agent env (${why}) fails fast`);
    assert.match(stderr, /ACP_STDIO_AGENT_ENV_JSON/, `invalid agent env (${why}) names the offending variable`);
  }
  console.log("acp-muse-profiles.test.mjs: credential-bearing agent env rejected — passed");
} finally {
  for (const instance of Object.values(instances)) instance.child.kill("SIGTERM");
  await Promise.all(Object.values(instances).map((instance) => Promise.race([new Promise((resolve) => instance.child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 10_000))])));
  stub.close();
  rmSync(root, { recursive: true, force: true });
}
