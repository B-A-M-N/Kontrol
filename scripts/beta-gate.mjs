// Canonical stable-beta release gate.
//
// Every phase is recorded before and after execution so an interrupted gate
// leaves an inspectable receipt. The gate may be run with --allow-dirty for
// engineering feedback, but a dirty checkout can never produce a qualified
// stable-beta receipt.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { validateBetaFaultMatrix, validateBetaSoakAssertions } from "./beta-soak-contract.mjs";
import { validateBetaExternalCatalogReceipt } from "./beta-external-catalog-contract.mjs";
import { testHarnessEnvironment } from "./lib/tool-environment.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const codeOnly = process.argv.includes("--code-only");
const allowDirty = process.argv.includes("--allow-dirty") || process.env.KONTROL_BETA_ALLOW_DIRTY === "true";
const receiptPath = resolve(
  process.env[codeOnly ? "KONTROL_BETA_CODE_RECEIPT" : "KONTROL_BETA_RECEIPT"]
    ?? join(root, codeOnly ? "beta-code-qualification.json" : "beta-qualification.json"),
);
const faultReportPath = resolve(process.env.KONTROL_BETA_FAULT_REPORT ?? join(root, "beta-fault-matrix.json"));
const soakReportPath = resolve(process.env.KONTROL_BETA_SOAK_REPORT ?? join(root, "beta-soak.json"));
const externalCatalogReceiptPath = resolve(process.env.KONTROL_BETA_EXTERNAL_CATALOG_RECEIPT ?? join(root, "beta-external-catalog.json"));
const STABLE_BETA_MIN_SOAK_HOURS = 12;
const configuredMinimumSoakHours = Number(process.env.KONTROL_BETA_MIN_SOAK_HOURS ?? STABLE_BETA_MIN_SOAK_HOURS);
// The environment may require a longer soak, but it must never weaken the
// stable-beta release policy.
const minimumSoakHours = Number.isFinite(configuredMinimumSoakHours)
  ? Math.max(STABLE_BETA_MIN_SOAK_HOURS, configuredMinimumSoakHours)
  : STABLE_BETA_MIN_SOAK_HOURS;
const startedAt = new Date().toISOString();
const receipt = {
  kind: "kontrol-beta-qualification",
  stage: codeOnly ? "code" : "combined",
  status: "running",
  qualified: false,
  policy: {
    cleanCheckoutRequired: true,
    allowDirtyRequested: allowDirty,
    minimumSoakHours,
  },
  startedAt,
  phases: [],
  candidate: undefined,
};

function persist() {
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  const temporary = `${receiptPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  // The receipt is operational evidence, not an active-generation pointer;
  // replacement is atomic on the local state filesystem.
  renameSync(temporary, receiptPath);
}

function gitStatus() {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
    return output ? output.split("\n") : [];
  } catch (error) {
    return [`git status failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function runPhase(id, command, args, environment = {}) {
  const phase = {
    id,
    command: [command, ...args].join(" "),
    status: "running",
    startedAt: new Date().toISOString(),
  };
  receipt.phases.push(phase);
  persist();
  console.log(`\n[beta-gate] START ${id}: ${phase.command}`);
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    // P1.10: explicit allowlist; launcher authority never reaches gate
    // children. Phases pass their own test-hook keys via `environment`.
    env: testHarnessEnvironment(process.env, { overrides: { KONTROL_BETA_GATE: "1", ...environment } }),
    stdio: "inherit",
  });
  phase.status = result.status === 0 && result.signal === null ? "passed" : "failed";
  phase.exitCode = result.status;
  phase.signal = result.signal;
  phase.durationMs = Date.now() - started;
  phase.finishedAt = new Date().toISOString();
  persist();
  console.log(`[beta-gate] ${phase.status.toUpperCase()} ${id} (${phase.durationMs}ms)`);
  return phase.status === "passed";
}

const dirtyPaths = gitStatus();
const cleanPass = dirtyPaths.length === 0;
receipt.source = {
  started: {
    dirtyPaths,
    gitSha: gitSha(),
  },
  dirtyPaths,
  gitSha: gitSha(),
};
const cleanPhase = {
  id: "clean-checkout",
  command: "git status --porcelain",
  status: cleanPass ? "passed" : (allowDirty ? "warning" : "failed"),
  dirtyPaths,
  finishedAt: new Date().toISOString(),
};
receipt.phases.push(cleanPhase);
persist();
console.log(`[beta-gate] ${cleanPhase.status.toUpperCase()} clean-checkout${dirtyPaths.length ? ` (${dirtyPaths.length} changed paths)` : ""}`);

// Run the complete local suite first. Later phases deliberately remain
// independent so the receipt identifies whether a failure is test, packaging,
// candidate boot, or recovery behavior.
runPhase("runtime-suite", "npm", ["run", "test:runtime"]);
runPhase("package-install", "npm", ["run", "test:package"]);
runPhase("installed-product-uat", "npm", ["run", "uat:release"]);

