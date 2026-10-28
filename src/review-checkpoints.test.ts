import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createReviewCheckpointManager, GitCheckpointCaptureCoordinator } from "./review-checkpoints.js";

const execFileAsync = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), "kontrol-review-checkpoints-test-")));

try {
  const coordinator = new GitCheckpointCaptureCoordinator();
  let duplicateCaptureCount = 0;
  const duplicateCapture = () => coordinator.run("/tmp/repo", "workspace-a", async () => {
    duplicateCaptureCount += 1;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    return "same-tree";
  });
  const [duplicateA, duplicateB] = await Promise.all([duplicateCapture(), duplicateCapture()]);
  assert.equal(duplicateA, "same-tree");
  assert.equal(duplicateB, "same-tree");
  assert.equal(duplicateCaptureCount, 1, "overlapping captures of the same scope are single-flight");

  let activeCaptures = 0;
  let maxActiveCaptures = 0;
  const serializedCapture = (scope: string) => coordinator.run("/tmp/serialized-repo", scope, async () => {
    activeCaptures += 1;
    maxActiveCaptures = Math.max(maxActiveCaptures, activeCaptures);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    activeCaptures -= 1;
    return scope;
  });
  const [scopeA, scopeB] = await Promise.all([serializedCapture("a"), serializedCapture("b")]);
  assert.deepEqual([scopeA, scopeB], ["a", "b"]);
  assert.equal(maxActiveCaptures, 1, "different workspace scopes in one repository serialize their temporary index captures");

  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Kontrol Test"]);
  await git(root, ["config", "user.email", "kontrol-test@example.invalid"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["add", "README.md"]);
  const tree = await git(root, ["write-tree"]);
  const commit = await git(root, ["commit-tree", tree, "-m", "Initial commit"]);
  await git(root, ["update-ref", "HEAD", commit]);

  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_review", root });

  const clean = await manager.reviewChanges({ workspaceId: "ws_review", root });
  assert.equal(clean.summary.files, 0);
  assert.equal(clean.patch, "");
  assert.match(clean.result, /No changes/);

  const rootAlias = join(tmpdir(), `kontrol-review-checkpoints-alias-${process.pid}`);
  await symlink(root, rootAlias, process.platform === "win32" ? "junction" : "dir");
  try {
    const aliasManager = createReviewCheckpointManager();
    await aliasManager.initializeWorkspace({ workspaceId: "ws_review_alias", root: rootAlias });
    const aliasClean = await aliasManager.reviewChanges({ workspaceId: "ws_review_alias", root: rootAlias });
    assert.equal(aliasClean.summary.files, 0, "Git checkpoint paths stay inside the repository when opened through an OS path alias");
  } finally {
    await rm(rootAlias, { force: true });
  }

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  await writeFile(join(root, "new.txt"), "new\n");

  const firstReview = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: false,
  });
  assert.equal(firstReview.summary.files, 2);
  assert.equal(firstReview.summary.additions, 2);
  assert.equal(firstReview.summary.removals, 0);
  assert.equal(firstReview.files.some((file) => file.path === "README.md"), true);
  assert.equal(firstReview.files.some((file) => file.path === "new.txt"), true);
  assert.match(firstReview.patch, /world/);

  const stillUnreviewed = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: true,
  });
  assert.equal(stillUnreviewed.summary.files, 2);

  const afterReviewed = await manager.reviewChanges({ workspaceId: "ws_review", root });
  assert.equal(afterReviewed.summary.files, 0);

  await writeFile(join(root, "README.md"), "hello\nworld\nshown but unsubmitted\n");
  const presentationOnly = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    since: "last_shown",
    markReviewed: true,
  });
  assert.equal(presentationOnly.summary.files, 1);

  await writeFile(join(root, "README.md"), "hello\nworld\nshown but unsubmitted\nseparate transport baseline\n");
  const ownerA = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    since: "last_shown",
    markReviewed: true,
    presentationOwnerId: "transport-tab-a",
  });
  const ownerB = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    since: "last_shown",
    markReviewed: false,
    presentationOwnerId: "transport-tab-b",
  });
  assert.equal(ownerA.summary.files, ownerB.summary.files,
    "one Git transport's presentation baseline does not advance another's");
  assert.equal((await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    since: "last_shown",
    presentationOwnerId: "transport-tab-a",
  })).summary.files, 0, "the Git presentation owner sees its own advanced ref");

  const sessionReview = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    since: "work_session",
    workSessionId: "work_session_a",
    markReviewed: false,
  });
  assert.equal(sessionReview.summary.files, 2);
  assert.match(sessionReview.patch, /shown but unsubmitted/);

  await manager.commitReviewed({
    workspaceId: "ws_review",
    root,
    workSessionId: "work_session_a",
    snapshotCommit: sessionReview.snapshotCommit,
  });

  await writeFile(join(root, "correction.txt"), "round two\n");
  const correctionRound = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    since: "work_session",
    workSessionId: "work_session_a",
    markReviewed: false,
  });
  assert.equal(correctionRound.summary.files, 1);
  assert.equal(correctionRound.files[0]?.path, "correction.txt");

  const otherSession = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    since: "work_session",
    workSessionId: "work_session_b",
    markReviewed: false,
  });
  assert.equal(otherSession.summary.files, 3);

  await writeFile(join(root, ".gitattributes"), "*.failure filter=checkpointfailure\n");
  await writeFile(join(root, "trigger.failure"), "fail checkpoint capture\n");
  await git(root, ["config", "filter.checkpointfailure.clean", "false"]);
  await git(root, ["config", "filter.checkpointfailure.required", "true"]);
  const failingManager = createReviewCheckpointManager();
  await failingManager.initializeWorkspace({ workspaceId: "ws_checkpoint_failure", root });
  const failedCheckpoint = await failingManager.getSnapshotInfo({ workspaceId: "ws_checkpoint_failure", root });
  assert.equal(failedCheckpoint.available, false, "Git capture failure leaves the checkpoint unavailable");
  assert.equal(failedCheckpoint.checkpointError?.operation, "git add", "structured diagnostics identify the failing Git operation");
  assert.ok((failedCheckpoint.checkpointError?.stderr.length ?? Infinity) <= 1_000, "checkpoint stderr is bounded");
  assert.ok(failedCheckpoint.checkpointError?.stderr, "checkpoint failure includes the sanitized Git diagnostic");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}
