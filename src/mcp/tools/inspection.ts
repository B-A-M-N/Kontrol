/**
 * Inspection tool registrations (read, grep, glob, ls) extracted verbatim from
 * `src/mcp/tools/workspace.ts`.
 *
 * Schemas, tool names, authorization checks, instruction handling, and result
 * shaping are unchanged; this module only owns the registration bodies for
 * read-only inspection. Shared helpers used by other registrars
 * (`instructionContent`, truncation metadata) live here and are re-exported.
 */
import * as z from "zod/v4";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../../config.js";
import type { PolicyEngine } from "../../policy.js";
import type { PolicyEnforcer } from "../../policy-enforcement.js";
import { brandWorkSessionId, brandWorkspaceId } from "../../branded.js";
import {
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileSnapshotTool,
} from "../../pi-tools.js";
import { formatAgentsPath, type WorkspaceRegistry } from "../../workspaces.js";
import type { createWorkSessionManager } from "../../work-sessions.js";
import type { ScheduledExecutionPolicy } from "../../work-session-action-guard.js";
import type { ConnectionContext } from "../connection-context.js";
import { approvalResumeIdSchema, resultOutputSchema } from "../tool-schemas.js";
import { toolNames } from "../tool-names.js";
import { toolWidgetDescriptorMeta } from "../tool-context.js";
import {
  canonicalPolicyPath,
  enforceToolPolicy,
  policyFailureResponse,
} from "../tool-policy.js";
import {
  boundInspectionContent,
  contentLineCount,
  contentText,
  logFailedToolResponse,
  textBlock,
  textSummary,
  type ToolContent,
} from "../tool-result.js";
import { logToolCall } from "../tool-logging.js";
import { assertWorkerWorkspaceBinding } from "../process-tool-response.js";
import type { ToolEnvelope } from "../tool-envelope.js";
import {
  peerSensitivePathDenied,
  peerWorkspaceDenied,
} from "../../peer/workspace-guard.js";

export interface InspectionToolsDeps {
  readonly config: ServerConfig;
  readonly workspaces: WorkspaceRegistry;
  readonly policyEngine?: PolicyEngine;
  readonly policyEnforcer?: PolicyEnforcer;
  readonly connectionContext?: ConnectionContext;
  readonly workSessions?: ReturnType<typeof createWorkSessionManager>;
  readonly trackToolEvent: ToolEnvelope["trackToolEvent"];
  readonly scheduledExecutionPolicyFor?: (workSessionId: string) => ScheduledExecutionPolicy | undefined;
}

export const MAX_READ_LINES = 600;
export const MAX_INSPECTION_ITEMS = 500;

export function instructionContent(files: Array<{ path: string; content: string }>, root: string): ToolContent[] {
  return files.map((file) => textBlock(`Instruction loaded from ${formatAgentsPath(file.path, root)}:\n${file.content}`));
}

function inspectionTruncation(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  const value = details as Record<string, unknown>;
  const truncation = value.truncation && typeof value.truncation === "object"
    ? value.truncation as Record<string, unknown>
    : undefined;
  return truncation?.truncated === true
    || value.matchLimitReached !== undefined
    || value.resultLimitReached !== undefined
    || value.entryLimitReached !== undefined
    || value.linesTruncated === true;
}

