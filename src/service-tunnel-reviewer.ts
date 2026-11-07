import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadKontrolFiles, type KontrolServiceComponent } from "./user-config.js";
import { loadPolicyConfig, policyCanAsk } from "./policy.js";

/**
 * Tunnel reviewer-assertion credential authority, extracted from
 * service.ts (behavior preserved; re-exported by service.ts for
 * compatibility). The secret VALUE never enters unit files or command
 * lines — tunnel-client resolves the env: reference from its own
 * EnvironmentFile at runtime.
 */
// runtime. The header always names KONTROL_TUNNEL_REVIEWER_SECRET because
// that is the server's first-precedence credential (see config.ts): naming
// the legacy variable would break dedicated-secret deployments and
// both-secrets-differ deployments.
export const TUNNEL_REVIEWER_HEADER_NAME = "X-Kontrol-Tunnel-Reviewer";
export const TUNNEL_REVIEWER_SECRET_ENV = "KONTROL_TUNNEL_REVIEWER_SECRET";
export const TUNNEL_REVIEWER_HEADER_ARGS = [
  "--mcp.extra-headers",
  `${TUNNEL_REVIEWER_HEADER_NAME}: env:${TUNNEL_REVIEWER_SECRET_ENV}`,
] as const;

export type TunnelReviewerCredentialSource = "env-tunnel" | "env-acp" | "auth-file";

/**
 * Explicit, validated credential-source resolver shared (by precedence
 * contract) with scripts/kontrol-tunnel.sh: dedicated variable first, then
 * the legacy ACP reviewer secret, then the 0600 auth file. Returns the
 * source and the secret value; the value must never be logged or embedded
 * in generated files.
 */
export function resolveTunnelReviewerCredential(env: NodeJS.ProcessEnv = process.env): { source: TunnelReviewerCredentialSource; value: string } | undefined {
  const dedicated = env.KONTROL_TUNNEL_REVIEWER_SECRET?.trim();
  if (dedicated) return { source: "env-tunnel", value: dedicated };
  const legacy = env.KONTROL_ACP_REVIEWER_SECRET?.trim();
  if (legacy) return { source: "env-acp", value: legacy };
  const files = loadKontrolFiles(env);
  const authFile = files.auth.tunnelReviewerSecret?.trim();
  if (authFile) return { source: "auth-file", value: authFile };
  return undefined;
}

export type TunnelReviewerHeaderState =
  | { state: "exact" }
  | { state: "malformed"; value: string }
  | { state: "absent" };

const TUNNEL_REVIEWER_HEADER_PATTERN = /^X-Kontrol-Tunnel-Reviewer:\s*env:[A-Za-z_][A-Za-z0-9_]*\s*$/i;

/**
 * Exact parse of the `--mcp.extra-headers` argv pairs. Merely finding the
 * header name somewhere in the command does not count as valid wiring: the
 * flag must be present as its own argv element and its value must be a
 * well-formed reviewer assertion.
 */
export function tunnelReviewerHeaderState(command: string[]): TunnelReviewerHeaderState {
  for (let i = 0; i < command.length; i += 1) {
    if (command[i] !== "--mcp.extra-headers") continue;
    const value = command[i + 1];
    if (value === undefined) return { state: "malformed", value: "" };
    if (TUNNEL_REVIEWER_HEADER_PATTERN.test(value)) return { state: "exact" };
    if (value.toLowerCase().includes(TUNNEL_REVIEWER_HEADER_NAME.toLowerCase())) {
      return { state: "malformed", value };
    }
  }
  return { state: "absent" };
}

export function tunnelComponentHasReviewerAuth(command: string[]): boolean {
  return tunnelReviewerHeaderState(command).state === "exact";
}

/**
 * Append the canonical reviewer-assertion header args to a tunnel-client
 * argv, mirroring scripts/kontrol-tunnel.sh. Idempotent: an exactly-parsed
 * header is left untouched. A malformed reviewer header is an operator
 * error and fails closed instead of being papered over with a second
 * flag. Adapter commands must never pass through here.
 */
