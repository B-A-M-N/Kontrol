import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client.js";
import { reviewHandoffs, reviewRoutes, reviewThreads, reviewThreadMessages, type ReviewHandoffRow, type ReviewRouteRow } from "../db/schema.js";

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
  admittedReviewRounds: number;
  status: ReviewRouteStatus;
  routeEpoch: number;
  revision: number;
  warningAcknowledgedAt?: string;
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
  claimExpiresAt?: string;
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
  getReviewPacketByHandoff(handoffId: string): Record<string, unknown> | undefined;
  setReviewPacket(input: { handoffId: string; payloadJson: string; payloadSha256: string }): void;
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
    reviewThreadId?: string;
    destinationConversationId?: string;
    claimLeaseMs?: number;
  }): ReviewHandoff;
  renewHandoffClaim(input: {
    handoffId: string;
    expectedRevision: number;
    principalId: string;
    ownerContextId: string;
    claimLeaseMs?: number;
  }): ReviewHandoff;
  markHandoffStatus(input: {
    handoffId: string;
    expectedRevision: number;
    nextStatus: ReviewHandoffStatus;
    completed?: boolean;
  }): ReviewHandoff;
  incrementCompletedRound(input: { routeId: string; expectedRevision: number }): ReviewRoute;
  /**
   * L04: change only the route's automation status (active/paused/disabled)
   * without altering the selected routing mode or its round budget. Used by
   * pause/resume/disable controls.
   */
  setStatus(input: { workSessionId: string; expectedRevision?: number; status: ReviewRouteStatus }): ReviewRoute;
  closeThreadForSession(workSessionId: string): void;
  markWarningAcknowledged(input: { workSessionId: string; expectedRevision: number }): ReviewRoute;
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
    admittedReviewRounds: row.admittedReviewRounds,
    status: row.status as ReviewRouteStatus,
    routeEpoch: row.routeEpoch,
    revision: row.revision,
    warningAcknowledgedAt: row.warningAcknowledgedAt ?? undefined,
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
    claimExpiresAt: row.claimExpiresAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
  };
}

