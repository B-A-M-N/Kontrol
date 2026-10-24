/**
 * Pure Host-header / host-entry policy helpers for ingress profiles (PR-A).
 * No state, no timers, no listeners: every function maps inputs to outputs.
 */

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
  const host = parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname;
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

/**
 * Semantics of config.ts isLoopbackHost, replicated here to avoid a module
 * cycle (config.ts imports validate.ts which would import this module).
 */
export function isLoopbackHostValue(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
