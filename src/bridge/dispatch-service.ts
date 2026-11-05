/**
 * Durable dispatch service — single authority for ChatGPT-to-ACP dispatch.
 *
 * Both `submit_to_coding_agent` (delegation-tools) and `call_acp_agent`
 * (agent-tools) funnel through here. There is exactly one place that:
 *  - selects a healthy registered ACP agent (explicit name honored exactly,
 *    so `muse-code` / `musefi` dispatch as first-class dispatchable agents
 *    on the generic stdio duplex adapter — no allowlist, no second transport)
 *  - creates / validates the work session and acquires the canonical
 *    checkout lease (realpath root), with takeover only on explicit reuse
 *  - persists the dispatch with its idempotency identity via
 *    `callRemoteAgent`
 *  - preserves uncertain acceptance: a transport error after the launch
 *    may have reached the adapter is surfaced as `uncertain`, never as a
 *    failed-and-released lease, so reconciliation can re-lookup the same
 *    idempotency key
 *  - rolls back the lease/session ONLY on a definitive pre-acceptance
 *    failure; an accepted or uncertain launch keeps lease + correlation
 *
 * The service never touches the installed systemd units, tunnel
 * configuration, or any storage system other than the existing
 * work-session / registry / event stores.
 */
import { callRemoteAgent, selectHealthyAgent } from "../acp-gateway.js";
import type { BridgeConfig } from "./context.js";
import type { MissionCriterionInput, WorkOrderInput } from "../mission-ledger.js";
import type { ApprovalMode, AutonomyMode, SupervisorStatus } from "../supervisor-runs.js";
import {
  acquireCheckoutModifyLease,
  captureMissionBaseline,
  checkoutLeaseMetadata,
  liveOwnerContextId,
  livePrincipalId,
  requireWorkSessionRead,
  renderMissionPrompt,
  workSessionInstructions,
} from "./shared.js";

export interface DurableDispatchInput {
  task: string;
  workspaceSessionId: string;
  workspaceId?: string;
  workSessionId?: string;
  agentName?: string;
  dispatchIntent?: "optional_assist" | "required_delegate";
  completionPolicy?: "agent_completion" | "webui_approval_required";
  submittedBy?: string;
  /**
   * When true, an existing session is reused without the strict
   * fresh/changes_requested + webui_approval_required gate (legacy
   * call_acp_agent semantics). Workspace-mismatch and unknown-session
   * checks still apply. Default false (fail closed).
   */
  allowNonReviewSessionReuse?: boolean;
  mission?: {
    objective: string;
    desiredOutcome?: string;
    constraints?: unknown[];
    nonGoals?: string[];
    acceptanceCriteria?: MissionCriterionInput[];
    supervisorInstructions?: string;
    maxCorrectionRounds?: number;
    finalVerification?: string[];
    reviewCoverage?: string[];
    completionClaim?: "implementation" | "real_world_outcome";
    outcomeEvidence?: "implementation_verified" | "integration_verified" | "outcome_verified" | "operationally_stable";
    outcomeExpectedBehavior?: string;
    autonomyMode?: AutonomyMode;
    approvalMode?: ApprovalMode;
    maxWallTimeMinutes?: number;
    workOrder?: WorkOrderInput;
  } | undefined;
}

export interface DurableDispatchResult {
  status: "accepted" | "uncertain" | "failed" | "unavailable";
  runId?: string;
  remoteRunId?: string;
  workSessionId?: string;
  workspaceSessionId: string;
  agentName?: string;
  agentId?: string;
  output?: string;
  error?: string;
  retryable?: boolean;
  fallback?: string;
  reason?: string;
  isError?: boolean;
  text?: string;
}

type SupervisorRunLike = {
  id: string;
  status: SupervisorStatus;
  revision: number;
};

/**
 * Single durable dispatch entry point. `createSessionOnReuse` is always
 * false: an existing session must be validated and reused, never silently
 * recreated.
 */
