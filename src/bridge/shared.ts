/**
 * Shared bridge helpers and small types
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import { selectHealthyAgent } from "../acp-gateway.js";
import type { AgentInfo } from "../acp-registry.js";
import type { MissionReviewPacket } from "../mission-ledger.js";
import type { PrincipalRole } from "../policy-enforcement.js";
import { workspaceAppToolMeta } from "../workspace-app-resource.js";
import type { BridgeConfig } from "./context.js";
import { realpath } from "node:fs/promises";

export interface LiveWaiterRegistry {
  add(sessionId: string): string;
  /**
   * Remove a waiter. Returns true if this removal emptied the waiter set for
   * the session (i.e. it was the LAST live waiter), so callers can emit a
   * `worker.waiter.closed` event and wake the continuation dispatcher
   * immediately instead of waiting for the lease sweep.
   */
  remove(sessionId: string, waiterId?: string): boolean;
  has(sessionId: string): boolean;
}

export function workspaceAppModelAndAppMeta() {
  return workspaceAppToolMeta();
}

export function compactMissionPacket(packet: MissionReviewPacket): MissionReviewPacket {
  const unresolvedCriteria = packet.criteria.filter((criterion) => criterion.status !== "verified");
  const blockingFindings = packet.findings.filter((finding) =>
    finding.scope !== "out_of_scope" &&
    (finding.severity === "blocker" || finding.severity === "high") &&
    !["verified_resolved", "waived"].includes(finding.status),
  );
  const latestEvidenceByCriterion = new Map<string, MissionReviewPacket["evidence"][number]>();
  for (const evidence of packet.evidence) {
    if (evidence.criterionId && !latestEvidenceByCriterion.has(evidence.criterionId)) {
      latestEvidenceByCriterion.set(evidence.criterionId, evidence);
    }
  }
  return {
    mission: packet.mission,
    criteria: unresolvedCriteria,
    findings: blockingFindings,
    workOrders: packet.workOrders.slice(0, 1),
    evidence: [...latestEvidenceByCriterion.values()],
    completionReports: packet.completionReports.slice(0, 1),
    approval: packet.approval,
  };
}

