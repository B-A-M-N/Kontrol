import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerificationExecutionContext, parseVerificationCommand, runRuntimeProbe, runVerificationCommand, verificationCacheKey, verifyMissionSubmission } from "./mission-verifier.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-mission-verifier-test-"));
try {
  assert.deepEqual(parseVerificationCommand("npm test"), { executable: "npm", args: ["test"] });
  assert.throws(() => parseVerificationCommand("npm test; rm -rf /"), /not permitted/);
  assert.throws(() => parseVerificationCommand("sh test.sh"), /not allowlisted/);

  const originalCacheEnv = process.env.VERIFIER_CACHE_TEST_FLAG;
  try {
    process.env.VERIFIER_CACHE_TEST_FLAG = "first";
    const firstContext = await createVerificationExecutionContext({
      sandbox: false,
      childEnvironmentAllowlist: ["VERIFIER_CACHE_TEST_FLAG"],
      verifyToolchainPaths: [join(root, "toolchain-a")],
      sandboxExecutablePath: join(root, "sandbox-a"),
    });
    const firstKey = verificationCacheKey("npm test", "toolchain-v1", firstContext);
    assert.equal(firstContext.environment.VERIFIER_CACHE_TEST_FLAG, "first", "cache identity uses the actual allowlisted child environment");

    process.env.VERIFIER_CACHE_TEST_FLAG = "second";
    const changedEnvironment = await createVerificationExecutionContext({
      sandbox: false,
      childEnvironmentAllowlist: ["VERIFIER_CACHE_TEST_FLAG"],
      verifyToolchainPaths: [join(root, "toolchain-a")],
      sandboxExecutablePath: join(root, "sandbox-a"),
    });
    assert.notEqual(verificationCacheKey("npm test", "toolchain-v1", changedEnvironment), firstKey,
      "allowlisted environment changes invalidate cached verification");

    const changedToolchain = await createVerificationExecutionContext({
      sandbox: false,
      childEnvironmentAllowlist: ["VERIFIER_CACHE_TEST_FLAG"],
      verifyToolchainPaths: [join(root, "toolchain-b")],
      sandboxExecutablePath: join(root, "sandbox-a"),
    });
    assert.notEqual(verificationCacheKey("npm test", "toolchain-v1", changedToolchain), firstKey,
      "toolchain path changes invalidate cached verification");

    const changedSandbox = await createVerificationExecutionContext({
      sandbox: true,
      childEnvironmentAllowlist: ["VERIFIER_CACHE_TEST_FLAG"],
      verifyToolchainPaths: [join(root, "toolchain-a")],
      sandboxExecutablePath: join(root, "sandbox-b"),
    });
    assert.notEqual(verificationCacheKey("npm test", "toolchain-v1", changedSandbox), firstKey,
      "sandbox mode and implementation changes invalidate cached verification");
  } finally {
    if (originalCacheEnv === undefined) delete process.env.VERIFIER_CACHE_TEST_FLAG;
    else process.env.VERIFIER_CACHE_TEST_FLAG = originalCacheEnv;
  }

  const runtimeProbeServer = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/ready" }).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain" }).end("service ready");
  });
  await new Promise<void>((resolve) => runtimeProbeServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = runtimeProbeServer.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const probe = await runRuntimeProbe({ url: `${origin}/ready`, expectedStatus: 200, bodyIncludes: "ready" }, Date.now() + 5000);
    assert.equal(probe.status, "passed", "bounded loopback runtime probe observes status and response body");
    const redirect = await runRuntimeProbe({ url: `${origin}/redirect`, expectedStatus: 200 }, Date.now() + 5000);
    assert.equal(redirect.status, "failed", "runtime probe does not follow redirects");
    await assert.rejects(runRuntimeProbe({ url: "http://example.com/" }, Date.now() + 5000), /restricted to unauthenticated loopback/);
  } finally {
    await new Promise<void>((resolve, reject) => runtimeProbeServer.close((error) => error ? reject(error) : resolve()));
  }

  const passing = await runVerificationCommand("npm --version", root);
  assert.equal(passing.status, "passed", "allowlisted verification command passes");
  assert.equal(passing.exitCode, 0);
  assert.ok(passing.outputSha256.length === 64);

  const originalPath = process.env.PATH;
  const originalSecret = process.env.KONTROL_ACP_WORKER_SECRET;
  process.env.PATH = `${root}:${originalPath ?? ""}`;
  process.env.KONTROL_ACP_WORKER_SECRET = "must-not-cross-verification-boundary";
  await writeFile(join(root, "npm"), "#!/usr/bin/node\nconsole.log(process.env.KONTROL_ACP_WORKER_SECRET ?? 'missing')\n");
  await chmod(join(root, "npm"), 0o755);
  try {
    const stripped = await runVerificationCommand("npm probe", root);
    assert.match(stripped.outputTail, /missing/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalSecret === undefined) delete process.env.KONTROL_ACP_WORKER_SECRET;
    else process.env.KONTROL_ACP_WORKER_SECRET = originalSecret;
  }

  const failing = await runVerificationCommand("npm test", root);
  assert.equal(failing.status, "failed", "failing verification command is recorded as failed");
  assert.notEqual(failing.exitCode, 0);

  function harness(input: { criteria: Array<Record<string, unknown>>; finalVerification?: string[]; changed?: boolean }) {
    const evidence: Array<Record<string, unknown>> = [];
    const mission = { id: "mission_verify", finalVerification: input.finalVerification ?? [] };
    const session = { workspaceSessionId: "workspace_verify", latestSubmission: { id: "sub_verify", snapshotCommit: "snap_verify", files: [{ path: "src/target.ts", type: "change", additions: 1, removals: 0 }] } };
    const criteria: Array<any> = input.criteria.map((criterion) => ({
      priority: "required",
      status: "unverified",
      verificationType: criterion.verificationType ?? (criterion.verificationCommand ? "test" : "manual_review"),
      ...criterion,
    }));
    const ledger = {
      getMissionByWorkSession: () => mission,
      getPacket: () => ({
        criteria,
        criterionStates: criteria.map((criterion) => ({ criterionId: criterion.id, status: criterion.status })),
        findings: [], workOrders: [], evidence, completionReports: [], mission: { finalVerification: input.finalVerification ?? [] },
      }),
      recordVerifierEvidence: (_missionId: string, entries: Array<Record<string, unknown>>) => {
        evidence.push(...entries.map((entry) => ({ ...entry, source: "server_test_runner" })));
        for (const entry of entries) {
          if (entry.status === "passed") {
            const criterion = criteria.find((item) => item.id === entry.criterionId);
            if (criterion) criterion.status = "verified";
          }
        }
      },
      recordRuntimeProbeEvidence: (_missionId: string, entries: Array<Record<string, unknown>>) => {
        evidence.push(...entries.map((entry) => ({ ...entry, source: "runtime_probe" })));
        for (const entry of entries) {
          if (entry.status === "passed") {
            const criterion = criteria.find((item) => item.id === entry.criterionId);
            if (criterion) criterion.status = "verified";
          }
        }
      },
      recordCompletionReport: (_missionId: string, report: Record<string, unknown>) => { evidence.push({ completion: report }); },
    };
    return {
      evidence,
      run: (criterionIds?: string[], verificationPhase?: "progressive" | "final", verificationScope?: "focused" | "affected" | "full") => verifyMissionSubmission({
        workSessionId: "work_verify",
        missionLedger: ledger as any,
        workSessions: { get: () => session } as any,
        workspaces: { getWorkspace: () => ({ root }) } as any,
        reviewCheckpoints: { reviewChangesAgainstCommit: async () => ({ summary: { files: input.changed ? 1 : 0 } }) } as any,
        criterionIds,
        verificationPhase,
        verificationScope,
      }),
    };
  }

  const passingHarness = harness({
    criteria: [{ id: "criterion-pass", description: "version", verificationCommand: "npm --version" }],
    finalVerification: ["npm --version"],
  });
  const full = await passingHarness.run();
  assert.equal(full.length, 2, "criterion and final integration commands both run against the submitted snapshot");
  assert.equal(full[0].status, "passed");
  assert.equal(full[1].criterionId, "final:1");
  assert.equal(passingHarness.evidence.filter((entry) => entry.source === "server_test_runner").length, 1, "trusted criterion evidence is recorded");
  assert.ok(passingHarness.evidence.some((entry) => entry.completion), "passing final integration records a completion report");

  const phasedHarness = harness({
    criteria: [
      { id: "progressive", description: "progressive", verificationCommand: "npm --version", commandVersion: "test-toolchain-v1" },
      { id: "final-only", description: "final-only", verificationCommand: "npm --version", finalOnly: true },
    ],
    finalVerification: ["npm --version"],
  });
  const progressive = await phasedHarness.run();
  assert.deepEqual(progressive.map((result) => result.criterionId), ["progressive"], "progressive verification leaves finalOnly checks for the final phase");
  const final = await phasedHarness.run(undefined, "final");
  assert.deepEqual(final.map((result) => result.criterionId), ["progressive", "final-only", "final:1"], "final verification explicitly unlocks finalOnly and integration checks");
  assert.equal(final[0].source, "reused_exact_snapshot", "already-passed progressive evidence is reused in the final phase");

  const filteredHarness = harness({
    criteria: [
      { id: "criterion-one", description: "one", verificationCommand: "npm --version" },
      { id: "criterion-two", description: "two", verificationCommand: "npm test" },
    ],
  });
  const filtered = await filteredHarness.run(["criterion-one"]);
  assert.equal(filtered.length, 1, "criterion filtering runs only the requested declared command");
  assert.equal(filtered[0].criterionId, "criterion-one");

  const affectedHarness = harness({
    criteria: [
      { id: "affected", description: "affected", verificationCommand: "npm --version", affectedAreas: ["src/**"] },
      { id: "unaffected", description: "unaffected", verificationCommand: "npm --version", affectedAreas: ["docs/**"] },
    ],
  });
  const affected = await affectedHarness.run(undefined, "progressive", "affected");
  assert.deepEqual(affected.map((result) => result.criterionId), ["affected"], "affected verification uses structured submitted file metadata");

  const skippedHarness = harness({ criteria: [{ id: "manual", description: "manual only" }] });
  assert.deepEqual(await skippedHarness.run(), [], "criteria without a declared command are skipped, not treated as verified");

  const staleHarness = harness({ criteria: [{ id: "stale", description: "stale", verificationCommand: "npm --version" }], changed: true });
  await assert.rejects(staleHarness.run(), /workspace no longer matches/);
  assert.equal(staleHarness.evidence.length, 0, "stale snapshot blocks command execution and evidence recording");

  console.log("mission-verifier.test.ts: all assertions passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
