import type { EventStoreEvent } from "../event-log.js";
import type { ScheduledJobStatus } from "./scheduled-job-store.js";
import { workSessionTerminalOutcome } from "../work-session-lifecycle.js";

export interface ScheduledJobLifecycleProjection {
  nextStatus?: ScheduledJobStatus;
  finalWorkerOutcome?: "completed" | "failed" | "cancelled";
  lastError?: string;
  executionStarted?: boolean;
  executionPaused?: boolean;
  executionStopped?: boolean;
}

const ACTIVE_JOB_STATUSES = new Set<ScheduledJobStatus>([
  "dispatching",
  "running",
  "uncertain_dispatch",
  "awaiting_approval",
  "cancellation_requested",
  "operator_intervention",
]);

const WORKER_STOPPED_EVENTS = new Set([
  "agent.run.cancelled",
  "agent.run.completed",
  "agent.run.failed",
  "agent.run.failed_protocol",
  "worker.turn.completed",
  "worker.attempt.failed",
  "worker.attempt.exited",
]);

const EXECUTION_STOPPED_EVENTS = new Set([
  "agent.run.completed",
  "agent.run.approved",
  "agent.run.rejected",
  "agent.run.cancelled",
  "agent.run.failed",
  "agent.run.failed_protocol",
]);

const ATTEMPT_BOUND_EVENTS = new Set([
  ...WORKER_STOPPED_EVENTS,
]);

/**
 * Canonical event-to-job lifecycle mapping. A worker turn completing is not
 * review approval; only the review workflow's approved event completes a
 * review-required scheduled job.
 */
export function projectScheduledJobLifecycleEvent(
  currentStatus: ScheduledJobStatus,
  event: Pick<EventStoreEvent, "type" | "createdAt" | "payload">,
  cancellation?: { requestedAt?: string; previousStatus?: string },
  attempt?: { dispatchId?: string; runId?: string; attemptNumber?: number; remoteRunId?: string },
): ScheduledJobLifecycleProjection {
  if (!ACTIVE_JOB_STATUSES.has(currentStatus)) return {};

  // Event types can be replayed long after an ACP run resumes. Lifecycle
  // authority is bound to the currently persisted dispatch/run identity;
  // timestamps and event type alone never prove which worker stopped.
  const eventDispatchId = typeof event.payload.dispatchId === "string" ? event.payload.dispatchId : undefined;
  const eventRunId = typeof event.payload.runId === "string" ? event.payload.runId : undefined;
  const eventAttemptNumber = typeof event.payload.attemptNumber === "number" ? event.payload.attemptNumber : undefined;
  const eventRemoteRunId = typeof event.payload.remoteRunId === "string" ? event.payload.remoteRunId : undefined;
  const matchesCurrentAttempt = Boolean(attempt && (attempt.dispatchId || attempt.runId || attempt.attemptNumber || attempt.remoteRunId) && (
    (!attempt.runId || eventRunId === attempt.runId)
    && (!attempt.attemptNumber || eventAttemptNumber === attempt.attemptNumber || (!ATTEMPT_BOUND_EVENTS.has(event.type) && eventAttemptNumber === undefined))
    && (!attempt.dispatchId || eventDispatchId === attempt.dispatchId || (!ATTEMPT_BOUND_EVENTS.has(event.type) && !eventDispatchId))
    && (!attempt.remoteRunId || eventRemoteRunId === attempt.remoteRunId || (!ATTEMPT_BOUND_EVENTS.has(event.type) && !eventRemoteRunId))
  ));
  if (attempt && !matchesCurrentAttempt) return {};

  // An explicit cancellation intent fences later completion/approval events.
  // A worker-terminal event can confirm shutdown without turning a raced
  // completion or failure into success/failure after the reviewer cancelled.
  if (currentStatus === "cancellation_requested") {
    if (cancellation?.requestedAt && cancellation.previousStatus
      && Date.parse(event.createdAt) < Date.parse(cancellation.requestedAt)) {
      const earlier = projectScheduledJobLifecycleEvent(
        cancellation.previousStatus as ScheduledJobStatus,
        event,
        undefined,
        attempt,
      );
      if (earlier.finalWorkerOutcome) return { ...earlier, executionStopped: true };
    }
    if (!WORKER_STOPPED_EVENTS.has(event.type)) return {};
    return {
      nextStatus: "cancelled",
      finalWorkerOutcome: "cancelled",
      executionStopped: true,
      lastError: event.type === "agent.run.cancelled"
        ? "Scheduled worker cancellation confirmed."
        : `Cancellation completed after worker shutdown was confirmed by ${event.type}.`,
    };
  }

  if (event.type === "review.submitted") {
    return currentStatus === "running" || currentStatus === "operator_intervention"
      ? { nextStatus: "awaiting_approval", executionPaused: true }
      : {};
  }

  if (event.type === "agent.run.started") {
    if (currentStatus === "dispatching") return { nextStatus: "running", executionStarted: true };
    if (["running", "awaiting_approval", "uncertain_dispatch", "operator_intervention"].includes(currentStatus)) {
      return { ...(currentStatus === "running" ? {} : { nextStatus: "running" as const }), executionStarted: true };
    }
    return {};
  }

  // The worker turn ending only means the execution side has stopped. The
  // shared session lifecycle authority owns review-required terminal meaning.
  if (event.type === "agent.run.completed" || event.type === "worker.turn.completed"
    || event.type === "worker.attempt.failed" || event.type === "worker.attempt.exited") {
    return { executionPaused: true };
  }
  const terminal = workSessionTerminalOutcome(event.type, "webui_approval_required");

  if (terminal?.status === "approved") {
    return currentStatus === "awaiting_approval" || currentStatus === "operator_intervention"
      ? { nextStatus: "completed", finalWorkerOutcome: "completed", executionStopped: true }
      : {};
  }

  if (terminal?.status === "rejected") {
    return currentStatus === "awaiting_approval" || currentStatus === "running" || currentStatus === "operator_intervention"
      ? { nextStatus: "failed", finalWorkerOutcome: "failed", lastError: "Reviewer rejected the scheduled submission.", executionStopped: true }
      : {};
  }

  if (terminal?.status === "failed" || terminal?.status === "failed_protocol") {
    return currentStatus === "dispatching" || currentStatus === "running" || currentStatus === "awaiting_approval" || currentStatus === "uncertain_dispatch" || currentStatus === "operator_intervention"
      ? { nextStatus: "failed", finalWorkerOutcome: "failed", lastError: `Work session ended with ${event.type}.`, executionStopped: true }
      : {};
  }

  if (terminal?.status === "cancelled") {
    return { nextStatus: "cancelled", finalWorkerOutcome: "cancelled", lastError: "Scheduled worker cancelled.", executionStopped: true };
  }

  if (EXECUTION_STOPPED_EVENTS.has(event.type)) return { executionStopped: true };
  return {};
}
