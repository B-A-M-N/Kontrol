/**
 * Pure Host-header / host-entry policy helpers for ingress profiles (PR-A).
 * No state, no timers, no listeners: every function maps inputs to outputs.
 */
import type { NextFunction, Request, Response } from "express";

const STRIPPABLE_PORTS = new Set(["443", "80"]);

/**
 * Trim, lowercase, IDNA-normalize, and canonicalize a single host entry.
 * - IDNA/punycode happens via `new URL("https://" + value).hostname`.
 * - Default ports for the implied https scheme (443/80) are stripped.
 * - Non-default ports are kept (`host:8443`).
 * - Wildcards, whitespace, credentials, paths, and invalid hosts throw.
 */
export function normalizeHostEntry(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error("invalid host entry: empty value");
  }
  if (/\s/.test(trimmed)) {
    throw new Error(`invalid host entry: ${value} contains whitespace`);
  }
  if (trimmed.includes("*")) {
    throw new Error(`invalid host entry: ${value} contains a wildcard`);
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${trimmed.toLowerCase()}`);
  } catch {
    throw new Error(`invalid host entry: ${value} is not a valid host`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`invalid host entry: ${value} contains credentials`);
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`invalid host entry: ${value} contains a path, query, or fragment`);
  }
  if (parsed.hostname === "") {
    throw new Error(`invalid host entry: ${value} is not a valid host`);
  }
  // WHATWG URL.hostname already brackets IPv6 literals ("[::1]"); use it verbatim.
  const host = parsed.hostname;
  const port = STRIPPABLE_PORTS.has(parsed.port) ? "" : parsed.port;
  return port ? `${host}:${port}` : host;
}

/**
 * Normalize a full allowlist: every entry via normalizeHostEntry, deduped
 * preserving first-occurrence order. Wildcards throw (exact FQDNs only).
 */
export function normalizeHostAllowlist(values: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const value of values) {
    const host = normalizeHostEntry(value);
    if (!normalized.includes(host)) {
      normalized.push(host);
    }
  }
  return normalized;
}

export type HostResolution = { host: string } | { error: string };

/**
 * Resolve the normalized Host to validate for an incoming request.
 * `rawHeaders` is the list of all Host header values the HTTP layer saw.
 * Multiple Host entries, absolute-form hosts, whitespace, and CR/LF are
 * rejected with a reason instead of silently picking one.
 */
export function hostFromRequestHeader(rawHost: string | undefined, rawHeaders: readonly string[]): HostResolution {
  if (rawHeaders.length > 1) {
    return { error: `multiple Host headers (${rawHeaders.length} entries); refusing to guess authority` };
  }
  const value = rawHost?.trim();
  if (!value) {
    return { error: "missing Host header" };
  }
  if (/[\s\r\n\0]/.test(value)) {
    return { error: "Host header contains whitespace or control characters" };
  }
  if (value.includes("://") || /^https?:/i.test(value)) {
    return { error: "absolute-form Host header is not accepted" };
  }
  try {
    return { host: normalizeHostEntry(value) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "invalid host" };
  }
}

/** Strict listener-specific Host middleware shared by public and peer apps.
 * Non-loopback authorities must match the configured host AND port exactly;
 * only explicitly allowlisted loopback hosts may carry an ephemeral probe
 * port. X-Forwarded-Host is never consulted. */
export function strictHostHeaderValidation(
  allowedHostEntries: readonly string[],
): (req: Request, res: Response, next: NextFunction) => void {
  const allowed = new Set(normalizeHostAllowlist(allowedHostEntries));
  return (req, res, next) => {
    const hostValues: string[] = [];
    for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index]!.toLowerCase() === "host") hostValues.push(req.rawHeaders[index + 1]!);
    }
    const resolution = hostFromRequestHeader(req.headers.host, hostValues);
    if ("host" in resolution) {
      const hostname = hostnameFromAuthority(resolution.host);
      if (allowed.has(resolution.host) || (isLoopbackAuthority(hostname) && allowed.has(hostname))) { next(); return; }
    }
    res.status(403).json({ error: { code: "forbidden_host", message: "Host header is not accepted by this listener" } });
  };
}

export function hostMatchesAllowlist(resolvedHost: string, allowlistEntries: readonly string[]): boolean {
  const allowed = new Set(normalizeHostAllowlist(allowlistEntries));
  if (allowed.has(resolvedHost)) return true;
  const hostname = hostnameFromAuthority(resolvedHost);
  return isLoopbackAuthority(hostname) && allowed.has(hostname);
}

function isLoopbackAuthority(hostname: string): boolean {
  const value = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isLoopbackHostValue(value);
}

function hostnameFromAuthority(authority: string): string {
  if (authority.startsWith("[")) return authority.slice(0, authority.indexOf("]") + 1);
  const colon = authority.lastIndexOf(":");
  return colon > -1 && /^\d+$/.test(authority.slice(colon + 1)) ? authority.slice(0, colon) : authority;
}

/**
 * True for "*" and for ANY textual spelling of the unspecified ("all
 * interfaces") address: IPv4 "0.0.0.0", IPv6 "::", "::0", "0::",
 * "0:0:0:0:0:0:0:0", the IPv4-mapped family ("::ffff:0.0.0.0",
 * "::ffff:0:0", "0:0:0:0:0:ffff:0:0", "::0.0.0.0"), and bracketed forms.
 * Every IPv6 literal is expanded to 8 hex groups (with "::" compression and
 * embedded dotted-quad tails converted), then classified: all-zero →
 * unspecified; ::ffff:0:0 (mapped with a zero embedded-v4 tail) also binds
 * the IPv4 wildcard, so unspecified. Bind gates use this so an
 * equivalent-but-differently-spelled wildcard cannot sneak past an
 * exact-string check. Pure: no I/O.
 */
export function isUnspecifiedAddress(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === "*") return true;
  const literal = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (literal === "0.0.0.0") return true;
  if (!literal.includes(":")) return false;
  // Embedded dotted-quad tail ("::ffff:127.0.0.1", "::0.0.0.0"): convert it
  // to the two hex groups it denotes so the generic expansion below sees one
  // uniform IPv6 form. A malformed tail is not an unspecified spelling.
  let v6 = literal;
  const v4Tail = v6.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Tail) {
    const octets = v4Tail[1]!.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
      return false;
    }
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    v6 = v6.slice(0, v6.length - v4Tail[1]!.length) + hi + ":" + lo;
  }
  // Expand "::" compression to exactly 8 groups.
  const halves = v6.split("::");
  if (halves.length > 2) return false; // more than one "::" is invalid
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : [];
  if (left.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return false;
  if (right.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return false;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return false; // more than 8 groups
  if (halves.length === 1 && missing !== 0) return false; // no "::" → exactly 8 groups required
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.every((group) => parseInt(group, 16) === 0)) return true;
  // IPv4-mapped "::ffff:0:0" also binds the IPv4 wildcard: groups 1-5 zero,
  // group 6 = ffff, embedded v4 tail (groups 7-8) zero.
  return groups.slice(0, 5).every((group) => parseInt(group, 16) === 0)
    && parseInt(groups[5]!, 16) === 0xffff
    && parseInt(groups[6]!, 16) === 0
    && parseInt(groups[7]!, 16) === 0;
}

/**
 * Semantics of config.ts isLoopbackHost, replicated here to avoid a module
 * cycle (config.ts imports validate.ts which would import this module).
 */
export function isLoopbackHostValue(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
