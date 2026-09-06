/**
 * P0.3: deployment/runtime authority is NOT ambient global state. It is
 * resolved exactly once, at the process entrypoint, into an immutable
 * DeploymentContext that is passed explicitly to openDatabase, createServer,
 * migration/backup logic, runtime identity validation, and release
 * activation. Implementation code never reads these fields from
 * process.env directly — that made every test and child process an
 * unintentional consumer of the running deployment's authority.
 */

/**
 * Launcher-only fields removed before spawning any process whose command or
 * working tree is project-controlled, and before starting unrelated test
 * harnesses. Not relying on each test remembering to unset variables.
 */
const LAUNCHER_AUTHORITY_KEYS = [
  "KONTROL_DEPLOYMENT_ID",
  "KONTROL_EXPECTED_SCHEMA_VERSION",
  "KONTROL_RUNTIME_LOCK_TOKEN",
  "KONTROL_DEPLOYMENT_LOCK_TOKEN",
  "KONTROL_LAUNCH_GENERATION_ID",
  "KONTROL_ARTIFACT_PATH",
  "KONTROL_BUILD_ID",
  "KONTROL_LAUNCHER",
] as const;

export interface DeploymentContext {
  deploymentId?: string;
  expectedSchemaVersion?: number;
  expectedBuildId?: string;
  launchGenerationId?: string;
  artifactPath?: string;
  launcher?: "systemd" | "dev-watch" | "serve";
}

/**
 * Resolve deployment identity from the process environment exactly once.
 * The entrypoint calls this; everything downstream receives the value.
 */
export function resolveDeploymentContext(source: NodeJS.ProcessEnv = process.env): DeploymentContext {
  const rawSchemaVersion = source.KONTROL_EXPECTED_SCHEMA_VERSION;
  const parsedSchemaVersion = rawSchemaVersion === undefined ? undefined : Number(rawSchemaVersion);
  const launcher = source.KONTROL_LAUNCHER;
  return {
    deploymentId: source.KONTROL_DEPLOYMENT_ID?.trim() || undefined,
    expectedSchemaVersion:
      parsedSchemaVersion !== undefined && Number.isInteger(parsedSchemaVersion)
        ? parsedSchemaVersion
        : undefined,
    expectedBuildId: source.KONTROL_BUILD_ID?.trim() || undefined,
    launchGenerationId: source.KONTROL_LAUNCH_GENERATION_ID?.trim() || undefined,
    artifactPath: source.KONTROL_ARTIFACT_PATH?.trim() || undefined,
    launcher:
      launcher === "systemd" || launcher === "dev-watch" || launcher === "serve"
        ? launcher
        : undefined,
  };
}

/**
 * Return a copy of `env` with launcher-only authority stripped. Use for any
 * child process that is not explicitly part of the deployment lifecycle
 * (test harnesses, unrelated tools, project shells).
 */
export function stripLauncherAuthority(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if ((LAUNCHER_AUTHORITY_KEYS as readonly string[]).includes(key)) continue;
    result[key] = value;
  }
  return result;
}

export const launcherAuthorityKeys: readonly string[] = LAUNCHER_AUTHORITY_KEYS;
