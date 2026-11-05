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
import { DEFAULT_MAX_RUNTIME_MS, type ProcessSessionManager } from "../../process-sessions.js";
import { applyPatch, parsePatch } from "../../apply-patch.js";
import { getGitEligibility } from "../../git.js";
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

export interface LifecycleToolsDeps {
  readonly config: ServerConfig;
  readonly workspaces: WorkspaceRegistry;
  readonly reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>;
  readonly connectionContext?: ConnectionContext;
  readonly workSessions?: ReturnType<typeof createWorkSessionManager>;
  readonly trackToolEvent: ToolEnvelope["trackToolEvent"];
  readonly processSessions: ProcessSessionManager;
}

export function registerLifecycleTools(
  server: McpServer,
  deps: LifecycleToolsDeps,
): string[] {
  const { config, workspaces, reviewCheckpoints, connectionContext, workSessions, trackToolEvent, processSessions } = deps;
  const names: string[] = [];
  const registeredTool = (name: string): string => {
    names.push(name);
    return names[names.length - 1];
  };
  registerAppTool(
    server,
    registeredTool("open_workspace"),
    {
      title: "Open workspace",
      description:
        "Open a local project directory as a coding workspace. Call this once per project folder or worktree before reading, editing, searching, writing, showing changes, or running commands. Reuse the returned workspaceId for later calls in the same folder; do not call open_workspace again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. By default this opens the actual checkout; set mode=\"worktree\" when the user asks for an isolated or parallel coding session. Ordinary non-Git directories are valid checkout workspaces and use filesystem change tracking; only managed worktrees require Git. Checkpoint capture is deferred until a review or mutation needs an exact baseline, so opening a workspace and using read-only inspection does not scan the working tree. Review and code-edit work stays direct in the workspace; optional ACP delegation follows discover_agents and healthy-agent checks. Returns the workspace capabilities and project instructions.",
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
        checkpointBackend: z.enum(["git", "filesystem", "pending", "unavailable"]),
        checkpointDiagnostic: z.string().optional(),
        checkpointError: z.object({ code: z.string(), operation: z.string(), stderr: z.string() }).optional(),
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
      let openedWorkspace;
      if (connectionContext?.authenticatedRole === "worker") {
        const session = connectionContext.workSessionId ? workSessions?.get(connectionContext.workSessionId) : undefined;
        const workspaceSessionId = session?.workspaceSessionId;
        if (!workspaceSessionId || workspaceSessionId !== connectionContext.workspaceSessionId) {
          return { content: [textBlock("Forbidden: worker has no valid signed workspace binding.")], isError: true };
        }
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceSessionId);
        if (bindingErr) return bindingErr;
        if (mode === "worktree" || baseRef !== undefined) {
          return { content: [textBlock("Forbidden: workers may only reopen their existing workspace; worktree creation is not available to workers.")], isError: true };
        }
        const workspace = workspaces.getWorkspace(workspaceSessionId);
        let requestedRoot: string;
        try {
          requestedRoot = assertAllowedPath(expandHomePath(path), [workspace.root]);
          requestedRoot = await realpath(requestedRoot);
        } catch {
          return { content: [textBlock("Forbidden: worker may only reopen its bound workspace.")], isError: true };
        }
        if (requestedRoot !== workspace.root) {
          return { content: [textBlock("Forbidden: worker may only reopen its bound workspace.")], isError: true };
        }
        openedWorkspace = await workspaces.openExistingWorkspace(workspaceSessionId, connectionContext.mcpSessionId);
      } else {
        // Peer connections are confined to owner-granted workspace roots.
        // This check runs BEFORE any workspace state is created so an
        // unauthorized open leaves no side effects, and again AFTER resolve
        // because grants are compared against the canonical resolved root,
        // not the lexical request path.
        if (connectionContext?.authenticatedRole === "peer") {
          if (mode === "worktree" && !peerMayProposePatches(connectionContext)) {
            return { content: [textBlock("Forbidden: peers may not create managed worktrees.")], isError: true };
          }
          const requestedRoot = expandHomePath(path);
          const preDenied = peerWorkspaceDenied(connectionContext, requestedRoot);
          if (preDenied) return { content: [textBlock(preDenied)], isError: true };
          if (mode === "worktree") {
            // M2: per-peer managed-worktree cap. Reuses KONTROL_PEER_MAX_ACTIVE_SESSIONS
            // (config.peer.maxActiveSessions, normally the concurrent peer-session cap)
            // as the per-peer worktree budget, counted from this peer's ownership
            // registry — never from the global enumeration. The global and per-project
            // managed worktree limits inside openWorktreeWorkspace (src/workspaces.ts)
            // still apply on top of this — they are not bypassed.
            const cap = config.peer?.maxActiveSessions;
            const principalId = connectionContext.authenticatedPrincipalId;
            if (cap !== undefined && principalId && countPeerWorktrees(principalId) >= cap) {
              return { content: [textBlock(`Forbidden: peer managed-worktree cap reached (${cap} via KONTROL_PEER_MAX_ACTIVE_SESSIONS). Retire a managed worktree first.`)], isError: true };
            }
          }
        }
        openedWorkspace = await workspaces.openWorkspace({ path, mode, baseRef }, connectionContext?.mcpSessionId);
        if (connectionContext?.authenticatedRole === "peer") {
          // For worktree mode the worktree path lives under KONTROL_WORKTREE_ROOT,
          // so the grant check must compare against the SOURCE root the peer was
          // granted, not the worktree path.
          const grantRoot = openedWorkspace.workspace.sourceRoot ?? openedWorkspace.workspace.root;
          const postDenied = peerWorkspaceDenied(connectionContext, grantRoot);
          if (postDenied) return { content: [textBlock(postDenied)], isError: true };
          // M2 P0 fix: record ownership so this peer can mutate this worktree
          // and enumerate it. Applies to both the new-create path and any
          // existing-workspace reuse path that emerges from openWorkspace.
          if (openedWorkspace.workspace.mode === "worktree") {
            const principalId = connectionContext.authenticatedPrincipalId;
            if (principalId) recordPeerWorktree(openedWorkspace.workspace.id, principalId, config.stateDir);
          }
        }
      }
      const { workspace, agentsFiles, availableAgentsFiles } = openedWorkspace;
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
        initialize: false,
        kindHint: gitEligibility.ok ? "git" : "filesystem",
      });
      const checkpointBackend = snapshotInfo.pending ? "pending" : snapshotInfo.available ? snapshotInfo.kind : "unavailable";
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
      const instruction = `${baseInstruction} The active Kontrol server exposes ${toolSurface.requiredInspectionTools.join(", ")} in tool surface ${toolSurface.version}. If this client's catalog omits any of them, refresh or initialize a fresh MCP connection; meanwhile continue with available bounded structured tools such as read. Ordinary bash remains checkpoint-gated; use bash with readOnlyInspection=true only for its narrow pwd/ls/Git inspection allowlist.`;
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
          ...(snapshotInfo.diagnostic ? { checkpointDiagnostic: snapshotInfo.diagnostic } : {}),
          ...(snapshotInfo.checkpointError ? { checkpointError: snapshotInfo.checkpointError } : {}),
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

  registerAppTool(
    server,
    registeredTool(toolNames.listManagedWorktrees),
    {
      title: "List managed worktrees",
      description: "List managed worktrees, including retired entries and their clean, dirty, or divergent disposition. Dirty or divergent retired worktrees remain visible for explicit handling.",
      inputSchema: {
        before: z.object({ createdAt: z.string(), id: z.string() }).optional().describe("Cursor from the previous page."),
      },
      outputSchema: {
        worktrees: z.array(z.object({
          workspaceId: z.string(),
          projectId: z.string().optional(),
          sourceRoot: z.string().optional(),
          path: z.string(),
          baseSha: z.string().optional(),
          status: z.string(),
          retiredAt: z.string().optional(),
          cleanToBase: z.boolean(),
          dispositionRequired: z.boolean(),
          dispositionReason: z.string().optional(),
        })),
        nextCursor: z.object({ createdAt: z.string(), id: z.string() }).optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ before }) => {
      if (connectionContext?.authenticatedRole === "worker") {
        return { content: [textBlock("Forbidden: workers cannot enumerate managed worktrees.")], isError: true };
      }
      try {
        const page = await workspaces.listManagedWorktrees(before);
        if (connectionContext?.authenticatedRole === "peer") {
          // M2 P0 fix: peers must never observe other principals' worktree
          // ids/paths/sourceRoots — the page is filtered to worktrees this
          // peer opened in this process. Owner/reviewer/writer callers see
          // the unfiltered page.
          const principalId = connectionContext.authenticatedPrincipalId;
          const filteredPage = {
            ...page,
            worktrees: page.worktrees.filter((entry) =>
              principalId !== undefined
              && typeof entry.workspaceId === "string"
              && peerOwnsWorktree(entry.workspaceId, principalId)),
          };
          return {
            content: [textBlock(JSON.stringify(filteredPage, null, 2))],
            structuredContent: filteredPage,
          };
        }
        return {
          content: [textBlock(JSON.stringify(page, null, 2))],
          structuredContent: page,
        };
      } catch (error) {
        return { content: [textBlock(error instanceof Error ? error.message : String(error))], isError: true };
      }
    },
  );

  registerAppTool(
    server,
    registeredTool(toolNames.retireManagedWorktree),
    {
      title: "Retire managed worktree",
      description: "Retire an unused managed worktree. Refuses while work sessions, pending reviews or approvals, or running processes still use it. Physical cleanup happens after the configured retention period and only when the worktree is clean and still at its creation base.",
      inputSchema: {
        workspaceId: z.string().describe("Managed worktree workspace identifier."),
      },
      outputSchema: {
        workspaceId: z.string(),
        status: z.enum(["retired", "blocked", "already_retired"]),
        blockers: z.object({
          workSessions: z.number(),
          pendingReviews: z.number(),
          pendingApprovals: z.number(),
          runningProcesses: z.number().optional(),
        }).optional(),
        retiredAt: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workspaceId }) => {
      if (connectionContext?.authenticatedRole === "worker") {
        return { content: [textBlock("Forbidden: workers cannot retire managed worktrees.")], isError: true };
      }
      try {
        const runningProcesses = processSessions.countRunningForWorkspace(workspaceId);
        const result = workspaces.retireManagedWorktree(workspaceId, runningProcesses);
        const status = result.retired
          ? "retired"
          : result.session?.status === "retired" || result.session?.status === "removed"
            ? "already_retired"
            : "blocked";
        const structuredContent = {
          workspaceId,
          status,
          blockers: result.blockers,
          retiredAt: result.session?.retiredAt,
        };
        return {
          content: [textBlock(JSON.stringify(structuredContent, null, 2))],
          structuredContent,
        };
      } catch (error) {
        return { content: [textBlock(error instanceof Error ? error.message : String(error))], isError: true };
      }
    },
  );

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
          presentationOwnerId: processSessionOwnerId(connectionContext) ?? "default",
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

  return names;
}
