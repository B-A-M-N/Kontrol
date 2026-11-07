import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadKontrolFiles, type KontrolServiceComponent } from "./user-config.js";
import {
  SCHEMA_INCOMPATIBLE_EXIT_CODE,
  aggregateLifecycleStatus,
  buildLifecycleManifest,
  preflightArtifactCompatibility,
  type ComponentLiveness,
} from "./lifecycle-coordinator.js";
import { loadPolicyConfig, policyCanAsk } from "./policy.js";
import { acquireDeploymentLock, releaseDeploymentLock, type DeploymentLockHandle } from "./deployment-lock.js";
import { markMigrationRollbackWindowComplete, restoreDeploymentDatabaseBackup } from "./db/deployment-backup.js";
import { assertArtifactContent } from "./release-integrity.js";

export interface ServiceBuild {
  artifactPath: string;
  buildId: string;
  contentSha256: string;
  schemaVersion: number;
  minReadableSchemaVersion: number;
  maxReadableSchemaVersion: number;
}

export interface InstalledServiceState extends ServiceBuild {
  serviceName: string;
  deploymentId: string;
  installedAt: string;
  /** Installed component graph (adapters/tunnel), persisted so deployment
   * reconciliation can verify systemd component evidence. */
  serviceComponents?: KontrolServiceComponent[];
}

export interface ServicePaths {
  dataRoot: string;
  releasesRoot: string;
  statePath: string;
  stateDir: string;
  unitPath: string;
  environmentFile: string;
  serviceName: string;
}

export interface ServiceCommandDependencies {
  /** Test seam for selecting an immutable checkout or installed candidate. */
  currentArtifactPath?: () => string;
  /** Test seam for the systemd control boundary. */
  systemctl?: (paths: ServicePaths, args: string[]) => void;
  /** Test seam for the Linux/systemd availability check. */
  requireSystemd?: () => void;
  /** Test seam for readiness and exact artifact identity verification. */
  waitForReady?: (paths: ServicePaths, expected: InstalledServiceState) => Promise<void>;
  /** Test seam for unit active-state probes (stop verification, status). */
  probeUnitActive?: (unit: string) => boolean;
  /** Test seam for full unit-state probes (status verdict). */
  probeUnit?: (unit: string) => UnitProbeState;
  /** Test seam for auxiliary endpoint reachability (status verdict). */
  probeComponentEndpoint?: (unit: string, port: number) => Promise<{ reachable: boolean; detail?: string }>;
  /** Test seam for the tunnel MCP channel probe (status + recovery). */
  probeTunnelChannel?: (healthPort: number) => Promise<TunnelChannelState>;
  /** Test seam for persistent enablement probes (member reconciliation). */
  probeUnitEnabled?: (unit: string) => boolean | null;
}

interface DeploymentRecord {
  deploymentId: string;
  operation: "install" | "start" | "stop" | "restart" | "upgrade" | "uninstall" | "recover-tunnel";
  stage: "prepare" | "prepared" | "stop" | "activate" | "rollback" | "commit" | "rollback_failed" | "failed";
  previous?: InstalledServiceState;
  candidate?: InstalledServiceState;
  databaseRestore?: unknown;
  memberRestore?: MemberEnablementRestore;
  error?: string;
  updatedAt: string;
}

/**
 * Outcome of a member-enablement restore: which units were disabled and
 * enabled, and which prior states could not be determined. Unknown priors
 * are conservatively re-enabled (members are meant to be enabled) but stay
 * listed under `unresolved` so the journal never silently claims an exact
 * restoration it could not prove.
 */
export interface MemberEnablementRestore {
  disabled: string[];
  enabled: string[];
  unresolved: string[];
}

function defaultDataRoot(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "kontrol");
}

function defaultStateDir(env: NodeJS.ProcessEnv): string {
  const files = loadKontrolFiles(env);
  return resolve(env.KONTROL_STATE_DIR ?? files.config.stateDir ?? defaultDataRoot(env));
}

/**
 * Systemd-backend ownership: dataRoot + releasesRoot are the *installed*
 * store (~/.local/share/kontrol/releases). The tmux/source-checkout launcher
 * (start-all.sh) owns a separate store at <checkout>/releases. The two stores
 * are never interchangeable: a tmux launch that selects a systemd artifact
 * must import it (verified, atomic) into the tmux store before activation,
 * and must never mutate service.json / the installed record as a shortcut.
 * stateDir (shared generation.json) lives under the same data root by default,
 * which is why artifact ownership must be explicit in the record.
 */
