import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import type { PolicyConfig } from "./policy.js";
import { loadPolicyConfig, policyCanAsk } from "./policy.js";
import { loadKontrolFiles } from "./user-config.js";
import { DEFAULT_DIRECT_APPROVAL_REATTACH_GRACE_MS } from "./policy-approval-defaults.js";

export type ToolMode = "minimal" | "full" | "codex";
export type WidgetMode = "off" | "changes" | "full";
export type AuthMode = "oauth" | "tunnel";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  authMode: AuthMode;
  /**
   * Legacy tunnel token, retained only so older callers can inspect the
   * configuration during migration. Tunnel mode deliberately does not use it
   * as an MCP bearer gate; the Secure MCP Tunnel is the trust boundary.
   */
  tunnelToken?: string;
  /** Secret injected by the managed tunnel for WebUI reviewer authority. */
  tunnelReviewerSecret?: string;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  toolMode: ToolMode;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  skillsEnabled: boolean;
  skillPaths: string[];
  agentDir: string;
  logging: LoggingConfig;
  acpEnabled: boolean;
  acpKnownAgents: Array<{ name: string; url: string; description?: string }>;
  acpSharedSecret?: string;
  /** Shared secret used by the coding agent (worker) for ACP registration/calls. */
  acpAgentSecret?: string;
  /** Shared secret used by the reviewer (WebUI) for ACP calls. */
  acpReviewerSecret?: string;
  /**
   * P0 #9: secret Kontrol presents to ADAPTERS on outbound /runs, cancel, and
   * probe calls. Distinct from acpSharedSecret (legacy operator ingress) so
   * the adapter credential never doubles as a broad-authority operator key.
   */
  acpAdapterSecret?: string;
  policy: PolicyConfig;
  /** P1 #50: Secret required for /diagnostics access (even on loopback). */
  diagnosticsSecret?: string;
  /** P1 #22: centralized supervisor/verifier runtime configuration. */
  supervisorMaxInflight: number;
  verifyMaxInflight: number;
  verifySandbox: boolean;
  childEnvironmentAllowlist: string[];
  /** P1 #14: process-session resource controls (all optional, validated). */
  processMaxRunning?: number;
  processMaxRunningPerOwner?: number;
  processIdleTimeoutMs?: number;
  processMaxRuntimeMs?: number;
  processMaxBufferCharacters?: number;
  processReaperIntervalMs?: number;
  verifyToolchainPaths: string[];
  webhookEnabled: boolean;
  webhookAllowedHosts: string[];
  /** Bounded MCP request admission limits. */
  mcpMaxInflight: number;
  mcpMaxInflightPerSession: number;
  mcpMaxQueue: number;
  /** Independent cap for parked event/review/terminal waiters. */
  mcpMaxWaiters: number;
  mcpMaxWaitersPerSession: number;
  mcpMaxWaiterQueue: number;
  /** Maximum time a request may wait for an admission slot. */
  mcpAdmissionTimeoutMs: number;
  /** Maximum execution time for ordinary, non-waiter MCP requests. */
  mcpExecutionTimeoutMs: number;
  /** Periodic maintenance scheduling and wall-clock budget. */
  maintenanceIntervalMs: number;
  maintenanceBudgetMs: number;
  /** Diagnostic integrity scheduling and worker deadline. */
  integrityIntervalMs: number;
  integrityDeadlineMs: number;
  /** @deprecated use mcpAdmissionTimeoutMs. */
  mcpRequestDeadlineMs: number;
  /** Default blocking policy-approval lifetime. */
  policyApprovalTimeoutMs: number;
  /** Human decision window for a direct (non-blocking) tool approval. */
  policyDirectApprovalTtlMs: number;
  /** Grace period for reconnecting a direct MCP approval after its caller disappears. */
  policyDirectApprovalReattachGraceMs: number;
  mcpUnusedSessionIdleMs: number;
  mcpEphemeralSessionIdleMs: number;
  mcpReusableSessionIdleMs: number;
  mcpSessionReaperIntervalMs: number;
  /** Retention for trusted logical-client continuity after transport loss. */
  mcpLogicalContinuityRetentionMs: number;
  mcpSessionMaxPerClient: number;
  mcpSessionSoftCap: number;
  mcpSessionHardCap: number;
  /** Filesystem snapshot admission + retention limits (P0/P1 storage hardness). */
  fsSnapshot: FilesystemSnapshotConfig;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    if (roots.length === 0) {
      throw new Error("KONTROL_ALLOWED_ROOTS must contain at least one explicit directory; refusing an implicit process.cwd() filesystem boundary");
    }
    return roots.map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  if (rawRoots.length === 0) {
    throw new Error("KONTROL_ALLOWED_ROOTS must contain at least one explicit directory; refusing an implicit process.cwd() filesystem boundary");
  }
  return rawRoots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

