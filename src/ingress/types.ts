/**
 * Typed ingress profile configuration (PR-A). These types describe how
 * external origins are expected to reach Kontrol listeners. They are pure
 * configuration data: nothing here touches a live listener. Wiring arrives
 * in PR-B.
 */
export type IngressKind = "tailscale_serve" | "tailscale_funnel" | "https_bridge" | "secure_mcp_tunnel";

export type IngressAudience = "peer" | "owner_public";

export type IngressListenerTarget = "peer_listener" | "public_oauth_listener" | "secure_tunnel_listener";

export interface IngressProfile {
  /** Nonempty identifier matching [A-Za-z0-9._-]{1,64}; unique across profiles. */
  id: string;
  kind: IngressKind;
  audience: IngressAudience;
  /**
   * Absolute https origin for serve/funnel/bridge profiles. ENABLED
   * owner_public profiles — including secure_mcp_tunnel relays — must equal
   * the canonical publicBaseUrl origin (one-canonical-active rule); disabled
   * standby profiles are exempt from that equality check.
   */
  externalOrigin: string;
  target: IngressListenerTarget;
  /** Explicitly required: no implicit enable. */
  enabled: boolean;
  /** Observation only. Defaults to false when omitted. */
  managedByKontrol: boolean;
  /**
   * Stored operator-verbatim. Consumers MUST normalize via
   * normalizeHostAllowlist() before comparing against request Host values
   * (PR-B contract); validation normalizes for syntax checks only.
   */
  allowedHosts: string[];
  /** Exact trusted adjacent proxy peer IP literals (no CIDR/ranges). */
  proxyPeerIps?: string[];
}

export interface IngressConfig {
  profiles: IngressProfile[];
}

/** Privacy classification of an ingress kind. */
export function kindPrivacy(kind: IngressKind): "TAILNET_PRIVATE" | "PUBLIC_INTERNET" | "PROVIDER_RELAY" {
  switch (kind) {
    case "tailscale_serve":
      return "TAILNET_PRIVATE";
    case "tailscale_funnel":
    case "https_bridge":
      return "PUBLIC_INTERNET";
    case "secure_mcp_tunnel":
      return "PROVIDER_RELAY";
  }
}
