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
    ownerContextId: "owner-b",
    destinationConversationId: "conv-b",
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
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("review-handoff/route-store.test.ts: all assertions passed");
