import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client.js";
import { reviewRoutes, reviewThreads, reviewThreadActivations, reviewThreadMessages, reviewHandoffs } from "../db/schema.js";

export interface ReviewThread {
  id: string;
  routeId: string;
  routeEpoch: number;
  workSessionId: string;
  ownerPrincipalId: string;
  reviewerPrincipalId?: string;
  reviewerContextId?: string;
  hostKind: string;
  hostConversationId?: string;
  hostBindingVerified: boolean;
  browserProfileId?: string;
  browserGeneration?: number;
  conversationUrl?: string;
  conversationKey?: string;
  conversationFingerprint?: string;
  conversationBindingRevision?: number;
  conversationBindingStatus?: string;
  status: "pending_activation" | "active" | "paused" | "closed";
  maxRounds: number;
  revision: number;
  createdAt: string;
  activatedAt?: string;
  closedAt?: string;
}

function asThread(row: typeof reviewThreads.$inferSelect): ReviewThread {
  return {
    id: row.id,
    routeId: row.routeId,
    routeEpoch: row.routeEpoch,
    workSessionId: row.workSessionId,
    ownerPrincipalId: row.ownerPrincipalId,
    reviewerPrincipalId: row.reviewerPrincipalId ?? undefined,
    reviewerContextId: row.reviewerContextId ?? undefined,
    hostKind: row.hostKind,
    hostConversationId: row.hostConversationId ?? undefined,
    hostBindingVerified: row.hostBindingVerified,
    browserProfileId: row.browserProfileId ?? undefined,
    browserGeneration: row.browserGeneration ?? undefined,
    conversationUrl: row.conversationUrl ?? undefined,
    conversationKey: row.conversationKey ?? undefined,
    conversationFingerprint: row.conversationFingerprint ?? undefined,
    conversationBindingRevision: row.conversationBindingRevision ?? undefined,
    conversationBindingStatus: row.conversationBindingStatus ?? undefined,
    status: row.status as ReviewThread["status"],
    maxRounds: row.maxRounds,
    revision: row.revision,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt ?? undefined,
    closedAt: row.closedAt ?? undefined,
  };
}

export interface ReviewThreadStore {
  getForRoute(routeId: string, routeEpoch: number): ReviewThread | undefined;
  getForContext(principalId: string, contextId: string): ReviewThread | undefined;
  listForContext(principalId: string, contextId: string): ReviewThread[];
  getById(threadId: string): ReviewThread | undefined;
  createActivation(input: { routeId: string; ownerPrincipalId: string; reviewerPrincipalId: string; ttlMs?: number }): { threadId: string; activationSecret: string; expiresAt: string };
  activate(input: { activationSecret: string; principalId: string; contextId: string; hostKind?: string; hostConversationId?: string }): ReviewThread;
  setRouteStatus(routeId: string, routeEpoch: number, status: "active" | "paused" | "disabled" | "closed"): void;
  closeForSession(workSessionId: string): void;
  listMessages(threadId: string): Array<typeof reviewThreadMessages.$inferSelect>;
  queueAgentMessage(input: { threadId: string; agentMessageId: string; kind: "clarification_request" | "blocker"; title?: string; body?: string }): typeof reviewThreadMessages.$inferSelect | undefined;
}

