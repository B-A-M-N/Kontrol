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
import { WorkspaceMutationBlockedError } from "./mutation-barrier.js";
import type { ConnectionContext } from "./connection-context.js";

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
      // bound to THIS MCP connection, falling back to the workspace's "currently
      // active" session only for non-delegated (direct) tool calls.
      const workSessionId =
        connectionContext?.workSessionId ?? workspaces.getWorkspace(workspaceId).currentWorkSessionId;
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

  // P0 #3: Centralized mutation preflight. Every mutation-capable tool (write,
  // edit, apply_patch, bash, exec_command, write_stdin) awaits the workspace's
  // initial filesystem baseline through this single choke point, so a mutation
  // can never race the background baseline capture and escape the review
  // boundary. Reads may proceed immediately.
  // P0.5: readiness is fail-closed. If no usable checkpoint backend could be
  // established, mutation is refused with a distinct error instead of
  // silently proceeding untracked. The only override is the explicit
  // operator escape hatch KONTROL_ALLOW_UNTRACKED_MUTATION (default off) —
  // automatic fallback is never acceptable for a review-safe boundary.
  async function prepareForMutation(workspaceId: string): Promise<void> {
    if (!config.widgets || config.widgets === "off") return;
    const workspace = workspaces.getWorkspace(workspaceId);
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
