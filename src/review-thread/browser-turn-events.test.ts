import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase } from "../db/client.js";
import { createReviewRouteStore } from "../review-handoff/route-store.js";
import { createReviewThreadStore } from "./thread-store.js";
import { createReviewerJobStore } from "./reviewer-job-store.js";
import { createAgentMessageManager } from "../agent-messages.js";
import { reviewThreads as reviewThreadsTable } from "../db/schema.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-browser-turn-events-"));
const events: Array<{ type: string; sessionId: string; payload: Record<string, unknown> }> = [];
try {
  const db = openDatabase(root);
  db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-events");
  db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values (?, 'ws-events', 'owner', 'in_progress', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("session-events");
  const routes = createReviewRouteStore(db, { onEvent: (type, sessionId, payload) => events.push({ type, sessionId, payload }) });
  const threads = createReviewThreadStore(db);
  const route = routes.configure({
    workSessionId: "session-events", ownerPrincipalId: "owner", ownerContextId: "owner-context",
    enabled: true, mode: "isolated_review", maxReviewRounds: 3,
    deliveryTransport: "native_cdp", browserProfileId: "profile-events",
  });
  const handoff = routes.createHandoff({
    routeId: route.id, workSessionId: "session-events", submissionId: "submission-1",
    reviewEpoch: 1, snapshotKind: "git", snapshotRef: "snapshot-1", diffSha256: "hash-1", roundNumber: 1,
  });
  const pendingThread = threads.getForRoute(route.id, route.routeEpoch)!;
  const activation = threads.createActivation({ routeId: route.id, ownerPrincipalId: "owner", reviewerPrincipalId: "reviewer" });
  const activeThread = threads.activate({ activationSecret: activation.activationSecret, principalId: "reviewer", contextId: "review-context" });
  db.db.update(reviewThreadsTable).set({
    browserProfileId: "profile-events", browserGeneration: 7, conversationUrl: "https://chatgpt.com/c/c1",
    conversationKey: "c1", conversationFingerprint: "f".repeat(64), conversationBindingRevision: 1,
    conversationBindingStatus: "bound", conversationBindingAssurance: "browser_observed",
  }).where(eq(reviewThreadsTable.id, activeThread.id)).run();

  const agentMessages = createAgentMessageManager(db);
  const question = agentMessages.post({ workSessionId: "session-events", kind: "clarification_request", title: "T", body: "B" });
  const queued = threads.queueAgentMessage({ threadId: activeThread.id, agentMessageId: question.id, kind: "clarification_request", title: question.title, body: question.body })!;

  const jobs = createReviewerJobStore(db, { onEvent: (type, sessionId, payload) => events.push({ type, sessionId, payload }) });
  const consultation = jobs.claim({ messageId: queued.id, profileId: "profile-events", browserGeneration: 7 })!;
  jobs.transition({ attemptId: consultation.attemptId, leaseToken: consultation.leaseToken, profileId: "profile-events", browserGeneration: 7, nextStatus: "browser_ready" });
  jobs.transition({ attemptId: consultation.attemptId, leaseToken: consultation.leaseToken, profileId: "profile-events", browserGeneration: 7, nextStatus: "uncertain" });

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["reviewer.browser_turn.leased", "reviewer.browser_turn.transition", "reviewer.browser_turn.transition"]);
  assert.ok(events.every((e) => e.sessionId === "session-events"), "events carry the work-session identity");
  assert.equal(events[1].payload.from, "leased");
  assert.equal(events[1].payload.to, "browser_ready");
  assert.equal(events[2].payload.to, "uncertain", "blocked/uncertain states surface as errors, not silence");

  // Supersede emits its durable event when the route epoch is displaced.
  const before = events.length;
  routes.configure({
    workSessionId: "session-events", ownerPrincipalId: "owner", ownerContextId: "owner-context",
    enabled: true, mode: "isolated_review", maxReviewRounds: 5,
    deliveryTransport: "native_cdp", browserProfileId: "profile-events",
  });
  assert.ok(events.slice(before).some((e) => e.type === "review.handoff.superseded"), "route supersede emits a durable event");
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("browser-turn-events.test.ts: all assertions passed");
