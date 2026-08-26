import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildChildEnvironment } from "./process-environment.js";

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Static config overrides applied to EVERY control-plane Git invocation.
 *
 * - core.hooksPath points at a non-directory path so repository-configured
 *   hooks (post-checkout, reference-transaction, pre-auto-gc, ...) never run.
 *   A malicious/untrusted repository must not be able to turn a nominally
 *   internal Kontrol Git operation into arbitrary code execution outside the
 *   ordinary bash policy decision.
 * - credential.helper is emptied so Git cannot invoke a credential helper.
 * - fsmonitor/untrackedCache are disabled: core.fsmonitor may name a command
 *   that Git would otherwise spawn against repository-controlled config.
 */
const HARDCENED_CONFIG_OVERRIDES: string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
];

/**
 * Environment for control-plane Git. Built exclusively from the shared child
 * environment boundary — NEVER wholesale `process.env` inheritance — so
 * KONTROL_* / ACP / OAuth / tunnel / reviewer secrets cannot leak into Git or any
 * external filter/helper process Git spawns. Prompting and askpass are
 * explicitly disabled so a private remote can fail instead of hanging or
 * harvesting credentials.
 */
export function buildControlPlaneGitEnvironment(
  extra?: NodeJS.ProcessEnv,
): Record<string, string> {
  return {
    ...buildChildEnvironment(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
    GIT_EDITOR: "true",
    EDITOR: "true",
    ...extra,
  };
}

/**
 * Clean/smudge/process filters declared in the repository's LOCAL config run
 * during `git add`, checkout, and worktree materialization. They are
 * repository-controlled programs, so each discovered filter name is
 * overridden back to `cat` (which strips any filter effect) with `-c` flags,
 * which beat every config file including the local one. Results are cached
 * per repository root; the discovery call itself executes nothing
 * repository-controlled.
 */
const filterOverrideCache = new Map<string, string[]>();

async function discoverFilterOverrides(gitRoot: string): Promise<string[]> {
  const cached = filterOverrideCache.get(gitRoot);
  if (cached) return cached;

  const overrides: string[] = [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "config",
        "--local",
        "--name-only",
        "--get-regexp",
        "^filter\\.",
      ],
      {
        cwd: gitRoot,
        env: buildControlPlaneGitEnvironment(),
        timeout: 10_000,
      },
    );
    const names = new Set<string>();
    for (const line of stdout.split("\n")) {
      // e.g. "filter.lfs.clean" -> "lfs"
      const match = /^filter\.([^.]+)\./.exec(line.trim());
      if (match?.[1]) names.add(match[1]);
    }
    for (const name of names) {
      for (const phase of ["clean", "smudge", "process"]) {
        overrides.push("-c", `filter.${name}.${phase}=cat`);
      }
    }
  } catch {
    // No local filter config (or Git unavailable) -> nothing to override.
  }

  filterOverrideCache.set(gitRoot, overrides);
  return overrides;
}

async function resolveGitDirectory(cwd: string): Promise<string | undefined> {
  // Best-effort root for caching; falls back to cwd when rev-parse fails.
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      env: buildControlPlaneGitEnvironment(),
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function controlPlaneGit(
  cwd: string,
  args: string[],
  options: { extraEnv?: NodeJS.ProcessEnv; maxBuffer?: number; timeoutMs?: number } = {},
): Promise<GitCommandResult> {
  const root = await resolveGitDirectory(cwd);
  const filterOverrides = await discoverFilterOverrides(root ?? cwd);

  const { stdout, stderr } = await execFileAsync(
    "git",
    [...HARDCENED_CONFIG_OVERRIDES, ...filterOverrides, ...args],
    {
      cwd,
      env: buildControlPlaneGitEnvironment(options.extraEnv),
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      timeout: options.timeoutMs ?? 30_000,
    },
  );

  return { stdout, stderr };
}
