import assert from "node:assert/strict";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cancelReconnect, connectWithRetry, setLifecycleHost } from "./ui/connection-lifecycle.js";

async function connectPair(connectApp = true) {
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
  if (connectApp) {
    await app.connect(appTransport);
    await initialized;
  }
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

// A real SDK App cannot reconnect after its underlying transport closes. The
// lifecycle must therefore replace the App, preserve its handlers, and let
// the new instance complete a fresh initialize handshake.
const failed = await connectPair();
let active = failed;
let connected = true;
let reconnects = 0;
let state = "CONNECTED";
let lastError: string | null = null;
let rehydrations = 0;
let renders = 0;
const receivedAfterRecovery: unknown[] = [];
const toolResultHandler = (value: unknown) => { receivedAfterRecovery.push(value); };
active.app.ontoolresult = toolResultHandler;
await active.appTransport.close();
await active.bridgeTransport.close();
connected = false;

setLifecycleHost({
  app: () => active.app,
  isConnected: () => connected,
  setApprovalRecoveryState: () => {},
  approvalRecoveryState: () => "healthy",
  queueSessionRehydration: () => { rehydrations += 1; },
  scheduleRender: () => { renders += 1; },
  selectWorkSession: () => {},
  replaceSurfaceChildren: () => {},
  maybeAppendAgentBar: () => {},
  renderEmpty: () => {},
  getErrorMessage: () => null,
  connectApp: async () => {
    await active.app.connect(active.appTransport);
    connected = true;
  },
  applyHostContext: () => {},
  getHostContext: () => undefined,
  setHostContext: () => {},
  recreateApp: async () => {
    active = await connectPair(false);
    active.app.ontoolresult = toolResultHandler;
    reconnects += 1;
  },
  connectionState: () => state,
  setConnectionState: (value: string) => { state = value; },
  getConnectionError: () => lastError,
  setConnectionError: (value: string | null) => { lastError = value; },
  setConnected: (value: boolean) => { connected = value; },
  bumpWorkspaceWatcherGeneration: () => {},
} as never);

await connectWithRetry(new Error("host transport closed"));
assert.equal(reconnects, 1, "closed SDK transport creates a replacement App instance");
assert.notEqual(active.app, failed.app, "recovery must not reuse the failed SDK App");
assert.equal(connected, true);
assert.equal(state, "CONNECTED");
assert.equal(rehydrations, 1, "a fresh SDK handshake queues durable rehydration");
assert.ok(renders > 0, "recovery publishes lifecycle state changes");
await active.bridge.sendToolResult({
  content: [{ type: "text", text: "post-reconnect result" }],
  structuredContent: { tool: "read", workspaceId: "workspace-after-reconnect" },
});
assert.equal(receivedAfterRecovery.length, 1, "replacement App re-registers the tool-result handler");
await active.appTransport.close();
await active.bridgeTransport.close();

// Teardown must cancel the single reconnect owner immediately rather than
// leaving a failed host transport asleep in exponential backoff.
let cancelledApp: object | null = {};
let cancelledConnectAttempts = 0;
let cancelledRecreateAttempts = 0;
setLifecycleHost({
  app: () => cancelledApp,
  isConnected: () => false,
  setApprovalRecoveryState: () => {},
  approvalRecoveryState: () => "healthy",
  queueSessionRehydration: () => {},
  scheduleRender: () => {},
  selectWorkSession: () => {},
  replaceSurfaceChildren: () => {},
  maybeAppendAgentBar: () => {},
  renderEmpty: () => {},
  getErrorMessage: () => null,
  connectApp: async () => {
    cancelledConnectAttempts += 1;
    throw new Error("simulated teardown race");
  },
  applyHostContext: () => {},
  getHostContext: () => undefined,
  setHostContext: () => {},
  recreateApp: async () => { cancelledRecreateAttempts += 1; },
  connectionState: () => "RECONNECTING",
  setConnectionState: () => {},
  getConnectionError: () => null,
  setConnectionError: () => {},
  setConnected: () => {},
  bumpWorkspaceWatcherGeneration: () => {},
} as never);
const cancelledRetry = connectWithRetry(new Error("simulated teardown race"));
await new Promise<void>((resolve) => setTimeout(resolve, 0));
cancelReconnect();
await assert.rejects(cancelledRetry, /connection is unavailable/);
assert.equal(cancelledConnectAttempts, 1, "teardown cancellation prevents a second reconnect attempt");
assert.equal(cancelledRecreateAttempts, 1, "the failed transport is replaced at most once before cancellation");
console.log("workspace-app-host-lifecycle.test.ts: all assertions passed");
