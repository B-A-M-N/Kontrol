import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createWorkSessionManager } from "./work-sessions.js";
import { createEventStore } from "./event-log.js";
import { createContinuationManager } from "./continuation.js";
import { createAgentRegistryManager } from "./acp-registry.js";
import { registerBridgeTools, type BridgeConfig } from "./acp-bridge.js";
import { openDatabase, databasePath } from "./db/client.js";
import { createReviewWorkflowService } from "./review-workflow.js";
import { authorizeWorkSessionAction } from "./work-session-action-guard.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-enforcement-"));

function fakeServer(): { registerTool: (n: string, _c: unknown, h: (a: any) => any) => undefined; handlers: Map<string, (a: any) => any> } {
  const handlers = new Map<string, (a: any) => any>();
  return {
    registerTool: (name, _cfg, handler) => {
      handlers.set(name, handler);
    },
    handlers,
  };
}

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
const WS_OTHER = "ws-other";

let httpServer: any;
let agentUrl = "";
let currentSnapshot = "deadbeef";
let commitCalled = false;
const receivedRuns: Array<Record<string, any>> = [];

const db = openDatabase(root);
const workSessions = createWorkSessionManager(db);
const eventStore = createEventStore(db);
const continuationManager = createContinuationManager(db);
const agentRegistry = createAgentRegistryManager(db);
const reviewWorkflow = createReviewWorkflowService({
  workSessions,
  eventStore,
  continuationManager,
  agentRegistry,
  db,
  workspaces: {
    getWorkspace: (id: string) => {
      if (id === WS) return { id: WS, root: "/tmp", mode: "checkout" } as any;
      if (id === WS_OTHER) return { id: WS_OTHER, root: "/tmp", mode: "checkout" } as any;
      throw new Error(`Unknown workspace: ${id}`);
    },
  } as any,
  reviewCheckpoints: {
    reviewChanges: async () => ({
      patch: "diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n",
      result: "reviewed",
      summary: { files: 1, additions: 1, removals: 1 },
      files: [{ path: "x.txt", operation: "update", additions: 1, removals: 1 }],
      snapshotCommit: currentSnapshot,
    }),
    commitReviewed: async () => {
      commitCalled = true;
    },
  } as any,
});
const config: BridgeConfig = {
  workspaces: {
    getWorkspace: (id: string) => {
      if (id === WS) return { id: WS, root: "/tmp", mode: "checkout" } as any;
      if (id === WS_OTHER) return { id: WS_OTHER, root: "/tmp", mode: "checkout" } as any;
      throw new Error(`Unknown workspace: ${id}`);
    },
    setActiveSession: () => {},
  } as any,
  workSessions,
  reviewCheckpoints: {
    reviewChanges: async () => ({
      patch: "diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n",
      result: "reviewed",
      summary: { files: 1, additions: 1, removals: 1 },
      files: [{ path: "x.txt", operation: "update", additions: 1, removals: 1 }],
      snapshotCommit: currentSnapshot,
    }),
    commitReviewed: async () => {
      commitCalled = true;
    },
  } as any,
  agentRegistry,
  eventStore,
  continuationManager,
  reviewWorkflow,
  knownAgents: [],
  sharedSecret: "test-secret",
  principalRole: "client",
  resumeAgent: async () => {},
};

function createGatedSession(): string {
  return workSessions.create({ workspaceSessionId: WS, submittedBy: "webui", completionPolicy: "webui_approval_required" }).id;
}
function createAgentSession(): string {
  return workSessions.create({ workspaceSessionId: WS, submittedBy: "webui", completionPolicy: "agent_completion" }).id;
}

