import assert from "node:assert/strict";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

async function connectPair() {
  const [appTransport, bridgeTransport] = InMemoryTransport.createLinkedPair();
  const bridge = new AppBridge(
    null,
    { name: "workspace-app-test-host", version: "1.0.0" },
    { serverTools: {}, serverResources: {}, logging: {} },
    { hostContext: { theme: "dark" } },
  );
  const app = new App(
    { name: "kontrol-tool-cards", version: "0.4.0" },
    {},
    { autoResize: false, strict: true },
  );
  const initialized = new Promise<void>((resolve) => {
    bridge.oninitialized = () => resolve();
  });
  const result = new Promise<unknown>((resolve) => {
    app.ontoolresult = (value) => resolve(value);
  });
  await bridge.connect(bridgeTransport);
  await app.connect(appTransport);
  await initialized;
  return { app, bridge, result, appTransport, bridgeTransport };
}

const first = await connectPair();
await first.bridge.sendToolResult({
  content: [{ type: "text", text: "host tool result" }],
  structuredContent: { tool: "open_workspace", workspaceId: "workspace-host" },
});
const firstResult = await first.result;
assert.equal((firstResult as { structuredContent?: { tool?: string } }).structuredContent?.tool, "open_workspace");
assert.equal(first.app.getHostVersion()?.name, "workspace-app-test-host", "App must retain the negotiated host identity");
assert.equal(first.app.getHostContext()?.theme, "dark", "App must retain the negotiated host context");
await first.appTransport.close();
await first.bridgeTransport.close();

const second = await connectPair();
await second.bridge.sendToolResult({
  content: [{ type: "text", text: "reconnected tool result" }],
  structuredContent: { tool: "show_workspace_ui", workspaceId: "workspace-reconnect" },
});
const secondResult = await second.result;
assert.equal((secondResult as { structuredContent?: { tool?: string } }).structuredContent?.tool, "show_workspace_ui");
assert.equal(second.app.getHostVersion()?.name, "workspace-app-test-host", "a fresh App instance must negotiate the host again");
await second.appTransport.close();
await second.bridgeTransport.close();
console.log("workspace-app-host-lifecycle.test.ts: all assertions passed");
