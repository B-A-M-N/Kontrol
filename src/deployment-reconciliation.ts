import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { isRuntimeIdentityLive, readRuntimeIdentity } from "./runtime-identity.js";
import { databasePath } from "./db/client.js";

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
