/**
 * Durable background continuation dispatcher (Ralphie Muntz Loop auto-driver)
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import { DEFAULT_CLAIM_LEASE_MS } from "../continuation.js";
import type { Continuation } from "../continuation.js";
import type { DispatchOutboxEvent } from "../dispatch-outbox.js";
import { TERMINAL_STATUSES } from "../review-workflow.js";
import type { BridgeConfig } from "./context.js";
import { defaultLiveWaiters } from "./shared.js";
import type { LiveWaiterRegistry } from "./shared.js";
import type { DispatchContext } from "./dispatch-context.js";
import {
  claimOf,
  handoffState,
  latestHandoff,
  recordHandoffState,
  supersedeContinuation,
} from "./dispatch-context.js";
import { reconcileHandoffContinuations } from "./handoff-reconciliation.js";
import { enqueueReadyContinuations } from "./continuation-claims.js";
import { tryDispatchPeerContinuation } from "./peer-continuation.js";
import { dispatchAcpContinuation } from "./acp-continuation.js";

const DISPATCH_BLOCKED_SESSION_STATUSES = new Set([...TERMINAL_STATUSES, "cancelling"]);

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
        event.type === "continuation.redriven" ||
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
  const ctx: DispatchContext = { config, liveWaiters, dispatcherId };

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
      const handoff = latestHandoff(config, cont.sessionId);
      const handoffPayload = handoff?.payload as Record<string, unknown> | undefined;
      if (liveWaiters.has(cont.sessionId)) {
        // A committed handoff means the live waiter belongs to the current
        // destination worker. Later review feedback should wake that worker
        // normally; recording quiescing_source here would regress the durable
        // handoff and make its next wait look like an uncommitted transfer.
        if (handoff && handoffPayload?.toAgent && handoffState(config, cont.sessionId, handoffPayload.transferId) !== "committed") {
          recordHandoffState(config, cont.sessionId, handoff, "quiescing_source", "Waiting for the source worker's handoff signal and waiter shutdown.");
          return "deferred";
        }
        if (outboxEvent) config.dispatchOutbox?.markCompleted(claimOf(outboxEvent));
        return "completed";
      }

      const session = config.workSessions.get(cont.sessionId);
      if (!session) {
        outboxEvent ? config.dispatchOutbox?.markCompleted(claimOf(outboxEvent)) : undefined;
        return "completed";
      }
      if (DISPATCH_BLOCKED_SESSION_STATUSES.has(session.status)) {
        supersedeContinuation(config, cont.id, cont.sessionId, `session is ${session.status}`);
        outboxEvent ? config.dispatchOutbox?.markCompleted(claimOf(outboxEvent)) : undefined;
        return "completed";
      }

      // Atomic claim (CAS): only one dispatcher owns a given continuation.
      const claimed = config.continuationManager.claim(dispatcherId, { id: cont.id });
      if (!claimed) {
        outboxEvent ? config.dispatchOutbox?.markCompleted(claimOf(outboxEvent)) : undefined;
        return "completed";
      }
      const claimedSession = config.workSessions.get(claimed.sessionId);
      if (!claimedSession || DISPATCH_BLOCKED_SESSION_STATUSES.has(claimedSession.status)) {
        const reason = claimedSession ? `session is ${claimedSession.status}` : "session not found";
        supersedeContinuation(config, claimed.id, claimed.sessionId, reason);
        outboxEvent ? config.dispatchOutbox?.markCompleted(claimOf(outboxEvent)) : undefined;
        return "completed";
      }

      if (claimed.verdict !== "changes_requested") {
        // Defensive: pending continuations should only be changes_requested.
        config.continuationManager.markCompleted(claimed.id);
        outboxEvent ? config.dispatchOutbox?.markCompleted(claimOf(outboxEvent)) : undefined;
        return "completed";
      }

      // Strategy selection on the explicit durable dispatch target: scheduled
      // peer-pull continuations go to the peer strategy, everything else to ACP.
      const peerAttempt = await tryDispatchPeerContinuation(ctx, claimed, outboxEvent);
      if (peerAttempt.handled) return peerAttempt.outcome;
      return dispatchAcpContinuation(ctx, claimed, cont, handoff, outboxEvent);
  };

  try {
    await reconcileHandoffContinuations(ctx);
    if (config.dispatchOutbox) {
      enqueueReadyContinuations(ctx);

      for (;;) {
        // Claim only events owned by this dispatcher. The outbox is shared
        // with supervisor/scheduled consumers, so an unfiltered claim would
        // steal foreign events and this guard would otherwise acknowledge
        // them without letting their designated owner process them.
        const event = config.dispatchOutbox.claimNext(dispatcherId, DEFAULT_CLAIM_LEASE_MS, ["continuation.ready"]);
        if (!event) break;
        const claim = claimOf(event);
        if (event.eventType !== "continuation.ready") {
          // Defensive invariant: filtered claimNext() must never yield a
          // foreign event. Preserve it for investigation rather than
          // acknowledging a routing violation.
          config.dispatchOutbox.markFailed(claim, `Dispatch routing violation: ${event.eventType}`, 60_000);
          continue;
        }
        const cont = config.continuationManager.get(event.aggregateId);
        if (!cont || cont.status !== "pending") {
          config.dispatchOutbox.markCompleted(claim);
          continue;
        }
        const result = await dispatchContinuation(cont, event);
        if (result === "completed") config.dispatchOutbox.markCompleted(claim);
      }
      return;
    }

    for (const cont of config.continuationManager.listPending()) {
      await dispatchContinuation(cont);
    }
  } catch (error) {
    // The next bounded tick retries durable, still-pending work. Report only a
    // stable category here: adapter messages can contain host paths or other
    // request data and do not belong in startup/dispatcher diagnostics.
    const reason = error instanceof Error ? error.message : "";
    const category = /SQLITE_BUSY|database is locked/i.test(reason) ? "database_busy"
      : /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up/i.test(reason) ? "transport_unavailable"
        : /timed? ?out|deadline/i.test(reason) ? "timeout"
          : "unexpected";
    console.warn(`[kontrol] continuation dispatcher tick failed (${category}); pending work remains retryable`);
  }
}