export function withTunnelReviewerAuth(command: string[]): string[] {
  const header = tunnelReviewerHeaderState(command);
  if (header.state === "exact") return [...command];
  if (header.state === "malformed") {
    throw new Error(
      `Tunnel component has a malformed reviewer header ${JSON.stringify(header.value)}; `
      + `expected "${TUNNEL_REVIEWER_HEADER_NAME}: env:<VARIABLE>". Fix the component command instead of stacking flags.`,
    );
  }
  return [...command, ...TUNNEL_REVIEWER_HEADER_ARGS];
}

/**
 * Protected runtime credential mechanism for non-env reviewer secrets.
 * When the reviewer secret resolves from the legacy variable or the auth
 * file, the service EnvironmentFile must still provide
 * KONTROL_TUNNEL_REVIEWER_SECRET at tunnel start (that is the only name the
 * generated header references). Upserts the single key atomically at 0600,
 * preserving every other line; never logs the value.
 */
export function ensureTunnelReviewerEnvFile(environmentFile: string, value: string): "present" | "materialized" {
  const keyPattern = /^\s*KONTROL_TUNNEL_REVIEWER_SECRET\s*=/;
  let existing = "";
  try {
    existing = readFileSync(environmentFile, "utf8");
  } catch {
    existing = "";
  }
  if (existing.split("\n").some((line) => keyPattern.test(line))) return "present";
  const body = existing.length === 0
    ? `KONTROL_TUNNEL_REVIEWER_SECRET=${value}\n`
    : `${existing.endsWith("\n") ? existing : `${existing}\n`}KONTROL_TUNNEL_REVIEWER_SECRET=${value}\n`;
  mkdirSync(dirname(environmentFile), { recursive: true, mode: 0o700 });
  writeFileSync(environmentFile, body, { mode: 0o600 });
  try {
    chmodSync(environmentFile, 0o600);
  } catch {
    // Filesystem may not support chmod (exotic mounts); the atomic create
    // already requested 0600. Best effort only, never fatal.
  }
  return "materialized";
}

/**
 * Fail closed when a tunnel component would launch an ask-capable deployment
 * without a reviewer assertion. Mirrors the kontrol-tunnel.sh startup guard:
 * ask-gated tools would otherwise create approvals that no reviewer surface
 * can open or resolve. The secret may live in the service environment or the
 * 0600 auth file; only its absence under tunnel authMode with an ask-capable
 * policy rejects the install/upgrade.
 */
/**
 * Ensure the runtime environment provides the canonical reviewer secret.
 * The generated tunnel header always references
 * KONTROL_TUNNEL_REVIEWER_SECRET, so when the credential resolves from the
 * legacy variable or the auth file, that value is materialized into the
 * 0600 service EnvironmentFile (single-key upsert, never logged). No-op
 * when no tunnel component is configured, authMode is not tunnel, no
 * credential resolves, or the key is already present.
 */
export function materializeTunnelReviewerSecret(
  components: KontrolServiceComponent[],
  env: NodeJS.ProcessEnv = process.env,
  environmentFile?: string,
): "present" | "materialized" | "skipped" {
  if (!components.some((component) => component.kind === "tunnel")) return "skipped";
  const files = loadKontrolFiles(env);
  if ((env.KONTROL_AUTH_MODE ?? files.config.authMode) !== "tunnel") return "skipped";
  const credential = resolveTunnelReviewerCredential(env);
  if (!credential || !environmentFile) return "skipped";
  return ensureTunnelReviewerEnvFile(environmentFile, credential.value);
}

export function requireTunnelReviewerWiring(components: KontrolServiceComponent[], env: NodeJS.ProcessEnv = process.env): void {
  if (!components.some((component) => component.kind === "tunnel")) return;
  const files = loadKontrolFiles(env);
  const authMode = env.KONTROL_AUTH_MODE ?? files.config.authMode;
  if (authMode !== "tunnel") return;
  const credential = resolveTunnelReviewerCredential(env);
  if (policyCanAsk(loadPolicyConfig(env)) && !credential) {
    throw new Error(
      "Tunnel service components with authMode=tunnel and an ask-capable policy require a reviewer assertion: "
      + "set KONTROL_TUNNEL_REVIEWER_SECRET (or KONTROL_ACP_REVIEWER_SECRET), or use a non-interactive policy posture "
      + "(KONTROL_POLICY_MODE=allow). Ask-gated tools would otherwise create approvals that no reviewer surface can open or resolve.",
    );
  }
}
