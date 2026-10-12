import type { EventStoreEvent } from "../event-log.js";
import type { ScheduledJobStatus } from "./scheduled-job-store.js";
import { workSessionTerminalOutcome } from "../work-session-lifecycle.js";

export interface ScheduledJobLifecycleProjection {
  nextStatus?: ScheduledJobStatus;
  finalWorkerOutcome?: "completed" | "failed" | "cancelled";
  lastError?: string;
  executionStopped?: boolean;
}

const ACTIVE_JOB_STATUSES = new Set<ScheduledJobStatus>([
  "dispatching",
  "running",
  "uncertain_dispatch",
  "awaiting_approval",
  "cancellation_requested",
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
  "worker.turn.completed",
  "agent.run.completed",
  "agent.run.approved",
  "agent.run.rejected",
  "agent.run.cancelled",
  "agent.run.failed",
  "agent.run.failed_protocol",
]);

/**
 * Canonical event-to-job lifecycle mapping. A worker turn completing is not
 * review approval; only the review workflow's approved event completes a
 * review-required scheduled job.
 */
export function projectScheduledJobLifecycleEvent(
  currentStatus: ScheduledJobStatus,
  event: Pick<EventStoreEvent, "type" | "createdAt">,
  cancellation?: { requestedAt?: string; previousStatus?: string },
): ScheduledJobLifecycleProjection {
  if (!ACTIVE_JOB_STATUSES.has(currentStatus)) return {};

  // An explicit cancellation intent fences later completion/approval events.
  // A worker-terminal event can confirm shutdown without turning a raced
  // completion or failure into success/failure after the reviewer cancelled.
  if (currentStatus === "cancellation_requested") {
    if (cancellation?.requestedAt && cancellation.previousStatus
      && Date.parse(event.createdAt) < Date.parse(cancellation.requestedAt)) {
      const earlier = projectScheduledJobLifecycleEvent(
        cancellation.previousStatus as ScheduledJobStatus,
        event,
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
    return currentStatus === "running" ? { nextStatus: "awaiting_approval" } : {};
  }

  // The worker turn ending only means the execution side has stopped. The
  // shared session lifecycle authority owns review-required terminal meaning.
  if (event.type === "worker.turn.completed") return { executionStopped: true };
  const terminal = workSessionTerminalOutcome(event.type, "webui_approval_required");

  if (terminal?.status === "approved") {
    return currentStatus === "awaiting_approval"
      ? { nextStatus: "completed", finalWorkerOutcome: "completed", executionStopped: true }
      : {};
  }

  if (terminal?.status === "rejected") {
    return currentStatus === "awaiting_approval" || currentStatus === "running"
      ? { nextStatus: "failed", finalWorkerOutcome: "failed", lastError: "Reviewer rejected the scheduled submission.", executionStopped: true }
      : {};
  }

  if (terminal?.status === "failed" || terminal?.status === "failed_protocol") {
    return currentStatus === "running" || currentStatus === "awaiting_approval" || currentStatus === "uncertain_dispatch"
      ? { nextStatus: "failed", finalWorkerOutcome: "failed", lastError: `Work session ended with ${event.type}.`, executionStopped: true }
      : {};
  }

  if (terminal?.status === "cancelled") {
    return { nextStatus: "cancelled", finalWorkerOutcome: "cancelled", lastError: "Scheduled worker cancelled.", executionStopped: true };
  }

  if (EXECUTION_STOPPED_EVENTS.has(event.type)) return { executionStopped: true };
  return {};
}
