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
  admissionWeight?: number;
  workSessionHash?: string;
}

interface TrackedExpiredMcpOperation extends ExpiredMcpOperationInput {
  state: "CANCELLING" | "STUCK";
  stuckSinceMs?: number;
  stuckTimer?: NodeJS.Timeout;
}

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

  constructor(private readonly maxCompleted = 64, private readonly stuckGraceMs = 5_000) {
    if (!Number.isInteger(maxCompleted) || maxCompleted < 1) {
      throw new Error("maxCompleted must be a positive integer");
    }
    if (!Number.isInteger(stuckGraceMs) || stuckGraceMs < 0) throw new Error("stuckGraceMs must be non-negative");
  }

  markExpired(record: ExpiredMcpOperationInput): void {
    if (this.active.has(record.operationId)) return;
    this.totalExpired++;
    const tracked: TrackedExpiredMcpOperation = { ...record, state: "CANCELLING" };
    tracked.stuckTimer = setTimeout(() => {
      if (this.active.get(record.operationId) !== tracked) return;
      tracked.state = "STUCK";
      tracked.stuckSinceMs = Date.now();
    }, this.stuckGraceMs);
    tracked.stuckTimer.unref?.();
    this.active.set(record.operationId, tracked);
  }

  markTerminated(operationId: string, outcome: "completed" | "failed", error?: unknown): void {
    const record = this.active.get(operationId);
    if (!record) return;
    this.active.delete(operationId);
    if (record.stuckTimer) clearTimeout(record.stuckTimer);
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
    stuckCount: number;
    oldestExpiredAgeMs: number;
    oldestStuckHandlerAgeMs: number;
    activeAdmissionWeight: number;
    active: Array<Record<string, unknown>>;
    recentTerminated: Array<Record<string, unknown>>;
  } {
    const active = [...this.active.values()]
      .sort((a, b) => a.expiredAtMs - b.expiredAtMs)
      .map((record) => ({
        ...this.serializeIdentity(record),
        state: record.state,
        admissionWeight: record.admissionWeight ?? 1,
        startedAt: new Date(record.startedAtMs).toISOString(),
        expiredAt: new Date(record.expiredAtMs).toISOString(),
        operationAgeMs: Math.max(0, now - record.startedAtMs),
        expiredAgeMs: Math.max(0, now - record.expiredAtMs),
        ...(record.stuckSinceMs ? { stuckAgeMs: Math.max(0, now - record.stuckSinceMs) } : {}),
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
      stuckCount: [...this.active.values()].filter((record) => record.state === "STUCK").length,
      oldestExpiredAgeMs: active.length > 0 ? Math.max(...active.map((record) => Number(record.expiredAgeMs))) : 0,
      oldestStuckHandlerAgeMs: active.length > 0 ? Math.max(0, ...active.map((record) => Number(record.stuckAgeMs ?? 0))) : 0,
      activeAdmissionWeight: [...this.active.values()].reduce((sum, record) => sum + (record.admissionWeight ?? 1), 0),
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
      admissionWeight: record.admissionWeight ?? 1,
      ...(record.workSessionHash ? { workSessionHash: record.workSessionHash } : {}),
    };
  }
}
