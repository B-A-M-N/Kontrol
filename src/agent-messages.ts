import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { agentMessages, agentMessageReplies, agentReplyWaits, type AgentMessageReplyRow, type AgentMessageRow, type AgentReplyWaitRow } from "./db/schema.js";

export type AgentMessageKind =
  | "clarification_request"
  | "blocker"
  | "finding"
  | "artifact"
  | "note";

export const AGENT_MESSAGE_KINDS: AgentMessageKind[] = [
  "clarification_request",
  "blocker",
  "finding",
  "artifact",
  "note",
];

export type AgentMessageStatus = "open" | "resolved";

export type AgentReplyStatus = "pending_delivery" | "delivering" | "acknowledged" | "blocked" | "cancelled";

export interface AgentMessageReply {
  id: string;
  messageId: string;
  workSessionId: string;
  replyRevision: number;
  body: string;
  bodySha256: string;
  reviewerPrincipalId: string;
  status: AgentReplyStatus;
  createdAt: string;
  acknowledgedAt?: string;
  acknowledgedRunId?: string;
  acknowledgedAttempt?: number;
  acknowledgedActorId?: string;
}

export interface AgentReplyWait {
  id: string;
  messageId: string;
  workSessionId: string;
  runId?: string;
  workerAttempt: number;
  expectsReply: boolean;
  resumeOnReply: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessage {
  id: string;
  workSessionId: string;
  runId?: string;
  kind: AgentMessageKind;
  author: string;
  title?: string;
  body?: string;
  data: Record<string, unknown>;
  replyToId?: string;
  status: AgentMessageStatus;
  createdAt: string;
  resolvedAt?: string;
}

export interface AgentMessageManager {
  post(input: {
    workSessionId: string;
    runId?: string;
    kind: AgentMessageKind;
    author?: string;
    title?: string;
    body?: string;
    data?: Record<string, unknown>;
    replyToId?: string;
  }): AgentMessage;
  get(id: string): AgentMessage | undefined;
  list(workSessionId: string, opts?: { kind?: AgentMessageKind; openOnly?: boolean }): AgentMessage[];
  resolve(id: string): { message: AgentMessage | undefined; changed: boolean };
  acceptReply(input: { messageId: string; workSessionId: string; body: string; reviewerPrincipalId: string }): AgentMessageReply;
  getReply(replyId: string): AgentMessageReply | undefined;
  listPendingReplies(workSessionId: string): AgentMessageReply[];
  listReplies(workSessionId: string): AgentMessageReply[];
  acknowledgeReply(input: { replyId: string; workSessionId: string; runId: string; attempt: number; actorId: string }): AgentMessageReply;
  setReplyDelivery(input: { replyId: string; expectedStatus: AgentReplyStatus; nextStatus: AgentReplyStatus }): AgentMessageReply | undefined;
  waitForReply(input: { messageId: string; workSessionId: string; runId?: string; attempt: number; expectsReply: boolean; resumeOnReply: boolean }): AgentReplyWait;
  getActiveWaitForMessage(messageId: string): AgentReplyWait | undefined;
  closeWait(input: { messageId: string; workSessionId: string }): void;
  close(): void;
}

export function createAgentMessageManager(
  stateDirOrHandle: string | DatabaseHandle,
): AgentMessageManager {
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;

  function post(input: {
    workSessionId: string;
    runId?: string;
    kind: AgentMessageKind;
    author?: string;
    title?: string;
    body?: string;
    data?: Record<string, unknown>;
    replyToId?: string;
  }): AgentMessage {
    const id = `msg_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    // A clarification_request/blocker is an open question by construction; a
    // finding/artifact/note is a record, not a gate — mark it resolved so it
    // never shows as an outstanding demand on the reviewer.
    const gating = input.kind === "clarification_request" || input.kind === "blocker";
    const status: AgentMessageStatus = gating ? "open" : "resolved";
    const resolvedAt = gating ? null : createdAt;

    database.db
      .insert(agentMessages)
      .values({
        id,
        workSessionId: input.workSessionId,
        runId: input.runId ?? null,
        kind: input.kind,
        author: input.author ?? "worker",
        title: input.title ?? null,
        body: input.body ?? null,
        dataJson: JSON.stringify(input.data ?? {}),
        replyToId: input.replyToId ?? null,
        status,
        createdAt,
        resolvedAt,
      })
      .run();

    return {
      id,
      workSessionId: input.workSessionId,
      runId: input.runId,
      kind: input.kind,
      author: input.author ?? "worker",
      title: input.title,
      body: input.body,
      data: input.data ?? {},
      replyToId: input.replyToId,
      status,
      createdAt,
      resolvedAt: resolvedAt ?? undefined,
    };
  }

  function get(id: string): AgentMessage | undefined {
    const row = database.db.select().from(agentMessages).where(eq(agentMessages.id, id)).get();
    return row ? rowToMessage(row) : undefined;
  }

  function list(
    workSessionId: string,
    opts: { kind?: AgentMessageKind; openOnly?: boolean } = {},
  ): AgentMessage[] {
    const conditions = [eq(agentMessages.workSessionId, workSessionId)];
    if (opts.kind) conditions.push(eq(agentMessages.kind, opts.kind));
    if (opts.openOnly) conditions.push(eq(agentMessages.status, "open"));

    return database.db
      .select()
      .from(agentMessages)
      .where(conditions.length === 1 ? conditions[0] : and(...conditions))
      .orderBy(asc(agentMessages.createdAt))
      .all()
      .map(rowToMessage);
  }

  function rowToReply(row: AgentMessageReplyRow): AgentMessageReply {
    return {
      id: row.id,
      messageId: row.messageId,
      workSessionId: row.workSessionId,
      replyRevision: row.replyRevision,
      body: row.body,
      bodySha256: row.bodySha256,
      reviewerPrincipalId: row.reviewerPrincipalId,
      status: row.status as AgentReplyStatus,
      createdAt: row.createdAt,
      acknowledgedAt: row.acknowledgedAt ?? undefined,
      acknowledgedRunId: row.acknowledgedRunId ?? undefined,
      acknowledgedAttempt: row.acknowledgedAttempt ?? undefined,
      acknowledgedActorId: row.acknowledgedActorId ?? undefined,
    };
  }

  function acceptReply(input: { messageId: string; workSessionId: string; body: string; reviewerPrincipalId: string }): AgentMessageReply {
    if (!input.body.trim()) throw new Error("Reply body must not be empty.");
    const existingForMessage = database.db.select().from(agentMessageReplies)
      .where(eq(agentMessageReplies.messageId, input.messageId))
      .all();
    if (existingForMessage.length > 0) {
      const prior = existingForMessage[0]!;
      if (prior.bodySha256 === createHash("sha256").update(input.body).digest("hex")
        && prior.reviewerPrincipalId === input.reviewerPrincipalId
        && prior.workSessionId === input.workSessionId) {
        return rowToReply(prior);
      }
      throw new Error(`Message ${input.messageId} already has an accepted reply.`);
    }
    const message = get(input.messageId);
    if (!message || message.workSessionId !== input.workSessionId) throw new Error("Message not found for this session.");
    if (!["clarification_request", "blocker"].includes(message.kind)) throw new Error(`Message kind ${message.kind} is not replyable.`);
    if (message.status === "resolved") throw new Error(`Message ${input.messageId} is already resolved.`);
    const id = `reply_${randomUUID()}`;
    const now = new Date().toISOString();
    database.sqlite.transaction(() => {
      database.db.insert(agentMessageReplies).values({
        id,
        messageId: input.messageId,
        workSessionId: input.workSessionId,
        replyRevision: 1,
        body: input.body,
        bodySha256: createHash("sha256").update(input.body).digest("hex"),
        reviewerPrincipalId: input.reviewerPrincipalId,
        status: "pending_delivery",
        createdAt: now,
      }).run();
      database.db.update(agentMessages)
        .set({ status: "resolved", resolvedAt: now })
        .where(and(eq(agentMessages.id, input.messageId), eq(agentMessages.status, "open")))
        .run();
    })();
    const created = getReply(id);
    if (!created) throw new Error("Reply commit could not be read back.");
    return created;
  }

  function getReply(replyId: string): AgentMessageReply | undefined {
    const row = database.db.select().from(agentMessageReplies).where(eq(agentMessageReplies.id, replyId)).get();
    return row ? rowToReply(row) : undefined;
  }

  function listPendingReplies(workSessionId: string): AgentMessageReply[] {
    return database.db.select().from(agentMessageReplies)
      .where(and(eq(agentMessageReplies.workSessionId, workSessionId), eq(agentMessageReplies.status, "pending_delivery")))
      .orderBy(asc(agentMessageReplies.createdAt))
      .all().map(rowToReply);
  }

  function listReplies(workSessionId: string): AgentMessageReply[] {
    return database.db.select().from(agentMessageReplies)
      .where(eq(agentMessageReplies.workSessionId, workSessionId))
      .orderBy(asc(agentMessageReplies.createdAt))
      .all().map(rowToReply);
  }

  function acknowledgeReply(input: { replyId: string; workSessionId: string; runId: string; attempt: number; actorId: string }): AgentMessageReply {
    const existing = getReply(input.replyId);
    if (!existing || existing.workSessionId !== input.workSessionId) throw new Error("Reply not found for this session.");
    if (existing.status === "acknowledged") {
      if (existing.acknowledgedRunId === input.runId && existing.acknowledgedAttempt === input.attempt) return existing;
      throw new Error("Reply is already acknowledged by a different logical run or attempt.");
    }
    if (existing.status !== "pending_delivery" && existing.status !== "delivering") throw new Error(`Reply cannot be acknowledged from status ${existing.status}.`);
    const wait = getActiveWaitForMessage(existing.messageId);
    const currentAttempt = wait?.workerAttempt ?? 1;
    if (input.attempt < currentAttempt) throw new Error("Stale worker attempt cannot acknowledge the reply.");
    const now = new Date().toISOString();
    const updated = database.db.update(agentMessageReplies)
      .set({
        status: "acknowledged",
        acknowledgedAt: now,
        acknowledgedRunId: input.runId,
        acknowledgedAttempt: input.attempt,
        acknowledgedActorId: input.actorId,
      })
      .where(and(eq(agentMessageReplies.id, input.replyId), eq(agentMessageReplies.status, existing.status)))
      .run();
    if (updated.changes !== 1) throw new Error("Reply acknowledgement conflict; its delivery state changed concurrently.");
    closeWait({ messageId: existing.messageId, workSessionId: input.workSessionId });
    return getReply(input.replyId)!;
  }

  function setReplyDelivery(input: { replyId: string; expectedStatus: AgentReplyStatus; nextStatus: AgentReplyStatus }): AgentMessageReply | undefined {
    const updated = database.db.update(agentMessageReplies)
      .set({ status: input.nextStatus })
      .where(and(eq(agentMessageReplies.id, input.replyId), eq(agentMessageReplies.status, input.expectedStatus)))
      .run();
    return updated.changes === 1 ? getReply(input.replyId) : undefined;
  }

  function waitForReply(input: { messageId: string; workSessionId: string; runId?: string; attempt: number; expectsReply: boolean; resumeOnReply: boolean }): AgentReplyWait {
    const existing = getActiveWaitForMessage(input.messageId);
    const now = new Date().toISOString();
    if (existing) {
      database.db.update(agentReplyWaits).set({
        runId: input.runId ?? existing.runId,
        workerAttempt: input.attempt,
        expectsReply: input.expectsReply,
        resumeOnReply: input.resumeOnReply,
        active: true,
        updatedAt: now,
      }).where(eq(agentReplyWaits.id, existing.id)).run();
      return getActiveWaitForMessage(input.messageId)!;
    }
    const id = `wait_${randomUUID()}`;
    database.db.insert(agentReplyWaits).values({
      id,
      messageId: input.messageId,
      workSessionId: input.workSessionId,
      runId: input.runId ?? null,
      workerAttempt: input.attempt,
      expectsReply: input.expectsReply,
      resumeOnReply: input.resumeOnReply,
      active: true,
      createdAt: now,
      updatedAt: now,
    }).run();
    return getActiveWaitForMessage(input.messageId)!;
  }

  function getActiveWaitForMessage(messageId: string): AgentReplyWait | undefined {
    const row = database.db.select().from(agentReplyWaits)
      .where(and(eq(agentReplyWaits.messageId, messageId), eq(agentReplyWaits.active, true)))
      .orderBy(asc(agentReplyWaits.updatedAt))
      .all()[0];
    return row ? rowToWait(row) : undefined;
  }

  function rowToWait(row: AgentReplyWaitRow): AgentReplyWait {
    return {
      id: row.id,
      messageId: row.messageId,
      workSessionId: row.workSessionId,
      runId: row.runId ?? undefined,
      workerAttempt: row.workerAttempt,
      expectsReply: row.expectsReply,
      resumeOnReply: row.resumeOnReply,
      active: row.active,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function closeWait(input: { messageId: string; workSessionId: string }): void {
    database.db.update(agentReplyWaits)
      .set({ active: false, updatedAt: new Date().toISOString() })
      .where(and(eq(agentReplyWaits.messageId, input.messageId), eq(agentReplyWaits.workSessionId, input.workSessionId), eq(agentReplyWaits.active, true)))
      .run();
  }

  /**
   * Resolve reports whether THIS call performed the open→resolved transition.
   * The update is CAS-guarded on `status = open`, so a repeated call that finds
   * the message already resolved returns changed:false. Callers must suppress
   * their resolution event unless changed is true — otherwise a re-request
   * manufactures a second `agent.message.resolved` that never happened.
   */
  function resolve(id: string): { message: AgentMessage | undefined; changed: boolean } {
    const result = database.db
      .update(agentMessages)
      .set({ status: "resolved", resolvedAt: new Date().toISOString() })
      .where(and(eq(agentMessages.id, id), eq(agentMessages.status, "open")))
      .run();
    return { message: get(id), changed: result.changes === 1 };
  }

  // P1 #11: DB owned by server
  function close(): void { }

  return { post, get, list, resolve, acceptReply, getReply, listPendingReplies, listReplies, acknowledgeReply, setReplyDelivery, waitForReply, getActiveWaitForMessage, closeWait, close };
}

function rowToMessage(row: AgentMessageRow): AgentMessage {
  return {
    id: row.id,
    workSessionId: row.workSessionId,
    runId: row.runId ?? undefined,
    kind: row.kind as AgentMessageKind,
    author: row.author,
    title: row.title ?? undefined,
    body: row.body ?? undefined,
    data: JSON.parse(row.dataJson) as Record<string, unknown>,
    replyToId: row.replyToId ?? undefined,
    status: row.status as AgentMessageStatus,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? undefined,
  };
}
