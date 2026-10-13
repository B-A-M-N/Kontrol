import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyScheduledJob } from "./scheduled-verification.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-scheduled-verification-"));
const workspaceRoot = join(root, "workspace");
const fakeBubblewrap = join(root, "bwrap");
const capturedCwd = join(root, "sandbox-cwd.txt");
try {
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
  let persistedReport: any;
  const result = await verifyScheduledJob({
    job,
    jobs: {
      persistReport(_jobId: string, runId: string, reportText: string) {
        persistedReport = { runId, reportText };
        return { reportSha256: "a".repeat(64), reportText };
      },
    } as any,
    workSessions: {
      get: () => ({
        id: "work-session-1",
        workspaceSessionId: "workspace-1",
        status: "awaiting_review",
        latestSubmission: {
          id: "submission-1",
          snapshotKind: "filesystem",
          snapshotRef: "fs:submitted-snapshot",
          createdAt: "2026-10-12T12:00:00.000Z",
        },
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
  });

  assert.equal(result.report.results[0]?.status, "passed", "allowlisted command runs through the confined verifier launcher");
  assert.equal(result.report.executionPolicy.capability, "read_only_verification");
  assert.equal(result.report.executionPolicy.network, "disabled");
  assert.deepEqual(result.report.executionPolicy.commands, [{
    command: "npm test",
    executable: "npm",
    args: ["test"],
    argumentPolicy: "exact_predeclared_argv_no_shell_path_traversal_denied",
    maxRuntimeMs: 5 * 60_000,
  }], "report records the exact command and argument policy that was approved");
  assert.deepEqual(result.report.executionPolicy.writablePaths, [
    "/workspace (disposable submitted snapshot)",
    "/tmp (private temporary filesystem)",
  ]);
  assert.deepEqual(result.report.executionPolicy.environment, {
    policy: "explicit_child_environment_allowlist",
    allowedNames: [],
  }, "report records environment variable names without storing values");
  assert.equal(result.report.snapshotRef, "fs:submitted-snapshot");
  assert.match(persistedReport.runId, /^verification:submission-1:/, "verification report is durably tied to the submission");
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
  console.log("scheduling/scheduled-verification.test.ts: all assertions passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
