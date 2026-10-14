import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  assertInputSchemaCompatibility,
  extractCatalog,
  extractRegisteredCatalog,
  extractServerInfoVersion,
  extractWorkspaceAppResourceUris,
  fingerprintToolCatalog,
  matchJsonRpcResponse,
  parseSseEventChunks,
} from "./lib/mcp-probe-protocol.mjs";
import {
  matchCatalogAcknowledgementEvidence,
  matchExternalSseEvidence,
  verifyQualificationEvidenceContentHash,
} from "./lib/mcp-qualification-evidence.mjs";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function contentAddressedRecord(record) {
  return {
    ...record,
    contentSha256: createHash("sha256").update(canonicalJson(record)).digest("hex"),
  };
}

const receivedOnly = { toolsList: { tools: [{ name: "server-read", inputSchema: { type: "object" } }] } };
assert.equal(extractRegisteredCatalog(receivedOnly), undefined,
  "a received tools/list must never be treated as the host's callable registry");
const registered = [{ name: "host-read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
assert.deepEqual(extractRegisteredCatalog({ registeredCatalog: registered })?.rawTools, registered,
  "only an explicit registeredCatalog field can provide host registry descriptors");

const captureSessionHash = "01234567" + "a".repeat(56);
const collidingPrefixSessionHash = "01234567" + "b".repeat(56);
const ackRecord = contentAddressedRecord({
  recordId: "ack-evidence-1",
  recordType: "catalog_acknowledgement",
  captureId: "capture-1",
  serverBuildId: "build-1",
  serverVersion: "1.0.0+build-1",
  sessionIdSha256: captureSessionHash,
  observedAt: "2026-10-14T12:00:00.000Z",
  expiresAt: "2027-01-12T12:00:00.000Z",
  status: "accepted",
  serverCatalogSha256: "a".repeat(64),
  hostCatalogSha256: "a".repeat(64),
  toolCount: 9,
});
assert.equal(verifyQualificationEvidenceContentHash(ackRecord), true);
assert.equal(matchCatalogAcknowledgementEvidence([ackRecord], {
  captureId: "capture-1",
  serverBuildId: "build-1",
  serverVersion: "1.0.0+build-1",
  sessionIdSha256: captureSessionHash,
  catalogSha256: "a".repeat(64),
  toolCount: 9,
}).length, 1, "persisted acknowledgement matches the exact capture, session, build and catalog");
assert.equal(matchCatalogAcknowledgementEvidence([ackRecord], {
  captureId: "capture-1",
  serverBuildId: "build-1",
  serverVersion: "1.0.0+build-1",
  sessionIdSha256: collidingPrefixSessionHash,
  catalogSha256: "a".repeat(64),
  toolCount: 9,
}).length, 0, "matching session prefixes cannot substitute for the complete session hash");

const streamRecord = contentAddressedRecord({
  recordId: "sse-evidence-1",
  recordType: "external_sse",
  captureId: "capture-1",
  serverBuildId: "build-1",
  serverVersion: "1.0.0+build-1",
  sessionIdSha256: captureSessionHash,
  operationId: "operation-1",
  observedAt: "2026-10-14T12:00:45.000Z",
  expiresAt: "2027-01-12T12:00:45.000Z",
  httpMethod: "POST",
  rpcMethod: "tools/call",
  toolName: "await_workspace_events",
  startedAt: "2026-10-14T12:00:00.000Z",
  finishedAt: "2026-10-14T12:00:45.000Z",
  durationMs: 45_000,
  httpStatus: 200,
  responseBytes: 500,
  heartbeatBytes: 60,
  responseCloseClassification: "response_finished",
  handlerStillRunning: false,
});
const streamExpectation = {
  operationId: "operation-1",
  sessionIdSha256: captureSessionHash,
  serverBuildId: "build-1",
  serverVersion: "1.0.0+build-1",
  captureId: "capture-1",
  toolName: "await_workspace_events",
  startedAt: "2026-10-14T12:00:00.500Z",
  finishedAt: "2026-10-14T12:00:45.500Z",
  requestedWaitMs: 45_000,
};
assert.equal(matchExternalSseEvidence([streamRecord], streamExpectation).length, 1,
  "external SSE evidence must match exact operation ID, full session hash, build and time window");
assert.equal(matchExternalSseEvidence([streamRecord], {
  ...streamExpectation,
  operationId: "another-operation",
}).length, 0, "a different server operation ID cannot qualify the host capture");
assert.equal(matchExternalSseEvidence([streamRecord], {
  ...streamExpectation,
  sessionIdSha256: collidingPrefixSessionHash,
}).length, 0, "an operation from a session with the same prefix cannot qualify another capture");
const { contentSha256: _streamContentSha256, ...streamContent } = streamRecord;
assert.equal(matchExternalSseEvidence([contentAddressedRecord({ ...streamContent, httpStatus: 500 })], streamExpectation).length, 0,
  "a completed SSE response with an unsuccessful HTTP status cannot qualify");
assert.equal(matchExternalSseEvidence([{ ...streamRecord, responseBytes: 501 }], streamExpectation).length, 0,
  "tampered evidence fields fail their content hash");

const completeTools = ["read", "grep", "glob", "ls", "git_status", "git_log", "git_diff", "git_show", "poll_process"];
const rawList = { jsonrpc: "2.0", id: 4, result: { tools: completeTools.map((name) => ({ name })) } };
assert.deepEqual([...extractCatalog(rawList).names].sort(), [...completeTools].sort());
assert.equal(extractCatalog(rawList).rawTools.length, completeTools.length);
const catalogFingerprint = fingerprintToolCatalog([
  { name: "write", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "read", inputSchema: { properties: { path: { type: "string" } }, type: "object" } },
]);
assert.deepEqual(catalogFingerprint, fingerprintToolCatalog([
  { inputSchema: { type: "object", properties: { path: { type: "string" } } }, name: "read" },
  { inputSchema: { properties: { path: { type: "string" } }, type: "object" }, name: "write" },
]), "catalog fingerprints ignore object-key and tool-list ordering");
assert.notEqual(catalogFingerprint.sha256, fingerprintToolCatalog([
  { name: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, approvalResumeId: { type: "string" } } } },
  { name: "write", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
]).sha256, "catalog fingerprints include callable input-schema changes");

const appCatalog = extractCatalog({ tools: [
  {
    name: "open_workspace",
    _meta: {
      ui: { resourceUri: "ui://kontrol/workspace-app-123456789abc.html", visibility: ["model"] },
      "openai/outputTemplate": "ui://kontrol/workspace-app.html",
    },
  },
  { name: "show_workspace_ui", _meta: { ui: { resourceUri: "ui://kontrol/workspace-app-123456789abc.html", visibility: ["model"] } } },
] });
assert.deepEqual(appCatalog.tools, [
  {
    name: "open_workspace",
    resourceUri: "ui://kontrol/workspace-app-123456789abc.html",
    visibility: ["model"],
    legacyOutputTemplate: "ui://kontrol/workspace-app.html",
  },
  {
    name: "show_workspace_ui",
    resourceUri: "ui://kontrol/workspace-app-123456789abc.html",
    visibility: ["model"],
  },
]);
assert.deepEqual(extractWorkspaceAppResourceUris(appCatalog), [
  "ui://kontrol/workspace-app-123456789abc.html",
  "ui://kontrol/workspace-app.html",
]);
assert.throws(() => extractCatalog({ tools: [{ name: "broken", _meta: { ui: { resourceUri: 4 } } }] }), /non-string _meta.ui.resourceUri/);

const schemaCatalog = (includeResumeId = true, required = ["workspaceId", "command"]) => extractCatalog({ tools: [{
  name: "bash",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "string" },
      command: { type: "string" },
      ...(includeResumeId ? { approvalResumeId: { type: "string" } } : {}),
    },
    required,
  },
}] });
assert.equal(assertInputSchemaCompatibility(schemaCatalog().tools, schemaCatalog().tools), true);
assert.throws(() => assertInputSchemaCompatibility(schemaCatalog().tools, schemaCatalog(false).tools), /missing approvalResumeId input for bash/,
  "host catalogs missing approvalResumeId must fail even when tool names match");
