import { DEFAULT_CLAIM_LEASE_MS } from "../continuation.js";
import type { DispatchOutboxEvent, OutboxClaim } from "../dispatch-outbox.js";
import { lookupPeerDispatch } from "../acp-gateway.js";
import type { BridgeConfig } from "./context.js";

export interface ReplyDispatcher {
  start(): void;
  stop(): void;
  drainOnce(): Promise<void>;
}

const REPLY_DISPATCHER_ID = "kontrol-reply-dispatcher";
const replyDispatchKey = (replyId: string, revision: number, runId: string, workerAttempt: number) =>
  `reply_${replyId}_rev_${revision}_run_${runId}_attempt_${workerAttempt}`;

const claimOf = (event: DispatchOutboxEvent): OutboxClaim => ({ eventId: event.id, claimOwner: event.claimedBy ?? "", claimToken: event.claimToken ?? "" });

/** Resolve the worker that currently owns the logical run after any transfer.
 * A run's agentName is its immutable origin identity and cannot route replies. */
export function resolveReplyDispatchTarget(config: BridgeConfig, runId: string, workSessionId: string) {
  const run = config.agentRegistry.getRun(runId);
  if (!run || run.workSessionId !== workSessionId) return undefined;
  const attempt = config.agentRegistry.getLatestDispatchAttemptForRun(runId);
  if (!attempt || attempt.runId !== runId || !attempt.agentId) return undefined;
  return config.agentRegistry.listAlive().find((agent) => agent.id === attempt.agentId);
}

