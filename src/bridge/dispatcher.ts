/**
 * Durable background continuation dispatcher (Ralphie Muntz Loop auto-driver)
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import { createHash } from "node:crypto";
import { callRemoteAgent, lookupPeerDispatch, selectHealthyAgent } from "../acp-gateway.js";
import type { AgentCallResult } from "../acp-gateway.js";
import { DEFAULT_CLAIM_LEASE_MS } from "../continuation.js";
import type { Continuation } from "../continuation.js";
import type { DispatchOutboxEvent, OutboxClaim } from "../dispatch-outbox.js";
import { TERMINAL_STATUSES } from "../review-workflow.js";

const DISPATCH_BLOCKED_SESSION_STATUSES = new Set([...TERMINAL_STATUSES, "cancelling"]);
import type { BridgeConfig } from "./context.js";
import { acquireCheckoutModifyLease, checkoutLeaseMetadata, defaultLiveWaiters, renderMissionPrompt, resolveHealthyAgentUrl, workSessionInstructions } from "./shared.js";
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
  const supersedeContinuation = (continuationId: string, sessionId: string, reason: string) => {
    config.continuationManager.supersede(continuationId, reason);
    config.eventStore.appendEvent({
      type: "continuation.superseded",
      sessionId,
      payload: { continuationId, reason },
    });
  };
  const claimOf = (event: DispatchOutboxEvent): OutboxClaim => ({ eventId: event.id, claimOwner: event.claimedBy ?? "", claimToken: event.claimToken ?? "" });
  const latestHandoff = (sessionId: string) => config.eventStore.getEventsForSession(sessionId)
    .filter((event) => event.type === "session.handoff")
    .at(-1);
  const handoffForRun = (sessionId: string, runId: string) => config.eventStore.getEventsForSession(sessionId)
    .filter((event) => event.type === "session.handoff")
    .reverse()
    .find((event) => (event.payload as Record<string, unknown>).runId === runId);
  const recordHandoffState = (sessionId: string, handoff: NonNullable<ReturnType<typeof latestHandoff>>, state: string, detail?: string) => {
    const payload = handoff.payload as Record<string, unknown>;
    const lastState = config.eventStore.getEventsForSession(sessionId)
      .filter((event) => event.type === "session.handoff.state")
      .at(-1)?.payload as Record<string, unknown> | undefined;
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
  };
  const markTransferredFeedbackConsumed = (sessionId: string, packet: unknown) => {
    const feedbackId = (packet as { latestReviewerFeedback?: { feedbackId?: unknown } } | undefined)
      ?.latestReviewerFeedback?.feedbackId;
    if (typeof feedbackId === "string") config.workSessions.markFeedbackConsumed(sessionId, feedbackId);
  };
  const reconcileHandoffContinuations = async () => {
    for (const continuation of config.continuationManager.listReconciliationRequired()) {
      const session = config.workSessions.get(continuation.sessionId);
      const run = continuation.target ? config.agentRegistry.getRun(continuation.target) : undefined;
      const handoff = continuation.target ? handoffForRun(continuation.sessionId, continuation.target) : undefined;
      const handoffPayload = handoff?.payload as Record<string, unknown> | undefined;
      if (!session || !run || !handoff || typeof handoffPayload?.transferId !== "string") continue;
      const attempt = config.agentRegistry.getLatestDispatchAttemptForRun(run.runId);
      if (!attempt || !attempt.agentId || attempt.attemptNumber !== run.attemptNumber) continue;
      const destinationId = typeof handoffPayload.toAgentId === "string" ? handoffPayload.toAgentId : undefined;
      if (!destinationId || attempt.agentId !== destinationId) continue;
      let accepted = attempt.status === "accepted" && Boolean(attempt.remoteRunId);
      let remoteRunId = attempt.remoteRunId;
      if (!accepted) {
        const agent = config.agentRegistry.get(attempt.agentId);
        if (!agent || !agent.alive) continue;
        const lookup = await lookupPeerDispatch({
          agentUrl: agent.url,
          adapterSecret: config.adapterSecret,
          dispatchIdempotencyKey: attempt.dispatchIdempotencyKey,
        }).catch(() => ({ status: "unknown" as const }));
        if (lookup.status === "unknown") continue;
        if (lookup.status === "unstarted") {
          config.agentRegistry.updateDispatchAttempt(attempt.dispatchIdempotencyKey, { status: "unstarted" });
          if (config.continuationManager.resolveReconciliation({
            id: continuation.id,
            targetRunId: run.runId,
            outcome: "retry_safe",
          })) {
            recordHandoffState(continuation.sessionId, handoff, "retry_safe", "The destination adapter confirmed this attempt never started; a fresh attempt is safe.");
          }
          continue;
        }
        accepted = true;
        remoteRunId = lookup.remoteRunId;
        if (remoteRunId) {
          config.agentRegistry.updateDispatchAttempt(attempt.dispatchIdempotencyKey, { status: "accepted", remoteRunId });
        }
      }
      if (!accepted || !remoteRunId) continue;
      config.agentRegistry.updateRun(run.runId, {
        status: "running",
        remoteRunId,
        attemptNumber: attempt.attemptNumber,
        lastHeartbeatAt: new Date().toISOString(),
        finishedAt: undefined,
        errorMessage: undefined,
      });
      if (!config.continuationManager.resolveReconciliation({
        id: continuation.id,
        targetRunId: run.runId,
        outcome: "dispatched",
      })) continue;
      recordHandoffState(continuation.sessionId, handoff, "destination_ready");
      recordHandoffState(continuation.sessionId, handoff, "committed");
      const transferId = handoffPayload.transferId;
      const latestTransferContext = config.eventStore.getEventsForSession(continuation.sessionId)
        .filter((event) => event.type === "session.handoff.context")
        .reverse()
        .find((event) => (event.payload as { transferId?: unknown }).transferId === transferId);
      markTransferredFeedbackConsumed(
        continuation.sessionId,
        (latestTransferContext?.payload as { contextTransferPacket?: unknown } | undefined)?.contextTransferPacket
          ?? handoffPayload.contextTransferPacket,
      );
      config.eventStore.appendEvent({
        type: "continuation.delivered",
        sessionId: continuation.sessionId,
        payload: { continuationId: continuation.id, runId: run.runId, remoteRunId, attemptNumber: attempt.attemptNumber, reconciled: true },
      });
    }
  };
  const markContinuationDispatchFailed = (event: DispatchOutboxEvent | undefined, continuation: Continuation, reason: string) => {
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
      const handoff = latestHandoff(cont.sessionId);
      const handoffPayload = handoff?.payload as Record<string, unknown> | undefined;
      if (liveWaiters.has(cont.sessionId)) {
        if (handoff && handoffPayload?.toAgent) {
          recordHandoffState(cont.sessionId, handoff, "quiescing_source", "Waiting for the source worker's handoff signal and waiter shutdown.");
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
        supersedeContinuation(cont.id, cont.sessionId, `session is ${session.status}`);
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
        supersedeContinuation(claimed.id, claimed.sessionId, reason);
        outboxEvent ? config.dispatchOutbox?.markCompleted(claimOf(outboxEvent)) : undefined;
        return "completed";
      }

      if (claimed.verdict !== "changes_requested") {
        // Defensive: pending continuations should only be changes_requested.
        config.continuationManager.markCompleted(claimed.id);
        outboxEvent ? config.dispatchOutbox?.markCompleted(claimOf(outboxEvent)) : undefined;
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
        markContinuationDispatchFailed(outboxEvent, claimed, "Original ACP run not found");
        return "failed";
      }
      const missionPacket = config.missionLedger?.getPacket(claimed.sessionId);
      const preferredAgent = missionPacket?.workOrders[0]?.preferredAgent;
      const agentName = (typeof handoffPayload?.toAgent === "string" ? handoffPayload.toAgent : undefined)
        || preferredAgent
        || existingRun.agentName;
      const selection = await selectHealthyAgent(config.agentRegistry.listAlive(), {
        name: agentName,
        role: "agent",
        adapterSecret: config.adapterSecret,
      });
      if (!selection.agent) {
        if (handoff) recordHandoffState(cont.sessionId, handoff, "blocked", `No healthy registered destination agent named ${agentName}.`);
        // No healthy agent — release the claim so a later wakeup retries it
        // (the lease prevents it from being re-claimed too eagerly after a blip).
        config.continuationManager.release(dispatcherId, { id: claimed.id });
        outboxEvent
          ? config.dispatchOutbox?.release(claimOf(outboxEvent), DEFAULT_CLAIM_LEASE_MS, "No healthy agent available")
          : undefined;
        return "deferred";
      }

      // A handoff binds to the exact adapter identity selected by the
      // reviewer. If the name now resolves to a replacement registration,
      // do not silently route the immutable transfer packet to that identity;
      // require an explicit new handoff so the destination context is bound
      // and reviewed against the replacement adapter.
      const requestedDestinationId = typeof handoffPayload?.toAgentId === "string"
        ? handoffPayload.toAgentId
        : undefined;
      if (handoff && requestedDestinationId && requestedDestinationId !== selection.agent.id) {
        const detail = `Selected destination identity changed (expected ${requestedDestinationId}, found ${selection.agent.id}); a new handoff is required.`;
        recordHandoffState(cont.sessionId, handoff, "blocked", detail);
        config.continuationManager.release(dispatcherId, { id: claimed.id });
        outboxEvent
          ? config.dispatchOutbox?.release(claimOf(outboxEvent), DEFAULT_CLAIM_LEASE_MS, detail)
          : undefined;
        return "deferred";
      }

      const initialTransferPacket = handoffPayload?.toAgentId === selection.agent.id
        ? handoffPayload.contextTransferPacket as Record<string, unknown> | undefined
        : undefined;
      const transferId = typeof handoffPayload?.transferId === "string" && initialTransferPacket
        ? handoffPayload.transferId
        : undefined;
      const previousAttempt = config.agentRegistry.getLatestDispatchAttemptForRun(existingRun.runId);
      const previousAgentId = previousAttempt?.agentId ?? existingRun.agentId;
      const switchingAgent = Boolean(transferId && previousAgentId && previousAgentId !== selection.agent.id);
      const retryingKnownUnstartedTransfer = Boolean(
        transferId
        && previousAttempt?.agentId === selection.agent.id
        && previousAttempt.status === "unstarted",
      );
      const freshContextTransfer = switchingAgent || retryingKnownUnstartedTransfer;
      const liveSourceLease = Boolean(
        switchingAgent
        && !TERMINAL_STATUSES.has(existingRun.status)
        && existingRun.status !== "cancelling"
        && existingRun.workerLeaseUntil
        && Date.parse(existingRun.workerLeaseUntil) > Date.now(),
      );
      if (liveSourceLease && handoff) {
        recordHandoffState(cont.sessionId, handoff, "quiescing_source", "The source attempt still owns a live workspace lease.");
        config.continuationManager.release(dispatcherId, { id: claimed.id });
        outboxEvent
          ? config.dispatchOutbox?.release(claimOf(outboxEvent), DEFAULT_CLAIM_LEASE_MS, "Waiting for source worker quiescence")
          : undefined;
        return "deferred";
      }
      if (switchingAgent && handoff) {
        recordHandoffState(cont.sessionId, handoff, "quiescing_source", "Source worker quiescence is confirmed; destination preparation may proceed.");
      }
      const transferPacket = transferId && initialTransferPacket
        ? {
            ...initialTransferPacket,
            continuation: {
              continuationId: claimed.id,
              reviewEpoch: claimed.reviewEpoch,
              prompt: claimed.promptText,
            },
            priorWork: {
              ...(initialTransferPacket.priorWork as Record<string, unknown> | undefined),
              latestRunOutput: existingRun.outputPreview,
              latestSubmission: session.latestSubmission ? {
                submissionId: session.latestSubmission.id,
                message: session.latestSubmission.message,
                reviewEpoch: session.latestSubmission.reviewEpoch,
                files: session.latestSubmission.files,
                diffSha256: session.latestSubmission.diffSha256,
              } : undefined,
            },
            checkpoint: session.latestSubmission ? {
              submissionId: session.latestSubmission.id,
              snapshotKind: session.latestSubmission.snapshotKind,
              snapshotRef: session.latestSubmission.snapshotRef,
              reviewEpoch: session.latestSubmission.reviewEpoch,
            } : initialTransferPacket.checkpoint,
            latestReviewerFeedback: session.latestFeedback ? {
              feedbackId: session.latestFeedback.id,
              submissionId: session.latestFeedback.submissionId,
              verdict: session.latestFeedback.verdict,
              comments: session.latestFeedback.comments,
              requiredActions: session.latestFeedback.requiredActionsJson ? JSON.parse(session.latestFeedback.requiredActionsJson) : undefined,
              allowedNextActions: session.latestFeedback.allowedNextActionsJson ? JSON.parse(session.latestFeedback.allowedNextActionsJson) : undefined,
              reviewerId: session.latestFeedback.reviewerId,
              createdAt: session.latestFeedback.createdAt,
            } : initialTransferPacket.latestReviewerFeedback,
          }
        : undefined;
      const transferSha256 = transferPacket ? createHash("sha256").update(JSON.stringify(transferPacket)).digest("hex") : undefined;
      if (transferId && transferPacket && handoff) {
        config.eventStore.appendEvent({
          type: "session.handoff.context",
          sessionId: claimed.sessionId,
          payload: { transferId, contextTransferPacket: transferPacket, contextTransferSha256: transferSha256 },
        });
      }

      let requiresTransferReconciliation = false;
      try {
        const preDispatchSession = config.workSessions.get(claimed.sessionId);
        if (!preDispatchSession || DISPATCH_BLOCKED_SESSION_STATUSES.has(preDispatchSession.status)) {
          const reason = preDispatchSession ? `session is ${preDispatchSession.status}` : "session not found";
          supersedeContinuation(claimed.id, claimed.sessionId, reason);
          outboxEvent ? config.dispatchOutbox?.markCompleted(claimOf(outboxEvent)) : undefined;
          return "completed";
        }
        if (config.beforeContinuationDispatch) {
          await config.beforeContinuationDispatch(claimed, claimed.sessionId);
          const afterHookSession = config.workSessions.get(claimed.sessionId);
          if (!afterHookSession || DISPATCH_BLOCKED_SESSION_STATUSES.has(afterHookSession.status)) {
            const reason = afterHookSession ? `session is ${afterHookSession.status}` : "session not found";
            supersedeContinuation(claimed.id, claimed.sessionId, reason);
            outboxEvent ? config.dispatchOutbox?.markCompleted(claimOf(outboxEvent)) : undefined;
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
          result = await defaultResume(config, claimed, session, agentName, transferId && transferPacket && transferSha256
            ? { id: transferId, sha256: transferSha256, packet: transferPacket, fresh: freshContextTransfer }
            : undefined);
        }

        // callRemoteAgent() catches transport errors and returns status:"failed"
        // instead of throwing. Treat that as a failed dispatch so the claim is
        // RELEASED (not marked delivered) and a later wakeup retries it.
        if (result.status === "failed") {
          throw new Error(result.error ?? "ACP continuation dispatch failed");
        }
        if (transferId && result.status === "uncertain") {
          requiresTransferReconciliation = true;
          throw new Error("Cross-agent transfer dispatch is uncertain; reconcile the exact destination attempt before retrying.");
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
          if (transferId && handoff) {
            requiresTransferReconciliation = true;
            recordHandoffState(claimed.sessionId, handoff, "reconciliation_required", "Destination accepted work but the continuation delivery claim could not be committed.");
          }
          outboxEvent
            ? config.dispatchOutbox?.release(claimOf(outboxEvent), DEFAULT_CLAIM_LEASE_MS, "continuation delivery CAS failed")
            : undefined;
          return "deferred";
        }

        if (transferId && handoff) {
          recordHandoffState(claimed.sessionId, handoff, "destination_ready");
          recordHandoffState(claimed.sessionId, handoff, "committed");
          // The immutable transfer packet carries the latest reviewer feedback
          // into the destination's fresh provider session. Mark that feedback
          // consumed only after destination acceptance is durably recorded, so
          // its first await_review_feedback cannot replay the already delivered
          // changes_requested event as though it were round-two feedback.
          markTransferredFeedbackConsumed(claimed.sessionId, transferPacket);
        }

        // Publish after the continuation is delivered so subscribers react without
        // a poll, and ordering is: feedback -> continuation -> delivered event.
        config.eventStore.appendEvent({
          type: "continuation.delivered",
          sessionId: claimed.sessionId,
          payload: { continuationId: claimed.id, runId: result.runId, remoteRunId: result.remoteRunId, attemptNumber: result.attemptNumber },
        });
        outboxEvent ? config.dispatchOutbox?.markCompleted(claimOf(outboxEvent)) : undefined;
        return "completed";
      } catch (error) {
        // Availability failures release the logical outbox row with backoff;
        // only genuine failures consume the dead-letter budget.
        const reason = error instanceof Error ? error.message : String(error);
        if (requiresTransferReconciliation && transferId && handoff) {
          const latestAttempt = config.agentRegistry.getLatestDispatchAttemptForRun(existingRun.runId);
          const persisted = latestAttempt && config.continuationManager.markReconciliationRequired({
            id: claimed.id,
            claimOwner: dispatcherId,
            targetRunId: existingRun.runId,
            reason,
          });
          if (persisted) recordHandoffState(claimed.sessionId, handoff, "reconciliation_required", reason);
          if (outboxEvent) config.dispatchOutbox?.release(claimOf(outboxEvent), DEFAULT_CLAIM_LEASE_MS, reason);
          return "deferred";
        }
        config.continuationManager.release(dispatcherId, { id: claimed.id });
        if (transferId && handoff) recordHandoffState(claimed.sessionId, handoff, "blocked", reason);
        if (isTemporaryDispatchUnavailability(reason)) {
          outboxEvent
            ? config.dispatchOutbox?.release(claimOf(outboxEvent), DEFAULT_CLAIM_LEASE_MS, reason)
            : undefined;
          return "deferred";
        }
        markContinuationDispatchFailed(outboxEvent, claimed, reason || "ACP continuation dispatch failed");
        return "failed";
      }
  };

  try {
    await reconcileHandoffContinuations();
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
  } catch {
    // Swallow; next drain retries unclaimed continuations.
  }
}

function isTemporaryDispatchUnavailability(reason: string): boolean {
  return /no healthy (?:dispatchable )?agent|workspace (?:root|checkout|lease).*(?:leased|unavailable|conflict)|temporarily unavailable|resource unavailable|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up/i.test(reason);
}

export async function defaultResume(
  config: BridgeConfig,
  continuation: Continuation,
  session: { workspaceSessionId: string },
  agentName = "cli-coding-agent",
  contextTransfer?: { id: string; sha256: string; packet: Record<string, unknown>; fresh: boolean },
): Promise<AgentCallResult> {
  const previousLease = config.workSessions.getWorkspaceLeaseForSession(continuation.sessionId);
  const activePreviousLease = previousLease && Date.parse(previousLease.expiresAt) > Date.now() ? previousLease : undefined;
  const leaseConflict = await acquireCheckoutModifyLease(config, session.workspaceSessionId, continuation.sessionId, { takeover: true });
  if (leaseConflict) {
    throw new Error(leaseConflict.content[0]?.text ?? "Unable to acquire the workspace lease for this continuation.");
  }
  const takeoverLease = config.workSessions.getWorkspaceLeaseForSession(continuation.sessionId);
  const run = config.agentRegistry.getRunByWorkSessionId(continuation.sessionId);
  const agent = config.agentRegistry.listAlive().find((candidate) => candidate.name === agentName);
  const missionPrompt = renderMissionPrompt(config, continuation.sessionId, continuation.promptText);
  const task = [
    continuation.promptText,
    contextTransfer?.fresh
      ? `Immutable cross-agent context transfer (sha256 ${contextTransfer.sha256}):\n${JSON.stringify(contextTransfer.packet, null, 2)}`
      : undefined,
    missionPrompt,
    `Continue from review feedback. ${workSessionInstructions(continuation.sessionId, agent)}`,
  ].filter(Boolean).join("\n\n");
  try {
    const result = await callRemoteAgent(
      { agentRegistry: config.agentRegistry, workspaces: config.workspaces, workSessions: config.workSessions, eventStore: config.eventStore, adapterSecret: config.adapterSecret },
      {
      agentUrl: await resolveHealthyAgentUrl(config, agentName),
      agentName,
      agentId: agent?.id,
      task,
      workspaceSessionId: session.workspaceSessionId,
      workSessionId: continuation.sessionId,
      existingRunId: run?.runId,
      continuationId: continuation.id,
      ...(contextTransfer ? { contextTransfer } : {}),
      ...checkoutLeaseMetadata(config, continuation.sessionId),
      mode: "async",
      fireAndForget: true,
      },
    );
    if (result.status === "failed") {
      if (activePreviousLease && takeoverLease) config.workSessions.restoreWorkspaceLeaseForSession(activePreviousLease, takeoverLease.leaseNonce);
      else config.workSessions.releaseWorkspaceLeasesForSession(continuation.sessionId);
    }
    return result;
  } catch (error) {
    if (activePreviousLease && takeoverLease) config.workSessions.restoreWorkspaceLeaseForSession(activePreviousLease, takeoverLease.leaseNonce);
    else config.workSessions.releaseWorkspaceLeasesForSession(continuation.sessionId);
    throw error;
  }
}
