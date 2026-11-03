#!/usr/bin/env node
// P1-E: qualification evaluation authority.
//
// This module applies release policy to exact candidate-bound evidence. It is
// deliberately side-effect-free: it launches no processes, performs no I/O,
// and owns no run identity. The qualification CONTROLLER (beta-gate.mjs) owns
// orchestration and the durable receipt; the PROCESS EXECUTOR
// (qualification-process.mjs) owns child lifecycle; this EVALUATOR owns only
// the verdict. The reviewer/operator approves promotion but cannot forge test
// results or bypass required evidence: a non-passing verdict is the only
// output this module can produce for failing evidence.
import { validateBetaSoakAssertions } from "../beta-soak-contract.mjs";

// Evidence classes that belong to deployment/continuity qualification, not to
// code qualification. A code-phase failure and a soak-phase failure are
// different verdicts; diagnostic continuation runs both, the verdict keeps
// them distinct.
export const NON_CODE_EVIDENCE_PHASES = [
  "continuity-soak-evidence",
  "deployment-uptime-evidence",
  "external-host-catalog-evidence",
];

// Every executor outcome other than an explicit pass blocks qualification.
// "warning" is the single tolerated non-pass: a dirty checkout observed under
// an explicit --allow-dirty engineering-feedback run (which can still never
// produce a qualified stable-beta receipt via cleanAtEnd).
export function isHardFailure(phase) {
  return phase?.status !== "passed" && phase?.status !== "warning";
}

export function evaluateCandidateIdentity({ candidate, sourceStarted, endingGitSha, endingDirtyPaths }) {
  const metadata = candidate?.metadata;
  const pass = Boolean(
    candidate?.buildId
    && metadata?.buildId === candidate.buildId
    && metadata?.gitSha === sourceStarted?.gitSha
    && Number(metadata?.gitDirty) === (sourceStarted?.dirtyPaths ?? []).length
    && endingGitSha === sourceStarted?.gitSha
    && JSON.stringify(sourceStarted?.dirtyPaths ?? []) === JSON.stringify(endingDirtyPaths ?? []),
  );
  return {
    id: "candidate-source-identity",
    command: "build-meta.json + git status --porcelain + git rev-parse HEAD",
    status: pass ? "passed" : "failed",
    candidateBuildId: candidate?.buildId,
    candidateGitSha: metadata?.gitSha,
    candidateGitDirty: metadata?.gitDirty,
    sourceStartedGitSha: sourceStarted?.gitSha,
    sourceFinishedGitSha: endingGitSha,
    sourceStartedDirtyPaths: sourceStarted?.dirtyPaths,
    sourceFinishedDirtyPaths: endingDirtyPaths,
    finishedAt: new Date().toISOString(),
    pass,
  };
}

export function evaluateSoakEvidence(soak, { candidateBuildId, sourceStartedGitSha }) {
  if (!soak || soak.status !== "passed") return { passed: false, reason: "missing or non-passing soak report" };
  if (soak.monitoring?.diagnosticsRequired === false || soak.monitoring?.tunnelRequired === false) {
    return { passed: false, reason: "soak skipped required diagnostics or tunnel monitoring" };
  }
  const started = soak.snapshots?.started;
  const finished = soak.snapshots?.finished;
  const startedAtMs = Date.parse(soak.startedAt ?? "");
  const finishedAtMs = Date.parse(soak.finishedAt ?? "");
  const timestampsValid = Number.isFinite(startedAtMs)
    && Number.isFinite(finishedAtMs)
    && finishedAtMs >= startedAtMs;
  const buildMatches = Boolean(
    candidateBuildId
    && soak.expectedBuildId === candidateBuildId
    && started?.buildId === candidateBuildId
    && finished?.buildId === candidateBuildId,
  );
  const sourceMatches = Boolean(
    started?.gitSha === sourceStartedGitSha
    && finished?.gitSha === sourceStartedGitSha
    && (finished?.gitDirty === undefined || Number(finished.gitDirty) === 0),
  );
  const assertionCheck = validateBetaSoakAssertions(soak.assertions);
  return {
    passed: timestampsValid && buildMatches && sourceMatches && assertionCheck.valid,
    timestampsValid,
    buildMatches,
    sourceMatches,
    assertions: assertionCheck.valid,
    missingAssertions: assertionCheck.missing,
    invalidAssertions: assertionCheck.invalid,
    reason: timestampsValid && buildMatches && sourceMatches && assertionCheck.valid ? undefined : "soak timestamps, identity, or required assertions did not match the candidate",
  };
}

// Pure verdict over assembled evidence. `phases` are the controller's
// recorded executor outcomes; this function never re-runs them.
export function evaluateGateVerdict({
  phases = [],
  codeOnly = false,
  cleanPass = false,
  candidateIdentityPass = false,
  identityStable = false,
  dirtySetStable = false,
  cleanAtEnd = false,
}) {
  const hardFailures = phases.filter(isHardFailure);
  const codeFailures = hardFailures.filter((phase) => !NON_CODE_EVIDENCE_PHASES.includes(phase.id));
  const codeQualified = cleanPass
    && codeFailures.length === 0
    && candidateIdentityPass
    && identityStable
    && dirtySetStable
    && cleanAtEnd;
  const soakQualified = codeOnly
    ? true
    : phases.find((phase) => phase.id === "continuity-soak-evidence")?.status === "passed"
      && phases.find((phase) => phase.id === "deployment-uptime-evidence")?.status === "passed"
      && phases.find((phase) => phase.id === "external-host-catalog-evidence")?.status === "passed";
  const qualified = codeQualified && soakQualified;
  return {
    codeQualified,
    soakQualified,
    qualified,
    status: qualified ? "qualified" : (codeOnly ? "code_failed" : "failed"),
    resultLabel: qualified
      ? "QUALIFIED"
      : codeQualified
        ? (codeOnly ? "CODE QUALIFIED; DEPLOYMENT EVIDENCE REQUIRED" : "CODE QUALIFIED; UPTIME, CONTINUITY, OR EXTERNAL CATALOG EVIDENCE REQUIRED")
        : "NOT QUALIFIED",
  };
}
