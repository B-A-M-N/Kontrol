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
  });
  assert.match(reply.id, /^reply_/);
  assert.equal(reply.status, "pending_delivery");
  assert.equal(reply.replyRevision, 1);
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
  const ack = messages.acknowledgeReply({
    replyId: reply.id,
    workSessionId: "wsess-replies",
    runId: "run-a",
    attempt: 2,
    actorId: "worker-a",
  });
  assert.equal(ack.status, "acknowledged");
  assert.equal(ack.acknowledgedRunId, "run-a");
  const repeated = messages.acknowledgeReply({
    replyId: reply.id,
    workSessionId: "wsess-replies",
    runId: "run-a",
    attempt: 2,
    actorId: "worker-a",
  });
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
