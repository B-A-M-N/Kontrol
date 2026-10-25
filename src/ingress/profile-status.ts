/**
 * Expected-vs-observed ingress classification and DRY-RUN planning (P1-08).
 * Pure configuration logic plus one bounded loopback probe primitive; the
 * probe and the Tailscale facts layer are only ever driven by the one-shot
 * `kontrol ingress inspect|plan` CLI command — never by the server hot path.
 *
 * ZERO MUTATION: nothing here executes Tailscale. `buildIngressPlan` only
 * PRINTS the commands an operator would run by hand; apply/disable do not
 * exist in this build.
 */
import { connect } from "node:net";
import type { IngressAudience, IngressConfig, IngressKind, IngressListenerTarget, IngressProfile } from "./types.js";
import { kindPrivacy } from "./types.js";
import type { ServeMapping, TailscaleFacts } from "./tailscale-status.js";
import { validateIngressProfiles, type IngressValidationContext } from "./validate.js";

/** Structural subset of ServerConfig this module needs (keeps the ingress
 * modules decoupled from the full config loader). */
export interface IngressConfigSource {
  authMode: "oauth" | "tunnel";
  publicBaseUrl?: string;
  peer?: { port: number };
  publicMcp?: { port: number };
  ingress?: IngressConfig;
}

export type ProfileClassification = "DISABLED" | "LOCAL_DOWN" | "NO_MAPPING" | "MISMATCH" | "MATCHED";

export type IngressPrivacy = ReturnType<typeof kindPrivacy>;

/** Injectable loopback readiness probe (bounded net.connect in the default). */
type LocalProbe = (port: number) => Promise<boolean>;

/** Port the CLI probes before classifying; null when nothing must be probed
 * (secure_tunnel_listener is never mapped or probed in this build). */
export function expectedLocalTargetPort(profile: IngressProfile, config: IngressConfigSource): number | null {
  if (profile.target === "peer_listener") return config.peer?.port ?? null;
  if (profile.target === "public_oauth_listener") return config.publicMcp?.port ?? null;
  return null;
}

/** Mirror of the startup validation context built in src/config.ts so the CLI
 * validates with EXACTLY the same inputs the server would. */
export function validationContextFromConfig(config: IngressConfigSource): IngressValidationContext {
  return {
    authMode: config.authMode,
    peerEnabled: config.peer !== undefined,
    hasPeerCredentials: config.peer !== undefined,
    publicBaseUrl: config.publicBaseUrl,
  };
}

/**
 * Normalize a proxy target to the canonical loopback spelling
 * http://127.0.0.1:<effectivePort>; null when the target is not loopback or
 * not a parseable URL. 127.0.0.1, [::1], and localhost all normalize to
 * 127.0.0.1, and the effective port falls back to the scheme default (80/443)
 * because WHATWG URL drops explicitly-written default ports.
 */
export function normalizeLocalTarget(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  // Node's URL keeps IPv6 hostnames bracketed ("[::1]"); both spellings loop back.
  if (host !== "127.0.0.1" && host !== "::1" && host !== "[::1]" && host !== "localhost") return null;
  const port = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
  return `http://127.0.0.1:${port}`;
}

export interface ProfileStatus {
  id: string;
  kind: IngressKind;
  audience: IngressAudience;
  externalOrigin: string;
  target: IngressListenerTarget;
  enabled: boolean;
  privacy: IngressPrivacy;
  /** Canonical expected local target, or null when nothing is expected. */
  expectedLocalTarget: string | null;
  /** The matching observed route, or null. */
  observed: ServeMapping | null;
  classification: ProfileClassification;
  notes: string[];
}

/**
 * Redacted inspect report: contains ONLY the whitelisted fields — never env
 * values, never credential file contents/paths, never raw tailscale output
 * beyond the four headline fields plus the profile projections.
 */
export interface IngressReport {
  cliVersion: string | null;
  backendState: string | null;
  dnsName: string | null;
  profiles: ProfileStatus[];
}

