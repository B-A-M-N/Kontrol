import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { isRuntimeIdentityLive, readRuntimeIdentity } from "./runtime-identity.js";
import { databasePath } from "./db/client.js";
import { migrationChain } from "./db/migrations.js";
import { verifyArtifactContent } from "./release-integrity.js";

export type ReconciliationStatus = "PASS" | "WARN" | "FAIL" | "UNAVAILABLE";

export interface ReconciliationResult {
  status: ReconciliationStatus;
  detail: string;
}

export interface DeploymentReconciliation {
  recordedGeneration: ReconciliationResult;
  observedRuntime: ReconciliationResult;
  activeArtifact: ReconciliationResult;
  databaseCompatibility: ReconciliationResult;
}

export type UnifiedReconciliationStatus = "PASS" | "DRIFT" | "FAILED" | "UNKNOWN";
export type UnifiedEvidenceStatus = UnifiedReconciliationStatus | "FAIL" | "WARN" | "UNAVAILABLE";
export interface UnifiedEvidenceResult { status: UnifiedEvidenceStatus; detail: string }

export interface UnifiedDeploymentReconciliation {
  status: UnifiedReconciliationStatus;
  evidence: {
    committedManifest: UnifiedEvidenceResult;
    systemd: UnifiedEvidenceResult;
    runtime: UnifiedEvidenceResult;
    artifact: UnifiedEvidenceResult;
    database: UnifiedEvidenceResult;
  };
}

export interface ReconciliationServicePaths {
  stateDir: string;
  statePath: string;
  unitPath: string;
  serviceName: string;
}

export interface SystemdObservation {
  loadState?: string;
  activeState?: string;
  mainPid?: number;
  fragmentPath?: string;
  error?: string;
}


interface GenerationRecord {
  status?: string;
  generationId?: string | null;
  requestedBuildId?: string | null;
  activeBuildId?: string | null;
  artifactPath?: string | null;
  rollback?: boolean;
  failedBuildId?: string | null;
  reason?: string | null;
}

interface ArtifactMetadata {
  buildId?: string;
  schemaVersion?: number;
  minReadableSchemaVersion?: number;
  maxReadableSchemaVersion?: number;
}

