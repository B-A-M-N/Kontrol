import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp/workspace-server.js";
import { loadConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { WorkspaceRegistry } from "./workspaces.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-widget-metadata-"));
try {
  mkdirSync(join(root, "src"), { recursive: true });
  for (const mode of ["changes", "full"] as const) {
    const config = loadConfig({
      KONTROL_ALLOWED_ROOTS: root,
      KONTROL_WORKTREE_ROOT: join(root, `.worktrees-${mode}`),
      KONTROL_AGENT_DIR: join(root, `.agent-${mode}`),
      KONTROL_AUTH_MODE: "tunnel",
      KONTROL_ACP_ENABLED: "false",
      KONTROL_POLICY_MODE: "allow",
      KONTROL_LOG_LEVEL: "error",
      KONTROL_LOG_REQUESTS: "0",
      KONTROL_WIDGETS: mode,
      KONTROL_TOOL_MODE: "full",
      PORT: "1",
    });
    const workspaces = new WorkspaceRegistry(config);
    const checkpoints = createReviewCheckpointManager({ snapshotStoreRoot: join(root, `.snapshots-${mode}`) });
    const processSessions = new ProcessSessionManager({ childEnvironmentAllowlist: [] });
    const server = createMcpServer(config, workspaces, checkpoints, processSessions);
    const client = new Client({ name: `widget-metadata-${mode}`, version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
      const workspaceMeta = byName.get("open_workspace")?._meta as Record<string, any> | undefined;
      assert.equal(workspaceMeta?.ui?.resourceUri, `ui://kontrol/workspace-app-${(await import("./workspace-app-resource.js")).WORKSPACE_APP_BUILD_ID}.html`);
      assert.equal(workspaceMeta?.["openai/outputTemplate"], undefined, "new tool metadata must not advertise a legacy output template");
      const opened = await client.callTool({ name: "open_workspace", arguments: { path: root, mode: "checkout" } });
      assert.equal((opened.structuredContent as Record<string, unknown> | undefined)?.tool, "open_workspace", "open_workspace structured result must carry a validated discriminator");
      assert.equal(opened._meta?.tool, "open_workspace", "open_workspace must carry the host metadata discriminator");
      const showUi = byName.get("show_workspace_ui");
      assert.ok(showUi, `${mode} mode must expose the on-demand workspace UI tool`);
      const showUiMeta = showUi._meta as { ui?: { resourceUri?: string } } | undefined;
      assert.ok(showUiMeta?.ui?.resourceUri, "show_workspace_ui must advertise the standard Workspace App resource");
      assert.equal(Boolean(byName.get("read")?._meta?.ui), mode === "full", `read widget metadata must follow ${mode} mode`);
      assert.equal(Boolean(byName.get("grep")?._meta?.ui), mode === "full", `grep widget metadata must follow ${mode} mode`);
      assert.equal(Boolean(byName.get("ls")?._meta?.ui), mode === "full", `ls widget metadata must follow ${mode} mode`);
      assert.equal(byName.has("show_changes"), true, `${mode} mode must expose show_changes for explicit aggregate review`);
    } finally {
      await client.close();
      await server.close();
      await checkpoints.drain();
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("widget-metadata.test.ts: all assertions passed");
