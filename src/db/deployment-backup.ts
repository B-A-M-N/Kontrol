import { copyFileSync, existsSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
}): RestoreDatabaseResult {
  const { stateDir, deploymentId, maxReadableSchemaVersion, expectedOriginalSchemaVersion } = options;
  const record = readDeploymentMigrationRecord(stateDir, deploymentId);
  const databasePath = record?.databasePath ?? join(stateDir, "kontrol.sqlite");
  const currentSchemaVersion = currentDatabaseSchema(databasePath);
  const required = currentSchemaVersion > maxReadableSchemaVersion;
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
