import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBetaExternalCatalogReceipt } from "../scripts/beta-external-catalog-contract.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = mkdtempSync(join(tmpdir(), "kontrol-beta-final-"));
const checkout = join(fixture, "checkout");
const fixtureScripts = join(checkout, "scripts");
const codeReceiptPath = join(fixture, "beta-code.json");
const soakReportPath = join(fixture, "beta-soak.json");
const externalCatalogReceiptPath = join(fixture, "beta-external-catalog.json");
const receiptPath = join(fixture, "beta-final.json");
mkdirSync(fixtureScripts, { recursive: true });
for (const script of ["beta-gate-final.mjs", "beta-soak-contract.mjs", "beta-external-catalog-contract.mjs"]) {
  copyFileSync(join(root, "scripts", script), join(fixtureScripts, script));
}
execFileSync("git", ["init", "--quiet"], { cwd: checkout });
execFileSync("git", ["add", "scripts"], { cwd: checkout });
const fixtureTree = execFileSync("git", ["write-tree"], { cwd: checkout, encoding: "utf8" }).trim();
const sha = execFileSync("git", ["commit-tree", fixtureTree, "-m", "beta gate fixture"], {
  cwd: checkout,
  encoding: "utf8",
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: "Kontrol Test",
    GIT_AUTHOR_EMAIL: "kontrol-test@example.invalid",
    GIT_COMMITTER_NAME: "Kontrol Test",
    GIT_COMMITTER_EMAIL: "kontrol-test@example.invalid",
  },
}).trim();
execFileSync("git", ["update-ref", "HEAD", sha], { cwd: checkout });
const buildId = "candidate-build";
const contentSha256 = "b".repeat(64);
const expectedMcpVersion = `1.0.4+${contentSha256}`;
const sessionIdSha256 = "d".repeat(64);
const captureId = "capture-fixture-1";
const streamingOperationId = "operation-fixture-1";
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function contentAddressedRecord(record) {
  return { ...record, contentSha256: createHash("sha256").update(canonicalJson(record)).digest("hex") };
}
const externalSseEvidence = contentAddressedRecord({
  recordId: "sse-evidence-fixture-1",
  recordType: "external_sse",
  captureId,
  serverBuildId: buildId,
  serverVersion: expectedMcpVersion,
  sessionIdSha256,
  operationId: streamingOperationId,
  observedAt: "2026-08-27T11:59:45.000Z",
  expiresAt: "2026-11-25T11:59:45.000Z",
  httpMethod: "POST",
  rpcMethod: "tools/call",
  toolName: "await_workspace_events",
  startedAt: "2026-08-27T11:59:00.000Z",
  finishedAt: "2026-08-27T11:59:45.000Z",
  durationMs: 45_000,
  httpStatus: 200,
  responseBytes: 512,
  heartbeatBytes: 60,
  responseCloseClassification: "response_finished",
  handlerStillRunning: false,
});
const workspaceAppUri = "ui://kontrol/workspace-app-abcdef123456.html";
const workspaceAppCompatibilityUri = "ui://kontrol/workspace-app-abcdef123456.skybridge.html";
const requiredTools = ["read", "grep", "glob", "ls", "git_status", "git_log", "git_diff", "git_show", "poll_process"];
const catalogTools = [...requiredTools, "open_workspace", "show_workspace_ui"];
const inputProperties = {
  read: ["workspaceId", "path", "approvalResumeId"],
  grep: ["workspaceId", "pattern", "approvalResumeId"],
  glob: ["workspaceId", "pattern", "approvalResumeId"],
  ls: ["workspaceId", "path", "approvalResumeId"],
  git_status: ["workspaceId", "path", "approvalResumeId"],
  git_log: ["workspaceId", "path", "approvalResumeId"],
  git_diff: ["workspaceId", "path", "approvalResumeId"],
  git_show: ["workspaceId", "path", "approvalResumeId"],
  poll_process: ["workspaceId", "sessionId"],
  open_workspace: ["path", "mode", "baseRef"],
  show_workspace_ui: ["workspaceId"],
};
const toolMetadata = catalogTools.map((name) => ({
  name,
  inputFields: {
    properties: [...inputProperties[name]].sort(),
    required: (name === "open_workspace" ? ["path"] : name === "poll_process" ? ["workspaceId", "sessionId"] : name === "show_workspace_ui" ? ["workspaceId"] : ["workspaceId"]).sort(),
    types: Object.fromEntries(inputProperties[name].sort().map((field) => [field, field === "mode" ? "anyOf" : "string"]).sort(([a], [b]) => a.localeCompare(b))),
  },
  ...(name === "show_workspace_ui" ? { resourceUri: workspaceAppUri, visibility: ["model"], legacyOutputTemplate: workspaceAppCompatibilityUri } : {}),
}));
const serverToolDescriptors = toolMetadata.map((tool) => ({
  name: tool.name,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(tool.inputFields.properties.map((field) => [field, {
      type: tool.inputFields.types[field] ?? "string",
      ...(field === "path" ? { minLength: 1 } : {}),
    }])),
    required: tool.inputFields.required,
    additionalProperties: false,
  },
  ...(tool.resourceUri ? {
    _meta: {
      ui: { resourceUri: tool.resourceUri, visibility: tool.visibility },
      "openai/outputTemplate": tool.legacyOutputTemplate,
    },
  } : {}),
}));
const catalogSha256 = createHash("sha256").update(canonicalJson(
  [...serverToolDescriptors].sort((a, b) => a.name.localeCompare(b.name)),
)).digest("hex");
const catalogAcknowledgementEvidence = contentAddressedRecord({
  recordId: "catalog-evidence-fixture-1",
  recordType: "catalog_acknowledgement",
  captureId,
  serverBuildId: buildId,
  serverVersion: expectedMcpVersion,
  sessionIdSha256,
  observedAt: "2026-08-27T11:58:00.000Z",
  expiresAt: "2026-11-25T11:58:00.000Z",
  status: "accepted",
  serverCatalogSha256: catalogSha256,
  hostCatalogSha256: catalogSha256,
  toolCount: serverToolDescriptors.length,
});
const operatorObservationRecordId = "operator-observation-fixture-1";
const hostQualificationAssociation = (externalSseRecordId) => contentAddressedRecord({
  recordId: externalSseRecordId ? "host-association-stream-fixture-1" : "host-association-ack-fixture-1",
  serverBuildId: buildId,
  captureId,
  sessionIdSha256,
  acknowledgementRecordId: catalogAcknowledgementEvidence.recordId,
  observationRecordId: operatorObservationRecordId,
  ...(externalSseRecordId ? { externalSseRecordId } : {}),
  createdAt: "2026-08-27T11:59:46.000Z",
  expiresAt: "2026-11-25T11:59:46.000Z",
});
const probeSessionIdSha256 = "f".repeat(64);
const probeAcknowledgementEvidence = contentAddressedRecord({
  recordId: "probe-client-ack-fixture-1",
  recordType: "catalog_acknowledgement",
  captureId,
  serverBuildId: buildId,
  serverVersion: expectedMcpVersion,
  sessionIdSha256: probeSessionIdSha256,
  observedAt: "2026-08-27T12:04:00.000Z",
  expiresAt: "2026-11-25T12:04:00.000Z",
  status: "accepted",
  serverCatalogSha256: catalogSha256,
  hostCatalogSha256: catalogSha256,
  toolCount: serverToolDescriptors.length,
});
const probeSseEvidence = contentAddressedRecord({
  recordId: "probe-sse-fixture-1",
  recordType: "external_sse",
  captureId,
  serverBuildId: buildId,
  serverVersion: expectedMcpVersion,
  sessionIdSha256: probeSessionIdSha256,
  operationId: "probe-operation-fixture-1",
  observedAt: "2026-08-27T12:05:45.000Z",
  expiresAt: "2026-11-25T12:05:45.000Z",
  httpMethod: "POST",
  rpcMethod: "tools/call",
  toolName: "await_workspace_events",
  startedAt: "2026-08-27T12:05:00.000Z",
  finishedAt: "2026-08-27T12:05:45.000Z",
  durationMs: 45_000,
  httpStatus: 200,
  responseBytes: 512,
  heartbeatBytes: 60,
  responseCloseClassification: "response_finished",
  handlerStillRunning: false,
});
const probeQualificationAssociation = contentAddressedRecord({
  recordId: "probe-association-fixture-1",
  serverBuildId: buildId,
  captureId,
  sessionIdSha256: probeSessionIdSha256,
  acknowledgementRecordId: probeAcknowledgementEvidence.recordId,
  externalSseRecordId: probeSseEvidence.recordId,
  createdAt: "2026-08-27T12:05:46.000Z",
  expiresAt: "2026-11-25T12:05:46.000Z",
});
const probeQualificationAssociationReceipt = {
  source: "authenticated_server_sqlite_evidence",
  machineVerified: true,
  recordId: probeQualificationAssociation.recordId,
  contentSha256: probeQualificationAssociation.contentSha256,
  serverBuildId: buildId,
  captureId,
  sessionIdSha256: probeSessionIdSha256,
  acknowledgementRecordId: probeAcknowledgementEvidence.recordId,
  externalSseRecordId: probeSseEvidence.recordId,
  evidenceRecord: probeQualificationAssociation,
};
const serverCatalogEvidence = contentAddressedRecord({
  source: "fresh_http_tools_list",
  serverVersion: expectedMcpVersion,
  tools: serverToolDescriptors,
  catalogSha256,
});
const externalHostObservation = contentAddressedRecord({
  contractVersion: 1,
  captureId,
  capturedAt: "2026-08-27T11:59:00.000Z",
  hostKind: "chatgpt",
  serverVersion: expectedMcpVersion,
  sessionIdSha256,
  initializeResult: { serverInfo: { name: "kontrol", version: expectedMcpVersion } },
  toolsListResult: { tools: serverToolDescriptors },
  registeredCatalog: serverToolDescriptors,
  serverCatalogSha256: catalogSha256,
  hostCatalogSha256: catalogSha256,
  hostToolCount: serverToolDescriptors.length,
  acknowledgement: {
    method: "notifications/experimental/kontrol/tool-catalog-accepted",
    contractVersion: 1,
    captureId,
    serverVersion: expectedMcpVersion,
    hostCatalogSha256: catalogSha256,
    hostToolCount: serverToolDescriptors.length,
  },
  observationSource: "operator_reported",
  status: "operator_reported_match",
});
const externalCatalogObservationRecord = contentAddressedRecord({
  ...externalHostObservation,
  recordId: operatorObservationRecordId,
  serverBuildId: buildId,
  expiresAt: "2026-11-25T11:59:00.000Z",
});
const code = {
  codeQualified: true,
  faultMatrix: { buildId, qualified: true, cases: [{ id: "supervised-mission-loop", passed: true }] },
  candidate: {
    buildId,
    artifactPath: "/immutable/releases/candidate-build",
    metadata: { buildId, version: "1.0.4", contentSha256, gitSha: sha, gitDirty: 0 },
  },
  source: {
    started: { gitSha: sha, dirtyPaths: [] },
    finished: { gitSha: sha, dirtyPaths: [] },
  },
};
const assertions = {
  noUnexpectedCoreRestarts: true,
  noUnexpectedSupervisorRestarts: true,
  noUnexpectedTunnelRestarts: true,
  noUnexpectedAdapterRestarts: true,
  noRestartFailures: true,
  noOrphanedApprovals: true,
  noPendingApprovalRows: true,
  noLivePolicyWaiters: true,
  noLeakedProcessSessions: true,
  diagnosticsContract: true,
  tunnelEndpointsHealthy: true,
  databaseIntegrityHealthy: true,
  noMaintenanceError: true,
  schemaConsistent: true,
  buildIdentityConsistent: true,
  sourceIdentityConsistent: true,
  continuityBounded: true,
  resourceAdmissionRecovered: true,
  expiredHandlerAccounting: true,
  approvalContinuityCapable: true,
  conversationContinuityProven: true,
  supervisedMissionLoopQualified: true,
};
const soak = {
  status: "passed",
  requestedHours: 12,
  startedAt: "2026-08-27T00:00:00.000Z",
  finishedAt: "2026-08-27T12:00:00.000Z",
  expectedBuildId: buildId,
  monitoring: { diagnosticsRequired: true, tunnelRequired: true },
  snapshots: {
    started: { buildId, gitSha: sha, gitDirty: 0, generation: { activeBuildId: buildId } },
    finished: { buildId, gitSha: sha, gitDirty: 0, generation: { activeBuildId: buildId } },
  },
  assertions,
  targetUrl: "https://kontrol.example.trycloudflare.com",
};
const externalCatalog = {
  kind: "kontrol-external-catalog-probe",
  status: "unverified",
  statusReason: "host_registration_unverified",
  serverCatalogVerified: true,
  hostRegistrationVerified: false,
  externalTransportVerified: true,
  expectedBuildId: buildId,
  expectedMcpVersion,
  serverInfoVersion: expectedMcpVersion,
  hostCatalogVersion: expectedMcpVersion,
  serverTools: catalogTools,
  hostTools: catalogTools,
  serverToolMetadata: toolMetadata,
  hostToolMetadata: toolMetadata,
  serverToolDescriptors,
  hostToolDescriptors: serverToolDescriptors,
  serverCatalogEvidence,
  externalHostObservation,
  workspaceApp: {
    deployedResourceUri: workspaceAppUri,
    deployedCompatibilityUri: workspaceAppCompatibilityUri,
    hostRendererResourceUri: workspaceAppUri,
    hostRendererCompatibilityUri: workspaceAppCompatibilityUri,
    hostRendererUrisMatchCandidate: true,
    resources: [{
      uri: workspaceAppUri,
      mimeType: "text/html;profile=mcp-app",
      htmlBytes: 1234,
      listed: true,
      read: true,
    }, {
      uri: workspaceAppCompatibilityUri,
      mimeType: "text/html+skybridge",
      htmlBytes: 1234,
      listed: true,
      read: true,
    }],
  },
  catalogParity: true,
  inputSchemaParity: true,
  hostCapture: {
    source: "operator_supplied",
    captureId,
    machineVerified: false,
    sha256: catalogSha256,
    sessionIdSha256,
  },
  hostCatalogHandshake: {
    source: "authenticated_server_diagnostics",
    machineVerified: true,
    evidenceId: catalogAcknowledgementEvidence.recordId,
    evidenceContentSha256: catalogAcknowledgementEvidence.contentSha256,
    evidenceRecord: catalogAcknowledgementEvidence,
    serverBuildId: buildId,
    serverVersion: expectedMcpVersion,
    captureId,
    method: "notifications/experimental/kontrol/tool-catalog-accepted",
    contractVersion: 1,
    sessionIdSha256,
    hostCatalogSha256: catalogSha256,
    serverCatalogSha256: catalogSha256,
    clientCatalogSha256: catalogSha256,
    toolCount: catalogTools.length,
    acceptedAt: "2026-08-27T11:58:00.000Z",
  },
  externalHostStreaming: {
    source: "authenticated_server_diagnostics",
    machineVerified: true,
    evidenceId: externalSseEvidence.recordId,
    evidenceContentSha256: externalSseEvidence.contentSha256,
    evidenceRecord: externalSseEvidence,
    serverBuildId: buildId,
    serverVersion: expectedMcpVersion,
    operationId: streamingOperationId,
    tunnelId: "tunnel_fixture_1",
    scheme: "https",
    sessionIdSha256,
    toolName: "await_workspace_events",
    requestedWaitMs: 45_000,
    startedAt: externalSseEvidence.startedAt,
    finishedAt: externalSseEvidence.finishedAt,
    durationMs: externalSseEvidence.durationMs,
    heartbeatBytes: externalSseEvidence.heartbeatBytes,
    responseBytes: externalSseEvidence.responseBytes,
    responseCloseClassification: externalSseEvidence.responseCloseClassification,
    handlerStillRunning: externalSseEvidence.handlerStillRunning,
    terminalResultReceived: true,
  },
  externalTransport: {
    source: "authenticated_server_diagnostics",
    machineVerified: true,
    mode: "public_https",
    url: "https://kontrol.example.trycloudflare.com",
    serverBuildId: buildId,
    serverVersion: expectedMcpVersion,
    sessionIdSha256: probeSessionIdSha256,
    operationId: probeSseEvidence.operationId,
    evidenceId: probeSseEvidence.recordId,
    evidenceRecord: probeSseEvidence,
    qualificationAssociation: probeQualificationAssociationReceipt,
  },
  qualificationEvidenceAssociation: {
    source: "authenticated_server_sqlite_evidence",
    machineVerified: true,
    recordId: hostQualificationAssociation().recordId,
    contentSha256: hostQualificationAssociation().contentSha256,
    serverBuildId: buildId,
    captureId,
    sessionIdSha256,
    catalogAcknowledgementRecordId: catalogAcknowledgementEvidence.recordId,
    observationRecordId: operatorObservationRecordId,
    evidenceRecord: hostQualificationAssociation(),
  },
  externalCatalogObservationRecord,
  liveServerProbe: {
    source: "fresh_http_initialize_and_tools_list",
    machineVerified: true,
    startedAt: "2026-08-27T12:05:00.000Z",
    finishedAt: "2026-08-27T12:06:00.000Z",
    url: "https://kontrol.example.trycloudflare.com",
  },
  hostCatalogEvidenceSource: "operator_supplied",
  hostCatalogMachineVerified: false,
  liveServerProbeMachineVerified: true,
  dualSession: true,
  heartbeatCountPerSession: 2,
  heartbeatBytesObserved: 4,
  drainRecoveryEvents: 2,
  resourceLoadReads: 2,
  boundedInspectionCalls: 8,
  postHeartbeat: {
    method: "POST",
    tool: "await_workspace_events",
    requestedWaitMs: 45_000,
    durationMs: 45_010,
    heartbeatCount: 3,
    terminalResponseReceived: true,
    contentType: "text/event-stream; charset=utf-8",
    diagnosticsVerified: true,
    heartbeatBytes: 60,
    responseBytes: 512,
    responseCloseClassification: "response_finished",
    handlerStillRunning: false,
    stalledWriterEvents: 0,
    sessionIdSha256: probeSessionIdSha256,
    operationId: probeSseEvidence.operationId,
    evidenceId: probeSseEvidence.recordId,
    evidenceRecord: probeSseEvidence,
    qualificationAssociation: probeQualificationAssociationReceipt,
  },
  probeClientAcknowledgements: Array.from({ length: 3 }, (_, index) => ({
    source: "kontrol_probe_client",
    captureId,
    sessionIdSha256: ["8", "9", "a"][index].repeat(64),
    serverVersion: expectedMcpVersion,
    serverCatalogSha256: catalogSha256,
    probeClientCatalogSha256: catalogSha256,
    toolCount: serverToolDescriptors.length,
    status: "accepted",
  })),
  hostCatalogCapturedAt: "2026-08-27T11:59:00.000Z",
  startedAt: "2026-08-27T12:05:00.000Z",
  finishedAt: "2026-08-27T12:06:00.000Z",
  url: "https://kontrol.example.trycloudflare.com",
  cycles: 1,
};
const publicCatalogCheck = validateBetaExternalCatalogReceipt(externalCatalog, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
});
assert.equal(publicCatalogCheck.serverCatalogVerified, true,
  "the fresh server catalog and immutable build identity can be verified independently");
