/**
 * Workspace-event reduction: routes each durable workspace event onto the
 * owning session view (or the workspace approval center) and mutates the
 * session projection accordingly. Extracted verbatim from
 * ui/workspace-app.tsx (P1.4); the active-workspace cell and the
 * outcome-unknown memory are reached through an explicit host binding.
 */
import { approvalCenterId } from "./approval-center.js";
import { noteSubmission, workSessionViews } from "./session-views.js";
import { parsePolicyApprovalOptions } from "./review-feedback.js";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getStructuredContent } from "./server-tool-call.js";
import type {
  AgentActivityEvent,
  ReviewSubmissionView,
  WorkSessionViewState,
} from "./session-view-types.js";

export interface ReducerHost {
  getApp(): App | null;
  refreshMission(view: WorkSessionViewState): Promise<void>;
  callServerToolChecked(request: { name: string; arguments: Record<string, unknown> }): Promise<CallToolResult>;
  getActiveWorkspaceId(): string | null;
  messageMutationOutcomeUnknown: Set<string>;
  render(): void;
  setErrorMessage(v: string | null): void;
}

let host: ReducerHost;
export function setReducerHost(next: ReducerHost): void {
  host = next;
}

export function workspaceEventTargetSessionId(event: AgentActivityEvent): string {
  const isApprovalEvent = event.type === "policy.approval_requested"
    || event.type === "approval.requested"
    || event.type === "policy.approval.provided"
    || event.type === "approval.resolved";
  const eventWorkSessionId = typeof event.payload?.workSessionId === "string"
    ? event.payload.workSessionId
    : undefined;
  // Direct approvals have no work-session authority. Keep them in the
  // workspace-scoped approval center (P0.4) even when another work session is
  // selected; fall back to the watcher's workspace since the event itself
  // only carries its own workspaceSessionId.
  if (eventWorkSessionId) return eventWorkSessionId;
  if (isApprovalEvent) return approvalCenterId(event.workspaceSessionId ?? host.getActiveWorkspaceId() ?? "");
  return event.sessionId;
}


