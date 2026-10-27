import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { openDatabase } from "../db/client.js";
import { createReviewRouteStore } from "../review-handoff/route-store.js";
import { createReviewThreadStore } from "./thread-store.js";
import { createReviewPacket } from "./review-packet.js";
import { createReviewerJobStore } from "./reviewer-job-store.js";
import { createAgentMessageManager } from "../agent-messages.js";
import { reviewThreads as reviewThreadsTable } from "../db/schema.js";

const oversizedText = "🌲".repeat(20_000);
const boundedPacket = createReviewPacket({
  session: { id: "session-large", title: oversizedText } as any,
  submission: {
    id: "submission-large", submissionNumber: 1, reviewEpoch: 1, status: "pending",
    summaryJson: JSON.stringify({ summary: oversizedText }), message: oversizedText,
    diffSha256: "a".repeat(64), snapshotKind: "git", snapshotRef: oversizedText,
    files: Array.from({ length: 100 }, () => ({ path: oversizedText, additions: 1, removals: 1 })),
    coverage: { backend: "git", uncoveredPaths: Array(100).fill(oversizedText), reasons: Array(100).fill(oversizedText) },
  } as any,
  roundNumber: 1,
  objective: oversizedText,
  mission: {
    mission: { objective: oversizedText },
    criteria: Array.from({ length: 100 }, () => ({ id: oversizedText, description: oversizedText, verificationType: oversizedText })),
    evidence: Array.from({ length: 100 }, () => ({ type: oversizedText, source: oversizedText, summary: oversizedText })),
    findings: Array.from({ length: 100 }, () => ({ severity: oversizedText, description: oversizedText, requiredAction: oversizedText })),
  },
  priorFeedback: Array.from({ length: 100 }, () => ({ submissionId: oversizedText, verdict: oversizedText, comments: oversizedText, requiredActions: [oversizedText], createdAt: oversizedText })),
});
assert.ok(Buffer.byteLength(JSON.stringify(boundedPacket), "utf8") <= 32 * 1024, "review packet stays within the host-message byte budget");
assert.equal(boundedPacket.truncated, true, "the packet marks omitted content explicitly");

