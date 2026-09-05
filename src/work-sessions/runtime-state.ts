/**
 * Runtime-state classification and bounded reconciliation
 *
 * Extracted verbatim from SqliteWorkSessionManager (P1 god-object
 * decomposition). `runtimeStateFor` is the single classifier consulted by the
 * session store's hydration and by the maintenance reconciliation pass;
 * `reconcileRuntimeStates` is the bounded page engine the maintenance
 * coordinator drives.
 */
import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client.js";
import type {
  RuntimeReconciliationPage,
  WorkSessionRuntimeState,
  WorkSessionStatus,
} from "./types.js";
import { isTerminalStatus, STALE_THRESHOLD_MS } from "./internal.js";

type LatestRun = {
  status: string;
  lastHeartbeatAt?: string | null;
  workerLeaseUntil?: string | null;
  finishedAt?: string | null;
};

export function runtimeStateFor(
  status: WorkSessionStatus,
  updatedAt: string,
  run: LatestRun | undefined,
): WorkSessionRuntimeState {
  if (isTerminalStatus(status)) return "archived";
  const ageMs = Date.now() - Date.parse(updatedAt);
  if (status === "awaiting_review" || status === "review_in_progress") {
    // A parked review remains durable and recoverable, but month-old review
    // work must not consume the active control-plane surface forever.
    return ageMs > 30 * 24 * 60 * 60 * 1000 ? "stale" : "parked";
  }
  const runActive = Boolean(run && !run.finishedAt && ["created", "in-progress", "running", "working", "awaiting"].includes(run.status));
  const heartbeat = run?.lastHeartbeatAt ? Date.parse(run.lastHeartbeatAt) : 0;
  const lease = run?.workerLeaseUntil ? Date.parse(run.workerLeaseUntil) : 0;
  const recentHeartbeat = heartbeat > 0 && Date.now() - heartbeat <= 2 * 60_000;
  const validLease = lease > Date.now();
  if (runActive && (recentHeartbeat || validLease)) return "running";
  if (ageMs > STALE_THRESHOLD_MS) return "stale";
  return "detached";
}

export function reconcileRuntimeStates(
  db: DatabaseHandle,
  afterSessionId?: string,
  limit = 100,
): RuntimeReconciliationPage {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  // Fetch the page and each session's latest run in one bounded SQLite
  // statement. The previous implementation performed one latest-run query
  // per session before yielding, making the nominal maintenance page an
  // uninterruptible N+1 synchronous burst on the serving thread. Select the
  // session page first so the window function does not rank the entire ACP
  // run history for every maintenance page.
  const rows = db.sqlite.prepare(`
    with session_page as (
      select id, status, updated_at, runtime_state
      from work_sessions
      where (? is null or id > ?)
      order by id
      limit ?
    ), ranked_runs as (
      select
        ar.work_session_id,
        ar.status,
        ar.last_heartbeat_at,
        ar.worker_lease_until,
        ar.finished_at,
        row_number() over (
          partition by ar.work_session_id
          order by ar.created_at desc, ar.run_id desc
        ) as run_rank
      from acp_runs ar
      inner join session_page sp on sp.id = ar.work_session_id
    )
    select
      sp.id,
      sp.status,
      sp.updated_at,
      sp.runtime_state,
      rr.status as latest_status,
      rr.last_heartbeat_at as latest_last_heartbeat_at,
      rr.worker_lease_until as latest_worker_lease_until,
      rr.finished_at as latest_finished_at
    from session_page sp
    left join ranked_runs rr
      on rr.work_session_id = sp.id
     and rr.run_rank = 1
    order by sp.id
  `).all(afterSessionId ?? null, afterSessionId ?? null, boundedLimit) as Array<{
    id: string;
    status: string;
    updated_at: string;
    runtime_state: string | null;
    latest_status?: string | null;
    latest_last_heartbeat_at?: string | null;
    latest_worker_lease_until?: string | null;
    latest_finished_at?: string | null;
  }>;
  let reconciled = 0;
  let markedStale = 0;
  const now = new Date().toISOString();
  const updates: Array<{ id: string; state: WorkSessionRuntimeState }> = [];
  for (const row of rows) {
    const latestRun = row.latest_status == null
      ? undefined
      : {
          status: row.latest_status,
          lastHeartbeatAt: row.latest_last_heartbeat_at,
          workerLeaseUntil: row.latest_worker_lease_until,
          finishedAt: row.latest_finished_at,
        };
    const next = runtimeStateFor(row.status as WorkSessionStatus, row.updated_at, latestRun);
    if (row.runtime_state === next) continue;
    updates.push({ id: row.id, state: next });
    reconciled++;
    if (next === "stale" || next === "orphaned") markedStale++;
  }
  // Keep the page's write phase to one SQLite statement as well. A page is
  // deliberately bounded, but issuing one synchronous UPDATE per row would
  // still make the maintenance budget's yield boundary misleading under a
  // large reconciliation backlog.
  if (updates.length > 0) {
    const stateCases = updates.map(() => "when ? then ?").join(" ");
    const ids = updates.map(() => "?").join(", ");
    const parameters: unknown[] = [];
    for (const update of updates) parameters.push(update.id, update.state);
    parameters.push(now, ...updates.map((update) => update.id));
    db.sqlite.prepare(`
      update work_sessions
      set runtime_state = case id ${stateCases} else runtime_state end,
          runtime_classified_at = ?
      where id in (${ids})
    `).run(...parameters);
  }
  return {
    reconciled,
    markedStale,
    nextAfterId: rows.length > 0 ? rows[rows.length - 1]!.id : undefined,
    hasMore: rows.length === boundedLimit,
  };
}