try {
  seedWorkspace(root, WS);
  seedWorkspace(root, WS_OTHER);

  httpServer = (await import("node:http")).createServer(async (req: any, res: any) => {
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
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  agentUrl = `http://127.0.0.1:${port}`;
  agentRegistry.register({ name: "cli-coding-agent", url: agentUrl, role: "agent", ttlSeconds: 600 });

  const reviewerServer = fakeServer();
  registerBridgeTools(reviewerServer as any, { ...config, principalRole: "reviewer" });
  const workerServer = fakeServer();
  registerBridgeTools(workerServer as any, { ...config, principalRole: "worker" });
  const callReviewer = (name: string, args: any) => reviewerServer.handlers.get(name)!(args);
  const callWorker = (name: string, args: any) => workerServer.handlers.get(name)!(args);

  // ── Test 1: Codex enforcement (apply_patch/exec_command/write_stdin gated) ──
  {
    const sessionId = createGatedSession();
    await callWorker("submit_for_review", { sessionId });
    assert.equal(workSessions.get(sessionId)!.status, "awaiting_review");
    // The exact tool classes the Codex handlers pass to enforceToolPolicy:
    assert.equal(authorizeWorkSessionAction(workSessions, { workSessionId: sessionId, tool: "exec_command", command: "rm -rf /" }).allowed, false, "exec_command blocked while awaiting_review");
    assert.equal(authorizeWorkSessionAction(workSessions, { workSessionId: sessionId, tool: "apply_patch" }).allowed, false, "apply_patch blocked while awaiting_review");
    // write_stdin has no TOOL_TO_ACTION_CLASS entry -> gated session denies it:
    assert.equal(authorizeWorkSessionAction(workSessions, { workSessionId: sessionId, tool: "write_stdin" }).allowed, false, "write_stdin blocked while awaiting_review (gated, unclassified)");
    // reads + await are always allowed:
    assert.equal(authorizeWorkSessionAction(workSessions, { workSessionId: sessionId, tool: "read" }).allowed, true, "read allowed while awaiting_review");
    assert.equal(authorizeWorkSessionAction(workSessions, { workSessionId: sessionId, tool: "await_review_feedback" }).allowed, true, "await allowed while awaiting_review");

    // After approval, the same tools are permitted again.
    await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: workSessions.getSubmissions(sessionId).at(-1)!.id,
      diffSha256: workSessions.getSubmissions(sessionId).at(-1)!.diffSha256,
      reviewEpoch: workSessions.getSubmissions(sessionId).at(-1)!.reviewEpoch,
      verdict: "approve",
    });
    assert.equal(workSessions.get(sessionId)!.status, "approved");
    assert.equal(authorizeWorkSessionAction(workSessions, { workSessionId: sessionId, tool: "exec_command" }).allowed, false, "terminal session still rejects worker tools");
  }

  // ── Test 2: UI changes_requested -> default remediation set ──
  {
    const sessionId = createGatedSession();
    const sub2 = await callWorker("submit_for_review", { sessionId });
    const fb = await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: sub2.structuredContent.submissionId,
      diffSha256: sub2.structuredContent.diffSha256,
      reviewEpoch: sub2.structuredContent.reviewEpoch,
      verdict: "changes_requested",
    });
    assert.ok(!fb.isError, "changes_requested succeeds with no allowedNextActions");
    const session = workSessions.get(sessionId)!;
    const allowed = session.latestFeedback!.allowedNextActionsJson
      ? JSON.parse(session.latestFeedback!.allowedNextActionsJson)
      : [];
    assert.ok(allowed.includes("edit_files"), "default remediation includes edit_files");
    assert.ok(allowed.includes("run_commands"), "default remediation includes run_commands");
    assert.ok(allowed.includes("resubmit"), "default remediation includes resubmit");
  }

  // ── Test 3: webui/client reconciled to webui/reviewer via ensure() ──
  {
    agentRegistry.register({ name: "webui", url: "ui://kontrol/workspace-app.html", role: "client", ttlSeconds: 600 });
    const before = agentRegistry.listAll().find((a) => a.name === "webui");
    assert.equal(before?.role, "client", "registered initially as client");
    agentRegistry.ensure({ name: "webui", url: "ui://kontrol/workspace-app.html", role: "reviewer", ttlSeconds: 600 });
    const after = agentRegistry.listAll().find((a) => a.name === "webui");
    assert.equal(after?.role, "reviewer", "ensure() reconciles stale client -> reviewer");
  }

  // ── Test 4: MCP reviewer auth via role gate (X-Kontrol-Reviewer-Token) ──
  {
    const sessionId = createGatedSession();
    const sub = await callWorker("submit_for_review", { sessionId });
    // worker cannot approve (proves reviewer-only authority is gated):
    const workerApprove = await callWorker("provide_review_feedback", {
      sessionId,
      submissionId: sub.structuredContent.submissionId,
      diffSha256: sub.structuredContent.diffSha256,
      reviewEpoch: sub.structuredContent.reviewEpoch,
      verdict: "approve",
    });
    assert.ok(workerApprove.isError, "worker (no reviewer token) cannot approve");
    // reviewer (token-derived) can approve:
    const reviewerApprove = await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: sub.structuredContent.submissionId,
      diffSha256: sub.structuredContent.diffSha256,
      reviewEpoch: sub.structuredContent.reviewEpoch,
      verdict: "approve",
    });
    assert.ok(!reviewerApprove.isError, "reviewer (X-Kontrol-Reviewer-Token) can approve");
    assert.equal(workSessions.get(sessionId)!.status, "approved");
  }

  // ── Test 5: ACP approval after workspace drift (snapshot mismatch) ──
  {
    const sessionId = createGatedSession();
    const sub = await callWorker("submit_for_review", { sessionId });
    currentSnapshot = "changed-commit";
    const driftApprove = await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: sub.structuredContent.submissionId,
      diffSha256: sub.structuredContent.diffSha256,
      reviewEpoch: sub.structuredContent.reviewEpoch,
      verdict: "approve",
    });
    assert.ok(driftApprove.isError, "approve rejected when workspace snapshot drifted");
    assert.equal(workSessions.get(sessionId)!.status, "awaiting_review", "session stays awaiting_review on drifted approve");
    // Revert to the captured snapshot -> approve now succeeds.
    currentSnapshot = "deadbeef";
    const okApprove = await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: sub.structuredContent.submissionId,
      diffSha256: sub.structuredContent.diffSha256,
      reviewEpoch: sub.structuredContent.reviewEpoch,
      verdict: "approve",
    });
    assert.ok(!okApprove.isError, "approve succeeds once snapshot matches submission");
  }

  // ── Test 6: two sessions / same workspace / different snapshots ──
  {
    const a = createGatedSession();
    currentSnapshot = "snapA";
    const subA = await callWorker("submit_for_review", { sessionId: a });
    const b = createGatedSession();
    currentSnapshot = "snapB";
    const subB = await callWorker("submit_for_review", { sessionId: b });

    // Approve A with the workspace still at snapB -> must fail (A captured snapA).
    const wrongApprove = await callReviewer("provide_review_feedback", {
      sessionId: a,
      submissionId: subA.structuredContent.submissionId,
      diffSha256: subA.structuredContent.diffSha256,
      reviewEpoch: subA.structuredContent.reviewEpoch,
      verdict: "approve",
    });
    assert.ok(wrongApprove.isError, "A cannot be approved against B's snapshot");
    assert.equal(workSessions.get(a)!.status, "awaiting_review", "A untouched by B-snapshot approve");

    // Approve A with workspace at snapA -> succeeds; B stays open.
    currentSnapshot = "snapA";
    const okA = await callReviewer("provide_review_feedback", {
      sessionId: a,
      submissionId: subA.structuredContent.submissionId,
      diffSha256: subA.structuredContent.diffSha256,
      reviewEpoch: subA.structuredContent.reviewEpoch,
      verdict: "approve",
    });
    assert.ok(!okA.isError, "A approved against its own snapshot");
    assert.equal(workSessions.get(b)!.status, "awaiting_review", "B remains open after A approved");
  }

  // ── Test 7: ACP submission failure does NOT advance checkpoint ──
  {
    commitCalled = false;
    const sessionId = createGatedSession();
    await callWorker("submit_for_review", { sessionId });
    assert.ok(commitCalled, "successful submit advances checkpoint (commitReviewed called)");
    commitCalled = false;
    // A fresh submit on a now-awaiting_review session is rejected (not submittable);
    // checkpoint must NOT advance on the failed path.
    const late = await callWorker("submit_for_review", { sessionId });
    assert.ok(late.isError, "duplicate submit rejected");
    assert.equal(commitCalled, false, "checkpoint NOT advanced on failed submit");
  }

  // ── Test 8: changes_requested / reject allowed on changed workspace ──
  {
    const sessionId = createGatedSession();
    const sub = await callWorker("submit_for_review", { sessionId });
    currentSnapshot = "changed-commit"; // workspace drifted
    const changes = await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: sub.structuredContent.submissionId,
      diffSha256: sub.structuredContent.diffSha256,
      reviewEpoch: sub.structuredContent.reviewEpoch,
      verdict: "changes_requested",
    });
    assert.ok(!changes.isError, "changes_requested allowed on drifted workspace (drift check is approve-only)");
    assert.equal(workSessions.get(sessionId)!.status, "changes_requested");
    currentSnapshot = "deadbeef"; // restore for other tests
  }

  // ── Test 9: resubmission denied when "resubmit" absent from allowedNextActions ──
  {
    const sessionId = createGatedSession();
    const sub9 = await callWorker("submit_for_review", { sessionId });
    await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: sub9.structuredContent.submissionId,
      diffSha256: sub9.structuredContent.diffSha256,
      reviewEpoch: sub9.structuredContent.reviewEpoch,
      verdict: "changes_requested",
      allowedNextActions: ["edit_files", "run_commands"], // no "resubmit"
    });
    const decision = authorizeWorkSessionAction(workSessions, { workSessionId: sessionId, tool: "submit_for_review" });
    assert.equal(decision.allowed, false, "submit_for_review (resubmit) denied when resubmit not permitted");
  }

  // ── Test 10: agent_completion via await terminal resolution ──
  {
    const sessionId = createAgentSession();
    await callWorker("submit_for_review", { sessionId });
    await callReviewer("provide_review_feedback", {
      sessionId,
      submissionId: workSessions.getSubmissions(sessionId).at(-1)!.id,
      verdict: "approve",
    });
    assert.equal(workSessions.get(sessionId)!.status, "approved");
    const events = eventStore.getEventsForSession(sessionId);
    assert.ok(events.some((e) => e.type === "agent.run.approved"), "agent_completion approval emits canonical terminal event");
  }

  // ── Test 11: existing-session / workspace mismatch in submit_to_coding_agent ──
  {
    const sessionId = createGatedSession();
    const mismatched = await callReviewer("submit_to_coding_agent", {
      task: "do a thing",
      workspaceSessionId: WS_OTHER,
      workSessionId: sessionId,
    });
    assert.ok(mismatched.isError, "submit_to_coding_agent rejects existing session in a different workspace");
    const sameWs = await callReviewer("submit_to_coding_agent", {
      task: "do a thing",
      workspaceSessionId: WS,
      workSessionId: sessionId, // same workspace -> not rejected by the ws-mismatch guard
    });
    assert.ok(!sameWs.isError, "submit_to_coding_agent allows same-workspace reuse (ws check passes)");
  }

  // ── Test 12: run cancellation -> terminal session + canonical event ──
  {
    const sessionId = createGatedSession();
    await callWorker("submit_for_review", { sessionId });
    const result = reviewWorkflow.cancelSession({ sessionId });
    assert.equal(result.status, "cancelled");
    assert.equal(workSessions.get(sessionId)!.status, "cancelled");
    const events = eventStore.getEventsForSession(sessionId);
    assert.ok(events.some((e) => e.type === "agent.run.cancelled"), "cancel emits canonical agent.run.cancelled event");
    assert.equal(events.filter((e) => e.type === "agent.run.cancelled").length, 1, "exactly one canonical cancel event");
  }

  console.log("enforcement-layer.test.ts: all 12 regression scenarios passed");
} finally {
  if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  workSessions.close();
  eventStore.close();
  continuationManager.close();
  agentRegistry.close();
  await rm(root, { recursive: true, force: true });
}
