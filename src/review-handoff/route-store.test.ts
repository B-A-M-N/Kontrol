import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createReviewRouteStore } from "./route-store.js";

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
  let duplicate = false;
  try {
    routes.createHandoff({
      routeId: configured.id,
      workSessionId: "wsess-route",
      submissionId: "sub-1",
      reviewEpoch: 1,
      snapshotKind: "git",
      snapshotRef: "ref-1",
      diffSha256: "hash-1",
      roundNumber: 2,
    });
  } catch {
    duplicate = true;
  }
  assert.ok(duplicate, "duplicate handoff for same submission is rejected");

  const claimed = routes.claimHandoff({
    handoffId: h1.id,
    expectedRevision: 1,
    principalId: "user-b",
    ownerContextId: "owner-a",
    destinationConversationId: "conv-b",
    authorization: {
      conversationId: "owner-a",
      freshConversationIds: ["owner-a"],
    },
  });
  assert.equal(claimed.status, "claimed");
  let competing = false;
  try {
    routes.claimHandoff({
      handoffId: h1.id,
      expectedRevision: 1,
      principalId: "user-c",
      ownerContextId: "owner-c",
    });
  } catch {
    competing = true;
  }
  assert.ok(competing, "two conversations cannot claim the same handoff revision");

  const committed = routes.markHandoffStatus({
    handoffId: h1.id,
    expectedRevision: claimed.revision,
    nextStatus: "feedback_committed",
    completed: true,
  });
  assert.equal(committed.status, "feedback_committed");

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
  assert.equal(routes.getRouteBySession("wsess-route")!.completedReviewRounds, 2);
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
  void h2;

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
