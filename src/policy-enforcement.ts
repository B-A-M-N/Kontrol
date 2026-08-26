import { randomUUID } from "node:crypto";
import type { PolicyEngine, PolicyDecision, ApprovalScope, PolicyInputPath } from "./policy.js";
import { CANONICAL_TOOL_ALIASES } from "./policy.js";
import type { EventStore } from "./event-log.js";
import type { ApprovalOption } from "./approval-requests.js";

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
  /** Abort when the originating MCP/ACP request genuinely disappears. */
  signal?: AbortSignal;
  /** Suspend the request's execution lease while a human approval is pending. */
  onPolicyWaitStart?: (context: PolicyWaitContext) => void | Promise<void>;
  /** Resume the request's execution lease after the approval decision. */
  onPolicyWaitEnd?: (context: PolicyWaitContext & { outcome: PolicyWaitOutcome }) => void | Promise<void>;
  /**
   * Identity of the originating MCP request. Two invocations with the same
   * (mcpSessionId, mcpRequestId) are the SAME live call retrying — they must
   * dedupe to one approval row. Invocations with different ids are independent
   * and each get their own waiter/approval, even for identical work.
   */
  mcpSessionId?: string;
  mcpRequestId?: string;
}

export type PolicyWaitOutcome = "approved" | "denied" | "timed_out" | "cancelled" | "caller_gone";

export interface PolicyWaitContext {
  approvalId: string;
  approvalKey: string;
  waiterKey: string;
  /** Identifier of the LIVE waiter; equal to mcpRequestId (or a synthetic
   *  nonce when there is no MCP request id). Cancelled or detached waiters
   *  must not resume even when the durable approval row later resolves. */
  liveWaiterId: string;
  principalId: string;
  workspaceId: string;
  workSessionId?: string;
  tool: string;
  path?: string;
  command?: string;
  mcpSessionId?: string;
  mcpRequestId?: string;
  coalesced: boolean;
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
  /**
   * Authoritative server-created approval options. Rehydrating clients (e.g.
   * via list_pending_approvals) must always reconcile with these, never
   * invent their own. Approve Once / Session / Workspace are determined
   * by the presence of workSessionId; Deny is always offered.
   */
  options: Array<{
    id: string;
    label: string;
    effect: "approve" | "deny";
    scope?: ApprovalScope;
  }>;
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
   *
   * Two-phase admission (P0.1): the caller is expected to release execution
   * capacity inside `onPolicyWaitStart` and reacquire it inside `onPolicyWaitEnd`
   * when the outcome is `approved`. The policy enforcer never holds execution
   * capacity for the blocked request — it only holds the in-memory waiter.
   *
   * Live-vs-durable separation (P0.3/P0.4): each invocation gets its own
   * approval row, identified by `(mcpSessionId, mcpRequestId, approvalKey)`.
   * Cancelling the originating signal only releases the LIVE waiter; the
   * durable approval row remains available so a later live retry can attach
   * to it and resume under the eventual reviewer decision.
   */
  enforce(inv: PolicyInvocation): Promise<{
    allowed: boolean;
    decision: PolicyDecision;
    outcome?: PolicyWaitOutcome;
  }>;
}

/**
 * Build the stable identity of the durable approval row for an invocation.
 * Two invocations with the same (mcpSessionId, mcpRequestId, approvalKey)
 * are the SAME live call retrying — they MUST reuse one durable row, not
 * each create their own. Invocations with different MCP identities remain
 * independent even for identical work.
 */
function approvalRowKey(inv: PolicyInvocation, approvalKey: string): string {
  const session = inv.mcpSessionId ?? "";
  const request = inv.mcpRequestId ?? "";
  return `${session}|${request}|${inv.principalId}|${inv.workspaceId}|${inv.workSessionId ?? ""}|${approvalKey}`;
}