export function reduceWorkSessionEvent(sessionId: string, event: AgentActivityEvent): void {
  const view = workSessionViews.get(sessionId);
  if (!view) return;
  // The server's snapshot+cursor handoff and reconnects are deliberately
  // idempotent. Never duplicate an already-applied durable event if a host
  // retries a tool call or returns an overlapping page.
  if (event.seq > 0 && event.seq <= view.lastSeq) return;
  view.lastSeq = Math.max(view.lastSeq, event.seq);

  // Heartbeats are connection health, not user activity. Keep the timestamp
  // available to the status surface without filling the primary timeline.
  if (event.type === "agent.run.heartbeat") {
    view.lastHeartbeatAt = event.createdAt;
    return;
  }
  view.updatedAt = event.createdAt;

  // Coalesce adjacent transcript fragments so a fast agent does not turn each
  // 250ms flush into a separate visible activity row.
  const previous = view.activity.at(-1);
  if (previous && previous.type === event.type && (event.type === "agent.run.output_delta" || event.type === "agent.run.thought_delta")) {
    previous.payload = {
      ...previous.payload,
      text: `${String(previous.payload?.text ?? "")}${String(event.payload?.text ?? "")}`.slice(-4000),
    };
    previous.createdAt = event.createdAt;
  } else {
    view.activity.push(event);
    if (view.activity.length > 200) view.activity.shift();
  }

  if (event.type === "review.submitted") {
    const submissionId = String(event.payload?.submissionId ?? "");
    view.status = "awaiting_review";
    void host.refreshMission(view);
    // Auto-fetch the full submission card from the agent's submit_for_review
    // invocation (which occurred in CRUSH's MCP connection, not this iframe).
    if (submissionId && host.getApp()) {
      // Install an immediate placeholder so a newer review cannot be hidden
      // behind a slow detail fetch. The async response below is still guarded
      // by the same (reviewEpoch, submissionNumber) authority tuple.
      noteSubmission(view, {
        submissionId,
        sessionId,
        submissionNumber: Number(event.payload?.submissionNumber ?? 0),
        reviewEpoch: typeof event.payload?.reviewEpoch === "number" ? event.payload.reviewEpoch : undefined,
        status: "pending",
        files: [],
        patch: "",
        fileCount: 0,
        additions: Number(event.payload?.additions ?? 0),
        removals: Number(event.payload?.removals ?? 0),
        diffSha256: typeof event.payload?.diffSha256 === "string" ? event.payload.diffSha256 : undefined,
      });
      void host.callServerToolChecked({ name: "get_review_submission", arguments: { sessionId, submissionId } })
        .then((res) => {
          const sc = getStructuredContent<{
            submissionId: string;
            status: string;
            files: ReviewSubmissionView["files"];
            fileCount: number;
            patch: string;
            additions: number;
            removals: number;
            submissionNumber: number;
            diffSha256?: string;
            reviewEpoch?: number;
          } & { summary?: ReviewSubmissionView }>(res);
          if (!sc) return;
          const card = (res as { _meta?: { card?: { summary?: ReviewSubmissionView; files?: ReviewSubmissionView["files"]; payload?: { patch: string } } } })._meta?.card;
          const view2 = workSessionViews.get(sessionId);
          if (!view2) return;
          const fetchedSubmission: ReviewSubmissionView = {
            submissionId,
            sessionId,
            submissionNumber: Number(event.payload?.submissionNumber ?? sc.submissionNumber ?? 0),
            reviewEpoch: typeof card?.summary?.reviewEpoch === "number"
              ? card.summary.reviewEpoch
              : typeof sc.reviewEpoch === "number" ? sc.reviewEpoch : undefined,
            status: sc.status,
            files: sc.files ?? card?.files ?? [],
            patch: sc.patch ?? card?.payload?.patch ?? "",
            fileCount: Number(sc.fileCount ?? sc.files?.length ?? card?.files?.length ?? 0),
            additions: card?.summary?.additions ?? sc.additions ?? 0,
            removals: card?.summary?.removals ?? sc.removals ?? 0,
            message: card?.summary?.message,
            diffSha256: typeof card?.summary?.diffSha256 === "string"
              ? card.summary.diffSha256
              : typeof sc.diffSha256 === "string" ? sc.diffSha256 : undefined,
            coverage: card?.summary?.coverage
              ?? (typeof (sc as { coverage?: ReviewSubmissionView["coverage"] }).coverage === "object"
                ? (sc as { coverage?: ReviewSubmissionView["coverage"] }).coverage
                : undefined),
          };
          noteSubmission(view2, fetchedSubmission);
          host.render();
        })
        .catch((err) => {
          // P1 #11: surface the failure to load submission details rather than
          // silently leaving a blank card (which would mask a worker/transport
          // failure).
          const failedView = workSessionViews.get(sessionId);
          if (failedView) {
            failedView.notice = {
              tone: "error",
              message: "Failed to load submission details: " + (err instanceof Error ? err.message : String(err)),
            };
          } else {
            host.setErrorMessage("Failed to load submission details: " + (err instanceof Error ? err.message : String(err)));
          }
          host.render();
        });
    }
  } else if (event.type === "review.feedback.provided") {
    const sid = String(event.payload?.submissionId ?? view.activeSubmissionId ?? "");
    if (sid && view.submissions.has(sid)) view.feedbackStateBySubmission.set(sid, "submitted");
    const verdict = String(event.payload?.verdict ?? "");
    if (verdict === "changes_requested") view.status = "changes_requested";
    else if (verdict === "approve") view.status = "approved";
    else if (verdict === "reject") view.status = "rejected";
    view.feedbackMessage = "Feedback submitted. The waiting agent has been notified.";
  } else if (event.type === "continuation.created") {
    view.status = "continuation_queued";
  } else if (event.type === "continuation.delivered") {
    view.status = "resuming";
  } else if (event.type === "continuation.superseded") {
    view.status = "awaiting_resume";
  } else if (event.type === "worker.attempt.failed" || event.type === "worker.attempt.exited") {
    view.status = "awaiting_resume";
  } else if (event.type === "agent.run.failed_protocol") {
    view.status = "failed_protocol";
  } else if (event.type === "agent.run.approved") {
    view.status = "approved";
  } else if (event.type === "agent.run.rejected") {
    view.status = "rejected";
  } else if (event.type === "agent.run.cancellation_requested") {
    view.status = "cancelling";
  } else if (event.type === "agent.run.failed" || event.type === "agent.run.cancelled") {
    view.status = event.type === "agent.run.failed" ? "failed" : "cancelled";
  } else if (event.type === "policy.approval_requested" || event.type === "approval.requested") {
    const approvalId = String(event.payload?.approvalId ?? "");
    if (approvalId) {
      view.policyApprovals.set(approvalId, {
        approvalId,
        workspaceId: typeof event.payload?.workspaceId === "string" ? event.payload.workspaceId : undefined,
        workSessionId: typeof event.payload?.workSessionId === "string" ? event.payload.workSessionId : undefined,
        tool: String(event.payload?.tool ?? "tool"),
        path: typeof event.payload?.path === "string" ? event.payload.path : undefined,
        command: typeof event.payload?.command === "string" ? event.payload.command : undefined,
        approvalKey: typeof event.payload?.approvalKey === "string" ? event.payload.approvalKey : undefined,
        matchedPattern: typeof event.payload?.matchedPattern === "string" ? event.payload.matchedPattern : undefined,
        origin: event.payload?.origin === "work_session" ? "work_session" : "direct_mcp",
        conversationId: typeof event.payload?.conversationId === "string" ? event.payload.conversationId : undefined,
        requestedAt: typeof event.payload?.requestedAt === "string" ? event.payload.requestedAt : event.createdAt,
        expiresAt: typeof event.payload?.expiresAt === "string" ? event.payload.expiresAt : undefined,
        options: parsePolicyApprovalOptions(event.payload?.options),
      });
      view.pendingApprovalCount = view.policyApprovals.size;
    }
  } else if (event.type === "policy.approval.provided" || event.type === "approval.resolved") {
    const approvalId = String(event.payload?.approvalId ?? "");
    if (approvalId) {
      view.policyApprovals.delete(approvalId);
      view.pendingApprovalCount = view.policyApprovals.size;
    }
  } else if (event.type === "agent.message.posted") {
    const messageId = String(event.payload?.messageId ?? "");
    const kind = String(event.payload?.kind ?? "note");
    // Only gating kinds (questions/blockers) go into the open-messages tray;
    // findings/artifacts/notes remain in the activity feed as records.
    if (messageId && String(event.payload?.status ?? "") === "open" && (kind === "clarification_request" || kind === "blocker")) {
      view.openMessages.set(messageId, {
        messageId,
        kind,
        author: typeof event.payload?.author === "string" ? event.payload.author : undefined,
        title: typeof event.payload?.title === "string" ? event.payload.title : undefined,
        body: typeof event.payload?.body === "string" ? event.payload.body : undefined,
        status: "open",
        runId: typeof event.payload?.runId === "string" ? event.payload.runId : undefined,
        createdAt: typeof event.payload?.createdAt === "string" ? event.payload.createdAt : event.createdAt,
      });
      view.unresolvedMessageCount = view.openMessages.size;
    }
  } else if (event.type === "agent.message.resolved") {
    const messageId = String(event.payload?.messageId ?? "");
    if (messageId) {
      view.openMessages.delete(messageId);
      host.messageMutationOutcomeUnknown.delete(messageId);
      view.unresolvedMessageCount = view.openMessages.size;
    }
  } else if (event.type === "session.handoff") {
    // Run identity and durable state are unchanged; only the agent handling the
    // next resume differs, so we just surface a notice.
    const toAgent = String(event.payload?.toAgent ?? "");
    view.notice = { tone: "info", message: `Session handed off to ${toAgent || "another agent"}.` };
  }
}

// ── Agent submit bar ─────────────────────────────────


