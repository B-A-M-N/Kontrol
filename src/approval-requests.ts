import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { approvalRequests, type ApprovalRequestRow } from "./db/schema.js";
import { DEFAULT_DIRECT_APPROVAL_REATTACH_GRACE_MS } from "./policy-approval-defaults.js";

export type ApprovalKind = "tool" | "filesystem" | "command" | "work_review" | "agent_permission" | "user_input";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface ApprovalOption {
  id: string;
  label: string;
  effect: "approve" | "deny" | "changes_requested";
  scope?: "once" | "work_session" | "workspace";
}

export interface ApprovalRequest {
  approvalId: string;
  kind: ApprovalKind;
  workspaceSessionId: string;
  workSessionId?: string;
  runId?: string;
  agentId?: string;
  principalId?: string;
  approvalKey?: string;
  mcpSessionId?: string;
  mcpRequestId?: string;
  waiterKey?: string;
  /** Identity of the LIVE waiter currently attached to this row, or undefined
   *  if no caller is waiting right now. A durable card can outlive its
   *  current live waiter (P0.3); a future live invocation with the same
   *  row key can reattach. */
  liveWaiterId?: string;
  origin?: "direct_mcp" | "work_session";
  conversationId?: string;
  orphanedAt?: string;
  reattachDeadline?: string;
  liveWaiterCount?: number;
  title: string;
  description?: string;
  risk?: string;
  tool?: string;
  command?: string;
  path?: string;
  options: ApprovalOption[];
  status: ApprovalStatus;
  createdAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  consumedAt?: string;
  resolution?: Record<string, unknown>;
}

export interface CreateApprovalRequestInput {
  /** Optional caller-supplied ID used when a legacy waiter already published it. */
  approvalId?: string;
  kind: ApprovalKind;
  workspaceSessionId: string;
  workSessionId?: string;
  runId?: string;
  agentId?: string;
  principalId?: string;
  approvalKey?: string;
  mcpSessionId?: string;
  mcpRequestId?: string;
  waiterKey?: string;
  liveWaiterId?: string;
  origin?: "direct_mcp" | "work_session";
  conversationId?: string;
  orphanedAt?: string;
  reattachDeadline?: string;
  title: string;
  description?: string;
  risk?: string;
  tool?: string;
  command?: string;
  path?: string;
  options?: ApprovalOption[];
  expiresAt?: string;
}

export interface ApprovalRequestManager {
  create(input: CreateApprovalRequestInput): ApprovalRequest;
  get(id: string): ApprovalRequest | undefined;
  listPending(workspaceSessionId?: string): ApprovalRequest[];
  listPendingPage(
    workspaceSessionId?: string,
    limit?: number,
    before?: { createdAt: string; id: string },
    origin?: "direct_mcp" | "work_session",
  ): {
    requests: ApprovalRequest[];
    nextBefore?: { createdAt: string; id: string };
    hasMore: boolean;
  };
  /** Atomically move expired pending requests to expired. */
  expirePending(now?: string, limit?: number): ApprovalRequest[];
  resolve(id: string, input: { status: ApprovalStatus; optionId?: string; effect?: ApprovalOption["effect"]; scope?: "once" | "work_session" | "workspace"; reason?: string; reviewerId?: string }): ApprovalRequest | undefined;
  detachLiveWaiter(id: string, liveWaiterId: string): void;
  reattachLiveWaiter(id: string, liveWaiterId: string): void;
  /** Refresh the bounded reattachment window for a direct retry. */
  touchDirectApproval(id: string, now?: string): void;
  /** Atomically consume a resolved one-shot operation approval. */
  consumeApprovedOperation(waiterKey: string): boolean;
  close(): void;
}

export interface ApprovalRequestManagerOptions {
  /** Bounded grace for a direct-MCP retry after its transport disappears. */
  directReattachGraceMs?: number;
  /** Human decision window for a direct (non-blocking) tool approval. */
  directToolApprovalTtlMs?: number;
}

