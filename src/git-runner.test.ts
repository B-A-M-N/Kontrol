/**
 * Adversarial tests for the control-plane Git runner.
 *
 * Threat model: an untrusted repository configures hooks (post-checkout,
 * reference-transaction), clean/smudge filters, or a credential helper that
 * try to execute repository-controlled programs during nominally internal
 * Kontrol Git operations, or to exfiltrate control-plane secrets from the
 * environment. The runner must neutralize all of these.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { controlPlaneGit, buildControlPlaneGitEnvironment } from "./git-runner.js";

const tmp = await mkdtemp(join(tmpdir(), "kontrol-git-runner-test-"));
const markers = join(tmp, "markers");
await mkdir(markers, { recursive: true });

function runGit(cwd: string, args: string[]): string {
  // Fixture-prep git must ALSO be neutralized: it is not under test and
  // otherwise fires the hostile hooks/filters before we exercise the runner.
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "filter.evil.clean=cat", "-c", "filter.evil.smudge=cat", "-c", "filter.evil.process=", "-c", "credential.helper=", ...args],
    { cwd, encoding: "utf8" },
  );
}

// --- Set up a hostile repository -------------------------------------------
const repo = join(tmp, "hostile-repo");
runGit(tmp, ["init", repo]);
runGit(repo, ["config", "user.email", "test@example.test"]);
runGit(repo, ["config", "user.name", "Test"]);

// Malicious post-checkout + reference-transaction + pre-auto-gc hooks.
const hookScript = "#!/bin/sh\n touch \"" + join(markers, "hook-fired") + "\"\n env > " + join(markers, "hook-env.txt") + "\n exit 0\n";
for (const hook of ["post-checkout", "reference-transaction", "pre-auto-gc", "post-commit"]) {
  const hookPath = join(repo, ".git", "hooks", hook);
  await writeFile(hookPath, hookScript);
  await chmod(hookPath, 0o755);
}

// Malicious clean/smudge filter declared in LOCAL repo config.
await writeFile(join(repo, ".gitattributes"), "* filter=evil filter.evil.required=true\n");

// Filter program writes a marker if it is ever executed.
const filterScript = "#!/bin/sh\n touch \"" + join(markers, "filter-fired") + "\"\n cat\n";
const filterBin = join(tmp, "evil-filter");
await writeFile(filterBin, filterScript);
await chmod(filterBin, 0o755);
runGit(repo, ["config", "filter.evil.clean", filterBin]);
runGit(repo, ["config", "filter.evil.smudge", filterBin]);
runGit(repo, ["config", "filter.evil.process", filterBin]);

// Credential helper that would fire on any fetch.
runGit(repo, ["config", "credential.helper", "!f() { touch " + join(markers, "cred-fired") + "; }; f"]);

// Poison a control-plane-looking secret into the parent environment to prove
// it never reaches Git child processes through wholesale inheritance.
process.env.KONTROL_ACP_AGENT_SECRET = "super-secret-value";

try {
  // Commit something so HEAD exists.
  await writeFile(join(repo, "file.txt"), "hello\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "initial"]);

  // --- Control-plane operations over the hostile repo ----------------------
  await controlPlaneGit(repo, ["rev-parse", "--show-toplevel"]);
  // Temporary-index snapshot pattern used by review checkpoints:
  const { stdout: treeOut } = await controlPlaneGit(repo, ["read-tree", "HEAD"]);
  void treeOut;
  await controlPlaneGit(repo, ["add", "-A", "--", "."]);
  await controlPlaneGit(repo, ["write-tree"]);
  // Worktree materialization triggers checkout machinery.
  await controlPlaneGit(repo, ["update-ref", "refs/kontrol/test/baseline", "HEAD"]);
  const wtPath = join(tmp, "wt");
  await controlPlaneGit(repo, ["worktree", "add", "--detach", wtPath, "HEAD"]);

  // Give lazy hook/filter invocations a moment, then assert nothing fired.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const hookFired = await import("node:fs/promises").then((fs) =>
    fs.stat(join(markers, "hook-fired")).then(() => true, () => false),
  );
  const filterFired = await import("node:fs/promises").then((fs) =>
    fs.stat(join(markers, "filter-fired")).then(() => true, () => false),
  );
  const credFired = await import("node:fs/promises").then((fs) =>
    fs.stat(join(markers, "cred-fired")).then(() => true, () => false),
  );

  assert.equal(hookFired, false, "repository hooks must never execute in control-plane Git operations");
  assert.equal(filterFired, false, "repository clean/smudge filters must never execute in control-plane Git operations");
  assert.equal(credFired, false, "credential helpers must never execute in control-plane Git operations");

  // Hook environment file must not exist either (no hook ran at all).
  let hookEnvLeaked = false;
  try {
    const envText = await (await import("node:fs/promises")).readFile(join(markers, "hook-env.txt"), "utf8");
    hookEnvLeaked = envText.includes("super-secret-value");
  } catch {
    // no env dump at all — good
  }
  assert.equal(hookEnvLeaked, false, "control-plane secrets must not reach any spawned hook process");

  // --- Environment hygiene --------------------------------------------------
  const env = buildControlPlaneGitEnvironment();
  assert.match(env.GIT_TERMINAL_PROMPT!, /0/);
  // Scrubbed: KONTROL_* secret must not be present.
  assert.equal(env.KONTROL_ACP_AGENT_SECRET, undefined, "KONTROL_* secrets must not enter the Git environment");

  // Extra env still flows through (GIT_INDEX_FILE pattern).
  const env2 = buildControlPlaneGitEnvironment({ GIT_INDEX_FILE: "/tmp/x" });
  assert.equal(env2.GIT_INDEX_FILE, "/tmp/x");

  console.log("git-runner.test.ts: all adversarial assertions passed");
} finally {
  delete process.env.KONTROL_ACP_AGENT_SECRET;
  await rm(tmp, { recursive: true, force: true });
}
