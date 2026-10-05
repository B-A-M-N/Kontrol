import * as z from "zod/v4";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EventStore } from "./event-log.js";
import type { PolicyEngine } from "./policy.js";
import type { ApprovalScope } from "./policy.js";
import type { PrincipalRole } from "./policy-enforcement.js";
import type { ApprovalRequestManager, ApprovalRequest } from "./approval-requests.js";
import type { WorkSessionManager } from "./work-sessions.js";
import {
  workspaceAppCallableToolMeta,
  workspaceAppRenderToolMeta,
} from "./workspace-app-resource.js";
import { mutationPrincipalId, runWithMutationReceipt, type MutationReceiptStore } from "./mutation-receipts.js";
import { mcpOwnerContextId } from "./mcp/owner-context.js";

interface PolicyToolConfig {
  eventStore: EventStore;
  policyEngine: PolicyEngine;
  approvalRequests?: ApprovalRequestManager;
  workSessions?: WorkSessionManager;
  /**
   * The role of the caller presenting this MCP connection. Reviewer-only tools
   * (provide_policy_approval) are rejected unless the caller is a reviewer.
   * The worker (coding agent) must never be able to approve its own policy
   * prompts — possession of the agent adapter secret must not confer reviewer
   * authority.
   */
  principalRole?: PrincipalRole;
  principalId?: string;
  ownerContextId?: string;
  connectionContext?: import("./mcp/connection-context.js").ConnectionContext;
  mutationReceipts?: MutationReceiptStore;
}

function isReviewer(role?: PrincipalRole): boolean {
  return role === "reviewer";
}

function liveOwner(config: PolicyToolConfig): string | undefined {
  // A reviewer transport without an explicit conversation header is the
  // global approval surface. Its disposable MCP transport identity must not
  // hide cards created by another conversation. Conversation-scoped reviewer
  // connections remain isolated through the durable conversation owner.
  if (config.connectionContext && !config.connectionContext.conversationId?.trim()) {
    return undefined;
  }
  return mcpOwnerContextId(config.connectionContext ?? {}) ?? config.ownerContextId;
}

function missingOwnerResponse() {
  return { content: [{ type: "text" as const, text: "Forbidden: this reviewer connection has no live transport identity." }], isError: true as const };
}

function grantOwnedBy(config: PolicyToolConfig, grant: { principalId: string; scope: string; scopeId: string }): boolean {
  const owner = liveOwner(config);
  if (!owner) return true;
  if (grant.principalId === owner) return true;
  return grant.scope === "work_session"
    ? config.workSessions?.get(grant.scopeId)?.ownerContextId === owner
    : false;
}

function workspaceAppCallableMeta() {
  return workspaceAppCallableToolMeta();
}

function registerMutationPolicyTool(
  server: McpServer,
  name: string,
  definition: unknown,
  config: PolicyToolConfig,
  handler: (input: any) => Promise<unknown> | unknown,
): void {
  registerAppTool(server, name as any, definition as any, (async (input: any) => {
    const { clientMutationId, ...request } = input as { clientMutationId?: string } & Record<string, unknown>;
    return runWithMutationReceipt({
      store: config.mutationReceipts,
      principalId: [mutationPrincipalId(config.principalId, config.principalRole), liveOwner(config)].filter(Boolean).join("|owner:"),
      operation: name,
      clientMutationId,
      request,
      execute: () => handler(input),
    });
  }) as any);
}

const approvalOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  effect: z.enum(["approve", "deny", "changes_requested"]),
  scope: z.enum(["once", "work_session", "workspace"]).optional(),
});

/**
 * Lifecycle classification for a pending approval. A direct MCP approval
 * returns `approval_required` immediately, so ZERO live waiters is its normal
 * shape — it is still awaiting a human decision, not orphaned. Only a direct
 * operation whose reattachment window has actually elapsed (no retry arrived
 * in time) is an abandoned operation.
 */
export type ApprovalLifecycleState =
  | "pending_human_approval"
  | "detached_live_waiter"
  | "abandoned_operation";

function approvalLifecycleState(approval: {
  workSessionId?: string;
  origin?: "direct_mcp" | "work_session";
  liveWaiterCount: number;
  reattachDeadline?: string;
}): ApprovalLifecycleState {
  const nowIso = new Date().toISOString();
  const blocking = approval.origin === "work_session" || Boolean(approval.workSessionId);
  if (blocking) {
    // Work-session approvals park their caller; a missing live waiter there
    // genuinely means the waiting invocation detached.
    return approval.liveWaiterCount > 0 ? "pending_human_approval" : "detached_live_waiter";
  }
  if (approval.reattachDeadline && approval.reattachDeadline <= nowIso) return "abandoned_operation";
  return "pending_human_approval";
}

