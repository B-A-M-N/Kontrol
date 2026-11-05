import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createAgentMessageManager } from "../agent-messages.js";
import { createEventStore } from "../event-log.js";
import { createWorkSessionManager } from "../work-sessions.js";
import { registerMessageTools } from "./message-tools.js";
import { registerReplyTools } from "./reply-tools.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-message-isolation-test-"));

function isForbidden(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const value = result as { isError?: unknown; content?: unknown };
  if (value.isError !== true || !Array.isArray(value.content)) return false;
  return value.content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" && /forbidden/i.test(text);
  });
}

try {
  const db = openDatabase(root);
  db.sqlite
    .prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
    .run("ws-isolation");
  db.sqlite
    .prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp-b', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
    .run("ws-isolation-b");
  const workSessions = createWorkSessionManager(db);
  const sessionA = workSessions.create({ workspaceSessionId: "ws-isolation", submittedBy: "tester" });
  const sessionB = workSessions.create({ workspaceSessionId: "ws-isolation-b", submittedBy: "tester" });
  const eventStore = createEventStore(db);
  const agentMessages = createAgentMessageManager(db);

  // Seed one message in session B so a cross-session read would have
  // something to leak if the binding check were missing or misordered.
  const foreign = agentMessages.post({
    workSessionId: sessionB.id,
    kind: "clarification_request",
    title: "Foreign question",
    body: "Which region?",
    data: {},
  });

  const handlers = new Map<string, (input: any) => Promise<any>>();
  const stubServer = {
    registerTool(name: string, _definition: unknown, handler: (input: any) => Promise<any>) {
      handlers.set(name, handler);
    },
  } as never;
  const baseConfig = {
    workSessions,
    eventStore,
    agentMessages,
    agentRegistry: { getRunByWorkSessionId: () => undefined },
    principalRole: "worker",
    connectionWorkSessionId: sessionA.id,
  } as never;
  registerMessageTools(stubServer, baseConfig);
  registerReplyTools(stubServer, baseConfig);
  for (const name of ["post_agent_message", "await_agent_reply", "get_pending_agent_replies", "ack_agent_reply", "resolve_agent_message"]) {
    assert.ok(handlers.has(name), `isolation harness exposes ${name}`);
  }

  // ── Positive controls: the harness itself can succeed in the bound session.
  const own = await handlers.get("post_agent_message")!({
    sessionId: sessionA.id,
    kind: "note",
    title: "Own note",
    body: "hello",
  });
  assert.equal(own.isError, undefined, "a worker posts in its own session");
  assert.ok(own.structuredContent.messageId, "the post returns a durable message identity");
  const ownPending = await handlers.get("get_pending_agent_replies")!({ sessionId: sessionA.id });
  assert.equal(ownPending.isError, undefined, "a worker lists its own pending replies");

  // ── Cross-session access fails closed on every relay tool.
  const crossPost = await handlers.get("post_agent_message")!({
    sessionId: sessionB.id,
    kind: "note",
    title: "Intrusion",
    body: "should never land",
  });
  assert.ok(isForbidden(crossPost), "a worker cannot post into another session");
  const crossAwait = await handlers.get("await_agent_reply")!({
    sessionId: sessionB.id,
    messageId: foreign.id,
    timeoutMs: 1_000,
  });
  assert.ok(isForbidden(crossAwait), "a worker cannot await another session's reply");
  const crossList = await handlers.get("get_pending_agent_replies")!({ sessionId: sessionB.id });
  assert.ok(isForbidden(crossList), "a worker cannot list another session's replies");
  const crossAck = await handlers.get("ack_agent_reply")!({
    sessionId: sessionB.id,
    replyId: "r-forged",
    replyRevision: 1,
    deliveryAttemptId: "forged:1",
  });
  assert.ok(isForbidden(crossAck), "a worker cannot acknowledge another session's reply");

  // ── A worker cannot touch the reviewer side either.
  const resolve = await handlers.get("resolve_agent_message")!({
    sessionId: sessionA.id,
    messageId: own.structuredContent.messageId,
    body: "self-approved",
  });
  assert.ok(isForbidden(resolve), "resolve_agent_message stays reviewer-only even in the bound session");

  eventStore.close();
  db.close();
  workSessions.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("bridge/message-isolation.test.ts: cross-session isolation assertions passed");
