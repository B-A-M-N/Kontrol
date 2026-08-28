import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const fixture = mkdtempSync(join(tmpdir(), "kontrol-beta-final-"));
const fakeBin = join(fixture, "bin");
const codeReceiptPath = join(fixture, "beta-code.json");
const soakReportPath = join(fixture, "beta-soak.json");
const receiptPath = join(fixture, "beta-final.json");
const sha = "a".repeat(40);
const buildId = "candidate-build";
mkdirSync(fakeBin, { recursive: true });
const fakeGit = join(fakeBin, "git");
writeFileSync(fakeGit, "#!/bin/sh\ncase \"$1 $2\" in\n  'rev-parse HEAD') printf '%s\\n' '" + sha + "' ;;\n  'status --porcelain') ;;\n  *) exit 1 ;;\nesac\n");
chmodSync(fakeGit, 0o755);

const code = {
  codeQualified: true,
  faultMatrix: { qualified: true },
  candidate: {
    buildId,
    artifactPath: "/immutable/releases/candidate-build",
    metadata: { buildId, gitSha: sha, gitDirty: 0 },
  },
  source: {
    started: { gitSha: sha, dirtyPaths: [] },
    finished: { gitSha: sha, dirtyPaths: [] },
  },
};
const assertions = {
  noUnexpectedCoreRestarts: true,
  noUnexpectedSupervisorRestarts: true,
  noUnexpectedTunnelRestarts: true,
  noUnexpectedAdapterRestarts: true,
  noRestartFailures: true,
  noOrphanedApprovals: true,
  noPendingApprovalRows: true,
  noLivePolicyWaiters: true,
  noLeakedProcessSessions: true,
  diagnosticsContract: true,
  tunnelEndpointsHealthy: true,
  databaseIntegrityHealthy: true,
  noMaintenanceError: true,
  schemaConsistent: true,
  buildIdentityConsistent: true,
  sourceIdentityConsistent: true,
  continuityBounded: true,
  approvalContinuityCapable: true,
};
const soak = {
  status: "passed",
  requestedHours: 12,
  startedAt: "2026-08-27T00:00:00.000Z",
  finishedAt: "2026-08-27T12:00:00.000Z",
  expectedBuildId: buildId,
  monitoring: { diagnosticsRequired: true, tunnelRequired: true },
  snapshots: {
    started: { buildId, gitSha: sha, gitDirty: 0, generation: { activeBuildId: buildId } },
    finished: { buildId, gitSha: sha, gitDirty: 0, generation: { activeBuildId: buildId } },
  },
  assertions,
};

function runFinal(extraEnv = {}) {
  return spawnSync(process.execPath, ["scripts/beta-gate-final.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: fakeBin + ":" + process.env.PATH,
      KONTROL_BETA_CODE_RECEIPT: codeReceiptPath,
      KONTROL_BETA_SOAK_REPORT: soakReportPath,
      KONTROL_BETA_RECEIPT: receiptPath,
      ...extraEnv,
    },
  });
}

try {
  writeFileSync(codeReceiptPath, JSON.stringify(code));
  writeFileSync(soakReportPath, JSON.stringify(soak));
  const passed = runFinal();
  assert.equal(passed.status, 0, `status=${passed.status} error=${passed.error?.message ?? "none"}\n${passed.stdout}\n${passed.stderr}`);
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).qualified, true);

  writeFileSync(soakReportPath, JSON.stringify({ ...soak, expectedBuildId: "different-build" }));
  const rejected = runFinal();
  assert.notEqual(rejected.status, 0, "a soak for a different build must not qualify");
  const rejectedReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(rejectedReceipt.qualified, false);
  assert.equal(rejectedReceipt.checks.soakIdentity, false);

  writeFileSync(soakReportPath, JSON.stringify({
    ...soak,
    requestedHours: 2,
    finishedAt: "2026-08-27T02:00:00.000Z",
  }));
  const tooShort = runFinal();
  assert.notEqual(tooShort.status, 0, "the canonical gate must reject a soak shorter than 12 hours");
  const tooShortReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(tooShortReceipt.policy.minimumSoakHours, 12);
  assert.equal(tooShortReceipt.checks.soakDuration, false);

  const attemptedPolicyOverride = runFinal({ KONTROL_BETA_MIN_SOAK_HOURS: "1" });
  assert.notEqual(attemptedPolicyOverride.status, 0, "the environment must not lower the 12-hour stable-beta floor");
  const attemptedOverrideReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(attemptedOverrideReceipt.policy.minimumSoakHours, 12);
  assert.equal(attemptedOverrideReceipt.checks.soakDuration, false);

  writeFileSync(soakReportPath, JSON.stringify({
    ...soak,
    assertions: { noUnexpectedCoreRestarts: true },
  }));
  const incomplete = runFinal();
  assert.notEqual(incomplete.status, 0, "an incomplete soak assertion set must not qualify");
  const incompleteReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(incompleteReceipt.checks.soakAssertionsPass, false);
  assert.ok(incompleteReceipt.soak.missingAssertions.includes("databaseIntegrityHealthy"));
  console.log("beta-gate-final.test.mjs: matching candidate/soak qualification and mismatch rejection passed");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
