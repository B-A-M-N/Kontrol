/**
 * Bridge tool registrar composition root: mounts each capability module onto
 * the MCP server with the shared typed BridgeConfig context. Replaces the
 * single 2,966-line registerBridgeTools closure of the original acp-bridge.ts
 * god module (P0 refactor).
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { BridgeConfig } from "./context.js";
import { registerSessionTools } from "./session-tools.js";
import { registerReviewTools } from "./review-tools.js";
import { registerEventTools } from "./event-tools.js";
import { registerContinuationTools } from "./continuation-tools.js";
import { registerMissionTools } from "./mission-tools.js";
import { registerSupervisorTools } from "./supervisor-tools.js";
import { registerDelegationTools } from "./delegation-tools.js";
import { registerMessageTools } from "./message-tools.js";
import { registerScheduleTools } from "./schedule-tools.js";
import { registerReplyTools } from "./reply-tools.js";
import { registerHandoffTools } from "./handoff-tools.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerWorkResultTools } from "./work-result-tools.js";

/**
 * Front slice: the ChatGPT-facing workflow (sessions, dispatch, messaging,
 * agent discovery, result intake, events, review). Registration order is the
 * tools/list order and capped hosts (ChatGPT, ~55 tools) keep the first
 * entries, so this slice registers BEFORE the workspace tools in
 * workspace-server.ts — that puts open_workspace (the first workspace tool)
 * and every critical workflow tool within the first 55. Guarded by
 * mcp-tool-surface-contract.test.ts (critical tools within 55).
 */
export function registerBridgeToolsFront(server: McpServer, config: BridgeConfig): void {
  registerSessionTools(server, config);
  registerDelegationTools(server, config);
  registerMessageTools(server, config);
  registerReplyTools(server, config);
  registerAgentTools(server, config);
  registerWorkResultTools(server, config);
  registerEventTools(server, config);
  registerReviewTools(server, config);
}

/**
 * Back slice: continuation, missions, supervisor, scheduling, and handoff.
 * Not on the ChatGPT dispatch path; registers after the workspace tools.
 */
export function registerBridgeToolsBack(server: McpServer, config: BridgeConfig): void {
  registerContinuationTools(server, config);
  registerMissionTools(server, config);
  registerSupervisorTools(server, config);
  registerScheduleTools(server, config);
  registerHandoffTools(server, config);
}

export function registerBridgeTools(server: McpServer, config: BridgeConfig): void {
  registerBridgeToolsFront(server, config);
  registerBridgeToolsBack(server, config);
}

  // Initial delegation has one model-facing path: discover_agents followed by
  // submit_to_coding_agent/call_acp_agent. Configured URL-specific route tools
  // were intentionally removed because they bypassed health selection and
  // made an unavailable peer look dispatchable. Continuation redelivery and
  // explicit handoff remain separate durable paths.

  // NOTE: the continuation dispatcher is started explicitly by the server
  // (via startContinuationDispatcher) so it can be omitted in tests.
