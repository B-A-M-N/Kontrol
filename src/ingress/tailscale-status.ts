/**
 * Read-only Tailscale CLI facts layer (P1-08). Runs `tailscale version`,
 * `status --json`, `serve status --json`, and `funnel status --json` and
 * reduces them to a small, redacted facts object.
 *
 * ZERO MUTATION: only read-only subcommands are ever spawned. The exec
 * contract passes subcommands/flags only, guarded by a strict read-only
 * allowlist — no operator-controlled strings, no paths, and never any
 * secret-bearing arguments. Per-command failures
 * (nonzero exit, ENOENT, timeout, malformed JSON) become per-field warnings;
 * this layer never throws for a partial failure.
 */
import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";

/** Injectable executor so tests never spawn a real tailscale binary. */
export type TailscaleExec = (args: string[]) => Promise<TailscaleExecResult>;

export interface TailscaleExecResult {
  stdout: string;
  /** Internal diagnostic channel ONLY: readTailscaleFacts never surfaces it
   * into facts, warnings, or reports (stable categories instead). */
  stderr: string;
  exitCode: number;
}

/** One recognized Tailscale serve/funnel route. Shape-tolerant: fields are
 * derived defensively from whatever the status JSON contained. */
export interface ServeMapping {
  /** Tailscale HTTPS listen port when recognizable (e.g. "443"), else "". */
  port: string;
  /** Handler path when recognizable (e.g. "/"), else "/". */
  path: string;
  /** The handler's Proxy value, SANITIZED to scheme://host[:port] — userinfo, path, query, and
   * fragment are dropped so credentials never survive into facts;
   * unrecognizable values collapse to a fixed placeholder. */
  proxyTarget: string;
  /** The SNI:port route this handler belongs to (upstream Web/AllowFunnel
   * keying), when recognizable. Absent for legacy/unknown shapes. */
  hostPort?: string;
  /** Funnel-enabled for THIS host:port route, attributed exactly from the
   * AllowFunnel HostPort map (or a nested boolean in tolerated shapes).
   * Undefined means the document does not say — never inferred from port. */
  allowFunnel?: boolean;
}

export interface TailscaleFacts {
  /** First line of `tailscale version`, or null when unavailable. */
  cliVersion: string | null;
  /** BackendState from `status --json` (e.g. "Running"), or null. */
  backendState: string | null;
  /** Self.DNSName with the trailing dot stripped, or null. */
  dnsName: string | null;
  /** Routes observed via the serve status command. */
  serveMappings: ServeMapping[];
  /**
   * Routes observed via the funnel status command. Upstream tailscale renders
   * the SAME ipn.ServeConfig for both status commands, so in production this
   * bucket mirrors serveMappings; the ONLY authoritative funnel signal is the
   * per-route allowFunnel flag attributed from the AllowFunnel HostPort map.
   */
  funnelMappings: ServeMapping[];
  /** One stable-category warning per failed fact command — never
   * subprocess output, paths, or secrets. */
  warnings: string[];
}

const TAILSCALE_TIMEOUT_MS = 5_000;

/**
 * Default exec: node:child_process execFile (never a shell), binary resolved
 * as KONTROL_TAILSCALE_BIN ?? "tailscale", bounded 5s timeout. All errors are
 * folded into the result — the promise never rejects.
 */
export function defaultTailscaleExec(args: string[]): Promise<TailscaleExecResult> {
  assertReadOnlyFactArgs(args);
  const bin = process.env.KONTROL_TAILSCALE_BIN ?? "tailscale";
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: TAILSCALE_TIMEOUT_MS, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        // Map no-completion failures onto conventional exit codes so callers
        // get stable categories: numeric code = real child exit status,
        // 124 = killed by our timeout, 127 = binary not found.
        const code = error.code;
        const exitCode = typeof code === "number"
          ? code
          : error.killed === true
            ? 124
            : code === "ENOENT"
              ? 127
              : 1;
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: stderr.trim(),
          exitCode,
        });
      },
    );
  });
}

/**
 * Read the four fact commands. Always resolves; every per-command problem is
 * recorded in warnings and the corresponding fields stay null/empty.
 */
