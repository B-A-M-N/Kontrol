// kontrol-stdio-bridge.mjs
//
// CRUSH (and MiMo) only speak the `stdio` MCP transport for external servers.
// Kontrol exposes its tools over Streamable HTTP at /mcp. This bridge is a
// thin stdio MCP *server* that proxies to Kontrol's HTTP MCP *server*, so a
// stdio-only agent (CRUSH / MiMo) can use Kontrol's file tools
// (read / write / edit / grep / glob / bash / ls / open_workspace / ...).
//
//   CRUSH (stdio client) -> this bridge (stdio server + HTTP client) -> kontrol :7676/mcp
//
// SECURITY: this bridge runs INSIDE the coding-agent (worker) process. It must
// NOT expose reviewer-only tools (provide_review_feedback, provide_policy_approval,
// submit_to_coding_agent, list_pending_approvals) to the worker. Filtering only
// tool *discovery* is not enough — the agent can still call any tool by name, so
// we filter BOTH ListTools and CallTool.
//
// Usage (CRUSH mcp config):
//   "kontrol": {
//     "type": "stdio",
//     "command": "node",
//     "args": ["/absolute/path/to/Kontrol/scripts/mcp-stdio-bridge.mjs"],
//     "cwd": "/absolute/path/to/project"
//   }
//
// Auth: tunnel mode can use KONTROL_TUNNEL_TOKEN directly. If needed, point
// KONTROL_BRIDGE_ENV at a 0600 env file containing KONTROL_TUNNEL_TOKEN.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpUpstreamConnection } from "./lib/mcp-upstream-connection.mjs";
import { authorizationForEndpoint, endpointFetch, EndpointPreferenceStore, McpEndpointSelector, parseMcpEndpointProfiles, restoreWorkerWorkspaceContext } from "./lib/mcp-endpoint-selector.mjs";
import {
  InitializeRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  PingRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const KONTROL_URL = process.env.KONTROL_BRIDGE_URL || "http://127.0.0.1:7676/mcp";
const KONTROL_ENV = process.env.KONTROL_BRIDGE_ENV || "";
const BRIDGE_PRINCIPAL = process.env.KONTROL_BRIDGE_PRINCIPAL || "worker";

// Tools the coding agent (worker) is permitted to use. Anything NOT in this
// set — especially reviewer-only tools — is hidden from discovery AND rejected
// on call. This is the second line of defense behind the server-side role
// checks: even if the worker guesses a tool name, it cannot invoke it here.
const WORKER_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "grep",
  "glob",
  "ls",
  "git_status",
  "git_log",
  "git_diff",
  "git_show",
  "poll_process",
  "bash",
  "apply_patch",
  "show_changes",
  "open_workspace",
  "submit_for_review",
  "await_review_feedback",
  "get_work_session",
  "get_continuation_prompt",
  "check_review_status",
  "get_review_submission",
  "ack_agent_reply",
  "cancel_work_session",
]);

const REQUIRED_WORKER_INSPECTION_TOOLS = [
  "read", "grep", "glob", "ls", "git_status", "git_log", "git_diff", "git_show",
];
for (const name of REQUIRED_WORKER_INSPECTION_TOOLS) {
  if (!WORKER_TOOLS.has(name)) throw new Error("worker bridge is missing required inspection capability: " + name);
}
if (!WORKER_TOOLS.has("poll_process")) throw new Error("worker bridge is missing process polling capability");
if (!WORKER_TOOLS.has("ack_agent_reply")) throw new Error("worker bridge is missing bounded reply acknowledgement capability");

if (process.argv.includes("--validate-imports")) {
  console.log("[mcp-stdio-bridge] import and worker tool-surface validation ok");
  process.exit(0);
}

// Reviewer-only tools that must NEVER reach the worker.
const REVIEWER_TOOLS = new Set([
  "provide_review_feedback",
  "provide_policy_approval",
  "submit_to_coding_agent",
  "list_pending_approvals",
]);