export function inspectionMetadata(
  content: ToolContent[],
  details: unknown,
  offset = 1,
) {
  const originalText = contentText(content);
  const record = details && typeof details === "object" ? details as Record<string, unknown> : undefined;
  const truncation = record?.truncation && typeof record.truncation === "object"
    ? record.truncation as Record<string, unknown>
    : undefined;
  const notice = /(?:\n\n\[(?:Showing lines |\d+ more lines in file)|\[Truncated:|Some lines truncated)/m.test(originalText);
  const sourceTruncated = inspectionTruncation(details) || notice;
  const detailLines = typeof truncation?.outputLines === "number" ? truncation.outputLines : undefined;
  const withoutNotice = originalText.replace(/\n\n\[(?:Showing lines [\s\S]*|\d+ more lines in file\.[\s\S]*)$/, "");
  const returnedLines = detailLines ?? contentLineCount(withoutNotice);
  const nextOffset = sourceTruncated ? offset + returnedLines : undefined;
  const bounded = boundInspectionContent(content, { offset, nextOffset, sourceTruncated: sourceTruncated && !notice });
  const effectiveReturnedLines = detailLines ?? bounded.returnedLines;
  const effectiveNextOffset = sourceTruncated || bounded.truncated ? offset + effectiveReturnedLines : undefined;
  return {
    content: bounded.content,
    truncated: sourceTruncated || bounded.truncated,
    returnedLines: effectiveReturnedLines,
    characters: bounded.characters,
    bytes: bounded.bytes,
    ...(effectiveNextOffset !== undefined ? { nextOffset: effectiveNextOffset } : {}),
  };
}

/**
 * Peer inspection guard (M1): peers are confined to owner-granted workspace
 * roots, and credential/private-state paths are denied outright. Returns an
 * error result to return, or undefined when the call may proceed.
 * Owner/reviewer/worker connections are unaffected.
 */
export function peerInspectionDenied(
  connectionContext: ConnectionContext | undefined,
  config: ServerConfig,
  workspace: { root: string; sourceRoot?: string },
  absolutePath?: string,
): { content: ReturnType<typeof textBlock>[]; isError: true } | undefined {
  if (connectionContext?.authenticatedRole !== "peer") return undefined;
  // M2: worktree workspaces are granted against the SOURCE root; the
  // worktree path itself lives under KONTROL_WORKTREE_ROOT.
  const rootDenied = peerWorkspaceDenied(connectionContext, workspace.sourceRoot ?? workspace.root);
  if (rootDenied) return { content: [textBlock(rootDenied)], isError: true };
  if (absolutePath) {
    const pathDenied = peerSensitivePathDenied(config, absolutePath);
    if (pathDenied) return { content: [textBlock(pathDenied)], isError: true };
  }
  return undefined;
}

export function registerInspectionTools(
  server: McpServer,
  deps: InspectionToolsDeps,
): string[] {
  const { config, workspaces, policyEngine, policyEnforcer, connectionContext, workSessions, trackToolEvent, scheduledExecutionPolicyFor } = deps;
  const scheduledExecutionPolicy = (workSessionId: string | undefined) =>
    workSessionId && scheduledExecutionPolicyFor ? scheduledExecutionPolicyFor(workSessionId) : undefined;
  const names: string[] = [];
  const registeredTool = (name: string): string => {
    names.push(name);
    return name;
  };
  const denyPeerInspection = (
    workspace: { root: string; sourceRoot?: string },
    absolutePath?: string,
  ) => peerInspectionDenied(connectionContext, config, workspace, absolutePath);

  registerAppTool(
    server,
    registeredTool(toolNames.read),
    {
      title: "Read file",
      description:
        [
          "Read a file inside an open workspace. Use this for file inspection instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_READ_LINES)
          .optional()
          .describe(`Maximum number of lines to read (default ${MAX_READ_LINES}; hard maximum ${MAX_READ_LINES}). Continue with the returned nextOffset for larger files.`),
        approvalResumeId: approvalResumeIdSchema,
      },
      outputSchema: resultOutputSchema({
        contentSha256: z.string().optional().describe("SHA-256 of the complete file bytes at read time; pass it as expectedContentSha256 to guard a later mutation."),
        offset: z.number().int().optional(),
        returnedLines: z.number().int().optional(),
        truncated: z.boolean().optional(),
        nextOffset: z.number().int().optional(),
        characters: z.number().int().optional(),
        bytes: z.number().int().optional(),
      }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
      const readPath = workspaces.resolveReadPath(workspace, input.path, connectionContext?.mcpSessionId);
      {
        const peerDenied = denyPeerInspection(workspace, readPath.absolutePath);
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
          canonicalPolicyPath(workspace.root, input.path, readPath.absolutePath),
          undefined,
          undefined,
          input.approvalResumeId,
          input,
          scheduledExecutionPolicy(connectionContext?.workSessionId),
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.read}" denied by policy. Path: ${input.path}`, {
            tool: toolNames.read,
            workspaceId,
            path: input.path,
          });
        }
      }
      const newlyApplicable = readPath.skillRead
        ? []
        : await workspaces.loadApplicableInstructions(workspace, input.path, connectionContext?.mcpSessionId);
      const response = await readFileSnapshotTool(
        { ...input, limit: Math.min(input.limit ?? MAX_READ_LINES, MAX_READ_LINES), path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath, connectionContext?.mcpSessionId);
      workspaces.acknowledgeApplicableInstructions(workspace, newlyApplicable, connectionContext?.mcpSessionId);

      const responseContent = newlyApplicable.length > 0
        ? [...instructionContent(newlyApplicable, workspace.root), ...response.content]
        : response.content;
      const inspection = inspectionMetadata(responseContent, response.details, input.offset ?? 1);
      const responseForOutput = { ...response, content: inspection.content };
      const contentSha256 = response.contentSha256;
      const summary = {
        ...textSummary(inspection.content),
        offset: input.offset ?? 1,
        returnedLines: inspection.returnedLines,
        truncated: inspection.truncated,
        nextOffset: inspection.nextOffset,
        characters: inspection.characters,
        bytes: inspection.bytes,
      };
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      trackToolEvent(workspaceId, toolNames.read, input, responseForOutput, startedAt);

      return {
        ...responseForOutput,
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary,
          },
        },
        structuredContent: {
          tool: toolNames.read,
          result: contentText(inspection.content),
          contentSha256,
          offset: input.offset ?? 1,
          returnedLines: inspection.returnedLines,
          truncated: inspection.truncated,
          ...(inspection.nextOffset !== undefined ? { nextOffset: inspection.nextOffset } : {}),
          characters: inspection.characters,
          bytes: inspection.bytes,
        },
      };
    },
  );

  registerAppTool(
    server,
    registeredTool(toolNames.grep),
    {
      title: "Grep",
      description:
        "Search file contents inside an open workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        pattern: z.string().describe("Search pattern."),
        approvalResumeId: approvalResumeIdSchema,
        path: z
          .string()
          .optional()
          .describe(
            "Optional path or glob scope relative to the workspace root.",
          ),
        include: z.string().optional().describe("Optional include glob."),
        limit: z.number().int().min(1).max(MAX_INSPECTION_ITEMS).optional()
          .describe(`Maximum matching locations (default 100; hard maximum ${MAX_INSPECTION_ITEMS}). Refine path or include when more results are needed.`),
      },
      outputSchema: resultOutputSchema({
        truncated: z.boolean().optional(), returnedLines: z.number().int().optional(),
        characters: z.number().int().optional(), bytes: z.number().int().optional(),
      }),
      ...toolWidgetDescriptorMeta(config, "search"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
      {
        const peerDenied = denyPeerInspection(
          workspace,
          input.path ? workspaces.resolvePath(workspace, input.path) : undefined,
        );
        if (peerDenied) return peerDenied;
      }
      const policyPath = input.path
        ? canonicalPolicyPath(workspace.root, input.path, workspaces.resolvePath(workspace, input.path))
        : undefined;
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          brandWorkspaceId(workspaceId),
          connectionContext?.workSessionId ? brandWorkSessionId(connectionContext.workSessionId) : undefined,
          connectionContext?.runId,
          toolNames.grep,
          policyPath,
          undefined,
          undefined,
          input.approvalResumeId,
          input,
          scheduledExecutionPolicy(connectionContext?.workSessionId),
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.grep}" denied by policy.`, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          });
        }
      }
      const newlyApplicable = input.path ? await workspaces.loadApplicableInstructions(workspace, input.path, connectionContext?.mcpSessionId) : [];
      const response = await grepFilesTool({ ...input, limit: Math.min(input.limit ?? 100, MAX_INSPECTION_ITEMS) }, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      workspaces.acknowledgeApplicableInstructions(workspace, newlyApplicable, connectionContext?.mcpSessionId);
      const responseWithInstructions = newlyApplicable.length > 0
        ? { ...response, content: [...instructionContent(newlyApplicable, workspace.root), ...response.content] }
        : response;
      const inspection = inspectionMetadata(responseWithInstructions.content, response.details);
      const summary = {
        pattern: input.pattern,
        scope: input.path ?? ".",
        ...textSummary(inspection.content),
        truncated: inspection.truncated,
        returnedLines: inspection.returnedLines,
        characters: inspection.characters,
        bytes: inspection.bytes,
      };
      logToolCall(config, {
        tool: toolNames.grep,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...responseWithInstructions,
        content: inspection.content,
        _meta: {
          tool: toolNames.grep,
          card: {
            workspaceId,
            path: input.path,
            summary,
          },
        },
        structuredContent: {
          tool: toolNames.grep,
          result: contentText(inspection.content),
          truncated: inspection.truncated,
          returnedLines: inspection.returnedLines,
          characters: inspection.characters,
          bytes: inspection.bytes,
        },
      };
    },
  );

  registerAppTool(
    server,
    registeredTool(toolNames.glob),
    {
      title: "Glob",
      description:
        "Find files by glob pattern inside an open workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        pattern: z.string().describe("File glob pattern."),
        approvalResumeId: approvalResumeIdSchema,
        limit: z.number().int().min(1).max(MAX_INSPECTION_ITEMS).optional()
          .describe(`Maximum matching paths (default 200; hard maximum ${MAX_INSPECTION_ITEMS}). Narrow the path or pattern to continue.`),
        path: z
          .string()
          .optional()
          .describe("Optional path scope relative to the workspace root."),
      },
      outputSchema: resultOutputSchema({
        truncated: z.boolean().optional(), returnedLines: z.number().int().optional(),
        characters: z.number().int().optional(), bytes: z.number().int().optional(),
      }),
      ...toolWidgetDescriptorMeta(config, "search"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
      {
        const peerDenied = denyPeerInspection(
          workspace,
          input.path ? workspaces.resolvePath(workspace, input.path) : undefined,
        );
        if (peerDenied) return peerDenied;
      }
      const policyPath = input.path
        ? canonicalPolicyPath(workspace.root, input.path, workspaces.resolvePath(workspace, input.path))
        : undefined;
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          brandWorkspaceId(workspaceId),
          connectionContext?.workSessionId ? brandWorkSessionId(connectionContext.workSessionId) : undefined,
          connectionContext?.runId,
          toolNames.glob,
          policyPath,
          undefined,
          undefined,
          input.approvalResumeId,
          input,
          scheduledExecutionPolicy(connectionContext?.workSessionId),
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.glob}" denied by policy.`, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          });
        }
      }
      const newlyApplicable = input.path ? await workspaces.loadApplicableInstructions(workspace, input.path, connectionContext?.mcpSessionId) : [];
      const response = await findFilesTool({ ...input, limit: Math.min(input.limit ?? 200, MAX_INSPECTION_ITEMS) }, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.acknowledgeApplicableInstructions(workspace, newlyApplicable, connectionContext?.mcpSessionId);
      const responseWithInstructions = newlyApplicable.length > 0
        ? { ...response, content: [...instructionContent(newlyApplicable, workspace.root), ...response.content] }
        : response;
      const inspection = inspectionMetadata(responseWithInstructions.content, response.details);

      const summary = {
        pattern: input.pattern,
        scope: input.path ?? ".",
        ...textSummary(inspection.content),
        truncated: inspection.truncated,
        returnedLines: inspection.returnedLines,
        characters: inspection.characters,
        bytes: inspection.bytes,
      };
      logToolCall(config, {
        tool: toolNames.glob,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...responseWithInstructions,
        content: inspection.content,
        _meta: {
          tool: toolNames.glob,
          card: {
            workspaceId,
            path: input.path,
            summary,
          },
        },
        structuredContent: {
          tool: toolNames.glob,
          result: contentText(inspection.content),
          truncated: inspection.truncated,
          returnedLines: inspection.returnedLines,
          characters: inspection.characters,
          bytes: inspection.bytes,
        },
      };
    },
  );

  registerAppTool(
    server,
    registeredTool(toolNames.ls),
    {
      title: "Ls",
      description:
        "List a directory inside an open workspace. Use this for directory inspection before reading files. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            "Directory path to list, relative to the workspace root.",
          ),
        limit: z.number().int().min(1).max(MAX_INSPECTION_ITEMS).optional()
          .describe(`Maximum directory entries (default 500; hard maximum ${MAX_INSPECTION_ITEMS}). Narrow the path to continue.`),
        approvalResumeId: approvalResumeIdSchema,
      },
      outputSchema: resultOutputSchema({
        truncated: z.boolean().optional(), returnedLines: z.number().int().optional(),
        characters: z.number().int().optional(), bytes: z.number().int().optional(),
      }),
      ...toolWidgetDescriptorMeta(config, "directory"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
      const resolvedPath = workspaces.resolvePath(workspace, input.path);
      {
        const peerDenied = denyPeerInspection(workspace, resolvedPath);
        if (peerDenied) return peerDenied;
      }
      const policyPath = canonicalPolicyPath(workspace.root, input.path, resolvedPath);
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          brandWorkspaceId(workspaceId),
          connectionContext?.workSessionId ? brandWorkSessionId(connectionContext.workSessionId) : undefined,
          connectionContext?.runId,
          toolNames.ls,
          policyPath,
          undefined,
          undefined,
          input.approvalResumeId,
          input,
          scheduledExecutionPolicy(connectionContext?.workSessionId),
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.ls}" denied by policy. Path: ${input.path}`, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          });
        }
      }
      const newlyApplicable = await workspaces.loadApplicableInstructions(workspace, input.path, connectionContext?.mcpSessionId);
      const response = await listDirectoryTool({ ...input, limit: Math.min(input.limit ?? MAX_INSPECTION_ITEMS, MAX_INSPECTION_ITEMS) }, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      workspaces.acknowledgeApplicableInstructions(workspace, newlyApplicable, connectionContext?.mcpSessionId);
      const responseWithInstructions = newlyApplicable.length > 0
        ? { ...response, content: [...instructionContent(newlyApplicable, workspace.root), ...response.content] }
        : response;
      const inspection = inspectionMetadata(responseWithInstructions.content, response.details);
      const summary = {
        ...textSummary(inspection.content),
        truncated: inspection.truncated,
        returnedLines: inspection.returnedLines,
        characters: inspection.characters,
        bytes: inspection.bytes,
      };
      logToolCall(config, {
        tool: toolNames.ls,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...responseWithInstructions,
        content: inspection.content,
        _meta: {
          tool: toolNames.ls,
          card: {
            workspaceId,
            path: input.path,
            summary,
          },
        },
        structuredContent: {
          tool: toolNames.ls,
          result: contentText(inspection.content),
          truncated: inspection.truncated,
          returnedLines: inspection.returnedLines,
          characters: inspection.characters,
          bytes: inspection.bytes,
        },
      };
    },
  );

  return names;
}
