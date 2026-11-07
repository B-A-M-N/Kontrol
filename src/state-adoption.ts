import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, openSync, fsyncSync, closeSync, createReadStream, statfsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { acquireDeploymentLock, releaseDeploymentLock } from "./deployment-lock.js";
import { migrationChain } from "./db/migrations.js";
import { isRuntimeLockLive, readRuntimeLock } from "./runtime-lock.js";

interface OwnershipRecord {
  formatVersion: 1;
  stateId: string;
  profile: "production";
  permittedLauncherContext: "systemd";
  createdAt: string;
}

export interface StateAdoptionResult {
  transactionId: string;
  stateDir: string;
  schemaVersion: number;
  backupPath: string;
  backupSha256: string;
  migrationLedgerSha256: string;
}

interface AdoptionJournal {
  formatVersion: 1;
  transactionId: string;
  deploymentId: string;
  stateDir: string;
  databasePath: string;
  schemaVersion: number;
  migrationLedgerSha256: string;
  backupPath: string;
  backupSha256: string;
  stateOwner: OwnershipRecord;
  stateOwnerSha256: string;
  stage: "prepared" | "committed";
  preparedAt: string;
  committedAt?: string;
}

function canonical(path: string): string {
  const absolute = resolve(path);
  return realpathSync(absolute);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertBackupHeadroom(stateDir: string, sourcePath: string): void {
  const backupBytes = statSync(sourcePath).size;
  const reserveBytes = Math.max(512 * 1024 * 1024, Math.ceil(backupBytes * 0.05));
  const filesystem = statfsSync(stateDir);
  const availableBytes = filesystem.bavail * filesystem.bsize;
  if (availableBytes < backupBytes + reserveBytes) {
    throw new Error(`Insufficient disk headroom for state adoption backup: need ${backupBytes + reserveBytes} bytes, have ${availableBytes}.`);
  }
}

function schemaLedger(sqlite: Database.Database): { version: number; hash: string } {
  const rows = sqlite.prepare("select version, name, applied_at from kontrol_schema_migrations order by version").all() as Array<{
    version: number; name: string; applied_at: string;
  }>;
  if (rows.length === 0) throw new Error("Legacy database has no schema migration ledger.");
  if (rows.some((row, index) => row.version !== index + 1 || row.name !== migrationChain[index]?.name || !Number.isFinite(Date.parse(row.applied_at)))) {
    throw new Error("Legacy database migration ledger is incomplete or does not match this Kontrol migration history.");
  }
  if (rows.length > migrationChain.length) throw new Error("Legacy database schema is newer than this Kontrol build.");
  return { version: rows.at(-1)!.version, hash: sha256Text(JSON.stringify(rows)) };
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeNoReplace(path: string, data: string): void {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
  try {
    linkSync(temp, path);
    unlinkSync(temp);
    syncDirectory(resolve(path, ".."));
  } catch (error) {
    try { unlinkSync(temp); } catch { /* preserve publication failure */ }
    throw error;
  }
}

function parseOwnershipRecord(value: unknown): OwnershipRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<OwnershipRecord>;
  if (record.formatVersion !== 1 || typeof record.stateId !== "string" || !/^[0-9a-f-]{36}$/i.test(record.stateId)
    || record.profile !== "production" || record.permittedLauncherContext !== "systemd"
    || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) return undefined;
  return record as OwnershipRecord;
}

function readAdoptionJournal(path: string): AdoptionJournal | undefined {
  let value: Partial<AdoptionJournal>;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as Partial<AdoptionJournal>;
  } catch {
    return undefined;
  }
  const owner = parseOwnershipRecord(value.stateOwner);
  const invalid: string[] = [];
  if (value.formatVersion !== 1) invalid.push("formatVersion");
  if (typeof value.transactionId !== "string" || !/^adopt-[0-9a-f-]{36}$/i.test(value.transactionId)) invalid.push("transactionId");
  if (value.deploymentId !== value.transactionId) invalid.push("deploymentId");
  if (typeof value.stateDir !== "string") invalid.push("stateDir");
  if (typeof value.databasePath !== "string") invalid.push("databasePath");
  if (!Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) < 1) invalid.push("schemaVersion");
  if (typeof value.migrationLedgerSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.migrationLedgerSha256)) invalid.push("migrationLedgerSha256");
  if (typeof value.backupPath !== "string") invalid.push("backupPath");
  if (typeof value.backupSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.backupSha256)) invalid.push("backupSha256");
  if (!owner) invalid.push("stateOwner");
  if (typeof value.stateOwnerSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.stateOwnerSha256)) invalid.push("stateOwnerSha256");
  if (value.stage !== "prepared" && value.stage !== "committed") invalid.push("stage");
  if (typeof value.preparedAt !== "string" || !Number.isFinite(Date.parse(value.preparedAt))) invalid.push("preparedAt");
  if (invalid.length) throw new Error(`State adoption journal is invalid (${invalid.join(", ")}).`);
  return value as AdoptionJournal;
}

function serializedOwner(owner: OwnershipRecord): string {
  return `${JSON.stringify(owner, null, 2)}\n`;
}