const root = await mkdtemp(join(tmpdir(), "kontrol-review-thread-test-"));
try {
  const db = openDatabase(root);
  db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-thread");
  db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values (?, 'ws-thread', 'owner', 'in_progress', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("session-thread");
  const routes = createReviewRouteStore(db);
  const threads = createReviewThreadStore(db);
  const route = routes.configure({
    workSessionId: "session-thread", ownerPrincipalId: "owner", ownerContextId: "owner-context",
    enabled: true, mode: "isolated_review", maxReviewRounds: 3,
    deliveryTransport: "native_cdp", browserProfileId: "profile-thread",
  });
  const makeHandoff = (round: number) => routes.createHandoff({
    routeId: route.id, workSessionId: "session-thread", submissionId: `submission-${round}`,
    reviewEpoch: round, snapshotKind: "git", snapshotRef: `snapshot-${round}`,
    diffSha256: `hash-${round}`, roundNumber: round,
  });

  const first = makeHandoff(1);
  const immutablePacketJson = JSON.stringify({ version: 1, packetSha256: "packet-1", requestedDecision: "review submission-1" });
  routes.setReviewPacket({ handoffId: first.id, payloadJson: immutablePacketJson, payloadSha256: createHash("sha256").update(immutablePacketJson).digest("hex") });
  const changedRetryJson = JSON.stringify({ version: 1, packetSha256: "packet-recomputed", requestedDecision: "changed retry" });
  routes.setReviewPacket({ handoffId: first.id, payloadJson: changedRetryJson, payloadSha256: createHash("sha256").update(changedRetryJson).digest("hex") });
  assert.deepEqual(routes.getReviewPacketByHandoff(first.id), JSON.parse(immutablePacketJson), "retry cannot replace the prepared immutable reviewer packet");
  const pendingThread = threads.getForRoute(route.id, route.routeEpoch)!;
  assert.equal(pendingThread.status, "pending_activation");
  assert.equal(threads.listMessages(pendingThread.id).length, 1);
  // A route status change must not fabricate an active thread binding when none
  // exists: with no reviewer principal/context yet, the thread stays
  // `pending_activation` instead of being promoted to a ready-but-unbound state.
  threads.setRouteStatus(route.id, route.routeEpoch, "active");
  assert.equal(threads.getForRoute(route.id, route.routeEpoch)?.status, "pending_activation",
    "setRouteStatus preserves pending_activation until a real reviewer binding exists");
  threads.setRouteStatus(route.id, route.routeEpoch, "paused");
  assert.equal(threads.getForRoute(route.id, route.routeEpoch)?.status, "pending_activation",
    "pausing an unbound thread also leaves it pending_activation");

  const activation = threads.createActivation({ routeId: route.id, ownerPrincipalId: "owner", reviewerPrincipalId: "reviewer" });
  const storedGrant = db.sqlite.prepare("select activation_secret_sha256 from review_thread_activations where thread_id = ?").get(pendingThread.id) as { activation_secret_sha256: string };
  assert.notEqual(storedGrant.activation_secret_sha256, activation.activationSecret, "only the activation-secret hash is persisted");
  assert.throws(() => threads.activate({ activationSecret: activation.activationSecret, principalId: "impostor", contextId: "review-context" }), /invalid|expired|consumed/i);
  const activeThread = threads.activate({
    activationSecret: activation.activationSecret, principalId: "reviewer", contextId: "fresh-review-context",
    hostKind: "chatgpt", hostConversationId: "operator-supplied-chat-id",
  });
  assert.equal(activeThread.id, pendingThread.id);
  assert.equal(activeThread.status, "active");
  assert.equal(activeThread.hostBindingVerified, false);
  assert.throws(() => threads.activate({ activationSecret: activation.activationSecret, principalId: "reviewer", contextId: "fresh-review-context" }), /invalid|expired|consumed/i);

  // A worker clarification wakes the route-bound WebUI conversation as an
  // advisory message, and only the durable agent reply settles that browser turn.
  db.db.update(reviewThreadsTable).set({
    browserProfileId: "profile-thread", browserGeneration: 7, browserTargetId: "tab-thread",
    browserCdpSessionId: "cdp-thread", conversationUrl: "https://chatgpt.com/c/conversation_thread1",
    conversationKey: "conversation_thread1", conversationFingerprint: "f".repeat(64),
    conversationBindingRevision: 1, conversationBindingStatus: "bound", conversationBindingAssurance: "browser_observed",
  }).where(eq(reviewThreadsTable.id, activeThread.id)).run();
  const agentMessages = createAgentMessageManager(db);
  const question = agentMessages.post({ workSessionId: "session-thread", kind: "clarification_request", title: "Choose target", body: "Should the change target staging or production?" });
  const queuedQuestion = threads.queueAgentMessage({
    threadId: activeThread.id, agentMessageId: question.id, kind: "clarification_request", title: question.title, body: question.body,
  })!;
  assert.equal(queuedQuestion.kind, "agent_message");
  assert.equal(threads.queueAgentMessage({ threadId: activeThread.id, agentMessageId: question.id, kind: "clarification_request" })?.id, queuedQuestion.id,
    "repeated wake creation reuses the same immutable browser message");
  const browserJobs = createReviewerJobStore(db);
  const consultation = browserJobs.claim({ messageId: queuedQuestion.id, profileId: "profile-thread", browserGeneration: 7 });
  assert.ok(consultation);
  assert.match(consultation.prompt, /kontrol\.webui-agent-message\.v1/);
  assert.match(consultation.prompt, new RegExp(question.id));
  browserJobs.transition({ attemptId: consultation.attemptId, leaseToken: consultation.leaseToken, profileId: "profile-thread", browserGeneration: 7, nextStatus: "browser_ready" });
  browserJobs.transition({ attemptId: consultation.attemptId, leaseToken: consultation.leaseToken, profileId: "profile-thread", browserGeneration: 7, nextStatus: "dispatching" });
  browserJobs.transition({ attemptId: consultation.attemptId, leaseToken: consultation.leaseToken, profileId: "profile-thread", browserGeneration: 7, nextStatus: "prompt_accepted" });
  const acceptedReply = agentMessages.acceptReply({ messageId: question.id, workSessionId: "session-thread", body: "Use staging.", reviewerPrincipalId: "reviewer" });
  assert.equal(acceptedReply.created, true);
  browserJobs.settleForAgentMessage({ agentMessageId: question.id, routeEpoch: route.routeEpoch });
  assert.equal(browserJobs.getActiveForThread(activeThread.id), undefined, "accepted reviewer reply settles the browser wake without a verdict");
  assert.equal(threads.listMessages(activeThread.id).find((message) => message.id === queuedQuestion.id)?.status, "settled");

  const preDispatchQuestion = agentMessages.post({ workSessionId: "session-thread", kind: "clarification_request", title: "Pre-dispatch recovery", body: "Recover safely." });
  const preDispatchMessage = threads.queueAgentMessage({ threadId: activeThread.id, agentMessageId: preDispatchQuestion.id, kind: "clarification_request", title: preDispatchQuestion.title, body: preDispatchQuestion.body })!;
  const preDispatchClaim = browserJobs.claim({ messageId: preDispatchMessage.id, profileId: "profile-thread", browserGeneration: 7 })!;
  assert.equal(preDispatchClaim.bindingRevision, 1, "the durable browser claim captures the selected conversation-binding revision");
  db.db.update(reviewThreadsTable).set({ conversationBindingRevision: 2, revision: activeThread.revision + 1 })
    .where(eq(reviewThreadsTable.id, activeThread.id)).run();
  assert.throws(() => browserJobs.transition({
    attemptId: preDispatchClaim.attemptId, leaseToken: preDispatchClaim.leaseToken,
    profileId: "profile-thread", browserGeneration: 7, nextStatus: "browser_ready",
  }), /binding revision/i, "an old queued turn is fenced after the same conversation is rebound at a new revision");
  db.sqlite.prepare("update review_browser_turns set lease_expires_at = ? where id = ?").run("2000-01-01T00:00:00.000Z", preDispatchClaim.attemptId);
  const safeRecovery = browserJobs.reconcileExpiredAttempts({ now: new Date().toISOString(), limit: 100 });
  assert.equal(safeRecovery.reconciled, 1, "an expired attempt before dispatch is safely requeued");
  assert.equal(threads.listMessages(activeThread.id).find((message) => message.id === preDispatchMessage.id)?.status, "queued");
  const observedClaim = browserJobs.claim({ messageId: preDispatchMessage.id, profileId: "profile-thread", browserGeneration: 7 })!;
  assert.equal(observedClaim.bindingRevision, 2, "a fresh attempt binds to the new durable conversation revision");
  for (const nextStatus of ["browser_ready", "dispatching", "prompt_accepted", "model_generating"] as const) {
    browserJobs.transition({ attemptId: observedClaim.attemptId, leaseToken: observedClaim.leaseToken, profileId: "profile-thread", browserGeneration: 7, nextStatus });
  }
  const generatingAttempt = browserJobs.getActiveForThread(activeThread.id)!;
  assert.ok(generatingAttempt.generationStartedAt, "observed generation start is durably timestamped");
  assert.equal(generatingAttempt.generationStartedObservationId, `${observedClaim.attemptId}:chatgpt-dom:start`);
  browserJobs.transition({ attemptId: observedClaim.attemptId, leaseToken: observedClaim.leaseToken, profileId: "profile-thread", browserGeneration: 7, nextStatus: "generation_finished" });
  db.sqlite.prepare("update review_browser_turns set lease_expires_at = ? where id = ?").run("2000-01-01T00:00:00.000Z", observedClaim.attemptId);
  const finishedRecovery = browserJobs.reconcileExpiredAttempts({ now: new Date().toISOString(), limit: 100 });
  assert.equal(finishedRecovery.reconciled, 1,
    "a restart after the durable generation-finished observation advances without another browser send");
  const finishedAttempt = browserJobs.getActiveForThread(activeThread.id)!;
  assert.equal(finishedAttempt.status, "awaiting_feedback");
  assert.ok(finishedAttempt.generationFinishedAt, "observed generation finish is durably timestamped");
  assert.equal(finishedAttempt.generationFinishedObservationId, `${observedClaim.attemptId}:chatgpt-dom:finish`);
  agentMessages.acceptReply({ messageId: preDispatchQuestion.id, workSessionId: "session-thread", body: "Proceed.", reviewerPrincipalId: "reviewer" });
  browserJobs.settleForAgentMessage({ agentMessageId: preDispatchQuestion.id, routeEpoch: route.routeEpoch });

  const postBoundaryQuestion = agentMessages.post({ workSessionId: "session-thread", kind: "clarification_request", title: "Post-boundary recovery", body: "Do not resend." });
  const postBoundaryMessage = threads.queueAgentMessage({ threadId: activeThread.id, agentMessageId: postBoundaryQuestion.id, kind: "clarification_request", title: postBoundaryQuestion.title, body: postBoundaryQuestion.body })!;
  const postBoundaryClaim = browserJobs.claim({ messageId: postBoundaryMessage.id, profileId: "profile-thread", browserGeneration: 7 })!;
  browserJobs.transition({ attemptId: postBoundaryClaim.attemptId, leaseToken: postBoundaryClaim.leaseToken, profileId: "profile-thread", browserGeneration: 7, nextStatus: "browser_ready" });
  browserJobs.transition({ attemptId: postBoundaryClaim.attemptId, leaseToken: postBoundaryClaim.leaseToken, profileId: "profile-thread", browserGeneration: 7, nextStatus: "dispatching" });
  db.sqlite.prepare("update review_browser_turns set lease_expires_at = ? where id = ?").run("2000-01-01T00:00:00.000Z", postBoundaryClaim.attemptId);
  const uncertainRecovery = browserJobs.reconcileExpiredAttempts({ now: new Date().toISOString(), limit: 100 });
  assert.equal(uncertainRecovery.uncertain, 1, "an expired attempt after the dispatch boundary remains explicitly uncertain");
  assert.equal(browserJobs.getActiveForThread(activeThread.id)?.status, "uncertain", "uncertain delivery retains the thread fence");
  assert.equal(browserJobs.claim({ messageId: postBoundaryMessage.id, profileId: "profile-thread", browserGeneration: 7 }), undefined,
    "an uncertain attempt cannot be cleared by claiming the same message again");
  db.sqlite.prepare("update review_browser_turns set binding_revision = null where id = ?").run(postBoundaryClaim.attemptId);
  const resolution = browserJobs.resolveUncertainAttemptForRetry({
    attemptId: postBoundaryClaim.attemptId, reviewThreadId: activeThread.id, routeEpoch: route.routeEpoch,
    reviewerPrincipalId: "reviewer", confirmPromptAbsent: true,
    inspectionEvidence: "I inspected the bound conversation and confirmed the exact prompt is absent.",
  });
  assert.equal(threads.listMessages(activeThread.id).find((message) => message.id === postBoundaryMessage.id)?.status, "queued",
    "authenticated exact-conversation inspection can recover a legacy uncertain row without a stored binding revision");
  assert.equal(browserJobs.getActiveForThread(activeThread.id), undefined, "operator resolution releases the thread fence transactionally");
  assert.match(resolution.resolutionSha256, /^[a-f0-9]{64}$/);
  const resolutionReceipt = db.sqlite.prepare("select reviewer_principal_id, resolution, evidence_sha256 from review_browser_turn_resolutions where attempt_id = ?")
    .get(postBoundaryClaim.attemptId) as { reviewer_principal_id: string; resolution: string; evidence_sha256: string };
  assert.deepEqual(resolutionReceipt, {
    reviewer_principal_id: "reviewer", resolution: "confirmed_prompt_absent_requeue", evidence_sha256: resolution.resolutionSha256,
  }, "recovery records the reviewer identity and hashes, not the freeform inspection note");
  assert.ok(browserJobs.claim({ messageId: postBoundaryMessage.id, profileId: "profile-thread", browserGeneration: 7 }),
    "a replacement attempt is allowed only after the durable reviewer recovery receipt");

  const claimed = routes.claimHandoff({
    handoffId: first.id, expectedRevision: first.revision, principalId: "reviewer",
    ownerContextId: "fresh-review-context", reviewThreadId: activeThread.id,
  });
  assert.equal(claimed.status, "claimed");
  assert.throws(() => routes.claimHandoff({
    handoffId: first.id, expectedRevision: first.revision, principalId: "reviewer",
    ownerContextId: "other-context", reviewThreadId: activeThread.id,
  }), /context|conflict|lifecycle/i);
  const released = routes.markHandoffStatus({ handoffId: first.id, expectedRevision: claimed.revision, nextStatus: "awaiting_attachment" });
  assert.equal(released.claimedByPrincipalId, undefined);
  assert.equal(released.claimedByOwnerContextId, undefined);
  assert.throws(() => routes.claimHandoff({
    handoffId: first.id, expectedRevision: released.revision, principalId: "reviewer",
    ownerContextId: "old-context", reviewThreadId: activeThread.id,
  }), /context/i);

  const replacementGrant = threads.createActivation({ routeId: route.id, ownerPrincipalId: "owner", reviewerPrincipalId: "replacement-reviewer" });
  const reboundThread = threads.activate({
    activationSecret: replacementGrant.activationSecret,
    principalId: "replacement-reviewer",
    contextId: "replacement-review-context",
  });
  assert.equal(reboundThread.id, activeThread.id, "reviewer replacement preserves the route's persistent thread identity");
  assert.equal(threads.listMessages(activeThread.id).find((message) => message.handoffId === first.id)?.status, "queued",
    "a previously presented pending packet is requeued for the replacement reviewer context");
  assert.throws(() => routes.claimHandoff({
    handoffId: first.id, expectedRevision: released.revision, principalId: "reviewer",
    ownerContextId: "fresh-review-context", reviewThreadId: activeThread.id,
  }), /principal|context|conflict/i, "the prior reviewer loses claim authority after rebinding");
  const replacementClaim = routes.claimHandoff({
    handoffId: first.id, expectedRevision: released.revision, principalId: "replacement-reviewer",
    ownerContextId: "replacement-review-context", reviewThreadId: reboundThread.id,
  });
  const replacementRelease = routes.markHandoffStatus({
    handoffId: first.id, expectedRevision: replacementClaim.revision, nextStatus: "awaiting_attachment",
  });

  for (const round of [2, 3]) {
    const next = makeHandoff(round);
    assert.equal(threads.getForRoute(route.id, route.routeEpoch)?.id, activeThread.id, "resubmissions reuse the persistent thread");
    const message = threads.listMessages(activeThread.id).find((item) => item.handoffId === next.id)!;
    assert.equal(message.roundNumber, round);
    assert.equal(message.kind, "resubmission");
    assert.equal(message.status, "queued", "reading a thread message does not claim that the host received it");
  }
  const beforeDuplicate = routes.getRouteBySession("session-thread")!.admittedReviewRounds;
  assert.equal(makeHandoff(3).id, threads.listMessages(activeThread.id).find((item) => item.submissionId === "submission-3")?.handoffId, "duplicate submission returns the existing handoff identity");
  assert.equal(routes.getRouteBySession("session-thread")!.admittedReviewRounds, beforeDuplicate, "duplicate submissions do not consume rounds");
  assert.throws(() => makeHandoff(4), /round limit/i);
  assert.equal(routes.getRouteBySession("session-thread")!.completedReviewRounds, 0, "creating review packets does not count completed feedback rounds");

  const paused = routes.setStatus({ workSessionId: "session-thread", status: "paused" });
  threads.setRouteStatus(paused.id, paused.routeEpoch, "paused");
  assert.equal(threads.getForRoute(route.id, route.routeEpoch)?.status, "paused");
  assert.ok(threads.listMessages(activeThread.id).every((item) => item.status !== "queued"), "pausing suppresses queued delivery");
  const resumed = routes.setStatus({ workSessionId: "session-thread", status: "active" });
  threads.setRouteStatus(resumed.id, resumed.routeEpoch, "active");
  assert.equal(threads.getForRoute(route.id, route.routeEpoch)?.id, activeThread.id, "pause and resume preserve the thread binding");

  const changedRoute = routes.configure({
    workSessionId: "session-thread", ownerPrincipalId: "owner", ownerContextId: "owner-context",
    enabled: true, mode: "pinned_conversation", maxReviewRounds: 3, expectedRevision: resumed.revision,
  });
  assert.equal(changedRoute.routeEpoch, route.routeEpoch + 1);
  assert.throws(() => routes.claimHandoff({
    handoffId: first.id, expectedRevision: replacementRelease.revision, principalId: "replacement-reviewer",
    ownerContextId: "replacement-review-context", reviewThreadId: reboundThread.id,
  }), /not claimable|epoch/i);

  // Pending thread state is durable across a database/runtime restart.
  const recoveryRoot = join(root, "restart-recovery");
  const recoveryDb = openDatabase(recoveryRoot);
  recoveryDb.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-recovery");
  recoveryDb.sqlite.prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values (?, 'ws-recovery', 'owner', 'in_progress', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("session-recovery");
  const recoveryRoutes = createReviewRouteStore(recoveryDb);
  const recoveryThreads = createReviewThreadStore(recoveryDb);
  const recoveryRoute = recoveryRoutes.configure({
    workSessionId: "session-recovery", ownerPrincipalId: "owner", ownerContextId: "owner-context",
    enabled: true, mode: "isolated_review", maxReviewRounds: 2,
  });
  const recoveryHandoff = recoveryRoutes.createHandoff({
    routeId: recoveryRoute.id, workSessionId: "session-recovery", submissionId: "submission-recovery",
    reviewEpoch: 1, snapshotKind: "git", snapshotRef: "snapshot-recovery", diffSha256: "hash-recovery", roundNumber: 1,
  });
  const recoveryGrant = recoveryThreads.createActivation({ routeId: recoveryRoute.id, ownerPrincipalId: "owner", reviewerPrincipalId: "reviewer" });
  const recoveryThread = recoveryThreads.activate({ activationSecret: recoveryGrant.activationSecret, principalId: "reviewer", contextId: "review-context-recovery" });
  const recoveryClaim = recoveryRoutes.claimHandoff({
    handoffId: recoveryHandoff.id,
    expectedRevision: recoveryHandoff.revision,
    principalId: "reviewer",
    ownerContextId: "review-context-recovery",
    reviewThreadId: recoveryThread.id,
    claimLeaseMs: 1_000,
  });
  recoveryDb.close();
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  const restartedDb = openDatabase(recoveryRoot);
  const restartedRoutes = createReviewRouteStore(restartedDb);
  const restartedThreads = createReviewThreadStore(restartedDb);
  assert.equal(restartedThreads.getForRoute(recoveryRoute.id, recoveryRoute.routeEpoch)?.id, recoveryThread.id);
  assert.equal(restartedThreads.listMessages(recoveryThread.id).find((item) => item.handoffId === recoveryHandoff.id)?.status, "reviewer_claimed",
    "a crash after claim preserves the exact in-flight review packet");
  const recoveredClaim = restartedRoutes.claimHandoff({
    handoffId: recoveryHandoff.id,
    expectedRevision: recoveryClaim.revision,
    principalId: "reviewer",
    ownerContextId: "review-context-recovery",
    reviewThreadId: recoveryThread.id,
    claimLeaseMs: 10_000,
  });
  assert.equal(recoveredClaim.status, "claimed", "a restarted reviewer can recover the expired durable claim");
  assert.ok(Date.parse(recoveredClaim.claimExpiresAt!) > Date.now(), "restart recovery grants a new bounded claim lease");
  restartedDb.close();
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("review-thread.test.ts: all assertions passed");