/**
 * Host/origin equality cannot be verified from tailscale status output alone:
 * Tailscale terminates TLS and the serve/funnel status JSON does not carry the
 * HTTP origin the mapping will serve. Origin checks therefore stay plan-time
 * (config canonical-origin validation), never inspect-time.
 */
export function classifyProfile(options: {
  profile: IngressProfile;
  facts: Pick<TailscaleFacts, "serveMappings" | "funnelMappings">;
  expectedLocalPort: number | null;
  localReachable?: boolean;
}): ProfileClassification {
  const { profile, facts, expectedLocalPort, localReachable } = options;
  if (!profile.enabled) return "DISABLED";
  if (profile.kind !== "tailscale_serve" && profile.kind !== "tailscale_funnel") {
    // https_bridge / secure_mcp_tunnel: no Tailscale observation applies in
    // this build (bridge deployment files arrive in a later PR).
    return "NO_MAPPING";
  }
  // Upstream tailscale renders the SAME ipn.ServeConfig for both status
  // commands, so the funnel bucket alone proves nothing: a funnel profile may
  // only match routes the document explicitly marks funnel-enabled.
  const rawCandidates = profile.kind === "tailscale_funnel" ? facts.funnelMappings : facts.serveMappings;
  const candidates = profile.kind === "tailscale_funnel"
    ? rawCandidates.filter((mapping) => mapping.allowFunnel === true)
    : rawCandidates;
  if (expectedLocalPort === null) return "NO_MAPPING";
  if (localReachable === false) return "LOCAL_DOWN";
  const expected = `http://127.0.0.1:${expectedLocalPort}`;
  const matchedRoutes = candidates.filter((mapping) => normalizeLocalTarget(mapping.proxyTarget) === expected);
  if (matchedRoutes.length > 0) {
    // A serve profile expects a TAILNET_PRIVATE route; ANY funnel-enabled
    // route to the same local port is PUBLIC exposure contradicting the
    // expectation (mirrors the plan path refusing public peer exposure) -
    // never a healthy MATCHED. ALL matches are scanned, not just the first,
    // because upstream may list several hosts proxying one local port.
    if (profile.kind === "tailscale_serve" && matchedRoutes.some((mapping) => mapping.allowFunnel === true)) return "MISMATCH";
    return "MATCHED";
  }
  if (candidates.some((mapping) => routeDiffersForProfile(mapping, profile, expectedLocalPort))) return "MISMATCH";
  return "NO_MAPPING";
}

/** Effective port of a URL: WHATWG URL drops explicitly-written default
 * ports, so re-parsing a sanitized target (http://127.0.0.1:80) yields an
 * empty port — fall back to the scheme default. */
function effectivePort(url: URL): string {
  return url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
}

/** A route "exists for this profile" (so the classification is MISMATCH, not
 * NO_MAPPING) when its local target port equals the expected port via a
 * non-canonical spelling, or when the route's Tailscale listen port equals the
 * profile's externalOrigin port but points somewhere else. */
function routeDiffersForProfile(mapping: ServeMapping, profile: IngressProfile, expectedLocalPort: number): boolean {
  try {
    if (effectivePort(new URL(mapping.proxyTarget)) === String(expectedLocalPort)) return true;
  } catch {
    // unparseable proxy target is handled by the MATCHED/NO_MAPPING checks
  }
  const originPort = externalOriginPort(profile);
  return mapping.port !== "" && originPort !== "" && mapping.port === originPort;
}

function externalOriginPort(profile: IngressProfile): string {
  try {
    const url = new URL(profile.externalOrigin);
    return url.port !== "" ? url.port : "443";
  } catch {
    return "";
  }
}

