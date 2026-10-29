import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ServerConfig } from "../../config.js";
import type { GoalStore, WorkspaceGoal } from "../../goal-store.js";
import type { WorkspaceRegistry } from "../../workspaces.js";
import { logToolCall } from "../tool-logging.js";
import { resultOutputSchema } from "../tool-schemas.js";
import { toolWidgetDescriptorMeta } from "../tool-context.js";
import { textBlock } from "../tool-result.js";

const goalOutputSchema = z.object({
  workspaceId: z.string(),
  goalId: z.string(),
  objective: z.string(),
  status: z.enum(["active", "blocked", "complete"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
});

function goalResultText(goal: WorkspaceGoal | undefined): string {
  if (!goal) return "No goal exists for this workspace.";
  const completed = goal.completedAt ? `\nCompleted at: ${goal.completedAt}` : "";
  return [`Goal ${goal.goalId}`, `Status: ${goal.status}`, `Objective: ${goal.objective}`, `Updated at: ${goal.updatedAt}${completed}`].join("\n");
}

function goalToolResponse(tool: "get_goal" | "create_goal" | "update_goal", workspaceId: string, goal: WorkspaceGoal | undefined, action: string) {
  const result = goalResultText(goal);
  const content = [textBlock(result)];
  return {
    content,
    _meta: { tool, card: { workspaceId, summary: { action, hasGoal: Boolean(goal), status: goal?.status }, payload: { content } } },
    structuredContent: { result, goal: goal ?? null },
  };
}

export function registerGoalTools(server: McpServer, config: ServerConfig, workspaces: WorkspaceRegistry, goalStore: GoalStore): void {
  registerAppTool(server, "get_goal", {
    title: "Get goal",
    description: "Retrieve the durable goal for an open workspace. Call after opening a workspace, after context compaction or resume, and before continuing long-running work. Returns null when no goal exists.",
    inputSchema: { workspaceId: z.string().describe("Workspace identifier returned by open_workspace.") },
    outputSchema: resultOutputSchema({ goal: goalOutputSchema.nullable() }),
    ...toolWidgetDescriptorMeta(config, "goal"),
    annotations: { readOnlyHint: true },
  }, async ({ workspaceId }) => {
    const startedAt = performance.now();
    workspaces.getWorkspace(workspaceId);
    const goal = goalStore.getGoal(workspaceId);
    logToolCall(config, { tool: "get_goal", workspaceId, success: true, durationMs: Math.round(performance.now() - startedAt) });
    return goalToolResponse("get_goal", workspaceId, goal, "get");
  });

  registerAppTool(server, "create_goal", {
    title: "Create goal",
    description: "Create a durable active goal for an open workspace. Use only when explicitly requested by the user or governing instructions. Fails if an unfinished goal already exists; update that goal instead.",
    inputSchema: {
      workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
      objective: z.string().min(1).max(4000).describe("Concrete goal objective to persist for this workspace."),
    },
    outputSchema: resultOutputSchema({ goal: goalOutputSchema.nullable() }),
    ...toolWidgetDescriptorMeta(config, "goal"),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, objective }) => {
    const startedAt = performance.now();
    workspaces.getWorkspace(workspaceId);
    const goal = goalStore.createGoal({ workspaceId, objective });
    logToolCall(config, { tool: "create_goal", workspaceId, success: true, durationMs: Math.round(performance.now() - startedAt) });
    return goalToolResponse("create_goal", workspaceId, goal, "create");
  });

  registerAppTool(server, "update_goal", {
    title: "Update goal",
    description: "Update the current workspace goal lifecycle. Allowed statuses are complete and blocked. Use complete only when the objective is done. Use blocked only when progress cannot continue without user input or an external state change.",
    inputSchema: {
      workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
      status: z.enum(["complete", "blocked"]).describe("New lifecycle status for the current goal."),
    },
    outputSchema: resultOutputSchema({ goal: goalOutputSchema.nullable() }),
    ...toolWidgetDescriptorMeta(config, "goal"),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, status }) => {
    const startedAt = performance.now();
    workspaces.getWorkspace(workspaceId);
    const goal = goalStore.updateGoal({ workspaceId, status });
    logToolCall(config, { tool: "update_goal", workspaceId, success: true, durationMs: Math.round(performance.now() - startedAt) });
    return goalToolResponse("update_goal", workspaceId, goal, "update");
  });
}