export function inspectDeploymentReconciliation(stateDir: string): DeploymentReconciliation {
  let generation: GenerationRecord | undefined;
  const generationPath = join(stateDir, "generation.json");
  try {
    generation = JSON.parse(readFileSync(generationPath, "utf8")) as GenerationRecord;
  } catch {
    return {
      recordedGeneration: { status: "WARN", detail: "generation.json not present or unreadable" },
      observedRuntime: inspectObservedRuntime(readRuntimeIdentity(stateDir)),
      activeArtifact: { status: "UNAVAILABLE", detail: "no recorded active artifact" },
      databaseCompatibility: { status: "UNAVAILABLE", detail: "no recorded active artifact to compare" },
    };
  }

  const recordedGeneration: ReconciliationResult = {
    status: generation.rollback || generation.status !== "active" ? "WARN" : "PASS",
    detail: `status=${generation.status ?? "unknown"} requested=${generation.requestedBuildId ?? "unknown"} active=${generation.activeBuildId ?? "unknown"}`
      + (generation.rollback ? ` failed=${generation.failedBuildId ?? "unknown"} reason=${generation.reason ?? "unknown"}` : ""),
  };

  const identity = readRuntimeIdentity(stateDir);
  const observedRuntime = inspectObservedRuntime(identity, generation);
  const activePath = typeof generation.artifactPath === "string" && generation.artifactPath.length > 0
    ? resolve(generation.artifactPath)
    : undefined;
  let metadata: ArtifactMetadata | undefined;
  if (!activePath) {
    return {
      recordedGeneration,
      observedRuntime,
      activeArtifact: { status: "WARN", detail: "generation record has no active artifact path" },
      databaseCompatibility: { status: "UNAVAILABLE", detail: "generation record has no active artifact path" },
    };
  }

  try {
    metadata = JSON.parse(readFileSync(join(activePath, "build-meta.json"), "utf8")) as ArtifactMetadata;
  } catch {
    return {
      recordedGeneration,
      observedRuntime,
      activeArtifact: { status: "FAIL", detail: `active artifact metadata unavailable at ${activePath}` },
      databaseCompatibility: { status: "UNAVAILABLE", detail: "active artifact schema bounds unavailable" },
    };
  }

  const activeArtifact: ReconciliationResult = metadata.buildId === generation.activeBuildId
    ? { status: "PASS", detail: `recorded=${generation.activeBuildId ?? "unknown"} artifact=${metadata.buildId}; path=${activePath}` }
    : { status: "FAIL", detail: `recorded=${generation.activeBuildId ?? "unknown"} artifact=${metadata.buildId ?? "unknown"}; path=${activePath}` };

  let db: Database.Database | undefined;
  let databaseCompatibility: ReconciliationResult;
  try {
    const path = databasePath(stateDir);
    if (!existsSync(path)) {
      databaseCompatibility = { status: "UNAVAILABLE", detail: "kontrol.sqlite not present" };
    } else {
      db = new Database(path, { readonly: true, fileMustExist: true });
      const row = db.prepare("select max(version) as version from kontrol_schema_migrations").get() as { version?: number } | undefined;
      const currentVersion = Number(row?.version ?? 0);
      const schemaVersion = metadata.schemaVersion;
      const min = metadata.minReadableSchemaVersion ?? 0;
      const max = metadata.maxReadableSchemaVersion ?? schemaVersion;
      if (!Number.isInteger(schemaVersion) || !Number.isInteger(min) || !Number.isInteger(max)) {
        databaseCompatibility = { status: "UNAVAILABLE", detail: "active artifact has invalid schema compatibility metadata" };
      } else {
        const minimum = Number(min);
        const maximum = Number(max);
        const compatible = currentVersion >= minimum && currentVersion <= maximum;
        databaseCompatibility = {
          status: compatible ? "PASS" : "FAIL",
          detail: `database=${currentVersion} artifact=${metadata.buildId ?? "unknown"} readable=${minimum}..${maximum}`,
        };
      }
    }
  } catch (error) {
    databaseCompatibility = { status: "UNAVAILABLE", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }

  return { recordedGeneration, observedRuntime, activeArtifact, databaseCompatibility };
}

function inspectObservedRuntime(identity: ReturnType<typeof readRuntimeIdentity>, generation?: GenerationRecord): ReconciliationResult {
  if (!identity) return { status: "WARN", detail: "server.identity.json not present" };
  if (!isRuntimeIdentityLive(identity)) {
    return { status: "WARN", detail: `no live process for recorded pid=${identity.pid}; build=${identity.buildId}` };
  }
  if (generation) {
    // generation.json is written by the tmux-track launcher only; a
    // systemd-track deployment never updates it. Compare the live
    // runtime against the record only when the record's artifact lives
    // under the SAME artifact root as the runtime (same deployment
    // track). A record from another track's root (e.g. a devspace
    // checkout while systemd serves the state directory) is reported,
    // not treated as ownership evidence.
    const liveArtifactRoot = identity.artifactPath ? dirname(resolve(identity.artifactPath)) : undefined;
    const generationArtifact = generation.artifactPath ? resolve(generation.artifactPath) : undefined;
    const sameTrack = Boolean(liveArtifactRoot && generationArtifact
      && (generationArtifact === liveArtifactRoot || generationArtifact.startsWith(`${liveArtifactRoot}/`)));
    if (!sameTrack) {
      return {
        status: "PASS",
        detail: `pid=${identity.pid} build=${identity.buildId} generation=${identity.generationId ?? "unknown"} artifact=${identity.artifactPath ?? "unknown"}; generation record ${generation.generationId ?? generation.activeBuildId ?? "unknown"} belongs to another artifact root and is not compared`,
      };
    }
    const buildMatches = identity.buildId === generation.activeBuildId;
    const pathMatches = !generation.artifactPath
      || (identity.artifactPath !== undefined && resolve(identity.artifactPath) === resolve(generation.artifactPath));
    const generationMatches = !generation.generationId || identity.generationId === generation.generationId;
    if (!buildMatches || !pathMatches || !generationMatches) {
      return {
        status: "FAIL",
        detail: `runtime=${identity.buildId}@${identity.artifactPath ?? "unknown"} generation=${identity.generationId ?? "unknown"}; recorded=${generation.activeBuildId ?? "unknown"}@${generation.artifactPath ?? "unknown"} generation=${generation.generationId ?? "unknown"}`,
      };
    }
  }
  return {
    status: generation ? "PASS" : "WARN",
    detail: `pid=${identity.pid} build=${identity.buildId} generation=${identity.generationId ?? "unknown"} artifact=${identity.artifactPath ?? "unknown"}`,
  };
}

/**
 * Reconcile the persisted service manifest, systemd's read-only view, the
 * server identity, immutable artifact metadata, and SQLite schema. Missing
 * evidence remains UNKNOWN; it is never inferred from generation.json alone.
 */
export function inspectUnifiedDeploymentReconciliation(
  paths: ReconciliationServicePaths,
  options: { observeSystemd?: (serviceName: string) => SystemdObservation } = {},
): UnifiedDeploymentReconciliation {
  const observe = options.observeSystemd ?? observeSystemd;
  const manifest = readJsonFile<Record<string, unknown>>(paths.statePath);
  const componentContract = parseServiceComponents(manifest?.serviceComponents);
  const systemdInspection = inspectSystemd(paths, observe, componentContract.components, componentContract.error);
  const evidence: UnifiedDeploymentReconciliation["evidence"] = {
    committedManifest: inspectCommittedManifest(paths),
    systemd: systemdInspection.evidence,
    runtime: { status: "UNKNOWN", detail: "runtime identity not inspected" },
    artifact: { status: "UNKNOWN", detail: "committed artifact not inspected" },
    database: { status: "UNKNOWN", detail: "database not inspected" },
  };

  if (!manifest) return { status: aggregate(evidence), evidence };
  const buildId = stringField(manifest.buildId);
  const artifactPath = stringField(manifest.artifactPath);
  const schemaVersion = numberField(manifest.schemaVersion);
  const minReadable = numberField(manifest.minReadableSchemaVersion);
  const maxReadable = numberField(manifest.maxReadableSchemaVersion);
  if (!buildId || !artifactPath || schemaVersion === undefined || minReadable === undefined || maxReadable === undefined) {
    evidence.committedManifest = { status: "FAIL", detail: "service.json lacks build, artifact, or schema identity fields" };
    return { status: aggregate(evidence), evidence };
  }

  const generation = readJsonFile<GenerationRecord>(join(paths.stateDir, "generation.json"));
  const identity = readRuntimeIdentity(paths.stateDir);
  evidence.runtime = !identity
    ? { status: "UNKNOWN", detail: "server.identity.json not present" }
    : !isRuntimeIdentityLive(identity)
      ? { status: "FAILED", detail: `no live process for recorded pid=${identity.pid}; build=${identity.buildId}` }
      : { status: "PASS", detail: `pid=${identity.pid} build=${identity.buildId} generation=${identity.generationId ?? "unknown"} artifact=${identity.artifactPath ?? "unknown"}` };
  if (identity && generation) {
    // Same track rule as inspectObservedRuntime: only compare when the
    // generation record's artifact lives under the live runtime's
    // artifact root. Another track's record is reported, not compared.
    const liveArtifactRoot = identity.artifactPath ? dirname(resolve(identity.artifactPath)) : undefined;
    const generationArtifact = generation.artifactPath ? resolve(generation.artifactPath) : undefined;
    const sameTrack = Boolean(liveArtifactRoot && generationArtifact
      && (generationArtifact === liveArtifactRoot || generationArtifact.startsWith(`${liveArtifactRoot}/`)));
    if (!sameTrack) {
      evidence.runtime = { status: "PASS", detail: `pid=${identity.pid} build=${identity.buildId} generation=${identity.generationId ?? "unknown"} artifact=${identity.artifactPath ?? "unknown"}; generation record ${generation.generationId ?? generation.activeBuildId ?? "unknown"} belongs to another artifact root and is not compared` };
    } else {
    const matches = identity.buildId === generation.activeBuildId
      && (!generation.generationId || identity.generationId === generation.generationId)
      && (!generation.artifactPath || (identity.artifactPath !== undefined && resolve(identity.artifactPath) === resolve(generation.artifactPath)));
    if (!matches) evidence.runtime = { status: "DRIFT", detail: `runtime=${identity.buildId}@${identity.artifactPath ?? "unknown"}; generation record=${generation.activeBuildId ?? "unknown"}@${generation.artifactPath ?? "unknown"}` };
    }
  }
  const normalizedArtifactPath = resolve(artifactPath);
  const artifactMeta = readJsonFile<ArtifactMetadata>(join(normalizedArtifactPath, "build-meta.json"));
  // Byte integrity is recomputed from the installed tree (format-aware
  // release verifier): a PASS requires metadata identity AND matching
  // bytes. Missing metadata is UNKNOWN (never inferred); a missing or
  // mismatching hash is FAIL; tampering under intact metadata is FAIL.
  const artifactBytes = artifactMeta ? verifyArtifactContent(normalizedArtifactPath) : undefined;
  evidence.artifact = artifactMeta
    ? artifactMeta.buildId === buildId
      && artifactMeta.schemaVersion === schemaVersion
      && (artifactMeta.minReadableSchemaVersion ?? 0) === minReadable
      && (artifactMeta.maxReadableSchemaVersion ?? artifactMeta.schemaVersion) === maxReadable
      ? artifactBytes && artifactBytes.ok
        ? { status: "PASS", detail: `service.json=${buildId}; artifact=${artifactMeta.buildId}; content=${artifactBytes.contentSha256 ?? "unknown"}; path=${normalizedArtifactPath}` }
        : { status: "FAIL", detail: `artifact byte integrity failed for ${normalizedArtifactPath}: ${artifactBytes?.reason ?? "unverified"}` }
      : { status: "FAIL", detail: `service.json=${buildId} schema=${schemaVersion} readable=${minReadable}..${maxReadable}; artifact=${artifactMeta.buildId ?? "unknown"} schema=${artifactMeta.schemaVersion ?? "unknown"} readable=${artifactMeta.minReadableSchemaVersion ?? "unknown"}..${artifactMeta.maxReadableSchemaVersion ?? "unknown"}; path=${normalizedArtifactPath}` }
    : { status: "UNKNOWN", detail: `build metadata unavailable at ${normalizedArtifactPath}` };

  if (identity && isRuntimeIdentityLive(identity)) {
    const identityPath = identity.artifactPath ? resolve(identity.artifactPath) : undefined;
    if (identity.buildId !== buildId || identityPath !== normalizedArtifactPath) {
      evidence.runtime = { status: "FAIL", detail: `runtime=${identity.buildId}@${identityPath ?? "unknown"}; committed=${buildId}@${normalizedArtifactPath}` };
    }
  }
  evidence.database = inspectDatabaseCompatibility(paths.stateDir, minReadable, maxReadable, buildId);

  const systemd = systemdInspection.core;
  if (!systemd.error && systemd.mainPid && identity?.pid && systemd.mainPid !== identity.pid) {
    evidence.systemd = { status: "FAIL", detail: `systemd MainPID=${systemd.mainPid} differs from server identity pid=${identity.pid}` };
  }
  if (!systemd.error && systemd.fragmentPath && resolve(systemd.fragmentPath) !== resolve(paths.unitPath)) {
    evidence.systemd = { status: "FAIL", detail: `systemd FragmentPath=${systemd.fragmentPath}; expected=${paths.unitPath}` };
  }
  return { status: aggregate(evidence), evidence };
}

function inspectCommittedManifest(paths: ReconciliationServicePaths): UnifiedEvidenceResult {
  const path = paths.statePath;
  const manifest = readJsonFile<Record<string, unknown>>(path);
  if (!manifest) return { status: "UNKNOWN", detail: `committed service manifest unavailable at ${path}` };
  const required = ["buildId", "artifactPath", "deploymentId", "schemaVersion", "minReadableSchemaVersion", "maxReadableSchemaVersion"];
  const missing = required.filter((key) => manifest[key] === undefined);
  if (missing.length > 0) return { status: "FAIL", detail: `service.json missing: ${missing.join(", ")}` };
  const deploymentId = stringField(manifest.deploymentId);
  if (!deploymentId) return { status: "FAIL", detail: "service.json deploymentId is invalid" };
  const transaction = readJsonFile<Record<string, unknown>>(join(paths.stateDir, `deployment.${deploymentId}.json`));
  if (!transaction) return { status: "UNKNOWN", detail: `deployment transaction ${deploymentId} is unavailable` };
  if (transaction.stage !== "commit") {
    return { status: "FAILED", detail: `deployment transaction ${deploymentId} is ${String(transaction.stage ?? "unknown")}, not committed` };
  }
  const restored = Boolean((transaction.databaseRestore as { restored?: boolean } | undefined)?.restored);
  const rolledBack = restored || typeof transaction.error === "string" || transaction.rollback === true;
  const selected = rolledBack ? transaction.previous : transaction.candidate;
  if (!selected || typeof selected !== "object") return { status: "FAIL", detail: `committed transaction ${deploymentId} has no selected service state` };
  const selectedState = selected as Record<string, unknown>;
  if (selectedState.buildId !== manifest.buildId || resolve(String(selectedState.artifactPath)) !== resolve(String(manifest.artifactPath))) {
    return { status: "FAIL", detail: `service.json build=${String(manifest.buildId)} differs from committed transaction ${deploymentId} build=${String(selectedState.buildId)}` };
  }
  return { status: "PASS", detail: `service.json build=${manifest.buildId} deployment=${deploymentId} transaction=commit artifact=${manifest.artifactPath}` };
}

interface ServiceComponentReference { name: string; required: boolean }

function parseServiceComponents(value: unknown): { components: ServiceComponentReference[]; error?: string } {
  if (value === undefined) return { components: [] };
  if (!Array.isArray(value)) return { components: [], error: "service.json serviceComponents is not an array" };
  const components: ServiceComponentReference[] = [];
  const names = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { components: [], error: "service.json contains an invalid service component" };
    }
    const component = entry as Record<string, unknown>;
    const name = stringField(component.name);
    if (!name || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(name) || names.has(name)
      || (component.required !== undefined && typeof component.required !== "boolean")) {
      return { components: [], error: "service.json contains an invalid service component identity or required flag" };
    }
    names.add(name);
    components.push({ name, required: component.required !== false });
  }
  return { components };
}

