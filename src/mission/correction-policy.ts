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
}): LoopExtensionDecision {
  // No new blocking findings can mean convergence or unresolved work. If the
  // approval predicate is not satisfied, unresolved requirements remain and
  // the loop must escalate rather than declare convergence.
  if (input.newBlockingCount === 0 && input.round.missionApproved !== true) {
    return {
      extend: false,
      round: input.currentRound,
      maxRounds: input.maxCorrectionRounds,
      reason: "No new blocking findings and unresolved mission requirements remain; escalation to a human is required.",
      ceilingHit: false,
    };
  }
  if (input.newBlockingCount === 0) {
    return {
      extend: false,
      round: input.currentRound,
      maxRounds: input.maxCorrectionRounds,
      reason: "Round surfaced no new blocking in-scope findings; loop has converged.",
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
