import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpServer } from "./acp-server.js";
import { createAgentRegistryManager, FINAL_RESULT_MAX_BYTES, serializeFinalAcpResult } from "./acp-registry.js";
import { createApprovalRequestManager } from "./approval-requests.js";
import { openDatabase } from "./db/client.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-acp-identity-"));
const db = openDatabase(root);
const agents = createAgentRegistryManager(db);
const approvals = createApprovalRequestManager(db);
const app = express();
app.use(express.json());
app.use("/acp", createAcpServer(
  { getWorkspace: () => ({ id: "ws-identity", root: "/tmp", mode: "checkout" }) } as any,
  { get: () => undefined } as any,
  agents,
  "operator-secret",
  "adapter-secret",
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  approvals,
  "agent-secret",
  "reviewer-secret",
));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/acp`;

async function jsonFetch(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

try {
  const hostileResult = serializeFinalAcpResult({
    run_id: "run-hostile",
    status: "completed",
    error: "💥".repeat(FINAL_RESULT_MAX_BYTES),
    diagnostic: { nested: "x".repeat(FINAL_RESULT_MAX_BYTES) },
  }, "尾部\n\\".repeat(FINAL_RESULT_MAX_BYTES));
  assert.ok(Buffer.byteLength(hostileResult, "utf8") <= FINAL_RESULT_MAX_BYTES, "final ACP result stays within its UTF-8 byte budget");
  assert.doesNotThrow(() => JSON.parse(hostileResult), "bounded final ACP result remains valid JSON");

  const first = await jsonFetch("/agents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer agent-secret" },
    body: JSON.stringify({ name: "identity-a", url: "http://127.0.0.1:9001", role: "agent" }),
  });
  assert.equal(first.status, 201);
  assert.equal(typeof first.body.id, "string");
  assert.match(first.body.agentCredential, /^agcred_/);
  const identityA = { id: first.body.id as string, credential: first.body.agentCredential as string };

  const takeover = await jsonFetch("/agents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer agent-secret" },
    body: JSON.stringify({ name: "identity-a", url: "http://127.0.0.1:9002", role: "agent" }),
  });
  assert.equal(takeover.status, 409, "bootstrap secret alone cannot re-register an existing identity");

  const wrongCredential = await jsonFetch("/agents/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer agent-secret",
      "x-kontrol-agent-id": identityA.id,
      "x-kontrol-agent-credential": "agcred-wrong",
    },
    body: JSON.stringify({ name: "identity-a", url: "http://127.0.0.1:9002", role: "agent" }),
  });
  assert.equal(wrongCredential.status, 403);

  const reregis = await jsonFetch("/agents/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer agent-secret",
      "x-kontrol-agent-id": identityA.id,
      "x-kontrol-agent-credential": identityA.credential,
    },
    body: JSON.stringify({ name: "identity-a", url: "http://127.0.0.1:9002", role: "agent" }),
  });
  assert.equal(reregis.status, 201);
  assert.equal(reregis.body.id, identityA.id);
  assert.equal(reregis.body.agentCredential, undefined, "re-registration does not expose the stored raw credential");

  const rotated = await jsonFetch(`/agents/${encodeURIComponent(identityA.id)}/credential/rotate`, {
    method: "POST",
    headers: { Authorization: "Bearer operator-secret" },
  });
  assert.equal(rotated.status, 200);
  assert.match(rotated.body.agentCredential, /^agcred_/);
  assert.equal(agents.verifyAgentCredential(identityA.id, identityA.credential), false, "rotation invalidates the old credential");
  assert.equal(agents.verifyAgentCredential(identityA.id, rotated.body.agentCredential), true);

  const heartbeat = await jsonFetch(`/agents/${encodeURIComponent(identityA.id)}/heartbeat`, {
    method: "POST",
    headers: {
      Authorization: "Bearer agent-secret",
      "x-kontrol-agent-id": identityA.id,
      "x-kontrol-agent-credential": rotated.body.agentCredential,
    },
  });
  assert.equal(heartbeat.status, 200);

  const second = agents.register({ name: "identity-b", url: "http://127.0.0.1:9003", role: "agent" });
  assert.ok(second.agentCredential);
  const run = agents.createRun({
    agentName: "identity-a",
    agentId: identityA.id,
    workspaceSessionId: "ws-identity",
    workSessionId: "work-identity",
    status: "running",
  });
  const event = await jsonFetch(`/runs/${encodeURIComponent(run.runId)}/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer agent-secret",
      "x-kontrol-agent-id": identityA.id,
      "x-kontrol-agent-credential": rotated.body.agentCredential,
    },
    body: JSON.stringify({
      type: "permission.requested",
      work_session_id: "work-identity",
      payload: { title: "Needs approval", wait: false },
    }),
  });
  assert.equal(event.status, 202);
  const approvalId = event.body.approval_id as string;
  assert.ok(approvalId);

  const crossAgentRead = await jsonFetch(`/approvals/${encodeURIComponent(approvalId)}`, {
    headers: {
      Authorization: "Bearer agent-secret",
      "x-kontrol-agent-id": second.id,
      "x-kontrol-agent-credential": second.agentCredential!,
    },
  });
  assert.equal(crossAgentRead.status, 403);
  const crossAgentPoll = await jsonFetch(`/approvals/${encodeURIComponent(approvalId)}/decision`, {
    headers: {
      Authorization: "Bearer agent-secret",
      "x-kontrol-agent-id": second.id,
      "x-kontrol-agent-credential": second.agentCredential!,
    },
  });
  assert.equal(crossAgentPoll.status, 403);

  const ownerRead = await jsonFetch(`/approvals/${encodeURIComponent(approvalId)}`, {
    headers: {
      Authorization: "Bearer agent-secret",
      "x-kontrol-agent-id": identityA.id,
      "x-kontrol-agent-credential": rotated.body.agentCredential,
    },
  });
  assert.equal(ownerRead.status, 200);
  const revoked = await jsonFetch(`/agents/${encodeURIComponent(identityA.id)}/credential`, {
    method: "DELETE",
    headers: { Authorization: "Bearer operator-secret" },
  });
  assert.equal(revoked.status, 204);
  assert.equal(agents.verifyAgentCredential(identityA.id, rotated.body.agentCredential), false, "revocation invalidates the credential");
  console.log("acp-identity.test.ts: all assertions passed");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  approvals.close();
  agents.close();
  await rm(root, { recursive: true, force: true });
}
