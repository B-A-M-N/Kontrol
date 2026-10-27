import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import express from "express";
import { createWorkSessionManager } from "./work-sessions.js";
import { createEventStore } from "./event-log.js";
import { createContinuationManager } from "./continuation.js";
import { createMissionLedger } from "./mission-ledger.js";
import { createSupervisorRuns } from "./supervisor-runs.js";
import { createAgentRegistryManager } from "./acp-registry.js";
import { createDispatchOutbox } from "./dispatch-outbox.js";
import { registerBridgeTools, runContinuationTick, type BridgeConfig } from "./acp-bridge.js";
import { createAcpServer } from "./acp-server.js";
import { openDatabase, databasePath } from "./db/client.js";
import { createReviewWorkflowService } from "./review-workflow.js";
import { createReviewRouteStore } from "./review-handoff/route-store.js";
import { createReviewThreadStore } from "./review-thread/thread-store.js";
import { createApprovalRequestManager } from "./approval-requests.js";
import { createPolicyEngine } from "./policy.js";
import { createSqliteGrantStore } from "./policy-grants.js";
import { createAgentMessageManager } from "./agent-messages.js";
import { registerPolicyTools } from "./policy-tools.js";
import { authorizeWorkSessionAction } from "./work-session-action-guard.js";
import { compactMissionPacket, projectMissionExecutionContract, renderMissionPrompt } from "./bridge/shared.js";
import { supervisedMissionOptionsSchema } from "./bridge/context.js";
import { getPeerJobStore, setPeerJobStoreSingleton } from "./peer/jobs/store.js";
import { scheduledPeerContinuationJobId } from "./scheduling/scheduled-job-dispatch.js";
import { openPeerJobStore } from "./peer/jobs/store.js";
import { manifestSha256 } from "./peer/jobs/service.js";
import { createMutationReceiptStore } from "./mutation-receipts.js";

assert.equal(supervisedMissionOptionsSchema.safeParse({ outcomeEvidence: "outcome_verified" }).success, false,
  "the MCP mission contract requires its external outcome oracle before supervised work can start");
assert.equal(supervisedMissionOptionsSchema.safeParse({
  outcomeEvidence: "outcome_verified", outcomeExpectedBehavior: "The reviewer can see the saved change after reload.",
}).success, true, "the MCP mission contract exposes the declared expected behavior used by the reviewer observation tool");
assert.equal(supervisedMissionOptionsSchema.safeParse({ completionClaim: "real_world_outcome" }).success, false,
  "real-world completion claims require an explicit observable behavior");
assert.equal(supervisedMissionOptionsSchema.safeParse({
  completionClaim: "real_world_outcome", outcomeEvidence: "implementation_verified", outcomeExpectedBehavior: "The change is visible to users.",
}).success, false, "real-world completion cannot use implementation-only evidence");
assert.equal(supervisedMissionOptionsSchema.safeParse({
  completionClaim: "real_world_outcome", outcomeExpectedBehavior: "The change is visible to users.",
}).success, true, "real-world completion may derive outcome_verified from its explicit claim");

const root = await mkdtemp(join(tmpdir(), "kontrol-bridge-flow-"));
const VERIFY_WS = "ws-verification-test";
const UNCERTAIN_WS = "ws-uncertain-dispatch-test";
const verificationWorkspaceRoot = join(root, "verification-workspace");
const uncertainWorkspaceRoot = join(root, "uncertain-workspace");
await mkdir(verificationWorkspaceRoot, { recursive: true });
await mkdir(uncertainWorkspaceRoot, { recursive: true });

const staleCompactPacket = compactMissionPacket({
  criteria: [{ id: "stale-verified", status: "verified" }],
  findings: [],
  workOrders: [],
  evidence: [],
  completionReports: [],
  approval: { allowed: false, reasons: ["current-snapshot evidence is missing"] },
  // Simulate an older/incomplete projection: persisted status alone cannot
  // remove a criterion from the reviewer-visible packet.
  criterionStates: undefined,
} as any);
assert.equal(staleCompactPacket.criteria.length, 1, "a persisted verified status cannot hide a criterion when effective state is absent");

// A minimal MCP server that captures each registered tool handler.
function fakeServer(): {
  registerTool: (n: string, c: unknown, h: (a: any) => any) => undefined;
  handlers: Map<string, (a: any) => any>;
  configs: Map<string, any>;
} {
  const handlers = new Map<string, (a: any) => any>();
  const configs = new Map<string, any>();
  return {
    registerTool: (name, cfg, handler) => {
      configs.set(name, cfg);
      handlers.set(name, handler);
    },
    handlers,
    configs,
  };
}

// Seed a workspace_sessions parent row so FK constraints pass.
function seedWorkspace(dir: string, id: string, workspaceRoot = "/tmp"): void {
  const db = new Database(databasePath(dir));
  db.pragma("foreign_keys = OFF");
  db.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, ?, 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
    .run(id, workspaceRoot);
  db.close();
}

const WS = "ws-test";

let httpServer: Server | undefined;
let acpHttp: import("node:http").Server | undefined;
let destinationAdapter: ChildProcess | undefined;
let agentUrl = "";
let resumeCalls = 0;
let dropNextDispatchResponse = false;
let receivedRunsBeforeForeign = -1;
const receivedRuns: Array<Record<string, any>> = [];
const acceptedDispatches = new Map<string, string>();
let reviewPatch = "diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n";
// Mutable workspace snapshot so a "changed workspace" (drift) can be simulated.
let currentSnapshot = "deadbeef";

// Controllable live-waiter registry: the dispatcher only re-dispatches when no
// live waiter is registered, so a parked agent is woken by the feedback event
// itself instead of spawning a second worker. remove() returns whether it
// emptied the set (so the await_review_feedback cleanup can emit
// worker.waiter.closed).
const liveWaiters = {
  _m: new Map<string, Set<string>>(),
  add(id: string) {
    const waiterId = `waiter-${Date.now()}-${Math.random()}`;
    const set = this._m.get(id) ?? new Set<string>();
    set.add(waiterId);
    this._m.set(id, set);
    return waiterId;
  },
  remove(id: string, waiterId?: string) {
    const set = this._m.get(id);
    if (!set) return false;
    if (waiterId) set.delete(waiterId);
    else set.clear();
    const empty = set.size === 0;
    if (empty) this._m.delete(id);
    return empty;
  },
  has(id: string) { return (this._m.get(id)?.size ?? 0) > 0; },
};

const db = openDatabase(root);
const workSessions = createWorkSessionManager(db);
const eventStore = createEventStore(db);
const continuationManager = createContinuationManager(db);
const dispatchOutbox = createDispatchOutbox(db);
const agentMessages = createAgentMessageManager(db);
const missionLedger = createMissionLedger(db);
const supervisorRuns = createSupervisorRuns(db);
const approvalRequests = createApprovalRequestManager(db);
let supervisorWakeCalls = 0;
const agentRegistry = createAgentRegistryManager(db);
let ptyObservationSessionId: string | undefined;

// Hoisted so the workflow service (created below) can share the exact same
// workspaces + reviewCheckpoints the bridge config uses (P0 #4/#5 drift check
// requires them on the service).
const workspaces = {
  getWorkspace: (id: string) => {
    if (id === WS) return { id: WS, root: "/tmp", mode: "checkout" } as any;
    if (id === VERIFY_WS) return { id: VERIFY_WS, root: verificationWorkspaceRoot, mode: "checkout" } as any;
    if (id === UNCERTAIN_WS) return { id: UNCERTAIN_WS, root: uncertainWorkspaceRoot, mode: "checkout" } as any;
    throw new Error(`Unknown workspace: ${id}`);
  },
  setActiveSession: () => {},
} as any;
const reviewCheckpoints = {
  reviewChanges: async () => ({
    patch: reviewPatch,
    result: "reviewed",
    summary: reviewPatch ? { files: 1, additions: 1, removals: 1 } : { files: 0, additions: 0, removals: 0 },
      files: reviewPatch ? [{ path: "x.txt", operation: "update", additions: 1, removals: 1 }] : [],
      snapshotCommit: currentSnapshot,
      snapshotKind: "git",
      snapshotRef: currentSnapshot,
    }),
  reviewChangesAgainstCommit: async ({ baselineCommit }: { baselineCommit: string }) => ({
    patch: baselineCommit === currentSnapshot ? "" : reviewPatch || "diff --git a/x.txt b/x.txt\n",
    result: baselineCommit === currentSnapshot ? "reviewed snapshot is current" : "workspace changed",
    summary: baselineCommit === currentSnapshot ? { files: 0, additions: 0, removals: 0 } : { files: 1, additions: 1, removals: 1 },
    files: baselineCommit === currentSnapshot ? [] : [{ path: "x.txt", operation: "update", additions: 1, removals: 1 }],
    snapshotCommit: currentSnapshot,
  }),
  commitReviewed: async () => {},
} as any;

const reviewRoutes = createReviewRouteStore(db);
const reviewThreads = createReviewThreadStore(db);
const reviewWorkflow = createReviewWorkflowService({
  workSessions,
  eventStore,
  continuationManager,
  agentRegistry,
  db,
  workspaces,
  reviewCheckpoints,
  dispatchOutbox,
  reviewRoutes,
});
const policyEngine = createPolicyEngine({ defaultMode: "allow", toolRules: {}, pathRules: [] });

const config: BridgeConfig = {
  db,
  workspaces,
  workSessions,
  reviewCheckpoints,
  agentRegistry,
  eventStore,
  continuationManager,
  dispatchOutbox,
  agentMessages,
  reviewWorkflow,
  reviewRoutes,
  reviewThreads,
  reviewBrowserJobs: { getActiveForThread: () => undefined } as any,
  approvalRequests,
  agentPtyBindingsForWorkSession: (workSessionId) => workSessionId === ptyObservationSessionId ? [{
    processSessionId: "proc_reviewer_observe",
    agentName: "pty-fixture",
    processGeneration: 3,
    outputCursor: 24,
    status: "attached",
    createdAt: "2026-10-26T12:00:00.000Z",
  }] : [],
  observeAgentPty: ({ workSessionId, processSessionId }) => workSessionId === ptyObservationSessionId && processSessionId === "proc_reviewer_observe"
    ? {
        output: "read-only terminal output",
        outputCursor: 24,
        oldestAvailableCursor: 0,
        outputTruncated: false,
        running: true,
        binding: { agentName: "pty-fixture", processGeneration: 3, status: "attached", createdAt: "2026-10-26T12:00:00.000Z" },
      }
    : undefined,
  missionLedger,
  supervisorRuns,
  onSupervisorResume: () => { supervisorWakeCalls += 1; },
  knownAgents: [],
  adapterSecret: "test-secret",
  liveWaiters: liveWaiters as any,
  principalRole: "client",
  resumeAgent: async () => {
    resumeCalls++;
  },
  serverConfig: {
    verifySandbox: false,
    childEnvironmentAllowlist: [],
    verifyToolchainPaths: [],
    verifyMaxInflight: 1,
  } as any,
};

function createSession(): string {
  return workSessions.create({ workspaceSessionId: WS, submittedBy: "webui" }).id;
}

