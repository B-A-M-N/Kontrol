import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createAgentMessageManager } from "../agent-messages.js";
import { createDispatchOutbox } from "../dispatch-outbox.js";
import { createWorkSessionManager } from "../work-sessions.js";
import { createEventStore } from "../event-log.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-reply-dispatch-test-"));

try {
  const db = openDatabase(root);
  db.sqlite
    .prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
    .run("ws-reply-flow");
  const workSessions = createWorkSessionManager(db);
  const session = workSessions.create({ workspaceSessionId: "ws-reply-flow", submittedBy: "tester" });
  const eventStore = createEventStore(db);
  const agentMessages = createAgentMessageManager(db);
  const outbox = createDispatchOutbox(db);
  const question = agentMessages.post({
    workSessionId: session.id,
    kind: "clarification_request",
    title: "Which deployment?",
    body: "staging or production?",
    data: { resumeOnReply: true },
  });
  agentMessages.waitForReply({
    messageId: question.id,
    workSessionId: session.id,
    runId: "run-original",
    attempt: 1,
    expectsReply: true,
    resumeOnReply: true,
  });
  const reply = agentMessages.acceptReply({
    messageId: question.id,
    workSessionId: session.id,
    body: "production",
    reviewerPrincipalId: "reviewer-a",
  }).reply;
  outbox.enqueue({
    eventType: "agent.reply.ready",
    aggregateId: reply.id,
    aggregateRevision: reply.replyRevision,
    payload: { replyId: reply.id, messageId: question.id, workSessionId: session.id },
  });
  const events = eventStore.getEventsForSession(session.id);
  // The manager itself does not publish UI events; delivery tooling does.
  assert.ok(question.id);
  assert.equal(reply.status, "pending_delivery");
  assert.ok(agentMessages.getActiveWaitForMessage(question.id)?.resumeOnReply);
  eventStore.close();
  db.close();
  workSessions.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("bridge/reply-flow.test.ts: base lifecycle assertions passed");
