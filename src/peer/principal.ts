/**
 * Trusted server-side peer identity, derived ONLY from the credential
 * registry. Anything user-supplied (role, roots, capabilities) is never
 * honored: authorization decisions read exclusively from descriptors the
 * operator enrolled.
 */
import type { PeerCapability, PeerDescriptor } from "./config-types.js";
import { isPathInsideRoot } from "../roots.js";

export interface PeerPrincipal {
  peerId: string;
  credentialId: string;
  capabilities: readonly PeerCapability[];
  grantedRoots: readonly string[];
  /** Canonical durable identity: `peer:<peerId>:<credentialId>`. */
  principalId: string;
  /** Stable authorization grant identity; changes when grants change. */
  grantRevision: number;
  grantHash: string;
}

export function peerPrincipalId(peerId: string, credentialId: string): string {
  return `peer:${peerId}:${credentialId}`;
}

export function peerPrincipalFromDescriptor(
  d: PeerDescriptor,
  authorization: { revision: number; hash: string },
): PeerPrincipal {
  return {
    peerId: d.id,
    credentialId: d.credentialId,
    capabilities: [...d.capabilities],
    grantedRoots: [...d.grantedRoots],
    principalId: peerPrincipalId(d.id, d.credentialId),
    grantRevision: authorization.revision,
    grantHash: authorization.hash,
  };
}

/** A peer may perform an action only when its owner-granted capabilities include it. */
export function authorizePeerAction(principal: PeerPrincipal, capability: PeerCapability): boolean {
  return principal.capabilities.includes(capability);
}

/** Canonical root containment: true when `root` equals or is inside at least one granted root. */
export function peerGrantsRoot(principal: PeerPrincipal, root: string): boolean {
  return principal.grantedRoots.some((granted) => isPathInsideRoot(root, granted));
}
