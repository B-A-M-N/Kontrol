import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { createAgentMessageManager } from "./agent-messages.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-agent-replies-test-"));

try {
  const db = openDatabase(root);
  db.sqlite
    .prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
    .run("ws-replies");
  db.sqlite
    .prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values (?, ?, ?, 'in_progress', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
    .run("wsess-replies", "ws-replies", "tester");
  const messages = createAgentMessageManager(db);
  const question = messages.post({
    workSessionId: "wsess-replies",
    kind: "clarification_request",
    title: "Which environment?",
    body: "staging or production?",
    data: { expectsReply: true, resumeOnReply: true },
  });
  const reply = messages.acceptReply({
    messageId: question.id,
    workSessionId: "wsess-replies",
    body: "production",
    reviewerPrincipalId: "reviewer-a",
  }).reply;
  assert.match(reply.id, /^reply_/);
  assert.equal(reply.status, "pending_delivery");
  assert.equal(reply.replyRevision, 1);
  const dispatching = messages.recordReplyDispatch({
    replyId: reply.id,
    expectedStatus: "pending_delivery",
    nextStatus: "dispatching",
    dispatchIdempotencyKey: "reply-dispatch-1",
    runId: "run-a",
    attemptNumber: 2,
  });
  assert.equal(dispatching?.status, "dispatching");
  const awaitingAck = messages.recordReplyDispatch({
    replyId: reply.id,
    expectedStatus: "dispatching",
    nextStatus: "awaiting_acknowledgement",
    dispatchIdempotencyKey: "reply-dispatch-1",
    runId: "run-a",
    attemptNumber: 2,
    remoteRunId: "remote-2",
  });
  assert.equal(awaitingAck?.status, "awaiting_acknowledgement");
  assert.equal(awaitingAck?.deliveryDispatchIdempotencyKey, "reply-dispatch-1");
  assert.equal(awaitingAck?.deliveryRunId, "run-a");
  assert.equal(awaitingAck?.deliveryRemoteRunId, "remote-2");
  assert.equal(messages.listPendingReplies("wsess-replies")[0]?.id, reply.id,
    "accepted but unacknowledged replies remain recoverable without becoming undispatched work");
  assert.equal(messages.recordReplyDispatch({
    replyId: reply.id,
    expectedStatus: "awaiting_acknowledgement",
    nextStatus: "dispatching",
    dispatchIdempotencyKey: "different-reply-dispatch",
    runId: "run-b",
    attemptNumber: 3,
  }), undefined, "a reply cannot be rebound to a different delivery identity");
  let conflict = false;
  try {
    messages.acceptReply({
      messageId: question.id,
      workSessionId: "wsess-replies",
      body: "staging",
      reviewerPrincipalId: "reviewer-a",
    });
  } catch {
    conflict = true;
  }
  assert.ok(conflict, "second conflicting answer cannot replace the accepted answer");
  assert.throws(() => messages.acknowledgeReply({
    replyId: reply.id,
    workSessionId: "wsess-replies",
    runId: "run-a",
    attempt: 3,
    actorId: "worker-a",
  }), /accepted delivery attempt/, "the worker must acknowledge the exact accepted attempt");
  const ack = messages.acknowledgeReply({
    replyId: reply.id,
    workSessionId: "wsess-replies",
    runId: "run-a",
    attempt: 2,
    actorId: "worker-a",
  }).reply;
  assert.equal(ack.status, "acknowledged");
  assert.equal(ack.acknowledgedRunId, "run-a");
  const repeated = messages.acknowledgeReply({
    replyId: reply.id,
    workSessionId: "wsess-replies",
    runId: "run-a",
    attempt: 2,
    actorId: "worker-a",
  }).reply;
  assert.equal(repeated.id, ack.id, "idempotent acknowledgement returns existing receipt");
  let foreign = false;
  try {
    messages.acknowledgeReply({
      replyId: reply.id,
      workSessionId: "wsess-replies",
      runId: "run-b",
      attempt: 1,
      actorId: "worker-b",
    });
  } catch {
    foreign = true;
  }
  assert.ok(foreign, "a different run/attempt cannot overwrite acknowledgement authority");
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("agent-message-replies.test.ts: all assertions passed");