/** Filesystem snapshot admission + retention limits. All optional except the
 * store watermarks; an unset admission limit is unbounded. */
export interface FilesystemSnapshotConfig {
  /** Maximum files captured in a single tree snapshot. Unset = unbounded. */
  maxFiles?: number;
  /** Maximum logical bytes captured in a single tree snapshot. Unset = unbounded. */
  maxBytes?: number;
  /** Maximum bytes read for any single file during capture. Unset = unbounded. */
  maxFileBytes?: number;
  /** Store high-water mark; GC is attempted above it and new captures fail closed above it. */
  highWaterBytes?: number;
  /** Store low-water mark; captures resume once the store drops to/below it. */
  lowWaterBytes?: number;
  /** Retention (ms) for terminal-session unpinned snapshots before GC. */
  retentionMs?: number;
  /** Number of most-recent terminal snapshots per workspace to retain after TTL. */
  retainPerWorkspace?: number;
  /** Orphan grace (ms): very new unpinned objects are never reaped within this window. */
  orphanGraceMs?: number;
}

const DEFAULT_FS_SNAPSHOT_HIGH_WATER_BYTES = 40 * 1024 * 1024 * 1024;
const DEFAULT_FS_SNAPSHOT_LOW_WATER_BYTES = 25 * 1024 * 1024 * 1024;
const DEFAULT_FS_SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_FS_SNAPSHOT_RETAIN_PER_WORKSPACE = 10;
const DEFAULT_FS_SNAPSHOT_ORPHAN_GRACE_MS = 5 * 60_000;

function parseFsSnapshotConfig(env: NodeJS.ProcessEnv): FilesystemSnapshotConfig {
  const parsed: FilesystemSnapshotConfig = {
    maxFiles: parseOptionalPositiveInteger(env.KONTROL_FS_SNAPSHOT_MAX_FILES, "KONTROL_FS_SNAPSHOT_MAX_FILES"),
    maxBytes: parseOptionalPositiveInteger(env.KONTROL_FS_SNAPSHOT_MAX_BYTES, "KONTROL_FS_SNAPSHOT_MAX_BYTES"),
    maxFileBytes: parseOptionalPositiveInteger(env.KONTROL_FS_SNAPSHOT_MAX_FILE_BYTES, "KONTROL_FS_SNAPSHOT_MAX_FILE_BYTES"),
    highWaterBytes: parseOptionalPositiveInteger(env.KONTROL_FS_SNAPSHOT_STORE_HIGH_WATER_BYTES, "KONTROL_FS_SNAPSHOT_STORE_HIGH_WATER_BYTES")
      ?? DEFAULT_FS_SNAPSHOT_HIGH_WATER_BYTES,
    lowWaterBytes: parseOptionalPositiveInteger(env.KONTROL_FS_SNAPSHOT_STORE_LOW_WATER_BYTES, "KONTROL_FS_SNAPSHOT_STORE_LOW_WATER_BYTES")
      ?? DEFAULT_FS_SNAPSHOT_LOW_WATER_BYTES,
    retentionMs: parseOptionalPositiveInteger(env.KONTROL_FS_SNAPSHOT_RETENTION_MS, "KONTROL_FS_SNAPSHOT_RETENTION_MS")
      ?? DEFAULT_FS_SNAPSHOT_RETENTION_MS,
    retainPerWorkspace: parseOptionalPositiveInteger(env.KONTROL_FS_SNAPSHOT_RETAIN_PER_WORKSPACE, "KONTROL_FS_SNAPSHOT_RETAIN_PER_WORKSPACE")
      ?? DEFAULT_FS_SNAPSHOT_RETAIN_PER_WORKSPACE,
    orphanGraceMs: parseOptionalPositiveInteger(env.KONTROL_FS_SNAPSHOT_ORPHAN_GRACE_MS, "KONTROL_FS_SNAPSHOT_ORPHAN_GRACE_MS")
      ?? DEFAULT_FS_SNAPSHOT_ORPHAN_GRACE_MS,
  };
  if (parsed.lowWaterBytes !== undefined && parsed.highWaterBytes !== undefined && parsed.lowWaterBytes > parsed.highWaterBytes) {
    throw new Error(
      `KONTROL_FS_SNAPSHOT_STORE_LOW_WATER_BYTES=${parsed.lowWaterBytes} must not exceed KONTROL_FS_SNAPSHOT_STORE_HIGH_WATER_BYTES=${parsed.highWaterBytes}.`,
    );
  }
  return parsed;
}

