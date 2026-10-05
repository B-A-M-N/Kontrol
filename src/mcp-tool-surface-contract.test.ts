import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp/workspace-server.js";
import {
  mcpServerVersionFromBuildMeta,
  readMcpServerVersion,
  readMcpServerVersionFromBuildMeta,
} from "./mcp/tool-logging.js";
import { assertRequiredInspectionTools, REQUIRED_INSPECTION_TOOLS } from "./mcp/tool-names.js";
import { fingerprintToolCatalog, TOOL_CATALOG_ACK_CAPABILITY, TOOL_CATALOG_ACK_METHOD } from "./mcp/tool-catalog-handshake.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { loadConfig } from "./config.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { openDatabase } from "./db/client.js";
import { createWorkSessionManager } from "./work-sessions.js";

// Packaged candidates with the same npm version but different executable-tree
// identities must advertise different MCP server versions.
const fixtureRoot = mkdtempSync(join(tmpdir(), "kontrol-tool-surface-"));
try {
  const releaseA = join(fixtureRoot, "release-a");
  const releaseB = join(fixtureRoot, "release-b");
  mkdirSync(releaseA, { recursive: true });
  mkdirSync(releaseB, { recursive: true });
  writeFileSync(join(releaseA, "build-meta.json"), JSON.stringify({ version: "1.0.4", contentSha256: "a".repeat(64) }));
  writeFileSync(join(releaseB, "build-meta.json"), JSON.stringify({ version: "1.0.4", contentSha256: "b".repeat(64) }));
  const versionA = readMcpServerVersionFromBuildMeta(join(releaseA, "build-meta.json"));
  const versionB = readMcpServerVersionFromBuildMeta(join(releaseB, "build-meta.json"));
  assert.equal(versionA, `1.0.4+${"a".repeat(64)}`);
  assert.equal(versionB, `1.0.4+${"b".repeat(64)}`);
  assert.notEqual(versionA, versionB, "different packaged content identities cannot share an MCP version");
  assert.equal(mcpServerVersionFromBuildMeta({ version: "1.0.4", contentSha256: "invalid" }), "1.0.4");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

assert.throws(
  () => assertRequiredInspectionTools(new Set([REQUIRED_INSPECTION_TOOLS[0]])),
  /missing required inspection tool\(s\): grep, glob, ls, git_status, git_log, git_diff, git_show/,
  "the contract assertion must fail closed when a required tool is omitted",
);

const harnessRoot = mkdtempSync(join(tmpdir(), "kontrol-tool-surface-matrix-"));
const workspaceRoot = join(harnessRoot, "workspace");
mkdirSync(workspaceRoot, { recursive: true });

const modeExpectations: Record<string, { present: string[]; absent: string[] }> = {
  minimal: {
    present: ["write", "edit", "bash", "poll_process"],
    absent: ["apply_patch", "exec_command", "write_stdin"],
  },
  full: {
    present: ["write", "edit", "bash", "poll_process"],
    absent: ["apply_patch", "exec_command", "write_stdin"],
  },
  codex: {
    present: ["apply_patch", "exec_command", "write_stdin", "poll_process"],
    absent: ["write", "edit", "bash"],
  },
};

try {
  for (const [mode, expectation] of Object.entries(modeExpectations)) {
    const configDir = join(harnessRoot, `config-${mode}`);
    const stateDir = join(harnessRoot, `state-${mode}`);
    const snapshotStoreRoot = join(harnessRoot, `snapshots-${mode}`);
    mkdirSync(configDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(snapshotStoreRoot, { recursive: true });
    const config = loadConfig({
      KONTROL_CONFIG_DIR: configDir,
      KONTROL_ALLOWED_ROOTS: workspaceRoot,
      KONTROL_STATE_DIR: stateDir,
      KONTROL_WORKTREE_ROOT: join(harnessRoot, `worktrees-${mode}`),
      KONTROL_AUTH_MODE: "tunnel",
      KONTROL_ACP_ENABLED: "false",
      KONTROL_POLICY_MODE: "allow",
      KONTROL_LOG_LEVEL: "error",
      KONTROL_WIDGETS: "full",
      KONTROL_TOOL_MODE: mode,
    });
    const workspaces = new WorkspaceRegistry(config);
    const checkpoints = createReviewCheckpointManager({ snapshotStoreRoot });
    const processSessions = new ProcessSessionManager({ childEnvironmentAllowlist: [] });
    let observedHandshake: { status: "accepted" | "rejected"; reason?: string; serverCatalogSha256?: string; hostCatalogSha256: string } | undefined;
    const server = createServerWithHandshakeObserver(
      config,
      workspaces,
      checkpoints,
      processSessions,
      { mcpSessionId: `tool-surface-${mode}` },
      (_sessionId, result) => { observedHandshake = result; },
    );
    const client = new Client({ name: `mcp-tool-surface-${mode}`, version: "1.0.0" }, {
      capabilities: { extensions: { [TOOL_CATALOG_ACK_CAPABILITY]: { contractVersion: 1 } } },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      assert.equal(client.getServerVersion()?.version, readMcpServerVersion(),
        `${mode} MCP initialize must advertise the runtime tool-surface version`);
      assert.equal((client.getServerCapabilities()?.extensions?.[TOOL_CATALOG_ACK_CAPABILITY] as { contractVersion?: unknown } | undefined)?.contractVersion, 1,
        `${mode} must advertise the tool-catalog acknowledgement extension`);
      const listed = await client.listTools();
      const fingerprint = fingerprintToolCatalog({ tools: listed.tools });
      assert.ok(fingerprint, `${mode} tools/list catalog must be fingerprintable`);
      await client.notification({
        method: TOOL_CATALOG_ACK_METHOD,
        params: {
          contractVersion: 1,
          serverVersion: client.getServerVersion()!.version,
          hostCatalogSha256: fingerprint.sha256,
          hostToolCount: fingerprint.toolCount,
        },
      } as never);
      assert.equal(observedHandshake?.status, "accepted", `${mode} exact host catalog acknowledgement should be accepted`);
      assert.equal(observedHandshake?.serverCatalogSha256, fingerprint.sha256);
      await client.notification({
        method: TOOL_CATALOG_ACK_METHOD,
        params: {
          contractVersion: 1,
          serverVersion: client.getServerVersion()!.version,
          hostCatalogSha256: "0".repeat(64),
          hostToolCount: fingerprint.toolCount,
        },
      } as never);
      assert.equal(observedHandshake?.status, "rejected", `${mode} stale host catalog acknowledgement must be rejected`);
      assert.equal(observedHandshake?.reason, "host_catalog_fingerprint_mismatch");
      const names = new Set(listed.tools.map((tool) => tool.name));
      for (const name of ["read", "grep", "glob", "ls", "git_status", "git_log", "git_diff", "git_show"]) {
        assert.ok(names.has(name), `${mode} must expose required inspection tool ${name}`);
      }
      assert.ok(names.has("list_managed_worktrees"), `${mode} exposes managed worktree disposition listing`);
      assert.ok(names.has("retire_managed_worktree"), `${mode} exposes guarded managed worktree retirement`);
      for (const name of expectation.present) {
        assert.ok(names.has(name), `${mode} must expose mode-specific tool ${name}`);
      }
      for (const name of expectation.absent) {
        assert.equal(names.has(name), false, `${mode} must not expose ${name}`);
      }
      const opened = await client.callTool({
        name: "open_workspace",
        arguments: { path: workspaceRoot, mode: "checkout" },
      });
      const openedSurface = (opened.structuredContent as { toolSurface?: { version?: string; requiredInspectionTools?: string[] }; instruction?: string } | undefined);
      assert.deepEqual(openedSurface?.toolSurface?.requiredInspectionTools, ["read", "grep", "glob", "ls", "git_status", "git_log", "git_diff", "git_show"],
        `${mode} open_workspace must return the required inspection surface`);
      assert.equal(typeof openedSurface?.toolSurface?.version, "string",
        `${mode} open_workspace must return the MCP surface version`);
      assert.match(openedSurface?.instruction ?? "", /active Kontrol server exposes .* in tool surface/i,
        `${mode} open_workspace must identify the active server tool surface`);
      assert.match(openedSurface?.instruction ?? "", /client's catalog omits any of them, refresh or initialize a fresh MCP connection/i,
        `${mode} open_workspace must explain how to refresh a stale client catalog`);
      assert.match(openedSurface?.instruction ?? "", /meanwhile continue with available bounded structured tools such as read/i,
        `${mode} open_workspace must permit safe structured operations while reconnecting`);
      const managed = await client.callTool({ name: "list_managed_worktrees", arguments: {} });
      assert.notEqual(managed.isError, true, `${mode} managed worktree listing should be available`);
      assert.deepEqual((managed.structuredContent as { worktrees?: unknown[] } | undefined)?.worktrees, []);
    } finally {
      await client.close();
      await server.close();
      await checkpoints.drain();
    }
  }
} finally {
  rmSync(harnessRoot, { recursive: true, force: true });
}

console.log("mcp-tool-surface-contract.test.ts: all assertions passed");

function createServerWithHandshakeObserver(
  config: ReturnType<typeof loadConfig>,
  workspaces: WorkspaceRegistry,
  checkpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  connectionContext: { mcpSessionId: string },
  onHandshake: NonNullable<Parameters<typeof createMcpServer>[23]>,
) {
  return createMcpServer(
    config, workspaces, checkpoints, processSessions,
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined,
    connectionContext,
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined,
    onHandshake,
  );
}

// Mutation authority is independent of checkpoint widgets. A direct client
// cannot mutate a checkout while a delegated session holds its lease, while a
// worker must present the live fencing nonce bound to that exact session.
const leaseHarnessRoot = mkdtempSync(join(tmpdir(), "kontrol-lease-fence-"));
const leaseWorkspacePath = join(leaseHarnessRoot, "workspace");
const leaseOtherWorkspaceRoot = join(leaseHarnessRoot, "other-workspace");
const leaseStateDir = join(leaseHarnessRoot, "state");
mkdirSync(leaseWorkspacePath, { recursive: true });
mkdirSync(leaseOtherWorkspaceRoot, { recursive: true });
const leaseWorkspaceRoot = realpathSync(leaseWorkspacePath);
mkdirSync(leaseStateDir, { recursive: true });
const leaseConfig = loadConfig({
  KONTROL_CONFIG_DIR: join(leaseHarnessRoot, "config"),
  KONTROL_ALLOWED_ROOTS: leaseHarnessRoot,
  KONTROL_STATE_DIR: leaseStateDir,
  KONTROL_WORKTREE_ROOT: join(leaseHarnessRoot, "worktrees"),
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_POLICY_MODE: "allow",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_WIDGETS: "off",
  KONTROL_TOOL_MODE: "full",
});
const leaseWorkspaces = new WorkspaceRegistry(leaseConfig);
const leaseCheckpoints = createReviewCheckpointManager({ snapshotStoreRoot: join(leaseHarnessRoot, "snapshots") });
const leaseProcesses = new ProcessSessionManager({ childEnvironmentAllowlist: [] });
const leaseDb = openDatabase(leaseStateDir);
const leaseSessions = createWorkSessionManager(leaseDb);
const makeLeaseClient = async (context?: {
  authenticatedRole: "worker" | "reviewer" | "client";
  workSessionId?: string;
  workspaceSessionId?: string;
  workspaceLeaseNonce?: string;
  mcpSessionId?: string;
}, policy?: { engine?: any; enforcer?: any }) => {
  const server = createMcpServer(
    leaseConfig,
    leaseWorkspaces,
    leaseCheckpoints,
    leaseProcesses,
    leaseSessions,
    undefined, undefined, undefined, undefined,
    policy?.engine, policy?.enforcer,
    undefined, undefined,
    context,
  );
  const client = new Client({ name: "lease-fence-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
};
let leaseClients: Array<{ server: ReturnType<typeof createMcpServer>; client: Client }> = [];
try {
  const direct = await makeLeaseClient({ authenticatedRole: "client", mcpSessionId: "lease-direct" });
  leaseClients.push(direct);
  const opened = await direct.client.callTool({
    name: "open_workspace",
    arguments: { path: leaseWorkspaceRoot, mode: "checkout" },
  });
  const workspaceId = (opened.structuredContent as { workspaceId: string }).workspaceId;
  const canonicalLeaseWorkspaceRoot = leaseWorkspaces.getWorkspace(workspaceId).root;
  execFileSync("git", ["init", "-q", canonicalLeaseWorkspaceRoot]);
  const createdAt = new Date().toISOString();
  // The test registry owns a separate SQLite handle; mirror the workspace row
  // into the work-session fixture database, as the production composition
  // shares one DatabaseHandle between these stores.
  leaseDb.sqlite.prepare(
    "insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) " +
      "values (?, ?, 'active', 'checkout', 'false', ?, ?)",
  ).run(workspaceId, canonicalLeaseWorkspaceRoot, createdAt, createdAt);
  const workSession = leaseSessions.create({ workspaceSessionId: workspaceId, submittedBy: "lease-fence-test" });
  const acquired = leaseSessions.acquireWorkspaceLease({
    canonicalRoot: canonicalLeaseWorkspaceRoot,
    workspaceSessionId: workspaceId,
    workSessionId: workSession.id,
    ttlMs: 60_000,
  });
  assert.ok(acquired.acquired, "test delegated session acquires its checkout lease");

  const directWrite = await direct.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "direct.txt", content: "must remain blocked" },
  });
  assert.equal((directWrite.structuredContent as { status?: string }).status, "workspace_lease_conflict",
    "direct mutation is rejected while a delegated session owns the checkout");
  assert.equal(existsSync(join(canonicalLeaseWorkspaceRoot, "direct.txt")), false, "blocked direct mutation leaves the file unchanged");

  const worker = await makeLeaseClient({
    authenticatedRole: "worker",
    workSessionId: workSession.id,
    workspaceSessionId: workspaceId,
    workspaceLeaseNonce: acquired.lease.leaseNonce,
    mcpSessionId: "lease-worker-current",
  });
  leaseClients.push(worker);
  const workerReopen = await worker.client.callTool({
    name: "open_workspace",
    arguments: { path: canonicalLeaseWorkspaceRoot, mode: "checkout" },
  });
  assert.equal((workerReopen.structuredContent as { workspaceId?: string }).workspaceId, workspaceId,
    "worker can reopen only the workspace identified by its signed session");
  const workerWorktreeOpen = await worker.client.callTool({
    name: "open_workspace",
    arguments: { path: canonicalLeaseWorkspaceRoot, mode: "worktree" },
  });
  assert.equal(workerWorktreeOpen.isError, true, "worker cannot create a managed worktree");
  const workerOtherOpen = await worker.client.callTool({
    name: "open_workspace",
    arguments: { path: leaseOtherWorkspaceRoot, mode: "checkout" },
  });
  assert.equal(workerOtherOpen.isError, true, "worker cannot open an arbitrary second workspace");
  const otherOpened = await direct.client.callTool({
    name: "open_workspace",
    arguments: { path: leaseOtherWorkspaceRoot, mode: "checkout" },
  });
  const otherWorkspaceId = (otherOpened.structuredContent as { workspaceId?: string } | undefined)?.workspaceId;
  assert.ok(otherWorkspaceId, JSON.stringify(otherOpened));
  for (const name of ["git_status", "git_log", "git_diff", "git_show"]) {
    const crossWorkspace = await worker.client.callTool({ name, arguments: { workspaceId: otherWorkspaceId } });
    assert.equal(crossWorkspace.isError, true, `${name} rejects a workspace outside the signed worker binding`);
  }
  const workerWrite = await worker.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "worker.txt", content: "current owner" },
  });
  assert.notEqual(workerWrite.isError, true, "worker with the current session and nonce can mutate its checkout");
  assert.equal(existsSync(join(leaseWorkspaceRoot, "worker.txt")), true, "current lease owner mutation is applied");

  const staleWorker = await makeLeaseClient({
    authenticatedRole: "worker",
    workSessionId: workSession.id,
    workspaceSessionId: workspaceId,
    workspaceLeaseNonce: "stale-fencing-token",
    mcpSessionId: "lease-worker-stale",
  });
  leaseClients.push(staleWorker);
  const staleWrite = await staleWorker.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "stale.txt", content: "must remain blocked" },
  });
  assert.equal((staleWrite.structuredContent as { status?: string }).status, "workspace_lease_lost",
    "a worker with a stale nonce is rejected even when its work-session binding is valid");
  assert.equal(existsSync(join(leaseWorkspaceRoot, "stale.txt")), false, "stale worker mutation leaves the file unchanged");

  const nestedRoot = join(leaseWorkspaceRoot, "nested");
  mkdirSync(nestedRoot, { recursive: true });
  writeFileSync(join(nestedRoot, "AGENTS.md"), "Nested access instruction marker.\n");
  const deniedInvocations: any[] = [];
  const denyPolicyClient = await makeLeaseClient(
    { authenticatedRole: "client", mcpSessionId: "git-policy-deny" },
    {
      engine: {},
      enforcer: { enforce: async (invocation: any) => {
        deniedInvocations.push(invocation);
        return { allowed: false, decision: { mode: "deny" } };
      } },
    },
  );
  leaseClients.push(denyPolicyClient);
  for (const name of ["git_status", "git_log", "git_diff", "git_show"]) {
    const denied = await denyPolicyClient.client.callTool({
      name,
      arguments: { workspaceId, ...(name === "git_status" ? { path: "nested" } : {}) },
    });
    assert.equal(denied.isError, true, `${name} obeys the canonical read policy`);
  }
  assert.deepEqual(deniedInvocations.map((entry) => entry.tool), ["read", "read", "read", "read"],
    "all Git inspection tools are evaluated as canonical read operations");
  assert.equal(deniedInvocations[0].path.absolutePath, nestedRoot,
    "path-scoped Git policy receives the safely resolved workspace path");

  const submission = leaseSessions.submitForReview({
    workSessionId: workSession.id,
    snapshotKind: "git",
    snapshotRef: "test-snapshot",
    snapshotCommit: "test-snapshot",
    diff: "",
  });
  leaseSessions.submitFeedback({
    workSessionId: workSession.id,
    submissionId: submission.id,
    verdict: "changes_requested",
    comments: "Read the nested instructions before continuing.",
    allowedNextActions: ["read_files"],
  });
  const allowedInvocations: any[] = [];
  const readAllowedWorker = await makeLeaseClient(
    {
      authenticatedRole: "worker",
      workSessionId: workSession.id,
      workspaceSessionId: workspaceId,
      workspaceLeaseNonce: acquired.lease.leaseNonce,
      mcpSessionId: "lease-worker-read-allowed",
    },
    {
      engine: {},
      enforcer: { enforce: async (invocation: any) => {
        allowedInvocations.push(invocation);
        return { allowed: true, decision: { mode: "allow" } };
      } },
    },
  );
  leaseClients.push(readAllowedWorker);
  const nestedGit = await readAllowedWorker.client.callTool({
    name: "git_status",
    arguments: { workspaceId, path: "nested" },
  });
  assert.notEqual(nestedGit.isError, true, "changes-requested read_files permission allows Git inspection");
  assert.match(JSON.stringify(nestedGit.content), /Nested access instruction marker/,
    "path-scoped Git inspection returns newly applicable nested instructions");
  assert.equal(allowedInvocations[0].tool, "read", "Git inspection remains in the shared read policy class");
} finally {
  await Promise.all(leaseClients.map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
  await leaseCheckpoints.drain();
  leaseSessions.close();
  leaseDb.close();
  rmSync(leaseHarnessRoot, { recursive: true, force: true });
}

// Use a small isolated Git repository so git_diff exercises the tool's clean
// response contract without depending on the size or dirty state of this test
// runner's checkout.
const gitHarnessRoot = mkdtempSync(join(tmpdir(), "kontrol-git-tools-"));
const gitRoot = join(gitHarnessRoot, "repo");
mkdirSync(gitRoot, { recursive: true });
writeFileSync(join(gitRoot, "README.md"), "git inspection fixture\n");
const gitFixtureIdentity = {
  name: execFileSync("git", ["config", "user.name"], { cwd: process.cwd(), encoding: "utf8" }).trim(),
  email: execFileSync("git", ["config", "user.email"], { cwd: process.cwd(), encoding: "utf8" }).trim(),
};
execFileSync("git", ["init", "-q"], { cwd: gitRoot });
execFileSync("git", ["config", "user.name", gitFixtureIdentity.name], { cwd: gitRoot });
execFileSync("git", ["config", "user.email", gitFixtureIdentity.email], { cwd: gitRoot });
execFileSync("git", ["add", "README.md"], { cwd: gitRoot });
execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: gitRoot });
{
  await createMcpServerForGitFixture();
}