export function createReplyDispatcher(config: BridgeConfig): ReplyDispatcher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let started = false;
  let running: Promise<void> | undefined;
  let unsub: (() => void) | undefined;

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
    if (reply.status === "delivering") {
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
    if (!wait || wait.workSessionId !== reply.workSessionId || !run || run.workSessionId !== reply.workSessionId) {
      config.dispatchOutbox?.markCompleted(claimOf(event));
      return "completed";
    }
    const agentForRun = resolveReplyDispatchTarget(config, run.runId, reply.workSessionId);
    const supportsNativeReply = agentForRun?.capabilities.includes("native-reply-resume") === true;
    if (wait?.resumeOnReply === true && supportsNativeReply) {
      const dispatchKey = replyDispatchKey(reply.id, reply.replyRevision, run.runId, wait.workerAttempt);
      const priorAttempt = config.agentRegistry.getDispatchAttemptByIdempotencyKey(dispatchKey);
      if (priorAttempt) {
        if (priorAttempt.runId !== run.runId || priorAttempt.agentId !== agentForRun.id) {
          agentMessages.setReplyDelivery({ replyId: reply.id, expectedStatus: reply.status, nextStatus: "blocked" });
          config.dispatchOutbox?.markCompleted(claimOf(event));
          return "completed";
        }
        if (priorAttempt.status === "accepted" && priorAttempt.remoteRunId) {
          agentMessages.setReplyDelivery({ replyId: reply.id, expectedStatus: reply.status, nextStatus: "delivering" });
          config.dispatchOutbox?.markCompleted(claimOf(event));
          return "completed";
        }
        if (priorAttempt.status !== "uncertain" && priorAttempt.status !== "dispatching") {
          agentMessages.setReplyDelivery({ replyId: reply.id, expectedStatus: reply.status, nextStatus: "blocked" });
          config.dispatchOutbox?.markCompleted(claimOf(event));
          return "completed";
        }
        let lookup;
        try {
          lookup = await lookupPeerDispatch({
            agentUrl: agentForRun.url,
            adapterSecret: config.adapterSecret,
            dispatchIdempotencyKey: dispatchKey,
          });
        } catch {
          return "deferred";
        }
        if (lookup.status === "found" && lookup.remoteRunId) {
          config.agentRegistry.updateDispatchAttempt(dispatchKey, { status: "accepted", remoteRunId: lookup.remoteRunId });
          config.agentRegistry.updateRun(run.runId, { status: "running", remoteRunId: lookup.remoteRunId, attemptNumber: priorAttempt.attemptNumber });
          agentMessages.setReplyDelivery({ replyId: reply.id, expectedStatus: reply.status, nextStatus: "delivering" });
          config.dispatchOutbox?.markCompleted(claimOf(event));
          return "completed";
        }
        // Only an explicit adapter receipt proving the launch gate never
        // opened permits a retry. `unknown` includes unsupported or ambiguous
        // lookups and therefore stays fenced.
        if (lookup.status !== "unstarted") return "deferred";
      }
      // A deterministic reply identity plus the adapter's exact dispatch key
      // makes a retry reuse the same ACP attempt after an authoritative
      // `unstarted` receipt.
      const result = await defaultResumeReply(config, reply, wait, dispatchKey);
      if (result === "deferred" || result === "failed") return result;
      agentMessages.setReplyDelivery({
        replyId: reply.id,
        expectedStatus: reply.status as "pending_delivery" | "delivering",
        nextStatus: "delivering",
      });
      config.dispatchOutbox?.markCompleted(claimOf(event));
      return "completed";
    }
    if (wait?.resumeOnReply !== true) {
      // MCP-capable live waiter is responsible for its own consumption. Keep
      // the durable reply record pending for reconnect; do not keep a dispatch
      // event cycling while the worker waits or is offline.
      config.dispatchOutbox?.markCompleted(claimOf(event));
      return "completed";
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
    const outbox = config.dispatchOutbox;
    if (!outbox || stopped) return;
    if (running) return running;
    running = (async () => {
      outbox.reapExpiredClaims(DEFAULT_CLAIM_LEASE_MS);
      for (;;) {
        if (stopped) break;
        const event = outbox.claimNext(REPLY_DISPATCHER_ID, DEFAULT_CLAIM_LEASE_MS, ["agent.reply.ready"]);
        if (!event) break;
        const claim = claimOf(event);
        try {
          const result = await dispatchReply(event);
          if (result === "completed") outbox.markCompleted(claim);
        } catch (error) {
          outbox.markFailed(claim, error instanceof Error ? error.message : String(error), DEFAULT_CLAIM_LEASE_MS);
        }
      }
    })().finally(() => {
      running = undefined;
      scheduleNextEligible();
    });
    return running;
  }

  function scheduleNextEligible(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    const outbox = config.dispatchOutbox;
    if (!outbox || stopped || !started) return;
    const next = outbox.listPending(1, ["agent.reply.ready"])[0];
    if (!next) return;
    timer = setTimeout(() => {
      timer = null;
      void drainOnce();
    }, Math.max(0, Date.parse(next.availableAt) - Date.now()));
  }

  async function defaultResumeReply(config: BridgeConfig, reply: NonNullable<ReturnType<NonNullable<typeof config.agentMessages>["getReply"]>>, wait: NonNullable<ReturnType<NonNullable<typeof config.agentMessages>["getActiveWaitForMessage"]>>, dispatchIdempotencyKey: string): Promise<"completed" | "deferred" | "failed"> {
    const run = wait.runId ? config.agentRegistry.getRun(wait.runId) : undefined;
    const agent = run ? resolveReplyDispatchTarget(config, run.runId, reply.workSessionId) : undefined;
    if (!run || !agent) return "failed";
    const result = await import("../acp-gateway.js").then(({ callRemoteAgent }) => callRemoteAgent(
      { agentRegistry: config.agentRegistry, workspaces: config.workspaces, workSessions: config.workSessions, eventStore: config.eventStore, adapterSecret: config.adapterSecret },
      {
        agentUrl: agent.url,
        agentName: agent.name,
        agentId: agent.id,
        task: `Reviewer reply ${reply.id}: ${reply.body}`,
        workspaceSessionId: config.workSessions.get(reply.workSessionId)?.workspaceSessionId,
        workSessionId: reply.workSessionId,
        existingRunId: run.runId,
        dispatchIdempotencyKey,
        mode: "async",
        fireAndForget: true,
      },
    ));
    if (result.status === "uncertain" || result.status === "dispatch_uncertain") return "deferred";
    return result.status === "running" ? "completed" : "failed";
  }

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      const outbox = config.dispatchOutbox;
      if (!outbox) return;
      unsub = outbox.subscribe(() => { void drainOnce(); }, ["agent.reply.ready"]);
      // A fresh process reconstructs work from the durable outbox before
      // depending on notifications for newly committed replies.
      void drainOnce();
    },
    stop() {
      stopped = true;
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
      unsub?.();
      unsub = undefined;
    },
    drainOnce,
  };
}
