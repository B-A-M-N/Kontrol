/**
 * MCP session-state types, logical-client identity derivation, and HTTP body
 * gates for the MCP/ACP hops. Extracted verbatim from src/server.ts (P1.2).
 */
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContinuationDispatcher } from "../acp-bridge.js";
import type { ServerConfig } from "../config.js";
import { constantTimeStringEqual } from "../mcp/workspace-server.js";
import { sessionIdPrefix } from "../logger.js";
import type { Express, NextFunction, Request, Response } from "express";

export function resolveMcpMemoryBudget(explicitBytes?: number): number {
  // P0.3: explicit config override first; no ambient process.env read here.
  if (explicitBytes !== undefined && explicitBytes > 0) return explicitBytes;
  try {
    const cgroupLimit = Number(readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim());
    if (Number.isFinite(cgroupLimit) && cgroupLimit > 0) return cgroupLimit;
  } catch {
    // Not a cgroup-v2 container — fall through to total memory.
  }
  try {
    return os.totalmem();
  } catch {
    return 2_000_000_000;
  }
}

export interface McpSessionState {
  sessionId: string;
  sessionLabel: string;
  logicalClientId: string;
  identitySource: "instance_header" | "conversation" | "oauth" | "client_info_fallback";
  authenticatedRole: "worker" | "reviewer" | "client";
  authSource: "oauth" | "reviewer_token" | "worker_token" | "tunnel_reviewer" | "anonymous";
  conversationId?: string;
  approvalCorrelationId?: string;
  createdAt: number;
  /** Any request/stream activity, including protocol heartbeats and SSE. */
  lastTransportActivityAt: number;
  /** Meaningful MCP application traffic used by idle policy. */
  lastApplicationActivityAt: number;
  inFlightRequests: number;
  requestCount: number;
  notificationCount: number;
  toolCallCount: number;
  resourceReadCount: number;
  activeLongPollCount: number;
  activeSseStreams: number;
  activePolicyWaiters: number;
  closing: boolean;
  closed: boolean;
  endRecorded: boolean;
  durableWorkerSession: boolean;
  lastRpcMethod?: string;
  lastToolName?: string;
}

export interface McpPolicyWaiter {
  id: string;
  approvalId: string;
  waiterKey: string;
  principalId: string;
  workspaceId: string;
  workSessionId?: string;
  tool: string;
  mcpSessionId?: string;
  mcpRequestId?: string;
  startedAt: number;
  signal: AbortSignal;
  cancel: () => void;
}

export type McpSessionWindowKind = "created" | "closed" | "expired" | "tool";

export interface McpSessionClientMetrics {
  sessionsCreated: number;
  currentSessions: number;
  sessionsClosed: number;
  sessionsExpired: number;
  zeroToolSessions: number;
  singleToolSessions: number;
  multiToolSessions: number;
  totalToolCalls: number;
  totalLifetimeMs: number;
  oldestIdleMs: number;
}

export interface McpSessionMetrics {
  created: number;
  evicted: number;
  closed: number;
  expired: number;
  inFlight: number;
  clients: Map<string, McpSessionClientMetrics>;
  windowEvents: Array<{ at: number; kind: McpSessionWindowKind }>;
  completedToolCounts: number[];
}

export interface McpTimingSample {
  at: number;
  admissionClass: "execution" | "waiter" | "stream";
  admissionWaitMs: number;
  serverCreateMs: number;
  transportConnectMs: number;
  handlerMs: number;
  totalMs: number;
}

export interface PhaseTimingSample {
  at: number;
  phase: string;
  durationMs: number;
}

export interface WorkspaceAppResourceMetrics {
  currentHashed: number;
  openAiCompatibility: number;
  legacyKontrol: number;
  devDesktopMigration: number;
  servedTotal: number;
  lastDurationMs: number;
  maxDurationMs: number;
  /** P0 resource admission: reads rejected because the resource pool or its
   * per-client cap was exhausted. */
  admissionRejections: number;
  /** Currently in-flight admitted resource reads (peak-sampled max). */
  active: number;
  maxActive: number;
  /** P1 perf: actual wire bytes of the last served resource (post-encoding). */
  lastWireBytes: number;
}

/** Explicit route-level HTTP body caps. These are deliberately finite: MCP
 * writes/patches need more than Express's default 100 KB, while ACP events
 * must remain smaller than the final-result protocol budget plus envelope. */
export const MCP_HTTP_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
export const ACP_HTTP_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

