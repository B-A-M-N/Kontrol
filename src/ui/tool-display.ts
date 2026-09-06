/**
 * Tool-card display mapping (icon/title/label/tone) and plain-text payload
 * fallbacks. Extracted verbatim from ui/workspace-app.tsx (P1.4).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isReviewTool,
  isSearchTool,
  isShellTool,
  isToolName,
  type PatchOperation,
  type ToolName,
  type ToolResultCard,
} from "./card-types.js";
import { getPatchDisplayParts } from "./patch-display.js";
import {
  agentIcon,
  editIcon,
  fileIcon,
  filePlusIcon,
  filesIcon,
  folderIcon,
  listIcon,
  reviewIcon,
  searchIcon,
  terminalIcon,
} from "./ui-dom.js";

export interface ToolDisplay {
  icon: string;
  title: string;
  label: string;
  tone: string;
}

export function workspacePayloadText(card: ToolResultCard): string {
  const agentsFiles = card.agentsFiles ?? [];
  const availableAgentsFiles = card.availableAgentsFiles ?? [];
  const skills = card.skills ?? [];
  const lines = [
    card.workspaceId ? `Workspace: ${card.workspaceId}` : undefined,
    card.root ? `Root: ${card.root}` : undefined,
    skills.length > 0
      ? `Skills: ${skills.map((skill) => skill.name ?? skill.path ?? "unnamed").join(", ")}`
      : "Skills: none",
    availableAgentsFiles.length > 0
      ? `Nested instructions: ${availableAgentsFiles.map((file) => file.path ?? "unknown").join(", ")}`
      : undefined,
    agentsFiles.length > 0
      ? `\n${formatAgentsFilesForPayload(agentsFiles)}`
      : "\nAGENTS.md: none loaded",
  ].filter((line): line is string => typeof line === "string");
  return lines.join("\n");
}

export function formatAgentsFilesForPayload(
  agentsFiles: NonNullable<ToolResultCard["agentsFiles"]>,
): string {
  return agentsFiles
    .map((file) => {
      const path = file.path ?? "AGENTS.md";
      const content = file.content?.trim();
      return content ? `${path}\n\n${content}` : `${path}\n\nNo content loaded.`;
    })
    .join("\n\n");
}

export function getPatchToolDisplay(card: ToolResultCard, label: string): ToolDisplay {
  const display = getPatchDisplayParts(card);
  return {
    icon: patchIcon(display.iconOperation),
    title: display.title,
    label,
    tone: display.tone,
  };
}

export function patchIcon(operation: PatchOperation | undefined): string {
  if (operation === "add") return filePlusIcon();
  if (operation === "delete") return fileIcon();
  if (operation === "move") return filesIcon();
  return editIcon();
}

export function getToolDisplay(card: ToolResultCard): ToolDisplay {
  const label = getToolLabel(card);
  switch (card.tool) {
    case "open_workspace":
      return { icon: folderIcon(), title: "Workspace", label, tone: "workspace" };
    case "read":
      return { icon: fileIcon(), title: "Read File", label, tone: "read" };
    case "write":
      return { icon: filePlusIcon(), title: "Write File", label, tone: "write" };
    case "edit":
      return { icon: editIcon(), title: "Edit File", label, tone: "edit" };
    case "apply_patch":
      return getPatchToolDisplay(card, label);
    case "grep":
      return { icon: searchIcon(), title: "Grep", label, tone: "search" };
    case "glob":
      return { icon: filesIcon(), title: "Glob", label, tone: "search" };
    case "ls":
      return { icon: listIcon(), title: "List Directory", label, tone: "directory" };
    case "bash":
      return { icon: terminalIcon(), title: "Bash", label, tone: "shell" };
    case "exec_command":
      return { icon: terminalIcon(), title: "Exec Command", label, tone: "shell" };
    case "write_stdin":
      return { icon: terminalIcon(), title: "Process Session", label, tone: "shell" };
    case "show_changes":
      return { icon: reviewIcon(), title: "Show Changes", label, tone: "review" };
    case "submit_for_review":
      return { icon: reviewIcon(), title: "Review Submission", label, tone: "review" };
    case "submit_to_coding_agent":
      return { icon: agentIcon(), title: "Coding Agent", label, tone: "agent" };
    case "open_approval_center":
      return { icon: reviewIcon(), title: "Approval Center", label, tone: "agent" };
  }
}

export function getToolLabel(card: ToolResultCard): string {
  if (isShellTool(card.tool)) {
    return String(card.summary?.command ?? card.summary?.sessionId ?? card.path ?? card.tool);
  }
  if (isReviewTool(card.tool)) {
    const count = Number(card.summary?.files ?? card.files?.length ?? 0);
    return count === 0 ? "No changes since last review" : `${count} changed ${count === 1 ? "file" : "files"}`;
  }
  if (card.path) return card.path;
  if (card.root) return card.root;
  if (isSearchTool(card.tool)) {
    return String(card.summary?.pattern ?? card.tool);
  }
  return card.tool;
}

export function toolNameFromMeta(result: CallToolResult): ToolName | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const tool = meta?.tool;
  return isToolName(tool) ? tool : undefined;
}
