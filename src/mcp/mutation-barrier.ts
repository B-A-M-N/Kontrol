/**
 * P0.5 mutation barrier: the WorkspaceMutationBlockedError, its renderable
 * checkpoint_unavailable tool response, and the uniform runMutationBarrier
 * wrapper. Extracted verbatim from src/mcp/workspace-server.ts (P1.3).
 */

/**
 * P0.5: thrown by prepareForMutation when no usable checkpoint backend exists.
 * Tool handlers catch it and return a distinct, machine-readable
 * checkpoint_unavailable result rather than executing an untracked mutation.
 */
export class WorkspaceMutationBlockedError extends Error {
  readonly workspaceId: string;
  readonly code = "checkpoint_unavailable";
  constructor(workspaceId: string, message: string) {
    super(message);
    this.name = "WorkspaceMutationBlockedError";
    this.workspaceId = workspaceId;
  }
}

export function isWorkspaceMutationBlockedError(error: unknown): error is WorkspaceMutationBlockedError {
  return error instanceof WorkspaceMutationBlockedError;
}

/**
 * P0.5: a checkpoint-blocked mutation returns the same renderable card
 * envelope as a policy denial so the model sees a distinct, machine-readable
 * checkpoint_unavailable status instead of a generic transport error.
 */
export function checkpointUnavailableResponse(error: WorkspaceMutationBlockedError, tool: string) {
  const message = `${error.message} (Set KONTROL_ALLOW_UNTRACKED_MUTATION=1 to explicitly run without review tracking — not recommended.)`;
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
    _meta: {
      tool,
      card: {
        tool,
        workspaceId: error.workspaceId,
        status: "checkpoint_unavailable",
        summary: { status: "checkpoint_unavailable" },
        payload: { content: [{ type: "text", text: message }] },
      },
    },
    structuredContent: { result: message, status: "checkpoint_unavailable", retryable: false },
  };
}

/**
 * P0.5: uniform mutation barrier. Runs prepareForMutation and converts a
 * fail-closed block into a checkpoint_unavailable tool response.
 */
export async function runMutationBarrier(
  prepare: ((workspaceId: string) => Promise<void>) | undefined,
  workspaceId: string,
  tool: string,
): Promise<ReturnType<typeof checkpointUnavailableResponse> | null> {
  try {
    await prepare?.(workspaceId);
    return null;
  } catch (error) {
    if (isWorkspaceMutationBlockedError(error)) return checkpointUnavailableResponse(error, tool);
    throw error;
  }
}