try {
  seedWorkspace(root, WS);
  seedWorkspace(root, VERIFY_WS, verificationWorkspaceRoot);
  seedWorkspace(root, UNCERTAIN_WS, uncertainWorkspaceRoot);

  // Stand up a tiny healthy ACP agent endpoint so selectHealthyAgent() passes.
  httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/runs") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const requestBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      receivedRuns.push(requestBody);
      const remoteRunId = `remote-${receivedRuns.length}`;
      if (typeof requestBody.dispatch_idempotency_key === "string") {
        acceptedDispatches.set(requestBody.dispatch_idempotency_key, remoteRunId);
      }
      if (dropNextDispatchResponse) {
        dropNextDispatchResponse = false;
        // The adapter accepted the request, but the HTTP response disappears
        // after the handler has recorded the request body.
        res.destroy();
        return;
      }
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        run_id: remoteRunId,
        accepted: true,
        status: "running",
        output: [],
        ...(requestBody.agent_name === "mimo-code" && requestBody.dispatch_idempotency_key
          ? { dispatch_idempotency_key: requestBody.dispatch_idempotency_key }
          : {}),
      }));
      return;
    }
    const dispatchLookup = req.url?.match(/^\/runs\/by-dispatch-id\/(.+)$/);
    if (req.method === "GET" && dispatchLookup) {
      const remoteRunId = acceptedDispatches.get(decodeURIComponent(dispatchLookup[1]!));
      if (!remoteRunId) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true, run_id: remoteRunId, status: "running" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  agentUrl = `http://127.0.0.1:${port}`;
  agentRegistry.register({ name: "cli-coding-agent", url: agentUrl, role: "agent", ttlSeconds: 600 });
  agentRegistry.register({ name: "mimo-code", url: agentUrl, role: "agent", ttlSeconds: 600 });
  agentRegistry.register({ name: "codex", url: agentUrl, role: "agent", capabilities: ["native:openai"], ttlSeconds: 600 });

  // ACP HTTP server so we can POST real adapter lifecycle events (defect #1/#4).
  const acpApp = express();
  acpApp.use(express.json());
  acpApp.use(
    createAcpServer(
      workspaces,
      workSessions,
      agentRegistry,
      "shared-secret",
      "shared-secret",
      eventStore,
      continuationManager,
      reviewCheckpoints,
      reviewWorkflow,
      undefined,
      approvalRequests,
      "agent-secret",
      "reviewer-secret",
    ),
  );
  acpHttp = await new Promise<import("node:http").Server>((resolve) => {
    const s = acpApp.listen(0, "127.0.0.1", () => resolve(s));
  });
  const acpAddr = acpHttp.address();
  const acpPort = typeof acpAddr === "object" && acpAddr ? acpAddr.port : 0;
  const acpBase = `http://127.0.0.1:${acpPort}`;

  // Register one real generic stdio adapter beside the fake agents. The
  // cross-agent transfer scenario below dispatches to this adapter, whose
  // ACP child records the prompt it actually receives over stdin. This joins
  // the bridge's durable transfer packet to the provider-session boundary.
  const destinationAdapterPort = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
  const destinationPromptPath = join(root, "stdio-transfer-prompt.txt");
  const destinationChildCode = `let b="";const sid="stdio-transfer-session";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;const lines=b.split(/\\r?\\n/);b=lines.pop()||"";for(const line of lines){const m=JSON.parse(line);let result;if(m.method==="initialize")result={protocolVersion:1,agentCapabilities:{loadSession:true}};else if(m.method==="session/new")result={sessionId:sid};else if(m.method==="session/load")result={sessionId:m.params.sessionId};else if(m.method==="session/prompt"){require("node:fs").writeFileSync(${JSON.stringify(destinationPromptPath)},m.params.prompt[0].text);result={sessionId:m.params.sessionId,stopReason:"end_turn",content:[{type:"text",text:"destination processed transferred checkpoint"}]};setTimeout(()=>process.exit(0),20)}if(result)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n")}})`;
  destinationAdapter = spawn(process.execPath, ["scripts/acp-stdio-duplex-adapter.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      KONTROL_ACP_URL: acpBase,
      KONTROL_ACP_AGENT_SECRET: "agent-secret",
      KONTROL_ACP_ADAPTER_SECRET: "test-secret",
      KONTROL_ACP_AGENT_STATE_FILE: join(root, "stdio-transfer-identity.json"),
      KONTROL_STDIO_DISPATCH_RECEIPTS: join(root, "stdio-transfer-receipts.json"),
      KONTROL_STDIO_OWNED_PROCESSES: join(root, "stdio-transfer-owned.json"),
      KONTROL_STDIO_EVENT_SPOOL: join(root, "stdio-transfer-events.json"),
      KONTROL_STDIO_TERMINAL_SPOOL: join(root, "stdio-transfer-terminals.json"),
      KONTROL_STDIO_SESSION_BINDINGS: join(root, "stdio-transfer-bindings.json"),
      KONTROL_ALLOWED_ROOTS: "/tmp",
      ACP_STDIO_AGENT_NAME: "stdio-transfer",
      ACP_STDIO_COMMAND: process.execPath,
      ACP_STDIO_ARGS_JSON: JSON.stringify(["-e", destinationChildCode]),
      ACP_STDIO_ADAPTER_PORT: String(destinationAdapterPort),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let destinationAdapterStderr = "";
  destinationAdapter.stderr?.on("data", (chunk: Buffer) => { destinationAdapterStderr += chunk.toString("utf8").slice(-4_000); });
  const adapterReadyDeadline = Date.now() + 5_000;
  let destinationAdapterReady = false;
  while (Date.now() < adapterReadyDeadline && destinationAdapter.exitCode === null) {
    try {
      const health = await fetch(`http://127.0.0.1:${destinationAdapterPort}/health`);
      if (health.ok && agentRegistry.listAlive().some((agent) => agent.name === "stdio-transfer")) {
        destinationAdapterReady = true;
        break;
      }
    } catch { /* adapter is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(destinationAdapterReady, `real stdio destination adapter registered and became ready: ${destinationAdapterStderr}`);

  const postAcpEvent = async (runId: string, body: Record<string, unknown>) =>
    fetch(`${acpBase}/runs/${runId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer shared-secret" },
      body: JSON.stringify(body),
    });

  const workerServer = fakeServer();
  registerBridgeTools(workerServer as any, { ...config, principalRole: "worker" });
  const reviewerServer = fakeServer();
  registerBridgeTools(reviewerServer as any, { ...config, principalRole: "reviewer" });
  const reviewerOpenAIServer = fakeServer();
  registerBridgeTools(reviewerOpenAIServer as any, {
    ...config,
    principalRole: "reviewer",
    connectionContext: { clientPlatformHint: "ChatGPT OpenAI" },
  });
  const reviewerOwnerAServer = fakeServer();
  registerBridgeTools(reviewerOwnerAServer as any, { ...config, principalRole: "reviewer", connectionConversationId: "owner-a" });
  const reviewerOwnerBServer = fakeServer();
  registerBridgeTools(reviewerOwnerBServer as any, { ...config, principalRole: "reviewer", connectionConversationId: "owner-b" });
  const reviewerTransportAServer = fakeServer();
  registerBridgeTools(reviewerTransportAServer as any, { ...config, principalRole: "reviewer", connectionMcpSessionId: "transport-a" });
  const reviewerTransportBServer = fakeServer();
  registerBridgeTools(reviewerTransportBServer as any, { ...config, principalRole: "reviewer", connectionMcpSessionId: "transport-b" });
  const clientServer = fakeServer();
  registerBridgeTools(clientServer as any, { ...config, principalRole: "client" });
  registerPolicyTools(reviewerServer as any, { eventStore, policyEngine, approvalRequests, principalRole: "reviewer" });
  const workspaceGrantOldSession = workSessions.create({ workspaceSessionId: WS, submittedBy: "fixture", ownerContextId: "owner-a" }).id;
  const sameWorkspaceOtherOwnerSession = workSessions.create({ workspaceSessionId: WS, submittedBy: "fixture", ownerContextId: "owner-b" }).id;
  const otherWorkspaceSession = workSessions.create({ workspaceSessionId: VERIFY_WS, submittedBy: "fixture" }).id;
  const workspaceGrantStore = createSqliteGrantStore(db);
  workspaceGrantStore.insert({
    id: "a-policy-workspace-grant",
    principalId: "owner-a",
    scope: "workspace",
    scopeId: WS,
    approvalKey: "tool:write",
    createdAt: new Date().toISOString(),
  });
  workspaceGrantStore.insert({
    id: "b-policy-old-session-grant",
    principalId: "reviewer-fixture",
    scope: "work_session",
    scopeId: workspaceGrantOldSession,
    approvalKey: "tool:write",
    createdAt: new Date().toISOString(),
  });
  workspaceGrantStore.insert({
    id: "c-policy-other-owner-grant",
    principalId: "owner-b",
    scope: "work_session",
    scopeId: sameWorkspaceOtherOwnerSession,
    approvalKey: "tool:write",
    createdAt: new Date().toISOString(),
  });
  workspaceGrantStore.insert({
    id: "d-policy-other-workspace-grant",
    principalId: "reviewer-fixture",
    scope: "work_session",
    scopeId: otherWorkspaceSession,
    approvalKey: "tool:write",
    createdAt: new Date().toISOString(),
  });
  const workspaceGrantServer = fakeServer();
  registerPolicyTools(workspaceGrantServer as any, {
    eventStore,
    policyEngine: createPolicyEngine({ defaultMode: "allow", toolRules: {}, pathRules: [] }, workspaceGrantStore),
    approvalRequests,
    workSessions,
    principalRole: "reviewer",
  });
  const firstGrantPage = await workspaceGrantServer.handlers.get("list_policy_grants")!({ workspaceId: WS, limit: 1 });
  assert.deepEqual(firstGrantPage.structuredContent.grants.map((grant: { id: string }) => grant.id), ["a-policy-workspace-grant"]);
  assert.equal(firstGrantPage.structuredContent.nextCursor, "a-policy-workspace-grant");
  const secondGrantPage = await workspaceGrantServer.handlers.get("list_policy_grants")!({
    workspaceId: WS,
    limit: 1,
    afterId: firstGrantPage.structuredContent.nextCursor,
  });
  assert.deepEqual(secondGrantPage.structuredContent.grants.map((grant: { id: string }) => grant.id), ["b-policy-old-session-grant"],
    "workspace grant projection includes old sessions without scanning all grants in the Workspace App");
  assert.equal(secondGrantPage.structuredContent.nextCursor, "b-policy-old-session-grant");
  const thirdGrantPage = await workspaceGrantServer.handlers.get("list_policy_grants")!({
    workspaceId: WS,
    limit: 1,
    afterId: secondGrantPage.structuredContent.nextCursor,
  });
  assert.deepEqual(thirdGrantPage.structuredContent.grants.map((grant: { id: string }) => grant.id), ["c-policy-other-owner-grant"]);
  assert.equal(thirdGrantPage.structuredContent.nextCursor, undefined,
    "workspace projection excludes grants whose sessions belong to other workspaces");
  const ownerGrantServer = fakeServer();
  registerPolicyTools(ownerGrantServer as any, {
    eventStore,
    policyEngine: createPolicyEngine({ defaultMode: "allow", toolRules: {}, pathRules: [] }, workspaceGrantStore),
    approvalRequests,
    workSessions,
    principalRole: "reviewer",
    ownerContextId: "owner-a",
  });
  const ownerGrantPage = await ownerGrantServer.handlers.get("list_policy_grants")!({ workspaceId: WS, limit: 10 });
  assert.deepEqual(ownerGrantPage.structuredContent.grants.map((grant: { id: string }) => grant.id), [
    "a-policy-workspace-grant",
    "b-policy-old-session-grant",
  ], "workspace grant pagination applies owner scoping inside the query without leaking hidden grant cursors");
  const callWorker = (name: string, args: any) => workerServer.handlers.get(name)!(args);
  const callReviewer = (name: string, args: any) => reviewerServer.handlers.get(name)!(args);
  const callOpenAIReviewer = (name: string, args: any) => reviewerOpenAIServer.handlers.get(name)!(args);
  const callOwnerA = (name: string, args: any) => reviewerOwnerAServer.handlers.get(name)!(args);
  const callOwnerB = (name: string, args: any) => reviewerOwnerBServer.handlers.get(name)!(args);
  const callTransportA = (name: string, args: any) => reviewerTransportAServer.handlers.get(name)!(args);
  const callTransportB = (name: string, args: any) => reviewerTransportBServer.handlers.get(name)!(args);
  const createIsolatedReviewerContext = (conversationId: string) => {
    const isolatedServer = fakeServer();
    const mcpSessionId = `review-session-${conversationId}`;
    registerBridgeTools(isolatedServer as any, {
      ...config,
      principalRole: "reviewer",
      principalId: "role:reviewer",
      // Copyable host conversation IDs are correlation metadata only. The
      // authenticated MCP session is the context-binding authority.
      connectionConversationId: "same-untrusted-host-conversation",
      connectionMcpSessionId: mcpSessionId,
    });
    return {
      contextId: `principal:role:reviewer|mcp-session:${mcpSessionId}`,
      call: (name: string, args: any) => isolatedServer.handlers.get(name)!(args),
    };
  };
  const activateForReviewerContext = (routeId: string, contextId: string) => {
    const grant = reviewThreads.createActivation({ routeId, ownerPrincipalId: "role:reviewer", reviewerPrincipalId: "role:reviewer" });
    return reviewThreads.activate({ activationSecret: grant.activationSecret, principalId: "role:reviewer", contextId });
  };
  const callClient = (name: string, args: any) => clientServer.handlers.get(name)!(args);

  // ── App visibility contract: every iframe-called tool grants app visibility ──
  for (const toolName of [
    "await_work_session_events",
    "get_review_submission",
    "submit_to_coding_agent",
    "provide_review_feedback",
    "provide_policy_approval",
  ]) {
    const visibility = reviewerServer.configs.get(toolName)?._meta?.ui?.visibility ?? [];
    assert.ok(visibility.includes("app"), `${toolName} grants app visibility`);
  }

  {
    const reviewed = await callWorker("start_work_session", {
      workspaceId: WS,
      completionPolicy: "webui_approval_required",
    });
    assert.ok(!reviewed.isError, "start_work_session accepts reviewed completion policy");
    assert.equal(workSessions.get(reviewed.structuredContent.sessionId)!.completionPolicy, "webui_approval_required");
  }

  // ── Session/approval read authorization ──
  {
    const sessionA = createSession();
    const sessionB = createSession();
    const clientRead = await callClient("get_work_session", { sessionId: sessionA });
    assert.ok(clientRead.isError, "ordinary client cannot read arbitrary work session state");
    const clientReviews = await callClient("list_pending_reviews", {});
    assert.ok(clientReviews.isError, "ordinary client cannot enumerate pending reviews");

    const clientPolicyServer = fakeServer();
    registerPolicyTools(clientPolicyServer as any, { eventStore, policyEngine, approvalRequests, principalRole: "client" });
    const clientPolicy = (name: string, args: any) => clientPolicyServer.handlers.get(name)!(args);
    const approvalList = await clientPolicy("list_pending_approvals", {});
    assert.ok(approvalList.isError, "ordinary client cannot enumerate pending approvals");

    const boundA = fakeServer();
    registerBridgeTools(boundA as any, { ...config, principalRole: "worker", connectionWorkSessionId: sessionA } as BridgeConfig);
    const callBoundA = (name: string, args: any) => boundA.handlers.get(name)!(args);
    assert.ok(!(await callBoundA("get_work_session", { sessionId: sessionA })).isError, "bound worker can read own session");
    assert.ok((await callBoundA("get_work_session", { sessionId: sessionB })).isError, "bound worker cannot read another session");
  }

  // ── Scenario 1: full WebUI→agent→review→changes→resume→approve ──
  // A live parked waiter must suppress the duplicate dispatcher worker.
  {
    const sessionId = createSession();
    const s0 = await callWorker("submit_for_review", { sessionId });
    assert.equal(workSessions.get(sessionId)!.status, "awaiting_review");
    assert.ok(!s0.isError, "initial submit ok");
    assert.ok((await callWorker("provide_review_feedback", { sessionId, verdict: "approve" })).isError, "worker cannot self-approve");
    assert.ok((await callClient("provide_review_feedback", { sessionId, verdict: "approve" })).isError, "ordinary client cannot approve");

    // Agent parks on await_review_feedback.
    const waiterP = callWorker("await_review_feedback", { sessionId, timeoutMs: 5000 });

    // Reviewer requests changes.
    const fbRes = await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "fix the bug" });
    assert.equal(workSessions.get(sessionId)!.status, "changes_requested");

    assert.equal(
      continuationManager.listPending().filter((c) => c.sessionId === sessionId).length,
      0,
      "live waiter claims the continuation immediately",
    );
    assert.equal(
      continuationManager.listForSession(sessionId).filter((c) => c.status === "claimed").length,
      1,
      "claimed continuation is not completed before resubmission",
    );

    // Dispatcher tick while a live waiter is parked -> NO duplicate dispatch.
    await runContinuationTick(config);
    assert.equal(resumeCalls, 0, "live waiter suppresses duplicate dispatch");

    // Wake the live waiter (normally done by the feedback event + await return).
    const res = await waiterP;
    assert.equal(res.structuredContent.status, "feedback_ready");
    assert.equal(res.structuredContent.feedback.verdict, "changes_requested");
    const continuationId = res.structuredContent.feedback.continuationId;
    assert.ok(continuationId, "await returns the claimed continuation id");
    assert.equal(continuationManager.get(continuationId)!.status, "claimed");
    const continuation = continuationManager.get(continuationId)!;
    const promptRes = await callWorker("get_continuation_prompt", { feedbackEventId: continuation.feedbackEventId });
    assert.ok(!promptRes.isError, "continuation prompt loads by feedback event id");
    assert.equal(promptRes.structuredContent.continuationId, continuationId);
    assert.equal(promptRes.structuredContent.sessionId, sessionId);
    assert.equal(promptRes.structuredContent.verdict, "changes_requested");
    assert.match(promptRes.structuredContent.prompt, /get_work_session\(sessionId=/, "prompt uses exact sessionId field name");

    // Exactly one resumed worker: the live agent resubmits.
    const s1 = await callWorker("submit_for_review", { sessionId, continuationId });
    assert.ok(!s1.isError, "resumed submit allowed");
    assert.equal(workSessions.getSubmissions(sessionId).length, 2, "exactly one resumed submission (total 2)");
    assert.equal(resumeCalls, 0, "no duplicate worker from dispatcher");
    assert.equal(continuationManager.get(continuationId)!.status, "completed");

    // Reviewer approves -> terminal.
    await callReviewer("provide_review_feedback", { sessionId, verdict: "approve" });
    assert.equal(workSessions.get(sessionId)!.status, "approved");

    // Dispatcher must not re-open a terminal session.
    await runContinuationTick(config);
    assert.equal(resumeCalls, 0);

    // Late submit on an approved session is rejected (no re-open).
    const late = await callWorker("submit_for_review", { sessionId });
    assert.ok(late.isError, "late submit on approved session is rejected");
    assert.equal(workSessions.getSubmissions(sessionId).length, 2, "no new submission after terminal");

    // Late changes_requested on an approved session is also rejected.
    const lateFb = await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested" });
    assert.ok(lateFb.isError, "late feedback on approved session is rejected");
  }

  // ── Scenario 1.0: PTY-style retry identity replays one durable review submission ──
  {
    const sessionId = createSession();
    const server = fakeServer();
    registerBridgeTools(server as any, {
      ...config,
      principalRole: "worker",
      mutationReceipts: createMutationReceiptStore(db),
    } as BridgeConfig);
    const call = (name: string, args: any) => server.handlers.get(name)!(args);
    const request = {
      sessionId,
      message: "Retry this exact logical checkpoint safely.",
      clientMutationId: "pty-review-retry-integration",
    };
    const first = await call("submit_for_review", request);
    const retry = await call("submit_for_review", request);
    assert.ok(!first.isError && !retry.isError, "the original submission and exact retry both return success");
    assert.equal(retry.structuredContent.submissionId, first.structuredContent.submissionId,
      "a lost CLI response can be retried with the same durable submission receipt");
    assert.equal(workSessions.getSubmissions(sessionId).length, 1,
      "same-key retry does not create a second review submission");
    const conflicting = await call("submit_for_review", {
      ...request,
      message: "Different content must not reuse the receipt.",
    });
    assert.equal(conflicting.isError, true, "reusing the key for different content fails closed");
    assert.equal(workSessions.getSubmissions(sessionId).length, 1,
      "conflicting retry content cannot create another submission");
  }

  // ── Scenario 1.1: committed transfer stays committed during later live feedback ──
  {
    const sessionId = createSession();
    await callWorker("submit_for_review", { sessionId });
    const transferId = `committed-transfer-${sessionId}`;
    eventStore.appendEvent({
      type: "session.handoff",
      sessionId,
      payload: { transferId, runId: `run-${sessionId}`, fromAgent: "source", toAgent: "destination" },
    });
    eventStore.appendEvent({
      type: "session.handoff.state",
      sessionId,
      payload: { transferId, state: "committed" },
    });

    const waiter = callWorker("await_review_feedback", { sessionId, timeoutMs: 5_000 });
    const waiterDeadline = Date.now() + 1_000;
    while (!liveWaiters.has(sessionId) && Date.now() < waiterDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(liveWaiters.has(sessionId), "destination worker is parked for its next review round");
    await callReviewer("provide_review_feedback", {
      sessionId,
      verdict: "changes_requested",
      comments: "Continue in the already transferred worker session.",
    });
    await runContinuationTick(config);
    const handoffStates = eventStore.getEventsForSession(sessionId)
      .filter((event) => event.type === "session.handoff.state" && (event.payload as Record<string, unknown>).transferId === transferId)
      .map((event) => (event.payload as Record<string, unknown>).state);
    assert.deepEqual(handoffStates, ["committed"],
      "a later live continuation must not regress a completed transfer to quiescing_source");
    const feedback = await waiter;
    assert.equal(feedback.structuredContent.status, "feedback_ready");
    assert.equal(feedback.structuredContent.feedback.verdict, "changes_requested");
  }

  // ── Scenario 1a: explicit handoff preserves origin and binds a fresh destination context ──
  {
    const sessionId = createSession();
    await callReviewer("configure_review_loop", {
      workSessionId: sessionId,
      enabled: true,
      mode: "isolated_review",
      maxReviewRounds: 3,
    });
    const sourceAgent = agentRegistry.listAlive().find((agent) => agent.name === "cli-coding-agent")!;
    const initialCheckpoint = await callWorker("submit_for_review", { sessionId, message: "Initial implementation checkpoint." });
    assert.ok(!initialCheckpoint.isError);
    const reviewRoute = reviewRoutes.getRouteBySession(sessionId)!;
    const firstReviewHandoff = reviewRoutes.getHandoffBySubmission(
      sessionId,
      initialCheckpoint.structuredContent.submissionId,
      initialCheckpoint.structuredContent.reviewEpoch,
    )!;
    const reviewContext = createIsolatedReviewerContext("cross-agent-review-continuity");
    const reviewThread = activateForReviewerContext(reviewRoute.id, reviewContext.contextId);
    const firstClaim = await reviewContext.call("claim_review_handoff", {
      handoffId: firstReviewHandoff.id,
      expectedRevision: firstReviewHandoff.revision,
      reviewThreadId: reviewThread.id,
    });
    assert.ok(!firstClaim.isError, "the exact first submission is claimed by the selected reviewer thread");
    const originalTask = `Implement the handoff fixture behavior. ${"Keep the full task context intact across the worker transfer. ".repeat(24)}`;
    const originRun = agentRegistry.createRun({
      agentName: sourceAgent.name,
      agentId: sourceAgent.id,
      workspaceSessionId: WS,
      workSessionId: sessionId,
      inputTask: originalTask,
      inputPreview: originalTask.slice(0, 500),
      status: "awaiting_review",
    });
    const parkedSourcePromise = callWorker("await_review_feedback", { sessionId, timeoutMs: 5000 });
    const parkedDeadline = Date.now() + 1000;
    while (!liveWaiters.has(sessionId) && Date.now() < parkedDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(liveWaiters.has(sessionId), "the source worker is parked on the review continuation before handoff");
    const runId = originRun.runId;
    const handoff = await callReviewer("handoff_work_session", {
      sessionId,
      toAgent: "stdio-transfer",
      reason: "Continue using the second adapter.",
    });
    assert.equal(handoff.structuredContent.status, "requested", "handoff reports a durable request, not a completed transfer");
    const parkedSource = await parkedSourcePromise;
    assert.equal(parkedSource.structuredContent.status, "transferred", "the parked source is instructed to stop instead of consuming destination feedback");
    assert.equal(liveWaiters.has(sessionId), false, "the source waiter is removed before destination dispatch");
    const handoffEvent = eventStore.getEventsForSession(sessionId).find((event) => event.type === "session.handoff")!;
    const handoffPayload = handoffEvent.payload as Record<string, any>;
    assert.equal(handoffPayload.state, "requested");
    assert.equal(handoffPayload.contextTransferPacket.task, originalTask,
      "context transfer uses the exact original task rather than its bounded display preview");
    assert.equal(handoffPayload.contextTransferPacket.taskSha256, createHash("sha256").update(originalTask).digest("hex"),
      "context transfer carries the hash of the exact original task");
    assert.equal(handoffPayload.contextTransferPacket.taskComplete, true);
    assert.equal(handoffPayload.contextTransferPacket.checkpoint.snapshotKind, "git");
    assert.equal(handoffPayload.contextTransferPacket.checkpoint.snapshotRef, currentSnapshot,
      "context transfer binds the exact submitted checkpoint");
    assert.equal(handoffPayload.contextTransferPacket.checkpoint.submissionId, initialCheckpoint.structuredContent.submissionId);
    assert.equal(createHash("sha256").update(JSON.stringify(handoffPayload.contextTransferPacket)).digest("hex"), handoffPayload.contextTransferSha256,
      "the persisted context packet has an immutable content hash");
    const handoffFeedback = await reviewContext.call("submit_handoff_feedback", {
      handoffId: firstReviewHandoff.id,
      expectedRevision: firstClaim.structuredContent.revision,
      verdict: "changes_requested",
      comments: "Preserve the exact checkpoint and add the missing edge case.",
      requiredActions: ["Add the missing edge case"],
    });
    assert.ok(!handoffFeedback.isError, `handoff review feedback must persist: ${JSON.stringify(handoffFeedback)}`);
    await runContinuationTick({ ...config, resumeAgent: undefined });
    const destinationPromptDeadline = Date.now() + 5_000;
    while (Date.now() < destinationPromptDeadline) {
      try {
        const prompt = await import("node:fs/promises").then(({ readFile }) => readFile(destinationPromptPath, "utf8"));
        if (prompt.includes("Immutable cross-agent context transfer")) break;
      } catch { /* the adapter child has not received the prompt yet */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const destinationPrompt = await import("node:fs/promises").then(({ readFile }) => readFile(destinationPromptPath, "utf8"));
    assert.match(destinationPrompt, /Immutable cross-agent context transfer/, "the real ACP child receives the durable transfer packet in its prompt");
    assert.ok(destinationPrompt.includes(originalTask), "the real ACP child receives the exact original task");
    assert.ok(destinationPrompt.includes("Preserve the exact checkpoint and add the missing edge case."), "the real ACP child receives the latest committed reviewer feedback");
    assert.ok(destinationPrompt.includes(`\"snapshotRef\": \"${currentSnapshot}\"`), "the real ACP child receives the checkpoint identity");
    const destinationBody = destinationPrompt;
    const transferContextEvent = eventStore.getEventsForSession(sessionId).find((event) => event.type === "session.handoff.context")!;
    const transferContextPayload = transferContextEvent.payload as Record<string, any>;
    const destination = agentRegistry.listAlive().find((agent) => agent.name === "stdio-transfer")!;
    assert.equal(agentRegistry.getLatestDispatchAttemptForRun(runId)?.agentId, destination.id,
      "the real adapter's resumed attempt is authenticated as the destination agent");
    assert.ok(destinationBody.includes(String(handoff.structuredContent.transferId)));
    assert.ok(destinationBody.includes(String(transferContextPayload.contextTransferSha256)));
    assert.equal(transferContextPayload.contextTransferPacket.latestReviewerFeedback.comments,
      "Preserve the exact checkpoint and add the missing edge case.", "the transfer packet includes the latest committed reviewer feedback");
    assert.equal(transferContextPayload.contextTransferPacket.continuation.reviewEpoch,
      continuationManager.listForSession(sessionId).at(-1)?.reviewEpoch, "the packet binds the exact continuation review epoch");
    assert.equal(agentRegistry.getRun(runId)?.agentId, originRun.agentId, "the logical run retains the origin identity");
    assert.equal(agentRegistry.getLatestDispatchAttemptForRun(runId)?.agentId, destination.id,
      "the destination identity is stored on the new immutable attempt");
    const completedDeadline = Date.now() + 5_000;
    while (agentRegistry.getRun(runId)?.status !== "completed" && Date.now() < completedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(agentRegistry.getRun(runId)?.status, "completed",
      "the real stdio adapter's authoritative ACP end_turn settles the destination attempt");
    const handoffStates = eventStore.getEventsForSession(sessionId)
      .filter((event) => event.type === "session.handoff.state")
      .map((event) => (event.payload as Record<string, unknown>).state);
    assert.deepEqual(handoffStates.slice(-2), ["destination_ready", "committed"]);
    const sameExecutorHandoff = await callReviewer("handoff_work_session", {
      sessionId,
      toAgent: "stdio-transfer",
      reason: "The logical run still names its origin, but this is already the latest executor.",
    });
    assert.equal(sameExecutorHandoff.structuredContent.status, "unchanged",
      "handoff ownership follows the latest durable dispatch attempt, not the immutable origin run");
    assert.equal(eventStore.getEventsForSession(sessionId).filter((event) => event.type === "session.handoff").length, 1,
      "a same-destination request does not create a spurious second transfer");

    const secondCheckpoint = await callWorker("submit_for_review", {
      sessionId,
      message: "Destination implemented the requested edge case.",
    });
    assert.ok(!secondCheckpoint.isError, "the transferred destination can submit a second checkpoint to the original work session");
    const secondSubmission = workSessions.get(sessionId)!.latestSubmission!;
    const secondReviewHandoff = reviewRoutes.getHandoffBySubmission(sessionId, secondSubmission.id, secondSubmission.reviewEpoch)!;
    assert.ok(secondReviewHandoff, "the second destination checkpoint creates its own immutable review handoff");
    assert.equal(reviewRoutes.getRouteBySession(sessionId)?.id, reviewRoute.id, "round two remains bound to the original reviewer route");
    const secondClaim = await reviewContext.call("claim_review_handoff", {
      handoffId: secondReviewHandoff.id,
      expectedRevision: secondReviewHandoff.revision,
      reviewThreadId: reviewThread.id,
    });
    assert.ok(!secondClaim.isError, "the original reviewer thread can claim the destination's second checkpoint");
    const destinationFeedbackWaiter = callWorker("await_review_feedback", { sessionId, timeoutMs: 5_000 });
    const secondFeedback = await reviewContext.call("submit_handoff_feedback", {
      handoffId: secondReviewHandoff.id,
      expectedRevision: secondClaim.structuredContent.revision,
      verdict: "approve",
      comments: "Round two is approved on the same reviewer thread.",
    });
    assert.ok(!secondFeedback.isError, "the same reviewer thread commits round-two approval");
    const destinationFeedback = await destinationFeedbackWaiter;
    assert.equal(destinationFeedback.structuredContent.status, "feedback_ready", "the destination worker receives round-two feedback directly");
    assert.equal(destinationFeedback.structuredContent.feedback.verdict, "approve");
    assert.equal(workSessions.get(sessionId)?.id, sessionId, "review continuation preserves the original logical work session after transfer");
    assert.equal(workSessions.get(sessionId)?.status, "approved", "round-two reviewer approval settles the original work session");
  }

  // ── Scenario 1a.1: later transfer records its current executor, not run origin ──
  {
    const sessionId = createSession();
    const origin = agentRegistry.listAlive().find((agent) => agent.name === "cli-coding-agent")!;
    const currentExecutor = agentRegistry.listAlive().find((agent) => agent.name === "stdio-transfer")!;
    const nextExecutor = agentRegistry.listAlive().find((agent) => agent.name === "mimo-code")!;
    const run = agentRegistry.createRun({
      agentName: origin.name,
      agentId: origin.id,
      workspaceSessionId: WS,
      workSessionId: sessionId,
      inputTask: "Continue the already transferred work.",
      status: "awaiting_review",
    });
    const latestAttemptKey = `sequential-transfer-source-${sessionId}`;
    agentRegistry.beginDispatchAttempt({ key: latestAttemptKey, runId: run.runId, agentId: currentExecutor.id, attemptNumber: 2 });
    agentRegistry.updateDispatchAttempt(latestAttemptKey, { status: "accepted", remoteRunId: "current-executor-run" });
    const result = await callReviewer("handoff_work_session", {
      sessionId,
      toAgent: nextExecutor.name,
      reason: "Transfer from the current executor after a prior handoff.",
    });
    assert.equal(result.structuredContent.status, "requested");
    const event = eventStore.getEventsForSession(sessionId).find((candidate) => candidate.type === "session.handoff")!;
    const payload = event.payload as Record<string, unknown>;
    assert.equal(payload.fromAgentId, currentExecutor.id, "handoff provenance identifies the latest executor");
    assert.equal(agentRegistry.getRun(run.runId)?.agentId, origin.id, "the run continues to retain its immutable origin identity");
  }

  // ── Scenario 1a.2: a re-registered destination cannot inherit an old transfer ──
  {
    const sessionId = createSession();
    const source = agentRegistry.listAlive().find((agent) => agent.name === "cli-coding-agent")!;
    const destination = agentRegistry.listAlive().find((agent) => agent.name === "mimo-code")!;
    const submitted = await callWorker("submit_for_review", { sessionId, message: "Pin this handoff to the selected adapter identity." });
    assert.ok(!submitted.isError);
    agentRegistry.createRun({
      agentName: source.name,
      agentId: source.id,
      workspaceSessionId: WS,
      workSessionId: sessionId,
      inputTask: "Continue only on the reviewer-selected destination identity.",
      status: "awaiting_review",
    });
    const handoff = await callReviewer("handoff_work_session", { sessionId, toAgent: destination.name });
    assert.equal(handoff.structuredContent.status, "requested");
    await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: submitted.structuredContent.submissionId,
      verdict: "changes_requested",
      comments: "Continue after the explicit destination handoff.",
    });

    const rotatedRegistry = new Proxy(agentRegistry as any, {
      get(target, property) {
        if (property === "listAlive") {
          return () => target.listAlive().map((agent: any) => agent.id === destination.id
            ? { ...agent, id: `${agent.id}-replacement` }
            : agent);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const before = receivedRuns.length;
    await runContinuationTick({ ...config, agentRegistry: rotatedRegistry, resumeAgent: undefined } as BridgeConfig);
    assert.equal(receivedRuns.length, before, "a replacement registration with the same name does not receive the old transfer");
    assert.equal(continuationManager.listForSession(sessionId).at(-1)?.status, "pending",
      "the continuation remains recoverable until an explicit destination rebind");
    assert.ok(eventStore.getEventsForSession(sessionId).some((event) => event.type === "session.handoff.state"
      && (event.payload as Record<string, unknown>).transferId === handoff.structuredContent.transferId
      && (event.payload as Record<string, unknown>).state === "blocked"),
    "the handoff records the destination identity mismatch for reviewer-visible recovery");

    const rebindSession = createSession();
    const origin = agentRegistry.listAlive().find((agent) => agent.name === "cli-coding-agent")!;
    const priorDestinationAttempt = `rebind-source-${rebindSession}`;
    const rebindRun = agentRegistry.createRun({
      agentName: origin.name,
      agentId: origin.id,
      workspaceSessionId: WS,
      workSessionId: rebindSession,
      inputTask: "Continue under a reviewer-approved replacement adapter.",
      status: "awaiting_review",
    });
    agentRegistry.beginDispatchAttempt({
      key: priorDestinationAttempt,
      runId: rebindRun.runId,
      agentId: destination.id,
      attemptNumber: 2,
    });
    agentRegistry.updateDispatchAttempt(priorDestinationAttempt, { status: "accepted", remoteRunId: "prior-destination-run" });
    const rotatedReviewer = fakeServer();
    registerBridgeTools(rotatedReviewer as any, {
      ...config,
      agentRegistry: rotatedRegistry,
      principalRole: "reviewer",
    } as BridgeConfig);
    const rebind = await rotatedReviewer.handlers.get("handoff_work_session")!({
      sessionId: rebindSession,
      toAgent: destination.name,
      reason: "Approve the replacement registration with the same routing name.",
    });
    assert.equal(rebind.structuredContent.status, "requested",
      "a replacement with the same name can be explicitly re-bound by durable identity");
    const rebindEvent = eventStore.getEventsForSession(rebindSession).find((event) => event.type === "session.handoff")!;
    assert.equal((rebindEvent.payload as Record<string, unknown>).toAgentId, `${destination.id}-replacement`,
      "the new transfer binds to the replacement registration identity");
  }

  // ── Scenario 1b: a live source lease fences destination mutation until quiescence ──
  {
    const sessionId = createSession();
    const sourceAgent = agentRegistry.listAlive().find((agent) => agent.name === "cli-coding-agent")!;
    const submitted = await callWorker("submit_for_review", { sessionId, message: "Live source checkpoint." });
    assert.ok(!submitted.isError);
    const sourceRun = agentRegistry.createRun({
      agentName: sourceAgent.name,
      agentId: sourceAgent.id,
      workspaceSessionId: WS,
      workSessionId: sessionId,
      inputPreview: "Continue the live source task.",
      status: "running",
    });
    const sourceDispatch = `handoff-live-source-${sessionId}`;
    agentRegistry.beginDispatchAttempt({ key: sourceDispatch, runId: sourceRun.runId, agentId: sourceAgent.id, attemptNumber: 1 });
    agentRegistry.updateDispatchAttempt(sourceDispatch, { status: "accepted", remoteRunId: "live-source-remote" });
    agentRegistry.updateRun(sourceRun.runId, {
      remoteRunId: "live-source-remote",
      workerLeaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    const handoff = await callReviewer("handoff_work_session", { sessionId, toAgent: "mimo-code", reason: "Wait for source quiescence." });
    assert.equal(handoff.structuredContent.status, "requested");
    await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: submitted.structuredContent.submissionId,
      verdict: "changes_requested",
      comments: "Continue after the source relinquishes its lease.",
    });
    assert.equal(agentRegistry.getRun(sourceRun.runId)?.status, "changes_requested");
    assert.equal(agentRegistry.getRun(sourceRun.runId)?.agentId, sourceAgent.id);
    assert.equal(agentRegistry.getLatestDispatchAttemptForRun(sourceRun.runId)?.agentId, sourceAgent.id);
    assert.ok(Date.parse(agentRegistry.getRun(sourceRun.runId)?.workerLeaseUntil ?? "") > Date.now());
    const before = receivedRuns.length;
    await runContinuationTick({ ...config, resumeAgent: undefined });
    assert.equal(receivedRuns.length, before, `destination is not dispatched while the source owns a live mutation lease; run=${JSON.stringify(agentRegistry.getRun(sourceRun.runId))}; attempt=${JSON.stringify(agentRegistry.getLatestDispatchAttemptForRun(sourceRun.runId))}; body=${JSON.stringify(receivedRuns.at(-1))}`);
    assert.equal(continuationManager.listForSession(sessionId).at(-1)?.status, "pending",
      "the continuation stays recoverable while source shutdown is pending");
    assert.ok(eventStore.getEventsForSession(sessionId).some((event) => event.type === "session.handoff.state"
      && (event.payload as Record<string, unknown>).state === "quiescing_source"));
    agentRegistry.updateRun(sourceRun.runId, { status: "awaiting_review", workerLeaseUntil: null });
    const pendingHandoffOutbox = dispatchOutbox.listByAggregate(continuationManager.listForSession(sessionId).at(-1)!.id)[0];
    db.sqlite.prepare("update dispatch_outbox set available_at = ? where id = ?").run(new Date(Date.now() - 1000).toISOString(), pendingHandoffOutbox.id);
    await runContinuationTick({ ...config, resumeAgent: undefined });
    assert.equal(receivedRuns.length, before + 1, "destination dispatch begins after source quiescence is observed");
    assert.equal(receivedRuns.at(-1)?.agent_id, agentRegistry.listAlive().find((agent) => agent.name === "mimo-code")?.id);
    await callReviewer("cancel_work_session", { sessionId });
    reviewWorkflow.finalizeCancellation({ sessionId, reason: "source quiescence fixture complete" });
  }

  // ── Scenario 2: dead agent (no live waiter) -> exactly one redispatch ──
  // A lost destination acceptance response is reconciled by the exact durable
  // attempt identity; it must never create a second destination launch.
  {
    const sessionId = createSession();
    const submitted = await callWorker("submit_for_review", { sessionId, message: "Checkpoint before uncertain transfer." });
    assert.ok(!submitted.isError);
    const source = agentRegistry.listAlive().find((agent) => agent.name === "cli-coding-agent")!;
    const origin = agentRegistry.createRun({
      agentName: source.name,
      agentId: source.id,
      workspaceSessionId: WS,
      workSessionId: sessionId,
      inputPreview: "Transfer with acceptance response loss.",
      status: "awaiting_review",
    });
    const handoff = await callReviewer("handoff_work_session", { sessionId, toAgent: "mimo-code", reason: "Exercise exact-attempt reconciliation." });
    assert.equal(handoff.structuredContent.status, "requested");
    const feedback = await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: submitted.structuredContent.submissionId,
      verdict: "changes_requested",
      comments: "Continue on the destination agent.",
    });
    assert.ok(!feedback.isError);
    const continuation = continuationManager.listForSession(sessionId).at(-1)!;
    const before = receivedRuns.length;
    dropNextDispatchResponse = true;
    await runContinuationTick({ ...config, resumeAgent: undefined });
    assert.equal(receivedRuns.length, before + 1, "the destination receives one launch whose acceptance response is lost");
    assert.equal(continuationManager.get(continuation.id)?.status, "reconciliation_required",
      "uncertain destination acceptance is durably fenced from automatic redispatch");
    assert.equal(agentRegistry.getRun(origin.runId)?.status, "dispatch_uncertain");
    const attempt = agentRegistry.getLatestDispatchAttemptForRun(origin.runId)!;
    assert.equal(attempt.status, "uncertain");
    assert.ok(acceptedDispatches.has(attempt.dispatchIdempotencyKey), "the test adapter durably records the exact accepted dispatch");
    const acceptedCount = receivedRuns.length;
    await runContinuationTick({ ...config, resumeAgent: undefined });
    assert.equal(receivedRuns.length, acceptedCount, "reconciliation does not issue a second worker launch");
    assert.equal(continuationManager.get(continuation.id)?.status, "dispatched",
      "the continuation commits after exact adapter lookup confirms acceptance");
    assert.equal(agentRegistry.getLatestDispatchAttemptForRun(origin.runId)?.status, "accepted");
    const handoffStates = eventStore.getEventsForSession(sessionId)
      .filter((event) => event.type === "session.handoff.state")
      .map((event) => (event.payload as Record<string, unknown>).state);
    assert.deepEqual(handoffStates.slice(-2), ["destination_ready", "committed"]);
    const destinationWaiter = callWorker("await_review_feedback", { sessionId, timeoutMs: 5_000 });
    const secondSubmission = await callWorker("submit_for_review", {
      sessionId,
      message: "The destination completed the reconciled continuation.",
    });
    assert.ok(!secondSubmission.isError, "the destination can submit after uncertain acceptance is reconciled");
    const secondFeedback = await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: secondSubmission.structuredContent.submissionId,
      verdict: "approve",
      comments: "The destination continuation is approved.",
    });
    assert.ok(!secondFeedback.isError, "the destination's second checkpoint can be reviewed");
    const destinationFeedback = await destinationWaiter;
    assert.equal(destinationFeedback.structuredContent.status, "feedback_ready");
    assert.equal(destinationFeedback.structuredContent.feedback.verdict, "approve",
      "reconciliation marks transferred feedback consumed, so the destination receives only round-two feedback");
    await callReviewer("cancel_work_session", { sessionId });
  }

  // ── Scenario 2: dead agent (no live waiter) -> exactly one redispatch ──
  {
    const sessionId = createSession();
    await callWorker("submit_for_review", { sessionId });
    agentRegistry.createRun({
      agentName: "cli-coding-agent",
      workspaceSessionId: WS,
      workSessionId: sessionId,
      inputPreview: "original cli dispatch",
      status: "running",
    });
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "Please address the reviewed issue before resubmitting." });
    assert.equal(
      dispatchOutbox.listPending().filter((event) => event.aggregateId === continuationManager.listForSession(sessionId)[0]?.id).length,
      1,
      "changes_requested enqueues a durable continuation dispatch event",
    );

    // No live waiter registered -> dispatcher re-dispatches.
    await runContinuationTick(config);
    assert.equal(resumeCalls, 1, "dead-agent dispatcher redispatch #1");
    // A second tick must NOT double-dispatch (continuation delivered).
    await runContinuationTick(config);
    assert.equal(resumeCalls, 1, "no duplicate redispatch on second tick");
    assert.equal(
      continuationManager.listPending().filter((c) => c.sessionId === sessionId).length,
      0,
      "pending continuation claimed after dispatch",
    );
  }

  // ── Scenario 2a: temporary agent unavailability releases instead of dead-lettering ──
  {
    const sessionId = createSession();
    await callWorker("submit_for_review", { sessionId });
    agentRegistry.createRun({
      agentName: "cli-coding-agent",
      workspaceSessionId: WS,
      workSessionId: sessionId,
      inputPreview: "temporarily unavailable agent",
      status: "running",
    });
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "Retry after the agent returns." });
    const continuation = continuationManager.listForSession(sessionId).find((entry) => entry.status === "pending");
    assert.ok(continuation);
    const unavailableConfig = {
      ...config,
      agentRegistry: {
        getRunByWorkSessionId: agentRegistry.getRunByWorkSessionId.bind(agentRegistry),
        listAlive: () => [],
      },
    } as unknown as BridgeConfig;
    await runContinuationTick(unavailableConfig);
    const deferred = dispatchOutbox.listByAggregate(continuation.id)[0];
    assert.equal(deferred.status, "pending", `agent unavailability leaves the continuation queued: ${JSON.stringify({ deferred, continuation: continuationManager.get(continuation.id) })}`);
    assert.equal(deferred.failureCount, 0, "temporary unavailability does not consume genuine-failure budget");
    assert.equal(continuationManager.get(continuation.id)?.status, "pending");

    db.sqlite.prepare("update dispatch_outbox set available_at = ? where id = ?").run("2000-01-01T00:00:00.000Z", deferred.id);
    const before = resumeCalls;
    await runContinuationTick(config);
    assert.equal(resumeCalls, before + 1, "the same logical continuation dispatches when an agent is healthy again");
  }

  // ── Scenario 2b: cancellation supersedes pending continuations and prevents relaunch ──
  {
    const sessionId = createSession();
    await callWorker("submit_for_review", { sessionId });
    agentRegistry.createRun({
      agentName: "cli-coding-agent",
      workspaceSessionId: WS,
      workSessionId: sessionId,
      inputPreview: "cancellable dispatch",
      status: "running",
    });
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "Please address the reviewed issue before resubmitting." });
    const pending = continuationManager.listForSession(sessionId).find((c) => c.status === "pending");
    assert.ok(pending, "changes_requested creates a pending continuation");

    const cancellation = config.reviewWorkflow.cancelSession({ sessionId, reason: "test cancellation" });
    assert.equal(cancellation.status, "cancelling",
      "a correlated run with no remote ID or dispatch receipt remains fenced as an unknown worker state");
    assert.equal(workSessions.get(sessionId)!.status, "cancelling");
    assert.equal(eventStore.getEventsForSession(sessionId).some((event) => event.type === "agent.run.cancelled"), false,
      "missing remote metadata does not fabricate worker shutdown");
    assert.equal(continuationManager.get(pending.id)?.status, "superseded");

    const before = resumeCalls;
    await runContinuationTick(config);
    assert.equal(resumeCalls, before, "cancelled sessions are not relaunched from continuations");
  }

  // ── Scenario 2c: cancellation during dispatch cannot overwrite superseded -> dispatched ──
  {
    const sessionId = createSession();
    await callWorker("submit_for_review", { sessionId });
    const run = agentRegistry.createRun({
      agentName: "cli-coding-agent",
      workspaceSessionId: WS,
      workSessionId: sessionId,
      inputPreview: "race dispatch",
      status: "running",
    });
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "Please address the reviewed issue before resubmitting." });
    const pending = continuationManager.listForSession(sessionId).find((c) => c.status === "pending");
    assert.ok(pending, "changes_requested creates pending continuation for race test");

    let adapterCalls = 0;
    const raceConfig: BridgeConfig = {
      ...config,
      beforeContinuationDispatch: async () => {
        config.reviewWorkflow.cancelSession({ sessionId, reason: "cancelled during dispatch" });
      },
      resumeAgent: async () => {
        adapterCalls++;
      },
    };
    await runContinuationTick(raceConfig);
    assert.equal(adapterCalls, 0, "no adapter call occurs after cancellation wins the dispatch race");
    assert.equal(workSessions.get(sessionId)!.status, "cancelling",
      "cancellation during an uncertain continuation dispatch does not release the session early");
    assert.equal(authorizeWorkSessionAction(workSessions, { workSessionId: sessionId, tool: "edit" }).allowed, false,
      "cancellation fences further worker mutations");
    assert.equal(authorizeWorkSessionAction(workSessions, { workSessionId: sessionId, tool: "await_review_feedback" }).allowed, true,
      "an already waiting worker may observe the cancellation signal and exit");
    assert.equal(continuationManager.get(pending.id)?.status, "superseded", "late delivery CAS does not overwrite superseded continuation");
    assert.equal(agentRegistry.getRun(run.runId)?.status, "cancelling", "logical run remains fenced until shutdown evidence arrives");
  }

  // ── Scenario 2d: pre-outbox pending continuations are backfilled into the outbox ──
  {
    const sessionId = createSession();
    agentRegistry.createRun({
      agentName: "cli-coding-agent",
      workspaceSessionId: WS,
      workSessionId: sessionId,
      inputPreview: "legacy pending continuation",
      status: "running",
    });
    const legacy = continuationManager.create({
      sessionId,
      reviewId: "review-legacy",
      feedbackEventId: "feedback-legacy",
      verdict: "changes_requested",
    });
    assert.equal(dispatchOutbox.hasActive("continuation.ready", legacy.id), false, "legacy continuation starts without outbox row");
    const before = resumeCalls;
    await runContinuationTick(config);
    assert.equal(resumeCalls, before + 1, "dispatcher backfills and redrives legacy pending continuation");
    assert.equal(continuationManager.get(legacy.id)?.status, "dispatched");
  }

  // ── Scenario 2e: genuine dead letters emit attention and require reviewer redrive ──
  {
    const sessionId = createSession();
    await callWorker("submit_for_review", { sessionId });
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "Please address the reviewed issue before resubmitting." });
    const continuation = continuationManager.listForSession(sessionId).find((c) => c.status === "pending");
    assert.ok(continuation, "changes_requested creates a pending continuation for dead-letter test");

    for (let i = 0; i < 3; i++) {
      await runContinuationTick(config);
      db.sqlite
        .prepare("update dispatch_outbox set available_at = ? where aggregate_id = ? and status = 'pending'")
        .run("2000-01-01T00:00:00.000Z", continuation.id);
    }

    const deadLetter = db.sqlite
      .prepare("select status, attempt_count from dispatch_outbox where aggregate_id = ?")
      .get(continuation.id) as { status: string; attempt_count: number };
    assert.equal(deadLetter.status, "dead_lettered", "third failed dispatch dead-letters the outbox row");
    assert.ok(eventStore.getEventsForSession(sessionId).some((event) => event.type === "continuation.dispatch_attention"),
      "a genuine continuation dead letter emits a durable reviewer attention event");

    await runContinuationTick(config);
    const rowCount = db.sqlite
      .prepare("select count(*) as count from dispatch_outbox where aggregate_id = ?")
      .get(continuation.id) as { count: number };
    assert.equal(rowCount.count, 1, "dead-lettered continuation is not automatically backfilled as a fresh outbox row");

    const reviewerRedrive = await callReviewer("redrive_continuation", {
      workSessionId: sessionId,
      continuationId: continuation.id,
    });
    assert.equal(reviewerRedrive.isError, undefined, "reviewer can redrive the failed continuation");
    assert.equal(reviewerRedrive.structuredContent.redriven, true);
    const redriven = dispatchOutbox.listByAggregate(continuation.id)[0];
    assert.equal(redriven.status, "pending", "reviewer redrive resets the dead-lettered row");
    assert.equal(redriven.attemptCount, 0, "reviewer redrive resets the claim counter");
    assert.ok(eventStore.getEventsForSession(sessionId).some((event) => event.type === "continuation.redriven"),
      "redrive is recorded as a durable workspace event");
  }

  // ── Scenario 3: stale feedback is not replayed ──
  {
    const sessionId = createSession();
    await callWorker("submit_for_review", { sessionId });
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "Please address the reviewed issue before resubmitting." });
    const w = callWorker("await_review_feedback", { sessionId, timeoutMs: 100 });
    const fr = await w;
    assert.equal(fr.structuredContent.status, "feedback_ready");
    const continuationId = fr.structuredContent.feedback.continuationId;
    await callWorker("submit_for_review", { sessionId, continuationId });

    // A fresh await WITHOUT lastSeenFeedbackId must block (timeout), not
    // immediately re-return the already-consumed feedback.
    const w2 = callWorker("await_review_feedback", { sessionId, timeoutMs: 100 });
    const fr2 = await w2;
    assert.equal(fr2.structuredContent.status, "timeout", "stale feedback not replayed");
  }

  // ── Scenario 4: workspace is required for dispatch ──
  {
    // Dispatch without a workspace must be rejected (uncorrelated task).
    const missingWorkspace = await callReviewer("submit_to_coding_agent", { task: "do a thing" });
    assert.ok(missingWorkspace.isError, "submit_to_coding_agent without workspaceSessionId fails");

    // Dispatch with a valid workspace creates a work session and returns both
    // the Kontrol-owned runId and the workSessionId.
    const r = await callReviewer("submit_to_coding_agent", { task: "do a thing", workspaceSessionId: WS });
    assert.ok(!r.isError, "submit_to_coding_agent with workspaceSessionId succeeds");
    assert.ok(r.structuredContent.runId, "returns a Kontrol runId");
    assert.ok(r.structuredContent.workSessionId, "returns a workSessionId");
    assert.equal(agentRegistry.getRun(r.structuredContent.runId)!.agentName, "cli-coding-agent");
    assert.equal(workSessions.get(r.structuredContent.workSessionId)!.completionPolicy, "webui_approval_required");

    const busy = await callReviewer("submit_to_coding_agent", { task: "second checkout worker", workspaceSessionId: WS });
    assert.ok(busy.isError, "second modifying dispatch in same checkout is rejected");
    assert.match(String(busy.content[0]?.text ?? ""), /already controlled/i, "busy checkout message names the conflict");
    await callReviewer("cancel_work_session", { sessionId: r.structuredContent.workSessionId });
    reviewWorkflow.finalizeCancellation({ sessionId: r.structuredContent.workSessionId, reason: "test adapter stopped" });

    const legacySessionId = workSessions.create({
      workspaceSessionId: WS,
      submittedBy: "webui",
      completionPolicy: "webui_approval_required",
    }).id;
    const legacy = await callReviewer("submit_to_coding_agent", { task: "legacy exposed schema", sessionId: legacySessionId });
    assert.ok(!legacy.isError, `legacy sessionId alias resolves workspace from existing work session: ${JSON.stringify(legacy)}`);
    assert.equal(legacy.structuredContent.workSessionId, legacySessionId);
    assert.equal(receivedRuns.at(-1)?.workspace_root, "/tmp", "legacy alias dispatch still supplies workspace_root");
    await callReviewer("cancel_work_session", { sessionId: legacySessionId });
    reviewWorkflow.finalizeCancellation({ sessionId: legacySessionId, reason: "test adapter stopped" });

    const publicAlias = await callReviewer("submit_to_coding_agent", { task: "public workspace alias", workspaceId: WS });
    assert.ok(!publicAlias.isError, "public workspaceId alias dispatches");
    assert.equal(publicAlias.structuredContent.workspaceSessionId, WS);
    await callReviewer("cancel_work_session", { sessionId: publicAlias.structuredContent.workSessionId });
    reviewWorkflow.finalizeCancellation({ sessionId: publicAlias.structuredContent.workSessionId, reason: "test adapter stopped" });

    const mimo = await callReviewer("submit_to_coding_agent", {
      task: "do a MIMO thing",
      workspaceSessionId: WS,
      agentName: "mimo-code",
    });
    assert.ok(!mimo.isError, "submit_to_coding_agent can target mimo-code");
    assert.equal(agentRegistry.getRun(mimo.structuredContent.runId)!.agentName, "mimo-code");
    assert.equal(receivedRuns.at(-1)?.agent_name, "mimo-code", "initial dispatch uses selected agent name");
    await callReviewer("cancel_work_session", { sessionId: mimo.structuredContent.workSessionId });
    reviewWorkflow.finalizeCancellation({ sessionId: mimo.structuredContent.workSessionId, reason: "test adapter stopped" });

    const genericHarness = await callOpenAIReviewer("submit_to_coding_agent", {
      task: "use the platform-native registered ACP harness",
      workspaceSessionId: WS,
    });
    assert.ok(!genericHarness.isError, `omitted agentName selects a healthy registered ACP peer: ${JSON.stringify(genericHarness)}`);
    assert.equal(agentRegistry.getRun(genericHarness.structuredContent.runId)!.agentName, "codex",
      "ChatGPT/OpenAI requests prefer the registered Codex harness");
    await callReviewer("cancel_work_session", { sessionId: genericHarness.structuredContent.workSessionId });
    reviewWorkflow.finalizeCancellation({ sessionId: genericHarness.structuredContent.workSessionId, reason: "test adapter stopped" });

    // Both public supervised entry points must apply the same mission and
    // supervisor policy. The platform-native choice is a routing preference;
    // the bounded, healthy registry remains the dispatch authority.
    const missionOptions = {
      desiredOutcome: "A correct and reviewed outcome",
      constraints: ["keep the API stable"],
      nonGoals: ["do not rewrite unrelated modules"],
      acceptanceCriteria: [{
        id: "entry-path-test",
        description: "Declared verification passes",
        priority: "required" as const,
        verificationType: "test" as const,
        verificationCommand: "npm --version",
        affectedAreas: ["src/**"],
        dependsOnCriterionIds: ["entry-path-docs"],
        verificationGroup: "core",
        verificationScope: "focused" as const,
        commandVersion: "test-toolchain-v1",
      }, {
        id: "entry-path-docs",
        description: "Security assumptions are documented",
        priority: "preferred" as const,
        verificationType: "manual_review" as const,
        affectedAreas: ["docs/**"],
        verificationGroup: "docs",
      }, {
        id: "entry-path-runtime",
        description: "The ready endpoint answers successfully",
        priority: "preferred" as const,
        verificationType: "runtime_behavior" as const,
        runtimeProbe: { url: "http://127.0.0.1:8080/ready", method: "GET" as const, expectedStatus: 200, bodyIncludes: "ready" },
        affectedAreas: ["src/server/**"],
        verificationScope: "full" as const,
        finalOnly: true,
      }],
      supervisorInstructions: "Supervisor-only review guidance",
      maxCorrectionRounds: 2,
      maxWallTimeMinutes: 3,
      finalVerification: ["npm --version"],
      reviewCoverage: ["correctness"],
      autonomyMode: "verify_only" as const,
      approvalMode: "human_required" as const,
    };
    const missionWorkOrder = {
      objectiveForThisTurn: "Implement the declared outcome",
      requiredActions: ["preserve public compatibility"],
      prohibitedActions: ["change unrelated APIs"],
      requiredVerification: ["npm --version"],
      expectedDeliverables: ["reviewable implementation"],
      contextReferences: ["AGENTS.md"],
    };
    const begun = await callOpenAIReviewer("begin_supervised_work", {
      workspaceSessionId: WS,
      objective: "Entry path parity mission",
      ...missionOptions,
      workOrder: missionWorkOrder,
    });
    assert.equal(begun.isError, undefined, `begin_supervised_work should dispatch: ${JSON.stringify(begun)}`);
    const begunId = begun.structuredContent.workSessionId;
    const begunMission = missionLedger.getMissionByWorkSession(begunId)!;
    const begunPacket = missionLedger.getPacket(begunId);
    const workerContract = projectMissionExecutionContract(begunPacket, "fallback objective");
    assert.ok(workerContract, "a supervised mission produces a worker execution contract");
    assert.equal("supervisorInstructions" in workerContract, false, "supervisor-only instructions are not exposed to the worker");
    assert.deepEqual(workerContract.constraints, missionOptions.constraints);
    assert.deepEqual(workerContract.nonGoals, missionOptions.nonGoals);
    assert.deepEqual(workerContract.workOrder?.requiredActions, missionWorkOrder.requiredActions);
    assert.deepEqual(workerContract.workOrder?.prohibitedActions, missionWorkOrder.prohibitedActions);
    assert.deepEqual(workerContract.workOrder?.requiredVerification, missionWorkOrder.requiredVerification);
    assert.deepEqual(workerContract.workOrder?.expectedDeliverables, missionWorkOrder.expectedDeliverables);
    assert.deepEqual(workerContract.workOrder?.contextReferences, missionWorkOrder.contextReferences);
    assert.deepEqual(workerContract.acceptanceCriteria.map((criterion) => criterion.description), [
      "Declared verification passes",
      "Security assumptions are documented",
      "The ready endpoint answers successfully",
    ]);
    assert.deepEqual(workerContract.acceptanceCriteria[0]?.affectedAreas, ["src/**"]);
    assert.deepEqual(workerContract.acceptanceCriteria[0]?.dependsOnCriterionIds, ["entry-path-docs"]);
    assert.equal(workerContract.acceptanceCriteria[0]?.verificationGroup, "core");
    assert.equal(workerContract.acceptanceCriteria[0]?.verificationScope, "focused");
    assert.equal(workerContract.acceptanceCriteria[0]?.commandVersion, "test-toolchain-v1");
    assert.deepEqual(workerContract.acceptanceCriteria[2]?.runtimeProbe, {
      url: "http://127.0.0.1:8080/ready",
      method: "GET",
      expectedStatus: 200,
      bodyIncludes: "ready",
    });
    const begunSupervisor = supervisorRuns.getByWorkSession(begunId)!;
    assert.equal(agentRegistry.getRun(begun.structuredContent.runId)?.agentName, "codex");
    assert.equal(workSessions.get(begunId)?.completionPolicy, "webui_approval_required");
    assert.equal(begunSupervisor.maxCycles, 25, "mission correction rounds never replace the supervisor emergency cycle ceiling");
    assert.equal(begunSupervisor.autonomyMode, missionOptions.autonomyMode);
    assert.equal(begunSupervisor.approvalMode, missionOptions.approvalMode);
    assert.deepEqual(begunMission.constraints, missionOptions.constraints);
    assert.deepEqual(begunMission.nonGoals, missionOptions.nonGoals);
    assert.equal(begunMission.baselineRef, currentSnapshot);
    assert.deepEqual(begunPacket.workOrders[0]?.requiredVerification, missionWorkOrder.requiredVerification);
    const begunPrompt = JSON.stringify(receivedRuns.at(-1));
    for (const requiredContractField of [
      "Entry path parity mission",
      "A correct and reviewed outcome",
      "keep the API stable",
      "do not rewrite unrelated modules",
      "Declared verification passes",
      "npm --version",
      "test-toolchain-v1",
      "depends on entry-path-docs",
      "http://127.0.0.1:8080/ready",
      "final-only",
      "preserve public compatibility",
      "change unrelated APIs",
      "reviewable implementation",
      "AGENTS.md",
    ]) {
      assert.ok(begunPrompt.includes(requiredContractField), `dispatched mission prompt includes ${requiredContractField}`);
    }
    assert.ok(!begunPrompt.includes("Supervisor-only review guidance"), "supervisor-only instructions stay out of worker dispatch");
    const [workerFinding] = missionLedger.addFindings(begunMission.id, [{
      id: "worker-contract-finding",
      severity: "high",
      category: "security",
      scope: "in_scope",
      disposition: "blocking",
      description: "The retry path drops the workspace fence",
      requiredAction: "Keep the existing lease until the handoff is accepted",
      requiredVerification: ["npm test -- lease"],
    }]);
    const correctionContract = projectMissionExecutionContract(missionLedger.getPacket(begunId), "fallback objective");
    assert.deepEqual(correctionContract?.findings, [{
      id: workerFinding.id,
      scope: "in_scope",
      disposition: "blocking",
      severity: "high",
      category: "security",
      description: "The retry path drops the workspace fence",
      requiredAction: "Keep the existing lease until the handoff is accepted",
      requiredVerification: ["npm test -- lease"],
    }]);
    const correctionPrompt = renderMissionPrompt(config, begunId, "fallback objective");
    for (const findingField of [workerFinding.id, "in_scope", "security", "Keep the existing lease until the handoff is accepted", "npm test -- lease"]) {
      assert.ok(correctionPrompt.includes(findingField), `correction prompt includes finding field ${findingField}`);
    }
    await callReviewer("cancel_work_session", { sessionId: begunId });
    reviewWorkflow.finalizeCancellation({ sessionId: begunId, reason: "mission entry parity complete" });

    const delegatedMissionOptions = {
      ...missionOptions,
      acceptanceCriteria: missionOptions.acceptanceCriteria.map((criterion) => ({
        ...criterion,
        id: criterion.id.replace("entry-path", "delegated-entry-path"),
        dependsOnCriterionIds: criterion.dependsOnCriterionIds?.map((id) => id.replace("entry-path", "delegated-entry-path")),
      })),
    };
    const delegatedMission = await callOpenAIReviewer("submit_to_coding_agent", {
      task: "Entry path parity mission",
      workspaceSessionId: WS,
      completionPolicy: "agent_completion",
      missionContract: { objective: "Entry path parity mission", ...delegatedMissionOptions, workOrder: missionWorkOrder },
    });
    assert.equal(delegatedMission.isError, undefined, `mission-bearing delegation should dispatch: ${JSON.stringify(delegatedMission)}`);
    const delegatedId = delegatedMission.structuredContent.workSessionId;
    const delegatedContract = missionLedger.getMissionByWorkSession(delegatedId)!;
    const delegatedPacket = missionLedger.getPacket(delegatedId);
    const delegatedSupervisor = supervisorRuns.getByWorkSession(delegatedId)!;
    assert.equal(agentRegistry.getRun(delegatedMission.structuredContent.runId)?.agentName, "codex");
    assert.equal(workSessions.get(delegatedId)?.completionPolicy, "webui_approval_required", "mission-bearing delegation forces reviewer approval");
    assert.equal(delegatedSupervisor.maxCycles, 25, "the delegation entry path preserves the separate emergency cycle ceiling");
    assert.equal(delegatedSupervisor.autonomyMode, begunSupervisor.autonomyMode);
    assert.equal(delegatedSupervisor.approvalMode, begunSupervisor.approvalMode);
    assert.equal(delegatedContract.objective, begunMission.objective);
    assert.deepEqual(delegatedContract.constraints, begunMission.constraints);
    assert.deepEqual(delegatedContract.nonGoals, begunMission.nonGoals);
    const criterionProjection = (criteria: typeof begunPacket.criteria) => criteria.map((criterion) => ({
      description: criterion.description,
      priority: criterion.priority,
      verificationType: criterion.verificationType,
      verificationCommand: criterion.verificationCommand,
      runtimeProbe: criterion.runtimeProbe,
    }));
    assert.deepEqual(criterionProjection(delegatedPacket.criteria), criterionProjection(begunPacket.criteria));
    assert.equal(delegatedContract.baselineKind, begunMission.baselineKind);
    assert.equal(delegatedContract.baselineRef, begunMission.baselineRef);
    assert.deepEqual(delegatedPacket.workOrders[0]?.requiredVerification, begunPacket.workOrders[0]?.requiredVerification);
    await callReviewer("cancel_work_session", { sessionId: delegatedId });
    reviewWorkflow.finalizeCancellation({ sessionId: delegatedId, reason: "mission entry parity complete" });

    const unsafeUrl = await callReviewer("call_acp_agent", {
      agentName: "cli-coding-agent",
      task: "do not ssrf",
      workspaceId: WS,
      agentUrl: "http://127.0.0.1:9",
    });
    assert.ok(unsafeUrl.isError, "call_acp_agent rejects caller-supplied URLs");

    const generic = await callReviewer("call_acp_agent", {
      agentName: "cli-coding-agent",
      task: "generic registered dispatch",
      workspaceId: WS,
    });
    assert.ok(!generic.isError, "call_acp_agent routes through registered agent with workspace");
    assert.equal(receivedRuns.at(-1)?.workspace_root, "/tmp", "call_acp_agent supplies workspace_root");
    await callReviewer("cancel_work_session", { sessionId: generic.structuredContent.workSessionId });
    reviewWorkflow.finalizeCancellation({ sessionId: generic.structuredContent.workSessionId, reason: "test adapter stopped" });
  }

  // ── Conversation isolation: foreign sessions stay out of the WebUI surface and cursor ──
  {
    const ownedSession = workSessions.create({
      workspaceSessionId: WS,
      submittedBy: "mcp",
      title: "owner-a-only",
      ownerContextId: "conversation:owner-a",
    });
    const beforeOwnerAEvent = workSessions.getWorkspaceEventCursor(WS);
    eventStore.appendEvent({
      type: "review.submitted",
      sessionId: ownedSession.id,
      workspaceSessionId: WS,
      payload: { sessionId: ownedSession.id },
    }, { publish: true });

    const ownerASurface = await callOwnerA("get_workspace_session_surface", { workspaceId: WS });
    const ownerBSurface = await callOwnerB("get_workspace_session_surface", { workspaceId: WS });
    assert.ok(ownerASurface.structuredContent.sessions.some((entry: { sessionId: string }) => entry.sessionId === ownedSession.id), "owner A sees its own workspace session");
    assert.ok(!ownerBSurface.structuredContent.sessions.some((entry: { sessionId: string }) => entry.sessionId === ownedSession.id), "owner B cannot see owner A's workspace session");
    const globalSurface = await callReviewer("get_workspace_session_surface", { workspaceId: WS });
    assert.ok(globalSurface.structuredContent.sessions.some((entry: { sessionId: string }) => entry.sessionId === ownedSession.id), "ownerless reviewer retains the global review surface");

    const transportOwnedSession = workSessions.create({
      workspaceSessionId: WS,
      submittedBy: "mcp",
      title: "transport-a-only",
      ownerContextId: "transport:transport-a",
    });
    const transportASurface = await callTransportA("get_workspace_session_surface", { workspaceId: WS });
    const transportBSurface = await callTransportB("get_workspace_session_surface", { workspaceId: WS });
    assert.ok(transportASurface.structuredContent.sessions.some((entry: { sessionId: string }) => entry.sessionId === transportOwnedSession.id), "transport A sees its own workspace session");
    assert.ok(!transportBSurface.structuredContent.sessions.some((entry: { sessionId: string }) => entry.sessionId === transportOwnedSession.id), "transport B cannot see transport A's workspace session");

    const ownerBEvents = await callOwnerB("await_workspace_events", { workspaceId: WS, afterSeq: beforeOwnerAEvent, timeoutMs: 1000 });
    assert.equal(ownerBEvents.structuredContent.events.length, 0, "owner B receives no owner A event");
    assert.ok(ownerBEvents.structuredContent.nextSeq > 0, "owner B cursor advances past filtered owner A events");
    const ownerBNextEvents = await callOwnerB("await_workspace_events", { workspaceId: WS, afterSeq: ownerBEvents.structuredContent.nextSeq, timeoutMs: 1000 });
    assert.equal(ownerBNextEvents.structuredContent.events.length, 0, "filtered foreign event is not refetched at the next cursor");

    // Known IDs must not bypass conversation ownership for reviewer mutations.
    const crossReview = await callOwnerB("provide_review_feedback", { sessionId: ownedSession.id, verdict: "approve" });
    assert.ok(crossReview.isError, "owner B cannot provide feedback for owner A's session");
    const crossHandoff = await callOwnerB("handoff_work_session", { sessionId: ownedSession.id, toAgent: "cli-coding-agent" });
    assert.ok(crossHandoff.isError, "owner B cannot hand off owner A's session");
    const crossCancel = await callOwnerB("cancel_work_session", { sessionId: ownedSession.id });
    assert.ok(crossCancel.isError, "owner B cannot cancel owner A's session");
    const crossMissionPause = await callOwnerB("pause_supervisor_run", { sessionId: ownedSession.id, expectedRevision: 1 });
    assert.ok(crossMissionPause.isError, "owner B cannot pause owner A's supervisor run");
    assert.equal(workSessions.get(ownedSession.id)?.status, "in_progress", "cross-owner reviewer calls do not mutate the target");
  }

  // ── Scenario 4b: gated sessions enforce action guard + exact artifact approval ──
  {
    const sessionId = workSessions.create({
      workspaceSessionId: WS,
      submittedBy: "webui",
      completionPolicy: "webui_approval_required",
    }).id;
    reviewPatch = "diff --git a/gated.txt b/gated.txt\n--- a/gated.txt\n+++ b/gated.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const submitted = await callWorker("submit_for_review", { sessionId });
    assert.ok(!submitted.isError, "gated submit succeeds");
    assert.equal(workSessions.get(sessionId)!.status, "awaiting_review");
    const pendingApproval = approvalRequests.create({
      kind: "agent_permission",
      workspaceSessionId: WS,
      workSessionId: sessionId,
      title: "Allow the reviewed agent action",
      description: "The worker needs permission to continue.",
      options: [{ id: "allow", label: "Allow", effect: "approve", scope: "work_session" }],
    });
    ptyObservationSessionId = sessionId;
    const deliveryRoute = reviewRoutes.configure({
      workSessionId: sessionId, ownerPrincipalId: "snapshot-owner", ownerContextId: "snapshot-owner-context",
      enabled: true, mode: "isolated_review", maxReviewRounds: 3,
      deliveryTransport: "native_cdp", browserProfileId: "reviewer-snapshot-profile",
    });
    const activation = reviewThreads.createActivation({
      routeId: deliveryRoute.id, ownerPrincipalId: "snapshot-owner", reviewerPrincipalId: "snapshot-reviewer",
    });
    const deliveryThread = reviewThreads.activate({
      activationSecret: activation.activationSecret, principalId: "snapshot-reviewer", contextId: "snapshot-reviewer-context",
    });
    const snapshotSubmission = workSessions.getLatestSubmission(sessionId)!;
    const deliveryHandoff = reviewRoutes.createHandoff({
      routeId: deliveryRoute.id, workSessionId: sessionId,
      submissionId: snapshotSubmission.id, reviewEpoch: snapshotSubmission.reviewEpoch!,
      snapshotKind: snapshotSubmission.snapshotKind!, snapshotRef: snapshotSubmission.snapshotRef!,
      diffSha256: snapshotSubmission.diffSha256!, roundNumber: 1,
    });
    const snapshotReviewContext = createIsolatedReviewerContext("review-snapshot-status");
    const snapshotActivation = reviewThreads.createActivation({
      routeId: deliveryRoute.id, ownerPrincipalId: "snapshot-owner", reviewerPrincipalId: "role:reviewer",
    });
    const snapshotReviewThread = reviewThreads.activate({
      activationSecret: snapshotActivation.activationSecret, principalId: "role:reviewer", contextId: snapshotReviewContext.contextId,
    });
    const snapshotDelivery = await snapshotReviewContext.call("claim_review_thread_deliveries", {});
    const snapshotMessage = snapshotDelivery.structuredContent.messages[0];
    assert.equal(snapshotMessage?.handoffId, deliveryHandoff.id, "the pinned reviewer context receives the exact queued packet");
    const snapshotDeliveryAck = await snapshotReviewContext.call("acknowledge_review_thread_delivery", {
      threadId: snapshotReviewThread.id, handoffId: deliveryHandoff.id, payloadSha256: snapshotMessage.payloadSha256, outcome: "accepted",
    });
    assert.ok(!snapshotDeliveryAck.isError, "the pinned reviewer context records host delivery acceptance");
    const snapshotHandoffClaim = await snapshotReviewContext.call("claim_review_handoff", {
      handoffId: deliveryHandoff.id, expectedRevision: deliveryHandoff.revision, reviewThreadId: snapshotReviewThread.id,
    });
    assert.ok(!snapshotHandoffClaim.isError, "snapshot review handoff is claimed by its bound reviewer thread");
    db.sqlite.prepare(`update review_threads set browser_profile_id = ?, browser_generation = 3,
      conversation_url = ?, conversation_key = ?, conversation_fingerprint = ?, conversation_binding_revision = 4,
      conversation_binding_status = 'bound' where id = ?`)
      .run("reviewer-snapshot-profile", "https://chatgpt.com/c/conversation_snapshot", "conversation_snapshot", "f".repeat(64), deliveryThread.id);
    config.reviewBrowserJobs!.getActiveForThread = (threadId: string) => threadId === deliveryThread.id ? ({
      id: "browser-turn-snapshot", status: "awaiting_feedback", attemptNumber: 2,
      promptSubmittedAt: "2026-10-26T12:01:00.000Z", generationStartedAt: "2026-10-26T12:01:01.000Z",
      generationFinishedAt: "2026-10-26T12:01:02.000Z",
    } as any) : undefined;
    const replyDestination = agentRegistry.listAlive().find((agent) => agent.name === "cli-coding-agent");
    assert.ok(replyDestination, "snapshot reply fixture has a live destination agent");
    const replyRun = agentRegistry.createRun({
      agentName: replyDestination.name,
      agentId: replyDestination.id,
      workspaceSessionId: WS,
      workSessionId: sessionId,
      status: "running",
      attemptNumber: 3,
    });
    const replyDispatchKey = "snapshot-reply-dispatch";
    agentRegistry.beginDispatchAttempt({ key: replyDispatchKey, runId: replyRun.runId, agentId: replyDestination.id, attemptNumber: 4 });
    agentRegistry.updateDispatchAttempt(replyDispatchKey, { status: "accepted", remoteRunId: "snapshot-reply-remote" });
    const snapshotQuestion = agentMessages.post({
      workSessionId: sessionId,
      runId: replyRun.runId,
      kind: "clarification_request",
      title: "Clarify snapshot destination",
      body: "Which endpoint should I use?",
      data: { expectsReply: true, resumeOnReply: true },
    });
    agentMessages.waitForReply({
      messageId: snapshotQuestion.id,
      workSessionId: sessionId,
      runId: replyRun.runId,
      attempt: 3,
      expectsReply: true,
      resumeOnReply: true,
    });
    const snapshotReply = agentMessages.acceptReply({
      messageId: snapshotQuestion.id,
      workSessionId: sessionId,
      body: "Use the staged endpoint.",
      reviewerPrincipalId: "snapshot-reviewer",
    }).reply;
    agentMessages.recordReplyDispatch({
      replyId: snapshotReply.id,
      expectedStatus: "pending_delivery",
      nextStatus: "awaiting_acknowledgement",
      dispatchIdempotencyKey: replyDispatchKey,
      runId: replyRun.runId,
      attemptNumber: 4,
      remoteRunId: "snapshot-reply-remote",
    });
    const snapshot = await callReviewer("get_work_session_snapshot", { sessionId });
    assert.ok(!snapshot.isError, "work-session snapshot rehydrates");
    assert.equal(snapshot.structuredContent.latestSubmission.submissionId, submitted.structuredContent.submissionId);
    assert.equal(snapshot.structuredContent.latestSubmission.diffSha256, submitted.structuredContent.diffSha256);
    assert.equal(snapshot.structuredContent.latestSubmission.reviewEpoch, submitted.structuredContent.reviewEpoch);
    assert.equal(snapshot.structuredContent.pendingApprovals.length, 1, "snapshot includes pending approval for this work session");
    assert.equal(snapshot.structuredContent.pendingApprovals[0].approvalId, pendingApproval.approvalId);
    assert.equal(snapshot.structuredContent.pendingApprovals[0].title, pendingApproval.title);
    assert.equal(snapshot.structuredContent.pendingApprovals[0].options[0].id, "allow");
    assert.equal(snapshot.structuredContent.agentPtys[0].processGeneration, 3,
      "cold session hydration includes durable PTY ownership and generation");
    assert.equal(snapshot.structuredContent.reviewLoop.deliveryTransport, "native_cdp");
    assert.equal(snapshot.structuredContent.reviewLoop.browserProfileId, "reviewer-snapshot-profile");
    assert.equal(snapshot.structuredContent.reviewLoop.conversation.key, "conversation_snapshot");
    assert.equal(snapshot.structuredContent.reviewLoop.conversation.bindingRevision, 4);
    assert.equal(snapshot.structuredContent.reviewLoop.deliveryMessage.status, "reviewer_claimed");
    assert.equal(snapshot.structuredContent.reviewLoop.deliveryMessage.messageId,
      reviewThreads.listMessages(deliveryThread.id).find((message) => message.handoffId === deliveryHandoff.id)?.id);
    assert.equal(snapshot.structuredContent.reviewLoop.browserAttempt.status, "awaiting_feedback",
      "snapshot exposes the current durable browser-turn state without claiming reviewer feedback");
    const projectedReply = snapshot.structuredContent.agentMessages.find((message: { messageId: string }) => message.messageId === snapshotQuestion.id);
    assert.equal(projectedReply.replyStatus, "awaiting_acknowledgement");
    assert.equal(projectedReply.replyDeliveryAttemptNumber, 4);
    assert.equal(projectedReply.replyDestinationAgentId, replyDestination.id,
      "cold session hydration binds clarification state to the exact accepted destination attempt");
    assert.equal(projectedReply.replyDestinationAgentName, replyDestination.name);
    const ptyObservation = await callReviewer("observe_agent_pty", {
      sessionId,
      processSessionId: "proc_reviewer_observe",
      afterCursor: 12,
    });
    assert.equal(ptyObservation.structuredContent.output, "read-only terminal output");
    assert.equal(ptyObservation.structuredContent.outputCursor, 24);
    assert.equal(ptyObservation.structuredContent.running, true);
    const workerPtyObservation = await callWorker("observe_agent_pty", {
      sessionId,
      processSessionId: "proc_reviewer_observe",
    });
    assert.ok(workerPtyObservation.isError, "PTY output observation is reviewer-only");
    ptyObservationSessionId = undefined;
    const surface = await callReviewer("get_workspace_session_surface", { workspaceId: WS });
    assert.ok(!surface.isError, "workspace session surface reads through the shared snapshot path");
    assert.ok(surface.structuredContent.sessions.some((entry: { sessionId: string }) => entry.sessionId === sessionId));
    approvalRequests.resolve(pendingApproval.approvalId, { status: "approved", reviewerId: "snapshot-test" });
    const missingSubmission = await callReviewer("get_review_submission", {
      sessionId,
      submissionId: "wssub_does_not_exist",
    });
    assert.ok(missingSubmission.isError, "explicit missing submission id fails instead of falling back to latest");
    assert.equal(
      authorizeWorkSessionAction(workSessions, { workSessionId: sessionId, tool: "edit", path: "gated.txt" }).allowed,
      false,
      "worker cannot edit while awaiting_review",
    );
    assert.equal(
      authorizeWorkSessionAction(workSessions, { workSessionId: sessionId, tool: "brand_new_tool" }).allowed,
      false,
      "unknown worker tools fail closed in gated sessions",
    );

    // Simulate the workspace changing since the submission was captured.
    currentSnapshot = "changed-since-submit";
    const changedWorkspace = await snapshotReviewContext.call("provide_review_feedback", {
      sessionId,
      submissionId: submitted.structuredContent.submissionId,
      diffSha256: submitted.structuredContent.diffSha256,
      reviewEpoch: submitted.structuredContent.reviewEpoch,
      verdict: "approve",
    });
    assert.ok(changedWorkspace.isError, "workspace changes after submission cannot be approved");
    currentSnapshot = "deadbeef";

    reviewPatch = "";
    const stale = await snapshotReviewContext.call("provide_review_feedback", {
      sessionId,
      submissionId: submitted.structuredContent.submissionId,
      diffSha256: "not-the-submitted-diff",
      reviewEpoch: submitted.structuredContent.reviewEpoch,
      verdict: "approve",
    });
    assert.ok(stale.isError, "stale diff hash cannot be approved");

    const approved = await snapshotReviewContext.call("provide_review_feedback", {
      sessionId,
      submissionId: submitted.structuredContent.submissionId,
      diffSha256: submitted.structuredContent.diffSha256,
      reviewEpoch: submitted.structuredContent.reviewEpoch,
      verdict: "approve",
    });
    assert.ok(!approved.isError, `current exact submission can be approved: ${JSON.stringify(approved)}`);
    assert.equal(workSessions.get(sessionId)!.status, "approved");
    reviewPatch = "diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n";
  }

  // ── Scenario 5: continuation lease release / requeue ──
  {
    const cm = createContinuationManager(join(root, "cm-lease"));
    const c = cm.create({ sessionId: "s-lease", reviewId: "r", feedbackEventId: "e", verdict: "changes_requested" });
    const claimed = cm.claim("dispatcher-x", { id: c.id });
    assert.ok(claimed, "claim succeeds");
    assert.equal(cm.reapExpiredClaims(1000, "dispatcher-x"), 0, "fresh claim not reaped");
    cm.release("dispatcher-x", { id: c.id });
    assert.equal(cm.listPending().length, 1, "released continuation returns to pending");
    const live = cm.claim("live-worker:s-lease:w1", { id: c.id });
    assert.ok(live, "live worker can claim continuation");
    const leaseDb = new Database(databasePath(join(root, "cm-lease")));
    leaseDb.prepare("update continuations set claimed_at = ? where id = ?").run("2000-01-01T00:00:00.000Z", c.id);
    leaseDb.close();
    assert.equal(cm.reapExpiredClaims(1000), 1, "expired live-worker claim is reaped without owner filter");
    assert.equal(cm.get(c.id)?.status, "pending", "reaped live-worker claim returns to pending");
  }

  // ── Scenario 6: generic ACP approval requests are durable and visible ──
  {
    const request = approvalRequests.create({
      kind: "agent_permission",
      workspaceSessionId: WS,
      workSessionId: "wsess-generic-approval",
      runId: "run-generic-approval",
      agentId: "custom-agent",
      title: "Allow custom action",
      description: "Custom ACP-style agent requested permission.",
      options: [
        { id: "allow_custom", label: "Allow", effect: "approve" },
        { id: "deny_custom", label: "Deny", effect: "deny" },
      ],
    });

    const center = await callReviewer("open_approval_center", { workspaceId: WS });
    assert.ok(!center.isError, "approval center opens");
    assert.equal(center.structuredContent.count, 1, "generic approval is listed");
    assert.equal(center.structuredContent.approvals[0].approvalId, request.approvalId);

    const resolved = await callReviewer("provide_policy_approval", {
      approvalId: request.approvalId,
      decision: "allow_custom",
    });
    assert.ok(!resolved.isError, "generic approval resolves through shared approval tool");
    assert.equal(approvalRequests.get(request.approvalId)?.status, "approved");

    const changesRequest = approvalRequests.create({
      kind: "agent_permission",
      workspaceSessionId: WS,
      workSessionId: "wsess-generic-approval",
      title: "Request a safer alternative",
      options: [{ id: "request_changes", label: "Request changes", effect: "changes_requested" }],
    });
    const invalidDecision = await callReviewer("provide_policy_approval", {
      approvalId: changesRequest.approvalId,
      decision: "approve",
    });
    assert.ok(invalidDecision.isError, "generic approval rejects an option ID it did not offer");
    assert.equal(approvalRequests.get(changesRequest.approvalId)?.status, "pending", "invalid generic decision leaves the request pending");
    const changes = await callReviewer("provide_policy_approval", {
      approvalId: changesRequest.approvalId,
      decision: "request_changes",
    });
    assert.ok(!changes.isError, "changes_requested generic approval resolves through shared approval tool");
    assert.equal(approvalRequests.get(changesRequest.approvalId)?.status, "denied", "changes_requested uses a denied gate outcome while preserving its effect");
  }

  // ── Scenario 7: continuation affinity stays with the original MIMO agent ──
  {
    const sessionId = createSession();
    await callWorker("submit_for_review", { sessionId });
    const originalRun = agentRegistry.createRun({
      agentName: "mimo-code",
      workspaceSessionId: WS,
      workSessionId: sessionId,
      inputPreview: "original mimo dispatch",
      status: "running",
    });
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "Please address the reviewed issue before resubmitting." });

    const before = receivedRuns.length;
    await runContinuationTick({ ...config, resumeAgent: undefined });
    assert.equal(receivedRuns.length, before + 1, "continuation redispatches through ACP transport");
    assert.equal(receivedRuns.at(-1)?.agent_name, "mimo-code", "continuation returns to original agent name");
    assert.equal(receivedRuns.at(-1)?.parent_run_id, originalRun.runId, "continuation reuses original logical run");
  }

  // ── Scenario 8: missing continuation provenance fails closed, not CRUSH fallback ──
  {
    const sessionId = createSession();
    await callWorker("submit_for_review", { sessionId });
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "Please address the reviewed issue before resubmitting." });

    const before = receivedRuns.length;
    await runContinuationTick({ ...config, resumeAgent: undefined });
    assert.equal(receivedRuns.length, before, "missing provenance does not fallback-dispatch to cli-coding-agent");
    assert.ok(
      eventStore.getEventsForSession(sessionId).some((event) => event.type === "continuation.dispatch_failed"),
      "missing provenance emits a dispatch_failed event",
    );
    assert.equal(
      continuationManager.listPending().filter((c) => c.sessionId === sessionId).length,
      1,
      "missing provenance leaves continuation pending for recovery",
    );
  }

  // ── Scenario 9: P0 #5 race — live waiter catches feedback published after subscribe ──
  {
    const sessionId = createSession();
    await callWorker("submit_for_review", { sessionId });
    // Park the waiter, then publish feedback on a later tick (after the handler
    // has subscribed). The race-free wait must still observe it.
    const waiterP = callWorker("await_review_feedback", { sessionId, timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 20));
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "Please address the reviewed issue before resubmitting." });
    const res = await waiterP;
    assert.equal(res.structuredContent.status, "feedback_ready", "live waiter catches feedback published after subscribe");
    assert.equal(res.structuredContent.feedback.verdict, "changes_requested");
    assert.ok(typeof res.structuredContent.nextSeq === "number", "returns a durable nextSeq cursor");
  }

  // ── Scenario 10: P1 #8 — last live waiter disconnect emits worker.waiter.closed and redrives ──
  {
    const sessionId = createSession();
    await callWorker("submit_for_review", { sessionId });
    // Park a live waiter with a short timeout; no feedback arrives.
    const waiterP = callWorker("await_review_feedback", { sessionId, timeoutMs: 100 });
    const res = await waiterP;
    assert.equal(res.structuredContent.status, "timeout", "no feedback -> timeout");
    // The last-waiter disconnect must have emitted worker.waiter.closed.
    assert.ok(
      eventStore.getEventsForSession(sessionId).some((e) => e.type === "worker.waiter.closed"),
      "last live waiter disconnect emits worker.waiter.closed",
    );
    // Now feedback arrives -> continuation pending, no live waiter -> dispatcher redrives.
    // A correlated run must exist or the dispatcher emits dispatch_failed instead.
    agentRegistry.createRun({
      agentName: "cli-coding-agent",
      workspaceSessionId: WS,
      workSessionId: sessionId,
      inputPreview: "scenario 10 dispatch",
      status: "running",
    });
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "Please address the reviewed issue before resubmitting." });
    const before = resumeCalls;
    await runContinuationTick(config);
    assert.equal(resumeCalls, before + 1, "dispatcher redrives after worker.waiter.closed (dead agent)");
  }

  // ── Scenario 11: P0 #6 — a dispatched worker is bound to one work session ──
  {
    const sessionA = createSession();
    const sessionB = createSession();
    await callWorker("submit_for_review", { sessionId: sessionA });
    await callWorker("submit_for_review", { sessionId: sessionB });
    // Give A a changes_requested so the worker may resubmit on its own session.
    await callReviewer("provide_review_feedback", { sessionId: sessionA, verdict: "changes_requested", comments: "Please address the reviewed issue before resubmitting." });
    const contA = continuationManager.listForSession(sessionA).find((c) => c.status === "pending")!;
    assert.ok(contA, "continuation for A exists");

    const boundConfig = { ...config, principalRole: "worker", connectionWorkSessionId: sessionA } as BridgeConfig;
    const boundServer = fakeServer();
    registerBridgeTools(boundServer as any, boundConfig);
    const callBound = (name: string, args: any) => boundServer.handlers.get(name)!(args);

    const crossSubmit = await callBound("submit_for_review", { sessionId: sessionB });
    assert.ok(crossSubmit.isError, "worker bound to A cannot submit_for_review on B");
    assert.match(String(crossSubmit.content[0]?.text ?? ""), /different|bound/i, "forbidden mentions binding");
    // The cross-session call must not mutate session B.
    assert.equal(workSessions.get(sessionB)!.status, "awaiting_review");

    const crossCancel = await callBound("cancel_work_session", { sessionId: sessionB });
    assert.ok(crossCancel.isError, "worker bound to A cannot cancel B");
    assert.equal(workSessions.get(sessionB)!.status, "awaiting_review", "cross-session cancel does not mutate B");

    const ownSubmit = await callBound("submit_for_review", { sessionId: sessionA, continuationId: contA.id });
    assert.ok(!ownSubmit.isError, "worker may resubmit on its bound session A");
    assert.equal(continuationManager.get(contA.id)!.status, "completed");
  }

  // ── Scenario 12: P1 #13 — a worker cannot consume another session's continuation ──
  {
    const sessionA = createSession();
    const sessionB = createSession();
    await callWorker("submit_for_review", { sessionId: sessionA });
    await callWorker("submit_for_review", { sessionId: sessionB });
    await callReviewer("provide_review_feedback", { sessionId: sessionB, verdict: "changes_requested", comments: "Please address the reviewed issue before resubmitting." });
    const contB = continuationManager.listForSession(sessionB).find((c) => c.status === "pending")!;
    assert.ok(contB, "continuation for B exists");

    const boundA = fakeServer();
    registerBridgeTools(boundA as any, { ...config, principalRole: "worker", connectionWorkSessionId: sessionA } as BridgeConfig);
    const callBoundA = (name: string, args: any) => boundA.handlers.get(name)!(args);

    const crossConsume = await callBoundA("mark_continuation_consumed", { continuationId: contB.id });
    assert.ok(crossConsume.isError, "worker bound to A cannot consume B's continuation");
    assert.equal(continuationManager.get(contB.id)!.status, "pending", "cross-session continuation untouched");

    const boundB = fakeServer();
    registerBridgeTools(boundB as any, { ...config, principalRole: "worker", connectionWorkSessionId: sessionB } as BridgeConfig);
    const callBoundB = (name: string, args: any) => boundB.handlers.get(name)!(args);
    const ownConsume = await callBoundB("mark_continuation_consumed", { continuationId: contB.id });
    assert.ok(!ownConsume.isError, "worker bound to B can consume B's continuation");
    assert.equal(continuationManager.get(contB.id)!.status, "completed");
  }

  // ── Scenario 12b: F02 — message delivery/consumption requires a bound worker ──
  {
    const sessionA = createSession();
    const sessionB = createSession();

    // A worker bound to A may post its own message.
    const boundA = fakeServer();
    registerBridgeTools(boundA as any, { ...config, principalRole: "worker", connectionWorkSessionId: sessionA } as BridgeConfig);
    const callBoundA = (name: string, args: any) => boundA.handlers.get(name)!(args);
    const ownPost = await callBoundA("post_agent_message", { sessionId: sessionA, kind: "clarification_request", body: "which env?" });
    assert.ok(!ownPost.isError, "worker bound to A may post its own message");

    // ...but not B's.
    const crossPost = await callBoundA("post_agent_message", { sessionId: sessionB, kind: "clarification_request", body: "leak?" });
    assert.ok(crossPost.isError, "worker bound to A cannot post a message for B");
    assert.equal(agentMessages.list(sessionB).length, 0, "cross-session post persisted nothing for B");

    // An UNBOUND worker (no signed work-session envelope) must fail closed for
    // message delivery and consumption; the legacy permissive worker read
    // branch must not grant it message authority.
    const unbound = fakeServer();
    registerBridgeTools(unbound as any, { ...config, principalRole: "worker" } as BridgeConfig);
    const callUnbound = (name: string, args: any) => unbound.handlers.get(name)!(args);
    const unboundPost = await callUnbound("post_agent_message", { sessionId: sessionA, kind: "clarification_request", body: "no envelope" });
    assert.ok(unboundPost.isError, "an unbound worker cannot post a message");
    const unboundAck = await callUnbound("ack_agent_reply", { sessionId: sessionA, replyId: "reply-x", replyRevision: 1, deliveryAttemptId: "attempt-1" });
    assert.ok(unboundAck.isError, "an unbound worker cannot acknowledge a reply");
    const unboundPending = await callUnbound("get_pending_agent_replies", { sessionId: sessionA });
    assert.ok(unboundPending.isError, "an unbound worker cannot enumerate pending replies");

    // A BOUND worker still cannot acknowledge a cross-session reply.
    const crossAck = await callBoundA("ack_agent_reply", { sessionId: sessionB, replyId: "reply-y", replyRevision: 1, deliveryAttemptId: "attempt-1" });
    assert.ok(crossAck.isError, "worker bound to A cannot acknowledge B's reply");
  }

  // ── Scenario 12c: R06 — a governed route blocks unclaimed feedback and admits
  //    the exact claimed handoff through the authoritative workflow ──
  {
    const sessionId = workSessions.create({ workspaceSessionId: WS, submittedBy: "webui", ownerContextId: "conversation:owner-a" }).id;
    const configured = await callOwnerA("configure_review_loop", {
      workSessionId: sessionId, enabled: true, mode: "isolated_review", maxReviewRounds: 2,
    });
    assert.ok(!configured.isError, "reviewer can configure an isolated review route");
    const submittedForLoop = await callWorker("submit_for_review", { sessionId });
    assert.equal(submittedForLoop._meta?.card, undefined, "an active review loop sends its submission through MCP without adding a reviewer UI card");
    const submission = workSessions.get(sessionId)!.latestSubmission!;
    const route = reviewRoutes.getRouteBySession(sessionId)!;
    const handoff = reviewRoutes.getHandoffBySubmission(sessionId, submission.id, submission.reviewEpoch)!;
    assert.ok(handoff, "a governed submission creates a handoff");
    const reviewContext = createIsolatedReviewerContext("owner-b-session-12c");
    const thread = activateForReviewerContext(route.id, reviewContext.contextId);

    // Unclaimed handoff: ordinary feedback must be rejected by the workflow.
    const blocked = await callReviewer("provide_review_feedback", { sessionId, verdict: "approve" });
    assert.ok(blocked.isError, "unclaimed handoff blocks ordinary review feedback: " + JSON.stringify(blocked.content));
    assert.equal(workSessions.get(sessionId)!.status, "awaiting_review", "blocked feedback did not mutate the session");

    // Claim the exact handoff, then the same feedback is admitted.
    const claimed = await reviewContext.call("claim_review_handoff", { handoffId: handoff.id, expectedRevision: handoff.revision, reviewThreadId: thread.id, destinationConversationId: reviewContext.contextId });
    assert.ok(!claimed.isError, "reviewer claims the handoff: " + JSON.stringify(claimed.content));
    const claimedSubmission = await reviewContext.call("get_review_submission", { sessionId, submissionId: submission.id });
    assert.ok(!claimedSubmission.isError, "the activated reviewer can read the exact claimed submission from its separate context");
    assert.match(String((claimedSubmission.structuredContent as { patch?: string }).patch ?? ""), /diff --git/, "the authorized reviewer receives the immutable submission diff");
    assert.equal(claimedSubmission._meta?.card, undefined, "the reviewer receives the diff through MCP without a reviewer-facing UI card");
    const crossContextFeedback = await callOwnerA("provide_review_feedback", { sessionId, verdict: "approve", comments: "wrong context" });
    assert.ok(crossContextFeedback.isError, "the originating context cannot answer a handoff claimed by the separate reviewer context");
    assert.equal(workSessions.get(sessionId)!.status, "awaiting_review", "cross-context feedback leaves the pending review unchanged");
    const released = await reviewContext.call("release_review_handoff", {
      handoffId: handoff.id,
      expectedRevision: (claimed.structuredContent as { revision: number }).revision,
    });
    assert.ok(!released.isError, "the bound reviewer can release an unused claim");
    const releasedSubmission = await reviewContext.call("get_review_submission", { sessionId, submissionId: submission.id });
    assert.ok(releasedSubmission.isError, "releasing the claim removes the fresh context's submission-read authority");
    const staleFeedback = await reviewContext.call("submit_handoff_feedback", {
      handoffId: handoff.id,
      expectedRevision: (claimed.structuredContent as { revision: number }).revision,
      verdict: "approve",
    });
    assert.ok(staleFeedback.isError, "a released reviewer cannot commit feedback with its stale claim revision");
    assert.equal(workSessions.get(sessionId)!.status, "awaiting_review", "stale feedback after release leaves the submission pending");
    const releasedHandoff = reviewRoutes.getHandoffById(handoff.id)!;
    const reclaimed = await reviewContext.call("claim_review_handoff", {
      handoffId: handoff.id,
      expectedRevision: releasedHandoff.revision,
      reviewThreadId: thread.id,
    });
    assert.ok(!reclaimed.isError, "the activated context can reclaim the released handoff with its current revision");
    const waiter = callWorker("await_review_feedback", { sessionId, timeoutMs: 5_000 });
    const admitted = await reviewContext.call("submit_handoff_feedback", {
      handoffId: handoff.id,
      expectedRevision: (reclaimed.structuredContent as { revision: number }).revision,
      verdict: "changes_requested",
      comments: "Please address the reviewed issue before resubmitting.",
      requiredActions: ["Fix the reviewed issue"],
    });
    assert.ok(!admitted.isError, "the authenticated WebUI reviewer submits feedback through its claimed handoff: " + JSON.stringify(admitted.content));
    const returned = await waiter;
    assert.equal(returned.structuredContent.status, "feedback_ready", "the blocked worker is woken by committed WebUI handoff feedback");
    assert.equal(returned.structuredContent.feedback.verdict, "changes_requested");
    assert.equal(returned.structuredContent.feedback.comments, "Please address the reviewed issue before resubmitting.");
    assert.deepEqual(returned.structuredContent.feedback.requiredActions, ["Fix the reviewed issue"]);
    assert.equal(workSessions.get(sessionId)!.status, "changes_requested");
    void route;
  }

  // ── Scenario 12d: L04 — pause/resume/status route controls ──
  {
    const sessionId = createSession();
    await callReviewer("configure_review_loop", { workSessionId: sessionId, enabled: true, mode: "isolated_review", maxReviewRounds: 3 });
    const paused = await callReviewer("pause_review_loop", { workSessionId: sessionId });
    assert.ok(!paused.isError, "reviewer can pause the review loop");
    const status = await callReviewer("get_review_loop_status", { workSessionId: sessionId });
    assert.ok(!status.isError, "reviewer can read review-loop status");
    assert.equal((status.structuredContent as { status?: string })?.status, "paused", "status reflects the pause");
    // A submission while paused is blocked before mutation: the worker cannot
    // create a stranded pending submission with no recoverable handoff.
    const pausedSubmission = await callWorker("submit_for_review", { sessionId });
    assert.ok(pausedSubmission.isError, "paused route blocks submission before mutation");
    assert.equal(workSessions.get(sessionId)!.latestSubmission, undefined, "paused route does not create a stranded submission");
    const resumed = await callReviewer("resume_review_loop", { workSessionId: sessionId });
    assert.ok(!resumed.isError, "reviewer can resume the review loop");
    assert.equal((resumed.structuredContent as { status?: string })?.status, "active", "resume restores the active route");

    // C05: enabling a multi-round pinned review surfaces the context-drift warning.
    const pinned = await callReviewer("configure_review_loop", {
      workSessionId: sessionId, enabled: true, mode: "pinned_conversation", maxReviewRounds: 3,
    });
    assert.ok(!pinned.isError, "reviewer can enable a pinned review loop");
    assert.match(
      String((pinned.structuredContent as { warning?: string })?.warning ?? ""),
      /context drift/i,
      "enabling a multi-round pinned review warns about context drift",
    );
    const singleRound = await callReviewer("configure_review_loop", {
      workSessionId: sessionId, enabled: true, mode: "pinned_conversation", maxReviewRounds: 1,
    });
    assert.equal((singleRound.structuredContent as { warning?: string })?.warning, undefined, "a single-round pinned review has no drift warning");
  }

  // ── Experiment C: pinned review, maximum 3 rounds, 4th automatic round blocked ──
  {
    const sessionId = createSession();
    // Enable a pinned review route with a hard 3-round ceiling and disable the
    // live waiter so reviewer feedback drives the automation deterministically.
    await callReviewer("configure_review_loop", {
      workSessionId: sessionId, enabled: true, mode: "pinned_conversation", maxReviewRounds: 3,
      pinnedConversationId: "unknown-owner",
    });

    // Round 1: submit S1, reviewer claims the handoff and requests changes.
    await callWorker("submit_for_review", { sessionId });
    let sub = workSessions.get(sessionId)!.latestSubmission!;
    let handoff = reviewRoutes.getHandoffBySubmission(sessionId, sub.id, sub.reviewEpoch)!;
let claimResult: any;
claimResult = await callReviewer("claim_review_handoff", { handoffId: handoff.id, expectedRevision: handoff.revision });
    if (claimResult.isError) throw new Error(claimResult.content?.[0]?.text ?? "claim failed");
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "round 1 fix" });
    assert.equal(reviewRoutes.getRouteBySession(sessionId)!.completedReviewRounds, 1, "round 1 consumed a review round");

    // Round 2.
    await callWorker("submit_for_review", { sessionId });
    sub = workSessions.get(sessionId)!.latestSubmission!;
    handoff = reviewRoutes.getHandoffBySubmission(sessionId, sub.id, sub.reviewEpoch)!;
