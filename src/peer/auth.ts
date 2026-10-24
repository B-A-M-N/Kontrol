/**
 * Peer authentication: bearer-token authentication against the operator's
 * credential registry with mtime-based hot reload, plus an express middleware
 * that attaches the trusted PeerPrincipal or fails closed with a 401/429.
 * Raw tokens and Authorization headers are never logged.
 */
import { statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
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
const SECRET_MIN_LENGTH = 16;
const SECRET_MAX_LENGTH = 256;

/** Fail-auth rate limiting: >30 failures within 60s from one IP → 429. */
const RATE_LIMIT_MAX_FAILURES = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

export class PeerCredentialRegistry {
  private readonly filePath: string;
  private peers: PeerDescriptor[];
  private mtimeMs: number;

  private constructor(filePath: string, peers: PeerDescriptor[], mtimeMs: number) {
    this.filePath = filePath;
    this.peers = peers;
    this.mtimeMs = mtimeMs;
  }

  static open(filePath: string): PeerCredentialRegistry {
    const stat = statSync(filePath);
    const file = loadPeerCredentialFile(filePath);
    return new PeerCredentialRegistry(filePath, file.peers, stat.mtimeMs);
  }

  /**
   * Hot-reload before each authenticate: if the registry file's mtimeMs
   * changed, re-read and re-parse. A transient failure keeps the last good
   * registry (fail operational); revocation applies as soon as the file
   * parses again.
   */
  private maybeReload(): void {
    let stat: { mtimeMs: number };
    try {
      stat = statSync(this.filePath);
    } catch {
      return; // Transient stat failure: keep serving the last good registry.
    }
    if (stat.mtimeMs === this.mtimeMs) return;
    try {
      const file = loadPeerCredentialFile(this.filePath);
      this.peers = file.peers;
      this.mtimeMs = stat.mtimeMs;
    } catch {
      // Keep the last good registry; do not update mtimeMs so a later
      // successful rewrite still triggers a reload.
    }
  }

  authenticate(authorizationHeader: string | undefined): PeerPrincipal | undefined {
    this.maybeReload();
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
        return peerPrincipalFromDescriptor(descriptor);
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

/**
 * Express middleware factory. On success sets req.peerPrincipal and calls
 * next(). On failure responds 401 unauthorized_peer (or 429 when one IP
 * exceeds the failure budget) and logs a warn event with the reason — never
 * the raw header.
 */
export function createPeerAuthMiddleware(
  registry: PeerCredentialRegistry,
  config: { logging: { level: string } },
): (req: Request, res: Response, next: NextFunction) => void {
  const failedAuthByIp = new Map<string, FailedAuthWindow>();

  const recordFailure = (ip: string): number => {
    const now = Date.now();
    const window = failedAuthByIp.get(ip) ?? { timestamps: [] };
    window.timestamps = window.timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    window.timestamps.push(now);
    failedAuthByIp.set(ip, window);
    // Bounded pruning on each check: drop IPs whose windows went quiet.
    for (const [key, value] of failedAuthByIp) {
      if (value.timestamps.length === 0) failedAuthByIp.delete(key);
    }
    return window.timestamps.length;
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const principal = registry.authenticate(req.header("authorization"));
    if (principal) {
      if (failedAuthByIp.has(ip)) failedAuthByIp.delete(ip);
      req.peerPrincipal = principal;
      next();
      return;
    }

    const failures = recordFailure(ip);
    // logEvent expects the full LoggingConfig; the peer middleware contract
    // only requires the level, so project onto a minimal valid shape.
    const logging = { ...config.logging, format: "json", requests: false, assets: false, toolCalls: false, shellCommands: false } as LoggingConfig;
    if (failures > RATE_LIMIT_MAX_FAILURES) {
      logEvent(logging, "warn", "peer_auth_rate_limited", { ip, failures });
      res.status(429).json({ error: { code: "peer_auth_rate_limited", message: "Too many failed peer authentication attempts" } });
      return;
    }
    logEvent(logging, "warn", "peer_auth_failed", { ip, failures });
    res.status(401).json({ error: { code: "unauthorized_peer", message: "Peer authentication failed" } });
  };
}
