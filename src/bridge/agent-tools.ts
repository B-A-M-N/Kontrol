/**
 * Skill discovery, ACP agent calling and agent discovery tools
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { BridgeConfig } from "./context.js";
import { probeAgent, type AgentProbeResult } from "../acp-gateway.js";
import { dispatchToRegisteredAgent } from "./dispatch-service.js";
import { loadSkillIndex } from "../skills.js";
import { registerMutationAppTool } from "./app-tool.js";
import { forbidden, isReviewer, resolveDelegationContext } from "./shared.js";
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
        dispatchStatus: z.string().optional(),
        workerStatus: z.string().optional(),
        outcomeObserved: z.boolean().optional(),
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
    async ({ agentName, task, dispatchIntent = "required_delegate", workspaceId, workspaceSessionId, workSessionId, sessionId, agentUrl, webhookUrl, clientMutationId }) => {
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
      const result = await dispatchToRegisteredAgent(config, {
        task,
        workspaceSessionId: resolved.workspaceSessionId,
        workSessionId: resolved.workSessionId,
        agentName,
        dispatchIntent,
        // Legacy call_acp_agent reuse semantics: an existing non-terminal
        // session may be reused without the strict review-gate checks that
        // submit_to_coding_agent enforces. Terminal sessions still fail closed.
        allowNonReviewSessionReuse: true,
        clientMutationId,
      });
      const displayName = result.agentName ?? agentName;
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
          content: [{ type: "text" as const, text: `${displayName}: failed\n${result.error ?? "(no error detail)"}` }],
          structuredContent: { runId: result.runId, workSessionId: result.workSessionId, workspaceSessionId: result.workspaceSessionId, status: result.status, dispatchStatus: "failed", workerStatus: "unknown", outcomeObserved: false, output: result.output, error: result.error },
          isError: true,
        };
      }
      if (result.status === "uncertain") {
        return {
          content: [{ type: "text" as const, text: result.text ?? `${displayName}: dispatch acceptance is uncertain.` }],
          structuredContent: { runId: result.runId, workSessionId: result.workSessionId, workspaceSessionId: result.workspaceSessionId, status: "uncertain", dispatchStatus: "uncertain", workerStatus: "unknown", outcomeObserved: false, output: result.output, error: result.error, retryable: false },
        };
      }
      const output = result.output ?? "";
      return {
        content: [{ type: "text" as const, text: `${displayName}: ${result.status}\n${output.slice(0, 5000)}${result.error ? `\nError: ${result.error}` : ""}` }],
        structuredContent: { runId: result.runId, workSessionId: result.workSessionId, workspaceSessionId: result.workspaceSessionId, status: result.status, dispatchStatus: "accepted", workerStatus: "unknown", outcomeObserved: false, output, error: result.error },
      };
    },
  );

  registerAppTool(
    server,
    "discover_agents",
    {
      title: "Discover agents",
      description: "Inspect every registered peer and probe its protocol readiness. Clearly separates dispatchable agents from unavailable, dead, non-agent, or unsupported-transport entries; only alive role=agent peers with a successful HTTP ACP probe are dispatchable. Unspecified delegation prefers the registered native harness for the caller platform (ChatGPT/OpenAI prefers Codex), then falls back to another healthy peer.",
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
          probeFailureCategory: z.string().optional(),
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
          const probe: AgentProbeResult = a.alive
            ? await probeAgent(a.url, config.adapterSecret)
            : { healthy: false, status: 0, checkedAt: new Date().toISOString(), failureCategory: "unreachable", note: "agent heartbeat is not alive" };
          return { a, probe, checkedAt: probe.checkedAt };
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
            probeFailureCategory: probe.failureCategory,
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
