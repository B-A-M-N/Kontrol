/**
 * Expected-vs-observed ingress classification and DRY-RUN planning.
 * Configuration logic and one bounded loopback application probe; the Tailscale
 * lifecycle controller lives separately in controller.ts.
 *
 * ZERO MUTATION: nothing here executes Tailscale. `buildIngressPlan` only
 * prints a human-readable command preview; mutations go through the durable
 * profile controller, never the server hot path.
 */
import { request as httpRequest } from "node:http";
import type { IngressAudience, IngressConfig, IngressKind, IngressListenerTarget, IngressProfile } from "./types.js";
import { kindPrivacy } from "./types.js";
import type { IngressRouteIdentity, ServeMapping, TailscaleFacts } from "./tailscale-status.js";
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

export type ProfileClassification =
  | "DISABLED"
  | "CONFIG_INVALID"
  | "LOCAL_DOWN"
  | "NETWORK_DOWN"
  | "NO_MAPPING"
  | "MISMATCH"
  | "MAPPING_MATCHED"
  | "EXTERNAL_UNVERIFIED"
  | "UNKNOWN";

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

export interface ExpectedRouteIdentity extends Omit<IngressRouteIdentity, "hostname" | "allowFunnel"> {
  hostname: string | null;
  allowFunnel: boolean;
}

/**
 * Parse a proxy target into the EXACT upstream identity. Unlike the old
 * canonical string comparison, any path other than "/", query, fragment, or
 * userinfo makes the identity unrepresentable (null). A configured loopback
 * spelling of localhost or [::1] is normalized to 127.0.0.1; this is the one
 * equivalence accepted for local upstream hostnames.
 */
export function normalizeLocalTarget(raw: string): string | null {
  const identity = parseUpstreamTarget(raw);
  if (!identity || identity.path !== "/" ) return null;
  const host = normalizeLoopbackHost(identity.host);
  return host === null ? null : `${identity.scheme}://${host}:${identity.port}${identity.path}`;
}

function parseUpstreamTarget(raw: string): { scheme: "http" | "https"; host: string; port: string; path: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  const port = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
  return { scheme: url.protocol === "https:" ? "https" : "http", host: url.hostname.toLowerCase(), port, path: "/" };
}

function normalizeLoopbackHost(host: string): "127.0.0.1" | null {
  // WHATWG URL keeps IPv6 authorities bracketed.
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (host === "localhost" || unbracketed === "::1") return "127.0.0.1";
  return host === "127.0.0.1" ? "127.0.0.1" : null;
}

/**
 * Build the complete expected route identity from the configured origin,
 * target listener, and observed Tailscale self identity.
 */
