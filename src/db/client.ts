import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { LATEST_SCHEMA_VERSION, assertDatabaseSchemaContract, migrateDatabase } from "./migrations.js";
import { captureMigrationBackup, markMigrationCompleted, markMigrationFailed } from "./deployment-backup.js";
import type { DeploymentContext } from "../runtime-context.js";

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

/**
 * Open an existing database for inspection only. This deliberately does not
 * create the state directory, change file permissions, set journal mode,
 * checkpoint WAL, create a backup, or run migrations. The full schema
 * contract is checked through SQLite's read-only connection before callers
 * receive the handle.
 */
export function inspectDatabase(stateDir: string): DatabaseHandle {
  const path = databasePath(stateDir);
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    assertDatabaseSchemaContract(sqlite);
    return {
      sqlite,
      db: createDrizzleDatabase(sqlite),
      close: () => sqlite.close(),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

/**
 * P0.3: deployment identity arrives via an explicit DeploymentContext, never
 * read from process.env deep inside the DB layer. Callers that predate the
 * context (tests, CLI utilities without a deployment) may omit it.
 */
export function openDatabase(stateDir: string, deploymentContext: DeploymentContext = {}): DatabaseHandle {
  const path = databasePath(stateDir);
  const existedBeforeOpen = existsSync(path);
  if (!existedBeforeOpen) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const sqlite = new Database(path);
  let migrationAuthorityEstablished = false;
  try {
    let currentVersion = 0;
    try {
      const row = sqlite.prepare("select max(version) as version from kontrol_schema_migrations").get() as { version?: number } | undefined;
      currentVersion = Number(row?.version ?? 0);
    } catch {
      // A new or pre-ledger database starts at version zero.
    }
    const mayUpgradeExistingDatabase = deploymentContext.deploymentId !== undefined
      && deploymentContext.expectedSchemaVersion === LATEST_SCHEMA_VERSION;
    if (existedBeforeOpen && currentVersion < LATEST_SCHEMA_VERSION && !mayUpgradeExistingDatabase) {
      throw new Error(
        `Database migration from schema ${currentVersion} to ${LATEST_SCHEMA_VERSION} requires an authorized deployment context; run Kontrol through its deployment lifecycle.`,
      );
    }
    migrationAuthorityEstablished = true;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    chmodSync(path, 0o600);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("foreign_keys = ON");
    const candidateSchemaVersion = deploymentContext.expectedSchemaVersion ?? LATEST_SCHEMA_VERSION;
    const deploymentId = deploymentContext.deploymentId;
    backupBeforeMigration(
      sqlite,
      path,
      existedBeforeOpen,
      stateDir,
      deploymentId,
      Number.isInteger(candidateSchemaVersion) ? candidateSchemaVersion : LATEST_SCHEMA_VERSION,
    );
    migrateDatabase(sqlite, { deployedBuildId: deploymentContext.expectedBuildId });
    markMigrationCompleted(stateDir, deploymentId, LATEST_SCHEMA_VERSION);
  } catch (error) {
    if (migrationAuthorityEstablished) {
      try {
        markMigrationFailed(stateDir, deploymentContext.deploymentId);
      } catch {
        // Preserve the initialization failure; the connection must still close.
      }
    }
    sqlite.close();
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
