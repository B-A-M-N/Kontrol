/**
 * Startup reconciliation: paged expiry of pending approvals, orphaned
 * work-session approvals, terminal continuations, runtime states, and
 * terminal work-session grants. Extracted verbatim from src/server.ts
 * (P1.2); the createServer closures become an explicit dependency object.
 */
import type { DatabaseHandle } from "../db/client.js";
import type { ServerConfig } from "../config.js";
import { createDatabaseIntegrityMonitor } from "../runtime/database-integrity.js";
import { createApprovalRequestManager } from "../approval-requests.js";
import { createWorkSessionManager } from "../work-sessions.js";
import { createEventStore } from "../event-log.js";
import { createContinuationManager } from "../continuation.js";
import { createMaintenanceCoordinator } from "../runtime/maintenance.js";
import { createSupervisorRuns } from "../supervisor-runs.js";

import { createPolicyEngine } from "../policy.js";

type ApprovalRequestManager = ReturnType<typeof createApprovalRequestManager>;
type WorkSessionManager = ReturnType<typeof createWorkSessionManager>;
type EventStore = ReturnType<typeof createEventStore>;
type ContinuationManager = ReturnType<typeof createContinuationManager>;
type MaintenanceCoordinator = ReturnType<typeof createMaintenanceCoordinator>;
type SupervisorRuns = ReturnType<typeof createSupervisorRuns>;
type PolicyEngine = ReturnType<typeof createPolicyEngine>;

export interface StartupRecoveryCounters {
  at: string;
  expiredApprovals: number;
  cancelledApprovals: number;
  supersededContinuations: number;
  releasedSupervisorLeases: number;
  reconciledWorkSessions: number;
  markedStaleWorkSessions: number;
  recoveryWork: {
    examinedRows: number;
    modifiedRows: number;
    totalDurationMs: number;
    longestSynchronousSliceMs: number;
  };
}

function recordRecoverySlice(counters: StartupRecoveryCounters, startedAt: number, examined: number, modified: number): void {
  const durationMs = Math.max(0, performance.now() - startedAt);
  counters.recoveryWork.examinedRows += examined;
  counters.recoveryWork.modifiedRows += modified;
  counters.recoveryWork.totalDurationMs += durationMs;
  counters.recoveryWork.longestSynchronousSliceMs = Math.max(counters.recoveryWork.longestSynchronousSliceMs, durationMs);
}

export interface StartupRecoveryDeps {
  readonly config: ServerConfig;
  readonly db: DatabaseHandle;
  readonly startupRecovery: StartupRecoveryCounters;
  readonly approvalRequests: ApprovalRequestManager;
  readonly workSessions: WorkSessionManager;
  readonly eventStore: EventStore;
  readonly continuationManager: ContinuationManager;
  readonly maintenance: MaintenanceCoordinator;
  readonly supervisorRuns: SupervisorRuns;
}

export interface StartupRecoveryHandles {
  readonly integrity: ReturnType<typeof createDatabaseIntegrityMonitor>;
  readonly databaseIntegrity: unknown;
  readonly terminalWorkSessionStatuses: Set<string>;
  reconcileTerminalGrants(policyEngine: PolicyEngine): void;
  stop(): void;
}

export function reconcileReplyDeliveryPage(db: DatabaseHandle, after?: { createdAt: string; id: string }, limit = 100): { examined: number; reconciled: number; next?: { createdAt: string; id: string } } {
  const page = db.sqlite.prepare(`select id, created_at from agent_message_replies
    where status = 'delivering'
      and (? is null or created_at > ? or (created_at = ? and id > ?))
    order by created_at, id limit ?`).all(after?.createdAt ?? null, after?.createdAt ?? null,
      after?.createdAt ?? null, after?.id ?? null, limit) as Array<{ id: string; created_at: string }>;
  for (const reply of page) db.sqlite.prepare("update agent_message_replies set status = 'awaiting_acknowledgement' where id = ? and status = 'delivering'").run(reply.id);
  const last = page.at(-1);
  return {
    reconciled: page.length,
    examined: page.length,
    ...(page.length === limit && last ? { next: { createdAt: last.created_at, id: last.id } } : {}),
  };
}

export function reconcileReviewHandoffPage(db: DatabaseHandle, afterId?: string, limit = 100): { examined: number; reconciled: number; nextAfterId?: string } {
  const rows = db.sqlite.prepare(`select h.id, ws.status as work_session_status
      from review_handoffs h left join work_sessions ws on ws.id = h.work_session_id
      where h.status not in ('closed', 'feedback_committed')
        and (ws.id is null or ws.status in ('approved', 'rejected', 'cancelled', 'failed', 'failed_protocol'))
        and (? is null or h.id > ?)
      order by h.id limit ?`)
    .all(afterId ?? null, afterId ?? null, limit) as Array<{ id: string; work_session_status: string | null }>;
  let reconciled = 0;
  for (const row of rows) {
    const terminalSession = ["approved", "rejected", "cancelled", "failed", "failed_protocol"].includes(row.work_session_status ?? "");
    if (!terminalSession && row.work_session_status !== null) continue;
    reconciled += db.sqlite.prepare("update review_handoffs set status = 'closed', completed_at = coalesce(completed_at, ?) where id = ? and status not in ('closed', 'feedback_committed')")
      .run(new Date().toISOString(), row.id).changes;
  }
  const last = rows.at(-1);
  return { examined: rows.length, reconciled, ...(rows.length === limit && last ? { nextAfterId: last.id } : {}) };
}

