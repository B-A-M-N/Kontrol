/**
 * Per-connection attribution envelope and process-session ownership
 * derivation. Extracted verbatim from src/mcp/workspace-server.ts (P1.3).
 */
export interface ConnectionContext {
  /**
   * The role authenticated for this connection. A successfully-verified signed
   * worker token yields "worker"; otherwise the connection is treated as a
   * reviewer/client. AUTHORIZATION MUST derive from this field — never from the
   * unsigned attribution headers (P0 #3). The unsigned headers below are for
   * logging/attribution only and grant no privileges.
   */
  authenticatedRole?: "worker" | "reviewer" | "client";
  authSource?: "oauth" | "reviewer_token" | "worker_token" | "tunnel_reviewer" | "anonymous";
  /** Authenticated principal for durable client mutation identities. */
  authenticatedPrincipalId?: string;
  workspaceSessionId?: string;
  workSessionId?: string;
  runId?: string;
  continuationId?: string;
  /** Checkout lease nonce issued for the bound worker work session. */
  workspaceLeaseNonce?: string;
  /** Transport identity, never shared across MCP sessions. */
  mcpSessionId?: string;
  /** Human-readable diagnostic label for this isolated transport. */
  mcpSessionLabel?: string;
  /** Optional upstream conversation correlation; not an authorization key. */
  conversationId?: string;
  /** Stable trusted identity used only for reconnecting one approval operation. */
  approvalCorrelationId?: string;
}

/**
 * Direct process sessions normally belong to the transport that opened them,
 * but a trusted reconnect identity or durable work session can outlive one
 * MCP transport. Generic clientInfo fallback remains deliberately ephemeral.
 */
export function processSessionOwnerId(context?: ConnectionContext): string | undefined {
  if (context?.workSessionId) return `work-session:${context.workSessionId}`;
  if (context?.approvalCorrelationId) return `logical-client:${context.approvalCorrelationId}`;
  return context?.mcpSessionId;
}
