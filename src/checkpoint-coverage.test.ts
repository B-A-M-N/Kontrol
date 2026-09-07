/**
 * P1 (audit): checkpoint coverage blind spots.
 *
 * Unit coverage for the pure classifier plus an end-to-end pass through the
 * checkpoint manager: a structured mutation into an excluded tree must be
 * reported as uncovered on both backends, and a plain mutation must not be.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  isExcludedFromCheckpoint,
  classifyFilesystemCoverage,
  classifyGitCoverage,
  workspaceRelativePath,
} from "./checkpoint-coverage.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";

// ── Pure classifier ──────────────────────────────────────

// Only directory SEGMENTS count; a file merely NAMED like an excluded tree at
// the workspace root is covered.
assert.equal(isExcludedFromCheckpoint("node_modules/x/index.js"), true);
assert.equal(isExcludedFromCheckpoint("packages/app/dist/bundle.js"), true);
assert.equal(isExcludedFromCheckpoint("src/.venv/lib.py"), true);
assert.equal(isExcludedFromCheckpoint("node_modules"), false, "file named node_modules at root is not inside an excluded tree");
assert.equal(isExcludedFromCheckpoint("src/main.ts"), false);
assert.equal(isExcludedFromCheckpoint("dist",), false, "bare name is a file path, not a directory segment");

// workspaceRelativePath normalization.
assert.equal(workspaceRelativePath("/tmp/r", "/tmp/r/a/b.txt"), "a/b.txt");
assert.equal(workspaceRelativePath("/tmp/r", "a/b.txt"), "a/b.txt");
assert.equal(workspaceRelativePath("/tmp/r", "/tmp/other/x"), undefined);

const fsCoverage = classifyFilesystemCoverage(["src/app.ts", "node_modules/pkg/index.js"]);
assert.deepEqual(fsCoverage.uncoveredPaths, ["node_modules/pkg/index.js"]);
assert.equal(fsCoverage.backend, "filesystem");
assert.equal(fsCoverage.reasons.length, 1);

const gitCoverage = classifyGitCoverage(
  ["src/app.ts", "node_modules/pkg/index.js", ".env.local"],
  (path) => path === ".env.local" || path.startsWith("node_modules/"),
);
assert.deepEqual(gitCoverage.uncoveredPaths, ["node_modules/pkg/index.js", ".env.local"]);
assert.equal(gitCoverage.backend, "git");
// Both-reason case is named explicitly.
assert.match(gitCoverage.reasons[0], /AND git-ignored/);
assert.match(gitCoverage.reasons[1], /git-ignored/);

// ── Manager integration (filesystem backend) ─────────────

{
  const state = mkdtempSync(join(tmpdir(), "kontrol-coverage-fs-"));
  const root = mkdtempSync(join(tmpdir(), "kontrol-coverage-root-"));
  writeFileSync(join(root, "app.ts"), "export {};\n");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", "hidden.txt"), "invisible to checkpoints\n");
  const checkpoints = createReviewCheckpointManager({ snapshotStoreRoot: join(state, "snapshots") });

  // Before any mutation: fully covered.
  const before = await checkpoints.checkpointCoverage({ workspaceId: "ws-coverage", root });
  assert.deepEqual(before.uncoveredPaths, []);

  await checkpoints.recordMutations({ workspaceId: "ws-coverage", root, paths: [
    join(root, "src", "main.ts"),
    join(root, "node_modules", "hidden.txt"),
  ] });
  const after = await checkpoints.checkpointCoverage({ workspaceId: "ws-coverage", root });
  assert.deepEqual(after.uncoveredPaths, ["node_modules/hidden.txt"]);
  assert.equal(after.backend, "filesystem");
  assert.match(after.reasons[0], /excludes/);

  // Absolute AND relative recordings converge on the same normalized set.
  await checkpoints.recordMutations({ workspaceId: "ws-coverage", root, paths: ["node_modules/hidden.txt"] });
  const deduped = await checkpoints.checkpointCoverage({ workspaceId: "ws-coverage", root });
  assert.equal(deduped.uncoveredPaths.length, 1);

  // Escape attempts are ignored (confinement rejects them upstream).
  await checkpoints.recordMutations({ workspaceId: "ws-coverage", root, paths: ["/etc/passwd"] });
  const escaped = await checkpoints.checkpointCoverage({ workspaceId: "ws-coverage", root });
  assert.equal(escaped.uncoveredPaths.length, 1);

  // An unknown workspace still has no state (nothing was ever opened under
  // that id), so classification is fully covered rather than a crash.

  checkpoints.clearRecordedMutations({ workspaceId: "ws-coverage" });
  assert.deepEqual((await checkpoints.checkpointCoverage({ workspaceId: "ws-coverage", root })).uncoveredPaths, []);

  checkpoints.drain();
}

// ── Manager integration (git backend: git-ignored material) ──

{
  const state = mkdtempSync(join(tmpdir(), "kontrol-coverage-git-"));
  const root = mkdtempSync(join(tmpdir(), "kontrol-coverage-git-root-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: root });
  run(["init", "-q"]);
  run(["config", "user.email", "test@kontrol.local"]);
  run(["config", "user.name", "Kontrol Coverage Test"]);
  writeFileSync(join(root, ".gitignore"), "secret.txt\n");
  writeFileSync(join(root, "tracked.txt"), "hi\n");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "init"]);
  const checkpoints = createReviewCheckpointManager({ snapshotStoreRoot: join(state, "snapshots") });
  // Open the workspace so the git backend initializes.
  await checkpoints.reviewChanges({ workspaceId: "ws-coverage-git", root, since: "workspace_open", markReviewed: false });

  await checkpoints.recordMutations({ workspaceId: "ws-coverage-git", root, paths: [
    join(root, "tracked.txt"),
    join(root, "secret.txt"),
  ] });
  const coverage = await checkpoints.checkpointCoverage({ workspaceId: "ws-coverage-git", root });
  assert.equal(coverage.backend, "git");
  assert.deepEqual(coverage.uncoveredPaths, ["secret.txt"], `got: ${JSON.stringify(coverage)}`);
  assert.match(coverage.reasons[0], /git-ignored/);
  checkpoints.drain();
}

console.log("checkpoint-coverage: classifier + manager integration passed");