assert.equal(publicCatalogCheck.externalTransportVerified, true,
  "the external HTTPS probe stream and durable server receipt are independently verifiable");
assert.equal(publicCatalogCheck.hostRegistrationVerified, false,
  "a model/operator-supplied registry is never promoted to host-registration evidence");
assert.equal(publicCatalogCheck.valid, false,
  "operator-reported host descriptors remain unverified and cannot pass the final catalog gate");
const tunnelId = "tunnel_fixture_1";
const secureTarget = "http://127.0.0.1:7676";
const secureSoak = {
  ...soak,
  targetUrl: secureTarget,
  transport: { mode: "secure_mcp_tunnel", tunnelId },
};
const secureHostTransportBody = {
  source: "operator_reported_host_capture",
  observationSource: "operator_reported",
  mode: "secure_mcp_tunnel",
  scheme: "https",
  tunnelId,
  captureId,
  sessionIdSha256,
  operationId: streamingOperationId,
};
const secureExternalCatalog = {
  ...externalCatalog,
  url: secureTarget,
  transport: {
    mode: "secure_mcp_tunnel",
    scheme: "https",
    source: "operator_supplied_host_capture",
    tunnelId,
  },
  hostCapture: {
    ...externalCatalog.hostCapture,
    streamingOperationId,
    transport: {
      source: "operator_supplied",
      kind: "openai_secure_mcp_tunnel",
      scheme: "https",
      tunnelId,
    },
  },
  hostFacingTransportObservation: contentAddressedRecord(secureHostTransportBody),
  qualificationEvidenceAssociation: {
    ...externalCatalog.qualificationEvidenceAssociation,
    recordId: hostQualificationAssociation(externalSseEvidence.recordId).recordId,
    contentSha256: hostQualificationAssociation(externalSseEvidence.recordId).contentSha256,
    externalSseRecordId: externalSseEvidence.recordId,
    evidenceRecord: hostQualificationAssociation(externalSseEvidence.recordId),
  },
  liveServerProbe: {
    ...externalCatalog.liveServerProbe,
    url: secureTarget,
    transportMode: "secure_mcp_tunnel",
  },
};
const secureCatalogCheck = validateBetaExternalCatalogReceipt(secureExternalCatalog, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak: secureSoak,
});
assert.equal(secureCatalogCheck.externalHostStreamingEvidenceValid, true,
  "the persisted local SSE record verifies the exact Secure MCP Tunnel tool operation");
