/**
 * Pure view classification helpers over WorkSessionViewState. Extracted
 * verbatim from ui/workspace-app.tsx (P1.4).
 */
import type { WorkSessionViewState } from "./workspace-app.js";
import { humanizeStatus } from "./ui-format.js";

export function sessionCategory(view: WorkSessionViewState): string {
  if (view.openMessages.size > 0 || view.unresolvedMessageCount > 0 || view.policyApprovals.size > 0 || view.pendingApprovalCount > 0) {
    return "Needs input";
  }
  if (["awaiting_review", "review_in_progress", "changes_requested"].includes(view.status)
    || ["awaiting_review", "review_in_progress", "changes_requested"].includes(view.lifecycle ?? "")) {
    return "Needs review";
  }
  if (["stale", "archived", "detached", "orphaned", "parked"].includes(view.runtimeState ?? "")
    || ["approved", "rejected", "cancelled", "failed", "failed_protocol"].includes(view.status)) {
    return "Historical";
  }
  return humanizeStatus(view.status);
}

export function relativeSessionAge(value: string): string {
  const ageMs = Math.max(0, Date.now() - Date.parse(value));
  if (!Number.isFinite(ageMs)) return "";
  if (ageMs < 60_000) return `${Math.max(1, Math.round(ageMs / 1000))}s ago`;
  if (ageMs < 60 * 60_000) return `${Math.round(ageMs / 60_000)}m ago`;
  return `${Math.round(ageMs / (60 * 60_000))}h ago`;
}

export function isLiveAgentSession(view: WorkSessionViewState): boolean {
  // A recent heartbeat alone is not proof that a worker still owns the live
  // lease. Review, queued, and parked states are intentionally reported as a
  // last heartbeat even when their underlying process has not exited yet.
  const activeStatuses = new Set(["in_progress", "resuming"]);
  const activeLifecycles = new Set(["running", "in_progress", "resuming"]);
  const heartbeatAge = view.lastHeartbeatAt ? Date.now() - Date.parse(view.lastHeartbeatAt) : Number.POSITIVE_INFINITY;
  return activeStatuses.has(view.status)
    && (!view.lifecycle || activeLifecycles.has(view.lifecycle))
    && view.runtimeState === "running"
    && Number.isFinite(heartbeatAge)
    && heartbeatAge >= 0
    && heartbeatAge <= 45_000;
}
