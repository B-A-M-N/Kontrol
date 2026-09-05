/**
 * ACP session-inspection and approval decision routes
 * (GET /session/:id, GET /approvals/:id[...]).
 *
 * Extracted verbatim from acp-server.ts's createAcpServer closure (P1
 * decomposition). The approval decision endpoint long-polls with NO
 * fail-closed timeout: a pending approval returns `still_pending` and the
 * agent re-parks — the human may be away for hours.
 */
import type { Router } from "express";
import type { ApprovalRequestManager } from "../../approval-requests.js";
import type { AcpContext } from "./context.js";
import { APPROVAL_WAIT_TIMEOUT_MS } from "./context.js";
import type { makeAuth } from "./auth.js";

export function registerReviewRoutes(
  router: Router,
  ctx: AcpContext,
  auth: ReturnType<typeof makeAuth>,
) {
  const { workSessions, agentRegistry, eventStore, approvalRequests } = ctx;
  const { authGate, requireAgentOwnership } = auth;

  function stringPayload(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  function approvalToEventPayload(approval: NonNullable<ReturnType<ApprovalRequestManager["get"]>>): Record<string, unknown> {
    return {
      approvalId: approval.approvalId,
      kind: approval.kind,
      workspaceId: approval.workspaceSessionId,
      workspaceSessionId: approval.workspaceSessionId,
      workSessionId: approval.workSessionId,
      runId: approval.runId,
      agentId: approval.agentId,
      title: approval.title,
      description: approval.description,
      risk: approval.risk,
      tool: approval.tool,
      command: approval.command,
      path: approval.path,
      options: approval.options,
      status: approval.status,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
    };
  }

  // GET /session/{session_id}
  router.get("/session/:session_id", (req, res) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;
    const session = workSessions.get(req.params.session_id);
    if (!session) { res.status(404).json({ error: { code: "not_found", message: "Session not found" } }); return; }

    const submissions = workSessions.getSubmissions(session.id);
    const toolEvents = workSessions.getToolEvents(session.id, 50);
    const runs = agentRegistry.listRuns(session.workspaceSessionId, 10);

    res.json({
      id: session.id,
      workspaceSessionId: session.workspaceSessionId,
      status: session.status,
      submittedBy: session.submittedBy,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      submissionCount: submissions.length,
      feedbackCount: workSessions.countFeedback(session.id),
      latestSubmission: session.latestSubmission,
      latestFeedback: session.latestFeedback,
      recentToolEvents: toolEvents.slice(0, 10),
      recentRuns: runs,
    });
  });

  router.get("/approvals/:approval_id", (req, res) => {
    const role = authGate(req, res, ["agent", "reviewer", "operator"]);
    if (!role) return;
    const approval = approvalRequests?.get(req.params.approval_id);
    if (!approval) {
      res.status(404).json({ error: { code: "not_found", message: "Approval request not found" } });
      return;
    }
    if (!requireAgentOwnership(req, res, role, approval.agentId)) return;
    res.json(approvalToEventPayload(approval));
  });

  // Long-poll for an approval's decision. An agent that reconnected (or whose
  // original blocking POST hit the long-poll window) parks here until the human
  // decides. Crucially there is NO fail-closed timeout: if the window elapses
  // with the approval still pending, we return `still_pending` so the agent
  // simply re-parks — the human may be away for hours, exactly like the CLI
  // coding agents. A resolved approval returns its decision immediately.
  router.get("/approvals/:approval_id/decision", async (req, res) => {
    const role = authGate(req, res, ["agent", "operator"]);
    if (!role) return;
    if (!approvalRequests) {
      res.status(500).json({ error: { code: "server_error", message: "Approval request store unavailable" } });
      return;
    }
    const approval = approvalRequests.get(req.params.approval_id);
    if (!approval) {
      res.status(404).json({ error: { code: "not_found", message: "Approval request not found" } });
      return;
    }
    if (!requireAgentOwnership(req, res, role, approval.agentId)) return;

    const decisionFor = (a: NonNullable<ReturnType<ApprovalRequestManager["get"]>>) => {
      const resolution = a.resolution ?? {};
      const decision = a.status === "approved" ? "approve" : a.status === "denied" ? "deny" : null;
      return {
        approval_id: a.approvalId,
        status: a.status,
        decision,
        option_id: stringPayload(resolution.optionId),
        reason: stringPayload(resolution.reason),
      };
    };

    // Already decided — return now.
    if (approval.status !== "pending") {
      res.json(decisionFor(approval));
      return;
    }

    const eventSessionId = approval.workSessionId ?? approval.workspaceSessionId;
    const resolution = eventStore
      ? await eventStore.waitForEvent(
          eventSessionId,
          "approval.resolved",
          (e: { payload?: Record<string, unknown> }) => e.payload?.approvalId === approval.approvalId,
          APPROVAL_WAIT_TIMEOUT_MS,
        )
      : null;

    if (resolution) {
      const rp = resolution.payload ?? {};
      res.json({
        approval_id: approval.approvalId,
        status: stringPayload(rp.status) ?? (rp.decision === "approve" ? "approved" : "denied"),
        decision: stringPayload(rp.decision) ?? "deny",
        option_id: stringPayload(rp.optionId),
        reason: stringPayload(rp.reason),
      });
      return;
    }

    // Re-check the store in case it resolved outside the event stream, then
    // (still pending) tell the caller to keep parking. Never fail-closed.
    const latest = approvalRequests.get(approval.approvalId);
    if (latest && latest.status !== "pending") {
      res.json(decisionFor(latest));
      return;
    }
    res.json({
      approval_id: approval.approvalId,
      status: "pending",
      decision: null,
      still_pending: true,
      poll_url: `/approvals/${encodeURIComponent(approval.approvalId)}/decision`,
    });
  });
}