const buildRoot = mkdtempSync(join(tmpdir(), "kontrol-beta-gate-"));
const buildResultPath = join(buildRoot, "build-result.json");
try {
  const built = runPhase("immutable-candidate-build", "npm", ["run", "build"], {
    KONTROL_BUILD_RESULT_PATH: buildResultPath,
  });
  if (built && existsSync(buildResultPath)) {
    const candidate = JSON.parse(readFileSync(buildResultPath, "utf8"));
    const metadataPath = join(candidate.artifactPath, "build-meta.json");
    const metadata = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, "utf8")) : undefined;
    receipt.candidate = { ...candidate, metadata };
    persist();
    const validated = runPhase("candidate-module-closure", process.execPath, ["scripts/validate-release.mjs", candidate.artifactPath]);
    if (validated) runPhase("candidate-isolated-boot", process.execPath, ["scripts/probe-release.mjs", "--boot", candidate.artifactPath]);
  } else {
    const phase = { id: "candidate-module-closure", status: "skipped", reason: "immutable candidate build did not produce a result" };
    receipt.phases.push(phase);
    const bootPhase = { id: "candidate-isolated-boot", status: "skipped", reason: "immutable candidate build did not produce a result" };
    receipt.phases.push(bootPhase);
    persist();
  }
} finally {
  rmSync(buildRoot, { recursive: true, force: true });
}

runPhase("fault-matrix", process.execPath, ["scripts/beta-fault-matrix.mjs"], {
  KONTROL_BETA_FAULT_REPORT: faultReportPath,
  KONTROL_BETA_BUILD_ID: receipt.candidate?.buildId,
});
try {
  receipt.faultMatrix = JSON.parse(readFileSync(faultReportPath, "utf8"));
} catch {
  receipt.faultMatrix = { status: "missing", path: faultReportPath };
}
receipt.faultMatrixCheck = validateBetaFaultMatrix(receipt.faultMatrix, { candidateBuildId: receipt.candidate?.buildId });
receipt.phases.push({
  id: "fault-matrix-evidence",
  command: `read ${faultReportPath}`,
  status: receipt.faultMatrixCheck.valid ? "passed" : "failed",
  qualified: receipt.faultMatrixCheck.valid,
  missingRequiredCases: receipt.faultMatrixCheck.missing,
  buildMatches: receipt.faultMatrixCheck.buildMatches,
  finishedAt: new Date().toISOString(),
});
persist();

const endingDirtyPaths = gitStatus();
const endingGitSha = gitSha();
receipt.source.finished = {
  dirtyPaths: endingDirtyPaths,
  gitSha: endingGitSha,
};
receipt.source.identityStable = receipt.source.started.gitSha === endingGitSha;
receipt.source.cleanAtEnd = endingDirtyPaths.length === 0;
receipt.source.dirtySetStable = JSON.stringify(receipt.source.started.dirtyPaths) === JSON.stringify(endingDirtyPaths);
const candidateMetadata = receipt.candidate?.metadata;
const candidateIdentityPass = Boolean(
  receipt.candidate?.buildId
  && candidateMetadata?.buildId === receipt.candidate.buildId
  && candidateMetadata?.gitSha === receipt.source.started.gitSha
  && Number(candidateMetadata?.gitDirty) === receipt.source.started.dirtyPaths.length
  && endingGitSha === receipt.source.started.gitSha
  && JSON.stringify(receipt.source.started.dirtyPaths) === JSON.stringify(endingDirtyPaths),
);
const candidateIdentityPhase = {
  id: "candidate-source-identity",
  command: "build-meta.json + git status --porcelain + git rev-parse HEAD",
  status: candidateIdentityPass ? "passed" : "failed",
  candidateBuildId: receipt.candidate?.buildId,
  candidateGitSha: candidateMetadata?.gitSha,
  candidateGitDirty: candidateMetadata?.gitDirty,
  sourceStartedGitSha: receipt.source.started.gitSha,
  sourceFinishedGitSha: endingGitSha,
  sourceStartedDirtyPaths: receipt.source.started.dirtyPaths,
  sourceFinishedDirtyPaths: endingDirtyPaths,
  finishedAt: new Date().toISOString(),
};
receipt.phases.push(candidateIdentityPhase);
receipt.candidateIdentity = candidateIdentityPhase;

