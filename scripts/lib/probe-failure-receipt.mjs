import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function classifyProbeFailure(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  for (const reason of [
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
  ]) {
    if (message.includes(reason)) return reason;
  }
  if (/acknowledgement|catalog acknowledgment|catalog acknowledgement/i.test(message)) return "host_acknowledgement_missing";
  if (/server.*catalog.*incomplete|deployed_server_catalog_incomplete/i.test(message)) return "server_catalog_incomplete";
  if (/stale.*catalog|catalog.*stale|another_generation/i.test(message)) return "host_catalog_stale";
  if (/subset|registered catalog.*mismatch|catalog mismatch/i.test(message)) return "host_registered_subset";
  if (/input.?schema.*mismatch|approvalResumeId/i.test(message)) return "input_schema_mismatch";
  if (/expired|evidence.*unavailable|evidence.*missing/i.test(message)) return "catalog_evidence_expired";
  if (/session|correlat/i.test(message)) return "session_correlation_failed";
  if (/stream|heartbeat|SSE/i.test(message)) return "external_stream_not_confirmed";
  if (/build.*identity|immutable MCP version|server version.*match/i.test(message)) return "build_identity_mismatch";
  return "qualification_failed";
}

function bounded(value, pattern) {
  return typeof value === "string" && value.length <= 256 && pattern.test(value) ? value : undefined;
}

export function writeFailedProbeReceipt(path, error, context = {}, failedAt = new Date().toISOString()) {
  const destination = resolve(path);
  mkdirSync(dirname(destination), { recursive: true });
  const row = {
    kind: "kontrol-external-catalog-probe-failure",
    schemaVersion: 1,
    status: "failed",
    reason: classifyProbeFailure(error),
    failedAt: Number.isFinite(Date.parse(failedAt)) ? new Date(failedAt).toISOString() : new Date().toISOString(),
    ...(bounded(context.expectedBuildId, /^[A-Za-z0-9._:+-]+$/) ? { expectedBuildId: context.expectedBuildId } : {}),
    ...(bounded(context.expectedMcpVersion, /^[A-Za-z0-9._:+-]+$/) ? { expectedMcpVersion: context.expectedMcpVersion } : {}),
    ...(bounded(context.captureId, /^[A-Za-z0-9._:-]+$/) ? { captureId: context.captureId } : {}),
    ...(context.transportMode === "public_https" || context.transportMode === "secure_mcp_tunnel"
      ? { transportMode: context.transportMode }
      : {}),
  };
  const contentSha256 = createHash("sha256").update(canonicalJson(row)).digest("hex");
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...row, contentSha256 }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, destination);
  return { path: destination, reason: row.reason, contentSha256 };
}
