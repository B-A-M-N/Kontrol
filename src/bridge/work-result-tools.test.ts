import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createAgentMessageManager } from "../agent-messages.js";
import { createEventStore } from "../event-log.js";
import { createWorkSessionManager } from "../work-sessions.js";
import { createAgentRegistryManager } from "../acp-registry.js";
import { registerMessageTools } from "./message-tools.js";
import { projectWorkResult, registerWorkResultTools } from "./work-result-tools.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-work-result-test-"));

try {
  const db = openDatabase(root);
  db.sqlite
    .prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
    .run("ws-result");
  const workSessions = createWorkSessionManager(db);
  const session = workSessions.create({ workspaceSessionId: "ws-result", submittedBy: "tester" });
  const eventStore = createEventStore(db);
  const agentMessages = createAgentMessageManager(db);
  const agentRegistry = createAgentRegistryManager(db);

  // Seed a dispatched run + accepted attempt + message + event.
  const run = agentRegistry.createRun({ agentName: "test-agent", workSessionId: session.id, workspaceSessionId: "ws-result", status: "running" });
  agentRegistry.beginDispatchAttempt({ key: "key-1", runId: run.runId, attemptNumber: 1 });
  agentRegistry.updateDispatchAttempt("key-1", { status: "accepted", remoteRunId: "remote-1" });
  const msg = agentMessages.post({ workSessionId: session.id, runId: run.runId, kind: "clarification_request", title: "Q", body: "Which region?" });
  eventStore.appendEvent({ type: "agent.message.posted", sessionId: session.id, payload: { messageId: msg.id } });

  const projection = projectWorkResult(
    { workSessions, eventStore, agentMessages, agentRegistry } as never,
    session.id,
  );
  assert.ok(projection, "projection exists for a known session");
  assert.equal(projection!.session.sessionId, session.id);
  assert.equal(projection!.run!.runId, run.runId);
  assert.equal(projection!.dispatch.status, "accepted");
  assert.equal(projection!.dispatch.idempotencyKey, "key-1");
  assert.equal(projection!.messages.length, 1);
  assert.equal(projection!.messages[0]!.body, "Which region?");
  assert.equal(projection!.outcome.terminal, false);
  assert.equal(projectWorkResult({ workSessions, eventStore, agentMessages, agentRegistry } as never, "missing"), undefined, "unknown session projects to undefined (tool fails closed)");

  // Tool registration + reviewer post + read gate.
  const handlers = new Map<string, (input: any) => Promise<any>>();
  const stubServer = {
    registerTool(name: string, _definition: unknown, handler: (input: any) => Promise<any>) { handlers.set(name, handler); },
  } as never;
  const reviewerConfig = {
    workSessions, eventStore, agentMessages, agentRegistry,
    principalRole: "reviewer",
    principalId: "reviewer-1",
    db,
  } as never;
  registerWorkResultTools(stubServer, reviewerConfig);
  registerMessageTools(stubServer, reviewerConfig);
  assert.ok(handlers.has("get_work_result"), "get_work_result is registered");
  assert.ok(handlers.has("post_reviewer_message"), "post_reviewer_message is registered");

  const result = await handlers.get("get_work_result")!({ sessionId: session.id });
  assert.equal(result.isError, undefined, "reviewer can read the unified result");
  assert.equal(result.structuredContent.dispatch.status, "accepted");
  assert.equal(result.structuredContent.run.runId, run.runId);
  assert.equal(result.structuredContent.messages[0].body, "Which region?");

  const unknown = await handlers.get("get_work_result")!({ sessionId: "missing" });
  assert.ok(unknown.isError, "unknown session fails closed");

  const posted = await handlers.get("post_reviewer_message")!({ sessionId: session.id, body: "Use us-east." });
  assert.equal(posted.isError, undefined, "reviewer can message the active worker");
  const after = projectWorkResult({ workSessions, eventStore, agentMessages, agentRegistry } as never, session.id)!;
  assert.ok(after.messages.some((m) => m.author === "reviewer" && m.body === "Use us-east."), "reviewer note is durable and visible in the projection");
  assert.ok(after.events.recent.some((e) => e.type === "reviewer.message.posted"), "reviewer note emits a durable event");

  // Worker role cannot post reviewer messages (workers cannot self-approve / self-message as reviewer).
  const workerConfig = {
    workSessions, eventStore, agentMessages, agentRegistry,
    principalRole: "worker",
    principalId: "reviewer-1",
    connectionWorkSessionId: session.id,
    db,
  } as never;
  const workerHandlers = new Map<string, (input: any) => Promise<any>>();
  const workerServer = { registerTool(name: string, _d: unknown, h: (i: any) => Promise<any>) { workerHandlers.set(name, h); } } as never;
  registerMessageTools(workerServer, workerConfig);
  const forbiddenPost = await workerHandlers.get("post_reviewer_message")!({ sessionId: session.id, body: "spoof" });
  assert.ok(forbiddenPost.isError, "worker cannot post as reviewer");

  // Terminal session fails closed.
  workSessions.updateStatus(session.id, "approved");
  const terminalPost = await handlers.get("post_reviewer_message")!({ sessionId: session.id, body: "too late" });
  assert.ok(terminalPost.isError, "terminal session rejects reviewer messages");

  console.log("work-result-tools.test: all assertions passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
