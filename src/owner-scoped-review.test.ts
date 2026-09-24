import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { createWorkSessionManager } from "./work-sessions/index.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { requireWorkSessionRead } from "./bridge/shared.js";
import { loadConfig } from "./config.js";
import type { BridgeConfig } from "./bridge/context.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-owner-review-"));
const database = openDatabase(join(root, "state"));
const workspaceStore = new SqliteWorkspaceStore(database);
const workSessions = createWorkSessionManager(database);
const config = loadConfig({
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_WORKTREE_ROOT: join(root, "worktrees"),
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_POLICY_MODE: "allow",
  PORT: "1",
});
const workspace = workspaceStore.createSession({ id: "workspace-owner-review", root });
const session = workSessions.create({ workspaceSessionId: workspace.id, submittedBy: "mcp", ownerContextId: "conversation:owner-b" });
const bridgeBase = {
  workspaces: { getWorkspace: () => { throw new Error("not used"); } },
  workSessions,
  principalRole: "reviewer" as const,
} as unknown as BridgeConfig;
const scoped = requireWorkSessionRead({ ...bridgeBase, connectionConversationId: "owner-a" }, session.id);
assert.equal(scoped?.isError, true, "owner A must not read owner B work-session details");
assert.match(scoped?.content[0]?.text ?? "", /cross-conversation/);
const owner = requireWorkSessionRead({ ...bridgeBase, connectionConversationId: "owner-b" }, session.id);
assert.equal(owner, null, "owner B can read its own work session");
const globalReviewer = requireWorkSessionRead({ ...bridgeBase }, session.id);
assert.equal(globalReviewer, null, "ownerless reviewer retains the explicit global review surface");
workSessions.close();
workspaceStore.close?.();
console.log("owner-scoped-review.test.ts: all assertions passed");