async function createMcpServerForGitFixture(): Promise<void> {
  const config = loadConfig({
    KONTROL_CONFIG_DIR: join(gitRoot, ".kontrol-test-config-git-tools"),
    KONTROL_ALLOWED_ROOTS: gitRoot,
    KONTROL_STATE_DIR: join(gitRoot, ".kontrol-test-state-git-tools"),
    KONTROL_WORKTREE_ROOT: join(gitRoot, ".kontrol-test-worktrees-git-tools"),
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_TUNNEL_REVIEWER_SECRET: "fixture-reviewer-secret",
    KONTROL_ACP_ENABLED: "false",
    KONTROL_POLICY_MODE: "ask",
    KONTROL_LOG_LEVEL: "error",
    KONTROL_WIDGETS: "off",
    KONTROL_TOOL_MODE: "full",
  });
  const workspaces = new WorkspaceRegistry(config);
  const checkpoints = createReviewCheckpointManager({ snapshotStoreRoot: join(gitRoot, ".kontrol-test-snapshots-git-tools") });
  const processes = new ProcessSessionManager({ childEnvironmentAllowlist: [] });
  const server = createMcpServer(config, workspaces, checkpoints, processes);
  const client = new Client({ name: "git-tools-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const opened = await client.callTool({ name: "open_workspace", arguments: { path: gitRoot, mode: "checkout" } });
    const workspaceId = (opened.structuredContent as { workspaceId: string }).workspaceId;
    for (const [name, args] of [
      ["git_status", {}], ["git_log", { limit: 5 }],
      ["git_diff", {}], ["git_show", { revision: "HEAD" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: { workspaceId, ...args } });
      assert.notEqual(result.isError, true, `${name} should not fail: ${JSON.stringify(result)}`);
      assert.notEqual((result.structuredContent as { status?: string }).status, "approval_required", `${name} must not prompt`);
    }
  } finally {
    await client.close();
    await server.close();
    await checkpoints.drain();
    rmSync(gitHarnessRoot, { recursive: true, force: true });
  }
}
