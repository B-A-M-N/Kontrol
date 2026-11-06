/**
 * Internal helpers shared by the work-session stores
 *
 * Extracted verbatim from work-sessions.ts (P1 god-object decomposition).
 * Row mappers and classification logic used by more than one store live here
 * so no store reaches into another store's module.
 */
import type {
  WorkSessionFeedback,
  WorkSessionLifecycle,
  WorkSessionRuntimeState,
  WorkSessionStatus,
  WorkSessionSubmission,
  SubmissionVerdict,
  ToolEvent,
  WorkspaceLease,
} from "./types.js";
import type {
  WorkspaceLeaseRow,
  WorkSessionSubmissionRow,
  WorkSessionFeedbackRow,
  WorkSessionToolEventRow,
} from "../db/schema.js";
import { normalizeWorkspaceSnapshotIdentity, type ReviewFile } from "../review-checkpoints.js";
import type { CheckpointCoverage } from "../checkpoint-coverage.js";
import { createHash } from "node:crypto";

export function rowToWorkspaceLease(row: WorkspaceLeaseRow): WorkspaceLease {
  return {
    canonicalRoot: row.canonicalRoot,
    workspaceSessionId: row.workspaceSessionId,
    workSessionId: row.workSessionId,
    leaseKind: row.leaseKind === "peer_job" ? "peer_job" : row.leaseKind === "cleanup_pending" ? "cleanup_pending" : "modify",
    durableRecovery: row.leaseKind === "peer_job" || row.leaseKind === "cleanup_pending",
    ownerInstanceId: row.ownerInstanceId,
    leaseNonce: row.leaseNonce,
    acquiredAt: row.acquiredAt,
    heartbeatAt: row.heartbeatAt,
    expiresAt: row.expiresAt,
  };
}

export function isTerminalStatus(status: WorkSessionStatus): boolean {
  return status === "approved" || status === "rejected" || status === "cancelled" || status === "failed" || status === "failed_protocol";
}

export function lifecycleForRuntimeState(status: WorkSessionStatus, runtimeState: WorkSessionRuntimeState): WorkSessionLifecycle {
  if (runtimeState === "archived") return "archived";
  if (status === "awaiting_review" || status === "review_in_progress" || runtimeState === "parked") return "awaiting_review";
  if (status === "changes_requested") return "resumable";
  if (runtimeState === "running") return "active_worker";
  if (runtimeState === "stale") return "stale";
  if (runtimeState === "detached" || runtimeState === "orphaned") return "detached";
  return "pending";
}

/** P1 #7: classify a work session into a lifecycle bucket for UI grouping. */
export function classifyLifecycle(
  status: WorkSessionStatus,
  updatedAt: string,
  hasLiveRun: boolean,
  hasRecentHeartbeat: boolean,
): WorkSessionLifecycle {
  if (isTerminalStatus(status)) return "archived";
  if (status === "awaiting_review") return "awaiting_review";
  if (status === "changes_requested") return "resumable";

  // in_progress / resuming / drafting etc.
  if (hasLiveRun && hasRecentHeartbeat) return "active_worker";
  if (!hasLiveRun && !hasRecentHeartbeat) {
    // P1 #7: stale threshold — no run, no heartbeat for >1h
    const ageMs = Date.now() - new Date(updatedAt).getTime();
    if (ageMs > STALE_THRESHOLD_MS) return "stale";
    return "detached";
  }
  return "pending";
}

export const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
export function rowToSubmission(row: WorkSessionSubmissionRow): WorkSessionSubmission {
  const snapshot = normalizeWorkspaceSnapshotIdentity({
    snapshotKind: row.snapshotKind,
    snapshotRef: row.snapshotRef,
    snapshotCommit: row.snapshotCommit,
  });
  return {
    id: row.id,
    workSessionId: row.workSessionId,
    submissionNumber: row.submissionNumber ?? 1,
    diff: row.diff ?? undefined,
    diffSha256: row.diffSha256 ?? undefined,
    snapshotKind: snapshot?.kind,
    snapshotRef: snapshot?.ref,
    snapshotCommit: snapshot?.ref,
    reviewEpoch: row.reviewEpoch ?? 1,
    message: row.message ?? undefined,
    summaryJson: row.summaryJson ?? undefined,
    files: parseReviewFiles(row.filesJson),
    coverage: parseCheckpointCoverage(row.coverageJson, row.coverageStatus),
    coverageStatus: row.coverageStatus ?? "unknown",
    status: (row.status as "pending" | "reviewed") ?? "pending",
    createdAt: row.createdAt,
  };
}

