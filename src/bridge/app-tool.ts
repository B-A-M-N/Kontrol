/**
 * Mutation wrapper around registerAppTool (idempotency receipts)
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import { mutationPrincipalId, runWithMutationReceipt } from "../mutation-receipts.js";
import type { BridgeConfig } from "./context.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerMutationAppTool(
  server: McpServer,
  name: string,
  definition: unknown,
  config: BridgeConfig,
  handler: (input: any) => Promise<unknown> | unknown,
): void {
  registerAppTool(server, name as any, definition as any, (async (input: any) => {
    const { clientMutationId, ...request } = input as { clientMutationId?: string } & Record<string, unknown>;
    return runWithMutationReceipt({
      store: config.mutationReceipts,
      principalId: mutationPrincipalId(config.principalId, config.principalRole),
      operation: name,
      clientMutationId,
      request,
      execute: () => handler(input),
    });
  }) as any);
}
