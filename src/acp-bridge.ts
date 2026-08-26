import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkSessionManager } from "./work-sessions.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { ReviewCheckpointManager } from "./review-checkpoints.js";
import type { AgentInfo, AgentRegistryManager } from "./acp-registry.js";
import type { EventStore, EventStoreEvent, EventPredicate } from "./event-log.js";
import { type ContinuationManager, type Continuation, DEFAULT_CLAIM_LEASE_MS } from "./continuation.js";
import { callRemoteAgent, cancelRemoteRun, selectHealthyAgent, probeAgent, type AgentCallResult } from "./acp-gateway.js";
import { TERMINAL_STATUSES, type ReviewWorkflowService } from "./review-workflow.js";
import { authorizeWorkSessionAction } from "./work-session-action-guard.js";
import type { PrincipalRole } from "./policy-enforcement.js";
import type { MissionLedger, MissionReviewPacket } from "./mission-ledger.js";
import type { DispatchOutbox, DispatchOutboxEvent } from "./dispatch-outbox.js";
import type { AgentMessageManager } from "./agent-messages.js";
import { AGENT_MESSAGE_KINDS } from "./agent-messages.js";
import { workspaceAppToolMeta } from "./workspace-app-resource.js";
import { verifyMissionSubmission } from "./mission-verifier.js";
import type { SupervisorRuns } from "./supervisor-runs.js";
import type { ServerConfig } from "./config.js";
import { loadSkillIndex } from "./skills.js";
import type { DatabaseHandle } from "./db/client.js";
import type { ReviewSubmissionDTO } from "./review-submission.js";

function workspaceAppModelAndAppMeta() {
  return workspaceAppToolMeta();
}

