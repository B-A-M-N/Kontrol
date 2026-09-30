export interface McpOperationStart {
  operationId: string;
  requestId?: string;
  externalCorrelationId?: string;
  generationId?: string;
  sessionIdPrefix?: string;
  method: string;
  rpcMethod?: string;
  toolName?: string;
  startedAtMs: number;
  admissionClass: "execution" | "waiter" | "stream";
}

export interface McpOperationFinish {
  finishedAtMs: number;
  httpStatus: number;
  responseBytes: number;
  responseCloseClassification: string;
  admissionWaitMs: number;
  executionDurationMs: number;
  handlerStillRunning: boolean;
  errorClass?: string;
  executionAdmission: Record<string, unknown>;
  resourceAdmission: Record<string, unknown>;
  sessionInFlight?: number;
  connectionMetrics: Record<string, unknown>;
}

interface ActiveMcpOperation extends McpOperationStart {}
interface CompletedMcpOperation extends McpOperationStart, McpOperationFinish {
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
}

/** Bounded, body-free MCP request correlation for authenticated diagnostics. */
export class McpOperationDiagnostics {
  private readonly active = new Map<string, ActiveMcpOperation>();
  private readonly completed: CompletedMcpOperation[] = [];
  private droppedActive = 0;

  constructor(private readonly maxActive = 1024, private readonly maxCompleted = 256) {
    if (!Number.isInteger(maxActive) || maxActive < 1) throw new Error("maxActive must be positive");
    if (!Number.isInteger(maxCompleted) || maxCompleted < 1) throw new Error("maxCompleted must be positive");
  }

  begin(operation: McpOperationStart): void {
    if (this.active.has(operation.operationId)) return;
    if (this.active.size >= this.maxActive) {
      this.droppedActive++;
      return;
    }
    this.active.set(operation.operationId, operation);
  }

  finish(operationId: string, result: McpOperationFinish): void {
    const started = this.active.get(operationId);
    if (!started) return;
    this.active.delete(operationId);
    this.completed.push({
      ...started,
      ...result,
      startedAt: new Date(started.startedAtMs).toISOString(),
      finishedAt: new Date(result.finishedAtMs).toISOString(),
      totalDurationMs: Math.max(0, result.finishedAtMs - started.startedAtMs),
    });
    if (this.completed.length > this.maxCompleted) this.completed.splice(0, this.completed.length - this.maxCompleted);
  }

  snapshot(now = Date.now()): {
    activeCount: number;
    droppedActiveCount: number;
    active: Array<Record<string, unknown>>;
    recent: CompletedMcpOperation[];
  } {
    return {
      activeCount: this.active.size,
      droppedActiveCount: this.droppedActive,
      active: [...this.active.values()].map((operation) => ({
        operationId: operation.operationId,
        ...(operation.requestId ? { requestId: operation.requestId } : {}),
        ...(operation.externalCorrelationId ? { externalCorrelationId: operation.externalCorrelationId } : {}),
        ...(operation.generationId ? { generationId: operation.generationId } : {}),
        ...(operation.sessionIdPrefix ? { sessionIdPrefix: operation.sessionIdPrefix } : {}),
        method: operation.method,
        ...(operation.rpcMethod ? { rpcMethod: operation.rpcMethod } : {}),
        ...(operation.toolName ? { toolName: operation.toolName } : {}),
        startedAt: new Date(operation.startedAtMs).toISOString(),
        ageMs: Math.max(0, now - operation.startedAtMs),
        admissionClass: operation.admissionClass,
      })),
      recent: [...this.completed],
    };
  }
}