assert.equal(secureCatalogCheck.hostFacingTransportObservationValid, true,
  "the operator capture records the separately reported host-facing HTTPS tunnel identity");
assert.equal(secureCatalogCheck.hostFacingTransportSource, "operator_reported");
assert.equal(secureCatalogCheck.externalTransportVerified, false,
  "operator-reported tunnel metadata cannot independently verify host-facing TLS");
assert.equal(secureCatalogCheck.hostRegistrationVerified, false);
assert.equal(secureCatalogCheck.valid, false,
  "Secure Tunnel evidence does not turn an operator-supplied catalog into verified host registration");
assert.equal(validateBetaExternalCatalogReceipt({
  ...secureExternalCatalog,
  hostCapture: { ...secureExternalCatalog.hostCapture, streamingOperationId: "different-operation" },
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak: secureSoak,
}).valid, false, "Secure MCP Tunnel evidence with a different operation ID must not qualify");
assert.equal(validateBetaExternalCatalogReceipt({
  ...secureExternalCatalog,
  hostFacingTransportObservation: contentAddressedRecord({
    ...secureHostTransportBody,
    operationId: "different-operation",
  }),
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak: secureSoak,
}).hostFacingTransportObservationValid, false,
"Secure MCP Tunnel host-facing transport capture must bind to the exact stream operation");
assert.equal(validateBetaExternalCatalogReceipt({
  ...secureExternalCatalog,
  externalHostStreaming: {
    ...secureExternalCatalog.externalHostStreaming,
    evidenceRecord: { ...externalSseEvidence, heartbeatBytes: 61 },
  },
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak: secureSoak,
}).valid, false, "tampered durable SSE metadata must fail its content hash");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  hostCatalogHandshake: undefined,
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "operator-supplied catalogs without a matching server-observed acknowledgement must not qualify");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  hostCatalogHandshake: { ...externalCatalog.hostCatalogHandshake, sessionIdSha256: "f".repeat(64) },
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "an acknowledgement from another MCP transport must not qualify the captured host catalog");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  hostCatalogCapturedAt: "2026-08-26T23:59:00.000Z",
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "a catalog captured before deployment must be rejected");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  hostTools: [...requiredTools, "stale_tool"],
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "missing or extra external tools must be rejected");
const hostToolsWithoutResumeId = toolMetadata.map((tool) => tool.name === "read" ? {
  ...tool,
  inputFields: {
    ...tool.inputFields,
    properties: tool.inputFields.properties.filter((field) => field !== "approvalResumeId"),
    types: Object.fromEntries(Object.entries(tool.inputFields.types).filter(([field]) => field !== "approvalResumeId")),
  },
} : tool);
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  hostToolMetadata: hostToolsWithoutResumeId,
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "host schema dropping approvalResumeId must invalidate catalog evidence");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  postHeartbeat: { ...externalCatalog.postHeartbeat, heartbeatCount: 1 },
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "GET-only streaming evidence must not qualify without repeated POST SSE heartbeats");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  boundedInspectionCalls: 7,
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "the concurrent eight-call inspection evidence must be required");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  workspaceApp: {
    ...externalCatalog.workspaceApp,
    hostRendererResourceUri: "ui://kontrol/workspace-app-deadbeefcafe.html",
    hostRendererUrisMatchCandidate: false,
  },
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "a host-captured renderer hash from another bundle must be rejected");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  workspaceApp: {
    ...externalCatalog.workspaceApp,
    resources: [{ ...externalCatalog.workspaceApp.resources[0], mimeType: "text/html" }],
  },
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "Workspace App resource MIME mismatches must be rejected");
const changedNestedDescriptor = structuredClone(externalCatalog);
changedNestedDescriptor.externalHostObservation.registeredCatalog[0].inputSchema.properties.workspaceId.minLength = 2;
assert.equal(validateBetaExternalCatalogReceipt(changedNestedDescriptor, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).externalHostObservationValid, false,
"changing a nested descriptor constraint invalidates the content-addressed host observation");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  hostToolDescriptors: externalCatalog.hostToolDescriptors.slice(1),
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).serverCatalogEvidenceValid, false,
"replacing one registered host descriptor breaks exact full-catalog parity");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  qualificationEvidenceAssociation: {
    ...externalCatalog.qualificationEvidenceAssociation,
    observationRecordId: "observation-from-another-capture",
  },
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).qualificationEvidenceAssociationValid, false,
"an altered observation ID cannot be substituted into the persisted association");
const priorBuildAcknowledgement = contentAddressedRecord({
  ...catalogAcknowledgementEvidence,
  serverBuildId: "previous-build",
});
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  hostCatalogHandshake: {
    ...externalCatalog.hostCatalogHandshake,
    evidenceRecord: priorBuildAcknowledgement,
  },
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).hostCatalogHandshakeMachineVerified, false,
"a content-valid acknowledgement from another build cannot be reused");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  hostRegistrationVerified: true,
  hostCapture: { ...externalCatalog.hostCapture, source: "host_integration", machineVerified: true },
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).hostRegistrationVerified, false,
"a receipt claim cannot upgrade operator evidence to a host integration");