export function servicePaths(env: NodeJS.ProcessEnv = process.env): ServicePaths {
  const configHome = resolve(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  const serviceName = env.KONTROL_USER_SERVICE_NAME?.trim() || "kontrol-core.service";
  const dataRoot = resolve(env.KONTROL_SERVICE_DATA_DIR ?? defaultDataRoot(env));
  const configRoot = join(configHome, "systemd", "user");
  return {
    dataRoot,
    releasesRoot: join(dataRoot, "releases"),
    statePath: join(dataRoot, "service.json"),
    stateDir: defaultStateDir(env),
    unitPath: join(configRoot, serviceName),
    environmentFile: resolve(env.KONTROL_USER_ENV_FILE ?? join(configHome, "kontrol", "environment")),
    serviceName,
  };
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function deploymentRecordPath(paths: ServicePaths, deploymentId: string): string {
  return join(paths.stateDir, `deployment.${deploymentId}.json`);
}

function writeDeploymentRecord(paths: ServicePaths, record: DeploymentRecord): void {
  writeJsonAtomic(deploymentRecordPath(paths, record.deploymentId), record);
}

function updateDeploymentRecord(paths: ServicePaths, record: DeploymentRecord, patch: Partial<DeploymentRecord>): DeploymentRecord {
  const next = { ...record, ...patch, updatedAt: new Date().toISOString() };
  writeDeploymentRecord(paths, next);
  return next;
}

function compiledArtifactPath(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export type LiveDatabaseInspection =
  /** No database file exists yet: a fresh install with nothing to be compatible with. */
  | { status: "absent" }
  /** The live schema version was read without mutation. */
  | { status: "ok"; schemaVersion: number }
  /** A database file exists but its schema version cannot be established. */
  | { status: "unreadable"; reason: string };

/**
 * Inspect the live database schema version without mutating anything. The
 * read-only open can never trigger a migration or a backup. Three outcomes
 * are distinguished: absent (fresh install), ok (a version was read), and
 * unreadable (a file exists but cannot be inspected — corrupt, locked, or
 * pre-migration). Unreadable is never conflated with absent: callers must
 * fail closed instead of skipping compatibility gates.
 */
export function inspectLiveDatabase(stateDir: string): LiveDatabaseInspection {
  const dbPath = join(stateDir, "kontrol.sqlite");
  if (!existsSync(dbPath)) return { status: "absent" };
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(dbPath, { readonly: true });
    const row = sqlite
      .prepare("select max(version) as version from kontrol_schema_migrations")
      .get() as { version?: unknown } | undefined;
    const version = Number(row?.version);
    if (!Number.isInteger(version) || version < 0) {
      return { status: "unreadable", reason: `${dbPath} exists but its schema version is unreadable (${String(row?.version)})` };
    }
    return { status: "ok", schemaVersion: version };
  } catch (error) {
    return { status: "unreadable", reason: `${dbPath} exists but cannot be inspected: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    try {
      sqlite?.close();
    } catch {
      // Read-only probe; close failures carry no state.
    }
  }
}

/**
 * Fail closed when the candidate artifact cannot open the live database.
 * This is the check whose absence left the obsolete 113 build crash-looping
 * against the schema-116 database: the refusal must happen here, before
 * any unit rewrite, process start, or migration — never in the journal
 * after five restarts. An unreadable database blocks the gate instead of
 * skipping it: proceeding without a compatibility verdict risks exactly
 * the crash loop this gate exists to prevent.
 */
function preflightCandidateAgainstLiveDatabase(paths: ServicePaths, candidate: ServiceBuild): void {
  const inspection = inspectLiveDatabase(paths.stateDir);
  if (inspection.status === "absent") return;
  if (inspection.status === "unreadable") {
    throw new Error(`cannot verify candidate ${candidate.buildId} against the live database: ${inspection.reason}`);
  }
  const verdict = preflightArtifactCompatibility(candidate, inspection.schemaVersion);
  if (!verdict.compatible) throw new Error(verdict.reason);
}

/**
 * Production units require their environment file (no `-` optional prefix
 * in the rendered unit). Validate its presence before any mutation without
 * ever logging its contents — install/upgrade must not default into an
 * insecure or incorrect authentication mode when configuration is absent.
 */
function requireServiceEnvironmentFile(paths: ServicePaths): void {
  if (!existsSync(paths.environmentFile)) {
    throw new Error(
      `Kontrol service environment file is missing: ${paths.environmentFile}. Create it before install/upgrade (never inline secrets on the command line).`,
    );
  }
}

/** Byte snapshot of one file; null when absent. */
function snapshotFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Restore a file snapshot; files absent at snapshot time are removed. */
function restoreFileSnapshot(path: string, snapshot: string | null): void {
  if (snapshot === null) rmSync(path, { force: true });
  else writeFileSync(path, snapshot);
}

/** Byte snapshot of every installed unit file plus the installed state. */
function snapshotUnitFiles(paths: ServicePaths): Map<string, string | null> {
  const names = new Set<string>([paths.unitPath, paths.statePath]);
  try {
    const configRoot = dirname(paths.unitPath);
    for (const entry of readdirSync(configRoot)) {
      if (entry === "kontrol.target" || /^kontrol-.+\.service$/.test(entry)) {
        names.add(join(configRoot, entry));
      }
    }
  } catch {
    // Config root may not exist yet on a fresh install.
  }
  const snapshot = new Map<string, string | null>();
  for (const name of names) {
    try {
      snapshot.set(name, readFileSync(name, "utf8"));
    } catch {
      snapshot.set(name, null);
    }
  }
  return snapshot;
}

/** Restore a byte snapshot; files absent at snapshot time are removed. */
function restoreUnitFiles(snapshot: Map<string, string | null>): void {
  for (const [path, content] of snapshot) {
    if (content === null) rmSync(path, { force: true });
    else writeFileSync(path, content);
  }
}

/** Delete managed units the failed candidate added: anything matching the
 * managed-unit pattern that the pre-mutation snapshot does not contain.
 * Snapshotted units are restored by restoreUnitFiles; this only removes
 * files the candidate introduced, so rollback cannot leak added units. */
function removeUnitsAddedSince(snapshot: Map<string, string | null>, configRoot: string): void {
  let entries: string[];
  try {
    entries = readdirSync(configRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry !== "kontrol.target" && !/^kontrol-.+\.service$/.test(entry)) continue;
    const full = join(configRoot, entry);
    if (!snapshot.has(full)) rmSync(full, { force: true });
  }
}

/** Member units present before a mutation: managed unit files excluding the
 * core service and the aggregate target (both are reconciled separately). */
function previousMemberUnits(snapshot: Map<string, string | null>, serviceName: string): string[] {
  const members: string[] = [];
  for (const path of snapshot.keys()) {
    const base = path.split("/").at(-1) ?? "";
    if (!/^kontrol-.+\.service$/.test(base) || base === serviceName) continue;
    members.push(base);
  }
  return members.sort();
}

/** Persistent enablement of pre-existing members: true/false when the query
 * succeeds, null when enablement cannot be determined (fail toward
 * re-enabling on rollback, since our members are meant to be enabled). */
function snapshotMemberEnablement(units: string[], dependencies: ServiceCommandDependencies): Map<string, boolean | null> {
  const enablement = new Map<string, boolean | null>();
  for (const unit of units) enablement.set(unit, probeUnitEnabled(unit, dependencies));
  return enablement;
}

function probeUnitEnabled(unit: string, dependencies: ServiceCommandDependencies): boolean | null {
  if (dependencies.probeUnitEnabled) {
    try {
      return dependencies.probeUnitEnabled(unit);
    } catch {
      return null;
    }
  }
  try {
    const result = spawnSync("systemctl", ["--user", "is-enabled", unit], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const state = String(result.stdout ?? "").trim().toLowerCase();
    if (/^(enabled|enabled-runtime|indirect)\b/.test(state)) return true;
    if (/^(disabled|masked)\b/.test(state)) return false;
    if (result.status !== 0 && /^(disabled|masked)\b/.test(state)) return false;
    return null;
  } catch {
    return null;
  }
}

/** Stop a removed member while systemd still knows it; a unit that is
 * already gone is not a failure. Unexpected errors propagate fail-closed. */
function stopManagedUnit(paths: ServicePaths, unit: string, dependencies: ServiceCommandDependencies): void {
  try {
    systemctl(paths, ["stop", unit], dependencies);
  } catch (error) {
    if (/not loaded|could not be found|not-found|no such file/i.test(error instanceof Error ? error.message : String(error))) return;
    throw error;
  }
}

/** Drop a removed member's persistent enablement; missing units are not a
 * failure. Unexpected errors propagate fail-closed. */
function disableManagedUnit(paths: ServicePaths, unit: string, dependencies: ServiceCommandDependencies): void {
  try {
    systemctl(paths, ["disable", unit], dependencies);
  } catch (error) {
    if (/not loaded|could not be found|not-found|no such file/i.test(error instanceof Error ? error.message : String(error))) return;
    throw error;
  }
}

/** Stop obsolete members while systemd still knows them: this must run
 * before their unit files are deleted, or their processes orphan. */
function stopRemovedMembers(paths: ServicePaths, removed: string[], dependencies: ServiceCommandDependencies): void {
  for (const unit of removed) stopManagedUnit(paths, unit, dependencies);
}

/** Drop obsolete members' persistent enablement after their files are gone
 * so no reboot-persistent symlink survives a removal. */
function disableRemovedMembers(paths: ServicePaths, removed: string[], dependencies: ServiceCommandDependencies): void {
  for (const unit of removed) disableManagedUnit(paths, unit, dependencies);
}

/** Prove no obsolete managed member survived: removal must end in a
 * stopped, disabled unit — never a live process behind a deleted file. */
function verifyNoObsoleteSurvivors(removed: string[], dependencies: ServiceCommandDependencies): void {
  const survivors = removed.filter((unit) => probeUnitActive(unit, dependencies));
  if (survivors.length > 0) {
    throw new Error(`removed members still active after stop: ${survivors.join(", ")}`);
  }
}

/** Rollback-side enablement restore: every previously disabled member is
 * disabled again, every previously enabled member is re-enabled, and
 * candidate-added members are disabled. A prior state that could not be
 * determined is conservatively re-enabled (members are meant to be
 * enabled) but reported under `unresolved` — never silently claimed exact. */
function restoreMemberEnablement(
  paths: ServicePaths,
  previousMembers: string[],
  previousEnablement: Map<string, boolean | null>,
  nextMembers: string[],
  dependencies: ServiceCommandDependencies,
): MemberEnablementRestore {
  const summary: MemberEnablementRestore = { disabled: [], enabled: [], unresolved: [] };
  for (const unit of nextMembers) {
    if (previousMembers.includes(unit)) continue;
    disableManagedUnit(paths, unit, dependencies);
    summary.disabled.push(unit);
  }
  const disable: string[] = [];
  const enable: string[] = [];
  for (const unit of previousMembers) {
    const prior = previousEnablement.get(unit);
    if (prior === false) disable.push(unit);
    else {
      enable.push(unit);
      if (prior !== true) summary.unresolved.push(unit);
    }
  }
  for (const unit of disable) {
    disableManagedUnit(paths, unit, dependencies);
    summary.disabled.push(unit);
  }
  if (enable.length > 0) systemctl(paths, ["enable", ...enable], dependencies);
  summary.enabled.push(...enable);
  return summary;
}

export function readServiceBuild(artifactPath: string): ServiceBuild {
  const root = resolve(artifactPath);
  const metadata = readJson<Record<string, unknown>>(join(root, "build-meta.json"));
  if (!metadata || typeof metadata.buildId !== "string" || !metadata.buildId || !existsSync(join(root, "cli.js"))) {
    throw new Error(`Invalid Kontrol release artifact: ${root}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(metadata.buildId)) throw new Error(`Release metadata has an unsafe buildId: ${root}`);
  if (typeof metadata.contentSha256 !== "string" || !/^[a-f0-9]{16,64}$/.test(metadata.contentSha256)) {
    throw new Error(`Release metadata has no valid contentSha256: ${root}`);
  }
  const numberField = (name: string): number => {
    const value = metadata[name];
    if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`Release metadata has invalid ${name}: ${root}`);
    return Number(value);
  };
  const build = {
    artifactPath: root,
    buildId: metadata.buildId,
    contentSha256: metadata.contentSha256,
    schemaVersion: numberField("schemaVersion"),
    minReadableSchemaVersion: numberField("minReadableSchemaVersion"),
    maxReadableSchemaVersion: numberField("maxReadableSchemaVersion"),
  };
  if (build.minReadableSchemaVersion > build.schemaVersion || build.schemaVersion > build.maxReadableSchemaVersion) {
    throw new Error(`Release metadata has incompatible schema bounds: ${root}`);
  }
  return build;
}

function readInstalledState(paths: ServicePaths): InstalledServiceState | undefined {
  const state = readJson<InstalledServiceState>(paths.statePath);
  if (!state) return undefined;
  if (state.serviceName !== paths.serviceName || !state.artifactPath || !state.buildId) {
    throw new Error(`Invalid installed Kontrol service state: ${paths.statePath}`);
  }
  return state;
}

function copyRelease(paths: ServicePaths, build: ServiceBuild): InstalledServiceState & { createdByThisTransaction: boolean } {
  // Verify the source artifact tree before copying: metadata alone is
  // never trusted for installation.
  assertArtifactContent(build.artifactPath);
  mkdirSync(paths.releasesRoot, { recursive: true, mode: 0o700 });
  const destination = join(paths.releasesRoot, build.buildId);
  let createdByThisTransaction = false;
  if (!existsSync(destination)) {
    const temporary = join(paths.releasesRoot, `.install-${build.buildId}-${process.pid}-${randomUUID()}`);
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    try {
      for (const entry of readdirSync(build.artifactPath)) {
        cpSync(join(build.artifactPath, entry), join(temporary, entry), { recursive: true });
      }
      assertArtifactContent(temporary);
      readServiceBuild(temporary);
      renameSync(temporary, destination);
      createdByThisTransaction = true;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  } else {
    assertArtifactContent(destination);
    const installed = readServiceBuild(destination);
    if (installed.buildId !== build.buildId || installed.contentSha256 !== build.contentSha256) {
      throw new Error(`Immutable release identity collision at ${destination}`);
    }
  }
  return {
    ...build,
    artifactPath: destination,
    serviceName: paths.serviceName,
    deploymentId: `systemd-${build.buildId}-${randomUUID()}`,
    installedAt: new Date().toISOString(),
    createdByThisTransaction,
  };
}

function systemdQuote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("systemd values cannot contain newlines");
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\t", "\\t")}"`;
}

// ── P1.9: auxiliary component units + kontrol.target ────
// The core unit owns only the MCP core. When the operator configures adapters
// or the tunnel via config.json `serviceComponents`, `kontrol service install`
// also emits one unit per component (kontrol-<name>.service) and a
// kontrol.target that groups them, each with an independent restart policy and
// journal identity. With no components configured the documented core-only
// production scope is unchanged.

/** Deterministic systemd unit name for an auxiliary component. */
export function componentServiceName(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(name)) {
    throw new Error(`Invalid service component name: ${JSON.stringify(name)}. Use lowercase letters, digits, and dashes (max 39 chars).`);
  }
  return `kontrol-${name}.service`;
}

// ── Tunnel reviewer-auth wiring ───
// scripts/kontrol-tunnel.sh asserts reviewer authority with `--mcp.extra-headers
// "X-Kontrol-Tunnel-Reviewer: env:KONTROL_TUNNEL_REVIEWER_SECRET"`, resolving
// KONTROL_TUNNEL_REVIEWER_SECRET from the dedicated variable, the legacy
// KONTROL_ACP_REVIEWER_SECRET, or the 0600 auth file. Systemd tunnel
// components must carry the same assertion: without it the tunnel's MCP
// sessions arrive as unauthenticated `client` and reviewer-only tools
// (approval center, session surface) are denied. The secret VALUE never
// enters the unit file or command line — tunnel-client resolves the `env:`
// reference from its own environment (the service EnvironmentFile) at
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

function validateServiceComponents(components: unknown): KontrolServiceComponent[] {
  if (components === undefined) return [];
  if (!Array.isArray(components)) throw new Error("serviceComponents must be an array.");
  const seen = new Set<string>();
  return components.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("serviceComponents entries must be objects.");
    const entry = raw as Partial<KontrolServiceComponent>;
    if (entry.kind !== "adapter" && entry.kind !== "tunnel") {
      throw new Error(`serviceComponents[].kind must be "adapter" or "tunnel".`);
    }
    const name = entry.name;
    componentServiceName(name ?? "");
    if (seen.has(name!)) throw new Error(`Duplicate service component name: ${name}`);
    seen.add(name!);
    if (!Array.isArray(entry.command) || entry.command.length === 0 || entry.command.some((part) => typeof part !== "string" || !part)) {
      throw new Error(`serviceComponents[${name}].command must be a nonempty array of argv strings.`);
    }
    if (entry.command[0].includes("/") || entry.command[0] === "sudo" || entry.command[0] === "sh" || entry.command[0] === "bash") {
      throw new Error(`serviceComponents[${name}].command must start with a plain executable name resolved from PATH (no shell wrappers, no absolute paths).`);
    }
    if (entry.port !== undefined && (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535)) {
      throw new Error(`serviceComponents[${name}].port must be a TCP port number.`);
    }
    return { name: name!, kind: entry.kind, command: entry.command, ...(entry.port !== undefined ? { port: entry.port } : {}) };
  });
}

/** Read the operator-configured auxiliary components (validated). */
export function readServiceComponents(env: NodeJS.ProcessEnv = process.env): KontrolServiceComponent[] {
  const files = loadKontrolFiles(env);
  return validateServiceComponents(files.config.serviceComponents);
}

/**
 * Render one auxiliary component unit. Tunnel components always carry the
 * reviewer-assertion header (auto-appended when absent, never duplicated);
 * adapter commands pass through verbatim.
 */
export function renderServiceComponentUnit(component: KontrolServiceComponent, options: {
  artifactPath: string;
  buildId: string;
  environmentFile: string;
  workingDirectory: string;
}): string {
  const command = component.kind === "tunnel" ? withTunnelReviewerAuth(component.command) : component.command;
  return renderComponentServiceUnit({
    serviceName: componentServiceName(component.name),
    kind: component.kind,
    description: component.kind === "tunnel"
      ? `Kontrol Secure MCP Tunnel (${component.name})`
      : `Kontrol ACP adapter (${component.name})`,
    command,
    artifactPath: options.artifactPath,
    buildId: options.buildId,
    environmentFile: options.environmentFile,
    workingDirectory: options.workingDirectory,
  });
}

export function renderComponentServiceUnit(options: {
  serviceName: string;
  description: string;
  command: string[];
  kind: "adapter" | "tunnel";
  artifactPath: string;
  buildId: string;
  environmentFile: string;
  workingDirectory: string;
}): string {
  const execArgs = options.command.map((part) => {
    // "@ARTIFACT" (as its own argv element or a prefix) stands in for the
    // installed immutable release directory.
    const substituted = part.replaceAll("@ARTIFACT", options.artifactPath);
    return /[\s"]/.test(substituted) ? systemdQuote(substituted) : substituted;
  }).join(" ");
  const artifactCli = join(options.artifactPath, "cli.js");
  // Tunnel-only startup gate: After= orders the tunnel after the core unit,
  // but ordering is not readiness — without this gate a slow or restarting
  // core makes the tunnel's single initial MCP probe fail, permanently
  // disabling its channel (tunnel-client never re-probes). The gate fails
  // closed within a finite timeout so systemd records a failed start and
  // retries under the unit's existing burst limits instead of running a
  // permanently degraded tunnel. Adapters manage their own startup and are
  // intentionally not gated here.
  const startupGate = options.kind === "tunnel"
    ? [`ExecStartPre=/usr/bin/env node ${systemdQuote(artifactCli)} service wait-core-ready --timeout-ms ${TUNNEL_CORE_WAIT_TIMEOUT_MS}`]
    : [];
  return [
    "[Unit]",
    `Description=${options.description}`,
    "PartOf=kontrol.target",
    "After=kontrol-core.service",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    // Bare paths: systemd 249 on the supported host rejects quoted
    // WorkingDirectory and EnvironmentFile paths as "not absolute"
    // (EnvironmentFile is silently ignored when quoted, so the service
    // then starts without its environment). Environment= assignments and
    // ExecStart arguments are not path directives and stay quoted.
    `WorkingDirectory=${options.workingDirectory}`,
    `EnvironmentFile=${options.environmentFile}`,
    `Environment=${systemdQuote(`KONTROL_LAUNCHER=systemd`)}`,
    `Environment=${systemdQuote(`KONTROL_EXPECTED_BUILD_ID=${options.buildId}`)}`,
    ...startupGate,
    `ExecStart=/usr/bin/env ${execArgs}`,
    "Restart=on-failure",
    "RestartSec=5",
    "KillMode=control-group",
    "",
    "[Install]",
    "WantedBy=kontrol.target",
    "",
  ].join("\n");
}

/**
 * Render the aggregate target from the single lifecycle component manifest.
 * Every member starts with the target (Wants) and stops with it (each
 * member carries PartOf=kontrol.target); the core is additionally Required
 * so a dead core fails the aggregate instead of reporting a healthy stack.
 * The core also carries PartOf=kontrol.target so stopping the target drains
 * the whole stack, which the lifecycle stop verification requires (a target
 * stop alone never stops a Wants-only unit). Shutdown propagation relies on
 * PartOf, not on BindsTo here, so an auxiliary failure degrades the stack
 * without killing the core.
 */
export function renderKontrolTargetUnit(memberUnits: string[], coreUnit: string): string {
  const wanted = [...new Set([coreUnit, ...memberUnits])];
  return [
    "[Unit]",
    "Description=Kontrol control plane (core + configured adapters/tunnel)",
    `Wants=${wanted.join(" ")}`,
    `Requires=${coreUnit}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderUserServiceUnit(options: {
  serviceName: string;
  artifactPath: string;
  buildId: string;
  schemaVersion: number;
  maxReadableSchemaVersion: number;
  deploymentId: string;
  stateDir: string;
  environmentFile: string;
  workingDirectory: string;
}): string {
  const artifactCli = join(options.artifactPath, "cli.js");
  return [
    "[Unit]",
    "Description=Kontrol local MCP core",
    "PartOf=kontrol.target",
    "After=default.target",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    // Bare paths: systemd 249 on the supported host rejects quoted
    // WorkingDirectory and EnvironmentFile paths as "not absolute"
    // (EnvironmentFile is silently ignored when quoted, so the service
    // then starts without its environment). Environment= assignments and
    // ExecStart arguments are not path directives and stay quoted.
    `WorkingDirectory=${options.workingDirectory}`,
    `EnvironmentFile=${options.environmentFile}`,
    `Environment=${systemdQuote("KONTROL_LAUNCHER=systemd")}`,
    `Environment=${systemdQuote(`KONTROL_EXPECTED_BUILD_ID=${options.buildId}`)}`,
    `Environment=${systemdQuote(`KONTROL_EXPECTED_SCHEMA_VERSION=${options.schemaVersion}`)}`,
    `Environment=${systemdQuote(`KONTROL_EXPECTED_MAX_SCHEMA_VERSION=${options.maxReadableSchemaVersion}`)}`,
    `Environment=${systemdQuote(`KONTROL_DEPLOYMENT_ID=${options.deploymentId}`)}`,
    `Environment=${systemdQuote(`KONTROL_ARTIFACT_PATH=${options.artifactPath}`)}`,
    `Environment=${systemdQuote(`KONTROL_STATE_DIR=${options.stateDir}`)}`,
    `ExecStart=/usr/bin/env node ${systemdQuote(artifactCli)} serve`,
    "Restart=on-failure",
    // Permanent configuration failures (schema/build incompatibility exits
    // 78 via the CLI classifier) must not be retried: retrying burns the
    // start budget and masks the operator action required.
    `RestartPreventExitStatus=${SCHEMA_INCOMPATIBLE_EXIT_CODE}`,
    "RestartSec=5",
    "KillMode=control-group",
    "Nice=0",
    "CPUWeight=100",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function writeUnit(paths: ServicePaths, state: InstalledServiceState, components: KontrolServiceComponent[] = []): void {
  writeJsonAtomic(paths.statePath, state);
  const unit = renderUserServiceUnit({
    ...state,
    stateDir: paths.stateDir,
    environmentFile: paths.environmentFile,
    workingDirectory: paths.dataRoot,
  });
  mkdirSync(dirname(paths.unitPath), { recursive: true, mode: 0o700 });
  const temporary = `${paths.unitPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, unit, { mode: 0o644 });
    renameSync(temporary, paths.unitPath);
  } finally {
    rmSync(temporary, { force: true });
  }
  // P1.9: auxiliary component units + the grouping target. Units removed from
  // the configuration are deleted so the installed unit set matches exactly.
  const configRoot = dirname(paths.unitPath);
  mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  const activeNames = new Set<string>([paths.serviceName]);
  for (const component of components) {
    const name = componentServiceName(component.name);
    activeNames.add(name);
    const unitText = renderServiceComponentUnit(component, {
      artifactPath: state.artifactPath,
      buildId: state.buildId,
      environmentFile: paths.environmentFile,
      workingDirectory: paths.dataRoot,
    });
    const componentTemp = `${join(configRoot, name)}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(componentTemp, unitText, { mode: 0o644 });
      renameSync(componentTemp, join(configRoot, name));
    } finally {
      rmSync(componentTemp, { force: true });
    }
  }
  // The target graph is generated from the same lifecycle manifest both
  // backends enumerate, so deployed units can never drift from the source.
  const manifest = buildLifecycleManifest({ coreServiceName: paths.serviceName, components });
  const targetText = renderKontrolTargetUnit(manifest.filter((c) => c.name !== "core").map((c) => c.systemdUnit), paths.serviceName);
  const targetTemp = `${join(configRoot, "kontrol.target")}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(targetTemp, targetText, { mode: 0o644 });
    renameSync(targetTemp, join(configRoot, "kontrol.target"));
  } finally {
    rmSync(targetTemp, { force: true });
  }
  for (const entry of readdirSync(configRoot)) {
    if (!/^kontrol-.+\.service$/.test(entry)) continue;
    if (activeNames.has(entry)) continue;
    rmSync(join(configRoot, entry), { force: true });
  }
}

function systemctl(paths: ServicePaths, args: string[], dependencies: ServiceCommandDependencies): void {
  if (dependencies.systemctl) return dependencies.systemctl(paths, args);
  const result = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
}

function requireSystemd(dependencies: ServiceCommandDependencies): void {
  if (dependencies.requireSystemd) return dependencies.requireSystemd();
  if (process.platform !== "linux") throw new Error("Kontrol service lifecycle is supported on Linux with a systemd user service only.");
  const probe = spawnSync("systemctl", ["--version"], { stdio: "ignore" });
  if (probe.status !== 0) throw new Error("systemctl is required for the Kontrol user service.");
}

async function waitForReady(paths: ServicePaths, expected: InstalledServiceState): Promise<void> {
  const endpoint = `http://127.0.0.1:${readInstalledPort(paths)}/core-readyz`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const body = await response.json() as { ok?: boolean };
        const identity = readJson<{ buildId?: string; artifactPath?: string; generationId?: string }>(join(paths.stateDir, "server.identity.json"));
        const lock = readJson<{ buildId?: string; artifactPath?: string; generationId?: string }>(join(paths.stateDir, "runtime.lock"));
        if (body.ok === true && identity?.buildId === expected.buildId && identity.artifactPath === expected.artifactPath && identity.generationId && lock?.buildId === expected.buildId && lock.artifactPath === expected.artifactPath && lock.generationId === identity.generationId) return;
      }
    } catch {
      // The unit may still be binding or restarting; keep the bounded probe.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Kontrol build ${expected.buildId} did not become ready as the exact installed artifact`);
}

async function withDeploymentLock<T>(paths: ServicePaths, operation: DeploymentRecord["operation"], action: (lock: DeploymentLockHandle, deploymentId: string) => Promise<T>): Promise<T> {
  const deploymentId = `systemd-${operation}-${Date.now()}-${process.pid}-${randomUUID()}`;
  const lock = await acquireDeploymentLock(paths.stateDir, { operation: `systemd-${operation}`, deploymentId, pid: process.pid });
  try {
    return await action(lock, deploymentId);
  } finally {
    await releaseDeploymentLock(paths.stateDir, lock.record.token);
  }
}

function makeRecord(deploymentId: string, operation: DeploymentRecord["operation"], previous?: InstalledServiceState, candidate?: InstalledServiceState): DeploymentRecord {
  return { deploymentId, operation, stage: "prepare", ...(previous ? { previous } : {}), ...(candidate ? { candidate } : {}), updatedAt: new Date().toISOString() };
}

async function install(paths: ServicePaths, dependencies: ServiceCommandDependencies, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  requireSystemd(dependencies);
  await withDeploymentLock(paths, "install", async (_lock, deploymentId) => {
    const build = readServiceBuild(dependencies.currentArtifactPath?.() ?? compiledArtifactPath());
    const components = readServiceComponents(env);
    requireTunnelReviewerWiring(components, env);
    // Pre-mutation gates first: candidate/database compatibility is decided
    // before any byte changes. Only then may the environment file be
    // touched, and its prior state is snapshotted so any later failure
    // restores it byte-for-byte.
    preflightCandidateAgainstLiveDatabase(paths, build);
    const environmentSnapshot = snapshotFile(paths.environmentFile);
    const unitSnapshot = snapshotUnitFiles(paths);
    const previousMembers = previousMemberUnits(unitSnapshot, paths.serviceName);
    const previousEnablement = snapshotMemberEnablement(previousMembers, dependencies);
    const nextMembers = components.map((component) => componentServiceName(component.name));
    const removedMembers = previousMembers.filter((unit) => !nextMembers.includes(unit));
    try {
      materializeTunnelReviewerSecret(components, env, paths.environmentFile);
      requireServiceEnvironmentFile(paths);
      const state = { ...copyRelease(paths, build), deploymentId, serviceComponents: components };
      const record = makeRecord(deploymentId, "install", undefined, state);
      writeDeploymentRecord(paths, record);
      try {
        // Stop obsolete members while systemd still knows them; their files
        // are deleted by writeUnit below.
        stopRemovedMembers(paths, removedMembers, dependencies);
        writeUnit(paths, state, components);
        systemctl(paths, ["daemon-reload"], dependencies);
        disableRemovedMembers(paths, removedMembers, dependencies);
        updateDeploymentRecord(paths, record, { stage: "commit" });
      } catch (error) {
        // Best-effort cleanup of this install's own artifacts: only a
        // release directory THIS transaction created is deleted; a
        // pre-existing installed release (even for the same build) is
        // never removed, and units this install added are deleted,
        // while pre-existing units are restored. The deployment journal
        // keeps the failure for audit.
        try {
          if (state.createdByThisTransaction) {
            rmSync(state.artifactPath, { recursive: true, force: true });
          }
        } catch {
          // Leave the orphaned copy rather than masking the original error.
        }
        restoreUnitFiles(unitSnapshot);
        removeUnitsAddedSince(unitSnapshot, dirname(paths.unitPath));
        try {
          const memberRestore = restoreMemberEnablement(paths, previousMembers, previousEnablement, nextMembers, dependencies);
          if (memberRestore.unresolved.length > 0) {
            throw new Error(`member enablement unresolved for: ${memberRestore.unresolved.join(", ")}`);
          }
        } catch (cleanupError) {
          const reason = error instanceof Error ? error.message : String(error);
          const cleanupReason = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          throw new Error(`${reason}; member enablement restore also failed: ${cleanupReason}`);
        }
        throw error;
      }
    } catch (error) {
      restoreFileSnapshot(paths.environmentFile, environmentSnapshot);
      throw error;
    }
  });
}

async function activate(paths: ServicePaths, operation: "start" | "stop" | "restart", dependencies: ServiceCommandDependencies, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  requireSystemd(dependencies);
  const installed = readInstalledState(paths);
  if (!installed) throw new Error(`No installed Kontrol service at ${paths.statePath}; run \`kontrol service install\` first.`);
  await withDeploymentLock(paths, operation, async (_lock, deploymentId) => {
    const record = makeRecord(deploymentId, operation, installed, installed);
    writeDeploymentRecord(paths, record);
    // All three operations address the aggregate target so the complete
    // configured stack — core plus every configured auxiliary unit —
    // starts and stops together, never just the core.
    if (operation === "stop") {
      systemctl(paths, ["stop", "kontrol.target"], dependencies);
      const components = readServiceComponents(env);
      await verifyStackStopped(buildLifecycleManifest({ coreServiceName: paths.serviceName, components }), dependencies);
    } else {
      // Refuse to (re)start a build that cannot read the live database
      // instead of launching another doomed start loop.
      preflightCandidateAgainstLiveDatabase(paths, installed);
      requireServiceEnvironmentFile(paths);
      const components = readServiceComponents(env);
      const manifest = buildLifecycleManifest({ coreServiceName: paths.serviceName, components });
      // Persist every member so a reboot restores the same aggregate stack,
      // then start the target; members are pulled up through Wants.
      const members = manifest.map((c) => c.systemdUnit).filter((unit) => unit !== paths.serviceName);
      if (members.length > 0) systemctl(paths, ["enable", ...members], dependencies);
      if (operation === "start") systemctl(paths, ["enable", "--now", "kontrol.target"], dependencies);
      else systemctl(paths, ["restart", "kontrol.target"], dependencies);
      await (dependencies.waitForReady?.(paths, installed) ?? waitForReady(paths, installed));
      verifyAuxiliariesActive(manifest, dependencies);
    }
    updateDeploymentRecord(paths, record, { stage: "commit" });
  });
}

/**
 * Active-state probe for one systemd unit. Injectable for hermetic tests;
 * the default shells to `systemctl --user is-active --quiet`.
 */
function probeUnitActive(unit: string, dependencies: ServiceCommandDependencies): boolean {
  if (dependencies.probeUnitActive) return dependencies.probeUnitActive(unit);
  const result = spawnSync("systemctl", ["--user", "is-active", "--quiet", unit], { stdio: "ignore" });
  return result.status === 0;
}

/** Units that must be quiet after a stack stop: every member plus the target. */
function stackStopScope(manifest: { systemdUnit: string }[]): string[] {
  return [...manifest.map((c) => c.systemdUnit), "kontrol.target"];
}

/** Throw when any owned unit survived a stack stop; success means gone. */
/**
 * Bounded stop verification: stopping the target only starts the drain
 * (PartOf units exit asynchronously; the core takes ~0.5s with a live
 * session attached), so poll briefly instead of failing on the first probe
 * while a unit is still deactivating. A unit that never drains still fails.
 */
async function verifyStackStopped(manifest: { systemdUnit: string }[], dependencies: ServiceCommandDependencies, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const survivors = stackStopScope(manifest).filter((unit) => probeUnitActive(unit, dependencies));
    if (survivors.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`stop did not fully shut down the owned stack; still active: ${survivors.join(", ")}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

/**
 * Throw when a required auxiliary failed to reach active state after a
 * stack start. The core itself is verified separately by waitForReady;
 * every other required member must be systemd-active here.
 */
function verifyAuxiliariesActive(
  manifest: { name: string; systemdUnit: string; required: boolean }[],
  dependencies: ServiceCommandDependencies,
): void {
  const missing = manifest
    .filter((c) => c.name !== "core" && c.required && !probeUnitActive(c.systemdUnit, dependencies))
    .map((c) => c.systemdUnit);
  if (missing.length > 0) {
    throw new Error(`required auxiliaries did not reach active state: ${missing.join(", ")}`);
  }
}

export type UnitProbeState = "active" | "failed" | "inactive" | "unknown";

/** Full unit-state probe; injectable for hermetic tests. */
function defaultProbeUnit(unit: string): UnitProbeState {
  if (spawnSync("systemctl", ["--user", "is-active", "--quiet", unit], { stdio: "ignore" }).status === 0) return "active";
  if (spawnSync("systemctl", ["--user", "is-failed", "--quiet", unit], { stdio: "ignore" }).status === 0) return "failed";
  const show = spawnSync("systemctl", ["--user", "show", "-p", "LoadState", "--value", unit], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (show.status === 0 && String(show.stdout ?? "").trim() === "loaded") return "inactive";
  return "unknown";
}

export type InstalledPortSource = "configured" | "default-missing" | "default-malformed";

export interface InstalledPort {
  port: number;
  source: InstalledPortSource;
  /** Raw PORT assignment when present, for diagnostics (never a secret). */
  raw?: string;
}

export const DEFAULT_SERVICE_PORT = 7676;

/** Default tunnel-client health/admin port (tunnel-client's own default). */
export const DEFAULT_TUNNEL_HEALTH_PORT = 8080;

/**
 * Default bound for the tunnel startup gate: long enough for a slow core
 * (migrations, cold start) while fitting inside systemd's default 90s
 * start timeout so an overrun fails closed instead of hanging the stack.
 */
export const TUNNEL_CORE_WAIT_TIMEOUT_MS = 60_000;

/**
 * Readiness probe port from the installed service environment, never from
 * the invoking CLI process environment: the installed unit and the probe
 * must agree on the port or readiness checks the wrong endpoint. The
 * source is reported explicitly so callers never silently treat a
 * malformed or missing PORT as a healthy configured value.
 */
export function describeInstalledPort(paths: ServicePaths): InstalledPort {
  try {
    for (const line of readFileSync(paths.environmentFile, "utf8").split("\n")) {
      const match = line.match(/^\s*(?:export\s+)?PORT\s*=\s*"?([^"\s]+)"?\s*$/);
      if (match) {
        const port = Number(match[1]);
        if (Number.isInteger(port) && port >= 1 && port <= 65535) {
          return { port, source: "configured", raw: match[1] };
        }
        return { port: DEFAULT_SERVICE_PORT, source: "default-malformed", raw: match[1] };
      }
    }
  } catch {
    // Missing/unreadable environment falls back to the default port.
  }
  return { port: DEFAULT_SERVICE_PORT, source: "default-missing" };
}

/** Numeric port for readiness probes; see describeInstalledPort for provenance. */
export function readInstalledPort(paths: ServicePaths): number {
  return describeInstalledPort(paths).port;
}

/**
 * Functional reachability check for one auxiliary component endpoint. A
 * systemd-active unit that accepts no connections is degraded, not ready:
 * this is the independent functional signal behind the aggregate verdict.
 */
function probeComponentEndpoint(_name: string, port: number, timeoutMs = 1500): Promise<{ reachable: boolean; detail?: string }> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      resolve({ reachable: true });
    });
    const fail = (detail: string) => {
      socket.destroy();
      resolve({ reachable: false, detail });
    };
    socket.once("timeout", () => fail("connection timed out"));
    socket.once("error", (error) => fail(error instanceof Error ? error.message : String(error)));
  });
}

export interface CoreReadyWaitOptions {
  /** Directory holding server.identity.json (the core's live identity). */
  stateDir: string;
  /** Installed core HTTP port. */
  port: number;
  /** Expected deployed core build; identity mismatch fails closed when set. */
  expectedBuildId?: string;
  /** Expected artifact path; checked alongside the build id when set. */
  expectedArtifactPath?: string;
  /** Finite bound; never blocks indefinitely. */
  timeoutMs?: number;
  /** Delay between probes. */
  intervalMs?: number;
  /** Per-attempt HTTP timeout. */
  attemptTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Bounded startup gate for the tunnel: waits for the core to answer
 * /core-readyz with HTTP 200 + ok=true and (when expected identity is
 * given) the exact deployed build. Ordering (After=) is not readiness —
 * this is what stops the tunnel's single initial MCP probe from racing a
 * still-starting core. Throws a descriptive error on timeout; never blocks
 * indefinitely.
 */
export async function waitForCoreReady(options: CoreReadyWaitOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? TUNNEL_CORE_WAIT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 500;
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `http://127.0.0.1:${options.port}/core-readyz`;
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "no attempts made";
  for (;;) {
    try {
      const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(options.attemptTimeoutMs ?? 2_000) });
      if (response.ok) {
        const body = await response.json() as { ok?: boolean };
        if (body.ok === true) {
          if (options.expectedBuildId === undefined) return;
          const identity = readJson<{ buildId?: string; artifactPath?: string }>(join(options.stateDir, "server.identity.json"));
          if (identity?.buildId === options.expectedBuildId
            && (options.expectedArtifactPath === undefined || identity.artifactPath === options.expectedArtifactPath)) return;
          lastDetail = `core is ready but live identity ${identity?.buildId ?? "unknown"} does not match expected ${options.expectedBuildId}`;
        } else {
          lastDetail = "core answered but ok !== true";
        }
      } else {
        lastDetail = `core answered HTTP ${response.status}`;
      }
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      throw new Error(`core was not ready within ${timeoutMs}ms (GET ${endpoint}): ${lastDetail}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

export interface TunnelChannelState {
  /** The tunnel health endpoint answered. */
  reachable: boolean;
  /** The main MCP channel is enabled with a non-failed probe. */
  operational?: boolean;
  /** Raw main-channel enabled flag, when observed. */
  mainEnabled?: boolean;
  /** Raw main-channel probe status, when observed. */
  probeStatus?: string;
  /** Human-readable detail for verdicts and diagnostics (no secrets). */
  detail?: string;
}

/**
 * Application-level tunnel probe: unlike a TCP connect (process alive) or
 * systemd state, this reports whether the main MCP channel is actually
 * operational. A process-alive tunnel with a disabled channel is the exact
 * failure mode Restart=on-failure cannot see.
 */
export async function probeTunnelChannel(
  healthPort: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2_000,
): Promise<TunnelChannelState> {
  const endpoint = `http://127.0.0.1:${healthPort}/api/status`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { reachable: false, detail: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) return { reachable: false, detail: `health endpoint answered HTTP ${response.status}` };
  let body: { channels?: Array<{ name?: string; enabled?: boolean; probe_status?: string; probe_error?: string; reason?: string }> };
  try {
    body = await response.json() as typeof body;
  } catch {
    return { reachable: true, operational: false, detail: "health endpoint answered but /api/status is not JSON" };
  }
  const main = Array.isArray(body.channels) ? body.channels.find((channel) => channel?.name === "main") : undefined;
  if (!main) return { reachable: true, operational: false, detail: "no main channel in /api/status" };
  const operational = main.enabled === true && main.probe_status !== "failed";
  const detail = operational
    ? `main channel enabled (probe ${main.probe_status ?? "unknown"})`
    : `main.enabled=${String(main.enabled)} probe_status=${main.probe_status ?? "unknown"}${main.probe_error ? ` probe_error=${main.probe_error.slice(0, 200)}` : ""}${main.reason ? ` reason=${main.reason.slice(0, 200)}` : ""}`;
  return {
    reachable: true,
    operational,
    ...(main.enabled !== undefined ? { mainEnabled: main.enabled } : {}),
    ...(main.probe_status !== undefined ? { probeStatus: main.probe_status } : {}),
    detail,
  };
}

/** Bounded core-readiness check against the installed endpoint + identity. */
async function probeCoreReady(paths: ServicePaths, installed: InstalledServiceState): Promise<boolean> {
  const endpoint = `http://127.0.0.1:${readInstalledPort(paths)}/core-readyz`;
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean };
    if (body.ok !== true) return false;
    const identity = readJson<{ buildId?: string; artifactPath?: string }>(join(paths.stateDir, "server.identity.json"));
    return identity?.buildId === installed.buildId && identity?.artifactPath === installed.artifactPath;
  } catch {
    return false;
  }
}

/**
 * Rebuild the previous component manifest from the unit snapshot so
 * rollback verification checks exactly the units that were restored —
 * even when the candidate added or removed component units.
 */
function manifestFromUnitSnapshot(paths: ServicePaths, unitSnapshot: Map<string, string | null>): { name: string; systemdUnit: string; required: boolean }[] {
  const specs: { name: string; systemdUnit: string; required: boolean }[] = [{
    name: "core",
    systemdUnit: paths.serviceName,
    required: true,
  }];
  for (const path of unitSnapshot.keys()) {
    if (path === paths.unitPath || unitSnapshot.get(path) === null) continue;
    const base = path.endsWith("/kontrol.target") || path === "kontrol.target" ? "kontrol.target" : path.split("/").at(-1) ?? "";
    if (base === "kontrol.target" || !/^kontrol-.+\.service$/.test(base)) continue;
    specs.push({ name: base.replace(/^kontrol-/, "").replace(/\.service$/, ""), systemdUnit: base, required: true });
  }
  return specs;
}

async function upgrade(paths: ServicePaths, dependencies: ServiceCommandDependencies, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  requireSystemd(dependencies);
  const previous = readInstalledState(paths);
  if (!previous) throw new Error(`No installed Kontrol service at ${paths.statePath}; run \`kontrol service install\` first.`);
  await withDeploymentLock(paths, "upgrade", async (_lock, deploymentId) => {
    const build = readServiceBuild(dependencies.currentArtifactPath?.() ?? compiledArtifactPath());
    const upgradeComponents = readServiceComponents(env);
    requireTunnelReviewerWiring(upgradeComponents, env);
    // Gates before mutation: a rejected candidate leaves no trace.
    preflightCandidateAgainstLiveDatabase(paths, build);
    // Live schema baseline for rollback: the database restore is required
    // only when this deployment itself raised the schema past what it
    // found. An already-newer database (migrated out-of-band) is left
    // untouched — there is nothing this deployment did to undo.
    const preMutationInspection = inspectLiveDatabase(paths.stateDir);
    const preMutationLiveSchema = preMutationInspection.status === "ok" ? preMutationInspection.schemaVersion : undefined;
    // Snapshots before mutation: unit files, installed state, the
    // environment file, and member enablement are all restored on failure.
    const unitSnapshot = snapshotUnitFiles(paths);
    const environmentSnapshot = snapshotFile(paths.environmentFile);
    const previousMembers = previousMemberUnits(unitSnapshot, paths.serviceName);
    const previousEnablement = snapshotMemberEnablement(previousMembers, dependencies);
    let candidate: InstalledServiceState;
    try {
      materializeTunnelReviewerSecret(upgradeComponents, env, paths.environmentFile);
      requireServiceEnvironmentFile(paths);
      candidate = { ...copyRelease(paths, build), deploymentId, serviceComponents: upgradeComponents };
    } catch (error) {
      restoreFileSnapshot(paths.environmentFile, environmentSnapshot);
      throw error;
    }
    const manifest = buildLifecycleManifest({ coreServiceName: paths.serviceName, components: upgradeComponents });
    const members = manifest.map((c) => c.systemdUnit).filter((unit) => unit !== paths.serviceName);
    const removedMembers = previousMembers.filter((unit) => !members.includes(unit));
    let record = makeRecord(deploymentId, "upgrade", previous, candidate);
    writeDeploymentRecord(paths, record);
    record = updateDeploymentRecord(paths, record, { stage: "prepared" });
    try {
      // Reconcile the full configured stack: obsolete members are stopped
      // while systemd still knows them, then added components gain units,
      // removed ones lose their files and enablement, and everything new
      // is enabled persistently before activation.
      stopRemovedMembers(paths, removedMembers, dependencies);
      writeUnit(paths, candidate, upgradeComponents);
      systemctl(paths, ["daemon-reload"], dependencies);
      disableRemovedMembers(paths, removedMembers, dependencies);
      if (members.length > 0) systemctl(paths, ["enable", ...members], dependencies);
      record = updateDeploymentRecord(paths, record, { stage: "stop" });
      systemctl(paths, ["stop", "kontrol.target"], dependencies);
      await verifyStackStopped(manifest, dependencies);
      // No obsolete managed member may survive: removal ends stopped.
      verifyNoObsoleteSurvivors(removedMembers, dependencies);
      record = updateDeploymentRecord(paths, record, { stage: "activate" });
      systemctl(paths, ["enable", "--now", "kontrol.target"], dependencies);
      await (dependencies.waitForReady?.(paths, candidate) ?? waitForReady(paths, candidate));
      verifyAuxiliariesActive(manifest, dependencies);
      // The rollback window ends only after the candidate is ready, the
      // deployment transaction has durably committed, and the live schema
      // still matches it. Rollback authority is preserved through every
      // pre-commit failure path: closing the window before the commit
      // write would leave a failed commit unrecoverable. An unverifiable
      // close fails retentive (backup stays protected), never additive.
      updateDeploymentRecord(paths, record, { stage: "commit" });
      try {
        markMigrationRollbackWindowComplete(paths.stateDir, deploymentId);
      } catch {
        // Fail-retain: an unverifiable window keeps its backup protected.
      }
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      record = updateDeploymentRecord(paths, record, { stage: "rollback", error: reason });
      try {
        // Do not touch the live database until systemd confirms that the
        // candidate stack is stopped and no longer owns the runtime lock.
        systemctl(paths, ["stop", "kontrol.target"], dependencies);
        await verifyStackStopped(manifest, dependencies);
        const databaseRestore = restoreDeploymentDatabaseBackup({
          stateDir: paths.stateDir,
          deploymentId,
          maxReadableSchemaVersion: previous.maxReadableSchemaVersion,
          expectedOriginalSchemaVersion: preMutationLiveSchema ?? previous.schemaVersion,
          preMutationSchemaVersion: preMutationLiveSchema,
        });
        record = updateDeploymentRecord(paths, record, { databaseRestore });
        restoreUnitFiles(unitSnapshot);
        removeUnitsAddedSince(unitSnapshot, dirname(paths.unitPath));
        restoreFileSnapshot(paths.environmentFile, environmentSnapshot);
        // Restore prior membership and enablement: candidate-added members
        // are disabled, restored members regain their exact prior state.
        // Anything unresolvable is recorded in the journal, never silent.
        const memberRestore = restoreMemberEnablement(paths, previousMembers, previousEnablement, members, dependencies);
        record = updateDeploymentRecord(paths, record, { memberRestore });
        systemctl(paths, ["daemon-reload"], dependencies);
        systemctl(paths, ["enable", "--now", "kontrol.target"], dependencies);
        await (dependencies.waitForReady?.(paths, previous) ?? waitForReady(paths, previous));
        verifyAuxiliariesActive(manifestFromUnitSnapshot(paths, unitSnapshot), dependencies);
        updateDeploymentRecord(paths, record, { stage: "commit" });
      } catch (rollbackError) {
        const rollbackReason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        updateDeploymentRecord(paths, record, { stage: "rollback_failed", error: `${reason}; rollback: ${rollbackReason}` });
        throw new Error(`Candidate ${candidate.buildId} failed readiness and rollback was not verified: ${rollbackReason}`);
      }
      throw new Error(`Candidate ${candidate.buildId} failed readiness; previous build ${previous.buildId} and database were restored (cause: ${reason}).`);
    }
  });
}

async function uninstall(paths: ServicePaths, dependencies: ServiceCommandDependencies): Promise<void> {
  requireSystemd(dependencies);
  await withDeploymentLock(paths, "uninstall", async (_lock, deploymentId) => {
    const record = makeRecord(deploymentId, "uninstall", readInstalledState(paths));
    writeDeploymentRecord(paths, record);
    try { systemctl(paths, ["disable", "--now", paths.serviceName], dependencies); } catch { /* already stopped/disabled */ }
    rmSync(paths.unitPath, { force: true });
    // P1.9: drop the component units and the grouping target as well.
    try {
      systemctl(paths, ["stop", "kontrol.target"], dependencies);
    } catch { /* target may not exist */ }
    const configRoot = dirname(paths.unitPath);
    try {
      for (const entry of readdirSync(configRoot)) {
        if (entry === "kontrol.target" || /^kontrol-.+\.service$/.test(entry)) {
          rmSync(join(configRoot, entry), { force: true });
        }
      }
    } catch { /* config root may not exist */ }
    rmSync(paths.statePath, { force: true });
    systemctl(paths, ["daemon-reload"], dependencies);
    updateDeploymentRecord(paths, record, { stage: "commit" });
  });
}

/**
 * Window and budget for tunnel recovery attempts. Restarts are the only
 * mutation and each one is journaled; once the budget is spent inside the
 * window, recovery refuses to act until an attempt ages out or a healthy
 * probe clears the journal. This bounds the worst case to 3 restarts per
 * 15 minutes no matter how often the command is invoked.
 */
export const TUNNEL_RECOVERY_WINDOW_MS = 15 * 60_000;
export const TUNNEL_RECOVERY_MAX_ATTEMPTS = 3;
export const TUNNEL_RECOVERY_SETTLE_TIMEOUT_MS = 30_000;

export type TunnelRecoverOutcome = "already-operational" | "recovered" | "core-not-ready";

export interface TunnelRecoverResult {
  outcome: TunnelRecoverOutcome;
  reason: string;
  /** Unit that was restarted (only ever the tunnel unit, never the core). */
  restartedUnit?: string;
}

export interface TunnelRecoverOptions {
  /** Bound for the post-restart channel settle wait. */
  settleTimeoutMs?: number;
  /** Post-restart channel poll interval. */
  settleIntervalMs?: number;
  /** Test seam for the tunnel channel probe. */
  probeChannel?: (healthPort: number) => Promise<TunnelChannelState>;
}

interface TunnelRecoveryJournal {
  attempts: string[];
}

function readRecoveryJournal(stateDir: string): TunnelRecoveryJournal {
  const journal = readJson<TunnelRecoveryJournal>(join(stateDir, "tunnel-recovery.json"));
  if (!journal || !Array.isArray(journal.attempts)) return { attempts: [] };
  const cutoff = Date.now() - TUNNEL_RECOVERY_WINDOW_MS;
  return { attempts: journal.attempts.filter((stamp) => Number.isFinite(Date.parse(stamp)) && Date.parse(stamp) >= cutoff) };
}

/**
 * Bounded tunnel-channel recovery through the deployment lock. Restarts only
 * the tunnel unit — never the core, never any adapter — and only when the
 * core is independently READY (restarting the tunnel while the core is down
 * cannot help and would burn the budget). Concurrent invocations serialize
 * on the deployment lock; a live holder fails the second caller closed
 * instead of stacking a second restart. Unit files, the environment file,
 * and credentials are never rewritten by this path, so reviewer
 * authorization structurally survives recovery.
 */
export async function recoverTunnel(
  paths: ServicePaths,
  dependencies: ServiceCommandDependencies,
  env: NodeJS.ProcessEnv = process.env,
  options: TunnelRecoverOptions = {},
): Promise<TunnelRecoverResult> {
  return withDeploymentLock(paths, "recover-tunnel", async (_lock, deploymentId) => {
    const installed = readInstalledState(paths);
    if (!installed) throw new Error("No installed Kontrol service; run `kontrol service install` first.");
    const record = makeRecord(deploymentId, "recover-tunnel", installed);
    writeDeploymentRecord(paths, record);
    try {
      const tunnels = readServiceComponents(env).filter((component) => component.kind === "tunnel");
      if (tunnels.length === 0) {
        const result = { outcome: "already-operational", reason: "no tunnel component configured; nothing to recover" } as const;
        updateDeploymentRecord(paths, record, { stage: "commit" });
        return result;
      }
      if (tunnels.length > 1) {
        throw new Error(`refusing tunnel recovery with ${tunnels.length} tunnel components configured (${tunnels.map((t) => t.name).join(", ")}); disambiguate first`);
      }
      const tunnel = tunnels[0]!;
      const tunnelUnit = componentServiceName(tunnel.name);
      const healthPort = tunnel.port ?? DEFAULT_TUNNEL_HEALTH_PORT;
      if (!(await probeCoreReady(paths, installed))) {
        const result = {
          outcome: "core-not-ready",
          reason: "core is not ready with the exact installed identity; tunnel left untouched (restarting it cannot help while the core is down)",
        } as const;
        updateDeploymentRecord(paths, record, { stage: "commit" });
        return result;
      }
      const probeChannel = options.probeChannel ?? ((port: number) => probeTunnelChannel(port));
      if ((await probeChannel(healthPort)).operational === true) {
        writeJsonAtomic(join(paths.stateDir, "tunnel-recovery.json"), { attempts: [] } satisfies TunnelRecoveryJournal);
        const result = { outcome: "already-operational", reason: `tunnel MCP channel is operational on 127.0.0.1:${healthPort}` } as const;
        updateDeploymentRecord(paths, record, { stage: "commit" });
        return result;
      }
      const journal = readRecoveryJournal(paths.stateDir);
      if (journal.attempts.length >= TUNNEL_RECOVERY_MAX_ATTEMPTS) {
        throw new Error(
          `tunnel recovery budget exhausted (${journal.attempts.length} attempts within ${TUNNEL_RECOVERY_WINDOW_MS / 60_000} minutes); `
          + "investigate the tunnel and core logs instead of restarting again",
        );
      }
      // The only mutation on this path: restart the single tunnel unit.
      // systemd guarantees at most one instance; the core and all adapters
      // are never addressed here.
      systemctl(paths, ["restart", tunnelUnit], dependencies);
      const settleTimeoutMs = options.settleTimeoutMs ?? TUNNEL_RECOVERY_SETTLE_TIMEOUT_MS;
      const settleIntervalMs = options.settleIntervalMs ?? 1_000;
      const deadline = Date.now() + settleTimeoutMs;
      let lastDetail = "no post-restart probe completed";
      for (;;) {
        const state = await probeChannel(healthPort);
        if (state.operational === true) {
          writeJsonAtomic(join(paths.stateDir, "tunnel-recovery.json"), { attempts: [] } satisfies TunnelRecoveryJournal);
          const result = {
            outcome: "recovered",
            reason: `tunnel unit restarted and MCP channel is operational on 127.0.0.1:${healthPort}`,
            restartedUnit: tunnelUnit,
          } as const;
          updateDeploymentRecord(paths, record, { stage: "commit" });
          return result;
        }
        lastDetail = state.detail ?? "channel not operational";
        if (Date.now() >= deadline) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, settleIntervalMs));
      }
      writeJsonAtomic(
        join(paths.stateDir, "tunnel-recovery.json"),
        { attempts: [...journal.attempts, new Date().toISOString()] } satisfies TunnelRecoveryJournal,
      );
      throw new Error(`tunnel unit restarted but MCP channel is still not operational: ${lastDetail}`);
    } catch (error) {
      updateDeploymentRecord(paths, record, {
        stage: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}

/**
 * Authoritative aggregate verdict over the installed systemd stack. Unlike
 * raw `systemctl status` text, this binds the installed build, the live
 * process identity, the live database schema, and every required component
 * into one verdict: READY, RUNNING, DEGRADED, BLOCKED, or STOPPED.
 */
async function runStatus(paths: ServicePaths, dependencies: ServiceCommandDependencies, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const installed = readInstalledState(paths);
  if (!installed) throw new Error(`No installed Kontrol service at ${paths.statePath}; run \`kontrol service install\` first.`);
  // Unresolvable component configuration is a verdict, not a crash: the
  // stack cannot be READY when its own membership is unknown.
  let components: KontrolServiceComponent[];
  try {
    components = readServiceComponents(env);
  } catch (error) {
    console.log([
      `kontrol service status: BLOCKED`,
      `backend: systemd`,
      `installed: build ${installed.buildId} (schema ${installed.schemaVersion}, max readable ${installed.maxReadableSchemaVersion}, content ${installed.contentSha256})`,
      `reasons:`,
      `  - configured components cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
    ].join("\n"));
    return;
  }
  const manifest = buildLifecycleManifest({ coreServiceName: paths.serviceName, components });
  const probe = dependencies.probeUnit ?? defaultProbeUnit;
  const states = new Map(manifest.map((c) => [c.name, probe(c.systemdUnit)]));
  const inspection = inspectLiveDatabase(paths.stateDir);
  const liveIdentity = readJson<{ buildId?: string; artifactPath?: string; generationId?: string }>(
    join(paths.stateDir, "server.identity.json"),
  );
  const coreReady = await probeCoreReady(paths, installed);
  const permanentFailures: string[] = [];
  if (inspection.status === "unreadable") {
    // An existing but uninspectable database blocks any compatibility
    // claim: the gate cannot be skipped, so the stack cannot be READY.
    permanentFailures.push(`live database cannot be inspected: ${inspection.reason}`);
  } else if (inspection.status === "ok" && inspection.schemaVersion > installed.maxReadableSchemaVersion) {
    permanentFailures.push(
      `installed build ${installed.buildId} cannot read live database schema ${inspection.schemaVersion} (max ${installed.maxReadableSchemaVersion}); upgrade to a compatible candidate instead of restarting`,
    );
  }
  const portDesc = describeInstalledPort(paths);
  const portNote = portDesc.source === "configured"
    ? `readiness port ${portDesc.port} (installed environment)`
    : portDesc.source === "default-missing"
      ? `readiness port ${portDesc.port} (default; no PORT in installed environment)`
      : `readiness port ${portDesc.port} (default; installed PORT=${JSON.stringify(portDesc.raw ?? "")} is malformed)`;
  // Entries bind systemd state with independent functional readiness: a
  // systemd-active tunnel/adapter that accepts no connections counts as
  // failed, so the aggregator degrades instead of reporting READY on a
  // unit that merely exists. Qualification is evidence-explicit: a TCP
  // connection proves transport liveness, not application protocol
  // readiness, and components without a port are systemd-state only.
  // Neither is silently represented as fully protocol-qualified.
  const entries: ComponentLiveness[] = [];
  const qualification = new Map<string, string>();
  for (const c of manifest) {
    const state = states.get(c.name) ?? "unknown";
    let failed = state === "failed";
    let detail = state === "failed" || state === "unknown" ? `systemd reports ${state}` : undefined;
    if (c.name !== "core" && state === "active" && c.kind === "tunnel") {
      // Tunnel components get the application-level channel probe: a
      // process-alive tunnel with a disabled MCP channel is degraded, not
      // ready. TCP reachability alone cannot see that failure mode.
      const healthPort = c.port ?? DEFAULT_TUNNEL_HEALTH_PORT;
      const channel = dependencies.probeTunnelChannel
        ? await dependencies.probeTunnelChannel(healthPort)
        : await probeTunnelChannel(healthPort);
      if (channel.operational === true) {
        qualification.set(c.name, `tunnel MCP channel operational (127.0.0.1:${healthPort})`);
      } else {
        failed = true;
        detail = `tunnel process alive but MCP channel not operational on 127.0.0.1:${healthPort} (${channel.detail ?? "no detail"})`;
      }
    } else if (c.name !== "core" && state === "active" && c.port !== undefined) {
      const endpoint = dependencies.probeComponentEndpoint
        ? await dependencies.probeComponentEndpoint(c.systemdUnit, c.port)
        : await probeComponentEndpoint(c.systemdUnit, c.port);
      if (!endpoint.reachable) {
        failed = true;
        detail = `systemd-active but not reachable on 127.0.0.1:${c.port} (${endpoint.detail ?? "no detail"})`;
      } else {
        qualification.set(c.name, `endpoint 127.0.0.1:${c.port} reachable (TCP transport only; application protocol not verified)`);
      }
    } else if (c.name !== "core" && state === "active" && c.port === undefined) {
      qualification.set(c.name, "systemd state only; no functional probe configured");
    }
    entries.push({
      name: c.name,
      required: c.required,
      active: state === "active",
      failed,
      ...(detail !== undefined ? { detail } : {}),
    });
  }
  const aggregated = aggregateLifecycleStatus({ components: entries, coreReady, permanentFailures });
  // A malformed PORT means the readiness probe may have checked the wrong
  // endpoint: never report READY on that basis, surface it instead.
  const verdict = aggregated.verdict === "READY" && portDesc.source === "default-malformed" ? "DEGRADED" : aggregated.verdict;
  const reasons = verdict !== aggregated.verdict
    ? [...aggregated.reasons, `installed PORT is malformed; readiness probed the default port and cannot vouch for the configured endpoint`]
    : aggregated.reasons;
  const lines = [
    `kontrol service status: ${verdict}`,
    `backend: systemd`,
    `installed: build ${installed.buildId} (schema ${installed.schemaVersion}, max readable ${installed.maxReadableSchemaVersion}, content ${installed.contentSha256})`,
    liveIdentity?.buildId
      ? `live: build ${liveIdentity.buildId}${liveIdentity.buildId === installed.buildId ? "" : ` (DRIFT: installed is ${installed.buildId})`}`
      : `live: no live core identity observed`,
    `database schema: ${inspection.status === "ok" ? inspection.schemaVersion : inspection.status === "absent" ? "absent (fresh)" : `unreadable`}`,
    portNote,
    `components:`,
    ...manifest.map((c) => {
      const state = states.get(c.name) ?? "unknown";
      const note = qualification.get(c.name);
      return `  ${c.name} (${c.systemdUnit}): ${state}${note ? `, ${note}` : ""}`;
    }),
    `reasons:`,
    ...reasons.map((reason) => `  - ${reason}`),
  ];
  console.log(lines.join("\n"));
}

export async function runServiceCommand(args: string[], env: NodeJS.ProcessEnv = process.env, dependencies: ServiceCommandDependencies = {}): Promise<void> {
  const [command] = args;
  const paths = servicePaths(env);
  if (command === "adopt-state") {
    // Explicit legacy-state adoption (historical 2686c25d): binds
    // state-owner.json to the canonical production directory with a
    // verified backup + migration ledger. Required before the ownership
    // fence will open a pre-existing production database.
    const { adoptLegacyProductionState } = await import("./state-adoption.js");
    const { canonicalProductionDirectory } = await import("./state-directory.js");
    const flagValue = (name: string): string | undefined => {
      const index = args.indexOf(name);
      return index === -1 ? undefined : args[index + 1];
    };
    const confirmedStateDir = flagValue("--confirm-state-dir");
    const confirmedSchemaVersion = Number(flagValue("--confirm-schema-version"));
    const canonicalDir = canonicalProductionDirectory(env);
    if (!confirmedStateDir || !Number.isInteger(confirmedSchemaVersion)) {
      throw new Error("Usage: kontrol service adopt-state --confirm-state-dir <canonical production dir> --confirm-schema-version <N>");
    }
    const result = await adoptLegacyProductionState({
      stateDir: canonicalDir,
      confirmedStateDir,
      confirmedSchemaVersion,
      canonicalProductionStateDir: canonicalDir,
    });
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "unit" || command === "--print-unit") {
    const build = readServiceBuild(dependencies.currentArtifactPath?.() ?? compiledArtifactPath());
    const state = readInstalledState(paths) ?? {
      ...build,
      serviceName: paths.serviceName,
      deploymentId: `systemd-preview-${build.buildId}`,
      installedAt: new Date().toISOString(),
    };
    const components = readServiceComponents(env);
    requireTunnelReviewerWiring(components, env);
    const unit = renderUserServiceUnit({ ...state, stateDir: paths.stateDir, environmentFile: paths.environmentFile, workingDirectory: paths.dataRoot });
    const manifest = buildLifecycleManifest({ coreServiceName: paths.serviceName, components });
    const targetMemberUnits = manifest.filter((c) => c.name !== "core").map((c) => c.systemdUnit);
    if (args.includes("--json")) {
      console.log(JSON.stringify({
        paths,
        build,
        unit,
        target: renderKontrolTargetUnit(targetMemberUnits, paths.serviceName),
        components: components.map((component) => ({
          name: component.name,
          kind: component.kind,
          unit: componentServiceName(component.name),
          unitText: renderServiceComponentUnit(component, {
            artifactPath: state.artifactPath,
            buildId: state.buildId,
            environmentFile: paths.environmentFile,
            workingDirectory: paths.dataRoot,
          }),
        })),
      }));
    } else {
      process.stdout.write(unit);
      for (const component of components) {
        process.stdout.write(renderServiceComponentUnit(component, {
          artifactPath: state.artifactPath,
          buildId: state.buildId,
          environmentFile: paths.environmentFile,
          workingDirectory: paths.dataRoot,
        }));
      }
      process.stdout.write(renderKontrolTargetUnit(targetMemberUnits, paths.serviceName));
    }
    return;
  }
  if (command === "wait-core-ready") {
    const timeoutFlag = args.indexOf("--timeout-ms");
    const timeoutMs = timeoutFlag === -1 ? TUNNEL_CORE_WAIT_TIMEOUT_MS : Number(args[timeoutFlag + 1]);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Usage: kontrol service wait-core-ready [--timeout-ms N] [--expected-build-id ID] [--artifact-path PATH] [--port N] [--state-dir DIR]");
    const flagValue = (name: string): string | undefined => {
      const index = args.indexOf(name);
      return index === -1 ? undefined : args[index + 1];
    };
    const expectedBuildId = flagValue("--expected-build-id") ?? env.KONTROL_EXPECTED_BUILD_ID;
    const expectedArtifactPath = flagValue("--artifact-path") ?? env.KONTROL_ARTIFACT_PATH;
    const portFlag = flagValue("--port");
    const stateDirFlag = flagValue("--state-dir");
    const explicitPort = portFlag !== undefined ? Number(portFlag) : (env.PORT ? Number(env.PORT) : undefined);
    if (explicitPort !== undefined && (!Number.isInteger(explicitPort) || explicitPort <= 0 || explicitPort > 65535)) {
      throw new Error("Usage: kontrol service wait-core-ready [--port N] (1-65535)");
    }
    // Backend-aware: tmux launcher passes the exact candidate identity as
    // flags; the systemd path (no explicit flags) keeps the installed-service
    // behavior. Classify on flags only: component units export
    // KONTROL_EXPECTED_BUILD_ID in their environment, which must not be
    // mistaken for a tmux candidate identity (that misclassification made
    // the tunnel gate demand --artifact-path and fail every systemd start).
    const tmuxIdentity = flagValue("--expected-build-id") !== undefined || flagValue("--artifact-path") !== undefined || portFlag !== undefined || stateDirFlag !== undefined;
    if (tmuxIdentity) {
      if (!expectedBuildId || !expectedArtifactPath) {
        throw new Error("wait-core-ready with explicit identity requires --expected-build-id and --artifact-path (tmux candidate identity)");
      }
      const stateDir = stateDirFlag ?? env.KONTROL_STATE_DIR ?? paths.stateDir;
      const port = explicitPort ?? readInstalledPort(paths);
      await waitForCoreReady({
        stateDir,
        port,
        expectedBuildId,
        expectedArtifactPath,
        timeoutMs,
      });
      console.log(`core ready: build ${expectedBuildId} (tmux candidate)`);
      return;
    }
    const installed = readInstalledState(paths);
    if (!installed) throw new Error("No installed Kontrol service; run `kontrol service install` first.");
    await waitForCoreReady({
      stateDir: paths.stateDir,
      port: readInstalledPort(paths),
      expectedBuildId: installed.buildId,
      expectedArtifactPath: installed.artifactPath,
      timeoutMs,
    });
    console.log(`core ready: build ${installed.buildId}`);
    return;
  }
  if (command === "recover-tunnel") {
    if (args.length > 1) throw new Error("Usage: kontrol service recover-tunnel");
    requireSystemd(dependencies);
    const result = await recoverTunnel(paths, dependencies, env);
    console.log([`tunnel recovery: ${result.outcome}`, `reason: ${result.reason}`].join("\n"));
    return;
  }
  if (args.length > 1) throw new Error(`Usage: kontrol service ${command ?? "install|start|stop|restart|upgrade|status|logs|uninstall|wait-core-ready|recover-tunnel"}`);
  if (command === "install") return install(paths, dependencies, env);
  if (command === "start") return activate(paths, "start", dependencies, env);
  if (command === "stop") return activate(paths, "stop", dependencies, env);
  if (command === "restart") return activate(paths, "restart", dependencies, env);
  if (command === "upgrade") return upgrade(paths, dependencies, env);
  if (command === "uninstall") return uninstall(paths, dependencies);
  if (command === "status") {
    requireSystemd(dependencies);
    await runStatus(paths, dependencies, env);
    // Existing systemd detail passthrough: the authoritative verdict above
    // never relies on systemd activity text alone, but operators still get
    // the raw unit state for diagnosis. Best-effort: a missing or dead unit
    // must not turn a reported verdict into a thrown error.
    try {
      systemctl(paths, ["--no-pager", "status", paths.serviceName], dependencies);
      // P1.9: configured auxiliary units are part of the production surface.
      const components = readServiceComponents(env);
      if (components.length > 0) {
        systemctl(paths, ["--no-pager", "status", "kontrol.target", ...components.map((c) => componentServiceName(c.name))], dependencies);
      }
    } catch (error) {
      console.error(`note: systemd detail unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  if (command === "logs") {
    requireSystemd(dependencies);
    // Aggregate the core plus every configured auxiliary unit so one
    // command covers the whole stack instead of only the core journal.
    const components = readServiceComponents(env);
    const units = [paths.serviceName, ...components.map((c) => componentServiceName(c.name))];
    const journalArgs = ["--user", "--no-pager", "-f"];
    for (const unit of units) journalArgs.push("-u", unit);
    const result = spawnSync("journalctl", journalArgs, { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`journalctl --user -f -u ${units.join(" -u ")} failed with status ${result.status ?? "unknown"}`);
    return;
  }
  throw new Error("Usage: kontrol service unit|install|start|stop|restart|upgrade|status|logs|uninstall|wait-core-ready|recover-tunnel");
}