interface SystemdInspection { evidence: UnifiedEvidenceResult; core: SystemdObservation }

function inspectSystemd(
  paths: ReconciliationServicePaths,
  observe: (serviceName: string) => SystemdObservation,
  components: ServiceComponentReference[] = [],
  componentContractError?: string,
): SystemdInspection {
  const core = observe(paths.serviceName);
  const target = observe("kontrol.target");
  const details: string[] = [];
  const failures: string[] = [];
  const unknown: string[] = [];
  const warnings: string[] = [];

  if (core.error) unknown.push(`core observation unavailable: ${core.error}`);
  else if (!core.loadState || core.loadState === "not-found") failures.push(`core unit loadState=${core.loadState ?? "unknown"}`);
  else if (core.activeState !== "active") failures.push(`core unit activeState=${core.activeState ?? "unknown"} MainPID=${core.mainPid ?? 0}`);
  else if (!core.mainPid || core.mainPid <= 0 || !core.fragmentPath) unknown.push("core unit is active but MainPID or FragmentPath is missing");
  else if (resolve(core.fragmentPath) !== resolve(paths.unitPath)) failures.push(`core FragmentPath=${core.fragmentPath}; expected=${paths.unitPath}`);
  else details.push(`core=active pid=${core.mainPid}`);

  if (target.error) unknown.push(`target observation unavailable: ${target.error}`);
  else if (!target.loadState || target.loadState === "not-found") failures.push(`kontrol.target loadState=${target.loadState ?? "unknown"}`);
  else if (target.activeState !== "active") failures.push(`kontrol.target activeState=${target.activeState ?? "unknown"}`);
  else details.push("kontrol.target=active");

  if (componentContractError) failures.push(componentContractError);
  for (const component of components) {
    const unitName = `kontrol-${component.name}.service`;
    const observed = observe(unitName);
    const prefix = `${component.required ? "required" : "optional"} component ${unitName}`;
    if (observed.error) {
      const detail = `${prefix} observation unavailable: ${observed.error}`;
      (component.required ? unknown : warnings).push(detail);
      continue;
    }
    if (!observed.loadState || observed.loadState === "not-found") {
      const detail = `${prefix} loadState=${observed.loadState ?? "unknown"}`;
      (component.required ? failures : warnings).push(detail);
      continue;
    }
    if (observed.activeState !== "active") {
      const detail = `${prefix} activeState=${observed.activeState ?? "unknown"}`;
      (component.required ? failures : warnings).push(detail);
      continue;
    }
    const expectedFragment = join(dirname(paths.unitPath), unitName);
    if (observed.fragmentPath && resolve(observed.fragmentPath) !== expectedFragment) {
      failures.push(`${prefix} FragmentPath=${observed.fragmentPath}; expected=${expectedFragment}`);
      continue;
    }
    if (!observed.fragmentPath) {
      (component.required ? unknown : warnings).push(`${prefix} is active but FragmentPath is missing`);
      continue;
    }
    details.push(`${unitName}=active`);
  }

  if (failures.length) return { evidence: { status: "FAILED", detail: [...failures, ...warnings, ...unknown].join("; ") }, core };
  if (unknown.length) return { evidence: { status: "UNKNOWN", detail: [...unknown, ...warnings].join("; ") }, core };
  if (warnings.length) return { evidence: { status: "WARN", detail: [...details, ...warnings].join("; ") }, core };
  return { evidence: { status: "PASS", detail: details.join("; ") || "systemd core, target, and configured components are active" }, core };
}

