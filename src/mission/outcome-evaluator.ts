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
}

export interface OutcomeReport {
  status: string;
  reviewCoverage: string[];
}

export function evaluateEffectiveCriteria(
  criteria: OutcomeCriterion[],
  evidenceFor: (criterion: OutcomeCriterion, status: "passed" | "failed") => EvidenceRecord | undefined,
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
    const evidence = evidenceFor(criterion, "passed");
    const failedEvidence = evidenceFor(criterion, "failed");
    const baseStatus: CriterionStatus = evidence ? "verified" : failedEvidence ? "failed" : "unverified";
    const status: CriterionStatus = baseStatus === "verified" && dependenciesSatisfied ? "verified" : baseStatus === "verified" ? "unverified" : baseStatus;
    const staleReason = !evidence && criterion.status !== "unverified" && !failedEvidence
      ? `stored ${criterion.status} status has no qualifying evidence for current submission ${context.submissionId ?? "(unknown)"}`
      : baseStatus === "verified" && !dependenciesSatisfied
        ? "one or more dependencies are not currently verified"
        : undefined;
    const state: EffectiveCriterionState = { criterionId, status, evidenceId: evidence?.id ?? failedEvidence?.id, dependenciesSatisfied, staleReason };
    visiting.delete(criterionId);
    states.set(criterionId, state);
    return state;
  };
  for (const criterion of criteria) evaluate(criterion.id);
  return criteria.map((criterion) => states.get(criterion.id)!);
}

export function evaluateMissionOutcome(input: {
  criteria: OutcomeCriterion[];
  criterionStates: EffectiveCriterionState[];
  findings: OutcomeFinding[];
  finalVerification: string[];
  reviewCoverage: string[];
  currentReport?: OutcomeReport;
}): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const states = new Map(input.criterionStates.map((state) => [state.criterionId, state]));
  for (const criterion of input.criteria) {
    if (criterion.priority === "required") {
      const state = states.get(criterion.id);
      if (state?.status !== "verified") reasons.push(`Required criterion ${criterion.id} is effectively ${state?.status ?? "unverified"}: ${state?.staleReason ?? criterion.description}`);
    }
  }
  for (const finding of input.findings) {
    if (finding.scope === "out_of_scope") continue;
    if (finding.disposition === "blocking" && !["verified_resolved", "waived"].includes(finding.status)) {
      reasons.push(`${finding.severity} finding ${finding.id} is ${finding.status}: ${finding.description}`);
    }
  }
  if (input.finalVerification.length && input.currentReport?.status !== "passed") {
    reasons.push("Mission-level final integration verification has not passed for the current submission.");
  }
  const covered = new Set(input.currentReport?.reviewCoverage ?? []);
  const missing = input.reviewCoverage.filter((area) => !covered.has(area));
  if (missing.length) reasons.push(`Review coverage is incomplete; missing: ${missing.join(", ")}.`);
  return { allowed: reasons.length === 0, reasons };
}
