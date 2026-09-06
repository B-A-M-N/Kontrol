/**
 * Pure formatting helpers shared by the workspace app surfaces. Extracted
 * verbatim from ui/workspace-app.tsx (P1.4).
 */
export function humanizeStatus(status: string): string {
  const labels: Record<string, string> = {
    in_progress: "Working",
    awaiting_review: "Awaiting review",
    review_in_progress: "In review",
    changes_requested: "Changes requested",
    continuation_queued: "Resume queued",
    awaiting_resume: "Awaiting resume",
    resuming: "Resuming",
    approved: "Approved",
    rejected: "Rejected",
    cancelled: "Cancelled",
    cancelling: "Cancelling",
    failed: "Failed",
    failed_protocol: "Protocol failure",
    stale: "Historical",
    archived: "Archived",
  };
  return labels[status] ?? status.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return "<1s";
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