export function createPolicyEnforcer(
  policy: PolicyEngine,
  eventStore: EventStore,
  opts: { timeoutMs?: number } = {},
): PolicyEnforcer {
  // Blocking approvals are intentionally long-lived. The server supplies a
  // deployment backstop, while the originating request signal cancels a
  // waiter when its caller actually disconnects.
  const timeoutMs = opts.timeoutMs ?? 24 * 60 * 60_000;

  return {
    async enforce(inv: PolicyInvocation): Promise<{ allowed: boolean; decision: PolicyDecision; outcome?: PolicyWaitOutcome }> {
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
      let lastOutcome: PolicyWaitOutcome | undefined;
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
      ): Promise<{ allowed: boolean; decision: PolicyDecision; outcome?: PolicyWaitOutcome }> {
        const approvalKey = decision.approvalKey!;
        const rowKey = approvalRowKey(inv, approvalKey);

        // P0.4 dedup: only the SAME live invocation (matching mcpSessionId +
        // mcpRequestId) reuses the durable approval row. Concurrent identical
        // calls from different MCP sessions each get their own row.
        const existing = policy.findPendingByKey(rowKey);
        const approvalId = existing?.id ?? `pol_${randomUUID()}`;
        const isCoalesced = Boolean(existing);
        const liveWaiterId = inv.mcpRequestId ?? `synthetic_${randomUUID()}`;
        const policyPath = policyPathLabel(path);
        const waitContext: PolicyWaitContext = {
          approvalId,
          approvalKey,
          waiterKey: rowKey,
          liveWaiterId,
          principalId: inv.principalId,
          workspaceId: inv.workspaceId,
          workSessionId: inv.workSessionId,
          tool: canonical,
          path: policyPath,
          command: inv.command,
          mcpSessionId: inv.mcpSessionId,
          mcpRequestId: inv.mcpRequestId,
          coalesced: isCoalesced,
        };

        // P0.1: signal the caller to release execution weight BEFORE we
        // commit any durable state, so an aborted request never leaves an
        // immortal capacity reservation on the live invoker.
        if (inv.signal?.aborted) {
          return { allowed: false, decision, outcome: "cancelled" };
        }
        await inv.onPolicyWaitStart?.(waitContext);

        let requestAfterSeq = 0;
        if (!existing) {
          const options: ApprovalOption[] = [
            { id: "approve", label: "Approve Once", effect: "approve", scope: "once" },
            ...(inv.workSessionId ? [{ id: "approve_session", label: "Approve Session", effect: "approve" as const, scope: "work_session" as const }] : []),
            { id: "approve_workspace", label: "Approve Workspace", effect: "approve", scope: "workspace" },
            { id: "deny", label: "Deny", effect: "deny" },
          ];
          policy.addPending({
            id: approvalId,
            principalId: inv.principalId,
            workspaceId: inv.workspaceId,
            workSessionId: inv.workSessionId,
            approvalKey,
            mcpSessionId: inv.mcpSessionId,
            mcpRequestId: inv.mcpRequestId,
            waiterKey: rowKey,
            liveWaiterId,
            options,
            tool: canonical,
            path: policyPath,
            command: inv.command,
            requestedAt: new Date().toISOString(),
            expiresAt: Number.isFinite(timeoutMs)
              ? new Date(Date.now() + timeoutMs).toISOString()
              : undefined,
          });

          const payload: PolicyApprovalEventPayload = {
            approvalId,
            workspaceId: inv.workspaceId,
            workSessionId: inv.workSessionId,
            runId: inv.runId,
            principalId: inv.principalId,
            tool: canonical,
            path: policyPath,
            command: inv.command,
            approvalKey,
            approvalKeyType: decision.source,
            matchedPattern: decision.matchedPattern,
            options,
          };
          requestAfterSeq = eventStore.appendEvent({
            type: "policy.approval_requested",
            sessionId: inv.workSessionId ?? inv.workspaceId,
            payload: payload as unknown as Record<string, unknown>,
          }).seq;
        } else {
          // Re-attach path: refresh the liveWaiterId for an existing row so
          // a stale approval can resume under the new live invocation only.
          const session = (inv.workSessionId ?? inv.workspaceId);
          requestAfterSeq = eventStore.getLatestEvent(session)?.seq ?? 0;
          policy.reattachLiveWaiter(approvalId, liveWaiterId);
        }

        let lifecycleEnded = false;
        const endLifecycle = async (outcome: PolicyWaitOutcome): Promise<void> => {
          if (lifecycleEnded) return;
          lifecycleEnded = true;
          await inv.onPolicyWaitEnd?.({ ...waitContext, outcome });
        };
        try {
          // The request event is the durable ordering anchor. Subscribe-first
          // plus the durable reread prevents a reviewer who responds in the
          // append/wait gap from being mistaken for a timeout.
          const event = await eventStore.waitForMatchingEventAfter(
            inv.workSessionId ?? inv.workspaceId,
            requestAfterSeq,
            (candidate) => candidate.type === "policy.approval.provided"
              && candidate.payload.approvalId === approvalId,
            timeoutMs,
            inv.signal,
          );

          // P0.3/P0.4: caller disappeared (or was aborted upstream) before
          // the reviewer decided. Release runtime resources immediately,
          // but the durable approval row stays — a future live retry with
          // the same row key can still attach, and a workspace grant may
          // already have been recorded by the reviewer side.
          if (inv.signal?.aborted) {
            // Mark this waiter detached so the eventual resolution does not
            // wake a dead invocation. The durable row is left intact for a
            // later live invocation to attach to.
            policy.detachLiveWaiter(approvalId, liveWaiterId);
            await endLifecycle("caller_gone");
            return { allowed: false, decision, outcome: "caller_gone" };
          }

          if (!event) {
            const cancelled = inv.signal?.aborted === true;
            if (cancelled) {
              policy.detachLiveWaiter(approvalId, liveWaiterId);
              await endLifecycle("caller_gone");
              return { allowed: false, decision, outcome: "caller_gone" };
            }
            policy.resolvePending(approvalId, "expired", "approval timed out");
            await endLifecycle("timed_out");
            return { allowed: false, decision, outcome: "timed_out" };
          }

          // The reviewer decided. If THIS live waiter was already detached
          // (signal aborted while we were in waitForMatchingEventAfter),
          // do NOT resume the dead invocation. The durable row is resolved,
          // which releases the grant for any future live retry that already
          // attached and matches the row key.
          const decision2 = String(event.payload.decision ?? "deny");
          const scope = (event.payload.scope as ApprovalScope) ?? "once";
          const myLiveState = policy.getLiveWaiterState(approvalId, liveWaiterId);

          if (decision2 !== "approve") {
            policy.resolvePending(approvalId, "denied", String(event.payload.reason ?? "denied by reviewer"));
            if (myLiveState === "dead") {
              await endLifecycle("caller_gone");
              return { allowed: false, decision, outcome: "caller_gone" };
            }
            await endLifecycle("denied");
            return { allowed: false, decision, outcome: "denied" };
          }

          // Approved. Record the canonical-key grant BEFORE resolving, so a
          // workspace approval can be reused by any later live invocation in
          // the same workspace even if the original caller has gone.
          if (decision.approvalKey) {
            policy.recordApproval(inv.principalId, decision.approvalKey, scope, {
              workspaceId: inv.workspaceId,
              workSessionId: inv.workSessionId,
            });
          }
          policy.resolvePending(approvalId, "approved", String(event.payload.reason ?? "approved by reviewer"));

          if (myLiveState === "dead") {
            // The grant is recorded; the dead invocation must not resume.
            await endLifecycle("caller_gone");
            return { allowed: false, decision, outcome: "caller_gone" };
          }
          await endLifecycle("approved");
          return { allowed: true, decision, outcome: "approved" };
        } finally {
          // P0.3: a successful resolution already cleared the durable row
          // via resolvePending. A failed wait (caller_gone) leaves the
          // durable row intact for a future live reattach. We must NOT
          // unconditionally clearPending — that would orphan the durable
          // card right when a reconnection was about to use it.
          if (inv.signal?.aborted) {
            policy.detachLiveWaiter(approvalId, liveWaiterId);
          }
        }
      }
    },
  };
}
