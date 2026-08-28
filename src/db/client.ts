import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { LATEST_SCHEMA_VERSION, migrateDatabase } from "./migrations.js";
import { captureMigrationBackup, markMigrationCompleted, markMigrationFailed } from "./deployment-backup.js";

export type SqliteDatabase = Database.Database;
export type AppDatabase = ReturnType<typeof createDrizzleDatabase>;

export interface DatabaseHandle {
  sqlite: SqliteDatabase;
  db: AppDatabase;
  close(): void;
}

export function databasePath(stateDir: string): string {
  return join(stateDir, "kontrol.sqlite");
}

export function openDatabase(stateDir: string): DatabaseHandle {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const path = databasePath(stateDir);
  const existedBeforeOpen = existsSync(path);
  const sqlite = new Database(path);
  chmodSync(path, 0o600);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const candidateSchemaVersion = Number(process.env.KONTROL_EXPECTED_SCHEMA_VERSION ?? LATEST_SCHEMA_VERSION);
  const deploymentId = process.env.KONTROL_DEPLOYMENT_ID?.trim() || undefined;
  backupBeforeMigration(
    sqlite,
    path,
    existedBeforeOpen,
    stateDir,
    deploymentId,
    Number.isInteger(candidateSchemaVersion) ? candidateSchemaVersion : LATEST_SCHEMA_VERSION,
  );
  try {
    migrateDatabase(sqlite);
    markMigrationCompleted(stateDir, deploymentId, LATEST_SCHEMA_VERSION);
  } catch (error) {
    markMigrationFailed(stateDir, deploymentId);
    throw error;
  }

  return {
    sqlite,
    db: createDrizzleDatabase(sqlite),
    close: () => sqlite.close(),
  };
}

/**
 * Keep a recoverable copy before applying a schema upgrade. SQLite is opened in
 * WAL mode, so checkpoint first and copy only the main database file while no
 * application managers have been created yet. The versioned name prevents a
 * later upgrade from overwriting the copy needed to diagnose an earlier one.
 */
function backupBeforeMigration(
  sqlite: SqliteDatabase,
  path: string,
  existedBeforeOpen: boolean,
  stateDir: string,
  deploymentId: string | undefined,
  candidateSchemaVersion: number,
): void {
  if (!existedBeforeOpen) {
    captureMigrationBackup(sqlite, path, stateDir, deploymentId, candidateSchemaVersion);
    return;
  }

  let currentVersion = 0;
  try {
    const row = sqlite.prepare("select max(version) as version from kontrol_schema_migrations").get() as { version?: number } | undefined;
    currentVersion = Number(row?.version ?? 0);
  } catch {
    // A database without the migration table is a pre-migration database; the
    // first migration will establish the schema and is still worth backing up.
  }
  if (!Number.isFinite(currentVersion) || currentVersion >= LATEST_SCHEMA_VERSION) {
    captureMigrationBackup(sqlite, path, stateDir, deploymentId, candidateSchemaVersion);
    return;
  }

  const backupPath = `${path}.pre-migration-v${Math.max(0, Math.trunc(currentVersion))}-to-v${LATEST_SCHEMA_VERSION}.bak`;
  if (!existsSync(backupPath)) {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    copyFileSync(path, backupPath);
    chmodSync(backupPath, 0o600);
  }
  captureMigrationBackup(sqlite, path, stateDir, deploymentId, candidateSchemaVersion);
}

function createDrizzleDatabase(sqlite: SqliteDatabase) {
  return drizzle(sqlite, { schema });
}
