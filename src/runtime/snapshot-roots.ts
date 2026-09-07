/**
 * P0 GC safety: the single production collector for durable filesystem
 * snapshot roots held in SQLite. Every destructive GC entry point (automatic
 * maintenance, high-water emergency GC, `kontrol snapshots gc`), every
 * reachability estimate (`snapshots stats`, doctor), and the high-water
 * capture brake must go through this module — never a call-site-local copy.
 *
 * Failure direction is deliberate: if the durable root set cannot be
 * enumerated, this THROWS. "I could not determine what data is live" must
 * never become "nothing in SQLite is live" — the caller aborts the GC slice
 * and reclaims nothing.
 */
import { terminalWorkSessionStatuses } from "./maintenance.js";
import type { DatabaseHandle } from "../db/client.js";


export interface DurableSnapshotRoot {
  ref: string;
  /** True when the owning work session is terminal: the root ages out via
   * retention instead of being a permanent strong pin. */
  terminal?: boolean;
  /** RFC 3339 moment the owning work session reached its terminal status.
   * Retention ages from this, never from the manifest's mtime. */
  terminalAt?: string;
}

export type DurableRootCollector = () => DurableSnapshotRoot[];

/**
 * Enumerate every filesystem snapshot ref the database still references, with
 * terminality and terminal timestamps. Throws on any SQLite/query failure so
 * no caller can accidentally GC against a partial root set.
 *
 * A missing database handle is NOT a failure: a fresh install legitimately has
 * no database yet, and there are then zero DB roots to protect.
 */
export function collectDurableSnapshotRoots(db: DatabaseHandle | undefined): DurableSnapshotRoot[] {
  if (!db) return [];
  const roots: DurableSnapshotRoot[] = [];
  // work_session_submissions, terminal by owning work_session.status, aged
  // from work_sessions.terminal_at.
  const submissions = db.sqlite.prepare(
    "select wss.snapshot_ref as ref, ws.status as status, ws.terminal_at as terminal_at"
    + " from work_session_submissions wss"
    + " left join work_sessions ws on ws.id = wss.work_session_id"
    + " where wss.snapshot_kind = 'filesystem' and wss.snapshot_ref is not null",
  ).all() as Array<{ ref?: string; status?: string; terminal_at?: string | null }>;
  for (const row of submissions) {
    if (row.ref) {
      roots.push({
        ref: row.ref,
        terminal: row.status ? terminalWorkSessionStatuses.has(row.status) : undefined,
        ...(row.terminal_at ? { terminalAt: row.terminal_at } : {}),
      });
    }
  }
  // mission_evidence, mission_completion_reports: always strong pins.
  for (const table of ["mission_evidence", "mission_completion_reports"]) {
    const rows = db.sqlite.prepare(
      `select snapshot_ref as ref from ${table} where snapshot_kind = 'filesystem' and snapshot_ref is not null`,
    ).all() as Array<{ ref?: string }>;
    for (const row of rows) if (row.ref) roots.push({ ref: row.ref });
  }
  // supervisor_runs.last_snapshot_ref.
  const runs = db.sqlite.prepare(
    "select last_snapshot_ref as ref from supervisor_runs where last_snapshot_kind = 'filesystem' and last_snapshot_ref is not null",
  ).all() as Array<{ ref?: string }>;
  for (const row of runs) if (row.ref) roots.push({ ref: row.ref });
  return roots;
}
