import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { writeKontrolAuth, writeKontrolConfig } from "./user-config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "kontrol-empty-config-test-"));
const baseEnv = {
  KONTROL_CONFIG_DIR: emptyConfigDir,
  KONTROL_ALLOWED_ROOTS: process.cwd(),
  KONTROL_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.equal(loadConfig(baseEnv).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, KONTROL_WIDGETS: "changes" }).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, KONTROL_WIDGETS: "full" }).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, KONTROL_WIDGETS: "off" }).widgets, "off");
assert.equal(loadConfig(baseEnv).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, KONTROL_TOOL_MODE: "minimal" }).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, KONTROL_TOOL_MODE: "full" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, KONTROL_TOOL_MODE: "codex" }).toolMode, "codex");
assert.equal(loadConfig({ ...baseEnv, KONTROL_MINIMAL_TOOLS: "0" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, KONTROL_MINIMAL_TOOLS: "1" }).toolMode, "minimal");
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.deepEqual(loadConfig(baseEnv).childEnvironmentAllowlist, []);
assert.deepEqual(loadConfig({ ...baseEnv, KONTROL_CHILD_ENV_ALLOWLIST: "SSH_AUTH_SOCK,HTTP_PROXY,not-valid-name!" }).childEnvironmentAllowlist, ["SSH_AUTH_SOCK", "HTTP_PROXY"]);
assert.deepEqual(loadConfig({ ...baseEnv, KONTROL_VERIFY_TOOLCHAIN_PATHS: "/opt/node,/opt/cargo" }).verifyToolchainPaths, ["/opt/node", "/opt/cargo"]);
assert.equal(loadConfig(baseEnv).webhookEnabled, false);
assert.deepEqual(loadConfig({ ...baseEnv, KONTROL_WEBHOOKS: "1", KONTROL_WEBHOOK_ALLOWED_HOSTS: "hooks.example,api.example" }).webhookAllowedHosts, ["hooks.example", "api.example"]);

// P1 #5: ACP credential strength / role-separation validation.
const long = "x".repeat(48);
assert.doesNotThrow(() => loadConfig({
  ...baseEnv,
  KONTROL_ACP_AGENT_SECRET: "a" + "0".repeat(47),
  KONTROL_ACP_REVIEWER_SECRET: "b" + "0".repeat(47),
  KONTROL_ACP_ADAPTER_SECRET: "c" + "0".repeat(47),
}), "distinct strong secrets accepted");

// Secrets built at runtime so key-shaped literals never appear in source.
const shortSecret = "short-" + "0".repeat(10); // 16 chars < 32
assert.throws(
  () => loadConfig({
    ...baseEnv,
    KONTROL_ACP_AGENT_SECRET: shortSecret,
    KONTROL_ACP_REVIEWER_SECRET: "b" + "0".repeat(47),
    KONTROL_ACP_ADAPTER_SECRET: "c" + "0".repeat(47),
  }),
  /at least 32 characters/,
  "short ACP secret rejected",
);

const dup = "d" + "0".repeat(47);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    KONTROL_ACP_AGENT_SECRET: dup,
    KONTROL_ACP_REVIEWER_SECRET: dup,
    KONTROL_ACP_ADAPTER_SECRET: "c" + "0".repeat(47),
  }),
  /are identical/,
  "identical agent/reviewer secrets rejected",
);

assert.throws(
  () => loadConfig({ ...baseEnv, KONTROL_ACP_SHARED_SECRET: "legacy-short" }),
  /at least 32 characters/,
  "short legacy shared secret rejected",
);

assert.doesNotThrow(() => loadConfig({
  ...baseEnv,
  KONTROL_ACP_SHARED_SECRET: "e" + "0".repeat(47),
}), "long legacy shared secret (compatibility mode) accepted");

assert.throws(
  () => loadConfig({
    ...baseEnv,
    KONTROL_ACP_AGENT_SECRET: "a" + "0".repeat(47),
    KONTROL_ACP_SHARED_SECRET: "e" + "0".repeat(47),
  }),
  /Partial ACP credential configuration/,
  "partial per-role configuration rejected",
);