export function createApprovalRequestManager(
  stateDirOrHandle: string | DatabaseHandle,
  options: ApprovalRequestManagerOptions = {},
): ApprovalRequestManager {
  const DIRECT_TOOL_APPROVAL_TTL_MS = options.directToolApprovalTtlMs ?? 10 * 60_000;
  const WORK_SESSION_TOOL_APPROVAL_TTL_MS = 24 * 60 * 60_000;
  const DIRECT_REATTACH_GRACE_MS = options.directReattachGraceMs ?? DEFAULT_DIRECT_APPROVAL_REATTACH_GRACE_MS;
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;

  function create(input: CreateApprovalRequestInput): ApprovalRequest {
    const now = new Date().toISOString();
    const request: ApprovalRequest = {
      approvalId: input.approvalId ?? `apr_${randomUUID()}`,
      kind: input.kind,
      workspaceSessionId: input.workspaceSessionId,
      workSessionId: input.workSessionId,
      runId: input.runId,
      agentId: input.agentId,
      principalId: input.principalId,
      approvalKey: input.approvalKey,
      mcpSessionId: input.mcpSessionId,
      mcpRequestId: input.mcpRequestId,
      waiterKey: input.waiterKey,
      liveWaiterId: input.liveWaiterId,
      origin: input.origin ?? (input.workSessionId ? "work_session" : "direct_mcp"),
      conversationId: input.conversationId,
      // P1: a direct MCP approval returns approval_required immediately, so
      // zero live waiters is its normal shape — it is a PENDING HUMAN
      // DECISION, not an orphan. It is born pending_human_approval with no
      // orphan timestamp and stays decidable until its normal approval TTL
      // (expirePending) unless a later retry detaches it. Only a caller that
      // actually detaches mid-flight gets a reattachment window.
      orphanedAt: input.orphanedAt,
      reattachDeadline: input.reattachDeadline,
      title: input.title,
      description: input.description,
      risk: input.risk,
      tool: input.tool,
      command: input.command,
      path: input.path,
      options: input.options?.length ? input.options : defaultOptions(),
      status: "pending",
      createdAt: now,
      // Policy waiters are in-memory. A tool approval must therefore carry a
      // durable expiry so a server restart cannot leave an approval card (and
      // its abandoned caller) pending forever. Explicit expiries remain
      // authoritative for other approval kinds.
      expiresAt: input.expiresAt ?? (input.kind === "tool"
        ? new Date(Date.parse(now) + (input.workSessionId ? WORK_SESSION_TOOL_APPROVAL_TTL_MS : DIRECT_TOOL_APPROVAL_TTL_MS)).toISOString()
        : undefined),
    };

    database.db.insert(approvalRequests).values({
      id: request.approvalId,
      kind: request.kind,
      workspaceSessionId: request.workspaceSessionId,
      workSessionId: request.workSessionId ?? null,
      runId: request.runId ?? null,
      agentId: request.agentId ?? null,
      principalId: request.principalId ?? null,
      approvalKey: request.approvalKey ?? null,
      mcpSessionId: request.mcpSessionId ?? null,
      mcpRequestId: request.mcpRequestId ?? null,
      waiterKey: request.waiterKey ?? null,
      liveWaiterId: request.liveWaiterId ?? null,
      origin: request.origin ?? (request.workSessionId ? "work_session" : "direct_mcp"),
      conversationId: request.conversationId ?? null,
      orphanedAt: request.orphanedAt ?? null,
      reattachDeadline: request.reattachDeadline ?? null,
      title: request.title,
      description: request.description ?? null,
      risk: request.risk ?? null,
      tool: request.tool ?? null,
      command: request.command ?? null,
      path: request.path ?? null,
      optionsJson: JSON.stringify(request.options),
      status: request.status,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt ?? null,
      resolvedAt: null,
      resolutionJson: null,
      consumedAt: null,
    }).run();

    return request;
  }

  function get(id: string): ApprovalRequest | undefined {
    expirePending();
    const row = database.db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get();
    return row ? rowToApproval(row) : undefined;
  }

  function listPending(workspaceSessionId?: string): ApprovalRequest[] {
    expirePending(undefined, 100);
    const where = workspaceSessionId
      ? and(eq(approvalRequests.status, "pending"), eq(approvalRequests.workspaceSessionId, workspaceSessionId))
      : eq(approvalRequests.status, "pending");
    return database.db
      .select()
      .from(approvalRequests)
      .where(where)
      .orderBy(desc(approvalRequests.createdAt))
      .all()
      .map(rowToApproval);
  }

  function listPendingPage(
    workspaceSessionId?: string,
    limit = 100,
    before?: { createdAt: string; id: string },
    origin?: "direct_mcp" | "work_session",
  ): {
    requests: ApprovalRequest[];
    nextBefore?: { createdAt: string; id: string };
    hasMore: boolean;
  } {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const conditions = [eq(approvalRequests.status, "pending")];
    if (workspaceSessionId) conditions.push(eq(approvalRequests.workspaceSessionId, workspaceSessionId));
    if (origin) conditions.push(eq(approvalRequests.origin, origin));
    if (before) {
      conditions.push(or(
        lt(approvalRequests.createdAt, before.createdAt),
        and(eq(approvalRequests.createdAt, before.createdAt), lt(approvalRequests.id, before.id)),
      )!);
    }
    const rows = database.db
      .select()
      .from(approvalRequests)
      .where(and(...conditions))
      .orderBy(desc(approvalRequests.createdAt), desc(approvalRequests.id))
      .limit(boundedLimit + 1)
      .all();
    const hasMore = rows.length > boundedLimit;
    const page = hasMore ? rows.slice(0, boundedLimit) : rows;
    const last = page[page.length - 1];
    return {
      requests: page.map(rowToApproval),
      nextBefore: hasMore && last ? { createdAt: last.createdAt, id: last.id } : undefined,
      hasMore,
    };
  }

  function resolve(
    id: string,
    input: { status: ApprovalStatus; optionId?: string; effect?: ApprovalOption["effect"]; scope?: "once" | "work_session" | "workspace"; reason?: string; reviewerId?: string },
  ): ApprovalRequest | undefined {
    if (!["approved", "denied", "expired", "cancelled"].includes(input.status)) {
      throw new Error(`Invalid approval resolution status: ${input.status}`);
    }
    const existing = get(id);
    if (!existing || existing.status !== "pending") return existing;
    if (input.effect && !input.optionId) {
      throw new Error("Approval effect requires a selected option");
    }
    if (input.optionId) {
      const option = existing.options.find((candidate) => candidate.id === input.optionId);
      if (!option) throw new Error(`Unknown approval option: ${input.optionId}`);
      if (input.status === "approved" && option.effect !== "approve") {
        throw new Error(`Approved resolution requires an approve option, not ${option.effect}`);
      }
      if (input.status === "denied" && !["deny", "changes_requested"].includes(option.effect)) {
        throw new Error(`Denied resolution requires a deny or changes_requested option, not ${option.effect}`);
      }
      if (["expired", "cancelled"].includes(input.status)) {
        throw new Error(`${input.status} resolutions cannot select an approval option`);
      }
      const expectedEffect = input.effect ?? (input.status === "approved" ? "approve" : input.status === "denied" ? "deny" : undefined);
      if (expectedEffect && option.effect !== expectedEffect) {
        throw new Error(`Approval option ${input.optionId} has effect ${option.effect}, not ${expectedEffect}`);
      }
    }
    const now = new Date().toISOString();
    const resolution = {
      optionId: input.optionId,
      effect: input.effect,
      scope: input.scope,
      reason: input.reason,
      reviewerId: input.reviewerId,
    };
    const updated = database.db.update(approvalRequests)
      .set({ status: input.status, resolvedAt: now, resolutionJson: JSON.stringify(resolution) })
      .where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, "pending")))
      .run();
    if (updated.changes === 0) return get(id);
    return get(id);
  }

  function expirePending(now = new Date().toISOString(), limit = 100): ApprovalRequest[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const candidates = database.db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(
        eq(approvalRequests.status, "pending"),
        // NULL expiry means no expiry. ISO-8601 UTC strings sort naturally.
        // Drizzle's SQL fragment is used because nullable comparison is not
        // expressible with the narrow generated column type.
        sql`${approvalRequests.expiresAt} is not null and ${approvalRequests.expiresAt} <= ${now}`,
      ))
      .orderBy(approvalRequests.expiresAt, approvalRequests.id)
      .limit(boundedLimit)
      .all();
    const expiredIds: string[] = [];
    for (const candidate of candidates) {
      const updated = database.db.update(approvalRequests)
        .set({ status: "expired", resolvedAt: now, resolutionJson: JSON.stringify({ reason: "approval timed out" }) })
        .where(and(eq(approvalRequests.id, candidate.id), eq(approvalRequests.status, "pending")))
        .run();
      if (updated.changes > 0) expiredIds.push(candidate.id);
    }
    if (expiredIds.length === 0) return [];
    return database.db
      .select()
      .from(approvalRequests)
      .where(inArray(approvalRequests.id, expiredIds))
      .all()
      .map(rowToApproval);
  }

  function detachLiveWaiter(id: string, liveWaiterId: string): void {
    const now = new Date().toISOString();
    // A detached caller opens its bounded reattachment window: a future live
    // retry with the same row key may reattach until the deadline, after
    // which the row is classifiable as an abandoned operation (diagnostics
    // only — cancellation belongs to expiry or a reviewer decision).
    database.db.update(approvalRequests)
      .set({
        liveWaiterId: null,
        orphanedAt: now,
        reattachDeadline: new Date(Date.parse(now) + DIRECT_REATTACH_GRACE_MS).toISOString(),
      })
      .where(and(eq(approvalRequests.id, id), eq(approvalRequests.liveWaiterId, liveWaiterId)))
      .run();
  }

  function reattachLiveWaiter(id: string, liveWaiterId: string): void {
    database.db.update(approvalRequests)
      .set({ liveWaiterId, orphanedAt: null })
      .where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, "pending")))
      .run();
  }

  function touchDirectApproval(id: string, now = new Date().toISOString()): void {
    const deadline = new Date(Date.parse(now) + DIRECT_REATTACH_GRACE_MS).toISOString();
    // Liveness touch, not an orphan event: the retry proves a live owner, so
    // only the bounded reattachment window moves. orphanedAt stays whatever
    // the lifecycle actually recorded.
    database.db.update(approvalRequests)
      .set({ reattachDeadline: deadline })
      .where(and(
        eq(approvalRequests.id, id),
        eq(approvalRequests.kind, "tool"),
        sql`${approvalRequests.workSessionId} is null`,
        sql`(${approvalRequests.origin} = 'direct_mcp' or ${approvalRequests.origin} is null)`,
        eq(approvalRequests.status, "pending"),
      ))
      .run();
  }

  function consumeApprovedOperation(waiterKey: string): boolean {
    const candidates = database.db
      .select()
      .from(approvalRequests)
      .where(and(
        eq(approvalRequests.waiterKey, waiterKey),
        eq(approvalRequests.status, "approved"),
        sql`${approvalRequests.consumedAt} is null`,
      ))
      .orderBy(desc(approvalRequests.resolvedAt))
      .all();
    for (const candidate of candidates) {
      const resolution = candidate.resolutionJson
        ? JSON.parse(candidate.resolutionJson) as { scope?: string }
        : {};
      if (resolution.scope !== "once") continue;
      const updated = database.db.update(approvalRequests)
        .set({ consumedAt: new Date().toISOString() })
        .where(and(
          eq(approvalRequests.id, candidate.id),
          eq(approvalRequests.status, "approved"),
          sql`${approvalRequests.consumedAt} is null`,
        ))
        .run();
      if (updated.changes === 1) return true;
    }
    return false;
  }

  return { create, get, listPending, listPendingPage, expirePending, resolve, detachLiveWaiter, reattachLiveWaiter, touchDirectApproval, consumeApprovedOperation, close: () => { /* P1 #11: DB owned by server */ } };
}

