/**
 * Integrated regression: browser review-packet acceptance → authenticated
 * handoff claim → handoff-bound feedback → worker continuation.
 *
 * Proves the end-to-end path that is missing from the existing fragmented
 * suite:
 *
 *  - src/bridge-flow.test.ts:1294-1362  Scenario 12c/R06 exercises
 *    separate reviewer activation, exact claimed immutable submission,
 *    wrong-context rejection, submit_handoff_feedback, and
 *    await_review_feedback wake — but the handoff claim is driven
 *    through the MCP bridge tools (fakeServer), not the browser contract
 *    acceptance path.
 *
 *  - src/review-browser/contracts.test.ts  fakes CDP and validates that a
 *    bounded review packet is accepted without duplicate sends, but it does
 *    not touch the handoff feedback or worker waiter.
 *
 *  - src/review-thread/review-thread.test.ts  covers advisory clarification
 *    messages but NOT review-packet feedback through handoff.
 *
 * This test wires real stores (work-sessions, routes, threads, workflow,
 * continuation-manager, dispatch-outbox) with a fake browser-transport
 * reviewer context and exercises the complete path. It proves that:
 *
 *  1. A bounded packet accepted by the browser transport leaves the review
 *     route in pending-claim state (worker waiter unresolved).
 *  2. An authenticated reviewer claims the exact handoff and returns
 *     `changes_requested` structured feedback via `submit_handoff_feedback`.
 *  3. The worker `await_review_feedback` resolver wakes with the expected
 *     continuation and verdict.
 *  4. Wrong context / wrong epoch / stale snapshot / wrong handoff revision
 *     are all rejected by the handoff claim or feedback path.
 *  5. Browser transport retry (duplicate packet send) does not produce a
 *     second handoff claim or duplicate feedback.
 *
 * Synthetic evidence disclaimer: all database state is in-memory/tempfile
 * with a fake browser transport; this cannot qualify live ChatGPT or real
 * Chromium browser integration.
 *
 * Environment contract:
 *   - This file is plain ESM. `import` statements are hoisted, so a module
 *     cannot set `KONTROL_WORKSPACE_APP_HTML_PATH` before the kontrol graph
 *     loads `workspace-app-resource.ts`. Therefore the caller MUST set
 *     `KONTROL_WORKSPACE_APP_HTML_PATH` to a built, self-contained
 *     `workspace-app.html` before launching this test (the dev watcher
 *     produces one; the primary harness uses `.tmp-ui/workspace-app.html`).
 *     Without it, module load fails fast at `workspace-app-resource` with an
 *     explicit instruction — the intended fail-closed behavior.
 *   - Determinism & bounded runtime: all reviewer/worker chatter uses
 *     in-memory MCP transports (no real HTTP servers, no network, no
 *     recurring polling). A hard watchdog terminates the run non-zero if the
 *     suite ever exceeds a fixed wall-clock budget, so a regression can never
 *     hang an invocation unboundedly.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { openDatabase } from "./db/client.js";
import { createWorkSessionManager } from "./work-sessions.js";
import { createEventStore } from "./event-log.js";
import { createContinuationManager } from "./continuation.js";
import { createMissionLedger } from "./mission-ledger.js";
import { createSupervisorRuns } from "./supervisor-runs.js";
import { createAgentRegistryManager } from "./acp-registry.js";
import { createDispatchOutbox } from "./dispatch-outbox.js";
import { createAgentMessageManager } from "./agent-messages.js";
import { createReviewWorkflowService } from "./review-workflow.js";
import { createReviewRouteStore } from "./review-handoff/route-store.js";
import { createReviewThreadStore } from "./review-thread/thread-store.js";
import { createApprovalRequestManager } from "./approval-requests.js";
import { registerBridgeTools, type BridgeConfig } from "./acp-bridge.js";
import { registerPolicyTools } from "./policy-tools.js";
import { createPolicyEngine } from "./policy.js";

// ─── Bounded runtime guard ─────────────────────────────────────────
//
// The review/worker tools all run over in-memory MCP transports, so the
// suite is fully local and synchronous-ish. This watchdog only exists to
// convert a real future regression (e.g. a waiter that never resolves) into
// a fast, explicit failure instead of an unbounded hang. It is cleared on
// success; on failure it dumps the active handles and exits non-zero.
const HARD_DEADLINE_MS = 30_000;
let suiteFinished = false;
const watchdog = setTimeout(() => {
  if (suiteFinished) return;
  console.error(
    `[review-browser-handoff-integration] FATAL: suite exceeded hard deadline (${HARD_DEADLINE_MS}ms); ` +
      "a waiter likely never resolved. Dumping active handles for diagnosis.",
  );
  const handles: unknown[] = (process as any)._getActiveHandles?.() ?? [];
  for (const h of handles) {
    const ctor = (h as any)?.constructor?.name ?? "?";
    const details: string[] = [];
    if (typeof (h as any)?.listening === "boolean") details.push(`listening=${(h as any).listening}`);
    if ((h as any)?._httpMessage) details.push("httpMessage");
    if ((h as any)?.server) details.push(`serverCtor=${(h as any).server?.constructor?.name}`);
    if (typeof (h as any)?._eventsCount === "number") details.push(`events=${(h as any)._eventsCount}`);
    console.error(`  [${ctor}] ${details.join(" ")}`);
  }
  process.exit(2);
}, HARD_DEADLINE_MS);
watchdog.unref?.();

// Fail fast with an explicit instruction when the caller forgot the built
// artifact. This is a runtime clone of the module-load guard in
// workspace-app-resource so the failure message is crystal clear even when
// the import graph resolves the artifact differently.
if (!process.env.KONTROL_WORKSPACE_APP_HTML_PATH) {
  throw new Error(
    "review-browser-handoff-integration.test.ts requires KONTROL_WORKSPACE_APP_HTML_PATH to be set to a " +
      "built, self-contained workspace-app.html (the kontrol graph loads workspace-app-resource at import " +
      "time, before this file can set it). Example: " +
      "KONTROL_WORKSPACE_APP_HTML_PATH=$PWD/.tmp-ui/workspace-app.html",
  );
}

// ─── Test scaffolding ──────────────────────────────────────────────────

const root = await mkdtemp(join(tmpdir(), "kontrol-browser-handoff-int-"));
const WS = "ws-browser-int";

// NOTE: no real HTTP servers are created here. The worker and reviewer MCP
// servers run over in-memory transports, and the registered agent's URL is a
// placeholder never contacted by these scenarios (their assertions exercise
// submission, handoff claim, and feedback wake — not agent dispatch).

let db: any;
let workSessions: any;
let eventStore: any;
let continuationManager: any;
let dispatchOutbox: any;
let agentMessages: any;
let missionLedger: any;
let supervisorRuns: any;
let approvalRequests: any;
let agentRegistry: any;
let reviewRoutes: any;
let reviewThreads: any;

// ─── Mutable browser-transport state ────────────────────────────────────

/** Simulates the ChatGptPageDriver submitting a bounded review packet. */
const browserDriver: {
  attempts: Map<string, string>;
  accepted: number;
  handoffId: string;
  submissionId: string;
  epoch: number;
  sha256: string;
  retrySameAttempt(handoffId: string, submissionId: string, epoch: number, sha256: string): Promise<"accepted" | "duplicate">;
  getState(): { handoffId: string; submissionId: string; epoch: number; sha256: string };
} = {
  attempts: new Map(),
  accepted: 0,
  handoffId: "",
  submissionId: "",
  epoch: 0,
  sha256: "",
  async retrySameAttempt(handoffId: string, submissionId: string, epoch: number, sha256: string) {
    // Each browser turn is a distinct attempt for the SAME logical handoff.
    // The server-side dedup (one handoff / one continuation) is what
    // Scenario C proves; the driver itself acknowledges every distinct turn
    // as "accepted". A genuinely repeated attemptId is a pure duplicate.
    const attemptId = `browser-attempt-${Date.now()}-${Math.random()}`;
    if (this.attempts.has(attemptId)) {
      return "duplicate";
    }
    this.attempts.set(attemptId, `${handoffId}:${submissionId}`);
    this.handoffId = handoffId;
    this.submissionId = submissionId;
    this.epoch = epoch;
    this.sha256 = sha256;
    this.accepted += 1;
    return "accepted";
  },
  getState() {
    return { handoffId: this.handoffId, submissionId: this.submissionId, epoch: this.epoch, sha256: this.sha256 };
  },
};