function configuredEndpoints() {
  if (process.env.KONTROL_BRIDGE_ENDPOINTS) {
    if (BRIDGE_PRINCIPAL === "worker") return parseMcpEndpointProfiles(process.env.KONTROL_BRIDGE_ENDPOINTS, WORKER_TOOLS, "worker");
    if (BRIDGE_PRINCIPAL !== "owner_public") throw new Error("unsupported stdio bridge principal");
    let parsed;
    try { parsed = JSON.parse(process.env.KONTROL_BRIDGE_ENDPOINTS); } catch { throw new Error("KONTROL_BRIDGE_ENDPOINTS must be valid JSON"); }
    const ownerCapabilities = new Set((Array.isArray(parsed) ? parsed : []).flatMap((profile) => Array.isArray(profile?.allowedCapabilities) ? profile.allowedCapabilities.filter((name) => typeof name === "string") : []));
    const profiles = parseMcpEndpointProfiles(process.env.KONTROL_BRIDGE_ENDPOINTS, ownerCapabilities, "owner_public");
    if (profiles.some((profile) => profile.privacy !== "public" || profile.auth.type !== "bearer_file")) throw new Error("owner stdio bridge profiles require public OAuth and endpoint-specific bearer files");
    return profiles;
  }
  if (BRIDGE_PRINCIPAL !== "worker") throw new Error("owner stdio bridge requires explicit KONTROL_BRIDGE_ENDPOINTS profiles");
  const url = new URL(KONTROL_URL);
  if (url.pathname !== "/mcp" || url.username || url.password || url.search || url.hash) throw new Error("KONTROL_BRIDGE_URL must be a credential-free /mcp endpoint URL");
  return [Object.freeze({
    id: "legacy-primary",
    url: url.href,
    expectedTlsAuthority: url.host.toLowerCase(),
    principal: "worker",
    resourceIdentity: url.protocol === "https:" ? url.origin + "/mcp" : null,
    allowedCapabilities: Object.freeze([...WORKER_TOOLS]),
    allowedResources: null,
    privacy: "private",
    auth: Object.freeze({ type: "legacy_tunnel" }),
    circuitBreaker: Object.freeze({ failureThreshold: 2, cooldownMs: 30_000 }),
  })];
}

const endpointProfiles = configuredEndpoints();
const endpointSelector = new McpEndpointSelector(endpointProfiles);
const endpointPreferenceStore = BRIDGE_PRINCIPAL === "owner_public"
  ? new EndpointPreferenceStore(process.env.KONTROL_BRIDGE_PREFERENCE_FILE || join(homedir(), ".kontrol", "bridge-endpoint-preferences.json"), endpointProfiles)
  : null;
if (endpointPreferenceStore) endpointSelector.setPreference(endpointPreferenceStore.read());
const availableTools = new Map();
let activeEndpoint;
let downstreamInitialized = false;
let lastRestorableWorkspace;

function endpointAuthorization(profile) {
  if (profile.auth.type === "legacy_tunnel") {
    const currentToken = loadToken();
    return currentToken ? "Bearer " + currentToken : "";
  }
  return authorizationForEndpoint(profile);
}

