/**
 * Pure validation for ingress profiles (PR-A). All functions throw Error with
 * a stable "ingress_profiles_invalid: " prefix so startup failures are greppable.
 */
import type { IngressConfig, IngressProfile, IngressListenerTarget } from "./types.js";
import { normalizeHostEntry, normalizeHostAllowlist } from "./host-policy.js";
import { isIpLiteral } from "./proxy-context.js";

const PREFIX = "ingress_profiles_invalid: ";
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const FUNNEL_PORTS = new Set(["443", "8443", "10000"]);

export interface IngressValidationContext {
  authMode: "oauth" | "tunnel";
  peerEnabled: boolean;
  hasPeerCredentials: boolean;
  publicBaseUrl?: string;
}

function fail(reason: string): never {
  throw new Error(`${PREFIX}${reason}`);
}

function originKey(profile: IngressProfile): { hostname: string; port: string } | undefined {
  let url: URL;
  try {
    url = new URL(profile.externalOrigin);
  } catch {
    return undefined; // invalid origins are rejected by checkExternalOrigin
  }
  return { hostname: url.hostname, port: url.port };
}

function checkExternalOrigin(profile: IngressProfile): void {
  let url: URL;
  try {
    url = new URL(profile.externalOrigin);
  } catch {
    fail(`profile "${profile.id}" externalOrigin is not a valid absolute URL: ${profile.externalOrigin}`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    fail(`profile "${profile.id}" externalOrigin must not include a path`);
  }
  if (url.search) {
    fail(`profile "${profile.id}" externalOrigin must not include a query`);
  }
  if (url.username || url.password) {
    fail(`profile "${profile.id}" externalOrigin must not contain userinfo`);
  }
  if (url.hash) {
    fail(`profile "${profile.id}" externalOrigin must not contain a fragment`);
  }
  if (url.protocol !== "https:") {
    fail(`profile "${profile.id}" externalOrigin must use https`);
  }
  if (url.hostname.includes("*") || profile.externalOrigin.includes("*")) {
    fail(`profile "${profile.id}" externalOrigin must not contain a wildcard`);
  }
  if (profile.kind === "tailscale_serve" || profile.kind === "tailscale_funnel") {
    const hostname = url.hostname.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.ts\.net$/.test(hostname)) {
      fail(`profile "${profile.id}" ${profile.kind} externalOrigin hostname must be a Tailscale-managed <node>.ts.net DNS name`);
    }
  }
  if (profile.kind === "tailscale_funnel") {
    // WHATWG URL drops explicitly-written default ports (https://h:443 and
    // https://h both yield port with empty string), so the funnel-port check
    // must use the EFFECTIVE port, otherwise the most common Funnel spelling
    // (443) is wrongly rejected even though 443 is an allowed funnel port.
    const effectivePort = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
    if (!FUNNEL_PORTS.has(effectivePort)) {
      fail(`profile "${profile.id}" tailscale_funnel externalOrigin port must be 443, 8443, or 10000 (got ${effectivePort})`);
    }
  }
}

/**
 * Validate a full profile list against the deployment context. Throws on the
 * first violated matrix row.
 */
