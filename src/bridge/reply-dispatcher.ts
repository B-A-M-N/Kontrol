import { DEFAULT_CLAIM_LEASE_MS } from "../continuation.js";
import type { DispatchOutboxEvent, OutboxClaim } from "../dispatch-outbox.js";
import type { BridgeConfig } from "./context.js";

export interface ReplyDispatcher {
  start(): void;
  stop(): void;
  drainOnce(): Promise<void>;
}

const REPLY_DISPATCHER_ID = "kontrol-reply-dispatcher";

const claimOf = (event: DispatchOutboxEvent): OutboxClaim => ({ eventId: event.id, claimOwner: event.claimedBy ?? "", claimToken: event.claimToken ?? "" });

export function createReplyDispatcher(config: BridgeConfig): ReplyDispatcher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let unsub: (() => void) | null = null;

  async function dispatchReply(event: DispatchOutboxEvent): Promise<"completed" | "deferred" | "failed"> {
    const agentMessages = config.agentMessages;
    if (!agentMessages) return "failed";
    const replyId = typeof event.payload.replyId === "string" ? event.payload.replyId : event.aggregateId;
    const reply = agentMessages.getReply(replyId);
    if (!reply) {
      config.dispatchOutbox?.markCompleted(claimOf(event));
      return "completed";
    }
    if (reply.status === "acknowledged") {
      config.dispatchOutbox?.markCompleted(claimOf(event));
      return "completed";
    }
    const session = config.workSessions.get(reply.workSessionId);
    if (!session || ["approved", "rejected", "cancelled", "failed", "failed_protocol"].includes(session.status)) {
      agentMessages.setReplyDelivery({
        replyId: reply.id,
        expectedStatus: reply.status as "pending_delivery" | "delivering",
        nextStatus: "blocked",
      });
      config.eventStore.appendEvent({
        type: "agent.message.reply_blocked",
        sessionId: reply.workSessionId,
        payload: { replyId: reply.id, reason: session ? `session is ${session.status}` : "session not found" },
      });
      config.dispatchOutbox?.markCompleted(claimOf(event));
      return "completed";
    }
    const wait = agentMessages.getActiveWaitForMessage(reply.messageId);
    const run = wait?.runId ? config.agentRegistry.getRun(wait.runId) : undefined;
    const agentForRun = run?.agentName ? config.agentRegistry.listAlive().find((candidate) => candidate.name === run.agentName) : undefined;
    const supportsNativeReply = agentForRun?.capabilities.includes("native-reply-resume") === true;
    if (wait?.resumeOnReply === true && supportsNativeReply) {
      // Structured native resume: reuse the original logical run and adapter
      // contract. The adapter is expected to expose needs_input/answer turn
      // semantics and authenticated acknowledgement.
      const result = await defaultResumeReply(config, reply, wait);
      if (result === "deferred" || result === "failed") return result;
      agentMessages.setReplyDelivery({
        replyId: reply.id,
        expectedStatus: reply.status as "pending_delivery" | "delivering",
        nextStatus: "delivering",
      });
      config.dispatchOutbox?.release(claimOf(event), DEFAULT_CLAIM_LEASE_MS, "native reply resume dispatched");
      return "deferred";
    }
    if (wait?.resumeOnReply !== true) {
      // MCP-capable live waiter is responsible for its own consumption. Keep
      // the delivery pending and return it on reconnect; do not spawn a worker
      // merely because a question exists.
      config.dispatchOutbox?.release(claimOf(event), DEFAULT_CLAIM_LEASE_MS, "waiting for authorized MCP worker");
      return "deferred";
    }
    // Native ACP resume path intentionally fails closed in this first phase.
    // It requires adapter support for structured needs_input and authenticated
    // acknowledgement; blindly reusing callRemoteAgent would create duplicate
    // logical attempts. Operator-visible blocked status prevents unbounded retry.
    agentMessages.setReplyDelivery({
      replyId: reply.id,
      expectedStatus: reply.status as "pending_delivery" | "delivering",
      nextStatus: "blocked",
    });
    config.eventStore.appendEvent({
      type: "agent.message.reply_blocked",
      sessionId: reply.workSessionId,
      payload: { replyId: reply.id, reason: "native ACP reply resume support not qualified" },
    });
    config.dispatchOutbox?.markCompleted(claimOf(event));
    return "completed";
  }

  async function drainOnce(): Promise<void> {
    if (!config.dispatchOutbox || stopped) return;
    config.dispatchOutbox.reapExpiredClaims(DEFAULT_CLAIM_LEASE_MS);
    for (;;) {
      const event = config.dispatchOutbox.claimNext(REPLY_DISPATCHER_ID, DEFAULT_CLAIM_LEASE_MS, ["agent.reply.ready"]);
      if (!event) break;
      const claim = claimOf(event);
      if (event.eventType !== "agent.reply.ready") {
        config.dispatchOutbox.markFailed(claim, `Reply routing violation: ${event.eventType}`, DEFAULT_CLAIM_LEASE_MS);
        continue;
      }
      try {
        const result = await dispatchReply(event);
        if (result === "completed") config.dispatchOutbox.markCompleted(claim);
      } catch (error) {
        config.dispatchOutbox.markFailed(claim, error instanceof Error ? error.message : String(error), DEFAULT_CLAIM_LEASE_MS);
      }
    }
  }

  function scheduleNext(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void drainOnce().then(() => {
        if (!stopped) scheduleNext();
      });
    }, DEFAULT_CLAIM_LEASE_MS);
  }

  async function defaultResumeReply(config: BridgeConfig, reply: NonNullable<ReturnType<NonNullable<typeof config.agentMessages>["getReply"]>>, wait: NonNullable<ReturnType<NonNullable<typeof config.agentMessages>["getActiveWaitForMessage"]>>): Promise<"completed" | "deferred" | "failed"> {
    const run = wait.runId ? config.agentRegistry.getRun(wait.runId) : undefined;
    const agent = config.agentRegistry.listAlive().find((candidate) => candidate.name === run?.agentName);
    if (!run || !agent) return "failed";
    const result = await import("../acp-gateway.js").then(({ callRemoteAgent }) => callRemoteAgent(
      { agentRegistry: config.agentRegistry, workspaces: config.workspaces, workSessions: config.workSessions, adapterSecret: config.adapterSecret },
      {
        agentUrl: agent.url,
        agentName: agent.name,
        agentId: agent.id,
        task: `Reviewer reply ${reply.id}: ${reply.body}`,
        workspaceSessionId: config.workSessions.get(reply.workSessionId)?.workspaceSessionId,
        workSessionId: reply.workSessionId,
        existingRunId: run.runId,
        mode: "async",
        fireAndForget: true,
      },
    ));
    return result.status === "failed" ? "failed" : "completed";
  }

  return {
    start() {
      stopped = false;
      void drainOnce();
      unsub = config.eventStore.subscribeAll((event) => {
        if (event.type === "agent.message.reply_accepted") void drainOnce();
      });
      scheduleNext();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      unsub?.();
      unsub = null;
    },
    drainOnce,
  };
}
