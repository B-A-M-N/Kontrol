/**
 * Public OAuth MCP listener app (P0-02): a THIRD, independently authenticated
 * listener surface for public ingress (Tailscale Funnel / HTTPS bridge). It
 * mounts ONLY: Host allowlist validation, request logging with redacted proxy
 * context, the SDK OAuth router, bearer-authenticated /mcp, and liveness.
 * There is deliberately no ACP router, no diagnostics, no Workspace App
 * assets, no tunnel discovery metadata, and no peer surface — anything not
 * mounted falls through to Express's 404.
 *
 * Like the peer app, this is one Kontrol process: every manager/DB/session
 * map is shared through the injected handler's deps spread; only the
 * listener-kind fence differs ("owner_public" sessions never attach from the
 * owner or peer listener and vice versa).
 *
 * Performance contract: config is parsed once at startup (the allowlist is
 * built once per app, not per request); the per-request work is exactly the
 * same middleware-chain pattern as app.ts/peer-app.ts.
 */
import { randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { ServerConfig } from "../config.js";
import type { SingleUserOAuthProvider } from "../oauth-provider.js";
import type { DerivedAuth } from "./auth.js";
import { logEvent, requestPath } from "../logger.js";
import { hostMatchesAllowlist, normalizeHostAllowlist, strictHostHeaderValidation } from "../ingress/host-policy.js";
import { normalizeIpLiteral, resolveClientIp, type TrustedProxyPolicy } from "../ingress/proxy-context.js";
import { MCP_HTTP_BODY_LIMIT_BYTES, rejectOversizedBody } from "./mcp-session-state.js";

export interface PublicMcpAppDeps {
  readonly config: ServerConfig;
  /** Derived once by deriveAuth(config); the public listener reuses the SAME provider as the owner app. */
  readonly oauthProvider: SingleUserOAuthProvider;
  readonly resourceServerUrl: URL;
  readonly bearerAuth: NonNullable<DerivedAuth["bearerAuth"]>;
  /** Bound MCP request handler (handleMcpHttpRequest with public-listener deps). */
  readonly handleMcpRequest: (req: Request, res: Response) => void;
  /** Defaults to direct (socket-address-only): forwarded headers are never honored. */
  readonly trustedProxyPolicy?: TrustedProxyPolicy;
  /**
   * F2-1: edge-limiter caps, injectable so tests can override and wired from
   * config (KONTROL_PUBLIC_MCP_EDGE_*). The authorize-attempt throttle (20
   * POST /authorize attempts per sliding 5-minute window per key,
   * KONTROL_PUBLIC_MCP_EDGE_AUTHORIZE_ATTEMPTS) bounds the public listener's
   * contribution to the shared provider global brute-force ceiling (50
   * failures / 5-min window) to under half of it, so a single IP cannot lock
   * the operator's own /authorize. Successful OAuth-surface requests are
   * capped at 60/min/IP (one client bootstrap is ~6 requests); /mcp tool
   * traffic at 240/min/IP.
   */
  readonly edgeOAuthSurfaceMaxPerMinute?: number;
  readonly edgeMcpMaxPerMinute?: number;
  readonly edgeAuthorizeMaxAttemptsPerWindow?: number;
}

// F2-A supersedes P1-1's "one shared router" for the PUBLIC listener: sharing
// the owner router merged the two budgets, and with proxyPeerIps unset the
// shared limiter key (req.ip) on the public listener collapses onto the same
// loopback bucket the owner's own OAuth traffic uses — a remote caller could
// drain register/authorize/token budgets and lock the operator's /authorize.
// The public app therefore builds its OWN mcpAuthRouter (same shared
// provider — credentials/issuance logic unchanged) with the SDK rate limiters
// DISABLED on all four handler option groups (rateLimit: false → the handler
// skips rateLimit() entirely: no MemoryStore, no setInterval, zero timers).
// Public rate protection is entirely OUR edge limiter below.
//
// Residual (documented, out of scope): public traffic still shares the
// provider's GLOBAL brute-force failure ceiling with the owner; a distributed
// attack can spend that ceiling. Full isolation requires provider surgery.
// A SINGLE IP is bounded by the authorize-attempt throttle below, not by the
// request caps.

// P2-2/F2-B edge limiter: fixed-window, no timers (window/volume state is
// evaluated lazily per request, mirroring the bounded failed-auth limiter in
// src/peer/auth.ts). Keying: req.ip — in direct mode that is the socket
// address (spoof-proof); in exact_peers mode Express derives req.ip as the
// RIGHTMOST non-trusted hop, which the trusted front end appends, so a client
// cannot forge it by prepending XFF entries. The leftmost XFF chain entry
// (resolveClientIp) is forgeable and is used for DIAGNOSTICS LOG FIELDS ONLY
// — never limiting, never authorization. Protecting the provider's global
// failure ceiling is the AUTHORIZE-ATTEMPT THROTTLE below, not the request caps.
const EDGE_WINDOW_MS = 60_000;
const EDGE_MAX_KEYS = 1_024;
const EDGE_OAUTH_SURFACE_DEFAULT_PER_MINUTE = 60;
const EDGE_MCP_DEFAULT_PER_MINUTE = 240;
// F2-1 (redesigned after the round-4 review): authorize-attempt throttle.
// The provider's global brute-force ceiling (AUTH_GLOBAL_MAX_FAILURES = 50
// per 5-minute ANCHORED window, src/oauth-provider.ts) is shared between the
// owner app and this public listener, and the ONLY provider-recorded failure
// path is POST /authorize with a wrong owner token (src/oauth-provider.ts:301,
// answered 401). We therefore bound the raw ATTEMPT RATE per req.ip with a
// true sliding window, counted at REQUEST time BEFORE the provider runs:
// any window-length span receives at most EDGE_AUTHORIZE_MAX_ATTEMPTS (+1 at
// the exact span boundary, since the oldest attempt ages out exactly as the
// new one arrives) attempts from one IP, so any provider window — anchored
// however the attacker likes — receives fewer failures than the 50 ceiling.
// PATH MATCHING mirrors Express 5 default routing (case-insensitive, trailing
// slash optional): the SDK mounts the authorize handler with router.use, so
// "/authorize/", "/AUTHORIZE" and "/authorize//" reach the provider too — the
// predicate must classify them identically (normalizedRoutePath). Counting at
// admission also makes the bound immune to aborted responses (an
// outcome-based counter under-counts when the client disconnects after the
// provider records but before the response flushes). Attempts, not outcomes:
// correct owner tokens pass through untouched.
const EDGE_AUTHORIZE_WINDOW_MS = 5 * 60_000;
const EDGE_AUTHORIZE_MAX_ATTEMPTS = 20;

interface EdgeWindow { timestamps: number[]; lastSeenAtMs: number }
interface AuthorizeAttempts { timestamps: number[]; lastSeenAtMs: number }

/**
 * Sliding-window authorize-attempt throttle (F2-1). Admission-time check and
 * record in one step; the timestamps kept per key bound the attempts in ANY
 * window-length span to maxAttemptsPerWindow (for every kept index i,
 * timestamps[i + max] - timestamps[i] >= windowMs holds by construction).
 * Pure data-plane (no timers); pruning is inline and bounded by EDGE_MAX_KEYS.
 * Returns true when the POST /authorize attempt may proceed.
 */
export function edgeAuthorizeAttemptCheck(
  store: Map<string, AuthorizeAttempts>,
  key: string,
  nowMs: number,
  maxAttemptsPerWindow: number,
  windowMs: number = EDGE_AUTHORIZE_WINDOW_MS,
): boolean {
  const entry = store.get(key);
  if (entry) {
    entry.timestamps = entry.timestamps.filter((ts) => nowMs - ts < windowMs);
    if (entry.timestamps.length >= maxAttemptsPerWindow) {
      entry.lastSeenAtMs = nowMs;
      return false;
    }
    entry.timestamps.push(nowMs);
    entry.lastSeenAtMs = nowMs;
  } else {
    store.set(key, { timestamps: [nowMs], lastSeenAtMs: nowMs });
  }
  if (store.size > EDGE_MAX_KEYS) {
    // Bounded volume: evict the single least-recently-seen key (O(n) scan).
    let oldestKey: string | undefined;
    let oldestSeen = Infinity;
    for (const [k, w] of store) {
      if (w.lastSeenAtMs < oldestSeen) {
        oldestSeen = w.lastSeenAtMs;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) store.delete(oldestKey);
  }
  return true;
}

/**
 * Normalize a request path with Express 5 default routing semantics
 * (case-insensitive, non-strict trailing slash) so predicates classify
 * exactly the requests the SDK router — mounted with router.use — accepts:
 * "/authorize/", "/AUTHORIZE" and "/authorize//" all normalize to
 * "/authorize".
 */
export function normalizedRoutePath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.length > 1 && lower.endsWith("/")) {
    return lower.replace(/\/+$/, "");
  }
  return lower;
}

