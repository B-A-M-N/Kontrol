/**
 * Durable background continuation dispatcher (Ralphie Muntz Loop auto-driver)
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import { callRemoteAgent, selectHealthyAgent } from "../acp-gateway.js";
import type { AgentCallResult } from "../acp-gateway.js";
import { DEFAULT_CLAIM_LEASE_MS } from "../continuation.js";
import type { Continuation } from "../continuation.js";
import type { DispatchOutboxEvent } from "../dispatch-outbox.js";
import { TERMINAL_STATUSES } from "../review-workflow.js";
import type { BridgeConfig } from "./context.js";
import { defaultLiveWaiters, renderMissionPrompt, resolveHealthyAgentUrl, workSessionInstructions } from "./shared.js";
import type { LiveWaiterRegistry } from "./shared.js";

export interface ContinuationDispatcher {
  start(): void;
  stop(): void;
  /** One deterministic pass over pending continuations. */
  drainOnce(): Promise<void>;
}


export function createContinuationDispatcher(config: BridgeConfig): ContinuationDispatcher {
  const liveWaiters = config.liveWaiters ?? defaultLiveWaiters;
  const dispatcherId = "kontrol-dispatcher";
  let leaseTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let unsub: (() => void) | null = null;

  function scheduleNextLeaseCheck(): void {
    if (leaseTimer) clearTimeout(leaseTimer);
    if (stopped) return;
    // Bound the next scan to the claim-lease window; if nothing is claimed this
    // is just a liveness sweep.
    leaseTimer = setTimeout(() => {
      if (stopped) return;
      void runContinuationTick(config, liveWaiters).then(scheduleNextLeaseCheck);
    }, DEFAULT_CLAIM_LEASE_MS);
  }

  async function drainOnce(): Promise<void> {
    await runContinuationTick(config, liveWaiters);
  }

  function start(): void {
    stopped = false;
    // Immediate drain for anything already pending (e.g. at process startup).
    void drainOnce();
    // React immediately (no periodic poll) when:
    //  - a continuation is committed (reviewer requested changes),
    //  - the LAST live waiter disconnected (redrive without the lease sweep), or
    //  - a worker attempt exited while the review is still open (the durable
    //    review lives on; redrive only if a continuation later exists).
    unsub = config.eventStore.subscribeAll((event) => {
      if (
        event.type === "continuation.created" ||
        event.type === "worker.waiter.closed" ||
        event.type === "worker.attempt.exited" ||
        event.type === "worker.attempt.failed"
      ) {
        void drainOnce();
      }
    });
    scheduleNextLeaseCheck();
  }

  function stop(): void {
    stopped = true;
    if (leaseTimer) clearTimeout(leaseTimer);
    leaseTimer = null;
    if (unsub) unsub();
    unsub = null;
  }

  return { start, stop, drainOnce };
}

/**
 * Single dispatcher pass. Exported so integration tests can drive the exact same
 * logic deterministically (instead of waiting on the lease timer).
 */