export function validateIngressProfiles(profiles: readonly IngressProfile[], context: IngressValidationContext): void {
  // 1. duplicate ids
  const seenIds = new Set<string>();
  for (const profile of profiles) {
    if (!ID_PATTERN.test(profile.id)) {
      fail(`profile id "${profile.id}" must match [A-Za-z0-9._-]{1,64}`);
    }
    if (seenIds.has(profile.id)) {
      fail(`duplicate profile id "${profile.id}"`);
    }
    seenIds.add(profile.id);
  }

  // 2. serve/funnel same external node+port
  const tailnetPorts = new Map<string, string>();
  for (const profile of profiles) {
    if (profile.kind !== "tailscale_serve" && profile.kind !== "tailscale_funnel") continue;
    const key = originKey(profile);
    if (!key) continue;
    const mapKey = `${key.hostname}|${key.port}`;
    const existing = tailnetPorts.get(mapKey);
    if (existing) {
      fail(`profiles "${existing}" and "${profile.id}" share a tailnet serve/funnel node+port; tailscale serve/funnel cannot share a tailnet port`);
    }
    tailnetPorts.set(mapKey, profile.id);
  }

  for (const profile of profiles) {
    // 3+4. wildcard externalOrigin, URL validity/scheme
    checkExternalOrigin(profile);

    // 3+9. allowedHosts via host-policy (wildcards throw inside), nonempty for enabled profiles
    let hosts: string[];
    try {
      hosts = normalizeHostAllowlist(profile.allowedHosts);
    } catch (error) {
      fail(`profile "${profile.id}": ${error instanceof Error ? error.message : "invalid allowedHosts"}`);
    }
    if (profile.enabled) {
      if (!hosts || hosts.length === 0) {
        fail(`profile "${profile.id}" is enabled and must declare at least one exact allowedHosts entry`);
      }
      let origin: URL;
      try {
        origin = new URL(profile.externalOrigin);
      } catch {
        origin = new URL("https://invalid.invalid"); // already reported below
      }
      const originPort = origin.port !== "" ? origin.port : "443";
      const originAuthority = `${origin.hostname.toLowerCase()}:${originPort}`;
      const originHostname = origin.hostname.toLowerCase();
      if (!hosts.includes(originAuthority) && !hosts.includes(originHostname)) {
        fail(`profile "${profile.id}" allowedHosts must include its externalOrigin authority ${originAuthority}`);
      }
    }

    // 10. proxyPeerIps must be IP literals
    for (const peer of profile.proxyPeerIps ?? []) {
      if (!isIpLiteral(peer)) {
        fail(`profile "${profile.id}" proxyPeerIps entry "${peer}" is not an exact IPv4/IPv6 literal (CIDR and ranges are rejected)`);
      }
    }

    // 6+7. Exhaustive kind/target/audience/runtime matrix. Every mismatch is
    // rejected here, not deferred to the planner or listener implementation.
    const target: IngressListenerTarget = profile.target;
    if (target === "peer_listener") {
      if (profile.kind !== "tailscale_serve") {
        fail(`profile "${profile.id}" targets peer_listener; only tailscale_serve may expose the peer listener`);
      }
      if (profile.audience !== "peer") {
        fail(`profile "${profile.id}" targets peer_listener but has ${profile.audience} audience; peer_listener requires peer audience`);
      }
      if (!(context.peerEnabled && context.hasPeerCredentials)) {
        fail(`profile "${profile.id}" targets peer_listener but the peer listener is not enabled with credentials`);
      }
    } else if (target === "public_oauth_listener") {
      const allowedKind = profile.kind === "tailscale_serve" || profile.kind === "tailscale_funnel" || profile.kind === "https_bridge";
      if (!allowedKind) {
        fail(`profile "${profile.id}" of kind ${profile.kind} cannot target public_oauth_listener`);
      }
      if (profile.audience !== "owner_public") {
        fail(`profile "${profile.id}" targets public_oauth_listener but has ${profile.audience} audience; public_oauth_listener requires owner_public audience`);
      }
      if (context.authMode !== "oauth") {
        fail(`profile "${profile.id}" targets public_oauth_listener but the deployment is tunnel-mode; public ingress requires OAuth mode`);
      }
    } else {
      if (profile.kind !== "secure_mcp_tunnel") {
        fail(`profile "${profile.id}" targets secure_tunnel_listener; only secure_mcp_tunnel profiles may use that target`);
      }
      if (profile.audience !== "owner_public") {
        fail(`profile "${profile.id}" targets secure_tunnel_listener but has ${profile.audience} audience`);
      }
      if (context.authMode !== "tunnel") {
        fail(`profile "${profile.id}" targets secure_tunnel_listener but the deployment is oauth-mode; Secure MCP Tunnel requires a compatible tunnel deployment`);
      }
    }

    // 8. canonical OAuth resource uniqueness for ENABLED owner_public profiles
    if (
      profile.enabled &&
      profile.audience === "owner_public" &&
      (target === "public_oauth_listener" || target === "secure_tunnel_listener") &&
      context.publicBaseUrl
    ) {
      let canonicalHost: string;
      let profileHost: string;
      try {
        const canonical = new URL(context.publicBaseUrl);
        const profileUrl = new URL(profile.externalOrigin);
        canonicalHost = `${canonical.hostname}|${canonical.port}`;
        profileHost = `${profileUrl.hostname}|${profileUrl.port}`;
      } catch {
        fail(`profile "${profile.id}" externalOrigin or context publicBaseUrl is not a valid URL`);
      }
      if (canonicalHost !== profileHost) {
        fail(`profile "${profile.id}" enabled owner_public externalOrigin ${profile.externalOrigin} does not equal the canonical publicBaseUrl origin ${context.publicBaseUrl}; disabled standby profiles are exempt`);
      }
    }
  }
}

