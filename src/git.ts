import { createHash } from "node:crypto";
import { controlPlaneGit, type GitCommandResult } from "./git-runner.js";

export type { GitCommandResult };

export interface GitEligibility {
  ok: boolean;
  gitRoot?: string;
  reason?: "not_git" | "no_head";
  message?: string;
}

/**
 * All internal Kontrol Git operations run through the hardened control-plane
 * runner: scrubbed environment (never wholesale `process.env`), no repository
 * hooks or filters, no credential prompting. See git-runner.ts.
 */
export async function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number; timeoutMs?: number } = {},
): Promise<GitCommandResult> {
  return controlPlaneGit(cwd, args, {
    extraEnv: options.env,
    maxBuffer: options.maxBuffer,
    timeoutMs: options.timeoutMs,
  });
}

export async function getGitEligibility(cwd: string): Promise<GitEligibility> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return {
      ok: false,
      reason: "not_git",
      message: "workspace is not inside a git repository",
    };
  }

  const gitRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  try {
    await git(gitRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  } catch {
    return {
      ok: false,
      gitRoot,
      reason: "no_head",
      message: "repository has no HEAD commit",
    };
  }

  return { ok: true, gitRoot };
}

export function safeWorkspaceRefSegment(workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9._-]/g, "-");
  return safe.length > 0 ? safe : createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
}
