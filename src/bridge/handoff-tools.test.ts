import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createReviewRouteStore } from "../review-handoff/route-store.js";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { registerHandoffTools } from "./handoff-tools.js";
import { mcpOwnerContextId } from "../mcp/owner-context.js";
import { McpQualificationEvidenceJournal } from "../server/mcp-qualification-evidence.js";
import { reviewerThreadContextId } from "./shared.js";
import { ManualAuthenticationRequiredError } from "../review-browser/browser-controller.js";

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
  });
  assert.equal(claimed.claimedByOwnerContextId, ownerContextId);

  const eventTypes: string[] = [];
  const eventPayloads: unknown[] = [];
  let browserRecoveryInput: Record<string, unknown> | undefined;
  const browserAuthCalls: string[] = [];
  const testSubmission = {
    id: "sub-1", workSessionId: "wsess-handoff", submissionNumber: 1,
    diffSha256: "hash-1", snapshotKind: "git" as const, snapshotRef: "ref-1",
    reviewEpoch: 1, status: "pending" as const, createdAt: new Date().toISOString(),
    message: "bounded change summary", summaryJson: JSON.stringify({ files: 1, additions: 2, removals: 0 }),
    files: [{ path: "src/example.ts", type: "change" as const, additions: 2, removals: 0 }],
  };
  const reviewerConfig = {
    workspaces: {},
    workSessions: { get: () => ({ id: "wsess-handoff", ownerContextId, title: "Review objective" }), getSubmissions: () => [testSubmission] },
    reviewCheckpoints: {},
    agentRegistry: { getRunByWorkSessionId: () => undefined },
    eventStore: { appendEvent: (event: { type: string; payload: unknown }) => { eventTypes.push(event.type); eventPayloads.push(event.payload); } },
    continuationManager: {},
    reviewWorkflow: {},
    knownAgents: [],
    principalRole: "reviewer",
    principalId: "user-a",
    connectionConversationId: "conv-b",
    connectionMcpSessionId: "mcp-reviewer-1",
    reviewRoutes: routes,
    reviewThreads: {
      getById: (id: string) => id === "thread-recovery" ? {
        id, status: "active", reviewerPrincipalId: "user-a",
        reviewerContextId: reviewerThreadContextId({ principalRole: "reviewer", principalId: "user-a", connectionConversationId: "conv-b", connectionMcpSessionId: "mcp-reviewer-1" } as any),
        routeEpoch: route.routeEpoch, workSessionId: "wsess-handoff",
      } : undefined,
    },
    reviewBrowserJobs: {
      resolveUncertainAttemptForRetry: (input: Record<string, unknown>) => {
        browserRecoveryInput = input;
        return { messageId: "message-recovered", messageRevision: 3, resolutionSha256: "b".repeat(64) };
      },
    },
    reviewBrowserController: {
      profiles: { get: (profileId: string) => profileId === "reviewer-profile" ? { id: profileId, ownerPrincipalId: "user-a" } : undefined },
      inspectHealth: async () => ({
        browserProcess: "running" as const, cdpConnection: "connected" as const, authState: "authenticated",
        lastVerifiedAt: "2026-01-01T00:00:00.000Z", browserProduct: "Google Chrome 136.0", remoteDebuggingEnabled: true,
        bindings: { bound: 1, recoveryRequired: 0, other: 0 }, dispatch: { queued: 0, active: 0, uncertain: 0, blocked: 0 },
      }),
      openLoginPage: async (profileId: string) => {
        browserAuthCalls.push(`legacy-login:${profileId}`);
        throw new ManualAuthenticationRequiredError();
      },
      beginManualAuthentication: async (profileId: string) => {
        browserAuthCalls.push(`begin:${profileId}`);
        return { profileId, generation: 4, browserPid: 4321, browserProduct: "Google Chrome 136.0", remoteDebuggingEnabled: false as const, browserLaunchDiagnostic: "" };
      },
      completeManualAuthentication: async (profileId: string) => {
        browserAuthCalls.push(`complete:${profileId}`);
        return { status: "auth_required", reason: "close_all_chrome_windows_before_handoff", targets: [] };
      },
    },
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
  assert.equal((packet as any).reviewPacket.submission.snapshot.ref, "ref-1");
  assert.equal((packet as any).reviewPacket.originalObjective, "Review objective");
  assert.ok((packet as any).reviewPacket.packetSha256);
  assert.equal(eventTypes.includes("review.handoff.external_catalog_observation_attached"), true);
  assert.equal(JSON.stringify(eventPayloads).includes("host_integration"), false,
    "reviewer-provided data is never promoted to host integration evidence");
  const resolvedBrowserAttempt = await reviewerClient.callTool({ name: "resolve_uncertain_reviewer_browser_attempt", arguments: {
    attemptId: "rturn-uncertain", threadId: "thread-recovery", confirmPromptAbsent: true,
    inspectionEvidence: "I inspected the bound conversation and confirmed the prompt is absent.",
  } });
  assert.equal(resolvedBrowserAttempt.isError, undefined);
  assert.deepEqual(browserRecoveryInput, {
    attemptId: "rturn-uncertain", reviewThreadId: "thread-recovery", routeEpoch: route.routeEpoch,
    reviewerPrincipalId: "user-a", confirmPromptAbsent: true,
    inspectionEvidence: "I inspected the bound conversation and confirmed the prompt is absent.",
  }, "recovery tool binds the explicit resolution to the active reviewer principal and route epoch");
  assert.equal((resolvedBrowserAttempt.structuredContent as Record<string, unknown>).status, "queued");
  assert.equal(eventTypes.includes("review.browser_turn.operator_reconciled"), true);

  const authStarted = await reviewerClient.callTool({ name: "begin_reviewer_browser_auth", arguments: { profileId: "reviewer-profile" } });
  assert.equal(authStarted.isError, undefined, "authenticated reviewers can start the dedicated ordinary-Chrome auth handoff");
  assert.deepEqual(authStarted.structuredContent, {
    profileId: "reviewer-profile", generation: 4, browserPid: 4321,
    browserProduct: "Google Chrome 136.0", remoteDebuggingEnabled: false, browserLaunchDiagnostic: "",
  });
  assert.match(JSON.stringify(authStarted.content), /without remote debugging/);
  const authCompleted = await reviewerClient.callTool({ name: "complete_reviewer_browser_auth", arguments: { profileId: "reviewer-profile" } });
  assert.equal(authCompleted.isError, undefined);
  assert.equal((authCompleted.structuredContent as { status: string }).status, "auth_required");
  const legacyLogin = await reviewerClient.callTool({ name: "open_reviewer_browser_login", arguments: { profileId: "reviewer-profile" } });
  assert.deepEqual(legacyLogin.structuredContent, {
    profileId: "reviewer-profile", code: "manual_authentication_required", retryable: false,
    requiredAction: "begin_reviewer_browser_auth",
  }, "the compatibility action cannot open ChatGPT under CDP and directs reviewers to ordinary Chrome");
  const browserHealth = await reviewerClient.callTool({ name: "inspect_reviewer_browser_health", arguments: { profileId: "reviewer-profile" } });
  assert.equal(browserHealth.isError, undefined);
  assert.deepEqual(browserHealth.structuredContent, {
    browserProcess: "running", cdpConnection: "connected", authState: "authenticated",
    lastVerifiedAt: "2026-01-01T00:00:00.000Z", browserProduct: "Google Chrome 136.0", remoteDebuggingEnabled: true,
    bindings: { bound: 1, recoveryRequired: 0, other: 0 }, dispatch: { queued: 0, active: 0, uncertain: 0, blocked: 0 },
  }, "health reports process, CDP, authentication, conversation binding, and dispatch independently");
  assert.deepEqual(browserAuthCalls, ["begin:reviewer-profile", "complete:reviewer-profile", "legacy-login:reviewer-profile"]);

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
  const deniedBrowserRecovery = await client.callTool({ name: "resolve_uncertain_reviewer_browser_attempt", arguments: {
    attemptId: "rturn-forged", threadId: "thread-forged", confirmPromptAbsent: true,
    inspectionEvidence: "I inspected the conversation carefully.",
  } });
  assert.equal(deniedBrowserRecovery.isError, true, "non-reviewers cannot release an uncertain browser-attempt fence");
  const deniedBrowserAuth = await client.callTool({ name: "begin_reviewer_browser_auth", arguments: { profileId: "reviewer-profile" } });
  assert.equal(deniedBrowserAuth.isError, true, "non-reviewers cannot launch ordinary Chrome for reviewer authentication");
  assert.deepEqual(browserAuthCalls, ["begin:reviewer-profile", "complete:reviewer-profile", "legacy-login:reviewer-profile"], "denied auth requests never reach the browser controller");
  await Promise.all([reviewerClient.close(), reviewerServer.close(), client.close(), clientServer.close()]);
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("bridge/handoff-tools.test.ts: all assertions passed");
