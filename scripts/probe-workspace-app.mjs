import assert from "node:assert/strict";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const url = urlIndex >= 0 ? args[urlIndex + 1] : "http://127.0.0.1:7676/mcp";
if (!url) throw new Error("usage: probe-workspace-app.mjs [--url http://127.0.0.1:7676/mcp]");

// Tunnel mode is intentionally unauthenticated at Kontrol's local /mcp hop.
// Keep the optional header for compatibility with older deployments, but do
// not require or invent a bearer token during readiness.
const token = process.env.KONTROL_TUNNEL_TOKEN;

let requestId = 0;
let sessionId;

function decode(text) {
  const data = text.trim().split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return JSON.parse(data || text);
}

async function rpc(method, params, { withSession = true } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (withSession && sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
  });
  const payload = decode(await response.text());
  if (method === "initialize") sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  assert.equal(response.status, 200, `${method} returned HTTP ${response.status}`);
  assert.ok(!payload.error, `${method}: ${payload.error?.message ?? "JSON-RPC error"}`);
  return payload.result;
}

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "kontrol-workspace-app-probe", version: "1" },
}, { withSession: false });
assert.ok(sessionId, "initialize did not provide an MCP session id");

const listed = await rpc("resources/list", {});
const resources = (listed.resources ?? []).filter((item) => typeof item?.uri === "string" && item.uri.startsWith("ui://kontrol/"));
const modern = resources.find((item) => /^ui:\/\/kontrol\/workspace-app-[a-f0-9]{12}\.html$/.test(item.uri));
assert.ok(modern, "resources/list did not advertise the hashed modern Kontrol workspace app");
assert.equal(modern.mimeType, "text/html;profile=mcp-app");
const compatibility = resources.filter((item) => item.uri !== modern.uri);
assert.ok(compatibility.length >= 2, "resources/list did not advertise cached-card compatibility URIs");
for (const resource of resources) {
  const read = await rpc("resources/read", { uri: resource.uri });
  const content = read.contents?.[0];
  assert.equal(content?.uri, resource.uri);
  assert.equal(typeof content?.mimeType, "string");
  assert.equal(typeof content?.text, "string");
  const expectedMimeType = /^ui:\/\/kontrol\/workspace-app-[a-f0-9]{12}\.html$/i.test(resource.uri)
    ? "text/html;profile=mcp-app"
    : "text/html+skybridge";
  assert.equal(content.mimeType, expectedMimeType, `${resource.uri} has the wrong Workspace App MIME type`);
  assert.ok(content.text.includes('<main id="app"'), `${resource.uri} is missing the app root`);
  assert.ok(content.text.length > 1_000, `${resource.uri} is unexpectedly small`);
  assert.doesNotMatch(JSON.stringify(content._meta ?? {}), /(?:127\.0\.0\.1|localhost|http:\/\/)/i, `${resource.uri} metadata exposes an invalid loopback CSP domain`);
}

const tools = await rpc("tools/list", {});
const openTool = tools.tools?.find((tool) => tool.name === "open_workspace");
assert.ok(openTool, "tools/list did not advertise open_workspace");
assert.equal(openTool._meta?.ui?.resourceUri, undefined,
  "open_workspace must remain data-only and leave renderer selection to show_workspace_ui");
assert.equal(openTool._meta["openai/outputTemplate"], undefined,
  "open_workspace must not advertise a legacy output template");
const showUiTool = tools.tools?.find((tool) => tool.name === "show_workspace_ui");
assert.ok(showUiTool?._meta?.ui?.resourceUri,
  "show_workspace_ui must advertise the standard modern Workspace App resource");
assert.equal(showUiTool._meta.ui.resourceUri, modern.uri,
  "show_workspace_ui must advertise the modern resource returned by resources/list");
assert.equal(showUiTool._meta["openai/outputTemplate"], modern.uri.replace(/\.html$/, ".skybridge.html"),
  "show_workspace_ui must advertise the matching content-hashed ChatGPT compatibility resource");
assert.ok(resources.some((resource) => resource.uri === showUiTool._meta["openai/outputTemplate"]
  && resource.mimeType === "text/html+skybridge"),
"resources/list must include the exact compatibility URI advertised by show_workspace_ui");
const opened = await rpc("tools/call", { name: "open_workspace", arguments: { path: process.cwd(), mode: "checkout" } });
const openedContent = opened.structuredContent ?? opened;
assert.equal(typeof openedContent.workspaceId, "string", "open_workspace must return a workspace card payload");
assert.ok(openedContent.root, "open_workspace card must carry its workspace root");
assert.ok(opened._meta?.tool === "open_workspace" || opened._meta?.card?.tool === "open_workspace" || openedContent.tool === "open_workspace",
  "open_workspace must provide a tool discriminator for widget result delivery");
const showUi = await rpc("tools/call", { name: "show_workspace_ui", arguments: { workspaceId: openedContent.workspaceId } });
const showUiContent = showUi.structuredContent ?? showUi;
assert.equal(showUiContent.tool, "show_workspace_ui", "show_workspace_ui must return a validated tool discriminator");
assert.equal(showUi._meta?.tool, "show_workspace_ui", "show_workspace_ui must also carry the validated host metadata discriminator");
assert.equal(showUiContent.workspaceId, openedContent.workspaceId, "show_workspace_ui must retain the selected workspace");
assert.ok(showUiContent.root, "show_workspace_ui must return the workspace root");
let modernBytes = 0;
for (const resource of resources) {
  const read = await rpc("resources/read", { uri: resource.uri });
  if (resource.uri === modern.uri) modernBytes = Buffer.byteLength(read.contents?.[0]?.text ?? "", "utf8");
}

console.log(JSON.stringify({ ok: true, modernUri: modern.uri, compatibilityUris: compatibility.map((item) => item.uri), workspaceId: openedContent.workspaceId, showWorkspaceUi: showUiContent.tool, modernBytes }));
