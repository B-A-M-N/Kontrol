import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createReviewRouteStore } from "../review-handoff/route-store.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHandoffTools } from "./handoff-tools.js";
import { mcpOwnerContextId } from "../mcp/owner-context.js";
import { McpQualificationEvidenceJournal } from "../server/mcp-qualification-evidence.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-handoff-tools-test-"));

try {
  const db = openDatabase(root);
  db.sqlite
    .prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
    .run("ws-handoff");
  db.sqlite
    .prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values ('wsess-handoff', 'ws-handoff', 'tester', 'in_progress', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
    .run();
  const routes = createReviewRouteStore(db);
  const ownerContextId = mcpOwnerContextId({ conversationId: "conv-b", principalId: "user-a" })!;
  const route = routes.configure({
    workSessionId: "wsess-handoff",
    ownerPrincipalId: "user-a",
    ownerContextId,
    enabled: true,
    mode: "pinned_conversation",
    maxReviewRounds: 3,
    pinnedConversationId: ownerContextId,
  });
  const handoff = routes.createHandoff({
    routeId: route.id,
    workSessionId: "wsess-handoff",
    submissionId: "sub-1",
    reviewEpoch: 1,
    snapshotKind: "git",
    snapshotRef: "ref-1",
    diffSha256: "hash-1",
    roundNumber: 1,
  });
  const fetched = routes.getHandoffById(handoff.id);
  assert.equal(fetched?.submissionId, "sub-1");
  let wrongConversationDenied = false;
  try {
    routes.claimHandoff({
      handoffId: handoff.id,
      expectedRevision: 1,
      principalId: "user-a",
      ownerContextId: "owner-b",
      destinationConversationId: "owner-b",
      authorization: {
        conversationId: "owner-b",
        freshConversationIds: ["owner-b"],
      },
    });
  } catch {
    wrongConversationDenied = true;
  }
  assert.ok(wrongConversationDenied, "wrong pinned conversation cannot claim the handoff");
  const claimed = routes.claimHandoff({
    handoffId: handoff.id,
    expectedRevision: 1,
    principalId: "user-a",
    ownerContextId,
    destinationConversationId: ownerContextId,
    authorization: {
      conversationId: ownerContextId,
      freshConversationIds: [ownerContextId],
    },
  });
  assert.equal(claimed.claimedByOwnerContextId, ownerContextId);

  const eventTypes: string[] = [];
  const eventPayloads: unknown[] = [];
  const reviewerConfig = {
    workspaces: {},
    workSessions: { get: () => ({ ownerContextId }) },
    reviewCheckpoints: {},
    agentRegistry: {},
    eventStore: { appendEvent: (event: { type: string; payload: unknown }) => { eventTypes.push(event.type); eventPayloads.push(event.payload); } },
    continuationManager: {},
    reviewWorkflow: {},
    knownAgents: [],
    principalRole: "reviewer",
    principalId: "user-a",
    connectionConversationId: "conv-b",
    connectionMcpSessionId: "mcp-reviewer-1",
    reviewRoutes: routes,
    qualificationEvidence: new McpQualificationEvidenceJournal(db.sqlite),
    toolSurfaceVersion: "1.0.4+capture-test",
    serverConfig: { expectedBuildId: "build-capture-test" },
  } as any;
  const reviewerServer = new McpServer({ name: "handoff-capture-test", version: "1.0.0" });
  registerHandoffTools(reviewerServer, reviewerConfig);
  const reviewerClient = new Client({ name: "handoff-capture-client", version: "1.0.0" });
  const [reviewerClientTransport, reviewerServerTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([reviewerServer.connect(reviewerServerTransport), reviewerClient.connect(reviewerClientTransport)]);
  const observation = {
    contractVersion: 1,
    captureId: "capture-handoff-test",
    capturedAt: new Date().toISOString(),
    hostKind: "chatgpt",
    serverVersion: "1.0.4+capture-test",
    sessionIdSha256: "a".repeat(64),
    initializeResult: { serverInfo: { name: "kontrol", version: "1.0.4+capture-test" } },
    toolsListResult: { tools: [{ name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }] },
  };
  const submitted = await reviewerClient.callTool({ name: "submit_external_catalog_observation", arguments: {
    handoffId: handoff.id,
    investigationDirection: "Determine whether the host exposes a callable registry capture hook.",
    observation,
  } });
  const submittedContent = submitted.structuredContent as Record<string, unknown>;
  assert.equal(submitted.isError, undefined);
  assert.equal(submittedContent.status, "host_capture_unsupported");
  assert.equal(submittedContent.observationSource, "operator_reported");
  const fetchedObservation = await reviewerClient.callTool({ name: "get_external_catalog_observation", arguments: { recordId: submittedContent.recordId } });
  const fetchedRecord = (fetchedObservation.structuredContent as { observation: Record<string, unknown> }).observation;
  assert.equal(fetchedRecord.status, "host_capture_unsupported");
  assert.equal(fetchedRecord.observationSource, "operator_reported");
  const handoffPacket = await reviewerClient.callTool({ name: "get_review_handoff", arguments: { handoffId: handoff.id } });
  assert.ok(handoffPacket.structuredContent, `get_review_handoff returned no structured packet: ${JSON.stringify(handoffPacket)}`);
  const packet = handoffPacket.structuredContent as { externalCatalogAttachments: Array<Record<string, unknown>> };
  assert.equal(packet.externalCatalogAttachments.length, 1);
  assert.equal(packet.externalCatalogAttachments[0].observationRecordId, submittedContent.recordId);
  assert.equal(eventTypes.includes("review.handoff.external_catalog_observation_attached"), true);
  assert.equal(JSON.stringify(eventPayloads).includes("host_integration"), false,
    "reviewer-provided data is never promoted to host integration evidence");

  const clientConfig = { ...reviewerConfig, principalRole: "client" };
  const clientServer = new McpServer({ name: "handoff-client-auth-test", version: "1.0.0" });
  registerHandoffTools(clientServer, clientConfig);
  const client = new Client({ name: "handoff-nonreviewer", version: "1.0.0" });
  const [clientTransport, clientServerTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([clientServer.connect(clientServerTransport), client.connect(clientTransport)]);
  const denied = await client.callTool({ name: "submit_external_catalog_observation", arguments: {
    handoffId: handoff.id,
    investigationDirection: "unauthorized submission",
    observation,
  } });
  assert.equal(denied.isError, true, "non-reviewers cannot submit observations");
  await Promise.all([reviewerClient.close(), reviewerServer.close(), client.close(), clientServer.close()]);
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("bridge/handoff-tools.test.ts: all assertions passed");