function findObservedMapping(profile: IngressProfile, expectedLocalPort: number | null, facts: TailscaleFacts): ServeMapping | null {
  if (expectedLocalPort === null) return null;
  if (profile.kind !== "tailscale_serve" && profile.kind !== "tailscale_funnel") return null;
  // Mirror classifyProfile's candidate selection exactly (funnel: only
  // explicitly funnel-enabled routes).
  const rawCandidates = profile.kind === "tailscale_funnel" ? facts.funnelMappings : facts.serveMappings;
  const candidates = profile.kind === "tailscale_funnel"
    ? rawCandidates.filter((mapping) => mapping.allowFunnel === true)
    : rawCandidates;
  const expected = `http://127.0.0.1:${expectedLocalPort}`;
  const matchedRoutes = candidates.filter((mapping) => normalizeLocalTarget(mapping.proxyTarget) === expected);
  if (matchedRoutes.length > 0) {
    // Prefer a funnel-enabled match so the observed route carries the
    // exposure flag (drives the MISMATCH note and the FUNNEL-EXPOSED marker).
    return matchedRoutes.find((mapping) => mapping.allowFunnel === true) ?? matchedRoutes[0];
  }
  // On MISMATCH, report the route that CAUSED the mismatch (THE shared
  // predicate, not a copy) so the operator sees what is actually mapped
  // where instead of a useless (none).
  return candidates.find((mapping) => routeDiffersForProfile(mapping, profile, expectedLocalPort)) ?? null;
}

/**
 * Build the redacted inspect report. `probeResults` maps a probed local port
 * to its reachability; absent ports simply skip the LOCAL_DOWN check (the CLI
 * probes sequentially and only ports that an enabled tailscale profile needs).
 * Facts-layer warnings are echoed into every profile's notes so both the human
 * and --json views carry them.
 */
export function buildIngressReport(
  config: IngressConfigSource,
  facts: TailscaleFacts,
  probeResults?: ReadonlyMap<number, boolean>,
): IngressReport {
  const profiles = config.ingress?.profiles ?? [];
  const statuses = profiles.map((profile) => {
    const expectedLocalPort = expectedLocalTargetPort(profile, config);
    const localReachable = expectedLocalPort !== null && probeResults !== undefined
      ? probeResults.get(expectedLocalPort)
      : undefined;
    const classification = classifyProfile({ profile, facts, expectedLocalPort, localReachable });
    const notes = classificationNotes(profile, classification, expectedLocalPort);
    if (profile.kind === "tailscale_serve" && classification === "MISMATCH") {
      const observedMapping = findObservedMapping(profile, expectedLocalPort, facts);
      if (observedMapping?.allowFunnel === true) {
        notes.push("the matched route is funnel-enabled (AllowFunnel: true): this route is exposed to the PUBLIC internet while the profile expects a tailnet-private route");
      }
    }
    if (profile.kind === "tailscale_funnel" && classification === "NO_MAPPING" && expectedLocalPort !== null) {
      const expectedTarget = `http://127.0.0.1:${expectedLocalPort}`;
      if (facts.funnelMappings.some((mapping) => normalizeLocalTarget(mapping.proxyTarget) === expectedTarget && mapping.allowFunnel === undefined)) {
        notes.push("the status document lists a route for this target but does not mark it funnel-enabled; the tailscale status output may have changed shape");
      }
    }
    notes.push(...facts.warnings);
    return {
      id: profile.id,
      kind: profile.kind,
      audience: profile.audience,
      externalOrigin: profile.externalOrigin,
      target: profile.target,
      enabled: profile.enabled,
      privacy: kindPrivacy(profile.kind),
      expectedLocalTarget: expectedLocalPort !== null ? `http://127.0.0.1:${expectedLocalPort}` : null,
      observed: findObservedMapping(profile, expectedLocalPort, facts),
      classification,
      notes,
    };
  });
  return {
    cliVersion: facts.cliVersion,
    backendState: facts.backendState,
    dnsName: facts.dnsName,
    profiles: statuses,
  };
}

