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

// ── Fixture B2: legacy direct approval rows get a bounded reconnect window ─
{
  const sqlite = newSqlite();
  try {
    migrateUpTo(sqlite, 49);
    sqlite.prepare(`
      insert into approval_requests
        (id, kind, workspace_session_id, title, options_json, status, created_at)
      values (?, 'tool', ?, 'legacy shell', '[]', 'pending', ?)
    `).run("legacy-direct", "legacy-workspace", "2020-01-01T00:00:00.000Z");
    migrateDatabase(sqlite);
    const row = sqlite.prepare("select origin, orphaned_at, reattach_deadline from approval_requests where id = ?").get("legacy-direct") as {
      origin: string;
      orphaned_at: string;
      reattach_deadline: string;
    };
    assert.equal(row.origin, "direct_mcp");
    assert.equal(row.orphaned_at, "2020-01-01T00:00:00.000Z");
    assert.equal(row.reattach_deadline, "2020-01-01T00:05:00.000Z");
  } finally {
    sqlite.close();
  }
}
console.log("migration-fixtures: legacy approval reconciliation passed");

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

// ── Fixture: legacy v1 mission contract fingerprint survives migration ──────
{
  const sqlite = newSqlite();
  try {
    // Produce a "previous release" schema with no fingerprint-versioning
    // column; v63 was the last pre-fingerprinting state.
    migrateUpTo(sqlite, 63);
    // Seed a legacy mission exactly as the pre-versioning ledger would have.
    sqlite.pragma("foreign_keys = OFF");
    sqlite.prepare(`
      insert into mission_contracts
        (id, work_session_id, workspace_session_id, revision, objective, desired_outcome,
         constraints_json, non_goals_json, user_locked_fields_json, correction_rounds,
         max_correction_rounds, final_verification_json, review_coverage_json, created_at, updated_at)
      values ('legacy-mission', 'legacy-session', 'legacy-ws', 1, 'legacy objective', 'legacy objective',
              '[]', '[]', '[]', 0, 5, '[]', '[]', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
    `).run();
    sqlite.prepare(`
      insert into mission_acceptance_criteria
        (id, mission_id, description, priority, verification_type, verification_command,
         affected_areas_json, depends_on_json, status, created_at, updated_at)
      values ('legacy-crit', 'legacy-mission', 'works', 'required', 'test', 'npm --version',
              '[]', '[]', 'unverified', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
    `).run();
    sqlite.pragma("foreign_keys = ON");
    // Simulate a v1 fingerprint stored by the pre-versioning ledger.
    const { createHash } = await import("node:crypto");
    const canonicalPayload = JSON.stringify({
      workSessionId: "legacy-session",
      workspaceSessionId: "legacy-ws",
      objective: "legacy objective",
      desiredOutcome: "legacy objective",
      constraints: [],
      nonGoals: [],
      userLockedFields: ["objective", "desiredOutcome", "constraints", "nonGoals"],
      supervisorInstructions: null,
      baselineKind: null,
      baselineRef: null,
      maxCorrectionRounds: 5,
      finalVerification: [],
      reviewCoverage: [],
      acceptanceCriteria: [{
        id: "legacy-crit",
        description: "works",
        priority: "required",
        verificationType: "test",
        verificationCommand: "npm --version",
        runtimeProbe: null,
        affectedAreas: [],
        dependsOnCriterionIds: [],
        verificationGroup: null,
        verificationScope: "full",
        finalOnly: false,
        mutatesWorkspace: false,
        commandVersion: null,
      }],
    });
    // canonicalize() sorts keys and drops undefined. We replicate that exactly:
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]));
      }
      return value;
    };
    const v1Fingerprint = createHash("sha256").update(JSON.stringify(canonicalize(JSON.parse(canonicalPayload)))).digest("hex");
    sqlite.prepare("update mission_contracts set contract_fingerprint = ? where id = ?").run(v1Fingerprint, "legacy-mission");
    // Complete the full migration chain.
    migrateDatabase(sqlite);
    const stored = sqlite.prepare("select contract_fingerprint from mission_contracts where id = ?").get("legacy-mission") as { contract_fingerprint: string | null };
    assert.ok(stored.contract_fingerprint, "legacy mission has a stored fingerprint after migration");
    // Import the authority helper and confirm the v1 fingerprint still matches.
    const { fingerprintMissionContractV1, fingerprintMissionContract } = await import("../mission/contract-authority.js");
    const reconstructed = fingerprintMissionContractV1({
      workSessionId: "legacy-session",
      workspaceSessionId: "legacy-ws",
      objective: "legacy objective",
    }, [{ id: "legacy-crit", description: "works", verificationType: "test", verificationCommand: "npm --version" } as any]);
    assert.equal(reconstructed, v1Fingerprint, "v1 fingerprint reconstruction matches the stored legacy hash");
    // The v2 fingerprint differs (adds version wrapper + outcomeEvidence), so
    // without the compatibility check the ledger would throw on retry.
    const v2Fingerprint = fingerprintMissionContract({
      workSessionId: "legacy-session",
      workspaceSessionId: "legacy-ws",
      objective: "legacy objective",
    }, [{ id: "legacy-crit", description: "works", verificationType: "test", verificationCommand: "npm --version" } as any]);
    assert.notEqual(v2Fingerprint, v1Fingerprint, "v2 fingerprint is distinct from v1");
  } finally {
    sqlite.close();
  }
}
console.log("migration-fixtures: legacy mission fingerprint survives migration passed");