function parseToolMode(env: NodeJS.ProcessEnv): ToolMode {
  const mode = env.KONTROL_TOOL_MODE;
  if (mode === "minimal" || mode === "full" || mode === "codex") return mode;
  if (mode) throw new Error(`Invalid KONTROL_TOOL_MODE: ${mode}`);

  if (env.KONTROL_MINIMAL_TOOLS !== undefined) {
    return parseBoolean(env.KONTROL_MINIMAL_TOOLS) ? "minimal" : "full";
  }
  return "minimal";
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid KONTROL_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid KONTROL_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function parseEnvironmentAllowlist(value: string | undefined): string[] {
  return parsePathList(value).filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: must be a positive integer (got "${value}")`);
  }
  return Math.floor(parsed);
}

/** P1 #14: like parsePositiveInteger but returns undefined when unset. */
function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  return parsePositiveInteger(value, 0, name);
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(env.KONTROL_LOG_LEVEL),
    format: parseLogFormat(env.KONTROL_LOG_FORMAT),
    requests: env.KONTROL_LOG_REQUESTS === undefined ? true : parseBoolean(env.KONTROL_LOG_REQUESTS),
    assets: parseBoolean(env.KONTROL_LOG_ASSETS),
    toolCalls: env.KONTROL_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.KONTROL_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.KONTROL_LOG_SHELL_COMMANDS),
    trustProxy: parseTrustProxy(env.KONTROL_TRUST_PROXY),
  };
}

/**
 * P1 #7: replace the boolean trust-proxy model with an Express-compatible
 * specification. Accepted values: unset/empty (no proxy trusted), a hop count
 * ("1", "2", ...), "loopback", or "true" (legacy trust-all, deprecated).
 */
function parseTrustProxy(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) {
    if (Number(value) < 1) return undefined;
    return value;
  }
  const normalized = value.toLowerCase();
  if (normalized === "false" || normalized === "0") return undefined;
  if (normalized === "loopback") return "loopback";
  if (parseBoolean(value)) {
    console.warn(
      "[kontrol] KONTROL_TRUST_PROXY=true is deprecated: it lets any direct caller spoof CF-Connecting-IP / X-Forwarded-For. Set KONTROL_TRUST_PROXY=<hop count> (e.g. 1) or 'loopback' instead.",
    );
    return "true";
  }
  throw new Error(`Invalid KONTROL_TRUST_PROXY: ${value} (use a hop count like 1, "loopback", or "true" for legacy trust-all)`);
}

function parseWidgetMode(value: string | undefined): WidgetMode {
  // Full mode mounts the WebUI iframe for every tool result, which causes an
  // avoidable host-connection prompt on routine reads/searches/commands. Keep
  // the interactive surface for workspace and change-review cards by default.
  if (!value) return "changes";
  if (value === "full") return "full";
  if (value === "off" || value === "changes") return value;

  throw new Error(`Invalid KONTROL_WIDGETS: ${value}`);
}

function parseAcpKnownAgents(
  value: string | Array<{ name: string; url: string; description?: string }> | undefined,
): Array<{ name: string; url: string; description?: string }> {
  if (Array.isArray(value)) return value;
  if (!value) return [];

  return value.split(",").map((entry) => {
    const [name, url, ...descParts] = entry.trim().split("=");
    if (!name || !url) {
      throw new Error(
        `Invalid ACP agent entry: "${entry}". Use format: name=url or name=url=description`,
      );
    }
    return { name, url, description: descParts.join("=") || undefined };
  });
}

function parseOAuthConfig(
  env: NodeJS.ProcessEnv,
  ownerToken: string | undefined,
  required: boolean,
): OAuthConfig {
  const resolvedToken = env.KONTROL_OAUTH_OWNER_TOKEN ?? ownerToken;
  if (required) {
    if (!resolvedToken) {
      throw new Error("KONTROL_OAUTH_OWNER_TOKEN is required for Kontrol OAuth. Run: kontrol init");
    }
    if (resolvedToken.length < 16) {
      throw new Error("KONTROL_OAUTH_OWNER_TOKEN must be at least 16 characters long.");
    }
  }
  return {
    ownerToken: resolvedToken ?? "",
    accessTokenTtlSeconds: parsePositiveInteger(
      env.KONTROL_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "KONTROL_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.KONTROL_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "KONTROL_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.KONTROL_OAUTH_SCOPES, ["kontrol"]),
    allowedRedirectHosts: parseStringList(env.KONTROL_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
  };
}

function parseAuthMode(value: string | undefined): AuthMode {
  if (!value || value === "oauth") return "oauth";
  if (value === "tunnel") return "tunnel";
  throw new Error(`Invalid KONTROL_AUTH_MODE: ${value}. Expected "oauth" or "tunnel".`);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "kontrol");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".kontrol", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

/**
 * ACP role-separation invariant (P1 #5): agent/reviewer/adapter secrets must be
 * strong, distinct random values. Equal or short secrets undermine first-match
 * role resolution and make brute force feasible. The legacy shared secret is
 * accepted as an explicit compatibility mode only — it cannot satisfy the
 * strength requirement on its own.
 */
function validateAcpSecrets(env: NodeJS.ProcessEnv): void {
  if (env.KONTROL_ACP_ENABLED !== undefined && !parseBoolean(env.KONTROL_ACP_ENABLED)) return;

  const agent = env.KONTROL_ACP_AGENT_SECRET;
  const reviewer = env.KONTROL_ACP_REVIEWER_SECRET;
  const adapter = env.KONTROL_ACP_ADAPTER_SECRET;
  const shared = env.KONTROL_ACP_SHARED_SECRET;
  const configured = [agent, reviewer, adapter].filter((s): s is string => Boolean(s));

  const MIN_LENGTH = 32;
  for (const secret of configured) {
    if (secret.length < MIN_LENGTH) {
      throw new Error(
        `ACP secrets must be at least ${MIN_LENGTH} characters of high entropy (generate with: openssl rand -base64 48). Short secrets are rejected because the authenticated caller is untrusted-by-design.`,
      );
    }
  }
  const labels: Array<[string, string | undefined]> = [
    ["KONTROL_ACP_AGENT_SECRET", agent],
    ["KONTROL_ACP_REVIEWER_SECRET", reviewer],
    ["KONTROL_ACP_ADAPTER_SECRET", adapter],
  ];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i][1];
      const b = labels[j][1];
      if (a && b && a === b) {
        throw new Error(
          `${labels[i][0]} and ${labels[j][0]} are identical. Distinct per-role credentials are required: equal secrets undermine role separation and produce surprising first-match authorization.`,
        );
      }
    }
  }
  if (!configured.length && shared) {
    // Legacy compatibility mode is allowed but must itself be non-trivial.
    if (shared.length < MIN_LENGTH) {
      throw new Error(
        `KONTROL_ACP_SHARED_SECRET (legacy mode) must be at least ${MIN_LENGTH} characters. Prefer distinct KONTROL_ACP_AGENT_SECRET / KONTROL_ACP_REVIEWER_SECRET / KONTROL_ACP_ADAPTER_SECRET values.`,
      );
    }
  } else if (configured.length < 3 && shared) {
    // Partial configuration silently falls back to the shared secret for the
    // missing roles — that hides a misconfiguration. Require completeness.
    throw new Error(
      "Partial ACP credential configuration: set ALL of KONTROL_ACP_AGENT_SECRET, KONTROL_ACP_REVIEWER_SECRET, and KONTROL_ACP_ADAPTER_SECRET, or unset them all to use legacy KONTROL_ACP_SHARED_SECRET compatibility mode.",
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadKontrolFiles(env);
  validateAcpSecrets(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.KONTROL_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const authMode = parseAuthMode(env.KONTROL_AUTH_MODE);

  if (authMode === "tunnel" && !isLoopbackHost(host)) {
    throw new Error(
      `KONTROL_AUTH_MODE=tunnel requires HOST to bind a loopback address (127.0.0.1, ::1, or localhost), but HOST=${host}. Tunnel mode disables Kontrol's OAuth gate and must only be reachable through the OpenAI Secure MCP Tunnel on a loopback interface.`,
    );
  }

  const policy = loadPolicyConfig(env);
  // Direct policy approvals exist independently from ACP. In tunnel mode the
  // only reviewer authority is the secret-backed tunnel assertion, so an
  // ask-capable policy without one can mint approval cards that no surface is
  // authorized to resolve — the model would block forever. Fail at startup
  // with the concrete fix, not at the first blocked tool call. This
  // requirement is independent of ACP: KONTROL_ACP_ENABLED=false changes
  // nothing about who can resolve an approval.
  const tunnelReviewerSecret = env.KONTROL_TUNNEL_REVIEWER_SECRET ?? env.KONTROL_ACP_REVIEWER_SECRET;
  if (authMode === "tunnel" && policyCanAsk(policy) && !tunnelReviewerSecret) {
    throw new Error(
      "KONTROL_AUTH_MODE=tunnel with an ask-capable policy requires a reviewer credential. " +
        "Set KONTROL_TUNNEL_REVIEWER_SECRET (or the legacy KONTROL_ACP_REVIEWER_SECRET) so the tunnel can assert reviewer authority, " +
        "or set the policy to a non-interactive posture (KONTROL_POLICY_MODE=allow) if no approval decisions are wanted. " +
        "Without it, ask-gated tools create approvals that no reviewer surface can open or resolve.",
    );
  }

  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];

  const config: ServerConfig = {
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken, authMode === "oauth"),
    allowedRoots: parseAllowedRoots(env.KONTROL_ALLOWED_ROOTS ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(env.KONTROL_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    authMode,
    // Kept for migration diagnostics only. The server never uses this value
    // to challenge /mcp in tunnel mode.
    tunnelToken: env.KONTROL_TUNNEL_TOKEN,
    // Tunnel mode has no bearer gate at the local hop. The tunnel-client
    // therefore carries an explicit reviewer assertion. A dedicated secret is
    // preferred; the ACP reviewer secret is the migration fallback.
    tunnelReviewerSecret,
    toolMode: parseToolMode(env),
    widgets: parseWidgetMode(env.KONTROL_WIDGETS),
    stateDir: resolve(expandHomePath(env.KONTROL_STATE_DIR ?? files.config.stateDir ?? defaultStateDir())),
    worktreeRoot: resolve(expandHomePath(env.KONTROL_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    skillsEnabled: env.KONTROL_SKILLS === undefined ? true : parseBoolean(env.KONTROL_SKILLS),
    skillPaths: parsePathList(env.KONTROL_SKILL_PATHS),
    agentDir: resolve(expandHomePath(env.KONTROL_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
    logging: parseLoggingConfig(env),
    acpEnabled: env.KONTROL_ACP_ENABLED === undefined ? true : parseBoolean(env.KONTROL_ACP_ENABLED),
    acpKnownAgents: parseAcpKnownAgents(env.KONTROL_ACP_AGENTS ?? files.config.acpKnownAgents),
    acpSharedSecret: env.KONTROL_ACP_SHARED_SECRET,
    /** Shared secret used by the coding agent (worker) for ACP registration/calls. */
    acpAgentSecret: env.KONTROL_ACP_AGENT_SECRET,
    /** Shared secret used by the reviewer (WebUI) for ACP calls. */
    acpReviewerSecret: env.KONTROL_ACP_REVIEWER_SECRET,
    // P0 #9: outbound adapter credential; falls back to the legacy shared
    // secret only for backward compatibility.
    acpAdapterSecret: env.KONTROL_ACP_ADAPTER_SECRET ?? env.KONTROL_ACP_SHARED_SECRET,
    policy,
    // P1 #50: Diagnostics secret — required for /diagnostics when set
    diagnosticsSecret: env.KONTROL_DIAGNOSTICS_SECRET,
    supervisorMaxInflight: parsePositiveInteger(env.KONTROL_SUPERVISOR_MAX_INFLIGHT, 4, "KONTROL_SUPERVISOR_MAX_INFLIGHT"),
    verifyMaxInflight: parsePositiveInteger(env.KONTROL_VERIFY_MAX_INFLIGHT, 3, "KONTROL_VERIFY_MAX_INFLIGHT"),
    verifySandbox: env.KONTROL_VERIFY_SANDBOX === "1" || env.KONTROL_VERIFY_SANDBOX === "true",
    childEnvironmentAllowlist: parseEnvironmentAllowlist(env.KONTROL_CHILD_ENV_ALLOWLIST),
    // P1 #14: process-session resource controls, parsed/validated centrally.
    processMaxRunning: parseOptionalPositiveInteger(env.KONTROL_PROCESS_MAX_RUNNING, "KONTROL_PROCESS_MAX_RUNNING"),
    processMaxRunningPerOwner: parseOptionalPositiveInteger(env.KONTROL_PROCESS_MAX_RUNNING_PER_OWNER, "KONTROL_PROCESS_MAX_RUNNING_PER_OWNER"),
    processIdleTimeoutMs: parseOptionalPositiveInteger(env.KONTROL_PROCESS_IDLE_TIMEOUT_MS, "KONTROL_PROCESS_IDLE_TIMEOUT_MS"),
    processMaxRuntimeMs: parseOptionalPositiveInteger(env.KONTROL_PROCESS_MAX_RUNTIME_MS, "KONTROL_PROCESS_MAX_RUNTIME_MS"),
    processMaxBufferCharacters: parseOptionalPositiveInteger(env.KONTROL_PROCESS_BUFFER_CHARACTERS, "KONTROL_PROCESS_BUFFER_CHARACTERS"),
    processReaperIntervalMs: parseOptionalPositiveInteger(env.KONTROL_PROCESS_REAPER_INTERVAL_MS, "KONTROL_PROCESS_REAPER_INTERVAL_MS"),
    verifyToolchainPaths: parsePathList(env.KONTROL_VERIFY_TOOLCHAIN_PATHS),
    webhookEnabled: parseBoolean(env.KONTROL_WEBHOOKS),
    webhookAllowedHosts: parseStringList(env.KONTROL_WEBHOOK_ALLOWED_HOSTS, []),
    mcpMaxInflight: parsePositiveInteger(env.KONTROL_MCP_MAX_INFLIGHT, 32, "KONTROL_MCP_MAX_INFLIGHT"),
    mcpMaxInflightPerSession: parsePositiveInteger(env.KONTROL_MCP_MAX_INFLIGHT_PER_SESSION, 8, "KONTROL_MCP_MAX_INFLIGHT_PER_SESSION"),
    mcpMaxQueue: parsePositiveInteger(env.KONTROL_MCP_MAX_QUEUE, 128, "KONTROL_MCP_MAX_QUEUE"),
    mcpMaxWaiters: parsePositiveInteger(env.KONTROL_MCP_MAX_WAITERS, 64, "KONTROL_MCP_MAX_WAITERS"),
    mcpMaxWaitersPerSession: parsePositiveInteger(env.KONTROL_MCP_MAX_WAITERS_PER_SESSION, 2, "KONTROL_MCP_MAX_WAITERS_PER_SESSION"),
    mcpMaxWaiterQueue: parsePositiveInteger(env.KONTROL_MCP_MAX_WAITER_QUEUE, 64, "KONTROL_MCP_MAX_WAITER_QUEUE"),
    mcpAdmissionTimeoutMs: parsePositiveInteger(
      env.KONTROL_MCP_ADMISSION_TIMEOUT_MS ?? env.KONTROL_MCP_REQUEST_DEADLINE_MS,
      120_000,
      "KONTROL_MCP_ADMISSION_TIMEOUT_MS",
    ),
    mcpExecutionTimeoutMs: parsePositiveInteger(
      env.KONTROL_MCP_EXECUTION_TIMEOUT_MS,
      30 * 60_000,
      "KONTROL_MCP_EXECUTION_TIMEOUT_MS",
    ),
    maintenanceIntervalMs: parsePositiveInteger(
      env.KONTROL_MAINTENANCE_INTERVAL_MS,
      5 * 60_000,
      "KONTROL_MAINTENANCE_INTERVAL_MS",
    ),
    maintenanceBudgetMs: parsePositiveInteger(
      env.KONTROL_MAINTENANCE_BUDGET_MS,
      250,
      "KONTROL_MAINTENANCE_BUDGET_MS",
    ),
    integrityIntervalMs: parsePositiveInteger(
      env.KONTROL_INTEGRITY_INTERVAL_MS,
      30 * 60_000,
      "KONTROL_INTEGRITY_INTERVAL_MS",
    ),
    integrityDeadlineMs: parsePositiveInteger(
      env.KONTROL_INTEGRITY_DEADLINE_MS,
      10_000,
      "KONTROL_INTEGRITY_DEADLINE_MS",
    ),
    // Approval calls are intentionally blocking. This is a stale-request
    // backstop, not a normal conversational timeout; the WebUI can still
    // approve a request many hours after it was created.
    policyApprovalTimeoutMs: parsePositiveInteger(
      env.KONTROL_POLICY_APPROVAL_TIMEOUT_MS,
      24 * 60 * 60_000,
      "KONTROL_POLICY_APPROVAL_TIMEOUT_MS",
    ),
    policyDirectApprovalReattachGraceMs: parsePositiveInteger(
      env.KONTROL_POLICY_DIRECT_REATTACH_GRACE_MS,
      DEFAULT_DIRECT_APPROVAL_REATTACH_GRACE_MS,
      "KONTROL_POLICY_DIRECT_REATTACH_GRACE_MS",
    ),
    policyDirectApprovalTtlMs: parsePositiveInteger(
      env.KONTROL_POLICY_DIRECT_APPROVAL_TTL_MS,
      10 * 60_000,
      "KONTROL_POLICY_DIRECT_APPROVAL_TTL_MS",
    ),
    // Keep the old field for callers compiled against the previous config
    // contract, but make the new name authoritative internally.
    mcpRequestDeadlineMs: parsePositiveInteger(
      env.KONTROL_MCP_ADMISSION_TIMEOUT_MS ?? env.KONTROL_MCP_REQUEST_DEADLINE_MS,
      120_000,
      "KONTROL_MCP_REQUEST_DEADLINE_MS",
    ),
    // Give a client time to finish model-side reasoning and issue its first
    // useful operation; cleanup remains bounded by admission caps.
    // MCP hosts commonly initialize, fetch the app template, and then pause
    // while the model decides what to do. Keep those provisional sessions
    // around long enough to survive that setup phase without making the
    // admission caps unbounded.
    mcpUnusedSessionIdleMs: parsePositiveInteger(env.KONTROL_MCP_UNUSED_SESSION_IDLE_MS, 10 * 60_000, "KONTROL_MCP_UNUSED_SESSION_IDLE_MS"),
    // One useful tool call does not prove that the model is finished. The
    // soft/hard caps handle pathological one-session-per-tool churn without
    // conflating separate transports.
    // A completed tool call is not evidence that the host is finished. Keep
    // active client transports for a day by default; the per-client/global
    // caps and memory-pressure reaper still bound retained state.
    mcpEphemeralSessionIdleMs: parsePositiveInteger(env.KONTROL_MCP_EPHEMERAL_SESSION_IDLE_MS, 24 * 60 * 60_000, "KONTROL_MCP_EPHEMERAL_SESSION_IDLE_MS"),
    mcpReusableSessionIdleMs: parsePositiveInteger(env.KONTROL_MCP_REUSABLE_SESSION_IDLE_MS, 24 * 60 * 60_000, "KONTROL_MCP_REUSABLE_SESSION_IDLE_MS"),
    mcpSessionReaperIntervalMs: parsePositiveInteger(env.KONTROL_MCP_SESSION_REAPER_INTERVAL_MS, 15_000, "KONTROL_MCP_SESSION_REAPER_INTERVAL_MS"),
    mcpLogicalContinuityRetentionMs: parsePositiveInteger(env.KONTROL_MCP_LOGICAL_CONTINUITY_RETENTION_MS, 72 * 60 * 60_000, "KONTROL_MCP_LOGICAL_CONTINUITY_RETENTION_MS"),
    mcpSessionMaxPerClient: parsePositiveInteger(env.KONTROL_MCP_SESSION_MAX_PER_CLIENT, 20, "KONTROL_MCP_SESSION_MAX_PER_CLIENT"),
    mcpSessionSoftCap: parsePositiveInteger(env.KONTROL_MCP_SESSION_SOFT_CAP, 150, "KONTROL_MCP_SESSION_SOFT_CAP"),
    mcpSessionHardCap: parsePositiveInteger(env.KONTROL_MCP_SESSION_HARD_CAP, 200, "KONTROL_MCP_SESSION_HARD_CAP"),
    fsSnapshot: parseFsSnapshotConfig(env),
  };
  const mcpConfig = config;

  // P1 #15: relational validation. Individually-valid values can combine into
  // configurations where tools are permanently unadmittable or reaper timers
  // are meaningless — fail at startup with concrete messages instead.
  const MAX_ADMISSION_WEIGHT = 4; // heavy diff / mission verification (server.mcpAdmissionWeight)
  if (mcpConfig.mcpMaxInflight < MAX_ADMISSION_WEIGHT) {
    throw new Error(`KONTROL_MCP_MAX_INFLIGHT=${mcpConfig.mcpMaxInflight} is below the maximum single-request admission weight (${MAX_ADMISSION_WEIGHT}); heavy tools would never be admittable.`);
  }
  if (mcpConfig.mcpMaxInflightPerSession < MAX_ADMISSION_WEIGHT) {
    throw new Error(`KONTROL_MCP_MAX_INFLIGHT_PER_SESSION=${mcpConfig.mcpMaxInflightPerSession} is below the maximum single-request admission weight (${MAX_ADMISSION_WEIGHT}); heavy tools would be permanently blocked per session.`);
  }
  if (mcpConfig.mcpMaxWaitersPerSession > mcpConfig.mcpMaxWaiters) {
    throw new Error(`KONTROL_MCP_MAX_WAITERS_PER_SESSION=${mcpConfig.mcpMaxWaitersPerSession} must not exceed KONTROL_MCP_MAX_WAITERS=${mcpConfig.mcpMaxWaiters}.`);
  }
  if (mcpConfig.mcpSessionSoftCap > mcpConfig.mcpSessionHardCap) {
    throw new Error(`KONTROL_MCP_SESSION_SOFT_CAP=${mcpConfig.mcpSessionSoftCap} must not exceed KONTROL_MCP_SESSION_HARD_CAP=${mcpConfig.mcpSessionHardCap}.`);
  }
  if (mcpConfig.mcpSessionMaxPerClient > mcpConfig.mcpSessionHardCap) {
    throw new Error(`KONTROL_MCP_SESSION_MAX_PER_CLIENT=${mcpConfig.mcpSessionMaxPerClient} must not exceed KONTROL_MCP_SESSION_HARD_CAP=${mcpConfig.mcpSessionHardCap}.`);
  }
  if (mcpConfig.mcpSessionReaperIntervalMs > mcpConfig.mcpUnusedSessionIdleMs) {
    throw new Error(`KONTROL_MCP_SESSION_REAPER_INTERVAL_MS=${mcpConfig.mcpSessionReaperIntervalMs} should not exceed the shortest idle TTL (KONTROL_MCP_UNUSED_SESSION_IDLE_MS=${mcpConfig.mcpUnusedSessionIdleMs}); idle sessions would linger a full extra interval.`);
  }
  return config;
}

function parsePublicBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`KONTROL_PUBLIC_BASE_URL is not a valid URL: ${value}`);
  }
  // Deployment contract (P1 #7): the public base URL is embedded in OAuth
  // redirects and issuer metadata, so it must be an origin we actually serve.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`KONTROL_PUBLIC_BASE_URL must use http or https (got "${parsed.protocol}")`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("KONTROL_PUBLIC_BASE_URL must not contain username/password components");
  }
  if (parsed.hash) {
    throw new Error("KONTROL_PUBLIC_BASE_URL must not contain a fragment");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
