/**
 * Peer tool-profile: maps owner-granted peer capabilities to the exact MCP
 * tool names a peer may see and call. Read-only by default; mutation and
 * execution tools appear only when explicitly granted. Bridge, policy, and
 * reviewer tools are never included.
 */
import type { PeerCapability } from "./config-types.js";
import { toolNames } from "../mcp/tool-names.js";

/** Read-only inspection surface, granted with workspace:inspect. */
const INSPECT_TOOLS: ReadonlySet<string> = new Set([
  toolNames.openWorkspace,
  toolNames.listManagedWorktrees,
  toolNames.read,
  toolNames.grep,
  toolNames.glob,
  toolNames.ls,
  toolNames.gitStatus,
  toolNames.gitLog,
  toolNames.gitDiff,
  toolNames.gitShow,
]);

const PROPOSE_PATCH_TOOLS: readonly string[] = [toolNames.write, toolNames.edit, toolNames.stagedWrite];
/**
 * workspace:run_bounded remains a reserved future capability. The ordinary
 * process tools are not an OS confinement boundary: exposing them to a peer
 * would permit arbitrary process execution in a managed checkout. Until a
 * dedicated bounded peer runner exists, this capability grants no tools.
 */
const RUN_BOUNDED_TOOLS: readonly string[] = [];

/** MCP tool names a peer with these capabilities may see and call. */
export function peerAllowedToolNames(capabilities: readonly PeerCapability[]): ReadonlySet<string> {
  const names = new Set<string>();
  const has = (capability: PeerCapability): boolean => capabilities.includes(capability);
  if (has("workspace:inspect")) {
    for (const name of INSPECT_TOOLS) names.add(name);
  }
  if (has("workspace:propose_patch")) {
    for (const name of PROPOSE_PATCH_TOOLS) names.add(name);
  }
  if (has("workspace:run_bounded")) {
    for (const name of RUN_BOUNDED_TOOLS) names.add(name);
  }
  return names;
}

/** Stable cache-identity key for a capability profile: sorted, joined capabilities, or "none". */
export function peerToolProfileKey(capabilities: readonly PeerCapability[] | undefined): string {
  if (!capabilities || capabilities.length === 0) return "none";
  return [...capabilities].sort().join(",");
}
