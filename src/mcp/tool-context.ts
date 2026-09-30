/**
 * Tool descriptor metadata: widget-kind gating, interactive-approval
 * descriptor advertisement, and per-tool `_meta` assembly. Extracted
 * verbatim from src/mcp/workspace-server.ts (P1.3).
 */
import type { ServerConfig, WidgetMode } from "../config.js";
import type { PolicyConfig } from "../policy.js";
import {
  workspaceAppCallableToolMeta,
  workspaceAppRenderToolMeta,
} from "../workspace-app-resource.js";

export type ToolWidgetKind =
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

interface ToolWidgetDescriptorMeta {
  _meta: Record<string, unknown>;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "workspace" || kind === "show_changes";
    case "full":
      return true;
  }
}

/**
 * A tool whose effective policy can produce an `ask` outcome may return a
 * blocked result that carries an interactive approval card. Those results must
 * reach the Workspace App even in `changes` mode: a card the host cannot
 * render because the tool descriptor never advertised the app is a
 * dead-end approval. `off` stays off — an operator who disabled widgets has
 * no interactive surface to attach one to.
 */
function toolCanRequireInteractiveApproval(policy: PolicyConfig, kind: ToolWidgetKind): boolean {
  const canonicalToolsByKind: Partial<Record<ToolWidgetKind, string[]>> = {
    // exec_command and a mutating write_stdin are gated under the canonical
    // "bash" policy key (P0 #1), so the shell widget follows bash's rule.
    shell: ["bash"],
    read: ["read"],
    write: ["write"],
    edit: ["edit", "apply_patch"],
    search: ["grep", "glob"],
    directory: ["ls"],
  };
  const tools = canonicalToolsByKind[kind];
  if (!tools) return false;
  if (tools.some((tool) => (policy.toolRules[tool] ?? policy.defaultMode) === "ask")) return true;
  // Path rules can place a read/ls (and any path-scoped tool) in ask; the
  // pattern cannot be resolved per-descriptor, so any path rule with mode
  // "ask" makes every path-scoped tool potentially interactive.
  return policy.pathRules.some((rule) => rule.mode === "ask");
}

export function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  // Opening a workspace is a data/bootstrap operation. The dedicated
  // show_workspace_ui tool owns renderer selection for the workspace surface.
  if (kind === "workspace") return { _meta: {} };
  if (config.widgets === "changes" && toolCanRequireInteractiveApproval(config.policy, kind)) {
    return {
      _meta: workspaceAppCallableToolMeta(),
    };
  }
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  return {
    _meta: workspaceAppCallableToolMeta(),
  };
}

/** Only deliberate renderer entry points advertise the Workspace App resource. */
export function workspaceAppRenderToolDescriptorMeta(): ToolWidgetDescriptorMeta {
  return { _meta: workspaceAppRenderToolMeta() };
}
