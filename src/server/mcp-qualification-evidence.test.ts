import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databasePath, openDatabase } from "../db/client.js";
import { McpOperationDiagnostics } from "./mcp-operation-diagnostics.js";
import { McpQualificationEvidenceJournal, type ExternalSseEvidence } from "./mcp-qualification-evidence.js";
import { fingerprintExternalToolCatalog, validateExternalCatalogObservation } from "../qualification/external-catalog-capture.js";

const stateDir = mkdtempSync(join(tmpdir(), "kontrol-mcp-qualification-evidence-"));
const sessionId = "external-host-session-id-for-qualification";
const sessionIdSha256 = createHash("sha256").update(sessionId).digest("hex");
const startedAt = "2026-10-14T12:00:00.000Z";
const finishedAt = "2026-10-14T12:00:45.000Z";

try {
  const firstDb = openDatabase(stateDir);
  const firstJournal = new McpQualificationEvidenceJournal(firstDb.sqlite);
  const acknowledgement = firstJournal.recordCatalogAcknowledgement({
    sessionId,
    captureId: "capture-durable-test",
    serverBuildId: "build-durable-test",
    serverVersion: "1.0.0+durable-test",
    status: "accepted",
    serverCatalogSha256: "a".repeat(64),
    hostCatalogSha256: "a".repeat(64),
    toolCount: 12,
    observedAt: startedAt,
  });
  const stream = firstJournal.recordCompletedSseOperation({
    operationId: "operation-durable-test",
    qualificationCaptureId: "capture-durable-test",
    serverBuildId: "build-durable-test",
    serverVersion: "1.0.0+durable-test",
    sessionIdSha256,
    httpMethod: "POST",
    rpcMethod: "tools/call",
    toolName: "await_workspace_events",
    startedAt,
    finishedAt,
    durationMs: 45_000,
    isSseResponse: true,
    httpStatus: 200,
    responseBytes: 520,
    heartbeatBytes: 60,
    responseCloseClassification: "response_finished",
    handlerStillRunning: false,
  });
  assert.ok(stream, "qualifying tool SSE operations are persisted");
  assert.equal(acknowledgement.sessionIdSha256, sessionIdSha256);

  const hostTools = [{ name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
  const hostCatalog = fingerprintExternalToolCatalog(hostTools)!;
  const observation = firstJournal.recordExternalCatalogObservation(validateExternalCatalogObservation({
    contractVersion: 1,
    captureId: "capture-durable-test",
    capturedAt: startedAt,
    hostKind: "chatgpt",
    serverVersion: "1.0.0+durable-test",
    sessionIdSha256,
    initializeResult: { serverInfo: { name: "kontrol", version: "1.0.0+durable-test" } },
    toolsListResult: { tools: hostTools },
    registeredCatalog: hostTools,
    acknowledgement: {
      method: "notifications/experimental/kontrol/tool-catalog-accepted",
      contractVersion: 1,
      captureId: "capture-durable-test",
      serverVersion: "1.0.0+durable-test",
      hostCatalogSha256: hostCatalog.sha256,
      hostToolCount: hostCatalog.toolCount,
    },
  }), {
    serverBuildId: "build-durable-test",
    workSessionId: "wsess-durable-test",
    handoffId: "handoff-durable-test",
  });
  const attachment = firstJournal.attachObservationToHandoff({
    observationRecordId: observation.recordId,
    workSessionId: "wsess-durable-test",
    handoffId: "handoff-durable-test",
    reviewerPrincipalId: "reviewer-durable-test",
    reviewerOwnerContextId: "conversation-durable-test",
    investigationDirection: "Confirm the host registry preserved the nested input schema.",
  });
  assert.equal(attachment.observationRecordId, observation.recordId);
  assert.equal(firstJournal.listHandoffObservationAttachments("handoff-durable-test")[0]?.contentSha256, attachment.contentSha256);
  assert.throws(() => firstJournal.attachObservationToHandoff({
    observationRecordId: observation.recordId,
    workSessionId: "wsess-other",
    handoffId: "handoff-other",
    reviewerPrincipalId: "reviewer-durable-test",
    reviewerOwnerContextId: "conversation-durable-test",
    investigationDirection: "must not cross handoff scopes",
  }), /attribution does not match/);
  const association = firstJournal.recordQualificationAssociation({
    serverBuildId: "build-durable-test",
    captureId: "capture-durable-test",
    sessionIdSha256,
    soakId: "soak-durable-test",
    observationRecordId: observation.recordId,
    acknowledgementRecordId: acknowledgement.recordId,
    externalSseRecordId: stream.recordId,
  });
  assert.equal(firstJournal.listQualificationAssociations({ soakId: "soak-durable-test" })[0]?.contentSha256,
    association.contentSha256);
  assert.throws(() => firstJournal.recordQualificationAssociation({
    serverBuildId: "different-build",
    captureId: "capture-durable-test",
    sessionIdSha256,
    acknowledgementRecordId: acknowledgement.recordId,
  }), /does not match/);

  assert.equal(firstJournal.recordCompletedSseOperation({
    operationId: "not-an-sse-response",
    serverBuildId: "build-durable-test",
    serverVersion: "1.0.0+durable-test",
    sessionIdSha256,
    httpMethod: "POST",
    rpcMethod: "tools/call",
    toolName: "await_workspace_events",
    startedAt,
    finishedAt,
    durationMs: 45_000,
    isSseResponse: false,
    httpStatus: 200,
    responseBytes: 520,
    heartbeatBytes: 60,
    responseCloseClassification: "response_finished",
    handlerStillRunning: false,
  }), undefined, "non-SSE responses are not misclassified as streaming evidence");

  const transientRing = new McpOperationDiagnostics(1_000, 256);
  transientRing.begin({
    operationId: stream.operationId,
    serverBuildId: stream.serverBuildId,
    serverVersion: stream.serverVersion,
    sessionIdSha256,
    method: "POST",
    rpcMethod: "tools/call",
    toolName: "await_workspace_events",
    startedAtMs: Date.parse(startedAt),
    admissionClass: "waiter",
  });
  transientRing.finish(stream.operationId, {
    finishedAtMs: Date.parse(finishedAt),
    httpStatus: 200,
    responseBytes: stream.responseBytes,
    heartbeatBytes: stream.heartbeatBytes,
    responseCloseClassification: stream.responseCloseClassification,
    admissionWaitMs: 0,
    executionDurationMs: stream.durationMs,
    handlerStillRunning: false,
    executionAdmission: {},
    resourceAdmission: {},
    connectionMetrics: {},
  });
  for (let index = 0; index < 256; index++) {
    const operationId = `unrelated-${index}`;
    transientRing.begin({ operationId, method: "POST", startedAtMs: Date.now(), admissionClass: "execution" });
    transientRing.finish(operationId, {
      finishedAtMs: Date.now(),
      httpStatus: 200,
      responseBytes: 1,
      responseCloseClassification: "response_finished",
      admissionWaitMs: 0,
      executionDurationMs: 0,
      handlerStillRunning: false,
      executionAdmission: {},
      resourceAdmission: {},
      connectionMetrics: {},
    });
  }
  assert.equal(transientRing.snapshot().recent.length, 256);
  assert.ok(!transientRing.snapshot().recent.some((record) => record.operationId === stream.operationId),
    "the in-memory ring evicts old records after unrelated operations");
  for (let index = 0; index < 300; index++) {
    firstJournal.recordCompletedSseOperation({
      operationId: `unrelated-durable-operation-${index}`,
      qualificationCaptureId: "capture-durable-test",
      serverBuildId: "build-durable-test",
      serverVersion: "1.0.0+durable-test",
      sessionIdSha256,
      httpMethod: "POST",
      rpcMethod: "tools/call",
      toolName: "await_workspace_events",
      startedAt,
      finishedAt,
      durationMs: 1,
      isSseResponse: true,
      httpStatus: 200,
      responseBytes: 1,
      heartbeatBytes: 1,
      responseCloseClassification: "response_finished",
      handlerStillRunning: false,
    });
  }
  firstDb.close();

  const restartedDb = openDatabase(stateDir);
  const restartedJournal = new McpQualificationEvidenceJournal(restartedDb.sqlite);
  const persisted = restartedJournal.listRecent({
    serverBuildId: "build-durable-test",
    captureId: "capture-durable-test",
    sessionIdSha256,
    limit: 1_000,
  });
  assert.equal(persisted.length, 302,
    "the original acknowledgement and SSE record survive restart and more than 256 unrelated operations");
  const persistedAck = persisted.find((record) => record.recordType === "catalog_acknowledgement");
  const persistedStream = persisted.find((record): record is ExternalSseEvidence =>
    record.recordType === "external_sse" && record.operationId === stream.operationId);
  assert.equal(persistedAck?.recordId, acknowledgement.recordId);
  assert.equal(persistedAck?.contentSha256, acknowledgement.contentSha256);
  assert.equal(persistedStream?.recordId, stream.recordId);
  assert.equal(persistedStream?.operationId, stream.operationId);
  assert.equal(persistedStream?.sessionIdSha256, sessionIdSha256);
  assert.equal("sessionId" in (persistedStream ?? {}), false, "raw MCP session IDs are never persisted");
  assert.equal("arguments" in (persistedStream ?? {}), false, "tool payloads are never persisted");
  assert.equal(restartedJournal.getExternalCatalogObservation(observation.recordId)?.contentSha256, observation.contentSha256);
  assert.equal(restartedJournal.listQualificationAssociations({
    serverBuildId: "build-durable-test",
    captureId: "capture-durable-test",
    sessionIdSha256,
  }).find((item) => item.recordId === association.recordId)?.recordId, association.recordId);
  assert.equal(databasePath(stateDir), join(stateDir, "kontrol.sqlite"));
  restartedDb.close();
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log("mcp-qualification-evidence.test.ts: durable evidence and bounded diagnostic eviction passed");
