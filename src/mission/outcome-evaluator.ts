import type { CurrentApprovalContext, CriterionStatus, EffectiveCriterionState } from "../mission-ledger.js";
import type { EvidenceRecord } from "./evidence-authority.js";

export interface OutcomeCriterion {
  id: string;
  description: string;
  priority: string;
  verificationType: string;
  dependsOnCriterionIds?: string[];
  status: string;
}

export interface OutcomeFinding {
  id: string;
  scope: string;
  disposition: string;
  severity: string;
  status: string;
  description: string;
  resolutionSubmissionId?: string;
}

export interface OutcomeReport {
  status: string;
  reviewCoverage: string[];
  results?: unknown[];
}

export function evaluateEffectiveCriteria(
  criteria: OutcomeCriterion[],
  effectiveEvidenceFor: (criterion: OutcomeCriterion) => EvidenceRecord | undefined,
  context: CurrentApprovalContext,
): EffectiveCriterionState[] {
  const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const states = new Map<string, EffectiveCriterionState>();
  const visiting = new Set<string>();
  const evaluate = (criterionId: string): EffectiveCriterionState => {
    const cached = states.get(criterionId);
    if (cached) return cached;
    const criterion = byId.get(criterionId);
    if (!criterion) return { criterionId, status: "unverified", dependenciesSatisfied: false, staleReason: "criterion is missing" };
    if (visiting.has(criterionId)) return { criterionId, status: "unverified", dependenciesSatisfied: false, staleReason: "dependency cycle detected" };
    visiting.add(criterionId);
    const dependencies = (criterion.dependsOnCriterionIds ?? []).map(evaluate);
    const dependenciesSatisfied = dependencies.every((dependency) => dependency.status === "verified");
    // One authoritative attempt selects the criterion state. A later failed or
    // inconclusive observation supersedes an earlier passing result.
    const evidence = effectiveEvidenceFor(criterion);
    const baseStatus: CriterionStatus = evidence?.status === "passed"
      ? "verified"
      : evidence?.status === "failed"
        ? "failed"
        : "unverified";
    const status: CriterionStatus = baseStatus === "verified" && dependenciesSatisfied ? "verified" : baseStatus === "verified" ? "unverified" : baseStatus;
    const staleReason = !evidence && criterion.status !== "unverified"
      ? `stored ${criterion.status} status has no qualifying evidence for current submission ${context.submissionId ?? "(unknown)"}`
      : baseStatus === "verified" && !dependenciesSatisfied
        ? "one or more dependencies are not currently verified"
        : evidence?.status === "inconclusive"
          ? "latest verification attempt was inconclusive"
          : undefined;
    const state: EffectiveCriterionState = { criterionId, status, evidenceId: evidence?.id, dependenciesSatisfied, staleReason };
    visiting.delete(criterionId);
    states.set(criterionId, state);
    return state;
  };
  for (const criterion of criteria) evaluate(criterion.id);
  return criteria.map((criterion) => states.get(criterion.id)!);
}

const OUTCOME_EVIDENCE_RANK = {
  implementation_verified: 0,
  integration_verified: 1,
  outcome_verified: 2,
  operationally_stable: 3,
} as const;

export type OutcomeEvidenceLevel = keyof typeof OUTCOME_EVIDENCE_RANK;

export interface OutcomeObservation {
  observerIdentity: string;
  expectedBehavior: string;
  actualBehavior: string;
  status: string;
  observedAt: string;
}

/**
 * Evaluate independent outcome observations for a submission. At least one
 * qualifying observation must confirm the expected behavior against the exact
 * current snapshot; a later rejection supersedes earlier confirmations.
 * Observer identity must be nonempty and distinct from internal verifier
 * sources so an integration report can never substitute for an external
 * outcome check.
 */
export function evaluateOutcomeObservations(
  observations: OutcomeObservation[],
  context: { submissionId: string; snapshotKind: string; snapshotRef: string },
): { satisfied: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!observations.length) {
    reasons.push("Mission requires independent outcome evidence; no outcome observations exist for the current submission.");
    return { satisfied: false, reasons };
  }
  const rejection = observations
    .filter((o) => o.status === "rejected")
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  if (rejection) {
    reasons.push(`Latest outcome observation from ${rejection.observerIdentity} rejected the expected behavior at ${rejection.observedAt}.`);
    return { satisfied: false, reasons };
  }
  const confirmations = observations.filter((o) => o.status === "confirmed" && o.observerIdentity.trim());
  if (!confirmations.length) {
    reasons.push("Mission requires independent outcome evidence; no qualifying confirmed observation exists for the current submission.");
    return { satisfied: false, reasons };
  }
  return { satisfied: true, reasons };
}

