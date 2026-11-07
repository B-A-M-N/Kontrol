/**
 * ACP continuation: resume the bound run against the destination agent.
 */
import { createHash } from "node:crypto";
import { callRemoteAgent, selectHealthyAgent } from "../acp-gateway.js";
import { deriveStableDispatchKey } from "./dispatch-identity.js";
import type { AgentCallResult } from "../acp-gateway.js";
import { DEFAULT_CLAIM_LEASE_MS } from "../continuation.js";
import type { Continuation } from "../continuation.js";
import type { DispatchOutboxEvent } from "../dispatch-outbox.js";
import { TERMINAL_STATUSES } from "../review-workflow.js";
import type { BridgeConfig } from "./context.js";
import { acquireCheckoutModifyLease, checkoutLeaseMetadata, renderMissionPrompt, resolveHealthyAgentUrl, workSessionInstructions } from "./shared.js";
import type { DispatchContext } from "./dispatch-context.js";
import { claimOf, markContinuationDispatchFailed, markTransferredFeedbackConsumed, recordHandoffState, supersedeContinuation } from "./dispatch-context.js";
import type { HandoffEvent } from "./dispatch-context.js";

const DISPATCH_BLOCKED_SESSION_STATUSES = new Set([...TERMINAL_STATUSES, "cancelling"]);


/** ACP continuation: resume the bound run against the destination agent. */

export function isTemporaryDispatchUnavailability(reason: string): boolean {
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
      dispatchIdempotencyKey: deriveStableDispatchKey(config.agentRegistry, run?.runId, {
        workSessionId: continuation.sessionId,
        intentId: continuation.id,
        feedbackEpoch: continuation.reviewEpoch,
        latestFeedbackId: continuation.feedbackEventId,
        agentId: agent?.id ?? agentName,
        task,
      }),
      continuationId: continuation.id,
      ...(contextTransfer ? { contextTransfer } : {}),
      ...checkoutLeaseMetadata(config, continuation.sessionId),
      mode: "async",
      fireAndForget: true,
      },
    );
    if (result.status === "failed") {
      if (activePreviousLease && takeoverLease) config.workSessions.restoreWorkspaceLeaseForSession(activePreviousLease, takeoverLease.leaseNonce);
      else config.workSessions.releaseUnfencedWorkspaceLeasesForSession(continuation.sessionId);
    }
    return result;
  } catch (error) {
    if (activePreviousLease && takeoverLease) config.workSessions.restoreWorkspaceLeaseForSession(activePreviousLease, takeoverLease.leaseNonce);
    else config.workSessions.releaseUnfencedWorkspaceLeasesForSession(continuation.sessionId);
    throw error;
  }
}

