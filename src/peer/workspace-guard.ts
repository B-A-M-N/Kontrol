/**
 * Peer workspace/path authorization (M1). Peers are confined to canonical
 * workspace roots the owner granted in the credential registry, and are
 * denied credential/private state (.env*, the Kontrol state dir, ~/.kontrol)
 * by default. These checks run in addition to — never instead of — the
 * ordinary allowed-roots and symlink resolution.
 */
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { ServerConfig } from "../config.js";
import { isPathInsideRoot, isPathInsideRootCanonical } from "../roots.js";
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
  if (grants.some((grant) => isPathInsideRootCanonical(workspaceRoot, grant))) return undefined;
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
/**
 * Durable ownership file. The map remains the runtime cache, but a mode-0600
 * sidecar records peer-created worktree ownership so a restart can restore
 * the exact principal binding instead of silently treating disk worktrees as
 * orphaned. Existing corrupt state fails closed at restore time.
 */
const PEER_WORKTREE_OWNERS_FILE = "peer-worktree-owners.json";
const peerWorktreeOwners = new Map<string, string>();

/** Record that this peer principal opened this managed worktree workspace. */
export function recordPeerWorktree(workspaceId: string, principalId: string, stateDir?: string): void {
  peerWorktreeOwners.set(workspaceId, principalId);
  if (stateDir) persistPeerWorktreeOwners(stateDir);
}

function persistPeerWorktreeOwners(stateDir: string): void {
  const payload = JSON.stringify(Object.fromEntries(peerWorktreeOwners));
  const path = resolve(stateDir, PEER_WORKTREE_OWNERS_FILE);
  const temporaryPath = `${path}.tmp.${randomBytes(8).toString("hex")}`;
  const fd = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporaryPath, path);
    const directoryFd = openSync(resolve(stateDir), "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch (error) {
    // Keep the old authority record intact if publication failed. A leftover
    // uniquely named temporary file is inert and can be removed by bounded
    // state-directory maintenance later.
    throw error;
  }
}

/** Restore ownership from durable state. Corrupt existing evidence fails closed. */
export function restorePeerWorktreeOwners(stateDir: string): void {
  const path = resolve(stateDir, PEER_WORKTREE_OWNERS_FILE);
  if (!existsSync(path)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Peer worktree ownership state is corrupt (${(error as Error).message}); refusing to restore authority.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Peer worktree ownership state is corrupt; refusing to restore authority.");
  }
  peerWorktreeOwners.clear();
  for (const [workspaceId, owner] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof owner !== "string" || owner.length === 0) {
      throw new Error("Peer worktree ownership state is corrupt; refusing to restore authority.");
    }
    peerWorktreeOwners.set(workspaceId, owner);
  }
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
