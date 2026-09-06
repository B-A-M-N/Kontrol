/**
 * Checked server-tool invocation: one deterministic reconnect-and-retry on
 * transient transport failure, with per-tool retry classes and the
 * AmbiguousMutationError contract for lost mutation responses. Extracted
 * verbatim from ui/workspace-app.tsx (P1.4); the module `app` cell became an
 * explicit host binding installed at boot.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolResultCard } from "./card-types.js";

type ServerToolRequest = Parameters<App["callServerTool"]>[0];

export class AmbiguousMutationError extends Error {
  readonly operation: string;

  constructor(operation: string, cause?: unknown) {
    super(`The ${operation} mutation may have committed, but its response was lost. Refresh authoritative state before retrying.`);
    this.name = "AmbiguousMutationError";
    this.operation = operation;
    if (cause !== undefined) this.cause = cause;
  }
}

type ServerToolRetryMode = "safe" | "reconcile" | "never";
interface ServerToolCallOptions { retry?: ServerToolRetryMode }

const SAFE_RETRY_TOOLS = new Set([
  "get_workspace_session_surface",
  "list_pending_approvals",
  "get_work_session_snapshot",
  "get_review_submission",
  "inspect_supervised_work",
  "await_workspace_events",
]);

const RECONCILE_ONLY_TOOLS = new Set([
  "resolve_agent_message",
  "redrive_supervisor_run",
  "run_mission_verification",
  "continue_supervised_work",
  "submit_to_coding_agent",
  "pause_supervisor_run",
  "resume_supervisor_run",
  "provide_review_feedback",
  "approve_supervised_work",
  "provide_policy_approval",
]);

const NEVER_RETRY_TOOLS = new Set([
  "cancel_work_session",
]);

function retryModeForServerTool(name: string, explicit?: ServerToolRetryMode): ServerToolRetryMode {
  if (explicit) return explicit;
  if (SAFE_RETRY_TOOLS.has(name)) return "safe";
  if (RECONCILE_ONLY_TOOLS.has(name)) return "reconcile";
  if (NEVER_RETRY_TOOLS.has(name)) return "never";
  return "never";
}

export interface ServerToolHost {
  getApp(): App | null;
  reconnect(reason: unknown): Promise<void>;
}

let host: ServerToolHost = { getApp: () => null, reconnect: async () => undefined };

export function setServerToolHost(next: ServerToolHost): void {
  host = next;
}

export async function callServerToolChecked(request: ServerToolRequest, options: ServerToolCallOptions = {}): Promise<CallToolResult> {
  const app = host.getApp();
  if (!app) throw new Error("The MCP host connection is unavailable.");
  let result: CallToolResult;
  try {
    result = await app.callServerTool(request);
  } catch (transportError) {
    // A transient host/tunnel failure should get one deterministic reconnect
    // and rehydration attempt before the caller sees a permanent error.
    const retryMode = retryModeForServerTool(String(request.name), options.retry);
    try {
      await host.reconnect(transportError);
    } catch (reconnectError) {
      if (retryMode !== "safe") throw new AmbiguousMutationError(String(request.name), reconnectError);
      throw reconnectError;
    }
    if (!app) {
      if (retryMode !== "safe") throw new AmbiguousMutationError(String(request.name), transportError);
      throw transportError;
    }
    if (retryMode !== "safe") {
      throw new AmbiguousMutationError(String(request.name), transportError);
    }
    result = await app.callServerTool(request);
  }
  if (!result.isError) return result;
  const message = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  throw new Error(message || "The server rejected the tool call.");
}

export function cardFromMeta(result: CallToolResult): Partial<ToolResultCard> | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const metaCard = meta?.card;
  return metaCard && typeof metaCard === "object" ? metaCard : undefined;
}

export function getStructuredContent<T>(result: CallToolResult): T | undefined {
  return result.structuredContent as T | undefined;
}
