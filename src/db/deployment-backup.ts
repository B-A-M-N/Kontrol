import { copyFileSync, existsSync, chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";

export interface DeploymentMigrationRecord {
  deploymentId: string;
  databasePath: string;
  backupPath?: string;
  originalSchemaVersion: number;
  candidateSchemaVersion: number;
  currentSchemaVersion: number;
  migrationOccurred: boolean;
  migrationFailed: boolean;
  rollbackRestoreRequired: boolean;
  restoredAt?: string;
  failedDatabasePath?: string;
  updatedAt: string;
}

export interface DatabaseDeploymentState {
  deploymentId: string;
  databasePath: string;
  originalSchemaVersion: number;
  candidateSchemaVersion: number;
  rollbackRestoreRequired: boolean;
  backupPath?: string;
}

function safeDeploymentId(deploymentId: string): string {
  const safe = deploymentId.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safe) throw new Error("deployment ID must contain at least one safe filename character");
  return safe;
}

export function deploymentMigrationRecordPath(stateDir: string, deploymentId: string): string {
  return join(stateDir, `database-migration.${safeDeploymentId(deploymentId)}.json`);
}

function deploymentBackupDirectory(stateDir: string, deploymentId: string): string {
  return join(stateDir, "deployment-databases", safeDeploymentId(deploymentId));
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readDeploymentMigrationRecord(stateDir: string, deploymentId: string): DeploymentMigrationRecord | undefined {
  try {
    return JSON.parse(readFileSync(deploymentMigrationRecordPath(stateDir, deploymentId), "utf8")) as DeploymentMigrationRecord;
  } catch {
    return undefined;
  }
}

function schemaVersion(sqlite: Database.Database): number {
  try {
    const row = sqlite.prepare("select max(version) as version from kontrol_schema_migrations").get() as { version?: number } | undefined;
    const value = Number(row?.version ?? 0);
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  } catch {
    return 0;
  }
}

export function inspectDatabaseDeployment(
  stateDir: string,
  deploymentId: string,
  candidateSchemaVersion: number,
): DatabaseDeploymentState {
  const databasePath = join(stateDir, "kontrol.sqlite");
  if (!existsSync(databasePath)) {
    return {
      deploymentId,
      databasePath,
      originalSchemaVersion: 0,
      candidateSchemaVersion,
      rollbackRestoreRequired: false,
    };
  }
  const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const originalSchemaVersion = schemaVersion(sqlite);
    const prior = readDeploymentMigrationRecord(stateDir, deploymentId);
    return {
      deploymentId,
      databasePath,
      originalSchemaVersion,
      candidateSchemaVersion,
      rollbackRestoreRequired: candidateSchemaVersion > originalSchemaVersion,
      ...(prior?.backupPath ? { backupPath: prior.backupPath } : {}),
    };
  } finally {
    sqlite.close();
  }
}

/**
 * Capture the exact pre-migration database for one deployment transaction.
 * The generic versioned backup remains for operator diagnostics, while the
 * deployment-scoped copy is the only backup accepted by rollback.
 */
