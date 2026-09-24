import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkSessionManager } from "./work-sessions/index.js";
import { openDatabase } from "./db/client.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { loadConfig } from "./config.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-owner-context-"));
try {
  const config = loadConfig({
    KONTROL_ALLOWED_ROOTS: root,
    KONTROL_WORKTREE_ROOT: join(root, "worktrees"),
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_ACP_ENABLED: "false",
    KONTROL_POLICY_MODE: "allow",
    PORT: "1",
  });
  const stateDir = join(root, "state");
  const database = openDatabase(stateDir);
  const workspaceStore = new SqliteWorkspaceStore(database);
  workspaceStore.createSession({ id: "workspace-shared", root });
  const workSessions = createWorkSessionManager(database);
  try {
    const a = workSessions.create({ workspaceSessionId: "workspace-shared", submittedBy: "mcp", ownerContextId: "conversation:a" });
    const b = workSessions.create({ workspaceSessionId: "workspace-shared", submittedBy: "mcp", ownerContextId: "conversation:b" });
    assert.equal(a.ownerContextId, "conversation:a");
    assert.equal(b.ownerContextId, "conversation:b");
    assert.notEqual(a.ownerContextId, b.ownerContextId);
    assert.equal(workSessions.get(a.id)?.ownerContextId, "conversation:a", "owner context persists on reload-style projection");
    assert.equal(workSessions.get(b.id)?.ownerContextId, "conversation:b");
  } finally {
    workSessions.close();
  }
} finally {
  // The manager owns a temporary SQLite handle; the temp tree is disposable.
}
console.log("owner-context-isolation.test.ts: all assertions passed");
