import { execSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Socket } from "node:net";
import os from "node:os";
import { join, dirname, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hostHeaderValidation, localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import * as z from "zod/v4";
import { applyPatch, parsePatch } from "./apply-patch.js";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  sessionIdPrefix,
} from "./logger.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { FilesystemSnapshotStore } from "./filesystem-snapshot-store.js";
import { createMaintenanceCoordinator } from "./runtime/maintenance.js";
import { createDatabaseIntegrityMonitor } from "./runtime/database-integrity.js";
import {
  constantTimeStringEqual,
  createMcpServer,
  ConnectionContext,
  degradedAuditSnapshot,
  mcpRequestContext,
  requestLogFields,
  Transport,
  type McpRequestContext,
} from "./mcp/workspace-server.js";

export { constantTimeStringEqual } from "./mcp/workspace-server.js";
import { getGitEligibility } from "./git.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { createWorkSessionManager, type WorkSessionManager } from "./work-sessions.js";
import { createAgentRegistryManager } from "./acp-registry.js";
import { createAcpServer } from "./acp-server.js";
import { registerBridgeTools, createContinuationDispatcher, type ContinuationDispatcher, type LiveWaiterRegistry, type BridgeConfig } from "./acp-bridge.js";
import { createEventStore } from "./event-log.js";
import { createContinuationManager } from "./continuation.js";
import { createDispatchOutbox } from "./dispatch-outbox.js";
import { createSupervisorRuns } from "./supervisor-runs.js";
import { createSupervisorRuntime } from "./supervisor-runtime.js";
import { shutdownMissionVerifiers, verifyMissionSubmission } from "./mission-verifier.js";
import { evaluateSupervisorMission } from "./supervisor-evaluator.js";
import { createReviewWorkflowService, type ReviewWorkflowService } from "./review-workflow.js";
import { databasePath, openDatabase, type DatabaseHandle } from "./db/client.js";
import { LATEST_SCHEMA_VERSION } from "./db/migrations.js";
import { createPolicyEngine, policyCanAsk, type PolicyConfig, type PolicyEngine, type ApprovalScope } from "./policy.js";
import { createSqliteGrantStore } from "./policy-grants.js";
import { registerPolicyTools } from "./policy-tools.js";
import { createPolicyEnforcer, type PolicyInvocation, type PolicyEnforcer, type PolicyWaitContext, type PolicyWaitOutcome, ACP_TOOL_POLICY_NAMES, type PrincipalRole } from "./policy-enforcement.js";
import { authorizeWorkSessionAction } from "./work-session-action-guard.js";
import { verifyWorkerToken, type WorkerTokenClaims } from "./acp-worker-token.mjs";
import { createApprovalRequestManager } from "./approval-requests.js";
import { createMissionLedger } from "./mission-ledger.js";
import { createAgentMessageManager } from "./agent-messages.js";
import { createMutationReceiptStore, type MutationReceiptStore } from "./mutation-receipts.js";
import { DEVDESKTOP_WORKSPACE_APP_URI, LEGACY_WORKSPACE_APP_URI, OPENAI_WORKSPACE_APP_URI, WORKSPACE_APP_BUILD_ID, WORKSPACE_APP_HTML, WORKSPACE_APP_URI, workspaceAppResourceKind, workspaceAppResourceMeta, workspaceAppToolMeta } from "./workspace-app-resource.js";
import { createRuntimeIdentityRecord, readBuildIdentity, readRuntimeIdentity, removeRuntimeIdentity, writeRuntimeIdentity } from "./runtime-identity.js";
import { acquireRuntimeLock, assertRuntimeLock, releaseRuntimeLock, runtimeLockPath, type RuntimeLockHandle } from "./runtime-lock.js";
import { mcpSessionIdleReason, mcpSessionIdleTtl } from "./mcp-session-policy.js";
import { LogicalContinuityIndex } from "./mcp-logical-continuity.js";
import { installCachedToolList, toolListCacheDiagnostics } from "./mcp-tool-list-cache.js";
import { isPathInsideRoot } from "./roots.js";


/**
 * P1 #24: MCP memory budget for adaptive session caps. Resolution order:
 * 1. KONTROL_MCP_MEMORY_BUDGET_BYTES (explicit deployment budget)
 * 2. cgroup memory limit (container ceiling), when readable
 * 3. total system memory
 */
