import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { createWorkSessionManager } from "./work-sessions.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-lifecycle-"));
const database = openDatabase(root);
const store = new SqliteWorkspaceStore(database);
const workSessions = createWorkSessionManager(database);

try {
  const firstWorkspace = store.createSession({ id: "ws_old", root: "/tmp/project-history" });
  const secondWorkspace = store.createSession({ id: "ws_current", root: "/tmp/project-history" });
  assert.equal(firstWorkspace.projectId, secondWorkspace.projectId, "same canonical root must share one project identity");

  const old = workSessions.create({ workspaceSessionId: firstWorkspace.id, submittedBy: "test" });
  database.sqlite.prepare("update work_sessions set updated_at = ?, runtime_state = 'pending' where id = ?")
    .run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), old.id);
  const current = workSessions.create({ workspaceSessionId: secondWorkspace.id, submittedBy: "test" });
  const now = new Date().toISOString();
  database.sqlite.prepare(`
    insert into acp_runs (run_id, agent_name, workspace_session_id, work_session_id, attempt_number, status, webhook_delivered, last_heartbeat_at, worker_lease_until, created_at)
    values (?, ?, ?, ?, 1, 'running', 0, ?, ?, ?)
  `).run("run_current", "test-agent", secondWorkspace.id, current.id, now, new Date(Date.now() + 60_000).toISOString(), now);

  const boundedPage = workSessions.reconcileRuntimeStates(undefined, 1);
  assert.ok(boundedPage.hasMore, "runtime reconciliation must expose more work instead of sweeping every session");
  const reconciliation = workSessions.reconcileRuntimeStates();
  assert.ok(boundedPage.markedStale + reconciliation.markedStale >= 1, "old detached work must be classified stale");
  assert.deepEqual(workSessions.listLiveWorkSessions(secondWorkspace.id).map((session) => session.id), [current.id]);
  assert.ok(workSessions.listStaleWorkSessions(secondWorkspace.id).some((session) => session.id === old.id), "historical stale work must remain recoverable");
  assert.ok(workSessions.listByWorkspace(secondWorkspace.id).some((session) => session.id === old.id), "project-scoped history must include old workspace instances");
  const surface = workSessions.getWorkspaceSessionSurface(secondWorkspace.id);
  assert.deepEqual(surface.map((session) => session.sessionId).sort(), [current.id, old.id].sort(), "batch surface spans the project without per-session hydration");
  assert.equal(workSessions.getWorkspaceEventCursor(secondWorkspace.id), 0, "empty workspace starts at global event cursor zero");

  const pagedIds = [old.id, current.id];
  for (let index = 0; index < 52; index += 1) {
    pagedIds.push(workSessions.create({ workspaceSessionId: secondWorkspace.id, submittedBy: "pager-test" }).id);
  }
  const firstPage = workSessions.getWorkspaceSessionSurface(secondWorkspace.id, 50);
  const last = firstPage[firstPage.length - 1];
  assert.equal(firstPage.length, 50);
  assert.ok(last, "a full page must expose a cursor anchor");
  const secondPage = workSessions.getWorkspaceSessionSurface(secondWorkspace.id, 50, "all", {
    updatedAt: last.updatedAt,
    sessionId: last.sessionId,
  });
  const combined = [...firstPage, ...secondPage].map((entry) => entry.sessionId);
  assert.equal(new Set(combined).size, combined.length, "surface cursor pages must not overlap");
  assert.deepEqual(new Set(combined), new Set(pagedIds), "surface cursor pages must cover sessions beyond the first 50");

  const raceSession = workSessions.create({ workspaceSessionId: secondWorkspace.id, submittedBy: "race-test" });
  workSessions.submitForReview({
    workSessionId: raceSession.id,
    diff: "diff --git a/quoted b/quoted",
    files: [{ path: "src/quoted name.ts", type: "change", additions: 2, removals: 1 }],
  });
  assert.deepEqual(workSessions.getLatestSubmission(raceSession.id)?.files, [{ path: "src/quoted name.ts", type: "change", additions: 2, removals: 1 }]);
  assert.throws(
    () => workSessions.submitForReview({ workSessionId: raceSession.id, diff: "second" }),
    /cannot submit for review/,
    "a second submit must be rejected after the first transaction advances the status",
  );
} finally {
  workSessions.close();
  store.close();
  database.close();
  await rm(root, { recursive: true, force: true });
}

console.log("work-session-lifecycle.test.ts: all assertions passed");
