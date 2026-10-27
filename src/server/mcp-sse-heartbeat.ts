export interface McpSseHeartbeatResponse {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  write(chunk: string): boolean;
  on(event: "drain", listener: () => void): unknown;
  off(event: "drain", listener: () => void): unknown;
  destroy?(error?: Error): unknown;
}

/** Keep an MCP SSE response alive and recover after every backpressure event. */
export function startMcpSseHeartbeat(
  response: McpSseHeartbeatResponse,
  intervalMs: number,
  onStalled: () => void,
  onDrained: () => void,
  onHeartbeat?: (bytes: number) => void,
  options: { maxStallMs?: number; onStallTimeout?: (details: { stalledSince: number; lastSuccessfulWriteAt: number; consecutiveStallCount: number }) => void } = {},
): () => void {
  let stalled = false;
  let stopped = false;
  let timer: NodeJS.Timeout;
  let stallTimer: NodeJS.Timeout | undefined;
  let stalledSince = 0;
  let lastSuccessfulWriteAt = Date.now();
  let consecutiveStallCount = 0;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (stallTimer) clearTimeout(stallTimer);
    response.off("drain", onDrain);
  };

  const onDrain = (): void => {
    if (!stalled) return;
    stalled = false;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = undefined;
    lastSuccessfulWriteAt = Date.now();
    stalledSince = 0;
    onDrained();
  };

  response.on("drain", onDrain);
  timer = setInterval(() => {
    if (response.writableEnded || response.destroyed) {
      stop();
      return;
    }
    if (stalled) return;
    try {
      const chunk = ": kontrol-heartbeat\n\n";
      const writable = response.write(chunk);
      onHeartbeat?.(Buffer.byteLength(chunk, "utf8"));
      if (!writable) {
        stalled = true;
        stalledSince = Date.now();
        consecutiveStallCount += 1;
        onStalled();
        const maxStallMs = options.maxStallMs ?? 30_000;
        if (maxStallMs > 0) {
          stallTimer = setTimeout(() => {
            if (stopped || !stalled) return;
            const details = { stalledSince, lastSuccessfulWriteAt, consecutiveStallCount };
            stop();
            options.onStallTimeout?.(details);
            response.destroy?.(new Error("MCP SSE writer exceeded its stall deadline"));
          }, maxStallMs);
          stallTimer.unref?.();
        }
      } else {
        lastSuccessfulWriteAt = Date.now();
        consecutiveStallCount = 0;
      }
    } catch {
      stop();
    }
  }, intervalMs);
  timer.unref?.();
  return stop;
}
