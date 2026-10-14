import { createHash } from "node:crypto";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function verifyQualificationEvidenceContentHash(record) {
  if (!record || typeof record !== "object" || typeof record.contentSha256 !== "string") return false;
  const { contentSha256, ...content } = record;
  return createHash("sha256").update(canonicalJson(content)).digest("hex") === contentSha256;
}

export function matchCatalogAcknowledgementEvidence(records, expected) {
  return records.filter((record) =>
    record.recordType === "catalog_acknowledgement"
    && record.status === "accepted"
    && record.captureId === expected.captureId
    && record.serverBuildId === expected.serverBuildId
    && record.serverVersion === expected.serverVersion
    && record.sessionIdSha256 === expected.sessionIdSha256
    && record.hostCatalogSha256 === expected.catalogSha256
    && record.serverCatalogSha256 === expected.catalogSha256
    && record.toolCount === expected.toolCount
    && verifyQualificationEvidenceContentHash(record));
}

export function matchExternalSseEvidence(records, expected) {
  const startedAtMs = Date.parse(expected.startedAt);
  const finishedAtMs = Date.parse(expected.finishedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(finishedAtMs)) return [];
  return records.filter((record) =>
    record.recordType === "external_sse"
    && record.operationId === expected.operationId
    && record.sessionIdSha256 === expected.sessionIdSha256
    && record.serverBuildId === expected.serverBuildId
    && record.serverVersion === expected.serverVersion
    && (!record.captureId || record.captureId === expected.captureId)
    && record.httpMethod === "POST"
    && record.rpcMethod === "tools/call"
    && record.toolName === expected.toolName
    && record.heartbeatBytes > 0
    && record.responseBytes > 0
    && record.httpStatus === 200
    && record.responseCloseClassification === "response_finished"
    && record.handlerStillRunning === false
    && Number.isFinite(Date.parse(record.startedAt))
    && Number.isFinite(Date.parse(record.finishedAt))
    && Math.abs(Date.parse(record.startedAt) - startedAtMs) <= 2_000
    && Math.abs(Date.parse(record.finishedAt) - finishedAtMs) <= 2_000
    && Number(record.durationMs) >= expected.requestedWaitMs - 5_000
    && verifyQualificationEvidenceContentHash(record));
}