/** Canonical approval-card contract shared by list/open tools and the UI. */
export const approvalCardSchema = z.object({
  id: z.string(),
  approvalId: z.string(),
  kind: z.string(),
  workspaceId: z.string(),
  workspaceSessionId: z.string(),
  workSessionId: z.string().optional(),
  runId: z.string().optional(),
  agentId: z.string().optional(),
  tool: z.string(),
  title: z.string(),
  description: z.string().optional(),
  risk: z.string().optional(),
  path: z.string().optional(),
  command: z.string().optional(),
  origin: z.enum(["direct_mcp", "work_session"]).optional(),
  conversationId: z.string().optional(),
  ownerContextId: z.string().optional(),
  orphanedAt: z.string().optional(),
  reattachDeadline: z.string().optional(),
  liveWaiterCount: z.number(),
  state: z.enum(["pending_human_approval", "detached_live_waiter", "abandoned_operation"]),
  requestedAt: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  options: z.array(approvalOptionSchema),
});

function policyApprovalToCard(a: ReturnType<PolicyEngine["getPendingApprovals"]>[number]) {
  const liveWaiterCount = a.liveWaiterId ? 1 : 0;
  return {
    id: a.id,
    approvalId: a.id,
    kind: "tool",
    workspaceId: a.workspaceId,
    workspaceSessionId: a.workspaceId,
    workSessionId: a.workSessionId,
    runId: a.runId,
    agentId: a.agentId,
    tool: a.tool,
    title: `Approve ${a.tool}`,
    path: a.path,
    command: a.command,
    origin: a.origin,
    conversationId: a.conversationId,
    ownerContextId: a.ownerContextId,
    orphanedAt: a.orphanedAt,
    reattachDeadline: a.reattachDeadline,
    liveWaiterCount,
    state: approvalLifecycleState({
      workSessionId: a.workSessionId,
      origin: a.origin,
      liveWaiterCount,
      reattachDeadline: a.reattachDeadline,
    }),
    requestedAt: a.requestedAt,
    createdAt: a.requestedAt,
    expiresAt: a.expiresAt,
    options: a.options ?? [],
  };
}

function genericApprovalToCard(a: ApprovalRequest) {
  const liveWaiterCount = a.liveWaiterCount ?? 0;
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
    origin: a.origin,
    conversationId: a.conversationId,
    ownerContextId: a.ownerContextId,
    orphanedAt: a.orphanedAt,
    reattachDeadline: a.reattachDeadline,
    liveWaiterCount,
    state: approvalLifecycleState({
      workSessionId: a.workSessionId,
      origin: a.origin,
      liveWaiterCount,
      reattachDeadline: a.reattachDeadline,
    }),
    requestedAt: a.createdAt,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    options: a.options,
  };
}

