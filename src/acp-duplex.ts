/**
 * ACP duplex transport — spec-compliant bidirectional JSON-RPC over a stream.
 *
 * The legacy {@link AcpClient} is request/response only: DevSpace calls the
 * agent and reads back a result. But the Agent Client Protocol is duplex — a
 * running agent calls BACK into the client for:
 *
 *   - `session/request_permission`  (agent needs a human's approval mid-tool)
 *   - `fs/read_text_file`           (agent asks the client to read a file)
 *   - `fs/write_text_file`          (agent asks the client to write a file)
 *   - `session/update`              (streaming progress notification; no reply)
 *
 * This module speaks that reverse channel over a newline-delimited JSON-RPC
 * stream (the framing every ACP stdio agent uses). Inbound requests are routed
 * to an {@link AcpClientHandler}; DevSpace wires that handler into its approval +
 * policy machinery so agent-initiated permission requests surface in the WebUI
 * and park — with NO fail-closed timeout — until a human decides.
 */

import { randomUUID } from "node:crypto";

/** A JSON-RPC 2.0 message (request, response, or notification). */
export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Minimal duplex byte stream (stdin/stdout of a spawned agent, a socket, …). */
export interface DuplexStream {
  /** Emit one framed line (already newline-terminated) toward the agent. */
  write(line: string): void;
  /** Register a line reader. Each call receives one complete JSON-RPC line. */
  onLine(cb: (line: string) => void): void;
  /** Register a close handler. Pending requests reject when this fires. */
  onClose(cb: () => void): void;
  close(): void;
}

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall?: unknown;
  options: PermissionOption[];
}

export type PermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface FsReadParams {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}

export interface FsWriteParams {
  sessionId: string;
  path: string;
  content: string;
}

export interface SessionUpdateParams {
  sessionId: string;
  update: unknown;
}

/**
 * Host-side handler for agent-initiated ACP calls. Every method is async; a
 * rejected promise becomes a JSON-RPC error back to the agent. `requestPermission`
 * MUST NOT impose its own deny-on-timeout — it should resolve only when a human
 * (or an explicit cancellation) decides. Cancellation is surfaced via the passed
 * AbortSignal (fired when the session is cancelled or the stream closes).
 */
export interface AcpClientHandler {
  requestPermission(params: RequestPermissionParams, signal: AbortSignal): Promise<PermissionOutcome>;
  readTextFile?(params: FsReadParams): Promise<{ content: string }>;
  writeTextFile?(params: FsWriteParams): Promise<void>;
  sessionUpdate?(params: SessionUpdateParams): void;
  /** Any other agent-initiated method. Reject to send a JSON-RPC error. */
  extMethod?(method: string, params: unknown): Promise<unknown>;
}

const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INTERNAL_ERROR = -32603;

export interface AcpDuplexConnection {
  /** Send a request to the agent and await its response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Send a fire-and-forget notification to the agent. */
  notify(method: string, params?: unknown): void;
  /** Abort all in-flight inbound handlers (e.g. session cancelled). */
  cancelInbound(): void;
  close(): void;
}

/**
 * Wire a {@link DuplexStream} to a {@link AcpClientHandler}, returning a
 * connection that can also originate outbound requests. Handles JSON-RPC
 * framing, id correlation, and error mapping in both directions.
 */
export function createAcpDuplex(
  stream: DuplexStream,
  handler: AcpClientHandler,
): AcpDuplexConnection {
  const pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let inboundAbort = new AbortController();
  let closed = false;

  function send(msg: JsonRpcMessage): void {
    if (closed) return;
    stream.write(JSON.stringify(msg) + "\n");
  }

  function respondResult(id: string | number, result: unknown): void {
    send({ jsonrpc: "2.0", id, result });
  }

  function respondError(id: string | number, code: number, message: string): void {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async function dispatchInbound(msg: JsonRpcMessage): Promise<void> {
    const { id, method, params } = msg;
    // Notification (no id): session/update and other stream events.
    if (id === undefined || id === null) {
      if (method === "session/update") handler.sessionUpdate?.(params as SessionUpdateParams);
      else if (method && handler.extMethod) {
        try { await handler.extMethod(method, params); } catch { /* notifications swallow errors */ }
      }
      return;
    }

    try {
      switch (method) {
        case "session/request_permission": {
          const outcome = await handler.requestPermission(
            params as RequestPermissionParams,
            inboundAbort.signal,
          );
          respondResult(id, { outcome });
          return;
        }
        case "fs/read_text_file": {
          if (!handler.readTextFile) return respondError(id, JSONRPC_METHOD_NOT_FOUND, "fs/read_text_file not supported");
          respondResult(id, await handler.readTextFile(params as FsReadParams));
          return;
        }
        case "fs/write_text_file": {
          if (!handler.writeTextFile) return respondError(id, JSONRPC_METHOD_NOT_FOUND, "fs/write_text_file not supported");
          await handler.writeTextFile(params as FsWriteParams);
          respondResult(id, {});
          return;
        }
        default: {
          if (handler.extMethod) {
            respondResult(id, await handler.extMethod(method ?? "", params));
            return;
          }
          respondError(id, JSONRPC_METHOD_NOT_FOUND, `Unknown method: ${method}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      respondError(id, JSONRPC_INTERNAL_ERROR, message);
    }
  }

  stream.onLine((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return; // ignore malformed frames
    }
    // A response to one of OUR outbound requests?
    if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message));
        else waiter.resolve(msg.result);
      }
      return;
    }
    // Otherwise it's an inbound request/notification from the agent.
    void dispatchInbound(msg);
  });

  stream.onClose(() => {
    closed = true;
    inboundAbort.abort();
    for (const [, waiter] of pending) waiter.reject(new Error("ACP duplex stream closed"));
    pending.clear();
  });

  return {
    request<T>(method: string, params?: unknown): Promise<T> {
      if (closed) return Promise.reject(new Error("ACP duplex stream closed"));
      const id = randomUUID();
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method: string, params?: unknown): void {
      send({ jsonrpc: "2.0", method, params });
    },
    cancelInbound(): void {
      inboundAbort.abort();
      inboundAbort = new AbortController();
    },
    close(): void {
      if (closed) return;
      closed = true;
      inboundAbort.abort();
      stream.close();
    },
  };
}
