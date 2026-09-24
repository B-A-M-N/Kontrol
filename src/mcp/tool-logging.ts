/**
 * Tool-call logging helpers and best-effort audit-degradation accounting.
 * Extracted verbatim from src/mcp/workspace-server.ts (P1.3); the
 * createMcpServer closures become explicit module functions.
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Request } from "express";
import type { ServerConfig } from "../config.js";
import { logEvent, requestIp } from "../logger.js";
import { redactedPreview } from "../redaction.js";

/** P1 #26: package version remains the CLI/npm identity. */
let cachedPackageVersion: string | undefined;

export interface BuildMetaVersionIdentity {
  version?: unknown;
  contentSha256?: unknown;
}

/**
 * Derive the MCP server identity from the executable tree identity. A package
 * version alone is not enough to distinguish materially different tool
 * catalogs served by different immutable releases.
 */
export function mcpServerVersionFromBuildMeta(meta: BuildMetaVersionIdentity): string | undefined {
  if (typeof meta.version !== "string" || meta.version.length === 0) return undefined;
  if (typeof meta.contentSha256 === "string" && /^[a-f0-9]{16,64}$/.test(meta.contentSha256)) {
    return `${meta.version}+${meta.contentSha256}`;
  }
  return meta.version;
}

export function readMcpServerVersionFromBuildMeta(path: URL | string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as BuildMetaVersionIdentity;
    return mcpServerVersionFromBuildMeta(meta);
  } catch {
    return undefined;
  }
}

export function readPackageVersion(): string {
  if (cachedPackageVersion) return cachedPackageVersion;
  try {
    const buildMeta = JSON.parse(readFileSync(new URL("../build-meta.json", import.meta.url), "utf8")) as { version?: string };
    cachedPackageVersion = typeof buildMeta.version === "string" && buildMeta.version ? buildMeta.version : "0.0.0";
  } catch {
    try {
      const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: string };
      cachedPackageVersion = typeof manifest.version === "string" && manifest.version ? manifest.version : "0.0.0";
    } catch {
      cachedPackageVersion = "0.0.0";
    }
  }
  return cachedPackageVersion;
}

let cachedMcpServerVersion: string | undefined;

/**
 * Read the immutable artifact metadata beside the compiled module. Source
 * checkout/dev runs fall back to the package version because they have no
 * release-local build-meta.json.
 */
export function readMcpServerVersion(): string {
  if (cachedMcpServerVersion) return cachedMcpServerVersion;
  cachedMcpServerVersion = readMcpServerVersionFromBuildMeta(
    new URL("../build-meta.json", import.meta.url),
  ) ?? readPackageVersion();
  return cachedMcpServerVersion;
}

/**
 * P1 #25: audit-event writes are best-effort (they must never fail user
 * work), but silent degradation is unacceptable. Track a counter per scope,
 * warn rate-limited, and expose the counters under authenticated
 * diagnostics so persistent failures surface.
 */
const degradedAuditCounters = new Map<string, { count: number; lastWarnedAt: number; lastError?: string }>();
const DEGRADED_AUDIT_WARN_INTERVAL_MS = 60_000;

export function recordDegradedAudit(scope: string, error: unknown): void {
  const entry = degradedAuditCounters.get(scope) ?? { count: 0, lastWarnedAt: 0 };
  entry.count += 1;
  entry.lastError = error instanceof Error ? error.message : String(error);
  const now = Date.now();
  if (now - entry.lastWarnedAt >= DEGRADED_AUDIT_WARN_INTERVAL_MS) {
    entry.lastWarnedAt = now;
    console.warn(`[kontrol] degraded audit telemetry (${scope}): ${entry.count} write failure(s); last error: ${entry.lastError}`);
  }
  degradedAuditCounters.set(scope, entry);
}

export function degradedAuditSnapshot(): Record<string, { count: number; lastError?: string }> {
  const snapshot: Record<string, { count: number; lastError?: string }> = {};
  for (const [scope, entry] of degradedAuditCounters) {
    snapshot[scope] = { count: entry.count, lastError: entry.lastError };
  }
  return snapshot;
}

export function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

export function constantTimeStringEqual(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

export function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    // P0.6: the console preview is redacted through the shared sanitizer —
    // command text can contain pasted credentials just like tool output.
    commandPreview: config.logging.shellCommands && command ? redactedPreview(command) : undefined,
  });
}
