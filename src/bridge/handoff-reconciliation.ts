/**
 * Handoff reconciliation: quiesce sources and reconcile durable handoff state.
 */
import { lookupPeerDispatch } from "../acp-gateway.js";
import type { DispatchContext } from "./dispatch-context.js";
import { handoffForRun, markTransferredFeedbackConsumed, recordHandoffState } from "./dispatch-context.js";

import type { Continuation } from "../continuation.js";
import type { DispatchOutboxEvent } from "../dispatch-outbox.js";

/** Handoff reconciliation: quiesce sources and reconcile durable handoff state. */

  export async function reconcileHandoffContinuations(ctx: DispatchContext): Promise<void> {
    for (const continuation of ctx.config.continuationManager.listReconciliationRequired()) {
      const session = ctx.config.workSessions.get(continuation.sessionId);
      const run = continuation.target ? ctx.config.agentRegistry.getRun(continuation.target) : undefined;
      const handoff = continuation.target ? handoffForRun(ctx.config, continuation.sessionId, continuation.target) : undefined;
      const handoffPayload = handoff?.payload as Record<string, unknown> | undefined;
      if (!session || !run || !handoff || typeof handoffPayload?.transferId !== "string") continue;
      const attempt = ctx.config.agentRegistry.getLatestDispatchAttemptForRun(run.runId);
      if (!attempt || !attempt.agentId || attempt.attemptNumber !== run.attemptNumber) continue;
      const destinationId = typeof handoffPayload.toAgentId === "string" ? handoffPayload.toAgentId : undefined;
      if (!destinationId || attempt.agentId !== destinationId) continue;
      let accepted = attempt.status === "accepted" && Boolean(attempt.remoteRunId);
      let remoteRunId = attempt.remoteRunId;
      if (!accepted) {
        const agent = ctx.config.agentRegistry.get(attempt.agentId);
        if (!agent || !agent.alive) continue;
        const lookup = await lookupPeerDispatch({
          agentUrl: agent.url,
          adapterSecret: ctx.config.adapterSecret,
          dispatchIdempotencyKey: attempt.dispatchIdempotencyKey,
        }).catch(() => ({ status: "unknown" as const }));
        if (lookup.status === "unknown") continue;
        if (lookup.status === "unstarted") {
          ctx.config.agentRegistry.updateDispatchAttempt(attempt.dispatchIdempotencyKey, { status: "unstarted" });
          if (ctx.config.continuationManager.resolveReconciliation({
            id: continuation.id,
            targetRunId: run.runId,
            outcome: "retry_safe",
          })) {
            recordHandoffState(ctx.config, continuation.sessionId, handoff, "retry_safe", "The destination adapter confirmed this attempt never started; a fresh attempt is safe.");
          }
          continue;
        }
        accepted = true;
        remoteRunId = lookup.remoteRunId;
        if (remoteRunId) {
          ctx.config.agentRegistry.updateDispatchAttempt(attempt.dispatchIdempotencyKey, { status: "accepted", remoteRunId });
        }
      }
      if (!accepted || !remoteRunId) continue;
      ctx.config.agentRegistry.updateRun(run.runId, {
        status: "running",
        remoteRunId,
        attemptNumber: attempt.attemptNumber,
        lastHeartbeatAt: new Date().toISOString(),
        finishedAt: undefined,
        errorMessage: undefined,
      });
      if (!ctx.config.continuationManager.resolveReconciliation({
        id: continuation.id,
        targetRunId: run.runId,
        outcome: "dispatched",
      })) continue;
      recordHandoffState(ctx.config, continuation.sessionId, handoff, "destination_ready");
      recordHandoffState(ctx.config, continuation.sessionId, handoff, "committed");
      const transferId = handoffPayload.transferId;
      const latestTransferContext = ctx.config.eventStore.getLatestEventForSession(
        continuation.sessionId,
        "session.handoff.context",
        { field: "transferId", value: String(transferId) },
      );
      markTransferredFeedbackConsumed(ctx.config, 
        continuation.sessionId,
        (latestTransferContext?.payload as { contextTransferPacket?: unknown } | undefined)?.contextTransferPacket
          ?? handoffPayload.contextTransferPacket,
      );
      ctx.config.eventStore.appendEvent({
        type: "continuation.delivered",
        sessionId: continuation.sessionId,
        payload: { continuationId: continuation.id, runId: run.runId, remoteRunId, attemptNumber: attempt.attemptNumber, reconciled: true },
      });
    }
  }
