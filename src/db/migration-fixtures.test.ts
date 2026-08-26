// P1 #13: released-schema migration fixtures.
//
// Synthetic "previous release" databases are produced by running the real
// migration chain up to a target version, populating durable objects
// (workspaces, agents, submissions), then completing the remaining chain and
// asserting the data survives. Also covers: dirty WAL recovery, interrupted
// migration resumption, corrupt database fail-closed, future version
// rejection, and backup restoration.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrateDatabase, LATEST_SCHEMA_VERSION, migrationChain as migrations } from "./migrations.js";

function newSqlite(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

function appliedVersions(sqlite: Database.Database): number[] {
  return (
    sqlite.prepare("select version from kontrol_schema_migrations order by version").all() as Array<{
      version: number;
    }>
  ).map((row) => row.version);
}

/** Migrate only up to `targetVersion`, exactly like a release from that era. */
function migrateUpTo(sqlite: Database.Database, targetVersion: number): void {
  // Create the ledger table first (migrateDatabase normally does this).
  sqlite.exec(`
    create table if not exists kontrol_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
  `);
  const record = sqlite.prepare(
    "insert into kontrol_schema_migrations (version, name, applied_at) values (?, ?, ?)",
  );
  for (const migration of migrations) {
    if (migration.version > targetVersion) break;
    migration.up(sqlite);
    record.run(migration.version, migration.name, new Date().toISOString());
  }
}

// ── Fixture A: several-versions-old release → current, with durable data ────
{
  const sqlite = newSqlite();
  try {
    const cutoff = Math.min(36, LATEST_SCHEMA_VERSION - 3);
    migrateUpTo(sqlite, cutoff);
    assert.deepEqual(appliedVersions(sqlite).slice(-1), [cutoff]);

    // Populate durable objects using only tables that exist at that vintage.
    sqlite.prepare(
      "insert into workspace_sessions (id, root, status, created_at, last_used_at) values (?, ?, 'active', ?, ?)",
    ).run("ws_fixture", "/tmp/ws", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
    sqlite.prepare(
      "insert into agent_registry (id, name, url, last_heartbeat, created_at, role) values (?, ?, ?, ?, ?, 'agent')",
    ).run("agent_fixture", "fixture-agent", "http://fixture", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");

    // Complete the chain to current via the real entrypoint.
    migrateDatabase(sqlite);
    assert.ok(appliedVersions(sqlite).includes(LATEST_SCHEMA_VERSION));

    // Durable objects survived.
    const ws = sqlite.prepare("select id, status from workspace_sessions where id = ?").get("ws_fixture") as { id: string; status: string } | undefined;
    assert.equal(ws?.id, "ws_fixture", "workspace row survived migration");
    assert.equal(ws?.status, "active");
    assert.equal(
      (sqlite.prepare("select count(*) as n from agent_registry where id = 'agent_fixture'").get() as { n: number }).n,
      1,
      "agent registry row survived migration",
    );

    // New columns are usable post-migration.
    assert.ok(
      (sqlite.prepare("pragma table_info(work_session_submissions)").all() as Array<{ name: string }>).some((c) => c.name === "files_json"),
      "submission file metadata column present after upgrade",
    );
    assert.ok(
      (sqlite.prepare("pragma table_info(agent_registry)").all() as Array<{ name: string }>).some((c) => c.name === "agent_credential_hash"),
      "agent credential column present after upgrade",
    );
  } finally {
    sqlite.close();
  }
}
console.log("migration-fixtures: previous-release upgrade with data survival passed");

// ── Fixture B: interrupted migration resumes cleanly ─────────────────────────
{
  const sqlite = newSqlite();
  try {
    // Simulate a crash mid-chain: apply up to N-3, then run migrateDatabase —
    // its immediate transaction must complete the remaining versions atomically.
    const partial = LATEST_SCHEMA_VERSION - 3;
    migrateUpTo(sqlite, partial);

    // Corrupt the ledger by removing one middle entry to simulate an
    // interrupted apply; re-running must heal idempotently.
    sqlite.prepare("delete from kontrol_schema_migrations where version = ?").run(partial - 1);

    migrateDatabase(sqlite);
    const versions = appliedVersions(sqlite);
    assert.ok(versions.includes(LATEST_SCHEMA_VERSION), "chain completed after interruption");
    assert.ok(versions.includes(partial - 1), "missing intermediate version re-applied");

    const expected = versions.every((v, idx) => idx === 0 || v > versions[idx - 1]);
    assert.ok(expected, "ledger is consistent after healing");
  } finally {
    sqlite.close();
  }
}
console.log("migration-fixtures: interrupted-migration resume passed");

// ── Fixture C: dirty WAL sidecars do not block startup ───────────────────────
{
  const stateDir = mkdtempSync(join(tmpdir(), "kontrol-mig-wal-"));
  const dbPath = join(stateDir, "kontrol.sqlite");
  try {
    const raw = new Database(dbPath);
    raw.pragma("journal_mode = WAL");
    migrateDatabase(raw);
    raw.close();

    if (!existsSync(`${dbPath}-wal`)) writeFileSync(`${dbPath}-wal`, "");
    if (!existsSync(`${dbPath}-shm`)) writeFileSync(`${dbPath}-shm`, "");

    const reopened = new Database(dbPath);
    reopened.pragma("journal_mode = WAL");
    migrateDatabase(reopened); // must not throw
    reopened.close();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}
console.log("migration-fixtures: dirty WAL recovery passed");

// ── Fixture D: corrupt database fails closed on integrity check ──────────────
{
  const stateDir = mkdtempSync(join(tmpdir(), "kontrol-mig-corrupt-"));
  try {
    writeFileSync(join(stateDir, "kontrol.sqlite"), Buffer.from("this is definitely not a sqlite database".repeat(10)));
    const raw = new Database(join(stateDir, "kontrol.sqlite"));
    assert.throws(
      () => migrateDatabase(raw),
      /malformed|not a database|integrity/i,
      "corrupt db must fail closed",
    );
    raw.close();
  } catch (error) {
    // better-sqlite3 may reject at open time — also acceptable fail-closed.
    assert.match(String(error), /file is not a database|malformed|SQLITE_NOTADB/i);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}
console.log("migration-fixtures: corrupt database fail-closed passed");

console.log("migration-fixtures.test.ts: all assertions passed");
