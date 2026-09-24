/** Canonical owner identity for conversation/transport-scoped MCP state. */
export function mcpOwnerContextId(context: { conversationId?: string; mcpSessionId?: string; principalId?: string; authenticatedPrincipalId?: string }): string | undefined {
  const principal = (context.principalId ?? context.authenticatedPrincipalId)?.trim();
  const prefix = principal ? `principal:${principal}|` : "";
  const conversation = context.conversationId?.trim();
  if (conversation) return `${prefix}conversation:${conversation}`;
  const transport = context.mcpSessionId?.trim();
  return transport ? `${prefix}transport:${transport}` : undefined;
}
