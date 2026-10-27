import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const capabilityRegistrations = [];
const acceptedEventIds = new Set();
const control = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (req.url?.endsWith("/agents/register")) {
    capabilityRegistrations.push(body.capabilities ?? []);
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
const childCode = `const fs=require("node:fs");try{fs.appendFileSync(${JSON.stringify(launchCountPath)},"1")}catch{};let b="",v2Mode=false;process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;for(const line of b.split(/\\r?\\n/).slice(0,-1)){const m=JSON.parse(line);try{fs.appendFileSync(${JSON.stringify(sessionLogPath)},JSON.stringify({method:m.method,sessionId:m.params?.sessionId??(m.method==="session/new"?(v2Mode?"agent-session-v2":"agent-session-1"):undefined),...(m.method==="session/prompt"?{prompt:m.params.prompt?.[0]?.text}:{})})+"\\n")}catch{};const v2=m.params?.protocolVersion===2&&process.argv[1]!=="force-v1";if(m.method==="initialize"){v2Mode=v2;const result=v2?{protocolVersion:2,info:{name:"fake",version:"1"},capabilities:{session:{}}}:{protocolVersion:1,agentCapabilities:{loadSession:true}};process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n")}else if(m.method==="session/new"){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{sessionId:v2Mode?"agent-session-v2":"agent-session-1"}})+"\\n")}else if(m.method==="session/load"||m.method==="session/resume"){if(m.method==="session/resume")process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{sessionId:m.params.sessionId,update:{sessionUpdate:"state_update",state:"idle"}}})+"\\n");process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{sessionId:m.params.sessionId}})+"\\n")}else if(m.method==="session/prompt"){let workspaceWriteBlocked=false;if(process.env.READ_ONLY_TEST==="1"){try{fs.writeFileSync("/workspace/readonly-test-write.txt","should fail")}catch{workspaceWriteBlocked=true}};const report="Audit report: café 🌲\\nFindings persisted."+(workspaceWriteBlocked?"\\nworkspaceWriteBlocked=true":"");if(v2Mode){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{messageId:"user-message-1"}})+"\\n");setTimeout(()=>{process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{sessionId:m.params.sessionId,update:{sessionUpdate:"agent_message",messageId:"agent-message-1",content:[{type:"text",text:report}]}}})+"\\n");process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{sessionId:m.params.sessionId,update:{sessionUpdate:"state_update",state:"idle",stopReason:m.params.prompt?.[0]?.text==="v2-max"?"max_tokens":"end_turn"}}})+"\\n");setTimeout(()=>process.exit(0),20)},20)}else{process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{sessionId:m.params.sessionId,...(m.params.prompt?.[0]?.text==="omit-stop-reason"?{}:{stopReason:({cancelled:"cancelled",refusal:"refusal",max_tokens:"max_tokens",max_turns:"max_turns"}[m.params?.prompt?.[0]?.text]??"end_turn")}),content:[{type:"text",text:report}],workspaceWriteBlocked}})+"\\n");setTimeout(()=>process.exit(0),20)}}}b=b.split(/\\r?\\n/).at(-1)||""})`;
const v2BusyLogPath = join(state, "v2-busy-prompt.json");
const v2BusyChildCode = `let b="",foreground=false;const fs=require("node:fs");process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;for(const line of b.split(/\\r?\\n/).slice(0,-1)){const m=JSON.parse(line);const send=(x)=>process.stdout.write(JSON.stringify(x)+"\\n");if(m.method==="initialize")send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:2,info:{name:"busy-fake",version:"1"},capabilities:{session:{}}}});else if(m.method==="session/resume"){foreground=true;send({jsonrpc:"2.0",method:"session/update",params:{sessionId:m.params.sessionId,update:{sessionUpdate:"state_update",state:"running"}}});send({jsonrpc:"2.0",id:m.id,result:{sessionId:m.params.sessionId}});setTimeout(()=>{foreground=false;send({jsonrpc:"2.0",method:"session/update",params:{sessionId:m.params.sessionId,update:{sessionUpdate:"state_update",state:"idle",stopReason:"end_turn"}}})},150)}else if(m.method==="session/prompt"){fs.writeFileSync(${JSON.stringify(v2BusyLogPath)},JSON.stringify({promptBeforeIdle:foreground}));send({jsonrpc:"2.0",id:m.id,result:{messageId:"busy-user-message"}});setTimeout(()=>send({jsonrpc:"2.0",method:"session/update",params:{sessionId:m.params.sessionId,update:{sessionUpdate:"agent_message",messageId:"busy-agent-message",content:[{type:"text",text:"busy session resumed safely"}]}}}),220);setTimeout(()=>{send({jsonrpc:"2.0",method:"session/update",params:{sessionId:m.params.sessionId,update:{sessionUpdate:"state_update",state:"idle",stopReason:"end_turn"}}});setTimeout(()=>process.exit(0),20)},280)}}b=b.split(/\\r?\\n/).at(-1)||""})`;
const spawnAdapter = (enableV2 = false, forceV1 = false, agentCode = childCode) => {
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
    ACP_STDIO_CAPABILITIES: "native-reply-resume",
    ACP_STDIO_COMMAND: process.execPath,
    ACP_STDIO_ARGS_JSON: JSON.stringify(["-e", agentCode, ...(forceV1 ? ["force-v1"] : [])]),
    ACP_STDIO_DISPATCH_METHOD: "",
    ACP_STDIO_ENABLE_V2: enableV2 ? "1" : "0",
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
  assert.equal(capabilityRegistrations[0]?.includes("native-reply-resume"), false,
    "operator-provided capability strings cannot claim reply resume before ACP support is negotiated");
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
  assert.ok(capabilityRegistrations.at(-1)?.includes("native-reply-resume"),
    "a session-load-capable ACP child is registered for native reply resume after negotiation");
  assert.equal(terminalEvent?.payload.final_output, "Audit report: café 🌲\nFindings persisted.",
    "the terminal lifecycle event carries the exact attempt-scoped ACP report");
  assert.equal(terminalEvent?.dispatch_idempotency_key, "stdio-normal-dispatch");
  assert.equal(terminalEvent?.attempt_number, 1);
  assert.ok(terminalEvent?.event_id, "terminal delivery has a stable attempt-scoped identity");
  const missingStopReasonResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify({
      ...normalBody,
      parent_run_id: "stdio-missing-stop-reason-run",
      session_id: "stdio-missing-stop-reason-session",
      attempt_number: 1,
      dispatch_idempotency_key: "stdio-missing-stop-reason-dispatch",
      input: [{ parts: [{ content: "omit-stop-reason" }] }],
    }),
  });
  assert.equal(missingStopReasonResponse.status, 202, "the adapter accepts the dispatch before asynchronous ACP completion");
  const missingStopReasonDeadline = Date.now() + 5_000;
  while (Date.now() < missingStopReasonDeadline && !events.some((event) => event.dispatch_idempotency_key === "stdio-missing-stop-reason-dispatch" && event.type === "failed")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const missingStopReasonFailure = events.find((event) => event.dispatch_idempotency_key === "stdio-missing-stop-reason-dispatch" && event.type === "failed");
  assert.ok(missingStopReasonFailure, "a missing ACP stop reason is reported as failure, never successful completion");
  assert.match(JSON.stringify(missingStopReasonFailure.payload), /stopReason: missing/);
  for (const stopReason of ["cancelled", "refusal", "max_tokens", "max_turns"]) {
    const dispatchKey = `stdio-${stopReason}-dispatch`;
    const response = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
      body: JSON.stringify({
        ...normalBody,
        parent_run_id: `stdio-${stopReason}-run`,
        session_id: `stdio-${stopReason}-session`,
        attempt_number: 1,
        dispatch_idempotency_key: dispatchKey,
        input: [{ parts: [{ content: stopReason }] }],
      }),
    });
    assert.equal(response.status, 202, `${stopReason} is classified after the adapter accepts the dispatch`);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !events.some((event) => event.dispatch_idempotency_key === dispatchKey && ["failed", "completed"].includes(event.type))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const terminal = events.find((event) => event.dispatch_idempotency_key === dispatchKey && ["failed", "completed"].includes(event.type));
    assert.equal(terminal?.type, "failed", `${stopReason} must fail and never be reported as successful completion`);
    assert.match(JSON.stringify(terminal?.payload), new RegExp(`stopReason: ${stopReason}`));
  }
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
  const transferPacket = { version: 1, transferId: "stdio-transfer-1", checkpoint: { snapshotKind: "git", snapshotRef: "checkpoint-1" } };
  const transferContext = {
    id: "stdio-transfer-1",
    sha256: createHash("sha256").update(JSON.stringify(transferPacket)).digest("hex"),
    packet: transferPacket,
    fresh: true,
  };
  const transferredTask = `continue with the transferred checkpoint\n\nImmutable cross-agent context transfer (sha256 ${transferContext.sha256}):\n${JSON.stringify(transferPacket, null, 2)}`;
  const missingTransferPacket = { ...transferPacket, transferId: "stdio-transfer-missing" };
  const missingTransferContext = {
    id: missingTransferPacket.transferId,
    sha256: createHash("sha256").update(JSON.stringify(missingTransferPacket)).digest("hex"),
    packet: missingTransferPacket,
    fresh: false,
  };
  const sessionsBeforeMissingTransfer = (await readFile(sessionLogPath, "utf8")).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line)).filter((entry) => entry.method === "session/new").length;
  const missingTransferBinding = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify({
      ...normalBody,
      attempt_number: 3,
      dispatch_idempotency_key: "stdio-missing-transfer-binding",
      continuation_id: "continuation-missing-transfer-binding",
      context_transfer: missingTransferContext,
    }),
  });
  assert.equal(missingTransferBinding.status, 202, "adapter acceptance is distinct from provider session startup");
  const missingTransferDeadline = Date.now() + 5_000;
  while (Date.now() < missingTransferDeadline && !events.some((event) =>
    event.dispatch_idempotency_key === "stdio-missing-transfer-binding" && event.type === "failed")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const missingTransferFailure = events.find((event) =>
    event.dispatch_idempotency_key === "stdio-missing-transfer-binding" && event.type === "failed");
  assert.match(String(missingTransferFailure?.error ?? missingTransferFailure?.payload?.error), /continuation_session_missing/,
    "a resumed transfer fails visibly when its exact provider binding is absent");
  const sessionsAfterMissingTransfer = (await readFile(sessionLogPath, "utf8")).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line)).filter((entry) => entry.method === "session/new").length;
  assert.equal(sessionsAfterMissingTransfer, sessionsBeforeMissingTransfer,
    "a missing transfer binding never creates a replacement provider conversation");
  const transferResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify({
      ...normalBody,
      attempt_number: 3,
      dispatch_idempotency_key: "stdio-cross-agent-transfer-dispatch",
      continuation_id: "continuation-transfer-1",
      context_transfer: transferContext,
      input: [{ parts: [{ content: transferredTask }] }],
    }),
  });
  assert.equal(transferResponse.status, 202, "a verified transfer packet starts a fresh destination provider session");
  const transferDeadline = Date.now() + 5_000;
  while (Date.now() < transferDeadline && !events.some((event) => event.dispatch_idempotency_key === "stdio-cross-agent-transfer-dispatch" && event.type === "completed")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(events.some((event) => event.dispatch_idempotency_key === "stdio-cross-agent-transfer-dispatch" && event.type === "completed"),
    "the fresh destination session completes with an authoritative end_turn");
  const transferredPrompt = (await readFile(sessionLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    .findLast((entry) => entry.method === "session/prompt" && entry.sessionId === "agent-session-1")?.prompt;
  assert.equal(transferredPrompt, transferredTask,
    "the real ACP child receives the exact continuation prompt delivered to the destination adapter");
  assert.ok(transferredPrompt.includes('"snapshotRef": "checkpoint-1"'),
    "the destination ACP child receives the immutable transfer packet, including its exact checkpoint identity");
  assert.ok(transferredPrompt.includes(transferContext.sha256),
    "the destination ACP child receives the transfer packet hash used by the dispatch boundary");
  const transferredContinuation = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify({
      ...normalBody,
      attempt_number: 4,
      dispatch_idempotency_key: "stdio-cross-agent-transfer-continuation",
      continuation_id: "continuation-transfer-2",
      context_transfer: { ...transferContext, fresh: false },
      input: [{ parts: [{ content: "continue the destination provider conversation" }] }],
    }),
  });
  assert.equal(transferredContinuation.status, 202, "a later destination continuation restores the transfer-scoped provider session");
  const transferredContinuationDeadline = Date.now() + 5_000;
  while (Date.now() < transferredContinuationDeadline && !events.some((event) => event.dispatch_idempotency_key === "stdio-cross-agent-transfer-continuation" && event.type === "completed")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const sessionMethods = (await readFile(sessionLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(sessionMethods.some((entry) => entry.method === "session/new" && entry.sessionId === "agent-session-1"));
  assert.ok(sessionMethods.some((entry) => entry.method === "session/load" && entry.sessionId === "agent-session-1"),
    "continuation resumes the same provider-native session ID");
  assert.equal(sessionMethods.filter((entry) => entry.method === "session/new").length, 7,
    "same-agent continuation reuses its session while the failed-stop cases and cross-agent transfer use isolated sessions");
  assert.equal(sessionMethods.filter((entry) => entry.method === "session/load").length, 2,
    "both same-agent and transferred-destination continuations restore their exact provider session");
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
  const launchMarkerBeforeGrantChecks = await readFile(launchCountPath, "utf8");
  const forgedGrantResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify({ ...readOnlyBody, read_only_execution_grant: { ...grant, signature: "forged" } }),
  });
  assert.equal(forgedGrantResponse.status, 403, "forged scheduled read-only authority is rejected before any child launch");
  assert.equal(await readFile(launchCountPath, "utf8"), launchMarkerBeforeGrantChecks,
    "a forged grant cannot launch a worker");
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
  assert.equal(await readFile(launchCountPath, "utf8"), launchMarkerBeforeGrantChecks,
    "invalid grants never launch; sandbox execution does not alter the host-side launch marker");

  adapter.kill("SIGTERM");
  await new Promise((resolve) => adapter.once("exit", resolve));
  adapter = spawnAdapter(true);
  const v2ReadyDeadline = Date.now() + 5_000;
  let v2Ready = false;
  while (Date.now() < v2ReadyDeadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${adapterPort}/health`);
      if (health.ok) { v2Ready = true; break; }
    } catch { /* v2 adapter is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(v2Ready, "v2-enabled adapter restarts with its negotiated protocol mode");
  const v2Body = {
    workspace_root: workspaceRoot,
    parent_run_id: "stdio-v2-run",
    agent_id: "stdio-test-agent",
    session_id: "stdio-v2-work-session",
    workspace_lease_nonce: "stdio-v2-lease",
    workspace_lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    attempt_number: 1,
    dispatch_idempotency_key: "stdio-v2-dispatch",
    input: [{ parts: [{ content: "complete through v2 state_update" }] }],
  };
  const v2Response = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify(v2Body),
  });
  assert.equal(v2Response.status, 202, "ACP v2 prompt is accepted before its idle completion notification");
  const v2Deadline = Date.now() + 5_000;
  while (Date.now() < v2Deadline && !events.some((event) => event.dispatch_idempotency_key === "stdio-v2-dispatch" && event.type === "completed")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const v2Completed = events.find((event) => event.dispatch_idempotency_key === "stdio-v2-dispatch" && event.type === "completed");
  assert.ok(v2Completed, "ACP v2 completes only after the idle state_update");
  assert.equal(v2Completed.payload.final_output, "Audit report: café 🌲\nFindings persisted.", "ACP v2 agent_message update becomes the final output");
  const v2ContinuationResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify({ ...v2Body, parent_run_id: "stdio-v2-continuation", attempt_number: 2, dispatch_idempotency_key: "stdio-v2-continuation-dispatch", continuation_id: "stdio-v2-continuation-id" }),
  });
  assert.equal(v2ContinuationResponse.status, 202, "ACP v2 continuation restores its provider session");
  const v2ContinuationDeadline = Date.now() + 5_000;
  while (Date.now() < v2ContinuationDeadline && !events.some((event) => event.dispatch_idempotency_key === "stdio-v2-continuation-dispatch" && event.type === "completed")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(events.some((event) => event.dispatch_idempotency_key === "stdio-v2-continuation-dispatch" && event.type === "completed"),
    "ACP v2 continuation restores and completes the exact provider conversation");
  const v2LimitedResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify({
      ...v2Body,
      parent_run_id: "stdio-v2-limited-run",
      session_id: "stdio-v2-limited-work-session",
      attempt_number: 1,
      dispatch_idempotency_key: "stdio-v2-limited-dispatch",
      input: [{ parts: [{ content: "v2-max" }] }],
    }),
  });
  assert.equal(v2LimitedResponse.status, 202, "ACP v2 accepts the prompt before reporting its terminal reason");
  const v2LimitedDeadline = Date.now() + 5_000;
  while (Date.now() < v2LimitedDeadline && !events.some((event) => event.dispatch_idempotency_key === "stdio-v2-limited-dispatch" && event.type === "failed")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const v2LimitedFailure = events.find((event) => event.dispatch_idempotency_key === "stdio-v2-limited-dispatch" && event.type === "failed");
  assert.ok(v2LimitedFailure, "ACP v2 max_tokens is a failed task, never a successful completion");
  assert.match(JSON.stringify(v2LimitedFailure.payload), /stopReason: max_tokens/);
  const v2SessionMethods = (await readFile(sessionLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(v2SessionMethods.some((entry) => entry.method === "session/resume" && entry.sessionId === "agent-session-v2"),
    "ACP v2 uses session/resume rather than the removed session/load method");
  adapter.kill("SIGTERM");
  await new Promise((resolve) => adapter.once("exit", resolve));
  adapter = spawnAdapter(true, false, v2BusyChildCode);
  const busyReadyDeadline = Date.now() + 5_000;
  let busyReady = false;
  while (Date.now() < busyReadyDeadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${adapterPort}/health`);
      if (health.ok) { busyReady = true; break; }
    } catch { /* busy-session adapter is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(busyReady, "ACP v2 adapter restarts with the persisted provider session binding");
  const busyContinuationKey = "stdio-v2-busy-continuation";
  const busyContinuationResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify({
      ...v2Body,
      parent_run_id: "stdio-v2-busy-continuation-run",
      attempt_number: 3,
      dispatch_idempotency_key: busyContinuationKey,
      continuation_id: "stdio-v2-busy-continuation-id",
      input: [{ parts: [{ content: "wait until the resumed provider session is idle" }] }],
    }),
  });
  assert.equal(busyContinuationResponse.status, 202, "busy resumed-session handling is part of the accepted dispatch lifecycle");
  const busyContinuationDeadline = Date.now() + 5_000;
  while (Date.now() < busyContinuationDeadline && !events.some((event) => event.dispatch_idempotency_key === busyContinuationKey && event.type === "completed")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const busyContinuation = events.find((event) => event.dispatch_idempotency_key === busyContinuationKey && event.type === "completed");
  assert.ok(busyContinuation, "resumed ACP v2 session completes after its idle transition");
  assert.equal(busyContinuation.payload.final_output, "busy session resumed safely",
    "the pre-prompt idle snapshot cannot falsely complete the continuation");
  assert.deepEqual(JSON.parse(await readFile(v2BusyLogPath, "utf8")), { promptBeforeIdle: false },
    "Kontrol waits for the current foreground turn to become idle before sending another prompt");
  adapter.kill("SIGTERM");
  await new Promise((resolve) => adapter.once("exit", resolve));
  adapter = spawnAdapter(true, true);
  const fallbackReadyDeadline = Date.now() + 5_000;
  let fallbackReady = false;
  while (Date.now() < fallbackReadyDeadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${adapterPort}/health`);
      if (health.ok) { fallbackReady = true; break; }
    } catch { /* fallback adapter is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(fallbackReady, "adapter restarts for legacy-agent fallback qualification");
  const fallbackResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify({
      ...v2Body,
      parent_run_id: "stdio-v2-fallback-run",
      session_id: "stdio-v2-fallback-work-session",
      attempt_number: 1,
      dispatch_idempotency_key: "stdio-v2-fallback-dispatch",
    }),
  });
  assert.equal(fallbackResponse.status, 202, "a v1-only agent may negotiate v1 after the adapter requests v2");
  const fallbackDeadline = Date.now() + 5_000;
  while (Date.now() < fallbackDeadline && !events.some((event) => event.dispatch_idempotency_key === "stdio-v2-fallback-dispatch" && event.type === "completed")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(events.some((event) => event.dispatch_idempotency_key === "stdio-v2-fallback-dispatch" && event.type === "completed"),
    "v1 fallback retains v1 prompt-response completion semantics");
  console.log(`acp-stdio-duplex-integration: task reached child stdin; read-only sandbox ${readOnlySandboxAvailable ? "executed" : "failed closed"}`);
} finally {
  adapter.kill("SIGTERM");
  await new Promise((resolve) => adapter.once("exit", resolve));
  await new Promise((resolve) => control.close(resolve));
  await rm(state, { recursive: true, force: true });
}
