/**
 * Canonical MCP tool-name registry and server instruction text. Extracted
 * verbatim from src/mcp/workspace-server.ts (P1.3).
 */
import type { ServerConfig } from "../config.js";
import { readMcpServerVersion } from "./tool-logging.js";

export const toolNames = {
  openWorkspace: "open_workspace",
  showWorkspaceUi: "show_workspace_ui",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  gitStatus: "git_status",
  gitLog: "git_log",
  gitDiff: "git_diff",
  gitShow: "git_show",
  shell: "bash",
  pollProcess: "poll_process",
  writeStdin: "write_stdin",
} as const;

/**
 * Stable structured inspection surface. These tools are required in every
 * tool mode so a stale client catalog cannot silently route inspection through
 * the mutation-capable shell boundary.
 */
export const REQUIRED_INSPECTION_TOOLS = [
  toolNames.read,
  toolNames.grep,
  toolNames.glob,
  toolNames.ls,
  toolNames.gitStatus,
  toolNames.gitLog,
  toolNames.gitDiff,
  toolNames.gitShow,
] as const;

export interface McpToolSurface {
  version: string;
  requiredInspectionTools: readonly string[];
}

export function readMcpToolSurface(): McpToolSurface {
  return {
    version: readMcpServerVersion(),
    requiredInspectionTools: [...REQUIRED_INSPECTION_TOOLS],
  };
}

export function assertRequiredInspectionTools(registeredTools: ReadonlySet<string>): void {
  const missing = REQUIRED_INSPECTION_TOOLS.filter((name) => !registeredTools.has(name));
  if (missing.length > 0) {
    throw new Error(`MCP tool surface contract violation: missing required inspection tool(s): ${missing.join(", ")}`);
  }
}

const serverInstructionCache = new Map<string, string>();

function serverInstructions(config: ServerConfig): string {
  const showChangesInstruction = config.widgets !== "off"
    ? " If you successfully create, edit, overwrite, delete, move, or apply patches to files in a turn, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual change; do not skip it because individual file-change tools already returned diffs. When the user asks to open or inspect the workspace UI, call show_workspace_ui with the existing workspaceId."
    : "";

  if (config.toolMode === "codex") {
    return `Use Kontrol as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree and reuse its workspaceId. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, ${toolNames.ls}, ${toolNames.gitStatus}, ${toolNames.gitLog}, ${toolNames.gitDiff}, and ${toolNames.gitShow} for direct structured inspection; use apply_patch for modifications, exec_command for tests/builds/other commands, and ${toolNames.pollProcess} to observe running processes (${toolNames.writeStdin} remains available when input is required). When the user asks to open or inspect the workspace interface, call ${toolNames.showWorkspaceUi} with the existing workspaceId. Review, diagnosis, architecture, and code-edit requests go directly through the workspace first. Delegate only when the reviewer explicitly asks for bounded worker assistance: call discover_agents, dispatch only a currently dispatchable healthy role=agent peer, and if optional assistance is unavailable continue directly without trying an alternate ACP route. The WebUI reviewer remains the approval authority. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${showChangesInstruction}`;
  }

  const inspection = `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, ${toolNames.ls}, ${toolNames.gitStatus}, ${toolNames.gitLog}, ${toolNames.gitDiff}, and ${toolNames.gitShow} for file inspection. Long-running ${toolNames.shell} calls return a process session; use ${toolNames.pollProcess} to retrieve output and completion. `;

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";

  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Kontrol loads additional AGENTS.md/CLAUDE.md files lazily from the ancestors of each requested path and returns newly applicable instructions with that tool call. `;

  return `Use Kontrol as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree to obtain a workspaceId. Reuse that same workspaceId for all later file, search, edit, write, show-changes, and shell tools in that folder; do not call ${toolNames.openWorkspace} again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. ${agentsMd}${skills}${inspection}When the user asks to open or inspect the workspace interface, call ${toolNames.showWorkspaceUi} with the existing workspaceId. Review, diagnosis, architecture, and code-edit requests go directly through the workspace first. Delegate only when the reviewer explicitly asks for bounded worker assistance: call discover_agents before optional dispatch, select only a currently dispatchable healthy role=agent peer, and if optional assistance is unavailable continue directly without trying an alternate ACP route. The WebUI reviewer remains the approval authority. Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, package scripts, and commands that are better executed by the shell. Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.${showChangesInstruction}`;
}

export function cachedServerInstructions(config: ServerConfig): string {
  const key = `${config.toolMode}|${config.widgets}|${config.skillsEnabled ? "skills" : "no-skills"}`;
  const cached = serverInstructionCache.get(key);
  if (cached) return cached;
  const instructions = serverInstructions(config);
  serverInstructionCache.set(key, instructions);
  return instructions;
}
