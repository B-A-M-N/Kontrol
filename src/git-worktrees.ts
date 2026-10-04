import { randomBytes } from "node:crypto";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { controlPlaneGit } from "./git-runner.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";

export class GitWorktreeError extends Error {
  constructor(
    readonly code:
      | "GIT_NOT_AVAILABLE"
      | "GIT_REPOSITORY_NOT_FOUND"
      | "GIT_REPOSITORY_HAS_NO_COMMITS"
      | "GIT_INVALID_BASE_REF"
      | "GIT_WORKTREE_CREATE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "GitWorktreeError";
  }
}

export interface ManagedWorktree {
  sourceRoot: string;
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export async function createManagedWorktree(input: {
  sourcePath: string;
  baseRef?: string;
  config: ServerConfig;
}): Promise<ManagedWorktree> {
  const sourcePath = assertAllowedPath(input.sourcePath, input.config.allowedRoots);

  try {
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isDirectory()) {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_NOT_FOUND",
        `Cannot open workspace in worktree mode because the source path is not a directory: ${input.sourcePath}`,
      );
    }
  } catch (error) {
    if (error instanceof GitWorktreeError) throw error;
    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because the source path does not exist: ${input.sourcePath}`,
    );
  }

  const sourceRoot = await resolveGitRoot(sourcePath, input.config.allowedRoots);
  const baseRef = input.baseRef ?? "HEAD";
  const baseSha = await resolveBaseCommit(sourceRoot, baseRef);
  const dirtySource = (await git(["status", "--porcelain=v1"], sourceRoot)).trim().length > 0;
  const worktreePath = managedWorktreePath({
    worktreeRoot: input.config.worktreeRoot,
    repoRoot: sourceRoot,
  });

  await mkdir(input.config.worktreeRoot, { recursive: true });
  assertAllowedPath(worktreePath, [input.config.worktreeRoot]);

  try {
    await git(["worktree", "add", "--detach", worktreePath, baseSha], sourceRoot);
  } catch (error) {
    await rm(worktreePath, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new GitWorktreeError(
      "GIT_WORKTREE_CREATE_FAILED",
      `Git failed to create the managed worktree. ${message}`,
    );
  }

  return {
    sourceRoot,
    path: worktreePath,
    baseRef,
    baseSha,
    dirtySource,
    detached: true,
    managed: true,
  };
}

export async function resolveManagedWorktreeSourceRoot(sourcePath: string, config: ServerConfig): Promise<string> {
  const allowedSourcePath = assertAllowedPath(sourcePath, config.allowedRoots);
  return resolveGitRoot(allowedSourcePath, config.allowedRoots);
}

export interface ManagedWorktreeDisposition {
  pathExists: boolean;
  registered: boolean;
  cleanToBase: boolean;
  headSha?: string;
  reason?: string;
}

/** Inspect only; dirty or divergent worktrees remain available for explicit disposition. */
export async function inspectManagedWorktree(input: {
  sourceRoot: string;
  path: string;
  baseSha: string;
  config: ServerConfig;
}): Promise<ManagedWorktreeDisposition> {
  const managedRoot = await realpath(input.config.worktreeRoot).catch(() => resolve(input.config.worktreeRoot));
  const candidatePath = resolve(input.path);
  if (candidatePath === managedRoot || !isPathInsideRoot(candidatePath, managedRoot)) {
    return { pathExists: false, registered: false, cleanToBase: false, reason: "path_outside_managed_root" };
  }
  const sourceRoot = await assertGitRootAllowed(input.sourceRoot, input.config.allowedRoots);
  const pathExists = await stat(candidatePath).then((value) => value.isDirectory()).catch(() => false);
  if (pathExists) {
    const canonicalCandidatePath = await realpath(candidatePath);
    if (!isPathInsideRoot(canonicalCandidatePath, managedRoot)) {
      return { pathExists: false, registered: false, cleanToBase: false, reason: "path_outside_managed_root" };
    }
  }
  const list = await controlPlaneGit(sourceRoot, ["worktree", "list", "--porcelain"], { maxBuffer: 10 * 1024 * 1024 });
  const registeredPaths = list.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)));
  const registered = registeredPaths.includes(candidatePath);
  if (!pathExists || !registered) {
    return { pathExists, registered, cleanToBase: false, reason: !pathExists ? "worktree_path_missing" : "not_registered_with_source_repository" };
  }
  const [status, head] = await Promise.all([
    controlPlaneGit(candidatePath, ["status", "--porcelain=v1"], { maxBuffer: 10 * 1024 * 1024 }),
    controlPlaneGit(candidatePath, ["rev-parse", "HEAD"], { maxBuffer: 1024 * 1024 }),
  ]);
  const headSha = head.stdout.trim();
  const cleanToBase = status.stdout.trim().length === 0 && headSha === input.baseSha;
  return {
    pathExists,
    registered,
    cleanToBase,
    headSha,
    reason: cleanToBase ? undefined : status.stdout.trim().length > 0 ? "working_tree_dirty" : "head_differs_from_creation_base",
  };
}

/** Remove only a clean detached worktree that still points at its creation base. */
export async function removeCleanManagedWorktree(input: {
  sourceRoot: string;
  path: string;
  baseSha: string;
  config: ServerConfig;
}): Promise<void> {
  const disposition = await inspectManagedWorktree(input);
  if (!disposition.pathExists || !disposition.registered || !disposition.cleanToBase) {
    throw new Error(`Managed worktree is not safe to remove: ${disposition.reason ?? "unknown disposition"}`);
  }
  const sourceRoot = await assertGitRootAllowed(input.sourceRoot, input.config.allowedRoots);
  await controlPlaneGit(sourceRoot, ["worktree", "remove", resolve(input.path)], { maxBuffer: 10 * 1024 * 1024 });
}

async function resolveGitRoot(path: string, allowedRoots: string[]): Promise<string> {
  try {
    const output = await git(["rev-parse", "--show-toplevel"], path);
    return await assertGitRootAllowed(output.trim(), allowedRoots);
  } catch (error) {
    if (isGitUnavailable(error)) {
      throw new GitWorktreeError(
        "GIT_NOT_AVAILABLE",
        "Cannot open workspace in worktree mode because Git is not available on this machine.",
      );
    }

    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because this path is not inside a Git repository: ${path}. Use mode=\"checkout\" to work directly in this directory, or initialize Git and create an initial commit first.`,
    );
  }
}

