/**
 * Direct coding-agent delegation tool
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig } from "./context.js";
import { callRemoteAgent, selectHealthyAgent } from "../acp-gateway.js";
import { registerMutationAppTool } from "./app-tool.js";
import { supervisedMissionOptionsSchema, workOrderSchema } from "./context.js";
import { acquireCheckoutModifyLease, captureMissionBaseline, checkoutLeaseMetadata, forbidden, isReviewer, liveOwnerContextId, requireWorkSessionRead, renderMissionPrompt, resolveDelegationContext, workSessionInstructions, workspaceAppModelAndAppMeta } from "./shared.js";
import { z } from "zod/v4";

export function registerDelegationTools(server: McpServer, config: BridgeConfig): void {
  registerMutationAppTool(
    server,
    "submit_to_coding_agent",
    {
      title: "Submit task to coding agent",
      description: "Optional reviewer-directed delegation from the WebUI to a currently dispatchable registered ACP harness. If agentName is omitted, Kontrol prefers the native registered harness for the caller platform (ChatGPT/OpenAI prefers Codex), then falls back to any healthy role=agent HTTP ACP adapter. The platform hint affects routing only. The WebUI remains the reviewer.",
      inputSchema: {
        task: z.string().trim().min(1).describe("Bounded instruction or task for the coding agent."),
        dispatchIntent: z.enum(["optional_assist", "required_delegate"]).optional().describe("Optional assistance falls back to direct workspace work when unavailable; required_delegate returns an error instead."),
        workspaceId: z.string().optional().describe("Workspace ID from open_workspace. Preferred public name; aliases workspaceSessionId."),
        workspaceSessionId: z.string().optional().describe("Workspace session ID (legacy/internal alias for workspaceId)."),
        workSessionId: z.string().optional().describe("Optional existing work session ID. If omitted, Kontrol creates one before dispatch so the agent can reuse it for submit_for_review correlation."),
        sessionId: z.string().optional().describe("Legacy alias for workSessionId."),
        agentName: z.string().optional().describe("Optional registered ACP agent name. Omit to prefer the platform-native registered harness, then any healthy role=agent ACP adapter."),
        completionPolicy: z.enum(["agent_completion", "webui_approval_required"]).optional().describe("Completion policy for newly-created work sessions. Defaults to webui_approval_required for reviewed WebUI dispatch."),
        missionContract: supervisedMissionOptionsSchema.extend({
          objective: z.string(),
          workOrder: workOrderSchema.optional(),
        }).optional().describe("Optional durable mission contract. When present, WebUI approval is mission-gated rather than only snapshot-gated."),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: {
        runId: z.string().optional(),
        remoteRunId: z.string().optional(),
        workSessionId: z.string(),
        workspaceSessionId: z.string(),
        status: z.string(),
        output: z.string().optional(),
        error: z.string().optional(),
        retryable: z.boolean().optional(),
        fallback: z.string().optional(),
        reason: z.string().optional(),
      },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ task, dispatchIntent = "optional_assist", workspaceId, workspaceSessionId, workSessionId, sessionId, agentName, completionPolicy, missionContract }) => {
      // ROLE CHECK: submit_to_coding_agent (Nelson Wiggum Loop: WebUI → agent)
      // is reviewer or ordinary client only. A worker (coding agent) must not be able to
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

      if (missionContract) {
        const requiredCount = (missionContract.acceptanceCriteria ?? []).filter((c: { priority?: string }) => (c.priority ?? "required") === "required").length;
        if (requiredCount === 0) {
          return { content: [{ type: "text" as const, text: "Mission contract requires at least one required acceptance criterion." }], isError: true };
        }
        // This prerequisite must be checked before creating a work session or
        // acquiring its checkout lease. A missing ledger is a control-plane
        // configuration failure, not a dispatch failure, and must not strand
        // either durable resource.
        if (!config.missionLedger) {
          return { content: [{ type: "text" as const, text: "Mission contract supplied, but mission ledger is unavailable." }], isError: true };
        }
      }

      // If a name was requested, honor it. Otherwise select any currently
      // dispatchable registered ACP harness; all candidates must pass the
      // same protocol-readiness probe before durable session state is created.
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
        if (dispatchIntent === "optional_assist") {
          return {
            content: [{ type: "text" as const, text: `${reason} Continue in the direct workspace; no alternate ACP route was attempted.` }],
            structuredContent: { status: "unavailable", retryable: false, fallback: "direct_workspace", reason },
          };
        }
        return { content: [{ type: "text" as const, text: reason }], isError: true };
      }
      const peer = selection.agent;
      const selectedAgentName = peer.name;

      let missionBaseline: Awaited<ReturnType<typeof captureMissionBaseline>> | undefined;
      if (missionContract) {
        try {
          missionBaseline = await captureMissionBaseline(config, workspaceSessionId);
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: `Cannot dispatch a supervised mission without a durable workspace baseline: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true,
          };
        }
      }

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
          completionPolicy: missionContract ? "webui_approval_required" : completionPolicy ?? "webui_approval_required",
          ownerContextId: liveOwnerContextId(config) ?? config.principalId,
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
        const access = requireWorkSessionRead(config, existing.id);
        if (access) return access;
        if (existing.workspaceSessionId !== workspaceSessionId) {
          return {
            content: [{ type: "text" as const, text: `Work session ${wsId} belongs to a different workspace (${existing.workspaceSessionId}), not ${workspaceSessionId}.` }],
            isError: true,
          };
        }
        const latestRun = config.agentRegistry.getRunByWorkSessionId(wsId);
        const freshUndispatchedSession = existing.status === "in_progress"
          && !existing.latestSubmission
          && !latestRun;
        if (!freshUndispatchedSession && !["changes_requested", "resuming"].includes(existing.status)) {
          return {
            content: [{ type: "text" as const, text: `Work session ${wsId} is ${existing.status}; dispatch requires a fresh undispatched session or an explicit changes_requested/resuming handoff.` }],
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

      const previousLease = !createdSessionForDispatch ? config.workSessions.getWorkspaceLeaseForSession(wsId) : undefined;
      const activePreviousLease = previousLease && Date.parse(previousLease.expiresAt) > Date.now() ? previousLease : undefined;
      const leaseError = await acquireCheckoutModifyLease(config, workspaceSessionId, wsId, { takeover: !createdSessionForDispatch });
      if (leaseError) {
        if (createdSessionForDispatch) config.workSessions.updateStatus(wsId, "cancelled");
        return leaseError;
      }
      const dispatchLease = config.workSessions.getWorkspaceLeaseForSession(wsId);

      let supervisorRun: ReturnType<NonNullable<typeof config.supervisorRuns>["create"]> | undefined;
      const rollbackDispatch = (reason: string, runId?: string) => {
        // No worker was accepted, so release the checkout fence. A newly
        // created session is failed as a coherent unit; a reused session
        // keeps its review/continuation state and can be retried safely.
        if (createdSessionForDispatch) {
          config.workSessions.updateStatus(wsId!, "failed");
        } else if (activePreviousLease && dispatchLease) {
          config.workSessions.restoreWorkspaceLeaseForSession(activePreviousLease, dispatchLease.leaseNonce);
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
            reviewCoverage: missionContract.reviewCoverage,
            ...missionBaseline!,
          });
          supervisorRun = config.supervisorRuns?.create({
            missionId: mission.id,
            workSessionId: wsId,
            workspaceSessionId,
            autonomyMode: missionContract.autonomyMode,
            approvalMode: missionContract.approvalMode,
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
            ...checkoutLeaseMetadata(config, wsId),
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
}
