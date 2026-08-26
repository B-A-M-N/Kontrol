import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { LATEST_SCHEMA_VERSION, migrateDatabase } from "./migrations.js";

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
  backupBeforeMigration(sqlite, path, existedBeforeOpen);
  migrateDatabase(sqlite);

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
function backupBeforeMigration(sqlite: SqliteDatabase, path: string, existedBeforeOpen: boolean): void {
  if (!existedBeforeOpen) return;

  let currentVersion = 0;
  try {
    const row = sqlite.prepare("select max(version) as version from kontrol_schema_migrations").get() as { version?: number } | undefined;
    currentVersion = Number(row?.version ?? 0);
  } catch {
    // A database without the migration table is a pre-migration database; the
    // first migration will establish the schema and is still worth backing up.
  }
  if (!Number.isFinite(currentVersion) || currentVersion >= LATEST_SCHEMA_VERSION) return;

  const backupPath = `${path}.pre-migration-v${Math.max(0, Math.trunc(currentVersion))}-to-v${LATEST_SCHEMA_VERSION}.bak`;
  if (existsSync(backupPath)) return;
  sqlite.pragma("wal_checkpoint(TRUNCATE)");
  copyFileSync(path, backupPath);
  chmodSync(backupPath, 0o600);
}

function createDrizzleDatabase(sqlite: SqliteDatabase) {
  return drizzle(sqlite, { schema });
}