/** Parse a persisted coverage_json cell. A missing or malformed cell is an
 * explicit unknown assessment; it can never be treated as complete. */
export function parseCheckpointCoverage(value: string | null | undefined, persistedStatus?: string): CheckpointCoverage {
  const unknown = (errorCode = "coverage_record_unavailable"): CheckpointCoverage => ({
    status: "unknown",
    uncoveredPaths: [],
    backend: "unknown",
    reasons: ["Coverage classification is unavailable for this submission."],
    assessedAt: new Date().toISOString(),
    errorCode,
  });
  if (!value) return unknown();
  try {
    const parsed = JSON.parse(value) as Partial<CheckpointCoverage> | null;
    if (!parsed || typeof parsed !== "object") return unknown("coverage_record_malformed");
    if (!Array.isArray(parsed.uncoveredPaths) || !Array.isArray(parsed.reasons)) return unknown("coverage_record_malformed");
    const uncoveredPaths = parsed.uncoveredPaths.filter((p): p is string => typeof p === "string");
    const reasons = parsed.reasons.filter((r): r is string => typeof r === "string");
    const backend = parsed.backend === "git" || parsed.backend === "filesystem" ? parsed.backend : "unknown";
    const status = parsed.status === "complete" || parsed.status === "incomplete" || parsed.status === "unknown"
      ? parsed.status
      : "unknown";
    if (status !== persistedStatus && persistedStatus !== undefined) return unknown("coverage_status_mismatch");
    if ((status === "complete" || status === "incomplete") && backend === "unknown") return unknown("coverage_record_malformed");
    return {
      status,
      uncoveredPaths,
      backend,
      reasons,
      assessedAt: typeof parsed.assessedAt === "string" && Number.isFinite(Date.parse(parsed.assessedAt))
        ? parsed.assessedAt
        : new Date().toISOString(),
      ...(typeof parsed.errorCode === "string" && /^[A-Za-z0-9_:-]{1,80}$/.test(parsed.errorCode) ? { errorCode: parsed.errorCode } : {}),
    };
  } catch {
    return unknown("coverage_record_malformed");
  }
}

export function parseReviewFiles(value: string | null | undefined): ReviewFile[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const files = parsed.filter((file): file is ReviewFile => {
      if (!file || typeof file !== "object") return false;
      const candidate = file as Partial<ReviewFile>;
      return typeof candidate.path === "string"
        && typeof candidate.type === "string"
        && typeof candidate.additions === "number"
        && typeof candidate.removals === "number";
    });
    return files.length === parsed.length ? files : undefined;
  } catch {
    return undefined;
  }
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function rowToFeedback(row: WorkSessionFeedbackRow): WorkSessionFeedback {
  return {
    id: row.id,
    workSessionId: row.workSessionId,
    submissionId: row.submissionId,
    verdict: row.verdict as SubmissionVerdict,
    comments: row.comments ?? undefined,
    filesJson: row.filesJson ?? undefined,
    requiredActionsJson: row.requiredActionsJson ?? undefined,
    allowedNextActionsJson: row.allowedNextActionsJson ?? undefined,
    reviewerId: row.reviewerId ?? undefined,
    completionReportSha256: row.completionReportSha256 ?? undefined,
    createdAt: row.createdAt,
  };
}

export function rowToToolEvent(row: WorkSessionToolEventRow): ToolEvent {
  return {
    id: row.id,
    workSessionId: row.workSessionId,
    workspaceSessionId: row.workspaceSessionId ?? undefined,
    tool: row.tool,
    inputJson: row.inputJson,
    outputSummary: row.outputSummary ?? undefined,
    path: row.path ?? undefined,
    success: row.success === 1,
    elapsedMs: row.elapsedMs ?? 0,
    createdAt: row.createdAt,
  };
}
