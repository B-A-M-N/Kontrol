/**
 * Skill discovery, ACP agent calling and agent discovery tools
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig } from "./context.js";
import { callRemoteAgent, probeAgent, selectHealthyAgent } from "../acp-gateway.js";
import { loadSkillIndex } from "../skills.js";
import { registerMutationAppTool } from "./app-tool.js";
import { acquireCheckoutModifyLease, checkoutLeaseNonce, forbidden, isReviewer, resolveDelegationContext, workSessionInstructions } from "./shared.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod/v4";

export function registerAgentTools(server: McpServer, config: BridgeConfig): void {
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

  registerMutationAppTool(
    server,
    "call_acp_agent",
    {
      title: "Call ACP agent",
      description: "Optional reviewer-directed delegation to a currently dispatchable registered ACP agent. Use direct workspace tools first for review, diagnosis, and edits; this bounded path requires workspace correlation and never transfers reviewer authority.",
      inputSchema: {
        agentName: z.string().describe("Name of the target ACP agent."),
        task: z.string().trim().min(1).describe("Bounded task description for the remote agent."),
        dispatchIntent: z.enum(["optional_assist", "required_delegate"]).optional().describe("Use optional_assist when delegation is helpful but direct workspace work is an acceptable fallback; required_delegate preserves an error when no healthy agent is available."),
        workspaceId: z.string().optional().describe("Workspace ID from open_workspace. Preferred public name; aliases workspaceSessionId."),
        workspaceSessionId: z.string().optional().describe("Workspace session ID (legacy/internal alias for workspaceId)."),
        workSessionId: z.string().optional().describe("Optional existing work session ID."),
        sessionId: z.string().optional().describe("Legacy alias for workSessionId."),
        agentUrl: z.string().optional().describe("Deprecated and rejected. Agents must be selected from the trusted registry."),
        webhookUrl: z.string().optional().describe("Deprecated and rejected. Agent progress is tracked through Kontrol events."),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: {
        runId: z.string().optional(),
        workSessionId: z.string().optional(),
        workspaceSessionId: z.string().optional(),
        status: z.string(),
        output: z.string().optional(),
        error: z.string().optional(),
        retryable: z.boolean().optional(),
        fallback: z.string().optional(),
        reason: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ agentName, task, dispatchIntent = "required_delegate", workspaceId, workspaceSessionId, workSessionId, sessionId, agentUrl, webhookUrl }) => {
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
      if (!selection.agent) {
        const reason = `No healthy dispatchable registered ACP agent named "${agentName}".`;
        if (dispatchIntent === "optional_assist") {
          return {
            content: [{ type: "text" as const, text: `${reason} Continue in the direct workspace; no alternate ACP route was attempted.` }],
            structuredContent: { status: "unavailable", retryable: false, fallback: "direct_workspace", reason },
          };
        }
        return { content: [{ type: "text" as const, text: reason }], isError: true };
      }
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

  registerAppTool(
    server,
    "discover_agents",
    {
      title: "Discover agents",
      description: "Inspect every registered peer and probe its protocol readiness. Clearly separates dispatchable agents from unavailable, dead, non-agent, or unsupported-transport entries; only alive role=agent peers with a successful HTTP ACP probe are dispatchable.",
      inputSchema: {},
      outputSchema: {
        agents: z.array(z.object({
          name: z.string(),
          url: z.string(),
          role: z.string(),
          alive: z.boolean(),
          healthy: z.boolean(),
          dispatchable: z.boolean(),
          probeStatus: z.number().int(),
          probeNote: z.string().optional(),
          capabilities: z.array(z.string()),
          checkedAt: z.string(),
        })),
        available: z.array(z.string()),
        unavailable: z.array(z.string()),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "discover_agents");
      }
      const all = config.agentRegistry.listAll();
      // Probe every entry so the result is an auditable all-agent inventory.
      const health = await Promise.all(
        all.map(async (a) => {
          const probe = a.alive
            ? await probeAgent(a.url, config.adapterSecret)
            : { healthy: false, status: 0, note: "agent heartbeat is not alive" };
          return { a, probe, checkedAt: new Date().toISOString() };
        }),
      );
      const available = health.filter(({ a, probe }) => a.alive && a.role === "agent" && probe.healthy).map(({ a }) => a.name);
      const unavailable = health.filter(({ a, probe }) => !(a.alive && a.role === "agent" && probe.healthy)).map(({ a }) => a.name);
      const text = health.length > 0
        ? `Dispatchable agents: ${available.length ? available.join(", ") : "none"}. Unavailable: ${unavailable.length ? unavailable.join(", ") : "none"}. Continue directly in the workspace when no dispatchable agent is available.`
        : "No registered agents. Continue directly in the workspace; no alternate ACP route is available.";

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          agents: health.map(({ a, probe, checkedAt }) => ({
            name: a.name,
            url: a.url,
            role: a.role,
            alive: a.alive,
            healthy: probe.healthy,
            dispatchable: a.alive && a.role === "agent" && probe.healthy,
            probeStatus: probe.status,
            probeNote: probe.note ?? probe.error,
            capabilities: a.capabilities,
            checkedAt,
          })),
          available,
          unavailable,
        },
      };
    },
  );
}
