#!/usr/bin/env node
// P1-E focused test: the evaluator judges evidence without launching
// anything, and the authority boundary is statically enforced.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_BETA_SOAK_ASSERTIONS } from "../beta-soak-contract.mjs";
import {
  evaluateCandidateIdentity,
  evaluateGateVerdict,
  evaluateSoakEvidence,
} from "./qualification-evaluator.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// 0. Authority boundary: the evaluator must be incapable of launching
// processes (no child_process, no executor import, no dynamic import).
{
  const source = readFileSync(join(here, "qualification-evaluator.mjs"), "utf8");
  for (const forbidden of ["child_process", "runQualificationProcess", "execFile", "spawn", "import("]) {
    assert.ok(!source.includes(forbidden), `evaluator must not contain ${forbidden}`);
  }
  console.log("qualification-evaluator.test: side-effect-free authority — ok");
}

const candidate = {
  buildId: "b1",
  metadata: { buildId: "b1", gitSha: "sha", gitDirty: 0, version: "1.0.0", contentSha256: "abc" },
};
const sourceStarted = { gitSha: "sha", dirtyPaths: [] };
const passPhases = [
  { id: "runtime-suite", status: "passed" },
  { id: "immutable-candidate-build", status: "passed" },
  { id: "installed-product-uat", status: "passed" },
  { id: "continuity-soak-evidence", status: "passed" },
  { id: "deployment-uptime-evidence", status: "passed" },
  { id: "external-host-catalog-evidence", status: "passed" },
];

function passingSoak(buildId = "b1") {
  const assertions = Object.fromEntries(REQUIRED_BETA_SOAK_ASSERTIONS.map((key) => [key, true]));
  return {
    status: "passed",
    startedAt: "2026-10-31T00:00:00.000Z",
    finishedAt: "2026-10-31T01:00:00.000Z",
    expectedBuildId: buildId,
    snapshots: {
      started: { buildId, gitSha: "sha" },
      finished: { buildId, gitSha: "sha", gitDirty: 0 },
    },
    assertions,
  };
}

// 1. Identity match → pass.
{
  const identity = evaluateCandidateIdentity({ candidate, sourceStarted, endingGitSha: "sha", endingDirtyPaths: [] });
  assert.equal(identity.pass, true);
  assert.equal(identity.status, "passed");
  const verdict = evaluateGateVerdict({
    phases: passPhases, codeOnly: false, cleanPass: true,
    candidateIdentityPass: identity.pass, identityStable: true, dirtySetStable: true, cleanAtEnd: true,
  });
  assert.equal(verdict.qualified, true);
  assert.equal(verdict.status, "qualified");
  assert.equal(verdict.resultLabel, "QUALIFIED");
  console.log("qualification-evaluator.test: all-pass evidence qualifies — ok");
}

// 2. Identity mismatch (source moved mid-gate) → identity fails, gate fails.
{
  const identity = evaluateCandidateIdentity({ candidate, sourceStarted, endingGitSha: "other", endingDirtyPaths: [] });
  assert.equal(identity.pass, false);
  assert.equal(identity.status, "failed");
  const verdict = evaluateGateVerdict({
    phases: passPhases, codeOnly: false, cleanPass: true,
    candidateIdentityPass: identity.pass, identityStable: false, dirtySetStable: true, cleanAtEnd: true,
  });
  assert.equal(verdict.qualified, false);
  assert.equal(verdict.codeQualified, false);
  console.log("qualification-evaluator.test: identity drift blocks qualification — ok");
}

// 3. One failed code phase → NOT QUALIFIED (code verdict, not soak verdict).
{
  const phases = passPhases.map((phase) => (phase.id === "runtime-suite" ? { ...phase, status: "failed" } : phase));
  const verdict = evaluateGateVerdict({
    phases, codeOnly: false, cleanPass: true,
    candidateIdentityPass: true, identityStable: true, dirtySetStable: true, cleanAtEnd: true,
  });
  assert.equal(verdict.codeQualified, false);
  assert.equal(verdict.resultLabel, "NOT QUALIFIED");
  console.log("qualification-evaluator.test: code failure blocks qualification — ok");
}

// 4. warning-only (allow-dirty) with dirty tree → code failure stays failure.
{
  const phases = passPhases.map((phase) => (phase.id === "runtime-suite" ? { ...phase, status: "warning" } : phase));
  const verdict = evaluateGateVerdict({
    phases, codeOnly: false, cleanPass: false,
    candidateIdentityPass: true, identityStable: true, dirtySetStable: true, cleanAtEnd: false,
  });
  assert.equal(verdict.qualified, false);
  console.log("qualification-evaluator.test: dirty tree can never qualify — ok");
}

// 5. Soak evidence: build match passes, build mismatch fails with reason.
{
  const good = evaluateSoakEvidence(passingSoak("b1"), { candidateBuildId: "b1", sourceStartedGitSha: "sha" });
  assert.equal(good.passed, true);
  const bad = evaluateSoakEvidence(passingSoak("b2"), { candidateBuildId: "b1", sourceStartedGitSha: "sha" });
  assert.equal(bad.passed, false);
  assert.equal(bad.buildMatches, false);
  assert.ok(typeof bad.reason === "string" && bad.reason.length > 0);
  console.log("qualification-evaluator.test: soak identity binding — ok");
}

// 6. Code passes but soak evidence fails → CODE QUALIFIED verdict, not qualified.
{
  const phases = passPhases.map((phase) => (
    phase.id === "continuity-soak-evidence" ? { ...phase, status: "failed" } : phase
  ));
  const verdict = evaluateGateVerdict({
    phases, codeOnly: false, cleanPass: true,
    candidateIdentityPass: true, identityStable: true, dirtySetStable: true, cleanAtEnd: true,
  });
  assert.equal(verdict.codeQualified, true);
  assert.equal(verdict.qualified, false);
  assert.match(verdict.resultLabel, /CODE QUALIFIED/);
  console.log("qualification-evaluator.test: code/soak verdicts stay distinct — ok");
}

// 7. codeOnly gate: soak is vacuously satisfied but code rules still apply.
{
  const verdict = evaluateGateVerdict({
    phases: [{ id: "runtime-suite", status: "passed" }], codeOnly: true, cleanPass: true,
    candidateIdentityPass: true, identityStable: true, dirtySetStable: true, cleanAtEnd: true,
  });
  assert.equal(verdict.soakQualified, true);
  assert.equal(verdict.qualified, true);
  assert.equal(verdict.status, "qualified");
  console.log("qualification-evaluator.test: code-only gate — ok");
}

console.log("qualification-evaluator.test: ALL CHECKS PASSED");
