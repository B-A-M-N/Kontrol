import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config.js";
import { createMcpServer } from "./workspace-server.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-mcp-shared-schema-root-"));
const stateDir = await mkdtemp(join(tmpdir(), "kontrol-mcp-shared-schema-state-"));
const configDir = await mkdtemp(join(tmpdir(), "kontrol-mcp-shared-schema-config-"));
const worktreeRoot = await mkdtemp(join(tmpdir(), "kontrol-mcp-shared-schema-worktrees-"));
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

function makeServer(authenticatedRole: "client" | "reviewer") {
  const args: Parameters<typeof createMcpServer> = [config, {} as never, {} as never, {} as never];
  args[13] = { authenticatedRole, authSource: "anonymous", conversationId: `schema-${authenticatedRole}` };
  return createMcpServer(...args);
}

function registeredTools(server: ReturnType<typeof createMcpServer>) {
  return (server as unknown as {
    _registeredTools: Record<string, {
      inputSchema?: unknown;
      outputSchema?: unknown;
      handler: unknown;
      enabled: boolean;
      disable(): void;
    }>;
  })._registeredTools;
}

const clientServer = makeServer("client");
const reviewerServer = makeServer("reviewer");
try {
  const clientTools = registeredTools(clientServer);
  const reviewerTools = registeredTools(reviewerServer);
  assert.deepEqual(Object.keys(reviewerTools).sort(), Object.keys(clientTools).sort(), "authorization role does not change the registered tool surface");
  for (const name of Object.keys(clientTools)) {
    assert.strictEqual(reviewerTools[name]?.inputSchema, clientTools[name]?.inputSchema, `${name} input schema is shared as immutable registration data`);
    assert.strictEqual(reviewerTools[name]?.outputSchema, clientTools[name]?.outputSchema, `${name} output schema is shared as immutable registration data`);
    assert.notStrictEqual(reviewerTools[name]?.handler, clientTools[name]?.handler, `${name} retains a separate per-session handler and context`);
  }
  const readSchema = clientTools.read?.inputSchema as { safeParse(input: unknown): { success: boolean } } | undefined;
  assert.ok(readSchema, "read keeps a runtime input validator");
  assert.equal(readSchema.safeParse({ workspaceId: "ws_test", path: "file.txt" }).success, true, "shared schema accepts valid tool arguments");
  assert.equal(readSchema.safeParse({ path: "file.txt" }).success, false, "shared schema keeps required argument validation");

  clientTools.read?.disable();
  assert.equal(clientTools.read?.enabled, false, "tool registration controls remain owned by the first server");
  assert.equal(reviewerTools.read?.enabled, true, "changing one server registration does not affect another session");
} finally {
  await clientServer.close();
  await reviewerServer.close();
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  await rm(worktreeRoot, { recursive: true, force: true });
}

console.log("mcp/shared-tool-schemas: all assertions passed");
