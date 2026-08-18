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
const resource = listed.resources?.find((item) => (
  typeof item?.uri === "string"
  && /^ui:\/\/kontrol\/workspace-app-[a-f0-9]{12}\.html$/.test(item.uri)
));
assert.ok(resource, "resources/list did not advertise the hashed Kontrol workspace app");
assert.equal(resource.mimeType, "text/html;profile=mcp-app");

const read = await rpc("resources/read", { uri: resource.uri });
const content = read.contents?.[0];
assert.equal(content?.uri, resource.uri);
assert.equal(content?.mimeType, "text/html;profile=mcp-app");
assert.equal(typeof content?.text, "string");
assert.ok(content.text.includes('<main id="app"'), "workspace app HTML is missing its app root");
assert.ok(content.text.length > 1_000, "workspace app HTML is unexpectedly small");
assert.doesNotMatch(JSON.stringify(content._meta ?? {}), /(?:127\.0\.0\.1|localhost|http:\/\/)/i, "workspace app metadata exposes an invalid loopback CSP domain");

console.log(JSON.stringify({ ok: true, uri: resource.uri, bytes: Buffer.byteLength(content.text, "utf8") }));