export function reconcileTerminalGrantPage(
  db: DatabaseHandle,
  policyEngine: Pick<PolicyEngine, "revokeScope">,
  afterId?: string,
  limit = 100,
): { examined: number; reconciled: number; nextAfterId?: string } {
  const grantScopes = db.sqlite.prepare(`
    select distinct g.scope_id as id
    from policy_approval_grants g
    left join work_sessions ws on ws.id = g.scope_id
    where g.scope = 'work_session'
      and g.revoked_at is null
      and (g.expires_at is null or g.expires_at > ?)
      and (ws.id is null or ws.status in ('approved', 'rejected', 'cancelled', 'failed', 'failed_protocol'))
      and (? is null or g.scope_id > ?)
    order by g.scope_id
    limit ?
  `).all(new Date().toISOString(), afterId ?? null, afterId ?? null, limit) as Array<{ id: string }>;
  for (const row of grantScopes) policyEngine.revokeScope("work_session", row.id);
  const last = grantScopes.at(-1);
  return {
    examined: grantScopes.length,
    reconciled: grantScopes.length,
    ...(grantScopes.length === limit && last ? { nextAfterId: last.id } : {}),
  };
}

export function createStartupReconciliation(deps: StartupRecoveryDeps): StartupRecoveryHandles {
  const { config, db, approvalRequests, workSessions, eventStore, continuationManager, maintenance } = deps;
  const startupRecovery = deps.startupRecovery;
  const integrity = createDatabaseIntegrityMonitor(config);
  const databaseIntegrity = integrity.state;
  const terminalWorkSessionStatuses = new Set(["approved", "rejected", "cancelled", "failed", "failed_protocol"]);
  let startupRecoveryStopped = false;
  // P1: a direct MCP approval is a PENDING HUMAN DECISION, not an orphan. It
  // parks no live waiter, so it consumes no execution resources and stays
  // decidable until its normal approval TTL — expirePending (startup and
  // maintenance) is the only automatic cancellation path. The reattach
  // deadline remains a diagnostic classification (abandoned_operation), never
  // a cancellation trigger.
  // Expire pending approvals once during startup as well as during the normal
  // maintenance loop. This keeps expiry correct across long idle periods and
  // makes the recovery count reflect actual rows changed at startup.
  const expireStartupApprovalPage = (): void => {
    if (startupRecoveryStopped) return;
    const pageStartedAt = performance.now();
    const expired = approvalRequests.expirePending(undefined, 100);
    for (const approval of expired) {
      const session = approval.workSessionId ? workSessions.get(approval.workSessionId) : undefined;
      startupRecovery.expiredApprovals++;
      if (session) {
        eventStore.appendEvent({
          type: "recovery.approval.expired",
          sessionId: session.id,
          payload: { approvalId: approval.approvalId, reason: "approval expired during startup reconciliation" },
        }, { publish: false });
      }
    }
    recordRecoverySlice(startupRecovery, pageStartedAt, expired.length, expired.length);
    if (expired.length === 100) setImmediate(expireStartupApprovalPage);
  };
  expireStartupApprovalPage();
  // Durable rows survive a process restart; live transports and in-memory
  // worker maps do not. Reconcile only objects whose durable references make
  // their liveness unambiguous, and record each repair in the session event
  // log so recovery is inspectable rather than silently mutating state.
  const reconcileWorkSessionApprovalPage = (before?: { createdAt: string; id: string }): void => {
    if (startupRecoveryStopped) return;
    const pageStartedAt = performance.now();
    const page = approvalRequests.listPendingPage(undefined, 100, before, "work_session");
    let modified = 0;
    for (const approval of page.requests) {
      const session = approval.workSessionId ? workSessions.get(approval.workSessionId) : undefined;
      const orphaned = Boolean(approval.workSessionId && (!session || terminalWorkSessionStatuses.has(session.status)));
      if (!orphaned) continue;
      const status = "cancelled" as const;
      approvalRequests.resolve(approval.approvalId, { status, reason: "startup_reconciliation: referenced work session is terminal or missing", reviewerId: "kontrol-startup" });
      modified += 1;
      startupRecovery.cancelledApprovals++;
      if (session) {
        eventStore.appendEvent({
          type: "recovery.approval.reconciled",
          sessionId: session.id,
          payload: { approvalId: approval.approvalId, status, reason: "startup_reconciliation" },
        }, { publish: false });
      }
    }
    recordRecoverySlice(startupRecovery, pageStartedAt, page.requests.length, modified);
    if (page.hasMore) setImmediate(() => reconcileWorkSessionApprovalPage(page.nextBefore));
  };
  reconcileWorkSessionApprovalPage();
  // Recovery is deliberately paged. The old unrestricted join could block
  // startup on a pathological continuation history, while only repairing the
  // first page would leave terminal references behind forever. Reconcile one
  // bounded page synchronously, then yield the remainder after the server can
  // serve requests.
  const reconcileContinuationPage = (afterId?: string): void => {
    if (startupRecoveryStopped) return;
    const pageStartedAt = performance.now();
    const continuationRows = db.sqlite.prepare(`
      select c.id, c.session_id as sessionId, c.status, ws.status as workSessionStatus
      from continuations c
      left join work_sessions ws on ws.id = c.session_id
      where c.status in ('pending', 'claimed')
        and (? is null or c.id > ?)
      order by c.id
      limit ?
    `).all(afterId ?? null, afterId ?? null, 100) as Array<{ id: string; sessionId: string; status: string; workSessionStatus?: string | null }>;
    let modified = 0;
    for (const continuation of continuationRows) {
      if (continuation.workSessionStatus && !terminalWorkSessionStatuses.has(continuation.workSessionStatus)) continue;
      if (!continuationManager.supersede(continuation.id, "startup_reconciliation: referenced work session is terminal or missing")) continue;
      startupRecovery.supersededContinuations++;
      modified += 1;
      if (continuation.workSessionStatus) {
        eventStore.appendEvent({
          type: "recovery.continuation.superseded",
          sessionId: continuation.sessionId,
          payload: { continuationId: continuation.id, reason: "startup_reconciliation" },
        }, { publish: false });
      }
    }
    recordRecoverySlice(startupRecovery, pageStartedAt, continuationRows.length, modified);
    if (continuationRows.length === 100) {
      const nextAfterId = continuationRows[continuationRows.length - 1]?.id;
      if (nextAfterId) setImmediate(() => reconcileContinuationPage(nextAfterId));
    }
  };
  reconcileContinuationPage();
  // Runtime reconciliation is also paged during startup. Keep the first page
  // bounded, then yield between every subsequent page instead of deferring an
  // arbitrarily large remainder to the next five-minute maintenance tick.
  const reconcileRuntimeStatePage = (afterId?: string): void => {
    if (startupRecoveryStopped) return;
    const pageStartedAt = performance.now();
    const page = workSessions.reconcileRuntimeStates(afterId, 100);
    maintenance.resumeRuntimeReconciliationFrom(page.hasMore ? page.nextAfterId : undefined);
    startupRecovery.reconciledWorkSessions += page.reconciled;
    startupRecovery.markedStaleWorkSessions += page.markedStale;
    recordRecoverySlice(startupRecovery, pageStartedAt, page.examined ?? page.reconciled + page.markedStale, page.reconciled);
    if (page.hasMore && page.nextAfterId) {
      setImmediate(() => reconcileRuntimeStatePage(page.nextAfterId));
    }
  };
  reconcileRuntimeStatePage();
  // Reconcile grants created by an older process that terminated before its
  // lifecycle callback ran. Workspace grants intentionally survive restart;
  // work-session grants never survive the terminal boundary. Select only IDs
  // and page the history so startup does not hydrate a bounded projection and
  // silently miss older terminal sessions.
  // Replies survive restart. `delivering` was recorded only after an adapter
  // acceptance receipt, so preserve that fact and await the worker's exact ack
  // instead of making an already dispatched reply eligible for another send.
  const reconcileReplyPage = (after?: { createdAt: string; id: string }): void => {
    if (startupRecoveryStopped) return;
    const pageStartedAt = performance.now();
    const page = reconcileReplyDeliveryPage(db, after);
    recordRecoverySlice(startupRecovery, pageStartedAt, page.examined, page.reconciled);
    if (page.next) setImmediate(() => reconcileReplyPage(page.next));
  };
  reconcileReplyPage();

  // Stale review handoffs: mark claimed handoffs of terminal sessions closed,
  // and queued isolated handoffs remain awaiting attachment.
  const reconcileHandoffPage = (afterId?: string): void => {
    if (startupRecoveryStopped) return;
    const pageStartedAt = performance.now();
    const page = reconcileReviewHandoffPage(db, afterId);
    recordRecoverySlice(startupRecovery, pageStartedAt, page.examined, page.reconciled);
    if (page.nextAfterId) setImmediate(() => reconcileHandoffPage(page.nextAfterId));
  };
  reconcileHandoffPage();

  const reconcileTerminalGrantBatch = (policyEngine: PolicyEngine, afterId?: string): void => {
    if (startupRecoveryStopped) return;
    const pageStartedAt = performance.now();
    const page = reconcileTerminalGrantPage(db, policyEngine, afterId, 100);
    recordRecoverySlice(startupRecovery, pageStartedAt, page.examined, page.reconciled);
    if (page.nextAfterId) {
      setImmediate(() => reconcileTerminalGrantBatch(policyEngine, page.nextAfterId));
    }
  };
  return {
    integrity,
    databaseIntegrity,
    terminalWorkSessionStatuses,
    reconcileTerminalGrants(policyEngine) {
      reconcileTerminalGrantBatch(policyEngine);
    },
    stop(): void {
      startupRecoveryStopped = true;
    },
  };
}
