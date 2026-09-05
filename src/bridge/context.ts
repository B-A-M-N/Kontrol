/**
 * Shared typed dependency context and cross-capability helpers
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
export type { LiveWaiterRegistry } from "./shared.js";
import { callRemoteAgent, selectHealthyAgent } from "../acp-gateway.js";
import type { AgentRegistryManager } from "../acp-registry.js";
import type { AgentMessageManager } from "../agent-messages.js";
import type { ServerConfig } from "../config.js";
import type { Continuation, ContinuationManager } from "../continuation.js";
import type { DatabaseHandle } from "../db/client.js";
import type { DispatchOutbox } from "../dispatch-outbox.js";
import type { EventStore } from "../event-log.js";
import type { MissionLedger } from "../mission-ledger.js";
import type { MutationReceiptStore } from "../mutation-receipts.js";
import type { PrincipalRole } from "../policy-enforcement.js";
import type { ReviewCheckpointManager } from "../review-checkpoints.js";
import type { ReviewWorkflowService } from "../review-workflow.js";
import type { SupervisorRuns } from "../supervisor-runs.js";
import type { WorkSessionManager } from "../work-sessions.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { checkoutLeaseNonce, compactMissionPacket, workSessionInstructions } from "./shared.js";
import type { LiveWaiterRegistry } from "./shared.js";
import { createHash } from "node:crypto";
import { z } from "zod/v4";

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
  approvalRequests?: ReturnType<typeof import("../approval-requests.js").createApprovalRequestManager>;
  knownAgents: Array<{ name: string; url: string; description?: string }>;
  /** P0 #9: outbound adapter credential. */
  adapterSecret?: string;
  /** Server config for skill discovery (P1 #10). */
  serverConfig?: ServerConfig;
  /**
   * The role of the caller presenting this MCP connection. The WebUI connects
   * as a WebUI reviewer or ordinary MCP client; the coding agent connects as a worker. Role checks
   * on reviewer-only and worker-only tools are enforced server-side so a worker
   * cannot, e.g., self-approve a review or invoke submit_to_coding_agent.
   */
  principalRole?: PrincipalRole;
  /** Stable authenticated principal used to scope durable UI mutation IDs. */
  principalId?: string;
  mutationReceipts?: MutationReceiptStore;
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


export const missionCriterionSchema = z.object({
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
export const findingSchema = z.object({
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
export const criterionUpdateSchema = z.object({
  id: z.string(),
  status: z.enum(["unverified", "partially_verified", "verified", "failed"]),
});
export const findingUpdateSchema = z.object({
  id: z.string(),
  status: z.enum(["open", "claimed_resolved", "verified_resolved", "waived"]),
  waiverReason: z.string().optional(),
  resolutionSubmissionId: z.string().optional(),
  disposition: z.enum(["blocking", "required_followup", "advisory", "future_improvement"]).optional(),
});
export const workOrderSchema = z.object({
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

export async function dispatchAgentTask(
  config: BridgeConfig,
  input: {
    task: string;
    workspaceSessionId: string;
    workSessionId: string;
    agentName?: string;
    completionPolicy?: "agent_completion" | "webui_approval_required";
    appendSessionInstructions?: boolean;
  },
) {
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

export async function waitForSupervisorCheckpoint(config: BridgeConfig, workSessionId: string, afterSeq: number, expectedReviewEpoch?: number, timeoutMs = 120_000) {
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
    packet: event ? await supervisorPacket(config, workSessionId) : undefined,
  };
}

export async function supervisorPacket(config: BridgeConfig, workSessionId: string, detail: "summary" | "current" | "full" = "summary") {
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
    ? { deferred: detail !== "full", knownSnapshotKind: latestSubmission.snapshotKind, knownSnapshotRef: latestSubmission.snapshotRef, knownSnapshotCommit: latestSubmission.snapshotCommit, knownDiffSha256: latestSubmission.diffSha256 }
    : undefined;
  try {
    if (session && detail === "full") {
      const workspace = config.workspaces.getWorkspace(session.workspaceSessionId);
      const mission = config.missionLedger?.getMissionByWorkSession(workSessionId);
      const cumulative = mission?.baselineRef && typeof config.reviewCheckpoints.reviewChangesAgainstSnapshot === "function"
        ? await config.reviewCheckpoints.reviewChangesAgainstSnapshot({
            workspaceId: session.workspaceSessionId,
            root: workspace.root,
            baseline: { kind: mission.baselineKind ?? "git", ref: mission.baselineRef, createdAt: mission.createdAt },
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
        snapshotKind: cumulative.snapshotKind,
        snapshotRef: cumulative.snapshotRef,
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
          snapshotKind: latestSubmission.snapshotKind,
          snapshotRef: latestSubmission.snapshotRef,
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
