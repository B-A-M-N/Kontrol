import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findBubblewrap } from "../read-only-execution.mjs";
import type { ScheduledVerificationClaimInput, ScheduledVerificationExecution } from "./scheduled-job-store.js";
import { verifyScheduledJob } from "./scheduled-verification.js";
import { scheduledVerificationFingerprints } from "./scheduled-verification-projection.js";
import { parseScheduledVerificationCommand } from "./verification-profiles.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-scheduled-verification-"));
const workspaceRoot = join(root, "workspace");
const fakeBubblewrap = join(root, "bwrap");
const capturedCwd = join(root, "sandbox-cwd.txt");
const commandLaunches = join(root, "command-launches.txt");

function createVerificationJobs() {
  const executions = new Map<string, ScheduledVerificationExecution>();
  return {
    executions,
    claimVerificationExecution(input: ScheduledVerificationClaimInput) {
      const prior = executions.get(input.requestKey);
      if (prior) {
        if (prior.requestFingerprint !== input.requestFingerprint) throw new Error("Verification idempotency key was already used with different content.");
        return { execution: prior, owner: false };
      }
      const activeEquivalent = [...new Set(executions.values())].find((entry) => entry.status === "running"
        && entry.jobId === input.jobId
        && entry.workSessionId === input.workSessionId
        && entry.submissionId === input.submissionId
        && entry.reviewEpoch === input.reviewEpoch
        && entry.snapshotKind === input.snapshotKind
        && entry.snapshotRef === input.snapshotRef
        && entry.commandFingerprint === input.commandFingerprint
        && entry.policyFingerprint === input.policyFingerprint);
      if (activeEquivalent) {
        executions.set(input.requestKey, activeEquivalent);
        return { execution: activeEquivalent, owner: false };
      }
      const now = new Date().toISOString();
      const execution: ScheduledVerificationExecution = {
        ...input,
        id: `record:${input.executionIdentity}`,
        status: "running",
        createdAt: now,
        startedAt: now,
      };
      executions.set(input.requestKey, execution);
      return { execution, owner: true };
    },
    completeVerificationExecution({ executionId, reportText }: { executionId: string; reportText: string }) {
      const execution = [...executions.values()].find((entry) => entry.id === executionId)!;
      execution.status = "completed";
      execution.reportText = reportText;
      execution.reportSha256 = createHash("sha256").update(reportText, "utf8").digest("hex");
      execution.finishedAt = new Date().toISOString();
      return execution;
    },
    failVerificationExecution({ executionId, reason }: { executionId: string; reason: string }) {
      const execution = [...executions.values()].find((entry) => entry.id === executionId)!;
      execution.status = "failed";
      execution.failureReason = reason;
      execution.finishedAt = new Date().toISOString();
      return execution;
    },
  };
}