// Disabled ACP bypasses validation entirely.
assert.doesNotThrow(() => loadConfig({
  ...baseEnv,
  KONTROL_ACP_ENABLED: "0",
  KONTROL_ACP_AGENT_SECRET: "short",
}), "ACP validation skipped when ACP is disabled");
assert.equal(loadConfig(baseEnv).mcpUnusedSessionIdleMs, 600_000);
assert.equal(loadConfig(baseEnv).mcpEphemeralSessionIdleMs, 86_400_000);
assert.equal(loadConfig(baseEnv).mcpReusableSessionIdleMs, 86_400_000);
assert.equal(loadConfig(baseEnv).mcpSessionReaperIntervalMs, 15_000);
assert.equal(loadConfig(baseEnv).mcpLogicalContinuityRetentionMs, 259_200_000);
assert.equal(loadConfig(baseEnv).mcpSessionMaxPerClient, 20);
assert.equal(loadConfig(baseEnv).mcpSessionSoftCap, 150);
assert.equal(loadConfig(baseEnv).mcpSessionHardCap, 200);
assert.equal(loadConfig({ ...baseEnv, KONTROL_MCP_EPHEMERAL_SESSION_IDLE_MS: "1234" }).mcpEphemeralSessionIdleMs, 1234);
assert.equal(loadConfig(baseEnv).mcpAdmissionTimeoutMs, 120_000);
assert.equal(loadConfig(baseEnv).mcpExecutionTimeoutMs, 30 * 60_000);
assert.equal(loadConfig(baseEnv).maintenanceIntervalMs, 5 * 60_000);
assert.equal(loadConfig(baseEnv).maintenanceBudgetMs, 250);
assert.equal(loadConfig(baseEnv).integrityIntervalMs, 30 * 60_000);
assert.equal(loadConfig(baseEnv).integrityDeadlineMs, 10_000);
assert.equal(loadConfig(baseEnv).policyApprovalTimeoutMs, 24 * 60 * 60_000);
assert.equal(loadConfig(baseEnv).policyDirectApprovalReattachGraceMs, 5 * 60_000);
assert.equal(loadConfig({ ...baseEnv, KONTROL_MCP_ADMISSION_TIMEOUT_MS: "4321", KONTROL_MCP_EXECUTION_TIMEOUT_MS: "8765", KONTROL_POLICY_APPROVAL_TIMEOUT_MS: "9999" }).mcpAdmissionTimeoutMs, 4321);
assert.equal(loadConfig({ ...baseEnv, KONTROL_MAINTENANCE_INTERVAL_MS: "41", KONTROL_MAINTENANCE_BUDGET_MS: "17", KONTROL_INTEGRITY_INTERVAL_MS: "43", KONTROL_INTEGRITY_DEADLINE_MS: "19" }).maintenanceIntervalMs, 41);
assert.equal(loadConfig({ ...baseEnv, KONTROL_MAINTENANCE_INTERVAL_MS: "41", KONTROL_MAINTENANCE_BUDGET_MS: "17", KONTROL_INTEGRITY_INTERVAL_MS: "43", KONTROL_INTEGRITY_DEADLINE_MS: "19" }).maintenanceBudgetMs, 17);
assert.equal(loadConfig({ ...baseEnv, KONTROL_MAINTENANCE_INTERVAL_MS: "41", KONTROL_MAINTENANCE_BUDGET_MS: "17", KONTROL_INTEGRITY_INTERVAL_MS: "43", KONTROL_INTEGRITY_DEADLINE_MS: "19" }).integrityIntervalMs, 43);
assert.equal(loadConfig({ ...baseEnv, KONTROL_MAINTENANCE_INTERVAL_MS: "41", KONTROL_MAINTENANCE_BUDGET_MS: "17", KONTROL_INTEGRITY_INTERVAL_MS: "43", KONTROL_INTEGRITY_DEADLINE_MS: "19" }).integrityDeadlineMs, 19);
assert.equal(loadConfig({ ...baseEnv, KONTROL_POLICY_DIRECT_REATTACH_GRACE_MS: "23" }).policyDirectApprovalReattachGraceMs, 23);
assert.equal(loadConfig({ ...baseEnv, KONTROL_MCP_ADMISSION_TIMEOUT_MS: "4321" }).mcpRequestDeadlineMs, 4321);
assert.equal(loadConfig({ ...baseEnv, KONTROL_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, KONTROL_SKILLS: "1" }).skillsEnabled, true);