async function prepareEndpoint(profile) {
  if (profile.auth.type === "worker_envelope" && !process.env.KONTROL_WORKER_TOKEN) throw new Error("endpoint " + profile.id + " requires a bound worker authorization envelope");
  if (!profile.resourceIdentity) return;
  const fetchForEndpoint = endpointFetch(profile);
  const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", profile.url);
  const response = await fetchForEndpoint(metadataUrl, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (response.status !== 200) throw new Error("endpoint " + profile.id + " OAuth resource metadata returned HTTP " + response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("endpoint " + profile.id + " OAuth resource metadata body is missing");
  const chunks = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > 64 * 1024) {
        await reader.cancel().catch(() => {});
        throw new Error("endpoint " + profile.id + " OAuth resource metadata exceeded its bound");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let metadata;
  try { metadata = JSON.parse(new TextDecoder().decode(body)); } catch { throw new Error("endpoint " + profile.id + " OAuth resource metadata is invalid"); }
  if (metadata.resource !== profile.resourceIdentity) throw new Error("endpoint " + profile.id + " OAuth resource identity does not match its configured endpoint");
}

async function qualifyEndpoint(client, profile) {
  const version = client.getServerVersion?.();
  if (!version || typeof version.name !== "string" || typeof version.version !== "string") throw new Error("endpoint " + profile.id + " did not return MCP server identity");
  const catalog = await client.listTools();
  if (!Array.isArray(catalog.tools)) throw new Error("endpoint " + profile.id + " did not return an MCP tools catalog");
  const exposed = new Set(catalog.tools.map((tool) => tool.name).filter((name) => typeof name === "string"));
  const eligible = new Set(profile.allowedCapabilities.filter((name) => (BRIDGE_PRINCIPAL !== "worker" || WORKER_TOOLS.has(name)) && exposed.has(name)));
  if (eligible.size === 0) throw new Error("endpoint " + profile.id + " exposes none of its configured worker capabilities");
  if (lastRestorableWorkspace) {
    if (!eligible.has("open_workspace")) throw new Error("endpoint " + profile.id + " cannot restore the worker workspace capability");
    await restoreWorkerWorkspaceContext(client, lastRestorableWorkspace);
  }
  availableTools.set(profile.id, eligible);
}

function loadToken() {
  if (process.env.KONTROL_TUNNEL_TOKEN) return process.env.KONTROL_TUNNEL_TOKEN;
  if (!KONTROL_ENV) return "";
  try {
    const text = readFileSync(KONTROL_ENV, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*export\s+KONTROL_TUNNEL_TOKEN=(.*)\s*$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* ignore — token may simply be unset (No-Auth / OAuth mode) */
  }
  return "";
}

const headers = {};

// Worker attribution is carried only by the worker bridge. The owner bridge
// has a separate process entrypoint and relies on its endpoint-bound OAuth.
if (BRIDGE_PRINCIPAL === "worker" && process.env.KONTROL_WORKSPACE_SESSION_ID) {
  headers["X-Kontrol-Workspace-Session"] = process.env.KONTROL_WORKSPACE_SESSION_ID;
}
if (BRIDGE_PRINCIPAL === "worker" && process.env.KONTROL_WORK_SESSION_ID) {
  headers["X-Kontrol-Work-Session"] = process.env.KONTROL_WORK_SESSION_ID;
}
if (BRIDGE_PRINCIPAL === "worker" && process.env.KONTROL_PARENT_RUN_ID) {
  headers["X-Kontrol-Run"] = process.env.KONTROL_PARENT_RUN_ID;
}
if (BRIDGE_PRINCIPAL === "worker" && process.env.KONTROL_CONTINUATION_ID) {
  headers["X-Kontrol-Continuation"] = process.env.KONTROL_CONTINUATION_ID;
}
if (BRIDGE_PRINCIPAL === "worker" && process.env.KONTROL_WORKSPACE_LEASE_NONCE) {
  headers["X-Kontrol-Workspace-Lease-Nonce"] = process.env.KONTROL_WORKSPACE_LEASE_NONCE;
}

// Relay the signed worker envelope (issued by the adapter) so Kontrol can
// authenticate this connection's role + bound work session via HMAC instead of
// trusting the plain attribution headers above.
if (BRIDGE_PRINCIPAL === "worker" && process.env.KONTROL_WORKER_TOKEN) {
  headers["X-Kontrol-Worker-Token"] = process.env.KONTROL_WORKER_TOKEN;
}

// The manager replaces the HTTP client/transport as needed. Auth and worker
// attribution headers are captured above and applied to every new generation.
const upstream = new McpUpstreamConnection({
  createClient: () => {
    const candidate = endpointSelector.select();
    const requestHeaders = { ...headers };
    const authorization = endpointAuthorization(candidate);
    if (authorization) requestHeaders.Authorization = authorization;
    const fetch = endpointFetch(candidate);
    const client = new Client({ name: "kontrol-stdio-bridge", version: "1.0.0" }, { capabilities: {} });
    // A transport-level failure (dropped stream, reset socket, exhausted
    // stream reconnection) is a CONNECTION LOSS. Without this, the client
    // keeps reporting READY against a broken transport and the bridge never
    // rebuilds a fresh upstream session on the next endpoint. Closing the
    // client makes the upstream manager observe onclose and run its bounded,
    // single-flight recovery.
    client.onerror = () => {
      void client.close().catch(() => undefined);
    };
    return {
      candidate,
      client,
      transport: new StreamableHTTPClientTransport(new URL(candidate.url), {
        requestInit: { headers: requestHeaders },
        fetch,
        reconnectionOptions: { maxRetries: 0 },
      }),
    };
  },
  prepareCandidate: prepareEndpoint,
  qualifyClient: qualifyEndpoint,
  onConnectResult: (candidate, ok) => endpointSelector.record(candidate.id, ok),
  onState: (state, generation, candidate) => {
    if (state === "READY") {
      const previousId = activeEndpoint?.id;
      activeEndpoint = candidate;
      if (previousId && previousId !== candidate?.id) {
        if (downstreamInitialized) {
          void server.sendToolListChanged().catch(() => {});
          void server.sendResourceListChanged().catch(() => {});
        }
      }
    }
    console.error("[mcp-stdio-bridge] upstream=" + state + " generation=" + generation + " endpoint=" + (candidate?.id ?? "none"));
  },
});
const activeUpstreamOperations = new Set();
function withUpstreamOperation(operation) {
  const promise = Promise.resolve().then(() => operation(upstream.requireClient()));
  activeUpstreamOperations.add(promise);
  void promise.finally(() => activeUpstreamOperations.delete(promise)).catch(() => undefined);
  return promise;
}

// 2) stdio MCP server -> the agent (CRUSH / MiMo).
const server = new Server(
  { name: "kontrol-bridge", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } },
);
server.oninitialized = () => { downstreamInitialized = true; };

server.setRequestHandler(InitializeRequestSchema, async () => ({
  protocolVersion: "2025-06-18",
  capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
  serverInfo: { name: "kontrol-bridge", version: "1.0.0" },
}));

function rejection(name) {
  return {
    content: [{ type: "text", text: `Tool "${name}" is not available to the coding agent.` }],
    isError: true,
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const all = await withUpstreamOperation((client) => client.listTools());
  const allowed = activeEndpoint ? availableTools.get(activeEndpoint.id) : undefined;
  const tools = (all.tools ?? []).filter((tool) => (BRIDGE_PRINCIPAL !== "worker" || WORKER_TOOLS.has(tool.name))
    && (activeEndpoint?.allowedCapabilities.includes(tool.name) ?? true)
    && (!allowed || allowed.has(tool.name)));
  if (endpointPreferenceStore && endpointProfiles.length > 1) {
    const ingress = tools.find((tool) => tool.name === "ingress_management");
    if (ingress) {
      const inputSchema = structuredClone(ingress.inputSchema ?? {});
      inputSchema.properties ??= {};
      const action = inputSchema.properties.action ?? { type: "string" };
      action.enum = [...new Set([...(action.enum ?? []), "set_preference"])];
      inputSchema.properties.action = action;
      inputSchema.properties.preferredEndpointIds = { type: "array", items: { type: "string", enum: endpointProfiles.map((profile) => profile.id) }, minItems: endpointProfiles.length, maxItems: endpointProfiles.length };
      ingress.inputSchema = inputSchema;
      ingress.description = `${ingress.description ?? ""} The owner stdio bridge also supports set_preference with a complete ordered endpoint ID list; it affects subsequent connection attempts only.`.trim();
      if (ingress.outputSchema?.properties) {
        ingress.outputSchema.properties.endpointPreference = {
          type: "object", properties: {
            endpointIds: { type: "array", items: { type: "string" } },
            endpoints: { type: "array", items: { type: "object" } },
          }, required: ["endpointIds", "endpoints"], additionalProperties: false,
        };
      }
    }
  }
  const filtered = {
    ...all,
    tools,
  };
  return filtered;
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const allowed = activeEndpoint ? availableTools.get(activeEndpoint.id) : undefined;
  if ((BRIDGE_PRINCIPAL === "worker" && (!WORKER_TOOLS.has(name) || REVIEWER_TOOLS.has(name)))
    || Boolean(activeEndpoint && !activeEndpoint.allowedCapabilities.includes(name))
    || Boolean(allowed && !allowed.has(name))) {
    return rejection(name);
  }
  const args = req.params.arguments ?? {};
  if (name === "ingress_management" && endpointPreferenceStore && args.action === "set_preference") {
    try {
      if (args.confirm !== true) throw new Error("Changing the client failover preference requires explicit confirmation.");
      const endpointIds = endpointPreferenceStore.write(args.preferredEndpointIds);
      endpointSelector.setPreference(endpointIds);
      const result = await withUpstreamOperation((client) => client.callTool({ name, arguments: { action: "inspect" } }));
      return withEndpointPreference(result);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : "Endpoint preference update failed." }], isError: true };
    }
  }
  let dispatched = false;
  try {
    const result = await withUpstreamOperation((client) => {
      dispatched = true;
      return client.callTool({ name, arguments: args });
    });
    if (name === "open_workspace" && !result?.isError && process.env.KONTROL_WORKER_TOKEN
      && req.params.arguments?.mode !== "worktree" && typeof result?.structuredContent?.workspaceId === "string") {
      lastRestorableWorkspace = {
        arguments: { path: req.params.arguments.path, mode: "checkout" },
        workspaceId: result.structuredContent.workspaceId,
      };
    }
    return name === "ingress_management" && endpointPreferenceStore ? withEndpointPreference(result) : result;
  } catch (error) {
    return {
      content: [{ type: "text", text: dispatched
        ? "The upstream call failed after dispatch; its outcome may be uncertain. Reconcile it before deciding whether to retry."
        : (error instanceof Error ? error.message : "The upstream call was not sent.") }],
      isError: true,
    };
  }
});

