import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyProbeFailure, writeFailedProbeReceipt } from "./probe-failure-receipt.mjs";

const root = mkdtempSync(join(tmpdir(), "kontrol-failed-probe-receipt-"));
try {
  const path = join(root, "qualification.failed.json");
  const secret = "do-not-copy-this-token";
  const expectedReasons = [
    "host_capture_unsupported",
    "host_acknowledgement_missing",
    "server_catalog_incomplete",
    "host_catalog_stale",
    "host_registered_subset",
    "input_schema_mismatch",
    "catalog_evidence_expired",
    "session_correlation_failed",
    "external_stream_not_confirmed",
    "build_identity_mismatch",
  ];
  for (const reason of expectedReasons) {
    assert.equal(classifyProbeFailure(new Error(reason)), reason,
      `${reason} remains a stable machine-readable failure classification`);
  }
  assert.equal(classifyProbeFailure(new Error(`host_capture_unsupported ${secret}`)), "host_capture_unsupported");
  const written = writeFailedProbeReceipt(path, new Error(`host_capture_unsupported ${secret} /private/path`), {
    expectedBuildId: "build-123",
    expectedMcpVersion: "1.0.4+abc123",
    captureId: "capture-123",
    transportMode: "public_https",
  }, "2026-10-14T12:00:00.000Z");
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.reason, "host_capture_unsupported");
  assert.equal(receipt.expectedBuildId, "build-123");
  assert.equal(receipt.captureId, "capture-123");
  assert.equal(receipt.contentSha256, written.contentSha256);
  assert.equal(JSON.stringify(receipt).includes(secret), false);
  assert.equal(JSON.stringify(receipt).includes("/private/path"), false);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(root), ["qualification.failed.json"], "the final file appears atomically without a temporary sibling");
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("probe-failure-receipt.test.mjs: sanitized atomic failure receipts passed");
