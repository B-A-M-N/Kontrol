/**
 * Shared live-waiter registry for in-flight policy approval waits on the MCP
 * hop, plus their diagnostics. Extracted verbatim from src/server.ts (P1.2).
 */
import type { McpPolicyWaiter } from "./mcp-session-state.js";

export interface McpPolicyWaiterRegistry {
  readonly waiters: Map<string, McpPolicyWaiter>;
  recordDisconnect(): void;
  recordResume(): void;
  cancelForSession(sessionId: string, requestId?: string): number;
  diagnostics(listPending: () => Array<{ kind: string; origin?: string; approvalId: string; reattachDeadline?: string }>): ReturnType<typeof buildPolicyWaiterDiagnostics>;
}

function buildPolicyWaiterDiagnostics(
  waiters: Map<string, McpPolicyWaiter>,
  counters: { disconnects: number; resumes: number; lastDisconnectAt?: number; lastResumeAt?: number },
  listPending: () => Array<{ kind: string; origin?: string; approvalId: string; reattachDeadline?: string }>,
) {
  const byWorkspace = new Map<string, number>();
  const bySession = new Map<string, number>();
  let oldestStartedAt = Number.POSITIVE_INFINITY;
  for (const waiter of waiters.values()) {
    byWorkspace.set(waiter.workspaceId, (byWorkspace.get(waiter.workspaceId) ?? 0) + 1);
    const sessionKey = waiter.mcpSessionId ?? "none";
    bySession.set(sessionKey, (bySession.get(sessionKey) ?? 0) + 1);
    oldestStartedAt = Math.min(oldestStartedAt, waiter.startedAt);
  }
  const pendingPolicyApprovals = listPending().filter((request) => request.kind === "tool");
  const liveApprovalIds = new Set([...waiters.values()].map((waiter) => waiter.approvalId));
  const nowIso = new Date().toISOString();
  // Zero live waiters is the NORMAL shape of a direct MCP approval: the call
  // already returned approval_required and only a human decision is pending.
  // Count a row as orphaned only when its own lifecycle window says so —
  // a work-session approval lost its parked waiter, or a direct operation's
  // reattachment grace has actually elapsed.
  const pendingHumanApproval = pendingPolicyApprovals.filter((approval) => approval.origin === "work_session"
    ? liveApprovalIds.has(approval.approvalId)
    : !(approval.reattachDeadline && approval.reattachDeadline <= nowIso)).length;
  return {
    activePolicyWaiters: waiters.size,
    policyWaitersByWorkspace: Object.fromEntries([...byWorkspace.entries()].map(([key, count]) => [String(key), count])),
    policyWaitersByMcpSession: Object.fromEntries([...bySession.entries()].map(([key, count]) => [String(key), count])),
    oldestPolicyWaitMs: Number.isFinite(oldestStartedAt) ? Math.max(0, Date.now() - oldestStartedAt) : 0,
    pendingApprovalRows: pendingPolicyApprovals.length,
    pendingHumanApproval,
    detachedLiveWaiters: pendingPolicyApprovals.filter((approval) => approval.origin === "work_session"
      && !liveApprovalIds.has(approval.approvalId)).length,
    abandonedOperations: pendingPolicyApprovals.filter((approval) => approval.origin !== "work_session"
      && Boolean(approval.reattachDeadline && approval.reattachDeadline <= nowIso)).length,
    orphanedPendingApprovals: pendingPolicyApprovals.filter((approval) => approval.origin === "work_session"
      ? !liveApprovalIds.has(approval.approvalId)
      : Boolean(approval.reattachDeadline && approval.reattachDeadline <= nowIso)).length,
    suspendedExecutionRequests: waiters.size,
    policyWaiterDisconnects: counters.disconnects,
    policyWaiterResumes: counters.resumes,
    lastPolicyWaiterDisconnectAt: counters.lastDisconnectAt ? new Date(counters.lastDisconnectAt).toISOString() : undefined,
    lastPolicyWaiterResumeAt: counters.lastResumeAt ? new Date(counters.lastResumeAt).toISOString() : undefined,
  };
}

export function createPolicyWaiterRegistry(): McpPolicyWaiterRegistry {
  const waiters = new Map<string, McpPolicyWaiter>();
  let policyWaiterDisconnects = 0;
  let policyWaiterResumes = 0;
  let lastPolicyWaiterDisconnectAt: number | undefined;
  let lastPolicyWaiterResumeAt: number | undefined;
  const counters = {
    get disconnects() { return policyWaiterDisconnects; },
    get resumes() { return policyWaiterResumes; },
    get lastDisconnectAt() { return lastPolicyWaiterDisconnectAt; },
    get lastResumeAt() { return lastPolicyWaiterResumeAt; },
  };
  return {
    waiters,
    recordDisconnect() {
      policyWaiterDisconnects++;
      lastPolicyWaiterDisconnectAt = Date.now();
    },
    recordResume() {
      policyWaiterResumes++;
      lastPolicyWaiterResumeAt = Date.now();
    },
    cancelForSession(sessionId: string, requestId?: string): number {
      let cancelled = 0;
      for (const waiter of waiters.values()) {
        if (waiter.mcpSessionId !== sessionId) continue;
        if (requestId && waiter.mcpRequestId !== requestId) continue;
        if (waiter.signal.aborted) continue;
        waiter.cancel();
        cancelled++;
      }
      return cancelled;
    },
    diagnostics(listPending) {
      return buildPolicyWaiterDiagnostics(waiters, counters, listPending);
    },
  };
}