function compactMissionPacket(packet: MissionReviewPacket): MissionReviewPacket {
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

export interface BridgeConfig {
  /** Shared SQLite handle used for atomic snapshot+cursor reads. */
  db?: DatabaseHandle;
  workspaces: WorkspaceRegistry;
  workSessions: WorkSessionManager;
  reviewCheckpoints: ReviewCheckpointManager;
  agentRegistry: AgentRegistryManager;
  eventStore: EventStore;
  continuationManager: ContinuationManager;
  /** Authoritative review state machine; both transports must use it. */
  reviewWorkflow: ReviewWorkflowService;
  dispatchOutbox?: DispatchOutbox;
  missionLedger?: MissionLedger;
  supervisorRuns?: SupervisorRuns;
  onSupervisorResume?: (workSessionId: string) => void;
  /** Durable agent→WebUI messages/artifacts (clarifications, blockers, findings). */
  agentMessages?: AgentMessageManager;
  /** Pending approval requests for tools/commands that require human approval. */
  approvalRequests?: ReturnType<typeof import("./approval-requests.js").createApprovalRequestManager>;
  knownAgents: Array<{ name: string; url: string; description?: string }>;
  /** P0 #9: outbound adapter credential. */
  adapterSecret?: string;
  /** Server config for skill discovery (P1 #10). */
  serverConfig?: ServerConfig;
  /**
   * The role of the caller presenting this MCP connection. The WebUI connects
   * as a reviewer/client; the coding agent connects as a worker. Role checks
   * on reviewer-only and worker-only tools are enforced server-side so a worker
   * cannot, e.g., self-approve a review or invoke submit_to_coding_agent.
   */
  principalRole?: PrincipalRole;
  /** Continuation ID authenticated on this connection, when a dispatched worker reconnects. */
  connectionContinuationId?: string;
  /** Bound work session ID authenticated on this connection, when a dispatched worker reconnects. */
  connectionWorkSessionId?: string;
  /** Checkout lease nonce authenticated on this worker connection. */
  connectionWorkspaceLeaseNonce?: string;
  /**
   * Tracks which work sessions currently have a live agent parked inside
   * await_review_feedback. The continuation dispatcher consults this so it only
   * re-dispatches (redrives) for DEAD/disconnected agents — a live parked
   * waiter is woken by the feedback event itself, so double-dispatch is
   * suppressed (fixes duplicate-agent launches on changes_requested).
   */
  liveWaiters?: LiveWaiterRegistry;
  /**
   * Optional override for how a continuation is re-dispatched to the coding
   * agent. Used by tests to intercept dispatch; in production the default HTTP
   * callRemoteAgent path runs.
   */
  resumeAgent?: (continuation: Continuation, sessionId: string) => Promise<void>;
  /** Test hook used to exercise cancellation between claim and dispatch. */
  beforeContinuationDispatch?: (continuation: Continuation, sessionId: string) => Promise<void>;
  /** Rolling server diagnostics for expensive bridge phases. */
  onPhaseTiming?: (phase: string, durationMs: number) => void;
}

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

const defaultLiveWaiters: LiveWaiterRegistry = (() => {
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

function isReviewer(role?: PrincipalRole): boolean {
  return role === "reviewer";
}

function isWorkerOrClient(role?: PrincipalRole): boolean {
  return role === "worker" || role === "client" || role === undefined;
}

/**
 * Native ACP agents such as Hermes do not receive Kontrol's MCP tool list.
 * Their adapter turns a completed native turn into the durable review
 * submission on their behalf (see acp-server's native review barrier). Giving
 * them the stdio-worker instruction would make them search for tools that do
 * not exist and, in practice, keep an otherwise completed turn alive.
 */
function usesExternalReviewBarrier(agent?: Pick<AgentInfo, "capabilities">): boolean {
  return agent?.capabilities.includes("native-acp") === true;
}

function workSessionInstructions(workSessionId: string, agent?: Pick<AgentInfo, "capabilities">): string {
  if (usesExternalReviewBarrier(agent)) {
    return `[Kontrol work session ${workSessionId}] This is a native ACP turn. Complete the bounded work order, run the requested checks, and return a concise summary. Kontrol will capture the review submission and enforce the review barrier after your turn returns. Do not wait for or search for submit_for_review, await_review_feedback, or start_work_session tools.`;
  }
  return `[Kontrol work session ${workSessionId}] Use this existing session: call submit_for_review with sessionId="${workSessionId}" when done, then await_review_feedback(sessionId="${workSessionId}"). Do NOT call start_work_session.`;
}

function forbidden(role?: PrincipalRole, tool?: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [{ type: "text" as const, text: `Forbidden: ${tool ?? "this tool"} requires a different role (current: ${role ?? "unknown"}).` }],
    isError: true,
  };
}

function resolveDelegationContext(
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
function assertWorkerSessionBinding(config: BridgeConfig, sessionId: string) {
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

function requireWorkSessionRead(config: BridgeConfig, sessionId: string) {
  if (isReviewer(config.principalRole)) return null;
  if (config.principalRole === "worker" && config.connectionWorkSessionId === sessionId) return null;
  return forbidden(config.principalRole, "work-session read");
}

async function acquireCheckoutModifyLease(config: BridgeConfig, workspaceSessionId: string, workSessionId: string) {
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

function checkoutLeaseNonce(config: BridgeConfig, workSessionId: string): string | undefined {
  return config.workSessions.getWorkspaceLeaseForSession(workSessionId)?.leaseNonce;
}

function parsePatchFiles(patch: string): Array<{ path: string; operation: "add" | "update" | "delete"; additions: number; removals: number }> {
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

/**
 * Durable, background continuation dispatcher (Ralphie Muntz Loop auto-driver).
 *
 * Single-instance ownership: the Kontrol process creates ONE dispatcher in
 * createServer() and shares its liveWaiters with every MCP client's
 * BridgeConfig. It is NOT started per-MCP-initialization (that leaked timers and
 * database scans on every client connect).
 *
 * Event-driven: on start it drains pending continuations once, then reacts
 * IMMEDIATELY when a continuation is committed (the `continuation.created`
 * workflow event), instead of scanning the database on a fixed 10s interval.
 * A single lease-expiry timer is scheduled only when a claim is pending, so a
 * crashed dispatcher can requeue its orphaned claims.
 *
 * Ownership rule (fixes duplicate-agent launches): a continuation is only
 * re-dispatched when there is NO live agent already parked on
 * await_review_feedback for that session. A live waiter is woken by the feedback
 * event itself, so the dispatcher must not also spawn a second worker.
 */
export interface ContinuationDispatcher {
  start(): void;
  stop(): void;
  /** One deterministic pass over pending continuations. */
  drainOnce(): Promise<void>;
}

export function createContinuationDispatcher(config: BridgeConfig): ContinuationDispatcher {
  const liveWaiters = config.liveWaiters ?? defaultLiveWaiters;
  const dispatcherId = "kontrol-dispatcher";
  let leaseTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let unsub: (() => void) | null = null;

  function scheduleNextLeaseCheck(): void {
    if (leaseTimer) clearTimeout(leaseTimer);
    if (stopped) return;
    // Bound the next scan to the claim-lease window; if nothing is claimed this
    // is just a liveness sweep.
    leaseTimer = setTimeout(() => {
      if (stopped) return;
      void runContinuationTick(config, liveWaiters).then(scheduleNextLeaseCheck);
    }, DEFAULT_CLAIM_LEASE_MS);
  }

  async function drainOnce(): Promise<void> {
    await runContinuationTick(config, liveWaiters);
  }

  function start(): void {
    stopped = false;
    // Immediate drain for anything already pending (e.g. at process startup).
    void drainOnce();
    // React immediately (no periodic poll) when:
    //  - a continuation is committed (reviewer requested changes),
    //  - the LAST live waiter disconnected (redrive without the lease sweep), or
    //  - a worker attempt exited while the review is still open (the durable
    //    review lives on; redrive only if a continuation later exists).
    unsub = config.eventStore.subscribeAll((event) => {
      if (
        event.type === "continuation.created" ||
        event.type === "worker.waiter.closed" ||
        event.type === "worker.attempt.exited" ||
        event.type === "worker.attempt.failed"
      ) {
        void drainOnce();
      }
    });
    scheduleNextLeaseCheck();
  }

  function stop(): void {
    stopped = true;
    if (leaseTimer) clearTimeout(leaseTimer);
    leaseTimer = null;
    if (unsub) unsub();
    unsub = null;
  }

  return { start, stop, drainOnce };
}

/**
 * Single dispatcher pass. Exported so integration tests can drive the exact same
 * logic deterministically (instead of waiting on the lease timer).
 */
export async function runContinuationTick(
  config: BridgeConfig,
  liveWaiters: LiveWaiterRegistry = config.liveWaiters ?? defaultLiveWaiters,
): Promise<void> {
  const dispatcherId = "kontrol-dispatcher";
  const supersedeContinuation = (continuationId: string, sessionId: string, reason: string) => {
    config.continuationManager.supersede(continuationId, reason);
    config.eventStore.appendEvent({
      type: "continuation.superseded",
      sessionId,
      payload: { continuationId, reason },
    });
  };

  // Requeue continuations whose claim lease expired (e.g. a dispatcher crashed
  // mid-dispatch), so they are not stranded forever.
  config.continuationManager.reapExpiredClaims(DEFAULT_CLAIM_LEASE_MS);
  config.dispatchOutbox?.reapExpiredClaims(DEFAULT_CLAIM_LEASE_MS);

  const dispatchContinuation = async (
    cont: Continuation,
    outboxEvent?: DispatchOutboxEvent,
  ): Promise<"completed" | "deferred" | "failed"> => {
      // A live agent is already parked on await_review_feedback for this session:
      // the feedback event will wake it directly. Do NOT spawn a second worker.
      if (liveWaiters.has(cont.sessionId)) {
        outboxEvent
          ? config.dispatchOutbox?.release(outboxEvent.id, DEFAULT_CLAIM_LEASE_MS, "live waiter attached")
          : undefined;
        return "deferred";
      }

      const session = config.workSessions.get(cont.sessionId);
      if (!session) {
        outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
        return "completed";
      }
      if (TERMINAL_STATUSES.has(session.status)) {
        supersedeContinuation(cont.id, cont.sessionId, `session is ${session.status}`);
        outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
        return "completed";
      }

      // Atomic claim (CAS): only one dispatcher owns a given continuation.
      const claimed = config.continuationManager.claim(dispatcherId, { id: cont.id });
      if (!claimed) {
        outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
        return "completed";
      }
      const claimedSession = config.workSessions.get(claimed.sessionId);
      if (!claimedSession || TERMINAL_STATUSES.has(claimedSession.status)) {
        const reason = claimedSession ? `session is ${claimedSession.status}` : "session not found";
        supersedeContinuation(claimed.id, claimed.sessionId, reason);
        outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
        return "completed";
      }

      if (claimed.verdict !== "changes_requested") {
        // Defensive: pending continuations should only be changes_requested.
        config.continuationManager.markCompleted(claimed.id);
        outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
        return "completed";
      }

      const existingRun = config.agentRegistry.getRunByWorkSessionId(claimed.sessionId);
      if (!existingRun) {
        config.continuationManager.release(dispatcherId, { id: claimed.id });
        config.eventStore.appendEvent({
          type: "continuation.dispatch_failed",
          sessionId: claimed.sessionId,
          payload: {
            continuationId: claimed.id,
            reason: "Original ACP run not found",
          },
        });
        outboxEvent
          ? config.dispatchOutbox?.markFailed(outboxEvent.id, "Original ACP run not found", DEFAULT_CLAIM_LEASE_MS)
          : undefined;
        return "failed";
      }
      const missionPacket = config.missionLedger?.getPacket(claimed.sessionId);
      const preferredAgent = missionPacket?.workOrders[0]?.preferredAgent;
      const agentName = preferredAgent || existingRun.agentName;
      const selection = await selectHealthyAgent(config.agentRegistry.listAlive(), {
        name: agentName,
        role: "agent",
        adapterSecret: config.adapterSecret,
      });
      if (!selection.agent) {
        // No healthy agent — release the claim so a later wakeup retries it
        // (the lease prevents it from being re-claimed too eagerly after a blip).
        config.continuationManager.release(dispatcherId, { id: claimed.id });
        outboxEvent
          ? config.dispatchOutbox?.markFailed(outboxEvent.id, "No healthy agent available", DEFAULT_CLAIM_LEASE_MS)
          : undefined;
        return "failed";
      }

      try {
        const preDispatchSession = config.workSessions.get(claimed.sessionId);
        if (!preDispatchSession || TERMINAL_STATUSES.has(preDispatchSession.status)) {
          const reason = preDispatchSession ? `session is ${preDispatchSession.status}` : "session not found";
          supersedeContinuation(claimed.id, claimed.sessionId, reason);
          outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
          return "completed";
        }
        if (config.beforeContinuationDispatch) {
          await config.beforeContinuationDispatch(claimed, claimed.sessionId);
          const afterHookSession = config.workSessions.get(claimed.sessionId);
          if (!afterHookSession || TERMINAL_STATUSES.has(afterHookSession.status)) {
            const reason = afterHookSession ? `session is ${afterHookSession.status}` : "session not found";
            supersedeContinuation(claimed.id, claimed.sessionId, reason);
            outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
            return "completed";
          }
        }

        let result: AgentCallResult;
        if (config.resumeAgent) {
          // Test hook: treat a resolved hook as a successful dispatch. The real
          // run identity is unknown in this case, so fall back to the claimed
          // continuation id as the delivered-run marker.
          await config.resumeAgent(claimed, claimed.sessionId);
          result = { runId: claimed.id, agentName, attemptNumber: 1, status: "running", output: "" };
        } else {
          result = await defaultResume(config, claimed, session, agentName);
        }

        // callRemoteAgent() catches transport errors and returns status:"failed"
        // instead of throwing. Treat that as a failed dispatch so the claim is
        // RELEASED (not marked delivered) and a later wakeup retries it.
        if (result.status === "failed") {
          throw new Error(result.error ?? "ACP continuation dispatch failed");
        }

        // Persist the REAL kontrol run id so reconciliation/delivery records are
        // accurate (the dispatcher id is not a run identity).
        const delivered = config.continuationManager.markDelivered({
          id: claimed.id,
          expectedStatus: "claimed",
          claimOwner: dispatcherId,
          targetRunId: result.runId,
        });
        if (!delivered) {
          outboxEvent
            ? config.dispatchOutbox?.release(outboxEvent.id, DEFAULT_CLAIM_LEASE_MS, "continuation delivery CAS failed")
            : undefined;
          return "deferred";
        }

        // Publish after the continuation is delivered so subscribers react without
        // a poll, and ordering is: feedback -> continuation -> delivered event.
        config.eventStore.appendEvent({
          type: "continuation.delivered",
          sessionId: claimed.sessionId,
          payload: { continuationId: claimed.id, runId: result.runId, remoteRunId: result.remoteRunId, attemptNumber: result.attemptNumber },
        });
        outboxEvent ? config.dispatchOutbox?.markCompleted(outboxEvent.id) : undefined;
        return "completed";
      } catch {
        // Dispatch failed — release so a later wakeup retries it.
        config.continuationManager.release(dispatcherId, { id: claimed.id });
        outboxEvent
          ? config.dispatchOutbox?.markFailed(outboxEvent.id, "ACP continuation dispatch failed", DEFAULT_CLAIM_LEASE_MS)
          : undefined;
        return "failed";
      }
  };

  try {
    if (config.dispatchOutbox) {
      for (const cont of config.continuationManager.listPending()) {
        if (!config.dispatchOutbox.hasLogical("continuation.ready", cont.id, cont.reviewEpoch)) {
          config.dispatchOutbox.enqueue({
            eventType: "continuation.ready",
            aggregateId: cont.id,
            aggregateRevision: cont.reviewEpoch,
            payload: {
              sessionId: cont.sessionId,
              continuationId: cont.id,
              revision: cont.reviewEpoch,
            },
          });
        }
      }

      for (;;) {
        const event = config.dispatchOutbox.claimNext(dispatcherId, DEFAULT_CLAIM_LEASE_MS);
        if (!event) break;
        if (event.eventType !== "continuation.ready") {
          config.dispatchOutbox.markCompleted(event.id);
          continue;
        }
        const cont = config.continuationManager.get(event.aggregateId);
        if (!cont || cont.status !== "pending") {
          config.dispatchOutbox.markCompleted(event.id);
          continue;
        }
        await dispatchContinuation(cont, event);
      }
      return;
    }

    for (const cont of config.continuationManager.listPending()) {
      await dispatchContinuation(cont);
    }
  } catch {
    // Swallow; next drain retries unclaimed continuations.
  }
}

async function defaultResume(
  config: BridgeConfig,
  continuation: Continuation,
  session: { workspaceSessionId: string },
  agentName = "cli-coding-agent",
): Promise<AgentCallResult> {
  const run = config.agentRegistry.getRunByWorkSessionId(continuation.sessionId);
  const agent = config.agentRegistry.listAlive().find((candidate) => candidate.name === agentName);
  const missionPrompt = renderMissionPrompt(config, continuation.sessionId, continuation.promptText);
  const task = [
    continuation.promptText,
    missionPrompt,
    `Continue from review feedback. ${workSessionInstructions(continuation.sessionId, agent)}`,
  ].filter(Boolean).join("\n\n");
  return callRemoteAgent(
    { agentRegistry: config.agentRegistry, workspaces: config.workspaces, workSessions: config.workSessions, adapterSecret: config.adapterSecret },
    {
      agentUrl: await resolveHealthyAgentUrl(config, agentName),
      agentName,
      agentId: agent?.id,
      task,
      workspaceSessionId: session.workspaceSessionId,
      workSessionId: continuation.sessionId,
      existingRunId: run?.runId,
      continuationId: continuation.id,
      mode: "async",
      fireAndForget: true,
    },
  );
}

function renderMissionPrompt(config: BridgeConfig, workSessionId: string, fallbackObjective: string): string {
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

async function resolveHealthyAgentUrl(config: BridgeConfig, agentName = "cli-coding-agent"): Promise<string> {
  const selection = await selectHealthyAgent(config.agentRegistry.listAlive(), {
    name: agentName,
    role: "agent",
    adapterSecret: config.adapterSecret,
  });
  if (!selection.agent) throw new Error(`No healthy ${agentName} available to resume`);
  return selection.agent.url;
}

export function registerBridgeTools(
  server: McpServer,
  config: BridgeConfig,
): void {

  // ── Session Management ──────────────────────────────

  registerAppTool(
    server,
    "start_work_session",
    {
      title: "Start work session",
      description: "Create a work session linked to the current workspace. Enables auto-tracking of tool calls. Returns a sessionId. After submit_for_review, call await_review_feedback IMMEDIATELY (event-driven, blocks until feedback) — do NOT poll. check_review_status is a recovery-only fallback.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier from open_workspace."),
        title: z.string().optional().describe("Optional title for this session."),
        completionPolicy: z.enum(["agent_completion", "webui_approval_required"]).optional().describe("Completion policy. Use webui_approval_required for Ralph/WebUI-reviewed work."),
      },
      outputSchema: { sessionId: z.string(), status: z.string() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, title, completionPolicy }) => {
      try {
        config.workspaces.getWorkspace(workspaceId);
        const session = config.workSessions.create({ workspaceSessionId: workspaceId, submittedBy: "cli", title, completionPolicy });
        config.workspaces.setActiveSession(workspaceId, session.id);
        return {
          content: [{ type: "text" as const, text: `Session ${session.id} active. Tool calls will be logged. Use submit_for_review when ready.` }],
          structuredContent: { sessionId: session.id, status: "in_progress" },
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Failed" }], isError: true };
      }
    },
  );

  // ── Submit for Review (with real diff) ──────────────

  registerAppTool(
    server,
    "submit_for_review",
    {
      title: "Submit for review",
      description: "Capture the real git diff via review checkpoints and submit for human review. The WebUI displays the diff with feedback controls. After calling this, call await_review_feedback IMMEDIATELY to block for the verdict — do NOT poll. check_review_status is a recovery-only fallback if await_review_feedback times out.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID from start_work_session."),
        message: z.string().optional().describe("Note to the reviewer."),
        continuationId: z.string().optional().describe("Continuation ID returned by await_review_feedback; completed only after this submission is persisted."),
      },
      outputSchema: { submissionId: z.string(), status: z.string(), files: z.number(), additions: z.number(), removals: z.number(), diffSha256: z.string().optional(), reviewEpoch: z.number(), housekeepingWarnings: z.array(z.string()).optional() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    async ({ sessionId, message, continuationId }) => {
      // ROLE CHECK: submit_for_review is for the worker (coding agent) or an
      // ordinary client, NOT a reviewer approving work.
      if (!isWorkerOrClient(config.principalRole)) {
        return forbidden(config.principalRole, "submit_for_review");
      }

      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found. Call start_work_session first." }], isError: true };

      // P0 #6: a dispatched worker is bound to one work session; it must not
      // submit a different session for review.
      const bind = assertWorkerSessionBinding(config, sessionId);
      if (bind) return bind;

      // P1 #3: enforce the reviewer's allowedNextActions on resubmission. A
      // reviewer that omitted "resubmit" cannot be bypassed by the worker
      // calling submit_for_review again (e.g. while changes_requested).
      const resubmitDecision = authorizeWorkSessionAction(config.workSessions, {
        workSessionId: sessionId,
        tool: "submit_for_review",
      });
      if (!resubmitDecision.allowed) {
        return {
          content: [{ type: "text" as const, text: resubmitDecision.reason ?? "Resubmission is not permitted by the reviewer's allowedNextActions." }],
          isError: true,
        };
      }

      // Terminal-state enforcement: once a session is approved/rejected/cancelled,
      // no further submission may reopen it (fixes late submit_for_review
      // reopening an approved session).
      const TERMINAL = new Set(["approved", "rejected", "cancelled", "failed"]);
      if (TERMINAL.has(session.status)) {
        return {
          content: [{ type: "text" as const, text: `Session ${sessionId} is ${session.status}; no further submissions are accepted.` }],
          isError: true,
        };
      }

      try {
        const ws = config.workspaces.getWorkspace(session.workspaceSessionId);
        // Capture the diff WITHOUT advancing the checkpoint. The checkpoint is only
        // committed AFTER the submission is persisted, so a failure between capture
        // and persistence cannot silently drop the diff from the next review.
        const review = await config.reviewCheckpoints.reviewChanges({
          workspaceId: session.workspaceSessionId,
          root: ws.root,
          since: "work_session",
          workSessionId: session.id,
          markReviewed: false,
        });

        // Delegate the state transition to the authoritative workflow service
        // (validates status, transitions to awaiting_review, updates the correlated
        // run, and emits review.submitted atomically).
        const submitted = config.reviewWorkflow.submitForReview({
          workSessionId: sessionId,
          diff: review.patch,
          message: message ?? review.result,
          summaryJson: JSON.stringify(review.summary),
          files: review.summary.files,
          changedFiles: review.files,
          additions: review.summary.additions,
          removals: review.summary.removals,
          snapshotCommit: review.snapshotCommit,
        });

        const housekeepingWarnings: string[] = [];
        const recordHousekeepingFailure = (scope: string, error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          housekeepingWarnings.push(`${scope}: ${detail}`);
          try {
            config.eventStore.appendEvent({
              type: "review.submission.housekeeping_failed",
              sessionId,
              payload: { scope, detail, submissionId: submitted.submissionId },
            }, { publish: false });
          } catch (eventError) {
            console.error(`[kontrol] review submission housekeeping telemetry failed: ${eventError instanceof Error ? eventError.message : String(eventError)}`);
          }
        };

        // The submission is already durable. Checkpoint advancement is
        // follow-up housekeeping and must not turn a successful submission
        // into a misleading tool error if it fails.
        try {
          await config.reviewCheckpoints.commitReviewed({
            workspaceId: session.workspaceSessionId,
            root: ws.root,
            workSessionId: session.id,
            snapshotCommit: review.snapshotCommit,
          });
        } catch (error) {
          recordHousekeepingFailure("checkpoint_commit", error);
        }

        try {
          const completedContinuationId = continuationId ?? config.connectionContinuationId;
          if (completedContinuationId) {
            const continuation = config.continuationManager.get(completedContinuationId);
            if (continuation?.sessionId === sessionId) {
              config.continuationManager.markCompleted(completedContinuationId);
              config.workSessions.markFeedbackConsumed(sessionId, continuation.reviewId);
            }
          } else {
            const claimed = config.continuationManager
              .listForSession(sessionId)
              .filter((c) => c.status === "claimed" && c.claimOwner?.startsWith("live-worker:"))
              .sort((a, b) => (b.claimedAt ?? "").localeCompare(a.claimedAt ?? ""))[0];
            if (claimed) {
              config.continuationManager.markCompleted(claimed.id);
              config.workSessions.markFeedbackConsumed(sessionId, claimed.reviewId);
            }
          }
        } catch (error) {
          recordHousekeepingFailure("continuation_cleanup", error);
        }

        const submission = {
          id: submitted.submissionId,
          submissionNumber: submitted.submissionNumber,
        };
        const correlatedRun = config.agentRegistry.getRunByWorkSessionId(sessionId);

        // review-workflow.submitForReview already emitted the canonical
        // review.submitted event with file stats. Do not emit a duplicate.

        return {
          content: [{ type: "text" as const, text: `Submitted #${submission.submissionNumber}: ${review.summary.files} file(s), +${review.summary.additions} -${review.summary.removals}. Status: awaiting_review.${housekeepingWarnings.length ? ` Housekeeping warning: ${housekeepingWarnings.join("; ")}` : ""}` }],
          structuredContent: {
            submissionId: submission.id,
            sessionId,
            submissionNumber: submission.submissionNumber,
            reviewEpoch: submitted.reviewEpoch,
            status: "awaiting_review",
            diffSha256: submitted.diffSha256,
            patch: review.patch,
            files: review.files,
            fileCount: review.summary.files,
            additions: review.summary.additions,
            removals: review.summary.removals,
            message: message ?? review.result,
            housekeepingWarnings,
          } satisfies ReviewSubmissionDTO,
          _meta: {
            tool: "submit_for_review",
            card: {
              tool: "submit_for_review",
              workspaceId: session.workspaceSessionId,
              status: "awaiting_review",
              summary: { ...review.summary, submissionId: submission.id, sessionId, submissionNumber: submission.submissionNumber, runId: correlatedRun?.runId, message: message ?? review.result, diffSha256: submitted.diffSha256, reviewEpoch: submitted.reviewEpoch },
              files: review.files,
              payload: { patch: review.patch },
            },
          },
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Review capture failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );

  registerAppTool(
    server,
    "get_review_submission",
    {
      title: "Get review submission",
      description: "Fetch the full review submission (including the diff/patch) for a work session, so the WebUI can render the acceptance card after the original submit_for_review tool invocation has ended.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID."),
        submissionId: z.string().optional().describe("Specific submission ID; defaults to the latest."),
      },
      outputSchema: {
        submissionId: z.string(),
        sessionId: z.string(),
        status: z.string(),
        submissionNumber: z.number(),
        reviewEpoch: z.number(),
        diffSha256: z.string().optional(),
        patch: z.string(),
        files: z.array(z.object({ path: z.string(), previousPath: z.string().optional(), type: z.string().optional(), operation: z.string().optional(), additions: z.number(), removals: z.number() })),
        fileCount: z.number(),
        additions: z.number(),
        removals: z.number(),
        message: z.string().optional(),
      },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, submissionId }) => {
      const startedAt = performance.now();
      try {
        const access = requireWorkSessionRead(config, sessionId);
      if (access) return access;
      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };

      const submission = submissionId
        ? config.workSessions.getSubmissions(sessionId).find((s) => s.id === submissionId)
        : config.workSessions.getLatestSubmission(sessionId);
      if (!submission) {
        return {
          content: [{ type: "text" as const, text: `Submission ${submissionId} was not found for session ${sessionId}.` }],
          structuredContent: {
            submissionId: submissionId ?? "",
            sessionId,
            status: "not_found",
            submissionNumber: 0,
            reviewEpoch: 0,
            patch: "",
            files: [],
            fileCount: 0,
            additions: 0,
            removals: 0,
          },
          isError: true,
        };
      }

      const summary = submission.summaryJson ? (JSON.parse(submission.summaryJson) as Record<string, unknown>) : {};
      const patch = submission.diff ?? "";
      const files = parsePatchFiles(patch);
      const dto: ReviewSubmissionDTO = {
        submissionId: submission.id,
        sessionId,
        submissionNumber: submission.submissionNumber,
        reviewEpoch: submission.reviewEpoch,
        status: submission.status,
        diffSha256: submission.diffSha256,
        patch,
        files,
        fileCount: files.length,
        additions: Number(summary.additions ?? 0),
        removals: Number(summary.removals ?? 0),
        message: submission.message,
      };

      return {
        content: [{ type: "text" as const, text: `Submission #${submission.submissionNumber}: ${files.length} file(s).` }],
        structuredContent: dto,
        _meta: {
          tool: "submit_for_review",
          card: {
            tool: "submit_for_review",
            workspaceId: session.workspaceSessionId,
            status: "awaiting_review",
            summary: {
              ...summary,
              submissionId: submission.id,
              sessionId,
              submissionNumber: submission.submissionNumber,
              message: submission.message,
              files: files.length,
              additions: Number(summary.additions ?? 0),
              removals: Number(summary.removals ?? 0),
              diffSha256: submission.diffSha256,
              reviewEpoch: submission.reviewEpoch,
            },
            files,
            payload: { patch },
          },
        },
      };
      } finally {
        config.onPhaseTiming?.("review.diff_fetch", performance.now() - startedAt);
      }
    },
  );

  // ── Submit task to coding agent (Nelson Wiggum Loop: WebUI → agent) ──

  const missionCriterionSchema = z.object({
    id: z.string().optional(),
    description: z.string(),
    priority: z.enum(["required", "preferred"]).optional(),
    verificationType: z.enum(["test", "code_inspection", "runtime_behavior", "security_review", "manual_review"]).optional(),
    verificationCommand: z.string().optional(),
    affectedAreas: z.array(z.string()).optional(),
    dependsOnCriterionIds: z.array(z.string()).optional().describe("Stable criterion IDs that must be satisfied before this requirement is considered complete."),
    verificationGroup: z.string().optional().describe("Independent verification group for bounded parallel scheduling."),
    verificationScope: z.enum(["focused", "affected", "full"]).optional(),
    finalOnly: z.boolean().optional().describe("Run only during final verification."),
    mutatesWorkspace: z.boolean().optional().describe("Do not run concurrently with other verification commands."),
    commandVersion: z.string().optional().describe("Version/identity of the deterministic verifier command."),
  });
  const findingSchema = z.object({
    id: z.string().optional(),
    introducedInSubmissionId: z.string().optional(),
    scope: z.enum(["in_scope", "regression", "out_of_scope"]).optional().describe("in_scope/regression findings extend the correction loop; out_of_scope findings are advisory and never block approval."),
    disposition: z.enum(["blocking", "required_followup", "advisory", "future_improvement"]).optional().describe("Controls whether a finding blocks or merely informs the mission loop."),
    severity: z.enum(["blocker", "high", "medium", "low"]).optional(),
    category: z.enum(["correctness", "architecture", "security", "testing", "scope", "maintainability", "user_intent"]).optional(),
    description: z.string(),
    evidence: z.array(z.unknown()).optional(),
    requiredAction: z.string(),
    requiredVerification: z.array(z.unknown()).optional(),
    status: z.enum(["open", "claimed_resolved", "verified_resolved", "waived"]).optional(),
  });
  const criterionUpdateSchema = z.object({
    id: z.string(),
    status: z.enum(["unverified", "partially_verified", "verified", "failed"]),
  });
  const findingUpdateSchema = z.object({
    id: z.string(),
    status: z.enum(["open", "claimed_resolved", "verified_resolved", "waived"]),
    waiverReason: z.string().optional(),
    resolutionSubmissionId: z.string().optional(),
    disposition: z.enum(["blocking", "required_followup", "advisory", "future_improvement"]).optional(),
  });
  const workOrderSchema = z.object({
    objectiveForThisTurn: z.string(),
    requiredFindingIds: z.array(z.string()).optional(),
    acceptanceCriterionIds: z.array(z.string()).optional(),
    requiredActions: z.array(z.string()).optional(),
    prohibitedActions: z.array(z.string()).optional(),
    requiredVerification: z.array(z.unknown()).optional(),
    expectedDeliverables: z.array(z.string()).optional(),
    contextReferences: z.array(z.string()).optional(),
    preferredAgent: z.string().optional(),
    reviewCoverage: z.array(z.string()).optional().describe("Review lenses explicitly covered by this reviewer pass (accumulated onto the completion report)."),
    uncertainty: z.array(z.unknown()).optional().describe("Explicit uncertainty entries (verified/likely/uncertain/not inspected) so a deep review can end honestly."),
  });

  async function dispatchAgentTask(input: {
    task: string;
    workspaceSessionId: string;
    workSessionId: string;
    agentName?: string;
    completionPolicy?: "agent_completion" | "webui_approval_required";
    appendSessionInstructions?: boolean;
  }) {
    const startedAt = performance.now();
    try {
      const selectedAgentName = input.agentName ?? "cli-coding-agent";
      const selection = await selectHealthyAgent(config.agentRegistry.listAlive(), {
        name: selectedAgentName,
        role: "agent",
        adapterSecret: config.adapterSecret,
      });
      if (!selection.agent) {
        throw new Error(`No healthy ACP agent named ${selectedAgentName} (role=agent) is registered.`);
      }
      const wsId = input.workSessionId;
      const task = input.appendSessionInstructions === false
        ? input.task
        : `${input.task}\n\n${workSessionInstructions(wsId, selection.agent)}`;
      const result = await callRemoteAgent(
        {
          agentRegistry: config.agentRegistry,
          workspaces: config.workspaces,
          workSessions: config.workSessions,
          adapterSecret: config.adapterSecret,
        },
        {
          agentUrl: selection.agent.url,
          agentName: selectedAgentName,
          agentId: selection.agent.id,
          task,
          workspaceSessionId: input.workspaceSessionId,
          workSessionId: wsId,
          workspaceLeaseNonce: checkoutLeaseNonce(config, wsId),
          mode: "async",
          fireAndForget: true,
        },
      );
      return { result, workSessionId: wsId, agentName: selectedAgentName };
    } finally {
      config.onPhaseTiming?.("acp.dispatch_startup", performance.now() - startedAt);
    }
  }

  async function waitForSupervisorCheckpoint(workSessionId: string, afterSeq: number, expectedReviewEpoch?: number, timeoutMs = 120_000) {
    const event = await config.eventStore.waitForMatchingEventAfter(
      workSessionId,
      afterSeq,
      (candidate) => {
        if (candidate.type === "review.submitted") {
          const epoch = Number(candidate.payload?.reviewEpoch ?? 0);
          return expectedReviewEpoch === undefined || epoch >= expectedReviewEpoch;
        }
        return [
          "approval.requested",
          "agent.run.failed",
          "agent.run.failed_protocol",
          "agent.run.rejected",
          "agent.run.cancelled",
        ].includes(candidate.type);
      },
      timeoutMs,
    );
    return {
      status: event ? "checkpoint" : "pending",
      eventType: event?.type,
      nextSeq: event?.seq ?? afterSeq,
      packet: event ? await supervisorPacket(workSessionId) : undefined,
    };
  }

  async function supervisorPacket(workSessionId: string, detail: "summary" | "current" | "full" = "summary") {
    const session = config.workSessions.get(workSessionId);
    const submissions = config.workSessions.getSubmissions(workSessionId);
    const latestSubmission = submissions[submissions.length - 1];
    const toolActivity = detail === "full"
      ? config.workSessions.getToolEvents(workSessionId, 100)
      : detail === "current"
        ? config.workSessions.getToolEvents(workSessionId, 20)
        : [];
    const missionPacket = config.missionLedger?.getPacket(workSessionId);
    let cumulativeDiff: unknown = latestSubmission
      ? { deferred: detail !== "full", knownSnapshotCommit: latestSubmission.snapshotCommit, knownDiffSha256: latestSubmission.diffSha256 }
      : undefined;
    try {
      if (session && detail === "full") {
        const workspace = config.workspaces.getWorkspace(session.workspaceSessionId);
        const mission = config.missionLedger?.getMissionByWorkSession(workSessionId);
        const cumulative = mission?.baselineCommit
          ? await config.reviewCheckpoints.reviewChangesAgainstCommit({
              workspaceId: session.workspaceSessionId,
              root: workspace.root,
              baselineCommit: mission.baselineCommit,
            })
          : await config.reviewCheckpoints.reviewChanges({
              workspaceId: session.workspaceSessionId,
              root: workspace.root,
              since: "workspace_open",
              markReviewed: false,
            });
        cumulativeDiff = {
          summary: cumulative.summary,
          files: cumulative.files,
          diffSha256: createHash("sha256").update(cumulative.patch).digest("hex"),
          snapshotCommit: cumulative.snapshotCommit,
        };
      }
    } catch (error) {
      cumulativeDiff = { error: error instanceof Error ? error.message : String(error) };
    }
    return {
      session,
      supervisor: config.supervisorRuns?.getByWorkSession(workSessionId),
      mission: missionPacket
        ? detail === "full" ? missionPacket : compactMissionPacket(missionPacket)
        : undefined,
      submission: latestSubmission
        ? {
            id: latestSubmission.id,
            number: latestSubmission.submissionNumber,
            snapshotCommit: latestSubmission.snapshotCommit,
            diffSha256: latestSubmission.diffSha256,
            reviewEpoch: latestSubmission.reviewEpoch,
            message: latestSubmission.message,
          }
        : undefined,
      incrementalDiff: latestSubmission
        ? {
            diffSha256: latestSubmission.diffSha256,
            summary: latestSubmission.summaryJson ? JSON.parse(latestSubmission.summaryJson) : undefined,
          }
        : undefined,
      cumulativeDiff,
      toolActivitySummary: toolActivity.map((e) => ({
        tool: e.tool,
        path: e.path,
        success: e.success,
        outputSummary: e.outputSummary,
        createdAt: e.createdAt,
      })),
    };
  }

  registerAppTool(
    server,
    "begin_supervised_work",
    {
      title: "Begin supervised work",
      description: "Create a durable mission contract, dispatch a coding agent, and return a model-visible supervisor packet. The mission, not the worker's self-report, controls completion.",
      inputSchema: {
        workspaceSessionId: z.string(),
        objective: z.string(),
        desiredOutcome: z.string().optional(),
        constraints: z.array(z.unknown()).optional(),
        nonGoals: z.array(z.string()).optional(),
        acceptanceCriteria: z.array(missionCriterionSchema).optional(),
        supervisorInstructions: z.string().optional(),
        maxCorrectionRounds: z.number().int().min(1).max(50).optional().describe("Backstop ceiling on auto-extended correction rounds when new blocking findings appear (default 5). Progress raises the effective ceiling; convergence ends the loop earlier."),
        maxWallTimeMinutes: z.number().int().min(1).max(10_080).optional().describe("Wall-clock safety budget for autonomous supervision; defaults to 24 hours."),
        finalVerification: z.array(z.string()).optional().describe("Mission-level integration commands that must pass against the final submitted snapshot."),
        reviewCoverage: z.array(z.string()).optional().describe("Review lenses (e.g. architecture, security, correctness) the reviewer must explicitly cover before completion. Approval blocks while any lens lacks coverage evidence."),
        autonomyMode: z.enum(["manual", "verify_only", "correction_auto", "full"]).optional(),
        approvalMode: z.enum(["human_required", "policy_auto", "fully_automatic"]).optional(),
        workOrder: workOrderSchema.optional(),
        agentName: z.string().optional(),
      },
      outputSchema: { workSessionId: z.string(), runId: z.string(), status: z.string(), packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    async ({ workspaceSessionId, objective, desiredOutcome, constraints, nonGoals, acceptanceCriteria, supervisorInstructions, maxCorrectionRounds, maxWallTimeMinutes, finalVerification, reviewCoverage, autonomyMode, approvalMode, workOrder, agentName }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "begin_supervised_work");
      if (!config.missionLedger) return { content: [{ type: "text" as const, text: "Mission ledger unavailable." }], isError: true };
      const requiredCount = (acceptanceCriteria ?? []).filter((c) => (c.priority ?? "required") === "required").length;
      if (requiredCount === 0) {
        return { content: [{ type: "text" as const, text: "Supervised missions require at least one required acceptance criterion." }], isError: true };
      }
      const workspace = config.workspaces.getWorkspace(workspaceSessionId);
      let baselineCommit: string | undefined;
      try {
        baselineCommit = (await config.reviewCheckpoints.reviewChanges({ workspaceId: workspaceSessionId, root: workspace.root, since: "workspace_open", markReviewed: false })).snapshotCommit;
      } catch {
        baselineCommit = undefined;
      }
      const created = config.workSessions.create({
        workspaceSessionId,
        submittedBy: "webui",
        title: objective.slice(0, 80),
        completionPolicy: "webui_approval_required",
      });
      const leaseError = await acquireCheckoutModifyLease(config, workspaceSessionId, created.id);
      if (leaseError) {
        config.workSessions.updateStatus(created.id, "cancelled");
        return leaseError;
      }
      let mission: ReturnType<typeof config.missionLedger.createMission> | undefined;
      let supervisorRun: ReturnType<NonNullable<typeof config.supervisorRuns>["create"]> | undefined;
      try {
        mission = config.missionLedger.createMission({
          workSessionId: created.id,
          workspaceSessionId,
          objective,
          desiredOutcome,
          constraints,
          nonGoals,
          acceptanceCriteria,
          supervisorInstructions,
          maxCorrectionRounds,
          finalVerification,
          reviewCoverage,
          baselineCommit,
        });
        // Mission correction rounds are an evidence/convergence policy. They
        // are deliberately not copied into the supervisor's emergency cycle
        // guard; one cycle can include verification and a correction dispatch.
        supervisorRun = config.supervisorRuns?.create({ missionId: mission.id, workSessionId: created.id, workspaceSessionId, autonomyMode, approvalMode, maxWallTimeMs: maxWallTimeMinutes ? maxWallTimeMinutes * 60_000 : undefined });
        config.missionLedger.createWorkOrder(mission.id, created.id, workOrder ?? { objectiveForThisTurn: objective });
        const prompt = renderMissionPrompt(config, created.id, objective);
        const dispatch = await dispatchAgentTask({
          task: prompt,
          workspaceSessionId,
          workSessionId: created.id,
          agentName,
          appendSessionInstructions: true,
        });
        if (dispatch.result.status === "failed") {
          throw new Error(dispatch.result.error ?? "ACP worker dispatch failed");
        }
        if (supervisorRun) config.supervisorRuns?.transition({ id: supervisorRun.id, expectedStatus: "created", expectedRevision: supervisorRun.revision, nextStatus: "worker_active" });
        return {
          content: [{ type: "text" as const, text: `Supervised work started in ${created.id}; worker status=${dispatch.result.status}.` }],
          structuredContent: {
            workSessionId: created.id,
            runId: dispatch.result.runId,
            status: dispatch.result.status,
            packet: await supervisorPacket(created.id),
          },
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Dispatch failure is a durable failed mission, not a half-created
        // supervisor with a checkout fence left behind. Keep the mission and
        // work order for diagnosis, then release every ownership record.
        config.workSessions.updateStatus(created.id, "failed");
        config.workSessions.releaseWorkspaceLeasesForSession(created.id);
        if (supervisorRun) {
          const current = config.supervisorRuns?.getByWorkSession(created.id);
          if (current && !["failed", "cancelled", "completed"].includes(current.status)) {
            config.supervisorRuns?.transition({ id: current.id, expectedStatus: current.status, expectedRevision: current.revision, nextStatus: "failed", lastError: reason });
          }
        }
        config.eventStore.appendEvent({
          type: "agent.run.failed",
          sessionId: created.id,
          payload: { reason, missionId: mission?.id, phase: "supervised_dispatch" },
        });
        return {
          content: [{ type: "text" as const, text: `Supervised work failed before dispatch: ${reason}` }],
          structuredContent: { workSessionId: created.id, runId: "", status: "failed", packet: await supervisorPacket(created.id) },
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "inspect_supervised_work",
    {
      title: "Inspect supervised work",
      description: "Return a bounded model-visible mission packet. summary returns unresolved criteria, blocking findings, the current work order, latest evidence, progress, and the latest report; current adds recent tool activity; full explicitly loads complete mission history and cumulative diff metadata.",
      inputSchema: { workSessionId: z.string(), detail: z.enum(["summary", "current", "full"]).optional().describe("Defaults to summary. Use current for recent tool activity or full for complete history and cumulative diff metadata.") },
      outputSchema: { packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: true },
    },
    async ({ workSessionId, detail }) => {
      if (!config.workSessions.get(workSessionId)) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      const packet = await supervisorPacket(workSessionId, detail ?? "summary");
      return { content: [{ type: "text" as const, text: "Supervisor review packet ready." }], structuredContent: { packet } };
    },
  );

  registerAppTool(
    server,
    "run_mission_verification",
    {
      title: "Run mission verification",
      description: "Run declared criterion verification commands only when the current workspace matches the submitted snapshot, then record server-generated evidence.",
      inputSchema: { workSessionId: z.string(), criterionIds: z.array(z.string()).optional(), verificationScope: z.enum(["focused", "affected", "full"]).optional().describe("focused runs selected criteria, affected runs criteria whose declared areas intersect the submitted diff, and full runs all eligible criteria."), verificationPhase: z.enum(["progressive", "final"]).optional().describe("progressive runs normal correction checks; final explicitly unlocks finalOnly criteria and final integration checks."), },
      outputSchema: { packet: z.unknown(), results: z.array(z.unknown()) },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    async ({ workSessionId, criterionIds, verificationScope, verificationPhase }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "run_mission_verification");
      if (!config.missionLedger) return { content: [{ type: "text" as const, text: "Mission ledger unavailable." }], isError: true };
      let results;
      const currentSubmission = config.workSessions.get(workSessionId)?.latestSubmission;
      try { results = await verifyMissionSubmission({ workSessionId, missionLedger: config.missionLedger, workSessions: config.workSessions, workspaces: config.workspaces, reviewCheckpoints: config.reviewCheckpoints, criterionIds, verificationScope, verificationPhase, submissionId: currentSubmission?.id, reviewEpoch: currentSubmission?.reviewEpoch }); }
      catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
      return { content: [{ type: "text" as const, text: `Recorded ${results.length} verification result(s).` }], structuredContent: { results, packet: await supervisorPacket(workSessionId) } };
    },
  );

  registerAppTool(
    server,
    "pause_supervisor_run",
    {
      title: "Pause autonomous supervision",
      description: "Durably pause new supervisor actions without cancelling the mission or deleting its recovery state.",
      inputSchema: { workSessionId: z.string(), expectedRevision: z.number().int().positive() },
      outputSchema: { packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    async ({ workSessionId, expectedRevision }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "pause_supervisor_run");
      const current = config.supervisorRuns?.getByWorkSession(workSessionId);
      const paused = current && config.supervisorRuns?.pause(current.id, expectedRevision);
      if (!paused) return { content: [{ type: "text" as const, text: "Supervisor run was not found or changed concurrently." }], isError: true };
      config.eventStore.appendEvent({ type: "supervisor.run.paused", sessionId: workSessionId, payload: { supervisorRunId: paused.id, revision: paused.revision } });
      return { content: [{ type: "text" as const, text: "Supervisor paused." }], structuredContent: { packet: await supervisorPacket(workSessionId) } };
    },
  );

  registerAppTool(
    server,
    "resume_supervisor_run",
    {
      title: "Resume autonomous supervision",
      description: "Resume a paused supervisor run from its exact prior durable state.",
      inputSchema: { workSessionId: z.string(), expectedRevision: z.number().int().positive() },
      outputSchema: { packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    async ({ workSessionId, expectedRevision }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "resume_supervisor_run");
      const current = config.supervisorRuns?.getByWorkSession(workSessionId);
      const resumed = current && config.supervisorRuns?.resume(current.id, expectedRevision);
      if (!resumed) return { content: [{ type: "text" as const, text: "Supervisor run was not paused or changed concurrently." }], isError: true };
      config.eventStore.appendEvent({ type: "supervisor.run.resumed", sessionId: workSessionId, payload: { supervisorRunId: resumed.id, revision: resumed.revision, status: resumed.status } });
      // The runtime reconstructs the exact durable next action for every
      // non-paused state (verification, correction, or automatic approval).
      // Restricting this wake-up to verification stranded paused correction
      // and approval runs until a later unrelated event arrived.
      config.onSupervisorResume?.(workSessionId);
      return { content: [{ type: "text" as const, text: "Supervisor resumed." }], structuredContent: { packet: await supervisorPacket(workSessionId) } };
    },
  );

  registerAppTool(
    server,
    "redrive_supervisor_run",
    {
      title: "Redrive stalled supervisor run",
      description: "Requeue a dead-lettered supervisor action after reviewer intervention, preserving its durable audit trail.",
      inputSchema: { workSessionId: z.string(), expectedRevision: z.number().int().positive() },
      outputSchema: { redriven: z.number(), packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    async ({ workSessionId, expectedRevision }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "redrive_supervisor_run");
      const outbox = config.dispatchOutbox;
      if (!outbox) return { content: [{ type: "text" as const, text: "Dispatch outbox is unavailable." }], isError: true };
      const run = config.supervisorRuns?.getByWorkSession(workSessionId);
      if (!run || run.status !== "awaiting_human" || run.revision !== expectedRevision) return { content: [{ type: "text" as const, text: "Supervisor run is not an unchanged human-intervention checkpoint." }], isError: true };
      const events = outbox.listByAggregate(run.id);
      let redriven = 0;
      for (const event of events) {
        if (event.status === "dead_lettered" && outbox.redriveDeadLetter(event.eventType, event.aggregateId, event.aggregateRevision)) redriven += 1;
      }
      if (!redriven) return { content: [{ type: "text" as const, text: "No dead-lettered supervisor action exists to redrive." }], isError: true };
      const dead = events.filter((event) => event.status === "dead_lettered");
      const nextStatus = dead.some((event) => event.eventType === "supervisor.correction.requested") ? "correction_pending" : dead.some((event) => event.eventType === "supervisor.approval.requested") ? "approval_pending" : "verification_pending";
      config.supervisorRuns?.transition({ id: run.id, expectedStatus: "awaiting_human", expectedRevision, nextStatus });
      config.eventStore.appendEvent({ type: "supervisor.run.redriven", sessionId: workSessionId, payload: { supervisorRunId: run.id, redriven, nextStatus } });
      return { content: [{ type: "text" as const, text: `Redrove ${redriven} supervisor action(s).` }], structuredContent: { redriven, packet: await supervisorPacket(workSessionId) } };
    },
  );

  registerAppTool(
    server,
    "continue_supervised_work",
    {
      title: "Continue supervised work",
      description: "Persist supervisor findings/criterion updates, create a bounded work order, request changes, and return the next supervisor packet.",
      inputSchema: {
        workSessionId: z.string(),
        comments: z.string(),
        findings: z.array(findingSchema).optional(),
        criterionUpdates: z.array(criterionUpdateSchema.omit({ status: true }).extend({ status: z.enum(["unverified", "partially_verified", "failed"]) })).optional(),
        findingUpdates: z.array(findingUpdateSchema).optional(),
        evidence: z.array(z.object({
          criterionId: z.string().optional(),
          submissionId: z.string().optional(),
          snapshotCommit: z.string().optional(),
          command: z.string().optional(),
          status: z.enum(["passed", "failed", "inconclusive"]),
          details: z.unknown().optional(),
        })).optional(),
        workOrder: workOrderSchema,
      },
      outputSchema: { status: z.string(), continuationId: z.string().optional(), extension: z.unknown().optional(), packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    async ({ workSessionId, comments, findings, criterionUpdates, findingUpdates, evidence, workOrder }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "continue_supervised_work");
      if (!config.missionLedger) return { content: [{ type: "text" as const, text: "Mission ledger unavailable." }], isError: true };
      const mission = config.missionLedger.getMissionByWorkSession(workSessionId);
      if (!mission) return { content: [{ type: "text" as const, text: "No mission contract for this work session." }], isError: true };
      const session = config.workSessions.get(workSessionId);
      const latest = session?.latestSubmission;
      if (!latest?.id) return { content: [{ type: "text" as const, text: "No pending submission to continue from." }], isError: true };
      const createdFindings = findings?.length ? config.missionLedger.addFindings(mission.id, findings) : [];
      if (criterionUpdates?.length) config.missionLedger.updateCriterionStatus(mission.id, criterionUpdates);
      if (findingUpdates?.length) config.missionLedger.updateFindingStatus(mission.id, findingUpdates);
      if (evidence?.length) {
        config.missionLedger.recordReviewerEvidence(mission.id, evidence.map((entry) => ({
          ...entry,
          submissionId: entry.submissionId ?? latest.id,
          snapshotCommit: entry.snapshotCommit ?? latest.snapshotCommit,
        })));
      }

      // P2 #34/#35: persist which review lenses this pass covered and any
      // explicit uncertainty so completion can end on coverage, not a timer.
      if (workOrder.reviewCoverage?.length || workOrder.uncertainty?.length) {
        config.missionLedger.recordReviewCoverage(mission.id, {
          submissionId: latest.id,
          snapshotCommit: latest.snapshotCommit!,
          reviewCoverage: workOrder.reviewCoverage,
          uncertainty: workOrder.uncertainty,
        });
      }
      // Anti-runaway guard: only extend the correction loop when this round is
      // making progress. A round that surfaced new blocking in-scope findings
      // extends (bounded by a progress-aware ceiling); a non-converging runaway
      // is stopped and handed back to a human rather than auto-looping forever.
      const resolvedFindingIds = (findingUpdates ?? [])
        .filter((u) => u.status === "verified_resolved" || u.status === "waived")
        .map((u) => u.id);
      const extension = config.missionLedger.evaluateLoopExtension(workSessionId, {
        newFindingIds: createdFindings.map((f) => f.id),
        resolvedFindingIds,
      });
      if (extension.ceilingHit) {
        // The findings are already persisted (auditable), but we refuse to
        // auto-dispatch another correction turn. A human decides: ship what
        // exists, waive, or explicitly force another round.
        return {
          content: [{ type: "text" as const, text: `Correction loop not extended: ${extension.reason}` }],
          structuredContent: {
            status: "ceiling_reached",
            extension,
            packet: await supervisorPacket(workSessionId),
          },
        };
      }

      config.missionLedger.createWorkOrder(mission.id, workSessionId, workOrder);
      const result = await config.reviewWorkflow.provideFeedback({
        sessionId: workSessionId,
        submissionId: latest.id,
        diffSha256: latest.diffSha256,
        reviewEpoch: latest.reviewEpoch,
        verdict: "changes_requested",
        comments,
        requiredActions: workOrder.requiredActions,
        reviewerId: "webui",
      });
      return {
        content: [{ type: "text" as const, text: `Changes requested for ${workSessionId}; continuation queued.` }],
        structuredContent: {
          status: "running",
          continuationId: result.continuationId,
          packet: await supervisorPacket(workSessionId),
        },
      };
    },
  );

  registerAppTool(
    server,
    "approve_supervised_work",
    {
      title: "Approve supervised work",
      description: "Approve only if the durable mission predicate allows it. Criteria/finding/evidence updates are persisted before evaluating approval.",
      inputSchema: {
        workSessionId: z.string(),
        criterionUpdates: z.array(criterionUpdateSchema.omit({ status: true }).extend({ status: z.enum(["unverified", "partially_verified", "failed"]) })).optional(),
        findingUpdates: z.array(findingUpdateSchema).optional(),
        evidence: z.array(z.object({
          criterionId: z.string().optional(),
          submissionId: z.string().optional(),
          snapshotCommit: z.string().optional(),
          command: z.string().optional(),
          status: z.enum(["passed", "failed", "inconclusive"]),
          details: z.unknown().optional(),
        })).optional(),
        comments: z.string().optional(),
        reviewCoverage: z.array(z.string()).optional().describe("Review lenses covered by this approval pass; recorded before the gate evaluates coverage."),
        uncertainty: z.array(z.unknown()).optional().describe("Explicit residual-uncertainty entries recorded with the completion report."),
      },
      outputSchema: { status: z.string(), approved: z.boolean(), reasons: z.array(z.string()), packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    async ({ workSessionId, criterionUpdates, findingUpdates, evidence, comments, reviewCoverage, uncertainty }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "approve_supervised_work");
      if (!config.missionLedger) return { content: [{ type: "text" as const, text: "Mission ledger unavailable." }], isError: true };
      const mission = config.missionLedger.getMissionByWorkSession(workSessionId);
      if (!mission) return { content: [{ type: "text" as const, text: "No mission contract for this work session." }], isError: true };
      const session = config.workSessions.get(workSessionId);
      const latest = session?.latestSubmission;
      if (!latest?.id) return { content: [{ type: "text" as const, text: "No pending submission to approve." }], isError: true };
      if (criterionUpdates?.length) config.missionLedger.updateCriterionStatus(mission.id, criterionUpdates);
      if (findingUpdates?.length) config.missionLedger.updateFindingStatus(mission.id, findingUpdates);
      if (evidence?.length) {
        config.missionLedger.recordReviewerEvidence(mission.id, evidence.map((entry) => ({
          ...entry,
          submissionId: entry.submissionId ?? latest.id,
          snapshotCommit: entry.snapshotCommit ?? latest.snapshotCommit,
        })));
      }
      // P2 #34/#35: coverage/uncertainty recorded on the approval attempt so
      // the gate sees exactly which lenses this reviewer visited.
      if ((reviewCoverage?.length || uncertainty?.length) && latest.snapshotCommit) {
        config.missionLedger.recordReviewCoverage(mission.id, {
          submissionId: latest.id,
          snapshotCommit: latest.snapshotCommit,
          reviewCoverage,
          uncertainty,
        });
      }
      const approval = config.missionLedger.canApprove(workSessionId, { submissionId: latest.id, snapshotCommit: latest.snapshotCommit, reviewEpoch: latest.reviewEpoch });
      if (!approval.allowed) {
        return {
          content: [{ type: "text" as const, text: `Approval blocked: ${approval.reasons.join("; ")}` }],
          structuredContent: { status: "blocked", approved: false, reasons: approval.reasons, packet: await supervisorPacket(workSessionId) },
          isError: true,
        };
      }
      await config.reviewWorkflow.provideFeedback({
        sessionId: workSessionId,
        submissionId: latest.id,
        diffSha256: latest.diffSha256,
        reviewEpoch: latest.reviewEpoch,
        verdict: "approve",
        comments,
        reviewerId: "webui",
        completionReportSha256: config.missionLedger.getCompletionReportHash(workSessionId, { submissionId: latest.id, snapshotCommit: latest.snapshotCommit, reviewEpoch: latest.reviewEpoch }),
      });
      const supervisor = config.supervisorRuns?.getByWorkSession(workSessionId);
      if (supervisor) config.supervisorRuns?.transition({ id: supervisor.id, expectedStatus: supervisor.status, expectedRevision: supervisor.revision, nextStatus: "completed" });
      return {
        content: [{ type: "text" as const, text: `Approved ${workSessionId}.` }],
        structuredContent: { status: "approved", approved: true, reasons: [], packet: await supervisorPacket(workSessionId) },
      };
    },
  );

  registerAppTool(
    server,
    "submit_to_coding_agent",
    {
      title: "Submit task to coding agent",
      description: "Submit a task or instruction from the WebUI to the CLI coding agent over ACP. The coding agent executes and returns its result. (Nelson Wiggum Loop: WebUI → agent.)",
      inputSchema: {
        task: z.string().describe("Instruction or task for the coding agent."),
        workspaceId: z.string().optional().describe("Workspace ID from open_workspace. Preferred public name; aliases workspaceSessionId."),
        workspaceSessionId: z.string().optional().describe("Workspace session ID (legacy/internal alias for workspaceId)."),
        workSessionId: z.string().optional().describe("Optional existing work session ID. If omitted, Kontrol creates one before dispatch so the agent can reuse it for submit_for_review correlation."),
        sessionId: z.string().optional().describe("Legacy alias for workSessionId."),
        agentName: z.string().optional().describe("Registered ACP agent name to dispatch to. Defaults to cli-coding-agent; use mimo-code or another registered agent name when available."),
        completionPolicy: z.enum(["agent_completion", "webui_approval_required"]).optional().describe("Completion policy for newly-created work sessions. Defaults to webui_approval_required for reviewed WebUI dispatch."),
        missionContract: z.object({
          objective: z.string(),
          desiredOutcome: z.string().optional(),
          constraints: z.array(z.unknown()).optional(),
          nonGoals: z.array(z.string()).optional(),
          acceptanceCriteria: z.array(missionCriterionSchema).optional(),
          supervisorInstructions: z.string().optional(),
          maxCorrectionRounds: z.number().int().min(1).max(100).optional(),
          maxWallTimeMinutes: z.number().int().min(1).max(10_080).optional(),
          finalVerification: z.array(z.string()).optional(),
          autonomyMode: z.enum(["manual", "verify_only", "correction_auto", "full"]).optional(),
          approvalMode: z.enum(["human_required", "policy_auto", "fully_automatic"]).optional(),
          workOrder: workOrderSchema.optional(),
        }).optional().describe("Optional durable mission contract. When present, WebUI approval is mission-gated rather than only snapshot-gated."),
      },
      outputSchema: {
        runId: z.string(),
        remoteRunId: z.string().optional(),
        workSessionId: z.string(),
        workspaceSessionId: z.string(),
        status: z.string(),
        output: z.string(),
        error: z.string().optional(),
      },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    async ({ task, workspaceId, workspaceSessionId, workSessionId, sessionId, agentName, completionPolicy, missionContract }) => {
      // ROLE CHECK: submit_to_coding_agent (Nelson Wiggum Loop: WebUI → agent)
      // is reviewer/client only. A worker (coding agent) must not be able to
      // spawn further coding agents or self-delegate.
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "submit_to_coding_agent");
      }

      const resolved = resolveDelegationContext(config, { workspaceId, workspaceSessionId, workSessionId, sessionId });
      if (resolved.error || !resolved.workspaceSessionId) {
        return {
          content: [{ type: "text" as const, text: resolved.error ?? "Unknown workspace. Open a workspace via open_workspace before dispatching a coding agent." }],
          isError: true,
        };
      }
      workspaceSessionId = resolved.workspaceSessionId;
      workSessionId = resolved.workSessionId;

      const selectedAgentName = agentName ?? "cli-coding-agent";
      if (missionContract) {
        const requiredCount = (missionContract.acceptanceCriteria ?? []).filter((c) => (c.priority ?? "required") === "required").length;
        if (requiredCount === 0) {
          return { content: [{ type: "text" as const, text: "Mission contract requires at least one required acceptance criterion." }], isError: true };
        }
      }

      // Failover: among agents with the selected name (role=agent), pick the first
      // that actually answers a protocol-readiness probe. Stale/non-HTTP endpoints
      // are skipped in favor of a working ACP HTTP endpoint.
      const selection = await selectHealthyAgent(config.agentRegistry.listAlive(), {
        name: selectedAgentName,
        role: "agent",
        adapterSecret: config.adapterSecret,
      });
      if (!selection.agent) {
        const dead = selection.deadUrls.length
          ? ` Dead/ unhealthy endpoints found: ${selection.deadUrls.join("; ")}.`
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `No healthy ACP agent named ${selectedAgentName} (role=agent) is registered.${dead} Register a working ACP HTTP endpoint via POST /acp/agents/register.`,
            },
          ],
          isError: true,
        };
      }
      const peer = selection.agent;

      // Kontrol owns work-session creation (Nelson Wiggum Loop): create the session
      // here and hand its ID to the CLI so the agent reuses it for submit_for_review
      // correlation instead of making a disjoint session.
      let wsId = workSessionId;
      let createdSessionForDispatch = false;
      if (!wsId) {
        const created = config.workSessions.create({
          workspaceSessionId,
          submittedBy: "webui",
          title: task.slice(0, 80),
          completionPolicy: completionPolicy ?? "webui_approval_required",
        });
        wsId = created.id;
        createdSessionForDispatch = true;
      } else {
        // P1 #5: when an existing session is supplied, validate it before
        // reusing — a mismatched / terminal / non-review session must not be
        // miscorrelated or downgraded to a plain agent_completion dispatch.
        const existing = config.workSessions.get(wsId);
        if (!existing) {
          return { content: [{ type: "text" as const, text: `Unknown work session: ${wsId}.` }], isError: true };
        }
        if (existing.workspaceSessionId !== workspaceSessionId) {
          return {
            content: [{ type: "text" as const, text: `Work session ${wsId} belongs to a different workspace (${existing.workspaceSessionId}), not ${workspaceSessionId}.` }],
            isError: true,
          };
        }
        const EXISTING_TERMINAL = new Set(["approved", "rejected", "cancelled", "failed", "failed_protocol"]);
        if (EXISTING_TERMINAL.has(existing.status)) {
          return {
            content: [{ type: "text" as const, text: `Work session ${wsId} is ${existing.status}; it cannot be reused for a new dispatch.` }],
            isError: true,
          };
        }
        if (existing.completionPolicy !== "webui_approval_required") {
          return {
            content: [{ type: "text" as const, text: `Work session ${wsId} does not use webui_approval_required; WebUI dispatch requires review.` }],
            isError: true,
          };
        }
      }

      const leaseError = await acquireCheckoutModifyLease(config, workspaceSessionId, wsId);
      if (leaseError) {
        if (createdSessionForDispatch) config.workSessions.updateStatus(wsId, "cancelled");
        return leaseError;
      }

      if (missionContract && !config.missionLedger) {
        return { content: [{ type: "text" as const, text: "Mission contract supplied, but mission ledger is unavailable." }], isError: true };
      }

      let supervisorRun: ReturnType<NonNullable<typeof config.supervisorRuns>["create"]> | undefined;
      const rollbackDispatch = (reason: string, runId?: string) => {
        // No worker was accepted, so release the checkout fence. A newly
        // created session is failed as a coherent unit; a reused session
        // keeps its review/continuation state and can be retried safely.
        if (createdSessionForDispatch) {
          config.workSessions.updateStatus(wsId!, "failed");
        } else {
          config.workSessions.releaseWorkspaceLeasesForSession(wsId!);
        }
        if (supervisorRun) {
          config.supervisorRuns?.transition({
            id: supervisorRun.id,
            expectedStatus: supervisorRun.status,
            expectedRevision: supervisorRun.revision,
            nextStatus: "failed",
            lastError: reason,
          });
        }
        config.eventStore.appendEvent({
          type: createdSessionForDispatch ? "agent.run.failed" : "agent.dispatch.failed",
          sessionId: wsId!,
          payload: { runId, reason, newSession: createdSessionForDispatch },
        });
      };
      try {
        let dispatchTask = task;
        if (missionContract && config.missionLedger) {
          const workspace = config.workspaces.getWorkspace(workspaceSessionId);
          let baselineCommit: string | undefined;
          try {
            baselineCommit = (await config.reviewCheckpoints.reviewChanges({ workspaceId: workspaceSessionId, root: workspace.root, since: "workspace_open", markReviewed: false })).snapshotCommit;
          } catch {
            baselineCommit = undefined;
          }
          const mission = config.missionLedger.createMission({
            workSessionId: wsId,
            workspaceSessionId,
            objective: missionContract.objective,
            desiredOutcome: missionContract.desiredOutcome,
            constraints: missionContract.constraints,
            nonGoals: missionContract.nonGoals,
            acceptanceCriteria: missionContract.acceptanceCriteria,
            supervisorInstructions: missionContract.supervisorInstructions,
            maxCorrectionRounds: missionContract.maxCorrectionRounds,
            finalVerification: missionContract.finalVerification,
            baselineCommit,
          });
          supervisorRun = config.supervisorRuns?.create({
            missionId: mission.id,
            workSessionId: wsId,
            workspaceSessionId,
            autonomyMode: missionContract.autonomyMode,
            approvalMode: missionContract.approvalMode,
            maxCycles: missionContract.maxCorrectionRounds,
            maxWallTimeMs: missionContract.maxWallTimeMinutes ? missionContract.maxWallTimeMinutes * 60_000 : undefined,
          });
          config.missionLedger.createWorkOrder(mission.id, wsId, missionContract.workOrder ?? { objectiveForThisTurn: task });
          dispatchTask = renderMissionPrompt(config, wsId, task);
        }
        const result = await callRemoteAgent(
          {
            agentRegistry: config.agentRegistry,
            workspaces: config.workspaces,
            workSessions: config.workSessions,
            adapterSecret: config.adapterSecret,
          },
          {
          agentUrl: peer.url,
          agentName: selectedAgentName,
          agentId: peer.id,
            task: wsId
              ? `${dispatchTask}\n\n${workSessionInstructions(wsId, peer)}`
              : dispatchTask,
            workspaceSessionId: workspaceSessionId,
            workSessionId: wsId,
            workspaceLeaseNonce: checkoutLeaseNonce(config, wsId),
            mode: "async",
            fireAndForget: true,
          },
        );
        if (result.status === "failed") {
          rollbackDispatch(result.error ?? "ACP dispatch failed", result.runId);
          return {
            content: [{ type: "text" as const, text: result.error ?? "ACP call failed with no error detail." }],
            structuredContent: { runId: result.runId, remoteRunId: result.remoteRunId, workSessionId: wsId, workspaceSessionId, status: result.status, output: result.output, error: result.error },
            isError: true,
          };
        }
        if (supervisorRun) config.supervisorRuns?.transition({ id: supervisorRun.id, expectedStatus: "created", expectedRevision: supervisorRun.revision, nextStatus: "worker_active" });
        return {
          content: [{ type: "text" as const, text: result.output || "(no output)" }],
          structuredContent: { runId: result.runId, remoteRunId: result.remoteRunId, workSessionId: wsId, workspaceSessionId, status: result.status, output: result.output },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        rollbackDispatch(errorMessage);
        return {
          content: [{ type: "text" as const, text: `Submission to coding agent failed: ${errorMessage}` }],
          structuredContent: { runId: "", remoteRunId: undefined, workSessionId: wsId, workspaceSessionId, status: "failed", output: "", error: errorMessage },
          isError: true,
        };
      }
    },
  );

  // ── Provide Review Feedback ────────────────────────

  registerAppTool(
    server,
    "provide_review_feedback",
    {
      title: "Provide review feedback",
      description: "Submit human review feedback (approve, changes_requested, or reject) with optional comments and structured actions. Called by the WebUI after reviewing a submission. Wakes any agent blocked on await_review_feedback.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID to provide feedback on."),
        submissionId: z.string().optional().describe("Exact submission being reviewed. Enforced strictly — a stale card carrying an old id yields a conflict instead of approving the wrong submission. Defaults to the current pending submission."),
        diffSha256: z.string().optional().describe("SHA-256 of the submitted diff being reviewed. Required for webui_approval_required sessions."),
        reviewEpoch: z.number().optional().describe("Review epoch of the submitted diff being reviewed. Required for webui_approval_required sessions."),
        verdict: z.enum(["approve", "changes_requested", "reject"]).describe("The reviewer's verdict."),
        comments: z.string().optional().describe("Optional feedback comments for the coding agent."),
        requiredActions: z.array(z.string()).optional().describe("Specific actions the agent must take before resubmitting."),
        allowedNextActions: z.array(z.string()).optional().describe("Actions the agent is permitted to take next (e.g. edit_files, run_commands, resubmit)."),
        reviewerId: z.string().optional().describe("Identifier of the reviewer."),
      },
      outputSchema: { status: z.string(), verdict: z.string() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    async ({ sessionId, verdict, comments, requiredActions, allowedNextActions, reviewerId, submissionId, diffSha256, reviewEpoch }) => {
      // ROLE CHECK: provide_review_feedback is reviewer-only (or an ordinary
      // client). A worker (coding agent) must never be able to review/approve
      // its own submitted work.
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "provide_review_feedback");
      }

      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };

      // Resolve the exact submission. If the caller (WebUI) supplies an explicit
      // submissionId it is enforced EXACTLY — a stale card carrying an old id
      // yields a conflict rather than approving the wrong submission. When omitted
      // we default to the current pending submission (the latest), which is the
      // correct target and carries no stale-card race.
      let targetSubmissionId = submissionId;
      if (!targetSubmissionId) {
        const submissions = config.workSessions.getSubmissions(sessionId);
        const pending = submissions.filter((s) => s.status === "pending");
        const currentPending = pending[pending.length - 1];
        if (!currentPending) {
          return { content: [{ type: "text" as const, text: "No pending submission to review. Call submit_for_review first." }], isError: true };
        }
        targetSubmissionId = currentPending.id;
      }

      try {
        // Snapshot drift validation is performed centrally inside
        // reviewWorkflow.provideFeedback() (scoped to approval), so BOTH the
        // MCP and ACP transports enforce identical checks (P0 #5 / P1 #1).
        const result = await config.reviewWorkflow.provideFeedback({
          sessionId,
          submissionId: targetSubmissionId,
          diffSha256,
          reviewEpoch,
          verdict,
          comments,
          requiredActions,
          allowedNextActions,
          reviewerId,
        });

        // The continuation.created event is emitted inside the workflow transaction
        // (atomic with the feedback + continuation writes). Do NOT emit a duplicate.

        return {
          content: [{ type: "text" as const, text: `Feedback recorded: ${verdict}. Session status: ${result.status}.` }],
          structuredContent: { status: result.status, verdict, submissionId: result.submissionId },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    },
  );

  // ── Check Review Status ─────────────────────────────

  registerAppTool(
    server,
    "check_review_status",
    {
      title: "Check review status",
      description: "Poll for human feedback on a submitted review session. If changes_requested, read the comments and adjust. If approved, the work is accepted. If rejected, stop.",
      inputSchema: { sessionId: z.string().describe("Work session ID.") },
      outputSchema: { status: z.string(), verdict: z.string().optional(), comments: z.string().optional(), submissionCount: z.number(), feedbackCount: z.number() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }) => {
      const access = requireWorkSessionRead(config, sessionId);
      if (access) return access;
      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };

      const submissions = config.workSessions.getSubmissions(sessionId);
      const feedbackCount = config.workSessions.countFeedback(sessionId);
      const lf = session.latestFeedback;

      const text = (
        session.status === "awaiting_review" ? "⏳ awaiting_review — no feedback yet" :
        session.status === "in_review" ? "🔍 in_review — reviewer is examining" :
        session.status === "changes_requested" ? `✏️ changes_requested — ${lf?.comments ?? "reviewer wants changes"}` :
        session.status === "approved" ? "✅ approved!" :
        session.status === "rejected" ? `❌ rejected — ${lf?.comments ?? ""}` :
        `Status: ${session.status}`
      );

      return { content: [{ type: "text" as const, text }], structuredContent: { status: session.status, verdict: lf?.verdict, comments: lf?.comments, submissionCount: submissions.length, feedbackCount } };
    },
  );

  // ── Await Work Session Events (event-driven WebUI feed) ──
  // Host-authenticated, blocking event read. The WebUI does not need the ACP
  // bearer token in an iframe: it calls this MCP tool (already authenticated by
  // the host) and stays blocked until the next durable event arrives or the
  // connection-liveness timeout elapses. This replaces the 2.5s poll timer.

  const TERMINAL_RUN_EVENTS = new Set([
    "agent.run.approved",
    "agent.run.rejected",
    "agent.run.cancelled",
    "agent.run.completed",
    "agent.run.failed",
    "agent.run.failed_protocol",
  ]);

  registerAppTool(
    server,
    "await_work_session_events",
    {
      title: "Await work session events",
      description: "Blocking, host-authenticated read of durable work-session events after a given seq. Returns immediately when an event arrives, or after timeoutMs (a liveness heartbeat, not 'nothing happened'). Used by the WebUI watcher to receive activity without polling.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID to watch."),
        afterSeq: z.number().int().min(0).default(0).describe("Return events strictly after this seq."),
        timeoutMs: z.number().int().min(1000).max(120_000).default(55_000).describe("Max wait in ms before returning (liveness timeout)."),
      },
      outputSchema: {
        events: z.array(z.object({
          seq: z.number(),
          id: z.string(),
          type: z.string(),
          sessionId: z.string(),
          workspaceSessionId: z.string().optional(),
          payload: z.record(z.string(), z.unknown()),
          createdAt: z.string(),
        })),
        nextSeq: z.number(),
        terminal: z.boolean(),
      },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, afterSeq, timeoutMs }) => {
      const access = requireWorkSessionRead(config, sessionId);
      if (access) return access;
      const session = config.workSessions.get(sessionId);
      if (!session) {
        return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      }
      const waitStartedAt = performance.now();
      const events = await config.eventStore.waitForEventsAfter(sessionId, afterSeq, timeoutMs);
      config.onPhaseTiming?.("event.session_wait", performance.now() - waitStartedAt);
      const terminal = events.some((e) =>
        TERMINAL_RUN_EVENTS.has(e.type) &&
        !(session.completionPolicy === "webui_approval_required" && e.type === "agent.run.completed")
      );
      const nextSeq = events.length ? events[events.length - 1].seq : afterSeq;
      return {
        content: [{ type: "text" as const, text: `${events.length} event(s) after seq ${afterSeq}; terminal=${terminal}.` }],
        structuredContent: {
          events: events.map((e) => ({
            seq: e.seq,
            id: e.id,
            type: e.type,
            sessionId: e.sessionId,
            workspaceSessionId: e.workspaceSessionId,
            payload: e.payload,
            createdAt: e.createdAt,
          })),
          nextSeq,
          terminal,
        },
      };
    },
  );

  registerAppTool(
    server,
    "await_work_session_terminal",
    {
      title: "Await work session terminal",
      description: "Block until the reviewed work session reaches a terminal run event. For webui_approval_required sessions, successful completion is agent.run.approved only.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID to watch."),
        afterSeq: z.number().int().min(0).default(0).describe("Return terminal events strictly after this seq."),
        timeoutMs: z.number().int().min(1000).max(300_000).default(120_000).describe("Max wait in ms before returning pending."),
      },
      outputSchema: { status: z.string(), terminal: z.boolean(), successful: z.boolean(), eventType: z.string().optional(), nextSeq: z.number() },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, afterSeq, timeoutMs }) => {
      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      const waitStartedAt = performance.now();
      const event = await config.eventStore.waitForMatchingEventAfter(
        sessionId,
        afterSeq,
        (candidate) =>
          TERMINAL_RUN_EVENTS.has(candidate.type) &&
          !(session.completionPolicy === "webui_approval_required" && candidate.type === "agent.run.completed"),
        timeoutMs,
      );
      config.onPhaseTiming?.("event.terminal_wait", performance.now() - waitStartedAt);
      const latest = config.workSessions.get(sessionId);
      const status = latest?.status ?? session.status;
      // For webui_approval_required sessions, success is ONLY agent.run.approved.
      // For ordinary agent_completion sessions, success is agent.run.completed
      // (a zero exit code is NOT approval — P1 #6).
      const successful = latest?.completionPolicy === "webui_approval_required"
        ? status === "approved" && event?.type === "agent.run.approved"
        : (event?.type === "agent.run.completed" || event?.type === "agent.run.approved" || status === "approved");
      return {
        content: [{ type: "text" as const, text: event ? `Terminal: ${event.type}` : "Still pending." }],
        structuredContent: {
          status,
          terminal: Boolean(event),
          successful,
          eventType: event?.type,
          nextSeq: event?.seq ?? afterSeq,
        },
      };
    },
  );

  registerAppTool(
    server,
    "await_workspace_events",
    {
      title: "Await workspace events",
      description: "Blocking, host-authenticated read of durable events across all work sessions in one workspace/project. Use one cursor instead of keeping a long-poll connection open for every parked session.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace or project identifier from open_workspace."),
        afterSeq: z.number().int().min(0).default(0).describe("Return events strictly after this global event sequence."),
        timeoutMs: z.number().int().min(1000).max(120_000).default(55_000).describe("Max wait in ms before returning."),
      },
      outputSchema: {
        events: z.array(z.object({
          seq: z.number(),
          id: z.string(),
          type: z.string(),
          sessionId: z.string(),
          workspaceSessionId: z.string().optional(),
          payload: z.record(z.string(), z.unknown()),
          createdAt: z.string(),
        })),
        nextSeq: z.number(),
      },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, afterSeq, timeoutMs }) => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "await_workspace_events");
      }
      const startedAt = performance.now();
      try {
      // Fail early for a typo rather than parking a waiter that can never
      // receive an event. The store still accepts project IDs as aliases.
      try {
        config.workspaces.getWorkspace(workspaceId);
      } catch {
        // A project alias may not be present in the in-memory registry; the
        // event-store query below validates it by returning an empty stream.
      }
      const events = await config.eventStore.waitForWorkspaceEventsAfter(workspaceId, afterSeq, timeoutMs);
      const nextSeq = events.length ? events[events.length - 1].seq : afterSeq;
      return {
        content: [{ type: "text" as const, text: `${events.length} workspace event(s) after seq ${afterSeq}.` }],
        structuredContent: {
          events: events.map((event) => ({
            seq: event.seq,
            id: event.id,
            type: event.type,
            sessionId: event.sessionId,
            workspaceSessionId: event.workspaceSessionId,
            payload: event.payload,
            createdAt: event.createdAt,
          })),
          nextSeq,
        },
      };
      } finally {
        config.onPhaseTiming?.("event.workspace_wait", performance.now() - startedAt);
      }
    },
  );

  // ── Await Review Feedback (Ralphie Muntz Loop) ─────

  registerAppTool(
    server,
    "await_review_feedback",
    {
      title: "Await review feedback",
      description: "Block (event-driven) until review feedback is provided for the latest submission. Subscribes before checking durable state, so no feedback is missed (idempotent re-entry via lastSeenFeedbackId). Times out after timeoutMs (default 5 min) — timeout means 'still pending', not failure. After submit_for_review, call this IMMEDIATELY; do NOT poll check_review_status. Use get_work_session or list_pending_reviews to resume later.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID from start_work_session."),
        lastSeenFeedbackId: z.string().optional().describe("If resuming after a prior await, pass the last feedback ID you saw to skip duplicates."),
        timeoutMs: z.number().int().min(1000).max(900_000).optional().default(300_000).describe("Max wait in ms. Default 300000 (5 min). Max 900000 (15 min)."),
      },
      outputSchema: {
        status: z.enum(["feedback_ready", "timeout", "error"]),
        sessionId: z.string(),
        nextSeq: z.number().int().optional().describe("Durable event seq cursor; pass as afterSeq on resume to skip already-seen feedback."),
        feedback: z.object({
          id: z.string(),
          verdict: z.string(),
          comments: z.string().optional(),
          requiredActions: z.array(z.string()).optional(),
          allowedNextActions: z.array(z.string()).optional(),
          reviewerId: z.string().optional(),
          createdAt: z.string(),
          continuationId: z.string().optional(),
        }).optional(),
        message: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, lastSeenFeedbackId, timeoutMs }) => {
      // ROLE CHECK: await_review_feedback is for the worker (coding agent) or
      // an ordinary client, NOT a reviewer.
      if (!isWorkerOrClient(config.principalRole)) {
        return forbidden(config.principalRole, "await_review_feedback");
      }

      const session = config.workSessions.get(sessionId);
      if (!session) {
        return {
          content: [{ type: "text" as const, text: "Session not found. Call start_work_session first." }],
          structuredContent: { status: "error", sessionId, message: "Session not found" },
          isError: true,
        };
      }

      // P0 #6: a dispatched worker is bound to one work session; it must not
      // poll feedback for a different session.
      const bind = assertWorkerSessionBinding(config, sessionId);
      if (bind) return bind;

      // Register this call as a live waiter so the continuation dispatcher does
      // not also spawn a duplicate worker for this session. Cleared on exit.
      const liveWaiters = config.liveWaiters ?? defaultLiveWaiters;
      const waiterId = liveWaiters.add(sessionId);
      const waiterOwner = `live-worker:${sessionId}:${waiterId}`;

      // P1 #8: emit worker.waiter.closed when this is the LAST live waiter on the
      // session, so the continuation dispatcher redrives immediately instead of
      // waiting for the lease sweep to notice the disconnect.
      const cleanup = () => {
        const wasLast = liveWaiters.remove(sessionId, waiterId);
        if (wasLast) {
          config.eventStore.appendEvent({
            type: "worker.waiter.closed",
            sessionId,
            payload: { waiterId },
          });
        }
      };

      // P0 #5 + defect #2: race-free, sequence-anchored wait.
      // waitForMatchingEventAfter subscribes to live events BEFORE re-querying
      // durable state, so an event published between our start and our
      // subscription cannot be lost. We anchor on the SEQUENCE of the last
      // consumed feedback (not 0), so a multi-round review never replays an
      // OLDER cycle's feedback — getEventsAfter is strictly exclusive, so only
      // feedback published after the consumed one is ever returned. The anchor
      // feedback id is also excluded by the predicate (defense in depth).
      const anchor = lastSeenFeedbackId ?? session.lastConsumedFeedbackId;
      let afterSeq = 0;
      if (anchor) {
        const anchorEvent = config.eventStore
          .getEventsForSession(sessionId)
          .find((e) => String((e.payload as { feedbackId?: unknown }).feedbackId ?? e.id) === anchor);
        if (anchorEvent) afterSeq = anchorEvent.seq;
      }
      // Compare the FEEDBACK id (carried in the event payload as feedbackId),
      // not the event id — the anchor/lastConsumedFeedbackId is a feedback id.
      const predicate: EventPredicate = (event) =>
        (event.type === "review.feedback.provided" &&
          String((event.payload as { feedbackId?: unknown }).feedbackId ?? event.id) !== anchor) ||
        event.type === "agent.run.cancelled";

      let matched: EventStoreEvent | null = null;
      const waitStartedAt = performance.now();
      try {
        matched = await config.eventStore.waitForMatchingEventAfter(
          sessionId,
          afterSeq,
          predicate,
          timeoutMs ?? 300_000,
        );
      } catch (error) {
        cleanup();
        config.onPhaseTiming?.("event.review_wait", performance.now() - waitStartedAt);
        throw error;
      }
      config.onPhaseTiming?.("event.review_wait", performance.now() - waitStartedAt);

      if (!matched) {
        cleanup();
        return {
          content: [{ type: "text" as const, text: `No review feedback received within ${Math.round((timeoutMs ?? 300_000) / 1000)}s. Use list_pending_reviews or get_work_session to recover, or call await_review_feedback again.` }],
          structuredContent: { status: "timeout", sessionId, message: "Timeout waiting for feedback" },
        };
      }

      if (matched.type === "agent.run.cancelled") {
        cleanup();
        const reason = String((matched.payload as { reason?: unknown }).reason ?? "cancelled");
        return {
          content: [{ type: "text" as const, text: `Session cancelled: ${reason}` }],
          structuredContent: { status: "error" as const, sessionId, nextSeq: matched.seq, message: `Session cancelled: ${reason}` },
          isError: true,
        };
      }

      const p = matched.payload;
      const structured = {
        id: String(p.feedbackId ?? matched.id),
        verdict: String(p.verdict ?? ""),
        comments: p.comments as string | undefined,
        requiredActions: p.requiredActions as string[] | undefined,
        allowedNextActions: p.allowedNextActions as string[] | undefined,
        reviewerId: p.reviewerId as string | undefined,
        createdAt: matched.createdAt,
        continuationId: undefined as string | undefined,
      };
      const continuation = config.continuationManager
        .listForSession(sessionId)
        .find((c) => c.reviewId === structured.id && c.status === "pending");
      const claimed = continuation
        ? config.continuationManager.claim(waiterOwner, { id: continuation.id })
        : null;
      structured.continuationId = claimed?.id;

      cleanup();
      return {
        content: [{ type: "text" as const, text: `Feedback received: ${p.verdict}${p.comments ? ` — ${p.comments}` : ""}` }],
        structuredContent: { status: "feedback_ready" as const, sessionId, nextSeq: matched.seq, feedback: structured },
      };
    },
  );


  // ── Get Continuation Prompt ─────────────────────────
  // The agent-ready prompt for continuing from review feedback.
  // This is the handoff bridge: review surface → next agent turn.

  registerAppTool(
    server,
    "get_continuation_prompt",
    {
      title: "Get continuation prompt",
      description: "Get the agent-ready prompt for continuing a work session from review feedback. Contains verdict, required actions, and resumption instructions. Use after receiving review feedback to get the next instructions for the session.",
      inputSchema: {
        feedbackEventId: z.string().describe("Feedback event ID from the review.feedback.provided event."),
      },
      outputSchema: {
        continuationId: z.string(),
        prompt: z.string(),
        sessionId: z.string(),
        reviewId: z.string(),
        feedbackEventId: z.string(),
        reviewEpoch: z.number(),
        verdict: z.string(),
        status: z.string(),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ feedbackEventId }) => {
      const continuation = config.continuationManager.getByFeedbackEventId(feedbackEventId);
      const prompt = continuation?.promptText;

      if (!prompt) {
        return {
          content: [{ type: "text" as const, text: `No continuation found for feedback event "${feedbackEventId}". Call submit_for_review first.` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: prompt }],
        structuredContent: {
          continuationId: continuation.id,
          prompt,
          sessionId: continuation.sessionId,
          reviewId: continuation.reviewId,
          feedbackEventId: continuation.feedbackEventId,
          reviewEpoch: continuation.reviewEpoch,
          verdict: continuation.verdict,
          status: continuation.status,
        },
      };
    },
  );

  // ── List Pending Continuations ──────────────────────

  registerAppTool(
    server,
    "list_pending_continuations",
    {
      title: "List pending continuations",
      description: "List continuations awaiting agent pickup. A continuation is created when review feedback is submitted and represents the next agent prompt for that session.",
      inputSchema: {
        sessionId: z.string().optional().describe("Filter by work session ID. If omitted, returns all pending continuations."),
      },
      outputSchema: {
        continuations: z.array(z.object({
          id: z.string(),
          sessionId: z.string(),
          reviewId: z.string(),
          feedbackEventId: z.string(),
          verdict: z.string(),
          status: z.string(),
          createdAt: z.string(),
        })),
        count: z.number(),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }) => {
      const pending = config.continuationManager.listPending(sessionId);

      return {
        content: [{ type: "text" as const, text: `${pending.length} pending continuation(s).` }],
        structuredContent: {
          continuations: pending.map((c) => ({
            id: c.id,
            sessionId: c.sessionId,
            reviewId: c.reviewId,
            feedbackEventId: c.feedbackEventId,
            verdict: c.verdict,
            status: c.status,
            createdAt: c.createdAt,
          })),
          count: pending.length,
        },
      };
    },
  );

  // ── Mark Continuation Consumed ──────────────────────

  registerAppTool(
    server,
    "mark_continuation_consumed",
    {
      title: "Mark continuation consumed",
      description: "Mark a continuation as consumed after acting on it. Prevents the same feedback from being applied twice.",
      inputSchema: {
        continuationId: z.string().describe("Continuation ID to mark as consumed."),
      },
      outputSchema: { status: z.string() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    async ({ continuationId }) => {
      const continuation = config.continuationManager.get(continuationId);
      if (!continuation) {
        return {
          content: [{ type: "text" as const, text: `Continuation ${continuationId} not found.` }],
          structuredContent: { status: "not_found" },
          isError: true,
        };
      }
      // P1 #13: a dispatched worker is bound to one work session; it must not
      // consume a continuation that belongs to a different session.
      const bind = assertWorkerSessionBinding(config, continuation.sessionId);
      if (bind) return bind;
      if (continuation.status === "completed") {
        return {
          content: [{ type: "text" as const, text: `Continuation ${continuationId} already consumed.` }],
          structuredContent: { status: "already_consumed" },
        };
      }
      config.continuationManager.markCompleted(continuationId);
      return {
        content: [{ type: "text" as const, text: `Continuation ${continuationId} marked as consumed.` }],
        structuredContent: { status: "consumed" },
      };
    },
  );

  // ── Get Work Session ───────────────────────────────

  registerAppTool(
    server,
    "get_work_session",
    {
      title: "Get work session",
      description: "Read the current state of a work session including status, submissions, feedback history, and tool events. Use for recovery, sanity checks, or inspecting session state.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID."),
      },
      outputSchema: {
        sessionId: z.string(),
        status: z.string(),
        submittedBy: z.string(),
        title: z.string().optional(),
        submissionCount: z.number(),
        feedbackCount: z.number(),
        latestSubmission: z.object({
          submissionNumber: z.number(),
          message: z.string().optional(),
          status: z.string(),
          createdAt: z.string(),
        }).optional(),
        latestFeedback: z.object({
          verdict: z.string(),
          comments: z.string().optional(),
          requiredActions: z.array(z.string()).optional(),
          allowedNextActions: z.array(z.string()).optional(),
          createdAt: z.string(),
        }).optional(),
        toolEvents: z.array(z.object({
          tool: z.string(),
          path: z.string().optional(),
          summary: z.string().optional(),
          success: z.boolean(),
          createdAt: z.string(),
        })),
        createdAt: z.string(),
        updatedAt: z.string(),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }) => {
      const access = requireWorkSessionRead(config, sessionId);
      if (access) return access;
      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };

      const submissions = config.workSessions.getSubmissions(sessionId);
      const feedbackCount = config.workSessions.countFeedback(sessionId);
      const lf = session.latestFeedback;

      const latestFeedbackStructured = lf ? {
        verdict: lf.verdict,
        comments: lf.comments,
        requiredActions: lf.requiredActionsJson ? JSON.parse(lf.requiredActionsJson) as string[] : undefined,
        allowedNextActions: lf.allowedNextActionsJson ? JSON.parse(lf.allowedNextActionsJson) as string[] : undefined,
        createdAt: lf.createdAt,
      } : undefined;

      const latestSub = session.latestSubmission;
      const text = [
        `Session: ${session.id}`,
        `Status: ${session.status}`,
        `Submitted by: ${session.submittedBy}`,
        session.title ? `Title: ${session.title}` : null,
        `Submissions: ${submissions.length}, Feedback: ${feedbackCount}`,
        latestSub ? `Latest submission #${latestSub.submissionNumber} (${latestSub.status}) at ${latestSub.createdAt}` : null,
        lf ? `Latest feedback: ${lf.verdict} at ${lf.createdAt}` : null,
        lf?.comments ? `Comments: ${lf.comments}` : null,
      ].filter(Boolean).join("\n");

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          sessionId: session.id,
          status: session.status,
          submittedBy: session.submittedBy,
          title: session.title,
          submissionCount: submissions.length,
          feedbackCount,
          latestSubmission: latestSub ? {
            submissionNumber: latestSub.submissionNumber,
            message: latestSub.message,
            status: latestSub.status,
            createdAt: latestSub.createdAt,
          } : undefined,
          latestFeedback: latestFeedbackStructured,
          toolEvents: config.workSessions.getToolEvents(sessionId, 20).map((e) => ({
            tool: e.tool,
            path: e.path,
            summary: e.outputSummary,
            success: e.success,
            createdAt: e.createdAt,
          })),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
      };
    },
  );

  // ── List Pending Reviews ───────────────────────────

  registerAppTool(
    server,
    "list_pending_reviews",
    {
      title: "List pending reviews",
      description: "Find work sessions that are awaiting review or have review in progress. Use for recovery after timeout, reconnect, or discovering unreviewed submissions.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Optional workspace ID to scope the search."),
      },
      outputSchema: {
        sessions: z.array(z.object({
          sessionId: z.string(),
          workspaceSessionId: z.string(),
          status: z.string(),
          title: z.string().optional(),
          submittedBy: z.string(),
          submissionCount: z.number(),
          updatedAt: z.string(),
        })),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "list_pending_reviews");
      }
      const surface = config.workSessions.getWorkspaceSessionSurface(workspaceId, 20, "pending_review");
      const text = surface.length === 0
        ? "No sessions awaiting review."
        : `${surface.length} session(s) awaiting review:\n${surface.map((s) => {
            return `  ${s.sessionId} [${s.status}] ${s.title ?? "untitled"} — ${s.submissionCount} submission(s), updated ${s.updatedAt}`;
          }).join("\n")}`;

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          sessions: surface.map((s) => ({
            sessionId: s.sessionId,
            workspaceSessionId: s.workspaceSessionId,
            status: s.status,
            title: s.title,
            submittedBy: s.submittedBy,
            submissionCount: s.submissionCount,
            updatedAt: s.updatedAt,
          })),
        },
      };
    },
  );

  // ── Agent → WebUI messages / artifacts (item 6) ────

  registerAppTool(
    server,
    "post_agent_message",
    {
      title: "Post message to WebUI",
      description: "Send a general message or artifact from the worker to the WebUI: ask for clarification, report a blocker, publish a finding, submit an artifact, or leave a note. Durable and ordered — the WebUI receives it live and can re-list it after a reload. Use kind='clarification_request' or 'blocker' when you need a human to act (these show as open until resolved).",
      inputSchema: {
        sessionId: z.string().describe("Work session ID."),
        kind: z.enum(AGENT_MESSAGE_KINDS as [string, ...string[]]).describe("Message kind."),
        title: z.string().optional().describe("Short headline."),
        body: z.string().optional().describe("Message text / question / description."),
        data: z.record(z.string(), z.unknown()).optional().describe("Structured payload: artifact ref, finding evidence, or answer options."),
      },
      outputSchema: { messageId: z.string(), status: z.string(), kind: z.string() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    async ({ sessionId, kind, title, body, data }) => {
      if (!isWorkerOrClient(config.principalRole)) {
        return forbidden(config.principalRole, "post_agent_message");
      }
      if (!config.agentMessages) {
        return { content: [{ type: "text" as const, text: "Agent-message store unavailable." }], isError: true };
      }
      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      const bind = assertWorkerSessionBinding(config, sessionId);
      if (bind) return bind;

      const run = config.agentRegistry.getRunByWorkSessionId(sessionId);
      const message = config.agentMessages.post({
        workSessionId: sessionId,
        runId: run?.runId,
        kind: kind as (typeof AGENT_MESSAGE_KINDS)[number],
        author: config.principalRole === "worker" ? "worker" : "agent",
        title,
        body,
        data,
      });
      // Durable wakeup so the WebUI watcher renders it without polling.
      config.eventStore.appendEvent({
        type: "agent.message.posted",
        sessionId,
        payload: {
          messageId: message.id,
          kind: message.kind,
          title: message.title,
          body: message.body,
          status: message.status,
          runId: run?.runId,
        },
      });
      return {
        content: [{ type: "text" as const, text: `Posted ${message.kind} (${message.id}).` }],
        structuredContent: { messageId: message.id, status: message.status, kind: message.kind },
      };
    },
  );

  registerAppTool(
    server,
    "list_agent_messages",
    {
      title: "List agent messages",
      description: "List durable agent→WebUI messages/artifacts for a work session (clarification requests, blockers, findings, artifacts, notes). Use for WebUI rehydration and to surface open questions/blockers awaiting a reply.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID."),
        openOnly: z.boolean().optional().describe("Only return unresolved gating messages (questions/blockers)."),
      },
      outputSchema: {
        messages: z.array(z.object({
          messageId: z.string(),
          kind: z.string(),
          author: z.string(),
          title: z.string().optional(),
          body: z.string().optional(),
          status: z.string(),
          createdAt: z.string(),
        })),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, openOnly }) => {
      const denied = requireWorkSessionRead(config, sessionId);
      if (denied) return denied;
      if (!config.agentMessages) {
        return { content: [{ type: "text" as const, text: "Agent-message store unavailable." }], isError: true };
      }
      const messages = config.agentMessages.list(sessionId, { openOnly });
      return {
        content: [{ type: "text" as const, text: `${messages.length} message(s).` }],
        structuredContent: {
          messages: messages.map((m) => ({
            messageId: m.id,
            kind: m.kind,
            author: m.author,
            title: m.title,
            body: m.body,
            status: m.status,
            createdAt: m.createdAt,
          })),
        },
      };
    },
  );

  registerAppTool(
    server,
    "resolve_agent_message",
    {
      title: "Resolve agent message",
      description: "Mark an open clarification request or blocker as resolved (e.g. after the reviewer has answered it). Optional reply text is delivered back to the worker as a durable event.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID."),
        messageId: z.string().describe("The agent message to resolve."),
        reply: z.string().optional().describe("Answer / resolution text sent back to the worker."),
      },
      outputSchema: { messageId: z.string(), status: z.string() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    async ({ sessionId, messageId, reply }) => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "resolve_agent_message");
      }
      if (!config.agentMessages) {
        return { content: [{ type: "text" as const, text: "Agent-message store unavailable." }], isError: true };
      }
      const existing = config.agentMessages.get(messageId);
      if (!existing || existing.workSessionId !== sessionId) {
        return { content: [{ type: "text" as const, text: "Message not found for this session." }], isError: true };
      }
      const resolved = config.agentMessages.resolve(messageId);
      config.eventStore.appendEvent({
        type: "agent.message.resolved",
        sessionId,
        payload: { messageId, reply, replyToKind: existing.kind },
      });
      return {
        content: [{ type: "text" as const, text: `Resolved ${messageId}.` }],
        structuredContent: { messageId, status: resolved?.status ?? "resolved" },
      };
    },
  );

  // ── Get Work Session Snapshot (P0 #1: replaces seq-0 replay) ──
  // Returns a compact projection of the work session's current state so the
  // WebUI can hydrate instantly without replaying thousands of events. The
  // client then calls await_work_session_events starting from snapshot.lastSeq.

  registerAppTool(
    server,
    "get_work_session_snapshot",
    {
      title: "Get work session snapshot",
      description: "Return a compact projection of a work session's current state (status, workspace, latest submission/feedback, mission summary, last event seq) so the WebUI can hydrate without replaying the event log. The client should then call await_work_session_events with afterSeq = snapshot.lastSeq to receive only new activity.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID to snapshot."),
      },
      outputSchema: {
        sessionId: z.string(),
        workspaceSessionId: z.string(),
        status: z.string(),
        title: z.string().optional(),
        submittedBy: z.string(),
        runId: z.string().optional(),
        submissionCount: z.number(),
        lastSeq: z.number(),
        updatedAt: z.string(),
        latestSubmission: z.object({
          submissionId: z.string(),
          submissionNumber: z.number(),
          status: z.string(),
          additions: z.number(),
          removals: z.number(),
          diffSha256: z.string().optional(),
          reviewEpoch: z.number().optional(),
        }).optional(),
        latestFeedback: z.object({
          id: z.string(),
          submissionId: z.string().optional(),
          verdict: z.string(),
          comments: z.string().optional(),
          reviewerId: z.string().optional(),
        }).optional(),
        hasMission: z.boolean(),
        missionSummary: z.object({
          objective: z.string().optional(),
          status: z.string().optional(),
          cycleNumber: z.number().optional(),
          maxCycles: z.number().optional(),
        }).optional(),
        pendingApprovals: z.array(z.object({
          approvalId: z.string(),
          kind: z.string().optional(),
          title: z.string().optional(),
          description: z.string().optional(),
          risk: z.string().optional(),
          tool: z.string().optional(),
          path: z.string().optional(),
          command: z.string().optional(),
          options: z.array(z.object({
            id: z.string(),
            label: z.string(),
            effect: z.enum(["approve", "deny", "changes_requested"]),
            scope: z.enum(["once", "work_session", "workspace"]).optional(),
          })).optional(),
        })).optional(),
        agentMessages: z.array(z.object({
          messageId: z.string(),
          kind: z.string(),
          author: z.string().optional(),
          title: z.string().optional(),
          body: z.string().optional(),
          status: z.string().optional(),
          runId: z.string().optional(),
          createdAt: z.string().optional(),
        })).optional(),
        lastEventSeq: z.number().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }) => {
      const startedAt = performance.now();
      try {
        const access = requireWorkSessionRead(config, sessionId);
        if (access) return access;
        const buildSnapshot = () => {
      const session = config.workSessions.get(sessionId);
      if (!session) {
        return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      }
      const run = config.agentRegistry.getRunByWorkSessionId(sessionId);
      const latestSubmission = session.latestSubmission;
      const latestFeedback = session.latestFeedback;

      // Mission detection: check the mission ledger rather than calling inspect_supervised_work.
      let hasMission = false;
      let missionSummary: { objective?: string; status?: string; cycleNumber?: number; maxCycles?: number } | undefined;
      if (config.missionLedger) {
        const mission = config.missionLedger.getMissionByWorkSession(sessionId);
        if (mission) {
          hasMission = true;
          const supervisor = config.supervisorRuns?.getByWorkSession(sessionId);
          missionSummary = {
            objective: mission.objective,
            status: supervisor?.status,
            cycleNumber: supervisor?.cycleNumber,
            maxCycles: supervisor?.maxCycles,
          };
        }
      }

      // Get the last event seq for this session so the client can resume from there.
      const lastEvent = config.eventStore.getLatestEvent(sessionId);
      const lastSeq = lastEvent?.seq ?? 0;

      // P0 #6: Expand snapshot to include pending approvals and agent messages
      const pendingApprovals = config.approvalRequests
        ? config.approvalRequests.listPending(session.workspaceSessionId).filter((a) => a.workSessionId === sessionId).map((a) => ({
            approvalId: a.approvalId,
            kind: a.kind,
            title: a.title,
            description: a.description,
            risk: a.risk,
            tool: a.tool,
            path: a.path,
            command: a.command,
            options: a.options,
          }))
        : [];
      const agentMessages = config.agentMessages
        ? config.agentMessages.list(sessionId).filter((m) => m.status === "open").map((m) => ({
            messageId: m.id,
            kind: m.kind,
            author: m.author,
            title: m.title,
            body: m.body,
            status: m.status,
            runId: m.runId,
            createdAt: m.createdAt,
          }))
        : [];

      return {
        content: [{ type: "text" as const, text: `Snapshot for session ${sessionId}: status=${session.status}, submissions=${session.latestSubmission ? "yes" : "no"}, lastSeq=${lastSeq}.` }],
        structuredContent: {
          sessionId: session.id,
          workspaceSessionId: session.workspaceSessionId,
          status: session.status,
          title: session.title,
          submittedBy: session.submittedBy,
          runId: run?.runId,
          submissionCount: config.workSessions.getSubmissions(sessionId).length,
          lastSeq,
          updatedAt: session.updatedAt,
          latestSubmission: latestSubmission ? {
            submissionId: latestSubmission.id,
            submissionNumber: latestSubmission.submissionNumber,
            status: latestSubmission.status,
            additions: latestSubmission.additions ?? 0,
            removals: latestSubmission.removals ?? 0,
            diffSha256: latestSubmission.diffSha256 ?? undefined,
            reviewEpoch: latestSubmission.reviewEpoch ?? undefined,
          } : undefined,
          latestFeedback: latestFeedback ? {
            id: latestFeedback.id,
            submissionId: latestFeedback.submissionId,
            verdict: latestFeedback.verdict,
            comments: latestFeedback.comments ?? undefined,
            reviewerId: latestFeedback.reviewerId ?? undefined,
          } : undefined,
          hasMission,
          missionSummary,
          // P0 #6: Include pending approvals and agent messages for full recovery
          pendingApprovals,
          agentMessages,
          // Alias makes the cursor contract explicit to clients that use the
          // event-sourced terminology from the reliability protocol.
          lastEventSeq: lastSeq,
        },
        };
      };
      // All projection reads and the event cursor use the same SQLite
      // connection and transaction. This closes the fetch-vs-subscribe race:
      // the cursor is the exact boundary of the state returned above.
        return config.db
          ? config.db.sqlite.transaction(buildSnapshot)()
          : buildSnapshot();
      } finally {
        config.onPhaseTiming?.("workspace.snapshot_query", performance.now() - startedAt);
      }
    },
  );

  // ── Workspace Session Surface (batch WebUI rehydration) ──
  registerAppTool(
    server,
    "get_workspace_session_surface",
    {
      title: "Get workspace session surface",
      description: "Return a compact batch projection for the workspace session picker. It includes current lifecycle, review identity, pending counts, and event cursors without loading diffs or replaying event history. Fetch get_work_session_snapshot lazily for the selected session.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID to scope the session surface."),
        limit: z.number().int().min(1).max(200).optional().default(50),
        filter: z.enum(["all", "pending_review", "live"]).optional().default("all"),
        afterUpdatedAt: z.string().optional().describe("Return sessions strictly older than this updatedAt cursor."),
        afterSessionId: z.string().optional().describe("Tie-breaker for afterUpdatedAt; use the last sessionId from the previous page."),
      },
      outputSchema: {
        lastSeq: z.number(),
        sessions: z.array(z.object({
          sessionId: z.string(),
          workspaceSessionId: z.string(),
          status: z.string(),
          lifecycle: z.string(),
          runtimeState: z.string(),
          title: z.string().optional(),
          submittedBy: z.string(),
          updatedAt: z.string(),
          runId: z.string().optional(),
          hasMission: z.boolean(),
          missionStatus: z.string().optional(),
          missionCycleNumber: z.number().optional(),
          missionMaxCycles: z.number().optional(),
          lastSeq: z.number(),
          submissionCount: z.number(),
          unresolvedMessageCount: z.number(),
          pendingApprovalCount: z.number(),
          latestSubmission: z.object({
            submissionId: z.string(),
            submissionNumber: z.number(),
            status: z.string(),
            additions: z.number(),
            removals: z.number(),
            diffSha256: z.string().optional(),
            reviewEpoch: z.number().optional(),
          }).optional(),
          latestFeedback: z.object({
            id: z.string(),
            submissionId: z.string().optional(),
            verdict: z.string(),
            comments: z.string().optional(),
            reviewerId: z.string().optional(),
          }).optional(),
        })),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, limit, filter, afterUpdatedAt, afterSessionId }) => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "get_workspace_session_surface");
      }
      const startedAt = performance.now();
      try {
        const readSurface = () => ({
          lastSeq: config.workSessions.getWorkspaceEventCursor(workspaceId),
          sessions: config.workSessions.getWorkspaceSessionSurface(
            workspaceId,
            limit,
            filter,
            afterUpdatedAt && afterSessionId ? { updatedAt: afterUpdatedAt, sessionId: afterSessionId } : undefined,
          ),
        });
        const surface = config.db
          ? config.db.sqlite.transaction(readSurface)()
          : readSurface();
        return {
          content: [{ type: "text" as const, text: `${surface.sessions.length} workspace session surface entr${surface.sessions.length === 1 ? "y" : "ies"}.` }],
          structuredContent: surface,
        };
      } finally {
        config.onPhaseTiming?.("workspace.surface_query", performance.now() - startedAt);
      }
    },
  );

  // ── List Live Work Sessions (WebUI rehydration) ──
  // Returns only sessions with a current worker or a freshly-created pending
  // worker state. Awaiting-review sessions have their own bounded listing so
  // old human-review work cannot masquerade as a live worker.
  registerAppTool(
    server,
    "list_active_work_sessions",
    {
      title: "List live work sessions",
      description: "List live worker sessions (optionally scoped to a workspace) for WebUI rehydration. Awaiting-review, detached, stale, and archived work is returned through its dedicated recovery/review listing instead of being presented as currently running.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Optional workspace ID to scope the listing. Omit only when the user explicitly asks to view all sessions across all workspaces."),
      },
      outputSchema: {
        sessions: z.array(z.object({
          sessionId: z.string(),
          workspaceSessionId: z.string(),
          status: z.string(),
          title: z.string().optional(),
          submittedBy: z.string(),
          runId: z.string().optional(),
          submissionCount: z.number(),
          lastSeq: z.number(),
          updatedAt: z.string(),
          hasMission: z.boolean(),
          missionStatus: z.string().optional(),
          missionCycleNumber: z.number().optional(),
          missionMaxCycles: z.number().optional(),
          lifecycle: z.string(),
          runtimeState: z.string(),
        })),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "list_active_work_sessions");
      }
      const surface = config.workSessions.getWorkspaceSessionSurface(workspaceId, 50, "live");
      const mapped = surface.map((s) => {
        return {
          sessionId: s.sessionId,
          workspaceSessionId: s.workspaceSessionId,
          status: s.status,
          title: s.title,
          submittedBy: s.submittedBy,
          runId: s.runId,
          submissionCount: s.submissionCount,
          lastSeq: s.lastSeq,
          updatedAt: s.updatedAt,
          hasMission: s.hasMission,
          missionStatus: s.missionStatus,
          missionCycleNumber: s.missionCycleNumber,
          missionMaxCycles: s.missionMaxCycles,
          lifecycle: s.lifecycle,
          runtimeState: s.runtimeState,
        };
      });
      const text = mapped.length === 0
        ? "No active work sessions."
        : `${mapped.length} active session(s):\n${mapped.map((s) => `  ${s.sessionId} [${s.status}] ${s.title ?? "untitled"} — updated ${s.updatedAt}`).join("\n")}`;

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { sessions: mapped },
      };
    },
  );

  // ── Search Skills (P1 #10: lazy global skill discovery) ──
  // Returns a compact index of available skills (project-local + global)
  // so the model can search without loading every skill on every open.

  registerAppTool(
    server,
    "search_skills",
    {
      title: "Search skills",
      description: "Search the available skill catalog by keyword. Returns a compact index of matching skills (name, description, path, source). Use this to discover global skills lazily instead of loading all skills on every workspace open. The model can then read a specific skill's path with the read tool.",
      inputSchema: {
        query: z.string().describe("Search query to match against skill names and descriptions."),
        limit: z.number().int().min(1).max(50).optional().default(10).describe("Maximum number of results to return."),
        workspaceId: z.string().optional().describe("Workspace ID to scope project-local skill discovery. If omitted, only global skills are returned."),
      },
      outputSchema: {
        skills: z.array(z.object({
          name: z.string(),
          description: z.string(),
          path: z.string(),
          source: z.enum(["project-local", "global"]),
        })),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit, workspaceId }) => {
      // P1 #29: Use workspace-specific root for project-local skill discovery
      const serverConfig = config.serverConfig;
      if (!serverConfig) {
        return {
          content: [{ type: "text" as const, text: "Skill search is not available: server config not provided to bridge." }],
          isError: true,
        };
      }
      // P1 #29: Use workspace root if workspaceId provided, else fall back to server cwd
      let cwd = process.cwd();
      if (workspaceId) {
        try {
          const ws = config.workspaces.getWorkspace(workspaceId);
          cwd = ws.root;
        } catch {
          // workspace not found, fall back to global-only
        }
      }
      const allSkills = loadSkillIndex(serverConfig, cwd);
      const queryLower = query.toLowerCase();
      const matched = allSkills
        .filter((skill: { name: string; description: string }) =>
          skill.name.toLowerCase().includes(queryLower) ||
          skill.description.toLowerCase().includes(queryLower)
        )
        .slice(0, limit);

      const text = matched.length === 0
        ? `No skills matching "${query}".`
        : `${matched.length} skill(s) matching "${query}":\n${matched.map((s) => `  ${s.name} (${s.source}): ${s.description} — ${s.path}`).join("\n")}`;

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { skills: matched },
      };
    },
  );

  // ── Session Handoff between agents (item 7) ────────

  registerAppTool(
    server,
    "handoff_work_session",
    {
      title: "Hand off work session to another agent",
      description: "Reassign an in-flight work session to a different registered CLI agent (e.g. hand investigation from CRUSH to Hermes, or route a review to a dedicated reviewer agent). The session, workspace, mission, submissions, and review history are preserved; only the agent that will handle the NEXT resume changes. The handoff takes effect on the next continuation dispatch — a currently-parked worker is not force-killed unless you also cancel it.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID to hand off."),
        toAgent: z.string().describe("Name of the target registered agent (role=agent)."),
        reason: z.string().optional().describe("Why the session is being handed off (recorded)."),
      },
      outputSchema: { sessionId: z.string(), fromAgent: z.string().optional(), toAgent: z.string(), status: z.string() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    async ({ sessionId, toAgent, reason }) => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "handoff_work_session");
      }
      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      if (TERMINAL_STATUSES.has(session.status)) {
        return { content: [{ type: "text" as const, text: `Session is ${session.status}; cannot hand off a terminal session.` }], isError: true };
      }

      // The target must be a real, registered agent — otherwise the next resume
      // would fail with "no healthy agent" and strand the session.
      const selection = await selectHealthyAgent(config.agentRegistry.listAlive(), {
        name: toAgent,
        role: "agent",
        adapterSecret: config.adapterSecret,
      });
      if (!selection.agent) {
        return { content: [{ type: "text" as const, text: `No healthy agent named ${toAgent} (role=agent) is registered.` }], isError: true };
      }

      const run = config.agentRegistry.getRunByWorkSessionId(sessionId);
      if (!run) {
        return { content: [{ type: "text" as const, text: "No correlated run to reassign for this session." }], isError: true };
      }
      const fromAgent = run.agentName;
      if (fromAgent === toAgent) {
        return {
          content: [{ type: "text" as const, text: `Session already assigned to ${toAgent}.` }],
          structuredContent: { sessionId, fromAgent, toAgent, status: "unchanged" },
        };
      }

      // Reassign the correlated run. The continuation dispatcher reads
      // run.agentName when it routes the next resume, so this reroutes future
      // work without disturbing the durable session/review state.
      config.agentRegistry.updateRun(run.runId, { agentName: toAgent });
      // Keep the mission's preferredAgent in sync — the dispatcher prefers it
      // over run.agentName, so a stale work-order value would otherwise re-route
      // the very next resume back to the old agent, silently undoing the handoff.
      config.missionLedger?.setWorkOrderPreferredAgent(sessionId, toAgent);
      config.eventStore.appendEvent({
        type: "session.handoff",
        sessionId,
        payload: { runId: run.runId, fromAgent, toAgent, reason },
      });

      return {
        content: [{ type: "text" as const, text: `Handed off session ${sessionId} from ${fromAgent} to ${toAgent}.` }],
        structuredContent: { sessionId, fromAgent, toAgent, status: "handed_off" },
      };
    },
  );

  // ── Cancel Work Session ────────────────────────────

  registerAppTool(
    server,
    "cancel_work_session",
    {
      title: "Cancel work session",
      description: "Abandon a work session. Transitions status to cancelled, wakes blocked waiters, supersedes pending continuations, and requests remote worker cancellation.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID to cancel."),
      },
      outputSchema: { status: z.string(), sessionId: z.string(), remoteCancellation: z.unknown().optional() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    async ({ sessionId }) => {
      if (config.principalRole !== "reviewer" && config.principalRole !== "worker") {
        return forbidden(config.principalRole, "cancel_work_session");
      }
      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      const bind = assertWorkerSessionBinding(config, sessionId);
      if (bind) return bind;

      const cancellation = config.reviewWorkflow.cancelSession({ sessionId });
      const supervisor = config.supervisorRuns?.getByWorkSession(sessionId);
      if (supervisor) config.supervisorRuns?.transition({ id: supervisor.id, expectedStatus: supervisor.status, expectedRevision: supervisor.revision, nextStatus: "cancelled" });
      const run = config.agentRegistry.getRunByWorkSessionId(sessionId);
      let remoteCancellation = run
        ? await cancelRemoteRun(config, run)
        : { acknowledged: false, error: "No correlated ACP run" };
      if (!run || (!remoteCancellation.acknowledged && (!run.remoteRunId || remoteCancellation.status === 404))) {
        config.reviewWorkflow.finalizeCancellation({ sessionId, reason: "no live worker remained" });
        remoteCancellation = { ...remoteCancellation, acknowledged: true };
      }
      return {
        content: [{ type: "text" as const, text: `Session ${sessionId} ${config.workSessions.get(sessionId)?.status ?? cancellation.status}.${remoteCancellation.acknowledged ? " Remote worker cancellation requested." : ""}` }],
        structuredContent: { status: config.workSessions.get(sessionId)?.status ?? cancellation.status, sessionId, remoteCancellation },
      };
    },
  );

  // ── Call ACP Agent (gateway) ────────────────────────

  registerAppTool(
    server,
    "call_acp_agent",
    {
      title: "Call ACP agent",
      description: "Route a task to a registered ACP-compatible agent. Requires workspace correlation so the adapter can run in the correct workspace.",
      inputSchema: {
        agentName: z.string().describe("Name of the target ACP agent."),
        task: z.string().describe("Task description for the remote agent."),
        workspaceId: z.string().optional().describe("Workspace ID from open_workspace. Preferred public name; aliases workspaceSessionId."),
        workspaceSessionId: z.string().optional().describe("Workspace session ID (legacy/internal alias for workspaceId)."),
        workSessionId: z.string().optional().describe("Optional existing work session ID."),
        sessionId: z.string().optional().describe("Legacy alias for workSessionId."),
        agentUrl: z.string().optional().describe("Deprecated and rejected. Agents must be selected from the trusted registry."),
        webhookUrl: z.string().optional().describe("Deprecated and rejected. Agent progress is tracked through Kontrol events."),
      },
      outputSchema: { runId: z.string(), workSessionId: z.string().optional(), workspaceSessionId: z.string().optional(), status: z.string(), output: z.string(), error: z.string().optional() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    async ({ agentName, task, workspaceId, workspaceSessionId, workSessionId, sessionId, agentUrl, webhookUrl }) => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "call_acp_agent");
      }
      if (agentUrl || webhookUrl) {
        return { content: [{ type: "text" as const, text: "call_acp_agent only routes to registered agents and does not accept caller-supplied URLs." }], isError: true };
      }
      const resolved = resolveDelegationContext(config, { workspaceId, workspaceSessionId, workSessionId, sessionId });
      if (resolved.error || !resolved.workspaceSessionId) {
        return { content: [{ type: "text" as const, text: resolved.error ?? "Unknown workspace." }], isError: true };
      }
      workspaceSessionId = resolved.workspaceSessionId;
      workSessionId = resolved.workSessionId;

      const selection = await selectHealthyAgent(config.agentRegistry.listAlive(), {
        name: agentName,
        role: "agent",
        adapterSecret: config.adapterSecret,
      });
      if (!selection.agent) return { content: [{ type: "text" as const, text: `No healthy registered ACP agent named "${agentName}".` }], isError: true };
      const createdWorkSession = !workSessionId;
      const wsId = workSessionId ?? config.workSessions.create({
        workspaceSessionId,
        submittedBy: "webui",
        title: task.slice(0, 80),
        completionPolicy: "webui_approval_required",
      }).id;
      const leaseError = await acquireCheckoutModifyLease(config, workspaceSessionId, wsId);
      if (leaseError) {
        if (!workSessionId) config.workSessions.updateStatus(wsId, "cancelled");
        return leaseError;
      }

      try {
        const result = await callRemoteAgent(
          { agentRegistry: config.agentRegistry, workspaces: config.workspaces, workSessions: config.workSessions, adapterSecret: config.adapterSecret },
          {
            agentUrl: selection.agent.url,
            agentName,
            agentId: selection.agent.id,
            task: `${task}\n\n${workSessionInstructions(wsId, selection.agent)}`,
            workspaceSessionId,
            workSessionId: wsId,
            workspaceLeaseNonce: checkoutLeaseNonce(config, wsId),
            mode: "async",
            fireAndForget: true,
          },
        );

        if (result.status === "failed") {
          if (createdWorkSession) config.workSessions.updateStatus(wsId, "failed");
          config.workSessions.releaseWorkspaceLeasesForSession(wsId);
          config.eventStore.appendEvent({ type: "agent.dispatch.failed", sessionId: wsId, payload: { runId: result.runId, reason: result.error ?? "ACP dispatch failed" } });
          return {
            content: [{ type: "text" as const, text: `${agentName}: failed\n${result.error ?? "(no error detail)"}` }],
            structuredContent: { runId: result.runId, workSessionId: wsId, workspaceSessionId, status: result.status, output: result.output, error: result.error },
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `${agentName}: ${result.status}\n${result.output.slice(0, 5000)}${result.error ? `\nError: ${result.error}` : ""}` }],
          structuredContent: { runId: result.runId, workSessionId: wsId, workspaceSessionId, status: result.status, output: result.output, error: result.error },
        };
      } catch (error) {
        if (createdWorkSession) config.workSessions.updateStatus(wsId, "failed");
        config.workSessions.releaseWorkspaceLeasesForSession(wsId);
        config.eventStore.appendEvent({ type: "agent.dispatch.failed", sessionId: wsId, payload: { reason: error instanceof Error ? error.message : String(error) } });
        return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );

  // ── Discover Agents ─────────────────────────────────

  registerAppTool(
    server,
    "discover_agents",
    {
      title: "Discover agents",
      description: "List all registered peer agents in the registry. Returns alive agents that can be called via call_acp_agent.",
      inputSchema: {},
      outputSchema: { agents: z.array(z.object({ name: z.string(), url: z.string(), alive: z.boolean(), capabilities: z.array(z.string()) })) },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "discover_agents");
      }
      const all = config.agentRegistry.listAll();
      const alive = all.filter((a) => a.alive);
      // Probe each alive peer for protocol readiness so a stale/gRPC-only endpoint
      // is reported as unhealthy rather than merely "alive".
      const health = await Promise.all(
        alive.map(async (a) => {
          if (!/^https?:\/\//.test(a.url)) {
            return { a, probe: { healthy: true, status: 0, note: "n/a (non-http endpoint)" } as const };
          }
          return { a, probe: await probeAgent(a.url, config.adapterSecret) };
        }),
      );
      const text = alive.length > 0
        ? `Discovered ${alive.length} agent(s):\n${health.map(({ a, probe }) => `  ${a.name} → ${a.url} [${probe.note ? probe.note : probe.healthy ? "healthy" : "UNHEALTHY: " + (probe.error ?? "HTTP " + probe.status)}] (${a.capabilities.join(", ") || "no capabilities"})`).join("\n")}`
        : "No agents discovered. Register agents via the ACP /agents/register endpoint or configure knownAgents.";

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          agents: all.map((a) => {
            const h = health.find((x) => x.a.id === a.id)?.probe;
            return { name: a.name, url: a.url, alive: a.alive, healthy: h?.healthy, capabilities: a.capabilities };
          }),
        },
      };
    },
  );

  // ── Dynamic tools for configured known agents ───────

  for (const agent of config.knownAgents) {
    const safeName = agent.name.replace(/[^a-zA-Z0-9_]/g, "_");
    registerAppTool(
      server,
      `route_to_${safeName}`,
      {
        title: `Route to ${agent.name}`,
        description: `Route a task to configured agent "${agent.name}" at ${agent.url}.${agent.description ? ` ${agent.description}` : ""}`,
        inputSchema: {
          task: z.string().describe("Task description."),
          workspaceId: z.string().optional().describe("Workspace ID from open_workspace. Preferred public name; aliases workspaceSessionId."),
          workspaceSessionId: z.string().optional().describe("Workspace session ID (legacy/internal alias for workspaceId)."),
          workSessionId: z.string().optional().describe("Optional existing work session ID."),
          sessionId: z.string().optional().describe("Legacy alias for workSessionId."),
        },
        outputSchema: { runId: z.string(), workSessionId: z.string().optional(), workspaceSessionId: z.string().optional(), status: z.string(), output: z.string() },
        _meta: {},
        annotations: { readOnlyHint: false },
      },
      async ({ task, workspaceId, workspaceSessionId, workSessionId, sessionId }) => {
        if (!isReviewer(config.principalRole)) {
          return forbidden(config.principalRole, `route_to_${safeName}`);
        }
        const resolved = resolveDelegationContext(config, { workspaceId, workspaceSessionId, workSessionId, sessionId });
        if (resolved.error || !resolved.workspaceSessionId) {
          return { content: [{ type: "text" as const, text: resolved.error ?? "Unknown workspace." }], isError: true };
        }
        const resolvedWorkspaceSessionId = resolved.workspaceSessionId;
        const createdWorkSession = !resolved.workSessionId;
        const resolvedWorkSessionId = resolved.workSessionId ?? config.workSessions.create({
          workspaceSessionId: resolvedWorkspaceSessionId,
          submittedBy: "webui",
          title: task.slice(0, 80),
          completionPolicy: "webui_approval_required",
        }).id;
        const leaseError = await acquireCheckoutModifyLease(config, resolvedWorkspaceSessionId, resolvedWorkSessionId);
        if (leaseError) {
          if (!resolved.workSessionId) config.workSessions.updateStatus(resolvedWorkSessionId, "cancelled");
          return leaseError;
        }
        try {
          const result = await callRemoteAgent(
            { agentRegistry: config.agentRegistry, workspaces: config.workspaces, workSessions: config.workSessions, adapterSecret: config.adapterSecret },
            {
              agentUrl: agent.url,
              agentName: agent.name,
              task: `${task}\n\n${workSessionInstructions(resolvedWorkSessionId, config.agentRegistry.listAlive().find((candidate) => candidate.name === agent.name))}`,
              workspaceSessionId: resolvedWorkspaceSessionId,
              workSessionId: resolvedWorkSessionId,
              workspaceLeaseNonce: checkoutLeaseNonce(config, resolvedWorkSessionId),
              mode: "async",
              fireAndForget: true,
            },
          );
          if (result.status === "failed") {
            if (createdWorkSession) config.workSessions.updateStatus(resolvedWorkSessionId, "failed");
            config.workSessions.releaseWorkspaceLeasesForSession(resolvedWorkSessionId);
            config.eventStore.appendEvent({ type: "agent.dispatch.failed", sessionId: resolvedWorkSessionId, payload: { runId: result.runId, reason: result.error ?? "ACP dispatch failed" } });
            return { content: [{ type: "text" as const, text: `${agent.name}: failed\n${result.error ?? "ACP dispatch failed"}` }], structuredContent: { runId: result.runId, workSessionId: resolvedWorkSessionId, workspaceSessionId: resolvedWorkspaceSessionId, status: result.status, output: result.output, error: result.error }, isError: true };
          }
          return { content: [{ type: "text" as const, text: `${agent.name}: ${result.status}\n${result.output.slice(0, 5000)}` }], structuredContent: { runId: result.runId, workSessionId: resolvedWorkSessionId, workspaceSessionId: resolvedWorkspaceSessionId, status: result.status, output: result.output } };
        } catch (error) {
          if (createdWorkSession) config.workSessions.updateStatus(resolvedWorkSessionId, "failed");
          config.workSessions.releaseWorkspaceLeasesForSession(resolvedWorkSessionId);
          config.eventStore.appendEvent({ type: "agent.dispatch.failed", sessionId: resolvedWorkSessionId, payload: { reason: error instanceof Error ? error.message : String(error) } });
          return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
      },
    );
  }

  // NOTE: the continuation dispatcher is started explicitly by the server
  // (via startContinuationDispatcher) so it can be omitted in tests.
}
