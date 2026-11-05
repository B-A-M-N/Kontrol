// Final stable-beta qualification gate.
//
// This is intentionally a small evidence joiner. The code gate, continuity
// workload, CI-observed deployment uptime, and fresh external host-catalog
// probe run independently; qualify only when all evidence describes the same
// candidate and the checkout is clean and unchanged at the final decision.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MINIMUM_DEPLOYMENT_UPTIME_MS, validateBetaDeploymentUptimeReceipt, validateBetaFaultMatrix, validateBetaSoakAssertions } from "./beta-soak-contract.mjs";
import { validateBetaExternalCatalogReceipt } from "./beta-external-catalog-contract.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const codeReceiptPath = resolve(process.env.KONTROL_BETA_CODE_RECEIPT ?? join(root, "beta-code-qualification.json"));
const soakReportPath = resolve(process.env.KONTROL_BETA_SOAK_REPORT ?? join(root, "beta-soak.json"));
const deploymentUptimeReceiptPath = resolve(process.env.KONTROL_BETA_DEPLOYMENT_UPTIME_RECEIPT ?? join(root, "deployment-uptime-qualification.json"));
const externalCatalogReceiptPath = resolve(process.env.KONTROL_BETA_EXTERNAL_CATALOG_RECEIPT ?? join(root, "beta-external-catalog.json"));
const receiptPath = resolve(process.env.KONTROL_BETA_RECEIPT ?? join(root, "beta-qualification.json"));
const MINIMUM_DEPLOYMENT_UPTIME_HOURS = MINIMUM_DEPLOYMENT_UPTIME_MS / 3_600_000;

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function gitStatus() {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
    return output ? output.split("\n") : [];
  } catch (error) {
    return [`git status failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function writeReceipt(receipt) {
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  const temporary = `${receiptPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, receiptPath);
}

const codeResult = readJson(codeReceiptPath);
const soakResult = readJson(soakReportPath);
const deploymentUptimeResult = readJson(deploymentUptimeReceiptPath);
const externalCatalogResult = readJson(externalCatalogReceiptPath);
const code = codeResult.value;
const soak = soakResult.value;
const deploymentUptime = deploymentUptimeResult.value;
const externalCatalog = externalCatalogResult.value;
const finalGitSha = gitSha();
const finalDirtyPaths = gitStatus();
const candidate = code?.candidate;
const candidateMetadata = candidate?.metadata;
const candidateBuildId = candidate?.buildId;
const codeStart = code?.source?.started;
const codeFinish = code?.source?.finished;
const soakStart = soak?.snapshots?.started;
const soakFinish = soak?.snapshots?.finished;
const soakAssertions = soak?.assertions;
const soakAssertionCheck = validateBetaSoakAssertions(soakAssertions);
const faultMatrixCheck = validateBetaFaultMatrix(code?.faultMatrix, { candidateBuildId });
const soakStartedAtMs = Date.parse(soak?.startedAt ?? "");
const soakFinishedAtMs = Date.parse(soak?.finishedAt ?? "");
const soakWindowValid = Boolean(
  Number.isFinite(soakStartedAtMs)
  && Number.isFinite(soakFinishedAtMs)
  && soakFinishedAtMs >= soakStartedAtMs,
);
const uptimeChecks = deploymentUptime?.checks;
const deploymentUptimeCheck = validateBetaDeploymentUptimeReceipt(deploymentUptime, {
  candidateBuildId,
  sourceSha: codeStart?.gitSha,
  contentSha256: candidateMetadata?.contentSha256,
  minimumCheckedAt: soak?.finishedAt,
});
const deploymentUptimeQualified = deploymentUptimeCheck.valid;

const sourceUnchanged = Boolean(
  code?.codeQualified === true
  && codeStart?.gitSha
  && codeStart.gitSha === codeFinish?.gitSha
  && codeStart.gitSha === finalGitSha
  && Array.isArray(codeStart.dirtyPaths)
  && Array.isArray(codeFinish?.dirtyPaths)
  && codeStart.dirtyPaths.length === 0
  && codeFinish.dirtyPaths.length === 0
  && finalDirtyPaths.length === 0,
);
const candidateIdentity = Boolean(
  candidateBuildId
  && candidateMetadata?.buildId === candidateBuildId
  && candidateMetadata.gitSha === codeStart?.gitSha
  && Number(candidateMetadata.gitDirty) === 0,
);
const soakIdentity = Boolean(
  soak?.status === "passed"
  && soak?.monitoring?.diagnosticsRequired !== false
  && soak?.monitoring?.tunnelRequired !== false
  && candidateBuildId
  && soak?.expectedBuildId === candidateBuildId
  && soakStart?.buildId === candidateBuildId
  && soakFinish?.buildId === candidateBuildId
  && soakStart?.generation?.activeBuildId === candidateBuildId
  && soakFinish?.generation?.activeBuildId === candidateBuildId
  && soakStart?.gitSha === codeStart?.gitSha
  && soakFinish?.gitSha === codeStart?.gitSha
  && (soakFinish?.gitDirty === undefined || Number(soakFinish.gitDirty) === 0),
);
const soakAssertionsPass = Boolean(
  soakAssertionCheck.valid,
);
const expectedMcpVersion = typeof candidateMetadata?.version === "string"
  && typeof candidateMetadata?.contentSha256 === "string"
  ? `${candidateMetadata.version}+${candidateMetadata.contentSha256}`
  : undefined;
const externalCatalogCheck = validateBetaExternalCatalogReceipt(externalCatalog, {
  candidateBuildId,
  expectedMcpVersion,
  soak,
});
const externalCatalogFresh = externalCatalogCheck.valid;

const receipt = {
  kind: "kontrol-beta-qualification",
  stage: "combined",
  status: "failed",
  qualified: false,
  createdAt: new Date().toISOString(),
  policy: {
    cleanCheckoutRequired: true,
    matchingCodeReceiptRequired: true,
    matchingDeploymentUptimeReceiptRequired: true,
    minimumDeploymentUptimeHours: MINIMUM_DEPLOYMENT_UPTIME_HOURS,
    soakContinuityWorkloadRequired: true,
    diagnosticsRequired: true,
    tunnelMonitoringRequired: true,
  },
  inputs: {
    codeReceiptPath,
    soakReportPath,
    deploymentUptimeReceiptPath,
    externalCatalogReceiptPath,
  },
  candidate: candidate ? {
    buildId: candidateBuildId,
    artifactPath: candidate.artifactPath,
    metadata: candidateMetadata,
  } : undefined,
  source: {
    codeStarted: codeStart,
    codeFinished: codeFinish,
    final: { gitSha: finalGitSha, dirtyPaths: finalDirtyPaths },
    unchanged: sourceUnchanged,
  },
  soak: soak ? {
    status: soak.status,
    expectedBuildId: soak.expectedBuildId,
    transport: soak.transport,
    sseProbeRuns: soak.sseProbeRuns,
    sseProbeFailures: soak.sseProbeFailures,
    sseLastEvidence: soak.sseLastEvidence,
    started: soakStart,
    finished: soakFinish,
    assertions: soakAssertions,
    missingAssertions: soakAssertionCheck.missing,
    invalidAssertions: soakAssertionCheck.invalid,
    windowValid: soakWindowValid,
    identity: soakIdentity,
    assertionsPass: soakAssertionsPass,
  } : { error: soakResult.error, identity: false, assertionsPass: false },
  deploymentUptime: deploymentUptime ? {
    status: deploymentUptime.status,
    qualified: deploymentUptime.qualified === true,
    path: deploymentUptimeReceiptPath,
    startedAt: deploymentUptime.startedAt,
    checkedAt: deploymentUptime.checkedAt,
    uptimeMs: deploymentUptime.uptimeMs,
    deployment: deploymentUptime.deployment,
    checks: uptimeChecks,
    invalidReasons: deploymentUptimeCheck.reasons,
    valid: deploymentUptimeQualified,
  } : { path: deploymentUptimeReceiptPath, error: deploymentUptimeResult.error, valid: false },
  externalCatalog: externalCatalog ? {
    status: externalCatalog.status,
    path: externalCatalogReceiptPath,
    expectedBuildId: externalCatalog.expectedBuildId,
    expectedMcpVersion: externalCatalog.expectedMcpVersion,
    serverInfoVersion: externalCatalog.serverInfoVersion,
    hostCatalogVersion: externalCatalog.hostCatalogVersion,
    hostCatalogCapturedAt: externalCatalog.hostCatalogCapturedAt,
    startedAt: externalCatalog.startedAt,
    finishedAt: externalCatalog.finishedAt,
    url: externalCatalog.url,
    transport: externalCatalog.transport,
    externalHostStreaming: externalCatalog.externalHostStreaming,
    hostFacingTransportObservation: externalCatalog.hostFacingTransportObservation,
    evidence: {
      serverToolDescriptors: externalCatalog.serverToolDescriptors,
      hostToolDescriptors: externalCatalog.hostToolDescriptors,
      serverCatalogEvidence: externalCatalog.serverCatalogEvidence,
      externalHostObservation: externalCatalog.externalHostObservation,
      externalCatalogObservationRecord: externalCatalog.externalCatalogObservationRecord,
      hostCatalogHandshake: externalCatalog.hostCatalogHandshake,
      qualificationEvidenceAssociation: externalCatalog.qualificationEvidenceAssociation,
      externalTransport: externalCatalog.externalTransport,
      probeClientAcknowledgements: externalCatalog.probeClientAcknowledgements,
    },
    catalogParity: externalCatalog.catalogParity === true,
    freshHostExchange: externalCatalog.freshHostExchange === true,
    ...externalCatalogCheck,
    freshForDeployedCandidate: externalCatalogFresh,
  } : { path: externalCatalogReceiptPath, error: externalCatalogResult.error, freshForDeployedCandidate: false },
  checks: {
    codeReceiptPresent: Boolean(code),
    codeQualified: code?.codeQualified === true,
    faultMatrixQualified: faultMatrixCheck.valid,
    supervisedMissionLoopQualified: faultMatrixCheck.valid,
    candidateIdentity,
    sourceUnchanged,
    soakWindowValid,
    soakIdentity,
    soakAssertionsPass,
    deploymentUptimeQualified,
    externalCatalogFresh,
  },
};
receipt.qualified = Object.values(receipt.checks).every(Boolean);
receipt.status = receipt.qualified ? "qualified" : "failed";
receipt.finishedAt = new Date().toISOString();
writeReceipt(receipt);

console.log(`[beta-gate-final] ${receipt.qualified ? "QUALIFIED" : "NOT QUALIFIED"}`);
console.log(`[beta-gate-final] receipt=${receiptPath}`);
if (!receipt.qualified) process.exitCode = 1;
