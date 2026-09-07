/**
 * P0 GC safety: the shared durable-root collector must fail CLOSED. Any
 * SQLite/query failure must propagate as a throw — never an empty root set,
 * which a destructive GC would read as "nothing in SQLite is live". Also
 * covers the root-shape contract: terminality flags, terminalAt propagation,
 * and the legitimate zero-root case (no database handle).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import { collectDurableSnapshotRoots } from "./snapshot-roots.js";

const now = new Date().toISOString();

// --- 1. No database handle: a fresh install legitimately has zero roots. ---
{
  const roots = collectDurableSnapshotRoots(undefined);
  assert.deepEqual(roots, [], "no DB handle -> zero roots, no throw");
}

// --- 2. Real database: submissions, terminality, terminalAt propagation. ---
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-snapshot-roots-"));
{
  const db = openDatabase(stateDir);
  const { workspaceSessions, workSessions, workSessionSubmissions } = await import("../db/schema.js");
  const wsId = "wss_roots_test";
  const sessionA = "ws_roots_active";
  const sessionB = "ws_roots_terminal";
  db.db.insert(workspaceSessions).values({ id: wsId, root: "/tmp/kontrol-roots-root", createdAt: now, lastUsedAt: now }).run();
  db.db.insert(workSessions).values({
    id: sessionA, workspaceSessionId: wsId, status: "in_progress", runtimeState: "running",
    submittedBy: "test", createdAt: now, updatedAt: now,
  }).run();
  db.db.insert(workSessions).values({
    id: sessionB, workspaceSessionId: wsId, status: "approved", runtimeState: "archived",
    submittedBy: "test", createdAt: now, updatedAt: now, terminalAt: "2026-01-15T10:30:00.000Z",
  }).run();
  db.db.insert(workSessionSubmissions).values({
    id: "wssub_active", workSessionId: sessionA, submissionNumber: 1,
    snapshotKind: "filesystem", snapshotRef: "fs:sha256:" + "a".repeat(64), reviewEpoch: 1, status: "pending", createdAt: now,
  }).run();
  db.db.insert(workSessionSubmissions).values({
    id: "wssub_terminal", workSessionId: sessionB, submissionNumber: 1,
    snapshotKind: "filesystem", snapshotRef: "fs:sha256:" + "b".repeat(64), reviewEpoch: 1, status: "reviewed", createdAt: now,
  }).run();
  // A submission with a git snapshot_kind must be skipped entirely (only
  // filesystem refs are protected by this store).
  db.db.insert(workSessionSubmissions).values({
    id: "wssub_git", workSessionId: sessionA, submissionNumber: 2,
    snapshotKind: "git", snapshotCommit: "deadbeef", reviewEpoch: 2, status: "pending", createdAt: now,
  }).run();

  const roots = collectDurableSnapshotRoots(db);
  const byRef = new Map(roots.map((r) => [r.ref, r]));
  assert.equal(roots.length, 2, "only filesystem submissions with refs are roots");
  const activeRoot = byRef.get("fs:sha256:" + "a".repeat(64));
  assert.ok(activeRoot, "active-session submission is a root");
  assert.equal(activeRoot!.terminal, false, "nonterminal session -> strong pin");
  const terminalRoot = byRef.get("fs:sha256:" + "b".repeat(64));
  assert.ok(terminalRoot, "terminal-session submission is a retention-tracked root");
  assert.equal(terminalRoot!.terminal, true, "terminal flag set");
  assert.equal(terminalRoot!.terminalAt, "2026-01-15T10:30:00.000Z", "terminalAt propagates verbatim for retention aging");
  db.close();
}

// --- 3. Injected DB failure: enumeration must THROW, never return []. ---
// Real failure mode: schema damage behind a live handle (failed migration,
// external corruption). The collector has no way to know what is live, so the
// only safe behavior is to throw and let the caller abort its GC slice.
{
  const brokenDir = mkdtempSync(join(tmpdir(), "kontrol-snapshot-roots-broken-"));
  const db = openDatabase(brokenDir);
  db.sqlite.exec("drop table work_session_submissions");
  assert.throws(
    () => collectDurableSnapshotRoots(db),
    (error: unknown) => error instanceof Error,
    "a query failure (dropped table) must throw, never return an empty root set",
  );
  db.close();
  rmSync(brokenDir, { recursive: true, force: true });
}

// --- 4. A handle whose prepare throws (e.g. corrupted database file) —
// same contract at the API boundary, independent of real SQLite internals.
{
  const throwingHandle = {
    sqlite: {
      prepare() {
        throw new Error("sqlite: database disk image is malformed");
      },
    },
  } as unknown as DatabaseHandle;
  assert.throws(
    () => collectDurableSnapshotRoots(throwingHandle),
    /malformed/,
    "a throwing prepare must propagate (fail closed), never be swallowed into []",
  );
}

rmSync(stateDir, { recursive: true, force: true });
console.log("runtime/snapshot-roots: all assertions passed");
