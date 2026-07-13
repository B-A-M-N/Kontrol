import * as z from "zod/v4";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EventStore } from "./event-log.js";
import type { PolicyEngine } from "./policy.js";
import type { PrincipalRole } from "./policy-enforcement.js";
import type { ApprovalRequestManager, ApprovalRequest } from "./approval-requests.js";

interface PolicyToolConfig {
  eventStore: EventStore;
  policyEngine: PolicyEngine;
  approvalRequests?: ApprovalRequestManager;
  /**
   * The role of the caller presenting this MCP connection. Reviewer-only tools
   * (provide_policy_approval) are rejected unless the caller is a reviewer.
   * The worker (coding agent) must never be able to approve its own policy
   * prompts — possession of the agent adapter secret must not confer reviewer
   * authority.
   */
  principalRole?: PrincipalRole;
}

function isReviewer(role?: PrincipalRole): boolean {
  return role === "reviewer";
}

const WORKSPACE_APP_URI = "ui://kontrol/workspace-app.html";

function workspaceAppModelAndAppMeta() {
  return {
    ui: {
      resourceUri: WORKSPACE_APP_URI,
      visibility: ["model", "app"] as const,
    },
  };
}

function policyApprovalToCard(a: ReturnType<PolicyEngine["getPendingApprovals"]>[number]) {
  return {
    id: a.id,
    approvalId: a.id,
    kind: "tool",
    workspaceId: a.workspaceId,
    workspaceSessionId: a.workspaceId,
    workSessionId: a.workSessionId,
    tool: a.tool,
    title: `Approve ${a.tool}`,
    path: a.path,
    command: a.command,
    requestedAt: a.requestedAt,
    createdAt: a.requestedAt,
    options: [
      { id: "approve", label: "Approve Once", effect: "approve", scope: "once" },
      { id: "approve_session", label: "Approve Session", effect: "approve", scope: "work_session" },
      { id: "deny", label: "Deny", effect: "deny" },
    ],
  };
}

function genericApprovalToCard(a: ApprovalRequest) {
  return {
    id: a.approvalId,
    approvalId: a.approvalId,
    kind: a.kind,
    workspaceId: a.workspaceSessionId,
    workspaceSessionId: a.workspaceSessionId,
    workSessionId: a.workSessionId,
    runId: a.runId,
    agentId: a.agentId,
    tool: a.tool ?? a.kind,
    title: a.title,
    description: a.description,
    risk: a.risk,
    path: a.path,
    command: a.command,
    requestedAt: a.createdAt,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    options: a.options,
  };
}

function listAllApprovals(config: PolicyToolConfig, workspaceId?: string) {
  return [
    ...config.policyEngine.getPendingApprovals(workspaceId).map(policyApprovalToCard),
    ...(config.approvalRequests?.listPending(workspaceId).map(genericApprovalToCard) ?? []),
  ];
}

/**
 * MCP tools for policy approval workflow.
 *
 * The WebUI (or any client) uses these to:
 *   1. List pending tool-call approvals
 *   2. Submit an approval decision (approve / approve-for-session / deny)
 *
 * When a decision is submitted, it emits a policy.approval.provided event
 * that resolves the blocked tool call's waiter.
 */
