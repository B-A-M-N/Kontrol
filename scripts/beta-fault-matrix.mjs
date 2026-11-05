// Stable-beta fault matrix runner.
//
// The individual tests are intentionally executed as separate child
// processes. That keeps one test's timers, HTTP server, or durable state from
// making the next scenario appear healthy by accident, and makes the report
// useful as release evidence rather than a single aggregate exit code.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testHarnessEnvironment } from "./lib/tool-environment.mjs";
import { runQualificationProcess } from "./lib/qualification-process.mjs";
import { REQUIRED_BETA_FAULT_CASES } from "./beta-soak-contract.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const reportPath = resolve(process.env.KONTROL_BETA_FAULT_REPORT ?? join(root, "beta-fault-matrix.json"));
const cases = [
  { id: "deployment-transaction", area: "deployment", command: process.execPath, args: ["src/start-all.behavior.test.mjs"] },
  { id: "release-closure-and-boot", area: "deployment", command: "npm", args: ["run", "test:release-artifact"] },
  { id: "schema-changing-database-rollback", area: "deployment", command: "npx", args: ["--no-install", "tsx", "src/db/deployment-backup.test.ts"] },
  { id: "mcp-process-continuity", area: "mcp", command: "npx", args: ["--no-install", "tsx", "src/mcp-process-continuity.test.ts"] },
  // P1 #9: mandatory transport-resilience evidence — lost launch response,
  // trusted reconnect, retry-same-clientMutationId (exactly one child), lost
  // poll response, retry-same-cursor (identical output), preserved final
  // state after exit.
  { id: "mcp-lost-launch-and-poll-recovery", area: "processes", command: "npx", args: ["--no-install", "tsx", "src/mcp-minimal-process.test.ts"] },
  { id: "mcp-session-reaper-and-sse", area: "mcp", command: "npx", args: ["--no-install", "tsx", "src/mcp-session-reuse.test.ts"] },
  { id: "process-session-lifecycle", area: "processes", command: "npx", args: ["--no-install", "tsx", "src/process-sessions.test.ts"] },
  { id: "approval-disconnect-reconnect", area: "approvals", command: "npx", args: ["--no-install", "tsx", "src/policy-ask-lifecycle.test.ts"] },
  // Both public mission entry paths, durable correction across restart,
  // current-snapshot evidence, finding resolution, and exact approval.
  { id: "supervised-mission-loop", area: "missions", command: process.execPath, args: ["scripts/supervised-mission-loop-qualification.mjs"] },
  { id: "accelerated-maintenance-integrity-soak", area: "maintenance", command: process.execPath, args: ["src/lifecycle-soak.test.mjs"] },
];

function writeReport(report) {
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
  const temporary = `${reportPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, reportPath);
}

const report = {
  kind: "kontrol-beta-fault-matrix",
  buildId: process.env.KONTROL_BETA_BUILD_ID,
  startedAt: new Date().toISOString(),
  qualified: false,
  cases: [],
};
writeReport(report);

// Deadlines are generous wall-clock ceilings, not performance targets.
const caseDeadlineMs = Number(process.env.KONTROL_FAULT_CASE_TIMEOUT_MS ?? 15 * 60_000);
const runId = process.env.KONTROL_BETA_RUN_ID ?? `fault-matrix-${Date.now().toString(36)}`;

for (const testCase of cases) {
  console.log(`[beta-fault-matrix] START ${testCase.id}`);
  // Persist running before dispatch so an interrupted run never retains a
  // silent gap; terminal evidence replaces this entry after cleanup.
  const runningEntry = {
    ...testCase,
    passed: false,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  report.cases.push(runningEntry);
  writeReport(report);
  const receipt = await runQualificationProcess({
    runId,
    phaseId: testCase.id,
    command: testCase.command,
    args: testCase.args,
    cwd: root,
    // P1.10: explicit allowlist; the matrix's isolated tests get the
    // toolchain, not the launcher environment.
    env: testHarnessEnvironment(process.env, { overrides: { KONTROL_BETA_FAULT_MATRIX: "1" } }),
    deadlineMs: caseDeadlineMs,
  });
  const passed = receipt.status === "PASSED";
  if (!passed && receipt.outputTail) {
    process.stderr.write(receipt.outputTail + (receipt.outputTail.endsWith("\n") ? "" : "\n"));
  }
  report.cases[report.cases.indexOf(runningEntry)] = {
    ...testCase,
    passed,
    status: receipt.status.toLowerCase(),
    exitCode: receipt.exitCode,
    signal: receipt.signal,
    timedOut: receipt.timedOut,
    escalated: receipt.escalated,
    cleanupVerified: receipt.cleanupVerified,
    cleanupFailures: receipt.cleanupFailures,
    durationMs: receipt.durationMs,
    finishedAt: new Date().toISOString(),
  };
  writeReport(report);
  console.log(`[beta-fault-matrix] ${passed ? "PASS" : receipt.status} ${testCase.id} in ${receipt.durationMs}ms`);
}

report.finishedAt = new Date().toISOString();
report.missingRequiredCases = REQUIRED_BETA_FAULT_CASES.filter((id) => !report.cases.some((testCase) => testCase.id === id && testCase.passed));
report.qualified = report.missingRequiredCases.length === 0 && report.cases.length === cases.length && report.cases.every((testCase) => testCase.passed);
writeReport(report);
console.log(`[beta-fault-matrix] ${report.qualified ? "QUALIFIED" : "FAILED"}; report=${reportPath}`);
if (!report.qualified) process.exitCode = 1;