function listAllApprovals(config: PolicyToolConfig, workspaceId?: string) {
  const owner = liveOwner(config);
  const all = [
    ...config.policyEngine.getPendingApprovals(workspaceId).map(policyApprovalToCard),
    ...(config.approvalRequests?.listPending(workspaceId)
      .filter((request) => request.kind !== "tool")
      .map(genericApprovalToCard) ?? []),
  ];
  return owner ? all.filter((approval) => {
    const candidate = approval as { conversationId?: string; ownerContextId?: string };
    return candidate.ownerContextId === owner || candidate.conversationId === owner;
  }) : all;
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
  const approvalCenterMeta = workspaceAppRenderToolMeta();

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
        approvals: z.array(approvalCardSchema),
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
      if (config.connectionContext && !config.connectionContext.mcpSessionId?.trim()) return missingOwnerResponse();
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
        approvals: z.array(approvalCardSchema),
        count: z.number(),
      },
      _meta: workspaceAppCallableMeta(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ workspaceId }) => {
      if (!isReviewer(config.principalRole)) {
        return {
          content: [{ type: "text" as const, text: "Forbidden: list_pending_approvals requires reviewer authority." }],
          isError: true,
        };
      }
      if (config.connectionContext && !config.connectionContext.mcpSessionId?.trim()) return missingOwnerResponse();
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

  registerMutationPolicyTool(
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
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: { status: z.string(), approvalId: z.string() },
      _meta: workspaceAppCallableMeta(),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    config,
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
          if (liveOwner(config) && generic.ownerContextId && generic.ownerContextId !== liveOwner(config)) {
            return { content: [{ type: "text" as const, text: "Forbidden: approval belongs to another conversation." }], isError: true };
          }
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
              payload: { approvalId, kind: generic.kind, decision: "changes_requested", optionId: decision, effect: option.effect, status: resolved?.status ?? "denied", reason, ownerContextId: liveOwner(config) },
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
      if (liveOwner(config) && match.ownerContextId && match.ownerContextId !== liveOwner(config)) {
        return { content: [{ type: "text" as const, text: "Forbidden: approval belongs to another conversation." }], isError: true };
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

      // Resolve the blocked tool call's waiter via event. Record scoped grants
      // here too, so a durable approval remains useful if the original live
      // waiter disappeared before the reviewer responded. The live enforcer
      // repeats this operation idempotently when it resumes.
      const approvalScope: ApprovalScope = decision === "approve_session"
        ? "work_session"
        : decision === "approve_workspace"
          ? "workspace"
          : (scope ?? "once");
      if (approvalScope === "workspace" && /^(?:transport|ephemeral-workspace):/.test(match.principalId)) {
        return {
          content: [{ type: "text" as const, text: "A durable workspace grant requires a stable authenticated principal. This request is transport-scoped; approve it once or authenticate with a stable principal." }],
          isError: true,
        };
      }
      if (decision !== "deny" && match.approvalKey) {
        config.policyEngine.recordApproval(
          match.principalId,
          match.approvalKey,
          approvalScope,
          { workspaceId: match.workspaceId, workSessionId: match.workSessionId },
          "reviewer",
        );
      }
      config.policyEngine.resolvePending(
        approvalId,
        decision === "deny" ? "denied" : "approved",
        reason,
        { scope: approvalScope, optionId: decision },
      );
      config.eventStore.appendEvent({
        type: "policy.approval.provided",
        sessionId: match.workSessionId ?? match.workspaceId,
        payload: {
          approvalId,
          decision: decision === "deny" ? "deny" : "approve",
          scope: approvalScope,
          reason,
          ownerContextId: liveOwner(config),
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
        id: z.string(), principalId: z.string(), scope: z.string(), scopeId: z.string(), approvalKey: z.string(), createdAt: z.string(), expiresAt: z.string().optional(), reviewerId: z.string().optional(),
      })) },
      _meta: workspaceAppCallableMeta(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ scope, scopeId }) => {
      if (!isReviewer(config.principalRole)) {
        return { content: [{ type: "text" as const, text: "Forbidden: list_policy_grants requires reviewer authority." }], isError: true };
      }
      const grants = config.policyEngine.listGrants(scope as ApprovalScope | undefined, scopeId)
        .filter((grant) => grantOwnedBy(config, grant));
      return { content: [{ type: "text" as const, text: `${grants.length} effective policy grant(s).` }], structuredContent: { grants } };
    },
  );

  registerMutationPolicyTool(
    server,
    "revoke_policy_grant",
    {
      title: "Revoke policy grant",
      description:
        "Revoke EXACTLY ONE durable policy approval by its grant id (the id returned by list_policy_grants). "
        + "Other grants in the same scope are untouched. To revoke every grant in a scope at once, use "
        + "revoke_policy_grants instead. Reviewer-only.",
      inputSchema: {
        grantId: z.string().min(1).describe("Exact grant id from list_policy_grants."),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: { status: z.string(), grantId: z.string() },
      _meta: workspaceAppCallableMeta(),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    config,
    async ({ grantId }) => {
      if (!isReviewer(config.principalRole)) {
        return { content: [{ type: "text" as const, text: "Forbidden: revoke_policy_grant requires reviewer authority." }], isError: true };
      }
      const grant = config.policyEngine.listGrants().find((candidate) => candidate.id === grantId);
      if (liveOwner(config) && grant && !grantOwnedBy(config, grant)) {
        return { content: [{ type: "text" as const, text: "Forbidden: policy grant belongs to another conversation." }], isError: true };
      }
      if (!grant) {
        return { content: [{ type: "text" as const, text: `Unknown or already-revoked policy grant: ${grantId}.` }], isError: true };
      }
      config.policyEngine.revokeGrant(grantId);
      config.eventStore.appendEvent({
        type: "policy.grants.revoked",
        sessionId: grant.scopeId,
        payload: { scope: grant.scope, scopeId: grant.scopeId, grantId, principalId: grant.principalId, ownerContextId: liveOwner(config), exact: true },
      });
      return {
        content: [{ type: "text" as const, text: `Revoked policy grant ${grantId} (${grant.scope}:${grant.scopeId}).` }],
        structuredContent: { status: "revoked", grantId },
      };
    },
  );

  registerMutationPolicyTool(
    server,
    "revoke_policy_grants",
    {
      title: "Revoke policy grants (bulk)",
      description:
        "BULK: revoke ALL durable policy approvals for an exact work session or workspace scope — every grant, "
        + "every principal, every approval key in that scope. For a single grant, use revoke_policy_grant with "
        + "the grant id. Reviewer-only.",
      inputSchema: {
        scope: z.enum(["work_session", "workspace"]),
        scopeId: z.string().min(1),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: { status: z.string(), scope: z.string(), scopeId: z.string() },
      _meta: workspaceAppCallableMeta(),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    config,
    async ({ scope, scopeId }) => {
      if (!isReviewer(config.principalRole)) {
        return { content: [{ type: "text" as const, text: "Forbidden: revoke_policy_grants requires reviewer authority." }], isError: true };
      }
      if (liveOwner(config) && config.policyEngine.listGrants(scope as ApprovalScope, scopeId).some((grant) => !grantOwnedBy(config, grant))) {
        return { content: [{ type: "text" as const, text: "Forbidden: scope contains grants from another conversation." }], isError: true };
      }
      config.policyEngine.revokeScope(scope as ApprovalScope, scopeId);
      config.eventStore.appendEvent({
        type: "policy.grants.revoked",
        sessionId: scopeId,
        payload: { scope, scopeId, bulk: true, ownerContextId: liveOwner(config) },
      });
      return { content: [{ type: "text" as const, text: `Revoked ${scope} policy grants for ${scopeId}.` }], structuredContent: { status: "revoked", scope, scopeId } };
    },
  );
}