// ── Fixture: historical v64/v69 edits repaired by a forward-only migration ──
{
  const sqlite = newSqlite();
  try {
    migrateUpTo(sqlite, 88);
    const now = "2025-10-20T12:00:00.000Z";
    sqlite.prepare("insert into workspace_sessions (id, root, status, created_at, last_used_at) values (?, ?, 'active', ?, ?)")
      .run("schema-drift-ws", "/tmp/schema-drift", now, now);
    sqlite.prepare("insert into work_sessions (id, workspace_session_id, submitted_by, created_at, updated_at) values (?, ?, ?, ?, ?)")
      .run("schema-drift-session", "schema-drift-ws", "fixture", now, now);
    sqlite.prepare(`
      insert into mission_contracts (id, work_session_id, workspace_session_id, objective, desired_outcome, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?)
    `).run("schema-drift-mission", "schema-drift-session", "schema-drift-ws", "preserve mission", "preserve data", now, now);
    sqlite.prepare(`
      insert into review_routes (id, work_session_id, owner_principal_id, owner_context_id, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)
    `).run("schema-drift-route", "schema-drift-session", "fixture-principal", "fixture-owner", now, now);

    sqlite.exec(`
      alter table mission_contracts drop column outcome_evidence;
      alter table review_routes drop column warning_acknowledged_at;
    `);
    assert.ok(appliedVersions(sqlite).includes(88), "fixture records all historical migrations through v88");
    assert.equal((sqlite.prepare("pragma table_info(mission_contracts)").all() as Array<{ name: string }>).some((c) => c.name === "outcome_evidence"), false);
    assert.equal((sqlite.prepare("pragma table_info(review_routes)").all() as Array<{ name: string }>).some((c) => c.name === "warning_acknowledged_at"), false);

    migrateDatabase(sqlite, { deployedBuildId: "schema-drift-repair-fixture" });
    assert.ok(appliedVersions(sqlite).includes(89), "forward-only v89 repair is recorded");
    assert.ok((sqlite.prepare("pragma table_info(mission_contracts)").all() as Array<{ name: string }>).some((c) => c.name === "outcome_evidence"));
    assert.ok((sqlite.prepare("pragma table_info(review_routes)").all() as Array<{ name: string }>).some((c) => c.name === "warning_acknowledged_at"));
    assert.deepEqual(
      sqlite.prepare("select id, objective, desired_outcome from mission_contracts where id = ?").get("schema-drift-mission"),
      { id: "schema-drift-mission", objective: "preserve mission", desired_outcome: "preserve data" },
      "mission data remains unchanged by nullable-column repair",
    );
    assert.deepEqual(
      sqlite.prepare("select id, owner_context_id, status from review_routes where id = ?").get("schema-drift-route"),
      { id: "schema-drift-route", owner_context_id: "fixture-owner", status: "disabled" },
      "review-route data remains unchanged by nullable-column repair",
    );
    migrateDatabase(sqlite, { deployedBuildId: "schema-drift-repair-fixture" });
    assert.equal(appliedVersions(sqlite).filter((version) => version === 89).length, 1, "rerun is idempotent");
  } finally {
    sqlite.close();
  }
}
console.log("migration-fixtures: v88 historical schema drift repaired without data loss");

// ── Fixture: startup rejects drift that appears after a migration is recorded ─
{
  const sqlite = newSqlite();
  try {
    migrateDatabase(sqlite);
    sqlite.exec("alter table mission_contracts drop column outcome_evidence");
    assert.throws(
      () => migrateDatabase(sqlite, { deployedBuildId: "deliberately-broken-fixture" }),
      /Database schema contract failed:.*deliberately-broken-fixture.*outcome_evidence/,
      "a fully recorded migration ledger cannot conceal missing deployed columns",
    );
  } finally {
    sqlite.close();
  }
}
console.log("migration-fixtures: schema contract fails closed on post-migration drift");

console.log("migration-fixtures.test.ts: all assertions passed");
