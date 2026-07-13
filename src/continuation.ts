import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { continuations, type ContinuationRow } from "./db/schema.js";

/**
 * Continuation — durable review-to-agent handoff packet.
 *
 * Status lifecycle: pending → claimed → delivered → completed
 */

export type ContinuationStatus = "pending" | "claimed" | "dispatched" | "completed" | "superseded";

export interface Continuation {
  id: string;
  sessionId: string;
  reviewId: string;
  feedbackEventId: string;
  reviewEpoch: number;
  verdict: string;
  requiredActions: string[];
  allowedNextActions: string[];
  reviewedDiffHash?: string;
  feedbackSummary?: string;
  resumeInstructions?: string;
  status: ContinuationStatus;
  target?: string;
  claimOwner?: string;
  claimedAt?: string;
  promptText: string;
  createdAt: string;
  deliveredAt?: string;
  consumedAt?: string;
}

export interface CreateContinuationInput {
  sessionId: string;
  reviewId: string;
  feedbackEventId: string;
  verdict: string;
  requiredActions?: string[];
  allowedNextActions?: string[];
  reviewedDiffHash?: string;
  feedbackSummary?: string;
  resumeInstructions?: string;
  submissionMessage?: string;
}

export interface ContinuationManager {
  create(input: CreateContinuationInput): Continuation;
  get(id: string): Continuation | undefined;
  getByFeedbackEventId(feedbackEventId: string): Continuation | undefined;
  listPending(sessionId?: string): Continuation[];
  listForSession(sessionId: string): Continuation[];
  claim(owner: string, opts?: { id?: string; sessionId?: string }): Continuation | null;
  release(owner: string, opts?: { id?: string; sessionId?: string }): void;
  reapExpiredClaims(leaseMs: number, owner?: string): number;
  supersede(id: string, reason: string): boolean;
  supersedeForSession(sessionId: string, reason: string): number;
  markDelivered(input: {
    id: string;
    expectedStatus: "claimed";
    claimOwner: string;
    targetRunId: string;
  }): boolean;
  markDispatched(id: string): void;
  markCompleted(id: string): void;
  getPrompt(feedbackEventId: string): string | undefined;
  close(): void;
}

export const DEFAULT_CLAIM_LEASE_MS = 60_000;