const PROFILE_FIELDS = new Set([
  "id",
  "kind",
  "audience",
  "externalOrigin",
  "target",
  "enabled",
  "managedByKontrol",
  "allowedHosts",
  "proxyPeerIps",
]);

const KINDS = new Set(["tailscale_serve", "tailscale_funnel", "https_bridge", "secure_mcp_tunnel"]);
const AUDIENCES = new Set(["peer", "owner_public"]);
const TARGETS = new Set(["peer_listener", "public_oauth_listener", "secure_tunnel_listener"]);

function parseProfile(raw: unknown, index: number): IngressProfile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`profile ${index} is not an object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PROFILE_FIELDS.has(key)) {
      fail(`profile ${index} has unknown field "${key}"`);
    }
  }
  for (const required of ["id", "kind", "audience", "externalOrigin", "target", "enabled"] as const) {
    if (record[required] === undefined) {
      fail(`profile ${index} is missing required field "${required}"`);
    }
  }
  if (typeof record.id !== "string") fail(`profile ${index} id must be a string`);
  if (typeof record.kind !== "string" || !KINDS.has(record.kind)) fail(`profile ${index} has invalid kind`);
  if (typeof record.audience !== "string" || !AUDIENCES.has(record.audience)) fail(`profile ${index} has invalid audience`);
  if (typeof record.externalOrigin !== "string") fail(`profile ${index} externalOrigin must be a string`);
  if (typeof record.target !== "string" || !TARGETS.has(record.target)) fail(`profile ${index} has invalid target`);
  if (typeof record.enabled !== "boolean") fail(`profile ${index} enabled must be a boolean`);
  let managedByKontrol = false;
  if (record.managedByKontrol !== undefined) {
    if (typeof record.managedByKontrol !== "boolean") fail(`profile ${index} managedByKontrol must be a boolean`);
    managedByKontrol = record.managedByKontrol;
  }
  if (!Array.isArray(record.allowedHosts) || record.allowedHosts.some((entry) => typeof entry !== "string")) {
    fail(`profile ${index} allowedHosts must be an array of strings`);
  }
  let proxyPeerIps: string[] | undefined;
  if (record.proxyPeerIps !== undefined) {
    if (!Array.isArray(record.proxyPeerIps) || record.proxyPeerIps.some((entry) => typeof entry !== "string")) {
      fail(`profile ${index} proxyPeerIps must be an array of strings`);
    }
    proxyPeerIps = record.proxyPeerIps as string[];
  }
  const profile: IngressProfile = {
    id: record.id,
    kind: record.kind as IngressProfile["kind"],
    audience: record.audience as IngressProfile["audience"],
    externalOrigin: record.externalOrigin,
    target: record.target as IngressListenerTarget,
    enabled: record.enabled,
    managedByKontrol,
    allowedHosts: record.allowedHosts as string[],
  };
  if (proxyPeerIps) profile.proxyPeerIps = proxyPeerIps;
  return profile;
}

/**
 * Parse KONTROL_INGRESS_PROFILES. Undefined when unset/empty/whitespace.
 * Strict JSON array of exact-shape profiles; malformed input throws with the
 * ingress_profiles_invalid prefix.
 */
export function parseIngressProfilesEnv(value: string | undefined): IngressConfig | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(`KONTROL_INGRESS_PROFILES is not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    fail("KONTROL_INGRESS_PROFILES must be a JSON array of profiles");
  }
  const profiles = parsed.map(parseProfile);
  return { profiles };
}