export function captureMigrationBackup(
  sqlite: Database.Database,
  databasePath: string,
  stateDir: string,
  deploymentId: string | undefined,
  candidateSchemaVersion: number,
): DeploymentMigrationRecord | undefined {
  if (!deploymentId) return undefined;

  const originalSchemaVersion = schemaVersion(sqlite);
  const existing = readDeploymentMigrationRecord(stateDir, deploymentId);
  if (existing?.backupPath && existsSync(existing.backupPath)) return existing;

  const recordPath = deploymentMigrationRecordPath(stateDir, deploymentId);
  const shouldBackup = existsSync(databasePath) && candidateSchemaVersion > originalSchemaVersion;
  let backupPath: string | undefined;
  if (shouldBackup) {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    const backupDirectory = deploymentBackupDirectory(stateDir, deploymentId);
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    backupPath = join(
      backupDirectory,
      `kontrol.sqlite.pre-migration-v${originalSchemaVersion}-to-v${candidateSchemaVersion}.bak`,
    );
    if (!existsSync(backupPath)) {
      copyFileSync(databasePath, backupPath);
      chmodSync(backupPath, 0o600);
    }
  }

  const record: DeploymentMigrationRecord = {
    deploymentId,
    databasePath,
    ...(backupPath ? { backupPath } : {}),
    originalSchemaVersion,
    candidateSchemaVersion,
    currentSchemaVersion: originalSchemaVersion,
    migrationOccurred: false,
    migrationFailed: false,
    rollbackRestoreRequired: Boolean(backupPath),
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(recordPath, record);
  return record;
}

export function markMigrationCompleted(
  stateDir: string,
  deploymentId: string | undefined,
  currentSchemaVersion: number,
): void {
  if (!deploymentId) return;
  const prior = readDeploymentMigrationRecord(stateDir, deploymentId);
  if (!prior) return;
  writeJsonAtomic(deploymentMigrationRecordPath(stateDir, deploymentId), {
    ...prior,
    currentSchemaVersion,
    migrationOccurred: currentSchemaVersion > prior.originalSchemaVersion,
    migrationFailed: false,
    updatedAt: new Date().toISOString(),
  } satisfies DeploymentMigrationRecord);
}

export function markMigrationFailed(stateDir: string, deploymentId: string | undefined): void {
  if (!deploymentId) return;
  const prior = readDeploymentMigrationRecord(stateDir, deploymentId);
  if (!prior) return;
  writeJsonAtomic(deploymentMigrationRecordPath(stateDir, deploymentId), {
    ...prior,
    migrationFailed: true,
    updatedAt: new Date().toISOString(),
  } satisfies DeploymentMigrationRecord);
}

/**
 * End the immediate rollback window only after the owning service deployment
 * has committed and the live database still matches the candidate schema.
 * The active service manifest keeps this backup protected until a later
 * committed generation replaces it.
 */
export function markMigrationRollbackWindowComplete(stateDir: string, deploymentId: string): boolean {
  const prior = readDeploymentMigrationRecord(stateDir, deploymentId);
  if (!prior?.backupPath) return false;
  if (prior.migrationFailed || prior.restoredAt || !prior.migrationOccurred || !prior.rollbackRestoreRequired || !existsSync(prior.backupPath)) return false;
  const current = currentDatabaseSchema(prior.databasePath);
  if (current !== prior.candidateSchemaVersion || prior.currentSchemaVersion !== current) {
    throw new Error(`cannot close deployment ${deploymentId} rollback window: database schema ${current} does not match completed candidate schema ${prior.candidateSchemaVersion}`);
  }
  writeJsonAtomic(deploymentMigrationRecordPath(stateDir, deploymentId), {
    ...prior,
    rollbackRestoreRequired: false,
    updatedAt: new Date().toISOString(),
  } satisfies DeploymentMigrationRecord);
  return true;
}

/**
 * Return IDs whose migration backups are still referenced by the installed
 * production state or an unfinished service transaction. Undefined means
 * authority is missing or ambiguous and cleanup must retain everything.
 */
export function protectedMigrationBackupDeploymentIds(stateDir: string): Set<string> | undefined {
  const servicePath = join(stateDir, "service.json");
  if (!existsSync(servicePath)) return undefined;
  const service = readJsonRecord(servicePath);
  if (!service || typeof service.deploymentId !== "string" || !service.deploymentId) return undefined;
  const protectedIds = new Set([service.deploymentId]);

  for (const name of readdirSync(stateDir)) {
    if (!/^deployment\..+\.json$/.test(name)) continue;
    const journal = readJsonRecord(join(stateDir, name));
    if (!journal || typeof journal.deploymentId !== "string" || !journal.deploymentId) return undefined;
    const stage = journal.stage;
    const status = journal.status;
    if (stage === undefined && status === undefined) return undefined;
    const terminal = stage !== undefined
      ? stage === "commit" || stage === "failed"
      : status === "committed" || status === "failed";
    if (!terminal) protectedIds.add(journal.deploymentId);
  }
  return protectedIds;
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prune unreferenced completed migration backups after retention. Protected
 * generations and incomplete rollback records are never removed.
 */
export function pruneUnreferencedMigrationBackups(
  stateDir: string,
  protectedDeploymentIds: ReadonlySet<string>,
  retentionMs: number,
  now = Date.now(),
): string[] {
  const root = join(stateDir, "deployment-databases");
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const deploymentId of readdirSync(root)) {
    if (protectedDeploymentIds.has(deploymentId)) continue;
    const record = readDeploymentMigrationRecord(stateDir, deploymentId);
    if (!record || record.migrationFailed || record.rollbackRestoreRequired) continue;
    const updatedAt = Date.parse(record.updatedAt);
    if (!Number.isFinite(updatedAt) || now - updatedAt <= retentionMs) continue;
    const target = join(root, deploymentId);
    rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}

function currentDatabaseSchema(databasePath: string): number {
  if (!existsSync(databasePath)) return 0;
  const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return schemaVersion(sqlite);
  } finally {
    sqlite.close();
  }
}

function verifyBackup(backupPath: string, expectedSchemaVersion: number, maxReadableSchemaVersion: number): void {
  if (!existsSync(backupPath)) throw new Error(`deployment migration backup is missing: ${backupPath}`);
  const sqlite = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const backupSchemaVersion = schemaVersion(sqlite);
    if (backupSchemaVersion !== expectedSchemaVersion) {
      throw new Error(`deployment migration backup schema mismatch: expected ${expectedSchemaVersion}, got ${backupSchemaVersion}`);
    }
    if (backupSchemaVersion > maxReadableSchemaVersion) {
      throw new Error(`deployment migration backup schema ${backupSchemaVersion} exceeds rollback build limit ${maxReadableSchemaVersion}`);
    }
    const integrity = sqlite.prepare("pragma quick_check").get() as { quick_check?: string } | undefined;
    if (integrity?.quick_check !== "ok") {
      throw new Error(`deployment migration backup failed quick_check: ${integrity?.quick_check ?? "no result"}`);
    }
  } finally {
    sqlite.close();
  }
}