function runFinal(extraEnv = {}) {
  return spawnSync(process.execPath, ["scripts/beta-gate-final.mjs"], {
    cwd: checkout,
    encoding: "utf8",
    env: {
      ...process.env,
      KONTROL_BETA_CODE_RECEIPT: codeReceiptPath,
      KONTROL_BETA_SOAK_REPORT: soakReportPath,
      KONTROL_BETA_EXTERNAL_CATALOG_RECEIPT: externalCatalogReceiptPath,
      KONTROL_BETA_RECEIPT: receiptPath,
      ...extraEnv,
    },
  });
}

try {
  writeFileSync(codeReceiptPath, JSON.stringify(code));
  writeFileSync(soakReportPath, JSON.stringify(soak));
  writeFileSync(externalCatalogReceiptPath, JSON.stringify(externalCatalog));
  const passed = runFinal();
  assert.notEqual(passed.status, 0,
    `the final gate must stay unqualified without genuine host registry evidence\n${passed.stdout}\n${passed.stderr}`);
  const qualifiedReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(qualifiedReceipt.qualified, false);
  assert.equal(qualifiedReceipt.stage, "combined");
  assert.equal(qualifiedReceipt.checks.externalCatalogFresh, false);
  assert.equal(qualifiedReceipt.externalCatalog.serverCatalogVerified, true);
  assert.equal(qualifiedReceipt.externalCatalog.hostRegistrationVerified, false);
  assert.equal(qualifiedReceipt.externalCatalog.hostRegistrationReason, "host_registration_unverified");
  assert.equal(qualifiedReceipt.externalCatalog.externalTransportVerified, true);
  assert.equal(qualifiedReceipt.externalCatalog.workspaceApp.valid, true);
  assert.deepEqual(qualifiedReceipt.externalCatalog.evidence.serverToolDescriptors,
    externalCatalog.serverToolDescriptors,
    "the final receipt preserves the exact full server descriptors used for hashing");
  assert.deepEqual(qualifiedReceipt.externalCatalog.evidence.hostToolDescriptors,
    externalCatalog.hostToolDescriptors,
    "the final receipt preserves every complete operator-reported host descriptor");
  assert.deepEqual(qualifiedReceipt.externalCatalog.evidence.externalHostObservation,
    externalCatalog.externalHostObservation,
    "the final receipt preserves the content-addressed operator host observation and provenance");

  writeFileSync(codeReceiptPath, JSON.stringify({
    ...code,
    faultMatrix: { ...code.faultMatrix, cases: [] },
  }));
  const missingMissionLoop = runFinal();
  assert.notEqual(missingMissionLoop.status, 0, "the code receipt must include the supervised mission loop fault case");
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).checks.supervisedMissionLoopQualified, false);
  writeFileSync(codeReceiptPath, JSON.stringify(code));

  writeFileSync(soakReportPath, JSON.stringify({ ...soak, expectedBuildId: "different-build" }));
  const rejected = runFinal();
  assert.notEqual(rejected.status, 0, "a soak for a different build must not qualify");
  const rejectedReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(rejectedReceipt.qualified, false);
  assert.equal(rejectedReceipt.checks.soakIdentity, false);

  writeFileSync(soakReportPath, JSON.stringify(soak));
  writeFileSync(externalCatalogReceiptPath, JSON.stringify({
    ...externalCatalog,
    hostCatalogVersion: "1.0.3+stale",
  }));
  const staleHostCatalog = runFinal();
  assert.notEqual(staleHostCatalog.status, 0, "a stale external host catalog must not qualify the deployment");
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).checks.externalCatalogFresh, false);

  writeFileSync(externalCatalogReceiptPath, JSON.stringify({
    ...externalCatalog,
    hostCatalogCapturedAt: "2026-08-26T23:59:00.000Z",
  }));
  const preDeploymentCatalog = runFinal();
  assert.notEqual(preDeploymentCatalog.status, 0, "a host catalog captured before the candidate soak must not qualify");
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).checks.externalCatalogFresh, false);

  writeFileSync(externalCatalogReceiptPath, JSON.stringify(externalCatalog));

  writeFileSync(soakReportPath, JSON.stringify({
    ...soak,
    requestedHours: 2,
    finishedAt: "2026-08-27T02:00:00.000Z",
  }));
  const tooShort = runFinal();
  assert.notEqual(tooShort.status, 0, "the canonical gate must reject a soak shorter than 12 hours");
  const tooShortReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(tooShortReceipt.policy.minimumSoakHours, 12);
  assert.equal(tooShortReceipt.checks.soakDuration, false);

  const attemptedPolicyOverride = runFinal({ KONTROL_BETA_MIN_SOAK_HOURS: "1" });
  assert.notEqual(attemptedPolicyOverride.status, 0, "the environment must not lower the 12-hour stable-beta floor");
  const attemptedOverrideReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(attemptedOverrideReceipt.policy.minimumSoakHours, 12);
  assert.equal(attemptedOverrideReceipt.checks.soakDuration, false);

  writeFileSync(soakReportPath, JSON.stringify({
    ...soak,
    assertions: { noUnexpectedCoreRestarts: true },
  }));
  const incomplete = runFinal();
  assert.notEqual(incomplete.status, 0, "an incomplete soak assertion set must not qualify");
  const incompleteReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(incompleteReceipt.checks.soakAssertionsPass, false);
  assert.ok(incompleteReceipt.soak.missingAssertions.includes("databaseIntegrityHealthy"));
  console.log("beta-gate-final.test.mjs: host registration provenance blocks final qualification as intended");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
