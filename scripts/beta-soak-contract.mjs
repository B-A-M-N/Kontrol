// The assertions required for a stable-beta wall-clock soak. Keep this
// contract independent from the runner so qualification cannot be satisfied
// by an incomplete hand-written receipt.
export const REQUIRED_BETA_SOAK_ASSERTIONS = Object.freeze([
  "noUnexpectedCoreRestarts",
  "noUnexpectedSupervisorRestarts",
  "noUnexpectedTunnelRestarts",
  "noUnexpectedAdapterRestarts",
  "noRestartFailures",
  "noOrphanedApprovals",
  "noPendingApprovalRows",
  "noLivePolicyWaiters",
  "noLeakedProcessSessions",
  "diagnosticsContract",
  "tunnelEndpointsHealthy",
  "databaseIntegrityHealthy",
  "noMaintenanceError",
  "schemaConsistent",
  "buildIdentityConsistent",
  "sourceIdentityConsistent",
  "continuityBounded",
  "approvalContinuityCapable",
]);

export function validateBetaSoakAssertions(assertions) {
  if (!assertions || typeof assertions !== "object" || Array.isArray(assertions)) {
    return { valid: false, missing: [...REQUIRED_BETA_SOAK_ASSERTIONS], invalid: [] };
  }
  const missing = REQUIRED_BETA_SOAK_ASSERTIONS.filter((key) => assertions[key] !== true);
  const invalid = Object.entries(assertions)
    .filter(([, value]) => value !== true && value !== false)
    .map(([key]) => key);
  return { valid: missing.length === 0 && invalid.length === 0, missing, invalid };
}
