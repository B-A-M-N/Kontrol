import type { CheckpointCoverage } from "./checkpoint-coverage.js";

/** Shared approval predicate for every reviewer entry path. Unknown coverage
 * can never be waived; explicit acknowledgment applies only to known paths. */
export function reviewCoverageApprovalBlock(
  coverage: CheckpointCoverage,
  acceptIncompleteCoverage: boolean,
): string | undefined {
  if (coverage.status === "unknown") {
    return `Checkpoint coverage is unknown${coverage.errorCode ? ` (${coverage.errorCode})` : ""}; approval is blocked until a new submission has a successful coverage assessment.`;
  }
  if (coverage.status === "incomplete" && !acceptIncompleteCoverage) {
    const paths = coverage.uncoveredPaths.length > 0 ? coverage.uncoveredPaths.join(", ") : "unclassified paths";
    return `This submission has mutations the review checkpoint cannot represent: ${paths}. Review the listed paths out-of-band and re-approve with acceptIncompleteCoverage.`;
  }
  if (coverage.status === "incomplete" && coverage.uncoveredPaths.length === 0) {
    return "Incomplete coverage has no enumerated paths, so the acknowledgment cannot be applied safely.";
  }
  return undefined;
}
