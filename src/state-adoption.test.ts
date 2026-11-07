import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath } from "./db/client.js";
import { migrateDatabase, LATEST_SCHEMA_VERSION, migrationChain } from "./db/migrations.js";
import { adoptLegacyProductionState } from "./state-adoption.js";
import { claimStateDirectory } from "./state-directory.js";
import { processStartToken } from "./runtime-lock.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-state-adoption-"));
try {
  const stateDir = join(root, "production state");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(stateDir, { recursive: true });
  const path = databasePath(stateDir);
  const sqlite = new Database(path);
  try {
    migrateDatabase(sqlite);
    sqlite.prepare("insert into workspace_sessions (id, root, status, created_at, last_used_at) values (?, ?, 'active', ?, ?)")
      .run("preserved-session", "/tmp/preserved", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  } finally {
    sqlite.close();
  }
  assert.equal(migrationChain.length, LATEST_SCHEMA_VERSION);
  const sourceBytesHash = createHash("sha256").update(readFileSync(path)).digest("hex");
  const options = {
    stateDir,
    confirmedStateDir: stateDir,
    canonicalProductionStateDir: stateDir,
    confirmedSchemaVersion: LATEST_SCHEMA_VERSION,
  };
  await assert.rejects(
    () => adoptLegacyProductionState({ ...options, confirmedSchemaVersion: LATEST_SCHEMA_VERSION - 1 }),
    /does not match inspected schema/,
  );
  assert.equal(existsSync(join(stateDir, "state-owner.json")), false, "wrong schema confirmation does not publish ownership");

  const original = new Database(path, { readonly: true, fileMustExist: true });
  let originalSchema: number;
  try {
    originalSchema = (original.prepare("select max(version) as version from kontrol_schema_migrations").get() as { version: number }).version;
  } finally { original.close(); }

  const result = await adoptLegacyProductionState(options);
  assert.equal(result.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.ok(existsSync(result.backupPath));
  assert.match(result.backupSha256, /^[0-9a-f]{64}$/);
  assert.match(result.migrationLedgerSha256, /^[0-9a-f]{64}$/);
  const backup = new Database(result.backupPath, { readonly: true, fileMustExist: true });
  try {
    assert.equal((backup.prepare("pragma quick_check").get() as { quick_check: string }).quick_check, "ok");
    assert.equal((backup.prepare("select max(version) as version from kontrol_schema_migrations").get() as { version: number }).version, originalSchema);
    assert.equal((backup.prepare("select root from workspace_sessions where id = ?").get("preserved-session") as { root: string }).root, "/tmp/preserved");
  } finally { backup.close(); }
  const adopted = new Database(path, { readonly: true, fileMustExist: true });
  try {
    assert.equal((adopted.prepare("select root from workspace_sessions where id = ?").get("preserved-session") as { root: string }).root, "/tmp/preserved");
  } finally { adopted.close(); }
  const owner = JSON.parse(readFileSync(join(stateDir, "state-owner.json"), "utf8")) as { profile: string; permittedLauncherContext: string };
  assert.deepEqual(owner, { ...owner, profile: "production", permittedLauncherContext: "systemd" });
  assert.equal(claimStateDirectory(stateDir, { profile: "production", launcherContext: "systemd" }).profile, "production", "published marker matches the runtime ownership format");
  const journal = JSON.parse(readFileSync(join(stateDir, "state-adoption.json"), "utf8")) as { stage: string; schemaVersion: number; backupSha256: string };
  assert.equal(journal.stage, "committed");
  assert.equal(journal.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.equal(journal.backupSha256, result.backupSha256);
  assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), sourceBytesHash, "adoption leaves the source database bytes unchanged");
  await assert.rejects(() => adoptLegacyProductionState(options), /already has a committed, conflicting, or unreadable adoption journal/);

  // Simulate a process death after the prepared journal is durable but before
  // the owner record is published. A retry must verify the exact source and
  // backup identities, then finish the same transaction without inventing a
  // second owner.
  const interruptedRoot = join(root, "interrupted");
  const { mkdirSync: mkdirInterrupted } = await import("node:fs");
  mkdirInterrupted(interruptedRoot, { recursive: true });
  const interruptedDbPath = databasePath(interruptedRoot);
  const interruptedDb = new Database(interruptedDbPath);
  try {
    migrateDatabase(interruptedDb);
    interruptedDb.prepare("insert into workspace_sessions (id, root, status, created_at, last_used_at) values (?, ?, 'active', ?, ?)")
      .run("resume-session", "/tmp/resume", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
  } finally { interruptedDb.close(); }
  const interruptedLedgerDb = new Database(interruptedDbPath, { readonly: true, fileMustExist: true });
  let interruptedLedger: { version: number; hash: string };
  try {
    const rows = interruptedLedgerDb.prepare("select version, name, applied_at from kontrol_schema_migrations order by version").all();
    interruptedLedger = {
      version: (rows.at(-1) as { version: number }).version,
      hash: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    };
  } finally { interruptedLedgerDb.close(); }
  const transactionId = "adopt-123e4567-e89b-12d3-a456-426614174000";
  const interruptedBackupPath = join(interruptedRoot, `state-adoption.${transactionId}.sqlite.bak`);
  const backupSource = new Database(interruptedDbPath, { readonly: true, fileMustExist: true });
  try { await backupSource.backup(interruptedBackupPath); } finally { backupSource.close(); }
  const interruptedBackupSha256 = createHash("sha256").update(readFileSync(interruptedBackupPath)).digest("hex");
  const intendedOwner = {
    formatVersion: 1 as const,
    stateId: "323e4567-e89b-12d3-a456-426614174000",
    profile: "production" as const,
    permittedLauncherContext: "systemd" as const,
    createdAt: "2026-01-02T00:00:00.000Z",
  };
  const intendedOwnerBytes = `${JSON.stringify(intendedOwner, null, 2)}\n`;
  const interruptedJournal = {
    formatVersion: 1 as const,
    transactionId,
    deploymentId: transactionId,
    stateDir: interruptedRoot,
    databasePath: interruptedDbPath,
    schemaVersion: interruptedLedger.version,
    migrationLedgerSha256: interruptedLedger.hash,
    backupPath: interruptedBackupPath,
    backupSha256: interruptedBackupSha256,
    stateOwner: intendedOwner,
    stateOwnerSha256: createHash("sha256").update(intendedOwnerBytes).digest("hex"),
    stage: "prepared" as const,
    preparedAt: "2026-01-02T00:00:00.000Z",
  };
  writeFileSync(join(interruptedRoot, "state-adoption.json"), `${JSON.stringify(interruptedJournal, null, 2)}\n`);
  const interruptedOptions = {
    stateDir: interruptedRoot,
    confirmedStateDir: interruptedRoot,
    canonicalProductionStateDir: interruptedRoot,
    confirmedSchemaVersion: LATEST_SCHEMA_VERSION,
  };
  const recovered = await adoptLegacyProductionState(interruptedOptions);
  assert.equal(recovered.transactionId, transactionId, "recovery resumes the original adoption transaction");
  assert.equal(readFileSync(join(interruptedRoot, "state-owner.json"), "utf8"), intendedOwnerBytes,
    "recovery publishes the exact owner identity committed in the prepared journal");
  const recoveredJournal = JSON.parse(readFileSync(join(interruptedRoot, "state-adoption.json"), "utf8")) as { stage: string; transactionId: string };
  assert.equal(recoveredJournal.stage, "committed");
  assert.equal(recoveredJournal.transactionId, transactionId);
  const recoveredDb = new Database(interruptedDbPath, { readonly: true, fileMustExist: true });
  try {
    assert.equal((recoveredDb.prepare("select root from workspace_sessions where id = ?").get("resume-session") as { root: string }).root, "/tmp/resume");
  } finally { recoveredDb.close(); }

  const liveRoot = join(root, "live");
  const { mkdirSync: mkdir } = await import("node:fs");
  mkdir(liveRoot, { recursive: true });
  const liveDb = new Database(databasePath(liveRoot));
  try { migrateDatabase(liveDb); } finally { liveDb.close(); }
  writeFileSync(join(liveRoot, "runtime.lock"), JSON.stringify({
    lockToken: "live", launcher: "systemd", launcherPid: process.pid,
    launcherStartToken: processStartToken(process.pid), generationId: "generation-live",
    buildId: "build-live", artifactPath: "/release/live", port: 7676, acquiredAt: new Date().toISOString(),
  }));
  await assert.rejects(() => adoptLegacyProductionState({
    stateDir: liveRoot, confirmedStateDir: liveRoot, canonicalProductionStateDir: liveRoot,
    confirmedSchemaVersion: LATEST_SCHEMA_VERSION,
  }), /while runtime generation generation-live is live/);
  assert.equal(existsSync(join(liveRoot, "state-owner.json")), false, "live runtime blocks adoption before ownership mutation");
  console.log("state-adoption.test.ts: all assertions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
