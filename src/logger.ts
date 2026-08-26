import type { Request } from "express";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFormat = "json" | "pretty";

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
  requests: boolean;
  assets: boolean;
  toolCalls: boolean;
  shellCommands: boolean;
  /**
   * Trusted-proxy specification (P1 #7). Replaces the old boolean model:
   *   - undefined/false: no proxy is trusted; forwarded headers are ignored.
   *   - a number as string (e.g. "1"): trust exactly N proxy hops — the
   *     client address is taken N entries from the right of X-Forwarded-For,
   *     so direct callers cannot spoof it past the configured hop count.
   *   - "loopback": trust only loopback proxies (127.0.0.1/::1).
   *   - "true" (legacy): trust all proxies — deprecated, logs a warning.
   */
  trustProxy?: string;
}

type LogFields = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function shouldLog(config: LoggingConfig, level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_WEIGHT[config.level] >= LEVEL_WEIGHT[level];
}

export function logEvent(
  config: LoggingConfig,
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: LogFields = {},
): void {
  if (!shouldLog(config, level)) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };

  const line = config.format === "pretty" ? formatPretty(entry) : JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Resolve the client IP honoring the trusted-proxy specification. Forwarded
 * headers are only consulted when the spec says a proxy is present, and with
 * a hop count the address is taken N from the RIGHT (nearest-to-us proxy
 * appended last), so a direct caller cannot spoof past the configured trust.
 */
export function requestIp(req: Request, trustProxy: string | undefined): string | undefined {
  const forwardedFor = firstHeaderValue(req.header("x-forwarded-for"));
  if (trustProxy !== undefined && trustProxy !== "" && trustProxy !== "false" && trustProxy !== "0") {
    const hopMatch = /^(\d+)$/.exec(trustProxy);
    if (hopMatch) {
      // Express-compatible: with `trust proxy` = N, req.ip is the Nth entry
      // from the right of X-Forwarded-For. N=1 -> rightmost entry.
      const hops = Number(hopMatch[1]);
      const chain = (req.header("x-forwarded-for") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (chain.length >= hops) {
        return chain[chain.length - hops];
      }
    } else if (trustProxy === "loopback") {
      const remote = req.socket.remoteAddress ?? "";
      const normalized = remote.replace(/^::ffff:/, "");
      if (normalized === "127.0.0.1" || normalized === "::1") {
        const cfConnectingIp = firstHeaderValue(req.header("cf-connecting-ip"));
        if (cfConnectingIp) return cfConnectingIp;
        if (forwardedFor) return forwardedFor;
      }
    } else { // "true" or other truthy legacy values: trust all (deprecated)
      const cfConnectingIp = firstHeaderValue(req.header("cf-connecting-ip"));
      if (cfConnectingIp) return cfConnectingIp;
      if (forwardedFor) return forwardedFor;
    }
  }

  return req.ip ?? req.socket.remoteAddress;
}

export function requestPath(req: Request): string {
  return req.path || req.url.split("?")[0] || req.url;
}

export function sessionIdPrefix(sessionId: string | undefined): string | undefined {
  return sessionId ? sessionId.slice(0, 8) : undefined;
}

export function commandPreview(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function firstHeaderValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function formatPretty(entry: LogFields): string {
  const ts = String(entry.ts);
  const level = String(entry.level).toUpperCase();
  const event = String(entry.event);
  const rest = Object.entries(entry)
    .filter(([key, value]) => !["ts", "level", "event"].includes(key) && value !== undefined)
    .map(([key, value]) => `${key}=${formatPrettyValue(value)}`)
    .join(" ");

  return rest ? `${ts} ${level} ${event} ${rest}` : `${ts} ${level} ${event}`;
}

function formatPrettyValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}