function observeSystemd(serviceName: string): SystemdObservation {
  const result = spawnSync("systemctl", ["--user", "show", serviceName, "--no-pager", "--property=LoadState,ActiveState,MainPID,FragmentPath"], {
    encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) return { error: result.error.message };
  if (result.status !== 0) return { error: (result.stderr || result.stdout || `systemctl exited ${result.status}`).trim() };
  const fields = new Map(result.stdout.split(/\r?\n/).map((line) => {
    const index = line.indexOf("=");
    return index < 0 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
  }));
  return {
    loadState: fields.get("LoadState"),
    activeState: fields.get("ActiveState"),
    mainPid: Number(fields.get("MainPID") ?? 0),
    fragmentPath: fields.get("FragmentPath"),
  };
}

function inspectDatabaseCompatibility(stateDir: string, min: number, max: number, buildId: string): UnifiedEvidenceResult {
  const path = databasePath(stateDir);
  if (!existsSync(path)) return { status: "UNKNOWN", detail: `database not present at ${path}` };
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const ledger = db.prepare("select version, name from kontrol_schema_migrations order by version").all() as Array<{ version: number; name: string }>;
    const current = ledger.at(-1)?.version ?? 0;
    const complete = ledger.length === (current === 0 ? 0 : current)
      && ledger.every((row, index) => row.version === index + 1 && migrationChain[index]?.name === row.name);
    if (!complete) return { status: "FAIL", detail: `database migration ledger is incomplete or mismatched; schema=${current} rows=${ledger.length}` };
    const compatible = current >= min && current <= max;
    return { status: compatible ? "PASS" : "FAIL", detail: `database schema=${current} artifact=${buildId} readable=${min}..${max} migrations=${ledger.length}` };
  } catch (error) {
    return { status: "UNKNOWN", detail: `database schema inspection failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    db?.close();
  }
}

function aggregate(evidence: UnifiedDeploymentReconciliation["evidence"]): UnifiedReconciliationStatus {
  const statuses = Object.values(evidence).map((item) => item.status);
  if (statuses.includes("FAILED")) return "FAILED";
  if (statuses.includes("DRIFT")) return "DRIFT";
  if (statuses.includes("FAIL")) return "DRIFT";
  if (statuses.includes("WARN")) return "DRIFT";
  if (statuses.includes("UNAVAILABLE") || statuses.includes("UNKNOWN")) return "UNKNOWN";
  return "PASS";
}

function readJsonFile<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

function stringField(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function numberField(value: unknown): number | undefined { return typeof value === "number" && Number.isInteger(value) ? value : undefined; }

