/**
 * Core workspace tools: open_workspace, read, write, edit, apply_patch,
 * show_changes, structured discovery (grep/glob/ls), and bash. Tool
 * registration bodies extracted verbatim from src/mcp/workspace-server.ts
 * (P1.3); the createMcpServer closures become an explicit dependency object.
 */
import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { realpath } from "node:fs/promises";
import { brandWorkSessionId, brandWorkspaceId } from "../../branded.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../../config.js";
import type { PolicyEngine } from "../../policy.js";
import type { PolicyEnforcer } from "../../policy-enforcement.js";
import {
  editFileTool,
  writeFileTool,
} from "../../pi-tools.js";
import { inspectionMetadata, instructionContent, peerInspectionDenied, registerInspectionTools } from "./inspection.js";
import { registerMutationTools } from "./mutation.js";
import { registerGitTools } from "./git-tools.js";
import { registerLifecycleTools } from "./workspace-lifecycle.js";
import { DEFAULT_MAX_RUNTIME_MS, type ProcessSessionManager } from "../../process-sessions.js";
import { applyPatch, parsePatch } from "../../apply-patch.js";
import { getGitEligibility, git } from "../../git.js";
import { formatPathForPrompt } from "../../skills.js";
import { formatAgentsPath, type WorkspaceRegistry } from "../../workspaces.js";
import type { createReviewCheckpointManager } from "../../review-checkpoints.js";
import type { createWorkSessionManager } from "../../work-sessions.js";
import {
  approvalResumeIdSchema,
  clientMutationIdSchema,
  EDIT_TOOL_ANNOTATIONS,
  resultOutputSchema,
  reviewFileOutputSchema,
  reviewSummaryOutputSchema,
  SHELL_TOOL_ANNOTATIONS,
  workspaceAgentsFileOutputSchema,
  workspaceAvailableAgentsFileOutputSchema,
  workspaceSkillOutputSchema,
  WRITE_TOOL_ANNOTATIONS,
} from "../tool-schemas.js";
import { readMcpToolSurface, REQUIRED_INSPECTION_TOOLS, toolNames } from "../tool-names.js";
import {
  toolWidgetDescriptorMeta,
  workspaceAppRenderToolDescriptorMeta,
} from "../tool-context.js";
import {
  canonicalPolicyPath,
  enforceToolPolicy,
  policyFailureResponse,
} from "../tool-policy.js";
import {
  contentLineCount,
  contentText,
  countDiffStats,
  logFailedToolResponse,
  newFilePatch,
  textBlock,
  textSummary,
  type ToolContent,
} from "../tool-result.js";
import { logToolCall } from "../tool-logging.js";
import { runMutationBarrier } from "../mutation-barrier.js";
import { assertWorkerWorkspaceBinding, processOutputSchema, processToolResponse } from "../process-tool-response.js";
import { readOnlyShellInspectionError } from "../../read-only-shell.js";
import { publishScheduledArtifact } from "../../scheduling/scheduled-artifact-publisher.js";
import type { ToolEnvelope } from "../tool-envelope.js";
import { processSessionOwnerId, type ConnectionContext } from "../connection-context.js";
import { MISSING_FILE_VERSION, readFileVersion, withFileMutationLock } from "../../mutation-version.js";
import { assertAllowedPath, expandHomePath } from "../../roots.js";
import {
  countPeerWorktrees,
  peerMayProposePatches,
  peerOwnsWorktree,
  peerWorkspaceDenied,
  recordPeerWorktree,
} from "../../peer/workspace-guard.js";

export interface WorkspaceToolsDeps {
  readonly config: ServerConfig;
  readonly workspaces: WorkspaceRegistry;
  readonly reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>;
  readonly policyEngine?: PolicyEngine;
  readonly policyEnforcer?: PolicyEnforcer;
  readonly connectionContext?: ConnectionContext;
  readonly workSessions?: ReturnType<typeof createWorkSessionManager>;
  readonly trackToolEvent: ToolEnvelope["trackToolEvent"];
  readonly prepareForMutation: (workspaceId: string) => Promise<void>;
  readonly processSessions: ProcessSessionManager;
  readonly scheduledExecutionPolicyFor?: (workSessionId: string) => import("../../work-session-action-guard.js").ScheduledExecutionPolicy | undefined;
  readonly recordPublicationIntent?: (input: { jobId: string; intent: Record<string, unknown> }) => void;
  readonly recordPublicationReceipt?: (input: { jobId: string; receipt: Record<string, unknown> }) => void;
  readonly recordPublicationFailure?: (input: { jobId: string; receiptId: string; outcome: "rejected" | "conflict"; reason: string }) => void;
  readonly scheduledJobFor?: (workSessionId: string) => {
    id: string;
    activeDispatchAttemptId?: string;
    attemptNumber?: number;
    acpRunId?: string;
    dispatchIdempotencyKey?: string;
    policySnapshotJson: {
      allowedOutputs?: Array<{
        path?: string;
        operation?: string;
        expectedSha256?: string;
        overwrite?: string;
        expectedPreviousSha256?: string;
      }>;
    };
  } | undefined;
}