export interface RestoreDatabaseResult {
  deploymentId: string;
  restored: boolean;
  required: boolean;
  currentSchemaVersion: number;
  backupPath?: string;
  failedDatabasePath?: string;
}

/**
 * Restore only the exact backup captured by this deployment. Verification is
 * completed before the live database is moved, so a corrupt backup leaves the
 * migrated database untouched and the controller can fail loudly.
 */
export function restoreDeploymentDatabaseBackup(options: {
  stateDir: string;
  deploymentId: string;
  maxReadableSchemaVersion: number;
  expectedOriginalSchemaVersion?: number;
  /**
   * Live schema snapshotted before this deployment mutated anything. The
   * restore is required only when the deployment itself raised the schema
   * past this baseline: a database that was already newer than the rollback
   * target before the deployment (migrated out-of-band) is left untouched,
   * since there is nothing this deployment did to undo.
   */
  preMutationSchemaVersion?: number;
}): RestoreDatabaseResult {
  const { stateDir, deploymentId, maxReadableSchemaVersion, expectedOriginalSchemaVersion, preMutationSchemaVersion } = options;
  const record = readDeploymentMigrationRecord(stateDir, deploymentId);
  const databasePath = record?.databasePath ?? join(stateDir, "kontrol.sqlite");
  const currentSchemaVersion = currentDatabaseSchema(databasePath);
  const baseline = Math.max(preMutationSchemaVersion ?? maxReadableSchemaVersion, maxReadableSchemaVersion);
  const required = currentSchemaVersion > baseline;
  if (!required) {
    return {
      deploymentId,
      restored: false,
      required: false,
      currentSchemaVersion,
      ...(record?.backupPath ? { backupPath: record.backupPath } : {}),
    };
  }
  if (!record?.backupPath || !record.rollbackRestoreRequired) {
    throw new Error(`database schema ${currentSchemaVersion} exceeds rollback build limit ${maxReadableSchemaVersion}, but deployment ${deploymentId} has no bound pre-migration backup`);
  }
  if (expectedOriginalSchemaVersion !== undefined && record.originalSchemaVersion !== expectedOriginalSchemaVersion) {
    throw new Error(`deployment migration journal original schema mismatch: expected ${expectedOriginalSchemaVersion}, got ${record.originalSchemaVersion}`);
  }
  verifyBackup(record.backupPath, record.originalSchemaVersion, maxReadableSchemaVersion);

  const stamp = `${deploymentId}-${Date.now()}`.replace(/[^A-Za-z0-9._-]/g, "_");
  const failedDatabasePath = join(stateDir, `kontrol.sqlite.failed-migration-${stamp}.bak`);
  const restorePath = `${databasePath}.restore-${process.pid}`;
  copyFileSync(record.backupPath, restorePath);
  chmodSync(restorePath, 0o600);
  renameSync(databasePath, failedDatabasePath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${databasePath}${suffix}`;
    if (existsSync(sidecar)) renameSync(sidecar, `${failedDatabasePath}${suffix}`);
  }
  renameSync(restorePath, databasePath);

  const restoredAt = new Date().toISOString();
  writeJsonAtomic(deploymentMigrationRecordPath(stateDir, deploymentId), {
    ...record,
    currentSchemaVersion: record.originalSchemaVersion,
    restoredAt,
    failedDatabasePath,
    updatedAt: restoredAt,
  } satisfies DeploymentMigrationRecord);
  return {
    deploymentId,
    restored: true,
    required: true,
    currentSchemaVersion,
    backupPath: record.backupPath,
    failedDatabasePath,
  };
}

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const stateDir = value("--state-dir");
  const deploymentId = value("--deployment-id");
  if (!stateDir || !deploymentId) throw new Error("deployment-backup requires --state-dir and --deployment-id");
  if (command === "inspect") {
    const candidateSchemaVersion = Number(value("--candidate-schema-version") ?? 0);
    console.log(JSON.stringify(inspectDatabaseDeployment(stateDir, deploymentId, candidateSchemaVersion)));
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify(readDeploymentMigrationRecord(stateDir, deploymentId) ?? { deploymentId, found: false }));
    return;
  }
  if (command === "restore") {
    const maxReadableSchemaVersion = Number(value("--max-readable-schema-version"));
    if (!Number.isInteger(maxReadableSchemaVersion)) throw new Error("restore requires --max-readable-schema-version");
    const expectedOriginal = value("--expected-original-schema-version");
    console.log(JSON.stringify(restoreDeploymentDatabaseBackup({
      stateDir,
      deploymentId,
      maxReadableSchemaVersion,
      ...(expectedOriginal === undefined ? {} : { expectedOriginalSchemaVersion: Number(expectedOriginal) }),
    })));
    return;
  }
  throw new Error("Usage: deployment-backup {inspect|status|restore} --state-dir PATH --deployment-id ID");
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("deployment-backup.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