export const defaultLiveWaiters: LiveWaiterRegistry = (() => {
  const map = new Map<string, Set<string>>();
  return {
    add: (id) => {
      const waiterId = `waiter_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const set = map.get(id) ?? new Set<string>();
      set.add(waiterId);
      map.set(id, set);
      return waiterId;
    },
    remove: (id, waiterId) => {
      const set = map.get(id);
      if (!set) return false;
      if (waiterId) set.delete(waiterId);
      else set.clear();
      const empty = set.size === 0;
      if (empty) map.delete(id);
      return empty;
    },
    has: (id) => (map.get(id)?.size ?? 0) > 0,
  };
})();

export function isReviewer(role?: PrincipalRole): boolean {
  return role === "reviewer";
}

export function isWorkerOrClient(role?: PrincipalRole): boolean {
  return role === "worker" || role === "client" || role === undefined;
}

/**
 * Native ACP agents such as Hermes do not receive Kontrol's MCP tool list.
 * Their adapter turns a completed native turn into the durable review
 * submission on their behalf (see acp-server's native review barrier). Giving
 * them the stdio-worker instruction would make them search for tools that do
 * not exist and, in practice, keep an otherwise completed turn alive.
 */
export function usesExternalReviewBarrier(agent?: Pick<AgentInfo, "capabilities">): boolean {
  return agent?.capabilities.includes("native-acp") === true;
}

export function workSessionInstructions(workSessionId: string, agent?: Pick<AgentInfo, "capabilities">): string {
  if (usesExternalReviewBarrier(agent)) {
    return `[Kontrol work session ${workSessionId}] This is a native ACP turn. Complete the bounded work order, run the requested checks, and return a concise summary. Kontrol will capture the review submission and enforce the review barrier after your turn returns. Do not wait for or search for submit_for_review, await_review_feedback, or start_work_session tools.`;
  }
  return `[Kontrol work session ${workSessionId}] Use this existing session: call submit_for_review with sessionId="${workSessionId}" when done, then await_review_feedback(sessionId="${workSessionId}"). Do NOT call start_work_session.`;
}

export function forbidden(role?: PrincipalRole, tool?: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [{ type: "text" as const, text: `Forbidden: ${tool ?? "this tool"} requires a different role (current: ${role ?? "unknown"}).` }],
    isError: true,
  };
}

export function resolveDelegationContext(
  config: BridgeConfig,
  input: {
    workspaceSessionId?: string;
    workspaceId?: string;
    workSessionId?: string;
    sessionId?: string;
  },
): { workspaceSessionId?: string; workSessionId?: string; error?: string } {
  const workSessionId = input.workSessionId ?? input.sessionId;
  const existingSession = workSessionId ? config.workSessions.get(workSessionId) : undefined;
  const workspaceSessionId = input.workspaceSessionId ?? input.workspaceId ?? existingSession?.workspaceSessionId;

  if (workSessionId && !existingSession) {
    return { workSessionId, workspaceSessionId, error: `Unknown work session: ${workSessionId}.` };
  }
  if (!workspaceSessionId) {
    return {
      workSessionId,
      error: "Unknown workspace. Supply workspaceId/workspaceSessionId, or pass an existing workSessionId/sessionId.",
    };
  }
  try {
    config.workspaces.getWorkspace(workspaceSessionId);
  } catch {
    return { workSessionId, workspaceSessionId, error: `Unknown workspace: ${workspaceSessionId}.` };
  }
  if (existingSession && existingSession.workspaceSessionId !== workspaceSessionId) {
    return {
      workSessionId,
      workspaceSessionId,
      error: `Work session ${workSessionId} belongs to a different workspace (${existingSession.workspaceSessionId}), not ${workspaceSessionId}.`,
    };
  }
  return { workspaceSessionId, workSessionId };
}

/**
 * P0 #6: a dispatched worker is cryptographically bound to exactly one signed
 * work session. It must not act on a different session — cross-session access
 * defeats the correlation contract. Enforced only when a binding is present
 * (a non-dispatched client has no connectionWorkSessionId and is unrestricted).
 */
export function assertWorkerSessionBinding(config: BridgeConfig, sessionId: string) {
  if (config.principalRole === "worker" && config.connectionWorkSessionId && sessionId !== config.connectionWorkSessionId) {
    return forbidden(config.principalRole, "cross-session access");
  }
  if (config.principalRole === "worker" && config.connectionWorkSessionId === sessionId) {
    const lease = config.workSessions.getWorkspaceLeaseForSession(sessionId);
    if (lease && lease.leaseNonce !== config.connectionWorkspaceLeaseNonce) {
      return forbidden(config.principalRole, "stale workspace lease");
    }
  }
  return null;
}

export function requireWorkSessionRead(config: BridgeConfig, sessionId: string) {
  if (isReviewer(config.principalRole)) return null;
  if (config.principalRole === "worker" && config.connectionWorkSessionId === sessionId) return null;
  return forbidden(config.principalRole, "work-session read");
}

export async function acquireCheckoutModifyLease(config: BridgeConfig, workspaceSessionId: string, workSessionId: string) {
  const workspace = config.workspaces.getWorkspace(workspaceSessionId);
  if (workspace.mode !== "checkout") return null;
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(workspace.root);
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: `Unable to resolve checkout root for ${workspaceSessionId}: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true as const,
    };
  }
  const lease = config.workSessions.acquireWorkspaceLease({
    canonicalRoot,
    workspaceSessionId,
    workSessionId,
  });
  if (lease.acquired) return null;
  return {
    content: [{
      type: "text" as const,
      text: `Checkout is already controlled by work session ${lease.conflictingWorkSessionId}. Use an isolated worktree or cancel the existing session before dispatching another modifying worker.`,
    }],
    structuredContent: {
      conflict: {
        canonicalRoot,
        conflictingWorkSessionId: lease.conflictingWorkSessionId,
        workspaceSessionId: lease.workspaceSessionId,
        expiresAt: lease.expiresAt,
      },
    },
    isError: true as const,
  };
}

export function checkoutLeaseNonce(config: BridgeConfig, workSessionId: string): string | undefined {
  return config.workSessions.getWorkspaceLeaseForSession(workSessionId)?.leaseNonce;
}

export function parsePatchFiles(patch: string): Array<{ path: string; operation: "add" | "update" | "delete"; additions: number; removals: number }> {
  const files: Array<{ path: string; operation: "add" | "update" | "delete"; additions: number; removals: number }> = [];
  const blocks = patch.split(/^diff --git /m).filter(Boolean);
  for (const block of blocks) {
    const headerLines = block.split("\n");
    const newFileMatch = headerLines.find((l) => l.startsWith("+++ "));
    const oldFileMatch = headerLines.find((l) => l.startsWith("--- "));
    const newPath = newFileMatch ? newFileMatch.slice(4).replace(/^\/dev\/null\t?/, "").replace(/^b\//, "").trim() : "";
    const oldPath = oldFileMatch ? oldFileMatch.slice(4).replace(/^\/dev\/null\t?/, "").replace(/^a\//, "").trim() : "";
    const path = newPath || oldPath;
    let additions = 0;
    let removals = 0;
    let inHunk = false;
    for (const l of headerLines) {
      if (l.startsWith("@@")) { inHunk = true; continue; }
      if (!inHunk) continue;
      if (l.startsWith("+") && !l.startsWith("+++")) additions++;
      else if (l.startsWith("-") && !l.startsWith("---")) removals++;
    }
    const operation: "add" | "update" | "delete" = !oldPath || oldPath === "/dev/null" ? "add" : !newPath || newPath === "/dev/null" ? "delete" : "update";
    if (path) files.push({ path, operation, additions, removals });
  }
  return files;
}

export function renderMissionPrompt(config: BridgeConfig, workSessionId: string, fallbackObjective: string): string {
  const packet = config.missionLedger?.getPacket(workSessionId);
  if (!packet?.mission) return "";
  const mission = packet.mission;
  const workOrder = packet.workOrders[0];
  const requiredCriteria = packet.criteria.filter((c) => c.priority === "required");
  const openFindings = packet.findings.filter((f) => ["open", "claimed_resolved"].includes(f.status));
  const lines: string[] = [];
  lines.push("Kontrol supervised mission contract:");
  lines.push(`Objective: ${mission.objective ?? fallbackObjective}`);
  lines.push(`Desired outcome: ${mission.desiredOutcome ?? fallbackObjective}`);
  if (workOrder) {
    lines.push("");
    lines.push(`Current work order ${workOrder.id}: ${workOrder.objectiveForThisTurn}`);
    if (workOrder.requiredFindingIds.length) lines.push(`Required finding IDs: ${workOrder.requiredFindingIds.join(", ")}`);
    if (workOrder.acceptanceCriterionIds.length) lines.push(`Acceptance criterion IDs: ${workOrder.acceptanceCriterionIds.join(", ")}`);
    if (workOrder.requiredActions.length) lines.push(`Required actions: ${workOrder.requiredActions.join("; ")}`);
    if (workOrder.prohibitedActions.length) lines.push(`Prohibited actions: ${workOrder.prohibitedActions.join("; ")}`);
    if (workOrder.expectedDeliverables.length) lines.push(`Expected deliverables: ${workOrder.expectedDeliverables.join("; ")}`);
    if (workOrder.contextReferences.length) lines.push(`Context references: ${workOrder.contextReferences.join("; ")}`);
  }
  if (requiredCriteria.length) {
    lines.push("");
    lines.push("Required acceptance criteria:");
    for (const criterion of requiredCriteria) lines.push(`- ${criterion.id}: ${criterion.description} [${criterion.status}]`);
  }
  if (openFindings.length) {
    lines.push("");
    lines.push("Open findings to address:");
    for (const finding of openFindings) lines.push(`- ${finding.id} (${finding.severity}): ${finding.requiredAction}`);
  }
  lines.push("");
  lines.push("Submit evidence in your review summary. The WebUI supervisor decides mission completion; do not self-approve.");
  return lines.join("\n");
}

export async function resolveHealthyAgentUrl(config: BridgeConfig, agentName = "cli-coding-agent"): Promise<string> {
  const selection = await selectHealthyAgent(config.agentRegistry.listAlive(), {
    name: agentName,
    role: "agent",
    adapterSecret: config.adapterSecret,
  });
  if (!selection.agent) throw new Error(`No healthy ${agentName} available to resume`);
  return selection.agent.url;
}
