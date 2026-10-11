import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client.js";
import { reviewHandoffs, reviewRoutes, type ReviewHandoffRow, type ReviewRouteRow } from "../db/schema.js";

export type ReviewRouteMode = "pinned_conversation" | "isolated_review";
export type ReviewRouteStatus = "active" | "paused" | "disabled" | "closed";
export type ReviewHandoffStatus =
  | "queued"
  | "awaiting_attachment"
  | "ready"
  | "claimed"
  | "under_review"
  | "feedback_committed"
  | "superseded"
  | "blocked"
  | "closed";

export interface ReviewRoute {
  id: string;
  workSessionId: string;
  ownerPrincipalId: string;
  ownerContextId: string;
  mode: ReviewRouteMode;
  deliveryPolicy: "explicit_user_action" | "inbox_only";
  pinnedConversationId?: string;
  maxReviewRounds: number;
  completedReviewRounds: number;
  status: ReviewRouteStatus;
  routeEpoch: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewHandoff {
  id: string;
  routeId: string;
  workSessionId: string;
  submissionId: string;
  reviewEpoch: number;
  snapshotKind: "git" | "filesystem";
  snapshotRef: string;
  diffSha256: string;
  routeEpoch: number;
  roundNumber: number;
  destinationConversationId?: string;
  claimedByPrincipalId?: string;
  claimedByOwnerContextId?: string;
  status: ReviewHandoffStatus;
  revision: number;
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
}

export interface ConfigureReviewLoopInput {
  workSessionId: string;
  ownerPrincipalId: string;
  ownerContextId: string;
  enabled: boolean;
  mode: ReviewRouteMode;
  maxReviewRounds: number;
  pinnedConversationId?: string;
  expectedRevision?: number;
}

export interface ReviewRouteStore {
  configure(input: ConfigureReviewLoopInput): ReviewRoute;
  getRouteBySession(workSessionId: string): ReviewRoute | undefined;
  getHandoffById(handoffId: string): ReviewHandoff | undefined;
  getHandoffBySubmission(workSessionId: string, submissionId: string, reviewEpoch: number): ReviewHandoff | undefined;
  createHandoff(input: {
    routeId: string;
    workSessionId: string;
    submissionId: string;
    reviewEpoch: number;
    snapshotKind: "git" | "filesystem";
    snapshotRef: string;
    diffSha256: string;
    roundNumber: number;
  }): ReviewHandoff;
  claimHandoff(input: {
    handoffId: string;
    expectedRevision: number;
    principalId: string;
    ownerContextId: string;
    destinationConversationId?: string;
  }): ReviewHandoff;
  markHandoffStatus(input: {
    handoffId: string;
    expectedRevision: number;
    nextStatus: ReviewHandoffStatus;
    completed?: boolean;
  }): ReviewHandoff;
  incrementCompletedRound(input: { routeId: string; expectedRevision: number }): ReviewRoute;
  close(): void;
}

function rowToRoute(row: ReviewRouteRow): ReviewRoute {
  return {
    id: row.id,
    workSessionId: row.workSessionId,
    ownerPrincipalId: row.ownerPrincipalId,
    ownerContextId: row.ownerContextId,
    mode: row.mode as ReviewRouteMode,
    deliveryPolicy: row.deliveryPolicy as "explicit_user_action" | "inbox_only",
    pinnedConversationId: row.pinnedConversationId ?? undefined,
    maxReviewRounds: row.maxReviewRounds,
    completedReviewRounds: row.completedReviewRounds,
    status: row.status as ReviewRouteStatus,
    routeEpoch: row.routeEpoch,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToHandoff(row: ReviewHandoffRow): ReviewHandoff {
  return {
    id: row.id,
    routeId: row.routeId,
    workSessionId: row.workSessionId,
    submissionId: row.submissionId,
    reviewEpoch: row.reviewEpoch,
    snapshotKind: row.snapshotKind as "git" | "filesystem",
    snapshotRef: row.snapshotRef,
    diffSha256: row.diffSha256,
    routeEpoch: row.routeEpoch,
    roundNumber: row.roundNumber,
    destinationConversationId: row.destinationConversationId ?? undefined,
    claimedByPrincipalId: row.claimedByPrincipalId ?? undefined,
    claimedByOwnerContextId: row.claimedByOwnerContextId ?? undefined,
    status: row.status as ReviewHandoffStatus,
    revision: row.revision,
    createdAt: row.createdAt,
    claimedAt: row.claimedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
  };
}

export function createReviewRouteStore(database: DatabaseHandle): ReviewRouteStore {
  const getRouteBySession = (workSessionId: string): ReviewRoute | undefined => {
    const row = database.db.select().from(reviewRoutes)
      .where(eq(reviewRoutes.workSessionId, workSessionId))
      .orderBy(asc(reviewRoutes.createdAt))
      .all()[0];
    return row ? rowToRoute(row) : undefined;
  };

  const getHandoffById = (handoffId: string): ReviewHandoff | undefined => {
    const row = database.db.select().from(reviewHandoffs).where(eq(reviewHandoffs.id, handoffId)).get();
    return row ? rowToHandoff(row) : undefined;
  };

  const getHandoffBySubmission = (workSessionId: string, submissionId: string, reviewEpoch: number): ReviewHandoff | undefined => {
    const row = database.db.select().from(reviewHandoffs)
      .where(and(
        eq(reviewHandoffs.workSessionId, workSessionId),
        eq(reviewHandoffs.submissionId, submissionId),
        eq(reviewHandoffs.reviewEpoch, reviewEpoch),
      ))
      .get();
    return row ? rowToHandoff(row) : undefined;
  };

  return {
    configure(input) {
      if (input.maxReviewRounds < 1 || input.maxReviewRounds > 10) throw new Error("maxReviewRounds must be between 1 and 10.");
      const existing = getRouteBySession(input.workSessionId);
      const now = new Date().toISOString();
      if (!existing) {
        const id = `route_${randomUUID()}`;
        database.db.insert(reviewRoutes).values({
          id,
          workSessionId: input.workSessionId,
          ownerPrincipalId: input.ownerPrincipalId,
          ownerContextId: input.ownerContextId,
          mode: input.mode,
          deliveryPolicy: "explicit_user_action",
          pinnedConversationId: input.pinnedConversationId ?? null,
          maxReviewRounds: input.maxReviewRounds,
          completedReviewRounds: 0,
          status: input.enabled ? "active" : "disabled",
          routeEpoch: 1,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        }).run();
        return getRouteBySession(input.workSessionId)!;
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
        throw new Error(`Review route revision conflict; expected ${input.expectedRevision}, current ${existing.revision}.`);
      }
      const changedMode = input.mode !== existing.mode
        || (input.pinnedConversationId ?? undefined) !== existing.pinnedConversationId;
      database.db.update(reviewRoutes).set({
        mode: input.mode,
        pinnedConversationId: input.pinnedConversationId ?? null,
        maxReviewRounds: input.maxReviewRounds,
        status: input.enabled ? "active" : "disabled",
        routeEpoch: changedMode ? existing.routeEpoch + 1 : existing.routeEpoch,
        revision: existing.revision + 1,
        updatedAt: now,
      }).where(eq(reviewRoutes.id, existing.id)).run();
      return getRouteBySession(input.workSessionId)!;
    },

    getRouteBySession,

    getHandoffById,
    getHandoffBySubmission,

    createHandoff(input) {
      const route = getRouteBySession(input.workSessionId);
      if (!route || route.status === "closed") throw new Error("Review route is not active.");
      if (route.status !== "active") throw new Error(`Review route is ${route.status}.`);
      if (route.completedReviewRounds >= route.maxReviewRounds) throw new Error("Review round limit reached.");
      const id = `handoff_${randomUUID()}`;
      const now = new Date().toISOString();
      database.sqlite.transaction(() => {
        database.db.insert(reviewHandoffs).values({
          id,
          routeId: route.id,
          workSessionId: input.workSessionId,
          submissionId: input.submissionId,
          reviewEpoch: input.reviewEpoch,
          snapshotKind: input.snapshotKind,
          snapshotRef: input.snapshotRef,
          diffSha256: input.diffSha256,
          routeEpoch: route.routeEpoch,
          roundNumber: route.completedReviewRounds + 1,
          status: route.mode === "pinned_conversation" ? "ready" : "awaiting_attachment",
          revision: 1,
          createdAt: now,
        }).run();
        database.db.update(reviewRoutes).set({
          completedReviewRounds: route.completedReviewRounds + 1,
          revision: route.revision + 1,
          updatedAt: now,
        }).where(eq(reviewRoutes.id, route.id)).run();
      })();
      return getHandoffBySubmission(input.workSessionId, input.submissionId, input.reviewEpoch)!;
    },

    claimHandoff(input) {
      const now = new Date().toISOString();
      const updated = database.db.update(reviewHandoffs).set({
        status: "claimed",
        claimedByPrincipalId: input.principalId,
        claimedByOwnerContextId: input.ownerContextId,
        destinationConversationId: input.destinationConversationId ?? null,
        claimedAt: now,
        revision: input.expectedRevision + 1,
      }).where(and(
        eq(reviewHandoffs.id, input.handoffId),
        eq(reviewHandoffs.revision, input.expectedRevision),
      )).run();
      if (updated.changes !== 1) throw new Error("Review handoff claim conflict.");
      const row = database.db.select().from(reviewHandoffs).where(eq(reviewHandoffs.id, input.handoffId)).get();
      if (!row) throw new Error("Review handoff disappeared after claim.");
      return rowToHandoff(row);
    },

    markHandoffStatus(input) {
      const now = new Date().toISOString();
      const values: Record<string, unknown> = {
        status: input.nextStatus,
        revision: input.expectedRevision + 1,
      };
      if (input.completed) values.completedAt = now;
      const updated = database.db.update(reviewHandoffs).set(values).where(and(
        eq(reviewHandoffs.id, input.handoffId),
        eq(reviewHandoffs.revision, input.expectedRevision),
      )).run();
      if (updated.changes !== 1) throw new Error("Review handoff status transition conflict.");
      const row = database.db.select().from(reviewHandoffs).where(eq(reviewHandoffs.id, input.handoffId)).get();
      if (!row) throw new Error("Review handoff disappeared after transition.");
      return rowToHandoff(row);
    },

    incrementCompletedRound(input) {
      const current = database.db.select().from(reviewRoutes).where(eq(reviewRoutes.id, input.routeId)).get();
      if (!current) throw new Error("Review route disappeared.");
      const updated = database.db.update(reviewRoutes).set({
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }).where(and(
        eq(reviewRoutes.id, input.routeId),
        eq(reviewRoutes.revision, input.expectedRevision),
      )).run();
      if (updated.changes !== 1) throw new Error("Review route increment conflict.");
      const row = database.db.select().from(reviewRoutes).where(eq(reviewRoutes.id, input.routeId)).get();
      return rowToRoute(row!);
    },

    close() {
      database.close();
    },
  };
}
