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
): EvidenceRecord | undefined {
  if (!context.submissionId || !context.snapshotKind || !context.snapshotRef) return undefined;
  const scopeId = scope.criterionId ?? scope.findingId;
  if (!scopeId) return undefined;
  const scopeKey = scope.criterionId ? "criterionId" : "findingId";
  return evidence
    .filter((entry) => {
      const details = typeof entry.details === "object" && entry.details ? entry.details as Record<string, unknown> : {};
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
