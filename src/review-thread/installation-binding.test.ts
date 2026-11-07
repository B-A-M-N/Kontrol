import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createReviewRouteStore } from "../review-handoff/route-store.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-installation-binding-"));
try {
  const db = openDatabase(root);
  db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-inst");
  db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values (?, 'ws-inst', 'owner', 'in_progress', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("session-inst");

  const routesA = createReviewRouteStore(db, { installationId: "install-A" });
  const route = routesA.configure({
    workSessionId: "session-inst", ownerPrincipalId: "owner", ownerContextId: "owner-context",
    enabled: true, mode: "pinned_conversation", maxReviewRounds: 3,
    deliveryTransport: "native_cdp", browserProfileId: "profile-inst",
    pinnedConversationId: "conv-1",
  });
  assert.equal(routesA.getRouteBySession("session-inst")?.installationId, "install-A", "route persists the server-issued installation id");

  // Same installation: claim succeeds.
  const handoff1 = routesA.createHandoff({
    routeId: route.id, workSessionId: "session-inst", submissionId: "submission-1",
    reviewEpoch: 1, snapshotKind: "git", snapshotRef: "snapshot-1", diffSha256: "hash-1", roundNumber: 1,
  });
  const claimed = routesA.claimHandoff({
    handoffId: handoff1.id, expectedRevision: handoff1.revision,
    principalId: "owner", ownerContextId: "conv-1",
  });
  assert.ok(claimed.id, "same-installation claim succeeds");

  // Different installation (DB restored into a new state dir): claim refused.
  const routesB = createReviewRouteStore(db, { installationId: "install-B" });
  const handoff2 = routesB.createHandoff({
    routeId: route.id, workSessionId: "session-inst", submissionId: "submission-2",
    reviewEpoch: 1, snapshotKind: "git", snapshotRef: "snapshot-1", diffSha256: "hash-2", roundNumber: 1,
  });
  assert.throws(
    () => routesB.claimHandoff({ handoffId: handoff2.id, expectedRevision: handoff2.revision, principalId: "owner", ownerContextId: "conv-1" }),
    /different installation/,
    "cross-installation claim is refused",
  );

  // Legacy route with no installation id remains claimable (back-compat).
  const db2root = await mkdtemp(join(tmpdir(), "kontrol-installation-legacy-"));
  try {
    const db2 = openDatabase(db2root);
    db2.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-legacy");
    db2.sqlite.prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values (?, 'ws-legacy', 'owner', 'in_progress', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("session-legacy");
    const legacyRoutes = createReviewRouteStore(db2); // no installation id: pre-binding instance
    const legacyRoute = legacyRoutes.configure({
      workSessionId: "session-legacy", ownerPrincipalId: "owner", ownerContextId: "owner-context",
      enabled: true, mode: "pinned_conversation", maxReviewRounds: 3,
      deliveryTransport: "native_cdp", browserProfileId: "profile-inst", pinnedConversationId: "conv-1",
    });
    assert.equal(legacyRoutes.getRouteBySession("session-legacy")?.installationId, undefined, "no installation bound");
    const legacyHandoff = legacyRoutes.createHandoff({
      routeId: legacyRoute.id, workSessionId: "session-legacy", submissionId: "submission-1",
      reviewEpoch: 1, snapshotKind: "git", snapshotRef: "snapshot-1", diffSha256: "hash-1", roundNumber: 1,
    });
    assert.ok(legacyRoutes.claimHandoff({ handoffId: legacyHandoff.id, expectedRevision: legacyHandoff.revision, principalId: "owner", ownerContextId: "conv-1" }).id, "legacy unbound route is claimable");
    db2.close();
  } finally {
    await rm(db2root, { recursive: true, force: true });
  }
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("installation-binding.test.ts: all assertions passed");
