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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpUpstreamConnection } from "./lib/mcp-upstream-connection.mjs";
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

if (process.argv.includes("--validate-imports")) {
  console.log("[mcp-stdio-bridge] import validation ok");
  process.exit(0);
}

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
  "cancel_work_session",
]);

// Reviewer-only tools that must NEVER reach the worker.
const REVIEWER_TOOLS = new Set([
  "provide_review_feedback",
  "provide_policy_approval",
  "submit_to_coding_agent",
  "list_pending_approvals",
]);

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

const token = loadToken();
const headers = {};
if (token) headers["Authorization"] = `Bearer ${token}`;

// Carry the work-session attribution envelope (set by the adapter from the ACP
// request) into Kontrol's HTTP MCP connection. Kontrol binds each tool
// call on this connection to the exact work session named here.
if (process.env.KONTROL_WORKSPACE_SESSION_ID) {
  headers["X-Kontrol-Workspace-Session"] = process.env.KONTROL_WORKSPACE_SESSION_ID;
}
if (process.env.KONTROL_WORK_SESSION_ID) {
  headers["X-Kontrol-Work-Session"] = process.env.KONTROL_WORK_SESSION_ID;
}
if (process.env.KONTROL_PARENT_RUN_ID) {
  headers["X-Kontrol-Run"] = process.env.KONTROL_PARENT_RUN_ID;
}
if (process.env.KONTROL_CONTINUATION_ID) {
  headers["X-Kontrol-Continuation"] = process.env.KONTROL_CONTINUATION_ID;
}
if (process.env.KONTROL_WORKSPACE_LEASE_NONCE) {
  headers["X-Kontrol-Workspace-Lease-Nonce"] = process.env.KONTROL_WORKSPACE_LEASE_NONCE;
}

// Relay the signed worker envelope (issued by the adapter) so Kontrol can
// authenticate this connection's role + bound work session via HMAC instead of
// trusting the plain attribution headers above.
if (process.env.KONTROL_WORKER_TOKEN) {
  headers["X-Kontrol-Worker-Token"] = process.env.KONTROL_WORKER_TOKEN;
}

// The manager replaces the HTTP client/transport as needed. Auth and worker
// attribution headers are captured above and applied to every new generation.
const upstream = new McpUpstreamConnection({
  createClient: () => ({
    client: new Client({ name: "kontrol-stdio-bridge", version: "1.0.0" }, { capabilities: {} }),
    transport: new StreamableHTTPClientTransport(new URL(KONTROL_URL), { requestInit: { headers } }),
  }),
  onState: (state, generation) => console.error(`[mcp-stdio-bridge] upstream=${state} generation=${generation}`),
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
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(InitializeRequestSchema, async () => ({
  protocolVersion: "2025-06-18",
  capabilities: { tools: {}, resources: {} },
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
  const filtered = {
    ...all,
    tools: (all.tools ?? []).filter((t) => WORKER_TOOLS.has(t.name)),
  };
  return filtered;
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  if (!WORKER_TOOLS.has(name) || REVIEWER_TOOLS.has(name)) {
    return rejection(name);
  }
  try {
    return await withUpstreamOperation((client) => client.callTool({ name, arguments: req.params.arguments ?? {} }));
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => withUpstreamOperation((client) => client.listResources()));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => withUpstreamOperation((client) => client.readResource({ uri: req.params.uri })));
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
