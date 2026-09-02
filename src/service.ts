import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKontrolFiles } from "./user-config.js";
import { acquireDeploymentLock, releaseDeploymentLock, type DeploymentLockHandle } from "./deployment-lock.js";
import { restoreDeploymentDatabaseBackup } from "./db/deployment-backup.js";

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
}

interface DeploymentRecord {
  deploymentId: string;
  operation: "install" | "start" | "stop" | "restart" | "upgrade" | "uninstall";
  stage: "prepare" | "prepared" | "stop" | "activate" | "rollback" | "commit" | "rollback_failed" | "failed";
  previous?: InstalledServiceState;
  candidate?: InstalledServiceState;
  databaseRestore?: unknown;
  error?: string;
  updatedAt: string;
}

function defaultDataRoot(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "kontrol");
}

function defaultStateDir(env: NodeJS.ProcessEnv): string {
  const files = loadKontrolFiles(env);
  return resolve(env.KONTROL_STATE_DIR ?? files.config.stateDir ?? defaultDataRoot(env));
}

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

function copyRelease(paths: ServicePaths, build: ServiceBuild): InstalledServiceState {
  mkdirSync(paths.releasesRoot, { recursive: true, mode: 0o700 });
  const destination = join(paths.releasesRoot, build.buildId);
  if (!existsSync(destination)) {
    const temporary = join(paths.releasesRoot, `.install-${build.buildId}-${process.pid}-${randomUUID()}`);
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    try {
      for (const entry of readdirSync(build.artifactPath)) {
        cpSync(join(build.artifactPath, entry), join(temporary, entry), { recursive: true });
      }
      readServiceBuild(temporary);
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  } else {
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
  };
}

function systemdQuote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("systemd values cannot contain newlines");
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\t", "\\t")}"`;
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
    "After=default.target",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdQuote(options.workingDirectory)}`,
    `EnvironmentFile=-${systemdQuote(options.environmentFile)}`,
    `Environment=${systemdQuote("KONTROL_LAUNCHER=systemd")}`,
    `Environment=${systemdQuote(`KONTROL_EXPECTED_BUILD_ID=${options.buildId}`)}`,
    `Environment=${systemdQuote(`KONTROL_EXPECTED_SCHEMA_VERSION=${options.schemaVersion}`)}`,
    `Environment=${systemdQuote(`KONTROL_EXPECTED_MAX_SCHEMA_VERSION=${options.maxReadableSchemaVersion}`)}`,
    `Environment=${systemdQuote(`KONTROL_DEPLOYMENT_ID=${options.deploymentId}`)}`,
    `Environment=${systemdQuote(`KONTROL_ARTIFACT_PATH=${options.artifactPath}`)}`,
    `Environment=${systemdQuote(`KONTROL_STATE_DIR=${options.stateDir}`)}`,
    `ExecStart=/usr/bin/env node ${systemdQuote(artifactCli)} serve`,
    "Restart=on-failure",
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

function writeUnit(paths: ServicePaths, state: InstalledServiceState): void {
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
  const port = Number(process.env.PORT ?? 7676);
  const endpoint = `http://127.0.0.1:${port}/core-readyz`;
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

async function install(paths: ServicePaths, dependencies: ServiceCommandDependencies): Promise<void> {
  requireSystemd(dependencies);
  await withDeploymentLock(paths, "install", async (_lock, deploymentId) => {
    const current = copyRelease(paths, readServiceBuild(dependencies.currentArtifactPath?.() ?? compiledArtifactPath()));
    const state = { ...current, deploymentId };
    const record = makeRecord(deploymentId, "install", undefined, state);
    writeDeploymentRecord(paths, record);
    writeUnit(paths, state);
    systemctl(paths, ["daemon-reload"], dependencies);
    updateDeploymentRecord(paths, record, { stage: "commit" });
  });
}

async function activate(paths: ServicePaths, operation: "start" | "stop" | "restart", dependencies: ServiceCommandDependencies): Promise<void> {
  requireSystemd(dependencies);
  const installed = readInstalledState(paths);
  if (!installed) throw new Error(`No installed Kontrol service at ${paths.statePath}; run \`kontrol service install\` first.`);
  await withDeploymentLock(paths, operation, async (_lock, deploymentId) => {
    const record = makeRecord(deploymentId, operation, installed, installed);
    writeDeploymentRecord(paths, record);
    if (operation === "start") systemctl(paths, ["enable", "--now", paths.serviceName], dependencies);
    else if (operation === "stop") systemctl(paths, ["stop", paths.serviceName], dependencies);
    else systemctl(paths, ["restart", paths.serviceName], dependencies);
    if (operation !== "stop") await (dependencies.waitForReady?.(paths, installed) ?? waitForReady(paths, installed));
    updateDeploymentRecord(paths, record, { stage: "commit" });
  });
}

async function upgrade(paths: ServicePaths, dependencies: ServiceCommandDependencies): Promise<void> {
  requireSystemd(dependencies);
  const previous = readInstalledState(paths);
  if (!previous) throw new Error(`No installed Kontrol service at ${paths.statePath}; run \`kontrol service install\` first.`);
  await withDeploymentLock(paths, "upgrade", async (_lock, deploymentId) => {
    const candidate = { ...copyRelease(paths, readServiceBuild(dependencies.currentArtifactPath?.() ?? compiledArtifactPath())), deploymentId };
    let record = makeRecord(deploymentId, "upgrade", previous, candidate);
    writeDeploymentRecord(paths, record);
    record = updateDeploymentRecord(paths, record, { stage: "prepared" });
    writeUnit(paths, candidate);
    systemctl(paths, ["daemon-reload"], dependencies);
    try {
      record = updateDeploymentRecord(paths, record, { stage: "stop" });
      systemctl(paths, ["stop", paths.serviceName], dependencies);
      record = updateDeploymentRecord(paths, record, { stage: "activate" });
      systemctl(paths, ["start", paths.serviceName], dependencies);
      await (dependencies.waitForReady?.(paths, candidate) ?? waitForReady(paths, candidate));
      updateDeploymentRecord(paths, record, { stage: "commit" });
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      record = updateDeploymentRecord(paths, record, { stage: "rollback", error: reason });
      try {
        // Do not touch the live database until systemd confirms that the
        // candidate process is stopped and no longer owns the runtime lock.
        systemctl(paths, ["stop", paths.serviceName], dependencies);
        const databaseRestore = restoreDeploymentDatabaseBackup({
          stateDir: paths.stateDir,
          deploymentId,
          maxReadableSchemaVersion: previous.maxReadableSchemaVersion,
          expectedOriginalSchemaVersion: previous.schemaVersion,
        });
        record = updateDeploymentRecord(paths, record, { databaseRestore });
        writeUnit(paths, previous);
        systemctl(paths, ["daemon-reload"], dependencies);
        systemctl(paths, ["start", paths.serviceName], dependencies);
        await (dependencies.waitForReady?.(paths, previous) ?? waitForReady(paths, previous));
        updateDeploymentRecord(paths, record, { stage: "commit" });
      } catch (rollbackError) {
        const rollbackReason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        updateDeploymentRecord(paths, record, { stage: "rollback_failed", error: `${reason}; rollback: ${rollbackReason}` });
        throw new Error(`Candidate ${candidate.buildId} failed readiness and rollback was not verified: ${rollbackReason}`);
      }
      throw new Error(`Candidate ${candidate.buildId} failed readiness; previous build ${previous.buildId} and database were restored.`);
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
    rmSync(paths.statePath, { force: true });
    systemctl(paths, ["daemon-reload"], dependencies);
    updateDeploymentRecord(paths, record, { stage: "commit" });
  });
}

export async function runServiceCommand(args: string[], env: NodeJS.ProcessEnv = process.env, dependencies: ServiceCommandDependencies = {}): Promise<void> {
  const [command] = args;
  const paths = servicePaths(env);
  if (command === "unit" || command === "--print-unit") {
    const build = readServiceBuild(dependencies.currentArtifactPath?.() ?? compiledArtifactPath());
    const state = readInstalledState(paths) ?? {
      ...build,
      serviceName: paths.serviceName,
      deploymentId: `systemd-preview-${build.buildId}`,
      installedAt: new Date().toISOString(),
    };
    const unit = renderUserServiceUnit({ ...state, stateDir: paths.stateDir, environmentFile: paths.environmentFile, workingDirectory: paths.dataRoot });
    if (args.includes("--json")) console.log(JSON.stringify({ paths, build, unit }));
    else process.stdout.write(unit);
    return;
  }
  if (args.length > 1) throw new Error(`Usage: kontrol service ${command ?? "install|start|stop|restart|upgrade|status|logs|uninstall"}`);
  if (command === "install") return install(paths, dependencies);
  if (command === "start") return activate(paths, "start", dependencies);
  if (command === "stop") return activate(paths, "stop", dependencies);
  if (command === "restart") return activate(paths, "restart", dependencies);
  if (command === "upgrade") return upgrade(paths, dependencies);
  if (command === "uninstall") return uninstall(paths, dependencies);
  if (command === "status") { requireSystemd(dependencies); systemctl(paths, ["--no-pager", "status", paths.serviceName], dependencies); return; }
  if (command === "logs") {
    requireSystemd(dependencies);
    const result = spawnSync("journalctl", ["--user", "--no-pager", "-f", "-u", paths.serviceName], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`journalctl --user -u ${paths.serviceName} failed with status ${result.status ?? "unknown"}`);
    return;
  }
  throw new Error("Usage: kontrol service unit|install|start|stop|restart|upgrade|status|logs|uninstall");
}