claimResult = await callReviewer("claim_review_handoff", { handoffId: handoff.id, expectedRevision: handoff.revision });
    if (claimResult.isError) throw new Error(claimResult.content?.[0]?.text ?? "claim failed");
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "round 2 fix" });
    assert.equal(reviewRoutes.getRouteBySession(sessionId)!.completedReviewRounds, 2, "round 2 consumed a review round");

    // Round 3.
    await callWorker("submit_for_review", { sessionId });
    sub = workSessions.get(sessionId)!.latestSubmission!;
    handoff = reviewRoutes.getHandoffBySubmission(sessionId, sub.id, sub.reviewEpoch)!;
const claimError = await callReviewer("claim_review_handoff", { handoffId: handoff.id, expectedRevision: handoff.revision });
    if (claimError.isError) throw new Error(claimError.content?.[0]?.text ?? "claim failed");
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "round 3 fix" });
    assert.equal(reviewRoutes.getRouteBySession(sessionId)!.completedReviewRounds, 3, "round 3 consumed the final review round");

    // A 4th submission is rejected at admission; it cannot open a new automatic
    // review round, leave an orphan submission, or consume another round.
    let fourthSubmission: any;
    try {
      fourthSubmission = await callWorker("submit_for_review", { sessionId });
    } catch (error) {
      fourthSubmission = { isError: true, content: [{ text: error instanceof Error ? error.message : String(error) }] };
    }
    assert.ok(fourthSubmission.isError, "a 4th automatic round is blocked at submission admission");
    assert.match(String(fourthSubmission.content?.[0]?.text ?? ""), /review round limit reached/i);
    assert.equal(workSessions.get(sessionId)!.latestSubmission?.submissionNumber, 3, "the budget refusal leaves no orphan submission");
    assert.equal(reviewRoutes.getRouteBySession(sessionId)!.completedReviewRounds, 3, "the exhausted round count is unchanged");

    const beforeExtension = reviewRoutes.getRouteBySession(sessionId)!;
    const extension = await callReviewer("configure_review_loop", {
      workSessionId: sessionId,
      enabled: true,
      mode: "pinned_conversation",
      maxReviewRounds: 4,
      expectedRevision: beforeExtension.revision,
    });
    assert.ok(!extension.isError, "the authorized route owner can explicitly extend the exhausted budget");
    const extendedSubmission = await callWorker("submit_for_review", { sessionId });
    assert.ok(!extendedSubmission.isError, "a new review round is admitted only after the explicit extension");
    const extended = workSessions.get(sessionId)!.latestSubmission!;
    assert.equal(reviewRoutes.getHandoffBySubmission(sessionId, extended.id, extended.reviewEpoch)?.roundNumber, 4, "the extended round number remains server-derived");
  }

  // ── Experiment D: one activated reviewer thread receives fresh immutable
  //    handoffs while preserving the original work session across submissions ──
  {
    const sessionId = createSession();
    const originalSessionId = sessionId;
    await callReviewer("configure_review_loop", {
      workSessionId: sessionId, enabled: true, mode: "isolated_review", maxReviewRounds: 3,
    });
    await callWorker("submit_for_review", { sessionId });
    const s1 = workSessions.get(sessionId)!.latestSubmission!;
    const h1 = reviewRoutes.getHandoffBySubmission(sessionId, s1.id, s1.reviewEpoch)!;
    const reviewContext = createIsolatedReviewerContext("owner-b-session-loop");
    const thread = activateForReviewerContext(reviewRoutes.getRouteBySession(sessionId)!.id, reviewContext.contextId);
    await reviewContext.call("claim_review_handoff", { handoffId: h1.id, expectedRevision: h1.revision, reviewThreadId: thread.id });
    await reviewContext.call("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "thread review 1" });

    await callWorker("submit_for_review", { sessionId });
    const s2 = workSessions.get(sessionId)!.latestSubmission!;
    const h2 = reviewRoutes.getHandoffBySubmission(sessionId, s2.id, s2.reviewEpoch)!;
    assert.notEqual(h1.id, h2.id, "each submission gets a fresh isolated handoff");
    assert.notEqual(h1.reviewEpoch + ":" + h1.submissionId, h2.reviewEpoch + ":" + h2.submissionId, "handoffs bind to distinct submissions");
    // The original work session is never replaced by a fresh review.
    assert.equal(workSessions.get(sessionId)!.id, originalSessionId, "loop OFF does not create a new coding work session");
    await reviewContext.call("claim_review_handoff", { handoffId: h2.id, expectedRevision: h2.revision, reviewThreadId: thread.id });
    const approved = await reviewContext.call("provide_review_feedback", { sessionId, verdict: "approve", comments: "thread review 2" });
    assert.ok(!approved.isError, "the persistent authorized reviewer thread returns its verdict to the original work session");
  }

  // ── Experiment E: a route change mid-flight supersedes a stale claim ──
  {
    const sessionId = createSession();
    await callReviewer("configure_review_loop", { workSessionId: sessionId, enabled: true, mode: "isolated_review", maxReviewRounds: 3 });
    await callWorker("submit_for_review", { sessionId });
    const sub = workSessions.get(sessionId)!.latestSubmission!;
    const handoff = reviewRoutes.getHandoffBySubmission(sessionId, sub.id, sub.reviewEpoch)!;
    const reviewContext = createIsolatedReviewerContext("owner-b-session-stale");
    const thread = activateForReviewerContext(reviewRoutes.getRouteBySession(sessionId)!.id, reviewContext.contextId);
    const claimError = await reviewContext.call("claim_review_handoff", { handoffId: handoff.id, expectedRevision: handoff.revision, reviewThreadId: thread.id });
    if (claimError.isError) throw new Error(claimError.content?.[0]?.text ?? "claim failed");

    // The reviewer switches routing mode before committing feedback. This
    // increments the route epoch, invalidating the handoff claimed against the
    // old destination.
    const reconfigured = await callReviewer("configure_review_loop", {
      workSessionId: sessionId, enabled: true, mode: "pinned_conversation", maxReviewRounds: 3,
    });
    assert.equal(
      (reconfigured.structuredContent as { routeEpoch?: number })?.routeEpoch,
      2,
      "a mode change advances the route epoch",
    );
    const staleCommit = await reviewContext.call("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "stale route" });
    assert.ok(staleCommit.isError, "feedback claimed under a superseded route epoch is rejected");
    assert.equal(workSessions.get(sessionId)!.status, "awaiting_review", "the stale commit did not mutate the session");
  }

  // ── Scenario 13: defect #1 + #4 — awaiting-review worker crash stays resumable ──
  {
    const sessionId = createSession();
    await callWorker("submit_for_review", { sessionId }); // -> awaiting_review
    const run = agentRegistry.createRun({
      agentName: "cli-coding-agent",
      workspaceSessionId: WS,
      workSessionId: sessionId,
      inputPreview: "defect1 crash",
      status: "running",
    });
    const ev = await postAcpEvent(run.runId, {
      type: "failed",
      work_session_id: sessionId,
      payload: { message: "worker boom" },
    });
    assert.equal(ev.status, 202, "failed event accepted");
    const types = eventStore.getEventsForSession(sessionId).map((e) => e.type);
    assert.ok(!types.includes("agent.run.failed"), "awaiting-review crash must NOT emit terminal agent.run.failed");
    assert.ok(types.includes("worker.attempt.failed"), "emits non-terminal worker.attempt.failed");
    assert.equal(workSessions.get(sessionId)!.status, "awaiting_review", "session stays resumable/open");
    const lease = agentRegistry.getRun(run.runId)!.workerLeaseUntil;
    assert.ok(
      lease === undefined || lease === null || new Date(lease).getTime() < Date.now(),
      "worker lease cleared on exit, not left as a future timestamp (defect #4)",
    );
  }

  // ── Scenario 13b: native ACP completion review barrier carries exact snapshot ──
  {
    const sessionId = workSessions.create({
      workspaceSessionId: WS,
      submittedBy: "webui",
      completionPolicy: "webui_approval_required",
    }).id;
    const run = agentRegistry.createRun({
      agentName: "cli-coding-agent",
      workspaceSessionId: WS,
      workSessionId: sessionId,
      inputPreview: "native completed",
      status: "running",
    });
    reviewPatch = "diff --git a/native.txt b/native.txt\n--- a/native.txt\n+++ b/native.txt\n@@ -1 +1 @@\n-old\n+new\n";
    currentSnapshot = "native-snapshot";
    const ev = await postAcpEvent(run.runId, {
      type: "completed",
      work_session_id: sessionId,
      payload: { result: "done" },
    });
    assert.equal(ev.status, 202, "completed event accepted");
    const submission = workSessions.get(sessionId)!.latestSubmission!;
    assert.equal(submission.snapshotCommit, "native-snapshot", "native review barrier stores snapshot commit");
    assert.ok(submission.diffSha256, "native review barrier stores diff hash");
    assert.equal(submission.diffSha256.length, 64, "native review barrier stores sha256-sized diff hash");
    const approved = await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: submission.id,
      diffSha256: submission.diffSha256,
      reviewEpoch: submission.reviewEpoch,
      verdict: "approve",
    });
    assert.ok(!approved.isError, "native review barrier can be approved against current snapshot");
    assert.equal(workSessions.get(sessionId)!.status, "approved");
    currentSnapshot = "deadbeef";
    reviewPatch = "diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n";
  }

  // ── Scenario 14: defect #2 — three review rounds never replay stale feedback ──
  {
    const sessionId = createSession();
    const fbIds: string[] = [];
    // Round 1
    await callWorker("submit_for_review", { sessionId });
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "Please address the reviewed issue before resubmitting." });
    const r1 = await callWorker("await_review_feedback", { sessionId, timeoutMs: 100 });
    assert.equal(r1.structuredContent.status, "feedback_ready");
    fbIds.push(r1.structuredContent.feedback.id);
    await callWorker("submit_for_review", { sessionId, continuationId: r1.structuredContent.feedback.continuationId });
    // Round 2
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "Please address the reviewed issue before resubmitting." });
    const r2 = await callWorker("await_review_feedback", { sessionId, timeoutMs: 100 });
    assert.equal(r2.structuredContent.status, "feedback_ready");
    fbIds.push(r2.structuredContent.feedback.id);
    await callWorker("submit_for_review", { sessionId, continuationId: r2.structuredContent.feedback.continuationId });
    // Round 3 — must return the THIRD feedback, never the first-cycle one.
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "Please address the reviewed issue before resubmitting." });
    const r3 = await callWorker("await_review_feedback", { sessionId, timeoutMs: 100 });
    assert.equal(r3.structuredContent.status, "feedback_ready", "third round returns feedback");
    assert.notEqual(r3.structuredContent.feedback.id, fbIds[0], "third round must NOT replay first-cycle feedback");
    await callWorker("submit_for_review", { sessionId, continuationId: r3.structuredContent.feedback.continuationId });
    // Round 4 (no new feedback) — must time out, proving older cycles are not replayed.
    const r4 = await callWorker("await_review_feedback", { sessionId, timeoutMs: 100 });
    assert.equal(r4.structuredContent.status, "timeout", "no stale feedback replayed after 3 rounds");
  }

  // ── Scenario: anti-runaway loop guard stops a non-converging correction loop ──
  {
    const sessionId = workSessions.create({
      workspaceSessionId: VERIFY_WS,
      submittedBy: "webui",
      completionPolicy: "webui_approval_required",
    }).id;
    currentSnapshot = "verification-snapshot";
    missionLedger.createMission({
      workSessionId: sessionId, workspaceSessionId: VERIFY_WS, objective: "Verify command",
      acceptanceCriteria: [{ id: "verify-command", description: "command exits cleanly", verificationType: "test", verificationCommand: "npm --version" }],
      finalVerification: ["npm --version"],
    });
    await callWorker("submit_for_review", { sessionId });
    const verification = await callReviewer("run_mission_verification", { workSessionId: sessionId });
    assert.equal(verification.isError, undefined, `reviewer may run declared verification: ${JSON.stringify(verification)}`);
    assert.equal(verification.structuredContent.results[0].status, "passed");
    assert.equal(verification.structuredContent.results[1].status, "passed", "final integration command also passes");
    const packet = missionLedger.getPacket(sessionId);
    assert.equal(packet.criteria[0].status, "verified");
    assert.equal((packet.evidence[0].details as { source?: string }).source, "server_test_runner");
    assert.equal(packet.completionReports[0]?.status, "passed", "final integration produces a durable completion report");
    const latest = workSessions.get(sessionId)?.latestSubmission;
    assert.ok(latest?.id && latest.snapshotCommit);
    assert.equal(missionLedger.canApprove(sessionId, { submissionId: latest.id, snapshotCommit: latest.snapshotCommit }).allowed, true, "current final integration report enables approval");
    currentSnapshot = "verification-workspace-mutated";
    const staleApproval = await callReviewer("approve_supervised_work", { workSessionId: sessionId });
    assert.ok(staleApproval.isError, "mission approval refuses a workspace that changed after the verified submission");
    assert.match(String(staleApproval.content?.[0]?.text ?? ""), /Workspace snapshot changed since submission/);
    assert.equal(workSessions.get(sessionId)?.status, "awaiting_review", "stale mission approval leaves the exact submission pending");
    currentSnapshot = "verification-snapshot";
    const approved = await callReviewer("approve_supervised_work", { workSessionId: sessionId });
    assert.equal(approved.isError, undefined, "approval accepts the current completion report");
    assert.equal(workSessions.get(sessionId)?.latestFeedback?.completionReportSha256, packet.completionReports[0]?.reportSha256, "approval feedback is bound to the exact completion report hash");
    currentSnapshot = "deadbeef";
  }

  {
    const sessionId = createSession();
    // Mission with a low ceiling and one required criterion, bound to a real
    // submission so continue_supervised_work has a `latestSubmission` to act on.
    missionLedger.createMission({
      workSessionId: sessionId,
      workspaceSessionId: WS,
      objective: "Add feature Y",
      acceptanceCriteria: [{ id: "y-crit", description: "Feature Y works", priority: "required", verificationType: "test", verificationCommand: "npm --version" }],
      maxCorrectionRounds: 1,
    });
    await callWorker("submit_for_review", { sessionId });

    const wo = { objectiveForThisTurn: "fix it" };
    // Round 1: a new blocking in-scope finding extends the loop (within ceiling).
    const r1 = await callReviewer("continue_supervised_work", {
      workSessionId: sessionId, comments: "round1",
      findings: [{ description: "crashes on empty", requiredAction: "handle empty", severity: "blocker", scope: "in_scope" }],
      workOrder: wo,
    });
    assert.notEqual(r1.structuredContent?.status, "ceiling_reached", "round 1 within ceiling extends");

    // Resubmit so there is a pending submission for the next round.
    await callWorker("submit_for_review", { sessionId, continuationId: r1.structuredContent?.continuationId });
    await callWorker("await_review_feedback", { sessionId, timeoutMs: 50 }).catch(() => undefined);

    // Round 2: another NEW blocker, nothing resolved → runaway → ceiling stops it.
    const r2 = await callReviewer("continue_supervised_work", {
      workSessionId: sessionId, comments: "round2",
      findings: [{ description: "also breaks on null", requiredAction: "handle null", severity: "blocker", scope: "in_scope" }],
      workOrder: wo,
    });
    assert.equal(r2.structuredContent?.status, "awaiting_human", "non-converging runaway stops automatic dispatch at the ceiling");
    assert.equal(r2.structuredContent?.extension?.ceilingHit, true);

    // Resolve the two blocking findings from rounds 1 and 2 so the authority
    // predicate can actually converge; otherwise no-progress is correct.
    const convMission = missionLedger.getMissionByWorkSession(sessionId)!;
    const convPacket = missionLedger.getPacket(sessionId);
    for (const finding of convPacket.findings.filter((f) => f.disposition === "blocking" && f.status !== "waived")) {
      missionLedger.updateFindingStatus(convMission.id, [{ id: finding.id, status: "waived", waiverReason: "test-converged" }]);
    }
    const convLatest = workSessions.get(sessionId)?.latestSubmission;
    const savedSnapshot = currentSnapshot;
    if (convLatest?.id && convMission) {
      missionLedger.recordVerifierEvidence(convMission.id, [{
        criterionId: "y-crit",
        submissionId: convLatest.id,
        reviewEpoch: convLatest.reviewEpoch,
        snapshotKind: "git" as const,
        snapshotRef: convLatest.snapshotCommit ?? convLatest.snapshotRef,
        status: "passed" as const,
      }]);
    }
    currentSnapshot = convLatest?.snapshotCommit ?? savedSnapshot;
    const converged = await callReviewer("continue_supervised_work", {
      workSessionId: sessionId,
      comments: "Review the current result without adding another blocking issue.",
      workOrder: wo,
    });
    currentSnapshot = savedSnapshot;
    assert.equal(converged.structuredContent?.status, "converged", "a converged loop cannot dispatch another correction round");

    // An out-of-scope finding must NOT gate approval on its own.
    const mid = missionLedger.getMissionByWorkSession(sessionId)!;
    missionLedger.addFindings(mid.id, [{ description: "pre-existing lint elsewhere", requiredAction: "n/a", severity: "high", scope: "out_of_scope" }]);
    const approval = missionLedger.canApprove(sessionId);
    assert.ok(!approval.reasons.some((r) => r.includes("pre-existing")), "out_of_scope finding does not block approval");
  }

  // A resumed supervisor must wake the runtime for every durable action, not
  // only for verification.  Correction_pending is the previously stranded
  // case because no new review event is guaranteed to arrive after resume.
  {
    const sessionId = createSession();
    const mission = missionLedger.createMission({
      workSessionId: sessionId,
      workspaceSessionId: WS,
      objective: "Resume a correction",
      acceptanceCriteria: [{ id: "resume-correction", description: "Correction resumes", priority: "required" }],
    });
    const created = supervisorRuns.create({ missionId: mission.id, workSessionId: sessionId, workspaceSessionId: WS, autonomyMode: "correction_auto" });
    const correction = supervisorRuns.transition({ id: created.id, expectedStatus: "created", expectedRevision: created.revision, nextStatus: "correction_pending" });
    assert.ok(correction);
    const before = supervisorWakeCalls;
    const paused = await callReviewer("pause_supervisor_run", { workSessionId: sessionId, expectedRevision: correction.revision });
    assert.equal(paused.isError, undefined);
    const pausedRun = supervisorRuns.getByWorkSession(sessionId)!;
    assert.equal(pausedRun.status, "paused");
    const resumed = await callReviewer("resume_supervisor_run", { workSessionId: sessionId, expectedRevision: pausedRun.revision });
    assert.equal(resumed.isError, undefined);
    assert.equal(supervisorRuns.getByWorkSession(sessionId)?.status, "correction_pending");
    assert.equal(supervisorWakeCalls, before + 1, "resuming correction_pending wakes the durable supervisor runtime");
  }

  // ── Outbox ownership: continuation dispatcher must not acknowledge foreign events ──
  {
    const foreignId = dispatchOutbox.enqueue({
      eventType: "supervisor.verification.requested",
      aggregateId: "run-foreign",
      aggregateRevision: 7,
      payload: { workSessionId: "ws-foreign" },
    }).id;
    const foreignScheduledId = dispatchOutbox.enqueue({
      eventType: "scheduled_job.due",
      aggregateId: "job-foreign",
      aggregateRevision: 1,
      payload: { scheduledJobId: "job-foreign" },
    }).id;
    const sessionId = createSession();
    await callWorker("submit_for_review", { sessionId });
    const ownedOriginalRun = agentRegistry.createRun({
      agentName: "cli-coding-agent",
      workspaceSessionId: WS,
      workSessionId: sessionId,
      inputPreview: "owned continuation provenance",
      status: "running",
    });
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested", comments: "owned event regression" });
    const ownedContinuation = continuationManager.listForSession(sessionId).at(-1)!;
    const owned = dispatchOutbox.listByAggregate(ownedContinuation.id)
      .find((event) => event.eventType === "continuation.ready" && event.aggregateRevision === ownedContinuation.reviewEpoch);
    assert.ok(owned, "owned continuation event exists in the same outbox");
    // Foreign events must remain pending after any dispatcher pass. The
    // continuation's own dispatch outcome is covered by prior scenarios; this
    // test pins the ownership boundary.
    await runContinuationTick({ ...config, resumeAgent: undefined });
    const foreign = dispatchOutbox.get(foreignId)!;
    const scheduled = dispatchOutbox.get(foreignScheduledId)!;
    assert.equal(foreign.status, "pending", "supervisor event remains owned by its consumer");
    assert.equal(scheduled.status, "pending", "scheduled event remains owned by its consumer");
    void owned;
  }

  // ── K05: an accepted dispatch with a lost response remains recoverable. ──
  {
    dropNextDispatchResponse = true;
    const uncertain = await callReviewer("submit_to_coding_agent", {
      task: "continue after the adapter acceptance response is lost",
      workspaceSessionId: UNCERTAIN_WS,
    });
    assert.equal(uncertain.structuredContent.status, "uncertain",
      "a dropped acceptance response is reported as uncertain rather than failed");
    const workSessionId = uncertain.structuredContent.workSessionId as string;
    const runId = uncertain.structuredContent.runId as string;
    const logicalRun = agentRegistry.getRun(runId)!;
    const attempt = agentRegistry.getLatestDispatchAttemptForRun(runId)!;
    assert.equal(logicalRun.status, "dispatch_uncertain", "uncertain transport does not terminally fail the logical run");
    assert.equal(logicalRun.finishedAt, undefined, "uncertain transport has no false terminal timestamp");
    assert.equal(attempt.status, "uncertain", "the durable attempt stays available for reconciliation");
    assert.equal(workSessions.get(workSessionId)?.status, "in_progress", "the work session remains recoverable");
    assert.ok(workSessions.getWorkspaceLeaseForSession(workSessionId), "the workspace fence stays with the unresolved worker");

    const submitted = await callWorker("submit_for_review", { sessionId: workSessionId });
    assert.ok(!submitted.isError, `a later submission remains correlated: ${JSON.stringify(submitted)}`);
    assert.equal(agentRegistry.getRunByWorkSessionId(workSessionId)?.runId, runId,
      "the later review submission resolves to the original logical run");
  }

  // ── Scheduled peer changes-requested feedback creates a fenced follow-up job. ──
  {
    const sessionId = createSession();
    const priorSubmission = workSessions.submitForReview({
      workSessionId: sessionId,
      diff: "diff --git a/reports/audit.md b/reports/audit.md\n+prior report\n",
      snapshotKind: "git",
      snapshotRef: "a".repeat(40),
      files: [{ path: "reports/audit.md", type: "new", additions: 1, removals: 0 }],
      message: "Initial scheduled peer report",
    });
    const feedback = await reviewWorkflow.provideFeedback({
      sessionId,
      submissionId: priorSubmission.id,
      diffSha256: priorSubmission.diffSha256,
      reviewEpoch: priorSubmission.reviewEpoch,
      verdict: "changes_requested",
      comments: "Add the missing failure case and keep the report concise.",
      invocationOrigin: "authenticated_reviewer",
    });
    assert.ok(feedback.continuationId);
    const continuation = continuationManager.get(feedback.continuationId!)!;

    const peerJobStore = openPeerJobStore(root, {
      level: "silent", format: "json", requests: false, assets: false, toolCalls: false, shellCommands: false,
    }, db);
    const priorPeerJob = peerJobStore.createJob({
      jobId: `job_${"1".repeat(8)}-${"1".repeat(4)}-${"1".repeat(4)}-${"1".repeat(4)}-${"1".repeat(12)}`,
      peerId: "peer-scheduled",
      workSessionId: sessionId,
      workspaceSessionId: WS,
      schedulerDispatchId: "dispatch-scheduled-peer",
      repositoryId: "/tmp/scheduled-peer-repository",
      baseRevision: "b".repeat(40),
      taskClass: "read_only_audit",
      instructionHash: createHash("sha256").update("prior scheduled instruction").digest("hex"),
      instructions: "Inspect the repository and write reports/audit.md.",
      allowedOutputs: ["reports/audit.md"],
      maxRuntimeMs: 60_000,
      maxArtifactBytes: 1024,
    });
    const peerClaim = peerJobStore.claimNextJob(priorPeerJob.peerId, Date.now())!;
    peerJobStore.markStarted(peerClaim.attempt.attemptId, peerClaim.attempt.claimToken, priorPeerJob.peerId, Date.now());
    const peerReceipt = {
      jobId: priorPeerJob.jobId,
      attemptId: peerClaim.attempt.attemptId,
      actorClass: "muse_vm_process" as const,
      baseRevision: priorPeerJob.baseRevision,
      manifestSha256: manifestSha256(priorPeerJob.baseRevision, []),
      files: [],
      totalBytes: 0,
      terminalState: "succeeded" as const,
    };
    peerJobStore.completeAttempt(peerClaim.attempt.attemptId, peerClaim.attempt.claimToken, priorPeerJob.peerId, peerReceipt, Date.now());
    peerJobStore.markStaging(priorPeerJob.jobId, createHash("sha256").update(JSON.stringify(peerReceipt)).digest("hex"), Date.now());
    peerJobStore.markAwaitingReview(priorPeerJob.jobId, {
      receiptSha256: createHash("sha256").update(JSON.stringify(peerReceipt)).digest("hex"),
      submissionId: priorSubmission.id,
      reviewEpoch: priorSubmission.reviewEpoch,
      snapshotKind: "git",
      snapshotRef: "a".repeat(40),
      diffSha256: priorSubmission.diffSha256!,
    }, Date.now());
    const priorFeedbackId = eventStore.getEventById(feedback.feedbackEventId!)!.payload.feedbackId as string;
    peerJobStore.finalizeReview(priorPeerJob.jobId, {
      submissionId: priorSubmission.id,
      reviewEpoch: priorSubmission.reviewEpoch,
      feedbackId: priorFeedbackId,
      verdict: "changes_requested",
    }, Date.now());
    const previousPeerJobStore = getPeerJobStore();
    setPeerJobStoreSingleton(peerJobStore);
    try {
      const scheduledJobs = {
        getByWorkSessionId: (id: string) => id === sessionId
          ? { id: "scheduled-peer-source", projectId: WS, workSessionId: sessionId, activeDispatchAttemptId: "scheduled-peer-attempt", dispatchTarget: { kind: "peer_pull", peerId: priorPeerJob.peerId } }
          : undefined,
        getAttempt: () => ({ dispatchId: "dispatch-scheduled-peer" }),
      } as any;
      await runContinuationTick({ ...config, scheduledJobs });
      const resumedPeerJobId = scheduledPeerContinuationJobId(continuation.id);
      const resumedPeerJob = peerJobStore.getJob(resumedPeerJobId);
      assert.ok(resumedPeerJob, "the continuation becomes a durable peer job instead of failing for a missing ACP run");
      assert.equal(resumedPeerJob.workSessionId, sessionId);
      assert.equal(resumedPeerJob.workspaceSessionId, WS);
      assert.equal(resumedPeerJob.baseRevision, priorPeerJob.baseRevision, "the follow-up remains fenced to the original immutable base");
      assert.deepEqual(resumedPeerJob.allowedOutputs, priorPeerJob.allowedOutputs, "feedback cannot expand output authority");
      assert.match(resumedPeerJob.instructions, /Add the missing failure case/);
      assert.match(resumedPeerJob.instructions, /Exact prior checkpoint: git:/);
      assert.match(resumedPeerJob.instructions, /complete final contents for every listed changed path/);
      assert.equal(continuationManager.get(continuation.id)?.status, "dispatched");
      assert.equal(continuationManager.get(continuation.id)?.target, `peer:${resumedPeerJobId}`);
      assert.equal(workSessions.get(sessionId)?.lastConsumedFeedbackId, priorFeedbackId);
    } finally {
      setPeerJobStoreSingleton(previousPeerJobStore);
      peerJobStore.close();
    }
  }

  console.log("bridge-flow.test.ts: all assertions passed");
} finally {
  if (destinationAdapter && destinationAdapter.exitCode === null) {
    destinationAdapter.kill("SIGTERM");
    await new Promise<void>((resolve) => destinationAdapter!.once("exit", () => resolve()));
  }
  if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  if (acpHttp) await new Promise<void>((resolve) => acpHttp!.close(() => resolve()));
  workSessions.close();
  eventStore.close();
  continuationManager.close();
  missionLedger.close();
  supervisorRuns.close();
  approvalRequests.close();
  agentRegistry.close();
  await rm(root, { recursive: true, force: true });
}
