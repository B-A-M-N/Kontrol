/**
 * Shared workspace-tool execution envelope factories: durable tool-event
 * attribution and the checkpoint mutation barrier. Extracted verbatim from
 * src/mcp/workspace-server.ts (P1.3); the createMcpServer closures become
 * explicit factories over an explicit dependency object.
 */
import { performance } from "node:perf_hooks";
import type { ServerConfig } from "../config.js";
import { logEvent } from "../logger.js";
import { redactedPreview } from "../redaction.js";
import { redactValue, shellTelemetrySync } from "../redaction.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import type { createReviewCheckpointManager } from "../review-checkpoints.js";
import type { createWorkSessionManager } from "../work-sessions.js";
import type { EventStore } from "../event-log.js";
import { recordDegradedAudit } from "./tool-logging.js";
import { contentText, type ToolContent } from "./tool-result.js";
import { toolNames } from "./tool-names.js";
import { WorkspaceMutationAuthorityError, WorkspaceMutationBlockedError } from "./mutation-barrier.js";
import type { ConnectionContext } from "./connection-context.js";
import { assertWorkerWorkspaceBinding } from "./process-tool-response.js";

export interface ToolEnvelopeDeps {
  readonly config: ServerConfig;
  readonly workspaces: WorkspaceRegistry;
  readonly reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>;
  readonly workSessions?: ReturnType<typeof createWorkSessionManager>;
  readonly eventStore?: EventStore;
  readonly connectionContext?: ConnectionContext;
}

export interface ToolEnvelope {
  trackToolEvent(
    workspaceId: string,
    tool: string,
    input: Record<string, unknown>,
    result: { content: ToolContent[]; isError?: boolean },
    startedAt: number,
  ): void;
  prepareForMutation(workspaceId: string): Promise<void>;
}

