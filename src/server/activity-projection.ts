import { createHash } from "node:crypto";
import type { McpSessionState } from "./mcp-session-state.js";

/**
 * Activity projection (Finding 9): scoped metadata over live MCP
 * operations for the independent browser activity surface. ONLY these
 * fields ever leave this module — never tool arguments, command text,
 * credentials, raw outputs, or another owner's activity. Entries that
 * cannot be attributed to an authenticated session are excluded
 * (fail-closed), and direct workspace operations without a work
 * session are included when the session itself is attributable.
 */

export interface ActivityOperationInput {
  active: Array<Record<string, unknown>>;
  recent: Array<Record<string, unknown>>;
}

export interface ProjectedActivityRow {
  operationId: string;
  toolName?: string;
  method: string;
  status: "active" | "completed" | "error";
  startedAt: string;
  finishedAt?: string;
  elapsedMs: number;
  owner: string;
  role?: string;
  workSessionId?: string;
  workspaceSessionId?: string;
  errorClass?: string;
  /** Active entries whose server-side start is older than this are
   * flagged instead of presented as freshly live. */
  stale: boolean;
}

export interface ActivityProjection {
  generatedAt: string;
  serverNowMs: number;
  active: ProjectedActivityRow[];
  recent: ProjectedActivityRow[];
  counts: { active: number; recent: number; excludedUnattributed: number; dropped: number };
}

const STALE_ACTIVE_MS = 5 * 60_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sessionIndex(mcpSessions: Map<string, McpSessionState>): Map<string, McpSessionState> {
  const index = new Map<string, McpSessionState>();
  for (const session of mcpSessions.values()) {
    index.set(sha256(session.sessionId), session);
  }
  return index;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function projectRow(
  record: Record<string, unknown>,
  sessions: Map<string, McpSessionState>,
  now: number,
  isActive: boolean,
  viewerPrincipalId?: string,
): { row?: ProjectedActivityRow; excluded: boolean } {
  // Prefer the immutable attribution captured at operation begin; fall
  // back to the live session join only for older records. Peer sessions
  // (other installations' traffic) are never projected.
  const capturedOwner = stringField(record, "authenticatedPrincipalId");
  const sha = stringField(record, "sessionIdSha256");
  const session = sha ? sessions.get(sha) : undefined;
  if (session?.listenerKind === "peer") return { excluded: true };
  const owner = capturedOwner ?? session?.authenticatedPrincipalId;
  if (!owner) return { excluded: true };
  if (viewerPrincipalId && owner !== viewerPrincipalId) return { excluded: true };
  const workSessionId = stringField(record, "workSessionId") ?? session?.workSessionId;
  const startedAtMs = typeof record.startedAtMs === "number" ? record.startedAtMs : Date.parse(stringField(record, "startedAt") ?? "");
  const elapsedMs = isActive
    ? Math.max(0, now - startedAtMs)
    : (typeof record.totalDurationMs === "number" ? record.totalDurationMs
      : typeof record.executionDurationMs === "number" ? record.executionDurationMs : 0);
  const errorClass = stringField(record, "errorClass");
  const row: ProjectedActivityRow = {
    operationId: stringField(record, "operationId") ?? "unknown",
    ...(stringField(record, "toolName") ? { toolName: stringField(record, "toolName") } : {}),
    method: stringField(record, "method") ?? "unknown",
    status: errorClass ? "error" : isActive ? "active" : "completed",
    startedAt: new Date(startedAtMs).toISOString(),
    ...(!isActive && stringField(record, "finishedAt") ? { finishedAt: stringField(record, "finishedAt") } : {}),
    elapsedMs,
    owner,
    ...(session?.authenticatedRole ? { role: session.authenticatedRole } : {}),
    ...(workSessionId ? { workSessionId } : {}),
    ...(errorClass ? { errorClass } : {}),
    stale: isActive && now - startedAtMs > STALE_ACTIVE_MS,
  };
  return { row, excluded: false };
}

export interface ActivityProjectionOptions {
  now?: number;
  limit?: number;
  /** Viewer mode: only rows owned by this principal are projected. */
  viewerPrincipalId?: string;
}

export function projectActivity(
  operations: ActivityOperationInput,
  mcpSessions: Map<string, McpSessionState>,
  workSessionWorkspace: ReadonlyMap<string, string>,
  options: ActivityProjectionOptions = {},
): ActivityProjection {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 100;
  const viewerPrincipalId = options.viewerPrincipalId;
  const sessions = sessionIndex(mcpSessions);
  let excluded = 0;
  const project = (records: Array<Record<string, unknown>>, isActive: boolean): ProjectedActivityRow[] => {
    const rows: ProjectedActivityRow[] = [];
    for (const record of records) {
      const { row, excluded: isExcluded } = projectRow(record, sessions, now, isActive, viewerPrincipalId);
      if (isExcluded || !row) {
        excluded++;
        continue;
      }
      if (row.workSessionId) {
        const workspace = workSessionWorkspace.get(row.workSessionId);
        if (workspace) row.workspaceSessionId = workspace;
      }
      rows.push(row);
    }
    return rows.slice(-limit);
  };
  const active = project(operations.active, true);
  const recent = project(operations.recent, false).reverse();
  return {
    generatedAt: new Date(now).toISOString(),
    serverNowMs: now,
    active,
    recent,
    counts: { active: active.length, recent: recent.length, excludedUnattributed: excluded, dropped: 0 },
  };
}
