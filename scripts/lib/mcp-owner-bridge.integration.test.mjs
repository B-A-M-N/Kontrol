#!/usr/bin/env node
/**
 * Owner stdio bridge runtime proof (multipath ingress handoff).
 *
 * The handoff requires this deployment chain to be exercised end to end:
 * two separately authorized OAuth origins, a preference change through the
 * Workspace App control, persistence across a bridge restart, a forced
 * transport loss, and proof that the next qualified transport uses the
 * SELECTED route with the CORRECT origin-specific credential.
 *
 * Everything here runs against real processes over real TLS:
 *   - two HTTPS MCP upstreams with distinct bearer credentials,
 *   - the packaged owner stdio bridge as a child process,
 *   - a stdio MCP client driving the bridge.
 *
 * The upstreams are minimal MCP servers: they record the Authorization header
 * of every request, so "the right credential for the right origin" is proven
 * by observation, not by configuration.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bridgePath = join(root, "scripts", "mcp-owner-stdio-bridge.mjs");
const workDir = mkdtempSync(join(tmpdir(), "kontrol-owner-bridge-"));

function generateTlsMaterial() {
  const keyPath = join(workDir, "upstream-key.pem");
  const certPath = join(workDir, "upstream-cert.pem");
  const result = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`openssl is required to generate the local upstream TLS material: ${String(result.stderr ?? "").slice(0, 200)}`);
  }
  return { keyPath, certPath };
}

const { keyPath, certPath } = generateTlsMaterial();

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });
}

const TOOLS = [
  {
    name: "ingress_management",
    description: "Ingress management",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["inspect", "apply", "disable"] } },
      required: ["action"],
    },
  },
  {
    name: "ambiguous_mutation",
    description: "Mutates, then drops the connection before responding",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "break_transport",
    description: "Drops the connection without mutating anything",
    inputSchema: { type: "object", properties: {} },
  },
];

/** A minimal MCP origin with its own credential, port, and call log. */
async function startOrigin(name) {
  const state = {
    name,
    token: `owner-token-${name}-${"0".repeat(24)}`,
    authorizations: [],
    calls: [],
    ambiguousCalls: 0,
    breakCalls: 0,
    server: undefined,
    port: 0,
    origin: "",
    resourceIdentity: "",
  };
  const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, async (request, response) => {
    state.authorizations.push(request.headers.authorization ?? "");
    const url = request.url ?? "/";
    if (url === "/.well-known/oauth-protected-resource/mcp") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ resource: state.resourceIdentity, authorization_servers: [state.origin] }));
      return;
    }
    if (url !== "/mcp") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200);
      response.end();
      return;
    }
    let message;
    try {
      message = JSON.parse(await readBody(request));
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (typeof message.method === "string" && message.method.startsWith("notifications/")) {
      response.writeHead(202);
      response.end();
      return;
    }
    const reply = (result) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    if (message.method === "initialize") {
      reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: `origin-${name}`, version: "1.0.0" },
      });
      return;
    }
    if (message.method === "tools/list") {
      reply({ tools: TOOLS });
      return;
    }
    if (message.method === "tools/call") {
      const toolName = message.params?.name;
      state.calls.push({ name: toolName, arguments: message.params?.arguments });
      if (toolName === "break_transport") {
        state.breakCalls += 1;
        // The transport dies mid-request: the client observes a connection
        // loss and must rebuild a fresh session on the next endpoint.
        request.socket.destroy();
        return;
      }
      if (toolName === "ambiguous_mutation") {
        state.ambiguousCalls += 1;
        // The mutation was applied upstream but the response never arrives:
        // the client cannot know whether the call executed.
        request.socket.destroy();
        return;
      }
      reply({
        content: [{ type: "text", text: `origin-${name} handled ${toolName}` }],
        structuredContent: { origin: name, action: message.params?.arguments?.action ?? null },
      });
      return;
    }
    response.writeHead(400);
    response.end();
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  state.port = address.port;
  state.origin = `https://127.0.0.1:${address.port}`;
  state.resourceIdentity = `${state.origin}/mcp`;
  state.close = () => new Promise((resolveClose) => server.close(() => resolveClose()));
  return state;
}

