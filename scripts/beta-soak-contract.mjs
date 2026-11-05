// The assertions required for the stable-beta continuity workload. Keep this
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
  "resourceAdmissionRecovered",
  "expiredHandlerAccounting",
  "approvalContinuityCapable",
  // P1: the trusted-conversation continuity workload must actually run and
  // recover durable state across transport replacement — not merely re-run
  // tools/list on a fresh transport.
  "conversationContinuityProven",
  // The soak is tied to a code-gate receipt that passed the mission outcome
  // loop scenario for this exact immutable build.
  "supervisedMissionLoopQualified",
]);

export const REQUIRED_BETA_FAULT_CASES = Object.freeze([
  "supervised-mission-loop",
]);

export const MINIMUM_DEPLOYMENT_UPTIME_MS = 12 * 60 * 60_000;

export function validateBetaDeploymentUptimeReceipt(receipt, options = {}) {
  const checkedAtMs = Date.parse(receipt?.checkedAt ?? "");
  const startedAtMs = Date.parse(receipt?.startedAt ?? "");
  const uptimeMs = Number(receipt?.uptimeMs);
  const checks = receipt?.checks;
  const minimumUptimeMs = Number(receipt?.policy?.minimumUptimeMs);
  const minimumCheckedAtMs = Date.parse(options.minimumCheckedAt ?? "");
  const reasons = [];
  if (receipt?.kind !== "kontrol-deployment-uptime-qualification") reasons.push("wrong receipt kind");
  if (receipt?.status !== "qualified" || receipt?.qualified !== true) reasons.push("receipt is not qualified");
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(checkedAtMs)) reasons.push("invalid uptime timestamps");
  if (!Number.isFinite(minimumUptimeMs) || !Number.isFinite(uptimeMs)) reasons.push("reported uptime is invalid");
  else if (minimumUptimeMs < MINIMUM_DEPLOYMENT_UPTIME_MS || uptimeMs < MINIMUM_DEPLOYMENT_UPTIME_MS) reasons.push("deployment uptime is below 12 hours");
  if (Number.isFinite(startedAtMs) && Number.isFinite(checkedAtMs) && Number.isFinite(uptimeMs)
      && (checkedAtMs < startedAtMs + MINIMUM_DEPLOYMENT_UPTIME_MS
        || Math.abs(uptimeMs - (checkedAtMs - startedAtMs)) > 60_000)) reasons.push("reported uptime does not match the generation timestamps");
  if (Number.isFinite(minimumCheckedAtMs) && checkedAtMs < minimumCheckedAtMs) reasons.push("uptime receipt predates the completed continuity workload");
  if (checkedAtMs > Date.now() + 60_000 || checkedAtMs < Date.now() - 24 * 60 * 60_000) reasons.push("uptime receipt is outside the current 24-hour window");
  if (options.candidateBuildId && receipt?.deployment?.buildId !== options.candidateBuildId) reasons.push("candidate buildId mismatch");
  if (options.sourceSha && receipt?.deployment?.sourceSha !== options.sourceSha) reasons.push("source SHA mismatch");
  if (options.contentSha256 && receipt?.deployment?.contentSha256 !== options.contentSha256) reasons.push("artifact content identity mismatch");
  if (typeof receipt?.deployment?.generationId !== "string" || receipt.deployment.generationId.length === 0) reasons.push("generation identity is missing");
  for (const key of ["serviceActive", "runtimeIdentityMatchesLock", "installedReleaseMatchesRuntime", "serverProcessLive", "launcherProcessLive", "coreReady", "operationalReady"]) {
    if (checks?.[key] !== true) reasons.push(`required live check failed: ${key}`);
  }
  if (typeof receipt?.workflow?.repository !== "string" || !receipt.workflow.repository) reasons.push("GitHub workflow identity is missing");
  if (typeof receipt?.workflow?.runId !== "string" || !receipt.workflow.runId) reasons.push("GitHub workflow run identity is missing");
  return { valid: reasons.length === 0, reasons, startedAtMs, checkedAtMs, uptimeMs };
}

export function validateBetaFaultMatrix(matrix, options = {}) {
  const missing = REQUIRED_BETA_FAULT_CASES.filter((id) =>
    !Array.isArray(matrix?.cases) || !matrix.cases.some((testCase) => testCase?.id === id && testCase.passed === true),
  );
  const buildMatches = !options.candidateBuildId || matrix?.buildId === options.candidateBuildId;
  return {
    valid: matrix?.qualified === true && missing.length === 0 && buildMatches,
    missing,
    buildMatches,
  };
}

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
