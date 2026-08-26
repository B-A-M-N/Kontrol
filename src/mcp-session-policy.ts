export interface McpSessionPolicyState {
  toolCallCount: number;
  activeLongPollCount: number;
  activePolicyWaiters?: number;
  durableWorkerSession: boolean;
}

export interface McpSessionPolicyConfig {
  mcpUnusedSessionIdleMs: number;
  mcpEphemeralSessionIdleMs: number;
  mcpReusableSessionIdleMs: number;
}

export type McpSessionIdleReason = "unused_idle" | "ephemeral_idle" | "normal_idle";

export function mcpSessionIdleTtl(
  state: McpSessionPolicyState,
  config: McpSessionPolicyConfig,
): number {
  if (state.activeLongPollCount > 0) return Number.POSITIVE_INFINITY;
  if ((state.activePolicyWaiters ?? 0) > 0) return Number.POSITIVE_INFINITY;
  if (state.toolCallCount === 0) return config.mcpUnusedSessionIdleMs;
  // A one-tool session may still be the transport for the next model turn.
  // This is a grace classification for metrics, not permission to reap it
  // aggressively. Pressure-based admission may reclaim it only when needed.
  // A single completed tool call is only a provisional classification. The
  // caller may still be reasoning or about to issue another tool call.
  if (state.toolCallCount === 1 && !state.durableWorkerSession) return config.mcpEphemeralSessionIdleMs;
  return config.mcpReusableSessionIdleMs;
}

export function mcpSessionIdleReason(state: McpSessionPolicyState): McpSessionIdleReason {
  if (state.toolCallCount === 0) return "unused_idle";
  if (state.toolCallCount === 1 && !state.durableWorkerSession) return "ephemeral_idle";
  return "normal_idle";
}
