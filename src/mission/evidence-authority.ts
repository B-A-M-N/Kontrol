import type { CurrentApprovalContext, MissionEvidenceSource } from "../mission-ledger.js";

export interface EvidenceRecord {
  id: string;
  status: string;
  submissionId?: string;
  reviewEpoch?: number;
  snapshotKind?: string;
  snapshotRef?: string;
  criterionId?: string;
  findingId?: string;
  attempt?: number;
  createdAt?: string;
  command?: string;
  details?: unknown;
}

export function isEvidenceSourceAllowed(verificationType: string, source: MissionEvidenceSource): boolean {
  if (verificationType === "test") return source === "server_test_runner";
  if (verificationType === "runtime_behavior") return source === "runtime_probe";
  if (["code_inspection", "security_review", "manual_review"].includes(verificationType)) {
    return source === "reviewer_manual_attestation";
  }
  return false;
}

export interface EvidenceScopeContext {
  submissionId?: string;
  snapshotKind?: string;
  snapshotRef?: string;
  reviewEpoch?: number;
}

/**
 * Select the one authoritative result for a criterion or finding at the exact
 * current submission/snapshot/review epoch. Ordering is by durable attempt
 * first, then ISO timestamp and row id for legacy records whose attempt was
 * not populated. A later failure or inconclusive result supersedes an earlier
 * passing result; an earlier record can never certify the current context.
 */
export function selectEffectiveEvidenceResult(
  evidence: EvidenceRecord[],
  scope: { criterionId?: string; findingId?: string },
  context: EvidenceScopeContext,
  allowedSource?: (source: MissionEvidenceSource) => boolean,
): EvidenceRecord | undefined {
  if (!context.submissionId || !context.snapshotKind || !context.snapshotRef) return undefined;
  const scopeId = scope.criterionId ?? scope.findingId;
  if (!scopeId) return undefined;
  const scopeKey = scope.criterionId ? "criterionId" : "findingId";
  return evidence
    .filter((entry) => {
      const details = typeof entry.details === "object" && entry.details ? entry.details as Record<string, unknown> : {};
      const source = details.source as MissionEvidenceSource | undefined;
      // Filter by qualifying source BEFORE selecting the latest attempt so a
      // nonauthoritative claim cannot displace a trusted verifier result.
      if (allowedSource && (!source || !allowedSource(source))) return false;
      return entry[scopeKey] === scopeId
        && entry.submissionId === context.submissionId
        && entry.snapshotKind === context.snapshotKind
        && entry.snapshotRef === context.snapshotRef
        && (context.reviewEpoch === undefined || entry.reviewEpoch === context.reviewEpoch)
        && Boolean(details.source);
    })
    .sort((left, right) => {
      const attemptDelta = evidenceAttempt(left) - evidenceAttempt(right);
      if (attemptDelta !== 0) return attemptDelta;
      const timeDelta = (left.createdAt ?? "").localeCompare(right.createdAt ?? "");
      if (timeDelta !== 0) return timeDelta;
      return left.id.localeCompare(right.id);
    })
    .at(-1);
}

function evidenceAttempt(entry: EvidenceRecord): number {
  const attempt = entry.attempt;
  return typeof attempt === "number" ? attempt : -1;
}

export function findCurrentCriterionEvidence(
  evidence: EvidenceRecord[],
  verificationType: string,
  context: CurrentApprovalContext,
  status: "passed" | "failed" = "passed",
): EvidenceRecord | undefined {
  if (!context.submissionId || !context.snapshotKind || !context.snapshotRef) return undefined;
  return evidence.find((entry) => {
    const details = typeof entry.details === "object" && entry.details ? entry.details as Record<string, unknown> : {};
    return entry.status === status
      && entry.submissionId === context.submissionId
      && entry.snapshotKind === context.snapshotKind
      && entry.snapshotRef === context.snapshotRef
      && (context.reviewEpoch === undefined || entry.reviewEpoch === context.reviewEpoch)
      && isEvidenceSourceAllowed(verificationType, details.source as MissionEvidenceSource);
  });
}

