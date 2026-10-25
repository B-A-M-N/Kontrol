/**
 * Canonical ingress evidence tiers (multipath ingress audit §6).
 *
 * The audit requires five DISTINCT evidence tiers:
 *
 *   unit              — a pure source-level assertion
 *   local_integration — a test that exercised the real code path locally
 *   real_tailnet      — evidence captured from a real tailnet client
 *   public_internet   — evidence captured from a non-tailnet client
 *   operational       — sustained-operation qualification
 *
 * Two rules keep the tiers honest:
 *
 *   1. A lower tier can never qualify a higher claim.
 *   2. The tier is DERIVED from the scope the observation was actually
 *      collected in. A probe that ran against loopback is local-integration
 *      evidence even when its author labels it "public internet", and a
 *      public observation of a tailnet name is tailnet evidence even when
 *      the operator intends it to be public.
 *
 * Only an explicit sustained-operation receipt upgrades a scope-derived tier
 * to "operational"; the scope is still carried, so a tailnet qualification
 * never passes for a public origin.
 */
export type IngressEvidenceTier =
  | "unit"
  | "local_integration"
  | "real_tailnet"
  | "public_internet"
  | "operational";

/** Where an observation was actually collected. */
export type IngressEvidenceScope = "loopback" | "tailnet" | "public";

export const INGRESS_EVIDENCE_TIERS: readonly IngressEvidenceTier[] = [
  "unit",
  "local_integration",
  "real_tailnet",
  "public_internet",
  "operational",
];

export const INGRESS_EVIDENCE_SCOPES: readonly IngressEvidenceScope[] = ["loopback", "tailnet", "public"];

const TIER_RANK: Record<IngressEvidenceTier, number> = {
  unit: 0,
  local_integration: 1,
  real_tailnet: 2,
  public_internet: 3,
  operational: 4,
};

const TAILSCALE_DNS_SUFFIX = ".ts.net";

export function isIngressEvidenceTier(value: unknown): value is IngressEvidenceTier {
  return typeof value === "string" && (INGRESS_EVIDENCE_TIERS as readonly string[]).includes(value);
}

export function isIngressEvidenceScope(value: unknown): value is IngressEvidenceScope {
  return typeof value === "string" && (INGRESS_EVIDENCE_SCOPES as readonly string[]).includes(value);
}

/** Strict ordering used by every "a lower tier cannot qualify a higher one"
 * rule. `operational` is the strongest tier; it never downgrades. */
export function evidenceTierRank(tier: IngressEvidenceTier): number {
  return TIER_RANK[tier];
}

/** True when `actual` is at least as strong as `required`. */
export function tierSatisfies(actual: IngressEvidenceTier, required: IngressEvidenceTier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[required];
}

/** Tailscale's CGNAT range (100.64.0.0/10) is tailnet address space. */
function isTailnetAddress(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return numbers[0] === 100 && numbers[1] >= 64 && numbers[1] <= 127;
}

/**
 * Derive the evidence scope from an observed origin. This is the anti-mislabeling
 * rule: the scope comes from the address that was actually contacted, never
 * from an operator-supplied label.
 *
 * Returns null when the origin is unusable (unparseable, or credential-bearing).
 */
export function deriveEvidenceScope(origin: string): IngressEvidenceScope | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "" ) return null;
  if (host === "localhost" || host === "::1" || host === "0.0.0.0" || host.startsWith("127.")) return "loopback";
  if (host.endsWith(TAILSCALE_DNS_SUFFIX)) return "tailnet";
  if (isTailnetAddress(host)) return "tailnet";
  return "public";
}

/**
 * The scope a recorded tier belongs to. "operational" carries no scope of its
 * own, so it is derived from the probe origin; a tier recorded without a usable
 * origin cannot be scoped and therefore cannot qualify anything.
 */
export function scopeForTier(tier: IngressEvidenceTier, probeOrigin?: string | null): IngressEvidenceScope | null {
  switch (tier) {
    case "unit":
    case "local_integration":
      return "loopback";
    case "real_tailnet":
      return "tailnet";
    case "public_internet":
      return "public";
    case "operational":
      return probeOrigin ? deriveEvidenceScope(probeOrigin) : null;
  }
}

/**
 * The tier a scope actually earns. "operational" is only reachable through an
 * explicit sustained-operation receipt; scope alone never implies it.
 */
export function tierForScope(scope: IngressEvidenceScope, options: { operational?: boolean } = {}): IngressEvidenceTier {
  if (options.operational === true) return "operational";
  switch (scope) {
    case "loopback":
      return "local_integration";
    case "tailnet":
      return "real_tailnet";
    case "public":
      return "public_internet";
  }
}

export interface EvidenceRequirement {
  /** The scope in which the claim must have been observed. */
  scope: IngressEvidenceScope;
  /** The minimum tier that may satisfy the claim. */
  tier: IngressEvidenceTier;
}

/**
 * The single qualification predicate. The scope must match exactly and the
 * tier must be at least as strong. A public observation therefore never
 * qualifies a tailnet claim, and a loopback test never qualifies either.
 */
export function evidenceSatisfies(
  observation: { scope: IngressEvidenceScope; tier: IngressEvidenceTier },
  requirement: EvidenceRequirement,
): boolean {
  if (observation.scope !== requirement.scope) return false;
  return tierSatisfies(observation.tier, requirement.tier);
}

export type IngressPrivacyClass = "TAILNET_PRIVATE" | "PUBLIC_INTERNET" | "PROVIDER_RELAY";

/**
 * Privacy-scoped qualification. A tailnet-private route needs tailnet
 * evidence; a public or relayed route needs public evidence. The two are never
 * interchangeable, even at the "operational" tier, because an operational
 * observation still happened on one specific side of the boundary.
 */
export function evidenceSatisfiesPrivacy(
  observation: { scope: IngressEvidenceScope; tier: IngressEvidenceTier },
  privacy: IngressPrivacyClass,
): boolean {
  if (observation.tier === "unit") return false;
  if (privacy === "TAILNET_PRIVATE") {
    return observation.scope === "tailnet"
      && (observation.tier === "real_tailnet" || observation.tier === "operational");
  }
  return observation.scope === "public"
    && (observation.tier === "public_internet" || observation.tier === "operational");
}