export function rejectOversizedBody(limitBytes: number, protocol: "mcp" | "acp") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawLength = req.header("content-length");
    const contentLength = rawLength === undefined ? undefined : Number(rawLength);
    if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
      if (protocol === "mcp") sendJsonRpcError(res, 400, -32700, "Invalid Content-Length");
      else res.status(400).json({ error: { code: "invalid_request", message: "Invalid Content-Length" } });
      return;
    }
    if (contentLength !== undefined && contentLength > limitBytes) {
      res.setHeader("Connection", "close");
      if (protocol === "mcp") sendJsonRpcError(res, 413, -32013, `Request body exceeds ${limitBytes} bytes`);
      else res.status(413).json({ error: { code: "request_too_large", message: `Request body exceeds ${limitBytes} bytes` } });
      return;
    }
    next();
  };
}

export function authenticatedAcpBodyGate(config: ServerConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = req.headers.authorization ?? "";
    // Timing-safe comparison for every configured role secret. First-match
    // wins, so secrets must be distinct (enforced by config validation).
    const matches =
      (config.acpAgentSecret && constantTimeStringEqual(presented, `Bearer ${config.acpAgentSecret}`)) ||
      (config.acpReviewerSecret && constantTimeStringEqual(presented, `Bearer ${config.acpReviewerSecret}`)) ||
      (config.acpSharedSecret && constantTimeStringEqual(presented, `Bearer ${config.acpSharedSecret}`));
    if (!matches) {
      res.status(401).json({ error: { code: "unauthorized", message: "Missing or invalid authorization" } });
      return;
    }
    next();
  };
}

export interface RunningServer {
  app: Express;
  config: ServerConfig;
  dispatcher?: ContinuationDispatcher;
  close(): Promise<void>;
  drain(): Promise<void>;
}

export function logicalClientIdentity(req: Request): { id: string; source: McpSessionState["identitySource"] } {
  // Reconnectable interactive ownership partitions an ALREADY-AUTHENTICATED
  // principal by conversation. A conversation value never broadens
  // authorization: it only narrows which transports share one logical owner,
  // so two conversations of the same client cannot touch each other's direct
  // processes or reattach to each other's pending approvals.
  const suppliedConversation = conversationId(req);
  if (req.auth?.clientId) {
    return suppliedConversation
      ? { id: `oauth:${req.auth.clientId}|conversation:${suppliedConversation}`, source: "oauth" }
      : { id: `oauth:${req.auth.clientId}`, source: "oauth" };
  }
  const supplied = req.header("x-kontrol-client-instance")?.trim();
  if (supplied) {
    return suppliedConversation
      ? { id: `instance:${supplied.slice(0, 200)}|conversation:${suppliedConversation}`, source: "instance_header" }
      : { id: `instance:${supplied.slice(0, 200)}`, source: "instance_header" };
  }
  if (suppliedConversation) return { id: `conversation:${suppliedConversation}`, source: "conversation" };
  const clientInfo = (req.body as { params?: { clientInfo?: { name?: unknown; version?: unknown } } } | undefined)
    ?.params?.clientInfo;
  const name = typeof clientInfo?.name === "string" ? clientInfo.name : "unknown";
  const version = typeof clientInfo?.version === "string" ? clientInfo.version : "unknown";
  return { id: `mcp:${name.slice(0, 100)}@${version.slice(0, 100)}`, source: "client_info_fallback" };
}

export function logicalClientId(req: Request): string {
  return logicalClientIdentity(req).id;
}

// MCP does not standardize a conversation identifier. If a trusted
// deployment forwards one, retain it for diagnostics/labeling only. Never use
// this value to pool transports or grant access; the MCP session ID remains the
// isolation boundary.
export function conversationId(req: Request): string | undefined {
  const value = req.header("x-kontrol-conversation-id")?.trim()
    || req.header("x-openai-conversation-id")?.trim();
  return value ? value.slice(0, 200) : undefined;
}

export function mcpSessionLabel(logicalClientIdValue: string, sessionId: string, conversationIdValue?: string): string {
  const owner = conversationIdValue ? `conversation:${conversationIdValue}` : logicalClientIdValue;
  return `${owner}/mcp:${sessionIdPrefix(sessionId)}`;
}

export function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

export function uiBuildDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const localDirectory = join(moduleDirectory, "ui");
  return statSync(localDirectory, { throwIfNoEntry: false })?.isDirectory()
    ? localDirectory
    : join(process.cwd(), "dist", "ui");
}

export function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}
