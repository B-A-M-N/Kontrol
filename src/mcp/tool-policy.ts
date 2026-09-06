/**
 * Policy enforcement for MCP workspace tool calls: the renderable
 * policy-blocked response, the shared enforcer invocation, and the canonical
 * policy path representation. Extracted verbatim from
 * src/mcp/workspace-server.ts (P1.3); the createMcpServer closures become
 * explicit module functions.
 */
import { relative, resolve, sep } from "node:path";
import type { PolicyInvocation } from "../policy-enforcement.js";
import { isPathInsideRoot } from "../roots.js";
import { authorizeWorkSessionAction } from "../work-session-action-guard.js";
import type { WorkSessionManager } from "../work-sessions.js";
import { mcpRequestContext } from "./request-context.js";

/**
 * P0.2: a policy-blocked result must remain renderable by the Workspace App.
 * The MCP `_meta.tool`/`_meta.card` envelope is the only contract the app can
 * use (see toolNameFromMeta()/isToolResultCard() in workspace-app.tsx), and it
 * is attached even when isError is true because the UI renders both blocked
 * and approval-pending cards from the same payload.
 */
export function policyFailureResponse(
  result: { allowed: boolean; approvalRequired?: boolean; approvalId?: string },
  deniedMessage: string,
  context: {
    tool: "exec_command" | "write_stdin" | "read" | "write" | "edit" | "apply_patch" | "grep" | "glob" | "ls" | "bash";
    workspaceId: string;
    path?: string;
    command?: string;
  },
): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  _meta: { tool: string; card: Record<string, unknown> };
  structuredContent?: Record<string, unknown>;
} {
  if (result.approvalRequired && result.approvalId) {
    const message = `Approval required. Approve ${result.approvalId} in the Kontrol review UI, then retry this exact tool call with approvalResumeId set to ${result.approvalId}. The retry consumes the human decision without prompting again.`;
    const card: Record<string, unknown> = {
      tool: context.tool,
      workspaceId: context.workspaceId,
      status: "approval_required",
      approvalId: result.approvalId,
      resumeArgument: "approvalResumeId",
      retryable: true,
      summary: {
        status: "approval_required",
        approvalId: result.approvalId,
        command: context.command,
      },
      payload: { content: [{ type: "text", text: message }] },
    };
    if (context.path !== undefined) card.path = context.path;
    if (context.command !== undefined) card.command = context.command;
    return {
      content: [{ type: "text", text: message }],
      isError: false,
      _meta: { tool: context.tool, card },
      structuredContent: {
        result: message,
        status: "approval_required",
        approvalId: result.approvalId,
        retryable: true,
        ...(context.tool === "apply_patch" ? { additions: 0, removals: 0, files: [] } : {}),
      },
    };
  }
  const card: Record<string, unknown> = {
    tool: context.tool,
    workspaceId: context.workspaceId,
    status: "policy_denied",
    summary: { status: "policy_denied", command: context.command },
    payload: { content: [{ type: "text", text: deniedMessage }] },
  };
  if (context.path !== undefined) card.path = context.path;
  if (context.command !== undefined) card.command = context.command;
  return {
    content: [{ type: "text", text: deniedMessage }],
    isError: true,
    _meta: { tool: context.tool, card },
    structuredContent: { result: deniedMessage },
  };
}

/**
 * Policy enforcement for tool calls.
 * Returns the policy outcome. Direct MCP calls return approval_required
 * immediately; controlled ACP invocations may retain blocking semantics.
 *
 * Uses the shared enforcer so MCP and ACP share one code path, and records
 * approvals under the CANONICAL policy key (never a reconstructed key).
 */
export async function enforceToolPolicy(
  workSessions: ReturnType<typeof import("../work-sessions.js").createWorkSessionManager> | undefined,
  enforcer: import("../policy-enforcement.js").PolicyEnforcer,
  workspaceId: string,
  workSessionId: string | undefined,
  runId: string | undefined,
  tool: string,
  path: PolicyInvocation["path"],
  command: string | undefined,
  paths?: PolicyInvocation["paths"],
  approvalResumeId?: string,
): Promise<{ allowed: boolean; approvalRequired?: boolean; approvalId?: string }> {
  if (workSessions && workSessionId) {
    const sessionDecision = authorizeWorkSessionAction(workSessions, {
      workSessionId,
      tool,
      path: typeof path === "string" ? path : path?.relativePath,
      command,
    });
    if (!sessionDecision.allowed) return { allowed: false };
  }
  const result = await enforcer.enforce({
    principalId: workSessionId ?? workspaceId,
    principalRole: workSessionId ? "worker" : "client",
    workspaceId,
    workSessionId,
    runId,
    tool,
    path,
    paths,
    command,
    signal: mcpRequestContext.getStore()?.signal,
    mcpSessionId: mcpRequestContext.getStore()?.mcpSessionId,
    mcpRequestId: mcpRequestContext.getStore()?.mcpRequestId,
    onPolicyWaitStart: mcpRequestContext.getStore()?.onPolicyWaitStart,
    onPolicyWaitEnd: mcpRequestContext.getStore()?.onPolicyWaitEnd,
    // A direct MCP operation has no durable worker lifecycle to hold open, so
    // return approval_required immediately. Calls bound to a work session are
    // controlled worker operations and retain ACP-style blocking semantics.
    blockingApproval: Boolean(workSessionId),
    conversationId: mcpRequestContext.getStore()?.conversationId,
    approvalCorrelationId: mcpRequestContext.getStore()?.approvalCorrelationId,
    // Explicit opaque operation-resume identity: when a retrying caller
    // echoes the approvalId from its approval_required card, verified
    // content adopts the original durable operation instead of prompting
    // again under a new reconnect fingerprint.
    approvalResumeId,
  });
  return result;
}

/**
 * Build the only path representation that may enter policy evaluation from an
 * MCP filesystem action. The lexical user path is retained only as the
 * relative display form; the absolute form has already passed workspace
 * resolution and symlink checks.
 */
export function canonicalPolicyPath(
  workspaceRoot: string,
  inputPath: string | undefined,
  resolvedPath?: string,
): NonNullable<PolicyInvocation["path"]> {
  const absolutePath = resolve(resolvedPath ?? workspaceRoot, resolvedPath ? "." : (inputPath ?? "."));
  const relativePath = isPathInsideRoot(absolutePath, workspaceRoot)
    ? (relative(workspaceRoot, absolutePath).split(sep).join("/") || ".")
    : (inputPath ?? absolutePath).replaceAll("\\", "/");
  return { relativePath, absolutePath };
}
