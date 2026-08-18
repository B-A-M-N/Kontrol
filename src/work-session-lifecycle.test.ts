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

  const reconciliation = workSessions.reconcileRuntimeStates();
  assert.ok(reconciliation.markedStale >= 1, "old detached work must be classified stale");
  assert.deepEqual(workSessions.listLiveWorkSessions(secondWorkspace.id).map((session) => session.id), [current.id]);
  assert.ok(workSessions.listStaleWorkSessions(secondWorkspace.id).some((session) => session.id === old.id), "historical stale work must remain recoverable");
  assert.ok(workSessions.listByWorkspace(secondWorkspace.id).some((session) => session.id === old.id), "project-scoped history must include old workspace instances");
} finally {
  workSessions.close();
  store.close();
  database.close();
  await rm(root, { recursive: true, force: true });
}

console.log("work-session-lifecycle.test.ts: all assertions passed");
