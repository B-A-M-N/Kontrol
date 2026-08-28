import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "./client.js";
import {
  captureMigrationBackup,
  inspectDatabaseDeployment,
  readDeploymentMigrationRecord,
  restoreDeploymentDatabaseBackup,
} from "./deployment-backup.js";
import { LATEST_SCHEMA_VERSION, migrationChain } from "./migrations.js";

function createPreMigrationDatabase(stateDir: string, version: number) {
  const path = databasePath(stateDir);
  const sqlite = new Database(path);
  sqlite.exec("create table kontrol_schema_migrations (version integer primary key, name text not null, applied_at text not null)");
  for (const migration of migrationChain.slice(0, version)) {
    migration.up(sqlite);
    sqlite.prepare("insert into kontrol_schema_migrations (version, name, applied_at) values (?, ?, ?)")
      .run(migration.version, migration.name, new Date().toISOString());
  }
  sqlite.prepare(
    "insert into workspace_sessions (id, root, status, created_at, last_used_at) values (?, ?, 'active', ?, ?)",
  ).run("actual-a-workspace", "/tmp/actual-a-workspace", "2026-08-27T00:00:00.000Z", "2026-08-27T00:00:00.000Z");
  sqlite.close();
  return path;
}

// Exercise the real client migration path: A is schema 49, openDatabase as B
// upgrades it to schema 50 and records the exact pre-migration image. A later
// B-only table represents work performed after migration but before readiness.
const actual = mkdtempSync(join(tmpdir(), "kontrol-db-actual-ab-"));
const actualDeploymentId = "actual-ab-deployment";
const previousExpectedSchema = process.env.KONTROL_EXPECTED_SCHEMA_VERSION;
const previousDeploymentId = process.env.KONTROL_DEPLOYMENT_ID;
try {
  createPreMigrationDatabase(actual, LATEST_SCHEMA_VERSION - 1);
  process.env.KONTROL_EXPECTED_SCHEMA_VERSION = String(LATEST_SCHEMA_VERSION);
  process.env.KONTROL_DEPLOYMENT_ID = actualDeploymentId;
  const candidate = openDatabase(actual);
  candidate.sqlite.exec("create table candidate_only_after_migration (id text primary key not null)");
  candidate.close();
  const journal = readDeploymentMigrationRecord(actual, actualDeploymentId);
  assert.equal(journal?.originalSchemaVersion, LATEST_SCHEMA_VERSION - 1);
  assert.equal(journal?.candidateSchemaVersion, LATEST_SCHEMA_VERSION);
  assert.equal(journal?.migrationOccurred, true);
  assert.equal(journal?.rollbackRestoreRequired, true);
  const actualRestore = restoreDeploymentDatabaseBackup({
    stateDir: actual,
    deploymentId: actualDeploymentId,
    maxReadableSchemaVersion: LATEST_SCHEMA_VERSION - 1,
    expectedOriginalSchemaVersion: LATEST_SCHEMA_VERSION - 1,
  });
  assert.equal(actualRestore.restored, true);
  const recoveredA = new Database(databasePath(actual), { readonly: true });
  try {
    assert.equal(
      (recoveredA.prepare("select max(version) as version from kontrol_schema_migrations").get() as { version: number }).version,
      LATEST_SCHEMA_VERSION - 1,
    );
    assert.equal(
      (recoveredA.prepare("select root from workspace_sessions where id = ?").get("actual-a-workspace") as { root: string }).root,
      "/tmp/actual-a-workspace",
    );
    assert.throws(() => recoveredA.prepare("select * from candidate_only_after_migration").get(), /no such table/);
  } finally {
    recoveredA.close();
  }
} finally {
  if (previousExpectedSchema === undefined) delete process.env.KONTROL_EXPECTED_SCHEMA_VERSION;
  else process.env.KONTROL_EXPECTED_SCHEMA_VERSION = previousExpectedSchema;
  if (previousDeploymentId === undefined) delete process.env.KONTROL_DEPLOYMENT_ID;
  else process.env.KONTROL_DEPLOYMENT_ID = previousDeploymentId;
  rmSync(actual, { recursive: true, force: true });
}
console.log("deployment-backup: real A(schema 49) -> B(schema 50) migration rollback passed");

