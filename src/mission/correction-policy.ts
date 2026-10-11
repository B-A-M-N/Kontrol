import type { LoopExtensionDecision } from "../mission-ledger.js";

interface CorrectionRoundInput {
  newFindingIds: string[];
  resolvedFindingIds?: string[];
  missionApproved?: boolean;
  progress?: {
    blockingFindingCount?: number;
    failedCriterionCount?: number;
    passedCriterionCount?: number;
    failingVerificationCount?: number;
    unresolvedRequiredActions?: number;
    madeProgress?: boolean;
  };
}

export function evaluateCorrectionPolicy(input: {
  currentRound: number;
  maxCorrectionRounds: number;
  newBlockingCount: number;
  round: CorrectionRoundInput;
  /** The ledger's authoritative approval verdict for the current submission. */
  currentApproval?: boolean;
}): LoopExtensionDecision {
  // No new blocking findings can mean convergence, productive continuation, or
  // stagnation. A round that demonstrably progressed on unresolved actionable
  // work remains eligible for bounded continuation; only an approval-satisfied
  // mission converges, and only a non-progressing round escalates immediately.
  // Convergence requires the authoritative approval predicate, not merely the
  // absence of new blocking findings. round.missionApproved is a hint; the
  // ledger's canApprove is authoritative.
  const converged = input.currentApproval === true || input.round.missionApproved === true;
  if (input.newBlockingCount === 0 && !converged) {
    const resolvedCount = input.round.resolvedFindingIds?.length ?? 0;
    const madeProgress = input.round.progress?.madeProgress ?? resolvedCount > 0;
    if (madeProgress) {
      const nextRound = input.currentRound + 1;
      const effectiveMax = input.maxCorrectionRounds;
      if (nextRound > effectiveMax) {
        return {
          extend: false,
          round: input.currentRound,
          maxRounds: effectiveMax,
          reason: `Progressing correction reached the bounded ceiling (${input.currentRound}/${effectiveMax}); escalation to a human is required.`,
          ceilingHit: true,
        };
      }
      return {
        extend: true,
        round: nextRound,
        maxRounds: effectiveMax,
        reason: `Extending correction loop on demonstrated progress (${resolvedCount} finding(s) resolved), round ${nextRound}/${effectiveMax}.`,
        ceilingHit: false,
      };
    }
    return {
      extend: false,
      round: input.currentRound,
      maxRounds: input.maxCorrectionRounds,
      reason: "No new blocking findings, no demonstrated progress, and unresolved mission requirements remain; escalation to a human is required.",
      ceilingHit: false,
    };
  }
  if (input.newBlockingCount === 0 && converged) {
    return {
      extend: false,
      round: input.currentRound,
      maxRounds: input.maxCorrectionRounds,
      reason: "Round surfaced no new blocking in-scope findings and the authoritative approval predicate allows completion; loop has converged.",
      ceilingHit: false,
    };
  }
  const nextRound = input.currentRound + 1;
  const madeProgress = input.round.progress?.madeProgress ?? (input.round.resolvedFindingIds?.length ?? 0) > 0;
  const effectiveMax = input.maxCorrectionRounds + (madeProgress ? 2 : 0);
  if (nextRound > effectiveMax) {
    return {
      extend: false,
      round: input.currentRound,
      maxRounds: effectiveMax,
      reason: `Correction ceiling reached (${input.currentRound}/${effectiveMax}). New findings recorded but the loop will not auto-extend; a human must decide to continue or ship.`,
      ceilingHit: true,
    };
  }
  return {
    extend: true,
    round: nextRound,
    maxRounds: effectiveMax,
    reason: `Extending correction loop: ${input.newBlockingCount} new blocking in-scope finding(s), round ${nextRound}/${effectiveMax}${madeProgress ? " (progress: prior findings resolved)" : ""}.`,
    ceilingHit: false,
  };
}
