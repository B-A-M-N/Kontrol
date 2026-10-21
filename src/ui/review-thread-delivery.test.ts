import assert from "node:assert/strict";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { deliverPendingReviewMessages } from "./review-thread-delivery.js";
import { createMcpAppsReviewHostAdapter } from "../review-thread/host-adapter.js";

const [appTransport, bridgeTransport] = InMemoryTransport.createLinkedPair();
const bridge = new AppBridge(
  null,
  { name: "review-delivery-test-host", version: "1.0.0" },
  { message: { text: {} } },
  { hostContext: {} },
);
const app = new App({ name: "kontrol-review-app", version: "1.0.0" }, {}, { autoResize: false, strict: true });
let hostRejectsMessage = false;
const messageReceived = new Promise<{ role: string; content: Array<{ type: string; text?: string }> }>((resolve) => {
  bridge.onmessage = async (message) => { resolve(message); return hostRejectsMessage ? { isError: true } : {}; };
});
const initialized = new Promise<void>((resolve) => { bridge.oninitialized = () => resolve(); });
await bridge.connect(bridgeTransport);
await app.connect(appTransport);
await initialized;

const packet = { workSessionId: "work-1", submission: { submissionId: "submission-1" } };
let queued: Array<Record<string, unknown>> = [{
  threadId: "thread-1",
  handoffId: "handoff-1",
  handoffRevision: 1,
  payloadSha256: "a".repeat(64),
  packet,
}];
const calls: string[] = [];
const ackOutcomes: string[] = [];
const callTool = async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }): Promise<CallToolResult> => {
  calls.push(name);
  if (name === "claim_review_thread_deliveries") {
    const messages = queued;
    queued = [];
    return { content: [], structuredContent: { messages } };
  }
  if (name === "acknowledge_review_thread_delivery") ackOutcomes.push(String(args.outcome));
  return { content: [], structuredContent: { status: "presented" } };
};
const adapter = createMcpAppsReviewHostAdapter(app);
assert.deepEqual(adapter.capabilities(), { createThread: false, sendMessage: true, observeAcknowledgement: false });

assert.deepEqual(await deliverPendingReviewMessages({ adapter, callTool, onUncertain: (message) => { throw new Error(message); } }), { status: "accepted", handoffIds: ["handoff-1"] });
const deliveredMessage = await messageReceived;
assert.equal(deliveredMessage.role, "user");
assert.ok(deliveredMessage.content[0]?.text?.includes('"submissionId":"submission-1"'), "the exact immutable packet enters the active host conversation");
assert.ok(deliveredMessage.content[0]?.text?.includes("submit_handoff_feedback"), "the host is instructed to return its decision through Kontrol");
assert.equal(calls.filter((name) => name === "acknowledge_review_thread_delivery").length, 1, "host acceptance is acknowledged separately");

// Repeated event callbacks consult the durable queue; the accepted message is
// no longer eligible and cannot produce another host turn.
await deliverPendingReviewMessages({ adapter, callTool, onUncertain: (message) => { throw new Error(message); } });
assert.equal(calls.filter((name) => name === "acknowledge_review_thread_delivery").length, 1);

hostRejectsMessage = true;
queued = [{ threadId: "thread-1", handoffId: "handoff-rejected", handoffRevision: 1, payloadSha256: "b".repeat(64), packet }];
assert.deepEqual(await deliverPendingReviewMessages({ adapter, callTool, onUncertain: () => {} }), { status: "rejected", handoffId: "handoff-rejected" },
  "host rejection is surfaced distinctly from an empty queue");
assert.deepEqual(ackOutcomes, ["accepted", "rejected"], "a rejected host request is durably recorded as failed delivery");

const queueFailure = await deliverPendingReviewMessages({
  adapter,
  callTool: async () => { throw new Error("server unavailable"); },
  onUncertain: () => {},
});
assert.deepEqual(queueFailure, { status: "tool_error", reason: "server unavailable" },
  "claim failures are distinct from a successfully inspected empty queue");

await appTransport.close();
await bridgeTransport.close();

// Hosts without the message capability leave delivery to explicit activation.
const [unsupportedAppTransport, unsupportedBridgeTransport] = InMemoryTransport.createLinkedPair();
const unsupportedBridge = new AppBridge(null, { name: "unsupported-host", version: "1.0.0" }, {}, { hostContext: {} });
const unsupportedApp = new App({ name: "kontrol-review-app", version: "1.0.0" }, {}, { autoResize: false, strict: true });
const unsupportedInitialized = new Promise<void>((resolve) => { unsupportedBridge.oninitialized = () => resolve(); });
await unsupportedBridge.connect(unsupportedBridgeTransport);
await unsupportedApp.connect(unsupportedAppTransport);
await unsupportedInitialized;
let unsupportedCalls = 0;
const unsupportedAdapter = createMcpAppsReviewHostAdapter(unsupportedApp);
assert.deepEqual(unsupportedAdapter.capabilities(), { createThread: false, sendMessage: false, observeAcknowledgement: false });
assert.deepEqual(await deliverPendingReviewMessages({ adapter: unsupportedAdapter, callTool: async () => { unsupportedCalls += 1; return { content: [] }; }, onUncertain: () => {} }), { status: "unsupported" });
assert.equal(unsupportedCalls, 0, "unsupported hosts do not claim or consume queued review messages");
const legacyHostAdapter = createMcpAppsReviewHostAdapter({} as App);
assert.equal(legacyHostAdapter.capabilities().sendMessage, false, "hosts without capability negotiation leave review delivery queued");
await unsupportedAppTransport.close();
await unsupportedBridgeTransport.close();

console.log("review-thread-delivery.test.ts: all assertions passed");