function createSchemaChangingFixture(prefix: string) {
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  const deploymentId = `${prefix}-deployment`;
  const path = databasePath(stateDir);
  const initial = openDatabase(stateDir);
  initial.sqlite.prepare(
    "insert into workspace_sessions (id, root, status, created_at, last_used_at) values (?, ?, 'active', ?, ?)",
  ).run("rollback-workspace", "/tmp/rollback-workspace", "2026-08-27T00:00:00.000Z", "2026-08-27T00:00:00.000Z");
  const captured = captureMigrationBackup(initial.sqlite, path, stateDir, deploymentId, LATEST_SCHEMA_VERSION + 1);
  initial.close();
  assert.ok(captured?.backupPath, "schema-changing candidate must capture a deployment-bound backup");
  const inspection = inspectDatabaseDeployment(stateDir, deploymentId, LATEST_SCHEMA_VERSION + 1);

  // This is the B release fixture: a future migration has advanced the live
  // schema after A was stopped, but B will fail before becoming committed.
  const candidate = new Database(path);
  candidate.exec("create table candidate_only_v51 (id text primary key not null)");
  candidate.prepare("insert into kontrol_schema_migrations (version, name, applied_at) values (?, ?, ?)")
    .run(LATEST_SCHEMA_VERSION + 1, "candidate-fixture-v51", new Date().toISOString());
  candidate.close();
  return { stateDir, deploymentId, path, backupPath: captured.backupPath, inspection };
}

// A supports the current schema and has durable data. B migrates to a future
// schema, then rollback must restore A's exact pre-migration image.
const fixture = createSchemaChangingFixture("kontrol-db-rollback-");
try {
  assert.equal(fixture.inspection.originalSchemaVersion, LATEST_SCHEMA_VERSION);
  assert.equal(fixture.inspection.rollbackRestoreRequired, true);
  const restored = restoreDeploymentDatabaseBackup({
    stateDir: fixture.stateDir,
    deploymentId: fixture.deploymentId,
    maxReadableSchemaVersion: LATEST_SCHEMA_VERSION,
    expectedOriginalSchemaVersion: LATEST_SCHEMA_VERSION,
  });
  assert.equal(restored.restored, true);
  assert.ok(restored.failedDatabasePath && existsSync(restored.failedDatabasePath));
  const recovered = new Database(fixture.path, { readonly: true });
  try {
    const version = recovered.prepare("select max(version) as version from kontrol_schema_migrations").get() as { version: number };
    assert.equal(version.version, LATEST_SCHEMA_VERSION, "rollback restored A's readable schema");
    assert.equal(
      (recovered.prepare("select root from workspace_sessions where id = ?").get("rollback-workspace") as { root: string }).root,
      "/tmp/rollback-workspace",
      "rollback preserved A's durable rows",
    );
    assert.throws(() => recovered.prepare("select * from candidate_only_v51").get(), /no such table/);
  } finally {
    recovered.close();
  }
} finally {
  rmSync(fixture.stateDir, { recursive: true, force: true });
}
console.log("deployment-backup: schema-changing A/B rollback restored the exact pre-migration database");

// A corrupt bound backup must fail before the live migrated database is moved,
// leaving the operator a forensic copy of the current state.
const corrupt = createSchemaChangingFixture("kontrol-db-corrupt-backup-");
try {
  writeFileSync(corrupt.backupPath, "not a sqlite database\n");
  assert.throws(
    () => restoreDeploymentDatabaseBackup({
      stateDir: corrupt.stateDir,
      deploymentId: corrupt.deploymentId,
      maxReadableSchemaVersion: LATEST_SCHEMA_VERSION,
      expectedOriginalSchemaVersion: LATEST_SCHEMA_VERSION,
    }),
    /not a database|file is not a database|SQLITE_NOTADB|schema mismatch/i,
    "corrupt backup must fail closed",
  );
  const stillMigrated = new Database(corrupt.path, { readonly: true });
  try {
    const version = stillMigrated.prepare("select max(version) as version from kontrol_schema_migrations").get() as { version: number };
    assert.equal(version.version, LATEST_SCHEMA_VERSION + 1, "corrupt backup must not overwrite the migrated live DB");
  } finally {
    stillMigrated.close();
  }
} finally {
  rmSync(corrupt.stateDir, { recursive: true, force: true });
}
console.log("deployment-backup: corrupt backup failed closed without touching the migrated database");

// A same-schema restart does not need a database restore or a backup file.
const sameSchema = mkdtempSync(join(tmpdir(), "kontrol-db-same-schema-"));
try {
  const db = openDatabase(sameSchema);
  const deploymentId = "same-schema-deployment";
  const captured = captureMigrationBackup(db.sqlite, databasePath(sameSchema), sameSchema, deploymentId, LATEST_SCHEMA_VERSION);
  db.close();
  assert.equal(captured?.backupPath, undefined);
  const result = restoreDeploymentDatabaseBackup({
    stateDir: sameSchema,
    deploymentId,
    maxReadableSchemaVersion: LATEST_SCHEMA_VERSION,
  });
  assert.equal(result.restored, false);
  assert.equal(result.required, false);
  assert.equal(readDeploymentMigrationRecord(sameSchema, deploymentId)?.rollbackRestoreRequired, false);
} finally {
  rmSync(sameSchema, { recursive: true, force: true });
}
console.log("deployment-backup.test.ts: all assertions passed");