export function expectedRouteIdentity(
  profile: IngressProfile,
  expectedLocalPort: number | null,
  dnsName: string | null,
): ExpectedRouteIdentity | null {
  if (expectedLocalPort === null) return null;
  try {
    const url = new URL(profile.externalOrigin);
    const hostname = url.hostname.toLowerCase();
    // A configured .ts.net profile must match the actual Tailscale self DNS
    // name. Other hostnames remain acceptable for aliases, but can never be
    // proven by this facts document; hostname stays null and positive matching
    // is inconclusive.
    const nodeMatches = dnsName !== null && hostname === dnsName.toLowerCase();
    return {
      hostname: nodeMatches ? hostname : null,
      listenPort: url.port !== "" ? url.port : "443",
      handlerPath: "/",
      upstreamScheme: "http",
      upstreamHost: "127.0.0.1",
      upstreamPort: String(expectedLocalPort),
      upstreamPath: "/",
      allowFunnel: profile.kind === "tailscale_funnel",
    };
  } catch {
    return null;
  }
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
 * Exact route classification. `MAPPING_MATCHED` means every identity field
 * matched, the backend is Running, and the actual self DNS identity proves
 * the configured node. It intentionally does NOT claim end-to-end readiness:
 * that requires an authenticated protocol probe over the external route.
 */
export function classifyProfile(options: {
  profile: IngressProfile;
  facts: Pick<TailscaleFacts,
    | "serveMappings"
    | "funnelMappings"
    | "serveStatusSchemaSupported"
    | "funnelStatusSchemaSupported"
    | "serveFunnelAttributionComplete"
    | "funnelFunnelAttributionComplete"
    | "backendState"
    | "dnsName">;
  expectedLocalPort: number | null;
  localReachable?: boolean;
}): ProfileClassification {
  const { profile, facts, expectedLocalPort, localReachable } = options;
  if (!profile.enabled) return "DISABLED";
  if (profile.kind !== "tailscale_serve" && profile.kind !== "tailscale_funnel") {
    return profile.kind === "https_bridge" ? "EXTERNAL_UNVERIFIED" : "NO_MAPPING";
  }
  const schemaSupported = profile.kind === "tailscale_funnel"
    ? facts.funnelStatusSchemaSupported
    : facts.serveStatusSchemaSupported;
  if (!schemaSupported) return "UNKNOWN";
  if (facts.backendState !== "Running") return "NETWORK_DOWN";
  if (expectedLocalPort === null) return "NO_MAPPING";
  if (localReachable === false) return "LOCAL_DOWN";

  const expected = expectedRouteIdentity(profile, expectedLocalPort, facts.dnsName);
  if (!expected || expected.hostname === null) return "UNKNOWN";
  const rawCandidates = profile.kind === "tailscale_funnel" ? facts.funnelMappings : facts.serveMappings;
  const candidates = rawCandidates.filter((mapping) => mapping.identity !== undefined);
  // The completeness of the exposure attribution is a property of the union
  // of both status documents, and it gates the classification in BOTH
  // directions. When it is incomplete the route identity carries
  // allowFunnel: false, because the exposure could not be read, so the route
  // cannot be compared exactly. Falling through to the mismatch branch
  // would derive a POSITIVE MISMATCH from a dropped exposure signal: the
  // route would be reported as a different, actionable route when all that
  // is actually known is that its exposure is unproven. A dropped signal
  // proves nothing in either direction, so the classification stays UNKNOWN.
  const attributionComplete = profile.kind === "tailscale_funnel"
    ? facts.funnelFunnelAttributionComplete
    : facts.serveFunnelAttributionComplete;
  if (!attributionComplete) return "UNKNOWN";
  const exact = candidates.some((mapping) => routeIdentityEquals(mapping.identity, expected));
  if (exact) return "MAPPING_MATCHED";
  const routeDiffers = candidates.some((mapping) => routeDiffersForProfile(mapping, profile, expectedLocalPort));
  if (routeDiffers) return "MISMATCH";
  return "NO_MAPPING";
}

function routeIdentityEquals(
  actual: IngressRouteIdentity | undefined,
  expected: ExpectedRouteIdentity,
): boolean {
  if (!actual || expected.hostname === null) return false;
  return actual.hostname === expected.hostname
    && actual.listenPort === expected.listenPort
    && actual.handlerPath === expected.handlerPath
    && actual.upstreamScheme === expected.upstreamScheme
    && actual.upstreamHost === expected.upstreamHost
    && actual.upstreamPort === expected.upstreamPort
    && actual.upstreamPath === expected.upstreamPath
    && actual.allowFunnel === expected.allowFunnel;
}

/** Effective port of a URL: WHATWG URL drops explicitly-written default
 * ports, so re-parsing a sanitized target (http://127.0.0.1:80) yields an
 * empty port — fall back to the scheme default. */
function effectivePort(url: URL): string {
  return url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
}

/** A route is related to this profile when it shares the expected external
 * host:port, local target port, or target path. Related-but-not-equal is an
 * actionable MISMATCH, not NO_MAPPING. */
function routeDiffersForProfile(mapping: ServeMapping, profile: IngressProfile, expectedLocalPort: number): boolean {
  const identity = mapping.identity;
  if (identity) {
    if (identity.upstreamPort === String(expectedLocalPort)) return true;
    if (identity.handlerPath !== "/") return true;
    if (mapping.hostPort !== undefined) {
      const expected = externalOriginHostPort(profile);
      if (expected !== null && mapping.hostPort === expected) return true;
    }
    return false;
  }
  try {
    if (effectivePort(new URL(mapping.proxyTarget)) === String(expectedLocalPort)) return true;
  } catch {
    // Unparseable legacy targets are inconclusive, not a positive mismatch.
  }
  const expected = externalOriginHostPort(profile);
  return mapping.hostPort !== undefined && expected !== null && mapping.hostPort === expected;
}

function externalOriginHostPort(profile: IngressProfile): string | null {
  try {
    const url = new URL(profile.externalOrigin);
    return url.hostname.toLowerCase() + ":" + (url.port !== "" ? url.port : "443");
  } catch {
    return null;
  }
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
  const expected = expectedRouteIdentity(profile, expectedLocalPort, facts.dnsName);
  if (!expected) return null;
  const matchedRoutes = candidates.filter((mapping) => routeIdentityEquals(mapping.identity, expected));
  if (matchedRoutes.length > 0) return matchedRoutes[0];
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
      const expectedTarget = `http://127.0.0.1:${expectedLocalPort}/`;
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
      expectedLocalTarget: expectedLocalPort !== null ? `http://127.0.0.1:${expectedLocalPort}/` : null,
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
  if (classification === "MAPPING_MATCHED") {
    notes.push("exact expected route tuple matched; end-to-end readiness still requires an authenticated protocol probe over the external route");
  }
  if (classification === "EXTERNAL_UNVERIFIED") {
    notes.push("bridge deployment requires public-origin qualification; Tailscale status cannot establish this path");
  }
  if (profile.kind === "https_bridge") {
    notes.push("no tailscale observation applies to this kind; qualify the bridge with scripts/probe-ingress-bridge.mjs against its PUBLIC origin (see deploy/bridge/README.md)");
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
        note: "informational — no Tailscale command applies; deploy the bridge from deploy/bridge/ and qualify with scripts/probe-ingress-bridge.mjs",
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
 * Default bounded loopback application probe. It sends a valid MCP initialize
 * without credentials and accepts only the expected authentication boundary:
 * OAuth challenge or peer unauthorized response. A random TCP listener or an
 * unauthenticated MCP listener cannot satisfy this check. This proves the
 * listener protocol/auth gate is present; it does not prove valid credentials
 * or external route readiness, so it never upgrades mapping to READY.
 */
export function defaultLocalProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (up: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(up);
    };
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      timeout: 1_000,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > 4_096) request.destroy();
      });
      response.on("end", () => {
        const oauthChallenge = response.statusCode === 401 && typeof response.headers["www-authenticate"] === "string";
        const peerChallenge = response.statusCode === 401 && body.includes('"unauthorized_peer"');
        settle(oauthChallenge || peerChallenge);
      });
      response.on("error", () => settle(false));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => settle(false));
    request.end(JSON.stringify({
      jsonrpc: "2.0",
      id: "kontrol-ingress-local-probe",
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kontrol-ingress-probe", version: "1" } },
    }));
  });
}
