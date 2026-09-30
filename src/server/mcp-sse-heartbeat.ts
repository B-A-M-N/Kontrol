export interface McpSseHeartbeatResponse {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  write(chunk: string): boolean;
  on(event: "drain", listener: () => void): unknown;
  off(event: "drain", listener: () => void): unknown;
}

/** Keep an MCP SSE response alive and recover after every backpressure event. */
export function startMcpSseHeartbeat(
  response: McpSseHeartbeatResponse,
  intervalMs: number,
  onStalled: () => void,
  onDrained: () => void,
): () => void {
  let stalled = false;
  let stopped = false;
  let timer: NodeJS.Timeout;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    response.off("drain", onDrain);
  };

  const onDrain = (): void => {
    if (!stalled) return;
    stalled = false;
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
      if (!response.write(": kontrol-heartbeat\n\n")) {
        stalled = true;
        onStalled();
      }
    } catch {
      stop();
    }
  }, intervalMs);
  timer.unref?.();
  return stop;
}
