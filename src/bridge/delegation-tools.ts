/**
 * Direct coding-agent delegation tool
 *
 * Thin adapter over the single durable dispatch service
 * (dispatch-service.ts). All selection, session/lease, idempotency and
 * uncertain-dispatch logic lives there; this module owns only the
 * MCP schema, role check, workspace resolution, and result mapping.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { BridgeConfig } from "./context.js";
import { dispatchToRegisteredAgent } from "./dispatch-service.js";
import { registerMutationAppTool } from "./app-tool.js";
import { supervisedMissionOptionsSchema, workOrderSchema } from "./context.js";
import { forbidden, isReviewer, resolveDelegationContext, workspaceAppModelAndAppMeta } from "./shared.js";
import { z } from "zod/v4";

export function registerDelegationTools(server: McpServer, config: BridgeConfig): void {
  registerMutationAppTool(
    server,
    "submit_to_coding_agent",
    {
      title: "Submit task to coding agent",
      description: "Reviewer-directed delegation to a registered ACP harness. An explicit agentName is honored exactly; required_delegate fails if that peer is unavailable and never falls back to another adapter. If agentName is omitted, the optional routing policy may select a healthy peer.",
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
        agentName: z.string().optional(),
        agentId: z.string().optional(),
      },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ task, dispatchIntent = "optional_assist", workspaceId, workspaceSessionId, workSessionId, sessionId, agentName, completionPolicy, missionContract }) => {
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
      const result = await dispatchToRegisteredAgent(config, {
        task,
        workspaceSessionId: resolved.workspaceSessionId,
        workSessionId: resolved.workSessionId,
        agentName,
        dispatchIntent,
        completionPolicy,
        mission: missionContract,
      });
      if (result.status === "unavailable") {
        if (dispatchIntent === "optional_assist") {
          return {
            content: [{ type: "text" as const, text: result.text ?? result.reason ?? "No healthy agent available." }],
            structuredContent: { status: "unavailable", retryable: false, fallback: "direct_workspace", reason: result.reason },
          };
        }
        return { content: [{ type: "text" as const, text: result.text ?? result.reason ?? "No healthy agent available." }], isError: true };
      }
      if (result.status === "failed") {
        return {
          content: [{ type: "text" as const, text: result.text ?? result.error ?? "ACP call failed with no error detail." }],
          structuredContent: { runId: result.runId, remoteRunId: result.remoteRunId, workSessionId: result.workSessionId, workspaceSessionId: result.workspaceSessionId, status: result.status, output: result.output, error: result.error, agentName: result.agentName, agentId: result.agentId },
          isError: true,
        };
      }
      if (result.status === "uncertain") {
        return {
          content: [{ type: "text" as const, text: result.text ?? "Dispatch acceptance is uncertain." }],
          structuredContent: { runId: result.runId, remoteRunId: result.remoteRunId, workSessionId: result.workSessionId, workspaceSessionId: result.workspaceSessionId, status: "uncertain", output: result.output, error: result.error, retryable: false, agentName: result.agentName, agentId: result.agentId },
        };
      }
      return {
        content: [{ type: "text" as const, text: result.output || "(no output)" }],
        structuredContent: { runId: result.runId, remoteRunId: result.remoteRunId, workSessionId: result.workSessionId, workspaceSessionId: result.workspaceSessionId, status: result.status, output: result.output, agentName: result.agentName, agentId: result.agentId },
      };
    },
  );
}
