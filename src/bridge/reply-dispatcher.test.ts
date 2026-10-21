import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createDispatchOutbox } from "../dispatch-outbox.js";
import { createAgentMessageManager } from "../agent-messages.js";
import { createWorkSessionManager } from "../work-sessions.js";
import { createEventStore } from "../event-log.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import type { BridgeConfig } from "./context.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-reply-dispatcher-test-"));

try {
  const db = openDatabase(root);
  db.sqlite
    .prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
    .run("ws-reply-dispatch");
  const workSessions = createWorkSessionManager(db);
  const session = workSessions.create({ workspaceSessionId: "ws-reply-dispatch", submittedBy: "tester" });
  const eventStore = createEventStore(db);
  const agentMessages = createAgentMessageManager(db);
  const dispatchOutbox = createDispatchOutbox(db);

  const config = {
    workSessions,
    eventStore,
    agentMessages,
    dispatchOutbox,
    knownAgents: [],
  } as unknown as BridgeConfig;

  const question = agentMessages.post({
    workSessionId: session.id,
    kind: "clarification_request",
    title: "which env?",
    body: "staging or production?",
    data: { resumeOnReply: false },
  });
  const reply = agentMessages.acceptReply({
    messageId: question.id,
    workSessionId: session.id,
    body: "production",
    reviewerPrincipalId: "reviewer-a",
  }).reply;
  dispatchOutbox.enqueue({
    eventType: "agent.reply.ready",
    aggregateId: reply.id,
    aggregateRevision: reply.replyRevision,
    payload: { replyId: reply.id, messageId: question.id, workSessionId: session.id },
  });

  const dispatcher = createReplyDispatcher(config);
  await dispatcher.drainOnce();

  const delivered = agentMessages.getReply(reply.id);
  assert.equal(delivered?.status, "pending_delivery", "MCP-capable live-worker reply stays pending without a resume intent");
  const wait = agentMessages.getActiveWaitForMessage(question.id);
  assert.equal(wait?.resumeOnReply ?? false, false);
  const foreign = dispatchOutbox.listPending().filter((event) => event.eventType === "agent.reply.ready");
  assert.equal(foreign.length, 0, "the outbox wake is consumed once; replies remain durable independently");
  assert.equal(agentMessages.listPendingReplies(session.id).some((item) => item.id === reply.id), true, "the MCP worker can recover the unacknowledged reply after reconnect");
  eventStore.close();
  db.close();
  dispatchOutbox.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("bridge/reply-dispatcher.test.ts: all assertions passed");
