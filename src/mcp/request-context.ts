/**
 * Per-request MCP context propagation. Extracted verbatim from
 * src/mcp/workspace-server.ts (P1.3).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PolicyWaitContext, PolicyWaitOutcome } from "../policy-enforcement.js";

export interface McpRequestContext {
  signal: AbortSignal;
  mcpSessionId?: string;
  mcpRequestId?: string;
  conversationId?: string;
  approvalCorrelationId?: string;
  onPolicyWaitStart?: (context: PolicyWaitContext) => void | Promise<void>;
  onPolicyWaitEnd?: (context: PolicyWaitContext & { outcome: PolicyWaitOutcome }) => void | Promise<void>;
}

export const mcpRequestContext = new AsyncLocalStorage<McpRequestContext>();

export function currentMcpRequestSignal(): AbortSignal | undefined {
  return mcpRequestContext.getStore()?.signal;
}

export function currentMcpRequestContext(): McpRequestContext | undefined {
  return mcpRequestContext.getStore();
}
