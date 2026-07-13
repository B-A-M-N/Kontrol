import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
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
  kind: ApprovalKind;
  workspaceSessionId: string;
  workSessionId?: string;
  runId?: string;
  agentId?: string;
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
  resolve(id: string, input: { status: ApprovalStatus; optionId?: string; reason?: string; reviewerId?: string }): ApprovalRequest | undefined;
  close(): void;
}

export function createApprovalRequestManager(
  stateDirOrHandle: string | DatabaseHandle,
): ApprovalRequestManager {
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;

  function create(input: CreateApprovalRequestInput): ApprovalRequest {
    const now = new Date().toISOString();
    const request: ApprovalRequest = {
      approvalId: `apr_${randomUUID()}`,
      kind: input.kind,
      workspaceSessionId: input.workspaceSessionId,
      workSessionId: input.workSessionId,
      runId: input.runId,
      agentId: input.agentId,
      title: input.title,
      description: input.description,
      risk: input.risk,
      tool: input.tool,
      command: input.command,
      path: input.path,
      options: input.options?.length ? input.options : defaultOptions(),
      status: "pending",
      createdAt: now,
      expiresAt: input.expiresAt,
    };

    database.db.insert(approvalRequests).values({
      id: request.approvalId,
      kind: request.kind,
      workspaceSessionId: request.workspaceSessionId,
      workSessionId: request.workSessionId ?? null,
      runId: request.runId ?? null,
      agentId: request.agentId ?? null,
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
    const row = database.db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get();
    return row ? rowToApproval(row) : undefined;
  }

  function listPending(workspaceSessionId?: string): ApprovalRequest[] {
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
    input: { status: ApprovalStatus; optionId?: string; reason?: string; reviewerId?: string },
  ): ApprovalRequest | undefined {
    const existing = get(id);
    if (!existing || existing.status !== "pending") return existing;
    const now = new Date().toISOString();
    const resolution = {
      optionId: input.optionId,
      reason: input.reason,
      reviewerId: input.reviewerId,
    };
    database.db.update(approvalRequests)
      .set({ status: input.status, resolvedAt: now, resolutionJson: JSON.stringify(resolution) })
      .where(eq(approvalRequests.id, id))
      .run();
    return get(id);
  }

  return { create, get, listPending, resolve, close: () => database.close() };
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
