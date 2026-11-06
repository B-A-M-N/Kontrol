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
import { MISSING_FILE_VERSION, readFileVersion, withFileMutationLock, workspaceMutationLockKey } from "../../mutation-version.js";
import { assertAllowedPath, expandHomePath } from "../../roots.js";
import {
  countPeerWorktrees,
  peerMayProposePatches,
  peerOwnsWorktree,
  peerWorkspaceDenied,
  recordPeerWorktree,
} from "../../peer/workspace-guard.js";

export interface MutationToolsDeps {
  readonly config: ServerConfig;
  readonly workspaces: WorkspaceRegistry;
  readonly reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>;
  readonly policyEngine?: PolicyEngine;
  readonly policyEnforcer?: PolicyEnforcer;
  readonly connectionContext?: ConnectionContext;
  readonly workSessions?: ReturnType<typeof createWorkSessionManager>;
  readonly trackToolEvent: ToolEnvelope["trackToolEvent"];
  readonly prepareForMutation: (workspaceId: string) => Promise<void>;
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

function hashInstructionContent(files: Array<{ path: string; content: string }>): string {
  return createHash("sha256")
    .update(files.map((file) => `${file.path}\0${file.content}`).sort().join("\n"))
    .digest("hex");
}

function instructionsRequiredResponse(
  tool: string,
  files: Array<{ path: string; content: string }>,
  root: string,
  workspaceId: string,
  path: string | undefined,
  content: string,
) {
  const hash = hashInstructionContent(files);
  return {
    content: [...instructionContent(files, root), textBlock(content)],
    _meta: { tool, card: { workspaceId, path, status: "instructions_required", summary: { instructionContentHash: hash, files: files.length } } },
    structuredContent: { tool, status: "instructions_required", instructionsRequired: true, instructionContentHash: hash, result: contentText([...instructionContent(files, root), textBlock(content)]) },
  };
}

function fileVersionConflictResponse(
  tool: string,
  workspaceId: string,
  path: string,
  expected: string,
  actual: string,
) {
  const message = actual === MISSING_FILE_VERSION
    ? `File version conflict for ${path}: the file is missing, but the mutation expected version ${expected}. No files were changed.`
    : `File version conflict for ${path}: expected ${expected}, found ${actual}. Re-read the file and retry with its current contentSha256. No files were changed.`;
  return {
    content: [textBlock(message)],
    isError: true,
    _meta: {
      tool,
      card: {
        tool,
        workspaceId,
        path,
        status: "file_version_conflict",
        summary: { status: "file_version_conflict", expectedContentSha256: expected, actualContentSha256: actual },
      },
    },
    structuredContent: {
      tool,
      status: "file_version_conflict",
      retryable: false,
      path,
      expectedContentSha256: expected,
      actualContentSha256: actual,
      result: message,
    },
  };
}

function fileVersionPreconditionRequiredResponse(
  tool: string,
  workspaceId: string,
  paths: string[],
) {
  const message = `Guarded ${tool} requires contentSha256 for every affected path: ${paths.join(", ")}. No files were changed.`;
  return {
    content: [textBlock(message)],
    isError: true,
    _meta: {
      tool,
      card: {
        tool,
        workspaceId,
        path: paths[0],
        status: "file_version_precondition_required",
        summary: { status: "file_version_precondition_required", paths },
      },
    },
    structuredContent: {
      tool,
      status: "file_version_precondition_required",
      retryable: false,
      paths,
      result: message,
    },
  };
}

async function checkFileVersion(
  tool: string,
  workspaceId: string,
  path: string,
  expected: string | undefined,
) {
  if (expected === undefined) return null;
  const actual = await readFileVersion(path);
  return actual === expected ? null : fileVersionConflictResponse(tool, workspaceId, path, expected, actual);
}

type FileVersionConflict = ReturnType<typeof fileVersionConflictResponse>;
type LockedToolMutation<T> =
  | { versionConflict: FileVersionConflict }
  | { response: T; contentSha256: string | undefined };
type LockedPatchMutation =
  | { versionConflict: FileVersionConflict }
  | { applied: Awaited<ReturnType<typeof applyPatch>> };

export function registerMutationTools(
  server: McpServer,
  deps: MutationToolsDeps,
): string[] {
  const { config, workspaces, reviewCheckpoints, policyEngine, policyEnforcer, connectionContext, workSessions, trackToolEvent, prepareForMutation, scheduledExecutionPolicyFor, recordPublicationIntent, recordPublicationReceipt, recordPublicationFailure, scheduledJobFor } = deps;
  const scheduledExecutionPolicy = (workSessionId: string | undefined) =>
    workSessionId && scheduledExecutionPolicyFor ? scheduledExecutionPolicyFor(workSessionId) : undefined;
  const names: string[] = [];
  const registeredTool = (name: string): string => {
    names.push(name);
    return name;
  };
  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    registeredTool(toolNames.stagedWrite),
    {
      title: "Staged file write",
      description: "Publish one signed bounded-write artifact through Kontrol's durable artifact publisher. Callable only by the signed worker bound to an active bounded-write scheduled job.",
      inputSchema: {
        workspaceId: z.string().describe("Signed worker's registered workspace identifier."),
        path: z.string().describe("Exactly one authorized output path, relative to the workspace root."),
        content: z.string().describe("Complete artifact content."),
      },
      outputSchema: resultOutputSchema({
        contentSha256: z.string().optional(),
        publicationReceipt: z.record(z.string(), z.unknown()).optional(),
      }),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      if (connectionContext?.authenticatedRole !== "worker" || !connectionContext.workSessionId) {
        return { content: [textBlock("Forbidden: staged_file_write requires a signed bounded-write worker.")], isError: true };
      }
      const workSessionId = connectionContext.workSessionId;
      const scheduledPolicy = scheduledExecutionPolicy(workSessionId);
      if (scheduledPolicy?.executionMode !== "bounded_file_write" || scheduledPolicy.workspaceAccess !== "staged_write" || scheduledPolicy.mutate !== true) {
        return { content: [textBlock("Forbidden: staged_file_write requires an active bounded-write scheduled job.")], isError: true };
      }
      const scheduledJob = scheduledJobFor?.(workSessionId);
      if (!scheduledJob) {
        return { content: [textBlock("Forbidden: no scheduled job is bound to this worker.")], isError: true };
      }
      if (!scheduledJob.activeDispatchAttemptId || !Number.isSafeInteger(scheduledJob.attemptNumber) || (scheduledJob.attemptNumber ?? 0) < 1
        || !scheduledJob.acpRunId || !scheduledJob.dispatchIdempotencyKey) {
        return { content: [textBlock("Forbidden: the active ACP attempt identity is not durably bound.")], isError: true };
      }
      const authorizedOutput = Array.isArray(scheduledJob.policySnapshotJson.allowedOutputs)
        ? scheduledJob.policySnapshotJson.allowedOutputs.find((output) => output?.path === input.path)
        : undefined;
      if (!authorizedOutput) {
        return { content: [textBlock(`Forbidden: path "${input.path}" is not an authorized output.`)], isError: true };
      }
      if (!recordPublicationIntent || !recordPublicationReceipt || !recordPublicationFailure) {
        return { content: [textBlock("Internal error: scheduled publication durability is unavailable.")], isError: true };
      }
      const workspace = workspaces.getWorkspace(workspaceId);
      const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
      if (bindingErr) return bindingErr;
      const blocked = await runMutationBarrier(prepareForMutation, workspaceId, toolNames.stagedWrite);
      if (blocked) return blocked;
      const resolvedPath = workspaces.resolvePath(workspace, input.path);
      const publication = await withFileMutationLock<LockedToolMutation<Awaited<ReturnType<typeof writeFileTool>>>>([resolvedPath, workspaceMutationLockKey(workspace.root)], async (): Promise<LockedToolMutation<Awaited<ReturnType<typeof writeFileTool>>>> => {
        const receipt = await publishScheduledArtifact({
          jobId: scheduledJob.id,
          workSessionId,
          workspaceRoot: workspace.root,
          path: input.path,
          content: Buffer.from(input.content, "utf8"),
          attemptId: scheduledJob.activeDispatchAttemptId,
          attemptNumber: scheduledJob.attemptNumber,
          runId: scheduledJob.acpRunId,
          dispatchIdempotencyKey: scheduledJob.dispatchIdempotencyKey,
          recordPublicationIntent: (intent) => recordPublicationIntent({ jobId: scheduledJob.id, intent }),
          recordPublicationReceipt: (receipt) => recordPublicationReceipt({ jobId: scheduledJob.id, receipt: receipt as unknown as Record<string, unknown> }),
          recordPublicationFailure: (receiptId, outcome, reason) => recordPublicationFailure({ jobId: scheduledJob.id, receiptId, outcome, reason }),
          output: {
            path: input.path,
            operation: (authorizedOutput.operation === "replace" ? "replace" : "create") as "create" | "replace",
            ...(authorizedOutput.expectedSha256 ? { expectedSha256: authorizedOutput.expectedSha256 } : {}),
            overwrite: (authorizedOutput.overwrite === "expected_hash" ? "expected_hash" : "deny") as "deny" | "expected_hash",
            ...(authorizedOutput.expectedPreviousSha256 ? { expectedPreviousSha256: authorizedOutput.expectedPreviousSha256 } : {}),
          },
        });
        if (receipt.outcome !== "committed") {
          const response: Awaited<ReturnType<typeof writeFileTool>> = {
            content: [{ type: "text", text: `Artifact publication ${receipt.outcome}: ${receipt.reason ?? "unknown"}` }],
            isError: true,
          };
          return { response, contentSha256: undefined };
        }
        return {
          response: { content: [{ type: "text", text: `Published ${input.path} (sha256: ${receipt.sha256}, read-back verified).` }], isError: false },
          contentSha256: receipt.sha256,
        };
      });
      if ("versionConflict" in publication) return publication.versionConflict;
      const response = publication.response;
      if (response.isError) {
        logFailedToolResponse(config, { tool: toolNames.stagedWrite, workspaceId, path: input.path }, response.content, startedAt);
        return response;
      }
      const patch = newFilePatch(input.path, input.content);
      const summary = { ...countDiffStats(patch), lines: contentLineCount(input.content), characters: input.content.length };
      logToolCall(config, { tool: toolNames.stagedWrite, workspaceId, path: input.path, success: true, durationMs: Math.round(performance.now() - startedAt) });
      trackToolEvent(workspaceId, toolNames.stagedWrite, input, response, startedAt);
      return {
        ...response,
        _meta: {
          tool: toolNames.stagedWrite,
          card: { workspaceId, path: input.path, summary: { ...summary, contentSha256: publication.contentSha256 } },
        },
        structuredContent: {
          tool: toolNames.stagedWrite,
          result: contentText(response.content),
          contentSha256: publication.contentSha256,
        },
      };
    },
  );

