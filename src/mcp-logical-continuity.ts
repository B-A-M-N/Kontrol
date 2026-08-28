/**
 * Server-side continuity metadata for MCP clients.
 *
 * An MCP transport/session ID is intentionally disposable. This index records
 * only trusted logical identity metadata across transport loss so diagnostics,
 * approval correlation, and reconnect observability do not depend on a stale
 * session ID. It is not an authorization store and it never replays requests
 * or reuses a transport.
 */

export type TrustedMcpIdentitySource = "instance_header" | "conversation" | "oauth";

export interface LogicalContinuityAttachInput {
  identity: string;
  source: TrustedMcpIdentitySource;
  transportId: string;
  at?: number;
}

export interface LogicalContinuityAttachResult {
  reconnect: boolean;
  predecessorTransportId?: string;
  activeTransportCount: number;
}

export interface LogicalContinuityRecord {
  identity: string;
  source: TrustedMcpIdentitySource;
  createdAt: number;
  lastSeenAt: number;
  detachedAt?: number;
  activeTransportCount: number;
  detachedTransportCount: number;
  reconnectCount: number;
}

interface ContinuityEntry {
  identity: string;
  source: TrustedMcpIdentitySource;
  createdAt: number;
  lastSeenAt: number;
  detachedAt?: number;
  active: Set<string>;
  detached: Map<string, number>;
  reconnectCount: number;
}

export interface LogicalContinuityIndexOptions {
  /** How long detached identity metadata is retained for a reconnect. */
  retentionMs?: number;
  /** Bound memory if an untrusted deployment sends many unique identities. */
  maxEntries?: number;
  /** Keep only a small amount of predecessor metadata per identity. */
  maxDetachedTransports?: number;
  /** Called when an identity is no longer retained and its owned resources may be cleaned up. */
  onExpire?: (identity: string) => void;
}

const DEFAULT_RETENTION_MS = 72 * 60 * 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_DETACHED_TRANSPORTS = 2;

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be a positive finite number.`);
  return Math.floor(value);
}

export class LogicalContinuityIndex {
  private readonly entries = new Map<string, ContinuityEntry>();
  private readonly retentionMs: number;
  private readonly maxEntries: number;
  private readonly maxDetachedTransports: number;
  private readonly onExpire?: (identity: string) => void;

  constructor(options: LogicalContinuityIndexOptions = {}) {
    this.retentionMs = positiveLimit(options.retentionMs, DEFAULT_RETENTION_MS, "retentionMs");
    this.maxEntries = positiveLimit(options.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries");
    this.maxDetachedTransports = positiveLimit(options.maxDetachedTransports, DEFAULT_MAX_DETACHED_TRANSPORTS, "maxDetachedTransports");
    this.onExpire = options.onExpire;
  }

  attach(input: LogicalContinuityAttachInput): LogicalContinuityAttachResult {
    const at = input.at ?? Date.now();
    this.sweep(at);
    let entry = this.entries.get(input.identity);
    if (!entry) {
      entry = {
        identity: input.identity,
        source: input.source,
        createdAt: at,
        lastSeenAt: at,
        active: new Set(),
        detached: new Map(),
        reconnectCount: 0,
      };
      this.entries.set(input.identity, entry);
    } else if (entry.source !== input.source) {
      // The identity namespace is part of the trust boundary. Do not merge a
      // value under a different source if configuration/order changes.
      entry = {
        identity: input.identity,
        source: input.source,
        createdAt: at,
        lastSeenAt: at,
        active: new Set(),
        detached: new Map(),
        reconnectCount: 0,
      };
      this.entries.set(input.identity, entry);
    }

    const predecessor = [...entry.detached.keys()].at(-1);
    const reconnect = predecessor !== undefined;
    if (reconnect) entry.reconnectCount++;
    // A successful attachment claims one reconnect predecessor. Leaving every
    // detached transport in the map made concurrent fresh transports all count
    // the same historical disconnect as a new reconnect.
    if (predecessor) entry.detached.delete(predecessor);
    entry.detached.delete(input.transportId);
    entry.active.add(input.transportId);
    entry.lastSeenAt = at;
    entry.detachedAt = entry.detached.size > 0 ? [...entry.detached.values()].at(-1) : undefined;
    this.notifyExpired(this.trimEntries(at));
    return {
      reconnect,
      predecessorTransportId: predecessor,
      activeTransportCount: entry.active.size,
    };
  }

  touch(identity: string, transportId: string, at = Date.now()): void {
    const entry = this.entries.get(identity);
    if (!entry || !entry.active.has(transportId)) return;
    entry.lastSeenAt = at;
  }

  detach(identity: string, transportId: string, at = Date.now()): boolean {
    const entry = this.entries.get(identity);
    if (!entry || !entry.active.delete(transportId)) return false;
    entry.detached.set(transportId, at);
    entry.detachedAt = at;
    entry.lastSeenAt = at;
    while (entry.detached.size > this.maxDetachedTransports) {
      const oldest = entry.detached.keys().next().value as string | undefined;
      if (!oldest) break;
      entry.detached.delete(oldest);
    }
    return true;
  }

  sweep(at = Date.now()): number {
    const expired: string[] = [];
    for (const [identity, entry] of this.entries) {
      for (const [transportId, detachedAt] of entry.detached) {
        if (at - detachedAt >= this.retentionMs) entry.detached.delete(transportId);
      }
      if (entry.active.size === 0 && at - entry.lastSeenAt >= this.retentionMs) {
        this.entries.delete(identity);
        expired.push(identity);
      }
    }
    expired.push(...this.trimEntries(at));
    this.notifyExpired(expired);
    return expired.length;
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  snapshot(at = Date.now()): LogicalContinuityRecord[] {
    this.sweep(at);
    return [...this.entries.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((entry) => ({
        identity: entry.identity,
        source: entry.source,
        createdAt: entry.createdAt,
        lastSeenAt: entry.lastSeenAt,
        ...(entry.detachedAt !== undefined ? { detachedAt: entry.detachedAt } : {}),
        activeTransportCount: entry.active.size,
        detachedTransportCount: entry.detached.size,
        reconnectCount: entry.reconnectCount,
      }));
  }

  private trimEntries(at: number): string[] {
    const expired: string[] = [];
    if (this.entries.size <= this.maxEntries) return expired;
    const detached = [...this.entries.values()]
      .filter((entry) => entry.active.size === 0)
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    for (const entry of detached) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(entry.identity);
      expired.push(entry.identity);
    }
    if (this.entries.size <= this.maxEntries) return expired;
    // If every entry is active, preserve the active identities and allow the
    // bounded diagnostic index to exceed its soft bound until one detaches.
    // This avoids deleting metadata for a live transport under pressure.
    void at;
    return expired;
  }

  private notifyExpired(identities: string[]): void {
    if (!this.onExpire) return;
    for (const identity of new Set(identities)) {
      try {
        this.onExpire(identity);
      } catch {
        // Expiry cleanup is best effort from the metadata index. The resource
        // owner's own idle/max-runtime bounds remain the final safety net.
      }
    }
  }
}
