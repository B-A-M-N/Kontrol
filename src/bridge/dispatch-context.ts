/**
 * Shared continuation-dispatch ownership: one explicit context selects the
 * strategy; strategies consume it without duplicating authorization, lease,
 * or outbox handling. Helpers take the BridgeConfig first so both the tick
 * guard and the strategy modules share one call convention.
 */
import { DEFAULT_CLAIM_LEASE_MS } from "../continuation.js";
import type { Continuation } from "../continuation.js";
import type { DispatchOutboxEvent, OutboxClaim } from "../dispatch-outbox.js";
import type { BridgeConfig } from "./context.js";
import type { LiveWaiterRegistry } from "./shared.js";

/** Shared dispatch ownership: one context selects the strategy; strategies
 * consume it without duplicating authorization, lease, or outbox handling. */
export interface DispatchContext {
  readonly config: BridgeConfig;
  readonly liveWaiters: LiveWaiterRegistry;
  readonly dispatcherId: string;
}

export type HandoffEvent = ReturnType<BridgeConfig["eventStore"]["getLatestEventForSession"]>;

export function supersedeContinuation(config: BridgeConfig, continuationId: string, sessionId: string, reason: string) {

    config.continuationManager.supersede(continuationId, reason);
    config.eventStore.appendEvent({
      type: "continuation.superseded",
      sessionId,
      payload: { continuationId, reason },
    });
  }
export function claimOf(event: DispatchOutboxEvent): OutboxClaim {
  return { eventId: event.id, claimOwner: event.claimedBy ?? "", claimToken: event.claimToken ?? "" };
}
export function latestHandoff(config: BridgeConfig, sessionId: string) {
  return config.eventStore.getLatestEventForSession(sessionId, "session.handoff");
}
export function handoffState(config: BridgeConfig, sessionId: string, transferId: unknown) {

    if (typeof transferId !== "string") return undefined;
    const event = config.eventStore.getLatestEventForSession(sessionId, "session.handoff.state", { field: "transferId", value: transferId });
    const state = (event?.payload as { state?: unknown } | undefined)?.state;
    return typeof state === "string" ? state : undefined;
  }
export function handoffForRun(config: BridgeConfig, sessionId: string, runId: string) {
  return config.eventStore.getLatestEventForSession(
    sessionId, "session.handoff", { field: "runId", value: runId },
  );
}
export function recordHandoffState(config: BridgeConfig, sessionId: string, handoff: NonNullable<ReturnType<typeof latestHandoff>>, state: string, detail?: string) {

    const payload = handoff.payload as Record<string, unknown>;
    const lastState = config.eventStore.getLatestEventForSession(sessionId, "session.handoff.state", {
      field: "transferId",
      value: String(payload.transferId ?? ""),
    })?.payload as Record<string, unknown> | undefined;
    if (lastState?.transferId === payload.transferId && lastState?.state === state && lastState?.detail === detail) return;
    config.eventStore.appendEvent({
      type: "session.handoff.state",
      sessionId,
      payload: {
        transferId: payload.transferId,
        runId: payload.runId,
        fromAgent: payload.fromAgent,
        toAgent: payload.toAgent,
        state,
        ...(detail ? { detail } : {}),
      },
    });
  }
export function markTransferredFeedbackConsumed(config: BridgeConfig, sessionId: string, packet: unknown) {

    const feedbackId = (packet as { latestReviewerFeedback?: { feedbackId?: unknown } } | undefined)
      ?.latestReviewerFeedback?.feedbackId;
    if (typeof feedbackId === "string") config.workSessions.markFeedbackConsumed(sessionId, feedbackId);
  }

export function markContinuationDispatchFailed(config: BridgeConfig, event: DispatchOutboxEvent | undefined, continuation: Continuation, reason: string) {

    if (!event || !config.dispatchOutbox) return;
    config.dispatchOutbox.markFailed(claimOf(event), reason, DEFAULT_CLAIM_LEASE_MS);
    const current = config.dispatchOutbox.get(event.id);
    if (current?.status === "dead_lettered") {
      config.eventStore.appendEvent({
        type: "continuation.dispatch_attention",
        sessionId: continuation.sessionId,
        payload: {
          continuationId: continuation.id,
          reviewEpoch: continuation.reviewEpoch,
          outboxId: event.id,
          failureCount: current.failureCount,
          reason,
        },
      });
    }
  }