/**
 * Evaluate the effective resolution verdict for a finding at the exact current
 * submission/snapshot/review epoch. A resolution is valid only when every
 * required verification command's latest qualifying attempt passed. A later
 * failed or inconclusive attempt supersedes an earlier pass; a passing attempt
 * for one command does not excuse a missing or failed attempt for another.
 */
export function evaluateEffectiveFindingResolution(
  evidence: EvidenceRecord[],
  requiredCommands: string[],
  findingId: string,
  context: Required<Pick<CurrentApprovalContext, "submissionId" | "snapshotKind" | "snapshotRef" | "reviewEpoch">>,
): { resolved: boolean; reasons: string[]; qualifyingEvidenceIds: string[] } {
  const reasons: string[] = [];
  const qualifyingEvidenceIds: string[] = [];
  const scopeContext: EvidenceScopeContext = { ...context };
  const commands = requiredCommands.length ? requiredCommands : [];
  if (!commands.length) {
    // Manual-review resolution requires at least one qualifying reviewer
    // attestation; without commands there is no independent proof surface.
    const qualifying = evidence.filter((entry) => {
      const details = typeof entry.details === "object" && entry.details ? entry.details as Record<string, unknown> : {};
      return entry.findingId === findingId
        && entry.submissionId === context.submissionId
        && entry.snapshotKind === context.snapshotKind
        && entry.snapshotRef === context.snapshotRef
        && entry.reviewEpoch === context.reviewEpoch
        && details.source === "reviewer_manual_attestation";
    });
    const effective = selectEffectiveEvidenceResult(qualifying, { findingId }, scopeContext);
    if (!effective || effective.status !== "passed") {
      reasons.push(`Finding ${findingId} has no current passing independent evidence.`);
    } else {
      qualifyingEvidenceIds.push(effective.id);
    }
    return { resolved: reasons.length === 0, reasons, qualifyingEvidenceIds };
  }
  for (const command of commands) {
    const commandEvidence = evidence.filter((entry) => {
      const details = typeof entry.details === "object" && entry.details ? entry.details as Record<string, unknown> : {};
      const source = details.source;
      return entry.findingId === findingId
        && entry.command === command
        && entry.submissionId === context.submissionId
        && entry.snapshotKind === context.snapshotKind
        && entry.snapshotRef === context.snapshotRef
        && entry.reviewEpoch === context.reviewEpoch
        && (source === "server_test_runner" || source === "runtime_probe");
    });
    const effective = selectEffectiveEvidenceResult(commandEvidence, { findingId }, scopeContext);
    if (!effective) {
      reasons.push(`Finding ${findingId} is missing current verification for required command ${command}.`);
    } else if (effective.status !== "passed") {
      reasons.push(`Finding ${findingId}'s latest verification for ${command} is ${effective.status}; a passing result is required.`);
    } else {
      qualifyingEvidenceIds.push(effective.id);
    }
  }
  return { resolved: reasons.length === 0, reasons, qualifyingEvidenceIds };
}

export function evaluateFindingResolutionEvidence(
  evidence: EvidenceRecord[],
  requiredCommands: string[],
  context: Required<Pick<CurrentApprovalContext, "submissionId" | "snapshotKind" | "snapshotRef" | "reviewEpoch">>,
): { eligible: EvidenceRecord[]; missingCommands: string[] } {
  const eligible = evidence.filter((entry) => {
    const details = typeof entry.details === "object" && entry.details ? entry.details as Record<string, unknown> : {};
    const source = details.source;
    return entry.status === "passed"
      && entry.submissionId === context.submissionId
      && entry.snapshotKind === context.snapshotKind
      && entry.snapshotRef === context.snapshotRef
      && entry.reviewEpoch === context.reviewEpoch
      && (requiredCommands.length
        ? (source === "server_test_runner" || source === "runtime_probe") && Boolean(entry.command && requiredCommands.includes(entry.command))
        : source === "reviewer_manual_attestation");
  });
  const coveredCommands = new Set(eligible.map((entry) => entry.command).filter((command): command is string => Boolean(command)));
  return { eligible, missingCommands: requiredCommands.filter((command) => !coveredCommands.has(command)) };
}