export function createToolEnvelope(deps: ToolEnvelopeDeps): ToolEnvelope {
  const { config, workspaces, reviewCheckpoints, workSessions, eventStore, connectionContext } = deps;

  function trackToolEvent(
    workspaceId: string,
    tool: string,
    input: Record<string, unknown>,
    result: { content: ToolContent[]; isError?: boolean },
    startedAt: number,
  ): void {
    if (!workSessions || !config.acpEnabled || !eventStore) return;
    try {
      // Attribution is part of the execution envelope: prefer the work session
      // bound to THIS MCP connection, falling back to the per-transport active
      // session for non-delegated (direct) tool calls. The shared project record
      // never acts as an attribution fallback.
      const workSessionId =
        connectionContext?.workSessionId
          ?? workspaces.getCurrentWorkSessionId(workspaceId, connectionContext?.mcpSessionId);
      if (!workSessionId) return;

      const session = workSessions.get(workSessionId);
      if (!session) {
        throw new Error("Bound work session does not exist");
      }
      if (session.workspaceSessionId !== workspaceId) {
        throw new Error("Work session does not belong to this workspace");
      }

      // P0.6: durable telemetry is redacted at this single choke point —
      // input JSON, output summaries, and event-log payloads all flow
      // through the shared sanitizer so a command like `env` or
      // `echo "$SOME_SECRET"` cannot persist credentials.
      const redactedInput = redactValue(input) as Record<string, unknown>;
      const outputSummary = redactedPreview(contentText(result.content), 2000);
      // P0.6 storage model: shell inputs keep hash + redacted preview only.
      const shellTelemetryInput = tool === toolNames.shell
        ? shellTelemetrySync(String(input.command ?? ""), 160)
        : undefined;
      const persistedInput = shellTelemetryInput
        ? { commandHash: shellTelemetryInput.commandHash, commandPreview: shellTelemetryInput.commandPreview, commandLength: shellTelemetryInput.commandLength }
        : redactedInput;

      workSessions.logToolEvent({
        workSessionId,
        workspaceSessionId: workspaceId,
        tool,
        inputJson: JSON.stringify(persistedInput),
        outputSummary,
        path: typeof input.path === "string" ? input.path : undefined,
        success: !result.isError,
        elapsedMs: Math.round(performance.now() - startedAt),
      });

      // Append to the durable event log so subscribers (WebUI watcher) react
      // without polling. The projection (work_session_tool_events) is for
      // query/history; the event log is what drives the UI.
      eventStore.appendEvent({
        type: result.isError ? "agent.tool.failed" : "agent.tool.completed",
        sessionId: workSessionId,
        payload: {
          runId: connectionContext?.runId,
          mcpSessionId: connectionContext?.mcpSessionId,
          mcpSessionLabel: connectionContext?.mcpSessionLabel,
          conversationId: connectionContext?.conversationId,
          tool,
          path: typeof input.path === "string" ? input.path : undefined,
          input: persistedInput,
          outputSummary,
          success: !result.isError,
          elapsedMs: Math.round(performance.now() - startedAt),
        },
      });
    } catch (error) {
      // P1 #25: session tracking is non-critical and must never fail the
      // user's tool call, but persistent audit degradation must be visible.
      recordDegradedAudit("work_session_tool_event", error);
    }
  }

  // Centralized mutation preflight. Every mutation-capable tool (write, edit,
  // apply_patch, bash, exec_command, write_stdin) proves worker binding and
  // checkout lease ownership here, before checkpoint initialization, policy
  // waits, path resolution, or filesystem access.
  // P0.5: readiness is fail-closed. If no usable checkpoint backend could be
  // established, mutation is refused with a distinct error instead of
  // silently proceeding untracked. The only override is the explicit
  // operator escape hatch KONTROL_ALLOW_UNTRACKED_MUTATION (default off) —
  // automatic fallback is never acceptable for a review-safe boundary.
  async function prepareForMutation(workspaceId: string): Promise<void> {
    const bindingError = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
    if (bindingError) {
      throw new WorkspaceMutationAuthorityError(
        workspaceId,
        "workspace_binding_denied",
        bindingError.content[0]?.text ?? "Forbidden: worker is not bound to the requested workspace.",
        false,
      );
    }

    const workspace = workspaces.getWorkspace(workspaceId);
    if (connectionContext?.authenticatedRole === "worker") {
      const lease = workSessions?.getActiveWorkspaceLease(workspace.root);
      if (
        !connectionContext.workSessionId ||
        !connectionContext.workspaceLeaseNonce ||
        !lease ||
        lease.workSessionId !== connectionContext.workSessionId ||
        lease.workspaceSessionId !== workspaceId ||
        lease.leaseNonce !== connectionContext.workspaceLeaseNonce
      ) {
        throw new WorkspaceMutationAuthorityError(
          workspaceId,
          "workspace_lease_lost",
          "Workspace mutation refused because this worker no longer holds the current checkout lease.",
          false,
        );
      }
    } else {
      const lease = workSessions?.getActiveWorkspaceLease(workspace.root);
      if (lease) {
        throw new WorkspaceMutationAuthorityError(
          workspaceId,
          "workspace_lease_conflict",
          "Workspace mutation refused because a delegated work session currently holds the checkout lease.",
          true,
        );
      }
    }

    // Lease and worker authority do not depend on the review widget setting.
    // Widgets only control whether the additional checkpoint-readiness gate is
    // enabled for this workspace.
    if (!config.widgets || config.widgets === "off") return;
    try {
      await reviewCheckpoints.awaitWorkspaceReady({ workspaceId, root: workspace.root });
    } catch (error) {
      if (config.allowUntrackedMutation === true) {
        logEvent(config.logging, "warn", "checkpoint_ready_barrier_failed_untracked_allowed", {
          workspaceId,
          detail: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      throw new WorkspaceMutationBlockedError(
        workspaceId,
        `Workspace mutation is disabled because the review baseline could not be established: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const snapshotInfo = await reviewCheckpoints.getSnapshotInfo({ workspaceId, root: workspace.root });
    if (snapshotInfo.available) return;
    if (config.allowUntrackedMutation === true) {
      logEvent(config.logging, "warn", "checkpoint_backend_unavailable_untracked_allowed", {
        workspaceId,
        detail: snapshotInfo.diagnostic ?? "checkpoint backend unavailable",
      });
      return;
    }
    throw new WorkspaceMutationBlockedError(
      workspaceId,
      `Workspace mutation is disabled because the review baseline could not be established: ${snapshotInfo.diagnostic ?? "no usable checkpoint backend"}`,
    );
  }

  return { trackToolEvent, prepareForMutation };
}
