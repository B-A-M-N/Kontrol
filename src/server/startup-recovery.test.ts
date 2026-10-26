import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { openDatabase } from "../db/client.js";
import { loadConfig } from "../config.js";
import { createServer } from "../server.js";
import { dropPeerWorktree, peerOwnsWorktree, recordPeerWorktree } from "../peer/workspace-guard.js";
import { reconcileReplyDeliveryPage, reconcileReviewHandoffPage } from "./startup-recovery.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-startup-recovery-test-"));
try {
  const db = openDatabase(root);
  db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values ('ws', '/tmp', 'active', 'checkout', 'false', '2020', '2020')").run();
  db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values ('session', 'ws', 'reviewer', 'in_progress', '2020', '2020')").run();
  const insertMessage = db.sqlite.prepare("insert into agent_messages (id, work_session_id, kind, author, title, body, data_json, status, created_at) values (?, 'session', 'clarification_request', 'worker', 'title', 'body', '{}', 'open', ?)");
  const insertReply = db.sqlite.prepare("insert into agent_message_replies (id, message_id, work_session_id, body, body_sha256, reviewer_principal_id, status, created_at) values (?, ?, 'session', 'reply', ?, 'reviewer', 'delivering', ?)");
  for (let index = 0; index < 250; index++) {
    const id = `message-${String(index).padStart(3, "0")}`;
    insertMessage.run(id, "2026-01-01T00:00:00.000Z");
    const timestamp = `2026-01-${String(1 + Math.floor(index / 20)).padStart(2, "0")}T00:00:00.000Z`;
    insertReply.run(`reply-${String(index).padStart(3, "0")}`, id, "a".repeat(64), timestamp);
  }
  insertMessage.run("message-correlated", "2026-01-20T00:00:00.000Z");
  db.sqlite.prepare(`insert into agent_message_replies (
    id, message_id, work_session_id, body, body_sha256, reviewer_principal_id, status,
    delivery_dispatch_idempotency_key, delivery_run_id, delivery_attempt_number, delivery_remote_run_id, created_at
  ) values ('reply-correlated', 'message-correlated', 'session', 'reply', ?, 'reviewer', 'delivering',
    'reply_dispatch_exact', 'run_exact', 4, 'remote_exact', '2026-01-20T00:00:00.000Z')`).run("d".repeat(64));
  let after: { createdAt: string; id: string } | undefined;
  let reconciled = 0;
  for (;;) {
    const page = reconcileReplyDeliveryPage(db, after, 100);
    reconciled += page.reconciled;
    if (!page.next) break;
    after = page.next;
  }
  assert.equal(reconciled, 251, "ascending keyset pagination reaches every accepted reply across timestamp collisions");
  assert.equal((db.sqlite.prepare("select count(*) as count from agent_message_replies where status = 'awaiting_acknowledgement'").get() as { count: number }).count, 251);
  assert.deepEqual(db.sqlite.prepare(`select status, delivery_dispatch_idempotency_key as dispatchKey,
    delivery_run_id as runId, delivery_attempt_number as attemptNumber, delivery_remote_run_id as remoteRunId
    from agent_message_replies where id = 'reply-correlated'`).get(), {
    status: "awaiting_acknowledgement",
    dispatchKey: "reply_dispatch_exact",
    runId: "run_exact",
    attemptNumber: 4,
    remoteRunId: "remote_exact",
  }, "startup recovery preserves the accepted dispatch's exact correlation identity");
  assert.equal(reconcileReplyDeliveryPage(db, undefined, 100).reconciled, 0, "a second restart reconciliation does not replay accepted replies");

  // A terminal parent closes its handoff; a live parent is retained. The left
  // join also lets corrupted/orphaned references be classified and closed.
  db.sqlite.prepare("insert into review_routes (id, work_session_id, owner_principal_id, owner_context_id, status, mode, delivery_transport, max_review_rounds, completed_review_rounds, admitted_review_rounds, route_epoch, revision, created_at, updated_at) values ('route', 'session', 'reviewer', 'ctx', 'active', 'isolated_review', 'native_cdp', 3, 0, 0, 1, 1, '2026', '2026')").run();
  const handoffInsert = db.sqlite.prepare("insert into review_handoffs (id, route_id, work_session_id, submission_id, review_epoch, snapshot_kind, snapshot_ref, diff_sha256, route_epoch, round_number, status, created_at) values (?, 'route', ?, ?, 1, 'git', 'snapshot', ?, 1, 1, 'claimed', '2026')");
  db.sqlite.prepare("update work_sessions set status = 'approved' where id = 'session'").run();
  handoffInsert.run("handoff-terminal", "session", "submission-terminal", "b".repeat(64));
  assert.equal(reconcileReviewHandoffPage(db).reconciled, 1, "terminal work-session status closes its handoff");
  assert.equal((db.sqlite.prepare("select status from review_handoffs where id = 'handoff-terminal'").get() as { status: string }).status, "closed");
  const terminalStatuses = ["rejected", "failed", "cancelled"];
  for (const [index, status] of terminalStatuses.entries()) {
    const sessionId = `terminal-session-${status}`;
    db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values (?, 'ws', 'reviewer', ?, '2020', '2020')").run(sessionId, status);
    handoffInsert.run(`handoff-${status}`, sessionId, `submission-${status}`, `${String(index + 3).repeat(64)}`);
  }
  assert.equal(reconcileReviewHandoffPage(db).reconciled, 3, "rejected, failed, and cancelled parent sessions each close their handoff");
  db.sqlite.prepare("update work_sessions set status = 'in_progress' where id = 'session'").run();
  handoffInsert.run("handoff-live", "session", "submission-live", "c".repeat(64));
  let handoffCursor: string | undefined;
  const handoffPage = reconcileReviewHandoffPage(db, handoffCursor, 1);
  assert.equal(handoffPage.reconciled, 0, "live parent work does not close its handoff");
  handoffCursor = handoffPage.nextAfterId;
  assert.ok(handoffCursor);
  assert.equal(reconcileReviewHandoffPage(db, handoffCursor, 1).reconciled, 0);
  db.sqlite.pragma("foreign_keys = OFF");
  db.sqlite.prepare("delete from work_sessions where id = 'session'").run();
  assert.equal(reconcileReviewHandoffPage(db).reconciled, 1, "a handoff with a missing parent is explicitly closed by the left-join recovery path");
  assert.equal((db.sqlite.prepare("select status from review_handoffs where id = 'handoff-live'").get() as { status: string }).status, "closed");
  db.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
{
  // Peer worktree ownership restores across createServer restart.
  const stateDir = mkdtempSync(join(tmpdir(), "kontrol-peer-owner-restart-"));
  const workspaceId = "workspace-owner-restart-fixture";
  const owner = "peer:meta-muse:credential";
  recordPeerWorktree(workspaceId, owner, stateDir);
  const config = loadConfig({
    KONTROL_ALLOWED_ROOTS: "/tmp",
    KONTROL_STATE_DIR: stateDir,
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_ACP_ENABLED: "false",
    KONTROL_POLICY_MODE: "allow",
  });
  const running = createServer(config);
  await running.close();
  assert.equal(peerOwnsWorktree(workspaceId, owner), true, "peer worktree ownership must restore on startup");
  dropPeerWorktree(workspaceId);
}
console.log("startup-recovery.test.ts: all assertions passed");