export function registerPolicyTools(
  server: McpServer,
  config: PolicyToolConfig,
): void {
  const approvalCenterMeta = workspaceAppModelAndAppMeta();

  registerAppTool(
    server,
    "open_approval_center",
    {
      title: "Open approval center",
      description: "Render all pending Kontrol approval requests in an actionable iframe.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Filter by workspace session ID."),
      },
      outputSchema: {
        approvals: z.array(z.object({
          id: z.string(),
          workspaceId: z.string(),
          workSessionId: z.string().optional(),
          tool: z.string(),
          path: z.string().optional(),
          command: z.string().optional(),
          requestedAt: z.string(),
        })),
        count: z.number(),
      },
      _meta: approvalCenterMeta,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ workspaceId }) => {
      const approvals = listAllApprovals(config, workspaceId);
      return {
        content: [{ type: "text" as const, text: `${approvals.length} pending approval(s).` }],
        structuredContent: { approvals, count: approvals.length },
        _meta: {
          tool: "open_approval_center",
          card: {
            tool: "open_approval_center",
            summary: { approvals, count: approvals.length, status: "pending" },
          },
        },
      };
    },
  );

  registerAppTool(
    server,
    "list_pending_approvals",
    {
      title: "List pending approvals",
      description: "List tool-call approval requests awaiting human decision. Approved here, the blocked tool call proceeds; denied, it returns an error to the agent.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Filter by workspace session ID."),
      },
      outputSchema: {
        approvals: z.array(z.object({
          id: z.string(),
          workspaceId: z.string(),
          workSessionId: z.string().optional(),
          tool: z.string(),
          path: z.string().optional(),
          command: z.string().optional(),
          requestedAt: z.string(),
        })),
        count: z.number(),
      },
      _meta: approvalCenterMeta,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ workspaceId }) => {
      const pending = listAllApprovals(config, workspaceId);

      return {
        content: [{ type: "text" as const, text: `${pending.length} pending approval(s).` }],
        structuredContent: {
          approvals: pending,
          count: pending.length,
        },
      };
    },
  );

  registerAppTool(
    server,
    "provide_policy_approval",
    {
      title: "Provide policy approval",
      description: "Decide a pending tool-call approval request. Approve allows this call; approve-for-session allows all similar calls for the rest of the work session; deny blocks the call.",
      inputSchema: {
        approvalId: z.string().describe("Approval request ID from list_pending_approvals."),
        decision: z.string().describe("Approval decision or generic approval option ID."),
        scope: z.enum(["once", "work_session", "workspace"]).optional().describe("How long the approval should apply. Defaults to once."),
        reason: z.string().optional().describe("Optional reason for the decision."),
      },
      outputSchema: { status: z.string(), approvalId: z.string() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ approvalId, decision, scope, reason }) => {
      // SERVER-SIDE ROLE CHECK: reviewer-only tool. The worker (coding agent)
      // must not be able to self-approve its own blocked tool calls.
      if (!isReviewer(config.principalRole)) {
        return {
          content: [{ type: "text" as const, text: "Forbidden: provide_policy_approval requires reviewer authority." }],
          isError: true,
        };
      }

      // Lookup the workspace session for this approval (so waiter resolves)
      const pending = config.policyEngine.getPendingApprovals();
      const match = pending.find((a) => a.id === approvalId);

      if (!match) {
        const generic = config.approvalRequests?.get(approvalId);
        if (generic?.status === "pending") {
          const option = generic.options.find((candidate) => candidate.id === decision);
          const approve = option?.effect === "approve" || decision === "approve" || decision === "approve_session";
          const resolved = config.approvalRequests?.resolve(approvalId, {
            status: approve ? "approved" : "denied",
            optionId: decision,
            reason,
          });
          config.eventStore.appendEvent({
            type: "approval.resolved",
            sessionId: generic.workSessionId ?? generic.workspaceSessionId,
            payload: {
              approvalId,
              kind: generic.kind,
              decision: approve ? "approve" : "deny",
              optionId: decision,
              effect: option?.effect,
              status: resolved?.status ?? (approve ? "approved" : "denied"),
              reason,
            },
          });
          return {
            content: [{ type: "text" as const, text: `Decision recorded: ${decision} for approval ${approvalId}.` }],
            structuredContent: { status: "recorded", approvalId },
          };
        }
        return {
          content: [{ type: "text" as const, text: `Approval "${approvalId}" not found.` }],
          isError: true,
        };
      }
      if (decision !== "approve" && decision !== "approve_session" && decision !== "deny") {
        return {
          content: [{ type: "text" as const, text: `Decision "${decision}" is not valid for policy approval ${approvalId}.` }],
          isError: true,
        };
      }

      // Resolve the blocked tool call's waiter via event
      config.eventStore.appendEvent({
        type: "policy.approval.provided",
        sessionId: match.workSessionId ?? match.workspaceId,
        payload: {
          approvalId,
          decision: decision === "approve_session" ? "approve" : decision,
          scope: decision === "approve_session" ? "work_session" : (scope ?? "once"),
          reason,
        },
      });

      return {
        content: [{ type: "text" as const, text: `Decision recorded: ${decision} for approval ${approvalId}.` }],
        structuredContent: { status: "recorded", approvalId },
      };
    },
  );
}
