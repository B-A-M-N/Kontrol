import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import express from "express";
import { createWorkSessionManager } from "./work-sessions.js";
import { createEventStore } from "./event-log.js";
import { createContinuationManager } from "./continuation.js";
import { createMissionLedger } from "./mission-ledger.js";
import { createAgentRegistryManager } from "./acp-registry.js";
import { createDispatchOutbox } from "./dispatch-outbox.js";
import { registerBridgeTools, runContinuationTick, type BridgeConfig } from "./acp-bridge.js";
import { createAcpServer } from "./acp-server.js";
import { openDatabase, databasePath } from "./db/client.js";
import { createReviewWorkflowService } from "./review-workflow.js";
import { createApprovalRequestManager } from "./approval-requests.js";
import { createPolicyEngine } from "./policy.js";
import { registerPolicyTools } from "./policy-tools.js";
import { authorizeWorkSessionAction } from "./work-session-action-guard.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-bridge-flow-"));

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
function seedWorkspace(dir: string, id: string): void {
  const db = new Database(databasePath(dir));
  db.pragma("foreign_keys = OFF");
  db.exec(
    `insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) ` +
    `values ('${id}', '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
  );
  db.close();
}

const WS = "ws-test";

let httpServer: Server | undefined;
let acpHttp: import("node:http").Server | undefined;
let agentUrl = "";
let resumeCalls = 0;
const receivedRuns: Array<Record<string, any>> = [];
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
const missionLedger = createMissionLedger(db);
const approvalRequests = createApprovalRequestManager(db);
const agentRegistry = createAgentRegistryManager(db);

// Hoisted so the workflow service (created below) can share the exact same
// workspaces + reviewCheckpoints the bridge config uses (P0 #4/#5 drift check
// requires them on the service).
const workspaces = {
  getWorkspace: (id: string) => {
    if (id === WS) return { id: WS, root: "/tmp", mode: "checkout" } as any;
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
    }),
  commitReviewed: async () => {},
} as any;

const reviewWorkflow = createReviewWorkflowService({
  workSessions,
  eventStore,
  continuationManager,
  agentRegistry,
  db,
  workspaces,
  reviewCheckpoints,
  dispatchOutbox,
});
const policyEngine = createPolicyEngine({ defaultMode: "allow", toolRules: {}, pathRules: [] });

const config: BridgeConfig = {
  workspaces,
  workSessions,
  reviewCheckpoints,
  agentRegistry,
  eventStore,
  continuationManager,
  dispatchOutbox,
  reviewWorkflow,
  missionLedger,
  knownAgents: [],
  sharedSecret: "test-secret",
  liveWaiters: liveWaiters as any,
  principalRole: "client",
  resumeAgent: async () => {
    resumeCalls++;
  },
};

function createSession(): string {
  return workSessions.create({ workspaceSessionId: WS, submittedBy: "webui" }).id;
}

try {
  seedWorkspace(root, WS);

  // Stand up a tiny healthy ACP agent endpoint so selectHealthyAgent() passes.
  httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/runs") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      receivedRuns.push(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ run_id: `remote-${receivedRuns.length}`, status: "running", output: [] }));
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

  // ACP HTTP server so we can POST real adapter lifecycle events (defect #1/#4).
  const acpApp = express();
  acpApp.use(express.json());
  acpApp.use(
    createAcpServer(
      workspaces,
      workSessions,
      agentRegistry,
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
  const clientServer = fakeServer();
  registerBridgeTools(clientServer as any, { ...config, principalRole: "client" });
  registerPolicyTools(reviewerServer as any, { eventStore, policyEngine, approvalRequests, principalRole: "reviewer" });
  const callWorker = (name: string, args: any) => workerServer.handlers.get(name)!(args);
  const callReviewer = (name: string, args: any) => reviewerServer.handlers.get(name)!(args);
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
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested" });
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
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested" });
    const pending = continuationManager.listForSession(sessionId).find((c) => c.status === "pending");
    assert.ok(pending, "changes_requested creates a pending continuation");

    config.reviewWorkflow.cancelSession({ sessionId, reason: "test cancellation" });
    assert.equal(workSessions.get(sessionId)!.status, "cancelled");
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
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested" });
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
    assert.equal(workSessions.get(sessionId)!.status, "cancelled");
    assert.equal(continuationManager.get(pending.id)?.status, "superseded", "late delivery CAS does not overwrite superseded continuation");
    assert.equal(agentRegistry.getRun(run.runId)?.status, "cancelled", "logical run remains cancelled");
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

  // ── Scenario 2e: dead-lettered outbox rows block automatic backfill until explicit redrive ──
  {
    const sessionId = createSession();
    await callWorker("submit_for_review", { sessionId });
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested" });
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

    await runContinuationTick(config);
    const rowCount = db.sqlite
      .prepare("select count(*) as count from dispatch_outbox where aggregate_id = ?")
      .get(continuation.id) as { count: number };
    assert.equal(rowCount.count, 1, "dead-lettered continuation is not automatically backfilled as a fresh outbox row");

    const redriven = dispatchOutbox.redriveDeadLetter("continuation.ready", continuation.id, continuation.reviewEpoch);
    assert.equal(redriven?.status, "pending", "explicit redrive resets the dead-lettered row");
    assert.equal(redriven?.attemptCount, 0, "explicit redrive resets attempt count");
  }

  // ── Scenario 3: stale feedback is not replayed ──
  {
    const sessionId = createSession();
    await callWorker("submit_for_review", { sessionId });
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested" });
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

    const legacySessionId = workSessions.create({
      workspaceSessionId: WS,
      submittedBy: "webui",
      completionPolicy: "webui_approval_required",
    }).id;
    const legacy = await callReviewer("submit_to_coding_agent", { task: "legacy exposed schema", sessionId: legacySessionId });
    assert.ok(!legacy.isError, "legacy sessionId alias resolves workspace from existing work session");
    assert.equal(legacy.structuredContent.workSessionId, legacySessionId);
    assert.equal(receivedRuns.at(-1)?.workspace_root, "/tmp", "legacy alias dispatch still supplies workspace_root");
    await callReviewer("cancel_work_session", { sessionId: legacySessionId });

    const publicAlias = await callReviewer("submit_to_coding_agent", { task: "public workspace alias", workspaceId: WS });
    assert.ok(!publicAlias.isError, "public workspaceId alias dispatches");
    assert.equal(publicAlias.structuredContent.workspaceSessionId, WS);
    await callReviewer("cancel_work_session", { sessionId: publicAlias.structuredContent.workSessionId });

    const mimo = await callReviewer("submit_to_coding_agent", {
      task: "do a MIMO thing",
      workspaceSessionId: WS,
      agentName: "mimo-code",
    });
    assert.ok(!mimo.isError, "submit_to_coding_agent can target mimo-code");
    assert.equal(agentRegistry.getRun(mimo.structuredContent.runId)!.agentName, "mimo-code");
    assert.equal(receivedRuns.at(-1)?.agent_name, "mimo-code", "initial dispatch uses selected agent name");
    await callReviewer("cancel_work_session", { sessionId: mimo.structuredContent.workSessionId });

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
    const changedWorkspace = await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: submitted.structuredContent.submissionId,
      diffSha256: submitted.structuredContent.diffSha256,
      reviewEpoch: submitted.structuredContent.reviewEpoch,
      verdict: "approve",
    });
    assert.ok(changedWorkspace.isError, "workspace changes after submission cannot be approved");
    currentSnapshot = "deadbeef";

    reviewPatch = "";
    const stale = await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: submitted.structuredContent.submissionId,
      diffSha256: "not-the-submitted-diff",
      reviewEpoch: submitted.structuredContent.reviewEpoch,
      verdict: "approve",
    });
    assert.ok(stale.isError, "stale diff hash cannot be approved");

    const approved = await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: submitted.structuredContent.submissionId,
      diffSha256: submitted.structuredContent.diffSha256,
      reviewEpoch: submitted.structuredContent.reviewEpoch,
      verdict: "approve",
    });
    assert.ok(!approved.isError, "current exact submission can be approved");
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
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested" });

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
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested" });

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
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested" });
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
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested" });
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
    await callReviewer("provide_review_feedback", { sessionId: sessionA, verdict: "changes_requested" });
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
    await callReviewer("provide_review_feedback", { sessionId: sessionB, verdict: "changes_requested" });
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
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested" });
    const r1 = await callWorker("await_review_feedback", { sessionId, timeoutMs: 100 });
    assert.equal(r1.structuredContent.status, "feedback_ready");
    fbIds.push(r1.structuredContent.feedback.id);
    await callWorker("submit_for_review", { sessionId, continuationId: r1.structuredContent.feedback.continuationId });
    // Round 2
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested" });
    const r2 = await callWorker("await_review_feedback", { sessionId, timeoutMs: 100 });
    assert.equal(r2.structuredContent.status, "feedback_ready");
    fbIds.push(r2.structuredContent.feedback.id);
    await callWorker("submit_for_review", { sessionId, continuationId: r2.structuredContent.feedback.continuationId });
    // Round 3 — must return the THIRD feedback, never the first-cycle one.
    await callReviewer("provide_review_feedback", { sessionId, verdict: "changes_requested" });
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
    const sessionId = createSession();
    // Mission with a low ceiling and one required criterion, bound to a real
    // submission so continue_supervised_work has a `latestSubmission` to act on.
    missionLedger.createMission({
      workSessionId: sessionId,
      workspaceSessionId: WS,
      objective: "Add feature Y",
      acceptanceCriteria: [{ id: "y-crit", description: "Feature Y works", priority: "required", verificationType: "test" }],
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
    assert.equal(r2.structuredContent?.status, "ceiling_reached", "non-converging runaway hits the ceiling backstop");
    assert.equal(r2.structuredContent?.extension?.ceilingHit, true);

    // An out-of-scope finding must NOT gate approval on its own.
    const mid = missionLedger.getMissionByWorkSession(sessionId)!;
    missionLedger.addFindings(mid.id, [{ description: "pre-existing lint elsewhere", requiredAction: "n/a", severity: "high", scope: "out_of_scope" }]);
    const approval = missionLedger.canApprove(sessionId);
    assert.ok(!approval.reasons.some((r) => r.includes("pre-existing")), "out_of_scope finding does not block approval");
  }

  console.log("bridge-flow.test.ts: all assertions passed");
} finally {
  if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  if (acpHttp) await new Promise<void>((resolve) => acpHttp!.close(() => resolve()));
  workSessions.close();
  eventStore.close();
  continuationManager.close();
  missionLedger.close();
  approvalRequests.close();
  agentRegistry.close();
  await rm(root, { recursive: true, force: true });
}
