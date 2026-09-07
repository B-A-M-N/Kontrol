/**
 * P1 (audit): checkpoint coverage blind spots.
 *
 * Review checkpoints exclude generated/cache trees (node_modules, dist, .venv,
 * …) and git checkpoints do not represent git-ignored material. A structured
 * mutation (write/edit/apply_patch) into such a location therefore produces a
 * review submission whose diff LOOKS complete while hiding the change. This
 * module classifies mutation paths against the active checkpoint backend and
 * produces the coverage record carried on the submission.
 *
 * Shell is deliberately NOT classified here: shell already carries broad
 * authority and arbitrary side effects cannot be attributed to paths.
 */
import { relative, isAbsolute, resolve, sep } from "node:path";
import { DEFAULT_SNAPSHOT_EXCLUDED_DIRECTORIES } from "./filesystem-snapshot-store.js";
import type { WorkspaceSnapshotKind } from "./review-checkpoints.js";

export interface CheckpointCoverage {
  /** Workspace-relative paths structured mutations touched that the active
   * checkpoint backend cannot represent in a review diff. */
  uncoveredPaths: string[];
  /** The backend the coverage was classified against. */
  backend: WorkspaceSnapshotKind;
  /** Human-readable reason each path is outside coverage (parallel to
   * uncoveredPaths). */
  reasons: string[];
}

/** Workspace-relative POSIX path of an absolute path under root, or undefined
 * when the path escapes the root (escape is its own coverage problem but is
 * rejected upstream by the confinement checks). */
export function workspaceRelativePath(root: string, absoluteOrRelative: string): string | undefined {
  if (!isAbsolute(absoluteOrRelative)) {
    return absoluteOrRelative.split(sep).join("/").replace(/^\.\//, "");
  }
  const rel = relative(resolve(root), resolve(absoluteOrRelative));
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/**
 * True when the given workspace-relative path is inside a tree the checkpoint
 * layer excludes: either a default/operator-excluded directory name, or — for
 * the git backend — material matched by .gitignore semantics is ALSO outside
 * a `git add -A` checkpoint; that part is reported by the caller using the
 * reason string, since gitignore evaluation belongs to the workspace's git
 * config and cannot be cheaply re-derived here.
 */
export function isExcludedFromCheckpoint(path: string, extraExcludedDirectories?: Iterable<string>): boolean {
  const normalized = path.split(sep).join("/");
  const segments = normalized.split("/").filter(Boolean);
  // The file name itself is not an exclusion; only directory segments are.
  for (const segment of segments.slice(0, -1)) {
    if (DEFAULT_SNAPSHOT_EXCLUDED_DIRECTORIES.has(segment)) return true;
    if (extraExcludedDirectories) {
      for (const extra of extraExcludedDirectories) if (extra === segment) return true;
    }
  }
  return false;
}

/** Filesystem backend: a path is uncovered iff it falls under an excluded
 * directory (those trees are never captured). */
export function classifyFilesystemCoverage(
  paths: string[],
  extraExcludedDirectories?: Iterable<string>,
): CheckpointCoverage {
  const uncoveredPaths: string[] = [];
  const reasons: string[] = [];
  for (const path of paths) {
    if (isExcludedFromCheckpoint(path, extraExcludedDirectories)) {
      uncoveredPaths.push(path);
      reasons.push("inside a directory the filesystem checkpoint excludes (generated/cache tree)");
    }
  }
  return { uncoveredPaths, backend: "filesystem", reasons };
}

/**
 * Git backend: `git add -A -- <workspace>` represents the working tree
 * EXCEPT paths matched by .gitignore. The excluded-directory trees overlap
 * (node_modules is normally also gitignored) but are not identical, so both
 * reasons are reported; the gitignore check itself runs via the provided
 * checker (see recordGitIgnoredPaths' caller) to keep this module pure.
 */
export function classifyGitCoverage(
  paths: string[],
  isGitIgnored: (path: string) => boolean,
  extraExcludedDirectories?: Iterable<string>,
): CheckpointCoverage {
  const uncoveredPaths: string[] = [];
  const reasons: string[] = [];
  for (const path of paths) {
    const excludedDir = isExcludedFromCheckpoint(path, extraExcludedDirectories);
    const ignored = isGitIgnored(path);
    if (excludedDir || ignored) {
      uncoveredPaths.push(path);
      reasons.push(
        excludedDir && ignored
          ? "inside an excluded checkpoint directory AND git-ignored"
          : excludedDir
            ? "inside a directory the checkpoint excludes"
            : "git-ignored, so `git add -A` checkpoints do not represent it",
      );
    }
  }
  return { uncoveredPaths, backend: "git", reasons };
}
