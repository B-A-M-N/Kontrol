import assert from "node:assert/strict";
import { connectBootstrapWithRetry, setLifecycleHost, type LifecycleHost } from "./connection-lifecycle.js";

function makeHost(connectApp: () => Promise<void>) {
  let connected = false;
  let state = "DISCONNECTED";
  let connectionError: string | null = null;
  let recreateCount = 0;
  let renderCount = 0;
  let rehydrationCount = 0;
  let app = {};
  const host = {
    getActiveWorkspaceId: () => null,
    setApprovalRecoveryState: () => undefined,
    approvalRecoveryState: () => "healthy",
    queueSessionRehydration: () => { rehydrationCount += 1; },
    scheduleRender: () => { renderCount += 1; },
    selectWorkSession: () => undefined,
    replaceSurfaceChildren: () => undefined,
    maybeAppendAgentBar: () => undefined,
    renderEmpty: () => undefined,
    getErrorMessage: () => null,
    connectApp,
    applyHostContext: () => undefined,
    getHostContext: () => null,
    setHostContext: () => undefined,
    recreateApp: async () => { recreateCount += 1; app = {}; },
    isConnected: () => connected,
    connectionState: () => state,
    setConnectionState: (value: string) => { state = value; },
    getConnectionError: () => connectionError,
    setConnectionError: (value: string | null) => { connectionError = value; },
    setConnected: (value: boolean) => { connected = value; },
    bumpWorkspaceWatcherGeneration: () => undefined,
    app: () => app,
  } satisfies LifecycleHost;
  return {
    host,
    get connected() { return connected; },
    get state() { return state; },
    get connectionError() { return connectionError; },
    get recreateCount() { return recreateCount; },
    get renderCount() { return renderCount; },
    get rehydrationCount() { return rehydrationCount; },
  };
}

let attempts = 0;
const succeedsOnRetry = makeHost(async () => {
  attempts += 1;
  if (attempts === 1) throw new Error("temporary bootstrap failure");
});
setLifecycleHost(succeedsOnRetry.host);
await connectBootstrapWithRetry();
assert.equal(attempts, 2, "bootstrap gets one retry after its first failed connect");
assert.equal(succeedsOnRetry.recreateCount, 1, "the failed SDK App is recreated before retry");
assert.equal(succeedsOnRetry.connected, true);
assert.equal(succeedsOnRetry.state, "CONNECTED");
assert.equal(succeedsOnRetry.connectionError, null);
assert.equal(succeedsOnRetry.rehydrationCount, 1);

let failingAttempts = 0;
const remainsFailed = makeHost(async () => {
  failingAttempts += 1;
  throw new Error(`bootstrap failed ${failingAttempts}`);
});
setLifecycleHost(remainsFailed.host);
await assert.rejects(connectBootstrapWithRetry(), /bootstrap failed 2/);
assert.equal(failingAttempts, 2, "bootstrap stops after one retry");
assert.equal(remainsFailed.recreateCount, 1);
assert.equal(remainsFailed.connected, false);
assert.equal(remainsFailed.state, "DISCONNECTED");
assert.equal(remainsFailed.connectionError, "bootstrap failed 2");

console.log("connection-lifecycle.bootstrap.test.ts: bounded bootstrap retry assertions passed");
