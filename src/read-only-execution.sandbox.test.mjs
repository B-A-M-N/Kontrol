import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReadOnlySandboxCommand, probeReadOnlyExecutionSandbox } from "./read-only-execution.mjs";

const root = mkdtempSync(join(tmpdir(), "kontrol-read-only-sandbox-"));
try {
  const workspaceRoot = join(root, "workspace");
  const outsideFile = join(root, "outside.txt");
  mkdirSync(workspaceRoot);
  writeFileSync(join(workspaceRoot, "source.txt"), "source stays unchanged\n");
  writeFileSync(outsideFile, "outside stays unchanged\n");
  symlinkSync(outsideFile, join(workspaceRoot, "outside-link"));
  execFileSync("git", ["init", workspaceRoot], { stdio: "ignore" });
  const sourceHash = createHash("sha256").update(readFileSync(join(workspaceRoot, "source.txt"))).digest("hex");
  const gitConfigBefore = readFileSync(join(workspaceRoot, ".git", "config"));
  const outsideHash = createHash("sha256").update(readFileSync(outsideFile)).digest("hex");

  let sandboxReady = false;
  try {
    probeReadOnlyExecutionSandbox({ workspaceRoot });
    sandboxReady = true;
  } catch (error) {
    assert.equal(error?.code, "sandbox_unavailable", "an unusable confinement backend fails closed with a typed result");
    assert.equal(createHash("sha256").update(readFileSync(join(workspaceRoot, "source.txt"))).digest("hex"), sourceHash);
    assert.equal(createHash("sha256").update(readFileSync(outsideFile)).digest("hex"), outsideHash);
    console.log(`read-only-execution.sandbox.test.mjs: sandbox unavailable; fail-closed verified (${error.message})`);
  }

  if (sandboxReady) {
    assert.equal(probeReadOnlyExecutionSandbox({ workspaceRoot, networkPolicy: "host" }), true,
      "the explicitly authorized host-network sandbox starts while retaining filesystem confinement");
    const script = [
      "set -eu",
      "test \"$(cat /workspace/source.txt)\" = 'source stays unchanged'",
      "if printf changed >> /workspace/source.txt 2>/dev/null; then exit 41; fi",
      "if git -C /workspace config user.name attacker >/dev/null 2>&1; then exit 42; fi",
      "if git -C /workspace add source.txt >/dev/null 2>&1; then exit 43; fi",
      "if printf changed > /workspace/outside-link 2>/dev/null; then exit 44; fi",
      "if node -e \"require('node:fs').writeFileSync('/workspace/helper-write.txt','changed')\" >/dev/null 2>&1; then exit 45; fi",
      "printf scratch > /tmp/kontrol-sandbox-scratch.txt",
      "test \"$(cat /tmp/kontrol-sandbox-scratch.txt)\" = scratch",
    ].join("\n");
    const launch = buildReadOnlySandboxCommand({
      workspaceRoot,
      executable: "/bin/sh",
      args: ["-c", script],
      env: {},
    });
    const result = spawnSync(launch.command, launch.args, { encoding: "utf8", timeout: 15_000, env: launch.env });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || `sandbox exited ${result.status}`);
    const launcherPath = join(root, "hermes-acp-shim");
    const siblingPythonPath = join(root, "hermes-python-shim");
    writeFileSync(launcherPath, '#!/bin/sh\nexec "$(dirname -- "$(realpath -- "$0")")/python" "$@"\n');
    writeFileSync(siblingPythonPath, '#!/bin/sh\nprintf "sibling-python:%s\\n" "$*"\n');
    chmodSync(launcherPath, 0o755);
    chmodSync(siblingPythonPath, 0o755);
    const launcherProbe = buildReadOnlySandboxCommand({
      workspaceRoot,
      executable: launcherPath,
      executableTarget: "/opt/kontrol/hermes-bin/hermes-acp",
      args: ["--check"],
      bindFiles: [{ source: siblingPythonPath, target: "/opt/kontrol/hermes-bin/python" }],
    });
    const launcherResult = spawnSync(launcherProbe.command, launcherProbe.args, {
      encoding: "utf8",
      timeout: 15_000,
      env: launcherProbe.env,
    });
    assert.equal(launcherResult.error, undefined, launcherResult.error?.message);
    assert.equal(launcherResult.status, 0, launcherResult.stderr || `sibling interpreter probe exited ${launcherResult.status}`);
    assert.match(launcherResult.stdout, /sibling-python:--check/,
      "a Hermes-style entrypoint resolves Python mounted beside it in the confined filesystem");
    assert.equal(createHash("sha256").update(readFileSync(join(workspaceRoot, "source.txt"))).digest("hex"), sourceHash,
      "shell writes and helper-process writes leave the source file unchanged");
    assert.deepEqual(readFileSync(join(workspaceRoot, ".git", "config")), gitConfigBefore,
      "Git config and index mutation attempts leave the source repository unchanged");
    assert.equal(createHash("sha256").update(readFileSync(outsideFile)).digest("hex"), outsideHash,
      "a symlink to a host path cannot mutate its target");
    console.log("read-only-execution.sandbox.test.mjs: confined mutation attempts were rejected");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
