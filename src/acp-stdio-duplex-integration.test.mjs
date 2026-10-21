import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createReadOnlyExecutionGrant, findBubblewrap, probeReadOnlyExecutionSandbox } from "./read-only-execution.mjs";

const state = await mkdtemp(join(tmpdir(), "kontrol-stdio-integration-"));
const workspaceRoot = join(state, "workspace");
await mkdir(workspaceRoot);
const events = [];
const acceptedEventIds = new Set();
const control = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (req.url?.endsWith("/agents/register")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "stdio-test-agent", agentCredential: "stdio-test-credential" }));
    return;
  }
  if (req.url?.includes("/events")) {
    if (!acceptedEventIds.has(body.event_id)) {
      acceptedEventIds.add(body.event_id);
      events.push(body);
    }
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify(["completed", "failed", "cancelled", "exited"].includes(body.type) ? {
      accepted: true,
      dispatch_receipt_acknowledged: true,
      dispatch_idempotency_key: body.dispatch_idempotency_key,
      remote_run_id: body.remote_run_id,
      attempt_number: body.attempt_number,
      event_id: body.event_id,
    } : { accepted: true }));
    return;
  }
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
const sessionLogPath = join(state, "provider-session-log.jsonl");
await writeFile(fakeBubblewrap, "#!/bin/sh\necho namespace-denied >&2\nexit 1\n", { mode: 0o700 });
let bubblewrapPath = fakeBubblewrap;
let readOnlySandboxAvailable = false;
try {
  bubblewrapPath = findBubblewrap();
  probeReadOnlyExecutionSandbox({ workspaceRoot });
  readOnlySandboxAvailable = true;
} catch { /* the integration below asserts fail-closed when user namespaces are unavailable */ }
const childCode = `const fs=require("node:fs");try{fs.appendFileSync(${JSON.stringify(launchCountPath)},"1")}catch{};let b="",seen=[];process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;for(const line of b.split(/\\r?\\n/).slice(0,-1)){const m=JSON.parse(line);seen.push(m.method);try{fs.appendFileSync(${JSON.stringify(sessionLogPath)},JSON.stringify({method:m.method,sessionId:m.params?.sessionId??(m.method==="session/new"?"agent-session-1":undefined)})+"\\n")}catch{};if(m.method==="initialize"){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}})+"\\n")}else if(m.method==="session/new"){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{sessionId:"agent-session-1"}})+"\\n")}else if(m.method==="session/load"){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{sessionId:m.params.sessionId}})+"\\n")}else if(m.method==="session/prompt"){let workspaceWriteBlocked=false;if(process.env.READ_ONLY_TEST==="1"){try{fs.writeFileSync("/workspace/readonly-test-write.txt","should fail")}catch{workspaceWriteBlocked=true}};const report="Audit report: café 🌲\\nFindings persisted."+(workspaceWriteBlocked?"\\nworkspaceWriteBlocked=true":"");process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{sessionId:m.params.sessionId,content:[{type:"text",text:report}],methods:seen,workspaceWriteBlocked}})+"\\n");setTimeout(()=>process.exit(0),20)}}b=b.split(/\\r?\\n/).at(-1)||""})`;
const spawnAdapter = () => {
  const child = spawn(process.execPath, ["scripts/acp-stdio-duplex-adapter.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    KONTROL_ACP_URL: `http://127.0.0.1:${controlPort}/acp`,
    KONTROL_ACP_AGENT_SECRET: "agent-secret",
    KONTROL_ACP_ADAPTER_SECRET: "adapter-secret",
    KONTROL_ACP_AGENT_STATE_FILE: join(state, "identity.json"),
    KONTROL_STDIO_DISPATCH_RECEIPTS: join(state, "dispatch-receipts.json"),
    KONTROL_STDIO_OWNED_PROCESSES: join(state, "owned-processes.json"),
    KONTROL_STDIO_EVENT_SPOOL: join(state, "event-spool.json"),
    KONTROL_STDIO_TERMINAL_SPOOL: join(state, "terminal-spool.json"),
    KONTROL_STDIO_SESSION_BINDINGS: join(state, "session-bindings.json"),
    KONTROL_BWRAP: bubblewrapPath,
    KONTROL_ALLOWED_ROOTS: workspaceRoot,
    KONTROL_READ_ONLY_AGENT_ENV_ALLOWLIST: "READ_ONLY_TEST",
    READ_ONLY_TEST: "1",
    ACP_STDIO_AGENT_NAME: "stdio-test-agent",
    ACP_STDIO_COMMAND: process.execPath,
    ACP_STDIO_ARGS_JSON: JSON.stringify(["-e", childCode]),
    ACP_STDIO_DISPATCH_METHOD: "",
    ACP_STDIO_ADAPTER_PORT: String(adapterPort),
  },
  stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(`[stdio integration adapter] ${chunk}`));
  return child;
};
let adapter = spawnAdapter();
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
    workspace_root: workspaceRoot,
    parent_run_id: "stdio-normal-run",
    agent_id: "stdio-test-agent",
    session_id: "stdio-work-session",
  workspace_lease_nonce: "stdio-test-lease",
  workspace_lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    attempt_number: 1,
    dispatch_idempotency_key: "stdio-normal-dispatch",
    input: [{ parts: [{ content: "task reaches stdio child" }] }],
  };
  const response = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify(normalBody),
  });
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const accepted = await response.json();
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.dispatch_idempotency_key, "stdio-normal-dispatch");
  assert.ok(["running", "completed"].includes(accepted.status));
  const deadlineForEvent = Date.now() + 5_000;
  while (Date.now() < deadlineForEvent && !events.some((event) => event.type === "completed")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const protocolResult = events.find((event) => event.type === "output_delta" && event.payload?.channel === "result");
  assert.ok(protocolResult, `ACP protocol result was not projected; observed events: ${JSON.stringify(events)}`);
  const protocolOutput = JSON.stringify(protocolResult.payload);
  assert.match(protocolOutput, /Audit report: café 🌲\\nFindings persisted\./, "generic adapter records the authoritative multiline Unicode prompt response");
  const terminalEvent = events.find((event) => event.type === "completed");
  assert.equal(terminalEvent?.payload.final_output, "Audit report: café 🌲\nFindings persisted.",
    "the terminal lifecycle event carries the exact attempt-scoped ACP report");
  assert.equal(terminalEvent?.dispatch_idempotency_key, "stdio-normal-dispatch");
  assert.equal(terminalEvent?.attempt_number, 1);
  assert.ok(terminalEvent?.event_id, "terminal delivery has a stable attempt-scoped identity");
  const deadlineForAcknowledgement = Date.now() + 5_000;
  while (Date.now() < deadlineForAcknowledgement) {
    const pendingTerminalEvents = JSON.parse(await readFile(join(state, "terminal-spool.json"), "utf8"));
    if (pendingTerminalEvents.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(JSON.parse(await readFile(join(state, "event-spool.json"), "utf8")), [], "acknowledged output events leave the spool");
  assert.deepEqual(JSON.parse(await readFile(join(state, "terminal-spool.json"), "utf8")), [], "terminal event leaves the spool after exact controller acknowledgement");
  const replayResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify(normalBody),
  });
  assert.equal(replayResponse.status, 202, "an identical idempotency retry returns the existing execution receipt");
  assert.equal((await replayResponse.json()).replayed, true);
  adapter.kill("SIGTERM");
  await new Promise((resolve) => adapter.once("exit", resolve));
  adapter = spawnAdapter();
  const restartedAdapterDeadline = Date.now() + 5_000;
  let restartedAdapterReady = false;
  while (Date.now() < restartedAdapterDeadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${adapterPort}/health`);
      if (health.ok) { restartedAdapterReady = true; break; }
    } catch { /* adapter is restoring durable receipts and bindings */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(restartedAdapterReady, "adapter restart recovers its listener and durable provider session binding");
  const continuationBody = {
    ...normalBody,
    attempt_number: 2,
    dispatch_idempotency_key: "stdio-continuation-dispatch",
    continuation_id: "continuation-2",
    input: [{ parts: [{ content: "continue the same implementation conversation" }] }],
  };
  const continuationResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify(continuationBody),
  });
  assert.equal(continuationResponse.status, 202, "a continuation reloads the existing provider conversation");
  const continuationDeadline = Date.now() + 5_000;
  while (Date.now() < continuationDeadline && events.filter((event) => event.dispatch_idempotency_key === "stdio-continuation-dispatch" && event.type === "completed").length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const sessionMethods = (await readFile(sessionLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(sessionMethods.some((entry) => entry.method === "session/new" && entry.sessionId === "agent-session-1"));
  assert.ok(sessionMethods.some((entry) => entry.method === "session/load" && entry.sessionId === "agent-session-1"),
    "continuation resumes the same provider-native session ID");
  assert.equal(sessionMethods.filter((entry) => entry.method === "session/new").length, 1,
    "review continuation does not create a second implementing-agent conversation");
  const conflictResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify({ ...normalBody, input: [{ parts: [{ content: "different task under same key" }] }] }),
  });
  assert.equal(conflictResponse.status, 409, "a reused key with different content is rejected");

  const canonicalWorkspaceRoot = realpathSync(workspaceRoot);
  const grant = createReadOnlyExecutionGrant({
    workSessionId: "stdio-read-only-work",
    workspaceSessionId: "stdio-read-only-workspace",
    workspaceRoot: canonicalWorkspaceRoot,
    agentId: "stdio-test-agent",
    runId: "stdio-read-only-run",
    attemptNumber: 1,
    dispatchIdempotencyKey: "stdio-read-only-dispatch",
  }, "adapter-secret");
  const readOnlyBody = {
    workspace_root: canonicalWorkspaceRoot,
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
  const readOnlyResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify(readOnlyBody),
  });
  if (readOnlySandboxAvailable) {
    assert.equal(readOnlyResponse.status, 202, "a valid read-only grant starts inside the real OS sandbox");
    const readOnlyAccepted = await readOnlyResponse.json();
    assert.equal(readOnlyAccepted.execution_receipt?.network_policy, "disabled");
    assert.equal(readOnlyAccepted.execution_receipt?.confinement, "bubblewrap-read-only-workspace-no-network");
    const readOnlyEventDeadline = Date.now() + 5_000;
    while (Date.now() < readOnlyEventDeadline && !events.some((event) => event.type === "output_delta" && event.payload?.channel === "result" && event.payload?.text?.includes("workspaceWriteBlocked=true"))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const confinedResult = events.find((event) => event.type === "output_delta" && event.payload?.channel === "result" && event.payload?.text?.includes("workspaceWriteBlocked=true"));
    assert.ok(confinedResult, "the read-only ACP child completed a real protocol prompt");
    assert.match(confinedResult.payload.text, /workspaceWriteBlocked=true/,
      "the ACP child could not modify the read-only workspace mount");
  } else {
    assert.equal(readOnlyResponse.status, 503, "an unavailable OS namespace backend fails closed");
    assert.equal((await readOnlyResponse.json()).error.code, "sandbox_unavailable");
  }
  assert.equal(await readFile(launchCountPath, "utf8"), "11",
    "invalid grants never launch; read-only execution cannot alter the host-side launch marker");
  console.log(`acp-stdio-duplex-integration: task reached child stdin; read-only sandbox ${readOnlySandboxAvailable ? "executed" : "failed closed"}`);
} finally {
  adapter.kill("SIGTERM");
  await new Promise((resolve) => adapter.once("exit", resolve));
  await new Promise((resolve) => control.close(resolve));
  await rm(state, { recursive: true, force: true });
}
