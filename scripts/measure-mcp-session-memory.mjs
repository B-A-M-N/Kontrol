import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

if (typeof global.gc !== "function") {
  throw new Error("Run with --expose-gc to measure retained heap after collection.");
}

const root = join(tmpdir(), `kontrol-mcp-memory-root-${process.pid}`);
const stateDir = join(tmpdir(), `kontrol-mcp-memory-state-${process.pid}`);
const configDir = join(tmpdir(), `kontrol-mcp-memory-config-${process.pid}`);
const worktreeRoot = join(tmpdir(), `kontrol-mcp-memory-worktrees-${process.pid}`);
for (const directory of [root, stateDir, configDir, worktreeRoot]) mkdirSync(directory, { recursive: true });
writeFileSync(join(root, "probe.txt"), "MCP session memory profile\n");

const { loadConfig } = await import(pathToFileURL(resolve("src/config.ts")).href);
const { createMcpServer } = await import(pathToFileURL(resolve("src/mcp/workspace-server.ts")).href);
const { WorkspaceRegistry } = await import(pathToFileURL(resolve("src/workspaces.ts")).href);
const { createReviewCheckpointManager } = await import(pathToFileURL(resolve("src/review-checkpoints.ts")).href);
const config = loadConfig({
  KONTROL_CONFIG_DIR: configDir,
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_POLICY_MODE: "allow",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_LOG_REQUESTS: "0",
});

const servers = [];
const transports = new Map();
const sessions = new Map();
const workspaces = new WorkspaceRegistry(config);
const reviewCheckpoints = createReviewCheckpointManager({ snapshotStoreRoot: join(stateDir, "workspace-snapshots") });

function sample(label, workload) {
  global.gc();
  const memory = process.memoryUsage();
  console.log(JSON.stringify({
    label,
    sessionCount: sessions.size,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    rssBytes: memory.rss,
    externalBytes: memory.external,
    workload,
  }));
}

function createSessionState(sessionId, logicalClientId) {
  const now = Date.now();
  return {
    sessionId,
    sessionLabel: `profile:${sessionId}`,
    logicalClientId,
    identitySource: "client_info_fallback",
    authenticatedRole: "client",
    authSource: "anonymous",
    conversationId: undefined,
    approvalCorrelationId: undefined,
    workSessionId: undefined,
    createdAt: now,
    lastTransportActivityAt: now,
    lastApplicationActivityAt: now,
    inFlightRequests: 0,
    requestCount: 1,
    notificationCount: 0,
    toolCallCount: 0,
    resourceReadCount: 0,
    activeLongPollCount: 0,
    activeSseStreams: 0,
    transportAttached: false,
    activePolicyWaiters: 0,
    closing: false,
    closed: false,
    endRecorded: false,
    durableWorkerSession: false,
    lastRpcMethod: "initialize",
  };
}

try {
  sample("baseline", "process initialized; no MCP server instances");
  for (let index = 1; index <= 200; index++) {
    const sessionId = randomUUID();
    const logicalClientId = `profile-client-${index}`;
    const context = { authenticatedRole: "client", authSource: "anonymous", mcpSessionId: sessionId };
    const args = [config, workspaces, reviewCheckpoints, {}];
    while (args.length < 13) args.push(undefined);
    args.push(context);
    const server = createMcpServer(...args);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await server.connect(transport);
    servers.push(server);
    transports.set(sessionId, transport);
    sessions.set(sessionId, createSessionState(sessionId, logicalClientId));
    if ([1, 25, 100, 200].includes(index)) sample("connected-idle", "McpServer + connected in-process transport + per-session state; no tool calls");
  }

  const firstSessions = [...transports.keys()].slice(0, 25);
  for (let index = 0; index < firstSessions.length; index++) {
    const sessionId = firstSessions[index];
    const server = servers[index];
    const tools = server._registeredTools;
    const opened = await tools.open_workspace.handler({ path: root, mode: "checkout" });
    const workspaceId = opened?.structuredContent?.workspaceId;
    if (typeof workspaceId !== "string") throw new Error("open_workspace did not produce a workspaceId during the active-session profile.");
    const read = await tools.read.handler({ workspaceId, path: "probe.txt" });
    if (read?.isError) throw new Error("read failed during the active-session profile.");
    const session = sessions.get(sessionId);
    session.toolCallCount = 2;
    session.lastApplicationActivityAt = Date.now();
  }
  sample("active-25-of-200", "25 sessions each opened a workspace and read a file through their own registered tool handlers");
} finally {
  await Promise.allSettled(servers.map((server) => server.close()));
  await reviewCheckpoints.getSnapshotStore().close();
  for (const directory of [root, stateDir, configDir, worktreeRoot]) rmSync(directory, { recursive: true, force: true });
}
