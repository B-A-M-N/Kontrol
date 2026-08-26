import * as z from "zod/v4";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EventStore } from "./event-log.js";
import type { PolicyEngine } from "./policy.js";
import type { ApprovalScope } from "./policy.js";
import type { PrincipalRole } from "./policy-enforcement.js";
import type { ApprovalRequestManager, ApprovalRequest } from "./approval-requests.js";
import { workspaceAppToolMeta } from "./workspace-app-resource.js";

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

function workspaceAppModelAndAppMeta() {
  return workspaceAppToolMeta();
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
    expiresAt: a.expiresAt,
    options: [
      { id: "approve", label: "Approve Once", effect: "approve", scope: "once" },
      ...(a.workSessionId ? [{ id: "approve_session", label: "Approve Session", effect: "approve", scope: "work_session" }] : []),
      { id: "approve_workspace", label: "Approve Workspace", effect: "approve", scope: "workspace" },
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
    ...(config.approvalRequests?.listPending(workspaceId)
      .filter((request) => request.kind !== "tool")
      .map(genericApprovalToCard) ?? []),
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
      if (!isReviewer(config.principalRole)) {
        return {
          content: [{ type: "text" as const, text: "Forbidden: open_approval_center requires reviewer authority." }],
          isError: true,
        };
      }
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
      if (!isReviewer(config.principalRole)) {
        return {
          content: [{ type: "text" as const, text: "Forbidden: list_pending_approvals requires reviewer authority." }],
          isError: true,
        };
      }
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
          if (!option) {
            return {
              content: [{ type: "text" as const, text: `Decision "${decision}" is not one of the options for approval ${approvalId}.` }],
              isError: true,
            };
          }
          if (option && option.effect === "changes_requested") {
            const resolved = config.approvalRequests?.resolve(approvalId, {
              status: "denied",
              optionId: decision,
              effect: option.effect,
              reason: reason ?? "Changes requested",
            });
            config.eventStore.appendEvent({
              type: "approval.resolved",
              sessionId: generic.workSessionId ?? generic.workspaceSessionId,
              payload: { approvalId, kind: generic.kind, decision: "changes_requested", optionId: decision, effect: option.effect, status: resolved?.status ?? "denied", reason },
            });
            return {
              content: [{ type: "text" as const, text: `Decision recorded: ${decision} for approval ${approvalId}.` }],
              structuredContent: { status: "recorded", approvalId },
            };
          }
          const approve = option.effect === "approve";
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
      if (decision !== "approve" && decision !== "approve_session" && decision !== "approve_workspace" && decision !== "deny") {
        return {
          content: [{ type: "text" as const, text: `Decision "${decision}" is not valid for policy approval ${approvalId}.` }],
          isError: true,
        };
      }
      if ((decision === "approve_session" || scope === "work_session") && !match.workSessionId) {
        return {
          content: [{ type: "text" as const, text: "This approval has no work session; approve once or choose a workspace grant explicitly." }],
          isError: true,
        };
      }

      // Resolve the blocked tool call's waiter via event
      config.policyEngine.resolvePending(
        approvalId,
        decision === "deny" ? "denied" : "approved",
        reason,
      );
      config.eventStore.appendEvent({
        type: "policy.approval.provided",
        sessionId: match.workSessionId ?? match.workspaceId,
        payload: {
          approvalId,
          decision: decision === "deny" ? "deny" : "approve",
          scope: decision === "approve_session"
            ? "work_session"
            : decision === "approve_workspace"
              ? "workspace"
              : (scope ?? "once"),
          reason,
        },
      });

      return {
        content: [{ type: "text" as const, text: `Decision recorded: ${decision} for approval ${approvalId}.` }],
        structuredContent: { status: "recorded", approvalId },
      };
    },
  );

  registerAppTool(
    server,
    "list_policy_grants",
    {
      title: "List policy grants",
      description: "List durable effective policy approvals. Reviewer-only; scope filters are optional.",
      inputSchema: {
        scope: z.enum(["work_session", "workspace"]).optional(),
        scopeId: z.string().min(1).optional(),
      },
      outputSchema: { grants: z.array(z.object({
        id: z.string(), principalId: z.string(), scope: z.string(), scopeId: z.string(), approvalKey: z.string(), createdAt: z.string(), reviewerId: z.string().optional(),
      })) },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ scope, scopeId }) => {
      if (!isReviewer(config.principalRole)) {
        return { content: [{ type: "text" as const, text: "Forbidden: list_policy_grants requires reviewer authority." }], isError: true };
      }
      const grants = config.policyEngine.listGrants(scope as ApprovalScope | undefined, scopeId);
      return { content: [{ type: "text" as const, text: `${grants.length} effective policy grant(s).` }], structuredContent: { grants } };
    },
  );

  registerAppTool(
    server,
    "revoke_policy_grants",
    {
      title: "Revoke policy grants",
      description: "Revoke all durable policy approvals for an exact work session or workspace scope. Reviewer-only.",
      inputSchema: {
        scope: z.enum(["work_session", "workspace"]),
        scopeId: z.string().min(1),
      },
      outputSchema: { status: z.string(), scope: z.string(), scopeId: z.string() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ scope, scopeId }) => {
      if (!isReviewer(config.principalRole)) {
        return { content: [{ type: "text" as const, text: "Forbidden: revoke_policy_grants requires reviewer authority." }], isError: true };
      }
      config.policyEngine.revokeScope(scope as ApprovalScope, scopeId);
      config.eventStore.appendEvent({
        type: "policy.grants.revoked",
        sessionId: scopeId,
        payload: { scope, scopeId },
      });
      return { content: [{ type: "text" as const, text: `Revoked ${scope} policy grants for ${scopeId}.` }], structuredContent: { status: "revoked", scope, scopeId } };
    },
  );
}
