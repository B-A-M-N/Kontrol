import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { openDatabase } from "./db/client.js";
import { createAgentRegistryManager } from "./acp-registry.js";
import { createAcpServer } from "./acp-server.js";
import { createEventStore } from "./event-log.js";
import { createWorkSessionManager } from "./work-sessions.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-acp-lifecycle-"));
const database = openDatabase(root);
const agents = createAgentRegistryManager(database);
const workSessions = createWorkSessionManager(database);
const eventStore = createEventStore(database);
const peerRuns: Array<Record<string, unknown>> = [];
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
    res.end(JSON.stringify({ accepted: true, remote_run_id: "remote-e2e-1", status: "running", output: [] }));
    return;
  }
  res.writeHead(404).end();
});

const acpApp = express();
acpApp.use(express.json({ limit: "4mb" }));
acpApp.use("/acp", createAcpServer(
  {
    getWorkspace: (id: string) => {
      if (id !== "ws-e2e") throw new Error(`Unknown workspace: ${id}`);
      return { id, root, mode: "checkout" };
    },
  } as any,
  workSessions,
  agents,
  "operator-secret",
  "adapter-secret",
  eventStore,
  undefined,
  undefined,
  undefined,
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
  const outputEvent = await lifecycle("output_delta", { text: "working" }, workspaceLeaseNonce, "telemetry-output-1");
  assert.equal(outputEvent.status, 202);
  const ingressReceipt = database.sqlite.prepare("select status, payload_json from telemetry_ingress where event_id = ?")
    .get("telemetry-output-1") as { status: string; payload_json?: string | null } | undefined;
  assert.ok(ingressReceipt, "the adapter fragment receipt is committed before HTTP 202 is sent");
  assert.equal(JSON.parse(ingressReceipt.payload_json!).text, "working");
  const duplicateOutput = await lifecycle("output_delta", { text: "working" }, workspaceLeaseNonce, "telemetry-output-1");
  assert.equal(duplicateOutput.status, 202);
  assert.equal(duplicateOutput.body.duplicate, true, "event-id retries are recognized while coalescing is still pending");
  const completed = await lifecycle("completed", { final_output: "done ✅" }, workspaceLeaseNonce);
  assert.equal(completed.status, 202);
  assert.equal(completed.body.status, "completed", "authenticated lifecycle completion updates the durable run");
  assert.equal(agents.getRun(runId)?.status, "completed");
  assert.equal(agents.getRun(runId)?.remoteRunId, "remote-e2e-1");
  assert.equal(workSessions.get(sessionId)?.workspaceSessionId, "ws-e2e");

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
