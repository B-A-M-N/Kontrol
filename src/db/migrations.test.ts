import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "./client.js";
import { inspectDatabaseSchemaContract, LATEST_SCHEMA_VERSION, migrateDatabase } from "./migrations.js";

const sqlite = new Database(":memory:");
sqlite.pragma("foreign_keys = ON");
try {
  migrateDatabase(sqlite);
  const schemaContract = inspectDatabaseSchemaContract(sqlite);
  assert.equal(schemaContract.expectedTableCount, 52, "schema contract covers all Drizzle table mappings, including workspace goals, peer-job, and PTY binding storage");
  assert.deepEqual(schemaContract.missing, [], "all Drizzle tables and columns are present in migrated SQLite");
  assert.equal(schemaContract.appliedVersion, LATEST_SCHEMA_VERSION);
  const scheduledTargetColumns = sqlite.prepare("pragma table_info(scheduled_jobs)").all() as Array<{ name: string }>;
  assert.ok(scheduledTargetColumns.some((column) => column.name === "dispatch_target"), "scheduled dispatch target is durable after migration");
  assert.ok(scheduledTargetColumns.some((column) => column.name === "dispatch_peer_id"), "scheduled peer identity is durable after migration");
  assert.ok(
    (sqlite.prepare("select name from sqlite_master where type = 'index'").all() as Array<{ name: string }>)
      .some((index) => index.name === "event_log_scheduled_error_fingerprint_time_idx"),
    "scheduler recurrence lookup has a fingerprint/time index",
  );
  const recurrencePlan = sqlite.prepare(`
    explain query plan
    select count(*) from event_log
     where type = 'scheduled_job.scheduler_error'
       and created_at >= ?
       and json_extract(payload, '$.fingerprint') = ?
  `).all("2026-01-01T00:00:00.000Z", "fingerprint") as Array<{ detail: string }>;
  assert.ok(recurrencePlan.some((row) => row.detail.includes("event_log_scheduled_error_fingerprint_time_idx")),
    "durable recurrence count uses the bounded fingerprint/time lookup index");
  assert.ok(
    (sqlite.prepare("pragma table_info(work_session_submissions)").all() as Array<{ name: string }>)
      .some((column) => column.name === "files_json"),
    "submission file metadata column is present after migration",
  );
  assert.ok(
    (sqlite.prepare("pragma table_info(work_sessions)").all() as Array<{ name: string }>)
      .some((column) => column.name === "owner_context_id"),
    "work session owner context column is present after migration",
  );
  assert.ok(
    (sqlite.prepare("pragma table_info(review_handoffs)").all() as Array<{ name: string }>)
      .some((column) => column.name === "claim_expires_at"),
    "review handoff claim leases are durable after migration",
  );
  assert.ok(
    (sqlite.prepare("pragma table_info(review_routes)").all() as Array<{ name: string }>)
      .some((column) => column.name === "delivery_transport"),
    "review routes persist their selected delivery transport",
  );
  assert.ok(
    (sqlite.prepare("pragma table_info(review_threads)").all() as Array<{ name: string }>)
      .some((column) => column.name === "conversation_fingerprint"),
    "review threads persist exact browser conversation identity",
  );
  assert.ok(
    (sqlite.prepare("pragma table_info(review_browser_turns)").all() as Array<{ name: string }>)
      .some((column) => column.name === "lease_token_sha256"),
    "browser review turns persist fenced delivery leases",
  );
  const browserTurnColumns = (sqlite.prepare("pragma table_info(review_browser_turns)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(browserTurnColumns.includes("generation_started_at") && browserTurnColumns.includes("generation_started_observation_id")
    && browserTurnColumns.includes("generation_finished_observation_id"), "browser turns persist bounded generation observation identity and timestamps");
  assert.ok(browserTurnColumns.includes("binding_revision"), "browser turns persist the exact conversation-binding revision they claimed");
  assert.ok(
    (sqlite.prepare("pragma table_info(review_browser_turn_resolutions)").all() as Array<{ name: string }>)
      .some((column) => column.name === "evidence_sha256"),
    "operator browser recovery receipts persist only a hash of the inspection note",
  );
  assert.ok(
    (sqlite.prepare("pragma table_info(review_browser_profiles)").all() as Array<{ name: string }>)
      .some((column) => column.name === "owner_principal_id"),
    "review browser profiles remain owned by the authenticated principal",
  );
  const reviewBrowserProfileColumns = (sqlite.prepare("pragma table_info(review_browser_profiles)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(reviewBrowserProfileColumns.includes("browser_ready_at"), "browser readiness has a timestamp separate from authentication verification");
  assert.ok(reviewBrowserProfileColumns.includes("manual_auth_pid") && reviewBrowserProfileColumns.includes("manual_auth_process_start_identity")
    && reviewBrowserProfileColumns.includes("manual_auth_boot_identity") && reviewBrowserProfileColumns.includes("manual_auth_generation"),
  "manual authentication ownership and generation are durable across controller restarts");
  assert.ok(reviewBrowserProfileColumns.includes("browser_product") && reviewBrowserProfileColumns.includes("remote_debugging_enabled")
    && reviewBrowserProfileColumns.includes("browser_launch_diagnostic"), "browser launch product, CDP mode, and bounded diagnostics are durable");
  assert.ok(
    (sqlite.prepare("pragma table_info(approval_requests)").all() as Array<{ name: string }>)
      .some((column) => column.name === "owner_context_id"),
    "approval owner context column is present after migration",
  );
  assert.ok(
    (sqlite.prepare("pragma table_info(approval_requests)").all() as Array<{ name: string }>)
      .some((column) => column.name === "operation_hash"),
    "canonical direct-operation hash column is present after migration",
  );
  assert.ok(
    (sqlite.prepare("pragma table_info(telemetry_ingress)").all() as Array<{ name: string }>)
      .some((column) => column.name === "event_id"),
    "durable telemetry event-id receipts are present after migration",
  );
  assert.ok(
    (sqlite.prepare("pragma index_list(telemetry_ingress)").all() as Array<{ name: string }>)
      .some((index) => index.name === "telemetry_ingress_retention_idx"),
    "committed telemetry tombstone retention uses a bounded lookup index",
  );
  assert.ok(
    (sqlite.prepare("pragma table_info(workspace_sessions)").all() as Array<{ name: string }>)
      .some((column) => column.name === "retired_at"),
    "managed worktree retirement timestamp is present after migration",
  );
  assert.ok(
    (sqlite.prepare("pragma index_list(workspace_sessions)").all() as Array<{ name: string }>)
      .some((index) => index.name === "workspace_managed_lifecycle_created_idx"),
    "managed worktree pagination has an indexed stable cursor",
  );
  assert.ok(
    (sqlite.prepare("pragma index_list(policy_approval_grants)").all() as Array<{ name: string }>)
      .some((index) => index.name === "policy_approval_grants_principal_idx"),
    "effective policy grants retain their indexed composite identity",
  );
  assert.ok(
    (sqlite.prepare("pragma table_info(mcp_qualification_evidence)").all() as Array<{ name: string }>)
      .some((column) => column.name === "content_sha256"),
    "MCP qualification evidence is durably stored with content hashes",
  );
  const qualificationIndexes = (sqlite.prepare("pragma index_list(mcp_qualification_evidence)").all() as Array<{ name: string }>)
    .map((index) => index.name);
  for (const index of [
    "mcp_qualification_evidence_build_idx",
    "mcp_qualification_evidence_capture_idx",
    "mcp_qualification_evidence_session_idx",
    "mcp_qualification_evidence_operation_idx",
  ]) {
    assert.ok(qualificationIndexes.includes(index), `qualification evidence has its ${index} lookup index`);
  }
  assert.ok(
    (sqlite.prepare("pragma table_info(mcp_external_catalog_observations)").all() as Array<{ name: string }>)
      .some((column) => column.name === "content_sha256"),
    "external host observations are retained as content-addressed records",
  );
  const associationIndexes = (sqlite.prepare("pragma index_list(mcp_qualification_associations)").all() as Array<{ name: string }>)
    .map((index) => index.name);
  for (const index of [
    "mcp_qualification_associations_build_idx",
    "mcp_qualification_associations_capture_idx",
    "mcp_qualification_associations_session_idx",
  ]) {
    assert.ok(associationIndexes.includes(index), `qualification association has its ${index} lookup index`);
  }
  assert.ok(
    (sqlite.prepare("pragma table_info(review_handoff_external_catalog_attachments)").all() as Array<{ name: string }>)
      .some((column) => column.name === "investigation_direction"),
    "reviewer capture handoff attachments retain the investigation direction",
  );
  sqlite.pragma("foreign_keys = OFF");
  sqlite.prepare(`
    insert into mission_completion_reports
      (id, mission_id, submission_id, snapshot_commit, status, results_json, report_sha256, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("legacy-filesystem-report", "legacy-mission", "legacy-submission", "fs:sha256:legacy", "passed", "[]", "legacy-hash", new Date().toISOString());
  sqlite.pragma("foreign_keys = ON");
  // Re-run the canonical snapshot identity migration explicitly; newer
  // migrations may exist without changing this backfill assertion.
  sqlite.prepare("delete from kontrol_schema_migrations where version = ?").run(63);
  migrateDatabase(sqlite);
  assert.deepEqual(
    sqlite.prepare("select snapshot_kind, snapshot_ref from mission_completion_reports where id = ?").get("legacy-filesystem-report"),
    { snapshot_kind: "filesystem", snapshot_ref: "fs:sha256:legacy" },
    "canonical snapshot kind/ref fields backfill from the legacy alias",
  );
  assert.ok(
    (sqlite.prepare("pragma index_list(mission_completion_reports)").all() as Array<{ name: string }>)
      .some((index) => index.name === "mission_completion_reports_identity_idx"),
    "completion report lookups use the canonical snapshot identity index",
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