export async function runContinuationTick(
  config: BridgeConfig,
  liveWaiters: LiveWaiterRegistry = config.liveWaiters ?? defaultLiveWaiters,
): Promise<void> {
  const dispatcherId = "kontrol-dispatcher";
  const supersedeContinuation = (continuationId: string, sessionId: string, reason: string) => {
    config.continuationManager.supersede(continuationId, reason);
    config.eventStore.appendEvent({
      type: "continuation.superseded",
      sessionId,
      payload: { continuationId, reason },
    });
  };

  // Requeue continuations whose claim lease expired (e.g. a dispatcher crashed
  // mid-dispatch), so they are not stranded forever.
  config.continuationManager.reapExpiredClaims(DEFAULT_CLAIM_LEASE_MS);
  config.dispatchOutbox?.reapExpiredClaims(DEFAULT_CLAIM_LEASE_MS);

  const dispatchContinuation = async (
    cont: Continuation,
    outboxEvent?: DispatchOutboxEvent,
  ): Promise<"completed" | "deferred" | "failed"> => {
      // A live agent is already parked on await_review_feedback for this session:
      // the feedback event will wake it directly. Do NOT spawn a second worker.
      if (liveWaiters.has(cont.sessionId)) {
        outboxEvent
          ? config.dispatchOutbox?.release(outboxEvent.id, DEFAULT_CLAIM_LEASE_MS, "live waiter attached")
          : undefined;
        return "deferred";
      }

      const session = config.workSessions.get(cont.sessionId);
      if (!session) {
        outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
        return "completed";
      }
      if (TERMINAL_STATUSES.has(session.status)) {
        supersedeContinuation(cont.id, cont.sessionId, `session is ${session.status}`);
        outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
        return "completed";
      }

      // Atomic claim (CAS): only one dispatcher owns a given continuation.
      const claimed = config.continuationManager.claim(dispatcherId, { id: cont.id });
      if (!claimed) {
        outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
        return "completed";
      }
      const claimedSession = config.workSessions.get(claimed.sessionId);
      if (!claimedSession || TERMINAL_STATUSES.has(claimedSession.status)) {
        const reason = claimedSession ? `session is ${claimedSession.status}` : "session not found";
        supersedeContinuation(claimed.id, claimed.sessionId, reason);
        outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
        return "completed";
      }

      if (claimed.verdict !== "changes_requested") {
        // Defensive: pending continuations should only be changes_requested.
        config.continuationManager.markCompleted(claimed.id);
        outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
        return "completed";
      }

      const existingRun = config.agentRegistry.getRunByWorkSessionId(claimed.sessionId);
      if (!existingRun) {
        config.continuationManager.release(dispatcherId, { id: claimed.id });
        config.eventStore.appendEvent({
          type: "continuation.dispatch_failed",
          sessionId: claimed.sessionId,
          payload: {
            continuationId: claimed.id,
            reason: "Original ACP run not found",
          },
        });
        outboxEvent
          ? config.dispatchOutbox?.markFailed(outboxEvent.id, "Original ACP run not found", DEFAULT_CLAIM_LEASE_MS)
          : undefined;
        return "failed";
      }
      const missionPacket = config.missionLedger?.getPacket(claimed.sessionId);
      const preferredAgent = missionPacket?.workOrders[0]?.preferredAgent;
      const agentName = preferredAgent || existingRun.agentName;
      const selection = await selectHealthyAgent(config.agentRegistry.listAlive(), {
        name: agentName,
        role: "agent",
        adapterSecret: config.adapterSecret,
      });
      if (!selection.agent) {
        // No healthy agent — release the claim so a later wakeup retries it
        // (the lease prevents it from being re-claimed too eagerly after a blip).
        config.continuationManager.release(dispatcherId, { id: claimed.id });
        outboxEvent
          ? config.dispatchOutbox?.markFailed(outboxEvent.id, "No healthy agent available", DEFAULT_CLAIM_LEASE_MS)
          : undefined;
        return "failed";
      }

      try {
        const preDispatchSession = config.workSessions.get(claimed.sessionId);
        if (!preDispatchSession || TERMINAL_STATUSES.has(preDispatchSession.status)) {
          const reason = preDispatchSession ? `session is ${preDispatchSession.status}` : "session not found";
          supersedeContinuation(claimed.id, claimed.sessionId, reason);
          outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
          return "completed";
        }
        if (config.beforeContinuationDispatch) {
          await config.beforeContinuationDispatch(claimed, claimed.sessionId);
          const afterHookSession = config.workSessions.get(claimed.sessionId);
          if (!afterHookSession || TERMINAL_STATUSES.has(afterHookSession.status)) {
            const reason = afterHookSession ? `session is ${afterHookSession.status}` : "session not found";
            supersedeContinuation(claimed.id, claimed.sessionId, reason);
            outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
            return "completed";
          }
        }

        let result: AgentCallResult;
        if (config.resumeAgent) {
          // Test hook: treat a resolved hook as a successful dispatch. The real
          // run identity is unknown in this case, so fall back to the claimed
          // continuation id as the delivered-run marker.
          await config.resumeAgent(claimed, claimed.sessionId);
          result = { runId: claimed.id, agentName, attemptNumber: 1, status: "running", output: "" };
        } else {
          result = await defaultResume(config, claimed, session, agentName);
        }

        // callRemoteAgent() catches transport errors and returns status:"failed"
        // instead of throwing. Treat that as a failed dispatch so the claim is
        // RELEASED (not marked delivered) and a later wakeup retries it.
        if (result.status === "failed") {
          throw new Error(result.error ?? "ACP continuation dispatch failed");
        }

        // Persist the REAL kontrol run id so reconciliation/delivery records are
        // accurate (the dispatcher id is not a run identity).
        const delivered = config.continuationManager.markDelivered({
          id: claimed.id,
          expectedStatus: "claimed",
          claimOwner: dispatcherId,
          targetRunId: result.runId,
        });
        if (!delivered) {
          outboxEvent
            ? config.dispatchOutbox?.release(outboxEvent.id, DEFAULT_CLAIM_LEASE_MS, "continuation delivery CAS failed")
            : undefined;
          return "deferred";
        }

        // Publish after the continuation is delivered so subscribers react without
        // a poll, and ordering is: feedback -> continuation -> delivered event.
        config.eventStore.appendEvent({
          type: "continuation.delivered",
          sessionId: claimed.sessionId,
          payload: { continuationId: claimed.id, runId: result.runId, remoteRunId: result.remoteRunId, attemptNumber: result.attemptNumber },
        });
        outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
        return "completed";
      } catch {
        // Dispatch failed — release so a later wakeup retries it.
        config.continuationManager.release(dispatcherId, { id: claimed.id });
        outboxEvent
          ? config.dispatchOutbox?.markFailed(outboxEvent.id, "ACP continuation dispatch failed", DEFAULT_CLAIM_LEASE_MS)
          : undefined;
        return "failed";
      }
  };

  try {
    if (config.dispatchOutbox) {
      for (const cont of config.continuationManager.listPending()) {
        if (!config.dispatchOutbox.hasLogical("continuation.ready", cont.id, cont.reviewEpoch)) {
          config.dispatchOutbox.enqueue({
            eventType: "continuation.ready",
            aggregateId: cont.id,
            aggregateRevision: cont.reviewEpoch,
            payload: {
              sessionId: cont.sessionId,
              continuationId: cont.id,
              revision: cont.reviewEpoch,
            },
          });
        }
      }

      for (;;) {
        const event = config.dispatchOutbox.claimNext(dispatcherId, DEFAULT_CLAIM_LEASE_MS);
        if (!event) break;
        if (event.eventType !== "continuation.ready") {
          config.dispatchOutbox.markCompleted(event.id);
          continue;
        }
        const cont = config.continuationManager.get(event.aggregateId);
        if (!cont || cont.status !== "pending") {
          config.dispatchOutbox.markCompleted(event.id);
          continue;
        }
        await dispatchContinuation(cont, event);
      }
      return;
    }

    for (const cont of config.continuationManager.listPending()) {
      await dispatchContinuation(cont);
    }
  } catch {
    // Swallow; next drain retries unclaimed continuations.
  }
}

export async function defaultResume(
  config: BridgeConfig,
  continuation: Continuation,
  session: { workspaceSessionId: string },
  agentName = "cli-coding-agent",
): Promise<AgentCallResult> {
  const run = config.agentRegistry.getRunByWorkSessionId(continuation.sessionId);
  const agent = config.agentRegistry.listAlive().find((candidate) => candidate.name === agentName);
  const missionPrompt = renderMissionPrompt(config, continuation.sessionId, continuation.promptText);
  const task = [
    continuation.promptText,
    missionPrompt,
    `Continue from review feedback. ${workSessionInstructions(continuation.sessionId, agent)}`,
  ].filter(Boolean).join("\n\n");
  return callRemoteAgent(
    { agentRegistry: config.agentRegistry, workspaces: config.workspaces, workSessions: config.workSessions, adapterSecret: config.adapterSecret },
    {
      agentUrl: await resolveHealthyAgentUrl(config, agentName),
      agentName,
      agentId: agent?.id,
      task,
      workspaceSessionId: session.workspaceSessionId,
      workSessionId: continuation.sessionId,
      existingRunId: run?.runId,
      continuationId: continuation.id,
      mode: "async",
      fireAndForget: true,
    },
  );
}
