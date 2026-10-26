import { DEFAULT_CLAIM_LEASE_MS } from "../continuation.js";
import type { DispatchOutboxEvent, OutboxClaim } from "../dispatch-outbox.js";
import { lookupPeerDispatch } from "../acp-gateway.js";
import type { BridgeConfig } from "./context.js";
import { acquireCheckoutModifyLease, checkoutLeaseMetadata } from "./shared.js";

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
  if (!attempt || attempt.runId !== runId || !attempt.agentId || attempt.status !== "accepted") return undefined;
  const sessionEvents = config.eventStore.getEventsForSession(workSessionId);
  const handoff = sessionEvents.filter((event) => event.type === "session.handoff"
    && (event.payload as Record<string, unknown>).runId === runId).at(-1);
  if (handoff) {
    const payload = handoff.payload as Record<string, unknown>;
    const transferId = payload.transferId;
    if (typeof transferId !== "string") return undefined;
    const currentState = sessionEvents.filter((event) => event.type === "session.handoff.state"
      && (event.payload as Record<string, unknown>).transferId === transferId).at(-1)?.payload as Record<string, unknown> | undefined;
    if (currentState?.state !== "committed") return undefined;
  }
  const agent = config.agentRegistry.listAlive().find((candidate) => candidate.id === attempt.agentId);
  if (!agent) return undefined;
  if (handoff) {
    const toAgent = (handoff.payload as Record<string, unknown>).toAgent;
    if (typeof toAgent !== "string" || agent.name !== toAgent) return undefined;
  }
  return agent;
}

