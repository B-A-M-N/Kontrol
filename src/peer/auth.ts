/**
 * Peer authentication: bearer-token authentication against the operator's
 * credential registry with mtime-based hot reload, plus an express middleware
 * that attaches the trusted PeerPrincipal or fails closed with a 401/429.
 * Raw tokens and Authorization headers are never logged.
 */
import { statSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { PeerDescriptor } from "./config-types.js";
import { hashPeerCredential, loadPeerCredentialFile } from "./credentials.js";
import { peerPrincipalFromDescriptor, type PeerPrincipal } from "./principal.js";
import { logEvent, type LoggingConfig } from "../logger.js";

declare module "express-serve-static-core" {
  interface Request {
    peerPrincipal?: import("./principal.js").PeerPrincipal;
  }
}

const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SECRET_MIN_LENGTH = 32;
const SECRET_MAX_LENGTH = 256;

/** Fail-auth rate limiting: >30 failures within 60s from one key → 429. */
const RATE_LIMIT_MAX_FAILURES = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ENTRIES = 10_000;

export interface PeerCredentialReload {
  changed: boolean;
  generation: number;
  /** True when a prior registry remains active only under bounded atomic-update grace. */
  degraded: boolean;
  reason?: "missing" | "unreadable" | "malformed" | "permissions";
}

function peerGrantHash(peers: readonly PeerDescriptor[]): string {
  const canonical = JSON.stringify(
    peers.map((peer) => ({
      id: peer.id,
      credentialId: peer.credentialId,
      credentialHash: peer.credentialHash,
      capabilities: [...peer.capabilities].sort(),
      grantedRoots: [...peer.grantedRoots].sort(),
      notBefore: peer.notBefore,
      expiresAt: peer.expiresAt,
      revokedAt: peer.revokedAt,
    })).sort((a, b) => (a.id === b.id ? (a.credentialId < b.credentialId ? -1 : 1) : a.id < b.id ? -1 : 1)),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export class PeerCredentialRegistry {
  private readonly filePath: string;
  private peers: PeerDescriptor[];
  private observedMtimeMs: number;
  private observedGrantHash: string;
  private readonly generationBase: number;
  private generation = 0;
  private degradedAt: number | undefined;
  private degradedReason: PeerCredentialReload["reason"];
  private lastFailure: string | undefined;
  onReload?: ((event: PeerCredentialReload) => void) | undefined;

  private constructor(
    filePath: string,
    peers: PeerDescriptor[],
    observedMtimeMs: number,
    observedGrantHash: string,
    generationBase: number,
    onReload?: (event: PeerCredentialReload) => void,
  ) {
    this.filePath = filePath;
    this.peers = peers;
    this.observedMtimeMs = observedMtimeMs;
    this.observedGrantHash = observedGrantHash;
    this.generationBase = generationBase;
    this.onReload = onReload;
  }

  static open(filePath: string, options?: { onReload?: (event: PeerCredentialReload) => void }): PeerCredentialRegistry {
    const file = loadPeerCredentialFile(filePath);
    const stat = statSync(filePath);
    const grantHash = peerGrantHash(file.peers);
    return new PeerCredentialRegistry(filePath, file.peers, stat.mtimeMs, grantHash, Date.now(), options?.onReload);
  }

  get currentGeneration(): number {
    return this.generationBase + this.generation;
  }

  get currentGrantHash(): string {
    return peerGrantHash(this.peers);
  }

  /** Resolve a currently active enrolled peer for trusted server dispatch. */
  getActiveDescriptor(peerId: string, nowMs = Date.now()): PeerDescriptor | undefined {
    this.maybeReload();
    const descriptor = this.peers.find((peer) => peer.id === peerId);
    if (!descriptor || this.degradedAt !== undefined) return undefined;
    if (descriptor.revokedAt !== undefined && Date.parse(descriptor.revokedAt) <= nowMs) return undefined;
    if (descriptor.expiresAt !== undefined && Date.parse(descriptor.expiresAt) <= nowMs) return undefined;
    if (descriptor.notBefore !== undefined && Date.parse(descriptor.notBefore) > nowMs) return undefined;
    return {
      ...descriptor,
      capabilities: [...descriptor.capabilities],
      grantedRoots: [...descriptor.grantedRoots],
    };
  }

  /** Monotonic identity for diagnostics/tests. */
  snapshot(): { generation: number; peerCount: number; degraded: boolean; reason?: string; lastFailure?: string } {
    return {
      generation: this.currentGeneration,
      peerCount: this.peers.length,
      degraded: this.degradedAt !== undefined,
      reason: this.degradedReason,
      lastFailure: this.lastFailure,
    };
  }

  /**
   * Revalidate before every authentication. A missing, unreadable, malformed,
   * or over-permissive registry is treated as a possible urgent revocation and
   * fails closed. Only a read/parse failure on a CHANGED file may retain the
   * prior validated generation for a narrow 250ms atomic-rename window; a
   * second observation after that deadline clears all principals.
   */
  private maybeReload(): void {
    let stat: { mtimeMs: number };
    try {
      stat = statSync(this.filePath);
    } catch (error) {
      this.lastFailure = String(error);
      this.enterDegraded("missing");
      this.peers = [];
      this.emit({ changed: false, generation: this.currentGeneration, degraded: true, reason: "missing" });
      return;
    }

    if (this.degradedAt !== undefined) {
      if (stat.mtimeMs === this.observedMtimeMs) {
        // The failed observation has not changed. The prior generation cannot
        // remain active beyond the atomic-rename grace window.
        if (Date.now() - this.degradedAt > 250) this.peers = [];
        this.emit({ changed: false, generation: this.currentGeneration, degraded: true, reason: this.degradedReason });
        return;
      }
      // A new mtime under degraded state starts a fresh read attempt, but a
      // repeated invalid publication cannot extend the original grace.
      this.enterDegraded(this.degradedReason ?? "unreadable");
      this.degradedAt = Date.now();
    }

    try {
      const file = loadPeerCredentialFile(this.filePath);
      const grantHash = peerGrantHash(file.peers);
      const contentChanged = grantHash !== this.observedGrantHash;
      this.peers = file.peers;
      this.observedMtimeMs = stat.mtimeMs;
      if (contentChanged) {
        this.observedGrantHash = grantHash;
        this.generation += 1;
      }
      const reason = this.degradedReason;
      this.degradedAt = undefined;
      this.degradedReason = undefined;
      this.lastFailure = undefined;
      this.emit({ changed: contentChanged, generation: this.currentGeneration, degraded: false, ...(reason ? { reason } : {}) });
    } catch (error) {
      this.lastFailure = String(error);
      this.observedMtimeMs = stat.mtimeMs;
      this.enterDegraded(error instanceof Error && /group\/other accessible/.test(error.message) ? "permissions" : "unreadable");
      this.peers = [];
      this.emit({ changed: false, generation: this.currentGeneration, degraded: true, reason: this.degradedReason });
    }
  }

  private enterDegraded(reason: Exclude<PeerCredentialReload["reason"], undefined>): void {
    const now = Date.now();
    if (this.degradedAt === undefined) {
      this.degradedAt = now;
      this.degradedReason = reason;
    } else if (this.degradedReason !== reason) {
      this.degradedAt = now;
      this.degradedReason = reason;
    }
  }

  private emit(event: PeerCredentialReload): void {
    try {
      this.onReload?.(event);
    } catch {
      // Diagnostics must never affect authorization.
    }
  }

  authenticate(authorizationHeader: string | undefined): PeerPrincipal | undefined {
    this.maybeReload();
    if (this.peers.length === 0) return undefined;
    if (typeof authorizationHeader !== "string") return undefined;
    const match = /^Bearer (\S+)$/.exec(authorizationHeader);
    if (!match) return undefined;
    const separator = match[1].indexOf(":");
    if (separator <= 0) return undefined;
    const credentialId = match[1].slice(0, separator);
    const secret = match[1].slice(separator + 1);
    if (!CREDENTIAL_ID_PATTERN.test(credentialId)) return undefined;
    if (secret.length < SECRET_MIN_LENGTH || secret.length > SECRET_MAX_LENGTH) return undefined;

    const now = Date.now();
    const candidates = this.peers.filter((peer) => peer.credentialId === credentialId);
    for (const descriptor of candidates) {
      if (descriptor.revokedAt !== undefined && Date.parse(descriptor.revokedAt) <= now) continue;
      if (descriptor.expiresAt !== undefined && Date.parse(descriptor.expiresAt) <= now) continue;
      if (descriptor.notBefore !== undefined && Date.parse(descriptor.notBefore) > now) continue;
      if (this.hashMatches(descriptor, credentialId, secret)) {
        return peerPrincipalFromDescriptor(descriptor, {
          revision: this.currentGeneration,
          hash: this.currentGrantHash,
        });
      }
    }
    return undefined;
  }

  /** Constant-time hash comparison; length mismatch short-circuits to false. */
  private hashMatches(descriptor: PeerDescriptor, credentialId: string, secret: string): boolean {
    const computed = Buffer.from(hashPeerCredential(credentialId, secret), "hex");
    const stored = Buffer.from(descriptor.credentialHash, "hex");
    if (computed.length !== stored.length) return false;
    return timingSafeEqual(computed, stored);
  }
}

interface FailedAuthWindow {
  timestamps: number[];
}

function pruneFailureWindow(window: FailedAuthWindow, now: number): void {
  window.timestamps = window.timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
}

/**
 * Bounded failure accounting. The map has a hard entry cap; within an active
 * attack the oldest entries are retired first rather than growing the process
 * without limit. Failure budgets remain independent per IP.
 */
class PeerAuthFailureLimiter {
  private readonly windows = new Map<string, FailedAuthWindow>();

  record(key: string, now = Date.now()): number {
    let window = this.windows.get(key);
    if (!window) {
      if (this.windows.size >= RATE_LIMIT_MAX_ENTRIES) {
        this.prune(now);
        while (this.windows.size >= RATE_LIMIT_MAX_ENTRIES) {
          const oldest = this.windows.keys().next().value;
          if (oldest === undefined) break;
          this.windows.delete(oldest);
        }
      }
      window = { timestamps: [] };
      this.windows.set(key, window);
    }
    pruneFailureWindow(window, now);
    window.timestamps.push(now);
    return window.timestamps.length;
  }

  success(key: string): void {
    this.windows.delete(key);
  }

  prune(now = Date.now()): void {
    for (const [key, window] of this.windows) {
      pruneFailureWindow(window, now);
      if (window.timestamps.length === 0) this.windows.delete(key);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}

/**
 * Express middleware factory. On success sets req.peerPrincipal and calls
 * next(). On failure responds 401 unauthorized_peer (or 429 when a key
 * exceeds the failure budget) and logs a warn event with the reason — never
 * the raw header.
 */
export function createPeerAuthMiddleware(
  registry: PeerCredentialRegistry,
  config: { logging: { level: string } },
): (req: Request, res: Response, next: NextFunction) => void {
  const failedAuth = new PeerAuthFailureLimiter();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const authorization = req.header("authorization");
    const credentialKey = (() => {
      const match = /^Bearer (\S+)$/.exec(authorization ?? "");
      if (!match) return "malformed";
      const separator = match[1].indexOf(":");
      if (separator <= 0) return "malformed";
      const credentialId = match[1].slice(0, separator);
      return /^[A-Za-z0-9._-]{1,64}$/.test(credentialId) ? `credential:${credentialId}` : "malformed";
    })();

    const principal = registry.authenticate(authorization);
    if (principal) {
      failedAuth.success(ip);
      failedAuth.success(credentialKey);
      req.peerPrincipal = principal;
      next();
      return;
    }

    const failuresByIp = failedAuth.record(ip);
    const failuresByCredential = failedAuth.record(credentialKey);
    failedAuth.prune();
    // logEvent expects the full LoggingConfig; the peer middleware contract
    // only requires the level, so project onto a minimal valid shape.
    const logging = { ...config.logging, format: "json", requests: false, assets: false, toolCalls: false, shellCommands: false } as LoggingConfig;
    if (failuresByIp > RATE_LIMIT_MAX_FAILURES || failuresByCredential > RATE_LIMIT_MAX_FAILURES) {
      logEvent(logging, "warn", "peer_auth_rate_limited", { ip, failuresByIp, failuresByCredential });
      res.status(429).json({ error: { code: "peer_auth_rate_limited", message: "Too many failed peer authentication attempts" } });
      return;
    }
    logEvent(logging, "warn", "peer_auth_failed", { ip, failuresByIp, failuresByCredential });
    res.status(401).json({ error: { code: "unauthorized_peer", message: "Peer authentication failed" } });
  };
}
