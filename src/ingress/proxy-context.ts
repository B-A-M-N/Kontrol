/**
 * Pure proxy-context helpers (PR-A): deciding which client IP is authoritative
 * and which headers a public bridge edge must strip. No state, no listeners.
 */
import { isIP } from "node:net";

export type TrustedProxyPolicy =
  | { mode: "direct" }
  | { mode: "exact_peers"; peers: string[]; maxChainLength: number };

export interface ResolveClientIpInput {
  remoteAddress: string | undefined;
  xForwardedFor?: string;
  cfConnectingIp?: string;
  policy: TrustedProxyPolicy;
}

export interface ResolvedClientIp {
  ip: string;
  proxied: boolean;
  chainLength: number;
  rejectedForwarded: boolean;
}

/** Strict IP literal check: IPv4/IPv6 only, no CIDR, no ranges. */
export function isIpLiteral(value: string): boolean {
  if (!value) return false;
  const [addr, ...rest] = value.split("/");
  if (rest.length > 0) return false; // CIDR rejected
  if (addr.includes("-")) return false; // ranges rejected
  return isIP(addr) !== 0;
}

/**
 * Canonicalize an IP literal for comparison: IPv4-mapped IPv6
 * (::ffff:a.b.c.d) is reduced to its dotted-quad IPv4 form so a mapped
 * remoteAddress matches an IPv4 peer entry. Other literals are returned
 * unchanged. Non-literals are returned as-is (callers gate on isIpLiteral).
 */
export function normalizeIpLiteral(value: string): string {
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : value;
}

/**
 * Validate + normalize a proxyPeerIps list at policy construction: every
 * entry must be an exact IPv4/IPv6 literal (no CIDR/ranges); IPv4-mapped
 * IPv6 entries are reduced to their IPv4 form. Returns a new array.
 */
export function normalizeTrustedPeers(peers: readonly string[]): string[] {
  for (const peer of peers) {
    if (!isIpLiteral(peer)) {
      throw new Error(`trusted peer entry "${peer}" is not an exact IPv4/IPv6 literal (CIDR and ranges are rejected)`);
    }
  }
  return peers.map(normalizeIpLiteral);
}

function chainFrom(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Resolve the authoritative client IP.
 * - direct: only remoteAddress is trusted; any forwarded headers present are
 *   reported as rejectedForwarded (spoof resistance).
 * - exact_peers: forwarded headers are honored ONLY when remoteAddress matches
 *   a configured peer IP literal. The chain (rightmost = adjacent hop) is
 *   taken leftmost-origin; if the chain exceeds maxChainLength the whole
 *   forwarded chain is rejected (fail-closed) and remoteAddress is used.
 */
export function resolveClientIp(input: ResolveClientIpInput): ResolvedClientIp {
  const remote = input.remoteAddress?.replace(/^::ffff:/, "") ?? "";
  const xff = chainFrom(input.xForwardedFor);
  const cf = input.cfConnectingIp ? [input.cfConnectingIp.trim()] : [];
  const forwardedPresent = xff.length > 0 || cf.length > 0;

  if (input.policy.mode === "direct") {
    return { ip: remote, proxied: false, chainLength: 0, rejectedForwarded: forwardedPresent };
  }

  if (!remote || !normalizeTrustedPeers(input.policy.peers).includes(normalizeIpLiteral(remote))) {
    return { ip: remote, proxied: false, chainLength: 0, rejectedForwarded: forwardedPresent };
  }

  // Chain semantics: XFF list order is leftmost = original client, rightmost
  // = the adjacent hop that appended it. With exact_peers we trust the full
  // chain only up to maxChainLength; anything longer is fail-closed rejected.
  const chain = xff.length > 0 ? xff : cf;
  if (chain.length === 0) {
    // Trusted peer sent no forwarded headers: nothing was rejected.
    return { ip: remote, proxied: false, chainLength: 0, rejectedForwarded: false };
  }
  if (chain.length > input.policy.maxChainLength) {
    return { ip: remote, proxied: false, chainLength: chain.length, rejectedForwarded: true };
  }
  const originClient = chain[0];
  return { ip: isIpLiteral(originClient) ? originClient : remote, proxied: true, chainLength: chain.length, rejectedForwarded: false };
}

/**
 * Tailscale identity headers. UNTRUSTED for Kontrol authorization unless the
 * ingress chain is explicitly opted in; tailscale_funnel provides none of
 * them. Consumers may use these for logging only.
 */
export const TS_IDENTITY_HEADERS: readonly string[] = [
  "Tailscale-User-Login",
  "Tailscale-User-Name",
  "Tailscale-User-Profile-Pic",
  "Tailscale-User",
] as const;

/** Header names a public bridge edge must delete before proxying. */
export const BRIDGE_STRIP_HEADERS: readonly string[] = [
  "Forwarded",
  "X-Forwarded-For",
  "X-Forwarded-Host",
  "X-Forwarded-Proto",
  "X-Forwarded-Port",
  "X-Forwarded-Protocol",
  "X-Forwarded-Scheme",
  "X-Real-IP",
  "CF-Connecting-IP",
  "True-Client-IP",
  ...TS_IDENTITY_HEADERS,
] as const;

const KONTROL_PREFIX = "x-kontrol-";

/** Authority-bearing header check, including the X-Kontrol-* prefix rule. */
export function isBridgeStrippedHeader(name: string): boolean {
  if (name.toLowerCase().startsWith(KONTROL_PREFIX)) return true;
  return BRIDGE_STRIP_HEADERS.some((stripped) => stripped.toLowerCase() === name.toLowerCase());
}

export interface UntrustedIdentityHeaders {
  [header: string]: string;
}

/** Collect Tailscale identity header values for LOGGING only. Never authorize on these. */
export function extractUntrustedTailscaleIdentity(headers: Record<string, string | string[] | undefined>): UntrustedIdentityHeaders | undefined {
  const collected: UntrustedIdentityHeaders = {};
  for (const header of TS_IDENTITY_HEADERS) {
    const value = headers[header.toLowerCase()] ?? headers[header];
    if (typeof value === "string") {
      collected[header] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      collected[header] = value.join(", ");
    }
  }
  return Object.keys(collected).length > 0 ? collected : undefined;
}
