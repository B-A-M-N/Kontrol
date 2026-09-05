/**
 * WorkSessionStore: CRUD over the work_sessions table
 *
 * Extracted verbatim from SqliteWorkSessionManager (P1 god-object
 * decomposition). Shares the caller's DatabaseHandle. Cross-store effects
 * (workspace-lease release and onTerminal notification on terminal status)
 * are injected so this store never reaches into another store's module.
 */
import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client.js";
import {
  workSessions,
  acpRuns,
  workspaceSessions,
  type WorkSessionRow,
} from "../db/schema.js";
import type {
  CompletionPolicy,
  WorkSession,
  WorkSessionStatus,
} from "./types.js";
import { isTerminalStatus, lifecycleForRuntimeState } from "./internal.js";
import { runtimeStateFor } from "./runtime-state.js";
import { getLatestSubmission, getLatestFeedback } from "./review-store.js";

export interface WorkSessionStoreDeps {
  db: DatabaseHandle;
  /** Release this session's workspace leases (lease-store callback). */
  releaseWorkspaceLeasesForSession(workSessionId: string): number;
  /** Optional terminal-status observer (grant revocation in server.ts). */
  onTerminal?: (workSessionId: string) => void;
}

export function createWorkSessionStore(deps: WorkSessionStoreDeps) {
  const { db, releaseWorkspaceLeasesForSession, onTerminal } = deps;

  const projectIdForWorkspace = (workspaceSessionId: string): string | undefined => {
    const row = db.db.select({ projectId: workspaceSessions.projectId })
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, workspaceSessionId))
      .get();
    return row?.projectId ?? undefined;
  };

  const latestRunForSession = (workSessionId: string): {
    status: string;
    lastHeartbeatAt?: string | null;
    workerLeaseUntil?: string | null;
    finishedAt?: string | null;
  } | undefined => {
    const row = db.db.select({
      status: acpRuns.status,
      lastHeartbeatAt: acpRuns.lastHeartbeatAt,
      workerLeaseUntil: acpRuns.workerLeaseUntil,
      finishedAt: acpRuns.finishedAt,
    }).from(acpRuns)
      .where(eq(acpRuns.workSessionId, workSessionId))
      .orderBy(desc(acpRuns.createdAt))
      .limit(1)
      .get();
    return row;
  };

  const enrichSession = (row: WorkSessionRow): WorkSession => {
    const latestSubmission = getLatestSubmission(db, row.id);
    const latestFeedback = getLatestFeedback(db, row.id);
    const status = row.status as WorkSessionStatus;
    const runtimeState = row.runtimeState && row.runtimeState !== "pending"
      ? row.runtimeState as import("./types.js").WorkSessionRuntimeState
      : runtimeStateFor(status, row.updatedAt, latestRunForSession(row.id));

    return {
      id: row.id,
      projectId: row.projectId ?? undefined,
      workspaceSessionId: row.workspaceSessionId,
      status,
      completionPolicy: (row.completionPolicy as CompletionPolicy | undefined) ?? "agent_completion",
      reviewEpoch: row.reviewEpoch ?? 0,
      submittedBy: row.submittedBy,
      title: row.title ?? undefined,
      lastConsumedFeedbackId: row.lastConsumedFeedbackId ?? undefined,
      lastConsumedReviewEpoch: row.lastConsumedReviewEpoch ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      latestSubmission,
      latestFeedback,
      lifecycle: lifecycleForRuntimeState(status, runtimeState),
      runtimeState,
    };
  };

  return {
    /** Hydrate a raw row into the enriched WorkSession projection. */
    enrichSession,

    create(input: { workspaceSessionId: string; submittedBy: string; title?: string; completionPolicy?: CompletionPolicy }): WorkSession {
      const now = new Date().toISOString();
      const projectId = projectIdForWorkspace(input.workspaceSessionId);
      const session: WorkSession = {
        id: `wsess_${randomUUID()}`,
        projectId,
        workspaceSessionId: input.workspaceSessionId,
        status: "in_progress",
        completionPolicy: input.completionPolicy ?? "agent_completion",
        reviewEpoch: 0,
        submittedBy: input.submittedBy,
        title: input.title,
        lastConsumedReviewEpoch: 0,
        createdAt: now,
        updatedAt: now,
        lifecycle: "pending",
        runtimeState: "pending",
      };

      db.db
        .insert(workSessions)
        .values({
          id: session.id,
          projectId: session.projectId ?? null,
          workspaceSessionId: session.workspaceSessionId,
          status: session.status,
          runtimeState: session.runtimeState,
          runtimeClassifiedAt: now,
          completionPolicy: session.completionPolicy,
          reviewEpoch: session.reviewEpoch,
          submittedBy: session.submittedBy,
          title: session.title ?? null,
          lastConsumedFeedbackId: null,
          lastConsumedReviewEpoch: 0,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        })
        .run();

      return session;
    },

    get(id: string): WorkSession | undefined {
      const row = db.db.select().from(workSessions).where(eq(workSessions.id, id)).get();
      if (!row) return undefined;
      return enrichSession(row);
    },

    listByWorkspace(workspaceSessionId: string, limit = 10): WorkSession[] {
      const projectId = projectIdForWorkspace(workspaceSessionId);
      const rows = db.db
        .select()
        .from(workSessions)
        .where(projectId ? eq(workSessions.projectId, projectId) : eq(workSessions.workspaceSessionId, workspaceSessionId))
        .orderBy(desc(workSessions.updatedAt))
        .limit(limit)
        .all();
      return rows.map((row) => enrichSession(row));
    },

    updateStatus(id: string, status: WorkSessionStatus): void {
      const now = new Date().toISOString();
      const runtimeState = isTerminalStatus(status)
        ? "archived"
        : status === "awaiting_review" || status === "review_in_progress"
          ? "parked"
          : status === "changes_requested"
            ? "detached"
            : "pending";
      db.db
        .update(workSessions)
        .set({ status, runtimeState, runtimeClassifiedAt: now, updatedAt: now })
        .where(eq(workSessions.id, id))
        .run();
      if (isTerminalStatus(status)) {
        releaseWorkspaceLeasesForSession(id);
        onTerminal?.(id);
      }
    },
  };
}

export type WorkSessionStore = ReturnType<typeof createWorkSessionStore>;
