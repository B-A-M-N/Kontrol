/**
 * Canonical MCP tool-name registry and server instruction text. Extracted
 * verbatim from src/mcp/workspace-server.ts (P1.3).
 */
import type { ServerConfig } from "../config.js";

export const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
} as const;

const serverInstructionCache = new Map<string, string>();

function serverInstructions(config: ServerConfig): string {
  const showChangesInstruction =
    config.widgets === "changes"
      ? " If you successfully create, edit, overwrite, delete, move, or apply patches to files in a turn, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual change; do not skip it because individual file-change tools already returned diffs."
      : "";

  if (config.toolMode === "codex") {
    return `Use Kontrol as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree and reuse its workspaceId. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for direct structured inspection; use apply_patch for modifications, exec_command for tests/builds/other commands, and write_stdin to poll running processes. Review, diagnosis, architecture, and code-edit requests go directly through the workspace first. Delegate only when the reviewer explicitly asks for bounded worker assistance: call discover_agents, dispatch only a currently dispatchable healthy role=agent peer, and if optional assistance is unavailable continue directly without trying an alternate ACP route. The WebUI reviewer remains the approval authority. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${showChangesInstruction}`;
  }

  const inspection = `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";

  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Kontrol loads additional AGENTS.md/CLAUDE.md files lazily from the ancestors of each requested path and returns newly applicable instructions with that tool call. `;

  return `Use Kontrol as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree to obtain a workspaceId. Reuse that same workspaceId for all later file, search, edit, write, show-changes, and shell tools in that folder; do not call ${toolNames.openWorkspace} again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. ${agentsMd}${skills}${inspection}Review, diagnosis, architecture, and code-edit requests go directly through the workspace first. Delegate only when the reviewer explicitly asks for bounded worker assistance: call discover_agents before optional dispatch, select only a currently dispatchable healthy role=agent peer, and if optional assistance is unavailable continue directly without trying an alternate ACP route. The WebUI reviewer remains the approval authority. Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.${showChangesInstruction}`;
}

export function cachedServerInstructions(config: ServerConfig): string {
  const key = `${config.toolMode}|${config.widgets}|${config.skillsEnabled ? "skills" : "no-skills"}`;
  const cached = serverInstructionCache.get(key);
  if (cached) return cached;
  const instructions = serverInstructions(config);
  serverInstructionCache.set(key, instructions);
  return instructions;
}
