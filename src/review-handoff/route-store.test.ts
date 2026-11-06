import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createReviewRouteStore } from "./route-store.js";
import { createReviewThreadStore } from "../review-thread/thread-store.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-review-route-test-"));

try {
  const db = openDatabase(root);
  db.sqlite
    .prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
    .run("ws-route");
  db.sqlite
    .prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values ('wsess-route', 'ws-route', 'tester', 'in_progress', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
    .run();
  const routes = createReviewRouteStore(db);
  const threads = createReviewThreadStore(db);

  const configured = routes.configure({
    workSessionId: "wsess-route",
    ownerPrincipalId: "user-a",
    ownerContextId: "owner-a",
    enabled: true,
    mode: "isolated_review",
    maxReviewRounds: 2,
  });
  assert.equal(configured.status, "active");
  assert.equal(configured.completedReviewRounds, 0);

  const h1 = routes.createHandoff({
    routeId: configured.id,
    workSessionId: "wsess-route",
    submissionId: "sub-1",
    reviewEpoch: 1,
    snapshotKind: "git",
    snapshotRef: "ref-1",
    diffSha256: "hash-1",
    roundNumber: 1,
  });
  assert.equal(h1.status, "awaiting_attachment");
  const activation = threads.createActivation({ routeId: configured.id, ownerPrincipalId: "user-a", reviewerPrincipalId: "user-b" });
  const activated = threads.activate({ activationSecret: activation.activationSecret, principalId: "user-b", contextId: "review-context-b", hostKind: "chatgpt", hostConversationId: "chat-id-unverified" });
  assert.equal(activated.status, "active");
  assert.equal(activated.hostBindingVerified, false, "host conversation IDs remain correlation metadata");
  const duplicate = routes.createHandoff({
      routeId: configured.id,
      workSessionId: "wsess-route",
      submissionId: "sub-1",
      reviewEpoch: 1,
      snapshotKind: "git",
      snapshotRef: "ref-1",
      diffSha256: "hash-1",
      roundNumber: 2,
    });
  assert.equal(duplicate.id, h1.id, "duplicate handoff delivery reuses the existing message identity");
  assert.equal(routes.getRouteBySession("wsess-route")!.admittedReviewRounds, 1, "duplicate handoff does not consume a review round");

  assert.throws(() => routes.claimHandoff({
    handoffId: h1.id, expectedRevision: h1.revision, principalId: "user-b",
    ownerContextId: "owner-a", reviewThreadId: activated.id,
    destinationConversationId: "invented-destination-is-not-authority",
  }), /context/i, "an owner context or destination ID cannot substitute for the activated reviewer context");
  assert.throws(() => routes.claimHandoff({
    handoffId: h1.id, expectedRevision: h1.revision, principalId: "user-c",
    ownerContextId: "review-context-b", reviewThreadId: activated.id,
  }), /principal/i, "a different principal cannot borrow the activated context");

  const claimed = routes.claimHandoff({
    handoffId: h1.id,
    expectedRevision: 1,
    principalId: "user-b",
    ownerContextId: "review-context-b",
    reviewThreadId: activated.id,
    destinationConversationId: "conv-b",
    claimLeaseMs: 1_000,
  });
  assert.equal(claimed.status, "claimed");
  const renewedClaim = routes.renewHandoffClaim({
    handoffId: h1.id, expectedRevision: claimed.revision, principalId: "user-b",
    ownerContextId: "review-context-b", claimLeaseMs: 1_250,
  });
  assert.equal(renewedClaim.revision, claimed.revision + 1, "renewal uses compare-and-swap revisioning");
  assert.equal(renewedClaim.claimedAt, claimed.claimedAt, "renewal preserves the cumulative lease start");
  assert.ok(Date.parse(renewedClaim.claimExpiresAt!) > Date.parse(claimed.claimExpiresAt!), "renewal extends the same active claim");
  assert.throws(() => routes.renewHandoffClaim({
    handoffId: h1.id, expectedRevision: renewedClaim.revision, principalId: "user-c",
    ownerContextId: "review-context-b",
  }), /different reviewer/i);
  let competing = false;
  try {
    routes.claimHandoff({
      handoffId: h1.id,
      expectedRevision: 1,
      principalId: "user-c",
      ownerContextId: "owner-c",
      reviewThreadId: activated.id,
    });
  } catch {
    competing = true;
  }
  assert.ok(competing, "two conversations cannot claim the same handoff revision");

  db.sqlite.prepare("update review_handoffs set claim_expires_at = ? where id = ?")
    .run("1970-01-01T00:00:00.000Z", h1.id);
  const reclaimedExpiredClaim = routes.claimHandoff({
    handoffId: h1.id, expectedRevision: renewedClaim.revision, principalId: "user-b",
    ownerContextId: "review-context-b", reviewThreadId: activated.id, claimLeaseMs: 10_000,
  });
  assert.equal(reclaimedExpiredClaim.status, "claimed", "an expired crashed-reviewer lease can be reclaimed with a fresh revision");
  assert.ok(Date.parse(reclaimedExpiredClaim.claimExpiresAt!) > Date.now(), "the replacement claim has a live bounded lease");
  const released = routes.markHandoffStatus({ handoffId: h1.id, expectedRevision: reclaimedExpiredClaim.revision, nextStatus: "awaiting_attachment" });
  assert.equal(released.claimedByPrincipalId, undefined, "release invalidates the old principal claim");
  assert.equal(released.claimedByOwnerContextId, undefined, "release invalidates the old context claim");
  const reclaimed = routes.claimHandoff({ handoffId: h1.id, expectedRevision: released.revision, principalId: "user-b", ownerContextId: "review-context-b", reviewThreadId: activated.id });

  const committed = routes.markHandoffStatus({
    handoffId: h1.id,
    expectedRevision: reclaimed.revision,
    nextStatus: "feedback_committed",
    completed: true,
  });
  assert.equal(committed.status, "feedback_committed");
  assert.equal(routes.getRouteBySession("wsess-route")!.completedReviewRounds, 1, "completed rounds count committed feedback, not packet creation");
  assert.equal(routes.getRouteBySession("wsess-route")!.admittedReviewRounds, 1, "admitted rounds count unique submissions");

  // ── L04: pause/resume change only automation status, not the mode/budget.
  const paused = routes.setStatus({ workSessionId: "wsess-route", status: "paused" });
  assert.equal(paused.status, "paused");
  assert.equal(paused.mode, "isolated_review", "pause preserves the selected routing mode");
  assert.equal(paused.maxReviewRounds, 2, "pause preserves the round budget");
  // A paused route refuses new handoffs (no further automation).
  let pausedCreate = false;
  try {
    routes.createHandoff({
      routeId: configured.id, workSessionId: "wsess-route", submissionId: "sub-2",
      reviewEpoch: 2, snapshotKind: "git", snapshotRef: "ref-2", diffSha256: "hash-2", roundNumber: 2,
    });
  } catch { pausedCreate = true; }
  assert.ok(pausedCreate, "a paused route does not create new handoffs");

  const resumed = routes.setStatus({ workSessionId: "wsess-route", status: "active" });
  assert.equal(resumed.status, "active");
  assert.equal(resumed.mode, "isolated_review");
  assert.equal(resumed.maxReviewRounds, 2);

  // ── L02/L03: the round budget is an absolute ceiling. After two rounds the
  //    route refuses a third handoff regardless of convergence pressure.
  const h2 = routes.createHandoff({
    routeId: resumed.id, workSessionId: "wsess-route", submissionId: "sub-2",
    reviewEpoch: 2, snapshotKind: "git", snapshotRef: "ref-2", diffSha256: "hash-2", roundNumber: 2,
  });
  assert.equal(routes.getRouteBySession("wsess-route")!.admittedReviewRounds, 2);
  let thirdRound = false;
  try {
    routes.createHandoff({
      routeId: resumed.id, workSessionId: "wsess-route", submissionId: "sub-3",
      reviewEpoch: 3, snapshotKind: "git", snapshotRef: "ref-3", diffSha256: "hash-3", roundNumber: 3,
    });
  } catch (error) {
    thirdRound = /round limit reached/i.test(error instanceof Error ? error.message : String(error));
  }
  assert.ok(thirdRound, "the configured round maximum is an absolute ceiling on new handoffs");

  const h2Claim = routes.claimHandoff({
    handoffId: h2.id, expectedRevision: h2.revision, principalId: "user-b",
    ownerContextId: "review-context-b", reviewThreadId: activated.id,
    claimLeaseMs: 60_000,
  });
  // ── bounded claim renewal: same principal/context, unexpired lease, and a
  //    cumulative budget hung off the original claim time.
  const renewed = routes.renewHandoffClaim({
    handoffId: h2.id, expectedRevision: h2Claim.revision, principalId: "user-b",
    ownerContextId: "review-context-b", claimLeaseMs: 60_000,
  });
  assert.equal(renewed.status, "claimed");
  // Expiry is nowMs + lease at millisecond granularity: a same-millisecond
  // renewal legitimately yields an equal expiry, so assert never-shortened
  // plus the revision bump that proves the renewal was applied.
  assert.ok(Date.parse(renewed.claimExpiresAt!) >= Date.parse(h2Claim.claimExpiresAt!),
    "renewal never shortens the unexpired lease");
  assert.equal(renewed.revision, h2Claim.revision + 1, "renewal advances the revision");
  assert.throws(() => routes.renewHandoffClaim({
    handoffId: h2.id, expectedRevision: renewed.revision, principalId: "user-c",
    ownerContextId: "review-context-b", claimLeaseMs: 60_000,
  }), /expired|released|different/i, "a different principal cannot renew a live claim");
  // An expired claim cannot be renewed; it must be reclaimed instead.
  const bakedExpiry = routes.getHandoffById(h2.id)!;
  db.sqlite.prepare("update review_handoffs set claim_expires_at = ? where id = ?").run("1970-01-01T00:00:00.000Z", h2.id);
  // `bakedExpiry.revision` is the current revision: a failed renew call never
  // bumps it, and baking expiry only touches the timestamp column.
  assert.throws(() => routes.renewHandoffClaim({
    handoffId: h2.id, expectedRevision: bakedExpiry.revision, principalId: "user-b",
    ownerContextId: "review-context-b", claimLeaseMs: 60_000,
  }), /expired|released|different/i, "an expired claim cannot be renewed, only reclaimed");
  const pendingGrant = threads.createActivation({ routeId: resumed.id, ownerPrincipalId: "user-a", reviewerPrincipalId: "user-b" });
  const disabled = routes.setStatus({ workSessionId: "wsess-route", status: "disabled" });
  assert.equal(disabled.routeEpoch, resumed.routeEpoch + 1, "disabling the route advances its generation");
  assert.equal(threads.getById(activated.id)?.status, "closed", "disabling closes the reviewer thread");
  const superseded = routes.getHandoffById(h2.id)!;
  assert.equal(superseded.status, "superseded", "disabling fences an in-flight reviewer claim");
  assert.equal(superseded.claimedByPrincipalId, undefined, "disabling clears stale reviewer principal authority");
  assert.equal(superseded.claimedByOwnerContextId, undefined, "disabling clears stale reviewer context authority");
  assert.ok(h2Claim.revision < superseded.revision);
  assert.throws(() => threads.activate({ activationSecret: pendingGrant.activationSecret, principalId: "user-b", contextId: "replacement-context" }), /invalid|stale|expired/i,
    "disabling revokes unused reviewer activation grants");

  // ── Budget lock: changing maxReviewRounds starts a new loop generation.
  //    The budget is immutable within an epoch; the old thread closes and the
  //    next handoff opens a fresh thread carrying the new budget.
  {
    db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-route-budget");
    db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values ('wsess-budget', 'ws-route-budget', 'tester', 'in_progress', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run();
    const first = routes.configure({
      workSessionId: "wsess-budget", ownerPrincipalId: "user-a", ownerContextId: "owner-a",
      enabled: true, mode: "isolated_review", maxReviewRounds: 2,
    });
    routes.createHandoff({
      routeId: first.id, workSessionId: "wsess-budget", submissionId: "bsub-1",
      reviewEpoch: 1, snapshotKind: "git", snapshotRef: "bref-1", diffSha256: "bhash-1", roundNumber: 1,
    });
    const oldThread = threads.getForRoute(first.id, first.routeEpoch)!;
    assert.ok(oldThread, "first epoch owns a reviewer thread");
    const relocked = routes.configure({
      workSessionId: "wsess-budget", ownerPrincipalId: "user-a", ownerContextId: "owner-a",
      enabled: true, mode: "isolated_review", maxReviewRounds: 4,
    });
    assert.equal(relocked.routeEpoch, first.routeEpoch + 1, "a budget change advances the loop generation");
    assert.equal(relocked.maxReviewRounds, 4);
    assert.equal(threads.getById(oldThread.id)?.status, "closed", "a budget change closes the prior generation thread");
    assert.equal(relocked.admittedReviewRounds, 1, "admitted history survives the generation change");
    routes.createHandoff({
      routeId: relocked.id, workSessionId: "wsess-budget", submissionId: "bsub-2",
      reviewEpoch: 2, snapshotKind: "git", snapshotRef: "bref-2", diffSha256: "bhash-2", roundNumber: 2,
    });
    const nextThread = threads.getForRoute(relocked.id, relocked.routeEpoch)!;
    assert.ok(nextThread && nextThread.id !== oldThread.id, "the new generation opens a fresh reviewer thread");
    assert.equal(nextThread.maxRounds, 4, "the fresh thread carries the new generation budget");
    // Same-value reconfiguration stays in place: no spurious generation.
    // (Re-read the revision: the intervening handoff admission bumped it.)
    const same = routes.configure({
      workSessionId: "wsess-budget", ownerPrincipalId: "user-a", ownerContextId: "owner-a",
      enabled: true, mode: "isolated_review", maxReviewRounds: 4,
      expectedRevision: routes.getRouteBySession("wsess-budget")!.revision,
    });
    assert.equal(same.routeEpoch, relocked.routeEpoch, "repeating the same budget does not advance the generation");
  }

  // ── Skill provenance: the budget records which skill configuration set it.
  //    Changing provenance opens a fresh generation like a budget change.
  {
    db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-route-prov");
    db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values ('wsess-prov', 'ws-route-prov', 'tester', 'in_progress', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run();
    const prov = routes.configure({
      workSessionId: "wsess-prov", ownerPrincipalId: "user-a", ownerContextId: "owner-a",
      enabled: true, mode: "isolated_review", maxReviewRounds: 3,
      skillId: "nelson-wiggum-loop", skillVersion: "0.2.0", skillConfigSha256: "a".repeat(64),
    } as Parameters<typeof routes.configure>[0]);
    const stored = routes.getRouteBySession("wsess-prov")!;
    assert.equal(stored.skillId, "nelson-wiggum-loop", "the budget records its governing skill");
    assert.equal(stored.skillVersion, "0.2.0");
    assert.equal(stored.skillConfigSha256, "a".repeat(64));
    const reprov = routes.configure({
      workSessionId: "wsess-prov", ownerPrincipalId: "user-a", ownerContextId: "owner-a",
      enabled: true, mode: "isolated_review", maxReviewRounds: 3,
      skillId: "nelson-wiggum-loop", skillVersion: "0.3.0", skillConfigSha256: "b".repeat(64),
    } as Parameters<typeof routes.configure>[0]);
    assert.equal(reprov.routeEpoch, prov.routeEpoch + 1, "a skill reconfiguration opens a fresh generation");
    assert.equal(reprov.skillVersion, "0.3.0");
    db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-route-nosill");
    db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values ('wsess-noskill', 'ws-route-nosill', 'tester', 'in_progress', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run();
    routes.configure({
      workSessionId: "wsess-noskill", ownerPrincipalId: "user-a", ownerContextId: "owner-a",
      enabled: true, mode: "isolated_review", maxReviewRounds: 2,
    });
    const noskill = routes.getRouteBySession("wsess-noskill")!;
    assert.equal(noskill.skillId, undefined, "a reviewer-asserted budget records no skill provenance");
    assert.equal(noskill.skillConfigSha256, undefined);
    // Malformed provenance fails closed: partial triples and non-digests rejected.
    assert.throws(() => routes.configure({
      workSessionId: "wsess-noskill", ownerPrincipalId: "user-a", ownerContextId: "owner-a",
      enabled: true, mode: "isolated_review", maxReviewRounds: 2, skillId: "nelson-wiggum-loop",
    } as Parameters<typeof routes.configure>[0]), /all-or-nothing/i, "partial provenance is rejected");
    assert.throws(() => routes.configure({
      workSessionId: "wsess-noskill", ownerPrincipalId: "user-a", ownerContextId: "owner-a",
      enabled: true, mode: "isolated_review", maxReviewRounds: 2,
      skillId: "nelson-wiggum-loop", skillVersion: "0.2.0", skillConfigSha256: "not-a-digest",
    } as Parameters<typeof routes.configure>[0]), /hex digest/i, "a malformed config hash is rejected");
    assert.equal(routes.getRouteBySession("wsess-noskill")!.routeEpoch, noskill.routeEpoch, "rejected provenance leaves the generation untouched");
  }

  // ── P1-08: concurrent initial configuration cannot create duplicate routes.
  {
    const raceDb = openDatabase(join(root, "route-race"));
    const left = createReviewRouteStore(raceDb);
    const right = createReviewRouteStore(raceDb);
    const input = {
      workSessionId: "wsess-route-race",
      ownerPrincipalId: "user-a",
      ownerContextId: "owner-a",
      mode: "isolated_review" as const,
      enabled: true,
      maxReviewRounds: 2,
    };
    raceDb.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-route-race");
    raceDb.sqlite.prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values (?, 'ws-route-race', 'tester', 'in_progress', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run(input.workSessionId);
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => left.configure(input)),
      Promise.resolve().then(() => right.configure(input)),
    ]);
    assert.equal(first.id, second.id, "concurrent initial configuration converges on one route");
    const routeCount = raceDb.sqlite.prepare("select count(*) as count from review_routes where work_session_id = ?").get(input.workSessionId) as { count: number };
    assert.equal(routeCount.count, 1);
    raceDb.close();
  }

  // Revision CAS is enforced on status changes.
  let staleStatus = false;
  try {
    routes.setStatus({ workSessionId: "wsess-route", status: "paused", expectedRevision: 1 });
  } catch { staleStatus = true; }
  assert.ok(staleStatus, "stale revision cannot drive a route status change");

  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("review-handoff/route-store.test.ts: all assertions passed");
