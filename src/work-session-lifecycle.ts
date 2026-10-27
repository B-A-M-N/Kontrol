export type WorkSessionCompletionPolicy = "agent_completion" | "webui_approval_required";

export interface WorkSessionTerminalOutcome {
  terminal: true;
  successful: boolean;
  status: "completed" | "approved" | "rejected" | "cancelled" | "failed" | "failed_protocol";
}

/**
 * Shared authority for deciding whether a lifecycle event ends a logical
 * work session. A worker turn completing does not pass a human review barrier.
 */
export function workSessionTerminalOutcome(
  eventType: string | undefined,
  completionPolicy: WorkSessionCompletionPolicy | undefined,
): WorkSessionTerminalOutcome | undefined {
  if (!eventType) return undefined;
  if (eventType === "agent.run.completed") {
    return completionPolicy === "webui_approval_required"
      ? undefined
      : { terminal: true, successful: true, status: "completed" };
  }
  if (eventType === "agent.run.approved") return { terminal: true, successful: true, status: "approved" };
  if (eventType === "agent.run.rejected") return { terminal: true, successful: false, status: "rejected" };
  if (eventType === "agent.run.cancelled") return { terminal: true, successful: false, status: "cancelled" };
  if (eventType === "agent.run.failed_protocol") return { terminal: true, successful: false, status: "failed_protocol" };
  if (eventType === "agent.run.failed") return { terminal: true, successful: false, status: "failed" };
  return undefined;
}