assert.throws(
  () => loadConfig({ ...baseEnv, KONTROL_WIDGETS: "invalid" }),
  /Invalid KONTROL_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, KONTROL_WIDGETS: "minimal" }),
  /Invalid KONTROL_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, KONTROL_WIDGETS: "write-only" }),
  /Invalid KONTROL_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, KONTROL_TOOL_MODE: "invalid" }),
  /Invalid KONTROL_TOOL_MODE: invalid/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: undefined,
});

assert.equal(loadConfig({ ...baseEnv, KONTROL_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, KONTROL_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, KONTROL_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, KONTROL_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, KONTROL_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, KONTROL_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, KONTROL_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, KONTROL_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, KONTROL_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, KONTROL_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, KONTROL_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);

// P1 #7: trusted-proxy specification replaces the boolean model.
const trustDeepEqual = (env: Record<string, string>, expected: string | undefined) =>
  assert.deepEqual(loadConfig({ ...baseEnv, ...env }).logging.trustProxy, expected);
trustDeepEqual({ KONTROL_TRUST_PROXY: "0" }, undefined);
trustDeepEqual({ KONTROL_TRUST_PROXY: "false" }, undefined);
trustDeepEqual({ KONTROL_TRUST_PROXY: "1" }, "1");
trustDeepEqual({ KONTROL_TRUST_PROXY: "2" }, "2");
trustDeepEqual({ KONTROL_TRUST_PROXY: "loopback" }, "loopback");
assert.throws(
  () => loadConfig({ ...baseEnv, KONTROL_TRUST_PROXY: "banana" }),
  /Invalid KONTROL_TRUST_PROXY/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, KONTROL_LOG_LEVEL: "trace" }),
  /Invalid KONTROL_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, KONTROL_LOG_FORMAT: "color" }),
  /Invalid KONTROL_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["kontrol"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);

assert.deepEqual(
  loadConfig({ ...baseEnv, KONTROL_OAUTH_SCOPES: "kontrol,admin" }).oauth.scopes,
  ["kontrol", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, KONTROL_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, KONTROL_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, KONTROL_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

assert.throws(
  () => loadConfig({ KONTROL_CONFIG_DIR: emptyConfigDir, KONTROL_ALLOWED_ROOTS: process.cwd() }),
  /KONTROL_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, KONTROL_OAUTH_OWNER_TOKEN: "too-short" }),
  /KONTROL_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, KONTROL_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid KONTROL_OAUTH_ACCESS_TOKEN_TTL_SECONDS: must be a positive integer \(got "0"\)/,
);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

assert.equal(
  loadConfig({ ...baseEnv, KONTROL_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).publicBaseUrl,
  "https://abc.trycloudflare.com",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, KONTROL_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, KONTROL_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "kontrol-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://kontrol.example.com",
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ KONTROL_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://kontrol.example.com");
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "kontrol.example.com",
]);

// The filesystem boundary must always be explicit. Missing, empty, and
// whitespace-only values must not turn the process working directory into an
// implicit allowed root, including when a persisted config is present.
const rootsRequiredEnv = {
  KONTROL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "kontrol-roots-required-")),
  KONTROL_OAUTH_OWNER_TOKEN: "roots-required-owner-token-long-enough",
};
for (const roots of [undefined, "", "   "]) {
  assert.throws(
    () => loadConfig({ ...rootsRequiredEnv, ...(roots === undefined ? {} : { KONTROL_ALLOWED_ROOTS: roots }) }),
    /KONTROL_ALLOWED_ROOTS must contain at least one explicit directory/,
    `roots value ${String(roots)} must fail closed`,
  );
}
const persistedEmptyRootsDir = mkdtempSync(join(tmpdir(), "kontrol-persisted-empty-roots-"));
writeFileSync(join(persistedEmptyRootsDir, "config.json"), JSON.stringify({ allowedRoots: [] }));
writeFileSync(join(persistedEmptyRootsDir, "auth.json"), JSON.stringify({ ownerToken: "persisted-roots-owner-token-long-enough" }));
assert.throws(
  () => loadConfig({ KONTROL_CONFIG_DIR: persistedEmptyRootsDir }),
  /KONTROL_ALLOWED_ROOTS must contain at least one explicit directory/,
  "persisted empty roots must fail closed",
);

