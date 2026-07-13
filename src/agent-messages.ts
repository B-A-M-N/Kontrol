import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { agentMessages, type AgentMessageRow } from "./db/schema.js";

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
  resolve(id: string): AgentMessage | undefined;
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

  function resolve(id: string): AgentMessage | undefined {
    database.db
      .update(agentMessages)
      .set({ status: "resolved", resolvedAt: new Date().toISOString() })
      .where(and(eq(agentMessages.id, id), eq(agentMessages.status, "open")))
      .run();
    return get(id);
  }

  function close(): void {
    database.close();
  }

  return { post, get, list, resolve, close };
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