function commitJournal(journalPath: string, journal: AdoptionJournal, stateDir: string): AdoptionJournal {
  const committed: AdoptionJournal = { ...journal, stage: "committed", committedAt: new Date().toISOString() };
  const tempJournal = `${journalPath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tempJournal, `${JSON.stringify(committed, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(tempJournal, journalPath);
  syncDirectory(stateDir);
  return committed;
}

async function verifyAdoptionJournal(stateDir: string, databasePath: string, journal: AdoptionJournal, confirmedSchemaVersion: number): Promise<void> {
  if (journal.stateDir !== stateDir || journal.databasePath !== databasePath || journal.schemaVersion !== confirmedSchemaVersion) {
    throw new Error("Prepared state adoption identity does not match the confirmed state path or schema; refusing recovery.");
  }
  const expectedBackup = join(stateDir, `state-adoption.${journal.transactionId}.sqlite.bak`);
  if (resolve(journal.backupPath) !== expectedBackup || !existsSync(expectedBackup)) {
    throw new Error("Prepared state adoption backup path is invalid or missing; refusing recovery.");
  }
  const source = new Database(databasePath, { readonly: true, fileMustExist: true });
  let sourceLedger: { version: number; hash: string };
  try {
    const integrity = source.prepare("pragma quick_check").get() as { quick_check?: string } | undefined;
    if (integrity?.quick_check !== "ok") throw new Error(`Legacy database failed quick_check: ${integrity?.quick_check ?? "no result"}.`);
    sourceLedger = schemaLedger(source);
  } finally { source.close(); }
  if (sourceLedger.version !== journal.schemaVersion || sourceLedger.hash !== journal.migrationLedgerSha256) {
    throw new Error("Prepared state adoption source database no longer matches its recorded migration ledger; refusing recovery.");
  }
  if (await sha256File(expectedBackup) !== journal.backupSha256) {
    throw new Error("Prepared state adoption backup hash does not match its journal; refusing recovery.");
  }
  const backup = new Database(expectedBackup, { readonly: true, fileMustExist: true });
  let backupLedger: { version: number; hash: string };
  try {
    const integrity = backup.prepare("pragma quick_check").get() as { quick_check?: string } | undefined;
    if (integrity?.quick_check !== "ok") throw new Error("SQLite adoption backup failed quick_check.");
    backupLedger = schemaLedger(backup);
  } finally { backup.close(); }
  if (backupLedger.version !== sourceLedger.version || backupLedger.hash !== sourceLedger.hash) {
    throw new Error("Prepared state adoption backup does not match the current source migration ledger; refusing recovery.");
  }
  const ownerBytes = serializedOwner(journal.stateOwner);
  if (sha256Text(ownerBytes) !== journal.stateOwnerSha256) {
    throw new Error("Prepared state adoption owner identity does not match its journal; refusing recovery.");
  }
}

/**
 * Adopt an existing production SQLite database exactly once. The caller must
 * provide both confirmations, and the target must be the canonical path used
 * by the production service. This function never migrates the source DB.
 */
export async function adoptLegacyProductionState(options: {
  stateDir: string;
  confirmedStateDir: string;
  confirmedSchemaVersion: number;
  canonicalProductionStateDir: string;
}): Promise<StateAdoptionResult> {
  const stateDir = canonical(options.stateDir);
  const canonicalProductionStateDir = canonical(options.canonicalProductionStateDir);
  const confirmedStateDir = canonical(options.confirmedStateDir);
  if (stateDir !== canonicalProductionStateDir || confirmedStateDir !== canonicalProductionStateDir) {
    throw new Error(`State adoption requires explicit confirmation of the canonical production path (${canonicalProductionStateDir}).`);
  }
  if (!Number.isSafeInteger(options.confirmedSchemaVersion) || options.confirmedSchemaVersion < 1) {
    throw new Error("State adoption requires --confirm-schema-version with a positive integer.");
  }
  const databasePath = join(stateDir, "kontrol.sqlite");
  if (!existsSync(databasePath)) throw new Error(`No existing Kontrol database found at ${databasePath}.`);
  const ownerPath = join(stateDir, "state-owner.json");
  const journalPath = join(stateDir, "state-adoption.json");
  const hasOwner = existsSync(ownerPath);
  const hasJournal = existsSync(journalPath);
  let recoveryJournal: AdoptionJournal | undefined;
  if (hasJournal) {
    recoveryJournal = readAdoptionJournal(journalPath);
    if (!recoveryJournal || recoveryJournal.stage !== "prepared") {
      throw new Error("Legacy state already has a committed, conflicting, or unreadable adoption journal; refusing repeat adoption.");
    }
    if (recoveryJournal.stateDir !== stateDir || recoveryJournal.databasePath !== databasePath
      || recoveryJournal.schemaVersion !== options.confirmedSchemaVersion) {
      throw new Error("Prepared state adoption journal conflicts with the confirmed path or schema; refusing recovery.");
    }
  }
  if (hasOwner && !recoveryJournal) {
    throw new Error("Legacy state already has an ownership marker or adoption journal; refusing repeat adoption.");
  }
  if (hasOwner && recoveryJournal) {
    const existingOwnerBytes = readFileSync(ownerPath, "utf8");
    if (sha256Text(existingOwnerBytes) !== recoveryJournal.stateOwnerSha256) {
      throw new Error("Prepared state adoption found a conflicting ownership marker; refusing recovery.");
    }
  }

  const transactionId = recoveryJournal?.transactionId ?? `adopt-${randomUUID()}`;
  const lock = await acquireDeploymentLock(stateDir, { operation: "adopt-state", deploymentId: transactionId });
  let backupPath: string | undefined;
  try {
    if (!recoveryJournal && (existsSync(ownerPath) || existsSync(journalPath))) {
      throw new Error("Legacy state changed while adoption authority was being acquired.");
    }
    const runtime = readRuntimeLock(stateDir);
    if (runtime && isRuntimeLockLive(runtime)) {
      throw new Error(`Cannot adopt state while runtime generation ${runtime.generationId} is live (pid ${runtime.launcherPid}).`);
    }

    if (recoveryJournal) {
      const lockedJournal = readAdoptionJournal(journalPath);
      if (!lockedJournal || lockedJournal.stage !== "prepared"
        || JSON.stringify(lockedJournal) !== JSON.stringify(recoveryJournal)) {
        throw new Error("Prepared state adoption journal changed while deployment authority was being acquired; refusing recovery.");
      }
      recoveryJournal = lockedJournal;
      await verifyAdoptionJournal(stateDir, databasePath, recoveryJournal, options.confirmedSchemaVersion);
      if (!existsSync(ownerPath)) writeNoReplace(ownerPath, serializedOwner(recoveryJournal.stateOwner));
      const ownerBytes = readFileSync(ownerPath, "utf8");
      if (sha256Text(ownerBytes) !== recoveryJournal.stateOwnerSha256) {
        throw new Error("Prepared state adoption owner record changed during recovery; refusing commit.");
      }
      const committed = commitJournal(journalPath, recoveryJournal, stateDir);
      return {
        transactionId: committed.transactionId,
        stateDir,
        schemaVersion: committed.schemaVersion,
        backupPath: committed.backupPath,
        backupSha256: committed.backupSha256,
        migrationLedgerSha256: committed.migrationLedgerSha256,
      };
    }

    const source = new Database(databasePath, { readonly: true, fileMustExist: true });
    let ledger: { version: number; hash: string };
    try {
      const integrity = source.prepare("pragma quick_check").get() as { quick_check?: string } | undefined;
      if (integrity?.quick_check !== "ok") throw new Error(`Legacy database failed quick_check: ${integrity?.quick_check ?? "no result"}.`);
      ledger = schemaLedger(source);
      if (ledger.version !== options.confirmedSchemaVersion) {
        throw new Error(`Confirmed schema ${options.confirmedSchemaVersion} does not match inspected schema ${ledger.version}.`);
      }
      assertBackupHeadroom(stateDir, databasePath);
      backupPath = join(stateDir, `state-adoption.${transactionId}.sqlite.bak`);
      await source.backup(backupPath);
    } finally {
      source.close();
    }
    chmodSync(backupPath, 0o600);

    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    let backupLedger: { version: number; hash: string };
    try {
      const integrity = backup.prepare("pragma quick_check").get() as { quick_check?: string } | undefined;
      if (integrity?.quick_check !== "ok") throw new Error("SQLite adoption backup failed quick_check.");
      backupLedger = schemaLedger(backup);
    } finally {
      backup.close();
    }
    if (backupLedger.version !== ledger!.version || backupLedger.hash !== ledger!.hash) {
      throw new Error("SQLite adoption backup does not match the source migration ledger.");
    }
    const backupSha256 = await sha256File(backupPath);
    const owner: OwnershipRecord = {
      formatVersion: 1,
      stateId: randomUUID(),
      profile: "production",
      permittedLauncherContext: "systemd",
      createdAt: new Date().toISOString(),
    };
    const ownerBytes = serializedOwner(owner);
    const ownerSha256 = sha256Text(ownerBytes);
    const adoptionRecord: AdoptionJournal = {
      formatVersion: 1,
      transactionId,
      deploymentId: lock.record.deploymentId,
      stateDir,
      databasePath,
      schemaVersion: ledger!.version,
      migrationLedgerSha256: ledger!.hash,
      backupPath,
      backupSha256,
      stateOwner: owner,
      stateOwnerSha256: ownerSha256,
      stage: "prepared" as const,
      preparedAt: new Date().toISOString(),
    };
    writeNoReplace(journalPath, `${JSON.stringify(adoptionRecord, null, 2)}\n`);
    writeNoReplace(ownerPath, ownerBytes);
    const committed = commitJournal(journalPath, adoptionRecord, stateDir);
    return {
      transactionId,
      stateDir,
      schemaVersion: ledger!.version,
      backupPath,
      backupSha256,
      migrationLedgerSha256: ledger!.hash,
    };
  } finally {
    await releaseDeploymentLock(stateDir, lock.record.token);
  }
}