function resolveMcpMemoryBudget(): number {
  const explicit = Number(process.env.KONTROL_MCP_MEMORY_BUDGET_BYTES);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
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


interface McpSessionState {
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

interface McpPolicyWaiter {
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

type McpSessionWindowKind = "created" | "closed" | "expired" | "tool";

interface McpSessionClientMetrics {
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

interface McpSessionMetrics {
  created: number;
  evicted: number;
  closed: number;
  expired: number;
  inFlight: number;
  clients: Map<string, McpSessionClientMetrics>;
  windowEvents: Array<{ at: number; kind: McpSessionWindowKind }>;
  completedToolCounts: number[];
}

interface McpTimingSample {
  at: number;
  admissionClass: "execution" | "waiter" | "stream";
  admissionWaitMs: number;
  serverCreateMs: number;
  transportConnectMs: number;
  handlerMs: number;
  totalMs: number;
}

interface PhaseTimingSample {
  at: number;
  phase: string;
  durationMs: number;
}

interface WorkspaceAppResourceMetrics {
  currentHashed: number;
  openAiCompatibility: number;
  legacyKontrol: number;
  devDesktopMigration: number;
  servedTotal: number;
  lastDurationMs: number;
  maxDurationMs: number;
}


/** Explicit route-level HTTP body caps. These are deliberately finite: MCP
 * writes/patches need more than Express's default 100 KB, while ACP events
 * must remain smaller than the final-result protocol budget plus envelope. */
export const MCP_HTTP_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
export const ACP_HTTP_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

function rejectOversizedBody(limitBytes: number, protocol: "mcp" | "acp") {
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

function authenticatedAcpBodyGate(config: ServerConfig) {
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

interface RunningServer {
  app: Express;
  config: ServerConfig;
  dispatcher?: ContinuationDispatcher;
  close(): Promise<void>;
  drain(): Promise<void>;
}


function logicalClientIdentity(req: Request): { id: string; source: McpSessionState["identitySource"] } {
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

function logicalClientId(req: Request): string {
  return logicalClientIdentity(req).id;
}

// MCP does not standardize a conversation identifier. If a trusted
// deployment forwards one, retain it for diagnostics/labeling only. Never use
// this value to pool transports or grant access; the MCP session ID remains the
// isolation boundary.
function conversationId(req: Request): string | undefined {
  const value = req.header("x-kontrol-conversation-id")?.trim()
    || req.header("x-openai-conversation-id")?.trim();
  return value ? value.slice(0, 200) : undefined;
}

function mcpSessionLabel(logicalClientIdValue: string, sessionId: string, conversationIdValue?: string): string {
  const owner = conversationIdValue ? `conversation:${conversationIdValue}` : logicalClientIdValue;
  return `${owner}/mcp:${sessionIdPrefix(sessionId)}`;
}

interface McpAdmissionWaiter {
  key: string;
  weight: number;
  resolve: (release: (() => void) | null) => void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

function mcpAdmissionWeight(rpcMethod: string | undefined, toolName: string | undefined): number {
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

function mcpRequestHasExecutionDeadline(rpcMethod: string | undefined, toolName: string | undefined): boolean {
  return rpcMethod !== "tools/call" || !MCP_UNBOUNDED_TOOL_NAMES.has(toolName ?? "");
}

class McpExecutionTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`MCP request exceeded the ${timeoutMs}ms execution deadline`);
    this.name = "McpExecutionTimeoutError";
  }
}

class McpAdmissionUnavailableError extends Error {
  constructor() {
    super("MCP execution capacity was unavailable after policy approval");
    this.name = "McpAdmissionUnavailableError";
  }
}

async function handleMcpRequestWithDeadline(
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


function sendJsonRpcError(
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


function uiBuildDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const localDirectory = join(moduleDirectory, "ui");
  return statSync(localDirectory, { throwIfNoEntry: false })?.isDirectory()
    ? localDirectory
    : join(process.cwd(), "dist", "ui");
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

export function createServer(config = loadConfig()): RunningServer {
  // P0 #9: the ACP surface requires at least one role credential. The legacy
  // shared secret is compatibility-only: when it is the sole credential (or
  // when it doubles as the operator ingress), warn — it carries broad
  // operator authority and should be split into agent/reviewer/adapter roles.
  if (config.acpEnabled && !config.acpSharedSecret && !config.acpAgentSecret && !config.acpReviewerSecret) {
    throw new Error(
      "ACP is enabled but no credentials are configured. Set KONTROL_ACP_AGENT_SECRET, " +
        "KONTROL_ACP_REVIEWER_SECRET, and KONTROL_ACP_ADAPTER_SECRET to long random values " +
        "(e.g. `openssl rand -hex 32`). KONTROL_ACP_SHARED_SECRET is legacy-only.",
    );
  }
  if (config.acpEnabled && config.acpSharedSecret && (!config.acpAgentSecret || !config.acpReviewerSecret || !config.acpAdapterSecret)) {
    console.warn(
      "[kontrol] warning: KONTROL_ACP_SHARED_SECRET is set and acts as a broad-authority operator credential. " +
        "Prefer the split role secrets: KONTROL_ACP_AGENT_SECRET / KONTROL_ACP_REVIEWER_SECRET / KONTROL_ACP_ADAPTER_SECRET.",
    );
  }

  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  // Build the app locally so route-level body parsers remain under Kontrol's
  // control. The SDK helper installs an unconditional express.json() parser
  // with its ~100 KB default before callers can add a larger MCP/ACP limit.
  const app = express();
  if (allowedHosts) {
    app.use(hostHeaderValidation(allowedHosts));
  } else if (["127.0.0.1", "localhost", "::1"].includes(config.host)) {
    app.use(localhostHostValidation());
  } else if (config.host === "0.0.0.0" || config.host === "::") {
    console.warn(`[kontrol] Server is binding to ${config.host} without DNS rebinding protection.`);
  }
  const buildMeta = readBuildIdentity(join(dirname(fileURLToPath(import.meta.url)), "build-meta.json"));
  const transports = new Map<string, Transport>();
  const mcpSessions = new Map<string, McpSessionState>();
  // MCP session IDs are transport-scoped and intentionally disposable. This
  // bounded in-memory index retains only trusted identity continuity metadata
  // across a socket loss; it never authorizes, replays, or reuses a transport.
  const logicalContinuity = new LogicalContinuityIndex({
    retentionMs: config.mcpLogicalContinuityRetentionMs,
    onExpire: (identity) => {
      // Trusted direct process sessions outlive an individual transport, but
      // must not outlive the continuity record that authorizes reattachment.
      // Work-session-owned processes use a different owner namespace and are
      // intentionally unaffected by this cleanup.
      void processSessions.terminateByOwner(`logical-client:${identity}`).catch((error) => {
        logEvent(config.logging, "warn", "logical_continuity_process_cleanup_failed", {
          logicalClientId: identity,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  });
  // A host may reuse one keep-alive socket for hundreds of MCP requests. Keep
  // one close listener per socket, rather than one listener per request, so
  // transport disconnect cancellation cannot grow EventEmitter listeners.
  const socketAbortRegistries = new WeakMap<Socket, {
    controllers: Set<AbortController>;
    onClose: () => void;
  }>();
  const trackSocketAbort = (socket: Socket, controller: AbortController): (() => void) => {
    let registry = socketAbortRegistries.get(socket);
    if (!registry) {
      registry = {
        controllers: new Set<AbortController>(),
        onClose: () => {
          for (const activeController of registry!.controllers) activeController.abort();
          registry!.controllers.clear();
          socketAbortRegistries.delete(socket);
        },
      };
      socketAbortRegistries.set(socket, registry);
      socket.once("close", registry.onClose);
    }
    registry.controllers.add(controller);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      registry!.controllers.delete(controller);
      if (registry!.controllers.size === 0) {
        socket.off("close", registry!.onClose);
        socketAbortRegistries.delete(socket);
      }
    };
  };
  const mcpPolicyWaiters = new Map<string, McpPolicyWaiter>();
  let policyWaiterDisconnects = 0;
  let policyWaiterResumes = 0;
  let lastPolicyWaiterDisconnectAt: number | undefined;
  let lastPolicyWaiterResumeAt: number | undefined;
  let shuttingDown = false;
  const mcpAdmission = new McpAdmission(
    config.mcpMaxInflight,
    config.mcpMaxInflightPerSession,
    config.mcpMaxQueue,
  );
  const mcpWaiterAdmission = new McpAdmission(
    config.mcpMaxWaiters,
    config.mcpMaxWaitersPerSession,
    config.mcpMaxWaiterQueue,
  );
  const mcpSessionMetrics: McpSessionMetrics = {
    created: 0,
    evicted: 0,
    closed: 0,
    expired: 0,
    inFlight: 0,
    clients: new Map(),
    windowEvents: [],
    completedToolCounts: [],
  };
  const mcpTimingSamples: McpTimingSample[] = [];
  const phaseTimingSamples: PhaseTimingSample[] = [];
  const mcpCapacityRejectionsByTool = new Map<string, number>();
  const mcpCapacityRejectionsByWeight = new Map<number, number>();
  const workspaceAppResourceMetrics: WorkspaceAppResourceMetrics = {
    currentHashed: 0,
    openAiCompatibility: 0,
    legacyKontrol: 0,
    devDesktopMigration: 0,
    servedTotal: 0,
    lastDurationMs: 0,
    maxDurationMs: 0,
  };

  function recordMcpTiming(sample: Omit<McpTimingSample, "at">): void {
    mcpTimingSamples.push({ at: Date.now(), ...sample });
    if (mcpTimingSamples.length > 2_000) mcpTimingSamples.splice(0, mcpTimingSamples.length - 2_000);
    recordPhaseTiming("mcp.admission_wait", sample.admissionWaitMs);
    if (sample.serverCreateMs > 0) recordPhaseTiming("mcp.server_setup_total", sample.serverCreateMs);
    if (sample.transportConnectMs > 0) recordPhaseTiming("mcp.transport_connect", sample.transportConnectMs);
    if (sample.handlerMs > 0) recordPhaseTiming("mcp.handler", sample.handlerMs);
    recordPhaseTiming("mcp.request_total", sample.totalMs);
  }

  function recordPhaseTiming(phase: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    phaseTimingSamples.push({ at: Date.now(), phase, durationMs });
    if (phaseTimingSamples.length > 5_000) phaseTimingSamples.splice(0, phaseTimingSamples.length - 5_000);
  }

  let lastMcpCapacityRejection: { tool?: string; weight: number; requestId?: string; at: string } | undefined;

  function recordMcpCapacityRejection(toolName: string | undefined, weight: number, requestId?: string): void {
    const toolKey = toolName || "rpc";
    mcpCapacityRejectionsByTool.set(toolKey, (mcpCapacityRejectionsByTool.get(toolKey) ?? 0) + 1);
    mcpCapacityRejectionsByWeight.set(weight, (mcpCapacityRejectionsByWeight.get(weight) ?? 0) + 1);
    lastMcpCapacityRejection = { tool: toolName, weight, requestId, at: new Date().toISOString() };
  }

  function mapNumberCounts<TKey extends string | number>(values: Map<TKey, number>): Record<string, number> {
    return Object.fromEntries([...values.entries()].map(([key, count]) => [String(key), count]));
  }

  function mcpSseDiagnostics(): { active: number; byClient: Record<string, number> } {
    const byClient = new Map<string, number>();
    let active = 0;
    for (const state of mcpSessions.values()) {
      if (state.activeSseStreams <= 0) continue;
      active += state.activeSseStreams;
      byClient.set(state.logicalClientId, (byClient.get(state.logicalClientId) ?? 0) + state.activeSseStreams);
    }
    return { active, byClient: mapNumberCounts(byClient) };
  }

  function cancelMcpPolicyWaitersForSession(sessionId: string, _reason: string, requestId?: string): number {
    let cancelled = 0;
    for (const waiter of mcpPolicyWaiters.values()) {
      if (waiter.mcpSessionId !== sessionId) continue;
      if (requestId && waiter.mcpRequestId !== requestId) continue;
      if (waiter.signal.aborted) continue;
      waiter.cancel();
      cancelled++;
    }
    return cancelled;
  }

  function policyWaiterDiagnostics() {
    const byWorkspace = new Map<string, number>();
    const bySession = new Map<string, number>();
    let oldestStartedAt = Number.POSITIVE_INFINITY;
    for (const waiter of mcpPolicyWaiters.values()) {
      byWorkspace.set(waiter.workspaceId, (byWorkspace.get(waiter.workspaceId) ?? 0) + 1);
      const sessionKey = waiter.mcpSessionId ?? "none";
      bySession.set(sessionKey, (bySession.get(sessionKey) ?? 0) + 1);
      oldestStartedAt = Math.min(oldestStartedAt, waiter.startedAt);
    }
    const pendingPolicyApprovals = approvalRequests.listPending().filter((request) => request.kind === "tool");
    const liveApprovalIds = new Set([...mcpPolicyWaiters.values()].map((waiter) => waiter.approvalId));
    const nowIso = new Date().toISOString();
    // Zero live waiters is the NORMAL shape of a direct MCP approval: the call
    // already returned approval_required and only a human decision is pending.
    // Count a row as orphaned only when its own lifecycle window says so —
    // a work-session approval lost its parked waiter, or a direct operation's
    // reattachment grace has actually elapsed.
    const pendingHumanApproval = pendingPolicyApprovals.filter((approval) => approval.origin === "work_session"
      ? liveApprovalIds.has(approval.approvalId)
      : !(approval.reattachDeadline && approval.reattachDeadline <= nowIso)).length;
    return {
      activePolicyWaiters: mcpPolicyWaiters.size,
      policyWaitersByWorkspace: mapNumberCounts(byWorkspace),
      policyWaitersByMcpSession: mapNumberCounts(bySession),
      oldestPolicyWaitMs: Number.isFinite(oldestStartedAt) ? Math.max(0, Date.now() - oldestStartedAt) : 0,
      pendingApprovalRows: pendingPolicyApprovals.length,
      pendingHumanApproval,
      detachedLiveWaiters: pendingPolicyApprovals.filter((approval) => approval.origin === "work_session"
        && !liveApprovalIds.has(approval.approvalId)).length,
      abandonedOperations: pendingPolicyApprovals.filter((approval) => approval.origin !== "work_session"
        && Boolean(approval.reattachDeadline && approval.reattachDeadline <= nowIso)).length,
      orphanedPendingApprovals: pendingPolicyApprovals.filter((approval) => approval.origin === "work_session"
        ? !liveApprovalIds.has(approval.approvalId)
        : Boolean(approval.reattachDeadline && approval.reattachDeadline <= nowIso)).length,
      suspendedExecutionRequests: mcpPolicyWaiters.size,
      policyWaiterDisconnects,
      policyWaiterResumes,
      lastPolicyWaiterDisconnectAt: lastPolicyWaiterDisconnectAt ? new Date(lastPolicyWaiterDisconnectAt).toISOString() : undefined,
      lastPolicyWaiterResumeAt: lastPolicyWaiterResumeAt ? new Date(lastPolicyWaiterResumeAt).toISOString() : undefined,
    };
  }

  function serveWorkspaceAppResource(
    res: Response,
    requestId: string | undefined,
    body: { id?: unknown; params?: { uri?: unknown } },
    sessionless: boolean,
  ): boolean {
    const resourceStartedAt = performance.now();
    const uri = typeof body.params?.uri === "string" ? body.params.uri : undefined;
    const kind = workspaceAppResourceKind(uri);
    if (!kind) return false;

    if (kind === "current") workspaceAppResourceMetrics.currentHashed++;
    else if (kind === "openai") workspaceAppResourceMetrics.openAiCompatibility++;
    else if (kind === "legacy") workspaceAppResourceMetrics.legacyKontrol++;
    else if (kind === "devdesktop") workspaceAppResourceMetrics.devDesktopMigration++;

    const isCurrent = kind === "current";
    const content: { uri: string; mimeType: string; text: string; _meta?: Record<string, unknown> } = {
      uri: uri ?? WORKSPACE_APP_URI,
      mimeType: isCurrent ? RESOURCE_MIME_TYPE : "text/html+skybridge",
      text: WORKSPACE_APP_HTML,
      ...(isCurrent ? { _meta: workspaceAppResourceMeta() } : {}),
    };
    res.json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: { contents: [content] },
    });

    const totalMs = Math.round(performance.now() - resourceStartedAt);
    workspaceAppResourceMetrics.servedTotal++;
    workspaceAppResourceMetrics.lastDurationMs = totalMs;
    if (totalMs > workspaceAppResourceMetrics.maxDurationMs) workspaceAppResourceMetrics.maxDurationMs = totalMs;
    logEvent(config.logging, "info", "workspace_app_resource_served", {
      requestId,
      sessionless,
      resourceFastPath: true,
      resourceUri: uri,
      totalMs,
    });
    return true;
  }

  function timingQuantiles(samples: number[]): { count: number; p50: number; p95: number; p99: number } {
    if (samples.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0 };
    const ordered = [...samples].sort((a, b) => a - b);
    const percentile = (fraction: number) => ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))];
    return {
      count: ordered.length,
      p50: Math.round(percentile(0.5)),
      p95: Math.round(percentile(0.95)),
      p99: Math.round(percentile(0.99)),
    };
  }

  function mcpTimingDiagnostics(): Record<string, unknown> {
    const recent = mcpTimingSamples.filter((sample) => sample.at >= Date.now() - 15 * 60_000);
    const initialization = recent.filter((sample) => sample.serverCreateMs > 0);
    const requests = recent.filter((sample) => sample.serverCreateMs === 0);
    const by = (field: keyof Pick<McpTimingSample, "admissionWaitMs" | "serverCreateMs" | "transportConnectMs" | "handlerMs" | "totalMs">) =>
      timingQuantiles(requests.map((sample) => sample[field]));
    const initBy = (field: "serverCreateMs" | "transportConnectMs" | "totalMs") =>
      timingQuantiles(initialization.map((sample) => sample[field]));
    const phaseCutoff = Date.now() - 15 * 60_000;
    const phaseGroups = new Map<string, number[]>();
    for (const sample of phaseTimingSamples) {
      if (sample.at < phaseCutoff) continue;
      const values = phaseGroups.get(sample.phase) ?? [];
      values.push(sample.durationMs);
      phaseGroups.set(sample.phase, values);
    }
    const phaseTimings = Object.fromEntries(
      [...phaseGroups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([phase, values]) => [phase, timingQuantiles(values)]),
    );
    const waiterStats = mcpWaiterAdmission.getStats();
    return {
      windowMs: 15 * 60_000,
      requests: requests.length,
      totalMs: by("totalMs"),
      admissionWaitMs: by("admissionWaitMs"),
      initialization: {
        count: initialization.length,
        serverCreateMs: initBy("serverCreateMs"),
        transportConnectMs: initBy("transportConnectMs"),
        totalMs: initBy("totalMs"),
      },
      handlerMs: by("handlerMs"),
      waiterRequests: requests.filter((sample) => sample.admissionClass === "waiter").length,
      executionRequests: requests.filter((sample) => sample.admissionClass === "execution").length,
      streamRequests: requests.filter((sample) => sample.admissionClass === "stream").length,
      eventWaiterCount: waiterStats.active,
      waiterDurationMs: timingQuantiles(recent.filter((sample) => sample.admissionClass === "waiter").map((sample) => sample.totalMs)),
      streamDurationMs: timingQuantiles(recent.filter((sample) => sample.admissionClass === "stream").map((sample) => sample.totalMs)),
      phaseTimings,
    };
  }

  function clientMcpMetrics(logicalClientId: string): McpSessionClientMetrics {
    let metrics = mcpSessionMetrics.clients.get(logicalClientId);
    if (!metrics) {
      metrics = {
        sessionsCreated: 0,
        currentSessions: 0,
        sessionsClosed: 0,
        sessionsExpired: 0,
        zeroToolSessions: 0,
        singleToolSessions: 0,
        multiToolSessions: 0,
        totalToolCalls: 0,
        totalLifetimeMs: 0,
        oldestIdleMs: 0,
      };
      mcpSessionMetrics.clients.set(logicalClientId, metrics);
    }
    return metrics;
  }

  function recordMcpWindowEvent(kind: McpSessionWindowKind, at = Date.now()): void {
    mcpSessionMetrics.windowEvents.push({ at, kind });
    const cutoff = at - 15 * 60_000;
    while (mcpSessionMetrics.windowEvents.length > 0 && mcpSessionMetrics.windowEvents[0].at < cutoff) {
      mcpSessionMetrics.windowEvents.shift();
    }
  }

  function sessionWindowMetrics(windowMs: number, now = Date.now()) {
    const cutoff = now - windowMs;
    const events = mcpSessionMetrics.windowEvents.filter((event) => event.at >= cutoff);
    const sessionsCreated = events.filter((event) => event.kind === "created").length;
    const toolCalls = events.filter((event) => event.kind === "tool").length;
    return {
      sessionsCreated,
      sessionsClosed: events.filter((event) => event.kind === "closed").length,
      sessionsExpired: events.filter((event) => event.kind === "expired").length,
      toolCalls,
      sessionsPerToolCall: sessionsCreated / Math.max(toolCalls, 1),
    };
  }

  function recordMcpSessionEnd(state: McpSessionState, reason: string, now = Date.now()): void {
    if (state.endRecorded) return;
    state.endRecorded = true;
    state.closed = true;
    const metrics = clientMcpMetrics(state.logicalClientId);
    metrics.currentSessions = Math.max(0, metrics.currentSessions - 1);
    metrics.totalLifetimeMs += Math.max(0, now - state.createdAt);
    metrics.totalToolCalls += state.toolCallCount;
    metrics.oldestIdleMs = 0;
    if (state.toolCallCount === 0) metrics.zeroToolSessions++;
    else if (state.toolCallCount === 1) metrics.singleToolSessions++;
    else metrics.multiToolSessions++;
    mcpSessionMetrics.completedToolCounts.push(state.toolCallCount);
    if (mcpSessionMetrics.completedToolCounts.length > 10_000) mcpSessionMetrics.completedToolCounts.shift();
    if (reason === "expired") {
      mcpSessionMetrics.expired++;
      metrics.sessionsExpired++;
      recordMcpWindowEvent("expired", now);
    } else {
      mcpSessionMetrics.closed++;
      metrics.sessionsClosed++;
      recordMcpWindowEvent("closed", now);
    }
  }

  function recordMcpSessionCreated(logicalClientId: string, at = Date.now()): void {
    const metrics = clientMcpMetrics(logicalClientId);
    metrics.sessionsCreated++;
    metrics.currentSessions++;
    mcpSessionMetrics.created++;
    recordMcpWindowEvent("created", at);
  }

  function completedToolPercentile(percentile: number): number {
    if (mcpSessionMetrics.completedToolCounts.length === 0) return 0;
    const sorted = [...mcpSessionMetrics.completedToolCounts].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)] ?? 0;
  }

  function mcpSessionReuseMetrics() {
    const now = Date.now();
    const completed = mcpSessionMetrics.closed + mcpSessionMetrics.expired;
    const perClient = [...mcpSessionMetrics.clients.entries()].map(([client, metrics]) => {
      let currentZeroToolSessions = 0;
      let currentSingleToolSessions = 0;
      let currentMultiToolSessions = 0;
      let oldestIdleMs = 0;
      for (const state of mcpSessions.values()) {
        if (state.logicalClientId !== client) continue;
        if (state.toolCallCount === 0) currentZeroToolSessions++;
        else if (state.toolCallCount === 1) currentSingleToolSessions++;
        else currentMultiToolSessions++;
        oldestIdleMs = Math.max(oldestIdleMs, now - state.lastApplicationActivityAt);
      }
      return {
        client,
        sessionsCreated: metrics.sessionsCreated,
        currentSessions: metrics.currentSessions,
        sessionsClosed: metrics.sessionsClosed,
        sessionsExpired: metrics.sessionsExpired,
        singleToolSessions: metrics.singleToolSessions,
        multiToolSessions: metrics.multiToolSessions,
        unusedSessions: metrics.zeroToolSessions,
        currentZeroToolSessions,
        currentSingleToolSessions,
        currentMultiToolSessions,
        averageToolCallsPerSession: metrics.sessionsCreated > 0 ? metrics.totalToolCalls / metrics.sessionsCreated : 0,
        averageLifetimeMs: completed > 0 ? metrics.totalLifetimeMs / completed : 0,
        oldestIdleMs,
      };
    });
    const clientTotals = [...mcpSessionMetrics.clients.values()].reduce((totals, metrics) => ({
      zeroToolSessions: totals.zeroToolSessions + metrics.zeroToolSessions,
      singleToolSessions: totals.singleToolSessions + metrics.singleToolSessions,
      multiToolSessions: totals.multiToolSessions + metrics.multiToolSessions,
    }), { zeroToolSessions: 0, singleToolSessions: 0, multiToolSessions: 0 });
    return {
      sessionsCreated: mcpSessionMetrics.created,
      sessionsClosed: mcpSessionMetrics.closed,
      sessionsExpired: mcpSessionMetrics.expired,
      zeroToolSessions: clientTotals.zeroToolSessions,
      singleToolSessions: clientTotals.singleToolSessions,
      multiToolSessions: clientTotals.multiToolSessions,
      toolCallsPerSessionMean: completed > 0 ? mcpSessionMetrics.completedToolCounts.reduce((sum, count) => sum + count, 0) / completed : 0,
      toolCallsPerSessionP50: completedToolPercentile(0.5),
      toolCallsPerSessionP95: completedToolPercentile(0.95),
      windows: {
        last1m: sessionWindowMetrics(60_000, now),
        last5m: sessionWindowMetrics(5 * 60_000, now),
        last15m: sessionWindowMetrics(15 * 60_000, now),
      },
      perClient,
    };
  }

  // P1 #33: Memory pressure tracking for adaptive caps
  const mcpSessionBaseRss = process.memoryUsage().rss;
  let mcpSessionPeakRss = mcpSessionBaseRss;
  let mcpSessionCountAtPeak = 0;
  let mcpSessionBytesPerSessionEstimate = 5_700_000;

  function estimateMcpSessionMemoryCost() {
    return {
      bytesPerSession: mcpSessionBytesPerSessionEstimate,
      peakRss: mcpSessionPeakRss,
      peakCount: mcpSessionCountAtPeak,
    };
  }

  function trackMcpSessionMemory() {
    const current = process.memoryUsage();
    if (mcpSessions.size > mcpSessionCountAtPeak) {
      mcpSessionPeakRss = current.rss;
      mcpSessionCountAtPeak = mcpSessions.size;
      const delta = Math.max(0, current.rss - mcpSessionBaseRss);
      mcpSessionBytesPerSessionEstimate = Math.max(1_000_000, Math.round(delta / mcpSessions.size));
    }
  }

  function getMemoryPressureState() {
    trackMcpSessionMemory();
    const totalRss = process.memoryUsage().rss;
    // P1 #24: configurable deployment budget instead of a magic 2 GB. Prefer
    // an explicit KONTROL_MCP_MEMORY_BUDGET_BYTES; otherwise use a fraction
    // of the container/host ceiling when cgroup limits expose one.
    const rssLimit = resolveMcpMemoryBudget();
    if (totalRss > rssLimit * 0.8) {
      return { level: "high" as const, effectiveHardCap: Math.min(config.mcpSessionHardCap, 100), effectiveSoftCap: Math.min(config.mcpSessionSoftCap, 75) };
    }
    if (totalRss > rssLimit * 0.5) {
      return { level: "moderate" as const, effectiveHardCap: Math.min(config.mcpSessionHardCap, 150), effectiveSoftCap: Math.min(config.mcpSessionSoftCap, 100) };
    }
    return { level: "low" as const, effectiveHardCap: config.mcpSessionHardCap, effectiveSoftCap: config.mcpSessionSoftCap };
  }

  const mcpSessionHasActiveResponsibility = (state: McpSessionState): boolean => (
    state.inFlightRequests > 0
    || state.activeLongPollCount > 0
    || state.activeSseStreams > 0
    || state.activePolicyWaiters > 0
    || state.closing
    || state.closed
  );

  /**
   * Single cleanup primitive for a terminated MCP transport. Both the normal
   * close callback and the reaper must run the same steps — waiter
   * cancellation, continuity detach, direct process ownership cleanup, metric
   * recording, and map deletion — or a transport whose `sessionId` property is
   * unavailable at close time leaks a session record until its TTL. Callers
   * that hold the transport pass `transport` so it can be closed after the
   * maps are updated.
   */
  const finalizeMcpSession = (
    sessionId: string,
    reason: "client_closed" | "server_shutdown" | "expired",
    options: { transport?: Transport; evictionReason?: string; at?: number } = {},
  ): boolean => {
    const now = options.at ?? Date.now();
    const state = mcpSessions.get(sessionId);
    if (!state) {
      transports.delete(sessionId);
      return false;
    }
    if (reason === "expired" && mcpSessionHasActiveResponsibility(state)) return false;
    state.closing = true;
    transports.delete(sessionId);
    recordMcpSessionEnd(state, reason, now);
    if (state.identitySource !== "client_info_fallback") {
      logicalContinuity.detach(state.logicalClientId, state.sessionId, now);
    }
    cancelMcpPolicyWaitersForSession(sessionId, reason === "expired" ? "session_expired" : "transport_closed");
    mcpSessions.delete(sessionId);
    // Direct ephemeral commands belong to the transport and die with it.
    // Work-session commands belong to the durable work session and survive a
    // transient MCP reconnect/eviction. The close callback may run after the
    // maps are deleted, so ownership cleanup must not depend on it.
    if (!state.durableWorkerSession) {
      void processSessions.terminateByOwner(sessionId).catch((error) => {
        logEvent(config.logging, "warn", "mcp_session_process_cleanup_failed", {
          sessionIdPrefix: sessionIdPrefix(sessionId),
          reason: reason === "expired" ? "session_expired" : "transport_closed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    if (reason === "expired") {
      mcpSessionMetrics.evicted++;
      void options.transport?.close().catch(() => {});
      logEvent(config.logging, "info", "mcp_session_expired", {
        sessionIdPrefix: sessionIdPrefix(sessionId),
        logicalClientId: state.logicalClientId,
        ageMs: now - state.createdAt,
        idleMs: now - state.lastApplicationActivityAt,
        requestCount: state.requestCount,
        notificationCount: state.notificationCount,
        toolCallCount: state.toolCallCount,
        resourceReadCount: state.resourceReadCount,
        lastRpcMethod: state.lastRpcMethod,
        lastToolName: state.lastToolName,
        reason: options.evictionReason ?? "bounded",
        sessionLabel: state.sessionLabel,
        conversationId: state.conversationId,
      });
      return true;
    }
    logEvent(config.logging, "info", "mcp_session_closed", {
      sessionIdPrefix: sessionIdPrefix(sessionId),
      logicalClientId: state.logicalClientId,
      sessionLabel: state.sessionLabel,
      conversationId: state.conversationId,
      ageMs: now - state.createdAt,
      idleMs: now - state.lastApplicationActivityAt,
      requestCount: state.requestCount,
      notificationCount: state.notificationCount,
      toolCallCount: state.toolCallCount,
      resourceReadCount: state.resourceReadCount,
      lastRpcMethod: state.lastRpcMethod,
      lastToolName: state.lastToolName,
      closeReason: reason,
    });
    return true;
  };

  const reapIdleMcpSessions = (forceClientId?: string) => {
    const pressure = getMemoryPressureState();
    const now = Date.now();
    logicalContinuity.sweep(now);
    // Phase 1: evict sessions with active requests (never evict in-flight)
    // Phase 2: evict provisional one-tool sessions after their model-turn
    // grace window. One completed tool is not treated as immediate completion.
    // Phase 3: evict reusable sessions past their normal TTL.
    // Phase 4: if still over soft cap, LRU evict idle sessions
    const toEvict: string[] = [];
    const evictionReasons = new Map<string, string>();
    const queueEviction = (id: string, reason: string) => {
      if (evictionReasons.has(id)) return;
      toEvict.push(id);
      evictionReasons.set(id, reason);
    };
    const clientCounts = new Map<string, number>();

    for (const [id, state] of mcpSessions) {
      const idle = now - state.lastApplicationActivityAt;
      const ttl = mcpSessionIdleTtl(state, config);

      if (mcpSessionHasActiveResponsibility(state)) continue;

      if (idle >= ttl) {
        queueEviction(id, mcpSessionIdleReason(state));
      } else if (state.identitySource !== "client_info_fallback") {
        // Generic clientInfo name/version labels are not a trustworthy client
        // boundary. They participate only in the global LRU/memory bound, not
        // in the per-client lifetime cap.
        clientCounts.set(state.logicalClientId, (clientCounts.get(state.logicalClientId) ?? 0) + 1);
      }
    }

    // Admission at the per-client cap must not become a 503 wall when the
    // client has accumulated idle transports. Reclaim exactly the number of
    // sessions the new connection needs: zero-tool first, then one-tool, then
    // the oldest idle reusable non-worker transports. Active requests, SSE
    // streams, long polls, policy waiters, and worker-bound transports remain
    // protected. Without the multi-tool tier a client that had already filled
    // its quota with healthy reusable sessions could never connect again
    // until the 24h reusable TTL elapsed.
    if (forceClientId) {
      const currentClientCount = [...mcpSessions.values()].filter((state) => state.logicalClientId === forceClientId).length;
      const alreadyQueued = [...evictionReasons.keys()].filter((id) => mcpSessions.get(id)?.logicalClientId === forceClientId).length;
      const needed = Math.max(0, currentClientCount - config.mcpSessionMaxPerClient + 1 - alreadyQueued);
      if (needed > 0) {
        const eligible = [...mcpSessions.values()]
          .filter((state) => (
            state.logicalClientId === forceClientId
            && !state.durableWorkerSession
            && !mcpSessionHasActiveResponsibility(state)
            && !evictionReasons.has(state.sessionId)
          ));
        const byIdle = (a: McpSessionState, b: McpSessionState) => a.lastApplicationActivityAt - b.lastApplicationActivityAt;
        const zeroTool = eligible.filter((state) => state.toolCallCount === 0).sort(byIdle);
        const oneTool = eligible.filter((state) => state.toolCallCount === 1).sort(byIdle);
        const reusable = eligible.filter((state) => state.toolCallCount > 1).sort(byIdle);
        for (const state of [...zeroTool, ...oneTool, ...reusable].slice(0, needed)) {
          queueEviction(state.sessionId, "per_client_limit");
        }
      }
    }

    // Per-client limit: evict oldest idle sessions beyond limit
    for (const [id, state] of mcpSessions) {
      if (toEvict.includes(id)) continue;
      if (state.identitySource === "client_info_fallback") continue;
      if (mcpSessionHasActiveResponsibility(state)) continue;
      const count = clientCounts.get(state.logicalClientId) ?? 0;
      if (count > config.mcpSessionMaxPerClient) {
        queueEviction(id, "per_client_limit");
        clientCounts.set(state.logicalClientId, count - 1);
      }
    }

    // Adaptive soft cap: evict true LRU idle sessions before the hard cap.
    const softExcess = mcpSessions.size - toEvict.length - pressure.effectiveSoftCap;
    if (softExcess > 0) {
      const candidates: Array<{ id: string; lastApplicationActivityAt: number }> = [];
      for (const [id, state] of mcpSessions) {
        if (toEvict.includes(id)) continue;
        if (mcpSessionHasActiveResponsibility(state)) continue;
        candidates.push({ id, lastApplicationActivityAt: state.lastApplicationActivityAt });
      }
      candidates.sort((a, b) => a.lastApplicationActivityAt - b.lastApplicationActivityAt);
      for (let i = 0; i < Math.min(softExcess, candidates.length); i++) {
        queueEviction(candidates[i].id, "soft_cap_lru");
      }
    }

    for (const id of toEvict) {
      const transport = transports.get(id);
      // Recheck inside finalizeMcpSession: no active request/stream/waiter may
      // be reaped on eligibility evidence gathered before this pass.
      finalizeMcpSession(id, "expired", {
        transport,
        evictionReason: evictionReasons.get(id),
        at: now,
      });
    }
  };
  const mcpSessionReaper = setInterval(reapIdleMcpSessions, config.mcpSessionReaperIntervalMs);
  mcpSessionReaper.unref?.();
  const mcpMemorySampler = setInterval(trackMcpSessionMemory, 30_000);
  mcpMemorySampler.unref?.();
  const oauthEnabled = config.authMode === "oauth";
  let oauthProvider: SingleUserOAuthProvider | null = null;
  let bearerAuth:
    | ((req: Request, res: Response, next: (error?: unknown) => void) => void)
    | undefined;
  let resourceServerUrl: URL | undefined;
  if (oauthEnabled) {
    const mcpUrl = new URL("/mcp", config.publicBaseUrl);
    resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
    oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
    bearerAuth = requireBearerAuth({
      verifier: oauthProvider,
      requiredScopes: [config.oauth.scopes[0] ?? "kontrol"],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
    });
  }
  // ONE shared DB handle for every manager + the review workflow service, so the
  // workflow can commit state + event log in a SINGLE transaction (P1 #15).
  const db: DatabaseHandle = openDatabase(config.stateDir);
  const mutationReceipts = createMutationReceiptStore(db);
  const workspaceStore = createWorkspaceStore(db);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager({
    snapshotStoreRoot: join(config.stateDir, "workspace-snapshots"),
  });
  const processSessions = new ProcessSessionManager({
    childEnvironmentAllowlist: config.childEnvironmentAllowlist,
    // P1 #14: operator-tunable resource controls; manager applies defaults
    // for anything unset.
    ...(config.processMaxRunning !== undefined && { maxRunningProcesses: config.processMaxRunning }),
    ...(config.processMaxRunningPerOwner !== undefined && { maxRunningProcessesPerOwner: config.processMaxRunningPerOwner }),
    ...(config.processIdleTimeoutMs !== undefined && { idleTimeoutMs: config.processIdleTimeoutMs }),
    ...(config.processMaxRuntimeMs !== undefined && { maxRuntimeMs: config.processMaxRuntimeMs }),
    ...(config.processMaxBufferCharacters !== undefined && { maxBufferCharacters: config.processMaxBufferCharacters }),
    ...(config.processReaperIntervalMs !== undefined && { reaperIntervalMs: config.processReaperIntervalMs }),
  });
  let revokeWorkSessionGrants: ((workSessionId: string) => void) | undefined;
  const workSessions = createWorkSessionManager(db, { onTerminal: (workSessionId) => revokeWorkSessionGrants?.(workSessionId) });
  const agentRegistry = createAgentRegistryManager(db, { enabled: config.webhookEnabled, allowedHosts: config.webhookAllowedHosts });
  // Seed the well-known topology: the WebUI is the ACP reviewer;
  // the CLI coding agent registers itself as the ACP *agent* at runtime.
  agentRegistry.ensure({
    name: "webui",
    url: "ui://kontrol/workspace-app.html",
    description: "Kontrol review WebUI — the reviewer surface that may explicitly submit bounded work to a coding agent and signs off (Nelson Wiggum Loop).",
    role: "reviewer",
    tags: ["webui", "reviewer"],
    ttlSeconds: 60 * 60 * 24 * 365,
  });
  const eventStore = createEventStore(db, recordPhaseTiming);
  const continuationManager = createContinuationManager(db);
  const dispatchOutbox = createDispatchOutbox(db);
  const supervisorRuns = createSupervisorRuns(db);
  const approvalRequests = createApprovalRequestManager(db, {
    directReattachGraceMs: config.policyDirectApprovalReattachGraceMs,
    directToolApprovalTtlMs: config.policyDirectApprovalTtlMs,
  });
  // P1 #23: Periodic maintenance loop (event compaction, approval expiry,
  // mutation-receipt reconciliation, snapshot GC, pin pruning) lives in
  // runtime/maintenance.ts; createServer wires it with the shared managers.
  const maintenance = createMaintenanceCoordinator({
    config,
    db,
    workSessions,
    approvalRequests,
    eventStore,
    mutationReceipts,
    reviewCheckpoints,
  });
  const maintenanceStats = maintenance.stats;
  const collectFsSnapshotDbRoots = maintenance.collectFsSnapshotDbRoots;
  const missionLedger = createMissionLedger(db);
  const agentMessages = createAgentMessageManager(db);
  const startupRecovery = {
    at: new Date().toISOString(),
    expiredApprovals: 0,
    cancelledApprovals: 0,
    supersededContinuations: 0,
    releasedSupervisorLeases: 0,
    reconciledWorkSessions: 0,
    markedStaleWorkSessions: 0,
  };
  let startupRecoveryStopped = false;
  // DatabaseIntegrityMonitor: out-of-process PRAGMA quick_check diagnostic
  // (P0 refactor). The monitor owns its timer and worker lifecycle; /diagnostics
  // consumes integrity.state and finalizeClose calls integrity.stop().
  const integrity = createDatabaseIntegrityMonitor(config);
  const databaseIntegrity = integrity.state;
  const terminalWorkSessionStatuses = new Set(["approved", "rejected", "cancelled", "failed", "failed_protocol"]);
  // P1: a direct MCP approval is a PENDING HUMAN DECISION, not an orphan. It
  // parks no live waiter, so it consumes no execution resources and stays
  // decidable until its normal approval TTL — expirePending (startup and
  // maintenance) is the only automatic cancellation path. The reattach
  // deadline remains a diagnostic classification (abandoned_operation), never
  // a cancellation trigger.
  // Expire pending approvals once during startup as well as during the normal
  // maintenance loop. This keeps expiry correct across long idle periods and
  // makes the recovery count reflect actual rows changed at startup.
  const expireStartupApprovalPage = (): void => {
    if (startupRecoveryStopped) return;
    const expired = approvalRequests.expirePending(undefined, 100);
    for (const approval of expired) {
      const session = approval.workSessionId ? workSessions.get(approval.workSessionId) : undefined;
      startupRecovery.expiredApprovals++;
      if (session) {
        eventStore.appendEvent({
          type: "recovery.approval.expired",
          sessionId: session.id,
          payload: { approvalId: approval.approvalId, reason: "approval expired during startup reconciliation" },
        }, { publish: false });
      }
    }
    if (expired.length === 100) setImmediate(expireStartupApprovalPage);
  };
  expireStartupApprovalPage();
  // Durable rows survive a process restart; live transports and in-memory
  // worker maps do not. Reconcile only objects whose durable references make
  // their liveness unambiguous, and record each repair in the session event
  // log so recovery is inspectable rather than silently mutating state.
  const reconcileWorkSessionApprovalPage = (before?: { createdAt: string; id: string }): void => {
    if (startupRecoveryStopped) return;
    const page = approvalRequests.listPendingPage(undefined, 100, before, "work_session");
    for (const approval of page.requests) {
      const session = approval.workSessionId ? workSessions.get(approval.workSessionId) : undefined;
      const orphaned = Boolean(approval.workSessionId && (!session || terminalWorkSessionStatuses.has(session.status)));
      if (!orphaned) continue;
      const status = "cancelled" as const;
      approvalRequests.resolve(approval.approvalId, { status, reason: "startup_reconciliation: referenced work session is terminal or missing", reviewerId: "kontrol-startup" });
      startupRecovery.cancelledApprovals++;
      if (session) {
        eventStore.appendEvent({
          type: "recovery.approval.reconciled",
          sessionId: session.id,
          payload: { approvalId: approval.approvalId, status, reason: "startup_reconciliation" },
        }, { publish: false });
      }
    }
    if (page.hasMore) setImmediate(() => reconcileWorkSessionApprovalPage(page.nextBefore));
  };
  reconcileWorkSessionApprovalPage();
  // Recovery is deliberately paged. The old unrestricted join could block
  // startup on a pathological continuation history, while only repairing the
  // first page would leave terminal references behind forever. Reconcile one
  // bounded page synchronously, then yield the remainder after the server can
  // serve requests.
  const reconcileContinuationPage = (afterId?: string): void => {
    if (startupRecoveryStopped) return;
    const continuationRows = db.sqlite.prepare(`
      select c.id, c.session_id as sessionId, c.status, ws.status as workSessionStatus
      from continuations c
      left join work_sessions ws on ws.id = c.session_id
      where c.status in ('pending', 'claimed')
        and (? is null or c.id > ?)
      order by c.id
      limit ?
    `).all(afterId ?? null, afterId ?? null, 100) as Array<{ id: string; sessionId: string; status: string; workSessionStatus?: string | null }>;
    for (const continuation of continuationRows) {
      if (continuation.workSessionStatus && !terminalWorkSessionStatuses.has(continuation.workSessionStatus)) continue;
      if (!continuationManager.supersede(continuation.id, "startup_reconciliation: referenced work session is terminal or missing")) continue;
      startupRecovery.supersededContinuations++;
      if (continuation.workSessionStatus) {
        eventStore.appendEvent({
          type: "recovery.continuation.superseded",
          sessionId: continuation.sessionId,
          payload: { continuationId: continuation.id, reason: "startup_reconciliation" },
        }, { publish: false });
      }
    }
    if (continuationRows.length === 100) {
      const nextAfterId = continuationRows[continuationRows.length - 1]?.id;
      if (nextAfterId) setImmediate(() => reconcileContinuationPage(nextAfterId));
    }
  };
  reconcileContinuationPage();
  // Runtime reconciliation is also paged during startup. Keep the first page
  // bounded, then yield between every subsequent page instead of deferring an
  // arbitrarily large remainder to the next five-minute maintenance tick.
  const reconcileRuntimeStatePage = (afterId?: string): void => {
    if (startupRecoveryStopped) return;
    const page = workSessions.reconcileRuntimeStates(afterId, 100);
    maintenance.resumeRuntimeReconciliationFrom(page.hasMore ? page.nextAfterId : undefined);
    startupRecovery.reconciledWorkSessions += page.reconciled;
    startupRecovery.markedStaleWorkSessions += page.markedStale;
    if (page.hasMore && page.nextAfterId) {
      setImmediate(() => reconcileRuntimeStatePage(page.nextAfterId));
    }
  };
  reconcileRuntimeStatePage();
  startupRecovery.releasedSupervisorLeases = supervisorRuns.releaseExpiredClaims();
  const reviewWorkflow = createReviewWorkflowService({
    workSessions,
    eventStore,
    continuationManager,
    agentRegistry,
    db,
    workspaces,
    reviewCheckpoints,
    missionLedger,
    dispatchOutbox,
  });
  // Shared live-waiter registry: the singleton dispatcher and every MCP client
  // consult the SAME instance, so a parked agent suppresses duplicate dispatch
  // regardless of which client connection owns the worker.
  const liveWaitersMap = new Map<string, Set<string>>();
  const liveWaiters: LiveWaiterRegistry = {
    add(id: string) {
      const waiterId = `waiter_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const set = liveWaitersMap.get(id) ?? new Set<string>();
      set.add(waiterId);
      liveWaitersMap.set(id, set);
      return waiterId;
    },
    remove(id: string, waiterId?: string) {
      const set = liveWaitersMap.get(id);
      if (!set) return false;
      if (waiterId) set.delete(waiterId);
      else set.clear();
      const empty = set.size === 0;
      if (empty) liveWaitersMap.delete(id);
      return empty;
    },
    has(id: string) { return (liveWaitersMap.get(id)?.size ?? 0) > 0; },
  };
  const grantStore = createSqliteGrantStore(db);
  const policyEngine = createPolicyEngine(config.policy, grantStore, approvalRequests, {
    directReattachGraceMs: config.policyDirectApprovalReattachGraceMs,
  });
  revokeWorkSessionGrants = (workSessionId) => policyEngine.revokeScope("work_session", workSessionId);
  // Reconcile grants created by an older process that terminated before its
  // lifecycle callback ran. Workspace grants intentionally survive restart;
  // work-session grants never survive the terminal boundary. Select only IDs
  // and page the history so startup does not hydrate a bounded projection and
  // silently miss older terminal sessions.
  const reconcileTerminalGrantPage = (afterId?: string): void => {
    if (startupRecoveryStopped) return;
    const terminalIds = db.sqlite.prepare(`
      select id
      from work_sessions
      where status in ('approved', 'rejected', 'cancelled', 'failed', 'failed_protocol')
        and (? is null or id > ?)
      order by id
      limit ?
    `).all(afterId ?? null, afterId ?? null, 100) as Array<{ id: string }>;
    for (const session of terminalIds) policyEngine.revokeScope("work_session", session.id);
    if (terminalIds.length === 100) {
      const nextAfterId = terminalIds[terminalIds.length - 1]?.id;
      if (nextAfterId) setImmediate(() => reconcileTerminalGrantPage(nextAfterId));
    }
  };
  reconcileTerminalGrantPage();
  const policyEnforcer = createPolicyEnforcer(policyEngine, eventStore, {
    timeoutMs: config.policyApprovalTimeoutMs,
    directApprovalTtlMs: config.policyDirectApprovalTtlMs,
  });

  // P1 #7: pass the parsed trusted-proxy spec straight to Express. A hop
  // count ("1") or "loopback" scopes forwarded-header trust precisely;
  // undefined leaves Express's default (no proxy trusted).
  if (config.logging.trustProxy) {
    app.set(
      "trust proxy",
      config.logging.trustProxy === "true" ? true : config.logging.trustProxy,
    );
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        rpcMethod: typeof req.body?.method === "string" ? req.body.method : undefined,
        resourceUri: req.body?.method === "resources/read" && typeof req.body?.params?.uri === "string"
          ? req.body.params.uri
          : undefined,
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  if (oauthProvider) {
    app.use(
      mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: new URL(config.publicBaseUrl),
        baseUrl: new URL(config.publicBaseUrl),
        resourceServerUrl,
        scopesSupported: config.oauth.scopes,
        resourceName: "Kontrol",
      }),
    );
  } else if (config.authMode === "tunnel") {
    // Tunnel mode has no OAuth gate on /mcp, but the OpenAI tunnel-client
    // probes these discovery paths during readiness. Serve static metadata so
    // discovery succeeds and the tunnel reports ready; we do NOT actually
    // authenticate on /mcp (access is the loopback + tunnel boundary).
    const mcpResource = new URL("/mcp", config.publicBaseUrl).href;
    const metadata = {
      resource: mcpResource,
      authorization_servers: [],
      bearer_methods_supported: ["header"],
      scopes_supported: config.oauth.scopes,
      resource_documentation: "https://github.com/B-A-M-N/Kontrol",
    };
    const discovery = (_req: Request, res: Response) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.json(metadata);
    };
    app.get("/.well-known/oauth-protected-resource", discovery);
    app.get("/.well-known/oauth-protected-resource/mcp", discovery);
    app.get("/.well-known/oauth-authorization-server", (_req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(404).json({ error: { code: "not_found", message: "OAuth disabled in tunnel mode" } });
    });
  }

  // Authenticate protected requests before consuming their bodies, then parse
  // each protocol with its own explicit finite limit. This keeps a large
  // unauthenticated request from spending parser memory and avoids the SDK's
  // unconditional ~100 KB parser.
  if (bearerAuth) {
    app.use("/mcp", (req, res, next) => bearerAuth!(req, res, next));
  }
  if (config.acpEnabled) {
    app.use(
      "/acp",
      authenticatedAcpBodyGate(config),
      rejectOversizedBody(ACP_HTTP_BODY_LIMIT_BYTES, "acp"),
      express.json({ limit: ACP_HTTP_BODY_LIMIT_BYTES }),
    );
  }
  app.use(
    "/mcp",
    rejectOversizedBody(MCP_HTTP_BODY_LIMIT_BYTES, "mcp"),
    express.json({ limit: MCP_HTTP_BODY_LIMIT_BYTES }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    // Keep unauthenticated liveness deliberately minimal. Build/runtime
    // identity, process details, session counts, and workflow diagnostics
    // belong behind readiness/diagnostics controls.
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      name: "kontrol",
    });
  });

  function readinessChecks(req: Request, includeAgents: boolean): Record<string, { ok: boolean; detail?: string; agents?: unknown[] }> {
    const checks: Record<string, { ok: boolean; detail?: string; agents?: unknown[] }> = {};
    const runtime = readRuntimeIdentity(config.stateDir);
    let schemaVersion = 0;
    try {
      const databaseProbe = db.sqlite.prepare("select 1 as ok").get() as { ok?: number } | undefined;
      checks.database = { ok: databaseProbe?.ok === 1, detail: databaseProbe?.ok === 1 ? "select 1 ok" : "database probe failed" };
      const schema = db.sqlite.prepare("select max(version) as v from kontrol_schema_migrations").get() as { v?: number } | undefined;
      schemaVersion = Number(schema?.v ?? 0);
      // P1 #17: readiness requires the EXACT current schema, not just a
      // migrated-at-some-point database. A partial/older schema must fail.
      checks.schema = {
        ok: schemaVersion === LATEST_SCHEMA_VERSION,
        detail: `version=${schemaVersion} expected=${LATEST_SCHEMA_VERSION}`,
      };
    } catch (error) {
      checks.database = { ok: false, detail: error instanceof Error ? error.message : String(error) };
      checks.schema = { ok: false, detail: "schema query failed" };
    }
    // Full integrity scans are intentionally absent from readiness. They run
    // in a separate worker and are exposed through authenticated diagnostics;
    // a stale/slow diagnostic must not make a serving core fail closed.
    checks.mcpHandler = { ok: true, detail: `HTTP handler is serving ${includeAgents ? "/readyz" : "/core-readyz"}` };
    const executionAdmission = mcpAdmission.getStats();
    checks.mcpExecutionAdmission = {
      // Busy execution is healthy and must not make readiness flap. This
      // check only detects an impossible accounting state that would strand
      // capacity (negative counters or weight beyond the configured budget).
      ok: executionAdmission.active >= 0
        && executionAdmission.activeWeight >= 0
        && executionAdmission.activeWeight <= executionAdmission.maxInflight,
      detail: `active=${executionAdmission.active}; activeWeight=${executionAdmission.activeWeight}; availableWeight=${executionAdmission.availableWeight}; queued=${executionAdmission.queued}`,
    };
    checks.workspaceRegistry = { ok: Boolean(workspaces && workspaceStore), detail: "workspace registry initialized" };
    checks.reviewSubsystem = { ok: Boolean(reviewWorkflow && workSessions && eventStore), detail: "review managers initialized" };
    checks.acpBridge = { ok: !config.acpEnabled || Boolean(dispatcher), detail: config.acpEnabled ? "dispatcher initialized" : "ACP disabled" };
    // Configuration-level proof that ask-capable policies have a reviewer
    // credential source. loadConfig already rejects tunnel+ask-without-secret,
    // so this can only fail for non-tunnel modes whose credential wiring is
    // broken at runtime; report it as a first-class readiness check either way
    // so an operator sees the approval boundary's posture without reading
    // startup logs.
    const askCapable = policyCanAsk(config.policy);
    checks.approvalReviewerConfig = {
      ok: !askCapable || config.authMode !== "tunnel" || Boolean(config.tunnelReviewerSecret),
      detail: askCapable
        ? `policy can produce approvals; reviewer credential configured (authMode=${config.authMode})`
        : "policy cannot produce approvals; reviewer credential not required",
    };
    checks.build = {
      // Source-mode `tsx src/cli.ts serve` has no embedded build-meta.json;
      // its explicit `dev` identity is still valid. Release artifacts must
      // continue to match their immutable embedded build ID exactly.
      ok: Boolean(runtime) && (!buildMeta.buildId
        ? runtime?.buildId === "dev"
        : runtime?.buildId === buildMeta.buildId),
      detail: `expected=${buildMeta.buildId ?? "missing"} live=${runtime?.buildId ?? "missing"}`,
    };

    if (!includeAgents) {
      checks.agents = { ok: true, detail: "agent checks deferred to strict /readyz" };
      return checks;
    }

    // P1 #16: public readiness is deterministic from server configuration
    // alone. Query-string agent selection was removed — arbitrary "check
    // these agents" requests could replace the configured requirement set.
    // Diagnostics/doctor tooling covers ad-hoc agent checks instead.
    const configuredAgents = config.acpKnownAgents;
    const aliveAgents = agentRegistry.listAlive();
    // P1 #12 review note: an empty configured list with zero registered
    // workers is a legitimate deployment posture ("no ACP workers wanted"),
    // not a readiness failure. Strict /readyz only fails when the operator
    // has *configured* required agents that are absent/unhealthy.
    const agentResults = configuredAgents.map((required) => {
      const found = aliveAgents.find((agent) => agent.name === required.name);
      const urlMatches = !required.url || found?.url === required.url;
      return {
        name: required.name,
        expectedUrl: required.url,
        registeredUrl: found?.url,
        alive: Boolean(found?.alive),
        healthy: Boolean(found?.alive) && urlMatches,
      };
    });
    checks.agents = {
      ok: agentResults.every((agent) => agent.healthy),
      detail: configuredAgents.length > 0
        ? "required agents checked"
        : "no agents configured; deployments without ACP workers are ready",
      agents: agentResults,
    };
    return checks;
  }

  function sendReadiness(res: Response, checks: Record<string, { ok: boolean; detail?: string; agents?: unknown[] }>): void {
    const ready = Object.values(checks).every((check) => check.ok);
    const publicChecks = Object.fromEntries(Object.entries(checks).map(([name, check]) => [name, { ok: check.ok }]));
    res.setHeader("Cache-Control", "no-store");
    res.status(ready ? 200 : 503).json({
      ok: ready,
      ready,
      name: "kontrol",
      // Non-sensitive policy posture so probes can decide whether the
      // reviewer path is part of the readiness contract without guessing
      // from environment variables.
      approvalInteractive: policyCanAsk(config.policy),
      checks: publicChecks,
    });
  }

  // Core readiness is used while KONTROL is starting before adapters register.
  app.get("/core-readyz", (_req, res) => sendReadiness(res, readinessChecks(_req, false)));
  // Strict readiness is the operational contract used by the tunnel and the
  // persistent supervisor. It must fail when a required worker disappears.
  app.get("/readyz", (req, res) => sendReadiness(res, readinessChecks(req, true)));

  // P2: Warn about low reuse using a rolling rate, not only a raw creation
  // count. A client creating one session per tool call is operationally
  // different from a healthy reusable session that happens to be busy.
  let dbSizeBytes = 0;
  const mcpSessionChurnTimer = setInterval(() => {
    const window = sessionWindowMetrics(60_000);
    if (window.sessionsCreated > 10 || (window.toolCalls > 0 && window.sessionsPerToolCall >= 0.75)) {
      logEvent(config.logging, "warn", "mcp_session_reuse_low", {
        ...window,
        logicalClients: mcpSessionMetrics.clients.size,
      });
    }
  }, 60_000);
  mcpSessionChurnTimer.unref?.();

  // P1 #23 / P1 #50: Protect /diagnostics — loopback-only AND require an
  // explicit admin credential. Disabled diagnostics are not an accidental
  // unauthenticated information endpoint.
  // P0 #2: Snapshot store telemetry for /diagnostics. This bug reached 40 GB
  // because there was no signal that the store was expanding; surface counts,
  // bytes and GC progress so a runaway store is visible.
  const snapshotStoreDiagnostics = async (): Promise<Record<string, unknown>> => {
    try {
      const store = reviewCheckpoints.getSnapshotStore();
      const stats = await store.storeStats();
      const movable = Number(stats.blobBytes) || 0;
      const reachable = await store.estimateReachableBytes(collectFsSnapshotDbRoots);
      return {
        blobs: stats.blobs,
        blobBytes: stats.blobBytes,
        manifests: stats.manifests,
        retainedManifests: reachable.manifests,
        reachableBlobs: reachable.blobs,
        reachableBytes: reachable.bytes,
        orphanEstimate: Math.max(0, stats.blobs - reachable.blobs),
        orphanBytesEstimate: Math.max(0, movable - reachable.bytes),
        stagingBytes: stats.stagingBytes,
        activeCaptures: stats.activeCaptures,
        lastGcStartedAt: stats.lastGcStartedAt,
        lastGcCompletedAt: stats.lastGcCompletedAt,
        lastGcReclaimedBlobs: stats.lastGcReclaimedBlobs,
        lastGcReclaimedBytes: stats.lastGcReclaimedBytes,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };

  app.get("/diagnostics", async (req, res) => {
    const ip = requestIp(req, config.logging.trustProxy) || "";
    if (ip && !ip.startsWith("127.") && !ip.startsWith("::1") && ip !== "::ffff:127.0.0.1") {
      return res.status(403).json({ ok: false, error: "Forbidden: diagnostics is loopback-only" });
    }
    if (!config.diagnosticsSecret) {
      return res.status(404).json({ ok: false, error: "Diagnostics disabled" });
    }
    // Credentials are header-only. Query-string secrets leak through browser
    // history, proxy logs, and referrer metadata.
    const provided = req.header("x-kontrol-diagnostics") || "";
    const expected = config.diagnosticsSecret;
    const a = Buffer.from(String(provided));
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(403).json({ ok: false, error: "Forbidden: valid X-Kontrol-Diagnostics credential required" });
    }
    try {
      const sqlite = (db as unknown as { sqlite?: { prepare?: (sql: string) => { get?: () => unknown } } }).sqlite;
      let dbSizeBytes = 0;
      let walSizeBytes = 0;
      let eventLogCount = 0;
      let outputDeltaCount = 0;
      let thoughtDeltaCount = 0;
      let schemaVersion = 1;
      if (sqlite && sqlite.prepare) {
        try {
          // P1 #47: Use filesystem stat for accurate DB + WAL size
          const dbPath = join(config.stateDir, "kontrol.sqlite");
          try {
            const st = statSync(dbPath);
            dbSizeBytes = st.size;
          } catch { /* ignore */ }
          try {
            const st = statSync(`${dbPath}-wal`);
            walSizeBytes = st.size;
          } catch { /* ignore */ }
        } catch { /* ignore */ }
        try {
          const r = sqlite.prepare("select count(*) as c from event_log").get?.();
          eventLogCount = typeof r === "object" && r !== null && "c" in r ? (r as { c: number }).c : 0;
          const od = sqlite.prepare("select count(*) as c from event_log where type = 'agent.run.output_delta'").get?.();
          outputDeltaCount = typeof od === "object" && od !== null && "c" in od ? (od as { c: number }).c : 0;
          const td = sqlite.prepare("select count(*) as c from event_log where type = 'agent.run.thought_delta'").get?.();
          thoughtDeltaCount = typeof td === "object" && td !== null && "c" in td ? (td as { c: number }).c : 0;
        } catch { /* ignore */ }
        // P1 #48: Query actual schema version
        try {
          const sv = sqlite.prepare("select max(version) as v from kontrol_schema_migrations").get?.();
          schemaVersion = typeof sv === "object" && sv !== null && "v" in sv ? (sv as { v: number }).v : 1;
        } catch { schemaVersion = 1; }
      }

      // P1 #49: Use cheap count APIs instead of expensive hydration
      const activeWorkSessions = workSessions.countActiveWorkSessions();
      const pendingReviews = workSessions.countPendingReviews();
      const activeAcps = agentRegistry?.listAlive?.()?.length ?? 0;
      const totalMcpSessions = mcpSessions?.size ?? 0;
      const executionAdmission = mcpAdmission.getStats();
      const waiterAdmission = mcpWaiterAdmission.getStats();
      const sse = mcpSseDiagnostics();

      // P0 #2: Comprehensive session/heap metrics
      const memUsage = process.memoryUsage();
      const supervisorStatus = (() => {
        try {
          return JSON.parse(readFileSync(join(config.stateDir, "supervisor-status.json"), "utf8")) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })();
      const generationRecord = (() => {
        try {
          return JSON.parse(readFileSync(join(config.stateDir, "generation.json"), "utf8")) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })();
      const mcpMetrics = {
        created: mcpSessionMetrics.created,
        evicted: mcpSessionMetrics.evicted,
        current: totalMcpSessions,
        inFlight: [...mcpSessions.values()].reduce((sum, s) => sum + s.inFlightRequests, 0),
        activeLongPolls: [...mcpSessions.values()].reduce((sum, s) => sum + s.activeLongPollCount, 0),
        activePolicyWaiters: [...mcpSessions.values()].reduce((sum, s) => sum + s.activePolicyWaiters, 0),
        activeSseStreams: sse.active,
        activeSseStreamsByClient: sse.byClient,
        policyWaiters: policyWaiterDiagnostics(),
        admission: {
          execution: executionAdmission,
          waiter: waiterAdmission,
        },
          executionAdmission: {
            ...executionAdmission,
            capacityRejectionsByTool: mapNumberCounts(mcpCapacityRejectionsByTool),
            capacityRejectionsByWeight: mapNumberCounts(mcpCapacityRejectionsByWeight),
            lastRejection: lastMcpCapacityRejection,
        },
        waiterAdmission,
        timing: mcpTimingDiagnostics(),
        toolListDescriptorCache: toolListCacheDiagnostics()[0]?.metrics ?? { hits: 0, misses: 0 },
        workspaceAppResources: { ...workspaceAppResourceMetrics },
        memoryPressure: getMemoryPressureState(),
        memoryEstimate: estimateMcpSessionMemoryCost(),
        reuse: mcpSessionReuseMetrics(),
        policy: {
          unusedSessionIdleMs: config.mcpUnusedSessionIdleMs,
          ephemeralSessionIdleMs: config.mcpEphemeralSessionIdleMs,
          reusableSessionIdleMs: config.mcpReusableSessionIdleMs,
          sessionReaperIntervalMs: config.mcpSessionReaperIntervalMs,
          logicalContinuityRetentionMs: config.mcpLogicalContinuityRetentionMs,
          sessionMaxPerClient: config.mcpSessionMaxPerClient,
          sessionSoftCap: config.mcpSessionSoftCap,
          sessionHardCap: config.mcpSessionHardCap,
        },
        // Each entry is a separate transport/context. The aggregate logical
        // client label is deliberately not used as an ownership key.
        sessions: [...mcpSessions.values()]
          .sort((a, b) => a.lastApplicationActivityAt - b.lastApplicationActivityAt)
          .map((state) => ({
            sessionIdPrefix: sessionIdPrefix(state.sessionId),
            sessionLabel: state.sessionLabel,
            logicalClientId: state.logicalClientId,
            identitySource: state.identitySource,
            authenticatedRole: state.authenticatedRole,
            authSource: state.authSource,
            conversationId: state.conversationId,
            createdAt: new Date(state.createdAt).toISOString(),
            lastTransportActivityAt: new Date(state.lastTransportActivityAt).toISOString(),
            lastApplicationActivityAt: new Date(state.lastApplicationActivityAt).toISOString(),
            ageMs: Date.now() - state.createdAt,
            idleMs: Date.now() - state.lastApplicationActivityAt,
            transportIdleMs: Date.now() - state.lastTransportActivityAt,
            requestCount: state.requestCount,
            notificationCount: state.notificationCount,
            toolCallCount: state.toolCallCount,
            resourceReadCount: state.resourceReadCount,
            activeLongPollCount: state.activeLongPollCount,
            activeSseStreams: state.activeSseStreams,
            activePolicyWaiters: state.activePolicyWaiters,
            inFlightRequests: state.inFlightRequests,
            durableWorkerSession: state.durableWorkerSession,
            lastRpcMethod: state.lastRpcMethod,
            lastToolName: state.lastToolName,
          })),
        perClient: Object.entries([...mcpSessions.values()].reduce((acc, s) => {
          acc[s.logicalClientId] = (acc[s.logicalClientId] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)).map(([client, count]) => ({ client, count })),
        // P1: approval continuity qualification needs to see whether real
        // connector traffic relies on the untrusted clientInfo fallback, which
        // cannot reattach a one-shot approval retry after a transport
        // replacement. Aggregate per identity source, not per session.
        identitySources: [...mcpSessions.values()].reduce((acc, s) => {
          acc[s.identitySource] = (acc[s.identitySource] ?? 0) + 1;
          return acc;
        }, {} as Record<string, number>),
        logicalContinuity: {
          count: logicalContinuity.size(),
          records: logicalContinuity.snapshot(),
        },
      };

      // P1 #51: Report embedded build metadata (immutable artifact identity)
      // rather than the working tree state.
      let buildMeta: Record<string, unknown> | undefined;
      try {
        const metaPath = join(dirname(fileURLToPath(import.meta.url)), "build-meta.json");
        buildMeta = JSON.parse(readFileSync(metaPath, "utf8"));
      } catch { /* ignore */ }

      res.json({
        ok: true,
        name: "kontrol",
        build: buildMeta ?? process.env.KONTROL_BUILD_ID ?? "dev",
        buildMeta,
        schema: schemaVersion,
        schemaExpected: LATEST_SCHEMA_VERSION,
        degradedAudit: degradedAuditSnapshot(),
        dbSizeBytes,
        walSizeBytes,
        eventLogCount,
        outputDeltaCount,
        thoughtDeltaCount,
        activeWorkSessions,
        pendingReviews,
        activeAcps,
        processSessions: processSessions.getMetrics(),
        totalMcpSessions,
        mcpSessionMetrics: mcpMetrics,
        startupRecovery,
        databaseIntegrity,
        maintenance: { ...maintenanceStats },
        snapshotStore: await snapshotStoreDiagnostics(),
        generation: generationRecord,
        supervisor: supervisorStatus,
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        rss: memUsage.rss,
        external: memUsage.external,
        uptimeMs: Math.round(performance.now()),
        memoryUsage: memUsage,
        pid: process.pid,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  if (config.acpEnabled) {
    app.use("/acp", createAcpServer(
      workspaces,
      workSessions,
      agentRegistry,
      config.acpSharedSecret,
      config.acpAdapterSecret,
      eventStore,
      continuationManager,
      reviewCheckpoints,
      reviewWorkflow,
      policyEnforcer,
      approvalRequests,
      config.acpAgentSecret,
      config.acpReviewerSecret,
      { enabled: config.webhookEnabled, allowedHosts: config.webhookAllowedHosts },
    ));
  }

  app.all("/mcp", async (req, res) => {
    const requestStartedAt = performance.now();
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);
    const requestRpcMethod = (req.body as { method?: string } | undefined)?.method;
    const requestToolName = (req.body as { params?: { name?: string } } | undefined)?.params?.name;
    const requestIsSseStream = req.method === "GET" && Boolean(sessionId);
    const requestIsWaiter = requestRpcMethod === "tools/call" && (
      requestToolName === "await_review_feedback" ||
      requestToolName === "await_work_session_events" ||
      requestToolName === "await_work_session_terminal" ||
      requestToolName === "await_workspace_events"
    );
    let admissionRelease: (() => void) | undefined;
    let sessionRequestClass: "execution" | "waiter" | "stream" | undefined;
    let sessionExecutionCounted = false;
    let policyWaiterId: string | undefined;
    let admissionWaitMs = 0;
    let admissionClass: "execution" | "waiter" | "stream" = requestIsSseStream
      ? "stream"
      : requestIsWaiter
        ? "waiter"
        : "execution";
    let handlerStartedAt = 0;
    let transport: Transport | undefined;
    let sessionState: McpSessionState | undefined;
    let transportCloseRequested = false;
    let sseHeartbeatTimer: NodeJS.Timeout | undefined;
    const requestAbort = new AbortController();
    requestAbort.signal.addEventListener("abort", () => {
      // A socket can close before Node emits the response's `close` event.
      // The abort signal is the common path for both cases, so detach the
      // disposable transport here as soon as an incomplete request is lost.
      if (!res.writableFinished && transport?.sessionId && !transportCloseRequested) {
        transportCloseRequested = true;
        void transport.close().catch(() => undefined);
      }
    }, { once: true });
    const abortIfDisconnected = () => {
      if (!res.writableFinished) requestAbort.abort();
    };
    const removeSocketAbort = req.socket ? trackSocketAbort(req.socket, requestAbort) : undefined;
    let requestListenersCleaned = false;
    const cleanupRequestListeners = () => {
      if (requestListenersCleaned) return;
      requestListenersCleaned = true;
      req.off("aborted", abortIfDisconnected);
      res.off("close", onResponseClose);
      res.off("finish", onResponseFinish);
      removeSocketAbort?.();
    };
    // P0.2: catch BOTH the request-level abort (req.once aborted) AND the
    // underlying socket close. The latter fires earlier when a tunnel proxy
    // silently drops the connection without sending a final response, which
    // is the precise scenario the live audit surfaced. Cancelling on socket
    // close alone is safe because the requestAbort signal is observed by
    // every downstream caller (admission queue, policy enforcer, event-log
    // waiters) and they all no-op on a duplicated abort.
    req.once("aborted", abortIfDisconnected);
    const onResponseClose = () => {
      const wasAlreadyAborted = requestAbort.signal.aborted;
      abortIfDisconnected();
      // A response that closes before completion is a lost transport request.
      // Close the disposable MCP transport as well, but keep durable work and
      // logical continuity metadata alive for a fresh initialize. Guard the
      // reentrant close generated by the SDK's own cleanup path.
      if (!wasAlreadyAborted && !res.writableFinished && transport?.sessionId && !transportCloseRequested) {
        transportCloseRequested = true;
        void transport.close().catch(() => undefined);
      }
      cleanupRequestListeners();
    };
    const onResponseFinish = () => {
      const finishedAt = performance.now();
      recordPhaseTiming("mcp.response", finishedAt - requestStartedAt);
      if (handlerStartedAt > 0) recordPhaseTiming("mcp.serialization", finishedAt - handlerStartedAt);
      cleanupRequestListeners();
    };
    res.once("close", onResponseClose);
    res.once("finish", onResponseFinish);

    const restoreSessionExecutionCount = (): void => {
      if (!sessionId || sessionRequestClass !== "execution" || sessionExecutionCounted) return;
      const state = mcpSessions.get(sessionId);
      if (!state) return;
      state.inFlightRequests++;
      sessionExecutionCounted = true;
    };
    const removePolicyWaiter = (): McpPolicyWaiter | undefined => {
      if (!policyWaiterId) return undefined;
      const waiter = mcpPolicyWaiters.get(policyWaiterId);
      mcpPolicyWaiters.delete(policyWaiterId);
      policyWaiterId = undefined;
      const state = sessionId ? mcpSessions.get(sessionId) : undefined;
      if (state && state.activePolicyWaiters > 0) state.activePolicyWaiters--;
      return waiter;
    };
    const onPolicyWaitStart = async (context: PolicyWaitContext): Promise<void> => {
      if (requestAbort.signal.aborted) return;
      admissionRelease?.();
      admissionRelease = undefined;
      if (sessionId && sessionRequestClass === "execution" && sessionExecutionCounted) {
        const state = mcpSessions.get(sessionId);
        if (state && state.inFlightRequests > 0) state.inFlightRequests--;
        sessionExecutionCounted = false;
      }
      const id = `${requestId ?? randomUUID()}:${context.approvalId}:${randomUUID()}`;
      policyWaiterId = id;
      const state = sessionId ? mcpSessions.get(sessionId) : undefined;
      if (state) state.activePolicyWaiters++;
      mcpPolicyWaiters.set(id, {
        id,
        approvalId: context.approvalId,
        waiterKey: context.waiterKey,
        principalId: context.principalId,
        workspaceId: context.workspaceId,
        workSessionId: context.workSessionId,
        tool: context.tool,
        mcpSessionId: context.mcpSessionId,
        mcpRequestId: context.mcpRequestId,
        startedAt: Date.now(),
        signal: requestAbort.signal,
        cancel: () => requestAbort.abort(),
      });
    };
    const onPolicyWaitEnd = async (context: PolicyWaitContext & { outcome: PolicyWaitOutcome }): Promise<void> => {
      const waiter = removePolicyWaiter();
      if (context.outcome === "cancelled" && requestAbort.signal.aborted) {
        policyWaiterDisconnects++;
        lastPolicyWaiterDisconnectAt = Date.now();
      }
      if (context.outcome !== "approved") {
        restoreSessionExecutionCount();
        return;
      }
      const admissionStartedAt = performance.now();
      const acquired = await mcpAdmission.acquire(
        sessionId ?? logicalClientId(req),
        config.mcpAdmissionTimeoutMs,
        mcpAdmissionWeight(requestRpcMethod, requestToolName),
        requestAbort.signal,
      );
      admissionWaitMs += performance.now() - admissionStartedAt;
      if (!acquired) {
        restoreSessionExecutionCount();
        throw new McpAdmissionUnavailableError();
      }
      admissionRelease = acquired;
      restoreSessionExecutionCount();
      policyWaiterResumes++;
      lastPolicyWaiterResumeAt = Date.now();
      if (waiter) {
        logEvent(config.logging, "debug", "mcp_policy_waiter_resumed", {
          requestId,
          approvalId: waiter.approvalId,
          sessionIdPrefix: sessionIdPrefix(sessionId),
          admissionWaitMs: Math.round(admissionWaitMs),
        });
      }
    };

    if (shuttingDown) {
      return res.status(503).json({
        jsonrpc: "2.0",
        id: (req.body as { id?: unknown } | undefined)?.id ?? null,
        error: { code: -32000, message: "KONTROL is draining; retry after restart." },
      });
    }

    if (bearerAuth && !req.auth) {
      await new Promise<void>((resolve, reject) => {
        bearerAuth(req, res, (error?: unknown) => {
          if (error) reject(error);
          else resolve();
        });
      });
      if (res.headersSent) return;
    }
    if (bearerAuth) {
      if (res.headersSent) return;
      if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl! })) {
        logEvent(config.logging, "warn", "auth_denied", {
          requestId,
          method: req.method,
          path: requestPath(req),
          reason: "invalid_oauth_resource",
          ...requestLogFields(req, config),
        });
        sendJsonRpcError(res, 401, -32001, "Unauthorized");
        return;
      }
    } else if (config.authMode === "tunnel") {
      // Tunnel mode is intentionally unauthenticated at the local MCP hop.
      // The OpenAI Secure MCP Tunnel owns the external trust boundary. In
      // particular, never let a stale KONTROL_TUNNEL_TOKEN or Authorization
      // header turn this mode back into a second, unsynchronized auth gate.
    }

    // tunnel-client performs liveness and compatibility probes with an empty
    // POST and a sessionless GET before/after initialize. These are not MCP
    // tool requests and must not be reported as application 400s.
    const emptyTunnelProbe = config.authMode === "tunnel" && !sessionId && (
      req.method === "GET" ||
      (req.method === "POST" && (!req.body || Object.keys(req.body).length === 0))
    );
    if (emptyTunnelProbe) {
      logEvent(config.logging, "debug", "mcp_probe_request", {
        requestId,
        method: req.method,
        reason: "sessionless_tunnel_probe",
      });
      res.status(req.method === "GET" ? 200 : 202).end();
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });

    try {
      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
        sessionState = mcpSessions.get(sessionId);
        if (config.authMode === "oauth" && sessionState && sessionState.logicalClientId !== logicalClientId(req)) {
          logEvent(config.logging, "warn", "mcp_session_client_mismatch", {
            requestId,
            sessionIdPrefix: sessionIdPrefix(sessionId),
            expectedClientId: sessionState.logicalClientId,
            actualClientId: logicalClientId(req),
          });
          sendJsonRpcError(res, 403, -32001, "MCP session belongs to another client");
          return;
        }
        const requestedConversationId = conversationId(req);
        if (sessionState?.conversationId && requestedConversationId && sessionState.conversationId !== requestedConversationId) {
          logEvent(config.logging, "warn", "mcp_session_conversation_mismatch", {
            requestId,
            sessionIdPrefix: sessionIdPrefix(sessionId),
            sessionLabel: sessionState.sessionLabel,
            expectedConversationId: sessionState.conversationId,
            actualConversationId: requestedConversationId,
          });
          sendJsonRpcError(res, 403, -32001, "MCP session belongs to another conversation");
          return;
        }
        if (sessionState) {
          const activityAt = Date.now();
          sessionState.lastTransportActivityAt = activityAt;
          if (!requestIsSseStream) sessionState.lastApplicationActivityAt = activityAt;
          if (sessionState.identitySource !== "client_info_fallback") {
            logicalContinuity.touch(sessionState.logicalClientId, sessionState.sessionId, activityAt);
          }
          sessionRequestClass = requestIsSseStream ? "stream" : requestIsWaiter ? "waiter" : "execution";
          if (sessionRequestClass === "stream") sessionState.activeSseStreams++;
          else if (sessionRequestClass === "waiter") sessionState.activeLongPollCount++;
          else {
            sessionState.inFlightRequests++;
            sessionExecutionCounted = true;
          }
          sessionState.requestCount++;
          const rpcMethod = (req.body as { method?: string })?.method;
          sessionState.lastRpcMethod = rpcMethod;
          if (rpcMethod?.startsWith("notifications/")) {
            sessionState.notificationCount++;
          }
          if (rpcMethod === "resources/read") {
            sessionState.resourceReadCount++;
          }
          if (rpcMethod === "tools/call") {
            sessionState.toolCallCount++;
            recordMcpWindowEvent("tool");
            const toolName = (req.body as { params?: { name?: string } })?.params?.name;
            sessionState.lastToolName = toolName;
          }
        }

        // App hosts can keep a template URI from an earlier build and send
        // the later resources/read through the already-open MCP transport.
        // Serve recognized historical hashes on that transport too; the
        // transport's per-session resource registry only contains the hash
        // from the build that created it.
        if (requestRpcMethod === "resources/read" && workspaceAppResourceKind((req.body as { params?: { uri?: unknown } })?.params?.uri)) {
          if (sessionState) {
            const activityAt = Date.now();
            sessionState.lastTransportActivityAt = activityAt;
            sessionState.lastApplicationActivityAt = activityAt;
            if (sessionState.identitySource !== "client_info_fallback") {
              logicalContinuity.touch(sessionState.logicalClientId, sessionState.sessionId, activityAt);
            }
          }
          serveWorkspaceAppResource(
            res,
            requestId,
            req.body as { id?: unknown; params?: { uri?: unknown } },
            false,
          );
          return;
        }
      } else if (initializeRequest) {
        // P1 #31: Admission pressure control — enforce caps at session creation
        const clientIdentity = logicalClientIdentity(req);
        const clientId = clientIdentity.id;
        const pressure = getMemoryPressureState();
        if (mcpSessions.size >= pressure.effectiveSoftCap) {
          reapIdleMcpSessions();
        }
        if (mcpSessions.size >= pressure.effectiveHardCap) {
          // Try idle eviction first to make room
          reapIdleMcpSessions();
          if (mcpSessions.size >= pressure.effectiveHardCap) {
            logEvent(config.logging, "warn", "mcp_session_rejected", {
              requestId,
              reason: "global_hard_cap_reached",
              current: mcpSessions.size,
              hardCap: pressure.effectiveHardCap,
              pressure: pressure.level,
            });
            return res.status(503).json({
              jsonrpc: "2.0",
              id: (req.body as { id?: unknown })?.id ?? null,
              error: { code: -32000, message: "Server at capacity. Try again later." },
            });
          }
        }
        // A generic clientInfo name/version is not a trustworthy owner: many
        // independent host transports can share it. Use only an instance,
        // conversation, or authenticated OAuth identity for aggressive caps.
        if (clientIdentity.source !== "client_info_fallback") {
          let clientSessionCount = [...mcpSessions.values()].filter((s) => s.logicalClientId === clientId).length;
          if (clientSessionCount >= config.mcpSessionMaxPerClient) {
            reapIdleMcpSessions(clientId);
            clientSessionCount = [...mcpSessions.values()].filter((s) => s.logicalClientId === clientId).length;
          }
          if (clientSessionCount >= config.mcpSessionMaxPerClient) {
            logEvent(config.logging, "warn", "mcp_session_rejected", {
              requestId,
              reason: "per_client_limit_reached",
              clientId,
              identitySource: clientIdentity.source,
              current: clientSessionCount,
              maxPerClient: config.mcpSessionMaxPerClient,
            });
            return res.status(503).json({
              jsonrpc: "2.0",
              id: (req.body as { id?: unknown })?.id ?? null,
              error: { code: -32000, message: "Too many sessions for this client. Close some and retry." },
            });
          }
        }
        const sessionInitializedAt = performance.now();
        // The SDK is not required to expose its assigned session ID through
        // `transport.sessionId` (it is legitimately unset at close time for
        // some close paths). The callback-bound ID is authoritative for
        // cleanup; the transport property is only a fallback.
        let boundSessionId: string | undefined;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            boundSessionId = newSessionId;
            if (transport) {
              transports.set(newSessionId, transport);
              const requestConversationId = conversationId(req);
              mcpSessions.set(newSessionId, {
                sessionId: newSessionId,
                sessionLabel: mcpSessionLabel(clientId, newSessionId, requestConversationId),
                logicalClientId: clientId,
                identitySource: clientIdentity.source,
                authenticatedRole: connectionContext.authenticatedRole ?? "client",
                authSource: connectionContext.authSource ?? "anonymous",
                conversationId: requestConversationId,
                approvalCorrelationId: clientIdentity.source === "client_info_fallback" ? undefined : clientId,
                createdAt: Date.now(),
                lastTransportActivityAt: Date.now(),
                lastApplicationActivityAt: Date.now(),
                inFlightRequests: 0,
                requestCount: 1,
                notificationCount: 0,
                toolCallCount: 0,
                resourceReadCount: 0,
                activeLongPollCount: 0,
                activeSseStreams: 0,
                activePolicyWaiters: 0,
                closing: false,
                closed: false,
                endRecorded: false,
                durableWorkerSession: false,
                lastRpcMethod: "initialize",
              });
              let continuityAttachment: ReturnType<LogicalContinuityIndex["attach"]> | undefined;
              if (clientIdentity.source !== "client_info_fallback") {
                continuityAttachment = logicalContinuity.attach({
                  identity: clientId,
                  source: clientIdentity.source,
                  transportId: newSessionId,
                });
              }
              // Bind the per-transport tool context at the same point that the
              // session record is created. The SDK does not need to expose its
              // assigned session ID through transport.sessionId for callbacks
              // to be safe; tool ownership must never fall back to the
              // workspace merely because that property is not populated yet.
              connectionContext.mcpSessionId = newSessionId;
              connectionContext.mcpSessionLabel = mcpSessions.get(newSessionId)?.sessionLabel;
              connectionContext.conversationId = mcpSessions.get(newSessionId)?.conversationId;
              connectionContext.approvalCorrelationId = mcpSessions.get(newSessionId)?.approvalCorrelationId;
              recordMcpSessionCreated(clientId);
              if (continuityAttachment?.reconnect) {
                logEvent(config.logging, "info", "mcp_logical_continuity_reconnected", {
                  requestId,
                  sessionIdPrefix: sessionIdPrefix(newSessionId),
                  predecessorSessionIdPrefix: continuityAttachment.predecessorTransportId
                    ? sessionIdPrefix(continuityAttachment.predecessorTransportId)
                    : undefined,
                  logicalClientId: clientId,
                  identitySource: clientIdentity.source,
                  activeTransportCount: continuityAttachment.activeTransportCount,
                });
              }
            }
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              sessionLabel: mcpSessions.get(newSessionId)?.sessionLabel,
              conversationId: mcpSessions.get(newSessionId)?.conversationId,
              logicalClientId: clientId,
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = boundSessionId ?? transport?.sessionId;
          if (closedSessionId) {
            const state = mcpSessions.get(closedSessionId);
            finalizeMcpSession(closedSessionId, state?.closing ? "server_shutdown" : "client_closed");
          }
        };

        // Extract the work-session attribution envelope. Role is derived from a
        // SIGNED worker token (X-Kontrol-Worker-Token) when present, NOT from
        // the plain attribution headers. The token is HMAC-signed by the adapter
        // and binds this connection to exactly one work session + the "worker"
        // role. A caller that omits/forges the token is treated as a
        // reviewer/client and cannot acquire worker rights (P0 #3: role is no
        // longer client-controlled).
        const workerToken = req.header("x-kontrol-worker-token");
        let verifiedClaims: WorkerTokenClaims | undefined;
        if (workerToken && config.acpAgentSecret) {
          try {
            verifiedClaims = verifyWorkerToken(workerToken, config.acpAgentSecret);
          } catch (err) {
            logEvent(config.logging, "warn", "worker_token_rejected", {
              requestId,
              reason: err instanceof Error ? err.message : String(err),
              ...requestLogFields(req, config),
            });
          }
        }
        const reviewerToken = req.header("x-kontrol-reviewer-token");
        const verifiedReviewer = constantTimeStringEqual(reviewerToken, config.acpReviewerSecret);
        // Tunnel mode deliberately has no bearer gate on the local hop. The
        // managed tunnel adds this separate secret-backed assertion only to
        // MCP target traffic, allowing the WebUI to retain reviewer authority
        // without promoting every loopback client or unsigned attribution
        // header to reviewer.
        const tunnelReviewerToken = req.header("x-kontrol-tunnel-reviewer");
        const verifiedTunnelReviewer = config.authMode === "tunnel"
          && constantTimeStringEqual(tunnelReviewerToken, config.tunnelReviewerSecret);
        const oauthScopes = Array.isArray(req.auth?.scopes) ? req.auth.scopes : [];
        const verifiedOAuthReviewer = oauthEnabled && oauthScopes.some((scope) =>
          scope === "kontrol" ||
          scope === "kontrol:review" ||
          scope === "kontrol:approve" ||
          scope === "kontrol:mission" ||
          scope === "kontrol:dispatch"
        );

        // A verified worker token authenticates this connection as a worker. It
        // also provides the bound work sessions (workspace/run/continuation) so
        // they cannot be spoofed by the headers below. Unsigned attribution
        // headers are used ONLY when no token is present (a reviewer/client
        // reaching /mcp directly) and never grant worker rights.
        const connectionContext: ConnectionContext = {
          authenticatedRole: verifiedClaims ? "worker" : (verifiedReviewer || verifiedTunnelReviewer || verifiedOAuthReviewer) ? "reviewer" : "client",
          authSource: verifiedClaims
            ? "worker_token"
            : verifiedReviewer
              ? "reviewer_token"
              : verifiedTunnelReviewer
                ? "tunnel_reviewer"
                : oauthEnabled
                  ? "oauth"
                  : "anonymous",
          authenticatedPrincipalId: verifiedClaims
            ? `worker-work-session:${verifiedClaims.workSessionId}`
            : req.auth?.clientId
              ? `oauth-client:${req.auth.clientId}`
              : verifiedReviewer
                ? "reviewer-token"
                : verifiedTunnelReviewer
                  ? "tunnel-reviewer"
                  : undefined,
          workspaceSessionId:
            verifiedClaims?.workspaceSessionId
            || (req.header("x-kontrol-workspace-session") ?? undefined),
          // A plain attribution header is never allowed to turn a client into
          // a worker or to select the principal used for policy grants. Only
          // the signed worker envelope supplies an operational work session.
          workSessionId: verifiedClaims?.workSessionId,
          runId:
            verifiedClaims?.runId || (req.header("x-kontrol-run") ?? undefined),
          continuationId:
            verifiedClaims?.continuationId
            || (req.header("x-kontrol-continuation") ?? undefined),
          workspaceLeaseNonce:
            (verifiedClaims as (WorkerTokenClaims & { workspaceLeaseNonce?: string }) | undefined)?.workspaceLeaseNonce
            || (verifiedClaims ? req.header("x-kontrol-workspace-lease-nonce") ?? undefined : undefined),
          conversationId: conversationId(req),
        };

        const serverCreateStarted = performance.now();
        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          workSessions,
          agentRegistry,
          eventStore,
          continuationManager,
          dispatchOutbox,
          policyEngine,
          policyEnforcer,
          approvalRequests,
          missionLedger,
          connectionContext,
          reviewWorkflow,
          liveWaiters,
          agentMessages,
          supervisorRuns,
          (workSessionId) => supervisorRuntime?.wake(workSessionId),
          db,
          mutationReceipts,
          (uri) => {
            if (uri === WORKSPACE_APP_URI) workspaceAppResourceMetrics.currentHashed++;
            else if (uri === OPENAI_WORKSPACE_APP_URI) workspaceAppResourceMetrics.openAiCompatibility++;
            else if (uri === LEGACY_WORKSPACE_APP_URI) workspaceAppResourceMetrics.legacyKontrol++;
            else if (uri === DEVDESKTOP_WORKSPACE_APP_URI) workspaceAppResourceMetrics.devDesktopMigration++;
          },
          recordPhaseTiming,
        );
        const serverCreateMs = performance.now() - serverCreateStarted;
        const transportConnectStarted = performance.now();
        await server.connect(transport);
        const state = (sessionId ? mcpSessions.get(sessionId) : undefined)
          ?? (transport.sessionId ? mcpSessions.get(transport.sessionId) : undefined);
        if (state) {
          state.durableWorkerSession = connectionContext.authenticatedRole === "worker" || Boolean(connectionContext.workSessionId);
          connectionContext.mcpSessionId = state.sessionId;
          connectionContext.mcpSessionLabel = state.sessionLabel;
          connectionContext.conversationId = state.conversationId;
          connectionContext.approvalCorrelationId = state.approvalCorrelationId;
        }
        const transportConnectMs = performance.now() - transportConnectStarted;
        const initializationTotalMs = performance.now() - sessionInitializedAt;
        recordMcpTiming({
          admissionClass: "execution",
          admissionWaitMs: 0,
          serverCreateMs,
          transportConnectMs,
          handlerMs: 0,
          totalMs: initializationTotalMs,
        });
        logEvent(config.logging, "info", "mcp_session_initialized", {
          requestId,
          sessionIdPrefix: sessionIdPrefix(transport.sessionId),
          sessionLabel: sessionState?.sessionLabel,
          conversationId: sessionState?.conversationId,
          serverCreateMs: Math.round(serverCreateMs),
          transportConnectMs: Math.round(transportConnectMs),
          totalMs: Math.round(initializationTotalMs),
        });
      } else if (
        requestRpcMethod === "resources/read" &&
        workspaceAppResourceKind((req.body as { params?: { uri?: unknown } } | undefined)?.params?.uri)
      ) {
        // The OpenAI tunnel fetches app resources on a separate, sessionless
        // channel after initialization. Resources are read-only and the outer
        // bearer/tunnel authentication above has already succeeded, so serve
        // this one protocol method statelessly rather than constructing the
        // complete file/shell/ACP/policy tool universe just to return a static
        // HTML document.
        serveWorkspaceAppResource(
          res,
          requestId,
          req.body as { id?: unknown; params?: { uri?: unknown } },
          true,
        );
        return;
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      if (!requestIsSseStream) {
        const admission = requestIsWaiter ? mcpWaiterAdmission : mcpAdmission;
        admissionClass = requestIsWaiter ? "waiter" : "execution";
        const admissionWeight = requestIsWaiter ? 1 : mcpAdmissionWeight(requestRpcMethod, requestToolName);
        const admissionStartedAt = performance.now();
        const acquiredAdmission = await admission.acquire(
          sessionId ?? logicalClientId(req),
          config.mcpAdmissionTimeoutMs,
          admissionWeight,
          requestAbort.signal,
        );
        admissionWaitMs = performance.now() - admissionStartedAt;
        if (!acquiredAdmission) {
          if (!requestIsWaiter) recordMcpCapacityRejection(requestToolName, admissionWeight, requestId);
          logEvent(config.logging, "warn", "mcp_request_rejected", {
            requestId,
            reason: "admission_queue_full_or_deadline",
            sessionIdPrefix: sessionIdPrefix(sessionId),
            admissionClass,
            admissionWaitMs: Math.round(admissionWaitMs),
            admission: admission.getStats(),
          });
          return res.status(503).json({
            jsonrpc: "2.0",
            id: (req.body as { id?: unknown })?.id ?? null,
            error: { code: -32029, message: "MCP request capacity is temporarily exhausted. Retry later." },
          });
        }
        admissionRelease = acquiredAdmission;
        res.setHeader("x-kontrol-admission-wait-ms", String(Math.round(admissionWaitMs)));
      }

      if (requestIsSseStream && typeof res.write === "function") {
        // Keep long-lived SSE connections visible through idle proxies. This
        // is an SSE comment, not an MCP application event, and deliberately
        // does not advance the application-activity clock.
        sseHeartbeatTimer = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            clearInterval(sseHeartbeatTimer);
            sseHeartbeatTimer = undefined;
            return;
          }
          try {
            res.write(": kontrol-heartbeat\\n\\n");
          } catch {
            clearInterval(sseHeartbeatTimer);
            sseHeartbeatTimer = undefined;
          }
        }, 20_000);
        sseHeartbeatTimer.unref?.();
      }

      handlerStartedAt = performance.now();
      await mcpRequestContext.run({
        signal: requestAbort.signal,
        mcpSessionId: sessionId,
        mcpRequestId: requestId,
        conversationId: sessionState?.conversationId,
        approvalCorrelationId: sessionState?.approvalCorrelationId,
        onPolicyWaitStart,
        onPolicyWaitEnd,
      }, async () => {
        if (!requestIsSseStream && mcpRequestHasExecutionDeadline(requestRpcMethod, requestToolName)) {
          await handleMcpRequestWithDeadline(
            transport!,
            req,
            res,
            req.body,
            config.mcpExecutionTimeoutMs,
          );
        } else {
          await transport!.handleRequest(req, res, req.body);
        }
      });
      const handlerMs = performance.now() - handlerStartedAt;
      const totalMs = performance.now() - requestStartedAt;
      recordMcpTiming({
        admissionClass,
        admissionWaitMs,
        serverCreateMs: 0,
        transportConnectMs: 0,
        handlerMs,
        totalMs,
      });
      logEvent(config.logging, "debug", "mcp_request_completed", {
        requestId,
        sessionIdPrefix: sessionIdPrefix(sessionId),
        rpcMethod: requestRpcMethod,
        toolName: requestToolName,
        admissionClass,
        admissionWaitMs: Math.round(admissionWaitMs),
        handlerMs: Math.round(handlerMs),
        totalMs: Math.round(totalMs),
        status: res.statusCode,
      });
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
        timedOut: error instanceof McpExecutionTimeoutError,
        admissionUnavailable: error instanceof McpAdmissionUnavailableError,
      });
      if (!res.headersSent) {
        sendJsonRpcError(
          res,
          error instanceof McpExecutionTimeoutError ? 504 : error instanceof McpAdmissionUnavailableError ? 503 : 500,
          error instanceof McpExecutionTimeoutError ? -32008 : error instanceof McpAdmissionUnavailableError ? -32029 : -32603,
          error instanceof McpExecutionTimeoutError
            ? "MCP request exceeded its execution deadline; reconnect and retry."
            : error instanceof McpAdmissionUnavailableError
              ? "MCP request capacity is temporarily exhausted after approval; retry later."
              : "Internal server error",
        );
      }
    } finally {
      if (sseHeartbeatTimer) {
        clearInterval(sseHeartbeatTimer);
        sseHeartbeatTimer = undefined;
      }
      removePolicyWaiter();
      admissionRelease?.();
      admissionRelease = undefined;
      // Decrement in-flight count after response completes or is aborted.
      if (sessionId) {
        const state = mcpSessions.get(sessionId);
        if (state && sessionRequestClass) {
          if (sessionRequestClass === "stream" && state.activeSseStreams > 0) state.activeSseStreams--;
          else if (sessionRequestClass === "waiter" && state.activeLongPollCount > 0) state.activeLongPollCount--;
          else if (sessionRequestClass === "execution" && sessionExecutionCounted && state.inFlightRequests > 0) state.inFlightRequests--;
          const activityAt = Date.now();
          state.lastTransportActivityAt = activityAt;
          if (sessionRequestClass !== "stream") state.lastApplicationActivityAt = activityAt;
          if (state.identitySource !== "client_info_fallback") {
            logicalContinuity.touch(state.logicalClientId, state.sessionId, activityAt);
          }
        }
      }
    }
  });

  // Express's JSON parser reports oversize and malformed payloads through the
  // error pipeline. Keep those responses deterministic and protocol-shaped;
  // callers must never receive an HTML error page from a JSON endpoint.
  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    const parserError = error as { type?: string; status?: number; statusCode?: number };
    if (parserError.type === "entity.too.large" || parserError.status === 413 || parserError.statusCode === 413) {
      if (req.path.startsWith("/mcp")) sendJsonRpcError(res, 413, -32013, "Request body is too large");
      else res.status(413).json({ error: { code: "request_too_large", message: "Request body is too large" } });
      return;
    }
    if (parserError.type === "entity.parse.failed") {
      if (req.path.startsWith("/mcp")) sendJsonRpcError(res, 400, -32700, "Malformed JSON request body");
      else res.status(400).json({ error: { code: "invalid_json", message: "Malformed JSON request body" } });
      return;
    }
    next(error);
  });

  // Singleton continuation dispatcher — owned by the Kontrol process, not by an
  // individual MCP client connection. Shares the SAME liveWaiters instance used
  // by every createMcpServer so a parked agent suppresses duplicate dispatch.
  let dispatcher: ContinuationDispatcher | undefined;
  let supervisorRuntime: ReturnType<typeof createSupervisorRuntime> | undefined;
  if (config.acpEnabled) {
    const bridgeBase: BridgeConfig = {
      workspaces,
      workSessions,
      reviewCheckpoints,
      agentRegistry,
      eventStore,
      continuationManager,
      dispatchOutbox,
      reviewWorkflow,
      missionLedger,
      supervisorRuns,
      onSupervisorResume: (workSessionId) => supervisorRuntime?.wake(workSessionId),
      agentMessages,
      knownAgents: config.acpKnownAgents,
      adapterSecret: config.acpAdapterSecret,
      liveWaiters,
    };
    dispatcher = createContinuationDispatcher(bridgeBase);
    dispatcher.start();
    supervisorRuntime = createSupervisorRuntime({
      outbox: dispatchOutbox,
      events: eventStore,
      runs: supervisorRuns,
      onVerify: async (workSessionId, deadlineAt, submission) => {
        await verifyMissionSubmission({
          workSessionId,
          maxInflight: config.verifyMaxInflight,
          sandbox: config.verifySandbox,
          childEnvironmentAllowlist: config.childEnvironmentAllowlist,
          verifyToolchainPaths: config.verifyToolchainPaths,
          missionLedger,
          workSessions,
          workspaces,
          reviewCheckpoints,
          deadlineAtMs: deadlineAt ? Date.parse(deadlineAt) : undefined,
          submissionId: submission?.id,
          reviewEpoch: submission?.reviewEpoch,
        });
      },
      onEvaluate: async (workSessionId) => {
        const run = supervisorRuns.getByWorkSession(workSessionId);
        const latest = workSessions.get(workSessionId)?.latestSubmission;
        return evaluateSupervisorMission(missionLedger, workSessionId, {
          submissionId: latest?.id,
          snapshotKind: latest?.snapshotKind,
          snapshotRef: latest?.snapshotRef ?? latest?.snapshotCommit,
          snapshotCommit: latest?.snapshotRef ?? latest?.snapshotCommit,
          cycleNumber: run?.cycleNumber ?? 0,
          emergencyCycleCeiling: run?.maxCycles,
        });
      },
      onTiming: (sample) => {
        recordPhaseTiming(`supervisor.${sample.stage}.event_to_claim`, sample.eventToClaimMs);
        recordPhaseTiming(`supervisor.${sample.stage}.total`, sample.totalMs);
        if (sample.verificationMs !== undefined) recordPhaseTiming("supervisor.verification.duration", sample.verificationMs);
        if (sample.evaluationMs !== undefined) recordPhaseTiming("supervisor.evaluation.duration", sample.evaluationMs);
      },
      getProgressSnapshot: (workSessionId, evaluation) => {
        const session = workSessions.get(workSessionId);
        const latest = session?.latestSubmission;
        const packet = missionLedger.getPacket(workSessionId, latest?.id ? { submissionId: latest.id, snapshotKind: latest.snapshotKind, snapshotRef: latest.snapshotRef ?? latest.snapshotCommit, snapshotCommit: latest.snapshotRef ?? latest.snapshotCommit, reviewEpoch: latest.reviewEpoch } : undefined);
        const currentEvidence = packet.evidence.filter((entry) => !latest?.id || entry.submissionId === latest.id);
        const failedEvidence = currentEvidence.filter((entry) => entry.status === "failed");
        const failureSet = failedEvidence.map((entry) => {
          const details = typeof entry.details === "object" && entry.details ? entry.details as Record<string, unknown> : {};
          return { command: entry.command, failureSetSha256: details.failureSetSha256, outputSha256: details.outputSha256, status: entry.status };
        });
        const summary = latest?.summaryJson ? (() => { try { return JSON.parse(latest.summaryJson) as { files?: number }; } catch { return {}; } })() : {};
        return {
          blockingFindingCount: packet.findings.filter((finding) => finding.scope !== "out_of_scope" && ["blocker", "high"].includes(finding.severity) && !["verified_resolved", "waived"].includes(finding.status)).length,
          failedCriterionCount: packet.criteria.filter((criterion) => criterion.priority === "required" && criterion.status === "failed").length,
          passedCriterionCount: packet.criteria.filter((criterion) => criterion.status === "verified").length,
          failingVerificationCount: failedEvidence.length,
          verificationFailureFingerprint: failureSet.length ? createHash("sha256").update(JSON.stringify(failureSet)).digest("hex") : evaluation.failureSetSha256,
          changedRelevantFiles: typeof summary.files === "number" ? summary.files : 0,
          unresolvedRequiredActions: packet.workOrders[0]?.requiredActions.length ?? 0,
          submissionId: latest?.id ?? "",
          reviewEpoch: latest?.reviewEpoch ?? 0,
        };
      },
      onCorrect: async (workSessionId, reasons) => {
        const mission = missionLedger.getMissionByWorkSession(workSessionId);
        const session = workSessions.get(workSessionId);
        const latest = session?.latestSubmission;
        if (!mission || !latest?.id || !session) throw new Error("Cannot create a correction without a current mission submission.");
        const packet = missionLedger.getPacket(workSessionId);
        const failedCriteria = packet.criteria.filter((criterion) => criterion.priority === "required" && criterion.status !== "verified");
        const openFindings = packet.findings.filter((finding) => finding.scope !== "out_of_scope" && ["blocker", "high"].includes(finding.severity) && !["verified_resolved", "waived"].includes(finding.status));
        const workOrder = missionLedger.createWorkOrder(mission.id, workSessionId, {
          objectiveForThisTurn: "Resolve the current failed mission verification and resubmit the exact workspace snapshot for review.",
          acceptanceCriterionIds: failedCriteria.map((criterion) => criterion.id),
          requiredFindingIds: openFindings.map((finding) => finding.id),
          requiredActions: reasons,
          prohibitedActions: mission.userLockedFields.map((field) => `Do not alter user-locked mission field: ${field}`),
          requiredVerification: failedCriteria.map((criterion) => criterion.verificationCommand).filter(Boolean),
          expectedDeliverables: ["A corrected submission with verification-ready workspace state."],
        });
        await reviewWorkflow.provideFeedback({
          sessionId: workSessionId,
          submissionId: latest.id,
          diffSha256: latest.diffSha256,
          reviewEpoch: latest.reviewEpoch,
          verdict: "changes_requested",
          comments: `Automatic verification requires correction:\n${reasons.join("\n")}`,
          requiredActions: workOrder.requiredActions,
          reviewerId: "supervisor-runtime",
        });
      },
      currentSubmission: (workSessionId) => {
        const session = workSessions.get(workSessionId);
        if (session?.status !== "awaiting_review") return undefined;
        const submission = session.latestSubmission;
        return submission?.id ? { id: submission.id, snapshotKind: submission.snapshotKind, snapshotRef: submission.snapshotRef ?? submission.snapshotCommit, snapshotCommit: submission.snapshotRef ?? submission.snapshotCommit, reviewEpoch: submission.reviewEpoch } : undefined;
      },
      currentSessionStatus: (workSessionId) => workSessions.get(workSessionId)?.status,
      currentApproval: (workSessionId) => {
        const latest = workSessions.get(workSessionId)?.latestSubmission;
        return missionLedger.canApprove(workSessionId, latest?.id ? { submissionId: latest.id, snapshotKind: latest.snapshotKind, snapshotRef: latest.snapshotRef ?? latest.snapshotCommit, snapshotCommit: latest.snapshotRef ?? latest.snapshotCommit, reviewEpoch: latest.reviewEpoch } : {});
      },
      onApprove: async (workSessionId) => {
        const session = workSessions.get(workSessionId);
        const latest = session?.latestSubmission;
        if (!session || !latest?.id) throw new Error("Cannot automatically approve without a current submission.");
        const approval = missionLedger.canApprove(workSessionId, { submissionId: latest.id, snapshotKind: latest.snapshotKind, snapshotRef: latest.snapshotRef ?? latest.snapshotCommit, snapshotCommit: latest.snapshotRef ?? latest.snapshotCommit, reviewEpoch: latest.reviewEpoch });
        if (!approval.allowed) throw new Error(`Automatic approval blocked: ${approval.reasons.join("; ")}`);
        await reviewWorkflow.provideFeedback({
          sessionId: workSessionId,
          submissionId: latest.id,
          diffSha256: latest.diffSha256,
          reviewEpoch: latest.reviewEpoch,
          verdict: "approve",
          comments: "Automatically approved after current trusted mission verification.",
          reviewerId: "supervisor-runtime",
          completionReportSha256: missionLedger.getCompletionReportHash(workSessionId, { submissionId: latest.id, snapshotKind: latest.snapshotKind, snapshotRef: latest.snapshotRef ?? latest.snapshotCommit, snapshotCommit: latest.snapshotRef ?? latest.snapshotCommit, reviewEpoch: latest.reviewEpoch }),
        });
      },
    });
    supervisorRuntime.start();
  }

  let closed = false;
  let draining: Promise<void> | undefined;
  const closeTransport = async (transport: Transport): Promise<void> => {
    try {
      await Promise.race([
        Promise.resolve(transport.close()),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch {
      // A transport that rejects during drain is already unusable; continue
      // closing the rest of the generation.
    }
  };
  const finalizeClose = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    startupRecoveryStopped = true;
    maintenance.stop();
    // P0 #4: Drain in-flight filesystem capture transactions before exit. A
    // graceful stop finishes active publishes and clears their staging; a hard
    // kill is covered by the durable transaction journal on next startup.
    await reviewCheckpoints.drain().catch(() => undefined);
    dispatcher?.stop();
    supervisorRuntime?.stop();
    supervisorRuns.close();
    mcpAdmission.close();
    mcpWaiterAdmission.close();
    clearInterval(mcpSessionReaper);
    clearInterval(mcpMemorySampler);
    clearInterval(mcpSessionChurnTimer);
    const shutdownAt = Date.now();
    for (const state of mcpSessions.values()) {
      state.closing = true;
      recordMcpSessionEnd(state, "server_shutdown", shutdownAt);
    }
    await Promise.all([...transports.values()].map(closeTransport));
    transports.clear();
    mcpSessions.clear();
    await shutdownMissionVerifiers();
    eventStore.close();
    continuationManager.close();
    dispatchOutbox.close();
    await processSessions.shutdown();
    await agentRegistry.drain?.();
    oauthProvider?.close();
    workspaceStore.close?.();
    workSessions?.close?.();
    agentRegistry.close();
    await integrity.stop();
    try { db.close(); } catch { /* ignore */ }
  };
  return {
    app,
    config,
    dispatcher,
    close: finalizeClose,
    drain: async () => {
      if (closed) return;
      if (draining) return draining;
      draining = (async () => {
        // Reject new MCP admission first, then close transports so long polls
        // are woken before the Node HTTP server waits for connection closure.
        shuttingDown = true;
        mcpAdmission.close();
        mcpWaiterAdmission.close();
        const activeTransports = [...transports.values()];
        for (const state of mcpSessions.values()) state.closing = true;
        await Promise.all(activeTransports.map(closeTransport));
        await finalizeClose();
      })();
      return draining;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

export async function runServer(config = loadConfig()): Promise<void> {
  const buildMeta = readBuildIdentity(join(dirname(fileURLToPath(import.meta.url)), "build-meta.json"));
  const inheritedLockToken = process.env.KONTROL_RUNTIME_LOCK_TOKEN;
  const runtimeLock: RuntimeLockHandle = inheritedLockToken
    ? { path: runtimeLockPath(config.stateDir), record: assertRuntimeLock(config.stateDir, inheritedLockToken) }
    : await acquireRuntimeLock(config.stateDir, {
      launcher: (process.env.KONTROL_LAUNCHER as "systemd" | "dev-watch" | "serve" | undefined) ?? "serve",
      generationId: process.env.KONTROL_LAUNCH_GENERATION_ID,
      buildId: buildMeta.buildId,
      artifactPath: dirname(fileURLToPath(import.meta.url)),
      port: config.port,
    });
  const ownsRuntimeLock = !inheritedLockToken;
  let serverResources: ReturnType<typeof createServer>;
  try {
    serverResources = createServer(config);
  } catch (error) {
    if (ownsRuntimeLock) await releaseRuntimeLock(runtimeLock);
    throw error;
  }
  const { app, close, drain } = serverResources;
  const runtimeIdentity = createRuntimeIdentityRecord(
    buildMeta,
    process.argv.join(" "),
    {
      artifactPath: dirname(fileURLToPath(import.meta.url)),
      generationId: runtimeLock.record.generationId,
    },
  );
  let runtimeIdentityWritten = false;
  const httpServer = app.listen(config.port, config.host, () => {
    // P2 / P1 #51: Log build info at startup for dirty-deployment visibility.
    // Prefer the embedded build meta (artifact identity); fall back to git working tree.
    let commit = "unknown";
    let dirty = false;
    let dirtyFileCount = 0;
    try {
      const metaPath = join(dirname(fileURLToPath(import.meta.url)), "build-meta.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      commit = meta.gitSha ?? "unknown";
      dirty = (meta.gitDirty ?? 0) > 0;
      dirtyFileCount = meta.gitDirty ?? 0;
      console.log(`[build] id=${meta.buildId ?? "dev"} version=${meta.version} sha=${commit} dirty=${dirtyFileCount} schema=${meta.schemaHash} built=${meta.buildTimestamp}`);
    } catch {
      try {
        commit = execSync("git rev-parse HEAD 2>/dev/null || echo unknown", { encoding: "utf8" }).trim();
        const status = execSync("git status --porcelain 2>/dev/null", { encoding: "utf8" }).trim();
        if (status) {
          dirty = true;
          dirtyFileCount = status.split("\n").length;
        }
      } catch { /* ignore */ }
    }

    console.log(
      `kontrol listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(
      config.authMode === "tunnel"
        ? "auth: tunnel mode (loopback only; OAuth disabled on /mcp; ChatGPT connects with No Authentication)"
        : "auth: oauth owner-token flow required",
    );
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ?? "disabled"}`);
    // P2: Build info for dirty-deployment visibility
    console.log(`build commit: ${commit.slice(0, 8)} dirty: ${dirty ? `YES (${dirtyFileCount} files)` : "no"} built: ${new Date().toISOString()}`);
  });
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    httpServer.once("listening", onListening);
    httpServer.once("error", onError);
  }).catch(async (error) => {
    // Express leaves the HTTP server object allocated when the bind emits an
    // error. Close that object before tearing down the application resources;
    // otherwise a failed competing launch can retain a listener/timer long
    // enough to look like a hung process and obscure the real EADDRINUSE.
    try {
      if (httpServer.listening) {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      } else {
        httpServer.closeAllConnections?.();
      }
    } catch {
      // The socket never became ours or was already closed; resource cleanup
      // below remains authoritative.
    }
    await close();
    if (ownsRuntimeLock) await releaseRuntimeLock(runtimeLock);
    throw new Error(`kontrol failed to listen on ${config.host}:${config.port}: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    writeRuntimeIdentity(config.stateDir, runtimeIdentity);
    runtimeIdentityWritten = true;
  } catch (error) {
    await close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    if (ownsRuntimeLock) await releaseRuntimeLock(runtimeLock);
    throw new Error(`kontrol could not publish runtime identity: ${error instanceof Error ? error.message : String(error)}`);
  }

  let shutdownStarted = false;
  const shutdown = async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
      await drain();
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const deadline = setTimeout(() => {
          httpServer.closeAllConnections?.();
          finish();
        }, 5_000);
        httpServer.close(() => {
          clearTimeout(deadline);
          finish();
        });
      });
      await close();
      if (runtimeIdentityWritten) removeRuntimeIdentity(config.stateDir, runtimeIdentity.instanceId);
      if (ownsRuntimeLock) await releaseRuntimeLock(runtimeLock);
      process.exit(0);
    } catch (error) {
      console.error(`kontrol graceful shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      await close();
      if (runtimeIdentityWritten) removeRuntimeIdentity(config.stateDir, runtimeIdentity.instanceId);
      if (ownsRuntimeLock) await releaseRuntimeLock(runtimeLock);
      process.exit(1);
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (await isMainModule()) {
  await runServer().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
