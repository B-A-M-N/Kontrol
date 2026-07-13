import { randomUUID } from "node:crypto";
import type { PolicyEngine, PolicyDecision, ApprovalScope } from "./policy.js";
import type { EventStore } from "./event-log.js";

export type PrincipalRole = "reviewer" | "worker" | "client";

export interface PolicyInvocation {
  principalId: string;
  principalRole: PrincipalRole;
  workspaceId: string;
  workSessionId?: string;
  runId?: string;
  tool: string;
  path?: string;
  command?: string;
}

/**
 * Canonical ACP tool names map onto the same policy keys as the MCP tools.
 * If ACP `devdesktop-write` is gated as `write`, then the MCP `write` tool is
 * gated by the exact same rule. Without this mapping the ACP surface bypasses
 * policy entirely.
 */
export const ACP_TOOL_POLICY_NAMES: Record<string, string> = {
  "devdesktop-read": "read",
  "devdesktop-write": "write",
  "devdesktop-edit": "edit",
  "devdesktop-grep": "grep",
  "devdesktop-glob": "glob",
  "devdesktop-shell": "bash",
};

export function canonicalToolName(tool: string): string {
  return ACP_TOOL_POLICY_NAMES[tool] ?? tool;
}

export interface PolicyApprovalEventPayload {
  approvalId: string;
  workspaceId: string;
  workSessionId?: string;
  runId?: string;
  principalId: string;
  tool: string;
  path?: string;
  command?: string;
  approvalKey: string;
  approvalKeyType: PolicyDecision["source"];
  matchedPattern?: string;
}

export interface PolicyEnforcer {
  /**
   * Evaluate the policy for an invocation. Returns:
   *   - { allowed: true }                       if allow / already-approved
   *   - { allowed: false, decision }            if deny
   *   - { allowed: false, decision, blocked }   if ask & waiting on a human
   *
   * When `ask`, emits `policy.approval_requested` and blocks on
   * `policy.approval.provided` for up to `timeoutMs`. The approval decision's
   * scope is recorded via `recordApproval` using the canonical approval key.
   */
  enforce(inv: PolicyInvocation): Promise<{ allowed: boolean; decision: PolicyDecision }>;
}

export function createPolicyEnforcer(
  policy: PolicyEngine,
  eventStore: EventStore,
  opts: { timeoutMs?: number } = {},
): PolicyEnforcer {
  const timeoutMs = opts.timeoutMs ?? 300_000;

  return {
    async enforce(inv: PolicyInvocation): Promise<{ allowed: boolean; decision: PolicyDecision }> {
      const canonical = canonicalToolName(inv.tool);
      const decision = policy.evaluate(canonical, inv.path, inv.workspaceId);

      if (decision.mode === "allow") return { allowed: true, decision };
      if (decision.mode === "deny") return { allowed: false, decision };

      // mode === "ask": check for an existing scoped approval.
      const already = policy.isApproved(inv.principalId, decision.approvalKey!, {
        workspaceId: inv.workspaceId,
        workSessionId: inv.workSessionId,
      });
      if (already) return { allowed: true, decision };

      const approvalId = `pol_${randomUUID()}`;
      policy.addPending({
        id: approvalId,
        principalId: inv.principalId,
        workspaceId: inv.workspaceId,
        workSessionId: inv.workSessionId,
        tool: canonical,
        path: inv.path,
        command: inv.command,
        requestedAt: new Date().toISOString(),
      });

      const payload: PolicyApprovalEventPayload = {
        approvalId,
        workspaceId: inv.workspaceId,
        workSessionId: inv.workSessionId,
        runId: inv.runId,
        principalId: inv.principalId,
        tool: canonical,
        path: inv.path,
        command: inv.command,
        approvalKey: decision.approvalKey!,
        approvalKeyType: decision.source,
        matchedPattern: decision.matchedPattern,
      };

      eventStore.appendEvent({
        type: "policy.approval_requested",
        sessionId: inv.workSessionId ?? inv.workspaceId,
        payload: payload as unknown as Record<string, unknown>,
      });

      const event = await eventStore.waitForEvent(
        inv.workSessionId ?? inv.workspaceId,
        "policy.approval.provided",
        (e: { payload?: Record<string, unknown> }) => e.payload?.approvalId === approvalId,
        timeoutMs,
      );

      policy.clearPending(approvalId);

      if (!event) return { allowed: false, decision }; // timeout = denied

      const decision2 = String(event.payload.decision ?? "deny");
      const scope = (event.payload.scope as ApprovalScope) ?? "once";

      if (decision2 === "deny") return { allowed: false, decision };

      // Record the approval under the CANONICAL key — never reconstruct from the
      // raw invocation. This fixes the broken "approve for session" caching.
      if (decision2 === "approve" && decision.approvalKey) {
        policy.recordApproval(inv.principalId, decision.approvalKey, scope, {
          workspaceId: inv.workspaceId,
          workSessionId: inv.workSessionId,
        });
      }

      return { allowed: decision2 === "approve", decision };
    },
  };
}
