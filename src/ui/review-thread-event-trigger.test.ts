import assert from "node:assert/strict";
import { reduceWorkSessionEvent, setReducerHost } from "./workspace-event-reducer.js";

const toolCalls: string[] = [];
let resolveDelivered!: () => void;
const delivered = new Promise<void>((resolve) => { resolveDelivered = resolve; });
const app = {
  getHostCapabilities: () => ({ message: { text: {} } }),
  sendMessage: async () => { resolveDelivered(); return {}; },
} as any;

setReducerHost({
  getApp: () => app,
  refreshMission: async () => {},
  callServerToolChecked: async ({ name }) => {
    toolCalls.push(name);
    if (name === "claim_review_thread_deliveries") {
      return { content: [], structuredContent: { messages: [{
        threadId: "thread-1",
        handoffId: "handoff-1",
        handoffRevision: 1,
        payloadSha256: "a".repeat(64),
        packet: { submissionId: "submission-1" },
      }] } } as any;
    }
    return { content: [], structuredContent: { status: "presented" } } as any;
  },
  getActiveWorkspaceId: () => "workspace-1",
  messageMutationOutcomeUnknown: new Set(),
  render: () => {},
  setErrorMessage: (message) => { throw new Error(message ?? "unexpected reducer error"); },
});

// The reviewer-thread lifecycle event arrives before any work-session card
// exists for this session. The reducer must not discard the delivery trigger:
// it should still drain the durable review queue into the active WebUI
// conversation, so activation/reattach can begin delivery immediately.
reduceWorkSessionEvent("session-1", {
  seq: 1,
  id: "event-reattached",
  type: "review.thread.reattached",
  sessionId: "session-1",
  workspaceSessionId: "workspace-1",
  payload: { threadId: "thread-1" },
  createdAt: new Date().toISOString(),
});
await delivered;
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(toolCalls, ["claim_review_thread_deliveries", "acknowledge_review_thread_delivery"],
  "reattachment drains queued review messages even before a work-session card exists");
console.log("review-thread-event-trigger.test.ts: all assertions passed");