export async function readTailscaleFacts(exec: TailscaleExec = defaultTailscaleExec): Promise<TailscaleFacts> {
  const warnings: string[] = [];
  const facts: TailscaleFacts = {
    cliVersion: null,
    backendState: null,
    dnsName: null,
    serveMappings: [],
    funnelMappings: [],
    warnings,
  };

  const version = await safeExec(exec, ["version"], warnings);
  if (version) {
    const firstLine = version.stdout.split("\n", 1)[0]?.trim() ?? "";
    if (firstLine !== "") {
      facts.cliVersion = firstLine;
    } else {
      warnings.push("tailscale version produced no parseable first line");
    }
  }

  const status = await safeExec(exec, ["status", "--json"], warnings);
  if (status) {
    const parsed = safeJsonParse(status.stdout, ["status", "--json"], warnings);
    if (parsed) {
      if (typeof parsed.BackendState === "string" && parsed.BackendState !== "") {
        facts.backendState = parsed.BackendState;
      }
      const self = typeof parsed.Self === "object" && parsed.Self !== null ? parsed.Self as Record<string, unknown> : undefined;
      const dnsName = typeof self?.DNSName === "string" ? self.DNSName : undefined;
      if (dnsName !== undefined && dnsName !== "") {
        // Tailscale reports fully-qualified names with a trailing dot; strip
        // it so the value compares equal to operator-written origins.
        facts.dnsName = dnsName.endsWith(".") ? dnsName.slice(0, -1) : dnsName;
      }
    }
  }

  const serve = await safeExec(exec, ["serve", "status", "--json"], warnings);
  if (serve) {
    const parsed = safeJsonParse(serve.stdout, ["serve", "status", "--json"], warnings);
    if (parsed) facts.serveMappings = parseServeMappings(parsed);
  }

  const funnel = await safeExec(exec, ["funnel", "status", "--json"], warnings);
  if (funnel) {
    const parsed = safeJsonParse(funnel.stdout, ["funnel", "status", "--json"], warnings);
    if (parsed) facts.funnelMappings = parseServeMappings(parsed);
  }

  return facts;
}

const READ_ONLY_FACT_ARGS = new Set(["version", "status --json", "serve status --json", "funnel status --json"]);

/**
 * The ONLY invocations this layer may ever run. Enforced in safeExec (so any
 * exec used by readTailscaleFacts is bounded too) and in defaultTailscaleExec
 * (so the default executor cannot be repurposed) — defense in depth against
 * a future edit turning the facts layer into a mutation surface.
 */
export function assertReadOnlyFactArgs(args: string[]): void {
  const command = args.join(" ");
  if (!READ_ONLY_FACT_ARGS.has(command)) {
    throw new Error("tailscale facts layer is read-only; refusing to execute: " + command);
  }
}

/** Stable failure categories only — raw stderr/stdout/error messages can
 * carry host paths, credential material, or terminal control sequences and
 * never enter warnings or reports. */
function execFailureCategory(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const killed = (error as { killed?: unknown } | null)?.killed;
  if (code === "ENOENT") return "binary not found";
  if (code === "ETIMEDOUT" || killed === true) return "timed out";
  return "failed";
}

async function safeExec(exec: TailscaleExec, args: string[], warnings: string[]): Promise<TailscaleExecResult | null> {
  assertReadOnlyFactArgs(args);
  const command = args.join(" ");
  let result: TailscaleExecResult;
  try {
    result = await exec(args);
  } catch (error) {
    warnings.push("tailscale " + command + ": " + execFailureCategory(error));
    return null;
  }
  if (result.exitCode !== 0) {
    warnings.push("tailscale " + command + " failed (exit " + String(result.exitCode) + ")");
    return null;
  }
  return result;
}

function safeJsonParse(text: string, args: string[], warnings: string[]): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the malformed-JSON warning
  }
  warnings.push(`tailscale ${args.join(" ")} returned malformed JSON`);
  return null;
}

const WALK_MAX_DEPTH = 12;
const WALK_MAX_NODES = 2048;

/**
 * Parse a serve/funnel status document into mappings. The configured schema
 * is version-dependent: current versions nest handlers under
 * Web.<host>:<port>.Handlers.<path>.Proxy with a top-level AllowFunnel map
 * keyed by route; older or unknown shapes are tolerated by the same walker.
 * Depth and node budgets bound the walk; overflow is tolerated silently
 * (unmapped shapes simply yield no classification data).
 */
function parseServeMappings(parsed: Record<string, unknown>): ServeMapping[] {
  // Upstream AllowFunnel is map[HostPort]bool keyed by SNI:port (ipn/serve.go
  // deletes entries when unset), so attribution is by FULL HostPort — never
  // by port alone, which would leak funnel state across hosts.
  const funnelByHostPort = new Map<string, boolean>();
  const out: ServeMapping[] = [];
  walkForMappings(parsed, [], undefined, funnelByHostPort, out, 0, null);
  for (const mapping of out) {
    if (mapping.allowFunnel === undefined && mapping.hostPort !== undefined) {
      const byHostPort = funnelByHostPort.get(mapping.hostPort);
      if (byHostPort !== undefined) mapping.allowFunnel = byHostPort;
    }
  }
  return out;
}

/** Normalize a HostPort key (node.ts.net:443 or https://node.ts.net:443) to
 * the canonical host:port spelling. null for bare ports ("443"), bare words
 * (URL would invent a default port), and unrecognizable keys — attribution
 * must stay exact, never invented. */
function normalizeHostPort(key: string): string | null {
  if (/^\d{1,5}$/.test(key)) return null;
  if (!key.includes(":")) return null;
  try {
    const url = new URL(key.includes("://") ? key : "https://" + key);
    if (!url.hostname || url.hostname === "https") return null;
    const port = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
    return url.hostname.toLowerCase() + ":" + port;
  } catch {
    return null;
  }
}

