/**
 * Bounded diagnostics for MCP handlers whose HTTP deadline expired while the
 * underlying SDK operation continued running. Active records are bounded by
 * execution admission; completed records use a fixed-size ring.
 */
export interface ExpiredMcpOperationInput {
  operationId: string;
  requestId?: string;
  generationId?: string;
  sessionIdPrefix?: string;
  rpcMethod?: string;
  toolName?: string;
  ownerHash: string;
  startedAtMs: number;
  expiredAtMs: number;
}

interface TrackedExpiredMcpOperation extends ExpiredMcpOperationInput {}

interface CompletedExpiredMcpOperation extends ExpiredMcpOperationInput {
  terminatedAtMs: number;
  outcome: "completed" | "failed";
  errorName?: string;
}

export class ExpiredMcpOperationTracker {
  private readonly active = new Map<string, TrackedExpiredMcpOperation>();
  private readonly completed: CompletedExpiredMcpOperation[] = [];
  private totalExpired = 0;
  private totalTerminated = 0;

  constructor(private readonly maxCompleted = 64) {
    if (!Number.isInteger(maxCompleted) || maxCompleted < 1) {
      throw new Error("maxCompleted must be a positive integer");
    }
  }

  markExpired(record: ExpiredMcpOperationInput): void {
    if (this.active.has(record.operationId)) return;
    this.totalExpired++;
    this.active.set(record.operationId, record);
  }

  markTerminated(operationId: string, outcome: "completed" | "failed", error?: unknown): void {
    const record = this.active.get(operationId);
    if (!record) return;
    this.active.delete(operationId);
    this.totalTerminated++;
    this.completed.push({
      ...record,
      terminatedAtMs: Date.now(),
      outcome,
      ...(outcome === "failed" && error instanceof Error ? { errorName: error.name } : {}),
    });
    if (this.completed.length > this.maxCompleted) this.completed.splice(0, this.completed.length - this.maxCompleted);
  }

  snapshot(now = Date.now()): {
    totalExpired: number;
    totalTerminated: number;
    activeCount: number;
    oldestExpiredAgeMs: number;
    active: Array<Record<string, unknown>>;
    recentTerminated: Array<Record<string, unknown>>;
  } {
    const active = [...this.active.values()]
      .sort((a, b) => a.expiredAtMs - b.expiredAtMs)
      .map((record) => ({
        ...this.serializeIdentity(record),
        state: "expired_but_running",
        startedAt: new Date(record.startedAtMs).toISOString(),
        expiredAt: new Date(record.expiredAtMs).toISOString(),
        operationAgeMs: Math.max(0, now - record.startedAtMs),
        expiredAgeMs: Math.max(0, now - record.expiredAtMs),
      }));
    const recentTerminated = this.completed.map((record) => ({
      ...this.serializeIdentity(record),
      state: "terminated_after_expiry",
      outcome: record.outcome,
      ...(record.errorName ? { errorName: record.errorName } : {}),
      startedAt: new Date(record.startedAtMs).toISOString(),
      expiredAt: new Date(record.expiredAtMs).toISOString(),
      terminatedAt: new Date(record.terminatedAtMs).toISOString(),
      operationAgeMs: Math.max(0, record.terminatedAtMs - record.startedAtMs),
      expiredAgeMs: Math.max(0, record.terminatedAtMs - record.expiredAtMs),
    }));
    return {
      totalExpired: this.totalExpired,
      totalTerminated: this.totalTerminated,
      activeCount: active.length,
      oldestExpiredAgeMs: active.length > 0 ? Math.max(...active.map((record) => Number(record.expiredAgeMs))) : 0,
      active,
      recentTerminated,
    };
  }

  private serializeIdentity(record: ExpiredMcpOperationInput): Record<string, unknown> {
    return {
      operationId: record.operationId,
      ...(record.requestId ? { requestId: record.requestId } : {}),
      ...(record.generationId ? { generationId: record.generationId } : {}),
      ...(record.sessionIdPrefix ? { sessionIdPrefix: record.sessionIdPrefix } : {}),
      ...(record.rpcMethod ? { rpcMethod: record.rpcMethod } : {}),
      ...(record.toolName ? { toolName: record.toolName } : {}),
      ownerHash: record.ownerHash,
    };
  }
}