assert.throws(() => assertInputSchemaCompatibility(schemaCatalog().tools, schemaCatalog(true, ["workspaceId"]).tools), /input schema mismatch for bash/,
  "host catalogs must preserve the server's required input fields");

const hostEnvelope = {
  capturedAt: "2026-09-30T12:00:00.000Z",
  initialize: { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "Kontrol", version: "1.0.4+abc" } } },
  toolsList: rawList,
};
assert.equal(extractCatalog(hostEnvelope).version, "1.0.4+abc");
assert.equal(extractServerInfoVersion(hostEnvelope), "1.0.4+abc");

const contradictoryEnvelope = {
  tools: completeTools.map((name) => ({ name })),
  toolsList: { jsonrpc: "2.0", id: 4, result: { tools: [{ name: "read" }] } },
};
assert.throws(() => extractCatalog(contradictoryEnvelope), /exactly one authoritative tools list/,
  "a complete top-level catalog must not hide an incomplete nested toolsList");
assert.throws(() => extractCatalog({ tools: [{ name: "read" }], result: { tools: [{ name: "read" }] } }), /exactly one authoritative tools list/);

const chunks = [
  ": kontrol-heart", "beat\r\n\r\nevent: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\r\n",
  "data: \"params\":{\"progress\":1}}\r\n\r\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":9,\ndata: \"result\":{\"ok\":true}}\r\n\r\n",
];
const events = parseSseEventChunks(chunks);
assert.equal(events.length, 2, "heartbeat comments must not become events");
assert.equal(events[0].event, "message");
const matched = matchJsonRpcResponse(events, 9);
assert.equal(matched.intermediateNotifications, 1, "notifications are processed independently of the final response");
assert.deepEqual(matched.response.result, { ok: true });

const fragmentedOnlyNotification = parseSseEventChunks(["event: message\ndata: {\"jsonrpc\":\"2.0\",", "\"method\":\"notifications/progress\"}\n\n"]);
assert.equal(matchJsonRpcResponse(fragmentedOnlyNotification, 10).response, undefined,
  "a stream ending without the matching response is incomplete");
assert.throws(() => matchJsonRpcResponse(events, 10), /does not match request ID/);

console.log("probe-mcp-tunnel.test.mjs: catalog and SSE protocol tests passed");
