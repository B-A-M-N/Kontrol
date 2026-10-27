import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { openDatabase } from "./db/client.js";
import { createAgentRegistryManager } from "./acp-registry.js";
import { createAcpServer } from "./acp-server.js";
import { createEventStore } from "./event-log.js";
import { createWorkSessionManager } from "./work-sessions.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-acp-lifecycle-"));
const cancellationWorkspaceRoot = join(root, "cancellation-workspace");
await mkdir(cancellationWorkspaceRoot);
const database = openDatabase(root);
const agents = createAgentRegistryManager(database);
const workSessions = createWorkSessionManager(database);
const eventStore = createEventStore(database);
const peerRuns: Array<Record<string, unknown>> = [];
let remoteCancelRequests = 0;
const peer = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/runs") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    peerRuns.push(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accepted: true, run_id: `remote-e2e-${peerRuns.length}`, remote_run_id: `remote-e2e-${peerRuns.length}`, status: "running", output: [] }));
    return;
  }
  if (req.method === "POST" && /^\/runs\/remote-e2e-\d+\/cancel$/.test(req.url ?? "")) {
    remoteCancelRequests++;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found", message: "active run not found" } }));
    return;
  }
  res.writeHead(404).end();
});

let cancellationFinalizeCalls = 0;
const cancellationWorkflow = {
  cancelSession({ sessionId }: { sessionId: string }) {
    workSessions.updateStatus(sessionId, "cancelling");
    const run = agents.getRunByWorkSessionId(sessionId);
    if (run) agents.updateRun(run.runId, { status: "cancelling" });
    eventStore.appendEvent({ type: "agent.run.cancellation_requested", sessionId, payload: {} });
    return { status: "cancelling" };
  },
  finalizeCancellation({ sessionId, adapterEvent }: {
    sessionId: string;
    adapterEvent?: { id: string; runId: string; remoteRunId: string; attemptNumber: number; dispatchIdempotencyKey: string };
  }) {
    cancellationFinalizeCalls++;
    workSessions.updateStatus(sessionId, "cancelled");
    const run = agents.getRunByWorkSessionId(sessionId);
    if (run) agents.updateRun(run.runId, { status: "cancelled", finishedAt: new Date().toISOString() });
    eventStore.appendEvent({
      ...(adapterEvent ? { id: adapterEvent.id } : {}),
      type: "agent.run.cancelled",
      sessionId,
      payload: adapterEvent ? {
        runId: adapterEvent.runId,
        remoteRunId: adapterEvent.remoteRunId,
        attemptNumber: adapterEvent.attemptNumber,
        dispatchId: adapterEvent.dispatchIdempotencyKey,
      } : {},
    });
    return { status: "cancelled" };
  },
};

const acpApp = express();
acpApp.use(express.json({ limit: "4mb" }));
acpApp.use("/acp", createAcpServer(
  {
    getWorkspace: (id: string) => {
      if (id === "ws-e2e") return { id, root, mode: "checkout" };
      if (id === "ws-e2e-cancel") return { id, root: cancellationWorkspaceRoot, mode: "checkout" };
      throw new Error(`Unknown workspace: ${id}`);
    },
  } as any,
  workSessions,
  agents,
  "operator-secret",
  "adapter-secret",
  eventStore,
  undefined,
  undefined,
  cancellationWorkflow as any,
  undefined,
  undefined,
  "agent-secret",
  "reviewer-secret",
));

const server = acpApp.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
const acpAddress = server.address();
const peerAddress = peer.address();
const base = `http://127.0.0.1:${typeof acpAddress === "object" && acpAddress ? acpAddress.port : 0}/acp`;
const peerUrl = `http://127.0.0.1:${typeof peerAddress === "object" && peerAddress ? peerAddress.port : 0}`;

