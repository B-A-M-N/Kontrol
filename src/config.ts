import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import type { PolicyConfig } from "./policy.js";
import { loadPolicyConfig } from "./policy.js";
import { loadKontrolFiles } from "./user-config.js";

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
  /** Bounded MCP request admission limits. */
  mcpMaxInflight: number;
  mcpMaxInflightPerSession: number;
  mcpMaxQueue: number;
  /** Independent cap for parked event/review/terminal waiters. */
  mcpMaxWaiters: number;
  mcpMaxWaitersPerSession: number;
  mcpMaxWaiterQueue: number;
  mcpRequestDeadlineMs: number;
  mcpUnusedSessionIdleMs: number;
  mcpEphemeralSessionIdleMs: number;
  mcpReusableSessionIdleMs: number;
  mcpSessionReaperIntervalMs: number;
  mcpSessionMaxPerClient: number;
  mcpSessionSoftCap: number;
  mcpSessionHardCap: number;
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
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
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

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(env.KONTROL_LOG_LEVEL),
    format: parseLogFormat(env.KONTROL_LOG_FORMAT),
    requests: env.KONTROL_LOG_REQUESTS === undefined ? true : parseBoolean(env.KONTROL_LOG_REQUESTS),
    assets: parseBoolean(env.KONTROL_LOG_ASSETS),
    toolCalls: env.KONTROL_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.KONTROL_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.KONTROL_LOG_SHELL_COMMANDS),
    trustProxy: parseBoolean(env.KONTROL_TRUST_PROXY),
  };
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadKontrolFiles(env);
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
    policy: loadPolicyConfig(env),
    // P1 #50: Diagnostics secret — required for /diagnostics when set
    diagnosticsSecret: env.KONTROL_DIAGNOSTICS_SECRET,
    supervisorMaxInflight: parsePositiveInteger(env.KONTROL_SUPERVISOR_MAX_INFLIGHT, 4, "KONTROL_SUPERVISOR_MAX_INFLIGHT"),
    verifyMaxInflight: parsePositiveInteger(env.KONTROL_VERIFY_MAX_INFLIGHT, 3, "KONTROL_VERIFY_MAX_INFLIGHT"),
    verifySandbox: env.KONTROL_VERIFY_SANDBOX === "1" || env.KONTROL_VERIFY_SANDBOX === "true",
    mcpMaxInflight: parsePositiveInteger(env.KONTROL_MCP_MAX_INFLIGHT, 32, "KONTROL_MCP_MAX_INFLIGHT"),
    mcpMaxInflightPerSession: parsePositiveInteger(env.KONTROL_MCP_MAX_INFLIGHT_PER_SESSION, 8, "KONTROL_MCP_MAX_INFLIGHT_PER_SESSION"),
    mcpMaxQueue: parsePositiveInteger(env.KONTROL_MCP_MAX_QUEUE, 128, "KONTROL_MCP_MAX_QUEUE"),
    mcpMaxWaiters: parsePositiveInteger(env.KONTROL_MCP_MAX_WAITERS, 64, "KONTROL_MCP_MAX_WAITERS"),
    mcpMaxWaitersPerSession: parsePositiveInteger(env.KONTROL_MCP_MAX_WAITERS_PER_SESSION, 2, "KONTROL_MCP_MAX_WAITERS_PER_SESSION"),
    mcpMaxWaiterQueue: parsePositiveInteger(env.KONTROL_MCP_MAX_WAITER_QUEUE, 64, "KONTROL_MCP_MAX_WAITER_QUEUE"),
    mcpRequestDeadlineMs: parsePositiveInteger(env.KONTROL_MCP_REQUEST_DEADLINE_MS, 120_000, "KONTROL_MCP_REQUEST_DEADLINE_MS"),
    // Give a client time to finish model-side reasoning and issue its first
    // useful operation; cleanup remains bounded by admission caps.
    mcpUnusedSessionIdleMs: parsePositiveInteger(env.KONTROL_MCP_UNUSED_SESSION_IDLE_MS, 2 * 60_000, "KONTROL_MCP_UNUSED_SESSION_IDLE_MS"),
    // One useful tool call does not prove that the model is finished. The
    // soft/hard caps handle pathological one-session-per-tool churn without
    // conflating separate transports.
    mcpEphemeralSessionIdleMs: parsePositiveInteger(env.KONTROL_MCP_EPHEMERAL_SESSION_IDLE_MS, 5 * 60_000, "KONTROL_MCP_EPHEMERAL_SESSION_IDLE_MS"),
    mcpReusableSessionIdleMs: parsePositiveInteger(env.KONTROL_MCP_REUSABLE_SESSION_IDLE_MS, 15 * 60_000, "KONTROL_MCP_REUSABLE_SESSION_IDLE_MS"),
    mcpSessionReaperIntervalMs: parsePositiveInteger(env.KONTROL_MCP_SESSION_REAPER_INTERVAL_MS, 15_000, "KONTROL_MCP_SESSION_REAPER_INTERVAL_MS"),
    mcpSessionMaxPerClient: parsePositiveInteger(env.KONTROL_MCP_SESSION_MAX_PER_CLIENT, 20, "KONTROL_MCP_SESSION_MAX_PER_CLIENT"),
    mcpSessionSoftCap: parsePositiveInteger(env.KONTROL_MCP_SESSION_SOFT_CAP, 150, "KONTROL_MCP_SESSION_SOFT_CAP"),
    mcpSessionHardCap: parsePositiveInteger(env.KONTROL_MCP_SESSION_HARD_CAP, 200, "KONTROL_MCP_SESSION_HARD_CAP"),
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
  const parsed = new URL(value);
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
