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
import { DEFAULT_MAX_RUNTIME_MS, type ProcessSessionManager } from "../../process-sessions.js";
import { applyPatch, parsePatch } from "../../apply-patch.js";
import { git } from "../../git.js";
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

export interface GitToolsDeps {
  readonly config: ServerConfig;
  readonly workspaces: WorkspaceRegistry;
  readonly policyEngine?: PolicyEngine;
  readonly policyEnforcer?: PolicyEnforcer;
  readonly connectionContext?: ConnectionContext;
  readonly workSessions?: ReturnType<typeof createWorkSessionManager>;
  readonly trackToolEvent: ToolEnvelope["trackToolEvent"];
}

function gitPathArg(workspaces: WorkspaceRegistry, workspace: ReturnType<WorkspaceRegistry["getWorkspace"]>, path?: string): string[] {
  if (path === undefined || path === "") return [];
  const resolved = workspaces.resolvePath(workspace, path);
  const relativePath = workspace.root === resolved ? "." : relative(workspace.root, resolved);
  return ["--", relativePath || "."];
}

export function registerGitTools(
  server: McpServer,
  deps: GitToolsDeps,
): string[] {
  const { config, workspaces, policyEngine, policyEnforcer, connectionContext, workSessions, trackToolEvent } = deps;
  const names: string[] = [];
  const registeredTool = (name: string): string => {
    names.push(name);
    return names[names.length - 1];
  };
  const registerGitInspection = (
    name: typeof toolNames.gitStatus | typeof toolNames.gitLog | typeof toolNames.gitDiff | typeof toolNames.gitShow,
    title: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    run: (workspaceRoot: string, path: string | undefined, input: Record<string, unknown>) => Promise<string>,
  ) => {
    registerAppTool(server, registeredTool(name), {
      title,
      description,
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        path: z.string().optional().describe("Optional path relative to the workspace root."),
        ...inputSchema,
        approvalResumeId: approvalResumeIdSchema,
      },
      outputSchema: resultOutputSchema({
        truncated: z.boolean().optional(), returnedLines: z.number().int().optional(),
        characters: z.number().int().optional(), bytes: z.number().int().optional(),
      }),
      _meta: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async ({ workspaceId, path: requestedPath, ...input }) => {
      const startedAt = performance.now();
      const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
      if (bindingErr) return bindingErr;
      const workspace = workspaces.getWorkspace(workspaceId);
      const pathArgs = gitPathArg(workspaces, workspace, requestedPath);
      const absolutePath = requestedPath !== undefined ? workspaces.resolvePath(workspace, requestedPath) : undefined;
      {
        const peerDenied = peerInspectionDenied(connectionContext, config, workspace, absolutePath);
        if (peerDenied) return peerDenied;
      }
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          brandWorkspaceId(workspaceId),
          connectionContext?.workSessionId ? brandWorkSessionId(connectionContext.workSessionId) : undefined,
          connectionContext?.runId,
          toolNames.read,
          canonicalPolicyPath(workspace.root, requestedPath, absolutePath),
          undefined,
          undefined,
          input.approvalResumeId as string | undefined,
          { path: requestedPath, ...input },
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${name}" denied by read policy. Path: ${requestedPath ?? "."}`, {
            tool: name,
            workspaceId,
            path: requestedPath,
          });
        }
      }
      const newlyApplicable = requestedPath
        ? await workspaces.loadApplicableInstructions(workspace, requestedPath, connectionContext?.mcpSessionId)
        : [];
      const output = await run(workspace.root, pathArgs.length ? pathArgs[pathArgs.length - 1] : undefined, input as Record<string, unknown>);
      workspaces.acknowledgeApplicableInstructions(workspace, newlyApplicable, connectionContext?.mcpSessionId);
      const responseContent = newlyApplicable.length > 0
        ? [...instructionContent(newlyApplicable, workspace.root), textBlock(output)]
        : [textBlock(output)];
      const inspection = inspectionMetadata(responseContent, undefined);
      const content = inspection.content;
      logToolCall(config, { tool: name, workspaceId, path: requestedPath, success: true, durationMs: Math.round(performance.now() - startedAt) });
      trackToolEvent(workspaceId, name, { path: requestedPath, ...input }, { content, isError: false }, startedAt);
      return {
        content,
        structuredContent: {
          tool: name,
          result: contentText(content),
          truncated: inspection.truncated,
          returnedLines: inspection.returnedLines,
          characters: inspection.characters,
          bytes: inspection.bytes,
        },
        _meta: { tool: name, card: { workspaceId, path: requestedPath, summary: { truncated: inspection.truncated, returnedLines: inspection.returnedLines, characters: inspection.characters, bytes: inspection.bytes } } },
      };
    });
  };

  const boundedGitText = (result: Awaited<ReturnType<typeof git>>, emptyText: string): string => {
    const output = result.stdout || emptyText;
    return result.stdoutTruncated
      ? `${output}\n\n[Truncated: Git inspection output exceeded its bounded capture.]`
      : output;
  };

  registerGitInspection(toolNames.gitStatus, "Git status", "Read-only short Git status for an open workspace; never requires shell approval.", {}, async (root, path) => {
    // Report untracked directories as entries instead of expanding every
    // nested file. The bounded Git capture also prevents huge status output
    // from failing before MCP can return a truncation marker.
    const result = await git(root, ["status", "--short", "--branch", "--untracked-files=normal", ...(path ? ["--", path] : [])], { maxOutputBytes: 45_000, timeoutMs: 15_000 });
    return boundedGitText(result, "(clean)");
  });
  registerGitInspection(toolNames.gitLog, "Git log", "Read-only bounded Git history for an open workspace.", { limit: z.number().int().min(1).max(100).optional() }, async (root, path, input) => {
    const limit = Number(input.limit ?? 20);
    const result = await git(root, ["log", `--max-count=${limit}`, "--date=iso-strict", "--format=%H%x09%ad%x09%an%x09%s", ...(path ? ["--", path] : [])], { maxOutputBytes: 45_000, timeoutMs: 15_000 });
    return boundedGitText(result, "(no commits)");
  });
  registerGitInspection(toolNames.gitDiff, "Git diff", "Read-only unified diff for an open workspace. Use git show for committed file content.", { staged: z.boolean().optional() }, async (root, path, input) => {
    const args = ["diff", "--no-ext-diff", "--unified=3"];
    if (input.staged === true) args.push("--cached");
    if (path) args.push("--", path);
    const result = await git(root, args, { maxOutputBytes: 45_000, timeoutMs: 15_000 });
    return boundedGitText(result, "(no diff)");
  });
  registerGitInspection(toolNames.gitShow, "Git show", "Read-only bounded Git view for an open workspace. With path, returns the file or tree object at the selected revision; without path, returns revision metadata and stats.", { revision: z.string().regex(/^[A-Za-z0-9._/~^@{}-]+$/).default("HEAD") }, async (root, path, input) => {
    const revision = String(input.revision ?? "HEAD");
    const args = ["show", "--no-ext-diff", "--no-textconv"];
    if (path) args.push(`${revision}:${path}`);
    else args.push("--format=fuller", "--no-patch", "--stat", revision);
    const result = await git(root, args, { maxOutputBytes: 45_000, timeoutMs: 15_000 });
    return boundedGitText(result, path ? "" : "(empty object)");
  });

  return names;
}
