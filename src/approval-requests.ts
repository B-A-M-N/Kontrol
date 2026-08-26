import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { approvalRequests, type ApprovalRequestRow } from "./db/schema.js";

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
  /** Atomically move expired pending requests to expired. */
  expirePending(now?: string): ApprovalRequest[];
  resolve(id: string, input: { status: ApprovalStatus; optionId?: string; effect?: ApprovalOption["effect"]; reason?: string; reviewerId?: string }): ApprovalRequest | undefined;
  close(): void;
}

export function createApprovalRequestManager(
  stateDirOrHandle: string | DatabaseHandle,
): ApprovalRequestManager {
  const TOOL_APPROVAL_TTL_MS = 5 * 60_000;
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
        ? new Date(Date.parse(now) + TOOL_APPROVAL_TTL_MS).toISOString()
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
    }).run();

    return request;
  }

  function get(id: string): ApprovalRequest | undefined {
    expirePending();
    const row = database.db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get();
    return row ? rowToApproval(row) : undefined;
  }

  function listPending(workspaceSessionId?: string): ApprovalRequest[] {
    expirePending();
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

  function resolve(
    id: string,
    input: { status: ApprovalStatus; optionId?: string; effect?: ApprovalOption["effect"]; reason?: string; reviewerId?: string },
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

  function expirePending(now = new Date().toISOString()): ApprovalRequest[] {
    database.db.update(approvalRequests)
      .set({ status: "expired", resolvedAt: now, resolutionJson: JSON.stringify({ reason: "approval timed out" }) })
      .where(and(
        eq(approvalRequests.status, "pending"),
        // NULL expiry means no expiry. ISO-8601 UTC strings sort naturally.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        // Drizzle's SQL fragment is used because nullable comparison is not
        // expressible with the narrow generated column type.
        sql`${approvalRequests.expiresAt} is not null and ${approvalRequests.expiresAt} <= ${now}`,
      ))
      .run();
    return database.db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.status, "expired"), eq(approvalRequests.resolvedAt, now)))
      .all()
      .map(rowToApproval);
  }

  return { create, get, listPending, expirePending, resolve, close: () => { /* P1 #11: DB owned by server */ } };
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
    resolution: row.resolutionJson ? JSON.parse(row.resolutionJson) as Record<string, unknown> : undefined,
  };
}
