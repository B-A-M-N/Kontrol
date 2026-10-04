import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { createApprovalRequestManager } from "./approval-requests.js";
import { GitWorktreeError } from "./git-worktrees.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { createWorkSessionManager } from "./work-sessions.js";

const execFileAsync = promisify(execFile);
const testGitName = (await execFileAsync("git", ["config", "user.name"], { cwd: process.cwd() })).stdout.trim();
const testGitEmail = (await execFileAsync("git", ["config", "user.email"], { cwd: process.cwd() })).stdout.trim();
const root = await mkdtemp(join(tmpdir(), "kontrol-workspace-test-"));

try {
  const agentDir = join(root, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");
  // Performance fixture: opening a workspace must not walk 10,000 unrelated
  // descendant directories just to discover path-local instructions.
  const largeFixture = join(root, "large-fixture");
  await mkdir(largeFixture);
  await Promise.all(Array.from({ length: 10_000 }, (_, index) => mkdir(join(largeFixture, `dir-${index}`))));

  const config = loadConfig({
    KONTROL_ALLOWED_ROOTS: root,
    KONTROL_WORKTREE_ROOT: join(root, ".kontrol", "worktrees"),
    KONTROL_AGENT_DIR: agentDir,
    KONTROL_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const { workspace, agentsFiles, availableAgentsFiles } = await registry.openWorkspace(root);

  assert.equal(workspace.mode, "checkout");
  assert.deepEqual(
    agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
  assert.deepEqual(availableAgentsFiles, [], "openWorkspace must not recursively scan descendants");
  const largeStart = Date.now();
  const largeOpen = await new WorkspaceRegistry(config).openWorkspace(root);
  assert.deepEqual(largeOpen.availableAgentsFiles, [], "10,000 descendant directories do not trigger recursive instruction discovery");
  assert.ok(Date.now() - largeStart < 2_000, "workspace open remains bounded with a 10,000-directory fixture");
  const newlyLoaded = await registry.loadApplicableInstructions(workspace, "nested/file.txt");
  assert.deepEqual(newlyLoaded.map((file) => file.path), [join(root, "nested", "AGENTS.md")]);
  assert.deepEqual(await registry.loadApplicableInstructions(workspace, "nested/file.txt"), newlyLoaded,
    "instruction discovery remains unacknowledged until the owning operation succeeds");
  registry.acknowledgeApplicableInstructions(workspace, newlyLoaded);
  assert.deepEqual(await registry.loadApplicableInstructions(workspace, "nested/file.txt"), [],
    "acknowledged nested instructions are cached");

  const missingWorkspaceRoot = join(root, "missing", "workspace");
  await assert.rejects(
    () => registry.openWorkspace(missingWorkspaceRoot),
    /Workspace does not exist/,
  );
  await assert.rejects(() => stat(missingWorkspaceRoot), { code: "ENOENT" });

  await assert.rejects(
    () => registry.openWorkspace({ path: root, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_REPOSITORY_NOT_FOUND",
  );

  const gitRoot = join(root, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", testGitEmail]);
  await git(gitRoot, ["config", "user.name", testGitName]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");

  const worktreeWorkspace = await registry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  assert.equal(worktreeWorkspace.workspace.mode, "worktree");
  assert.notEqual(worktreeWorkspace.workspace.root, gitRoot);
  assert.match(worktreeWorkspace.workspace.root, /git-project-[a-f0-9]{8}$/);
  assert.equal(worktreeWorkspace.workspace.sourceRoot, gitRoot);
  assert.equal(worktreeWorkspace.workspace.worktree?.baseRef, "HEAD");
  assert.equal(worktreeWorkspace.workspace.worktree?.dirtySource, true);
  assert.equal(worktreeWorkspace.workspace.worktree?.managed, true);
  assert.equal((await stat(worktreeWorkspace.workspace.root)).isDirectory(), true);
  assert.match(worktreeWorkspace.agentsFiles.map((file) => file.content).join("\n"), /global instructions/);
  assert.match(worktreeWorkspace.agentsFiles.map((file) => file.content).join("\n"), /git root instructions/);

  const worktreeReadmePath = registry.resolvePath(worktreeWorkspace.workspace, "README.md");
  assert.equal(worktreeReadmePath.startsWith(worktreeWorkspace.workspace.root), true);

  const stateDir = join(root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const persistentRegistry = new WorkspaceRegistry(config, firstStore);
  const persistentWorkspace = await persistentRegistry.openWorkspace(root);
  const persistentWorktree = await persistentRegistry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });

  // Retirement refuses every live durable reference plus running processes.
  // Once references are terminal it retires atomically and delays physical
  // removal until retention elapses. Dirty retired worktrees remain visible.
  const lifecycleDb = openDatabase(stateDir);
  const lifecycleWorkSessions = createWorkSessionManager(lifecycleDb);
  const lifecycleApprovals = createApprovalRequestManager(lifecycleDb);
  const activeWorkSession = lifecycleWorkSessions.create({
    workspaceSessionId: persistentWorktree.workspace.id,
    submittedBy: "worktree-lifecycle-test",
  });
  const pendingSubmission = lifecycleWorkSessions.submitForReview({
    workSessionId: activeWorkSession.id,
    diff: "test diff",
  });
  const blockedByWorkSession = persistentRegistry.retireManagedWorktree(persistentWorktree.workspace.id, 0);
  assert.equal(blockedByWorkSession.retired, false);
  assert.equal(blockedByWorkSession.blockers?.workSessions, 1);
  assert.equal(blockedByWorkSession.blockers?.pendingReviews, 1);

  lifecycleWorkSessions.updateStatus(activeWorkSession.id, "approved");
  const blockedByReview = persistentRegistry.retireManagedWorktree(persistentWorktree.workspace.id, 0);
  assert.equal(blockedByReview.retired, false);
  assert.equal(blockedByReview.blockers?.pendingReviews, 1, "a pending review stays a blocker even after its work session is terminal");

  lifecycleDb.sqlite.prepare("update work_session_submissions set status = 'approved' where id = ?").run(pendingSubmission.id);
  lifecycleDb.sqlite.prepare(`
    insert into approval_requests (id, kind, workspace_session_id, title, options_json, status, created_at)
    values ('approval-worktree-test', 'policy', ?, 'test approval', '[]', 'pending', ?)
  `).run(persistentWorktree.workspace.id, new Date().toISOString());
  const blockedByApproval = persistentRegistry.retireManagedWorktree(persistentWorktree.workspace.id, 0);
  assert.equal(blockedByApproval.retired, false);
  assert.equal(blockedByApproval.blockers?.pendingApprovals, 1);
  lifecycleDb.sqlite.prepare("update approval_requests set status = 'approved' where id = 'approval-worktree-test'").run();

  const processes = new ProcessSessionManager({ childEnvironmentAllowlist: [] });
  try {
    const processNode = JSON.stringify(process.execPath);
    const running = await processes.start({
      workspaceId: persistentWorktree.workspace.id,
      cwd: persistentWorktree.workspace.root,
      command: `${processNode} -e "setTimeout(() => {}, 30000)"`,
      yieldTimeMs: 10,
    });
    assert.equal(running.running, true);
    assert.equal(processes.countRunningForWorkspace(persistentWorktree.workspace.id), 1);
    const blockedByProcess = persistentRegistry.retireManagedWorktree(
      persistentWorktree.workspace.id,
      processes.countRunningForWorkspace(persistentWorktree.workspace.id),
    );
    assert.equal(blockedByProcess.retired, false);
    assert.equal(blockedByProcess.blockers?.runningProcesses, 1);
  } finally {
    await processes.shutdown();
  }

  const retired = persistentRegistry.retireManagedWorktree(persistentWorktree.workspace.id, 0);
  assert.equal(retired.retired, true);
  assert.equal(retired.session?.status, "retired");
  assert.throws(() => persistentRegistry.getWorkspace(persistentWorktree.workspace.id), /retired/);
  lifecycleDb.sqlite.prepare("update workspace_sessions set retired_at = ? where id = ?")
    .run(new Date(Date.now() - 60_000).toISOString(), persistentWorktree.workspace.id);
  const collectorConfig = loadConfig({
    KONTROL_ALLOWED_ROOTS: root,
    KONTROL_WORKTREE_ROOT: join(root, ".kontrol", "worktrees"),
    KONTROL_AGENT_DIR: agentDir,
    KONTROL_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    KONTROL_MANAGED_WORKTREE_RETENTION_MS: "1",
    PORT: "1",
  });
  const collector = new WorkspaceRegistry(collectorConfig, firstStore);
  const retiredRow = lifecycleDb.sqlite.prepare("select mode, managed, status, retired_at from workspace_sessions where id = ?")
    .get(persistentWorktree.workspace.id);
  assert.equal(collectorConfig.managedWorktreeRetentionMs, 1);
  const dueCandidates = firstStore.listExpiredRetiredManagedWorktrees(new Date().toISOString());
  assert.equal(dueCandidates.length, 1, JSON.stringify(retiredRow));
  assert.equal(dueCandidates[0].retiredAt, (retiredRow as { retired_at: string }).retired_at);
  const cleanCollection = await collector.collectRetiredManagedWorktrees(() => 0);
  assert.equal(cleanCollection.removed, 1, `expired clean worktree is garbage-collected (${JSON.stringify(cleanCollection)})`);
  assert.equal(firstStore.getSession(persistentWorktree.workspace.id)?.status, "removed");
  await assert.rejects(() => stat(persistentWorktree.workspace.root), { code: "ENOENT" });
  assert.throws(
    () => lifecycleWorkSessions.create({ workspaceSessionId: persistentWorktree.workspace.id, submittedBy: "late-session" }),
    /is not active and cannot accept a new work session/,
    "a retired or removed worktree cannot acquire new durable work sessions",
  );
  assert.throws(
    () => lifecycleApprovals.create({
      kind: "tool",
      workspaceSessionId: persistentWorktree.workspace.id,
      title: "late approval",
    }),
    /is not active and cannot accept a new approval request/,
    "a retired or removed worktree cannot acquire a new approval request",
  );

  const dirtyWorktree = await persistentRegistry.openWorkspace({ path: gitRoot, mode: "worktree" });
  await writeFile(join(dirtyWorktree.workspace.root, "README.md"), "uncommitted work must remain\n");
  assert.equal(persistentRegistry.retireManagedWorktree(dirtyWorktree.workspace.id, 0).retired, true);
  lifecycleDb.sqlite.prepare("update workspace_sessions set retired_at = ? where id = ?")
    .run(new Date(Date.now() - 60_000).toISOString(), dirtyWorktree.workspace.id);
  const dirtyCollection = await collector.collectRetiredManagedWorktrees(() => 0);
  assert.equal(dirtyCollection.retained, 1, "dirty retired worktree remains in place");
  const dirtyRecord = (await collector.listManagedWorktrees()).worktrees.find((entry) => entry.workspaceId === dirtyWorktree.workspace.id);
  assert.equal(dirtyRecord?.dispositionRequired, true);
  assert.equal(dirtyRecord?.dispositionReason, "working_tree_dirty");
  assert.equal((await stat(dirtyWorktree.workspace.root)).isDirectory(), true);
  assert.throws(() => persistentRegistry.getWorkspace(dirtyWorktree.workspace.id), /retired/);

  lifecycleDb.close();
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  const restoredRegistry = new WorkspaceRegistry(config, secondStore);
  const restoredWorkspace = restoredRegistry.getWorkspace(persistentWorkspace.workspace.id);
  assert.equal(restoredWorkspace.root, root);
  assert.equal(restoredWorkspace.mode, "checkout");

  assert.throws(() => restoredRegistry.getWorkspace(persistentWorktree.workspace.id), /removed/);
  secondStore.close();

  // Project and global caps apply before creating another Git worktree.
  const capRoot = join(root, "cap-project");
  const capRoot2 = join(root, "cap-project-two");
  const capRoot3 = join(root, "cap-project-three");
  await Promise.all([capRoot, capRoot2, capRoot3].map(async (repo, index) => {
    await mkdir(repo);
    await writeFile(join(repo, "README.md"), `cap fixture ${index}\n`);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", testGitEmail]);
    await git(repo, ["config", "user.name", testGitName]);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "Initial commit"]);
  }));
  const capConfig = loadConfig({
    KONTROL_ALLOWED_ROOTS: root,
    KONTROL_WORKTREE_ROOT: join(root, ".capped-worktrees"),
    KONTROL_AGENT_DIR: agentDir,
    KONTROL_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    KONTROL_MANAGED_WORKTREE_PROJECT_LIMIT: "1",
    KONTROL_MANAGED_WORKTREE_GLOBAL_LIMIT: "2",
    PORT: "1",
  });
  const capStore = new SqliteWorkspaceStore(join(root, ".cap-state"));
  const capRegistry = new WorkspaceRegistry(capConfig, capStore);
  await capRegistry.openWorkspace({ path: capRoot, mode: "worktree" });
  await assert.rejects(
    () => capRegistry.openWorkspace({ path: capRoot, mode: "worktree" }),
    /project limit reached/,
  );
  await capRegistry.openWorkspace({ path: capRoot2, mode: "worktree" });
  await assert.rejects(
    () => capRegistry.openWorkspace({ path: capRoot3, mode: "worktree" }),
    /global limit reached/,
  );
  const firstWorktreePage = capStore.listManagedWorktrees({ limit: 1 });
  assert.equal(firstWorktreePage.worktrees.length, 1);
  assert.ok(firstWorktreePage.nextCursor, "bounded managed-worktree listing exposes a continuation cursor");
  const secondWorktreePage = capStore.listManagedWorktrees({ limit: 1, before: firstWorktreePage.nextCursor });
  assert.equal(secondWorktreePage.worktrees.length, 1);
  assert.notEqual(secondWorktreePage.worktrees[0].id, firstWorktreePage.worktrees[0].id);
  assert.equal(secondWorktreePage.nextCursor, undefined);
  capStore.close();

  if (platform() !== "win32") {
    const aliasRoot = join(root, "alias-root");
    await symlink(root, aliasRoot, "dir");
    const aliasConfig = loadConfig({
      KONTROL_ALLOWED_ROOTS: aliasRoot,
      KONTROL_WORKTREE_ROOT: join(aliasRoot, ".kontrol", "alias-worktrees"),
      KONTROL_AGENT_DIR: agentDir,
      KONTROL_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const aliasWorkspace = await new WorkspaceRegistry(aliasConfig).openWorkspace({
      path: join(aliasRoot, "git-project"),
      mode: "worktree",
    });
    assert.equal(aliasWorkspace.workspace.sourceRoot, join(aliasRoot, "git-project"));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
