import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "./client.js";
import { LATEST_SCHEMA_VERSION, migrateDatabase } from "./migrations.js";

const sqlite = new Database(":memory:");
sqlite.pragma("foreign_keys = ON");
try {
  migrateDatabase(sqlite);
  assert.ok(
    (sqlite.prepare("pragma table_info(work_session_submissions)").all() as Array<{ name: string }>)
      .some((column) => column.name === "files_json"),
    "submission file metadata column is present after migration",
  );

  sqlite.exec("drop index if exists agent_registry_name_unique");
  sqlite.prepare(`
    insert into agent_registry
      (id, name, url, last_heartbeat, created_at, role)
    values (?, ?, ?, ?, ?, ?)
  `).run("agent_old", "duplicate", "http://old", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z", "agent");
  sqlite.prepare(`
    insert into agent_registry
      (id, name, url, last_heartbeat, created_at, role)
    values (?, ?, ?, ?, ?, ?)
  `).run("agent_new", "duplicate", "http://new", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "agent");
  sqlite.prepare(`
    insert into acp_runs (run_id, agent_name, agent_id, status, created_at)
    values (?, ?, ?, ?, ?)
  `).run("run_old", "duplicate", "agent_old", "completed", "2025-01-02T00:00:00.000Z");
  sqlite.prepare("delete from kontrol_schema_migrations where version >= 37").run();

  migrateDatabase(sqlite);
  const agents = sqlite.prepare("select id, name from agent_registry where name = ?").all("duplicate") as Array<{ id: string; name: string }>;
  assert.deepEqual(agents, [{ id: "agent_new", name: "duplicate" }]);
  assert.equal(
    (sqlite.prepare("select agent_id from acp_runs where run_id = ?").get("run_old") as { agent_id: string }).agent_id,
    "agent_new",
    "historical runs are re-homed to the canonical identity",
  );
  assert.equal(
    (sqlite.prepare("select canonical_agent_id from agent_registry_identity_aliases where legacy_agent_id = ?").get("agent_old") as { canonical_agent_id: string }).canonical_agent_id,
    "agent_new",
  );

  sqlite.prepare("insert into kontrol_schema_migrations (version, name, applied_at) values (?, ?, ?)").run(
    LATEST_SCHEMA_VERSION + 1,
    "future-schema",
    new Date().toISOString(),
  );
  assert.throws(
    () => migrateDatabase(sqlite),
    /newer than this Kontrol build/,
    "future schema versions fail closed",
  );
} finally {
  sqlite.close();
}

const backupRoot = mkdtempSync(join(tmpdir(), "kontrol-migration-backup-"));
try {
  const initial = openDatabase(backupRoot);
  initial.close();
  const path = databasePath(backupRoot);
  const downgraded = new Database(path);
  downgraded.prepare("delete from kontrol_schema_migrations where version = ?").run(LATEST_SCHEMA_VERSION);
  downgraded.close();

  const upgraded = openDatabase(backupRoot);
  upgraded.close();
  const backupPath = `${path}.pre-migration-v${LATEST_SCHEMA_VERSION - 1}-to-v${LATEST_SCHEMA_VERSION}.bak`;
  assert.ok(existsSync(backupPath), "schema upgrades retain a versioned recoverable database backup");
  const backup = new Database(backupPath, { readonly: true });
  try {
    const backupVersion = backup.prepare("select max(version) as version from kontrol_schema_migrations").get() as { version: number };
    assert.equal(
      backupVersion.version,
      LATEST_SCHEMA_VERSION - 1,
      "the rollback copy remains at the pre-upgrade schema version",
    );
  } finally {
    backup.close();
  }
} finally {
  rmSync(backupRoot, { recursive: true, force: true });
}

console.log("migrations.test.ts: all assertions passed");