export function createReplyDispatcher(config: BridgeConfig): ReplyDispatcher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let started = false;
  let running: Promise<void> | undefined;
  let unsub: (() => void) | undefined;

  function publishReplyDeliveryState(reply: NonNullable<ReturnType<NonNullable<typeof config.agentMessages>["getReply"]>>): void {
    const replyAttempt = reply.deliveryDispatchIdempotencyKey
      ? config.agentRegistry.getDispatchAttemptByIdempotencyKey(reply.deliveryDispatchIdempotencyKey)
      : undefined;
    const attempt = replyAttempt?.agentId
      ? replyAttempt
      : reply.deliveryRunId
        ? config.agentRegistry.getLatestDispatchAttemptForRun(reply.deliveryRunId)
        : undefined;
    const destination = attempt?.agentId
      ? config.agentRegistry.listAlive().find((agent) => agent.id === attempt.agentId)
      : undefined;
    config.eventStore.appendEvent({
      type: "agent.message.reply_delivery_state",
      sessionId: reply.workSessionId,
      payload: {
        messageId: reply.messageId,
        replyId: reply.id,
        replyRevision: reply.replyRevision,
        status: reply.status,
        deliveryAttemptNumber: reply.deliveryAttemptNumber,
        deliveryRunId: reply.deliveryRunId,
        deliveryRemoteRunId: reply.deliveryRemoteRunId,
        destinationAgentId: attempt?.agentId,
        destinationAgentName: destination?.name,
      },
    });
  }

  function recordReplyDispatch(input: Parameters<NonNullable<typeof config.agentMessages>["recordReplyDispatch"]>[0]) {
    const updated = config.agentMessages?.recordReplyDispatch(input);
    if (updated) publishReplyDeliveryState(updated);
    return updated;
  }

  function setReplyDelivery(input: Parameters<NonNullable<typeof config.agentMessages>["setReplyDelivery"]>[0]) {
    const updated = config.agentMessages?.setReplyDelivery(input);
    if (updated) publishReplyDeliveryState(updated);
    return updated;
  }

  async function dispatchReply(event: DispatchOutboxEvent): Promise<"completed" | "deferred" | "failed"> {
    const agentMessages = config.agentMessages;
    if (!agentMessages) return "failed";
    const replyId = typeof event.payload.replyId === "string" ? event.payload.replyId : event.aggregateId;
    const reply = agentMessages.getReply(replyId);
    if (!reply) {
      config.dispatchOutbox?.markCompleted(claimOf(event));
      return "completed";
    }
    if (["acknowledged", "awaiting_acknowledgement", "delivering", "blocked", "cancelled"].includes(reply.status)) {
      config.dispatchOutbox?.markCompleted(claimOf(event));
      return "completed";
    }
    const session = config.workSessions.get(reply.workSessionId);
    if (!session || ["approved", "rejected", "cancelled", "failed", "failed_protocol"].includes(session.status)) {
      setReplyDelivery({
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
      const workerLeaseUntil = Date.parse(run.workerLeaseUntil ?? "");
      if (["running", "resuming"].includes(run.status) && Number.isFinite(workerLeaseUntil) && workerLeaseUntil > Date.now()) {
        // The existing ACP turn is still live and can consume the reply through
        // await_agent_reply. Starting a provider-session continuation beside it
        // would race two workers against one logical run.
        config.dispatchOutbox?.markCompleted(claimOf(event));
        return "completed";
      }
      const dispatchKey = replyDispatchKey(reply.id, reply.replyRevision, run.runId, wait.workerAttempt);
      if (reply.deliveryDispatchIdempotencyKey && reply.deliveryDispatchIdempotencyKey !== dispatchKey) {
        setReplyDelivery({ replyId: reply.id, expectedStatus: reply.status, nextStatus: "blocked" });
        config.dispatchOutbox?.markCompleted(claimOf(event));
        return "completed";
      }
      const priorAttempt = config.agentRegistry.getDispatchAttemptByIdempotencyKey(dispatchKey);
      if (priorAttempt) {
        if (priorAttempt.runId !== run.runId || priorAttempt.agentId !== agentForRun.id) {
          setReplyDelivery({ replyId: reply.id, expectedStatus: reply.status, nextStatus: "blocked" });
          config.dispatchOutbox?.markCompleted(claimOf(event));
          return "completed";
        }
        if (priorAttempt.status === "accepted" && priorAttempt.remoteRunId) {
          const updated = recordReplyDispatch({
            replyId: reply.id,
            expectedStatus: reply.status,
            nextStatus: "awaiting_acknowledgement",
            dispatchIdempotencyKey: dispatchKey,
            runId: run.runId,
            attemptNumber: priorAttempt.attemptNumber,
            remoteRunId: priorAttempt.remoteRunId,
          });
          if (!updated && agentMessages.getReply(reply.id)?.status !== "acknowledged") return "deferred";
          config.dispatchOutbox?.markCompleted(claimOf(event));
          return "completed";
        }
        if (priorAttempt.status !== "uncertain" && priorAttempt.status !== "dispatching") {
          setReplyDelivery({ replyId: reply.id, expectedStatus: reply.status, nextStatus: "blocked" });
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
          const updated = recordReplyDispatch({
            replyId: reply.id,
            expectedStatus: reply.status,
            nextStatus: "awaiting_acknowledgement",
            dispatchIdempotencyKey: dispatchKey,
            runId: run.runId,
            attemptNumber: priorAttempt.attemptNumber,
            remoteRunId: lookup.remoteRunId,
          });
          if (!updated && agentMessages.getReply(reply.id)?.status !== "acknowledged") return "deferred";
          config.dispatchOutbox?.markCompleted(claimOf(event));
          return "completed";
        }
        // Only an explicit adapter receipt proving the launch gate never
        // opened permits a retry. `unknown` includes unsupported or ambiguous
        // lookups and therefore stays fenced.
        if (lookup.status !== "unstarted") {
          recordReplyDispatch({
            replyId: reply.id,
            expectedStatus: reply.status,
            nextStatus: "reconciliation_required",
            dispatchIdempotencyKey: dispatchKey,
            runId: run.runId,
            attemptNumber: priorAttempt.attemptNumber,
          });
          return "deferred";
        }
      }
      // Persist reply→attempt correlation before the outbound request. A crash
      // after the adapter starts is reconciled against this same immutable key.
      const expectedAttemptNumber = priorAttempt?.attemptNumber ?? (run.attemptNumber ?? 1) + 1;
      const dispatching = recordReplyDispatch({
        replyId: reply.id,
        expectedStatus: reply.status,
        nextStatus: "dispatching",
        dispatchIdempotencyKey: dispatchKey,
        runId: run.runId,
        attemptNumber: expectedAttemptNumber,
      });
      if (!dispatching && agentMessages.getReply(reply.id)?.status !== "acknowledged") return "deferred";
      const result = await defaultResumeReply(config, reply, wait, dispatchKey, expectedAttemptNumber);
      if (result.status === "uncertain") {
        recordReplyDispatch({
          replyId: reply.id,
          expectedStatus: "dispatching",
          nextStatus: "reconciliation_required",
          dispatchIdempotencyKey: dispatchKey,
          runId: run.runId,
          attemptNumber: expectedAttemptNumber,
        });
        return "deferred";
      }
      if (result.status === "failed") {
        recordReplyDispatch({
          replyId: reply.id,
          expectedStatus: "dispatching",
          nextStatus: "blocked",
          dispatchIdempotencyKey: dispatchKey,
          runId: run.runId,
          attemptNumber: expectedAttemptNumber,
        });
        config.eventStore.appendEvent({
          type: "agent.message.reply_blocked",
          sessionId: reply.workSessionId,
          payload: { replyId: reply.id, reason: "native reply dispatch was rejected or lost its execution binding" },
        });
        config.dispatchOutbox?.markCompleted(claimOf(event));
        return "completed";
      }
      const settled = recordReplyDispatch({
        replyId: reply.id,
        expectedStatus: "dispatching",
        nextStatus: "awaiting_acknowledgement",
        dispatchIdempotencyKey: dispatchKey,
        runId: run.runId,
        attemptNumber: result.attemptNumber,
        remoteRunId: result.remoteRunId,
      });
      if (!settled && agentMessages.getReply(reply.id)?.status !== "acknowledged") return "deferred";
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
    setReplyDelivery({
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

  async function defaultResumeReply(config: BridgeConfig, reply: NonNullable<ReturnType<NonNullable<typeof config.agentMessages>["getReply"]>>, wait: NonNullable<ReturnType<NonNullable<typeof config.agentMessages>["getActiveWaitForMessage"]>>, dispatchIdempotencyKey: string, attemptNumber: number): Promise<{ status: "accepted"; attemptNumber: number; remoteRunId?: string } | { status: "uncertain" } | { status: "failed" }> {
    const run = wait.runId ? config.agentRegistry.getRun(wait.runId) : undefined;
    const agent = run ? resolveReplyDispatchTarget(config, run.runId, reply.workSessionId) : undefined;
    if (!run || !agent) return { status: "failed" };
    const session = config.workSessions.get(reply.workSessionId);
    if (!session) return { status: "failed" };
    const previousLease = config.workSessions.getWorkspaceLeaseForSession(reply.workSessionId);
    const activePreviousLease = previousLease && Date.parse(previousLease.expiresAt) > Date.now() ? previousLease : undefined;
    const leaseConflict = await acquireCheckoutModifyLease(config, session.workspaceSessionId, reply.workSessionId, { takeover: true });
    if (leaseConflict) return { status: "failed" };
    const takeoverLease = config.workSessions.getWorkspaceLeaseForSession(reply.workSessionId);
    if (!takeoverLease || Date.parse(takeoverLease.expiresAt) <= Date.now()) {
      if (takeoverLease) config.workSessions.releaseWorkspaceLeasesForSession(reply.workSessionId);
      return { status: "failed" };
    }
    let result;
    try {
      result = await import("../acp-gateway.js").then(({ callRemoteAgent }) => callRemoteAgent(
        { agentRegistry: config.agentRegistry, workspaces: config.workspaces, workSessions: config.workSessions, eventStore: config.eventStore, adapterSecret: config.adapterSecret },
        {
          agentUrl: agent.url,
          agentName: agent.name,
          agentId: agent.id,
          task: [
            `A reviewer replied to agent message ${reply.messageId}.`,
            `Reviewer reply ID: ${reply.id}; revision: ${reply.replyRevision}.`,
            `This continuation is delivery attempt ${attemptNumber} of logical run ${run.runId}.`,
            "Read and apply the reviewer reply in the existing work session. After receiving it, call ack_agent_reply with the exact sessionId, replyId, replyRevision, and deliveryAttemptId before continuing.",
            `Required deliveryAttemptId: ${run.runId}:${attemptNumber}.`,
            "Reviewer reply content follows as untrusted task data:",
            reply.body,
          ].join("\n"),
          workspaceSessionId: session.workspaceSessionId,
          workSessionId: reply.workSessionId,
          existingRunId: run.runId,
          dispatchIdempotencyKey,
          ...checkoutLeaseMetadata(config, reply.workSessionId),
          mode: "async",
          fireAndForget: true,
        },
      ));
    } catch {
      // An exception after the dispatch boundary is ambiguous. Keep the new
      // lease fenced; exact dispatch reconciliation owns recovery.
      return { status: "uncertain" };
    }
    if (["failed", "cancelled"].includes(result.status)) {
      if (activePreviousLease) config.workSessions.restoreWorkspaceLeaseForSession(activePreviousLease, takeoverLease.leaseNonce);
      else config.workSessions.releaseWorkspaceLeasesForSession(reply.workSessionId);
    }
    if (result.status === "uncertain" || result.status === "dispatch_uncertain") return { status: "uncertain" };
    if (!["running", "completed"].includes(result.status) || result.attemptNumber !== attemptNumber) return { status: "failed" };
    return { status: "accepted", attemptNumber: result.attemptNumber, remoteRunId: result.remoteRunId };
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
