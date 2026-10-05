import assert from "node:assert/strict";
import {
  assertInputSchemaCompatibility,
  extractCatalog,
  extractServerInfoVersion,
  extractWorkspaceAppResourceUris,
  fingerprintToolCatalog,
  matchJsonRpcResponse,
  parseSseEventChunks,
} from "./lib/mcp-probe-protocol.mjs";

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
