/**
 * Core workspace tools: open_workspace, read, write, edit, apply_patch,
 * show_changes, structured discovery (grep/glob/ls), and bash. Tool
 * registration bodies extracted verbatim from src/mcp/workspace-server.ts
 * (P1.3); the createMcpServer closures become an explicit dependency object.
 */
import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { brandWorkSessionId, brandWorkspaceId } from "../../branded.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "../../config.js";
import type { PolicyEngine } from "../../policy.js";
import type { PolicyEnforcer } from "../../policy-enforcement.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  writeFileTool,
} from "../../pi-tools.js";
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
  boundInspectionContent,
  logFailedToolResponse,
  newFilePatch,
  textBlock,
  textSummary,
  type ToolContent,
} from "../tool-result.js";
import { logToolCall } from "../tool-logging.js";
import { runMutationBarrier } from "../mutation-barrier.js";
import { assertWorkerWorkspaceBinding, processOutputSchema, processToolResponse } from "../process-tool-response.js";
import type { ToolEnvelope } from "../tool-envelope.js";
import { processSessionOwnerId, type ConnectionContext } from "../connection-context.js";
import { MISSING_FILE_VERSION, readFileVersion, withFileMutationLock } from "../../mutation-version.js";

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
}

function instructionContent(files: Array<{ path: string; content: string }>, root: string): ToolContent[] {
  return files.map((file) => textBlock(`Instruction loaded from ${formatAgentsPath(file.path, root)}:\n${file.content}`));
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

const MAX_READ_LINES = 600;
const MAX_INSPECTION_ITEMS = 500;

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

function inspectionMetadata(
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

function gitPathArg(workspaces: WorkspaceRegistry, workspace: ReturnType<WorkspaceRegistry["getWorkspace"]>, path?: string): string[] {
  if (path === undefined || path === "") return [];
  const resolved = workspaces.resolvePath(workspace, path);
  const relativePath = workspace.root === resolved ? "." : relative(workspace.root, resolved);
  return ["--", relativePath || "."];
}

export function registerWorkspaceTools(
  server: McpServer,
  deps: WorkspaceToolsDeps,
): ReadonlySet<string> {
  const { config, workspaces, reviewCheckpoints, policyEngine, policyEnforcer, connectionContext, workSessions, trackToolEvent, prepareForMutation, processSessions } = deps;
  const registeredToolNames = new Set<string>();
  const registeredTool = (name: string): string => {
    registeredToolNames.add(name);
    return name;
  };
  registerAppTool(
    server,
    registeredTool("open_workspace"),
    {
      title: "Open workspace",
      description:
        "Open a local project directory as a coding workspace. Call this once per project folder or worktree before reading, editing, searching, writing, showing changes, or running commands. Reuse the returned workspaceId for later calls in the same folder; do not call open_workspace again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. By default this opens the actual checkout; set mode=\"worktree\" when the user asks for an isolated or parallel coding session. Ordinary non-Git directories are valid checkout workspaces and use filesystem change tracking; only managed worktrees require Git. Review and code-edit work stays direct in the workspace; optional ACP delegation follows discover_agents and healthy-agent checks. Returns the workspace capabilities and project instructions.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a local project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout. Use checkout to work in the actual directory. Use worktree to create an isolated managed Git worktree for parallel work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        tool: z.literal(toolNames.openWorkspace),
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        workspaceKind: z.enum(["checkout", "worktree"]),
        versionControl: z.enum(["git", "none", "unknown"]),
        checkpointBackend: z.enum(["git", "filesystem", "unavailable"]),
        capabilities: z.object({
          read: z.boolean(),
          search: z.boolean(),
          edit: z.boolean(),
          changeTracking: z.boolean(),
          managedWorktree: z.boolean(),
        }),
        toolSurface: z.object({
          version: z.string(),
          requiredInspectionTools: z.array(z.enum(REQUIRED_INSPECTION_TOOLS)),
        }),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema),
        skills: z.array(workspaceSkillOutputSchema),
        skillDiagnostics: z.array(z.unknown()),
        instruction: z.string(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace"),
      // checkout opening initializes workspace/checkpoint state, and
      // mode="worktree" creates a managed Git worktree. This combined
      // operation therefore has a real side effect even when the default
      // checkout path only reads project files.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ path, mode, baseRef }) => {
      const startedAt = performance.now();
      const { workspace, agentsFiles, availableAgentsFiles } = await workspaces.openWorkspace({ path, mode, baseRef }, connectionContext?.mcpSessionId);
      const gitEligibility = await getGitEligibility(workspace.root);
      const workspaceKind = workspace.mode;
      const versionControl = gitEligibility.ok ? "git" : "none";
      // P0.5: capability reporting is authoritative, not inferred. Ask the
      // checkpoint manager whether initialization actually produced a usable
      // backend instead of predicting one from git eligibility — a failed
      // capture must be reported as "unavailable", never as a working backend.
      const snapshotInfo = await reviewCheckpoints.getSnapshotInfo({
        workspaceId: workspace.id,
        root: workspace.root,
      });
      const checkpointBackend = snapshotInfo.available ? snapshotInfo.kind : "unavailable";
      const changeTracking = snapshotInfo.available;
      const visibleSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const toolSurface = readMcpToolSurface();
      const loadedAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const baseInstruction = config.skillsEnabled
        ? "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Nested instructions are loaded automatically when later tools enter their directory. Review, diagnosis, architecture, and code-edit requests go directly through this workspace first. Delegate only when the reviewer explicitly asks for bounded assistance: call discover_agents, use only a currently dispatchable healthy role=agent peer, and if optional assistance is unavailable continue directly without an alternate ACP route. The WebUI reviewer remains the approval authority. When a task matches an available skill in skills, read its path before proceeding. For skills not listed here, use the search_skills tool to discover global skills by keyword."
        : "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Nested instructions are loaded automatically when later tools enter their directory. Review, diagnosis, architecture, and code-edit requests go directly through this workspace first. Delegate only when the reviewer explicitly asks for bounded assistance: call discover_agents, use only a currently dispatchable healthy role=agent peer, and if optional assistance is unavailable continue directly without an alternate ACP route. The WebUI reviewer remains the approval authority.";
      const instruction = `${baseInstruction} The active Kontrol server exposes ${toolSurface.requiredInspectionTools.join(", ")} in tool surface ${toolSurface.version}. If this client's catalog omits any of them, refresh or initialize a fresh MCP connection; meanwhile continue with available bounded structured tools such as read. Do not substitute bash or find for structured inspection.`;
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            `Opened workspace ${workspace.id}`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            `Version control: ${versionControl}; checkpoint backend: ${checkpointBackend}`,
            `MCP tool surface: ${toolSurface.version}; required structured inspection: ${toolSurface.requiredInspectionTools.join(", ")}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            summary: {
              agentsFiles: loadedAgentsFiles.length,
              availableAgentsFiles: availableAgentsFileOutputs.length,
              skills: visibleSkills.length,
              skillDiagnostics: workspace.skillDiagnostics.length,
            },
          },
        },
        structuredContent: {
          tool: toolNames.openWorkspace,
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          workspaceKind,
          versionControl,
          checkpointBackend,
          capabilities: {
            read: true,
            search: true,
            edit: true,
            changeTracking,
            managedWorktree: workspace.mode === "worktree",
          },
          toolSurface,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          agentsFiles: loadedAgentsFiles,
          availableAgentsFiles: availableAgentsFileOutputs,
          skills: visibleSkills,
          skillDiagnostics: workspace.skillDiagnostics,
          instruction,
        },
      };
    },
  );

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
      const response = await readFileTool(
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
      const contentSha256 = await readFileVersion(readPath.absolutePath);
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

  if (config.toolMode !== "codex") {
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
      const resolvedPath = workspaces.resolvePath(workspace, input.path);
      const policyPath = canonicalPolicyPath(workspace.root, input.path, resolvedPath);

      const newlyApplicable = await workspaces.loadApplicableInstructions(workspace, input.path, connectionContext?.mcpSessionId);
      if (newlyApplicable.length > 0 && input.instructionContentHash !== hashInstructionContent(newlyApplicable)) {
        return instructionsRequiredResponse(toolNames.write, newlyApplicable, workspace.root, workspaceId, input.path, `Read and acknowledge the returned instructions, then retry write with instructionContentHash="${hashInstructionContent(newlyApplicable)}". No file was changed.`);
      }

      // Policy enforcement for file writes
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          brandWorkspaceId(workspaceId),
          connectionContext?.workSessionId ? brandWorkSessionId(connectionContext.workSessionId) : undefined,
          connectionContext?.runId,
            toolNames.write,
            policyPath,
            undefined,
            undefined,
            input.approvalResumeId,
          );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.write}" denied by policy. Path: ${input.path}`, {
            tool: toolNames.write,
            workspaceId,
            path: input.path,
          });
        }
      }

      const mutation = await withFileMutationLock<LockedToolMutation<Awaited<ReturnType<typeof writeFileTool>>>>([resolvedPath], async (): Promise<LockedToolMutation<Awaited<ReturnType<typeof writeFileTool>>>> => {
        const versionConflict = await checkFileVersion(
          toolNames.write,
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
      if ("versionConflict" in mutation) return mutation.versionConflict;
      const response = mutation.response;

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      // P1 (audit): record the structured mutation path so the next review
      // submission can state whether the checkpoint represents it.
      await reviewCheckpoints.recordMutations({ workspaceId, root: workspace.root, paths: [input.path] });

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
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
      trackToolEvent(workspaceId, toolNames.write, input, responseWithInstructions, startedAt);

      return {
        ...responseWithInstructions,
        _meta: {
          tool: toolNames.write,
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
          tool: toolNames.write,
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
          );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.edit}" denied by policy. Path: ${input.path}`, {
            tool: toolNames.edit,
            workspaceId,
            path: input.path,
          });
        }
      }

      const mutation = await withFileMutationLock<LockedToolMutation<Awaited<ReturnType<typeof editFileTool>>>>([resolvedPath], async (): Promise<LockedToolMutation<Awaited<ReturnType<typeof editFileTool>>>> => {
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
      await reviewCheckpoints.recordMutations({ workspaceId, root: workspace.root, paths: [input.path] });

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
          affectedPaths.map((path) => workspaces.resolvePath(workspace, path)),
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

  if (config.widgets === "changes" || config.widgets === "full") {
    registerAppTool(
      server,
      registeredTool("show_changes"),
      {
        title: "Show changes",
        description:
          "Show aggregate changes for an open workspace using its available checkpoint backend. Git is optional: ordinary directories use content-addressed filesystem snapshots. After the final successful edit, write, or apply_patch call in the current turn, call this exactly once before the final response so the user can inspect the combined change set.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          since: z
            .enum(["last_shown", "workspace_open"])
            .optional()
            .describe("Defaults to last_shown, which is correct for normal end-of-turn review. Use workspace_open only when the user asks to review all changes since opening the workspace."),
          markReviewed: z
            .boolean()
            .optional()
            .describe("Defaults to true. When true, advances the last shown checkpoint to the current workspace state."),
        },
      outputSchema: resultOutputSchema({
          snapshotKind: z.enum(["git", "filesystem"]).optional(),
          snapshotRef: z.string().optional(),
        }),
        ...workspaceAppRenderToolDescriptorMeta(),
        // The default markReviewed=true advances the workspace checkpoint.
        // Keep the existing end-of-turn acknowledgement behavior, but do not
        // advertise this state-changing operation as read-only to MCP hosts.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async ({ workspaceId, since, markReviewed }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId,
          root: workspace.root,
          since: since ?? "last_shown",
          markReviewed: markReviewed ?? true,
        });

        const content = [textBlock(review.result)];
        logToolCall(config, {
          tool: "show_changes",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        trackToolEvent(workspaceId, "show_changes", { since, markReviewed }, { content, isError: false }, startedAt);

        return {
          content,
          _meta: {
            tool: "show_changes",
            card: {
              workspaceId,
              summary: review.summary,
              files: review.files,
              payload: {
                patch: review.patch,
              },
            },
          },
          structuredContent: {
            tool: "show_changes",
            result: contentText(content),
            snapshotKind: review.snapshotKind,
            snapshotRef: review.snapshotRef,
          },
        };
      },
    );
  }

  // Structured read-only discovery is part of the public surface in every
  // tool mode. Codex mode adds process-oriented tools but does not hide these
  // stable inspection primitives.
  {
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
  }

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
      },
      outputSchema: resultOutputSchema({
        truncated: z.boolean().optional(), returnedLines: z.number().int().optional(),
        characters: z.number().int().optional(), bytes: z.number().int().optional(),
      }),
      _meta: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async ({ workspaceId, path: requestedPath, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const pathArgs = gitPathArg(workspaces, workspace, requestedPath);
      const output = await run(workspace.root, pathArgs.length ? requestedPath : undefined, input as Record<string, unknown>);
      const inspection = inspectionMetadata([textBlock(output)], undefined);
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

  registerGitInspection(toolNames.gitStatus, "Git status", "Read-only short Git status for an open workspace; never requires shell approval.", {}, async (root, path) => {
    const result = await git(root, ["status", "--short", "--branch", "--untracked-files=all", ...(path ? ["--", path] : [])], { maxBuffer: 262_144, timeoutMs: 15_000 });
    return result.stdout || "(clean)";
  });
  registerGitInspection(toolNames.gitLog, "Git log", "Read-only bounded Git history for an open workspace.", { limit: z.number().int().min(1).max(100).optional() }, async (root, path, input) => {
    const limit = Number(input.limit ?? 20);
    const result = await git(root, ["log", `--max-count=${limit}`, "--date=iso-strict", "--format=%H%x09%ad%x09%an%x09%s", ...(path ? ["--", path] : [])], { maxBuffer: 262_144, timeoutMs: 15_000 });
    return result.stdout || "(no commits)";
  });
  registerGitInspection(toolNames.gitDiff, "Git diff", "Read-only unified diff for an open workspace. Use git show for committed file content.", { staged: z.boolean().optional() }, async (root, path, input) => {
    const args = ["diff", "--no-ext-diff", "--unified=3"];
    if (input.staged === true) args.push("--cached");
    if (path) args.push("--", path);
    const result = await git(root, args, { maxBuffer: 262_144, timeoutMs: 15_000 });
    return result.stdout || "(no diff)";
  });
  registerGitInspection(toolNames.gitShow, "Git show", "Read-only bounded Git object or file view for an open workspace.", { revision: z.string().regex(/^[A-Za-z0-9._/~^@{}-]+$/).default("HEAD") }, async (root, path, input) => {
    const revision = String(input.revision ?? "HEAD");
    const args = ["show", "--no-ext-diff", "--no-textconv", "--format=fuller", revision];
    if (path) args.push("--", path);
    else args.push("--no-patch", "--stat");
    const result = await git(root, args, { maxBuffer: 262_144, timeoutMs: 15_000 });
    return result.stdout || "(empty object)";
  });

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
      // REVIEW-01: shell is mutation-capable regardless of the command
      // string — a textual "read-only" classification is not a security
      // boundary. It crosses the same checkpoint-readiness barrier as
      // write/edit/apply_patch/exec_command.
      const blocked = await runMutationBarrier(prepareForMutation, workspaceId, toolNames.shell);
      if (blocked) return blocked;
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
      const response: any = await (async () => {
        try {
          const snapshot = await processSessions.start({
            workspaceId,
            ownerId: processSessionOwnerId(connectionContext),
            workSessionId: connectionContext?.workSessionId,
            command: input.command,
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