export function createReviewThreadStore(database: DatabaseHandle): ReviewThreadStore {
  const getForRoute = (routeId: string, routeEpoch: number) => {
    const row = database.db.select().from(reviewThreads).where(and(
      eq(reviewThreads.routeId, routeId), eq(reviewThreads.routeEpoch, routeEpoch),
    )).get();
    return row ? asThread(row) : undefined;
  };
  const getById = (threadId: string) => {
    const row = database.db.select().from(reviewThreads).where(eq(reviewThreads.id, threadId)).get();
    return row ? asThread(row) : undefined;
  };
  return {
    getForRoute,
    getById,
    getForContext(principalId, contextId) {
      const row = database.db.select().from(reviewThreads).where(and(
        eq(reviewThreads.reviewerPrincipalId, principalId),
        eq(reviewThreads.reviewerContextId, contextId),
        eq(reviewThreads.status, "active"),
      )).get();
      return row ? asThread(row) : undefined;
    },
    listForContext(principalId, contextId) {
      return database.db.select().from(reviewThreads).where(and(
        eq(reviewThreads.reviewerPrincipalId, principalId),
        eq(reviewThreads.reviewerContextId, contextId),
        eq(reviewThreads.status, "active"),
      )).all().map(asThread);
    },
    listMessages(threadId) {
      return database.db.select().from(reviewThreadMessages).where(eq(reviewThreadMessages.threadId, threadId)).all();
    },
    queueAgentMessage(input) {
      const thread = database.db.select().from(reviewThreads).where(eq(reviewThreads.id, input.threadId)).get();
      if (!thread || thread.status !== "active" || thread.conversationBindingStatus !== "bound") return undefined;
      const route = database.db.select().from(reviewRoutes).where(eq(reviewRoutes.id, thread.routeId)).get();
      if (!route || route.status !== "active" || route.routeEpoch !== thread.routeEpoch
        || route.deliveryTransport !== "native_cdp" || route.browserProfileId !== thread.browserProfileId) return undefined;
      const existing = database.db.select().from(reviewThreadMessages).where(and(
        eq(reviewThreadMessages.threadId, thread.id), eq(reviewThreadMessages.submissionId, input.agentMessageId), eq(reviewThreadMessages.reviewEpoch, 0),
      )).get();
      if (existing) return existing;
      const now = new Date().toISOString();
      const id = `rmsg_${randomUUID()}`;
      const payload = {
        version: 1,
        messageId: input.agentMessageId,
        kind: input.kind,
        title: input.title?.slice(0, 300),
        body: input.body?.slice(0, 8_000),
        truncated: (input.title?.length ?? 0) > 300 || (input.body?.length ?? 0) > 8_000,
      };
      const payloadJson = JSON.stringify(payload);
      database.db.insert(reviewThreadMessages).values({
        id, threadId: thread.id, routeEpoch: thread.routeEpoch, workSessionId: thread.workSessionId,
        handoffId: input.agentMessageId, submissionId: input.agentMessageId, reviewEpoch: 0,
        roundNumber: 0, kind: "agent_message",
        payloadJson,
        payloadSha256: createHash("sha256").update(payloadJson).digest("hex"),
        status: "queued", revision: 1, createdAt: now, updatedAt: now,
      }).run();
      return database.db.select().from(reviewThreadMessages).where(eq(reviewThreadMessages.id, id)).get();
    },
    createActivation(input) {
      const route = database.db.select().from(reviewRoutes).where(eq(reviewRoutes.id, input.routeId)).get();
      if (!route || route.ownerPrincipalId !== input.ownerPrincipalId || route.status !== "active") throw new Error("Review route owner authorization failed.");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + Math.max(60_000, Math.min(input.ttlMs ?? 30 * 60_000, 24 * 60 * 60_000))).toISOString();
      const raw = randomBytes(32).toString("base64url");
      const secret = `rta_${raw}`;
      const hash = createHash("sha256").update(secret).digest("hex");
      const thread = database.sqlite.transaction(() => {
        let current = getForRoute(route.id, route.routeEpoch);
        if (!current) {
          const id = `rthread_${randomUUID()}`;
          database.db.insert(reviewThreads).values({
            id, routeId: route.id, routeEpoch: route.routeEpoch, workSessionId: route.workSessionId,
            ownerPrincipalId: route.ownerPrincipalId, hostKind: "kontrol_ui", status: "pending_activation",
            maxRounds: route.maxReviewRounds, revision: 1, createdAt: now.toISOString(),
          }).run();
          current = getForRoute(route.id, route.routeEpoch);
        }
        if (!current || current.status === "closed") throw new Error("Review thread is closed.");
        database.db.insert(reviewThreadActivations).values({
          id: `rta_${randomUUID()}`, threadId: current.id, routeId: route.id, routeEpoch: route.routeEpoch,
          principalId: input.reviewerPrincipalId, activationSecretSha256: hash,
          createdAt: now.toISOString(), expiresAt,
        }).run();
        return current;
      })();
      return { threadId: thread.id, activationSecret: secret, expiresAt };
    },
    activate(input) {
      if (!input.contextId.trim()) throw new Error("Authenticated reviewer context is required.");
      const hash = createHash("sha256").update(input.activationSecret).digest("hex");
      const now = new Date().toISOString();
      return database.sqlite.transaction(() => {
        const grant = database.db.select().from(reviewThreadActivations).where(and(
          eq(reviewThreadActivations.activationSecretSha256, hash),
          eq(reviewThreadActivations.principalId, input.principalId),
          isNull(reviewThreadActivations.consumedAt), isNull(reviewThreadActivations.revokedAt),
          gt(reviewThreadActivations.expiresAt, now),
        )).get();
        if (!grant) throw new Error("Review thread activation is invalid, expired, or already consumed.");
        const route = database.db.select().from(reviewRoutes).where(eq(reviewRoutes.id, grant.routeId)).get();
        const thread = database.db.select().from(reviewThreads).where(eq(reviewThreads.id, grant.threadId)).get();
        if (!route || !thread || route.status !== "active" || route.routeEpoch !== grant.routeEpoch
          || thread.routeEpoch !== grant.routeEpoch || thread.status === "closed") {
          throw new Error("Review thread activation is stale for the current route.");
        }
        const existingContextBinding = database.db.select().from(reviewThreads).where(and(
          eq(reviewThreads.reviewerPrincipalId, input.principalId),
          eq(reviewThreads.reviewerContextId, input.contextId),
          eq(reviewThreads.status, "active"),
        )).all().find((bound) => bound.id !== thread.id);
        if (existingContextBinding) throw new Error("This authenticated context is already bound to another active review thread.");
        const rebindsThread = Boolean(thread.reviewerContextId
          && (thread.reviewerContextId !== input.contextId || thread.reviewerPrincipalId !== input.principalId));
        const consumed = database.db.update(reviewThreadActivations).set({ consumedAt: now }).where(and(
          eq(reviewThreadActivations.id, grant.id), isNull(reviewThreadActivations.consumedAt), isNull(reviewThreadActivations.revokedAt),
        )).run();
        if (consumed.changes !== 1) throw new Error("Review thread activation was consumed concurrently.");
        database.db.update(reviewThreadActivations).set({ revokedAt: now }).where(and(
          eq(reviewThreadActivations.threadId, thread.id), isNull(reviewThreadActivations.consumedAt), isNull(reviewThreadActivations.revokedAt),
        )).run();
        if (rebindsThread) {
          const releasedStatus = route.mode === "pinned_conversation" ? "ready" : "awaiting_attachment";
          database.db.update(reviewHandoffs).set({
            status: releasedStatus,
            claimedByPrincipalId: null,
            claimedByOwnerContextId: null,
            claimedAt: null,
            claimExpiresAt: null,
            revision: sql`${reviewHandoffs.revision} + 1`,
          }).where(and(eq(reviewHandoffs.routeId, route.id), eq(reviewHandoffs.routeEpoch, route.routeEpoch), eq(reviewHandoffs.status, "claimed"))).run();
          // A replacement reviewer context must receive any still-pending
          // packet again. Keep `presenting` fenced because the old host may
          // already have accepted it; explicit recovery can acknowledge the
          // possible duplicate before requeueing that uncertain state.
          database.db.update(reviewThreadMessages).set({ status: "queued", revision: sql`${reviewThreadMessages.revision} + 1`, updatedAt: now })
            .where(and(
              eq(reviewThreadMessages.threadId, thread.id),
              inArray(reviewThreadMessages.status, ["presented", "reviewer_claimed", "failed"]),
            )).run();
        }
        database.db.update(reviewThreads).set({
          reviewerPrincipalId: input.principalId,
          reviewerContextId: input.contextId,
          hostKind: input.hostKind ?? "kontrol_ui",
          hostConversationId: input.hostConversationId ?? null,
          hostBindingVerified: false,
          status: "active",
          activatedAt: thread.activatedAt ?? now,
          revision: thread.revision + 1,
        }).where(and(eq(reviewThreads.id, thread.id), eq(reviewThreads.revision, thread.revision))).run();
        database.db.update(reviewThreadMessages).set({ status: "queued", revision: sql`${reviewThreadMessages.revision} + 1`, updatedAt: now })
          .where(and(eq(reviewThreadMessages.threadId, thread.id), eq(reviewThreadMessages.status, "awaiting_activation"))).run();
        return getById(thread.id)!;
      })();
    },
    setRouteStatus(routeId, routeEpoch, status) {
      const nextThreadStatus = status === "active" ? "active" : status === "paused" ? "paused" : "closed";
      const current = database.db.select().from(reviewThreads).where(and(eq(reviewThreads.routeId, routeId), eq(reviewThreads.routeEpoch, routeEpoch))).get();
      if (!current || current.status === "closed") return;
      database.sqlite.transaction(() => {
        database.db.update(reviewThreads).set({
          status: nextThreadStatus,
          closedAt: nextThreadStatus === "closed" ? new Date().toISOString() : null,
          revision: sql`${reviewThreads.revision} + 1`,
        }).where(and(eq(reviewThreads.id, current.id), eq(reviewThreads.revision, current.revision))).run();
        if (nextThreadStatus !== "active") {
          database.db.update(reviewThreadMessages).set({ status: "awaiting_activation", revision: sql`${reviewThreadMessages.revision} + 1`, updatedAt: new Date().toISOString() })
            .where(and(eq(reviewThreadMessages.threadId, current.id), eq(reviewThreadMessages.status, "queued"))).run();
        } else {
          database.db.update(reviewThreadMessages).set({ status: "queued", revision: sql`${reviewThreadMessages.revision} + 1`, updatedAt: new Date().toISOString() })
            .where(and(eq(reviewThreadMessages.threadId, current.id), eq(reviewThreadMessages.status, "awaiting_activation"))).run();
        }
        if (nextThreadStatus === "closed") {
          database.db.update(reviewThreadActivations).set({ revokedAt: new Date().toISOString() }).where(and(eq(reviewThreadActivations.threadId, current.id), isNull(reviewThreadActivations.consumedAt), isNull(reviewThreadActivations.revokedAt))).run();
        }
      })();
    },
    closeForSession(workSessionId) {
      const now = new Date().toISOString();
      database.sqlite.prepare("update review_threads set status = 'closed', closed_at = ?, revision = revision + 1 where work_session_id = ? and status != 'closed'").run(now, workSessionId);
      database.sqlite.prepare("update review_thread_activations set revoked_at = ? where thread_id in (select id from review_threads where work_session_id = ?) and consumed_at is null and revoked_at is null").run(now, workSessionId);
    },
  };
}