function classificationNotes(profile: IngressProfile, classification: ProfileClassification, expectedLocalPort: number | null): string[] {
  const notes: string[] = [];
  if (classification === "DISABLED") {
    notes.push("profile is disabled (standby); no inspection applies");
  }
  if (classification === "MATCHED") {
    notes.push("mapping proxy target matches; external Host/origin equality cannot be verified from tailscale status output alone (Tailscale terminates TLS and the mapping does not carry the origin)");
  }
  if (profile.kind === "https_bridge") {
    notes.push("no tailscale observation applies to this kind; bridge deployment files arrive in a later PR");
  }
  if (profile.target === "secure_tunnel_listener") {
    notes.push("tunnel-mode owner listener is deliberately not observed or probed in this build");
  }
  if (
    classification !== "DISABLED" &&
    expectedLocalPort === null &&
    profile.target !== "secure_tunnel_listener" &&
    profile.kind !== "https_bridge"
  ) {
    notes.push("the expected local listener is not enabled in this deployment; nothing to observe locally");
  }
  return notes;
}

export interface IngressPlanEntry {
  id: string;
  kind: IngressKind;
  privacy: IngressPrivacy;
  /** Exact dry-run command; present only for plannable enabled profiles. */
  command?: string;
  /** Local target port the command would proxy to. */
  targetPort?: number;
  /** Stable refusal reason; command is always absent when this is set. */
  refused?: string;
  /** Human context: skipped (disabled) or informational (bridge) entries. */
  note?: string;
}

/**
 * PURE dry-run planner: no probes, no subprocesses. Validates the profile
 * list first (rethrowing the stable ingress_profiles_invalid error), then
 * emits one entry per profile. Refused profiles never get a command.
 */
export function buildIngressPlan(config: IngressConfigSource): IngressPlanEntry[] {
  const profiles = config.ingress?.profiles ?? [];
  validateIngressProfiles(profiles, validationContextFromConfig(config));
  const entries: IngressPlanEntry[] = [];
  for (const profile of profiles) {
    const privacy = kindPrivacy(profile.kind);
    if (!profile.enabled) {
      entries.push({ id: profile.id, kind: profile.kind, privacy, note: "disabled (standby) — skipped" });
      continue;
    }
    if (profile.target === "secure_tunnel_listener") {
      entries.push({
        id: profile.id,
        kind: profile.kind,
        privacy,
        refused: "tunnel-mode owner listener is unauthenticated at the app layer; never proxy it through Tailscale",
      });
      continue;
    }
    if (profile.kind !== "tailscale_serve" && profile.kind !== "tailscale_funnel") {
      entries.push({
        id: profile.id,
        kind: profile.kind,
        privacy,
        note: "informational — no command in this build (bridge deployment files arrive in a later PR)",
      });
      continue;
    }
    if (profile.kind === "tailscale_funnel" && profile.target === "peer_listener") {
      entries.push({
        id: profile.id,
        kind: profile.kind,
        privacy,
        refused: "public peer-bearer exposure is not supported in this build (needs P0-05 edge hardening first)",
      });
      continue;
    }
    const targetPort = expectedLocalTargetPort(profile, config);
    if (targetPort === null) {
      entries.push({
        id: profile.id,
        kind: profile.kind,
        privacy,
        refused: `the ${profile.target === "public_oauth_listener" ? "public OAuth listener" : "target listener"} is not enabled in this deployment; no local target port to plan against`,
      });
      continue;
    }
    const subcommand = profile.kind === "tailscale_funnel" ? "funnel" : "serve";
    const entry: IngressPlanEntry = {
      id: profile.id,
      kind: profile.kind,
      privacy,
      command: `tailscale ${subcommand} --bg --https=${externalOriginPort(profile)} http://127.0.0.1:${targetPort}`,
      targetPort,
    };
    if (profile.kind === "tailscale_serve" && profile.target === "public_oauth_listener") {
      entry.note = "OAuth mode and the one-canonical-owner-public rule apply; this origin must equal the canonical publicBaseUrl origin";
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Default bounded loopback readiness probe: a plain net.connect to
 * 127.0.0.1:<port> with a 500ms timeout. Resolves false on ANY failure —
 * it never throws and never retries. Used only inside the CLI command.
 */
export function defaultLocalProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 500 });
    const settle = (up: boolean): void => {
      socket.destroy();
      resolve(up);
    };
    socket.on("connect", () => settle(true));
    socket.on("timeout", () => settle(false));
    socket.on("error", () => settle(false));
  });
}
