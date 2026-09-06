/**
 * Bounded request admission for the MCP HTTP hop: admission classes, weights,
 * execution deadlines, and the shared admission queue. Extracted verbatim from
 * src/server.ts (P1.2); server.ts re-exports the public surface.
 */
import type { Transport } from "../mcp/workspace-server.js";
import type { Request, Response } from "express";

export interface McpAdmissionWaiter {
  key: string;
  weight: number;
  resolve: (release: (() => void) | null) => void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

export function mcpAdmissionWeight(rpcMethod: string | undefined, toolName: string | undefined): number {
  if (rpcMethod !== "tools/call") return 1;
  if (toolName === "show_changes" || toolName === "run_mission_verification") return 4;
  if (toolName === "grep" || toolName === "glob" || toolName === "find" || toolName === "list_pending_reviews") return 2;
  if (toolName === "bash" || toolName === "exec_command" || toolName === "write_stdin" || toolName === "write" || toolName === "edit" || toolName === "apply_patch") return 3;
  return 1;
}

// These calls either own their own process/mission lifecycle or deliberately
// park until a human/event arrives. A generic HTTP execution deadline would
// strand the operation while its durable state still says it is running.
const MCP_UNBOUNDED_TOOL_NAMES = new Set([
  "await_review_feedback",
  "await_work_session_events",
  "await_work_session_terminal",
  "await_workspace_events",
  "bash",
  "exec_command",
  "write_stdin",
  "write",
  "edit",
  "apply_patch",
  "submit_to_coding_agent",
  "call_acp_agent",
  "begin_supervised_work",
  "run_mission_verification",
  "provide_policy_approval",
]);

export function mcpRequestHasExecutionDeadline(rpcMethod: string | undefined, toolName: string | undefined): boolean {
  return rpcMethod !== "tools/call" || !MCP_UNBOUNDED_TOOL_NAMES.has(toolName ?? "");
}

export class McpExecutionTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`MCP request exceeded the ${timeoutMs}ms execution deadline`);
    this.name = "McpExecutionTimeoutError";
  }
}

export class McpAdmissionUnavailableError extends Error {
  constructor() {
    super("MCP execution capacity was unavailable after policy approval");
    this.name = "McpAdmissionUnavailableError";
  }
}

export async function handleMcpRequestWithDeadline(
  transport: Transport,
  req: Request,
  res: Response,
  body: unknown,
  timeoutMs: number,
): Promise<void> {
  const handler = transport.handleRequest(req, res, body);
  // The MCP SDK does not expose cancellation for an in-flight handler. Keep
  // its rejection observed, then close the transport on timeout so the caller
  // can reconnect instead of leaving a dead HTTP request and retained session.
  void handler.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      handler,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new McpExecutionTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof McpExecutionTimeoutError) {
      try {
        await Promise.race([
          Promise.resolve(transport.close()),
          new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        ]);
      } catch {
        // The transport is already considered unusable after a deadline.
      }
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bounded request admission for the MCP HTTP hop. Session caps protect the
 * transport map; this queue protects the process from an unbounded number of
 * expensive tool calls and long polls running at once.
 */
export class McpAdmission {
  private active = 0;
  private activeWeight = 0;
  private readonly activeByKey = new Map<string, number>();
  private readonly queue: McpAdmissionWaiter[] = [];
  private closed = false;

  constructor(
    private readonly maxInflight: number,
    private readonly maxInflightPerKey: number,
    private readonly maxQueue: number,
  ) {
    if (!Number.isInteger(maxInflight) || maxInflight < 1) throw new Error("maxInflight must be positive");
    if (!Number.isInteger(maxInflightPerKey) || maxInflightPerKey < 1) throw new Error("maxInflightPerKey must be positive");
    if (!Number.isInteger(maxQueue) || maxQueue < 0) throw new Error("maxQueue must be non-negative");
  }

  getStats(): { active: number; activeWeight: number; availableWeight: number; queued: number; maxInflight: number; maxInflightPerKey: number; maxQueue: number } {
    return {
      active: this.active,
      activeWeight: this.activeWeight,
      availableWeight: Math.max(0, this.maxInflight - this.activeWeight),
      queued: this.queue.length,
      maxInflight: this.maxInflight,
      maxInflightPerKey: this.maxInflightPerKey,
      maxQueue: this.maxQueue,
    };
  }

  acquire(key: string, waitDeadlineMs: number, weight = 1, signal?: AbortSignal): Promise<(() => void) | null> {
    if (this.closed) return Promise.resolve(null);
    if (!Number.isInteger(weight) || weight < 1 || weight > this.maxInflight || weight > this.maxInflightPerKey) return Promise.resolve(null);
    if (signal?.aborted) return Promise.resolve(null);
    if (this.canAdmit(key, weight)) return Promise.resolve(this.grant(key, weight));
    if (this.queue.length >= this.maxQueue) return Promise.resolve(null);

    return new Promise((resolve) => {
      const waiter: McpAdmissionWaiter = {
        key,
        weight,
        resolve,
        signal,
        settled: false,
      };
      const settle = (release: (() => void) | null) => {
        if (waiter.settled) return;
        waiter.settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
        resolve(release);
      };
      const removeAndCancel = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        settle(null);
      };
      waiter.onAbort = removeAndCancel;
      waiter.timer = setTimeout(() => {
          removeAndCancel();
        }, Math.max(1, waitDeadlineMs));
      if (signal) {
        signal.addEventListener("abort", waiter.onAbort, { once: true });
        if (signal.aborted) {
          removeAndCancel();
          return;
        }
      }
      if (this.closed) {
        removeAndCancel();
        return;
      }
      this.queue.push(waiter);
    });
  }

  close(): void {
    this.closed = true;
    while (this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      if (waiter.settled) continue;
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(null);
    }
  }

  private canAdmit(key: string, weight: number): boolean {
    return this.activeWeight + weight <= this.maxInflight && (this.activeByKey.get(key) ?? 0) + weight <= this.maxInflightPerKey;
  }

  private grant(key: string, weight: number): () => void {
    this.active++;
    this.activeWeight += weight;
    this.activeByKey.set(key, (this.activeByKey.get(key) ?? 0) + weight);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.activeWeight = Math.max(0, this.activeWeight - weight);
      const count = (this.activeByKey.get(key) ?? weight) - weight;
      if (count > 0) this.activeByKey.set(key, count);
      else this.activeByKey.delete(key);
      this.drain();
    };
  }

  private drain(): void {
    if (this.closed) return;
    for (let i = 0; i < this.queue.length; i++) {
      const waiter = this.queue[i];
      if (waiter.settled) {
        this.queue.splice(i, 1);
        i--;
        continue;
      }
      if (!this.canAdmit(waiter.key, waiter.weight)) continue;
      this.queue.splice(i, 1);
      i--;
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(this.grant(waiter.key, waiter.weight));
    }
  }
}
