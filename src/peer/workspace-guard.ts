/**
 * Peer workspace/path authorization (M1). Peers are confined to canonical
 * workspace roots the owner granted in the credential registry, and are
 * denied credential/private state (.env*, the Kontrol state dir, ~/.kontrol)
 * by default. These checks run in addition to — never instead of — the
 * ordinary allowed-roots and symlink resolution.
 */
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { ServerConfig } from "../config.js";
import { isPathInsideRoot } from "../roots.js";
import type { ConnectionContext } from "../mcp/connection-context.js";

/**
 * Undefined when the connection may access the workspace root; otherwise a
 * human-readable denial reason. Only applies to peer connections — owner,
 * reviewer, and worker connections keep their existing authority paths.
 */
export function peerWorkspaceDenied(
  connectionContext: ConnectionContext | undefined,
  workspaceRoot: string,
): string | undefined {
  if (connectionContext?.authenticatedRole !== "peer") return undefined;
  const grants = connectionContext.peerGrantedRoots ?? [];
  if (grants.some((grant) => isPathInsideRoot(workspaceRoot, grant))) return undefined;
  return `Forbidden: peer is not granted access to workspace root ${workspaceRoot}.`;
}

/**
 * M2: true only when the connection is an authenticated peer whose owner-
 * granted capabilities include `workspace:propose_patch`. Such peers may open
 * managed worktrees for granted source roots and mutate files inside them
 * (never the live checkout). Every other connection — including peers without
 * the capability — returns false.
 */
export function peerMayProposePatches(
  connectionContext: ConnectionContext | undefined,
): boolean {
  return connectionContext?.authenticatedRole === "peer"
    && (connectionContext.peerCapabilities ?? []).includes("workspace:propose_patch");
}

/**
 * Process-local registry of managed worktrees opened by peers (M2 P0 fix).
 * The persisted WorkspaceSession records no creator, so peer worktree
 * ownership is tracked in module state instead. Restart clears the map —
 * peer worktree ownership does NOT survive restart (fail closed): after a
 * restart a peer regains access by re-running open_workspace on the source
 * path, which re-records ownership.
 */
const peerWorktreeOwners = new Map<string, string>();

/** Record that this peer principal opened this managed worktree workspace. */
export function recordPeerWorktree(workspaceId: string, principalId: string): void {
  peerWorktreeOwners.set(workspaceId, principalId);
}

/** True only when the worktree was recorded for exactly this principal. */
export function peerOwnsWorktree(workspaceId: string, principalId: string): boolean {
  return peerWorktreeOwners.get(workspaceId) === principalId;
}

/** Drop a worktree's ownership record (for future retire/GC paths). */
export function dropPeerWorktree(workspaceId: string): void {
  peerWorktreeOwners.delete(workspaceId);
}

/** Number of worktrees currently recorded for this peer principal. */
export function countPeerWorktrees(principalId: string): number {
  let count = 0;
  for (const owner of peerWorktreeOwners.values()) {
    if (owner === principalId) count++;
  }
  return count;
}

/**
 * Credential and private-state paths are denied to peers by default. Returns
 * undefined for everything else. Applies to any resolved absolute path a peer
 * tool call touches.
 */
export function peerSensitivePathDenied(
  config: ServerConfig,
  absolutePath: string,
): string | undefined {
  const resolved = resolve(absolutePath);
  const base = basename(resolved);
  if (/^\.env(\..*)?$/.test(base)) {
    return `Forbidden: peer access to environment/credential files (${base}) is denied by default.`;
  }
  if (isPathInsideRoot(resolved, config.stateDir)) {
    return "Forbidden: peer access to the Kontrol state directory is denied.";
  }
  const kontrolHome = resolve(homedir(), ".kontrol");
  if (isPathInsideRoot(resolved, kontrolHome)) {
    return "Forbidden: peer access to ~/.kontrol credential state is denied.";
  }
  return undefined;
}
