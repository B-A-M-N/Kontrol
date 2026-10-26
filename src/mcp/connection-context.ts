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
  authenticatedRole?: "worker" | "reviewer" | "client" | "peer";
  authSource?: "oauth" | "reviewer_token" | "worker_token" | "tunnel_reviewer" | "peer_token" | "anonymous";
  /** Authenticated principal for durable client mutation identities. */
  authenticatedPrincipalId?: string;
  /**
   * Which HTTP listener accepted this connection. Sessions are bound to their
   * listener at initialization; a session created on the peer listener can
   * never be attached from the owner listener and vice versa, even if a
   * session ID leaks.
   */
  listenerKind?: "owner" | "peer" | "owner_public";
  /** Owner-granted capabilities when authenticatedRole === "peer" (registry-derived). */
  peerCapabilities?: readonly import("../peer/config-types.js").PeerCapability[];
  /** Canonical workspace roots granted to this peer (registry-derived). */
  peerGrantedRoots?: readonly string[];
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
  /** Untrusted MCP clientInfo.name hint used only to prefer a native ACP peer. */
  clientPlatformHint?: string;
  /** Stable trusted identity used only for reconnecting one approval operation. */
  approvalCorrelationId?: string;
}

/**
 * Direct process sessions normally belong to the transport that opened them,
 * but a trusted reconnect identity or durable work session can outlive one
 * MCP transport. Generic clientInfo fallback remains deliberately ephemeral.
 */
export function processSessionOwnerId(context?: ConnectionContext): string | undefined {
  if (context?.authenticatedRole === "worker" && context.workSessionId) {
    return `work-session:${context.workSessionId}`;
  }
  if (context?.approvalCorrelationId) return `logical-client:${context.approvalCorrelationId}`;
  return context?.mcpSessionId;
}
