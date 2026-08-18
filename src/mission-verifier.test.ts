import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVerificationCommand, runVerificationCommand, verifyMissionSubmission } from "./mission-verifier.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-mission-verifier-test-"));
try {
  assert.deepEqual(parseVerificationCommand("npm test"), { executable: "npm", args: ["test"] });
  assert.throws(() => parseVerificationCommand("npm test; rm -rf /"), /not permitted/);
  assert.throws(() => parseVerificationCommand("sh test.sh"), /not allowlisted/);

  const passing = await runVerificationCommand("npm --version", root);
  assert.equal(passing.status, "passed", "allowlisted verification command passes");
  assert.equal(passing.exitCode, 0);
  assert.ok(passing.outputSha256.length === 64);

  const failing = await runVerificationCommand("npm test", root);
  assert.equal(failing.status, "failed", "failing verification command is recorded as failed");
  assert.notEqual(failing.exitCode, 0);

  function harness(input: { criteria: Array<Record<string, unknown>>; finalVerification?: string[]; changed?: boolean }) {
    const evidence: Array<Record<string, unknown>> = [];
    const mission = { id: "mission_verify", finalVerification: input.finalVerification ?? [] };
    const session = { workspaceSessionId: "workspace_verify", latestSubmission: { id: "sub_verify", snapshotCommit: "snap_verify" } };
    const criteria: Array<any> = input.criteria.map((criterion) => ({ priority: "required", status: "unverified", ...criterion }));
    const ledger = {
      getMissionByWorkSession: () => mission,
      getPacket: () => ({ criteria, findings: [], workOrders: [], evidence, completionReports: [], mission: { finalVerification: input.finalVerification ?? [] } }),
      recordEvidence: (_missionId: string, entries: Array<Record<string, unknown>>) => {
        evidence.push(...entries);
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
      run: (criterionIds?: string[]) => verifyMissionSubmission({
        workSessionId: "work_verify",
        missionLedger: ledger as any,
        workSessions: { get: () => session } as any,
        workspaces: { getWorkspace: () => ({ root }) } as any,
        reviewCheckpoints: { reviewChangesAgainstCommit: async () => ({ summary: { files: input.changed ? 1 : 0 } }) } as any,
        criterionIds,
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

  const filteredHarness = harness({
    criteria: [
      { id: "criterion-one", description: "one", verificationCommand: "npm --version" },
      { id: "criterion-two", description: "two", verificationCommand: "npm test" },
    ],
  });
  const filtered = await filteredHarness.run(["criterion-one"]);
  assert.equal(filtered.length, 1, "criterion filtering runs only the requested declared command");
  assert.equal(filtered[0].criterionId, "criterion-one");

  const skippedHarness = harness({ criteria: [{ id: "manual", description: "manual only" }] });
  assert.deepEqual(await skippedHarness.run(), [], "criteria without a declared command are skipped, not treated as verified");

  const staleHarness = harness({ criteria: [{ id: "stale", description: "stale", verificationCommand: "npm --version" }], changed: true });
  await assert.rejects(staleHarness.run(), /workspace no longer matches/);
  assert.equal(staleHarness.evidence.length, 0, "stale snapshot blocks command execution and evidence recording");

  console.log("mission-verifier.test.ts: all assertions passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