function withEndpointPreference(result) {
  const preference = { endpointIds: endpointSelector.snapshot().map((endpoint) => endpoint.id), endpoints: endpointSelector.snapshot() };
  const structuredContent = result?.structuredContent && typeof result.structuredContent === "object"
    ? { ...result.structuredContent, endpointPreference: preference }
    : result?.structuredContent;
  const meta = result?._meta && typeof result._meta === "object" ? result._meta : {};
  const card = meta.card && typeof meta.card === "object" ? meta.card : {};
  return {
    ...result,
    ...(structuredContent ? { structuredContent } : {}),
    _meta: { ...meta, card: { ...card, tool: "ingress_management", summary: structuredContent } },
  };
}

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const result = await withUpstreamOperation((client) => client.listResources());
  if (!activeEndpoint || activeEndpoint.allowedResources === null) return result;
  const allowed = new Set(activeEndpoint.allowedResources);
  return { ...result, resources: (result.resources ?? []).filter((resource) => allowed.has(resource.uri)) };
});
server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (activeEndpoint && activeEndpoint.allowedResources !== null && !activeEndpoint.allowedResources.includes(req.params.uri)) {
    throw new Error("Resource is not available to this worker endpoint profile.");
  }
  return withUpstreamOperation((client) => client.readResource({ uri: req.params.uri }));
});
server.setRequestHandler(PingRequestSchema, async () => ({}));

const stdio = new StdioServerTransport();
await server.connect(stdio);

let stopping = false;
let shutdownPromise;
function shutdown(reason) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  console.error(`[mcp-stdio-bridge] stopping reason=${reason}`);
  shutdownPromise = (async () => {
    try { await server.close(); } catch { /* downstream already closed */ }
    let drainTimer;
    try {
      await Promise.race([
        Promise.allSettled([...activeUpstreamOperations]),
        new Promise((resolve) => { drainTimer = setTimeout(resolve, 5_000); }),
      ]);
    } finally {
      if (drainTimer) clearTimeout(drainTimer);
    }
    await upstream.close();
    process.exitCode = 0;
  })();
  return shutdownPromise;
}
server.onclose = () => { void shutdown("downstream_closed"); };
process.stdin.on("end", () => { void shutdown("stdin_eof"); });
process.once("SIGTERM", () => { void shutdown("sigterm"); });
process.once("SIGINT", () => { void shutdown("sigint"); });
void upstream.start();