async function assertGitRootAllowed(gitRoot: string, allowedRoots: string[]): Promise<string> {
  try {
    return assertAllowedPath(gitRoot, allowedRoots);
  } catch {
    const canonicalGitRoot = await realpath(gitRoot);
    for (const allowedRoot of allowedRoots) {
      const canonicalAllowedRoot = await realpath(allowedRoot).catch(() => undefined);
      if (!canonicalAllowedRoot || !isPathInsideRoot(canonicalGitRoot, canonicalAllowedRoot)) {
        continue;
      }

      const logicalGitRoot = resolve(allowedRoot, relative(canonicalAllowedRoot, canonicalGitRoot));
      return assertAllowedPath(logicalGitRoot, allowedRoots);
    }

    return assertAllowedPath(canonicalGitRoot, allowedRoots);
  }
}

async function resolveBaseCommit(sourceRoot: string, baseRef: string): Promise<string> {
  try {
    return (await git(["rev-parse", "--verify", `${baseRef}^{commit}`], sourceRoot)).trim();
  } catch (error) {
    if (baseRef === "HEAD") {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_HAS_NO_COMMITS",
        "Cannot open workspace in worktree mode because the repository has no commits yet. Create an initial commit first, or use mode=\"checkout\".",
      );
    }

    throw new GitWorktreeError(
      "GIT_INVALID_BASE_REF",
      `Cannot open workspace in worktree mode because baseRef ${JSON.stringify(baseRef)} does not resolve to a commit.`,
    );
  }
}

function managedWorktreePath(input: { worktreeRoot: string; repoRoot: string }): string {
  const repoName = sanitizePathSegment(basename(input.repoRoot)) || "repo";
  const worktreeId = randomBytes(4).toString("hex");
  return join(input.worktreeRoot, `${repoName}-${worktreeId}`);
}

function sanitizePathSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    // Hardened control-plane runner: scrubbed env, hooks/filters disabled.
    const { stdout } = await controlPlaneGit(cwd, args, { maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (isGitUnavailable(error)) throw error;

    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const stdout = typeof error === "object" && error && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "").trim()
      : "";
    const details = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(details);
  }
}

function isGitUnavailable(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}