function writeCredential(origin) {
  const path = join(workDir, `token-${origin.name}.txt`);
  writeFileSync(path, `Bearer ${origin.token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function endpointProfile(origin, credentialPath) {
  return {
    id: `origin-${origin.name}`,
    url: `${origin.origin}/mcp`,
    expectedTlsAuthority: `127.0.0.1:${origin.port}`,
    principal: "owner_public",
    resourceIdentity: origin.resourceIdentity,
    allowedCapabilities: ["ingress_management", "ambiguous_mutation", "break_transport"],
    privacy: "public",
    auth: { type: "bearer_file", credentialRef: credentialPath },
    circuitBreaker: { failureThreshold: 2, cooldownMs: 1_000 },
  };
}

async function startBridge({ profiles, preferenceFile }) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    NODE_EXTRA_CA_CERTS: certPath,
    KONTROL_BRIDGE_ENDPOINTS: JSON.stringify(profiles),
    KONTROL_BRIDGE_PREFERENCE_FILE: preferenceFile,
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bridgePath],
    env,
    stderr: "pipe",
    cwd: root,
  });
  const lines = [];
  transport.stderr?.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) if (line.trim()) lines.push(line.trim());
  });
  const client = new Client({ name: "owner-bridge-proof", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport, lines };
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
  }
  throw new Error(`timed out waiting for ${description}`);
}

const originA = await startOrigin("a");
const originB = await startOrigin("b");
const preferenceFile = join(workDir, "bridge-endpoint-preferences.json");
const profiles = [endpointProfile(originA, writeCredential(originA)), endpointProfile(originB, writeCredential(originB))];

try {
  // ── 1. the bridge qualifies the FIRST origin and uses ITS credential ──
  const first = await startBridge({ profiles, preferenceFile });
  await waitFor(
    () => first.lines.some((line) => line.includes("upstream=READY") && line.includes("endpoint=origin-a")),
    20_000,
    "the first origin to become READY",
  );
  const catalog = await first.client.listTools();
  const ingress = catalog.tools.find((tool) => tool.name === "ingress_management");
  assert.ok(ingress, "the bridge exposes the ingress management tool");
  assert.ok(ingress.inputSchema.properties.action.enum.includes("set_preference"),
    "the owner bridge adds the preference control to the ingress tool");
  assert.equal(originA.authorizations[0], "", "the OAuth metadata preflight carries no credential");
  assert.ok(originA.authorizations.length > 1, "the first origin served the MCP traffic");
  assert.ok(originA.authorizations.slice(1).every((value) => value === `Bearer ${originA.token}`),
    "every MCP request to the first origin used that origin's own credential");
  assert.equal(originB.authorizations.length, 0, "the second origin was not contacted yet");

  // ── 2. the preference change is persisted atomically for the operator ──
  const preferenceResult = await first.client.callTool({
    name: "ingress_management",
    arguments: { action: "set_preference", confirm: true, preferredEndpointIds: ["origin-b", "origin-a"] },
  });
  assert.equal(preferenceResult.isError, undefined, "the preference change succeeded");
  assert.deepEqual(JSON.parse(readFileSync(preferenceFile, "utf8")).endpointIds, ["origin-b", "origin-a"]);
  assert.equal(statSync(preferenceFile).mode & 0o777, 0o600, "the preference file stays owner-only");
  assert.deepEqual(
    preferenceResult.structuredContent.endpointPreference.endpointIds,
    ["origin-b", "origin-a"],
    "the bridge reports the new preference order",
  );

  // ── 3. a forced transport loss fails over to the SELECTED route ──
  const broken = await first.client.callTool({
    name: "break_transport",
    arguments: {},
  });
  assert.equal(broken.isError, true, "the broken transport is reported as a failed call, never a success");
  await waitFor(
    () => first.lines.some((line) => line.includes("upstream=READY") && line.includes("endpoint=origin-b")),
    30_000,
    "the bridge to fail over to the selected origin",
  );
  const afterFailover = await first.client.callTool({
    name: "ingress_management",
    arguments: { action: "inspect" },
  });
  assert.equal(afterFailover.isError, undefined, "the failover transport serves the call");
  assert.equal(afterFailover.structuredContent.origin, "b", "the call was served by the selected origin");
  assert.equal(originB.authorizations.filter((value) => value === "").length, 1,
    "only the OAuth metadata preflight is unauthenticated");
  assert.ok(originB.authorizations.slice(1).every((value) => value === `Bearer ${originB.token}`),
    "the failed-over transport used the selected origin's own credential");
  assert.ok(!originB.authorizations.includes(`Bearer ${originA.token}`),
    "the previous origin's credential never crossed to the other origin");

  // ── 4. the persisted preference survives a bridge restart ──
  await first.client.close();
  const restarted = await startBridge({ profiles, preferenceFile });
  await waitFor(
    () => restarted.lines.some((line) => line.includes("upstream=READY") && line.includes("endpoint=origin-b")),
    20_000,
    "the restarted bridge to honor the persisted preference",
  );
  assert.ok(originB.calls.length >= 1, "the restarted bridge kept using the selected origin");

  // ── 5. an ambiguous mutation is reported as uncertain and never replayed ──
  const before = originB.ambiguousCalls;
  const ambiguous = await restarted.client.callTool({
    name: "ambiguous_mutation",
    arguments: { marker: "unique-marker" },
  });
  assert.equal(ambiguous.isError, true, "an uncertain upstream call is an error, never a success");
  assert.match(String(ambiguous.content?.[0]?.text ?? ""), /uncertain/i,
    "the bridge tells the caller the outcome may be uncertain");
  await new Promise((resolveTick) => setTimeout(resolveTick, 500));
  assert.equal(originB.ambiguousCalls - before, 1,
    "the uncertain call reached the origin exactly once and was never replayed");

  await restarted.client.close();
} finally {
  await originA.close();
  await originB.close();
  rmSync(workDir, { recursive: true, force: true });
}

console.log("mcp-owner-bridge.integration: owner preference runtime proof passed");
