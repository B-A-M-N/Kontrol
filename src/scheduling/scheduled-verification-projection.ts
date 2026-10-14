import { createHash } from "node:crypto";
import { parseVerificationCommand } from "../mission-verifier.js";
import type { ServerConfig } from "../config.js";
import type { ScheduledVerificationExecution } from "./scheduled-job-store.js";

const ALLOWED_EXECUTABLES = ["cargo", "go", "jest", "make", "npm", "pytest", "ruff", "tsc", "vitest"];

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function scheduledVerificationFingerprints(input: {
  policySnapshotJson: Record<string, unknown>;
  serverConfig?: ServerConfig;
}): {
  commands: Array<{ command: string; executable: string; args: string[] }>;
  commandFingerprint: string;
  policyFingerprint: string;
  commandPolicyValid: boolean;
} {
  const declared = input.policySnapshotJson.verificationCommands;
  let commands: Array<{ command: string; executable: string; args: string[] }> = [];
  let invalidCommandPolicy = false;
  if (Array.isArray(declared) && declared.length <= 5 && declared.every((value) => typeof value === "string")) {
    try {
      commands = declared.map((command) => ({ command, ...parseVerificationCommand(command) }));
    } catch {
      // Result retrieval must remain available even if an old or manually
      // edited policy contains an invalid command. Verification itself rejects
      // that policy before claiming or executing anything.
      invalidCommandPolicy = true;
    }
  }
  const commandFingerprint = sha256(invalidCommandPolicy
    ? { invalidDeclaredCommands: declared }
    : commands.map(({ command, executable, args }) => ({ command, executable, args })));
  const policyFingerprint = sha256({
    policySnapshotJson: input.policySnapshotJson,
    verifierPolicy: "scheduled-read-only-bubblewrap-v2",
    allowedExecutables: ALLOWED_EXECUTABLES,
    network: "disabled",
    sandbox: input.serverConfig?.verifySandboxExecutable ?? "platform-default",
    childEnvironmentAllowlist: [...(input.serverConfig?.childEnvironmentAllowlist ?? [])].sort(),
    verifyToolchainPaths: [...(input.serverConfig?.verifyToolchainPaths ?? [])].sort(),
  });
  return { commands, commandFingerprint, policyFingerprint, commandPolicyValid: !invalidCommandPolicy };
}

export interface MissionVerificationProjectionInput {
  approval?: { allowed: boolean; reasons: string[] };
  requiredEvidenceLevel?: "implementation_verified" | "integration_verified" | "outcome_verified" | "operationally_stable";
  verificationEvidenceIds?: string[];
  outcomeObservationIds?: string[];
  completionReport?: { id: string; status: string; reportSha256: string; snapshotKind?: string; snapshotRef?: string };
  evidence?: Array<{ id: string; status: string; outputDigest?: string; snapshotKind?: string; snapshotRef?: string }>;
}

export interface ScheduledVerificationProjection {
  verificationStatus: "passed" | "failed" | "inconclusive" | "not_performed";
  verificationLevel: "not_performed" | "implementation" | "integration" | "outcome";
  independentOutcomeObserved: boolean;
  verificationEvidenceIds: string[];
  verificationReportSha256?: string;
  verificationResults: Array<{
    criterionId: string;
    command: string;
    status: "passed" | "failed" | "inconclusive";
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
    outputTail: string;
    outputSha256: string;
    failureSetSha256: string;
  }>;
  verificationBlockers: string[];
  unresolvedBlockers: string[];
}

function verificationResults(execution?: ScheduledVerificationExecution): ScheduledVerificationProjection["verificationResults"] {
  if (!execution?.reportText) return [];
  try {
    const parsed = JSON.parse(execution.reportText) as { results?: ScheduledVerificationProjection["verificationResults"] };
    return Array.isArray(parsed.results) ? parsed.results : [];
  } catch {
    return [];
  }
}

export function projectScheduledVerification(input: {
  mission?: MissionVerificationProjectionInput;
  scheduled?: ScheduledVerificationExecution;
}): ScheduledVerificationProjection {
  const { mission, scheduled } = input;
  const results = verificationResults(scheduled);
  const missionFailed = mission?.completionReport?.status === "failed"
    || mission?.evidence?.some((entry) => entry.status === "failed") === true;
  const missionHasPassedEvidence = mission?.completionReport?.status === "passed"
    && (mission.verificationEvidenceIds?.length ?? 0) > 0;
  const missionHasUncertainEvidence = Boolean(mission?.completionReport)
    && !missionFailed
    && !missionHasPassedEvidence;
  const scheduledFailed = scheduled?.status === "failed"
    || results.some((result) => result.status === "failed");
  const scheduledPassed = scheduled?.status === "completed"
    && results.length > 0
    && results.every((result) => result.status === "passed");
  const scheduledUncertain = scheduled?.status === "running"
    || (scheduled?.status === "completed" && results.some((result) => result.status === "inconclusive"));

  const hasEvidence = Boolean(missionHasPassedEvidence || missionFailed || missionHasUncertainEvidence || scheduled);
  const verificationStatus = missionFailed || scheduledFailed
    ? "failed"
    : missionHasUncertainEvidence || scheduledUncertain
      ? "inconclusive"
      : missionHasPassedEvidence || scheduledPassed
        ? "passed"
        : hasEvidence ? "inconclusive" : "not_performed";

  const outcomeIds = mission?.outcomeObservationIds ?? [];
  const hasOutcome = outcomeIds.length > 0;
  const verificationLevel = hasOutcome
    ? "outcome"
    : verificationStatus === "not_performed"
      ? "not_performed"
      : mission?.requiredEvidenceLevel === "integration_verified" && missionHasPassedEvidence
        ? "integration"
        : missionHasPassedEvidence || scheduledPassed || scheduledUncertain || scheduledFailed
          ? "implementation"
          : "not_performed";

  const verificationBlockers = [
    ...(missionFailed ? ["Mission verification evidence contains a failed result."] : []),
    ...(missionHasUncertainEvidence ? ["Mission verification has no qualifying passed evidence for the current submission."] : []),
    ...(scheduled?.failureReason ? [scheduled.failureReason] : []),
    ...results.filter((result) => result.status !== "passed").map((result) => `${result.status}: ${result.command}`),
    ...(scheduled?.status === "running" ? ["Scheduled verification is still running."] : []),
    ...(!missionHasPassedEvidence && !scheduledPassed && !scheduled && !missionFailed && !missionHasUncertainEvidence
      ? ["No qualifying verification receipt is available for the current submission."]
      : []),
  ];
  const evidenceIds = [
    ...(mission?.verificationEvidenceIds ?? []),
    ...outcomeIds,
    ...(missionHasPassedEvidence && mission?.completionReport ? [mission.completionReport.id] : []),
    ...(scheduled ? [`scheduled-verification:${scheduled.executionIdentity}`] : []),
  ];
  const uniqueEvidenceIds = [...new Set(evidenceIds)];
  return {
    verificationStatus,
    verificationLevel,
    independentOutcomeObserved: hasOutcome,
    verificationEvidenceIds: uniqueEvidenceIds,
    verificationReportSha256: scheduled?.reportSha256,
    verificationResults: results,
    verificationBlockers,
    unresolvedBlockers: [...new Set([...(mission?.approval?.reasons ?? []), ...verificationBlockers])],
  };
}
