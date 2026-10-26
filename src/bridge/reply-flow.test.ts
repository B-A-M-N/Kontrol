import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createAgentMessageManager } from "../agent-messages.js";
import { createDispatchOutbox } from "../dispatch-outbox.js";
import { createWorkSessionManager } from "../work-sessions.js";
import { createEventStore } from "../event-log.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { registerReplyTools } from "./reply-tools.js";

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

  // A reviewer reply may commit after the agent posts its question but before
  // the worker's await call creates a durable wait binding. The dispatcher can
  // consume the wake safely because await_agent_reply checks durable replies
  // immediately after registering that late wait.
  const lateWaitQuestion = agentMessages.post({
    workSessionId: session.id,
    kind: "clarification_request",
    title: "Reply before wait",
    body: "Which environment should I use?",
    data: { resumeOnReply: true },
  });
  const earlyReply = agentMessages.acceptReply({
    messageId: lateWaitQuestion.id,
    workSessionId: session.id,
    body: "Use staging.",
    reviewerPrincipalId: "reviewer-a",
  }).reply;
  outbox.enqueue({
    eventType: "agent.reply.ready",
    aggregateId: earlyReply.id,
    aggregateRevision: earlyReply.replyRevision,
    payload: { replyId: earlyReply.id, messageId: lateWaitQuestion.id, workSessionId: session.id },
  });
  await createReplyDispatcher({ workSessions, eventStore, agentMessages, dispatchOutbox: outbox } as never).drainOnce();
  const replyToolHandlers = new Map<string, (input: any) => Promise<any>>();
  registerReplyTools({
    registerTool(name: string, _definition: unknown, handler: (input: any) => Promise<any>) {
      replyToolHandlers.set(name, handler);
    },
  } as never, {
    workSessions,
    eventStore,
    agentMessages,
    agentRegistry: { getRunByWorkSessionId: () => undefined },
    principalRole: "worker",
    connectionWorkSessionId: session.id,
  } as never);
  const lateWaitResult = await replyToolHandlers.get("await_agent_reply")!({
    sessionId: session.id,
    messageId: lateWaitQuestion.id,
    timeoutMs: 1_000,
  });
  assert.equal(lateWaitResult.structuredContent.status, "reply_ready",
    "a reply committed before its wait is surfaced immediately instead of being lost with the dispatcher wake");
  assert.equal(lateWaitResult.structuredContent.replyId, earlyReply.id);
  assert.equal(lateWaitResult.structuredContent.body, "Use staging.");
  eventStore.close();
  db.close();
  workSessions.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("bridge/reply-flow.test.ts: base lifecycle assertions passed");
