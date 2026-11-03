// Canonical stable-beta release gate.
//
// Every phase is recorded before and after execution so an interrupted gate
// leaves an inspectable receipt. The gate may be run with --allow-dirty for
// engineering feedback, but a dirty checkout can never produce a qualified
// stable-beta receipt.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { MINIMUM_DEPLOYMENT_UPTIME_MS, validateBetaDeploymentUptimeReceipt, validateBetaFaultMatrix } from "./beta-soak-contract.mjs";
import { validateBetaExternalCatalogReceipt } from "./beta-external-catalog-contract.mjs";
import { testHarnessEnvironment } from "./lib/tool-environment.mjs";
import { runQualificationProcess } from "./lib/qualification-process.mjs";
import { evaluateCandidateIdentity, evaluateGateVerdict, evaluateSoakEvidence } from "./lib/qualification-evaluator.mjs";
import { acquireControllerLease, reconcilePhases, releaseControllerLease } from "./lib/qualification-controller.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const codeOnly = process.argv.includes("--code-only");
const allowDirty = process.argv.includes("--allow-dirty") || process.env.KONTROL_BETA_ALLOW_DIRTY === "true";
const receiptPath = resolve(
  process.env[codeOnly ? "KONTROL_BETA_CODE_RECEIPT" : "KONTROL_BETA_RECEIPT"]
    ?? join(root, codeOnly ? "beta-code-qualification.json" : "beta-qualification.json"),
);
const faultReportPath = resolve(process.env.KONTROL_BETA_FAULT_REPORT ?? join(root, "beta-fault-matrix.json"));
const soakReportPath = resolve(process.env.KONTROL_BETA_SOAK_REPORT ?? join(root, "beta-soak.json"));
const deploymentUptimeReceiptPath = resolve(process.env.KONTROL_BETA_DEPLOYMENT_UPTIME_RECEIPT ?? join(root, "deployment-uptime-qualification.json"));
const externalCatalogReceiptPath = resolve(process.env.KONTROL_BETA_EXTERNAL_CATALOG_RECEIPT ?? join(root, "beta-external-catalog.json"));
const minimumDeploymentUptimeHours = MINIMUM_DEPLOYMENT_UPTIME_MS / 3_600_000;
const startedAt = new Date().toISOString();
const receipt = {
  kind: "kontrol-beta-qualification",
  stage: codeOnly ? "code" : "combined",
  status: "running",
  qualified: false,
  policy: {
    cleanCheckoutRequired: true,
    allowDirtyRequested: allowDirty,
    minimumDeploymentUptimeHours,
    matchingDeploymentUptimeReceiptRequired: !codeOnly,
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

// Every gate phase runs under the shared qualification executor with an
// absolute deadline: a hung phase can no longer leave the receipt stuck at
// "running". Deadlines are generous wall-clock ceilings, not targets.
const PHASE_DEADLINE_MS = 30 * 60_000;
const phaseDeadlinesMs = {
  "runtime-suite": 100 * 60_000,
  "installed-product-uat": 90 * 60_000,
  "fault-matrix": 180 * 60_000,
  "immutable-candidate-build": 20 * 60_000,
};
const gateRunId = process.env.KONTROL_BETA_RUN_ID ?? `beta-gate-${Date.now().toString(36)}`;
receipt.runId = gateRunId;

// Stage 4: one writer per receipt. A live controller blocks a duplicate
// gate; a dead controller's unsettled "running" phases are reconciled to
// "interrupted" before this run appends its own evidence. A receipt can
// never again retain a permanent "running" status across gate restarts.
const leasePath = `${receiptPath}.controller-lease.json`;
{
  const lease = acquireControllerLease({
    leasePath, runId: gateRunId, receiptPath,
    readFileSync, writeFileSync, mkdirSync,
  });
  if (!lease.acquired) {
    console.error(`[beta-gate] BLOCKED: ${lease.reason}`);
    process.exit(2);
  }
  if (lease.reconciled) {
    try {
      const prior = JSON.parse(readFileSync(receiptPath, "utf8"));
      const { phases, interruptedCount } = reconcilePhases(
        prior.phases,
        `prior controller run ${lease.reconciled.priorRunId} did not settle this phase`,
      );
      receipt.phases.push(...phases);
      receipt.reconciledPriorRun = {
        priorRunId: lease.reconciled.priorRunId,
        priorPid: lease.reconciled.priorPid,
        carriedPhases: phases.length,
        interruptedPhases: interruptedCount,
      };
      console.log(`[beta-gate] reconciled prior run ${lease.reconciled.priorRunId}: ${interruptedCount} running phase(s) marked interrupted`);
    } catch {
      // No usable prior receipt; this run starts the history.
    }
  }
}

// A controller shutdown (SIGTERM/SIGINT) never strands a phase as "running":
// in-flight work settles under the executor's own absolute deadline, new
// dispatches are refused, and the receipt records "interrupted".
let controllerStopping = null;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    if (controllerStopping) return;
    controllerStopping = signal;
    for (const phase of receipt.phases) {
      if (phase.status === "running") {
        phase.status = "interrupted";
        phase.finishedAt = new Date().toISOString();
        phase.reason = `controller received ${signal} mid-phase`;
      }
    }
    try {
      persist();
    } catch {
      // Best-effort on the way out; the lease still fences successors.
    }
    console.error(`[beta-gate] ${signal} received; refusing new phases, in-flight work settles under its own deadline`);
  });
}

