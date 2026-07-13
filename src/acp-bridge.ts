import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkSessionManager } from "./work-sessions.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { ReviewCheckpointManager } from "./review-checkpoints.js";
import type { AgentRegistryManager } from "./acp-registry.js";
import type { EventStore, EventStoreEvent, EventPredicate } from "./event-log.js";
import { type ContinuationManager, type Continuation, DEFAULT_CLAIM_LEASE_MS } from "./continuation.js";
import { callRemoteAgent, cancelRemoteRun, selectHealthyAgent, probeAgent, type AgentCallResult } from "./acp-gateway.js";
import { TERMINAL_STATUSES, type ReviewWorkflowService } from "./review-workflow.js";
import { authorizeWorkSessionAction } from "./work-session-action-guard.js";
import type { PrincipalRole } from "./policy-enforcement.js";
import type { MissionLedger } from "./mission-ledger.js";

const WORKSPACE_APP_URI = "ui://kontrol/workspace-app.html";

function workspaceAppModelAndAppMeta() {
  return {
    ui: {
      resourceUri: WORKSPACE_APP_URI,
      visibility: ["model", "app"] as const,
    },
  };
}

export interface BridgeConfig {
  workspaces: WorkspaceRegistry;
  workSessions: WorkSessionManager;
  reviewCheckpoints: ReviewCheckpointManager;
  agentRegistry: AgentRegistryManager;
  eventStore: EventStore;
  continuationManager: ContinuationManager;
  /** Authoritative review state machine; both transports must use it. */
  reviewWorkflow: ReviewWorkflowService;
  missionLedger?: MissionLedger;
  knownAgents: Array<{ name: string; url: string; description?: string }>;
  sharedSecret?: string;
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
  return null;
}