/** The SDK OAuth-router endpoint paths (metadata endpoints included). */
export function isOAuthSurfacePath(path: string): boolean {
  const normalized = normalizedRoutePath(path);
  return normalized === "/authorize" || normalized === "/token" || normalized === "/register" || normalized === "/revoke"
    || normalized.startsWith("/.well-known/");
}

/**
 * Bounded per-key fixed-window counter. Returns true when the request is
 * allowed. Pure data-plane: no timers, no I/O; pruning happens inline on
 * each call (cheap map scan bounded by EDGE_MAX_KEYS) so nothing needs to be
 * registered in shutdown. Exported for direct unit testing.
 */
export function edgeRateLimitCheck(
  store: Map<string, EdgeWindow>,
  key: string,
  nowMs: number,
  maxRequestsPerMinute: number,
): boolean {
  const window = store.get(key) ?? { timestamps: [], lastSeenAtMs: nowMs };
  window.timestamps = window.timestamps.filter((ts) => nowMs - ts < EDGE_WINDOW_MS);
  window.timestamps.push(nowMs);
  window.lastSeenAtMs = nowMs;
  store.set(key, window);
  if (window.timestamps.length > maxRequestsPerMinute) {
    return false;
  }
  if (store.size > EDGE_MAX_KEYS) {
    // Bounded volume: evict the single least-recently-seen key (O(n) scan,
    // no allocation). Size exceeds the cap by at most one per call.
    let oldestKey: string | undefined;
    let oldestSeen = Infinity;
    for (const [k, w] of store) {
      if (w.lastSeenAtMs < oldestSeen) {
        oldestSeen = w.lastSeenAtMs;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) store.delete(oldestKey);
  }
  return true;
}

/**
 * Trust-proxy callback factory (P1-2). DIRECT mode: never trust any proxy —
 * req.ip stays the socket address, so the SDK rate limiter cannot be bucketed
 * or split by spoofed forwarded headers. EXACT_PEERS: trust ONLY the actual
 * adjacent peer (req.socket.remoteAddress after IPv4-mapped normalization);
 * the socket address is authoritative and forwarded headers are not
 * consulted for the trust decision itself — Express then derives req.ip from
 * X-Forwarded-For ONLY for trusted-socket requests, which the SDK limiter
 * keys on. Any other socket address → not trusted.
 */
export function publicTrustProxyValue(policy: TrustedProxyPolicy): boolean | ((ip: string, distance: number) => boolean) {
  if (policy.mode === "direct") return false;
  const peers = new Set(policy.peers.map(normalizeIpLiteral));
  return (ip: string) => peers.has(normalizeIpLiteral(ip.replace(/^::ffff:/i, "")));
}

/**
 * Exact Host allowlist for the public listener: the canonical publicBaseUrl
 * hostname, the allowedHosts of every ENABLED owner_public ingress profile
 * (stored operator-verbatim, normalized here per the PR-A contract), and
 * loopback. Wildcards are impossible — normalizeHostAllowlist throws on them.
 */
export function publicMcpAllowedHosts(config: ServerConfig): string[] {
  return normalizeHostAllowlist([
    new URL(config.publicBaseUrl).hostname,
    ...(config.ingress?.profiles ?? [])
      .filter((profile) => profile.enabled && profile.audience === "owner_public" && profile.target === "public_oauth_listener")
      .flatMap((profile) => profile.allowedHosts),
    "127.0.0.1",
    "localhost",
    "[::1]",
  ]);
}

/** Whether a normalized Host authority matches the exact listener allowlist.
 * Only loopback entries permit an arbitrary probe port. */
export function publicHostMatches(resolvedHost: string, allowlist: readonly string[]): boolean {
  return hostMatchesAllowlist(resolvedHost, allowlist);
}

/**
 * Redact an IP literal to a coarse prefix for logs: IPv4 keeps its first
 * three octets, IPv6 its first three groups. Short/loopback forms carry no
 * external sensitivity and pass through.
 */
export function redactIpPrefix(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const normalized = normalizeIpLiteral(ip);
  const v4 = normalized.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.x`;
  const groups = normalized.split(":").filter(Boolean);
  if (groups.length >= 3) return `${groups.slice(0, 3).join(":")}::…`;
  return normalized;
}

/**
 * Resolve the authoritative client IP for LOG FIELDS ONLY (never
 * authorization) and redact it. Exported pure so tests can assert spoof
 * resistance directly: with the default direct policy, forwarded headers are
 * reported as rejected and the socket address remains the source.
 */
export function publicClientLogFields(
  input: {
    remoteAddress: string | undefined;
    headers: Record<string, string | string[] | undefined>;
    policy: TrustedProxyPolicy;
  },
): { clientIpPrefix?: string; rejectedForwarded: boolean } {
  const resolved = resolveClientIp({
    remoteAddress: input.remoteAddress,
    xForwardedFor: typeof input.headers["x-forwarded-for"] === "string" ? input.headers["x-forwarded-for"] : undefined,
    cfConnectingIp: typeof input.headers["cf-connecting-ip"] === "string" ? input.headers["cf-connecting-ip"] : undefined,
    policy: input.policy,
  });
  return { clientIpPrefix: redactIpPrefix(resolved.ip), rejectedForwarded: resolved.rejectedForwarded };
}

export function createPublicMcpApp(deps: PublicMcpAppDeps): { app: Express } {
  const { config } = deps;
  if (!config.publicMcp) {
    throw new Error("createPublicMcpApp requires config.publicMcp (KONTROL_PUBLIC_MCP_ENABLED=1).");
  }
  const app = express();

  // P1-2: policy-driven trust proxy. DIRECT (default) → no proxy is ever
  // trusted, req.ip = socket address. EXACT_PEERS → only the configured
  // adjacent bridge/relay IP is trusted, so the SDK limiter keys on the real
  // client instead of one global front-end bucket. Never trust-all.
  app.set("trust proxy", publicTrustProxyValue(deps.trustedProxyPolicy ?? { mode: "direct" }));

  // F2-B edge limiter: per req.ip fixed window, ahead of EVERY gated surface.
  // Two limit classes: the OAuth surface (strict — protects the owner's own
  // /authorize from a single IP draining the shared provider's global failure
  // ceiling) and /mcp tool traffic (bounded but usable). Rate limiting only —
  // it never authorizes. resolveClientIp runs ONCE per request here (F3-E);
  // its leftmost-XFF result is diagnostics-only and never the limiter key.
  const edgeOAuthStore = new Map<string, EdgeWindow>();
  const edgeMcpStore = new Map<string, EdgeWindow>();
  const edgeAuthorizeStore = new Map<string, AuthorizeAttempts>();
  // Cap precedence: explicit deps override (test harness) first, then the
  // operator's config values, then the built-in defaults. config.publicMcp is
  // guaranteed present (guarded above).
  const oauthSurfaceCap = deps.edgeOAuthSurfaceMaxPerMinute
    ?? config.publicMcp.edgeOAuthSurfaceMaxPerMinute
    ?? EDGE_OAUTH_SURFACE_DEFAULT_PER_MINUTE;
  const mcpCap = deps.edgeMcpMaxPerMinute
    ?? config.publicMcp.edgeMcpMaxPerMinute
    ?? EDGE_MCP_DEFAULT_PER_MINUTE;
  const authorizeAttemptCap = deps.edgeAuthorizeMaxAttemptsPerWindow
    ?? config.publicMcp.edgeAuthorizeMaxAttemptsPerWindow
    ?? EDGE_AUTHORIZE_MAX_ATTEMPTS;
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Diagnostics-only resolution (leftmost XFF is forgeable; never used for
    // limiting or authorization). The limiter key is req.ip.
    const resolved = resolveClientIp({
      remoteAddress: req.socket.remoteAddress,
      xForwardedFor: typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"] : undefined,
      cfConnectingIp: typeof req.headers["cf-connecting-ip"] === "string" ? req.headers["cf-connecting-ip"] : undefined,
      policy: deps.trustedProxyPolicy ?? { mode: "direct" },
    });
    // One resolution per request (F3-E): stash for the log middleware below.
    res.locals.publicClientLog = {
      clientIpPrefix: redactIpPrefix(resolved.ip),
      rejectedForwarded: resolved.rejectedForwarded,
    };
    // Key on req.ip: direct mode → socket address (spoof-proof); exact_peers
    // mode → rightmost non-trusted hop (Express re-derives it under the trust
    // proxy callback; not forgeable through the trusted peer by prepending
    // XFF entries).
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const nowMs = Date.now();
    const onOAuthSurface = isOAuthSurfacePath(req.path);
    // F2-1: authorize-attempt throttle. POST /authorize is the ONLY path that
    // can make the shared provider record a brute-force failure
    // (src/oauth-provider.ts:301), so the attempt rate per IP is bounded at
    // admission — BEFORE the provider runs — with a true sliding window. This
    // bounds the public listener's contribution to the provider's global
    // ceiling for ANY 5-minute span, immune to window anchoring and to
    // aborted responses.
    const isAuthorizeAttempt = req.method === "POST" && normalizedRoutePath(req.path) === "/authorize";
    if (isAuthorizeAttempt && !edgeAuthorizeAttemptCheck(edgeAuthorizeStore, key, nowMs, authorizeAttemptCap)) {
      logEvent(config.logging, "warn", "public_mcp_authorize_throttled", {
        clientIpPrefix: (res.locals.publicClientLog as { clientIpPrefix?: string }).clientIpPrefix,
        rejectedForwarded: (res.locals.publicClientLog as { rejectedForwarded: boolean }).rejectedForwarded,
        path: requestPath(req),
      });
      res.status(429).json({ error: { code: "rate_limited", message: "Too many requests; retry later." } });
      return;
    }
    const allowed = edgeRateLimitCheck(
      onOAuthSurface ? edgeOAuthStore : edgeMcpStore,
      key,
      nowMs,
      onOAuthSurface ? oauthSurfaceCap : mcpCap,
    );
    if (!allowed) {
      logEvent(config.logging, "warn", "public_mcp_edge_rate_limited", {
        clientIpPrefix: (res.locals.publicClientLog as { clientIpPrefix?: string }).clientIpPrefix,
        rejectedForwarded: (res.locals.publicClientLog as { rejectedForwarded: boolean }).rejectedForwarded,
        oauthSurface: onOAuthSurface,
        path: requestPath(req),
      });
      res.status(429).json({ error: { code: "rate_limited", message: "Too many requests; retry later." } });
      return;
    }
    next();
  });

  // 1. Strict shared Host allowlist. Rejects duplicate Host entries,
  //    malformed authorities, unexpected ports, and unknown hosts.
  const allowedHosts = publicMcpAllowedHosts(config);
  app.use(strictHostHeaderValidation(allowedHosts));

  // 2. Request log middleware. Proxy fields were resolved ONCE per request
  //    in the edge limiter above (F3-E) and stashed on res.locals; they feed
  //    ONLY these log fields — nothing downstream authorizes on them, and
  //    Tailscale identity headers are not consulted at all.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;
    res.on("finish", () => {
      if (!config.logging.requests) return;
      const publicClientLog = res.locals.publicClientLog as { clientIpPrefix?: string; rejectedForwarded: boolean } | undefined;
      logEvent(config.logging, "info", "public_mcp_http_request", {
        requestId,
        listener: "public",
        method: req.method,
        path: requestPath(req),
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        rpcMethod: typeof req.body?.method === "string" ? req.body.method : undefined,
        ...(publicClientLog ?? publicClientLogFields({
          remoteAddress: req.socket.remoteAddress,
          headers: req.headers,
          policy: deps.trustedProxyPolicy ?? { mode: "direct" },
        })),
      });
    });
    next();
  });

  // 3. OAuth discovery/registration/authorize/token surface — the public
  //    listener's OWN router (F2-A): same shared provider, issuer, and
  //    resource metadata as the owner app, but with the SDK rate limiters
  //    DISABLED (rateLimit: false → the handlers skip rateLimit() entirely:
  //    no MemoryStore, no setInterval) so the two listeners' budgets stay
  //    separate and the public surface adds zero timers. Rate protection on
  //    this surface is entirely the edge limiter above.
  app.use(mcpAuthRouter({
    provider: deps.oauthProvider,
    issuerUrl: new URL(config.publicBaseUrl),
    baseUrl: new URL(config.publicBaseUrl),
    resourceServerUrl: deps.resourceServerUrl,
    scopesSupported: config.oauth.scopes,
    resourceName: "Kontrol",
    authorizationOptions: { rateLimit: false },
    tokenOptions: { rateLimit: false },
    clientRegistrationOptions: { rateLimit: false },
    revocationOptions: { rateLimit: false },
  }));

  // 4. Authenticate /mcp BEFORE any body parsing (same ordering as app.ts):
  //    a large unauthenticated request never spends parser memory.
  app.use("/mcp", (req: Request, res: Response, next: NextFunction) => deps.bearerAuth(req, res, next));

  // 5. /mcp body gates + the shared MCP request handler.
  app.all(
    "/mcp",
    rejectOversizedBody(MCP_HTTP_BODY_LIMIT_BYTES, "mcp"),
    express.json({ limit: MCP_HTTP_BODY_LIMIT_BYTES }),
    (req: Request, res: Response) => deps.handleMcpRequest(req, res),
  );

  // 6. Minimal liveness: boolean status only, no diagnostics.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, name: "kontrol-public-mcp" });
  });

  return { app };
}