async function runPhase(id, command, args, environment = {}) {
  const phase = {
    id,
    command: [command, ...args].join(" "),
    status: controllerStopping ? "interrupted" : "running",
    startedAt: new Date().toISOString(),
    deadlineMs: phaseDeadlinesMs[id] ?? PHASE_DEADLINE_MS,
    deadlineAt: new Date(Date.now() + (phaseDeadlinesMs[id] ?? PHASE_DEADLINE_MS)).toISOString(),
  };
  if (controllerStopping) {
    phase.finishedAt = new Date().toISOString();
    phase.reason = `controller shutdown (${controllerStopping}) requested before dispatch; phase never started`;
    receipt.phases.push(phase);
    persist();
    console.log(`[beta-gate] INTERRUPTED ${id} (never dispatched)`);
    return false;
  }
  receipt.phases.push(phase);
  persist();
  console.log(`\n[beta-gate] START ${id}: ${phase.command} (deadline ${phase.deadlineMs}ms)`);
  const receipt_ = await runQualificationProcess({
    runId: gateRunId,
    phaseId: id,
    command,
    args,
    cwd: root,
    // P1.10: explicit allowlist; launcher authority never reaches gate
    // children. Phases pass their own test-hook keys via `environment`.
    env: testHarnessEnvironment(process.env, { overrides: { KONTROL_BETA_GATE: "1", ...environment } }),
    deadlineMs: phase.deadlineMs,
  });
  phase.status = receipt_.status.toLowerCase();
  phase.exitCode = receipt_.exitCode;
  phase.signal = receipt_.signal;
  phase.timedOut = receipt_.timedOut;
  phase.escalated = receipt_.escalated;
  phase.cleanupVerified = receipt_.cleanupVerified;
  phase.cleanupFailures = receipt_.cleanupFailures;
  phase.durationMs = receipt_.durationMs;
  phase.finishedAt = new Date().toISOString();
  if (controllerStopping) {
    // The executor settled the child under its own deadline, but the
    // controller was asked to stop mid-phase: the phase is interrupted,
    // never passed, so its evidence cannot qualify anything.
    phase.status = "interrupted";
    phase.reason = `controller received ${controllerStopping} mid-phase; executor outcome was ${receipt_.status.toLowerCase()}`;
  }
  persist();
  if (phase.status !== "passed" && receipt_.outputTail) {
    process.stderr.write(receipt_.outputTail + (receipt_.outputTail.endsWith("\n") ? "" : "\n"));
  }
  console.log(`[beta-gate] ${phase.status.toUpperCase()} ${id} (${phase.durationMs}ms)`);
  return !controllerStopping && phase.status === "passed";
}

async function runEvidencePhase(id, command, args, evidence) {
  const phaseIndex = receipt.phases.length;
  const passed = await runPhase(id, command, args);
  const phase = receipt.phases[phaseIndex];
  phase.testName = evidence.testName;
  phase.evidenceScope = evidence.scope;
  phase.assertions = Object.fromEntries(evidence.assertions.map((assertion) => [assertion, passed]));
  if (evidence.excludes?.length) phase.excludes = evidence.excludes;
  persist();
  return passed;
}

// The gate's own controller lease lives next to the receipt by design (it
// serializes concurrent gate runs). It is gate runtime state, never source,
// so the cleanliness probe excludes exactly the lease file this gate owns;
// any other untracked or modified path still fails the check.
const dirtyPaths = gitStatus().filter(
  (entry) => entry.slice(3) !== relative(root, leasePath),
);
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

