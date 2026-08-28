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

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const reportPath = resolve(process.env.KONTROL_BETA_FAULT_REPORT ?? join(root, "beta-fault-matrix.json"));
const cases = [
  { id: "deployment-transaction", area: "deployment", command: process.execPath, args: ["src/start-all.behavior.test.mjs"] },
  { id: "release-closure-and-boot", area: "deployment", command: process.execPath, args: ["src/release-artifact.test.mjs"] },
  { id: "schema-changing-database-rollback", area: "deployment", command: "npx", args: ["--no-install", "tsx", "src/db/deployment-backup.test.ts"] },
  { id: "mcp-process-continuity", area: "mcp", command: "npx", args: ["--no-install", "tsx", "src/mcp-process-continuity.test.ts"] },
  { id: "mcp-session-reaper-and-sse", area: "mcp", command: "npx", args: ["--no-install", "tsx", "src/mcp-session-reuse.test.ts"] },
  { id: "process-session-lifecycle", area: "processes", command: "npx", args: ["--no-install", "tsx", "src/process-sessions.test.ts"] },
  { id: "approval-disconnect-reconnect", area: "approvals", command: "npx", args: ["--no-install", "tsx", "src/policy-ask-lifecycle.test.ts"] },
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
    // kontrol-env-exception: the matrix launches repository-owned isolated
    // tests; preserving the caller's toolchain environment is intentional.
    env: { ...process.env, KONTROL_BETA_FAULT_MATRIX: "1" },
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
report.qualified = report.cases.length === cases.length && report.cases.every((testCase) => testCase.passed);
writeReport(report);
console.log(`[beta-fault-matrix] ${report.qualified ? "QUALIFIED" : "FAILED"}; report=${reportPath}`);
if (!report.qualified) process.exitCode = 1;
