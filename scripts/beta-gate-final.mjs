// Final stable-beta qualification gate.
//
// This is intentionally a small evidence joiner. The expensive code gate and
// the real wall-clock soak run independently; this command qualifies only
// when both receipts describe the same candidate and the checkout is still
// clean and unchanged at the final decision point.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBetaSoakAssertions } from "./beta-soak-contract.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const codeReceiptPath = resolve(process.env.KONTROL_BETA_CODE_RECEIPT ?? join(root, "beta-code-qualification.json"));
const soakReportPath = resolve(process.env.KONTROL_BETA_SOAK_REPORT ?? join(root, "beta-soak.json"));
const receiptPath = resolve(process.env.KONTROL_BETA_RECEIPT ?? join(root, "beta-qualification.json"));
const STABLE_BETA_MIN_SOAK_HOURS = 12;
const configuredMinimumSoakHours = Number(process.env.KONTROL_BETA_MIN_SOAK_HOURS ?? STABLE_BETA_MIN_SOAK_HOURS);
// The environment may require a longer soak, but it must never weaken the
// stable-beta release policy.
const minimumSoakHours = Number.isFinite(configuredMinimumSoakHours)
  ? Math.max(STABLE_BETA_MIN_SOAK_HOURS, configuredMinimumSoakHours)
  : STABLE_BETA_MIN_SOAK_HOURS;

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
const code = codeResult.value;
const soak = soakResult.value;
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
const soakStartedAtMs = Date.parse(soak?.startedAt ?? "");
const soakFinishedAtMs = Date.parse(soak?.finishedAt ?? "");
const soakDuration = Boolean(
  Number(soak?.requestedHours) >= minimumSoakHours
  && Number.isFinite(soakStartedAtMs)
  && Number.isFinite(soakFinishedAtMs)
  && soakFinishedAtMs - soakStartedAtMs >= minimumSoakHours * 60 * 60_000,
);

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

const receipt = {
  kind: "kontrol-beta-qualification",
  status: "failed",
  qualified: false,
  createdAt: new Date().toISOString(),
  policy: {
    cleanCheckoutRequired: true,
    matchingCodeReceiptRequired: true,
    matchingWallClockSoakRequired: true,
    diagnosticsRequired: true,
    tunnelMonitoringRequired: true,
    minimumSoakHours,
  },
  inputs: {
    codeReceiptPath,
    soakReportPath,
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
    started: soakStart,
    finished: soakFinish,
    assertions: soakAssertions,
    missingAssertions: soakAssertionCheck.missing,
    invalidAssertions: soakAssertionCheck.invalid,
    duration: soakDuration,
    identity: soakIdentity,
    assertionsPass: soakAssertionsPass,
  } : { error: soakResult.error, identity: false, assertionsPass: false },
  checks: {
    codeReceiptPresent: Boolean(code),
    codeQualified: code?.codeQualified === true,
    faultMatrixQualified: code?.faultMatrix?.qualified === true,
    candidateIdentity,
    sourceUnchanged,
    soakDuration,
    soakIdentity,
    soakAssertionsPass,
  },
};
receipt.qualified = Object.values(receipt.checks).every(Boolean);
receipt.status = receipt.qualified ? "qualified" : "failed";
receipt.finishedAt = new Date().toISOString();
writeReceipt(receipt);

console.log(`[beta-gate-final] ${receipt.qualified ? "QUALIFIED" : "NOT QUALIFIED"}`);
console.log(`[beta-gate-final] receipt=${receiptPath}`);
if (!receipt.qualified) process.exitCode = 1;