// Keep scheduled control-plane lifecycle evidence separate from proof of
// bundled-adapter confinement: the unattended fixture's ACP endpoint writes
// its artifact directly and cannot qualify the adapter security boundary.
await runEvidencePhase(
  "scheduled-control-plane-lifecycle",
  process.execPath,
  ["--import", "tsx", "scripts/scheduled-job-unattended-e2e.mjs"],
  {
    testName: "scripts/scheduled-job-unattended-e2e.mjs",
    scope: "public scheduling, production scheduler dispatch, work-session correlation, durable result, restart recovery, and terminal convergence",
    assertions: ["public_schedule", "production_scheduler_dispatch", "work_session_correlation", "durable_result", "restart_recovery", "terminal_convergence"],
    excludes: ["bundled_adapter_confinement", "read_only_sandbox_security"],
  },
);
await runEvidencePhase(
  "scheduled-bundled-adapter-confinement",
  process.execPath,
  ["--import", "tsx", "scripts/scheduled-readonly-adapters-e2e.mjs"],
  {
    testName: "scripts/scheduled-readonly-adapters-e2e.mjs",
    scope: "scheduled execution through the bundled CRUSH and Hermes adapters with real Bubblewrap confinement",
    assertions: ["bundled_crush_adapter", "bundled_hermes_adapter", "real_bubblewrap_invoked", "workspace_mutations_denied", "symlink_escape_denied", "helper_process_confined", "read_only_execution_receipt_persisted"],
  },
);
await runEvidencePhase(
  "bundled-adapter-grant-and-receipt",
  process.execPath,
  ["src/acp-readonly-adapters.integration.test.mjs"],
  {
    testName: "src/acp-readonly-adapters.integration.test.mjs",
    scope: "adapter-level signed grant enforcement, confined execution, and controller receipt acknowledgement for CRUSH and Hermes",
    assertions: ["forged_grant_rejected_before_launch", "signed_network_policy_enforced", "mutation_denied", "durable_receipt_acknowledged", "receipt_lookup_preserves_execution_identity"],
  },
);
await runEvidencePhase(
  "bundled-adapter-crash-recovery",
  process.execPath,
  ["scripts/lib/adapter-launch-recovery.test.mjs"],
  {
    testName: "scripts/lib/adapter-launch-recovery.test.mjs",
    scope: "durable adapter child ownership and launch-gate crash recovery",
    assertions: ["pre_wrapper_crash_reconciled", "pre_ownership_crash_reconciled", "start_intent_crash_fails_closed", "spawned_child_terminated", "response_loss_does_not_duplicate_execution"],
  },
);

// Later phases remain independent so the receipt identifies whether a failure
// is runtime, packaging, candidate boot, or recovery behavior.
await runPhase("runtime-suite", "npm", ["run", "test:runtime"]);
await runPhase("package-install", "npm", ["run", "test:package"]);
// P1-D: installed-product-uat runs after the immutable candidate build and
// exercises that exact artifact via --candidate. See below.

const buildRoot = mkdtempSync(join(tmpdir(), "kontrol-beta-gate-"));
const buildResultPath = join(buildRoot, "build-result.json");
try {
  const built = await runPhase("immutable-candidate-build", "npm", ["run", "build"], {
    KONTROL_BUILD_RESULT_PATH: buildResultPath,
  });
  if (built && existsSync(buildResultPath)) {
    const candidate = JSON.parse(readFileSync(buildResultPath, "utf8"));
    const metadataPath = join(candidate.artifactPath, "build-meta.json");
    const metadata = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, "utf8")) : undefined;
    receipt.candidate = { ...candidate, metadata };
    persist();
    const validated = await runPhase("candidate-module-closure", process.execPath, ["scripts/validate-release.mjs", candidate.artifactPath]);
    if (validated) await runPhase("candidate-isolated-boot", process.execPath, ["scripts/probe-release.mjs", "--boot", candidate.artifactPath]);
    // P1-D: UAT exercises the exact immutable candidate above — never a
    // rebuild. It runs whenever the candidate exists (diagnostic
    // continuation); qualification eligibility is decided by the receipt.
    await runPhase("installed-product-uat", process.execPath, ["scripts/release-uat.mjs", "--candidate", candidate.artifactPath]);
  } else {
    const phase = { id: "candidate-module-closure", status: "skipped", reason: "immutable candidate build did not produce a result" };
    receipt.phases.push(phase);
    const bootPhase = { id: "candidate-isolated-boot", status: "skipped", reason: "immutable candidate build did not produce a result" };
    receipt.phases.push(bootPhase);
    const uatPhase = { id: "installed-product-uat", status: "blocked", reason: "no immutable candidate to exercise; refusal to test a rebuilt artifact" };
    receipt.phases.push(uatPhase);
    persist();
  }
} finally {
  rmSync(buildRoot, { recursive: true, force: true });
}