export function createContinuationManager(
  stateDirOrHandle: string | DatabaseHandle,
): ContinuationManager {
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;

  function create(input: CreateContinuationInput): Continuation {
    const now = new Date().toISOString();
    const id = `cont_${randomUUID()}`;
    const reviewEpoch = getNextEpoch(input.sessionId);

    const promptText = renderPrompt({
      sessionId: input.sessionId,
      reviewId: input.reviewId,
      feedbackEventId: input.feedbackEventId,
      verdict: input.verdict,
      requiredActions: input.requiredActions ?? [],
      allowedNextActions: input.allowedNextActions ?? [],
      resumeInstructions: input.resumeInstructions,
      submissionMessage: input.submissionMessage,
    });

    database.db
      .insert(continuations)
      .values({
        id,
        sessionId: input.sessionId,
        reviewId: input.reviewId,
        feedbackEventId: input.feedbackEventId,
        reviewEpoch,
        verdict: input.verdict,
        requiredActionsJson: JSON.stringify(input.requiredActions ?? []),
        allowedNextActionsJson: JSON.stringify(input.allowedNextActions ?? []),
        reviewedDiffHash: input.reviewedDiffHash ?? null,
        feedbackSummary: input.feedbackSummary ?? null,
        resumeInstructions: input.resumeInstructions ?? null,
        status: "pending",
        target: null,
        promptText,
        createdAt: now,
      })
      .run();

    return {
      id,
      sessionId: input.sessionId,
      reviewId: input.reviewId,
      feedbackEventId: input.feedbackEventId,
      reviewEpoch,
      verdict: input.verdict,
      requiredActions: input.requiredActions ?? [],
      allowedNextActions: input.allowedNextActions ?? [],
      reviewedDiffHash: input.reviewedDiffHash,
      feedbackSummary: input.feedbackSummary,
      resumeInstructions: input.resumeInstructions,
      status: "pending",
      promptText,
      createdAt: now,
    };
  }

  function getNextEpoch(sessionId: string): number {
    const latest = database.db
      .select()
      .from(continuations)
      .where(eq(continuations.sessionId, sessionId))
      .orderBy(desc(continuations.reviewEpoch))
      .limit(1)
      .get();
    return latest ? (latest.reviewEpoch ?? 0) + 1 : 1;
  }

  function get(id: string): Continuation | undefined {
    const row = database.db.select().from(continuations).where(eq(continuations.id, id)).get();
    return row ? rowToContinuation(row) : undefined;
  }

  function getByFeedbackEventId(feedbackEventId: string): Continuation | undefined {
    const row = database.db
      .select()
      .from(continuations)
      .where(eq(continuations.feedbackEventId, feedbackEventId))
      .orderBy(desc(continuations.createdAt))
      .limit(1)
      .get();
    return row ? rowToContinuation(row) : undefined;
  }

  function listPending(sessionId?: string): Continuation[] {
    const query = database.db
      .select()
      .from(continuations)
      .where(
        sessionId
          ? and(eq(continuations.status, "pending"), eq(continuations.sessionId, sessionId))
          : eq(continuations.status, "pending"),
      )
      .orderBy(asc(continuations.createdAt));
    return query.all().map(rowToContinuation);
  }

  function claim(owner: string, opts?: { id?: string; sessionId?: string }): Continuation | null {
    let candidate: ContinuationRow | undefined;
    if (opts?.id) {
      candidate = database.db.select().from(continuations).where(eq(continuations.id, opts.id)).get();
    } else if (opts?.sessionId) {
      candidate = database.db
        .select()
        .from(continuations)
        .where(and(eq(continuations.status, "pending"), eq(continuations.sessionId, opts.sessionId)))
        .orderBy(asc(continuations.createdAt))
        .limit(1)
        .get();
    } else {
      candidate = database.db
        .select()
        .from(continuations)
        .where(eq(continuations.status, "pending"))
        .orderBy(asc(continuations.createdAt))
        .limit(1)
        .get();
    }
    if (!candidate || candidate.status !== "pending") return null;

    const updated = database.db
      .update(continuations)
      .set({ status: "claimed", claimOwner: owner, claimedAt: new Date().toISOString() })
      .where(and(eq(continuations.id, candidate.id), eq(continuations.status, "pending")))
      .run();
    if (updated.changes === 0) return null;

    const claimed = database.db.select().from(continuations).where(eq(continuations.id, candidate.id)).get();
    return claimed ? rowToContinuation(claimed) : null;
  }

  function release(owner: string, opts?: { id?: string; sessionId?: string }): void {
    let where;
    if (opts?.id) {
      where = and(eq(continuations.status, "claimed"), eq(continuations.id, opts.id), eq(continuations.claimOwner, owner));
    } else if (opts?.sessionId) {
      where = and(eq(continuations.status, "claimed"), eq(continuations.sessionId, opts.sessionId), eq(continuations.claimOwner, owner));
    } else {
      where = and(eq(continuations.status, "claimed"), eq(continuations.claimOwner, owner));
    }
    database.db
      .update(continuations)
      .set({ status: "pending", claimOwner: null, claimedAt: null })
      .where(where)
      .run();
  }

  function reapExpiredClaims(leaseMs: number, owner?: string): number {
    const cutoff = new Date(Date.now() - leaseMs).toISOString();
    const base = and(eq(continuations.status, "claimed"), lt(continuations.claimedAt, cutoff));
    const where = owner ? and(base, eq(continuations.claimOwner, owner)) : base;
    const expired = database.db.select().from(continuations).where(where).all();
    if (expired.length === 0) return 0;
    for (const row of expired) {
      database.db
        .update(continuations)
        .set({ status: "pending", claimOwner: null, claimedAt: null })
        .where(eq(continuations.id, row.id))
        .run();
    }
    return expired.length;
  }

  function supersede(id: string, reason: string): boolean {
    const updated = database.db
      .update(continuations)
      .set({
        status: "superseded",
        claimOwner: null,
        claimedAt: null,
        feedbackSummary: reason,
        consumedAt: new Date().toISOString(),
      })
      .where(eq(continuations.id, id))
      .run();
    return updated.changes > 0;
  }

  function supersedeForSession(sessionId: string, reason: string): number {
    const updated = database.db
      .update(continuations)
      .set({
        status: "superseded",
        claimOwner: null,
        claimedAt: null,
        feedbackSummary: reason,
        consumedAt: new Date().toISOString(),
      })
      .where(and(eq(continuations.sessionId, sessionId), eq(continuations.status, "pending")))
      .run();
    const claimed = database.db
      .update(continuations)
      .set({
        status: "superseded",
        claimOwner: null,
        claimedAt: null,
        feedbackSummary: reason,
        consumedAt: new Date().toISOString(),
      })
      .where(and(eq(continuations.sessionId, sessionId), eq(continuations.status, "claimed")))
      .run();
    return updated.changes + claimed.changes;
  }

  function listForSession(sessionId: string): Continuation[] {
    const rows = database.db
      .select()
      .from(continuations)
      .where(eq(continuations.sessionId, sessionId))
      .orderBy(asc(continuations.createdAt))
      .all();
    return rows.map(rowToContinuation);
  }

  function markDelivered(input: {
    id: string;
    expectedStatus: "claimed";
    claimOwner: string;
    targetRunId: string;
  }): boolean {
    const updated = database.db
      .update(continuations)
      .set({ status: "dispatched", target: input.targetRunId, deliveredAt: new Date().toISOString() })
      .where(and(
        eq(continuations.id, input.id),
        eq(continuations.status, input.expectedStatus),
        eq(continuations.claimOwner, input.claimOwner),
      ))
      .run();
    return updated.changes > 0;
  }

  function markDispatched(id: string): void {
    database.db
      .update(continuations)
      .set({ status: "dispatched" })
      .where(eq(continuations.id, id))
      .run();
  }

  function markCompleted(id: string): void {
    database.db
      .update(continuations)
      .set({ status: "completed", consumedAt: new Date().toISOString() })
      .where(eq(continuations.id, id))
      .run();
  }

  function getPrompt(feedbackEventId: string): string | undefined {
    const row = database.db
      .select()
      .from(continuations)
      .where(eq(continuations.feedbackEventId, feedbackEventId))
      .orderBy(desc(continuations.createdAt))
      .limit(1)
      .get();
    return row ? row.promptText : undefined;
  }

  function close(): void {
    database.close();
  }

  return {
    create,
    get,
    getByFeedbackEventId,
    listPending,
    listForSession,
    claim,
    release,
    reapExpiredClaims,
    supersede,
    supersedeForSession,
    markDelivered,
    markDispatched,
    markCompleted,
    getPrompt,
    close,
  };
}