export async function dispatchToRegisteredAgent(
  config: BridgeConfig,
  input: DurableDispatchInput,
): Promise<DurableDispatchResult> {
  const { task, workspaceSessionId: rawWorkspace, agentName } = input;
  const workspaceSessionId = rawWorkspace;

  // --- Selection (explicit name honored exactly; no silent reroute) ---
  const selection = await selectHealthyAgent(config.agentRegistry.listAlive(), {
    name: agentName,
    role: "agent",
    adapterSecret: config.adapterSecret,
    clientPlatformHint: config.connectionContext?.clientPlatformHint,
  });
  if (!selection.agent) {
    const dead = selection.deadUrls.length
      ? ` Dead/ unhealthy endpoints found: ${selection.deadUrls.join("; ")}.`
      : "";
    const requested = agentName ? ` named ${agentName}` : "";
    const reason = `No healthy dispatchable ACP agent${requested} (role=agent) is registered.${dead}`;
    if (input.dispatchIntent === "optional_assist") {
      return {
        status: "unavailable",
        workspaceSessionId,
        retryable: false,
        fallback: "direct_workspace",
        reason,
        text: `${reason} Continue in the direct workspace; no alternate ACP route was attempted.`,
      };
    }
    return { status: "unavailable", workspaceSessionId, reason, isError: true, text: reason };
  }
  const peer = selection.agent;
  const selectedAgentName = peer.name;

  // --- Mission validation (before any durable resource is stranded) ---
  if (input.mission) {
    const criteria = (input.mission.acceptanceCriteria as Array<{ priority?: string }> | undefined) ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requiredCount = criteria.filter((c) => (c.priority ?? "required") === "required").length;
    if (requiredCount === 0) {
      const text = "Mission contract requires at least one required acceptance criterion.";
      return { status: "failed", workspaceSessionId, error: text, isError: true, text };
    }
    if (!config.missionLedger) {
      const text = "Mission contract supplied, but mission ledger is unavailable.";
      return { status: "failed", workspaceSessionId, error: text, isError: true, text };
    }
  }

  let missionBaseline: Awaited<ReturnType<typeof captureMissionBaseline>> | undefined;
  if (input.mission && config.missionLedger) {
    try {
      missionBaseline = await captureMissionBaseline(config, workspaceSessionId);
    } catch (error) {
      const text = `Cannot dispatch a supervised mission without a durable workspace baseline: ${error instanceof Error ? error.message : String(error)}`;
      return { status: "failed", workspaceSessionId, error: text, isError: true, text };
    }
  }

  // --- Work-session ownership (Kontrol owns creation) ---
  let wsId = input.workSessionId;
  let createdSessionForDispatch = false;
  if (!wsId) {
    const created = config.workSessions.create({
      workspaceSessionId,
      submittedBy: input.submittedBy ?? "webui",
      title: task.slice(0, 80),
      completionPolicy: input.mission ? "webui_approval_required" : input.completionPolicy ?? "webui_approval_required",
      ownerContextId: liveOwnerContextId(config) ?? config.principalId,
      principalId: livePrincipalId(config),
    });
    wsId = created.id;
    createdSessionForDispatch = true;
  } else {
    const existing = config.workSessions.get(wsId);
    if (!existing) {
      const text = `Unknown work session: ${wsId}.`;
      return { status: "failed", workspaceSessionId, error: text, isError: true, text };
    }
    const access = requireWorkSessionRead(config, existing.id);
    if (access) {
      // Surface the read gate as a failed dispatch without touching leases.
      const text = (access.content?.[0]?.text as string) ?? `Forbidden: work-session read for ${wsId}.`;
      return { status: "failed", workspaceSessionId, workSessionId: wsId, error: text, isError: true, text };
    }
    if (existing.workspaceSessionId !== workspaceSessionId) {
      const text = `Work session ${wsId} belongs to a different workspace (${existing.workspaceSessionId}), not ${workspaceSessionId}.`;
      return { status: "failed", workspaceSessionId, workSessionId: wsId, error: text, isError: true, text };
    }
    const latestRun = config.agentRegistry.getRunByWorkSessionId(wsId);
    const freshUndispatchedSession =
      existing.status === "in_progress" && !existing.latestSubmission && !latestRun;
    if (!input.allowNonReviewSessionReuse) {
      if (!freshUndispatchedSession && !["changes_requested", "resuming"].includes(existing.status)) {
        const text = `Work session ${wsId} is ${existing.status}; dispatch requires a fresh undispatched session or an explicit changes_requested/resuming handoff.`;
        return { status: "failed", workspaceSessionId, workSessionId: wsId, error: text, isError: true, text };
      }
      if (existing.completionPolicy !== "webui_approval_required") {
        const text = `Work session ${wsId} does not use webui_approval_required; WebUI dispatch requires review.`;
        return { status: "failed", workspaceSessionId, workSessionId: wsId, error: text, isError: true, text };
      }
    } else if (["approved", "rejected", "cancelled", "failed", "failed_protocol"].includes(existing.status)) {
      // Even legacy reuse never resurrects a terminal session.
      const text = `Work session ${wsId} is ${existing.status}; dispatch requires a non-terminal session.`;
      return { status: "failed", workspaceSessionId, workSessionId: wsId, error: text, isError: true, text };
    }
  }

  // --- Canonical checkout lease (takeover only on explicit reuse) ---
  const previousLease = !createdSessionForDispatch ? config.workSessions.getWorkspaceLeaseForSession(wsId) : undefined;
  const activePreviousLease =
    previousLease && Date.parse(previousLease.expiresAt) > Date.now() ? previousLease : undefined;
  const leaseError = await acquireCheckoutModifyLease(config, workspaceSessionId, wsId, {
    takeover: !createdSessionForDispatch,
  });
  if (leaseError) {
    if (createdSessionForDispatch) config.workSessions.updateStatus(wsId, "cancelled");
    const text = (leaseError.content?.[0]?.text as string) ?? "Workspace lease conflict.";
    return { status: "failed", workspaceSessionId, workSessionId: wsId, error: text, isError: true, text };
  }
  const dispatchLease = config.workSessions.getWorkspaceLeaseForSession(wsId);
  const runBeforeDispatch = config.agentRegistry.getRunByWorkSessionId(wsId);
  const priorAttemptKey = runBeforeDispatch
    ? config.agentRegistry.getLatestDispatchAttemptForRun(runBeforeDispatch.runId)?.dispatchIdempotencyKey
    : undefined;

  let supervisorRun: SupervisorRunLike | undefined;
  const rollbackDispatch = (reason: string, runId?: string) => {
    if (createdSessionForDispatch) {
      config.workSessions.updateStatus(wsId, "failed");
    } else if (activePreviousLease && dispatchLease) {
      config.workSessions.restoreWorkspaceLeaseForSession(activePreviousLease, dispatchLease.leaseNonce);
    } else {
      config.workSessions.releaseWorkspaceLeasesForSession(wsId);
    }
    if (supervisorRun && config.supervisorRuns) {
      try {
        config.supervisorRuns.transition({
          id: supervisorRun.id,
          expectedStatus: supervisorRun.status,
          expectedRevision: supervisorRun.revision,
          nextStatus: "failed",
          lastError: reason,
        });
      } catch {
        /* supervisor bookkeeping is best-effort on rollback */
      }
    }
    config.eventStore.appendEvent({
      type: createdSessionForDispatch ? "agent.run.failed" : "agent.dispatch.failed",
      sessionId: wsId,
      payload: { runId, reason, newSession: createdSessionForDispatch },
    });
  };

  try {
    let dispatchTask = task;
    if (input.mission && config.missionLedger) {
      const mission = config.missionLedger.createMission({
        workSessionId: wsId,
        workspaceSessionId,
        objective: input.mission.objective,
        desiredOutcome: input.mission.desiredOutcome,
        constraints: input.mission.constraints,
        nonGoals: input.mission.nonGoals,
        acceptanceCriteria: input.mission.acceptanceCriteria,
        supervisorInstructions: input.mission.supervisorInstructions,
        maxCorrectionRounds: input.mission.maxCorrectionRounds,
        finalVerification: input.mission.finalVerification,
        reviewCoverage: input.mission.reviewCoverage,
        completionClaim: input.mission.completionClaim,
        outcomeEvidence: input.mission.outcomeEvidence,
        outcomeExpectedBehavior: input.mission.outcomeExpectedBehavior,
        ...missionBaseline!,
      });
      supervisorRun = config.supervisorRuns?.create({
        missionId: mission.id,
        workSessionId: wsId,
        workspaceSessionId,
        autonomyMode: input.mission.autonomyMode,
        approvalMode: input.mission.approvalMode,
        maxWallTimeMs: input.mission.maxWallTimeMinutes ? input.mission.maxWallTimeMinutes * 60_000 : undefined,
      });
      config.missionLedger.createWorkOrder(mission.id, wsId, input.mission.workOrder ?? { objectiveForThisTurn: task });
      dispatchTask = renderMissionPrompt(config, wsId, task);
    }

    const result = await callRemoteAgent(
      {
        agentRegistry: config.agentRegistry,
        workspaces: config.workspaces,
        workSessions: config.workSessions,
        eventStore: config.eventStore,
        adapterSecret: config.adapterSecret,
      },
      {
        agentUrl: peer.url,
        agentName: selectedAgentName,
        agentId: peer.id,
        task: `${dispatchTask}\n\n${workSessionInstructions(wsId, peer)}`,
        workspaceSessionId,
        workSessionId: wsId,
        ...checkoutLeaseMetadata(config, wsId),
        mode: "async",
        fireAndForget: true,
      },
    );

    if (result.status === "uncertain") {
      if (supervisorRun && config.supervisorRuns) {
        try {
          config.supervisorRuns.transition({
            id: supervisorRun.id,
            expectedStatus: "created",
            expectedRevision: supervisorRun.revision,
            nextStatus: "worker_active",
            lastError: result.error ?? "ACP dispatch acceptance is uncertain; reconciliation is pending.",
          });
        } catch {
          /* reconciliation owns the durable state */
        }
      }
      config.eventStore.appendEvent({
        type: "agent.dispatch.uncertain",
        sessionId: wsId,
        payload: { runId: result.runId, reason: result.error ?? "ACP dispatch acceptance is uncertain." },
      });
      return {
        status: "uncertain",
        runId: result.runId,
        remoteRunId: result.remoteRunId,
        workSessionId: wsId,
        workspaceSessionId,
        agentName: selectedAgentName,
        agentId: peer.id,
        output: result.output,
        error: result.error,
        retryable: false,
        text: `${selectedAgentName}: dispatch acceptance is uncertain. Run ${result.runId} remains attached to this work session while Kontrol reconciles the original launch.`,
      };
    }
    if (result.status === "failed") {
      rollbackDispatch(result.error ?? "ACP dispatch failed", result.runId);
      const text = result.error ?? "ACP call failed with no error detail.";
      return {
        status: "failed",
        runId: result.runId,
        remoteRunId: result.remoteRunId,
        workSessionId: wsId,
        workspaceSessionId,
        agentName: selectedAgentName,
        agentId: peer.id,
        output: result.output,
        error: result.error,
        isError: true,
        text,
      };
    }
    if (supervisorRun && config.supervisorRuns) {
      try {
        config.supervisorRuns.transition({
          id: supervisorRun.id,
          expectedStatus: "created",
          expectedRevision: supervisorRun.revision,
          nextStatus: "worker_active",
        });
      } catch {
        /* worker is already accepted; do not fail the dispatch */
      }
    }
    return {
      status: "accepted",
      runId: result.runId,
      remoteRunId: result.remoteRunId,
      workSessionId: wsId,
      workspaceSessionId,
      agentName: selectedAgentName,
      agentId: peer.id,
      output: result.output || "(no output)",
      text: result.output || "(no output)",
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const correlatedRun = config.agentRegistry.getRunByWorkSessionId(wsId);
    const latestAttempt = correlatedRun
      ? config.agentRegistry.getLatestDispatchAttemptForRun(correlatedRun.runId)
      : undefined;
    const newAttemptMayHaveReachedPeer = Boolean(
      latestAttempt &&
        latestAttempt.dispatchIdempotencyKey !== priorAttemptKey &&
        ["dispatching", "uncertain", "accepted"].includes(latestAttempt.status),
    );
    if (newAttemptMayHaveReachedPeer || correlatedRun?.status === "dispatch_uncertain") {
      const status =
        latestAttempt?.status === "accepted" ? correlatedRun?.status ?? "running" : "uncertain";
      try {
        if (supervisorRun && config.supervisorRuns) {
          config.supervisorRuns.transition({
            id: supervisorRun.id,
            expectedStatus: "created",
            expectedRevision: supervisorRun.revision,
            nextStatus: "worker_active",
            lastError: errorMessage,
          });
        }
      } catch {
        /* dispatch uncertainty stays durable even if supervisor bookkeeping needs reconciliation */
      }
      try {
        config.eventStore.appendEvent({
          type: "agent.dispatch.uncertain",
          sessionId: wsId,
          payload: { runId: correlatedRun?.runId, reason: errorMessage },
        });
      } catch {
        /* the indexed dispatch attempt remains the recovery source */
      }
      return {
        status: status as "accepted" | "uncertain",
        runId: correlatedRun?.runId,
        remoteRunId: correlatedRun?.remoteRunId,
        workSessionId: wsId,
        workspaceSessionId,
        output: "",
        error: errorMessage,
        retryable: false,
        text: `Submission follow-up failed after the dispatch may have reached the adapter: ${errorMessage}`,
      };
    }
    rollbackDispatch(errorMessage);
    return {
      status: "failed",
      workSessionId: wsId,
      workspaceSessionId,
      output: "",
      error: errorMessage,
      isError: true,
      text: `Submission to coding agent failed: ${errorMessage}`,
    };
  }
}
