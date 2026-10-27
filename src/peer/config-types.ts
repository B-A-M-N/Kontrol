/**
 * Peer feature (M1) config types. Independently-authenticated peers (e.g.
 * Meta Muse) call Kontrol's MCP surface with scoped credentials granted by
 * the operator. This module is strictly opt-in and additive: it never alters
 * the main-server `AuthMode` contract in src/config.ts.
 */

/** Owner-granted peer capabilities. Exhaustive; config parsing rejects unknown values. */
export const PEER_CAPABILITIES = [
  "workspace:inspect",
  "workspace:propose_patch",
  "workspace:run_bounded",
  "job:claim",
  "job:complete",
  "job:cancel_ack",
] as const;

export type PeerCapability = (typeof PEER_CAPABILITIES)[number];

const PEER_CAPABILITY_SET: ReadonlySet<string> = new Set(PEER_CAPABILITIES);

export function isPeerCapability(value: string): value is PeerCapability {
  return PEER_CAPABILITY_SET.has(value);
}

export interface PeerDescriptor {
  /** Operator-assigned stable identity, e.g. "meta-muse". */
  id: string;
  /** Credential identifier. Rotation changes this or the hash. */
  credentialId: string;
  /** Lowercase hex SHA-256 of the domain-separated enrolled token (see credentials.ts). Plaintext is never stored. */
  credentialHash: string;
  capabilities: PeerCapability[];
  /** Canonical (resolved absolute) workspace roots; config validation enforces subset of server allowedRoots. */
  grantedRoots: string[];
  /** ISO-8601 timestamps for credential windows. */
  notBefore?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface PeerServerConfig {
  enabled: true;
  /** Specific local/tailnet interface only; wildcard binds are rejected at parse time. */
  bindHost: string;
  /** Independent of the main server port. */
  port: number;
  /** Operator-owned credential registry JSON file (mode 0600 enforced). */
  credentialFile: string;
  maxActiveSessions: number;
  maxClaimedJobs: number;
  requestBytesLimit: number;
  allowedPeers: PeerDescriptor[];
}