async function jsonFetch(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

try {
  database.sqlite.prepare(`
    insert into workspace_sessions
      (id, root, status, mode, managed, created_at, last_used_at)
    values (?, ?, 'active', 'worktree', 'false', ?, ?)
  `).run("ws-e2e", root, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  database.sqlite.prepare(`
    insert into workspace_sessions
      (id, root, status, mode, managed, created_at, last_used_at)
    values (?, ?, 'active', 'worktree', 'false', ?, ?)
  `).run("ws-e2e-cancel", cancellationWorkspaceRoot, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

  const registration = await jsonFetch("/agents/register", {
    method: "POST",
    headers: { Authorization: "Bearer agent-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "e2e-peer", url: peerUrl, role: "agent" }),
  });
  assert.equal(registration.status, 201, "agent registration is a real HTTP operation");
  const agentId = registration.body.id as string;
  const agentCredential = registration.body.agentCredential as string;
  assert.ok(agentId && agentCredential, "new registration returns one usable credential");

  const dispatch = await jsonFetch("/runs", {
    method: "POST",
    headers: { Authorization: "Bearer reviewer-secret", "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_name: "e2e-peer",
      workspace_id: "ws-e2e",
      mode: "async",
      input: [{ parts: [{ content: "run the lifecycle contract" }] }],
    }),
  });
  assert.equal(dispatch.status, 202, "dispatch reaches the registered peer");
  assert.equal(peerRuns.length, 1);
  assert.equal(peerRuns[0]?.agent_id, agentId);
  assert.equal(peerRuns[0]?.workspace_session_id, "ws-e2e");
  assert.equal(peerRuns[0]?.attempt_number, 1, "dispatch binds the adapter events to the current attempt");
  assert.ok(peerRuns[0]?.workspace_lease_expires_at, "dispatch gives the adapter its initial lease deadline");
  const runId = dispatch.body.kontrol_run_id as string;
  const sessionId = dispatch.body.session_id as string;
  assert.ok(runId && sessionId);
  const terminalDispatchKey = "acp-lifecycle-terminal-receipt";
  agents.beginDispatchAttempt({ key: terminalDispatchKey, runId, agentId, attemptNumber: 1 });
  agents.updateDispatchAttempt(terminalDispatchKey, { status: "accepted", remoteRunId: "remote-e2e-1" });

  const workspaceLeaseNonce = peerRuns[0]?.workspace_lease_nonce as string | undefined;
  assert.ok(workspaceLeaseNonce, "dispatch gives the adapter its checkout fencing nonce");
  const lifecycle = async (
    type: string,
    payload?: Record<string, unknown>,
    leaseNonce?: string,
    eventId?: string,
  ) => jsonFetch(`/runs/${encodeURIComponent(runId)}/events`, {
    method: "POST",
    headers: {
      Authorization: "Bearer agent-secret",
      "Content-Type": "application/json",
      "x-kontrol-agent-id": agentId,
      "x-kontrol-agent-credential": agentCredential,
    },
    body: JSON.stringify({
      type,
      remote_run_id: "remote-e2e-1",
      attempt_number: 1,
      event_id: eventId,
      agent_id: agentId,
      work_session_id: sessionId,
      workspace_lease_nonce: leaseNonce,
      payload,
    }),
  });

  const missingNonce = await lifecycle("heartbeat", undefined, undefined);
  assert.equal(missingNonce.status, 409, "lease renewal without a fencing nonce is rejected");
  assert.equal(missingNonce.body.error?.code, "workspace_lease_lost");
  const started = await lifecycle("started", undefined, workspaceLeaseNonce);
  assert.equal(started.status, 202);
  assert.ok(started.body.workspace_lease_expires_at, "lease renewal acknowledgement carries its new expiry");
  const heartbeatBeforeStaleAttempt = agents.getRun(runId)?.lastHeartbeatAt;
  const staleNonce = await lifecycle("heartbeat", undefined, "stale-fencing-token");
  assert.equal(staleNonce.status, 409, "a stale worker generation cannot renew the lease");
  assert.equal(staleNonce.body.error?.code, "workspace_lease_lost");
  assert.equal(agents.getRun(runId)?.lastHeartbeatAt, heartbeatBeforeStaleAttempt,
    "rejected lease renewals do not update worker heartbeat state");
  const outputEvent = await lifecycle("output_delta", {
    text: "working",
    runId: "spoofed-run",
    remoteRunId: "spoofed-remote-run",
    attemptNumber: 999,
    dispatchId: "spoofed-dispatch",
    workSessionId: "spoofed-session",
    eventId: "spoofed-event",
  }, workspaceLeaseNonce, "telemetry-output-1");
  assert.equal(outputEvent.status, 202);
  const ingressReceipt = database.sqlite.prepare("select status, payload_json from telemetry_ingress where event_id = ?")
    .get("telemetry-output-1") as { status: string; payload_json?: string | null } | undefined;
  assert.ok(ingressReceipt, "the adapter fragment receipt is committed before HTTP 202 is sent");
  const projectedOutput = JSON.parse(ingressReceipt.payload_json!);
  assert.equal(projectedOutput.text, "working");
  assert.equal(projectedOutput.runId, runId, "adapter payload cannot replace the trusted run identity");
  assert.equal(projectedOutput.remoteRunId, "remote-e2e-1", "adapter payload cannot replace the trusted remote run identity");
  assert.equal(projectedOutput.attemptNumber, 1, "adapter payload cannot replace the trusted attempt number");
  assert.notEqual(projectedOutput.dispatchId, "spoofed-dispatch", "adapter payload cannot replace the trusted dispatch identity");
  assert.equal(projectedOutput.workSessionId, sessionId, "adapter payload cannot replace the trusted work session");
  assert.equal(projectedOutput.eventId, "telemetry-output-1", "adapter payload cannot replace the trusted event identity");
  const duplicateOutput = await lifecycle("output_delta", { text: "working" }, workspaceLeaseNonce, "telemetry-output-1");
  assert.equal(duplicateOutput.status, 202);
  assert.equal(duplicateOutput.body.duplicate, true, "event-id retries are recognized while coalescing is still pending");
  const completed = await lifecycle("completed", { final_output: "done ✅" }, workspaceLeaseNonce, "terminal-event-1");
  assert.equal(completed.status, 202);
  assert.equal(completed.body.status, "completed", "authenticated lifecycle completion updates the durable run");
  assert.equal(agents.getRun(runId)?.status, "completed");
  assert.equal(agents.getRun(runId)?.remoteRunId, "remote-e2e-1");
  assert.equal(completed.body.dispatch_receipt_acknowledged, true,
    "Kontrol acknowledges adapter receipt retention only after persisting the current attempt's terminal event");
  assert.equal(completed.body.dispatch_idempotency_key, terminalDispatchKey);
  assert.equal(completed.body.remote_run_id, "remote-e2e-1");
  assert.equal(completed.body.attempt_number, 1);
  assert.equal(completed.body.event_id, "terminal-event-1");
  const duplicateCompletion = await lifecycle("completed", { final_output: "done ✅" }, workspaceLeaseNonce, "terminal-event-1");
  assert.equal(duplicateCompletion.body.duplicate, true);
  assert.equal(duplicateCompletion.body.dispatch_receipt_acknowledged, true,
    "a retried terminal event repeats the same durable acknowledgement after a lost HTTP response");
  assert.equal(workSessions.get(sessionId)?.workspaceSessionId, "ws-e2e");

  const destinationRegistration = await jsonFetch("/agents/register", {
    method: "POST",
    headers: { Authorization: "Bearer agent-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "destination-peer", url: peerUrl, role: "agent" }),
  });
  assert.equal(destinationRegistration.status, 201);
  const destinationAgentId = destinationRegistration.body.id as string;
  const destinationAgentCredential = destinationRegistration.body.agentCredential as string;
  const nextDispatchKey = "acp-lifecycle-next-attempt";
  agents.beginDispatchAttempt({ key: nextDispatchKey, runId, agentId: destinationAgentId, attemptNumber: 2 });
  agents.updateDispatchAttempt(nextDispatchKey, { status: "accepted", remoteRunId: "remote-e2e-2" });
  agents.updateRun(runId, {
    status: "running",
    remoteRunId: "remote-e2e-2",
    attemptNumber: 2,
    outputPreview: "",
    outputJson: "",
    finishedAt: undefined,
  });
  const latePriorTerminal = await jsonFetch(`/runs/${encodeURIComponent(runId)}/events`, {
    method: "POST",
    headers: {
      Authorization: "Bearer agent-secret",
      "Content-Type": "application/json",
      "x-kontrol-agent-id": agentId,
      "x-kontrol-agent-credential": agentCredential,
    },
    body: JSON.stringify({
      type: "completed",
      remote_run_id: "remote-e2e-1",
      attempt_number: 1,
      dispatch_idempotency_key: terminalDispatchKey,
      event_id: "late-prior-terminal-event",
      agent_id: agentId,
      work_session_id: sessionId,
      payload: { final_output: "late output from attempt one" },
    }),
  });
  assert.equal(latePriorTerminal.status, 202);
  assert.equal(latePriorTerminal.body.dispatch_receipt_acknowledged, true,
    "a durable late terminal event is acknowledged against its exact superseded dispatch attempt");
  assert.equal(latePriorTerminal.body.dispatch_idempotency_key, terminalDispatchKey);
  assert.equal(latePriorTerminal.body.attempt_number, 1);
  assert.equal(latePriorTerminal.body.event_id, "late-prior-terminal-event");
  assert.equal(agents.getRun(runId)?.status, "running");
  assert.equal(agents.getRun(runId)?.attemptNumber, 2,
    "a terminal event from an older attempt cannot overwrite the current attempt state");

  const hermesFailure = await jsonFetch(`/runs/${encodeURIComponent(runId)}/events`, {
    method: "POST",
    headers: {
      Authorization: "Bearer agent-secret",
      "Content-Type": "application/json",
      "x-kontrol-agent-id": destinationAgentId,
      "x-kontrol-agent-credential": destinationAgentCredential,
    },
    body: JSON.stringify({
      type: "failed",
      remote_run_id: "remote-e2e-2",
      attempt_number: 2,
      dispatch_idempotency_key: nextDispatchKey,
      event_id: "hermes-failure-terminal",
      agent_id: destinationAgentId,
      work_session_id: sessionId,
      payload: {
        error: "deadman idle timeout; Authorization: Bearer lifecycle-secret-token",
        stderr: "Traceback summary; Authorization: Bearer lifecycle-secret-token",
        exit_code: 1,
        signal: "SIGTERM",
      },
    }),
  });
  assert.equal(hermesFailure.status, 202);
  assert.equal(agents.getRun(runId)?.agentId, agentId,
    "destination lifecycle events do not rewrite the logical run's original agent identity");
  assert.equal(agents.getDispatchAttemptByIdempotencyKey(nextDispatchKey)?.agentId, destinationAgentId,
    "the destination identity remains attached to its own immutable dispatch attempt");
  const persistedHermesFailure = eventStore.getEventById("hermes-failure-terminal");
  const persistedFailureEvidence = persistedHermesFailure?.payload.workerFailureEvidence as Record<string, unknown> | undefined;
  assert.equal(persistedFailureEvidence?.category, "timeout",
    "terminal Hermes deadman failures retain a specific timeout classification");
  assert.match(String(persistedFailureEvidence?.reason), /deadman idle timeout/);
  assert.match(String(persistedFailureEvidence?.sanitizedStderrTail), /Traceback summary/);
  assert.doesNotMatch(JSON.stringify(persistedHermesFailure?.payload), /lifecycle-secret-token/,
    "raw error and stderr are removed after their bounded diagnostics are redacted");
  assert.equal(persistedHermesFailure?.payload.stderr, undefined);
  assert.equal(persistedHermesFailure?.payload.error, undefined);

  const cancellationDispatch = await jsonFetch("/runs", {
    method: "POST",
    headers: { Authorization: "Bearer reviewer-secret", "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_name: "e2e-peer",
      workspace_id: "ws-e2e-cancel",
      mode: "async",
      input: [{ parts: [{ content: "run the cancellation 404 contract" }] }],
    }),
  });
  assert.equal(cancellationDispatch.status, 202);
  const cancellationRunId = cancellationDispatch.body.kontrol_run_id as string;
  const cancellationSessionId = cancellationDispatch.body.session_id as string;
  const cancellationResponse = await jsonFetch(`/runs/${encodeURIComponent(cancellationRunId)}/cancel`, {
    method: "POST",
    headers: { Authorization: "Bearer reviewer-secret" },
  });
  assert.equal(cancellationResponse.status, 202);
  assert.equal(cancellationResponse.body.status, "cancelling",
    "adapter 404 means no active run, not confirmed worker shutdown");
  assert.equal(cancellationResponse.body.remote_cancellation.status, 404);
  assert.equal(remoteCancelRequests, 1);
  assert.equal(cancellationFinalizeCalls, 0, "adapter 404 cannot finalize cancellation");
  assert.equal(workSessions.get(cancellationSessionId)?.status, "cancelling");
  assert.equal(agents.getRun(cancellationRunId)?.status, "cancelling");
  assert.equal(eventStore.getEventsForSession(cancellationSessionId).some((event) => event.type === "agent.run.cancelled"), false,
    "an adapter 404 does not fabricate a durable worker-cancelled event");

  const cancellationRemoteRunId = "remote-e2e-2";
  const cancellationAttemptKey = "acp-lifecycle-cancel-terminal";
  agents.beginDispatchAttempt({ key: cancellationAttemptKey, runId: cancellationRunId, agentId, attemptNumber: 1 });
  agents.updateDispatchAttempt(cancellationAttemptKey, { status: "accepted", remoteRunId: cancellationRemoteRunId });
  const cancellationEventBody = {
    type: "cancelled",
    remote_run_id: cancellationRemoteRunId,
    attempt_number: 1,
    event_id: "cancel-terminal-event-1",
    agent_id: agentId,
    work_session_id: cancellationSessionId,
    payload: { message: "worker confirmed cancellation" },
  };
  const cancelled = await jsonFetch(`/runs/${encodeURIComponent(cancellationRunId)}/events`, {
    method: "POST",
    headers: {
      Authorization: "Bearer agent-secret",
      "Content-Type": "application/json",
      "x-kontrol-agent-id": agentId,
      "x-kontrol-agent-credential": agentCredential,
    },
    body: JSON.stringify(cancellationEventBody),
  });
  assert.equal(cancelled.status, 202);
  assert.equal(cancelled.body.dispatch_receipt_acknowledged, true,
    "workflow-finalized cancellation acknowledges only after persisting the exact adapter event ID");
  assert.equal(cancelled.body.event_id, cancellationEventBody.event_id);
  const persistedCancellationEvent = eventStore.getEventById(cancellationEventBody.event_id);
  assert.equal(persistedCancellationEvent?.payload?.dispatchId, cancellationAttemptKey);
  const duplicateCancelled = await jsonFetch(`/runs/${encodeURIComponent(cancellationRunId)}/events`, {
    method: "POST",
    headers: {
      Authorization: "Bearer agent-secret",
      "Content-Type": "application/json",
      "x-kontrol-agent-id": agentId,
      "x-kontrol-agent-credential": agentCredential,
    },
    body: JSON.stringify(cancellationEventBody),
  });
  assert.equal(duplicateCancelled.body.duplicate, true);
  assert.equal(duplicateCancelled.body.dispatch_receipt_acknowledged, true,
    "a retried workflow cancellation repeats the acknowledgement from its persisted event identity");

  console.log("acp-lifecycle.test.ts: all assertions passed");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => peer.close(() => resolve()));
  agents.close();
  eventStore.close();
  workSessions.close();
  database.close();
  await rm(root, { recursive: true, force: true });
}