export async function dispatchAcpContinuation(
  ctx: DispatchContext,
  claimed: Continuation,
  cont: Continuation,
  handoff: HandoffEvent | undefined,
  outboxEvent?: DispatchOutboxEvent,
): Promise<"completed" | "deferred" | "failed"> {
      const handoffPayload = handoff?.payload as Record<string, unknown> | undefined;
      const existingRun = ctx.config.agentRegistry.getRunByWorkSessionId(claimed.sessionId);
      if (!existingRun) {
        ctx.config.continuationManager.release(ctx.dispatcherId, { id: claimed.id });
        ctx.config.eventStore.appendEvent({
          type: "continuation.dispatch_failed",
          sessionId: claimed.sessionId,
          payload: {
            continuationId: claimed.id,
            reason: "Original ACP run not found",
          },
        });
        markContinuationDispatchFailed(ctx.config, outboxEvent, claimed, "Original ACP run not found");
        return "failed";
      }
      const session = ctx.config.workSessions.get(claimed.sessionId);
      if (!session) {
        ctx.config.continuationManager.release(ctx.dispatcherId, { id: claimed.id });
        ctx.config.eventStore.appendEvent({
          type: "continuation.dispatch_failed",
          sessionId: claimed.sessionId,
          payload: { continuationId: claimed.id, reason: "Work session not found" },
        });
        markContinuationDispatchFailed(ctx.config, outboxEvent, claimed, "Work session not found");
        return "failed";
      }
      const missionPacket = ctx.config.missionLedger?.getPacket(claimed.sessionId);
      const preferredAgent = missionPacket?.workOrders[0]?.preferredAgent;
      const agentName = (typeof handoffPayload?.toAgent === "string" ? handoffPayload.toAgent : undefined)
        || preferredAgent
        || existingRun.agentName;
      const selection = await selectHealthyAgent(ctx.config.agentRegistry.listAlive(), {
        name: agentName,
        role: "agent",
        adapterSecret: ctx.config.adapterSecret,
      });
      if (!selection.agent) {
        if (handoff) recordHandoffState(ctx.config, cont.sessionId, handoff, "blocked", `No healthy registered destination agent named ${agentName}.`);
        // No healthy agent — release the claim so a later wakeup retries it
        // (the lease prevents it from being re-claimed too eagerly after a blip).
        ctx.config.continuationManager.release(ctx.dispatcherId, { id: claimed.id });
        outboxEvent
          ? ctx.config.dispatchOutbox?.release(claimOf(outboxEvent), DEFAULT_CLAIM_LEASE_MS, "No healthy agent available")
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
        recordHandoffState(ctx.config, cont.sessionId, handoff, "blocked", detail);
        ctx.config.continuationManager.release(ctx.dispatcherId, { id: claimed.id });
        outboxEvent
          ? ctx.config.dispatchOutbox?.release(claimOf(outboxEvent), DEFAULT_CLAIM_LEASE_MS, detail)
          : undefined;
        return "deferred";
      }

      const initialTransferPacket = handoffPayload?.toAgentId === selection.agent.id
        ? handoffPayload.contextTransferPacket as Record<string, unknown> | undefined
        : undefined;
      const transferId = typeof handoffPayload?.transferId === "string" && initialTransferPacket
        ? handoffPayload.transferId
        : undefined;
      const previousAttempt = ctx.config.agentRegistry.getLatestDispatchAttemptForRun(existingRun.runId);
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
        recordHandoffState(ctx.config, cont.sessionId, handoff, "quiescing_source", "The source attempt still owns a live workspace lease.");
        ctx.config.continuationManager.release(ctx.dispatcherId, { id: claimed.id });
        outboxEvent
          ? ctx.config.dispatchOutbox?.release(claimOf(outboxEvent), DEFAULT_CLAIM_LEASE_MS, "Waiting for source worker quiescence")
          : undefined;
        return "deferred";
      }
      if (switchingAgent && handoff) {
        recordHandoffState(ctx.config, cont.sessionId, handoff, "quiescing_source", "Source worker quiescence is confirmed; destination preparation may proceed.");
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
        ctx.config.eventStore.appendEvent({
          type: "session.handoff.context",
          sessionId: claimed.sessionId,
          payload: { transferId, contextTransferPacket: transferPacket, contextTransferSha256: transferSha256 },
        });
      }

      let requiresTransferReconciliation = false;
      try {
        const preDispatchSession = ctx.config.workSessions.get(claimed.sessionId);
        if (!preDispatchSession || DISPATCH_BLOCKED_SESSION_STATUSES.has(preDispatchSession.status)) {
          const reason = preDispatchSession ? `session is ${preDispatchSession.status}` : "session not found";
          supersedeContinuation(ctx.config, claimed.id, claimed.sessionId, reason);
          outboxEvent ? ctx.config.dispatchOutbox?.markCompleted(claimOf(outboxEvent)) : undefined;
          return "completed";
        }
        if (ctx.config.beforeContinuationDispatch) {
          await ctx.config.beforeContinuationDispatch(claimed, claimed.sessionId);
          const afterHookSession = ctx.config.workSessions.get(claimed.sessionId);
          if (!afterHookSession || DISPATCH_BLOCKED_SESSION_STATUSES.has(afterHookSession.status)) {
            const reason = afterHookSession ? `session is ${afterHookSession.status}` : "session not found";
            supersedeContinuation(ctx.config, claimed.id, claimed.sessionId, reason);
            outboxEvent ? ctx.config.dispatchOutbox?.markCompleted(claimOf(outboxEvent)) : undefined;
            return "completed";
          }
        }

        let result: AgentCallResult;
        if (ctx.config.resumeAgent) {
          // Test hook: treat a resolved hook as a successful dispatch. The real
          // run identity is unknown in this case, so fall back to the claimed
          // continuation id as the delivered-run marker.
          await ctx.config.resumeAgent(claimed, claimed.sessionId);
          result = { runId: claimed.id, agentName, attemptNumber: 1, status: "running", output: "" };
        } else {
          result = await defaultResume(ctx.config, claimed, session, agentName, transferId && transferPacket && transferSha256
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
        const delivered = ctx.config.continuationManager.markDelivered({
          id: claimed.id,
          expectedStatus: "claimed",
          claimOwner: ctx.dispatcherId,
          targetRunId: result.runId,
        });
        if (!delivered) {
          if (transferId && handoff) {
            requiresTransferReconciliation = true;
            recordHandoffState(ctx.config, claimed.sessionId, handoff, "reconciliation_required", "Destination accepted work but the continuation delivery claim could not be committed.");
          }
          outboxEvent
            ? ctx.config.dispatchOutbox?.release(claimOf(outboxEvent), DEFAULT_CLAIM_LEASE_MS, "continuation delivery CAS failed")
            : undefined;
          return "deferred";
        }

        if (transferId && handoff) {
          recordHandoffState(ctx.config, claimed.sessionId, handoff, "destination_ready");
          recordHandoffState(ctx.config, claimed.sessionId, handoff, "committed");
          // The immutable transfer packet carries the latest reviewer feedback
          // into the destination's fresh provider session. Mark that feedback
          // consumed only after destination acceptance is durably recorded, so
          // its first await_review_feedback cannot replay the already delivered
          // changes_requested event as though it were round-two feedback.
          markTransferredFeedbackConsumed(ctx.config, claimed.sessionId, transferPacket);
        }

        // Publish after the continuation is delivered so subscribers react without
        // a poll, and ordering is: feedback -> continuation -> delivered event.
        ctx.config.eventStore.appendEvent({
          type: "continuation.delivered",
          sessionId: claimed.sessionId,
          payload: { continuationId: claimed.id, runId: result.runId, remoteRunId: result.remoteRunId, attemptNumber: result.attemptNumber },
        });
        outboxEvent ? ctx.config.dispatchOutbox?.markCompleted(claimOf(outboxEvent)) : undefined;
        return "completed";
      } catch (error) {
        // Availability failures release the logical outbox row with backoff;
        // only genuine failures consume the dead-letter budget.
        const reason = error instanceof Error ? error.message : String(error);
        if (requiresTransferReconciliation && transferId && handoff) {
          const latestAttempt = ctx.config.agentRegistry.getLatestDispatchAttemptForRun(existingRun.runId);
          const persisted = latestAttempt && ctx.config.continuationManager.markReconciliationRequired({
            id: claimed.id,
            claimOwner: ctx.dispatcherId,
            targetRunId: existingRun.runId,
            reason,
          });
          if (persisted) recordHandoffState(ctx.config, claimed.sessionId, handoff, "reconciliation_required", reason);
          if (outboxEvent) ctx.config.dispatchOutbox?.release(claimOf(outboxEvent), DEFAULT_CLAIM_LEASE_MS, reason);
          return "deferred";
        }
        ctx.config.continuationManager.release(ctx.dispatcherId, { id: claimed.id });
        if (transferId && handoff) recordHandoffState(ctx.config, claimed.sessionId, handoff, "blocked", reason);
        if (isTemporaryDispatchUnavailability(reason)) {
          outboxEvent
            ? ctx.config.dispatchOutbox?.release(claimOf(outboxEvent), DEFAULT_CLAIM_LEASE_MS, reason)
            : undefined;
          return "deferred";
        }
        markContinuationDispatchFailed(ctx.config, outboxEvent, claimed, reason || "ACP continuation dispatch failed");
        return "failed";
      }
  }