  registerAppTool(
    server,
    registeredTool(toolNames.write),
    {
      title: "Write file",
      description:
        `Create or completely overwrite a file inside an open workspace. Prefer ${toolNames.edit} for targeted changes to existing files. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
        expectedContentSha256: z
          .string()
          .regex(/^(missing|[a-f0-9]{64})$/)
          .optional()
          .describe("Optional optimistic precondition from read.contentSha256. Use missing when the file was absent. The write is rejected if the current version differs."),
        approvalResumeId: approvalResumeIdSchema,
        instructionContentHash: z.string().optional().describe("On a retry after instructions_required, must match the returned instruction hash."),
      },
      outputSchema: resultOutputSchema({
        instructionsRequired: z.boolean().optional(),
        instructionContentHash: z.string().optional(),
        contentSha256: z.string().optional(),
      }),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, expectedContentSha256, ...input }) => {
      const startedAt = performance.now();
      const blocked = await runMutationBarrier(prepareForMutation, workspaceId, toolNames.write);
      if (blocked) return blocked;
      const workspace = workspaces.getWorkspace(workspaceId);
      const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
      if (bindingErr) return bindingErr;
      const scheduledPolicy = scheduledExecutionPolicy(connectionContext?.workSessionId);
      const stagedWrite = scheduledPolicy?.executionMode === "bounded_file_write";
      const writeTool = stagedWrite ? toolNames.stagedWrite : toolNames.write;
      const scheduledJob = stagedWrite && connectionContext?.workSessionId
        ? scheduledJobFor?.(connectionContext.workSessionId)
        : undefined;
      const authorizedOutput = stagedWrite && scheduledJob
        ? scheduledJob.policySnapshotJson.allowedOutputs?.find((output) => output?.path === input.path)
        : undefined;
      if (stagedWrite) {
        if (scheduledPolicy?.workspaceAccess !== "staged_write"
          || scheduledPolicy.mutate !== true
          || !Array.isArray(scheduledPolicy.allowedOutputs)) {
          return { content: [textBlock("Forbidden: bounded-write execution policy is invalid.")], isError: true };
        }
        if (!scheduledJob) {
          return { content: [textBlock("Forbidden: no scheduled job is bound to this worker.")], isError: true };
        }
        if (!authorizedOutput) {
          return { content: [textBlock(`Forbidden: path "${input.path}" is not an authorized output.`)], isError: true };
        }
        if (!scheduledJob.activeDispatchAttemptId
          || !Number.isSafeInteger(scheduledJob.attemptNumber)
          || (scheduledJob.attemptNumber ?? 0) < 1
          || !scheduledJob.acpRunId || !scheduledJob.dispatchIdempotencyKey) {
          return { content: [textBlock("Forbidden: the active ACP attempt identity is not durably bound.")], isError: true };
        }
        if (!recordPublicationIntent || !recordPublicationReceipt || !recordPublicationFailure) {
          return { content: [textBlock("Internal error: scheduled publication durability is unavailable.")], isError: true };
        }
      }
      const resolvedPath = workspaces.resolvePath(workspace, input.path);
      const policyPath = canonicalPolicyPath(workspace.root, input.path, resolvedPath);

      const newlyApplicable = await workspaces.loadApplicableInstructions(workspace, input.path, connectionContext?.mcpSessionId);
      if (newlyApplicable.length > 0 && input.instructionContentHash !== hashInstructionContent(newlyApplicable)) {
        return instructionsRequiredResponse(writeTool, newlyApplicable, workspace.root, workspaceId, input.path, `Read and acknowledge the returned instructions, then retry write with instructionContentHash="${hashInstructionContent(newlyApplicable)}". No file was changed.`);
      }

      // Policy enforcement for file writes
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          brandWorkspaceId(workspaceId),
          connectionContext?.workSessionId ? brandWorkSessionId(connectionContext.workSessionId) : undefined,
          connectionContext?.runId,
            writeTool,
            policyPath,
            undefined,
            undefined,
            input.approvalResumeId,
            { expectedContentSha256, ...input },
            scheduledExecutionPolicy(connectionContext?.workSessionId),
          );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${writeTool}" denied by policy. Path: ${input.path}`, {
            tool: writeTool,
            workspaceId,
            path: input.path,
          });
        }
      }

      let mutation: LockedToolMutation<Awaited<ReturnType<typeof writeFileTool>>>;
      if (stagedWrite) {
        const activeJob = scheduledJob!;
        const output = authorizedOutput!;
        // Bounded scheduled writes route through the publisher for atomic
        // replacement, symlink-escape rejection, and read-back verification.
        mutation = await withFileMutationLock<LockedToolMutation<Awaited<ReturnType<typeof writeFileTool>>>>([resolvedPath, workspaceMutationLockKey(workspace.root)], async (): Promise<LockedToolMutation<Awaited<ReturnType<typeof writeFileTool>>>> => {
          const receipt = await publishScheduledArtifact({
            jobId: activeJob.id,
            workSessionId: connectionContext?.workSessionId ?? "",
            workspaceRoot: workspace.root,
            path: input.path,
            content: Buffer.from(input.content, "utf8"),
            attemptId: activeJob.activeDispatchAttemptId,
            attemptNumber: activeJob.attemptNumber,
            runId: activeJob.acpRunId,
            dispatchIdempotencyKey: activeJob.dispatchIdempotencyKey,
            recordPublicationIntent: (intent) => recordPublicationIntent!({ jobId: activeJob.id, intent }),
            recordPublicationReceipt: (receipt) => recordPublicationReceipt!({ jobId: activeJob.id, receipt: receipt as unknown as Record<string, unknown> }),
            recordPublicationFailure: (receiptId, outcome, reason) => recordPublicationFailure!({ jobId: activeJob.id, receiptId, outcome, reason }),
            output: {
              path: input.path,
              operation: (output.operation === "replace" ? "replace" : "create") as "create" | "replace",
              ...(output.expectedSha256 ? { expectedSha256: output.expectedSha256 } : {}),
              overwrite: (output.overwrite === "expected_hash" ? "expected_hash" : "deny") as "deny" | "expected_hash",
              ...(output.expectedPreviousSha256 ? { expectedPreviousSha256: output.expectedPreviousSha256 } : {}),
            },
          });
          if (receipt.outcome !== "committed") {
            const response: Awaited<ReturnType<typeof writeFileTool>> = {
              content: [{ type: "text", text: `Artifact publication ${receipt.outcome}: ${receipt.reason ?? "unknown"}` }],
              isError: true,
            };
            return { response, contentSha256: undefined };
          }
          return {
            response: { content: [{ type: "text", text: `Published ${input.path} (sha256: ${receipt.sha256}, read-back verified).` }], isError: false },
            contentSha256: receipt.sha256,
          };
        });
      } else {
        mutation = await withFileMutationLock<LockedToolMutation<Awaited<ReturnType<typeof writeFileTool>>>>([resolvedPath, workspaceMutationLockKey(workspace.root)], async (): Promise<LockedToolMutation<Awaited<ReturnType<typeof writeFileTool>>>> => {
          const versionConflict = await checkFileVersion(
            writeTool,
            workspaceId,
            resolvedPath,
            expectedContentSha256,
          );
          if (versionConflict) return { versionConflict } as const;
          const response = await writeFileTool(input, {
            cwd: workspace.root,
            root: workspace.root,
          });
          if (response.isError) return { response, contentSha256: undefined } as const;
          return { response, contentSha256: await readFileVersion(resolvedPath) } as const;
        });
      }
      if ("versionConflict" in mutation) return mutation.versionConflict;
      const response = mutation.response;

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: writeTool,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      // P1 (audit): record the structured mutation path so the next review
      // submission can state whether the checkpoint represents it.
      await reviewCheckpoints.recordMutations({ workspaceId, root: workspace.root, workSessionId: connectionContext?.workSessionId, paths: [input.path] });

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: writeTool,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      workspaces.acknowledgeApplicableInstructions(workspace, newlyApplicable, connectionContext?.mcpSessionId);
      const responseWithInstructions = newlyApplicable.length > 0
        ? { ...response, content: [...instructionContent(newlyApplicable, workspace.root), ...response.content] }
        : response;
      const contentSha256 = mutation.contentSha256;
      trackToolEvent(workspaceId, writeTool, input, responseWithInstructions, startedAt);

      return {
        ...responseWithInstructions,
        _meta: {
          tool: writeTool,
          card: {
            workspaceId,
            path: input.path,
            summary: { ...summary, contentSha256 },
            payload: {
              content: responseWithInstructions.content,
              patch,
            },
          },
        },
        structuredContent: {
          tool: writeTool,
          result: contentText(responseWithInstructions.content),
          contentSha256,
        },
      };
    },
  );

  registerAppTool(
    server,
    registeredTool(toolNames.edit),
    {
      title: "Edit file",
      description:
        `Edit one file inside an open workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
        expectedContentSha256: z
          .string()
          .regex(/^(missing|[a-f0-9]{64})$/)
          .optional()
          .describe("Optional optimistic precondition from read.contentSha256. The edit is rejected if the current file version differs."),
        approvalResumeId: approvalResumeIdSchema,
        instructionContentHash: z.string().optional().describe("On a retry after instructions_required, must match the returned instruction hash."),
      },
      outputSchema: resultOutputSchema({
        instructionsRequired: z.boolean().optional(),
        instructionContentHash: z.string().optional(),
        contentSha256: z.string().optional(),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, expectedContentSha256, ...input }) => {
      const startedAt = performance.now();
      const blocked = await runMutationBarrier(prepareForMutation, workspaceId, toolNames.write);
      if (blocked) return blocked;
      const workspace = workspaces.getWorkspace(workspaceId);
      const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
      if (bindingErr) return bindingErr;
      const resolvedPath = workspaces.resolvePath(workspace, input.path);
      const policyPath = canonicalPolicyPath(workspace.root, input.path, resolvedPath);

      const newlyApplicable = await workspaces.loadApplicableInstructions(workspace, input.path, connectionContext?.mcpSessionId);
      if (newlyApplicable.length > 0 && input.instructionContentHash !== hashInstructionContent(newlyApplicable)) {
        return instructionsRequiredResponse(toolNames.edit, newlyApplicable, workspace.root, workspaceId, input.path, `Read and acknowledge the returned instructions, then retry edit with instructionContentHash="${hashInstructionContent(newlyApplicable)}". No file was changed.`);
      }

      // Policy enforcement for file edits
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          brandWorkspaceId(workspaceId),
          connectionContext?.workSessionId ? brandWorkSessionId(connectionContext.workSessionId) : undefined,
          connectionContext?.runId,
            toolNames.edit,
            policyPath,
            undefined,
            undefined,
            input.approvalResumeId,
            { expectedContentSha256, ...input },
            scheduledExecutionPolicy(connectionContext?.workSessionId),
          );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.edit}" denied by policy. Path: ${input.path}`, {
            tool: toolNames.edit,
            workspaceId,
            path: input.path,
          });
        }
      }

      const mutation = await withFileMutationLock<LockedToolMutation<Awaited<ReturnType<typeof editFileTool>>>>([resolvedPath, workspaceMutationLockKey(workspace.root)], async (): Promise<LockedToolMutation<Awaited<ReturnType<typeof editFileTool>>>> => {
        const versionConflict = await checkFileVersion(
          toolNames.edit,
          workspaceId,
          resolvedPath,
          expectedContentSha256,
        );
        if (versionConflict) return { versionConflict } as const;
        const response = await editFileTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });
        if (response.isError) return { response, contentSha256: undefined } as const;
        return { response, contentSha256: await readFileVersion(resolvedPath) } as const;
      });
      if ("versionConflict" in mutation) return mutation.versionConflict;
      const response = mutation.response;

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      // P1 (audit): record the structured mutation path so the next review
      // submission can state whether the checkpoint represents it.
      await reviewCheckpoints.recordMutations({ workspaceId, root: workspace.root, workSessionId: connectionContext?.workSessionId, paths: [input.path] });

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [...instructionContent(newlyApplicable, workspace.root), textBlock(editResultText)];
      const contentSha256 = mutation.contentSha256;
      workspaces.acknowledgeApplicableInstructions(workspace, newlyApplicable, connectionContext?.mcpSessionId);
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      trackToolEvent(workspaceId, toolNames.edit, { ...input, path: input.path }, response, startedAt);

      return {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary: { ...summary, contentSha256 },
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          tool: toolNames.edit,
          status: "applied",
          result: contentText(editContent),
          contentSha256,
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    registerAppTool(
      server,
      registeredTool("apply_patch"),
      {
        title: "Apply patch",
        description:
          "Apply one Codex-style patch inside an open workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          patch: z
            .string()
            .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
          expectedContentSha256ByPath: z
            .record(z.string(), z.string().regex(/^(missing|[a-f0-9]{64})$/))
            .optional()
            .describe("Optional optimistic preconditions keyed by every patch path. Values come from read.contentSha256; use missing for paths that were absent. If supplied, every affected source and destination path must be included."),
          approvalResumeId: approvalResumeIdSchema,
          instructionContentHash: z.string().optional().describe("On a retry after instructions_required, must match the returned instruction hash."),
        },
        outputSchema: resultOutputSchema({
          instructionsRequired: z.boolean().optional(),
          instructionContentHash: z.string().optional(),
          contentSha256ByPath: z.record(z.string(), z.string()).optional(),
          additions: z.number(),
          removals: z.number(),
          files: z.array(
            z.object({
              path: z.string(),
              previousPath: z.string().optional(),
              operation: z.enum(["add", "update", "delete", "move"]),
            }),
          ),
        }),
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, patch, expectedContentSha256ByPath, approvalResumeId, instructionContentHash }) => {
        const startedAt = performance.now();
        const blocked = await runMutationBarrier(prepareForMutation, workspaceId, "apply_patch");
        if (blocked) return blocked;
        const workspace = workspaces.getWorkspace(workspaceId);
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
        const actions = parsePatch(patch) as Array<{ path: string; moveTo?: string }>;
        const affectedPaths = [...new Set(actions.flatMap((action) => [action.path, action.moveTo].filter((path): path is string => Boolean(path))))];
        const policyPaths = affectedPaths.map((path) => canonicalPolicyPath(
          workspace.root,
          path,
          workspaces.resolvePath(workspace, path),
        ));

        const newlyApplicable = [];
        for (const action of actions) {
          newlyApplicable.push(...await workspaces.loadApplicableInstructions(workspace, action.path, connectionContext?.mcpSessionId));
          if (action.moveTo) newlyApplicable.push(...await workspaces.loadApplicableInstructions(workspace, action.moveTo, connectionContext?.mcpSessionId));
        }
        const uniqueInstructions = [...new Map(newlyApplicable.map((file) => [file.path, file])).values()];
        const expectedInstructionHash = hashInstructionContent(uniqueInstructions);
        if (uniqueInstructions.length > 0 && instructionContentHash !== expectedInstructionHash) {
          return instructionsRequiredResponse("apply_patch", uniqueInstructions, workspace.root, workspaceId, affectedPaths[0], `Read and acknowledge the returned instructions, then retry apply_patch with instructionContentHash="${expectedInstructionHash}". No files were changed.`);
        }

        // Policy enforcement (P0 #3): Codex apply_patch is an edit_files action
        // and must be gated exactly like the ordinary `write`/`edit` tools.
        if (policyEnforcer && policyEngine) {
          const approved = await enforceToolPolicy(
            workSessions,
            policyEnforcer,
            brandWorkspaceId(workspaceId),
            connectionContext?.workSessionId ? brandWorkSessionId(connectionContext.workSessionId) : undefined,
            connectionContext?.runId,
            "apply_patch",
            undefined,
            undefined,
            policyPaths,
            approvalResumeId,
            { patch, expectedContentSha256ByPath },
            scheduledExecutionPolicy(connectionContext?.workSessionId),
          );
          if (!approved.allowed) {
            return policyFailureResponse(approved, `Tool "apply_patch" denied by policy.`, {
              tool: "apply_patch",
              workspaceId,
              path: affectedPaths[0],
            });
          }
        }

        if (expectedContentSha256ByPath) {
          const missingPreconditions = affectedPaths.filter((path) => expectedContentSha256ByPath[path] === undefined);
          if (missingPreconditions.length > 0) {
            return fileVersionPreconditionRequiredResponse("apply_patch", workspaceId, missingPreconditions);
          }
        }

        // Load instructions for every path named by the patch before any file
        // is changed. parsePatch is validation-only; applyPatch revalidates all
        // confined destinations immediately before staging/rename.
        const mutation = await withFileMutationLock<LockedPatchMutation>(
          [workspaceMutationLockKey(workspace.root), ...affectedPaths.map((path) => workspaces.resolvePath(workspace, path))],
          async (): Promise<LockedPatchMutation> => {
            if (expectedContentSha256ByPath) {
              for (const path of affectedPaths) {
                const versionConflict = await checkFileVersion(
                  "apply_patch",
                  workspaceId,
                  workspaces.resolvePath(workspace, path),
                  expectedContentSha256ByPath[path],
                );
                if (versionConflict) return { versionConflict } as const;
              }
            }
            return { applied: await applyPatch(workspace.root, patch) } as const;
          },
        );
        if ("versionConflict" in mutation) return mutation.versionConflict;
        const applied = mutation.applied;
        // P1 (audit): record every path the patch touched (including move
        // destinations) so the next review submission can state whether the
        // checkpoint represents it.
        await reviewCheckpoints.recordMutations({
          workspaceId,
          root: workspace.root,
          workSessionId: connectionContext?.workSessionId,
          paths: applied.files.map((file) => file.previousPath ?? file.path),
        });
        const paths = applied.files.map((file) => file.path).join(", ");
        const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
        workspaces.acknowledgeApplicableInstructions(workspace, newlyApplicable, connectionContext?.mcpSessionId);
        const content = [...instructionContent(newlyApplicable, workspace.root), textBlock(result)];
        const contentSha256ByPath = Object.fromEntries(await Promise.all(
          affectedPaths.map(async (path) => [path, await readFileVersion(workspaces.resolvePath(workspace, path))] as const),
        ));
        const displayPath = applied.files.length === 1
          ? applied.files[0]?.path
          : `${applied.files.length} files`;

        logToolCall(config, {
          tool: "apply_patch",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        trackToolEvent(workspaceId, "apply_patch", { patch: patch.slice(0, 500) }, { content, isError: false }, startedAt);

        return {
          content,
          _meta: {
            tool: "apply_patch",
            card: {
              workspaceId,
              path: displayPath,
              summary: {
                files: applied.files.length,
                additions: applied.additions,
                removals: applied.removals,
              },
              payload: { patch: applied.patch, contentSha256ByPath },
            },
          },
          structuredContent: {
            tool: "apply_patch",
            result,
            additions: applied.additions,
            removals: applied.removals,
            files: applied.files,
            contentSha256ByPath,
          },
        };
      },
    );
  }

  return names;
}
