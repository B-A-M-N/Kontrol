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
  /** Exact identity when this mapping came from a recognized status-schema
   * path and every identity field was unambiguous. Absence is inconclusive. */
  identity?: IngressRouteIdentity;
}

/** Exact normalized route identity used for ingress matching. Query strings,
 * userinfo, and fragments are never retained; a target carrying those extras
 * is intentionally not representable and therefore cannot match. */
export interface IngressRouteIdentity {
  hostname: string;
  listenPort: string;
  handlerPath: string;
  upstreamScheme: "http" | "https";
  upstreamHost: string;
  upstreamPort: string;
  upstreamPath: string;
  allowFunnel: boolean;
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
  /** Whether serve status used a schema this build understands. Unsupported
   * shapes remain inconclusive and can never produce a positive match. */
  serveStatusSchemaSupported: boolean;
  /** Same contract as serveStatusSchemaSupported for funnel status. */
  funnelStatusSchemaSupported: boolean;
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
    serveStatusSchemaSupported: true,
    funnelStatusSchemaSupported: true,
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
    if (parsed) {
      const result = parseServeMappings(parsed);
      facts.serveMappings = result.mappings;
      facts.serveStatusSchemaSupported = result.schemaSupported;
      if (!result.schemaSupported) warnings.push("tailscale serve status schema is unsupported; mapping comparison is inconclusive");
    }
  }

  const funnel = await safeExec(exec, ["funnel", "status", "--json"], warnings);
  if (funnel) {
    const parsed = safeJsonParse(funnel.stdout, ["funnel", "status", "--json"], warnings);
    if (parsed) {
      const result = parseServeMappings(parsed);
      facts.funnelMappings = result.mappings;
      facts.funnelStatusSchemaSupported = result.schemaSupported;
      if (!result.schemaSupported) warnings.push("tailscale funnel status schema is unsupported; mapping comparison is inconclusive");
    }
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

interface ParsedServeStatus {
  mappings: ServeMapping[];
  schemaSupported: boolean;
}

/**
 * Parse only the schema this classifier can prove: top-level or service-local
 * `Web.<HostPort>.Handlers.<path>.Proxy`, with `AllowFunnel` keyed by
 * HostPort. Unknown documents return no positive identity; the facts layer
 * marks them unsupported so classification becomes UNKNOWN.
 */
export function parseServeMappings(parsed: Record<string, unknown>): ParsedServeStatus {
  const funnelByHostPort = new Map<string, boolean>();
  const allowFunnel = parsed["AllowFunnel"] ?? parsed["allowFunnel"];
  if (typeof allowFunnel === "object" && allowFunnel !== null && !Array.isArray(allowFunnel)) {
    for (const [key, value] of Object.entries(allowFunnel as Record<string, unknown>)) {
      if (typeof value !== "boolean") continue;
      const hostPort = normalizeHostPort(key);
      if (hostPort !== null) funnelByHostPort.set(hostPort, value);
    }
  }

  const webRoots: Array<{ value: unknown; serviceLocal: boolean }> = [];
  const web = parsed["Web"];
  if (isPlainRecord(web)) webRoots.push({ value: web, serviceLocal: false });
  const services = parsed["Services"];
  if (isPlainRecord(services)) {
    for (const service of Object.values(services)) {
      if (!isPlainRecord(service) || !isPlainRecord(service["Web"])) continue;
      webRoots.push({ value: service["Web"], serviceLocal: true });
    }
  }

  if (webRoots.length === 0) {
    return {
      mappings: [],
      schemaSupported: Object.keys(parsed).length === 0,
    };
  }

  const mappings: ServeMapping[] = [];
  for (const { value: webRoot } of webRoots) {
    for (const [hostPortKey, hostNode] of Object.entries(webRoot as Record<string, unknown>)) {
      if (!isPlainRecord(hostNode) || !isPlainRecord(hostNode["Handlers"])) continue;
      const hostPort = normalizeHostPort(hostPortKey);
      if (hostPort === null) continue;
      const listenPort = portFromHostPort(hostPort);
      const allowFunnelValue = funnelByHostPort.get(hostPort);
      for (const [handlerPath, handler] of Object.entries(hostNode["Handlers"] as Record<string, unknown>)) {
        if (!isPlainRecord(handler) || typeof handler["Proxy"] !== "string") continue;
        const proxy = handler["Proxy"];
        const mapping: ServeMapping = {
          port: listenPort,
          path: normalizeHandlerPath(handlerPath),
          proxyTarget: sanitizeProxyTarget(proxy),
        };
        mapping.hostPort = hostPort;
        if (allowFunnelValue !== undefined) mapping.allowFunnel = allowFunnelValue;
        // AllowFunnel is a sparse true map: absence in a recognized Web
        // schema means funnel disabled, not unknown.
        const identity = routeIdentity(hostPort, mapping.path, proxy, allowFunnelValue ?? false);
        if (identity) mapping.identity = identity;
        mappings.push(mapping);
      }
    }
  }
  return { mappings, schemaSupported: true };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHandlerPath(path: string): string {
  return path.startsWith("/") ? path : "/" + path;
}

function routeIdentity(
  hostPort: string,
  handlerPath: string,
  proxy: string,
  allowFunnel: boolean,
): IngressRouteIdentity | undefined {
  const hostname = hostPort.slice(0, hostPort.lastIndexOf(":"));
  const listenPort = portFromHostPort(hostPort);
  if (listenPort === "") return undefined;
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.pathname !== "" && url.pathname !== "/") return undefined;
  return {
    hostname: hostname.toLowerCase(),
    listenPort,
    handlerPath,
    upstreamScheme: url.protocol === "https:" ? "https" : "http",
    upstreamHost: url.hostname.toLowerCase(),
    upstreamPort: effectiveUrlPort(url),
    upstreamPath: "/",
    allowFunnel,
  };
}

function effectiveUrlPort(url: URL): string {
  return url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
}

/** Normalize a HostPort key to canonical host:port. Unrecognizable keys are
 * rejected so they can never borrow another route's identity. */
function normalizeHostPort(key: string): string | null {
  if (/^\d{1,5}$/.test(key) || !key.includes(":")) return null;
  try {
    const url = new URL(key.includes("://") ? key : "https://" + key);
    if (!url.hostname || url.hostname === "https") return null;
    return url.hostname.toLowerCase() + ":" + effectiveUrlPort(url);
  } catch {
    return null;
  }
}

function portFromHostPort(hostPort: string): string {
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
