// Stable-beta fault matrix runner.
//
// The individual tests are intentionally executed as separate child
// processes. That keeps one test's timers, HTTP server, or durable state from
// making the next scenario appear healthy by accident, and makes the report
// useful as release evidence rather than a single aggregate exit code.
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testHarnessEnvironment } from "./lib/tool-environment.mjs";
import { REQUIRED_BETA_FAULT_CASES } from "./beta-soak-contract.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const reportPath = resolve(process.env.KONTROL_BETA_FAULT_REPORT ?? join(root, "beta-fault-matrix.json"));
const cases = [
  { id: "deployment-transaction", area: "deployment", command: process.execPath, args: ["src/start-all.behavior.test.mjs"] },
  { id: "release-closure-and-boot", area: "deployment", command: process.execPath, args: ["src/release-artifact.test.mjs"] },
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

for (const testCase of cases) {
  const startedAt = Date.now();
  console.log(`[beta-fault-matrix] START ${testCase.id}`);
  const result = spawnSync(testCase.command, testCase.args, {
    cwd: root,
    // P1.10: explicit allowlist; the matrix's isolated tests get the
    // toolchain, not the launcher environment.
    env: testHarnessEnvironment(process.env, { overrides: { KONTROL_BETA_FAULT_MATRIX: "1" } }),
    stdio: "inherit",
    encoding: "utf8",
  });
  const passed = result.status === 0 && result.signal === null;
  report.cases.push({
    ...testCase,
    passed,
    exitCode: result.status,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    finishedAt: new Date().toISOString(),
  });
  writeReport(report);
  console.log(`[beta-fault-matrix] ${passed ? "PASS" : "FAIL"} ${testCase.id}`);
}

report.finishedAt = new Date().toISOString();
report.missingRequiredCases = REQUIRED_BETA_FAULT_CASES.filter((id) => !report.cases.some((testCase) => testCase.id === id && testCase.passed));
report.qualified = report.missingRequiredCases.length === 0 && report.cases.length === cases.length && report.cases.every((testCase) => testCase.passed);
writeReport(report);
console.log(`[beta-fault-matrix] ${report.qualified ? "QUALIFIED" : "FAILED"}; report=${reportPath}`);
if (!report.qualified) process.exitCode = 1;
