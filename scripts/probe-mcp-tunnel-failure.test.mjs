import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "kontrol-probe-unsupported-host-"));
try {
  const capturePath = join(root, "host-observation.json");
  const resultPath = join(root, "beta-external-catalog.json");
  const failedPath = join(root, "beta-external-catalog.failed.json");
  writeFileSync(capturePath, JSON.stringify({
    contractVersion: 1,
    captureId: "capture-unsupported-test",
    capturedAt: "2026-10-14T12:00:00.000Z",
    hostKind: "chatgpt",
    serverVersion: "1.0.4+failure-test",
    sessionIdSha256: "a".repeat(64),
    initializeResult: { serverInfo: { name: "kontrol", version: "1.0.4+failure-test" } },
    toolsListResult: { tools: [{ name: "read" }] },
  }));
  const result = spawnSync(process.execPath, [
    "scripts/probe-mcp-tunnel.mjs",
    "--url", "https://kontrol.example.test",
    "--transport", "public_https",
    "--dual",
    "--cycles", "1",
    "--host-catalog-file", capturePath,
    "--result-file", resultPath,
    "--failure-result-file", failedPath,
    "--expected-build-id", "build-failure-test",
    "--expected-mcp-version", "1.0.4+failure-test",
    "--heartbeat-count", "2",
    "--resource-load-reads", "2",
    "--minimum-drain-events", "2",
    "--diagnostics-secret", "fixture-only-diagnostics-secret",
    "--post-heartbeat-ms", "45000",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /host_capture_unsupported/);
  const failureReceipt = JSON.parse(readFileSync(failedPath, "utf8"));
  assert.equal(failureReceipt.kind, "kontrol-external-catalog-probe-failure");
  assert.equal(failureReceipt.status, "failed");
  assert.equal(failureReceipt.reason, "host_capture_unsupported");
  assert.equal(failureReceipt.captureId, "capture-unsupported-test");
  assert.equal(failureReceipt.expectedBuildId, "build-failure-test");
  assert.equal(JSON.stringify(failureReceipt).includes(capturePath), false);
  assert.equal(JSON.stringify(failureReceipt).includes("registeredCatalog"), false);
  assert.throws(() => readFileSync(resultPath), /ENOENT/,
    "unsupported capture produces a failure receipt, never a successful receipt");
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("probe-mcp-tunnel-failure.test.mjs: unsupported host capture is explicit and sanitized");
