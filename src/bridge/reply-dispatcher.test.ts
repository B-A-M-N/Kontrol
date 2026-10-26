import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { openDatabase } from "../db/client.js";
import { createDispatchOutbox } from "../dispatch-outbox.js";
import { createAgentMessageManager } from "../agent-messages.js";
import { createWorkSessionManager } from "../work-sessions.js";
import { createEventStore } from "../event-log.js";
import { createReplyDispatcher, resolveReplyDispatchTarget } from "./reply-dispatcher.js";
import type { BridgeConfig } from "./context.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-reply-dispatcher-test-"));
const peers: Array<ReturnType<typeof createServer>> = [];

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

  const origin = { id: "agent-origin", name: "origin", url: "http://origin", capabilities: ["native-reply-resume"] };
  const destination = { id: "agent-destination", name: "destination", url: "http://destination", capabilities: ["native-reply-resume"] };
  const transferredRun = { runId: "run-transferred", agentName: origin.name, workSessionId: session.id };
  const routingConfig = {
    eventStore: { getEventsForSession: () => [] },
    agentRegistry: {
      getRun: (runId: string) => runId === transferredRun.runId ? transferredRun : undefined,
      getLatestDispatchAttemptForRun: () => ({ runId: transferredRun.runId, agentId: destination.id, attemptNumber: 2, status: "accepted" }),
      listAlive: () => [origin, destination],
    },
  } as unknown as BridgeConfig;
  assert.equal(resolveReplyDispatchTarget(routingConfig, transferredRun.runId, session.id)?.id, destination.id,
    "clarification replies follow the latest durable transfer attempt rather than the logical run's origin agent name");
  assert.equal(resolveReplyDispatchTarget(routingConfig, transferredRun.runId, "foreign-session"), undefined,
    "reply routing rejects a logical run from a different work session");
  const missingIdentityConfig = {
    ...routingConfig,
    agentRegistry: {
      ...routingConfig.agentRegistry,
      getLatestDispatchAttemptForRun: () => ({ runId: transferredRun.runId, attemptNumber: 2, status: "accepted" }),
    },
  } as unknown as BridgeConfig;
  assert.equal(resolveReplyDispatchTarget(missingIdentityConfig, transferredRun.runId, session.id), undefined,
    "reply routing fails closed when the latest attempt has no durable destination identity");
  const transferEvents = [
    { type: "session.handoff", payload: { runId: transferredRun.runId, transferId: "transfer-1", toAgent: destination.name } },
    { type: "session.handoff.state", payload: { transferId: "transfer-1", state: "destination_ready" } },
  ];
  const inFlightTransfer = { ...routingConfig, eventStore: { getEventsForSession: () => transferEvents } } as unknown as BridgeConfig;
  assert.equal(resolveReplyDispatchTarget(inFlightTransfer, transferredRun.runId, session.id), undefined,
    "clarification routing waits for the transfer's durable committed state");
  transferEvents.push({ type: "session.handoff.state", payload: { transferId: "transfer-1", state: "committed" } });
  assert.equal(resolveReplyDispatchTarget(inFlightTransfer, transferredRun.runId, session.id)?.id, destination.id,
    "the committed transfer routes to the exact recorded destination identity");

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

  let remoteDispatches = 0;
  let acceptedTask = "";
  let acceptedLeaseNonce = "";
  const peer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      input?: Array<{ parts?: Array<{ content?: string }> }>;
      dispatch_idempotency_key?: string;
      workspace_lease_nonce?: string;
    };
    remoteDispatches++;
    acceptedTask = body.input?.flatMap((part) => part.parts ?? []).map((part) => part.content ?? "").join("\n") ?? "";
    acceptedLeaseNonce = body.workspace_lease_nonce ?? "";
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      run_id: "remote-reply-attempt-2",
      remote_run_id: "remote-reply-attempt-2",
      dispatch_idempotency_key: body.dispatch_idempotency_key,
      accepted: true,
      status: "running",
      output: [],
    }));
  });
  peers.push(peer);
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const address = peer.address();
  assert.ok(address && typeof address === "object");
  const peerUrl = `http://127.0.0.1:${address.port}`;
  const originAgent = { id: "agent-origin-native-reply", name: "origin-native-reply", url: "http://127.0.0.1:1", capabilities: ["native-reply-resume"] };
  const nativeAgent = { id: "agent-destination-native-reply", name: "destination-native-reply", url: peerUrl, capabilities: ["native-reply-resume"] };
  const logicalRun = {
    runId: "run-native-reply",
    agentName: originAgent.name,
    agentId: originAgent.id,
    workspaceSessionId: "ws-reply-dispatch",
    workSessionId: session.id,
    attemptNumber: 1,
    status: "running",
    workerLeaseUntil: new Date(Date.now() + 60_000).toISOString(),
  };
  const attempts = new Map<string, { dispatchIdempotencyKey: string; runId: string; agentId: string; attemptNumber: number; status: string; remoteRunId?: string }>();
  attempts.set("initial-attempt", { dispatchIdempotencyKey: "initial-attempt", runId: logicalRun.runId, agentId: nativeAgent.id, attemptNumber: 1, status: "accepted", remoteRunId: "remote-attempt-1" });
  const registry = {
    getRun: (runId: string) => runId === logicalRun.runId ? logicalRun : undefined,
    getRunByWorkSessionId: () => logicalRun,
    getDispatchAttemptByIdempotencyKey: (key: string) => attempts.get(key),
    getLatestDispatchAttemptForRun: () => [...attempts.values()].filter((attempt) => attempt.runId === logicalRun.runId).sort((a, b) => b.attemptNumber - a.attemptNumber)[0],
    listAlive: () => [originAgent, nativeAgent],
    updateRun: (_runId: string, updates: Record<string, unknown>) => Object.assign(logicalRun, updates),
    updateRunIfCurrent: (_runId: string, expected: { status: string; attemptNumber: number }, updates: Record<string, unknown>) => {
      if (logicalRun.status !== expected.status || logicalRun.attemptNumber !== expected.attemptNumber) return false;
      Object.assign(logicalRun, updates);
      return true;
    },
    beginDispatchAttempt: (input: { key: string; runId: string; agentId: string; attemptNumber: number }) => {
      const prior = attempts.get(input.key);
      if (prior) return;
      attempts.set(input.key, { dispatchIdempotencyKey: input.key, runId: input.runId, agentId: input.agentId, attemptNumber: input.attemptNumber, status: "dispatching" });
    },
    updateDispatchAttempt: (key: string, updates: { status: string; remoteRunId?: string }) => {
      const attempt = attempts.get(key);
      if (attempt) Object.assign(attempt, updates);
    },
  };
  const nativeQuestion = agentMessages.post({
    workSessionId: session.id,
    runId: logicalRun.runId,
    kind: "clarification_request",
    title: "Clarify delivery",
    body: "Should I use the staged endpoint?",
    data: { expectsReply: true, resumeOnReply: true },
  });
  agentMessages.waitForReply({
    messageId: nativeQuestion.id,
    workSessionId: session.id,
    runId: logicalRun.runId,
    attempt: 1,
    expectsReply: true,
    resumeOnReply: true,
  });
  const nativeReply = agentMessages.acceptReply({
    messageId: nativeQuestion.id,
    workSessionId: session.id,
    body: "Yes, use the staged endpoint.",
    reviewerPrincipalId: "reviewer-a",
  }).reply;
  const nativeConfig = {
    ...config,
    agentRegistry: registry,
    workspaces: { getWorkspace: () => ({ id: "ws-reply-dispatch", root: "/tmp", mode: "checkout" }) },
    adapterSecret: "adapter-test-secret",
  } as unknown as BridgeConfig;
  dispatchOutbox.enqueue({
    eventType: "agent.reply.ready",
    aggregateId: nativeReply.id,
    aggregateRevision: nativeReply.replyRevision,
    payload: { replyId: nativeReply.id, messageId: nativeQuestion.id, workSessionId: session.id },
  });
  await createReplyDispatcher(nativeConfig).drainOnce();
  assert.equal(remoteDispatches, 0, "a live worker lease lets the existing turn consume its reply without a competing continuation");
  assert.equal(agentMessages.getReply(nativeReply.id)?.status, "pending_delivery");
  logicalRun.workerLeaseUntil = new Date(Date.now() - 1).toISOString();
  dispatchOutbox.enqueue({
    eventType: "agent.reply.ready",
    aggregateId: nativeReply.id,
    aggregateRevision: nativeReply.replyRevision + 1,
    payload: { replyId: nativeReply.id, messageId: nativeQuestion.id, workSessionId: session.id },
  });
  await createReplyDispatcher(nativeConfig).drainOnce();
  assert.equal(remoteDispatches, 1, "native reply is posted to its selected adapter once");
  const awaitingAcknowledgement = agentMessages.getReply(nativeReply.id);
  assert.equal(awaitingAcknowledgement?.status, "awaiting_acknowledgement");
  assert.equal(awaitingAcknowledgement?.deliveryRunId, logicalRun.runId);
  assert.equal(awaitingAcknowledgement?.deliveryAttemptNumber, 2);
  assert.equal(awaitingAcknowledgement?.deliveryRemoteRunId, "remote-reply-attempt-2");
  const deliveryEvents = eventStore.getEventsForSession(session.id)
    .filter((event) => event.type === "agent.message.reply_delivery_state")
    .map((event) => event.payload as Record<string, unknown>);
  assert.deepEqual(deliveryEvents.map((event) => event.status), ["dispatching", "awaiting_acknowledgement"],
    "each committed reply-delivery state is projected to live Workspace App observers");
  assert.ok(deliveryEvents.every((event) => event.destinationAgentId === nativeAgent.id),
    "reply status events retain the exact selected destination agent identity");
  assert.equal(logicalRun.agentId, originAgent.id, "transfer routing preserves the run's immutable origin identity");
  assert.ok(acceptedLeaseNonce, "native reply continuation is bound to the acquired workspace lease");
  assert.match(acceptedTask, new RegExp(`Required deliveryAttemptId: ${logicalRun.runId}:2`));
  assert.match(acceptedTask, new RegExp(`reply ID: ${nativeReply.id}; revision: ${nativeReply.replyRevision}`));
  dispatchOutbox.enqueue({
    eventType: "agent.reply.ready",
    aggregateId: nativeReply.id,
    aggregateRevision: nativeReply.replyRevision + 2,
    payload: { replyId: nativeReply.id, messageId: nativeQuestion.id, workSessionId: session.id },
  });
  await createReplyDispatcher(nativeConfig).drainOnce();
  assert.equal(remoteDispatches, 1, "a duplicate wake while awaiting acknowledgement cannot allocate another resume");
  const acknowledged = agentMessages.acknowledgeReply({
    replyId: nativeReply.id,
    workSessionId: session.id,
    runId: logicalRun.runId,
    attempt: 2,
    actorId: nativeAgent.id,
    expectedReplyRevision: nativeReply.replyRevision,
  }).reply;
  assert.equal(acknowledged.status, "acknowledged", "the exact accepted logical run and attempt can settle delivery");
  eventStore.close();
  db.close();
  dispatchOutbox.close();
} finally {
  await Promise.all(peers.map((peer) => new Promise<void>((resolve) => {
    if (!peer.listening) return resolve();
    peer.close(() => resolve());
  })));
  await rm(root, { recursive: true, force: true });
}
console.log("bridge/reply-dispatcher.test.ts: all assertions passed");
