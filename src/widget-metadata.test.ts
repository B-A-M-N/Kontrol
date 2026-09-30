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
      KONTROL_TUNNEL_REVIEWER_SECRET: `reviewer-${"x".repeat(48)}`,
      KONTROL_ACP_ENABLED: "false",
      KONTROL_POLICY_MODE: mode === "full" ? "ask" : "allow",
      KONTROL_LOG_LEVEL: "error",
      KONTROL_LOG_REQUESTS: "0",
      KONTROL_WIDGETS: mode,
      KONTROL_TOOL_MODE: "full",
      PORT: "1",
    });
    const workspaces = new WorkspaceRegistry(config);
    const checkpoints = createReviewCheckpointManager({ snapshotStoreRoot: join(root, `.snapshots-${mode}`) });
    const processSessions = new ProcessSessionManager({ childEnvironmentAllowlist: [] });
    const server = createMcpServer(
      config,
      workspaces,
      checkpoints,
      processSessions,
      undefined,
      undefined,
      {} as never,
      undefined,
      undefined,
      {} as never,
    );
    const client = new Client({ name: `widget-metadata-${mode}`, version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
      const workspaceMeta = byName.get("open_workspace")?._meta as Record<string, any> | undefined;
      assert.equal(workspaceMeta?.ui, undefined, "open_workspace returns structured workspace data and must not select the app renderer");
      assert.equal(workspaceMeta?.["openai/outputTemplate"], undefined, "new tool metadata must not advertise a legacy output template");
      const opened = await client.callTool({ name: "open_workspace", arguments: { path: root, mode: "checkout" } });
      assert.equal((opened.structuredContent as Record<string, unknown> | undefined)?.tool, "open_workspace", "open_workspace structured result must carry a validated discriminator");
      assert.equal(opened._meta?.tool, "open_workspace", "open_workspace must carry the host metadata discriminator");
      const showUi = byName.get("show_workspace_ui");
      assert.ok(showUi, `${mode} mode must expose the on-demand workspace UI tool`);
      const showUiMeta = showUi._meta as { ui?: { resourceUri?: string } } | undefined;
      assert.ok(showUiMeta?.ui?.resourceUri, "show_workspace_ui must advertise the standard Workspace App resource");
      for (const name of ["read", "grep", "ls"]) {
        const ui = byName.get(name)?._meta?.ui as { resourceUri?: string; visibility?: string[] } | undefined;
        assert.equal(Boolean(ui), mode === "full", `${name} app-callable metadata must follow ${mode} mode`);
        assert.equal(ui?.resourceUri, undefined, `${name} must not advertise the Workspace App as its result renderer`);
        if (mode === "full") assert.deepEqual(ui?.visibility, ["app"], `${name} must be callable from the app`);
      }
      const showChangesUi = byName.get("show_changes")?._meta?.ui as { resourceUri?: string } | undefined;
      assert.ok(showChangesUi?.resourceUri, "show_changes is a deliberate render entry point");
      assert.equal(byName.has("show_changes"), true, `${mode} mode must expose show_changes for explicit aggregate review`);
      if (mode === "full") {
        const approvalCenterUi = byName.get("open_approval_center")?._meta?.ui as { resourceUri?: string; visibility?: string[] } | undefined;
        assert.ok(approvalCenterUi?.resourceUri, "open_approval_center is a deliberate render entry point");
        const pendingApprovalsUi = byName.get("list_pending_approvals")?._meta?.ui as { resourceUri?: string; visibility?: string[] } | undefined;
        assert.deepEqual(pendingApprovalsUi?.visibility, ["app"], "pending approval data remains callable from the app");
        assert.equal(pendingApprovalsUi?.resourceUri, undefined, "approval data must not select the app renderer");
      }
      const workspaceAppResource = (await import("./workspace-app-resource.js")).workspaceAppResourceMeta();
      assert.deepEqual(workspaceAppResource.ui.permissions, { clipboardWrite: {} }, "Workspace App must request optional clipboard-write permission under _meta.ui without assuming it is granted");
      assert.equal("permissions" in workspaceAppResource, false, "resource metadata must not expose permissions at the root");
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