export function registerWorkspaceTools(
  server: McpServer,
  deps: WorkspaceToolsDeps,
): ReadonlySet<string> {
  const { config, workspaces, reviewCheckpoints, policyEngine, policyEnforcer, connectionContext, workSessions, trackToolEvent, prepareForMutation, processSessions, scheduledExecutionPolicyFor, recordPublicationIntent, recordPublicationReceipt, recordPublicationFailure, scheduledJobFor } = deps;
  const scheduledExecutionPolicy = (workSessionId: string | undefined) =>
    workSessionId && scheduledExecutionPolicyFor ? scheduledExecutionPolicyFor(workSessionId) : undefined;

  const registeredToolNames = new Set<string>();
  const registeredTool = (name: string): string => {
    registeredToolNames.add(name);
    return name;
  };
  for (const name of registerLifecycleTools(server, {
    config,
    workspaces,
    reviewCheckpoints,
    connectionContext,
    workSessions,
    trackToolEvent,
    processSessions,
  })) {
    registeredToolNames.add(name);
  }



  if (config.widgets !== "off") {
    registerAppTool(
      server,
      registeredTool(toolNames.showWorkspaceUi),
      {
        title: "Show workspace UI",
        description: "Open the interactive Kontrol workspace surface for an already-open workspace. Use this on demand when the user asks to inspect the workspace, approvals, activity, or review UI; routine file operations do not need to mount a widget.",
        inputSchema: {
          workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        },
      outputSchema: {
        tool: z.literal(toolNames.showWorkspaceUi),
          workspaceId: z.string(),
          root: z.string(),
          mode: z.enum(["checkout", "worktree"]),
          instruction: z.string(),
        },
        ...workspaceAppRenderToolDescriptorMeta(),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async ({ workspaceId }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
        const result = {
          tool: toolNames.showWorkspaceUi,
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          instruction: "The interactive workspace surface is now available for this workspace.",
        };
        logToolCall(config, {
          tool: toolNames.showWorkspaceUi,
          workspaceId,
          path: workspace.root,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        trackToolEvent(workspaceId, toolNames.showWorkspaceUi, {}, { content: [textBlock(result.instruction)] }, startedAt);
        return {
          content: [textBlock(result.instruction)],
          _meta: {
            tool: toolNames.showWorkspaceUi,
            card: result,
          },
          structuredContent: result,
        };
      },
    );
  }

  for (const name of registerInspectionTools(server, {
    config,
    workspaces,
    policyEngine,
    policyEnforcer,
    connectionContext,
    workSessions,
    trackToolEvent,
    scheduledExecutionPolicyFor,
  })) {
    registeredToolNames.add(name);
  }

  for (const name of registerMutationTools(server, {
    config,
    workspaces,
    reviewCheckpoints,
    policyEngine,
    policyEnforcer,
    connectionContext,
    workSessions,
    trackToolEvent,
    prepareForMutation,
    scheduledExecutionPolicyFor,
    recordPublicationIntent,
    recordPublicationReceipt,
    recordPublicationFailure,
    scheduledJobFor,
  })) {
    registeredToolNames.add(name);
  }




  for (const name of registerGitTools(server, {
    config,
    workspaces,
    policyEngine,
    policyEnforcer,
    connectionContext,
    workSessions,
    trackToolEvent,
  })) {
    registeredToolNames.add(name);
  }

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    registeredTool(toolNames.shell),
    {
      title: "Bash",
      description: `Run a shell command inside an open workspace. The request waits only for a bounded yield; a still-running child returns a sessionId and must be observed with ${toolNames.pollProcess}. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for repository inspection; do not use shell parsing to replace those structured read-only tools. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        command: z
          .string()
          .describe(
            `Shell command to run. Must not create or modify project files; use ${toolNames.edit} or ${toolNames.write} for file changes.`,
          ),
        readOnlyInspection: z.boolean().optional().describe(
          "Run only the fixed pwd/ls/read-only Git inspection allowlist. This mode bypasses baseline capture but retains workspace binding and shell policy checks. Other commands require the normal review checkpoint.",
        ),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(Math.ceil((config.processMaxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS) / 1_000))
          .optional()
          .describe(
            "Timeout in seconds: the child is terminated (SIGTERM, then SIGKILL) if still running. "
            + `Defaults to 30; the ceiling is the configured process runtime limit (${Math.ceil((config.processMaxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS) / 1_000)}s).`,
          ),
        approvalResumeId: approvalResumeIdSchema,
        clientMutationId: clientMutationIdSchema,
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const startedAt = performance.now();
      if (input.readOnlyInspection && connectionContext?.authenticatedRole === "peer") {
        return { content: [textBlock("Forbidden: peer shell inspection is unavailable; use structured read-only inspection tools.")], isError: true };
      }
      if (input.readOnlyInspection) {
        const inspectionError = readOnlyShellInspectionError(input.command);
        if (inspectionError) return { content: [textBlock(inspectionError)], isError: true };
      } else {
        // Ordinary shell commands remain mutation-capable regardless of their
        // text and cross the same checkpoint barrier as write/edit/patch.
        const blocked = await runMutationBarrier(prepareForMutation, workspaceId, toolNames.shell);
        if (blocked) return blocked;
      }
      const workspace = workspaces.getWorkspace(workspaceId);
      const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
      if (bindingErr) return bindingErr;
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const policyPath = canonicalPolicyPath(workspace.root, workingDirectory, cwd);

      // Policy enforcement: block until human approval if required
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          brandWorkspaceId(workspaceId),
          connectionContext?.workSessionId ? brandWorkSessionId(connectionContext.workSessionId) : undefined,
          connectionContext?.runId,
          toolNames.shell,
          policyPath,
          input.command,
          undefined,
          input.approvalResumeId,
          { workingDirectory, ...input },
          scheduledExecutionPolicy(connectionContext?.workSessionId),
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.shell}" denied by policy. Command: ${input.command}`, {
            tool: toolNames.shell,
            workspaceId,
            path: typeof policyPath === "string" ? policyPath : policyPath?.relativePath,
            command: input.command,
          });
        }
      }

      const newlyApplicable = workingDirectory
        ? await workspaces.loadApplicableInstructions(workspace, workingDirectory, connectionContext?.mcpSessionId)
        : [];
      const timeoutSeconds = input.timeout ?? 30;
      // A command's child lifetime is independent from the MCP request. The
      // bounded yield returns a process handle; poll_process owns later
      // observation after a gateway or connector drops the original request.
      const mutationIntentId = input.readOnlyInspection
        ? undefined
        : await reviewCheckpoints.beginMutationIntent({
          workspaceId,
          root: workspace.root,
          workSessionId: connectionContext?.workSessionId,
          paths: [],
        });
      const response: any = await (async () => {
        try {
          const snapshot = await processSessions.start({
            workspaceId,
            ownerId: processSessionOwnerId(connectionContext),
            workSessionId: connectionContext?.workSessionId,
            principalId: connectionContext?.authenticatedPrincipalId,
            command: input.command,
            readOnlyInspection: input.readOnlyInspection === true,
            cwd,
            timeoutMs: timeoutSeconds * 1_000,
            yieldTimeMs: Math.min(timeoutSeconds * 1_000, 10_000),
            clientMutationId: input.clientMutationId,
          });
          return processToolResponse("bash", workspaceId, snapshot, {
            command: input.command,
            workingDirectory: workingDirectory ?? ".",
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            wallTimeMs: snapshot.wallTimeMs,
            startedAtEpochMs: snapshot.startedAtEpochMs,
          });
        } catch (error) {
          return { content: [textBlock(error instanceof Error ? error.message : String(error))], isError: true };
        } finally {
          if (mutationIntentId) {
            await reviewCheckpoints.resolveMutationIntent({ workspaceId, operationId: mutationIntentId, outcome: "unknown" });
          }
        }
      })();

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: input.command,
          commandLength: input.command.length,
        }, response.content, startedAt);
        return response;
      }

      workspaces.acknowledgeApplicableInstructions(workspace, newlyApplicable, connectionContext?.mcpSessionId);
      const responseWithInstructions = newlyApplicable.length > 0
        ? { ...response, content: [...instructionContent(newlyApplicable, workspace.root), ...response.content] }
        : response;
      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(responseWithInstructions.content),
      };
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      trackToolEvent(workspaceId, toolNames.shell, input, response, startedAt);

      return {
        ...responseWithInstructions,
        _meta: {
          ...(responseWithInstructions._meta ?? {}),
          tool: toolNames.shell,
          card: {
            ...(response._meta?.card ?? {}),
            workspaceId,
            path: workingDirectory,
            summary,
          },
        },
      };
    },
  );
  }

  return registeredToolNames;
}
