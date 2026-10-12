import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createReviewRouteStore } from "../review-handoff/route-store.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-handoff-tools-test-"));

try {
  const db = openDatabase(root);
  db.sqlite
    .prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
    .run("ws-handoff");
  db.sqlite
    .prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values ('wsess-handoff', 'ws-handoff', 'tester', 'in_progress', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
    .run();
  const routes = createReviewRouteStore(db);
  const route = routes.configure({
    workSessionId: "wsess-handoff",
    ownerPrincipalId: "user-a",
    ownerContextId: "owner-a",
    enabled: true,
    mode: "pinned_conversation",
    maxReviewRounds: 3,
    pinnedConversationId: "conv-b",
  });
  const handoff = routes.createHandoff({
    routeId: route.id,
    workSessionId: "wsess-handoff",
    submissionId: "sub-1",
    reviewEpoch: 1,
    snapshotKind: "git",
    snapshotRef: "ref-1",
    diffSha256: "hash-1",
    roundNumber: 1,
  });
  const fetched = routes.getHandoffById(handoff.id);
  assert.equal(fetched?.submissionId, "sub-1");
  let wrongConversationDenied = false;
  try {
    routes.claimHandoff({
      handoffId: handoff.id,
      expectedRevision: 1,
      principalId: "user-b",
      ownerContextId: "owner-b",
      destinationConversationId: "owner-b",
      authorization: {
        authorizedWorkSessionIds: ["wsess-handoff"],
        conversationId: "owner-b",
        freshConversationIds: ["owner-b"],
      },
    });
  } catch {
    wrongConversationDenied = true;
  }
  assert.ok(wrongConversationDenied, "wrong pinned conversation cannot claim the handoff");
  const claimed = routes.claimHandoff({
    handoffId: handoff.id,
    expectedRevision: 1,
    principalId: "user-b",
    ownerContextId: "conv-b",
    destinationConversationId: "conv-b",
    authorization: {
      authorizedWorkSessionIds: ["wsess-handoff"],
      conversationId: "conv-b",
      freshConversationIds: ["conv-b"],
    },
  });
  assert.equal(claimed.claimedByOwnerContextId, "conv-b");
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("bridge/handoff-tools.test.ts: all assertions passed");
