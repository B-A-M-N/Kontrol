/**
 * Regression tests for the shared qualification executor (P0-A).
 * Synthetic children only; every case has a sub-second deadline so a
 * regression fails fast instead of stalling the suite.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQualificationProcess } from "./qualification-process.mjs";

const NODE = process.execPath;
let seq = 0;
const ids = () => `qp-test-${process.pid}-${seq++}`;

function childArgs(script) {
  return ["-e", script];
}

const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
}

// 1. Clean success exits normally with verified cleanup.
await check("clean pass", async () => {
  const receipt = await runQualificationProcess({
    runId: ids(), phaseId: "clean", command: NODE,
    args: childArgs("console.log('hello');"),
    deadlineMs: 5_000, graceMs: 500,
  });
  assert.equal(receipt.status, "PASSED");
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.cleanupVerified, true);
  assert.deepEqual(receipt.cleanupFailures, []);
  assert.ok(receipt.lifecycle.includes("REAPED"));
  assert.match(receipt.outputTail, /hello/);
});

// 2. Nonzero exit is FAILED, not a pass.
await check("nonzero exit", async () => {
  const receipt = await runQualificationProcess({
    runId: ids(), phaseId: "fail", command: NODE,
    args: childArgs("console.error('boom'); process.exit(3);"),
    deadlineMs: 5_000, graceMs: 500,
  });
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.exitCode, 3);
  assert.equal(receipt.cleanupVerified, true);
});

// 3. Live interval past the deadline is TIMED_OUT within a bounded duration.
await check("timeout", async () => {
  const startedAt = Date.now();
  const receipt = await runQualificationProcess({
    runId: ids(), phaseId: "timeout", command: NODE,
    args: childArgs("setInterval(() => {}, 50);"),
    deadlineMs: 300, graceMs: 300,
  });
  assert.equal(receipt.status, "TIMED_OUT");
  assert.equal(receipt.timedOut, true);
  assert.equal(receipt.groupReaped, true);
  assert.ok(Date.now() - startedAt < 10_000, "timeout case must stay bounded");
});

// 4. SIGTERM ignorer escalates to SIGKILL and is reaped.
await check("escalation", async () => {
  const receipt = await runQualificationProcess({
    runId: ids(), phaseId: "escalate", command: NODE,
    args: childArgs("process.on('SIGTERM', () => {}); setInterval(() => {}, 50);"),
    deadlineMs: 300, graceMs: 300,
  });
  assert.equal(receipt.status, "TIMED_OUT");
  assert.equal(receipt.escalated, true);
  assert.equal(receipt.signal, "SIGKILL");
  assert.equal(receipt.groupReaped, true);
});

// 5. Same-group grandchild that ignores SIGTERM is reaped by escalation.
// The parent waits for the grandchild's ready handshake before exiting: a
// SIGTERM landing during node boot (before the handler installs) would kill
// it and turn the scenario into a boot race instead of an ignore-TERM case.
await check("group grandchild", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qp-ready-"));
  const readyFile = join(dir, "ready");
  const script = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const kid = spawn(process.execPath, ['-e', [",
    "  \"process.on('SIGTERM', () => {});\",",
    `  'require("node:fs").writeFileSync(${JSON.stringify(readyFile)}, "ready");',`,
    "  'setInterval(() => {}, 50);'].join('\\n')],",
    "  { stdio: 'ignore' });",
    "kid.unref();",
    "const start = Date.now();",
    `while (!fs.existsSync(${JSON.stringify(readyFile)})) {`,
    "  if (Date.now() - start > 30000) throw new Error('grandchild never became ready');",
    "}",
  ].join("\n");
  try {
    const receipt = await runQualificationProcess({
      runId: ids(), phaseId: "grandchild", command: NODE,
      args: childArgs(script),
      deadlineMs: 60_000, graceMs: 1_000,
    });
    assert.equal(receipt.status, "PASSED");
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.escalated, true);
    assert.equal(receipt.groupReaped, true);
    assert.equal(receipt.cleanupVerified, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 6. Detached grandchild holding stdio open is CLEANUP_FAILED, never a pass.
await check("stdio held open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qp-pid-"));
  const pidFile = join(dir, "grandchild.pid");
  const uniqueMs = 45_000;
  const script = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${uniqueMs});'],`,
    "  { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
    `writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));`,
    "kid.unref();",
  ].join("\n");
  try {
    const receipt = await runQualificationProcess({
      runId: ids(), phaseId: "stdio", command: NODE,
      args: childArgs(script),
      deadlineMs: 5_000, graceMs: 300,
    });
    assert.equal(receipt.status, "CLEANUP_FAILED");
    assert.equal(receipt.stdioDrained, false);
    assert.ok(receipt.cleanupFailures.some((f) => f.includes("stdio")));
  } finally {
    try {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (Number.isFinite(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    } catch { /* pid file missing: nothing to reap */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

// 7. Unspawnable command is INFRA_ERROR, never a pass or assertion failure.
await check("spawn error", async () => {
  const receipt = await runQualificationProcess({
    runId: ids(), phaseId: "infra", command: "/nonexistent/qp-command",
    args: [], deadlineMs: 5_000, graceMs: 300,
  });
  assert.equal(receipt.status, "INFRA_ERROR");
  assert.ok(receipt.cleanupFailures.some((f) => f.includes("spawn failed")));
});

// 8. AbortSignal mid-phase is INTERRUPTED with the group reaped.
await check("interrupted", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const receipt = await runQualificationProcess({
    runId: ids(), phaseId: "interrupt", command: NODE,
    args: childArgs("setInterval(() => {}, 50);"),
    deadlineMs: 10_000, graceMs: 300, abortSignal: controller.signal,
  });
  assert.equal(receipt.status, "INTERRUPTED");
  assert.equal(receipt.groupReaped, true);
});

console.log(`qualification-process.test.mjs: ${results.length} scenarios passed (${results.join(", ")})`);