export function evaluateMissionOutcome(input: {
  criteria: OutcomeCriterion[];
  criterionStates: EffectiveCriterionState[];
  findings: OutcomeFinding[];
  finalVerification: string[];
  reviewCoverage: string[];
  outcomeEvidence?: OutcomeEvidenceLevel;
  currentReport?: OutcomeReport;
  currentSubmissionId?: string;
  effectiveFindingResolutions?: Record<string, { resolved: boolean; reasons: string[] }>;
  outcomeObservations?: OutcomeObservation[];
}): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const states = new Map(input.criterionStates.map((state) => [state.criterionId, state]));
  // Evidence-strength gate. integration_verified is the strongest currently
  // enforceable level: it requires a passing final integration report whose
  // results are nonempty. outcome_verified / operationally_stable are refused
  // at mission creation until independent oracle support exists, so the
  // evaluator never treats them as satisfiable by an empty passing report.
  const requiredStrength = input.outcomeEvidence ?? "implementation_verified";
  if (OUTCOME_EVIDENCE_RANK[requiredStrength] >= OUTCOME_EVIDENCE_RANK.integration_verified) {
    const report = input.currentReport;
    if (!report || report.status !== "passed") {
      reasons.push(`Mission requires ${requiredStrength} evidence; a passing final integration report is mandatory for the current submission.`);
    } else if (!report.results?.length) {
      reasons.push(`Mission requires ${requiredStrength} evidence; the passing completion report contains no verification results and cannot certify integration.`);
    }
  }
  // outcome_verified and operationally_stable additionally require a
  // qualifying external outcome observation against the exact submission.
  if (OUTCOME_EVIDENCE_RANK[requiredStrength] >= OUTCOME_EVIDENCE_RANK.outcome_verified) {
    const outcome = evaluateOutcomeObservations(input.outcomeObservations ?? [], {
      submissionId: input.currentSubmissionId ?? "",
      snapshotKind: "",
      snapshotRef: "",
    });
    if (!outcome.satisfied) reasons.push(...outcome.reasons);
  }
  for (const criterion of input.criteria) {
    if (criterion.priority === "required") {
      const state = states.get(criterion.id);
      if (state?.status !== "verified") reasons.push(`Required criterion ${criterion.id} is effectively ${state?.status ?? "unverified"}: ${state?.staleReason ?? criterion.description}`);
    }
  }
  for (const finding of input.findings) {
    if (finding.scope === "out_of_scope") continue;
    if (finding.disposition !== "blocking") continue;
    if (finding.status === "waived") continue;
    // The ledger supplies the effective resolution verdict; a stored status
    // alone is never trusted. A later failed or inconclusive verification on
    // the same submission supersedes an earlier passing resolution.
    const resolution = input.effectiveFindingResolutions?.[finding.id];
    if (finding.status === "verified_resolved" || finding.status === "claimed_resolved") {
      if (!resolution) {
        reasons.push(`Finding ${finding.id} has no current effective-resolution evaluation; renewal is required.`);
        continue;
      }
      if (!resolution.resolved) {
        reasons.push(`Finding ${finding.id} is not effectively resolved: ${resolution.reasons.join("; ")}`);
      }
      continue;
    }
    reasons.push(`${finding.severity} finding ${finding.id} is ${finding.status}: ${finding.description}`);
  }
  if (input.finalVerification.length && input.currentReport?.status !== "passed") {
    reasons.push("Mission-level final integration verification has not passed for the current submission.");
  }
  const covered = new Set(input.currentReport?.reviewCoverage ?? []);
  const missing = input.reviewCoverage.filter((area) => !covered.has(area));
  if (missing.length) reasons.push(`Review coverage is incomplete; missing: ${missing.join(", ")}.`);
  return { allowed: reasons.length === 0, reasons };
}
