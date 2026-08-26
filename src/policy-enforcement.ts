import { randomUUID } from "node:crypto";
import type { PolicyEngine, PolicyDecision, ApprovalScope, PolicyInputPath } from "./policy.js";
import { CANONICAL_TOOL_ALIASES } from "./policy.js";
import type { EventStore } from "./event-log.js";

export type PrincipalRole = "reviewer" | "worker" | "client";

export interface PolicyInvocation {
  principalId: string;
  principalRole: PrincipalRole;
  workspaceId: string;
  workSessionId?: string;
  runId?: string;
  tool: string;
  path?: PolicyInputPath;
  /** All affected paths for a multi-file action such as apply_patch. */
  paths?: PolicyInputPath[];
  command?: string;
}

/**
 * Canonical ACP tool names map onto the same policy keys as the MCP tools.
 * If ACP `kontrol-write` is gated as `write`, then the MCP `write` tool is
 * gated by the exact same rule. Delegates to the single canonical map in
 * policy.ts so MCP/ACP/process-session surfaces can never diverge.
 */
export const ACP_TOOL_POLICY_NAMES: Record<string, string> = CANONICAL_TOOL_ALIASES;

export function canonicalToolName(tool: string): string {
  return CANONICAL_TOOL_ALIASES[tool] ?? tool;
}

function policyPathLabel(path: PolicyInputPath | undefined): string | undefined {
  if (path === undefined) return undefined;
  return typeof path === "string" ? path : path.relativePath;
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
  enforce(inv: PolicyInvocation): Promise<{
    allowed: boolean;
    decision: PolicyDecision;
    outcome?: "approved" | "denied" | "timed_out";
  }>;
}

export function createPolicyEnforcer(
  policy: PolicyEngine,
  eventStore: EventStore,
  opts: { timeoutMs?: number } = {},
): PolicyEnforcer {
  const timeoutMs = opts.timeoutMs ?? 300_000;

  return {
    async enforce(inv: PolicyInvocation): Promise<{ allowed: boolean; decision: PolicyDecision; outcome?: "approved" | "denied" | "timed_out" }> {
      const canonical = canonicalToolName(inv.tool);
      const paths = inv.paths && inv.paths.length > 0 ? inv.paths : [inv.path];
      const decisions = paths.map((path) => ({
        path,
        decision: policy.evaluate(canonical, path, inv.workspaceId),
      }));

      // Preflight every affected path before asking for any approval. A later
      // denied path must not leave an earlier path's approval request hanging.
      const denied = decisions.find((entry) => entry.decision.mode === "deny");
      if (denied) return { allowed: false, decision: denied.decision };

      let firstDecision = decisions[0]?.decision;
      let lastOutcome: "approved" | "denied" | "timed_out" | undefined;
      for (const entry of decisions) {
        firstDecision ??= entry.decision;
        if (entry.decision.mode === "allow") continue;

        // mode === "ask": check for an existing scoped approval.
        const already = policy.isApproved(inv.principalId, entry.decision.approvalKey!, {
          workspaceId: inv.workspaceId,
          workSessionId: inv.workSessionId,
        });
        if (already) continue;

        const result = await waitForApproval(entry.decision, entry.path);
        if (!result.allowed) return result;
        lastOutcome = result.outcome;
      }

      return { allowed: true, decision: firstDecision!, outcome: lastOutcome };

      async function waitForApproval(
        decision: PolicyDecision,
        path: PolicyInputPath | undefined,
      ): Promise<{ allowed: boolean; decision: PolicyDecision; outcome?: "approved" | "denied" | "timed_out" }> {

        const approvalId = `pol_${randomUUID()}`;
        policy.addPending({
          id: approvalId,
          principalId: inv.principalId,
          workspaceId: inv.workspaceId,
          workSessionId: inv.workSessionId,
          tool: canonical,
          path: policyPathLabel(path),
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
          path: policyPathLabel(path),
          command: inv.command,
          approvalKey: decision.approvalKey!,
          approvalKeyType: decision.source,
          matchedPattern: decision.matchedPattern,
        };

        const requestEvent = eventStore.appendEvent({
          type: "policy.approval_requested",
          sessionId: inv.workSessionId ?? inv.workspaceId,
          payload: payload as unknown as Record<string, unknown>,
        });

        try {
          // The request event is the durable ordering anchor. Subscribe-first
          // plus the durable reread prevents a reviewer who responds in the
          // append/wait gap from being mistaken for a timeout.
          const event = await eventStore.waitForMatchingEventAfter(
            inv.workSessionId ?? inv.workspaceId,
            requestEvent.seq,
            (candidate) => candidate.type === "policy.approval.provided"
              && candidate.payload.approvalId === approvalId,
            timeoutMs,
          );

          if (!event) {
            policy.resolvePending(approvalId, "expired", "approval timed out");
            return { allowed: false, decision, outcome: "timed_out" };
          }

          const decision2 = String(event.payload.decision ?? "deny");
          const scope = (event.payload.scope as ApprovalScope) ?? "once";

          if (decision2 !== "approve") {
            policy.resolvePending(approvalId, "denied", String(event.payload.reason ?? "denied by reviewer"));
            return { allowed: false, decision, outcome: "denied" };
          }

          // Record the approval under the CANONICAL key — never reconstruct
          // from the raw invocation.
          if (decision.approvalKey) {
            policy.recordApproval(inv.principalId, decision.approvalKey, scope, {
              workspaceId: inv.workspaceId,
              workSessionId: inv.workSessionId,
            });
          }
          policy.resolvePending(approvalId, "approved", String(event.payload.reason ?? "approved by reviewer"));
          return { allowed: true, decision, outcome: "approved" };
        } finally {
          policy.clearPending(approvalId);
        }
      }
    },
  };
}
