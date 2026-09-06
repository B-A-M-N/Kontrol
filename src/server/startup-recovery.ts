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
    if (expired.length === 100) setImmediate(expireStartupApprovalPage);
  };
  expireStartupApprovalPage();
  // Durable rows survive a process restart; live transports and in-memory
  // worker maps do not. Reconcile only objects whose durable references make
  // their liveness unambiguous, and record each repair in the session event
  // log so recovery is inspectable rather than silently mutating state.
  const reconcileWorkSessionApprovalPage = (before?: { createdAt: string; id: string }): void => {
    if (startupRecoveryStopped) return;
    const page = approvalRequests.listPendingPage(undefined, 100, before, "work_session");
    for (const approval of page.requests) {
      const session = approval.workSessionId ? workSessions.get(approval.workSessionId) : undefined;
      const orphaned = Boolean(approval.workSessionId && (!session || terminalWorkSessionStatuses.has(session.status)));
      if (!orphaned) continue;
      const status = "cancelled" as const;
      approvalRequests.resolve(approval.approvalId, { status, reason: "startup_reconciliation: referenced work session is terminal or missing", reviewerId: "kontrol-startup" });
      startupRecovery.cancelledApprovals++;
      if (session) {
        eventStore.appendEvent({
          type: "recovery.approval.reconciled",
          sessionId: session.id,
          payload: { approvalId: approval.approvalId, status, reason: "startup_reconciliation" },
        }, { publish: false });
      }
    }
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
    const continuationRows = db.sqlite.prepare(`
      select c.id, c.session_id as sessionId, c.status, ws.status as workSessionStatus
      from continuations c
      left join work_sessions ws on ws.id = c.session_id
      where c.status in ('pending', 'claimed')
        and (? is null or c.id > ?)
      order by c.id
      limit ?
    `).all(afterId ?? null, afterId ?? null, 100) as Array<{ id: string; sessionId: string; status: string; workSessionStatus?: string | null }>;
    for (const continuation of continuationRows) {
      if (continuation.workSessionStatus && !terminalWorkSessionStatuses.has(continuation.workSessionStatus)) continue;
      if (!continuationManager.supersede(continuation.id, "startup_reconciliation: referenced work session is terminal or missing")) continue;
      startupRecovery.supersededContinuations++;
      if (continuation.workSessionStatus) {
        eventStore.appendEvent({
          type: "recovery.continuation.superseded",
          sessionId: continuation.sessionId,
          payload: { continuationId: continuation.id, reason: "startup_reconciliation" },
        }, { publish: false });
      }
    }
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
    const page = workSessions.reconcileRuntimeStates(afterId, 100);
    maintenance.resumeRuntimeReconciliationFrom(page.hasMore ? page.nextAfterId : undefined);
    startupRecovery.reconciledWorkSessions += page.reconciled;
    startupRecovery.markedStaleWorkSessions += page.markedStale;
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
  const reconcileTerminalGrantPage = (policyEngine: PolicyEngine, afterId?: string): void => {
    if (startupRecoveryStopped) return;
    const terminalIds = db.sqlite.prepare(`
      select id
      from work_sessions
      where status in ('approved', 'rejected', 'cancelled', 'failed', 'failed_protocol')
        and (? is null or id > ?)
      order by id
      limit ?
    `).all(afterId ?? null, afterId ?? null, 100) as Array<{ id: string }>;
    for (const session of terminalIds) policyEngine.revokeScope("work_session", session.id);
    if (terminalIds.length === 100) {
      const nextAfterId = terminalIds[terminalIds.length - 1]?.id;
      if (nextAfterId) setImmediate(() => reconcileTerminalGrantPage(policyEngine, nextAfterId));
    }
  };
  return {
    integrity,
    databaseIntegrity,
    terminalWorkSessionStatuses,
    reconcileTerminalGrants(policyEngine) {
      reconcileTerminalGrantPage(policyEngine);
    },
    stop(): void {
      startupRecoveryStopped = true;
    },
  };
}