function rowToContinuation(row: ContinuationRow): Continuation {
  return {
    id: row.id,
    sessionId: row.sessionId,
    reviewId: row.reviewId,
    feedbackEventId: row.feedbackEventId,
    reviewEpoch: row.reviewEpoch ?? 1,
    verdict: row.verdict,
    requiredActions: JSON.parse(row.requiredActionsJson) as string[],
    allowedNextActions: JSON.parse(row.allowedNextActionsJson) as string[],
    reviewedDiffHash: row.reviewedDiffHash ?? undefined,
    feedbackSummary: row.feedbackSummary ?? undefined,
    resumeInstructions: row.resumeInstructions ?? undefined,
    status: row.status as ContinuationStatus,
    target: row.target ?? undefined,
    claimOwner: row.claimOwner ?? undefined,
    claimedAt: row.claimedAt ?? undefined,
    promptText: row.promptText,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt ?? undefined,
    consumedAt: row.consumedAt ?? undefined,
  };
}

function renderPrompt(input: {
  sessionId: string;
  reviewId: string;
  feedbackEventId: string;
  verdict: string;
  requiredActions: string[];
  allowedNextActions: string[];
  resumeInstructions?: string;
  submissionMessage?: string;
}): string {
  const lines: string[] = [];

  lines.push(`Review feedback has arrived for Kontrol work session ${input.sessionId}.`);
  lines.push("");
  lines.push(`Review ID: ${input.reviewId}`);
  lines.push(`Feedback event: ${input.feedbackEventId}`);
  lines.push(`Verdict: ${input.verdict}`);
  lines.push("");

  if (input.requiredActions.length > 0) {
    lines.push("Required actions:");
    input.requiredActions.forEach((action, i) => {
      lines.push(`${i + 1}. ${action}`);
    });
    lines.push("");
  }

  if (input.allowedNextActions.length > 0) {
    lines.push("Allowed next actions:");
    input.allowedNextActions.forEach((action) => {
      lines.push(`- ${action}`);
    });
    lines.push("");
  }

  lines.push("Use Kontrol MCP:");
  lines.push(`- get_work_session(sessionId="${input.sessionId}")`);
  lines.push(`- get_review_submission(sessionId="${input.sessionId}")`);
  lines.push("- continue from the persisted session state.");
  lines.push("");

  if (input.resumeInstructions) {
    lines.push(input.resumeInstructions);
    lines.push("");
  }

  lines.push("Do not restart from scratch. Continue this session and address the review feedback.");
  lines.push("");
  lines.push("You MUST:");
  lines.push("- Remain in the existing workspace.");
  lines.push("- Preserve unrelated user changes.");
  lines.push("- Address each required action.");
  lines.push("- Submit a new review revision when done.");
  lines.push("- Call submit_for_review, then await_review_feedback waiting for A-okay.");

  return lines.join("\n");
}
