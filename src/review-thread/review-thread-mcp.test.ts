import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openDatabase } from "../db/client.js";
import { createReviewRouteStore } from "../review-handoff/route-store.js";
import { createReviewThreadStore } from "./thread-store.js";
import { registerHandoffTools } from "../bridge/handoff-tools.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-review-thread-mcp-test-"));
try {
  const db = openDatabase(root);
  db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-review-mcp");
  db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values (?, 'ws-review-mcp', 'worker', 'awaiting_review', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("session-review-mcp");
  const reviewRoutes = createReviewRouteStore(db);
  const reviewThreads = createReviewThreadStore(db);
  const route = reviewRoutes.configure({
    workSessionId: "session-review-mcp", ownerPrincipalId: "owner", ownerContextId: "owner-context",
    enabled: true, mode: "isolated_review", maxReviewRounds: 2,
  });
  const handoff = reviewRoutes.createHandoff({
    routeId: route.id, workSessionId: route.workSessionId, submissionId: "submission-review-mcp",
    reviewEpoch: 1, snapshotKind: "git", snapshotRef: "snapshot-review-mcp", diffSha256: "diff-review-mcp", roundNumber: 1,
  });
  const packet = { version: 1, workSessionId: route.workSessionId, submission: { submissionId: handoff.submissionId }, requestedDecision: "Review the exact submission." };
  const payloadJson = JSON.stringify(packet);
  const payloadSha256 = createHash("sha256").update(payloadJson).digest("hex");
  reviewRoutes.setReviewPacket({ handoffId: handoff.id, payloadJson, payloadSha256 });
  const activation = reviewThreads.createActivation({ routeId: route.id, ownerPrincipalId: "owner", reviewerPrincipalId: "reviewer" });
  const activeThread = reviewThreads.activate({ activationSecret: activation.activationSecret, principalId: "reviewer", contextId: "principal:reviewer|mcp-session:review-mcp-session" });

  const createConnection = (principalId: string, conversationId: string, mcpSessionId: string) => {
    const config = {
      db, workspaces: {},
      workSessions: {
        get: () => ({ id: route.workSessionId, title: "Review task" }),
        getSubmissions: () => [{ id: handoff.submissionId, submissionNumber: 1, reviewEpoch: handoff.reviewEpoch, diffSha256: handoff.diffSha256, snapshotKind: handoff.snapshotKind, snapshotRef: handoff.snapshotRef, status: "pending" }],
      },
      reviewCheckpoints: {},
      agentRegistry: { getRunByWorkSessionId: () => undefined },
      eventStore: { appendEvent: () => ({ seq: 1 }) },
      continuationManager: {}, reviewWorkflow: {}, knownAgents: [],
      principalRole: "reviewer", principalId, connectionConversationId: conversationId,
      connectionMcpSessionId: mcpSessionId,
      reviewRoutes, reviewThreads,
    } as any;
    const server = new McpServer({ name: "review-thread-mcp-test", version: "1.0.0" });
    registerHandoffTools(server, config);
    const client = new Client({ name: "review-thread-mcp-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    return { config, server, client, clientTransport, serverTransport };
  };

  const reviewer = createConnection("reviewer", "review-b", "review-mcp-session");
  // The attacker deliberately copies the same upstream conversation ID. Only
  // the server-issued MCP session identity separates the authenticated contexts.
  const other = createConnection("reviewer", "review-b", "different-mcp-session");
  await Promise.all([
    reviewer.server.connect(reviewer.serverTransport), reviewer.client.connect(reviewer.clientTransport),
    other.server.connect(other.serverTransport), other.client.connect(other.clientTransport),
  ]);
  try {
    const activationRetry = reviewThreads.createActivation({ routeId: route.id, ownerPrincipalId: "owner", reviewerPrincipalId: "reviewer" });
    const activated = await reviewer.client.callTool({ name: "activate_review_thread", arguments: { activationSecret: activationRetry.activationSecret, hostKind: "chatgpt", hostConversationId: "review-b" } });
    assert.equal(activated.isError, undefined, "the owner-issued activation grant binds the current authenticated MCP session");
    assert.equal((activated.structuredContent as { threadId: string; hostBindingVerified: boolean }).threadId, activeThread.id);
    assert.equal((activated.structuredContent as { hostBindingVerified: boolean }).hostBindingVerified, false, "caller-supplied host conversation IDs remain unverified metadata");

    const attackerClaim = await other.client.callTool({ name: "claim_review_thread_deliveries", arguments: {} });
    assert.deepEqual((attackerClaim.structuredContent as { messages: unknown[] }).messages, [], "another authenticated context cannot consume this thread's queue");
    const spoofedConversationClaim = await other.client.callTool({ name: "claim_review_handoff", arguments: {
      handoffId: handoff.id, expectedRevision: handoff.revision, reviewThreadId: activeThread.id,
    } });
    assert.equal(spoofedConversationClaim.isError, true, "copying the host conversation ID and thread ID cannot authorize a different MCP session");
    const presented = await reviewer.client.callTool({ name: "claim_review_thread_deliveries", arguments: {} });
    const claimedMessages = (presented.structuredContent as { messages: Array<{ threadId: string; handoffId: string; payloadSha256: string; packet: Record<string, unknown> }> }).messages;
    assert.equal(claimedMessages.length, 1);
    assert.equal(claimedMessages[0]?.threadId, activeThread.id);
    assert.equal(claimedMessages[0]?.packet.submission && (claimedMessages[0].packet.submission as any).submissionId, handoff.submissionId);
    assert.equal(reviewThreads.listMessages(activeThread.id)[0]?.status, "presenting", "only the delivery claim changes the lifecycle state");

    const duplicateClaim = await reviewer.client.callTool({ name: "claim_review_thread_deliveries", arguments: {} });
    assert.deepEqual((duplicateClaim.structuredContent as { messages: unknown[] }).messages, [], "duplicate event delivery cannot claim a presenting packet again");
    const unauthorizedAck = await other.client.callTool({ name: "acknowledge_review_thread_delivery", arguments: {
      threadId: activeThread.id, handoffId: handoff.id, payloadSha256, outcome: "accepted",
    } });
    assert.equal(unauthorizedAck.isError, true, "delivery receipts are bound to the activated reviewer context");
    const badAck = await reviewer.client.callTool({ name: "acknowledge_review_thread_delivery", arguments: {
      threadId: activeThread.id, handoffId: handoff.id, payloadSha256: "0".repeat(64), outcome: "accepted",
    } });
    assert.equal(badAck.isError, true, "a receipt cannot acknowledge a different packet hash");
    const ack = await reviewer.client.callTool({ name: "acknowledge_review_thread_delivery", arguments: {
      threadId: activeThread.id, handoffId: handoff.id, payloadSha256, outcome: "accepted",
    } });
    assert.equal(ack.isError, undefined);
    assert.equal(reviewThreads.listMessages(activeThread.id)[0]?.status, "presented", "host acceptance is recorded without claiming the model reviewed it");

    const firstClaim = await reviewer.client.callTool({ name: "claim_review_handoff", arguments: {
      handoffId: handoff.id, expectedRevision: handoff.revision, reviewThreadId: activeThread.id,
    } });
    assert.equal(firstClaim.isError, undefined, "the activated context can claim the presented packet");
    db.sqlite.prepare("update review_handoffs set claim_expires_at = ? where id = ?").run("1970-01-01T00:00:00.000Z", handoff.id);
    const expiredPacketRead = await reviewer.client.callTool({ name: "get_review_handoff", arguments: { handoffId: handoff.id } });
    assert.equal(expiredPacketRead.isError, true, "an expired claim cannot keep reading the handoff packet");
    const expiredStatusRead = await reviewer.client.callTool({ name: "get_review_handoff_status", arguments: { handoffId: handoff.id } });
    assert.equal(expiredStatusRead.isError, true, "an expired claim cannot keep reading claim status");
    const replacementActivation = reviewThreads.createActivation({ routeId: route.id, ownerPrincipalId: "owner", reviewerPrincipalId: "reviewer" });
    const rebound = await other.client.callTool({ name: "activate_review_thread", arguments: { activationSecret: replacementActivation.activationSecret } });
    assert.equal(rebound.isError, undefined, "a fresh authenticated context can consume a replacement grant");
    assert.equal((rebound.structuredContent as { threadId: string }).threadId, activeThread.id, "the durable thread identity survives context replacement");
    assert.equal(reviewThreads.listMessages(activeThread.id)[0]?.status, "queued", "the uncompleted packet is queued for the replacement context");
    const newContextDelivery = await other.client.callTool({ name: "claim_review_thread_deliveries", arguments: {} });
    assert.equal((newContextDelivery.structuredContent as { messages: unknown[] }).messages.length, 1,
      "the replacement context receives the same pending review packet");
    const oldContextClaim = await reviewer.client.callTool({ name: "claim_review_handoff", arguments: {
      handoffId: handoff.id, expectedRevision: (firstClaim.structuredContent as { revision: number }).revision, reviewThreadId: activeThread.id,
    } });
    assert.equal(oldContextClaim.isError, true, "the prior context loses access after rebinding");
  } finally {
    await Promise.all([reviewer.client.close(), reviewer.server.close(), other.client.close(), other.server.close()]);
    db.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("review-thread-mcp.test.ts: all assertions passed");
