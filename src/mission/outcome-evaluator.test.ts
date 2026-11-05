import assert from "node:assert/strict";
import type { CriterionStatus, EffectiveCriterionState } from "../mission-ledger.js";
import {
  evaluateEffectiveCriteria,
  evaluateMissionOutcome,
  evaluateOutcomeObservations,
} from "./outcome-evaluator.js";

// Adversarial fixtures for the completion authority: zero unauthorized
// COMPLETE is the primary safety constraint. These pin the pure evaluator so
// the posture cannot silently weaken even if ledger wiring changes.
const context = { submissionId: "sub-1", reviewEpoch: 3, snapshotKind: "git", snapshotRef: "abc123", expectedBehavior: "checkout works" };
const observation = {
  submissionId: "sub-1",
  reviewEpoch: 3,
  snapshotKind: "git",
  snapshotRef: "abc123",
  observerIdentity: "reviewer",
  observerPrincipalId: "principal-1",
  observationSource: "firsthand_authenticated_external_reviewer",
  externalEvidenceSha256: "a".repeat(64),
  expectedBehavior: "checkout works",
  actualBehavior: "checkout works",
  observedAt: "2026-10-29T00:00:01Z",
};

// Positive: exact-contract firsthand confirmation satisfies the outcome gate.
{
  const outcome = evaluateOutcomeObservations([{ ...observation, status: "confirmed" }], context);
  assert.equal(outcome.satisfied, true, "exact-contract firsthand confirmation satisfies the outcome gate");
}

// Negative: an internal verifier report can never substitute for an external check.
{
  const outcome = evaluateOutcomeObservations(
    [{ ...observation, status: "confirmed", observationSource: "integration_report" }],
    context,
  );
  assert.equal(outcome.satisfied, false, "integration reports cannot satisfy the outcome gate");
  assert.match(outcome.reasons.join(" "), /no outcome observations exist/);
}

// Negative: stale evidence bound to another snapshot or epoch is ignored.
{
  const stale = evaluateOutcomeObservations(
    [{ ...observation, status: "confirmed", snapshotRef: "different" }],
    context,
  );
  assert.equal(stale.satisfied, false, "observations for another snapshot do not satisfy this submission");
  const oldEpoch = evaluateOutcomeObservations(
    [{ ...observation, status: "confirmed", reviewEpoch: 2 }],
    context,
  );
  assert.equal(oldEpoch.satisfied, false, "observations from a prior review epoch are stale");
}

// Adversarial: a later rejection supersedes an earlier confirmation, and a
// later confirmation supersedes an earlier rejection. Latest record decides.
{
  const rejected = evaluateOutcomeObservations([
    { ...observation, status: "confirmed", observedAt: "2026-10-29T00:00:01Z" },
    { ...observation, status: "rejected", observedAt: "2026-10-29T00:00:02Z", observerIdentity: "reviewer-2" },
  ], context);
  assert.equal(rejected.satisfied, false, "a later rejection supersedes an earlier confirmation");
  const recovered = evaluateOutcomeObservations([
    { ...observation, status: "rejected", observedAt: "2026-10-29T00:00:01Z", observerIdentity: "reviewer-2" },
    { ...observation, status: "confirmed", observedAt: "2026-10-29T00:00:02Z" },
  ], context);
  assert.equal(recovered.satisfied, true, "a later confirmation supersedes an earlier rejection");
}

// Adversarial: malformed evidence identity is rejected, not trusted.
{
  const badHash = evaluateOutcomeObservations(
    [{ ...observation, status: "confirmed", externalEvidenceSha256: "not-a-sha" }],
    context,
  );
  assert.equal(badHash.satisfied, false, "observations without a content hash do not qualify");
}

// Stored criterion status without qualifying evidence is stale, never verified.
{
  const states = evaluateEffectiveCriteria(
    [{ id: "c1", description: "done", priority: "required", verificationType: "manual_review", status: "verified" }],
    () => undefined,
    { submissionId: "sub-1" },
  );
  assert.equal(states[0]?.status, "unverified", "stored verified status without evidence is stale");
  assert.match(states[0]?.staleReason ?? "", /no qualifying evidence/);
}

// Mission refusal cases: implementation-only evidence cannot certify
// integration; an empty passing report cannot certify anything; a claimed
// (not proven) finding resolution blocks completion.
{
  const base = {
    criteria: [{ id: "c1", description: "done", priority: "required", verificationType: "manual_review", status: "verified" as string }],
    criterionStates: [{ criterionId: "c1", status: "verified" as CriterionStatus, dependenciesSatisfied: true }] as EffectiveCriterionState[],
    findings: [] as { id: string; scope: string; disposition: string; severity: string; status: string; description: string }[],
    reviewCoverage: [] as string[],
  };
  const weak = evaluateMissionOutcome({ ...base, finalVerification: ["npm test"], outcomeEvidence: "integration_verified" });
  assert.equal(weak.allowed, false, "missing final report cannot satisfy integration evidence");
  const empty = evaluateMissionOutcome({
    ...base,
    finalVerification: ["npm test"],
    outcomeEvidence: "integration_verified",
    currentReport: { status: "passed", reviewCoverage: [] },
  });
  assert.equal(empty.allowed, false, "an empty passing report cannot certify integration");
  assert.match(empty.reasons.join(" "), /no verification results/);
  const claimed = evaluateMissionOutcome({
    ...base,
    finalVerification: [],
    currentReport: { status: "passed", reviewCoverage: [], results: ["ok"] },
    findings: [{ id: "f1", scope: "mission", disposition: "blocking", severity: "high", status: "claimed_resolved", description: "x" }],
  });
  assert.equal(claimed.allowed, false, "a merely claimed finding resolution blocks completion");
}

console.log("outcome-evaluator.test.ts: all assertions passed");