function walkForMappings(
  node: unknown,
  path: string[],
  inheritedAllowFunnel: boolean | undefined,
  funnelByHostPort: Map<string, boolean>,
  out: ServeMapping[],
  depth: number,
  currentHostPort: string | null,
): void {
  if (depth > WALK_MAX_DEPTH || out.length > WALK_MAX_NODES) return;
  if (Array.isArray(node)) {
    for (const entry of node) walkForMappings(entry, path, inheritedAllowFunnel, funnelByHostPort, out, depth + 1, currentHostPort);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  const ownFunnel = firstBoolean(record["allowFunnel"], record["AllowFunnel"]);
  const effectiveFunnel = ownFunnel ?? inheritedAllowFunnel;
  // AllowFunnel can also be a MAP keyed by HostPort (node.ts.net:443 or a
  // URL-ish spelling); collect it for exact per-host attribution.
  for (const mapKey of ["allowFunnel", "AllowFunnel"]) {
    const mapValue = record[mapKey];
    if (typeof mapValue === "object" && mapValue !== null && !Array.isArray(mapValue)) {
      for (const [routeKey, routeValue] of Object.entries(mapValue as Record<string, unknown>)) {
        if (typeof routeValue !== "boolean") continue;
        const hostPort = normalizeHostPort(routeKey);
        if (hostPort !== null) funnelByHostPort.set(hostPort, routeValue);
      }
    }
  }
  const proxy = record["Proxy"];
  if (typeof proxy === "string" && proxy.trim() !== "") {
    const hostPort = currentHostPort !== null ? currentHostPort : hostPortFromPath(path);
    const mapping: ServeMapping = {
      port: portFromHostPort(hostPort) || portFromPath(path),
      path: handlerPathFromPath(path),
      proxyTarget: sanitizeProxyTarget(proxy),
    };
    if (hostPort !== null) mapping.hostPort = hostPort;
    if (effectiveFunnel !== undefined) mapping.allowFunnel = effectiveFunnel;
    out.push(mapping);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "Proxy" || key === "allowFunnel" || key === "AllowFunnel") continue;
    // The Web section is keyed by HostPort (node.ts.net:443); the DEEPEST
    // normalizable key wins so a nested Web section attributes correctly.
    // Service-name keys ("svc:<digits>") look like host:port but are NOT:
    // skipping them prevents a service name from hijacking the host (and
    // its port) for the whole subtree.
    const childHostPort = key.startsWith("svc:") ? null : normalizeHostPort(key);
    const nextHostPort = childHostPort ?? currentHostPort;
    walkForMappings(value, [...path, key], effectiveFunnel, funnelByHostPort, out, depth + 1, nextHostPort);
  }
}

/** Derive the HostPort from the key path (fallback when the walk context did
 * not provide one): the first host:port or URL-ish segment wins. */
function hostPortFromPath(path: string[]): string | null {
  for (const segment of path) {
    const normalized = normalizeHostPort(segment);
    if (normalized !== null) return normalized;
  }
  return null;
}

/** Port part of a canonical host:port string; empty when null/malformed. */
function portFromHostPort(hostPort: string | null): string {
  if (hostPort === null) return "";
  const index = hostPort.lastIndexOf(":");
  return index === -1 ? "" : hostPort.slice(index + 1);
}

/**
 * Redact a handler Proxy value to scheme://host[:port]. Userinfo, path,
 * query, and fragment are dropped so credentials can never survive into
 * facts or reports; non-http(s) schemes and unparseable values collapse to a
 * fixed placeholder (they cannot be classified, so they never match).
 */
export function sanitizeProxyTarget(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "(unrecognized target)";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "(unrecognized target)";
  const port = url.port !== "" ? ":" + url.port : url.protocol === "https:" ? ":443" : ":80";
  return url.protocol + "//" + url.hostname + port;
}

function firstBoolean(...values: readonly unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

/** Derive the Tailscale HTTPS listen port from the key path: a URL-ish key
 * like "https://node.ts.net:443" yields "443", a bare host:port key (the
 * current Web section, e.g. "node.ts.net:443") yields "443", a bare numeric
 * key (legacy TCP section) yields itself, anything else yields "". */
function portFromPath(path: string[]): string {
  for (const segment of path) {
    if (/^\d{1,5}$/.test(segment)) return segment;
    if (/^[A-Za-z0-9.\-]+:\d{1,5}$/.test(segment)) return segment.slice(segment.lastIndexOf(":") + 1);
    if (/^https?:\/\//i.test(segment)) {
      try {
        const url = new URL(segment);
        if (url.port !== "") return url.port;
        return url.protocol === "https:" ? "443" : "80";
      } catch {
        // not a URL after all; keep scanning
      }
    }
  }
  return "";
}

function handlerPathFromPath(path: string[]): string {
  for (let index = path.length - 1; index >= 0; index--) {
    const segment = path[index];
    if (segment.startsWith("/")) return segment;
  }
  return "/";
}