function defaultOptions(): ApprovalOption[] {
  return [
    { id: "approve", label: "Approve", effect: "approve", scope: "once" },
    { id: "deny", label: "Deny", effect: "deny" },
  ];
}

function rowToApproval(row: ApprovalRequestRow): ApprovalRequest {
  return {
    approvalId: row.id,
    kind: row.kind as ApprovalKind,
    workspaceSessionId: row.workspaceSessionId,
    workSessionId: row.workSessionId ?? undefined,
    runId: row.runId ?? undefined,
    agentId: row.agentId ?? undefined,
    principalId: row.principalId ?? undefined,
    approvalKey: row.approvalKey ?? undefined,
    mcpSessionId: row.mcpSessionId ?? undefined,
    mcpRequestId: row.mcpRequestId ?? undefined,
    waiterKey: row.waiterKey ?? undefined,
    liveWaiterId: row.liveWaiterId ?? undefined,
    origin: row.origin === "work_session" ? "work_session" : row.origin === "direct_mcp" ? "direct_mcp" : row.workSessionId ? "work_session" : "direct_mcp",
    conversationId: row.conversationId ?? undefined,
    orphanedAt: row.orphanedAt ?? undefined,
    reattachDeadline: row.reattachDeadline ?? undefined,
    liveWaiterCount: row.liveWaiterId ? 1 : 0,
    title: row.title,
    description: row.description ?? undefined,
    risk: row.risk ?? undefined,
    tool: row.tool ?? undefined,
    command: row.command ?? undefined,
    path: row.path ?? undefined,
    options: JSON.parse(row.optionsJson) as ApprovalOption[],
    status: row.status as ApprovalStatus,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt ?? undefined,
    resolvedAt: row.resolvedAt ?? undefined,
    consumedAt: row.consumedAt ?? undefined,
    resolution: row.resolutionJson ? JSON.parse(row.resolutionJson) as Record<string, unknown> : undefined,
  };
}
