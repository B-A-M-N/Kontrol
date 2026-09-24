import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { loadConfig } from "./config.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { WorkspaceRegistry } from "./workspaces.js";

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
  /missing required inspection tool\(s\): grep, glob, ls/,
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
    const server = createMcpServer(config, workspaces, checkpoints, processSessions);
    const client = new Client({ name: `mcp-tool-surface-${mode}`, version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      assert.equal(client.getServerVersion()?.version, readMcpServerVersion(),
        `${mode} MCP initialize must advertise the runtime tool-surface version`);
      const listed = await client.listTools();
      const names = new Set(listed.tools.map((tool) => tool.name));
      for (const name of ["read", "grep", "glob", "ls"]) {
        assert.ok(names.has(name), `${mode} must expose required inspection tool ${name}`);
      }
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
      assert.deepEqual(openedSurface?.toolSurface?.requiredInspectionTools, ["read", "grep", "glob", "ls"],
        `${mode} open_workspace must return the required inspection surface`);
      assert.equal(typeof openedSurface?.toolSurface?.version, "string",
        `${mode} open_workspace must return the MCP surface version`);
      assert.match(openedSurface?.instruction ?? "", /client catalog is stale.*fresh MCP tool surface/i,
        `${mode} open_workspace must explain stale catalog recovery`);
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
