/**
 * Scheduled peer-pull continuation: follow-up peer jobs bound to the work session.
 */
import { createHash } from "node:crypto";
import { DEFAULT_CLAIM_LEASE_MS } from "../continuation.js";
import type { Continuation } from "../continuation.js";
import type { DispatchOutboxEvent } from "../dispatch-outbox.js";
import { getPeerJobStore } from "../peer/jobs/store.js";
import { MAX_INSTRUCTION_BYTES } from "../peer/jobs/service.js";
import { scheduledPeerContinuationJobId } from "../scheduling/scheduled-job-dispatch.js";
import type { DispatchContext } from "./dispatch-context.js";
import { claimOf, markContinuationDispatchFailed } from "./dispatch-context.js";


/** Scheduled peer-pull continuation: follow-up peer jobs bound to the work session. */

export async function tryDispatchPeerContinuation(
  ctx: DispatchContext,
  claimed: Continuation,
  outboxEvent?: DispatchOutboxEvent,
): Promise<{ handled: true; outcome: "completed" | "deferred" | "failed" } | { handled: false }> {
      const scheduledPeer = ctx.config.scheduledJobs?.getByWorkSessionId(claimed.sessionId);
      if (scheduledPeer?.dispatchTarget.kind === "peer_pull") {
        const peerStore = getPeerJobStore();
        const peerJobId = scheduledPeerContinuationJobId(claimed.id);
        const scheduledAttempt = scheduledPeer.activeDispatchAttemptId
          ? ctx.config.scheduledJobs?.getAttempt(scheduledPeer.id, scheduledPeer.activeDispatchAttemptId)
          : undefined;
        const session = ctx.config.workSessions.get(claimed.sessionId);
        const latestFeedback = ctx.config.workSessions.getLatestFeedback(claimed.sessionId);
        const feedbackEvent = ctx.config.eventStore.getEventById(claimed.feedbackEventId);
        if (!peerStore || !scheduledAttempt || !session || session.status !== "changes_requested" && session.status !== "resuming"
          || scheduledPeer.workSessionId !== claimed.sessionId
          || !latestFeedback || latestFeedback.id !== claimed.reviewId || latestFeedback.verdict !== "changes_requested"
          || !feedbackEvent || feedbackEvent.type !== "review.feedback.provided"
          || feedbackEvent.sessionId !== claimed.sessionId
          || feedbackEvent.payload.feedbackId !== claimed.reviewId
          || feedbackEvent.payload.submissionId === undefined
          || feedbackEvent.payload.verdict !== "changes_requested") {
          const reason = "Peer continuation is missing its durable store, work session, or exact authenticated feedback event.";
          ctx.config.continuationManager.release(ctx.dispatcherId, { id: claimed.id });
          ctx.config.eventStore.appendEvent({ type: "continuation.dispatch_failed", sessionId: claimed.sessionId, payload: { continuationId: claimed.id, reason } });
          markContinuationDispatchFailed(ctx.config, outboxEvent, claimed, reason);
          return { handled: true, outcome: "failed" };
        }
        const prior = peerStore.getLatestJobForWorkSession(scheduledPeer.dispatchTarget.peerId, claimed.sessionId, peerJobId);
        const existingPeerContinuation = peerStore.getJob(peerJobId);
        let peerJob = existingPeerContinuation;
        if (peerJob) {
          const priorReview = prior?.resultProcessing;
          const priorSubmission = priorReview?.submissionId
            ? ctx.config.workSessions.getSubmissions(claimed.sessionId).find((candidate) => candidate.id === priorReview.submissionId)
            : undefined;
          if (peerJob.peerId !== scheduledPeer.dispatchTarget.peerId
            || peerJob.workSessionId !== claimed.sessionId
            || peerJob.workspaceSessionId !== scheduledPeer.projectId
            || peerJob.schedulerDispatchId !== scheduledAttempt.dispatchId
            || prior?.status !== "review_changes_requested"
            || prior.schedulerDispatchId !== scheduledAttempt.dispatchId
            || priorReview?.reviewVerdict !== "changes_requested"
            || priorReview.feedbackId !== claimed.reviewId
            || priorReview.reviewEpoch !== claimed.reviewEpoch
            || priorReview.diffSha256 !== claimed.reviewedDiffHash
            || feedbackEvent.payload.submissionId !== priorReview.submissionId
            || feedbackEvent.payload.reviewedDiffHash !== priorReview.diffSha256
            || priorSubmission?.diffSha256 !== priorReview.diffSha256
            || priorSubmission?.snapshotKind !== priorReview.snapshotKind
            || priorSubmission?.snapshotRef !== priorReview.snapshotRef
            || !peerJob.instructions.includes(claimed.promptText)) {
            const reason = "The deterministic peer continuation does not match the exact authenticated feedback and reviewed snapshot.";
            ctx.config.continuationManager.release(ctx.dispatcherId, { id: claimed.id });
            ctx.config.eventStore.appendEvent({ type: "continuation.dispatch_failed", sessionId: claimed.sessionId, payload: { continuationId: claimed.id, reason } });
            markContinuationDispatchFailed(ctx.config, outboxEvent, claimed, reason);
            return { handled: true, outcome: "failed" };
          }
        } else {
          const processing = prior?.resultProcessing;
          const submission = processing?.submissionId
            ? ctx.config.workSessions.getSubmissions(claimed.sessionId).find((candidate) => candidate.id === processing.submissionId)
            : undefined;
          const changedPaths = submission?.files?.map((file) => file.path) ?? [];
          const outputsPermitSnapshot = changedPaths.length > 0 && changedPaths.every((path) => prior!.allowedOutputs.some((output) =>
            output === "*" || path === output || path.startsWith(`${output}/`),
          ));
          const exactPriorReview = prior?.status === "review_changes_requested"
            && prior.schedulerDispatchId === scheduledAttempt.dispatchId
            && prior.resultProcessing?.reviewVerdict === "changes_requested"
            && prior.resultProcessing.feedbackId === claimed.reviewId
            && prior.resultProcessing.reviewEpoch === claimed.reviewEpoch
            && prior.resultProcessing.diffSha256 === claimed.reviewedDiffHash
            && feedbackEvent.payload.submissionId === prior.resultProcessing.submissionId
            && feedbackEvent.payload.reviewedDiffHash === prior.resultProcessing.diffSha256
            && submission?.diffSha256 === prior.resultProcessing.diffSha256
            && submission?.snapshotKind === prior.resultProcessing.snapshotKind
            && submission?.snapshotRef === prior.resultProcessing.snapshotRef
            && outputsPermitSnapshot;
          if (!prior || !submission || !exactPriorReview) {
            const reason = "No exact peer result and snapshot match the authenticated changes-requested feedback; follow-up dispatch is fenced.";
            ctx.config.continuationManager.release(ctx.dispatcherId, { id: claimed.id });
            ctx.config.eventStore.appendEvent({ type: "continuation.dispatch_failed", sessionId: claimed.sessionId, payload: { continuationId: claimed.id, reason } });
            markContinuationDispatchFailed(ctx.config, outboxEvent, claimed, reason);
            return { handled: true, outcome: "failed" };
          }
          const instructions = [
            "Continue the existing scheduled peer task in the same logical work session.",
            `Original task:\n${prior.instructions}`,
            `Reviewer continuation:\n${claimed.promptText}`,
            `Exact prior checkpoint: ${submission.snapshotKind}:${submission.snapshotRef}`,
            `Prior submission SHA-256: ${submission.diffSha256}`,
            `Prior submission patch (context only; the exact changed paths are already listed below):\n${submission.diff ?? "[patch unavailable]"}`,
            `Return the complete final contents for every listed changed path: ${changedPaths.join(", ")}.`,
            "Do not add output paths or alter files outside the existing peer job's allowedOutputs.",
          ].join("\n\n");
          if (Buffer.byteLength(instructions, "utf8") > MAX_INSTRUCTION_BYTES) {
            const reason = "The exact reviewed patch and continuation exceed the peer instruction limit; a bounded peer continuation cannot be created.";
            ctx.config.continuationManager.release(ctx.dispatcherId, { id: claimed.id });
            ctx.config.eventStore.appendEvent({ type: "continuation.dispatch_failed", sessionId: claimed.sessionId, payload: { continuationId: claimed.id, reason } });
            markContinuationDispatchFailed(ctx.config, outboxEvent, claimed, reason);
            return { handled: true, outcome: "failed" };
          }
          try {
            peerJob = peerStore.createJob({
              jobId: peerJobId,
              peerId: prior.peerId,
              workSessionId: prior.workSessionId,
              workspaceSessionId: prior.workspaceSessionId,
              schedulerDispatchId: scheduledAttempt.dispatchId,
              repositoryId: prior.repositoryId,
              baseRevision: prior.baseRevision,
              taskClass: prior.taskClass,
              instructionHash: createHash("sha256").update(instructions).digest("hex"),
              instructions,
              allowedOutputs: prior.allowedOutputs,
              maxRuntimeMs: prior.maxRuntimeMs,
              maxArtifactBytes: prior.maxArtifactBytes,
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            ctx.config.continuationManager.release(ctx.dispatcherId, { id: claimed.id });
            ctx.config.eventStore.appendEvent({ type: "continuation.dispatch_failed", sessionId: claimed.sessionId, payload: { continuationId: claimed.id, reason } });
            markContinuationDispatchFailed(ctx.config, outboxEvent, claimed, reason);
            return { handled: true, outcome: "failed" };
          }
        }
        const delivered = ctx.config.continuationManager.markDelivered({
          id: claimed.id,
          expectedStatus: "claimed",
          claimOwner: ctx.dispatcherId,
          targetRunId: `peer:${peerJob.jobId}`,
        });
        if (!delivered) {
          outboxEvent
            ? ctx.config.dispatchOutbox?.release(claimOf(outboxEvent), DEFAULT_CLAIM_LEASE_MS, "peer continuation delivery CAS failed")
            : undefined;
          return { handled: true, outcome: "deferred" };
        }
        ctx.config.workSessions.markFeedbackConsumed(claimed.sessionId, claimed.reviewId);
        ctx.config.eventStore.appendEvent({
          type: "continuation.delivered",
          sessionId: claimed.sessionId,
          payload: { continuationId: claimed.id, transport: "peer_pull", peerJobId: peerJob.jobId, peerId: peerJob.peerId },
        });
        outboxEvent ? ctx.config.dispatchOutbox?.markCompleted(claimOf(outboxEvent)) : undefined;
        return { handled: true, outcome: "completed" };
      }

  return { handled: false };
}