try {
  assert.deepEqual(parseScheduledVerificationCommand("python3 -m pytest -q tests/test_routes.py"), {
    command: "python3 -m pytest -q tests/test_routes.py",
    executable: "python3",
    args: ["-m", "pytest", "-q", "tests/test_routes.py"],
    profile: "python-pytest",
  }, "Python verification uses the constrained pytest profile");
  assert.deepEqual(parseScheduledVerificationCommand("cargo test --offline -p athena_core"), {
    command: "cargo test --offline -p athena_core",
    executable: "cargo",
    args: ["test", "--offline", "-p", "athena_core"],
    profile: "rust-cargo-test",
  }, "Rust verification uses the constrained cargo test profile");
  assert.throws(() => parseScheduledVerificationCommand("python3 -c print(1)"), /not permitted/);
  assert.throws(() => parseScheduledVerificationCommand("cargo run"), /only permits/);
  assert.throws(() => parseScheduledVerificationCommand("cargo test ../escape"), /may not escape/);

  const invalidPolicyFingerprint = scheduledVerificationFingerprints({
    policySnapshotJson: { verificationCommands: ["npm test; touch source.txt"] },
  });
  assert.deepEqual(invalidPolicyFingerprint.commands, [],
    "receipt fingerprinting tolerates invalid historical commands so read-only result retrieval remains available");
  assert.equal(invalidPolicyFingerprint.commandPolicyValid, false);

  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspaceRoot));
  await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({
    name: "scheduled-verification-fixture",
    private: true,
    scripts: {
      test: "node -e \"require('node:fs').writeFileSync('verification-output.txt', 'written in disposable snapshot')\"",
    },
  }));
  await writeFile(join(workspaceRoot, "source.txt"), "unchanged");
  await writeFile(fakeBubblewrap, [
    "#!/bin/sh",
    "unshare=0",
    "bind=0",
    "while [ $# -gt 0 ] && [ \"$1\" != \"--\" ]; do",
    "  [ \"$1\" = \"--unshare-all\" ] && unshare=1",
    "  [ \"$1\" = \"--bind\" ] && bind=1",
    "  shift",
    "done",
    "[ \"$unshare\" = 1 ] && [ \"$bind\" = 1 ] || exit 91",
    `printf '%s' "$PWD" > ${JSON.stringify(capturedCwd)}`,
    `printf 'launch\\n' >> ${JSON.stringify(commandLaunches)}`,
    "shift",
    "exec \"$@\"",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(fakeBubblewrap, 0o700);

  const job: any = {
    id: "scheduled-verify-1",
    status: "awaiting_approval",
    workSessionId: "work-session-1",
    projectId: "workspace-1",
    workspaceRoot,
    maxRuntimeMs: 60_000,
    policySnapshotJson: { verificationCommands: ["npm test"] },
  };
  const verificationJobs = createVerificationJobs();
  let activeSubmission = {
    id: "submission-1",
    snapshotKind: "filesystem" as const,
    snapshotRef: "fs:submitted-snapshot",
    createdAt: "2026-10-12T12:00:00.000Z",
  };
  const verificationInput: Parameters<typeof verifyScheduledJob>[0] = {
    job,
    jobs: verificationJobs as any,
    workSessions: {
      get: () => ({
        id: "work-session-1",
        workspaceSessionId: "workspace-1",
        status: "awaiting_review",
        latestSubmission: activeSubmission,
      }),
    } as any,
    workspaces: { getWorkspace: () => ({ id: "workspace-1", root: workspaceRoot }) } as any,
    reviewCheckpoints: {
      assertSnapshotMatches: async () => true,
      materializeSnapshot: async ({ destination }: { destination: string }) => {
        const { cp, mkdir } = await import("node:fs/promises");
        await mkdir(destination, { recursive: true });
        await cp(workspaceRoot, destination, { recursive: true });
      },
    } as any,
    serverConfig: {
      verifySandboxExecutable: fakeBubblewrap,
      verifyToolchainPaths: [],
      childEnvironmentAllowlist: [],
    } as any,
    clientMutationId: "reviewer-request-1",
  };
  const [result, duplicateResult, distinctRequestResult] = await Promise.all([
    verifyScheduledJob(verificationInput),
    verifyScheduledJob(verificationInput),
    verifyScheduledJob({ ...verificationInput, clientMutationId: "reviewer-request-concurrent" }),
  ]);
  assert.equal(duplicateResult.executionIdentity, result.executionIdentity,
    "concurrent identical verification calls share one durable execution identity");
  assert.equal(distinctRequestResult.executionIdentity, result.executionIdentity,
    "concurrent distinct reviewer request IDs share the active equivalent verification execution");
  assert.ok(["running", "completed"].includes(result.status));
  assert.ok(["running", "completed"].includes(duplicateResult.status));
  assert.ok(["running", "completed"].includes(distinctRequestResult.status));
  assert.equal((await readFile(commandLaunches, "utf8")).trim().split("\n").length, 1,
    "concurrent duplicate requests execute the verification suite once");
  const completedResult = await verifyScheduledJob(verificationInput);
  assert.equal(completedResult.status, "completed", "a retry after execution completion retrieves the durable report");
  const freshVerification = await verifyScheduledJob({ ...verificationInput, clientMutationId: "reviewer-request-2" });
  assert.notEqual(freshVerification.executionIdentity, completedResult.executionIdentity,
    "a deliberate fresh verification gets a new immutable execution identity");
  assert.equal((await readFile(commandLaunches, "utf8")).trim().split("\n").length, 2);
  activeSubmission = { ...activeSubmission, id: "submission-2", snapshotRef: "fs:submitted-snapshot-2" };
  await assert.rejects(
    verifyScheduledJob({ ...verificationInput, clientMutationId: "reviewer-request-1" }),
    /already used with different content/,
    "reusing one idempotency key after the submitted snapshot changes fails closed",
  );
  const changedSubmissionVerification = await verifyScheduledJob({ ...verificationInput, clientMutationId: "reviewer-request-3" });
  assert.equal(changedSubmissionVerification.report?.submissionId, "submission-2");
  assert.equal((await readFile(commandLaunches, "utf8")).trim().split("\n").length, 3);

  assert.equal(completedResult.status, "completed");
  assert.ok(completedResult.report);
  assert.equal(completedResult.report.results[0]?.status, "passed", "allowlisted command runs through the confined verifier launcher");
  assert.equal(completedResult.report.executionPolicy.capability, "read_only_verification");
  assert.equal(completedResult.report.executionPolicy.network, "disabled");
  assert.deepEqual(completedResult.report.executionPolicy.commands, [{
    command: "npm test",
    profile: "npm-test",
    executable: "npm",
    args: ["test"],
    argumentPolicy: "exact_predeclared_argv_no_shell_path_traversal_denied",
    maxRuntimeMs: 5 * 60_000,
  }], "report records the exact command and argument policy that was approved");
  assert.deepEqual(completedResult.report.executionPolicy.writablePaths, [
    "/workspace (disposable submitted snapshot)",
    "/tmp (private temporary filesystem)",
  ]);
  assert.deepEqual(completedResult.report.executionPolicy.environment, {
    policy: "explicit_child_environment_allowlist",
    allowedNames: [],
  }, "report records environment variable names without storing values");
  assert.equal(completedResult.report.snapshotRef, "fs:submitted-snapshot");
  assert.match(completedResult.executionIdentity, /^verification:/, "verification report is durably tied to a unique execution identity");
  assert.equal(completedResult.report.submissionId, "submission-1");
  const executionCwd = await readFile(capturedCwd, "utf8");
  assert.notEqual(executionCwd, workspaceRoot, "tests run in a disposable submitted-snapshot copy");
  await assert.rejects(readFile(join(workspaceRoot, "verification-output.txt")), /ENOENT/,
    "test writes cannot alter the source checkout");
  await assert.rejects(readFile(join(executionCwd, "verification-output.txt")), /ENOENT/,
    "disposable verification files are removed after the run");

  await assert.rejects(verifyScheduledJob({
    job: { ...job, policySnapshotJson: { verificationCommands: ["npm test; touch source.txt"] } },
    jobs: {} as any,
    workSessions: {} as any,
    workspaces: {} as any,
    reviewCheckpoints: {} as any,
  }), /not permitted/, "shell syntax is rejected before a scheduled command can execute");
  await assert.rejects(verifyScheduledJob({
    job: { ...job, status: "running" },
    jobs: {} as any,
    workSessions: {} as any,
    workspaces: {} as any,
    reviewCheckpoints: {} as any,
  }), /only while the submitted result awaits review/);

  const realBubblewrap = process.platform === "linux" ? findBubblewrap() : undefined;
  if (realBubblewrap) {
    const realRoot = await mkdtemp(join(process.cwd(), ".tmp-kontrol-scheduled-verification-"));
    const realWorkspaceRoot = join(realRoot, "workspace");
    const outsideFile = join(realRoot, "outside.txt");
    const httpServer = createServer((_req, res) => res.end("host network reached"));
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(realWorkspaceRoot, { recursive: true }));
      await writeFile(join(realWorkspaceRoot, "source.txt"), "main checkout source stays unchanged\n");
      await writeFile(outsideFile, "outside target stays unchanged\n");
      await symlink(outsideFile, join(realWorkspaceRoot, "outside-link"));
      execFileSync("git", ["init", "-q", realWorkspaceRoot]);
      execFileSync("git", ["-C", realWorkspaceRoot, "config", "user.name", "fixture"]);
      const sourcePath = join(realWorkspaceRoot, "source.txt");
      const gitConfigPath = join(realWorkspaceRoot, ".git", "config");
      const sourceHash = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
      const gitConfigHash = createHash("sha256").update(await readFile(gitConfigPath)).digest("hex");
      const outsideHash = createHash("sha256").update(await readFile(outsideFile)).digest("hex");
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", resolve);
      });
      const networkPort = (httpServer.address() as { port: number }).port;
      const probeScript = [
        "(async () => {",
        "const fs = require('node:fs');",
        "const net = require('node:net');",
        "const { spawnSync } = require('node:child_process');",
        `const sourcePath = '/workspace/source.txt';`,
        `const gitConfigPath = '/workspace/.git/config';`,
        `const workspaceRoot = '/workspace';`,
        "const canWrite = (path, content) => { try { fs.writeFileSync(path, content); return true; } catch { return false; } };",
        "const sourceSnapshotWritable = canWrite(sourcePath, 'changed inside disposable snapshot');",
        "const gitProbe = spawnSync('git', ['-C', workspaceRoot, 'config', 'user.name', 'attacker'], { encoding: 'utf8' });",
        "const gitRan = !gitProbe.error && gitProbe.status !== null;",
        "const gitSnapshotWritable = gitRan && gitProbe.status === 0;",
        "const gitFileSnapshotWritable = canWrite(gitConfigPath, '[user]\\n\\tname = snapshot-write\\n');",
        "let symlinkWriteBlocked = false;",
        "let symlinkCreated = false;",
        `try { fs.symlinkSync(${JSON.stringify(outsideFile)}, '/workspace/host-outside-link'); symlinkCreated = true; symlinkWriteBlocked = !canWrite('/workspace/host-outside-link', 'escaped'); } catch { symlinkWriteBlocked = false; }`,
        "const helperProbe = spawnSync(process.execPath, ['-e', `require('node:fs').writeFileSync('/workspace/source.txt', 'helper')`], { encoding: 'utf8' });",
        "const helperRan = !helperProbe.error && helperProbe.status !== null;",
        "const helperSnapshotWritable = helperRan && helperProbe.status === 0;",
        "fs.writeFileSync('/tmp/kontrol-scheduled-verification-scratch', 'scratch');",
        "const scratchWritable = fs.readFileSync('/tmp/kontrol-scheduled-verification-scratch', 'utf8') === 'scratch';",
        `const networkBlocked = await new Promise(resolve => { const socket = net.createConnection({ host: '127.0.0.1', port: ${networkPort} }); const timer = setTimeout(() => { socket.destroy(); resolve(true); }, 1_000); socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); }); socket.once('error', () => { clearTimeout(timer); resolve(true); }); });`,
        "const result = { sourceSnapshotWritable, gitRan, gitSnapshotWritable, gitFileSnapshotWritable, symlinkCreated, symlinkWriteBlocked, helperRan, helperSnapshotWritable, scratchWritable, networkBlocked };",
        "console.log(JSON.stringify(result));",
        "if (!sourceSnapshotWritable || !gitRan || !gitSnapshotWritable || !gitFileSnapshotWritable || !symlinkCreated || !symlinkWriteBlocked || !helperRan || !helperSnapshotWritable || !scratchWritable || !networkBlocked) process.exitCode = 1;",
        "})().catch(error => { console.error(error); process.exitCode = 1; });",
        "",
      ].join("\n");
      await writeFile(join(realWorkspaceRoot, "package.json"), JSON.stringify({ name: "real-confined-verification", private: true, scripts: { test: "node probe.js" } }));
      await writeFile(join(realWorkspaceRoot, "probe.js"), probeScript);

      const realResult = await verifyScheduledJob({
        job: { ...job, id: "scheduled-real-verification", workspaceRoot: realWorkspaceRoot, projectId: "workspace-real", policySnapshotJson: { verificationCommands: ["npm test"] } },
        jobs: createVerificationJobs() as any,
        workSessions: {
          get: () => ({
            id: "work-session-real",
            workspaceSessionId: "workspace-real",
            status: "awaiting_review",
            latestSubmission: { id: "submission-real", snapshotKind: "filesystem", snapshotRef: "fs:real-snapshot", createdAt: "2026-10-12T12:00:00.000Z" },
          }),
        } as any,
        workspaces: { getWorkspace: () => ({ id: "workspace-real", root: realWorkspaceRoot }) } as any,
        reviewCheckpoints: {
          assertSnapshotMatches: async () => true,
          materializeSnapshot: async ({ destination }: { destination: string }) => {
            const { cp, mkdir } = await import("node:fs/promises");
            await mkdir(destination, { recursive: true });
            await cp(realWorkspaceRoot, destination, { recursive: true });
          },
        } as any,
        serverConfig: {
          verifySandboxExecutable: realBubblewrap,
          verifyToolchainPaths: [dirname(dirname(process.execPath))],
          childEnvironmentAllowlist: [],
        } as any,
      });
      assert.equal(realResult.status, "completed");
      assert.ok(realResult.report);
      assert.equal(realResult.report.results[0]?.status, "passed",
        `real bubblewrap permits the declared test while confining its effects: ${realResult.report.results[0]?.outputTail}`);
      assert.equal(realResult.report.executionPolicy.capability, "read_only_verification");
      assert.equal(realResult.report.executionPolicy.network, "disabled");
      assert.match(realResult.report.results[0]?.outputTail ?? "", /\"networkBlocked\":true/);
      assert.match(realResult.report.results[0]?.outputTail ?? "", /\"scratchWritable\":true/);
      assert.match(realResult.report.results[0]?.outputTail ?? "", /\"gitRan\":true/);
      assert.match(realResult.report.results[0]?.outputTail ?? "", /\"gitSnapshotWritable\":true/);
      assert.match(realResult.report.results[0]?.outputTail ?? "", /\"gitFileSnapshotWritable\":true/);
      assert.match(realResult.report.results[0]?.outputTail ?? "", /\"symlinkCreated\":true/);
      assert.match(realResult.report.results[0]?.outputTail ?? "", /\"helperRan\":true/);
      assert.match(realResult.report.results[0]?.outputTail ?? "", /\"helperSnapshotWritable\":true/);
      assert.equal(createHash("sha256").update(await readFile(sourcePath)).digest("hex"), sourceHash,
        "the real confined verifier cannot mutate the original checkout source");
      assert.equal(createHash("sha256").update(await readFile(gitConfigPath)).digest("hex"), gitConfigHash,
        "the real confined verifier cannot mutate original Git configuration");
      assert.equal(createHash("sha256").update(await readFile(outsideFile)).digest("hex"), outsideHash,
        "the real confined verifier cannot mutate a symlink target outside its snapshot");
    } finally {
      if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(realRoot, { recursive: true, force: true });
    }
  }
  console.log("scheduling/scheduled-verification.test.ts: all assertions passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