// Rewriting an existing exposed auth file must tighten its mode, not merely
// pass mode=0600 to a write call that leaves the old inode permissions intact.
const secureConfigDir = mkdtempSync(join(tmpdir(), "kontrol-user-config-secure-"));
const secureConfigEnv = { KONTROL_CONFIG_DIR: secureConfigDir };
writeKontrolConfig({ allowedRoots: [process.cwd()] }, secureConfigEnv);
writeKontrolAuth({ ownerToken: "secure-auth-owner-token-long-enough" }, secureConfigEnv);
chmodSync(join(secureConfigDir, "auth.json"), 0o644);
writeKontrolAuth({ ownerToken: "rewritten-auth-owner-token-long-enough" }, secureConfigEnv);
assert.equal(statSync(secureConfigDir).mode & 0o777, 0o700, "config directory is owner-only");
assert.equal(statSync(join(secureConfigDir, "auth.json")).mode & 0o777, 0o600, "auth rewrite tightens file permissions");

// P0 — tunnel mode must not start an ask-capable policy without a reviewer
// credential. Direct approvals exist independently from ACP; without reviewer
// authority the deployment can mint approval cards that no surface can
// resolve, deadlocking every ask-gated tool call.
const tunnelEnv = {
  KONTROL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "kontrol-tunnel-gate-config-")),
  KONTROL_ALLOWED_ROOTS: process.cwd(),
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
};
const reviewerSecret = "tunnel-gate-reviewer-secret-long-enough";

// Ask-capable without reviewer secret: deadlocked configuration, must fail.
assert.throws(
  () => loadConfig({ ...tunnelEnv }),
  /ask-capable policy requires a reviewer credential/,
  "tunnel + baseline ask policy without reviewer secret must fail startup",
);
assert.throws(
  () => loadConfig({ ...tunnelEnv, KONTROL_POLICY_MODE: "ask" }),
  /ask-capable policy requires a reviewer credential/,
  "tunnel + explicit ask mode without reviewer secret must fail startup",
);
assert.throws(
  () => loadConfig({ ...tunnelEnv, KONTROL_POLICY_MODE: "allow", KONTROL_POLICY_TOOL_BASH: "ask" }),
  /ask-capable policy requires a reviewer credential/,
  "tunnel + per-tool ask without reviewer secret must fail startup",
);
assert.throws(
  () => loadConfig({
    ...tunnelEnv,
    KONTROL_POLICY_MODE: "allow",
    KONTROL_POLICY_PATH_RULES: JSON.stringify([{ pattern: "/etc/**", mode: "ask" }]),
  }),
  /ask-capable policy requires a reviewer credential/,
  "tunnel + ask path rule without reviewer secret must fail startup",
);

// Non-interactive postures stay valid without a reviewer secret: no approval
// decisions can be produced, so there is nothing to deadlock.
assert.doesNotThrow(
  () => loadConfig({ ...tunnelEnv, KONTROL_POLICY_MODE: "allow" }),
  "tunnel + allow policy needs no reviewer credential",
);
assert.doesNotThrow(
  () => loadConfig({ ...tunnelEnv, KONTROL_POLICY_MODE: "deny" }),
  "tunnel + deny policy needs no reviewer credential",
);

// Any reviewer credential source satisfies the gate.
assert.doesNotThrow(
  () => loadConfig({ ...tunnelEnv, KONTROL_TUNNEL_REVIEWER_SECRET: reviewerSecret }),
  "dedicated tunnel reviewer secret satisfies the ask gate",
);
assert.doesNotThrow(
  () => loadConfig({ ...tunnelEnv, KONTROL_ACP_REVIEWER_SECRET: reviewerSecret }),
  "legacy ACP reviewer secret satisfies the ask gate",
);

// Non-tunnel auth modes provide reviewer authority through their own
// mechanisms (OAuth scopes / ACP credentials) and are not gated here.
assert.doesNotThrow(
  () => loadConfig({ ...baseEnv }),
  "oauth mode is not subject to the tunnel reviewer gate",
);