function validateSoakEvidence(soak) {
  if (!soak || soak.status !== "passed") return { passed: false, reason: "missing or non-passing soak report" };
  if (soak.monitoring?.diagnosticsRequired === false || soak.monitoring?.tunnelRequired === false) {
    return { passed: false, reason: "soak skipped required diagnostics or tunnel monitoring" };
  }
  const candidateBuildId = receipt.candidate?.buildId;
  const started = soak.snapshots?.started;
  const finished = soak.snapshots?.finished;
  const startedAtMs = Date.parse(soak.startedAt ?? "");
  const finishedAtMs = Date.parse(soak.finishedAt ?? "");
  const durationMatches = Number(soak.requestedHours) >= minimumSoakHours
    && Number.isFinite(startedAtMs)
    && Number.isFinite(finishedAtMs)
    && finishedAtMs - startedAtMs >= minimumSoakHours * 60 * 60_000;
  const buildMatches = Boolean(
    candidateBuildId
    && soak.expectedBuildId === candidateBuildId
    && started?.buildId === candidateBuildId
    && finished?.buildId === candidateBuildId,
  );
  const sourceMatches = Boolean(
    started?.gitSha === receipt.source.started.gitSha
    && finished?.gitSha === receipt.source.started.gitSha
    && (finished?.gitDirty === undefined || Number(finished.gitDirty) === 0),
  );
  const assertionCheck = validateBetaSoakAssertions(soak.assertions);
  return {
    passed: durationMatches && buildMatches && sourceMatches && assertionCheck.valid,
    durationMatches,
    buildMatches,
    sourceMatches,
    assertions: assertionCheck.valid,
    missingAssertions: assertionCheck.missing,
    invalidAssertions: assertionCheck.invalid,
    reason: durationMatches && buildMatches && sourceMatches && assertionCheck.valid ? undefined : "soak duration, identity, or required assertions did not match the candidate",
  };
}

if (!codeOnly) {
  let soak;
  try {
    soak = JSON.parse(readFileSync(soakReportPath, "utf8"));
  } catch (error) {
    soak = undefined;
    receipt.soak = { path: soakReportPath, error: error instanceof Error ? error.message : String(error) };
  }
  const soakCheck = validateSoakEvidence(soak);
  receipt.soak = {
    path: soakReportPath,
    status: soak?.status,
    expectedBuildId: soak?.expectedBuildId,
    startedBuildId: soak?.snapshots?.started?.buildId,
    finishedBuildId: soak?.snapshots?.finished?.buildId,
    startedGitSha: soak?.snapshots?.started?.gitSha,
    finishedGitSha: soak?.snapshots?.finished?.gitSha,
    assertions: soak?.assertions,
    ...soakCheck,
  };
  receipt.phases.push({
    id: "wall-clock-soak-evidence",
    command: `read ${soakReportPath}`,
    status: soakCheck.passed ? "passed" : "failed",
    ...soakCheck,
    finishedAt: new Date().toISOString(),
  });

  let externalCatalog;
  try {
    externalCatalog = JSON.parse(readFileSync(externalCatalogReceiptPath, "utf8"));
  } catch (error) {
    receipt.externalCatalog = {
      path: externalCatalogReceiptPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const candidateMetadata = receipt.candidate?.metadata;
  const expectedMcpVersion = typeof candidateMetadata?.version === "string"
    && typeof candidateMetadata?.contentSha256 === "string"
    ? `${candidateMetadata.version}+${candidateMetadata.contentSha256}`
    : undefined;
  const externalCatalogCheck = validateBetaExternalCatalogReceipt(externalCatalog, {
    candidateBuildId: receipt.candidate?.buildId,
    expectedMcpVersion,
    soak,
  });
  receipt.externalCatalog = {
    path: externalCatalogReceiptPath,
    ...receipt.externalCatalog,
    ...externalCatalogCheck,
  };
  receipt.phases.push({
    id: "external-host-catalog-evidence",
    command: `read ${externalCatalogReceiptPath}`,
    status: externalCatalogCheck.valid ? "passed" : "failed",
    ...externalCatalogCheck,
    finishedAt: new Date().toISOString(),
  });
}

receipt.finishedAt = new Date().toISOString();
const hardFailures = receipt.phases.filter((phase) => phase.status === "failed" || phase.status === "skipped");
const codeFailures = hardFailures.filter((phase) => phase.id !== "wall-clock-soak-evidence" && phase.id !== "external-host-catalog-evidence");
receipt.codeQualified = cleanPass
  && codeFailures.length === 0
  && candidateIdentityPass
  && receipt.source.identityStable
  && receipt.source.dirtySetStable
  && receipt.source.cleanAtEnd;
const soakQualified = codeOnly
  ? true
  : receipt.phases.find((phase) => phase.id === "wall-clock-soak-evidence")?.status === "passed"
    && receipt.phases.find((phase) => phase.id === "external-host-catalog-evidence")?.status === "passed";
receipt.qualified = receipt.codeQualified && soakQualified;
receipt.status = receipt.qualified ? "qualified" : (codeOnly ? "code_failed" : "failed");
if (!codeOnly) {
  receipt.checks = {
    ...(receipt.checks ?? {}),
    externalCatalogFresh: receipt.externalCatalog?.valid === true,
  };
}
receipt.policy.cleanCheckout = cleanPass && receipt.source.cleanAtEnd;
receipt.policy.soakRequired = !codeOnly;
receipt.policy.externalCatalogRequired = !codeOnly;
persist();
const resultLabel = receipt.qualified
  ? "QUALIFIED"
  : receipt.codeQualified
    ? (codeOnly ? "CODE QUALIFIED; DEPLOYMENT EVIDENCE REQUIRED" : "CODE QUALIFIED; SOAK OR EXTERNAL CATALOG EVIDENCE REQUIRED")
    : "NOT QUALIFIED";
console.log(`\n[beta-gate] ${resultLabel}`);
console.log(`[beta-gate] receipt=${receiptPath}`);
if (!receipt.qualified) process.exitCode = 1;
