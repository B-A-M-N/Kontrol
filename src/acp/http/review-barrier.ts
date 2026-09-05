/**
 * Review barrier: the completion rule for finished worker turns.
 *
 * Extracted verbatim from acp-server.ts's createAcpServer closure (P1
 * decomposition). A zero exit code is NOT approval — the work session's
 * durable state decides what the exit means. Shared by run-routes
 * (cancellation/resume) and event-routes (adapter lifecycle events).
 */
import { createHash } from "node:crypto";
import type { AcpContext } from "./context.js";

export function makeReviewBarrier(ctx: AcpContext) {
  const { workspaces, workSessions, agentRegistry, eventStore, reviewCheckpoints, reviewWorkflow } = ctx;

  // Session statuses after which a fresh `failed`/`completed` event must not
  // overwrite the logical outcome (the reviewer's verdict is authoritative).
  const TERMINAL_SESSION_STATUSES = new Set([
    "approved",
    "rejected",
    "cancelled",
    "failed",
    "failed_protocol",
  ]);

  // A zero exit code is NOT approval. Inspect the work session to decide what the
  // exit actually means (P0 #13 completion rule).
  async function submitReviewBarrierForCompletedTurn(runId: string, workSessionId: string): Promise<boolean> {
    if (!reviewCheckpoints || !reviewWorkflow) return false;
    const session = workSessions.get(workSessionId);
    if (!session) return false;
    let root: string;
    try {
      root = workspaces.getWorkspace(session.workspaceSessionId).root;
    } catch {
      return false;
    }
    const review = await reviewCheckpoints.reviewChanges({
      workspaceId: session.workspaceSessionId,
      root,
      since: "work_session",
      workSessionId,
      markReviewed: false,
    });
    const submitted = reviewWorkflow.submitForReview({
      workSessionId,
      diff: review.patch,
      diffSha256: createHash("sha256").update(review.patch).digest("hex"),
      snapshotKind: review.snapshotKind,
      snapshotRef: review.snapshotRef,
      snapshotCommit: review.snapshotCommit,
      message: review.result,
      summaryJson: JSON.stringify(review.summary),
      files: review.summary.files,
      changedFiles: review.files,
      additions: review.summary.additions,
      removals: review.summary.removals,
    });
    // The native path can return immediately after a continuation. Defend
    // against a stale `changes_requested` status surviving that resubmission:
    // a fresh pending submission is authoritative. Do not overwrite feedback
    // that has already been committed for this exact new submission.
    const postSubmit = workSessions.get(workSessionId);
    if (
      postSubmit?.latestSubmission?.id === submitted.submissionId
      && postSubmit.status !== "awaiting_review"
      && postSubmit.latestFeedback?.submissionId !== submitted.submissionId
    ) {
      workSessions.updateStatus(workSessionId, "awaiting_review");
    }
    if (review.snapshot && typeof reviewCheckpoints.commitReviewedSnapshot === "function") {
      await reviewCheckpoints.commitReviewedSnapshot({ workspaceId: session.workspaceSessionId, root, workSessionId, snapshot: review.snapshot });
    } else {
      await reviewCheckpoints.commitReviewed({ workspaceId: session.workspaceSessionId, root, workSessionId, snapshotCommit: review.snapshotCommit });
    }
    agentRegistry.updateRun(runId, {
      status: "awaiting_review",
      finishedAt: new Date().toISOString(),
      workerLeaseUntil: null,
    });
    eventStore?.appendEvent({
      type: "worker.turn.completed_review_submitted",
      sessionId: workSessionId,
      payload: { runId, submissionId: submitted.submissionId, submissionNumber: submitted.submissionNumber },
    });
    return true;
  }

  async function evaluateCompletion(runId: string, workSessionId: string): Promise<void> {
    const session = workSessions.get(workSessionId);
    if (!session) return;
    if (session.completionPolicy !== "webui_approval_required") {
      agentRegistry.updateRun(runId, { status: "completed", finishedAt: new Date().toISOString() });
      return;
    }

    // A zero-exit (`completed`) event means the worker process ended. What that
    // MEANS depends entirely on the work-session state — the durable Ralphie
    // table. A zero exit is NOT approval and is NOT automatically a protocol
    // failure; only specific state combinations are.
    switch (session.status) {
      case "approved":
        agentRegistry.updateRun(runId, { status: "approved", finishedAt: new Date().toISOString() });
        break;
      case "rejected":
        agentRegistry.updateRun(runId, { status: "rejected", finishedAt: new Date().toISOString() });
        break;
      case "awaiting_review":
        // The worker exited AFTER submitting, but BEFORE the reviewer responded.
        // The durable review remains OPEN and the reviewer's verdict is still the
        // only completion criterion — so do NOT destroy the session. Mark the
        // worker attempt detached (resumable) and stop; no terminal agent.run.*
        // event is emitted here.
        agentRegistry.updateRun(runId, {
          status: "awaiting_review",
          finishedAt: new Date().toISOString(),
          workerLeaseUntil: null,
        });
        eventStore?.appendEvent({
          type: "worker.attempt.exited",
          sessionId: workSessionId,
          payload: { runId, resumable: true, reason: "worker exited after submitting review" },
        });
        break;
      case "changes_requested":
        // Native ACP continuations also return as bounded turns. Capture their
        // new exact snapshot before leaving changes_requested; otherwise a
        // successful Hermes correction can never re-enter verification.
        if (await submitReviewBarrierForCompletedTurn(runId, workSessionId)) break;
        agentRegistry.updateRun(runId, { status: "changes_requested", finishedAt: new Date().toISOString() });
        break;
      case "in_progress":
      case "resuming":
        // Native ACP agents are supervised from the outside: when a turn ends,
        // Kontrol owns the review barrier. Capture the current diff and create
        // the review submission instead of requiring the agent to call
        // submit_for_review/await_review_feedback itself.
        if (await submitReviewBarrierForCompletedTurn(runId, workSessionId)) break;
        workSessions.updateStatus(workSessionId, "failed_protocol");
        agentRegistry.updateRun(runId, { status: "failed_protocol", finishedAt: new Date().toISOString() });
        eventStore?.appendEvent({
          type: "agent.run.failed_protocol",
          sessionId: workSessionId,
          payload: { runId, reason: `agent exited zero while session was ${session.status} and Kontrol could not create a review barrier` },
        });
        break;
      default:
        // Anything else (cancelled, failed, failed_protocol, or an unexpected
        // state) is left as-is; a terminal state is never overwritten.
        break;
    }
  }

  return { TERMINAL_SESSION_STATUSES, submitReviewBarrierForCompletedTurn, evaluateCompletion };
}
