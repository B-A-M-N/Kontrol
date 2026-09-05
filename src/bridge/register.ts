/**
 * Bridge tool registrar composition root: mounts each capability module onto
 * the MCP server with the shared typed BridgeConfig context. Replaces the
 * single 2,966-line registerBridgeTools closure of the original acp-bridge.ts
 * god module (P0 refactor).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig } from "./context.js";
import { registerSessionTools } from "./session-tools.js";
import { registerReviewTools } from "./review-tools.js";
import { registerEventTools } from "./event-tools.js";
import { registerContinuationTools } from "./continuation-tools.js";
import { registerMissionTools } from "./mission-tools.js";
import { registerSupervisorTools } from "./supervisor-tools.js";
import { registerDelegationTools } from "./delegation-tools.js";
import { registerMessageTools } from "./message-tools.js";
import { registerAgentTools } from "./agent-tools.js";

export function registerBridgeTools(server: McpServer, config: BridgeConfig): void {
  registerSessionTools(server, config);
  registerReviewTools(server, config);
  registerEventTools(server, config);
  registerContinuationTools(server, config);
  registerMissionTools(server, config);
  registerSupervisorTools(server, config);
  registerDelegationTools(server, config);
  registerMessageTools(server, config);
  registerAgentTools(server, config);
}

  // Initial delegation has one model-facing path: discover_agents followed by
  // submit_to_coding_agent/call_acp_agent. Configured URL-specific route tools
  // were intentionally removed because they bypassed health selection and
  // made an unavailable peer look dispatchable. Continuation redelivery and
  // explicit handoff remain separate durable paths.

  // NOTE: the continuation dispatcher is started explicitly by the server
  // (via startContinuationDispatcher) so it can be omitted in tests.
