import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createReadOnlyExecutionGrant } from "./read-only-execution.mjs";

const state = await mkdtemp(join(tmpdir(), "kontrol-stdio-integration-"));
const events = [];
const control = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (req.url?.endsWith("/agents/register")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "stdio-test-agent", agentCredential: "stdio-test-credential" }));
    return;
  }
  if (req.url?.includes("/events")) events.push(body);
  res.writeHead(202, { "content-type": "application/json" });
  res.end(JSON.stringify({ accepted: true }));
});
await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
const controlPort = control.address().port;
const adapterPort = await new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const port = probe.address().port;
    probe.close(() => resolve(port));
  });
});
const fakeBubblewrap = join(state, "bwrap");
const launchCountPath = join(state, "launch-count.txt");
await writeFile(fakeBubblewrap, "#!/bin/sh\necho namespace-denied >&2\nexit 1\n", { mode: 0o700 });
const childCode = `require("node:fs").appendFileSync(${JSON.stringify(launchCountPath)},"1");let b="",seen=[];process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;for(const line of b.split(/\\r?\\n/).slice(0,-1)){const m=JSON.parse(line);if(m.method==="initialize"){seen.push(m.method);process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentCapabilities:{}}})+"\\n")}else if(m.method==="session/new"){seen.push(m.method);process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{sessionId:"agent-session-1"}})+"\\n")}else if(m.method==="session/prompt"){seen.push(m.method);process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{sessionId:m.params.sessionId,received:m.params.prompt,methods:seen}})+"\\n");setTimeout(()=>process.exit(0),20)}}b=b.split(/\\r?\\n/).at(-1)||""})`;
const adapter = spawn(process.execPath, ["scripts/acp-stdio-duplex-adapter.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    KONTROL_ACP_URL: `http://127.0.0.1:${controlPort}/acp`,
    KONTROL_ACP_AGENT_SECRET: "agent-secret",
    KONTROL_ACP_ADAPTER_SECRET: "adapter-secret",
    KONTROL_ACP_AGENT_STATE_FILE: join(state, "identity.json"),
    KONTROL_STDIO_DISPATCH_RECEIPTS: join(state, "dispatch-receipts.json"),
    KONTROL_STDIO_OWNED_PROCESSES: join(state, "owned-processes.json"),
    KONTROL_BWRAP: fakeBubblewrap,
    ACP_STDIO_AGENT_NAME: "stdio-test-agent",
    ACP_STDIO_COMMAND: process.execPath,
    ACP_STDIO_ARGS_JSON: JSON.stringify(["-e", childCode]),
    ACP_STDIO_DISPATCH_METHOD: "",
    ACP_STDIO_ADAPTER_PORT: String(adapterPort),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${adapterPort}/health`);
      if (response.ok) break;
    } catch { /* adapter is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const emptyResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify({ workspace_root: process.cwd(), input: [{ parts: [{ content: "   " }] }] }),
  });
  assert.equal(emptyResponse.status, 400, "empty ACP tasks must be rejected before spawning");
  const normalBody = {
    workspace_root: process.cwd(),
    parent_run_id: "stdio-normal-run",
    agent_id: "stdio-test-agent",
    attempt_number: 1,
    dispatch_idempotency_key: "stdio-normal-dispatch",
    input: [{ parts: [{ content: "task reaches stdio child" }] }],
  };
  const response = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify(normalBody),
  });
  assert.equal(response.status, 202);
  const accepted = await response.json();
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.dispatch_idempotency_key, "stdio-normal-dispatch");
  assert.ok(["running", "completed"].includes(accepted.status));
  const deadlineForEvent = Date.now() + 5_000;
  while (Date.now() < deadlineForEvent && !events.some((event) => JSON.stringify(event).includes("task reaches stdio child"))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(events.some((event) => JSON.stringify(event).includes("task reaches stdio child")), "dispatched task did not reach child stdin");
  const protocolResult = events.find((event) => JSON.stringify(event.payload).includes("task reaches stdio child"));
  assert.ok(protocolResult, "ACP protocol result was not projected");
  const protocolOutput = JSON.stringify(protocolResult.payload);
  assert.match(protocolOutput, /initialize.*session\/new.*session\/prompt/, "generic adapter uses the standard ACP session handshake");
  assert.match(protocolOutput, /agent-session-1/, "generic adapter prompts the ACP session returned by session/new");
  const replayResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify(normalBody),
  });
  assert.equal(replayResponse.status, 202, "an identical idempotency retry returns the existing execution receipt");
  assert.equal((await replayResponse.json()).replayed, true);
  const conflictResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify({ ...normalBody, input: [{ parts: [{ content: "different task under same key" }] }] }),
  });
  assert.equal(conflictResponse.status, 409, "a reused key with different content is rejected");

  const workspaceRoot = realpathSync(process.cwd());
  const grant = createReadOnlyExecutionGrant({
    workSessionId: "stdio-read-only-work",
    workspaceSessionId: "stdio-read-only-workspace",
    workspaceRoot,
    agentId: "stdio-test-agent",
    runId: "stdio-read-only-run",
    attemptNumber: 1,
    dispatchIdempotencyKey: "stdio-read-only-dispatch",
  }, "adapter-secret");
  const readOnlyBody = {
    workspace_root: workspaceRoot,
    workspace_session_id: "stdio-read-only-workspace",
    session_id: "stdio-read-only-work",
    agent_id: "stdio-test-agent",
    parent_run_id: "stdio-read-only-run",
    attempt_number: 1,
    dispatch_idempotency_key: "stdio-read-only-dispatch",
    scheduled_execution_policy: { executionMode: "read_only_audit", workspaceAccess: "read_only", mutate: false },
    read_only_execution_grant: grant,
    input: [{ parts: [{ content: "must remain sandboxed" }] }],
  };
  const forgedGrantResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify({ ...readOnlyBody, read_only_execution_grant: { ...grant, signature: "forged" } }),
  });
  assert.equal(forgedGrantResponse.status, 403, "forged scheduled read-only authority is rejected before any child launch");
  const unavailableSandboxResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify(readOnlyBody),
  });
  assert.equal(unavailableSandboxResponse.status, 503, "an unavailable OS namespace backend fails closed");
  assert.equal((await unavailableSandboxResponse.json()).error.code, "sandbox_unavailable");
  assert.equal(await readFile(launchCountPath, "utf8"), "1", "invalid grants and unavailable confinement are rejected before another worker starts");
  console.log("acp-stdio-duplex-integration: task reached child stdin");
} finally {
  adapter.kill("SIGTERM");
  await new Promise((resolve) => adapter.once("exit", resolve));
  await new Promise((resolve) => control.close(resolve));
  await rm(state, { recursive: true, force: true });
}