await runPhase("fault-matrix", process.execPath, ["scripts/beta-fault-matrix.mjs"], {
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
// P1-E: identity and soak verdicts are computed by the side-effect-free
// evaluator, not by the orchestrating controller. The controller assembles
// evidence; only the evaluator judges it.
const { pass: candidateIdentityPass, ...candidateIdentityPhase } = evaluateCandidateIdentity({
  candidate: receipt.candidate,
  sourceStarted: receipt.source.started,
  endingGitSha,
  endingDirtyPaths,
});
receipt.phases.push(candidateIdentityPhase);
receipt.candidateIdentity = candidateIdentityPhase;

if (!codeOnly) {
  let soak;
  try {
    soak = JSON.parse(readFileSync(soakReportPath, "utf8"));
  } catch (error) {
    soak = undefined;
    receipt.soak = { path: soakReportPath, error: error instanceof Error ? error.message : String(error) };
  }
  const soakCheck = evaluateSoakEvidence(soak, {
    candidateBuildId: receipt.candidate?.buildId,
    sourceStartedGitSha: receipt.source.started.gitSha,
  });
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
    id: "continuity-soak-evidence",
    command: `read ${soakReportPath}`,
    status: soakCheck.passed ? "passed" : "failed",
    ...soakCheck,
    finishedAt: new Date().toISOString(),
  });

  let deploymentUptime;
  try {
    deploymentUptime = JSON.parse(readFileSync(deploymentUptimeReceiptPath, "utf8"));
  } catch (error) {
    receipt.deploymentUptime = { path: deploymentUptimeReceiptPath, error: error instanceof Error ? error.message : String(error) };
  }
  const deploymentUptimeCheck = validateBetaDeploymentUptimeReceipt(deploymentUptime, {
    candidateBuildId: receipt.candidate?.buildId,
    sourceSha: receipt.source.started.gitSha,
    contentSha256: receipt.candidate?.metadata?.contentSha256,
    minimumCheckedAt: soak?.finishedAt,
  });
  receipt.deploymentUptime = {
    path: deploymentUptimeReceiptPath,
    status: deploymentUptime?.status,
    qualified: deploymentUptime?.qualified === true,
    buildId: deploymentUptime?.deployment?.buildId,
    sourceSha: deploymentUptime?.deployment?.sourceSha,
    generationId: deploymentUptime?.deployment?.generationId,
    uptimeMs: deploymentUptime?.uptimeMs,
    ...deploymentUptimeCheck,
  };
  receipt.phases.push({
    id: "deployment-uptime-evidence",
    command: `read ${deploymentUptimeReceiptPath}`,
    status: deploymentUptimeCheck.valid ? "passed" : "failed",
    ...deploymentUptimeCheck,
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
// P1-E: the verdict is computed by the side-effect-free evaluator from the
// assembled evidence. Any non-passing executor outcome (failed, timed_out,
// interrupted, infra_error, cleanup_failed, skipped) blocks qualification;
// only an explicit "warning" (dirty checkout with --allow-dirty) is tolerated.
const verdict = evaluateGateVerdict({
  phases: receipt.phases,
  codeOnly,
  cleanPass,
  candidateIdentityPass,
  identityStable: receipt.source.identityStable,
  dirtySetStable: receipt.source.dirtySetStable,
  cleanAtEnd: receipt.source.cleanAtEnd,
});
receipt.codeQualified = verdict.codeQualified;
receipt.qualified = verdict.qualified;
receipt.status = verdict.status;
if (!codeOnly) {
  receipt.checks = {
    ...(receipt.checks ?? {}),
    externalCatalogFresh: receipt.externalCatalog?.valid === true,
  };
}
receipt.policy.cleanCheckout = cleanPass && receipt.source.cleanAtEnd;
receipt.policy.continuitySoakRequired = !codeOnly;
receipt.policy.deploymentUptimeRequired = !codeOnly;
receipt.policy.externalCatalogRequired = !codeOnly;
persist();
const resultLabel = receipt.qualified
  ? "QUALIFIED"
  : receipt.codeQualified
    ? (codeOnly ? "CODE QUALIFIED; DEPLOYMENT EVIDENCE REQUIRED" : "CODE QUALIFIED; UPTIME, CONTINUITY, OR EXTERNAL CATALOG EVIDENCE REQUIRED")
    : "NOT QUALIFIED";
console.log(`\n[beta-gate] ${resultLabel}`);
console.log(`[beta-gate] receipt=${receiptPath}`);
releaseControllerLease({ leasePath, runId: gateRunId, readFileSync, rmSync });
if (!receipt.qualified) process.exitCode = 1;