function requireWorkSessionRead(config: BridgeConfig, sessionId: string) {
  if (isReviewer(config.principalRole)) return null;
  if (config.principalRole === "worker" && config.connectionWorkSessionId === sessionId) return null;
  return forbidden(config.principalRole, "work-session read");
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

  try {
    for (const cont of config.continuationManager.listPending()) {
      // A live agent is already parked on await_review_feedback for this session:
      // the feedback event will wake it directly. Do NOT spawn a second worker.
      if (liveWaiters.has(cont.sessionId)) continue;

      const session = config.workSessions.get(cont.sessionId);
      if (!session) continue;
      if (TERMINAL_STATUSES.has(session.status)) {
        supersedeContinuation(cont.id, cont.sessionId, `session is ${session.status}`);
        continue;
      }

      // Atomic claim (CAS): only one dispatcher owns a given continuation.
      const claimed = config.continuationManager.claim(dispatcherId, { id: cont.id });
      if (!claimed) continue;
      const claimedSession = config.workSessions.get(claimed.sessionId);
      if (!claimedSession || TERMINAL_STATUSES.has(claimedSession.status)) {
        const reason = claimedSession ? `session is ${claimedSession.status}` : "session not found";
        supersedeContinuation(claimed.id, claimed.sessionId, reason);
        continue;
      }

      if (claimed.verdict !== "changes_requested") {
        // Defensive: pending continuations should only be changes_requested.
        config.continuationManager.markCompleted(claimed.id);
        continue;
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
        continue;
      }
      const missionPacket = config.missionLedger?.getPacket(claimed.sessionId);
      const preferredAgent = missionPacket?.workOrders[0]?.preferredAgent;
      const agentName = preferredAgent || existingRun.agentName;
      const selection = await selectHealthyAgent(config.agentRegistry.listAlive(), {
        name: agentName,
        role: "agent",
        sharedSecret: config.sharedSecret,
      });
      if (!selection.agent) {
        // No healthy agent — release the claim so a later wakeup retries it
        // (the lease prevents it from being re-claimed too eagerly after a blip).
        config.continuationManager.release(dispatcherId, { id: claimed.id });
        continue;
      }

      try {
        const preDispatchSession = config.workSessions.get(claimed.sessionId);
        if (!preDispatchSession || TERMINAL_STATUSES.has(preDispatchSession.status)) {
          const reason = preDispatchSession ? `session is ${preDispatchSession.status}` : "session not found";
          supersedeContinuation(claimed.id, claimed.sessionId, reason);
          continue;
        }
        if (config.beforeContinuationDispatch) {
          await config.beforeContinuationDispatch(claimed, claimed.sessionId);
          const afterHookSession = config.workSessions.get(claimed.sessionId);
          if (!afterHookSession || TERMINAL_STATUSES.has(afterHookSession.status)) {
            const reason = afterHookSession ? `session is ${afterHookSession.status}` : "session not found";
            supersedeContinuation(claimed.id, claimed.sessionId, reason);
            continue;
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
          continue;
        }

        // Publish after the continuation is delivered so subscribers react without
        // a poll, and ordering is: feedback -> continuation -> delivered event.
        config.eventStore.appendEvent({
          type: "continuation.delivered",
          sessionId: claimed.sessionId,
          payload: { continuationId: claimed.id, runId: result.runId, remoteRunId: result.remoteRunId, attemptNumber: result.attemptNumber },
        });
      } catch {
        // Dispatch failed — release so a later wakeup retries it.
        config.continuationManager.release(dispatcherId, { id: claimed.id });
      }
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
  const missionPrompt = renderMissionPrompt(config, continuation.sessionId, continuation.promptText);
  const task = [
    continuation.promptText,
    missionPrompt,
    "[Kontrol work session " + continuation.sessionId +
      "] Continue from review feedback. When done, call submit_for_review with sessionId=\"" +
      continuation.sessionId + "\", then await_review_feedback(sessionId=\"" +
      continuation.sessionId + "\").",
  ].filter(Boolean).join("\n\n");
  return callRemoteAgent(
    { agentRegistry: config.agentRegistry, workspaces: config.workspaces, workSessions: config.workSessions, sharedSecret: config.sharedSecret },
    {
      agentUrl: await resolveHealthyAgentUrl(config, agentName),
      agentName,
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
    sharedSecret: config.sharedSecret,
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
      outputSchema: { submissionId: z.string(), status: z.string(), files: z.number(), additions: z.number(), removals: z.number(), diffSha256: z.string().optional(), reviewEpoch: z.number() },
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
          additions: review.summary.additions,
          removals: review.summary.removals,
          snapshotCommit: review.snapshotCommit,
        });

        // Persisted successfully — now advance the checkpoint to the exact captured
        // snapshot (do not recompute: the tree may have changed since capture).
        await config.reviewCheckpoints.commitReviewed({
          workspaceId: session.workspaceSessionId,
          root: ws.root,
          workSessionId: session.id,
          snapshotCommit: review.snapshotCommit,
        });

        const completedContinuationId =
          continuationId ??
          config.connectionContinuationId;
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

        const submission = {
          id: submitted.submissionId,
          submissionNumber: submitted.submissionNumber,
        };
        const correlatedRun = config.agentRegistry.getRunByWorkSessionId(sessionId);

        // review-workflow.submitForReview already emitted the canonical
        // review.submitted event with file stats. Do not emit a duplicate.

        return {
          content: [{ type: "text" as const, text: `Submitted #${submission.submissionNumber}: ${review.summary.files} file(s), +${review.summary.additions} -${review.summary.removals}. Status: awaiting_review.` }],
          structuredContent: { submissionId: submission.id, status: "awaiting_review", files: review.summary.files, additions: review.summary.additions, removals: review.summary.removals, diffSha256: submitted.diffSha256, reviewEpoch: submitted.reviewEpoch },
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
      outputSchema: { submissionId: z.string(), status: z.string(), files: z.number(), additions: z.number(), removals: z.number(), submissionNumber: z.number(), diffSha256: z.string().optional(), reviewEpoch: z.number() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, submissionId }) => {
      const access = requireWorkSessionRead(config, sessionId);
      if (access) return access;
      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };

      const submissions = config.workSessions.getSubmissions(sessionId);
      if (!submissions.length) return { content: [{ type: "text" as const, text: "No submissions for this session." }], isError: true };

      const submission = submissionId
        ? submissions.find((s) => s.id === submissionId)
        : submissions[submissions.length - 1];
      if (!submission) {
        return {
          content: [{ type: "text" as const, text: `Submission ${submissionId} was not found for session ${sessionId}.` }],
          structuredContent: {
            submissionId: submissionId ?? "",
            status: "not_found",
            files: 0,
            additions: 0,
            removals: 0,
            submissionNumber: 0,
          },
          isError: true,
        };
      }

      const summary = submission.summaryJson ? (JSON.parse(submission.summaryJson) as Record<string, unknown>) : {};
      const patch = submission.diff ?? "";
      const files = parsePatchFiles(patch);

      return {
        content: [{ type: "text" as const, text: `Submission #${submission.submissionNumber}: ${files.length} file(s).` }],
        structuredContent: {
          submissionId: submission.id,
          status: submission.status,
          files: files.length,
          additions: Number(summary.additions ?? 0),
          removals: Number(summary.removals ?? 0),
          diffSha256: submission.diffSha256,
          reviewEpoch: submission.reviewEpoch,
        },
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
  });
  const findingSchema = z.object({
    id: z.string().optional(),
    introducedInSubmissionId: z.string().optional(),
    scope: z.enum(["in_scope", "regression", "out_of_scope"]).optional().describe("in_scope/regression findings extend the correction loop; out_of_scope findings are advisory and never block approval."),
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
  });

  async function dispatchAgentTask(input: {
    task: string;
    workspaceSessionId: string;
    workSessionId?: string;
    agentName?: string;
    completionPolicy?: "agent_completion" | "webui_approval_required";
    appendSessionInstructions?: boolean;
  }) {
    const selectedAgentName = input.agentName ?? "cli-coding-agent";
    const selection = await selectHealthyAgent(config.agentRegistry.listAlive(), {
      name: selectedAgentName,
      role: "agent",
      sharedSecret: config.sharedSecret,
    });
    if (!selection.agent) {
      throw new Error(`No healthy ACP agent named ${selectedAgentName} (role=agent) is registered.`);
    }
    let wsId = input.workSessionId;
    if (!wsId) {
      const created = config.workSessions.create({
        workspaceSessionId: input.workspaceSessionId,
        submittedBy: "webui",
        title: input.task.slice(0, 80),
        completionPolicy: input.completionPolicy ?? "webui_approval_required",
      });
      wsId = created.id;
    }
    const task = input.appendSessionInstructions === false
      ? input.task
      : `${input.task}\n\n[Kontrol work session ${wsId}] Use this existing session: call submit_for_review with sessionId="${wsId}" when done, then await_review_feedback(sessionId="${wsId}"). Do NOT call start_work_session.`;
    const result = await callRemoteAgent(
      {
        agentRegistry: config.agentRegistry,
        workspaces: config.workspaces,
        workSessions: config.workSessions,
        sharedSecret: config.sharedSecret,
      },
      {
        agentUrl: selection.agent.url,
        agentName: selectedAgentName,
        task,
        workspaceSessionId: input.workspaceSessionId,
        workSessionId: wsId,
        mode: "async",
        fireAndForget: true,
      },
    );
    return { result, workSessionId: wsId, agentName: selectedAgentName };
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

  async function supervisorPacket(workSessionId: string) {
    const session = config.workSessions.get(workSessionId);
    const submissions = config.workSessions.getSubmissions(workSessionId);
    const latestSubmission = submissions[submissions.length - 1];
    const toolActivity = config.workSessions.getToolEvents(workSessionId, 100);
    let cumulativeDiff: unknown = undefined;
    try {
      if (session) {
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
      mission: config.missionLedger?.getPacket(workSessionId),
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
        workOrder: workOrderSchema.optional(),
        agentName: z.string().optional(),
      },
      outputSchema: { workSessionId: z.string(), runId: z.string(), status: z.string(), packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    async ({ workspaceSessionId, objective, desiredOutcome, constraints, nonGoals, acceptanceCriteria, supervisorInstructions, maxCorrectionRounds, workOrder, agentName }) => {
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
      const mission = config.missionLedger.createMission({
        workSessionId: created.id,
        workspaceSessionId,
        objective,
        desiredOutcome,
        constraints,
        nonGoals,
        acceptanceCriteria,
        supervisorInstructions,
        maxCorrectionRounds,
        baselineCommit,
      });
      config.missionLedger.createWorkOrder(mission.id, created.id, workOrder ?? { objectiveForThisTurn: objective });
      const prompt = renderMissionPrompt(config, created.id, objective);
      const dispatch = await dispatchAgentTask({
        task: prompt,
        workspaceSessionId,
        workSessionId: created.id,
        agentName,
        appendSessionInstructions: true,
      });
      return {
        content: [{ type: "text" as const, text: `Supervised work started in ${created.id}; worker status=${dispatch.result.status}.` }],
        structuredContent: {
          workSessionId: created.id,
          runId: dispatch.result.runId,
          status: dispatch.result.status,
          packet: await supervisorPacket(created.id),
        },
      };
    },
  );

  registerAppTool(
    server,
    "inspect_supervised_work",
    {
      title: "Inspect supervised work",
      description: "Return the model-visible mission review packet, including criteria, findings, work orders, evidence, cumulative diff summary, and current approval predicate.",
      inputSchema: { workSessionId: z.string() },
      outputSchema: { packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: true },
    },
    async ({ workSessionId }) => {
      if (!config.workSessions.get(workSessionId)) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      const packet = await supervisorPacket(workSessionId);
      return { content: [{ type: "text" as const, text: "Supervisor review packet ready." }], structuredContent: { packet } };
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
          source: z.enum(["server_test_runner", "runtime_probe", "reviewer_code_inspection", "reviewer_manual_attestation", "agent_claim"]).optional(),
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
        config.missionLedger.recordEvidence(mission.id, evidence.map((entry) => ({
          ...entry,
          submissionId: entry.submissionId ?? latest.id,
          snapshotCommit: entry.snapshotCommit ?? latest.snapshotCommit,
        })));
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
          source: z.enum(["server_test_runner", "runtime_probe", "reviewer_code_inspection", "reviewer_manual_attestation", "agent_claim"]).optional(),
          details: z.unknown().optional(),
        })).optional(),
        comments: z.string().optional(),
      },
      outputSchema: { status: z.string(), approved: z.boolean(), reasons: z.array(z.string()), packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    async ({ workSessionId, criterionUpdates, findingUpdates, evidence, comments }) => {
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
        config.missionLedger.recordEvidence(mission.id, evidence.map((entry) => ({
          ...entry,
          submissionId: entry.submissionId ?? latest.id,
          snapshotCommit: entry.snapshotCommit ?? latest.snapshotCommit,
        })));
      }
      const approval = config.missionLedger.canApprove(workSessionId, { submissionId: latest.id, snapshotCommit: latest.snapshotCommit });
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
      });
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
        sharedSecret: config.sharedSecret,
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
      if (!wsId) {
        const created = config.workSessions.create({
          workspaceSessionId,
          submittedBy: "webui",
          title: task.slice(0, 80),
          completionPolicy: completionPolicy ?? "webui_approval_required",
        });
        wsId = created.id;
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

      if (missionContract && !config.missionLedger) {
        return { content: [{ type: "text" as const, text: "Mission contract supplied, but mission ledger is unavailable." }], isError: true };
      }

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
            baselineCommit,
          });
          config.missionLedger.createWorkOrder(mission.id, wsId, missionContract.workOrder ?? { objectiveForThisTurn: task });
          dispatchTask = renderMissionPrompt(config, wsId, task);
        }
        const result = await callRemoteAgent(
          {
            agentRegistry: config.agentRegistry,
            workspaces: config.workspaces,
            workSessions: config.workSessions,
            sharedSecret: config.sharedSecret,
          },
          {
            agentUrl: peer.url,
            agentName: selectedAgentName,
            task: wsId
              ? `${dispatchTask}\n\n[Kontrol work session ${wsId}] Use this existing session: call submit_for_review with sessionId="${wsId}" when done, then await_review_feedback(sessionId="${wsId}"). Do NOT call start_work_session.`
              : dispatchTask,
            workspaceSessionId: workspaceSessionId,
            workSessionId: wsId,
            mode: "async",
            fireAndForget: true,
          },
        );
        if (result.status === "failed") {
          return {
            content: [{ type: "text" as const, text: result.error ?? "ACP call failed with no error detail." }],
            structuredContent: { runId: result.runId, remoteRunId: result.remoteRunId, workSessionId: wsId, workspaceSessionId, status: result.status, output: result.output, error: result.error },
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: result.output || "(no output)" }],
          structuredContent: { runId: result.runId, remoteRunId: result.remoteRunId, workSessionId: wsId, workspaceSessionId, status: result.status, output: result.output },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
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
      const feedbackCount = submissions.filter((s) => s.feedback).length;
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
      const events = await config.eventStore.waitForEventsAfter(sessionId, afterSeq, timeoutMs);
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
      const event = await config.eventStore.waitForMatchingEventAfter(
        sessionId,
        afterSeq,
        (candidate) =>
          TERMINAL_RUN_EVENTS.has(candidate.type) &&
          !(session.completionPolicy === "webui_approval_required" && candidate.type === "agent.run.completed"),
        timeoutMs,
      );
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
      try {
        matched = await config.eventStore.waitForMatchingEventAfter(
          sessionId,
          afterSeq,
          predicate,
          timeoutMs ?? 300_000,
        );
      } catch (error) {
        cleanup();
        throw error;
      }

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
      const feedbackCount = submissions.filter((s) => s.feedback).length;
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
      const sessions = config.workSessions.listPendingReviews(workspaceId);
      const text = sessions.length === 0
        ? "No sessions awaiting review."
        : `${sessions.length} session(s) awaiting review:\n${sessions.map((s) => {
            const subs = config.workSessions.getSubmissions(s.id);
            return `  ${s.id} [${s.status}] ${s.title ?? "untitled"} — ${subs.length} submission(s), updated ${s.updatedAt}`;
          }).join("\n")}`;

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          sessions: sessions.map((s) => ({
            sessionId: s.id,
            status: s.status,
            title: s.title,
            submittedBy: s.submittedBy,
            submissionCount: config.workSessions.getSubmissions(s.id).length,
            updatedAt: s.updatedAt,
          })),
        },
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

      config.reviewWorkflow.cancelSession({ sessionId });
      const run = config.agentRegistry.getRunByWorkSessionId(sessionId);
      const remoteCancellation = run
        ? await cancelRemoteRun(config, run)
        : { acknowledged: false, error: "No correlated ACP run" };
      return {
        content: [{ type: "text" as const, text: `Session ${sessionId} cancelled.${remoteCancellation.acknowledged ? " Remote worker cancellation acknowledged." : ""}` }],
        structuredContent: { status: "cancelled", sessionId, remoteCancellation },
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
        sharedSecret: config.sharedSecret,
      });
      if (!selection.agent) return { content: [{ type: "text" as const, text: `No healthy registered ACP agent named "${agentName}".` }], isError: true };
      const wsId = workSessionId ?? config.workSessions.create({
        workspaceSessionId,
        submittedBy: "webui",
        title: task.slice(0, 80),
        completionPolicy: "webui_approval_required",
      }).id;

      try {
        const result = await callRemoteAgent(
          { agentRegistry: config.agentRegistry, workspaces: config.workspaces, workSessions: config.workSessions, sharedSecret: config.sharedSecret },
          {
            agentUrl: selection.agent.url,
            agentName,
            task: `${task}\n\n[Kontrol work session ${wsId}] Use this existing session: call submit_for_review with sessionId="${wsId}" when done, then await_review_feedback(sessionId="${wsId}"). Do NOT call start_work_session.`,
            workspaceSessionId,
            workSessionId: wsId,
            mode: "async",
            fireAndForget: true,
          },
        );

        if (result.status === "failed") {
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
          return { a, probe: await probeAgent(a.url, config.sharedSecret) };
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
        const resolvedWorkSessionId = resolved.workSessionId ?? config.workSessions.create({
          workspaceSessionId: resolvedWorkspaceSessionId,
          submittedBy: "webui",
          title: task.slice(0, 80),
          completionPolicy: "webui_approval_required",
        }).id;
        try {
          const result = await callRemoteAgent(
            { agentRegistry: config.agentRegistry, workspaces: config.workspaces, workSessions: config.workSessions, sharedSecret: config.sharedSecret },
            {
              agentUrl: agent.url,
              agentName: agent.name,
              task: `${task}\n\n[Kontrol work session ${resolvedWorkSessionId}] Use this existing session: call submit_for_review with sessionId="${resolvedWorkSessionId}" when done, then await_review_feedback(sessionId="${resolvedWorkSessionId}"). Do NOT call start_work_session.`,
              workspaceSessionId: resolvedWorkspaceSessionId,
              workSessionId: resolvedWorkSessionId,
              mode: "async",
              fireAndForget: true,
            },
          );
          return { content: [{ type: "text" as const, text: `${agent.name}: ${result.status}\n${result.output.slice(0, 5000)}` }], structuredContent: { runId: result.runId, workSessionId: resolvedWorkSessionId, workspaceSessionId: resolvedWorkspaceSessionId, status: result.status, output: result.output } };
        } catch (error) {
          return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
      },
    );
  }

  // NOTE: the continuation dispatcher is started explicitly by the server
  // (via startContinuationDispatcher) so it can be omitted in tests.
}