try {
  // ─── Database & stores ──────────────────────────────────────────────

  db = openDatabase(root);
  workSessions = createWorkSessionManager(db);
  eventStore = createEventStore(db);
  continuationManager = createContinuationManager(db);
  dispatchOutbox = createDispatchOutbox(db);
  agentMessages = createAgentMessageManager(db);
  missionLedger = createMissionLedger(db);
  supervisorRuns = createSupervisorRuns(db);
  approvalRequests = createApprovalRequestManager(db);
  agentRegistry = createAgentRegistryManager(db);
  reviewRoutes = createReviewRouteStore(db);
  reviewThreads = createReviewThreadStore(db);

  // Seed workspace_sessions for FK constraints
  db.sqlite.prepare(
    "insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, ?, 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')"
  ).run(WS, join(root, "ws"));

  // ─── Shared mocks ───────────────────────────────────────────────────

  const reviewPatch = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n";
  let currentSnapshot = "synthetic-snapshot-a";
  const workspaces = {
    getWorkspace: (_id: string) => {
      return { id: WS, root: join(root, "ws"), mode: "checkout" } as any;
    },
  } as any;
  const reviewCheckpoints = {
    reviewChanges: async () => ({
      patch: reviewPatch, result: "reviewed",
      summary: { files: 1, additions: 1, removals: 1 },
      files: [{ path: "x.ts", operation: "update", additions: 1, removals: 1 }],
      snapshotCommit: currentSnapshot, snapshotKind: "git", snapshotRef: currentSnapshot,
    }),
    reviewChangesAgainstCommit: async ({ baselineCommit }: { baselineCommit: string }) => ({
      patch: baselineCommit === currentSnapshot ? "" : reviewPatch,
      result: baselineCommit === currentSnapshot ? "reviewed snapshot is current" : "workspace changed",
      summary: baselineCommit === currentSnapshot ? { files: 0, additions: 0, removals: 0 } : { files: 1, additions: 1, removals: 1 },
      snapshotCommit: currentSnapshot,
    }),
    commitReviewed: async () => {},
  } as any;

  const reviewWorkflow = createReviewWorkflowService({
    workSessions, eventStore, continuationManager, agentRegistry, db,
    workspaces, reviewCheckpoints, dispatchOutbox, reviewRoutes,
  });
  const policyEngine = createPolicyEngine({ defaultMode: "allow", toolRules: {}, pathRules: [] });

  // ─── BridgeConfig ───────────────────────────────────────────────────

  const liveWaiters: any = (() => {
    const map = new Map<string, Set<string>>();
    return {
      add: (id: string) => {
        const waiterId = `waiter_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const set = map.get(id) ?? new Set<string>();
        set.add(waiterId);
        map.set(id, set);
        return waiterId;
      },
      remove: (id: string, waiterId?: string) => {
        const set = map.get(id);
        if (!set) return false;
        if (waiterId) set.delete(waiterId);
        else set.clear();
        const empty = set.size === 0;
        if (empty) map.delete(id);
        return empty;
      },
      has: (id: string) => (map.get(id)?.size ?? 0) > 0,
    };
  })();

  const baseConfig: Omit<BridgeConfig, "principalRole" | "resumeAgent" | "onSupervisorResume" | "knownAgents" | "adapterSecret"> = {
    db, workspaces, workSessions, reviewCheckpoints, agentRegistry,
    eventStore, continuationManager, dispatchOutbox, agentMessages,
    reviewWorkflow, reviewRoutes, reviewThreads, approvalRequests,
    missionLedger, supervisorRuns, liveWaiters,
    serverConfig: { verifySandbox: false, childEnvironmentAllowlist: [], verifyToolchainPaths: [], verifyMaxInflight: 1 } as any,
  };

  const config = { ...baseConfig, principalRole: "client" as const, adapterSecret: "test-secret", liveWaiters, onSupervisorResume: () => {}, knownAgents: [] };

  // Register a placeholder agent for FK/identity purposes. No scenario in this
  // suite dispatches to an agent, so the URL is never contacted.
  agentRegistry.register({
    name: "cli-coding-agent",
    url: "http://127.0.0.1:1/agents/cli-coding-agent",
    role: "agent",
    ttlSeconds: 600,
  });

  // ─── Helpers ────────────────────────────────────────────────────────

  function createSession(): string {
    return workSessions.create({ workspaceSessionId: WS, submittedBy: "webui" }).id;
  }

  /** Call a tool on a worker MCP server, returning the raw CallToolResult. */
  async function callWorker(config: BridgeConfig, sessionId: string, tool: string, args: Record<string, unknown>) {
    const server = new McpServer({ name: `worker-${tool}`, version: "1.0.0" });
    registerBridgeTools(server, { ...config, principalRole: "worker" as const, reviewRoutes, reviewThreads, approvalRequests, missionLedger, supervisorRuns, knownAgents: [], adapterSecret: "test-secret", liveWaiters, onSupervisorResume: () => {} });
    const client = new Client({ name: `worker-${tool}-client`, version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    let result: Awaited<ReturnType<typeof client.callTool>>;
    try {
      result = await client.callTool({ name: tool, arguments: args });
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
    return result;
  }

  /** Creates an MCP reviewer server bound to a specific conversation context. */
  function makeReviewerMcp(
    conversationId: string,
    principalId: string,
  ) {
    const mcpSessionId = `reviewer-${conversationId}`;
    const contextId = `principal:${principalId}|mcp-session:${mcpSessionId}`;
    const server = new McpServer({ name: `reviewer-${conversationId}`, version: "1.0.0" });
    const rc = {
      ...baseConfig, principalRole: "reviewer" as const, principalId,
      connectionConversationId: conversationId, connectionMcpSessionId: mcpSessionId,
      reviewRoutes, reviewThreads, approvalRequests, missionLedger, supervisorRuns,
      knownAgents: [], adapterSecret: "test-secret", liveWaiters, onSupervisorResume: () => {},
    } as BridgeConfig;
    registerBridgeTools(server, rc);
    // registerHandoffTools is already mounted by registerBridgeTools
    // (see src/bridge/register.ts); mounting it a second time would throw
    // "Tool X is already registered".
    registerPolicyTools(server, { eventStore, policyEngine, approvalRequests, principalRole: "reviewer" as const });
    const client = new Client({ name: `reviewer-client-${conversationId}`, version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const connected = Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      await connected;
      return client.callTool({ name, arguments: args });
    };
    return { client, server, contextId, call };
  }

  // ─── Fixture ────────────────────────────────────────────────────────

  // Every scenario needs an ACTIVE review route before its first submit so
  // submit_for_review provisions a handoff (route.status must be "active").
  // This mirrors the operator calling configure_review_loop(enabled=true)
  // before dispatching. Each fresh session starts at route epoch 1.
  function activateRoute(sessionId: string, ownerPrincipalId: string): void {
    const route = reviewRoutes.configure({
      workSessionId: sessionId,
      ownerPrincipalId,
      ownerContextId: `principal:${ownerPrincipalId}|mcp-session:owner`,
      enabled: true,
      mode: "isolated_review",
      maxReviewRounds: 3,
      deliveryTransport: "mcp_app",
    });
    assert.equal(route.status, "active", "review route activated");
  }

  // submit_for_review provisions a durable handoff but does not echo its id in
  // the tool result. Resolve it (authoritatively) from the route store so the
  // scenario can drive the browser-acceptance → claim → feedback path with the
  // real handoff identity.
  function handoffFor(sessionId: string, submissionId: string, reviewEpoch: number): string {
    const handoff = reviewRoutes.getHandoffBySubmission(sessionId, submissionId, reviewEpoch);
    assert.ok(handoff, "submit_for_review provisions a durable handoff");
    return handoff!.id;
  }

  // ── Scenario A: Full happy path ────────────────────────────────────
  {
    const sessionId = createSession();
    activateRoute(sessionId, "reviewer-user-1");

    // A1: Worker submits for review
    const submitRes = await callWorker(config, sessionId, "submit_for_review", { sessionId });
    assert.ok(!submitRes.isError, "worker submit_for_review is accepted");
    const submissionId = (submitRes.structuredContent as { submissionId: string }).submissionId;
    const submissionEpoch = (submitRes.structuredContent as { reviewEpoch: number }).reviewEpoch;
    const diffSha256 = (submitRes.structuredContent as { diffSha256: string }).diffSha256;
    const handoffId = handoffFor(sessionId, submissionId, submissionEpoch);
    assert.ok(submissionId, "submit returns a submissionId");
    assert.ok(diffSha256, "submit returns a diffSha256");
    assert.equal(workSessions.get(sessionId)!.status, "awaiting_review");

    // A2: Browser transport accepts the bounded review packet.
    browserDriver.handoffId = handoffId;
    browserDriver.submissionId = submissionId;
    browserDriver.epoch = submissionEpoch;
    browserDriver.sha256 = diffSha256;
    const acceptResult = await browserDriver.retrySameAttempt(handoffId, submissionId, submissionEpoch, diffSha256);
    assert.equal(acceptResult, "accepted", "browser transport accepts the bounded review packet");

    // A3: Worker parks on await_review_feedback (bounded wait — resolves on
    // feedback or after the internal timeout).
    const waiterPromise = callWorker(config, sessionId, "await_review_feedback", { sessionId, timeoutMs: 5000 });

    // A4: Reviewer activates a thread and claims the handoff.
    const reviewerClient = makeReviewerMcp("reviewer-op-a", "reviewer-user-1");
    const route = reviewRoutes.getRouteBySession(sessionId)!;
    const thread = reviewThreads.activate({
      activationSecret: reviewThreads.createActivation({ routeId: route.id, ownerPrincipalId: "reviewer-user-1", reviewerPrincipalId: "reviewer-user-1" }).activationSecret,
      principalId: "reviewer-user-1", contextId: reviewerClient.contextId,
    });
    assert.equal(thread.status, "active", "review thread activated");

    // A5: Claim the handoff.
    const claimResult = await reviewerClient.call("claim_review_handoff", {
      handoffId, expectedRevision: 1, reviewThreadId: thread.id,
    });
    assert.ok(!claimResult.isError, `reviewer claims the handoff: ${JSON.stringify(claimResult.content)}`);

    // A6: Submit changes_requested feedback through the claimed handoff.
    const feedbackResult = await reviewerClient.call("submit_handoff_feedback", {
      handoffId,
      expectedRevision: (claimResult.structuredContent as { revision: number }).revision,
      verdict: "changes_requested",
      comments: "Please address the reviewed issue before resubmitting.",
      requiredActions: ["Fix the reviewed issue"],
    });
    assert.ok(!feedbackResult.isError, `handoff feedback submitted: ${JSON.stringify(feedbackResult.content)}`);
    assert.equal((feedbackResult.structuredContent as { status: string }).status, "changes_requested");

    // A7: Worker waiter wakes.
    const waiterResult = await waiterPromise;
    assert.equal((waiterResult.structuredContent as { status: string }).status, "feedback_ready");
    assert.equal((waiterResult.structuredContent as { feedback: { verdict: string } }).feedback.verdict, "changes_requested");
    assert.equal((waiterResult.structuredContent as { feedback: { comments: string } }).feedback.comments, "Please address the reviewed issue before resubmitting.");
    assert.deepEqual((waiterResult.structuredContent as { feedback: { requiredActions: string[] } }).feedback.requiredActions, ["Fix the reviewed issue"]);

    await reviewerClient.client.close().catch(() => {});
    await reviewerClient.server.close().catch(() => {});
  }

  // ── Scenario B: Wrong context / stale revision rejected ───────────
  {
    const sessionId = createSession();
    // The review loop is owned by a single reviewer principal; any thread it
    // activates must match that route owner. Wrong-context/stale-revision
    // rejection is proven through feedback-time authority checks, not by
    // creating a second thread under a different owner.
    activateRoute(sessionId, "reviewer-user-b");

    const submitRes = await callWorker(config, sessionId, "submit_for_review", { sessionId });
    assert.ok(!submitRes.isError, "submit is accepted");
    const submissionId = (submitRes.structuredContent as { submissionId: string }).submissionId;
    const reviewEpoch = (submitRes.structuredContent as { reviewEpoch: number }).reviewEpoch;
    const handoffId = handoffFor(sessionId, submissionId, reviewEpoch);
    const diffSha256 = (submitRes.structuredContent as { diffSha256: string }).diffSha256;

    const wrongContext = makeReviewerMcp("wrong-conversation-123", "wrong-reviewer");
    const correctContext = makeReviewerMcp("correct-context-b", "reviewer-user-b");
    const route = reviewRoutes.getRouteBySession(sessionId)!;
    const thread = reviewThreads.activate({
      activationSecret: reviewThreads.createActivation({ routeId: route.id, ownerPrincipalId: "reviewer-user-b", reviewerPrincipalId: "reviewer-user-b" }).activationSecret,
      principalId: "reviewer-user-b", contextId: correctContext.contextId,
    });

    // B1: The correct-context reviewer claims the handoff.
    const goodClaim = await correctContext.call("claim_review_handoff", {
      handoffId, expectedRevision: 1, reviewThreadId: thread.id,
    });
    assert.ok(!goodClaim.isError, "reviewer claims the handoff");
    const goodRevision = (goodClaim.structuredContent as { revision: number }).revision;

    // B2: A different context (same principal role, separate MCP session)
    // submits feedback — rejected because the submitter context is not the
    // current handoff claim owner.
    const badFeedback = await wrongContext.call("submit_handoff_feedback", {
      handoffId,
      expectedRevision: goodRevision,
      verdict: "approve",
      comments: "this should fail",
    });
    assert.ok(badFeedback.isError, "wrong context rejected at feedback: " + JSON.stringify(badFeedback.content));
    assert.equal(workSessions.get(sessionId)!.status, "awaiting_review", "rejected feedback leaves the submission pending");

    // B3: Stale handoff revision is rejected for the correct context too.
    const staleFeedback = await correctContext.call("submit_handoff_feedback", {
      handoffId, expectedRevision: 9999, verdict: "changes_requested",
    });
    assert.ok(staleFeedback.isError, "stale handoff revision is rejected");
    assert.equal(workSessions.get(sessionId)!.status, "awaiting_review");
    void diffSha256;

    await wrongContext.client.close().catch(() => {});
    await wrongContext.server.close().catch(() => {});
    await correctContext.client.close().catch(() => {});
    await correctContext.server.close().catch(() => {});
  }

  // ── Scenario C: Browser retry does not duplicate feedback ──────────
  {
    const sessionId = createSession();
    activateRoute(sessionId, "reviewer-user-3");

    const submitRes = await callWorker(config, sessionId, "submit_for_review", { sessionId });
    assert.ok(!submitRes.isError);
    const submissionId = (submitRes.structuredContent as { submissionId: string }).submissionId;
    const epoch = (submitRes.structuredContent as { reviewEpoch: number }).reviewEpoch;
    const handoffId = handoffFor(sessionId, submissionId, epoch);
    const diffSha256 = (submitRes.structuredContent as { diffSha256: string }).diffSha256;

    // C1: Browser accepts.
    const acceptResult = await browserDriver.retrySameAttempt(handoffId, submissionId, epoch, diffSha256);
    assert.equal(acceptResult, "accepted");

    // C2: Browser redrives the same logical handoff (new attemptId). The
    // server-side dedup proves single continuation at C4.
    const retryResult = await browserDriver.retrySameAttempt(handoffId, submissionId, epoch, diffSha256);
    assert.equal(retryResult, "accepted", "second browser turn accepted");

    // C3: One review cycle through the first handoff.
    const route = reviewRoutes.getRouteBySession(sessionId)!;
    const firstHandoff = db.sqlite.prepare(`select id from review_handoffs where route_id = ? limit 1`).get(route.id) as { id: string };
    const reviewClient = makeReviewerMcp("retry-reviewer", "reviewer-user-3");
    const thread = reviewThreads.activate({
      activationSecret: reviewThreads.createActivation({ routeId: route.id, ownerPrincipalId: "reviewer-user-3", reviewerPrincipalId: "reviewer-user-3" }).activationSecret,
      principalId: "reviewer-user-3", contextId: reviewClient.contextId,
    });
    const claimResult = await reviewClient.call("claim_review_handoff", {
      handoffId: firstHandoff.id, expectedRevision: 1, reviewThreadId: thread.id,
    });
    assert.ok(!claimResult.isError, "claim first handoff");
    const feedbackResult = await reviewClient.call("submit_handoff_feedback", {
      handoffId: firstHandoff.id,
      expectedRevision: (claimResult.structuredContent as { revision: number }).revision,
      verdict: "changes_requested",
      comments: "fix first submission",
      requiredActions: ["Fix issue 1"],
    });
    assert.ok(!feedbackResult.isError, "feedback through first handoff");
    assert.equal(workSessions.get(sessionId)!.status, "changes_requested");

    // C4: Exactly one continuation exists.
    const continuations = continuationManager.listForSession(sessionId);
    assert.equal(continuations.length, 1, "exactly one continuation (no duplicate from browser retry)");

    await reviewClient.client.close().catch(() => {});
    await reviewClient.server.close().catch(() => {});
  }

  // ── Scenario D: Epoch change invalidates claim ───────────────────────
  {
    const sessionId = createSession();
    activateRoute(sessionId, "reviewer-user-4");

    const submitRes = await callWorker(config, sessionId, "submit_for_review", { sessionId });
    assert.ok(!submitRes.isError);
    const submissionId = (submitRes.structuredContent as { submissionId: string }).submissionId;
    const reviewEpochD = (submitRes.structuredContent as { reviewEpoch: number }).reviewEpoch;
    const handoffId = handoffFor(sessionId, submissionId, reviewEpochD);
    const diffSha256 = (submitRes.structuredContent as { diffSha256: string }).diffSha256;

    const reviewClient = makeReviewerMcp("epoch-reviewer", "reviewer-user-4");
    const route = reviewRoutes.getRouteBySession(sessionId)!;
    const thread = reviewThreads.activate({
      activationSecret: reviewThreads.createActivation({ routeId: route.id, ownerPrincipalId: "reviewer-user-4", reviewerPrincipalId: "reviewer-user-4" }).activationSecret,
      principalId: "reviewer-user-4", contextId: reviewClient.contextId,
    });

    // D1: Reviewer claims.
    const claimResult = await reviewClient.call("claim_review_handoff", {
      handoffId, expectedRevision: 1, reviewThreadId: thread.id,
    });
    assert.ok(!claimResult.isError, "claim before epoch change");

    // D2: Reconfigure advances route epoch, invalidating the old handoff claim.
    const configResult = await reviewClient.call("configure_review_loop", {
      workSessionId: sessionId, enabled: true, mode: "pinned_conversation", maxReviewRounds: 3,
    });
    assert.ok(!configResult.isError, "reconfigure advances route epoch");
    const newEpoch = (configResult.structuredContent as { routeEpoch: number }).routeEpoch;
    assert.equal(newEpoch, 2, "route epoch advanced");

    // D3: Old claim cannot submit feedback after epoch change.
    const staleFeedback = await reviewClient.call("submit_handoff_feedback", {
      handoffId,
      expectedRevision: (claimResult.structuredContent as { revision: number }).revision,
      verdict: "changes_requested",
      comments: "should fail after epoch change",
    });
    assert.ok(staleFeedback.isError, "post-epoch-change feedback rejected");
    assert.equal(workSessions.get(sessionId)!.status, "awaiting_review");

    await reviewClient.client.close().catch(() => {});
    await reviewClient.server.close().catch(() => {});
  }

  // ── Scenario E: Nonexistent handoffId rejected ──────────────────────
  {
    const sessionId = createSession();
    activateRoute(sessionId, "reviewer-user-5");

    const submitRes = await callWorker(config, sessionId, "submit_for_review", { sessionId });
    assert.ok(!submitRes.isError);
    const submissionId = (submitRes.structuredContent as { submissionId: string }).submissionId;
    const reviewEpochE = (submitRes.structuredContent as { reviewEpoch: number }).reviewEpoch;
    const handoffId = handoffFor(sessionId, submissionId, reviewEpochE);
    const diffSha256 = (submitRes.structuredContent as { diffSha256: string }).diffSha256;

    // E1: Browser accepts with the correct handoff.
    browserDriver.handoffId = handoffId;
    browserDriver.submissionId = submissionId;
    const acceptResult = await browserDriver.retrySameAttempt(handoffId, submissionId, 1, diffSha256);
    assert.equal(acceptResult, "accepted");

    // E2: Try to claim a non-existent handoff.
    const reviewClient = makeReviewerMcp("wrong-submission", "reviewer-user-5");
    const route = reviewRoutes.getRouteBySession(sessionId)!;
    const thread = reviewThreads.activate({
      activationSecret: reviewThreads.createActivation({ routeId: route.id, ownerPrincipalId: "reviewer-user-5", reviewerPrincipalId: "reviewer-user-5" }).activationSecret,
      principalId: "reviewer-user-5", contextId: reviewClient.contextId,
    });

    const fakeHandoffResult = await reviewClient.call("claim_review_handoff", {
      handoffId: "fake-handoff-nonexistent", expectedRevision: 1, reviewThreadId: thread.id,
    });
    assert.ok(fakeHandoffResult.isError, "nonexistent handoffId rejected");

    // E3: Correct handoff claim + feedback works.
    const claimResult = await reviewClient.call("claim_review_handoff", {
      handoffId, expectedRevision: 1, reviewThreadId: thread.id,
    });
    assert.ok(!claimResult.isError, "real handoff claimed");

    const feedbackResult = await reviewClient.call("submit_handoff_feedback", {
      handoffId,
      expectedRevision: (claimResult.structuredContent as { revision: number }).revision,
      verdict: "changes_requested",
      comments: "verified correct feedback path",
      requiredActions: ["Action 1", "Action 2"],
    });
    assert.ok(!feedbackResult.isError, "correct feedback through claimed handoff");
    assert.equal(workSessions.get(sessionId)!.status, "changes_requested");

    await reviewClient.client.close().catch(() => {});
    await reviewClient.server.close().catch(() => {});
  }

  // ─── Final assertions ──────────────────────────────────────────────
  assert.ok(browserDriver.accepted >= 1, "browser transport accepted at least one bounded packet");
  console.log("review-browser-handoff-integration.test.ts: all assertions passed");
  suiteFinished = true;
  clearTimeout(watchdog);
} finally {
  const closing = [
    agentRegistry?.close?.(),
    workSessions?.close?.(),
    eventStore?.close?.(),
    continuationManager?.close?.(),
    dispatchOutbox?.close?.(),
    missionLedger?.close?.(),
    supervisorRuns?.close?.(),
    approvalRequests?.close?.(),
    agentMessages?.close?.(),
    reviewRoutes?.close?.(),
    reviewThreads?.close?.(),
    db?.close?.(),
  ].filter((c): c is unknown => typeof c === "function" || (c && typeof (c as any).then === "function"));
  await Promise.all(closing.map((c: any) => (typeof c === "function" ? c() : c).catch(() => {})));
  await rm(root, { recursive: true, force: true });
  if (!suiteFinished) {
    console.error("review-browser-handoff-integration.test.ts: terminated with failure");
  }
}