export function createReviewRouteStore(database: DatabaseHandle): ReviewRouteStore {
  const supersedeRouteEpoch = (routeId: string, routeEpoch: number, now: string): void => {
    const threads = database.db.select({ id: reviewThreads.id }).from(reviewThreads).where(and(
      eq(reviewThreads.routeId, routeId), eq(reviewThreads.routeEpoch, routeEpoch),
    )).all();
    if (threads.length === 0) return;
    database.db.update(reviewThreads).set({ status: "closed", closedAt: now, revision: sql`${reviewThreads.revision} + 1` })
      .where(and(eq(reviewThreads.routeId, routeId), eq(reviewThreads.routeEpoch, routeEpoch), sql`${reviewThreads.status} != 'closed'`)).run();
    database.sqlite.prepare("update review_thread_activations set revoked_at = ? where route_id = ? and route_epoch = ? and consumed_at is null and revoked_at is null")
      .run(now, routeId, routeEpoch);
    database.db.update(reviewHandoffs).set({
      status: "superseded",
      claimedByPrincipalId: null,
      claimedByOwnerContextId: null,
      claimedAt: null,
      claimExpiresAt: null,
      revision: sql`${reviewHandoffs.revision} + 1`,
    }).where(and(
      eq(reviewHandoffs.routeId, routeId), eq(reviewHandoffs.routeEpoch, routeEpoch),
      sql`${reviewHandoffs.status} in ('queued', 'awaiting_attachment', 'ready', 'claimed', 'under_review')`,
    )).run();
    database.db.update(reviewThreadMessages).set({
      status: "superseded",
      revision: sql`${reviewThreadMessages.revision} + 1`,
      updatedAt: now,
    }).where(and(
      eq(reviewThreadMessages.routeEpoch, routeEpoch),
      sql`${reviewThreadMessages.threadId} in (select id from review_threads where route_id = ${routeId} and route_epoch = ${routeEpoch})`,
      sql`${reviewThreadMessages.status} in ('awaiting_activation', 'queued', 'presenting', 'reviewer_claimed')`,
    )).run();
  };
  const syncThreadDeliveryStatus = (routeId: string, routeEpoch: number, status: "active" | "paused", now: string): void => {
    const threads = database.db.select().from(reviewThreads).where(and(
      eq(reviewThreads.routeId, routeId), eq(reviewThreads.routeEpoch, routeEpoch), sql`${reviewThreads.status} != 'closed'`,
    )).all();
    for (const thread of threads) {
      const activated = Boolean(thread.reviewerPrincipalId && thread.reviewerContextId);
      const threadStatus = status === "paused" && activated ? "paused" : status === "active" && activated ? "active" : "pending_activation";
      if (thread.status !== threadStatus) database.db.update(reviewThreads).set({ status: threadStatus, revision: sql`${reviewThreads.revision} + 1` })
        .where(and(eq(reviewThreads.id, thread.id), eq(reviewThreads.revision, thread.revision))).run();
    }
    if (status === "paused") {
      database.db.update(reviewThreadMessages).set({ status: "awaiting_activation", revision: sql`${reviewThreadMessages.revision} + 1`, updatedAt: now })
        .where(and(sql`${reviewThreadMessages.threadId} in (select id from review_threads where route_id = ${routeId} and route_epoch = ${routeEpoch})`, eq(reviewThreadMessages.status, "queued"))).run();
    } else {
      database.db.update(reviewThreadMessages).set({ status: "queued", revision: sql`${reviewThreadMessages.revision} + 1`, updatedAt: now })
        .where(and(
          sql`${reviewThreadMessages.threadId} in (select id from review_threads where route_id = ${routeId} and route_epoch = ${routeEpoch} and status = 'active')`,
          eq(reviewThreadMessages.status, "awaiting_activation"),
        )).run();
    }
  };

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
      const now = new Date().toISOString();
      const configured = database.sqlite.transaction((): ReviewRoute => {
        const existing = getRouteBySession(input.workSessionId);
        if (!existing) {
          const id = `route_${randomUUID()}`;
          const insertResult = database.db.insert(reviewRoutes).values({
            id,
            workSessionId: input.workSessionId,
            ownerPrincipalId: input.ownerPrincipalId,
            ownerContextId: input.ownerContextId,
            mode: input.mode,
            deliveryPolicy: "explicit_user_action",
            pinnedConversationId: input.pinnedConversationId ?? null,
            maxReviewRounds: input.maxReviewRounds,
            completedReviewRounds: 0,
            admittedReviewRounds: 0,
            status: input.enabled ? "active" : "disabled",
            routeEpoch: 1,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          }).run();
          if (insertResult.changes !== 1) {
            throw new Error(`Review route already exists for work session ${input.workSessionId}.`);
          }
          return getRouteBySession(input.workSessionId)!;
        }

        if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
          throw new Error(`Review route revision conflict; expected ${input.expectedRevision}, current ${existing.revision}.`);
        }
        if (input.maxReviewRounds < existing.admittedReviewRounds) {
          throw new Error(`maxReviewRounds cannot be reduced below ${existing.admittedReviewRounds} already-admitted rounds.`);
        }
        const changedMode = input.mode !== existing.mode
          || (input.pinnedConversationId ?? undefined) !== existing.pinnedConversationId;
        const changesGeneration = changedMode
          || (input.enabled && existing.status === "disabled")
          || (!input.enabled && existing.status !== "disabled");
        if (changesGeneration) supersedeRouteEpoch(existing.id, existing.routeEpoch, now);
        database.db.update(reviewRoutes).set({
          mode: input.mode,
          pinnedConversationId: input.pinnedConversationId ?? null,
          maxReviewRounds: input.maxReviewRounds,
          status: input.enabled ? "active" : "disabled",
          routeEpoch: changesGeneration ? existing.routeEpoch + 1 : existing.routeEpoch,
          revision: existing.revision + 1,
          warningAcknowledgedAt: existing.warningAcknowledgedAt ?? null,
          updatedAt: now,
        }).where(eq(reviewRoutes.id, existing.id)).run();
        if (input.maxReviewRounds !== existing.maxReviewRounds && !changesGeneration) {
          database.db.update(reviewThreads).set({
            maxRounds: input.maxReviewRounds,
            revision: sql`${reviewThreads.revision} + 1`,
          }).where(and(
            eq(reviewThreads.routeId, existing.id), eq(reviewThreads.routeEpoch, existing.routeEpoch),
            sql`${reviewThreads.status} != 'closed'`,
          )).run();
        }
        if (!changesGeneration && input.enabled) syncThreadDeliveryStatus(existing.id, existing.routeEpoch, "active", now);
        return getRouteBySession(input.workSessionId)!;
      });
      return configured();
    },

    getRouteBySession,

    getHandoffById,
    getHandoffBySubmission,

    getReviewPacketByHandoff(handoffId) {
      const row = database.db.select().from(reviewThreadMessages).where(eq(reviewThreadMessages.handoffId, handoffId)).get();
      if (!row || createHash("sha256").update(row.payloadJson).digest("hex") !== row.payloadSha256) return undefined;
      try {
        const packet = JSON.parse(row.payloadJson) as Record<string, unknown>;
        return packet.version === 1 ? packet : undefined;
      } catch { return undefined; }
    },

    setReviewPacket(input) {
      const row = database.db.select().from(reviewThreadMessages).where(eq(reviewThreadMessages.handoffId, input.handoffId)).get();
      if (!row) throw new Error("Review thread message does not exist for this handoff.");
      if (row.payloadSha256 === input.payloadSha256) return;
      if (createHash("sha256").update(input.payloadJson).digest("hex") !== input.payloadSha256) throw new Error("Review packet content hash mismatch.");
      let current: Record<string, unknown> | undefined;
      try { current = JSON.parse(row.payloadJson) as Record<string, unknown>; } catch { /* corrupt placeholder is replaced only before presentation */ }
      if (current?.version !== undefined) return;
      if (row.status === "presented" || row.status === "reviewer_claimed" || row.status === "feedback_committed") {
        throw new Error("Review packet is immutable after preparation or presentation.");
      }
      const updated = database.db.update(reviewThreadMessages).set({
        payloadJson: input.payloadJson,
        payloadSha256: input.payloadSha256,
        revision: row.revision + 1,
        updatedAt: new Date().toISOString(),
      }).where(and(eq(reviewThreadMessages.id, row.id), eq(reviewThreadMessages.revision, row.revision))).run();
      if (updated.changes !== 1) throw new Error("Review packet preparation revision conflict.");
    },

    createHandoff(input) {
      return database.sqlite.transaction(() => {
        const route = getRouteBySession(input.workSessionId);
        if (!route || route.status === "closed" || route.status === "disabled") throw new Error("Review route is not active.");
        if (route.status !== "active") throw new Error(`Review route is ${route.status}.`);
        const existing = getHandoffBySubmission(input.workSessionId, input.submissionId, input.reviewEpoch);
        if (existing) {
          if (existing.snapshotKind !== input.snapshotKind || existing.snapshotRef !== input.snapshotRef || existing.diffSha256 !== input.diffSha256) {
            throw new Error("Review handoff idempotency conflict: submission identity is already bound to different snapshot content.");
          }
          return existing;
        }
        if (route.admittedReviewRounds >= route.maxReviewRounds) throw new Error("Review round limit reached.");
        const id = `handoff_${randomUUID()}`;
        const now = new Date().toISOString();
        let thread = database.db.select().from(reviewThreads).where(and(
          eq(reviewThreads.routeId, route.id), eq(reviewThreads.routeEpoch, route.routeEpoch),
        )).get();
        if (!thread) {
          const threadId = `rthread_${randomUUID()}`;
          database.db.insert(reviewThreads).values({
            id: threadId, routeId: route.id, routeEpoch: route.routeEpoch,
            workSessionId: route.workSessionId, ownerPrincipalId: route.ownerPrincipalId,
            hostKind: "kontrol_ui", status: "pending_activation", maxRounds: route.maxReviewRounds,
            revision: 1, createdAt: now,
          }).run();
          thread = database.db.select().from(reviewThreads).where(eq(reviewThreads.id, threadId)).get();
        }
        if (!thread || thread.status === "closed") throw new Error("Review thread is closed.");
        const nextRound = route.admittedReviewRounds + 1;
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
          roundNumber: nextRound,
          status: route.mode === "pinned_conversation" ? "ready" : "awaiting_attachment",
          revision: 1,
          createdAt: now,
        }).run();
        const routeUpdate = database.db.update(reviewRoutes).set({
          admittedReviewRounds: nextRound,
          revision: route.revision + 1,
          updatedAt: now,
        }).where(and(eq(reviewRoutes.id, route.id), eq(reviewRoutes.revision, route.revision), eq(reviewRoutes.admittedReviewRounds, route.admittedReviewRounds))).run();
        if (routeUpdate.changes !== 1) throw new Error("Review route round admission conflict.");
        const packet = JSON.stringify({
          handoffId: id,
          submissionId: input.submissionId,
          reviewEpoch: input.reviewEpoch,
          snapshotKind: input.snapshotKind,
          snapshotRef: input.snapshotRef,
          diffSha256: input.diffSha256,
          roundNumber: nextRound,
          requestedDecision: "Review this immutable submission and return approve, changes_requested, or reject with evidence.",
        });
        database.db.insert(reviewThreadMessages).values({
          id: `rtmsg_${randomUUID()}`, threadId: thread.id, routeEpoch: route.routeEpoch,
          workSessionId: input.workSessionId, submissionId: input.submissionId, reviewEpoch: input.reviewEpoch,
          handoffId: id,
          roundNumber: nextRound, kind: nextRound === 1 ? "initial_review" : "resubmission",
          payloadJson: packet, payloadSha256: createHash("sha256").update(packet).digest("hex"),
          status: thread.status === "active" ? "queued" : "awaiting_activation",
          revision: 1, createdAt: now, updatedAt: now,
        }).run();
        return getHandoffBySubmission(input.workSessionId, input.submissionId, input.reviewEpoch)!;
      })();
    },

    claimHandoff(input) {
      return database.sqlite.transaction(() => {
        const handoff = getHandoffById(input.handoffId);
        if (!handoff) throw new Error(`Unknown review handoff: ${input.handoffId}`);
        const route = getRouteBySession(handoff.workSessionId);
        if (!route) throw new Error("Review route disappeared before claim.");
        if (handoff.routeEpoch !== route.routeEpoch || route.status !== "active") {
          throw new Error(`Review handoff is not claimable on a ${route.status} route with epoch ${route.routeEpoch}.`);
        }
        if (route.mode === "isolated_review") {
          if (!input.reviewThreadId) throw new Error("An activated reviewer thread is required to claim isolated review.");
          const thread = database.db.select().from(reviewThreads).where(and(
            eq(reviewThreads.id, input.reviewThreadId), eq(reviewThreads.routeId, route.id),
            eq(reviewThreads.routeEpoch, route.routeEpoch), eq(reviewThreads.workSessionId, route.workSessionId),
          )).get();
          if (!thread || thread.status !== "active") throw new Error("Review thread is not active for this route epoch.");
          if (thread.reviewerPrincipalId !== input.principalId) throw new Error("Reviewer principal does not match the activated review thread.");
          if (thread.reviewerContextId !== input.ownerContextId) throw new Error("Reviewer context is not bound to the activated review thread.");
        } else {
          const required = route.pinnedConversationId ?? route.ownerContextId;
          if (input.principalId !== route.ownerPrincipalId || input.ownerContextId !== required) {
            throw new Error("Review handoff must be claimed by the pinned reviewer context.");
          }
        }
        const nowDate = new Date();
        const now = nowDate.toISOString();
        const leaseMs = Math.max(1_000, Math.min(input.claimLeaseMs ?? 15 * 60_000, 60 * 60_000));
        const claimExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
        const reclaimingExpiredClaim = handoff.status === "claimed"
          && Boolean(handoff.claimExpiresAt)
          && Date.parse(handoff.claimExpiresAt!) <= nowDate.getTime();
        if (handoff.status === "claimed" && !reclaimingExpiredClaim) {
          if (handoff.claimedByPrincipalId === input.principalId
            && handoff.claimedByOwnerContextId === input.ownerContextId
            && handoff.revision === input.expectedRevision) return handoff;
          throw new Error("Review handoff already has a live reviewer claim.");
        }
        const expectedSource = reclaimingExpiredClaim
          ? "claimed"
          : route.mode === "pinned_conversation" ? "ready" : "awaiting_attachment";
        const updated = database.db.update(reviewHandoffs).set({
          status: "claimed",
          claimedByPrincipalId: input.principalId,
          claimedByOwnerContextId: input.ownerContextId,
          destinationConversationId: input.destinationConversationId ?? null,
          claimedAt: now,
          claimExpiresAt,
          revision: input.expectedRevision + 1,
        }).where(and(
          eq(reviewHandoffs.id, input.handoffId),
          eq(reviewHandoffs.revision, input.expectedRevision),
          eq(reviewHandoffs.status, expectedSource),
          ...(reclaimingExpiredClaim ? [sql`${reviewHandoffs.claimExpiresAt} <= ${now}`] : []),
        )).run();
        if (updated.changes !== 1) throw new Error("Review handoff claim conflict or invalid lifecycle state.");
        const thread = input.reviewThreadId ? database.db.select().from(reviewThreads).where(eq(reviewThreads.id, input.reviewThreadId)).get() : undefined;
        if (thread) database.db.update(reviewThreadMessages).set({ status: "reviewer_claimed", revision: sql`${reviewThreadMessages.revision} + 1`, updatedAt: now })
          .where(and(eq(reviewThreadMessages.handoffId, input.handoffId), eq(reviewThreadMessages.threadId, thread.id))).run();
        const row = database.db.select().from(reviewHandoffs).where(eq(reviewHandoffs.id, input.handoffId)).get();
        if (!row) throw new Error("Review handoff disappeared after claim.");
        return rowToHandoff(row);
      })();
    },

    renewHandoffClaim(input) {
      return database.sqlite.transaction(() => {
        const handoff = getHandoffById(input.handoffId);
        if (!handoff) throw new Error(`Unknown review handoff: ${input.handoffId}`);
        const route = getRouteBySession(handoff.workSessionId);
        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        if (!route || route.status !== "active" || handoff.routeEpoch !== route.routeEpoch) {
          throw new Error("Review claim cannot be renewed for an inactive or stale route.");
        }
        if (handoff.status !== "claimed" || handoff.revision !== input.expectedRevision
          || handoff.claimedByPrincipalId !== input.principalId
          || handoff.claimedByOwnerContextId !== input.ownerContextId
          || !handoff.claimedAt || !handoff.claimExpiresAt || Date.parse(handoff.claimExpiresAt) <= nowMs) {
          throw new Error("Review claim is expired, released, or bound to a different reviewer.");
        }
        const maximumClaimDurationMs = 2 * 60 * 60_000;
        const maximumExpiry = Date.parse(handoff.claimedAt) + maximumClaimDurationMs;
        const requestedLeaseMs = Math.max(60_000, Math.min(input.claimLeaseMs ?? 15 * 60_000, 30 * 60_000));
        const claimExpiresAt = new Date(Math.min(nowMs + requestedLeaseMs, maximumExpiry)).toISOString();
        if (Date.parse(claimExpiresAt) <= nowMs) throw new Error("The maximum cumulative review-claim duration has elapsed.");
        const updated = database.db.update(reviewHandoffs).set({
          claimExpiresAt,
          revision: input.expectedRevision + 1,
        }).where(and(
          eq(reviewHandoffs.id, handoff.id),
          eq(reviewHandoffs.revision, input.expectedRevision),
          eq(reviewHandoffs.status, "claimed"),
          eq(reviewHandoffs.claimedByPrincipalId, input.principalId),
          eq(reviewHandoffs.claimedByOwnerContextId, input.ownerContextId),
          sql`${reviewHandoffs.claimExpiresAt} > ${now}`,
        )).run();
        if (updated.changes !== 1) throw new Error("Review claim renewal compare-and-swap conflict.");
        return getHandoffById(input.handoffId)!;
      })();
    },

    markHandoffStatus(input) {
      return database.sqlite.transaction(() => {
      const now = new Date().toISOString();
      const current = database.db.select().from(reviewHandoffs).where(eq(reviewHandoffs.id, input.handoffId)).get();
      if (!current) throw new Error("Review handoff not found.");
      const rowStatus = current.status as ReviewHandoffStatus;
      const allowedSources: Record<string, string[]> = {
        feedback_committed: ["claimed"],
        awaiting_attachment: ["claimed"],
        ready: ["claimed"],
      };
      const sourceStatuses = allowedSources[input.nextStatus] ?? [];
      if (!sourceStatuses.includes(rowStatus)) throw new Error(`Review handoff transition ${rowStatus} -> ${input.nextStatus} is not allowed.`);
      const values: Record<string, unknown> = {
        status: input.nextStatus,
        revision: input.expectedRevision + 1,
      };
      if (input.nextStatus === "awaiting_attachment" || input.nextStatus === "ready" || input.nextStatus === "feedback_committed") {
        values.claimedByPrincipalId = null;
        values.claimedByOwnerContextId = null;
        values.claimedAt = null;
        values.claimExpiresAt = null;
      }
      if (input.completed) values.completedAt = now;
      const updated = database.db.update(reviewHandoffs).set(values).where(and(
        eq(reviewHandoffs.id, input.handoffId),
        eq(reviewHandoffs.revision, input.expectedRevision),
        eq(reviewHandoffs.status, rowStatus),
      )).run();
      if (updated.changes !== 1) throw new Error("Review handoff status transition conflict.");
      if (input.nextStatus === "feedback_committed") {
        database.db.update(reviewRoutes).set({
          completedReviewRounds: sql`${reviewRoutes.completedReviewRounds} + 1`,
          revision: sql`${reviewRoutes.revision} + 1`, updatedAt: now,
        }).where(eq(reviewRoutes.id, current.routeId)).run();
        database.db.update(reviewThreadMessages).set({ status: "feedback_committed", revision: sql`${reviewThreadMessages.revision} + 1`, updatedAt: now })
          .where(and(eq(reviewThreadMessages.workSessionId, current.workSessionId), eq(reviewThreadMessages.submissionId, current.submissionId), eq(reviewThreadMessages.reviewEpoch, current.reviewEpoch))).run();
      } else if (input.nextStatus === "awaiting_attachment" || input.nextStatus === "ready") {
        database.db.update(reviewThreadMessages).set({ status: "presented", revision: sql`${reviewThreadMessages.revision} + 1`, updatedAt: now })
          .where(eq(reviewThreadMessages.handoffId, input.handoffId)).run();
      }
      const row = database.db.select().from(reviewHandoffs).where(eq(reviewHandoffs.id, input.handoffId)).get();
      if (!row) throw new Error("Review handoff disappeared after transition.");
      return rowToHandoff(row);
      })();
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

    markWarningAcknowledged(input) {
      const existing = getRouteBySession(input.workSessionId);
      if (!existing) throw new Error("No review route is configured for this work session.");
      if (input.expectedRevision !== existing.revision) {
        throw new Error(`Review route revision conflict; expected ${input.expectedRevision}, current ${existing.revision}.`);
      }
      database.db.update(reviewRoutes).set({
        warningAcknowledgedAt: new Date().toISOString(),
        revision: existing.revision + 1,
        updatedAt: new Date().toISOString(),
      }).where(eq(reviewRoutes.id, existing.id)).run();
      return getRouteBySession(input.workSessionId)!;
    },

    setStatus(input) {
      return database.sqlite.transaction(() => {
        const existing = getRouteBySession(input.workSessionId);
        if (!existing) throw new Error("No review route is configured for this work session.");
        if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
          throw new Error(`Review route revision conflict; expected ${input.expectedRevision}, current ${existing.revision}.`);
        }
        const now = new Date().toISOString();
        const disables = (input.status === "disabled" || input.status === "closed")
          && existing.status !== input.status;
        if (disables) supersedeRouteEpoch(existing.id, existing.routeEpoch, now);
        const updated = database.db.update(reviewRoutes).set({
          status: input.status,
          routeEpoch: disables ? existing.routeEpoch + 1 : existing.routeEpoch,
          revision: existing.revision + 1,
          updatedAt: now,
        }).where(and(eq(reviewRoutes.id, existing.id), eq(reviewRoutes.revision, existing.revision))).run();
        if (updated.changes !== 1) throw new Error("Review route status compare-and-swap conflict.");
        if (!disables && (input.status === "active" || input.status === "paused")) {
          syncThreadDeliveryStatus(existing.id, existing.routeEpoch, input.status, now);
        }
        return getRouteBySession(input.workSessionId)!;
      })();
    },

    closeThreadForSession(workSessionId) {
      const now = new Date().toISOString();
      database.sqlite.transaction(() => {
        const threads = database.db.select().from(reviewThreads).where(eq(reviewThreads.workSessionId, workSessionId)).all();
        for (const thread of threads) {
          database.db.update(reviewThreads).set({ status: "closed", closedAt: now, revision: sql`${reviewThreads.revision} + 1` })
            .where(eq(reviewThreads.id, thread.id)).run();
          database.sqlite.prepare("update review_thread_activations set revoked_at = ? where thread_id = ? and consumed_at is null and revoked_at is null").run(now, thread.id);
        }
      })();
    },

    close() {
      database.close();
    },
  };
}
