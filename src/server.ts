import { execSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Socket } from "node:net";
import os from "node:os";
import { Worker } from "node:worker_threads";
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

/** P1 #26: single source of runtime version identity — the package manifest. */
let cachedPackageVersion: string | undefined;
function readPackageVersion(): string {
  if (cachedPackageVersion) return cachedPackageVersion;
  try {
    const buildMeta = JSON.parse(readFileSync(new URL("./build-meta.json", import.meta.url), "utf8")) as { version?: string };
    cachedPackageVersion = typeof buildMeta.version === "string" && buildMeta.version ? buildMeta.version : "0.0.0";
  } catch {
    try {
      const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: string };
      cachedPackageVersion = typeof manifest.version === "string" && manifest.version ? manifest.version : "0.0.0";
    } catch {
      cachedPackageVersion = "0.0.0";
    }
  }
  return cachedPackageVersion;
}

/**
 * P1 #25: audit-event writes are best-effort (they must never fail user
 * work), but silent degradation is unacceptable. Track a counter per scope,
 * warn rate-limited, and expose the counters under authenticated
 * diagnostics so persistent failures surface.
 */
const degradedAuditCounters = new Map<string, { count: number; lastWarnedAt: number; lastError?: string }>();
const DEGRADED_AUDIT_WARN_INTERVAL_MS = 60_000;

function recordDegradedAudit(scope: string, error: unknown): void {
  const entry = degradedAuditCounters.get(scope) ?? { count: 0, lastWarnedAt: 0 };
  entry.count += 1;
  entry.lastError = error instanceof Error ? error.message : String(error);
  const now = Date.now();
  if (now - entry.lastWarnedAt >= DEGRADED_AUDIT_WARN_INTERVAL_MS) {
    entry.lastWarnedAt = now;
    console.warn(`[kontrol] degraded audit telemetry (${scope}): ${entry.count} write failure(s); last error: ${entry.lastError}`);
  }
  degradedAuditCounters.set(scope, entry);
}

function degradedAuditSnapshot(): Record<string, { count: number; lastError?: string }> {
  const snapshot: Record<string, { count: number; lastError?: string }> = {};
  for (const [scope, entry] of degradedAuditCounters) {
    snapshot[scope] = { count: entry.count, lastError: entry.lastError };
  }
  return snapshot;
}

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

type Transport = StreamableHTTPServerTransport;

interface McpRequestContext {
  signal: AbortSignal;
  mcpSessionId?: string;
  mcpRequestId?: string;
  conversationId?: string;
  approvalCorrelationId?: string;
  onPolicyWaitStart?: (context: PolicyWaitContext) => void | Promise<void>;
  onPolicyWaitEnd?: (context: PolicyWaitContext & { outcome: PolicyWaitOutcome }) => void | Promise<void>;
}

const mcpRequestContext = new AsyncLocalStorage<McpRequestContext>();

function currentMcpRequestSignal(): AbortSignal | undefined {
  return mcpRequestContext.getStore()?.signal;
}

function currentMcpRequestContext(): McpRequestContext | undefined {
  return mcpRequestContext.getStore();
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

const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

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

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface DiffStats {
  additions: number;
  removals: number;
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

type ToolWidgetKind =
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "workspace" || kind === "show_changes";
    case "full":
      return true;
  }
}

/**
 * A tool whose effective policy can produce an `ask` outcome may return a
 * blocked result that carries an interactive approval card. Those results must
 * reach the Workspace App even in `changes` mode: a card the host cannot
 * render because the tool descriptor never advertised the app is a
 * dead-end approval. `off` stays off — an operator who disabled widgets has
 * no interactive surface to attach one to.
 */
function toolCanRequireInteractiveApproval(policy: PolicyConfig, kind: ToolWidgetKind): boolean {
  const canonicalToolsByKind: Partial<Record<ToolWidgetKind, string[]>> = {
    // exec_command and a mutating write_stdin are gated under the canonical
    // "bash" policy key (P0 #1), so the shell widget follows bash's rule.
    shell: ["bash"],
    read: ["read"],
    write: ["write"],
    edit: ["edit", "apply_patch"],
    search: ["grep", "glob"],
    directory: ["ls"],
  };
  const tools = canonicalToolsByKind[kind];
  if (!tools) return false;
  if (tools.some((tool) => (policy.toolRules[tool] ?? policy.defaultMode) === "ask")) return true;
  // Path rules can place a read/ls (and any path-scoped tool) in ask; the
  // pattern cannot be resolved per-descriptor, so any path rule with mode
  // "ask" makes every path-scoped tool potentially interactive.
  return policy.pathRules.some((rule) => rule.mode === "ask");
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (config.widgets === "changes" && toolCanRequireInteractiveApproval(config.policy, kind)) {
    return {
      _meta: workspaceAppToolMeta(["model"]) as unknown as ToolDefinitionMeta,
    };
  }
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  return {
    _meta: workspaceAppToolMeta(["model"]) as unknown as ToolDefinitionMeta,
  };
}

const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
} as const;

const serverInstructionCache = new Map<string, string>();

// P1 #42: SDK internal-hook usage is isolated in mcp-tool-list-cache.ts.
const toolListDescriptorCache = new Map<string, Promise<unknown>>();
let toolListDescriptorCacheActive = false;

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

function serverInstructions(config: ServerConfig): string {
  const showChangesInstruction =
    config.widgets === "changes"
      ? " If you successfully create, edit, overwrite, delete, move, or apply patches to files in a turn, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual change; do not skip it because individual file-change tools already returned diffs."
      : "";

  if (config.toolMode === "codex") {
    return `Use Kontrol as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree and reuse its workspaceId. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for direct structured inspection; use apply_patch for modifications, exec_command for tests/builds/other commands, and write_stdin to poll running processes. Review, diagnosis, architecture, and code-edit requests go directly through the workspace first. Delegate only when the reviewer explicitly asks for bounded worker assistance: call discover_agents, dispatch only a currently dispatchable healthy role=agent peer, and if optional assistance is unavailable continue directly without trying an alternate ACP route. The WebUI reviewer remains the approval authority. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${showChangesInstruction}`;
  }

  const inspection = `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";

  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Kontrol loads additional AGENTS.md/CLAUDE.md files lazily from the ancestors of each requested path and returns newly applicable instructions with that tool call. `;

  return `Use Kontrol as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree to obtain a workspaceId. Reuse that same workspaceId for all later file, search, edit, write, show-changes, and shell tools in that folder; do not call ${toolNames.openWorkspace} again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. ${agentsMd}${skills}${inspection}Review, diagnosis, architecture, and code-edit requests go directly through the workspace first. Delegate only when the reviewer explicitly asks for bounded worker assistance: call discover_agents before optional dispatch, select only a currently dispatchable healthy role=agent peer, and if optional assistance is unavailable continue directly without trying an alternate ACP route. The WebUI reviewer remains the approval authority. Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.${showChangesInstruction}`;
}

function cachedServerInstructions(config: ServerConfig): string {
  const key = `${config.toolMode}|${config.widgets}|${config.skillsEnabled ? "skills" : "no-skills"}`;
  const cached = serverInstructionCache.get(key);
  if (cached) return cached;
  const instructions = serverInstructions(config);
  serverInstructionCache.set(key, instructions);
  return instructions;
}
function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    status: z.string().optional(),
    approvalId: z.string().optional(),
    retryable: z.boolean().optional(),
    ...extra,
  };
}

/**
 * Explicit opaque operation-resume identity (audit P1). A caller whose tool
 * call returned approval_required retries with the SAME arguments plus this
 * field set to the approvalId it was shown. The server verifies the echoed
 * operation content against the durable approval row before honoring the
 * original human decision, so a reconnect that lost its conversation
 * correlation can still consume "Approve Once" instead of prompting again.
 */
const approvalResumeIdSchema = z
  .string()
  .optional()
  .describe(
    "Opaque resume token: the approvalId returned in a prior approval_required result. Retry the identical tool call with this field set to consume the human's original decision.",
  );

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

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

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

export function constantTimeStringEqual(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

/**
 * P0.2: a policy-blocked result must remain renderable by the Workspace App.
 * The MCP `_meta.tool`/`_meta.card` envelope is the only contract the app can
 * use (see toolNameFromMeta()/isToolResultCard() in workspace-app.tsx), and it
 * is attached even when isError is true because the UI renders both blocked
 * and approval-pending cards from the same payload.
 */
function policyFailureResponse(
  result: { allowed: boolean; approvalRequired?: boolean; approvalId?: string },
  deniedMessage: string,
  context: {
    tool: "exec_command" | "write_stdin" | "read" | "write" | "edit" | "apply_patch" | "grep" | "glob" | "ls" | "bash";
    workspaceId: string;
    path?: string;
    command?: string;
  },
): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  _meta: { tool: string; card: Record<string, unknown> };
  structuredContent?: Record<string, unknown>;
} {
  if (result.approvalRequired && result.approvalId) {
    const message = `Approval required. Approve ${result.approvalId} in the Kontrol review UI, then retry this exact tool call with approvalResumeId set to ${result.approvalId}. The retry consumes the human decision without prompting again.`;
    const card: Record<string, unknown> = {
      tool: context.tool,
      workspaceId: context.workspaceId,
      status: "approval_required",
      approvalId: result.approvalId,
      resumeArgument: "approvalResumeId",
      retryable: true,
      summary: {
        status: "approval_required",
        approvalId: result.approvalId,
        command: context.command,
      },
      payload: { content: [{ type: "text", text: message }] },
    };
    if (context.path !== undefined) card.path = context.path;
    if (context.command !== undefined) card.command = context.command;
    return {
      content: [{ type: "text", text: message }],
      isError: false,
      _meta: { tool: context.tool, card },
      structuredContent: {
        result: message,
        status: "approval_required",
        approvalId: result.approvalId,
        retryable: true,
        ...(context.tool === "apply_patch" ? { additions: 0, removals: 0, files: [] } : {}),
      },
    };
  }
  const card: Record<string, unknown> = {
    tool: context.tool,
    workspaceId: context.workspaceId,
    status: "policy_denied",
    summary: { status: "policy_denied", command: context.command },
    payload: { content: [{ type: "text", text: deniedMessage }] },
  };
  if (context.path !== undefined) card.path = context.path;
  if (context.command !== undefined) card.command = context.command;
  return {
    content: [{ type: "text", text: deniedMessage }],
    isError: true,
    _meta: { tool: context.tool, card },
    structuredContent: { result: deniedMessage },
  };
}

/**
 * Policy enforcement for tool calls.
 * Returns the policy outcome. Direct MCP calls return approval_required
 * immediately; controlled ACP invocations may retain blocking semantics.
 *
 * Uses the shared enforcer so MCP and ACP share one code path, and records
 * approvals under the CANONICAL policy key (never a reconstructed key).
 */
async function enforceToolPolicy(
  workSessions: ReturnType<typeof createWorkSessionManager> | undefined,
  enforcer: PolicyEnforcer,
  workspaceId: string,
  workSessionId: string | undefined,
  runId: string | undefined,
  tool: string,
  path: PolicyInvocation["path"],
  command: string | undefined,
  paths?: PolicyInvocation["paths"],
  approvalResumeId?: string,
): Promise<{ allowed: boolean; approvalRequired?: boolean; approvalId?: string }> {
  if (workSessions && workSessionId) {
    const sessionDecision = authorizeWorkSessionAction(workSessions, {
      workSessionId,
      tool,
      path: typeof path === "string" ? path : path?.relativePath,
      command,
    });
    if (!sessionDecision.allowed) return { allowed: false };
  }
  const result = await enforcer.enforce({
    principalId: workSessionId ?? workspaceId,
    principalRole: workSessionId ? "worker" : "client",
    workspaceId,
    workSessionId,
    runId,
    tool,
    path,
    paths,
    command,
    signal: currentMcpRequestSignal(),
    mcpSessionId: currentMcpRequestContext()?.mcpSessionId,
    mcpRequestId: currentMcpRequestContext()?.mcpRequestId,
    onPolicyWaitStart: currentMcpRequestContext()?.onPolicyWaitStart,
    onPolicyWaitEnd: currentMcpRequestContext()?.onPolicyWaitEnd,
    // A direct MCP operation has no durable worker lifecycle to hold open, so
    // return approval_required immediately. Calls bound to a work session are
    // controlled worker operations and retain ACP-style blocking semantics.
    blockingApproval: Boolean(workSessionId),
    conversationId: currentMcpRequestContext()?.conversationId,
    approvalCorrelationId: currentMcpRequestContext()?.approvalCorrelationId,
    // Explicit opaque operation-resume identity: when a retrying caller
    // echoes the approvalId from its approval_required card, verified
    // content adopts the original durable operation instead of prompting
    // again under a new reconnect fingerprint.
    approvalResumeId,
  });
  return result;
}

/**
 * Build the only path representation that may enter policy evaluation from an
 * MCP filesystem action. The lexical user path is retained only as the
 * relative display form; the absolute form has already passed workspace
 * resolution and symlink checks.
 */
function canonicalPolicyPath(
  workspaceRoot: string,
  inputPath: string | undefined,
  resolvedPath?: string,
): NonNullable<PolicyInvocation["path"]> {
  const absolutePath = resolve(resolvedPath ?? workspaceRoot, resolvedPath ? "." : (inputPath ?? "."));
  const relativePath = isPathInsideRoot(absolutePath, workspaceRoot)
    ? (relative(workspaceRoot, absolutePath).split(sep).join("/") || ".")
    : (inputPath ?? absolutePath).replaceAll("\\", "/");
  return { relativePath, absolutePath };
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
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

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.string().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  });
}

function processToolResponse(
  tool: "exec_command" | "write_stdin",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: { ...summary, ...outputSummary },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
    },
  };
}

/**
 * P0 #6: a dispatched worker is cryptographically bound to exactly one signed
 * work session, which lives inside exactly one workspace. It must never operate
 * on a different workspace — cross-workspace worker access defeats the
 * correlation/credential contract. Enforced only when the connection is a
 * verified worker with a bound session; ordinary clients and reviewers are
 * unrestricted here (their tools are role-gated separately).
 */
function assertWorkerWorkspaceBinding(
  connectionContext: ConnectionContext | undefined,
  workSessions: WorkSessionManager | undefined,
  workspaceId: string,
): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
  if (connectionContext?.authenticatedRole === "worker" && connectionContext.workSessionId && workSessions) {
    const session = workSessions.get(connectionContext.workSessionId);
    const allowed = session?.workspaceSessionId;
    if (allowed && workspaceId !== allowed) {
      return {
        content: [{ type: "text" as const, text: "Forbidden: worker is bound to a different workspace than the requested one." }],
        isError: true,
      };
    }
  }
  return null;
}

function registerCodexProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
  workSessions?: ReturnType<typeof createWorkSessionManager>,
  policyEnforcer?: import("./policy-enforcement.js").PolicyEnforcer,
  policyEngine?: PolicyEngine,
  connectionContext?: ConnectionContext,
  prepareForMutation?: (workspaceId: string) => Promise<void>,
): void {
  registerAppTool(
    server,
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a command inside an open workspace. Returns its result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Use this for file inspection, tests, builds, package scripts, and long-running processes. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        cmd: z.string().min(1).describe("Shell command to execute."),
        approvalResumeId: approvalResumeIdSchema,
        tty: z
          .boolean()
          .optional()
          .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory relative to the workspace root. Defaults to the workspace root."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait before returning a running session. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, cmd, approvalResumeId, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      await prepareForMutation?.(workspaceId);
      const workspace = workspaces.getWorkspace(workspaceId);
      const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
      if (bindingErr) return bindingErr;
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const policyPath = canonicalPolicyPath(workspace.root, workingDirectory, cwd);

      // Policy enforcement (P0 #3): Codex exec_command is a run_commands action
      // and must be gated exactly like the ordinary `bash` tool.
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          // P0 #1: canonical policy name — exec_command is gated as "bash".
          "bash",
          policyPath,
          cmd,
          undefined,
          approvalResumeId,
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "exec_command" denied by policy. Command: ${cmd}`, {
            tool: "exec_command",
            workspaceId,
            path: typeof policyPath === "string" ? policyPath : policyPath?.relativePath,
            command: cmd,
          });
        }
      }

      const snapshot = await processSessions.start({
        workspaceId,
        ownerId: processSessionOwnerId(connectionContext),
        workSessionId: connectionContext?.workSessionId,
        command: cmd,
        cwd,
        tty,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "exec_command",
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: cmd,
        commandLength: cmd.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("exec_command", workspaceId, snapshot, {
        command: cmd,
        workingDirectory: workingDirectory ?? ".",
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  registerAppTool(
    server,
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.string().describe("Opaque process session identifier returned by exec_command."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        approvalResumeId: approvalResumeIdSchema,
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait for process output or completion. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, chars, approvalResumeId, columns, rows, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const hasInput = Boolean(chars && chars.length > 0);
      // Writing input to a process can mutate the workspace via that process;
      // gate it behind the baseline like exec_command. Outline-free poll stays fast.
      if (hasInput) await prepareForMutation?.(workspaceId);
      workspaces.getWorkspace(workspaceId);
      const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
      if (bindingErr) return bindingErr;

      // Policy enforcement (P0 #3): writing NONEMPTY input to a process is a
      // run_commands action and must be gated. A poll-only write_stdin (no
      // chars / empty string) cannot alter process state, so it stays a
      // read/wait operation and is not gated.
      if (hasInput && policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          // P0 #1: a mutating write_stdin is a run_commands action. Pass the
          // CANONICAL policy name ("bash") so it is gated by exactly the same
          // rule as exec_command and the bash tool — never an alias.
          "bash",
          undefined,
          chars,
          undefined,
          approvalResumeId,
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "write_stdin" denied by policy: cannot send input to a gated process.`, {
            tool: "write_stdin",
            workspaceId,
            command: chars,
          });
        }
      }

      const snapshot = await processSessions.write({
        workspaceId,
        sessionId,
        ownerId: processSessionOwnerId(connectionContext),
        workSessionId: connectionContext?.workSessionId,
        chars,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "write_stdin",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("write_stdin", workspaceId, snapshot, {
        sessionId,
        charactersWritten: chars?.length ?? 0,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );
}

/**
 * Work-session attribution envelope bound to a single MCP connection. Tool
 * activity is attributed to the work session named here, NOT to the workspace's
 * mutable "currently active" session. This prevents concurrent CRUSH processes
 * sharing a workspace from overwriting each other's attribution.
 */
interface ConnectionContext {
  /**
   * The role authenticated for this connection. A successfully-verified signed
   * worker token yields "worker"; otherwise the connection is treated as a
   * reviewer/client. AUTHORIZATION MUST derive from this field — never from the
   * unsigned attribution headers (P0 #3). The unsigned headers below are for
   * logging/attribution only and grant no privileges.
   */
  authenticatedRole?: "worker" | "reviewer" | "client";
  authSource?: "oauth" | "reviewer_token" | "worker_token" | "tunnel_reviewer" | "anonymous";
  /** Authenticated principal for durable client mutation identities. */
  authenticatedPrincipalId?: string;
  workspaceSessionId?: string;
  workSessionId?: string;
  runId?: string;
  continuationId?: string;
  /** Checkout lease nonce issued for the bound worker work session. */
  workspaceLeaseNonce?: string;
  /** Transport identity, never shared across MCP sessions. */
  mcpSessionId?: string;
  /** Human-readable diagnostic label for this isolated transport. */
  mcpSessionLabel?: string;
  /** Optional upstream conversation correlation; not an authorization key. */
  conversationId?: string;
  /** Stable trusted identity used only for reconnecting one approval operation. */
  approvalCorrelationId?: string;
}

/**
 * Direct process sessions normally belong to the transport that opened them,
 * but a trusted reconnect identity or durable work session can outlive one
 * MCP transport. Generic clientInfo fallback remains deliberately ephemeral.
 */
function processSessionOwnerId(context?: ConnectionContext): string | undefined {
  if (context?.workSessionId) return `work-session:${context.workSessionId}`;
  if (context?.approvalCorrelationId) return `logical-client:${context.approvalCorrelationId}`;
  return context?.mcpSessionId;
}

function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  workSessions?: ReturnType<typeof createWorkSessionManager>,
  agentRegistry?: import("./acp-registry.js").AgentRegistryManager,
  eventStore?: import("./event-log.js").EventStore,
  continuationManager?: import("./continuation.js").ContinuationManager,
  dispatchOutbox?: import("./dispatch-outbox.js").DispatchOutbox,
  policyEngine?: PolicyEngine,
  policyEnforcer?: import("./policy-enforcement.js").PolicyEnforcer,
  approvalRequests?: ReturnType<typeof createApprovalRequestManager>,
  missionLedger?: ReturnType<typeof createMissionLedger>,
  connectionContext?: ConnectionContext,
  reviewWorkflow?: ReviewWorkflowService,
  liveWaiters?: LiveWaiterRegistry,
  agentMessages?: ReturnType<typeof createAgentMessageManager>,
  supervisorRuns?: ReturnType<typeof createSupervisorRuns>,
  onSupervisorResume?: (workSessionId: string) => void,
  db?: DatabaseHandle,
  mutationReceipts?: MutationReceiptStore,
  onWorkspaceAppResource?: (uri: string) => void,
  onPhaseTiming?: (phase: string, durationMs: number) => void,
): McpServer {
  const serverConstructionStartedAt = performance.now();
  const server = new McpServer(
    {
      name: "kontrol",
      title: "Kontrol",
      // P1 #26: runtime version derives from the package manifest so the MCP
      // surface can never advertise an independent hardcoded version.
      version: readPackageVersion(),
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: cachedServerInstructions(config),
    },
  );
  onPhaseTiming?.("mcp.server_construction", performance.now() - serverConstructionStartedAt);
  const toolRegistrationStartedAt = performance.now();
  const mutationPrincipalId = connectionContext?.authenticatedPrincipalId
    || `${connectionContext?.authSource ?? "anonymous"}:${connectionContext?.authenticatedRole ?? "client"}`;

  function trackToolEvent(
    workspaceId: string,
    tool: string,
    input: Record<string, unknown>,
    result: { content: ToolContent[]; isError?: boolean },
    startedAt: number,
  ): void {
    if (!workSessions || !config.acpEnabled || !eventStore) return;
    try {
      // Attribution is part of the execution envelope: prefer the work session
      // bound to THIS MCP connection, falling back to the workspace's "currently
      // active" session only for non-delegated (direct) tool calls.
      const workSessionId =
        connectionContext?.workSessionId ?? workspaces.getWorkspace(workspaceId).currentWorkSessionId;
      if (!workSessionId) return;

      const session = workSessions.get(workSessionId);
      if (!session) {
        throw new Error("Bound work session does not exist");
      }
      if (session.workspaceSessionId !== workspaceId) {
        throw new Error("Work session does not belong to this workspace");
      }

      workSessions.logToolEvent({
        workSessionId,
        workspaceSessionId: workspaceId,
        tool,
        inputJson: JSON.stringify(input),
        outputSummary: contentText(result.content).slice(0, 2000),
        path: typeof input.path === "string" ? input.path : undefined,
        success: !result.isError,
        elapsedMs: Math.round(performance.now() - startedAt),
      });

      // Append to the durable event log so subscribers (WebUI watcher) react
      // without polling. The projection (work_session_tool_events) is for
      // query/history; the event log is what drives the UI.
      eventStore.appendEvent({
        type: result.isError ? "agent.tool.failed" : "agent.tool.completed",
        sessionId: workSessionId,
        payload: {
          runId: connectionContext?.runId,
          mcpSessionId: connectionContext?.mcpSessionId,
          mcpSessionLabel: connectionContext?.mcpSessionLabel,
          conversationId: connectionContext?.conversationId,
          tool,
          path: typeof input.path === "string" ? input.path : undefined,
          input,
          outputSummary: contentText(result.content).slice(0, 2000),
          success: !result.isError,
          elapsedMs: Math.round(performance.now() - startedAt),
        },
      });
    } catch (error) {
      // P1 #25: session tracking is non-critical and must never fail the
      // user's tool call, but persistent audit degradation must be visible.
      recordDegradedAudit("work_session_tool_event", error);
    }
  }

  // P0 #3: Centralized mutation preflight. Every mutation-capable tool (write,
  // edit, apply_patch, exec_command/bash, write_stdin) awaits the workspace's
  // initial filesystem baseline through this single choke point, so a mutation
  // can never race the background baseline capture and escape the review
  // boundary. Reads may proceed immediately.
  async function prepareForMutation(workspaceId: string): Promise<void> {
    if (!config.widgets || config.widgets === "off") return;
    const workspace = workspaces.getWorkspace(workspaceId);
    try {
      await reviewCheckpoints.awaitWorkspaceReady({ workspaceId, root: workspace.root });
    } catch (error) {
      // A permanently-ineligible workspace (no git, capture failure) must not
      // silently block mutations; log and let the mutation proceed, since there
      // is no baseline to race. Real readiness errors surface at open_workspace.
      logEvent(config.logging, "warn", "checkpoint_ready_barrier_failed", {
        workspaceId,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  registerAppResource(
    server,
    "Kontrol Workspace App",
    WORKSPACE_APP_URI,
    {
      description: "Interactive Kontrol workspace and review interface.",
      _meta: workspaceAppResourceMeta(),
    },
    async () => {
      onWorkspaceAppResource?.(WORKSPACE_APP_URI);
      logEvent(config.logging, "info", "workspace_app_resource_served", {
        uri: WORKSPACE_APP_URI,
        buildId: WORKSPACE_APP_BUILD_ID,
        mimeType: RESOURCE_MIME_TYPE,
        bytes: Buffer.byteLength(WORKSPACE_APP_HTML, "utf8"),
      });
      return { contents: [{ uri: WORKSPACE_APP_URI, mimeType: RESOURCE_MIME_TYPE, text: WORKSPACE_APP_HTML, _meta: workspaceAppResourceMeta() }] };
    },
  );
  // Existing ChatGPT cards already cache the original URI under OpenAI's
  // output-template key. Serve its legacy representation so Retry can repair
  // those cards; new MCP Apps use the content-hashed standards URI above.
  server.registerResource(
    "Kontrol Workspace App (legacy)",
    LEGACY_WORKSPACE_APP_URI,
    { mimeType: "text/html+skybridge", description: "Legacy ChatGPT template." },
    async () => {
      onWorkspaceAppResource?.(LEGACY_WORKSPACE_APP_URI);
      logEvent(config.logging, "info", "workspace_app_resource_served", {
        uri: LEGACY_WORKSPACE_APP_URI,
        buildId: WORKSPACE_APP_BUILD_ID,
        mimeType: "text/html+skybridge",
        bytes: Buffer.byteLength(WORKSPACE_APP_HTML, "utf8"),
      });
      return { contents: [{ uri: LEGACY_WORKSPACE_APP_URI, mimeType: "text/html+skybridge", text: WORKSPACE_APP_HTML }] };
    },
  );
  server.registerResource(
    "Kontrol Workspace App (OpenAI compatibility)",
    OPENAI_WORKSPACE_APP_URI,
    { mimeType: "text/html+skybridge", description: "OpenAI compatibility template." },
    async () => {
      onWorkspaceAppResource?.(OPENAI_WORKSPACE_APP_URI);
      logEvent(config.logging, "info", "workspace_app_resource_served", {
        uri: OPENAI_WORKSPACE_APP_URI,
        buildId: WORKSPACE_APP_BUILD_ID,
        mimeType: "text/html+skybridge",
        bytes: Buffer.byteLength(WORKSPACE_APP_HTML, "utf8"),
      });
      return { contents: [{ uri: OPENAI_WORKSPACE_APP_URI, mimeType: "text/html+skybridge", text: WORKSPACE_APP_HTML }] };
    },
  );
  server.registerResource(
    "Kontrol Workspace App (DevDesktop migration)",
    DEVDESKTOP_WORKSPACE_APP_URI,
    { mimeType: "text/html+skybridge", description: "Compatibility template for cached DevDesktop cards." },
    async () => {
      onWorkspaceAppResource?.(DEVDESKTOP_WORKSPACE_APP_URI);
      logEvent(config.logging, "info", "workspace_app_resource_served", {
        uri: DEVDESKTOP_WORKSPACE_APP_URI,
        buildId: WORKSPACE_APP_BUILD_ID,
        mimeType: "text/html+skybridge",
        bytes: Buffer.byteLength(WORKSPACE_APP_HTML, "utf8"),
      });
      return { contents: [{ uri: DEVDESKTOP_WORKSPACE_APP_URI, mimeType: "text/html+skybridge", text: WORKSPACE_APP_HTML }] };
    },
  );

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open a local project directory as a coding workspace. Call this once per project folder or worktree before reading, editing, searching, writing, showing changes, or running commands. Reuse the returned workspaceId for later calls in the same folder; do not call open_workspace again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. By default this opens the actual checkout; set mode=\"worktree\" when the user asks for an isolated or parallel coding session. Ordinary non-Git directories are valid checkout workspaces and use filesystem change tracking; only managed worktrees require Git. Review and code-edit work stays direct in the workspace; optional ACP delegation follows discover_agents and healthy-agent checks. Returns the workspace capabilities and project instructions.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a local project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout. Use checkout to work in the actual directory. Use worktree to create an isolated managed Git worktree for parallel work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        workspaceKind: z.enum(["checkout", "worktree"]),
        versionControl: z.enum(["git", "none", "unknown"]),
        checkpointBackend: z.enum(["git", "filesystem", "unavailable"]),
        capabilities: z.object({
          read: z.boolean(),
          search: z.boolean(),
          edit: z.boolean(),
          changeTracking: z.boolean(),
          managedWorktree: z.boolean(),
        }),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema),
        skills: z.array(workspaceSkillOutputSchema),
        skillDiagnostics: z.array(z.unknown()),
        instruction: z.string(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace"),
      // checkout opening initializes workspace/checkpoint state, and
      // mode="worktree" creates a managed Git worktree. This combined
      // operation therefore has a real side effect even when the default
      // checkout path only reads project files.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ path, mode, baseRef }) => {
      const startedAt = performance.now();
      const { workspace, agentsFiles, availableAgentsFiles } = await workspaces.openWorkspace({ path, mode, baseRef });
      const gitEligibility = await getGitEligibility(workspace.root);
      const workspaceKind = workspace.mode;
      const versionControl = gitEligibility.ok ? "git" : "none";
      const checkpointBackend = gitEligibility.ok ? "git" : "filesystem";
      if (config.widgets === "changes") {
        void reviewCheckpoints.initializeWorkspace({
          workspaceId: workspace.id,
          root: workspace.root,
        });
      }
      const visibleSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const loadedAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const instruction = config.skillsEnabled
        ? "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Nested instructions are loaded automatically when later tools enter their directory. Review, diagnosis, architecture, and code-edit requests go directly through this workspace first. Delegate only when the reviewer explicitly asks for bounded assistance: call discover_agents, use only a currently dispatchable healthy role=agent peer, and if optional assistance is unavailable continue directly without an alternate ACP route. The WebUI reviewer remains the approval authority. When a task matches an available skill in skills, read its path before proceeding. For skills not listed here, use the search_skills tool to discover global skills by keyword."
        : "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Nested instructions are loaded automatically when later tools enter their directory. Review, diagnosis, architecture, and code-edit requests go directly through this workspace first. Delegate only when the reviewer explicitly asks for bounded assistance: call discover_agents, use only a currently dispatchable healthy role=agent peer, and if optional assistance is unavailable continue directly without an alternate ACP route. The WebUI reviewer remains the approval authority.";
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            `Opened workspace ${workspace.id}`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            `Version control: ${versionControl}; checkpoint backend: ${checkpointBackend}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            summary: {
              agentsFiles: loadedAgentsFiles.length,
              availableAgentsFiles: availableAgentsFileOutputs.length,
              skills: visibleSkills.length,
              skillDiagnostics: workspace.skillDiagnostics.length,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          workspaceKind,
          versionControl,
          checkpointBackend,
          capabilities: {
            read: true,
            search: true,
            edit: true,
            changeTracking: true,
            managedWorktree: workspace.mode === "worktree",
          },
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          agentsFiles: loadedAgentsFiles,
          availableAgentsFiles: availableAgentsFileOutputs,
          skills: visibleSkills,
          skillDiagnostics: workspace.skillDiagnostics,
          instruction,
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read a file inside an open workspace. Use this for file inspection instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
        approvalResumeId: approvalResumeIdSchema,
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          toolNames.read,
          canonicalPolicyPath(workspace.root, input.path, readPath.absolutePath),
          undefined,
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.read}" denied by policy. Path: ${input.path}`, {
            tool: toolNames.read,
            workspaceId,
            path: input.path,
          });
        }
      }
      const newlyApplicable = readPath.skillRead
        ? []
        : await workspaces.loadApplicableInstructions(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      const instructionNotice = newlyApplicable.length > 0
        ? textBlock(`Newly applicable instructions loaded: ${newlyApplicable.map((file) => formatAgentsPath(file.path, workspace.root)).join(", ")}`)
        : undefined;
      const responseContent = instructionNotice ? [instructionNotice, ...response.content] : response.content;
      const responseForOutput = instructionNotice ? { ...response, content: responseContent } : response;
      const summary = {
        ...textSummary(responseContent),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      trackToolEvent(workspaceId, toolNames.read, input, responseForOutput, startedAt);

      return {
        ...responseForOutput,
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: responseContent },
          },
        },
        structuredContent: {
          result: contentText(responseContent),
        },
      };
    },
  );

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description:
        `Create or completely overwrite a file inside an open workspace. Prefer ${toolNames.edit} for targeted changes to existing files. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
        approvalResumeId: approvalResumeIdSchema,
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      await prepareForMutation(workspaceId);
      const workspace = workspaces.getWorkspace(workspaceId);
      const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
      if (bindingErr) return bindingErr;
      const resolvedPath = workspaces.resolvePath(workspace, input.path);
      const policyPath = canonicalPolicyPath(workspace.root, input.path, resolvedPath);

      // Policy enforcement for file writes
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          toolNames.write,
          policyPath,
          undefined,
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.write}" denied by policy. Path: ${input.path}`, {
            tool: toolNames.write,
            workspaceId,
            path: input.path,
          });
        }
      }

      await workspaces.loadApplicableInstructions(workspace, input.path);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      trackToolEvent(workspaceId, toolNames.write, input, response, startedAt);

      return {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description:
        `Edit one file inside an open workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
        approvalResumeId: approvalResumeIdSchema,
      },
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      await prepareForMutation(workspaceId);
      const workspace = workspaces.getWorkspace(workspaceId);
      const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
      if (bindingErr) return bindingErr;
      const resolvedPath = workspaces.resolvePath(workspace, input.path);
      const policyPath = canonicalPolicyPath(workspace.root, input.path, resolvedPath);

      // Policy enforcement for file edits
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          toolNames.edit,
          policyPath,
          undefined,
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.edit}" denied by policy. Path: ${input.path}`, {
            tool: toolNames.edit,
            workspaceId,
            path: input.path,
          });
        }
      }

      await workspaces.loadApplicableInstructions(workspace, input.path);
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      trackToolEvent(workspaceId, toolNames.edit, { ...input, path: input.path }, response, startedAt);

      return {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    registerAppTool(
      server,
      "apply_patch",
      {
        title: "Apply patch",
        description:
          "Apply one Codex-style patch inside an open workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          patch: z
            .string()
            .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
          approvalResumeId: approvalResumeIdSchema,
        },
        outputSchema: resultOutputSchema({
          additions: z.number(),
          removals: z.number(),
          files: z.array(
            z.object({
              path: z.string(),
              previousPath: z.string().optional(),
              operation: z.enum(["add", "update", "delete", "move"]),
            }),
          ),
        }),
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, patch, approvalResumeId }) => {
        const startedAt = performance.now();
        await prepareForMutation(workspaceId);
        const workspace = workspaces.getWorkspace(workspaceId);
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
        const actions = parsePatch(patch) as Array<{ path: string; moveTo?: string }>;
        const affectedPaths = actions.flatMap((action) => [action.path, action.moveTo].filter((path): path is string => Boolean(path)));
        const policyPaths = affectedPaths.map((path) => canonicalPolicyPath(
          workspace.root,
          path,
          workspaces.resolvePath(workspace, path),
        ));

        // Policy enforcement (P0 #3): Codex apply_patch is an edit_files action
        // and must be gated exactly like the ordinary `write`/`edit` tools.
        if (policyEnforcer && policyEngine) {
          const approved = await enforceToolPolicy(
            workSessions,
            policyEnforcer,
            workspaceId,
            connectionContext?.workSessionId,
            connectionContext?.runId,
            "apply_patch",
            undefined,
            undefined,
            policyPaths,
            approvalResumeId,
          );
          if (!approved.allowed) {
            return policyFailureResponse(approved, `Tool "apply_patch" denied by policy.`, {
              tool: "apply_patch",
              workspaceId,
              path: affectedPaths[0],
            });
          }
        }

        // Load instructions for every path named by the patch before any file
        // is changed. parsePatch is validation-only; applyPatch revalidates all
        // confined destinations immediately before staging/rename.
        for (const action of actions) {
          await workspaces.loadApplicableInstructions(workspace, action.path);
          if (action.moveTo) await workspaces.loadApplicableInstructions(workspace, action.moveTo);
        }
        const applied = await applyPatch(workspace.root, patch);
        const paths = applied.files.map((file) => file.path).join(", ");
        const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
        const content = [textBlock(result)];
        const displayPath = applied.files.length === 1
          ? applied.files[0]?.path
          : `${applied.files.length} files`;

        logToolCall(config, {
          tool: "apply_patch",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        trackToolEvent(workspaceId, "apply_patch", { patch: patch.slice(0, 500) }, { content, isError: false }, startedAt);

        return {
          content,
          _meta: {
            tool: "apply_patch",
            card: {
              workspaceId,
              path: displayPath,
              summary: {
                files: applied.files.length,
                additions: applied.additions,
                removals: applied.removals,
              },
              payload: { patch: applied.patch },
            },
          },
          structuredContent: {
            result,
            additions: applied.additions,
            removals: applied.removals,
            files: applied.files,
          },
        };
      },
    );
  }

  if (config.widgets === "changes") {
    registerAppTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description:
          "Show aggregate changes for an open workspace using its available checkpoint backend. Git is optional: ordinary directories use content-addressed filesystem snapshots. After the final successful edit, write, or apply_patch call in the current turn, call this exactly once before the final response so the user can inspect the combined change set.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          since: z
            .enum(["last_shown", "workspace_open"])
            .optional()
            .describe("Defaults to last_shown, which is correct for normal end-of-turn review. Use workspace_open only when the user asks to review all changes since opening the workspace."),
          markReviewed: z
            .boolean()
            .optional()
            .describe("Defaults to true. When true, advances the last shown checkpoint to the current workspace state."),
        },
        outputSchema: resultOutputSchema({
          snapshotKind: z.enum(["git", "filesystem"]).optional(),
          snapshotRef: z.string().optional(),
        }),
        ...toolWidgetDescriptorMeta(config, "show_changes"),
        // The default markReviewed=true advances the workspace checkpoint.
        // Keep the existing end-of-turn acknowledgement behavior, but do not
        // advertise this state-changing operation as read-only to MCP hosts.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async ({ workspaceId, since, markReviewed }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId,
          root: workspace.root,
          since: since ?? "last_shown",
          markReviewed: markReviewed ?? true,
        });

        const content = [textBlock(review.result)];
        logToolCall(config, {
          tool: "show_changes",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        trackToolEvent(workspaceId, "show_changes", { since, markReviewed }, { content, isError: false }, startedAt);

        return {
          content,
          _meta: {
            tool: "show_changes",
            card: {
              workspaceId,
              summary: review.summary,
              files: review.files,
              payload: {
                patch: review.patch,
              },
            },
          },
          structuredContent: {
            result: contentText(content),
            snapshotKind: review.snapshotKind,
            snapshotRef: review.snapshotRef,
          },
        };
      },
    );
  }

  // Structured read-only discovery is part of the public surface in every
  // tool mode. Codex mode adds process-oriented tools but does not hide these
  // stable inspection primitives.
  {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: "Grep",
        description:
          "Search file contents inside an open workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("Search pattern."),
          approvalResumeId: approvalResumeIdSchema,
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root.",
            ),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
        const policyPath = input.path
          ? canonicalPolicyPath(workspace.root, input.path, workspaces.resolvePath(workspace, input.path))
          : undefined;
        if (policyEnforcer && policyEngine) {
          const approved = await enforceToolPolicy(
            workSessions,
            policyEnforcer,
            workspaceId,
            connectionContext?.workSessionId,
            connectionContext?.runId,
            toolNames.grep,
            policyPath,
            undefined,
          );
          if (!approved.allowed) {
            return policyFailureResponse(approved, `Tool "${toolNames.grep}" denied by policy.`, {
              tool: toolNames.grep,
              workspaceId,
              path: input.path,
            });
          }
        }
        if (input.path) await workspaces.loadApplicableInstructions(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.grep,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.glob,
      {
        title: "Glob",
        description:
          "Find files by glob pattern inside an open workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("File glob pattern."),
          approvalResumeId: approvalResumeIdSchema,
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
        const policyPath = input.path
          ? canonicalPolicyPath(workspace.root, input.path, workspaces.resolvePath(workspace, input.path))
          : undefined;
        if (policyEnforcer && policyEngine) {
          const approved = await enforceToolPolicy(
            workSessions,
            policyEnforcer,
            workspaceId,
            connectionContext?.workSessionId,
            connectionContext?.runId,
            toolNames.glob,
            policyPath,
            undefined,
          );
          if (!approved.allowed) {
            return policyFailureResponse(approved, `Tool "${toolNames.glob}" denied by policy.`, {
              tool: toolNames.glob,
              workspaceId,
              path: input.path,
            });
          }
        }
        if (input.path) await workspaces.loadApplicableInstructions(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.glob,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.ls,
      {
        title: "Ls",
        description:
          "List a directory inside an open workspace. Use this for directory inspection before reading files. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
          approvalResumeId: approvalResumeIdSchema,
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
        const resolvedPath = workspaces.resolvePath(workspace, input.path);
        const policyPath = canonicalPolicyPath(workspace.root, input.path, resolvedPath);
        if (policyEnforcer && policyEngine) {
          const approved = await enforceToolPolicy(
            workSessions,
            policyEnforcer,
            workspaceId,
            connectionContext?.workSessionId,
            connectionContext?.runId,
            toolNames.ls,
            policyPath,
            undefined,
          );
          if (!approved.allowed) {
            return policyFailureResponse(approved, `Tool "${toolNames.ls}" denied by policy. Path: ${input.path}`, {
              tool: toolNames.ls,
              workspaceId,
              path: input.path,
            });
          }
        }
        await workspaces.loadApplicableInstructions(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = textSummary(response.content);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.ls,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );
  }

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.shell,
    {
      title: "Bash",
      description: `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for repository inspection; do not use shell parsing to replace those structured read-only tools. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        command: z
          .string()
          .describe(
            `Shell command to run. Must not create or modify project files; use ${toolNames.edit} or ${toolNames.write} for file changes.`,
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
        approvalResumeId: approvalResumeIdSchema,
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
      if (bindingErr) return bindingErr;
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const policyPath = canonicalPolicyPath(workspace.root, workingDirectory, cwd);

      // Policy enforcement: block until human approval if required
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          toolNames.shell,
          policyPath,
          input.command,
          undefined,
          input.approvalResumeId,
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.shell}" denied by policy. Command: ${input.command}`, {
            tool: toolNames.shell,
            workspaceId,
            path: typeof policyPath === "string" ? policyPath : policyPath?.relativePath,
            command: input.command,
          });
        }
      }

      if (workingDirectory) await workspaces.loadApplicableInstructions(workspace, workingDirectory);
      const response = await runShellTool(input, {
        cwd,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: input.command,
          commandLength: input.command.length,
        }, response.content, startedAt);
        return response;
      }

      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      trackToolEvent(workspaceId, toolNames.shell, input, response, startedAt);

      return {
        ...response,
        _meta: {
          tool: toolNames.shell,
          card: {
            workspaceId,
            path: workingDirectory,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    registerCodexProcessTools(server, config, workspaces, processSessions, workSessions, policyEnforcer, policyEngine, connectionContext, prepareForMutation);
  }

  // Policy approval tools — available whenever policy engine is configured.
  // The MCP /mcp surface is reached by the WebUI (reviewer) and ordinary
  // clients, NOT by the worker (the worker reaches Kontrol through the
  // stdio bridge, which hides these tools). Mark the caller as a reviewer so
  // provide_policy_approval is permitted here.
  if (policyEngine && eventStore) {
    registerPolicyTools(server, {
      eventStore,
      policyEngine,
      approvalRequests,
      principalRole: connectionContext?.authenticatedRole ?? "client",
      principalId: mutationPrincipalId,
      mutationReceipts,
    });
  }

  if (workSessions && config.acpEnabled && eventStore && reviewWorkflow && liveWaiters) {
    const bridgeConfig: Parameters<typeof registerBridgeTools>[1] = {
      db,
      workspaces,
      workSessions,
      reviewCheckpoints,
      agentRegistry: agentRegistry!,
      eventStore,
      continuationManager: continuationManager!,
      dispatchOutbox,
      reviewWorkflow,
      missionLedger,
      supervisorRuns,
      onSupervisorResume,
      agentMessages,
      approvalRequests,
      knownAgents: config.acpKnownAgents,
      adapterSecret: config.acpAdapterSecret,
      // P1 #10: pass server config to bridge so search_skills has access to skill paths.
      serverConfig: config,
      // Role is derived from the AUTHENTICATED envelope only. A connection is a
      // WORKER solely when a signed worker token verified (see
      // connectionContext.authenticatedRole); an ordinary MCP client is
      // "client". Reviewer authority requires the separate reviewer credential.
      // This lets the SAME bridge tool set enforce
      // reviewer-only vs worker-only server-side without registering the tools
      // twice — and crucially, a caller cannot gain worker rights by sending an
      // unsigned X-Kontrol-Work-Session header (P0 #3).
      principalRole: connectionContext?.authenticatedRole ?? "client",
      principalId: mutationPrincipalId,
      mutationReceipts,
      connectionContinuationId: connectionContext?.continuationId,
      connectionWorkSessionId: connectionContext?.workSessionId,
      connectionWorkspaceLeaseNonce: connectionContext?.workspaceLeaseNonce,
      liveWaiters,
      onPhaseTiming,
    };
    registerBridgeTools(server, bridgeConfig);
  }

  toolListDescriptorCacheActive = installCachedToolList(
    server,
    `${config.toolMode}|${config.widgets}|${config.skillsEnabled ? "skills" : "no-skills"}|${config.acpEnabled ? "acp" : "no-acp"}|${policyEngine ? "policy" : "no-policy"}`,
    toolListDescriptorCache,
    ListToolsRequestSchema,
  );
  if (!toolListDescriptorCacheActive) {
    console.warn("[kontrol] tools/list descriptor cache unavailable (SDK internals changed); serving uncached");
  }
  onPhaseTiming?.("mcp.tool_registration", performance.now() - toolRegistrationStartedAt);

  return server;
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

  const reportMaintenanceFailure = (scope: string, error: unknown, fields: Record<string, unknown> = {}) => {
    const detail = error instanceof Error ? error.message : String(error);
    logEvent(config.logging, "error", "maintenance_failure", { scope, detail, ...fields });
    console.error(`[kontrol] maintenance failure (${scope}): ${detail}`);
  };

  // P1 #23: Periodic maintenance loop — event compaction, stale approval
  // reconciliation, and DB checkpoint. Runs every 5 minutes. Compaction is
  // deliberately chunked and yielded between sessions: a large historical
  // telemetry backlog must not monopolize the serving isolate.
  const MAINTENANCE_INTERVAL_MS = config.maintenanceIntervalMs;
  const MAINTENANCE_BUDGET_MS = config.maintenanceBudgetMs;
  const MAINTENANCE_PAGE_SIZE = 100;
  const COMPACT_PAGE_SIZE = 500;
  const COMPACT_BATCH_SIZE = 250;
  let maintenanceStopped = false;
  let maintenanceRunning = false;
  let runtimeReconciliationCursor: string | undefined;
  let compactionCursor: string | undefined;
  const maintenanceStats: {
    running: boolean;
    backlog: boolean;
    cycles: number;
    lastStartedAt?: string;
    lastCompletedAt?: string;
    lastDurationMs: number;
    maxDurationMs: number;
    compactedRows: number;
    pendingMutationReceipts: number;
    lastError?: string;
  } = {
    running: false,
    backlog: false,
    cycles: 0,
    lastDurationMs: 0,
    maxDurationMs: 0,
    compactedRows: 0,
    pendingMutationReceipts: 0,
  };

  // P0 #2: Durable filesystem snapshot roots held in SQLite. A submitted
  // snapshot may no longer be a current baseline yet still be required for
  // approval or immutable mission verification — so GC must root from these
  // tables, not just from the manifest directory.
  const collectFsSnapshotDbRoots = (): Array<{ ref: string; terminal?: boolean }> => {
    if (!db) return [];
    const roots: Array<{ ref: string; terminal?: boolean }> = [];
    try {
      const sqlite = db.sqlite;
      // work_session_submissions, terminal by owning work_session.status.
      const submissions = sqlite.prepare(
        "select wss.snapshot_ref as ref, ws.status as status from work_session_submissions wss left join work_sessions ws on ws.id = wss.work_session_id where wss.snapshot_kind = 'filesystem' and wss.snapshot_ref is not null",
      ).all() as Array<{ ref?: string; status?: string }>;
      for (const row of submissions) {
        if (row.ref) roots.push({ ref: row.ref, terminal: row.status ? terminalWorkSessionStatuses.has(row.status) : undefined });
      }
      // mission_evidence, mission_completion_reports: always strong pins.
      for (const table of ["mission_evidence", "mission_completion_reports"]) {
        const rows = sqlite.prepare(
          `select snapshot_ref as ref from ${table} where snapshot_kind = 'filesystem' and snapshot_ref is not null`,
        ).all() as Array<{ ref?: string }>;
        for (const row of rows) if (row.ref) roots.push({ ref: row.ref });
      }
      // supervisor_runs.last_snapshot_ref.
      const runs = sqlite.prepare(
        "select last_snapshot_ref as ref from supervisor_runs where last_snapshot_kind = 'filesystem' and last_snapshot_ref is not null",
      ).all() as Array<{ ref?: string }>;
      for (const row of runs) if (row.ref) roots.push({ ref: row.ref });
    } catch (error) {
      // A failed DB query must never abort maintenance: report and return an
      // empty root set so only the manifest/baseline roots are honored.
      reportMaintenanceFailure("snapshot_gc_db_roots", error);
    }
    return roots;
  };

  const snapshotGcSlice = async (
    store: FilesystemSnapshotStore,
    budgetMs: number,
    pageSize: number,
  ): Promise<{ result?: unknown; hasMore?: boolean; error?: string }> => {
    try {
      const { result, hasMore } = await store.gcSlice({
        budgetMs,
        pageSize,
        listDbSnapshots: collectFsSnapshotDbRoots,
        dryRun: false,
      });
      return { result, hasMore };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };

  // P1: Drop workspace-session baseline pins whose key is no longer a
  // nonterminal work session (terminal or gone). This is what lets GC actually
  // reclaim the blobs those stale pins were rooting.
  const pruneStaleSessionBaselines = async (): Promise<void> => {
    if (!db) return;
    const store = reviewCheckpoints.getSnapshotStore();
    try {
      const rows = db.sqlite.prepare(
        "select ws.id as work_session_id, ws.status as status, ws.workspace_session_id as wsid from work_sessions ws",
      ).all() as Array<{ work_session_id: string; status: string; wsid: string }>;
      const nonterminalByWorkspace = new Map<string, Set<string>>();
      for (const row of rows) {
        if (row.status && terminalWorkSessionStatuses.has(row.status)) continue;
        let set = nonterminalByWorkspace.get(row.wsid);
        if (!set) {
          set = new Set();
          nonterminalByWorkspace.set(row.wsid, set);
        }
        set.add(row.work_session_id);
      }
      for (const [workspaceId, nonterminal] of nonterminalByWorkspace) {
        await store.pruneSessionBaselines(workspaceId, nonterminal);
      }
    } catch (error) {
      reportMaintenanceFailure("snapshot_gc_prune_pins", error);
    }
  };

  const runMaintenanceCycle = (): void => {
    if (maintenanceStopped || maintenanceRunning) return;
    maintenanceRunning = true;
    maintenanceStats.running = true;
    maintenanceStats.cycles++;
    maintenanceStats.lastStartedAt = new Date().toISOString();
    maintenanceStats.lastError = undefined;
    const startedAt = performance.now();
    let page: string[] = [];
    let pageIndex = 0;
    let runtimeReconciliationDone = false;
    let approvalExpiryDone = false;
    let mutationReceiptReconciliationDone = false;
    let snapshotGcDone = false;

    const finish = (backlog: boolean): void => {
      const durationMs = Math.round(performance.now() - startedAt);
      maintenanceStats.running = false;
      maintenanceStats.backlog = backlog;
      maintenanceStats.lastDurationMs = durationMs;
      maintenanceStats.maxDurationMs = Math.max(maintenanceStats.maxDurationMs, durationMs);
      maintenanceStats.lastCompletedAt = new Date().toISOString();
      maintenanceRunning = false;
    };

    const step = async (): Promise<void> => {
      if (maintenanceStopped) {
        finish(false);
        return;
      }
      // Every expensive operation is a bounded batch. Stop the cycle at the
      // wall-clock budget and leave the cursor for the next maintenance tick.
      if (performance.now() - startedAt >= MAINTENANCE_BUDGET_MS) {
        finish(true);
        return;
      }
      try {
        // Every maintenance class advances in bounded pages. A page is still
        // synchronous SQLite work, but it cannot turn a large historical
        // database into an unbounded serving-thread sweep.
        if (!runtimeReconciliationDone) {
          const runtimePage = workSessions.reconcileRuntimeStates(runtimeReconciliationCursor, MAINTENANCE_PAGE_SIZE);
          runtimeReconciliationCursor = runtimePage.hasMore ? runtimePage.nextAfterId : undefined;
          runtimeReconciliationDone = !runtimePage.hasMore;
          setImmediate(step);
          return;
        }

        if (!approvalExpiryDone) {
          const expiredApprovals = approvalRequests.expirePending(undefined, MAINTENANCE_PAGE_SIZE);
          for (const approval of expiredApprovals) {
            const session = approval.workSessionId ? workSessions.get(approval.workSessionId) : undefined;
            if (!session) continue;
            try {
              eventStore.appendEvent({
                type: "recovery.approval.expired",
                sessionId: session.id,
                payload: { approvalId: approval.approvalId, reason: "approval timed out during maintenance" },
              }, { publish: false });
            } catch (error) {
              reportMaintenanceFailure("approval_expiry_event", error, { approvalId: approval.approvalId, sessionId: session.id });
            }
          }
          // An exactly full page may have another page behind it. Ask again on
          // the next yielded step; the second empty page closes the scan.
          approvalExpiryDone = expiredApprovals.length < MAINTENANCE_PAGE_SIZE;
          setImmediate(step);
          return;
        }

        if (!mutationReceiptReconciliationDone) {
          const receiptMaintenance = mutationReceipts.reconcile({ limit: MAINTENANCE_PAGE_SIZE });
          maintenanceStats.pendingMutationReceipts = receiptMaintenance.pendingSample.length
            + (receiptMaintenance.pendingHasMore ? MAINTENANCE_PAGE_SIZE : 0);
          // Pending rows are an inspection result, not a deletion cursor:
          // they remain until an operator reconciles the authoritative
          // mutation outcome. Only completed-row pruning determines whether
          // another bounded page is needed.
          mutationReceiptReconciliationDone = receiptMaintenance.deletedCompleted < MAINTENANCE_PAGE_SIZE;
          if (!mutationReceiptReconciliationDone) {
            setImmediate(step);
            return;
          }
        }

        if (!snapshotGcDone) {
          // P0 #2: Filesystem snapshot reachability GC, bounded by the same
          // wall-clock budget as the other maintenance classes. One gcSlice is
          // advanced per yielded step; if it reports more work, the next cycle
          // resumes (never monopolizing the serving thread).
          const store = reviewCheckpoints.getSnapshotStore();
          const slice = await snapshotGcSlice(store, MAINTENANCE_BUDGET_MS, MAINTENANCE_PAGE_SIZE);
          if (slice.error) {
            maintenanceStats.lastError = slice.error;
            reportMaintenanceFailure("snapshot_gc", slice.error);
            // Advance past the failing GC class so a corrupt store cannot wedge
            // all future maintenance; it is retried next cycle.
            snapshotGcDone = true;
            setImmediate(step);
            return;
          }
          const wasDone = snapshotGcDone;
          snapshotGcDone = !slice.hasMore;
          // Once a full GC pass completes, drop stale session baseline pins so
          // the blobs they rooted become reclaimable.
          if (!wasDone && snapshotGcDone) await pruneStaleSessionBaselines();
          setImmediate(step);
          return;
        }

        if (pageIndex >= page.length) {
          page = workSessions.listSessionIdsNeedingCompaction(compactionCursor, COMPACT_PAGE_SIZE);
          pageIndex = 0;
          if (page.length === 0) {
            // A complete pass starts over on the next cycle; an interrupted
            // pass retains its cursor across cycles so it cannot repeatedly
            // rescan the same prefix after a budget expiry.
            compactionCursor = undefined;
            finish(false);
            return;
          }
        }

        const sessionId = page[pageIndex];
        const removed = eventStore.compactSessionEvents(sessionId, {
          retentionDays: 7,
          maxRows: COMPACT_BATCH_SIZE,
        });
        maintenanceStats.compactedRows += removed;
        // Keep the cursor on this session while a bounded batch indicates
        // more historical telemetry remains. This avoids skipping rows while
        // still yielding to the HTTP server after every transaction.
        if (removed < COMPACT_BATCH_SIZE) {
          compactionCursor = sessionId;
          pageIndex++;
        }
      } catch (error) {
        maintenanceStats.lastError = error instanceof Error ? error.message : String(error);
        reportMaintenanceFailure("maintenance_cycle", error);
        pageIndex++;
      }
      setImmediate(step);
    };
    step();
  };
  const maintenanceTimer = setInterval(runMaintenanceCycle, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref?.();
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
  const databaseIntegrity = {
    ok: false,
    status: "pending" as "pending" | "healthy" | "degraded",
    checkedAt: undefined as string | undefined,
    detail: "integrity check pending",
    durationMs: 0,
    timedOut: false,
  };
  const INTEGRITY_INTERVAL_MS = config.integrityIntervalMs;
  const INTEGRITY_DEADLINE_MS = config.integrityDeadlineMs;
  let integrityWorker: Worker | undefined;
  // Keep the single-flight guard set until a timed-out worker has actually
  // terminated. Clearing only the worker reference in the timeout callback
  // would let a short test interval (or an unusually fast maintenance timer)
  // overlap a still-running diagnostic worker.
  let integrityScanActive = false;
  const refreshDatabaseIntegrity = (): void => {
    // A slow read-only scan is diagnostic work. Never queue a second scan or
    // execute it in the serving isolate while the previous one is running.
    if (integrityScanActive) return;
    const startedAt = performance.now();
    const workerModule = import.meta.url.endsWith(".ts")
      ? "./database-integrity-worker.ts"
      : "./database-integrity-worker.js";
    let worker: Worker;
    try {
      worker = new Worker(new URL(workerModule, import.meta.url), {
        workerData: {
          databasePath: databasePath(config.stateDir),
          delayMs: Number(process.env.KONTROL_INTEGRITY_TEST_DELAY_MS ?? 0),
        },
      });
    } catch (error) {
      // Worker construction can fail synchronously (for example when a
      // packaged worker artifact is missing or the runtime rejects its
      // module options). Integrity is diagnostic work: record the degraded
      // result and keep server construction/serving independent of it.
      databaseIntegrity.ok = false;
      databaseIntegrity.status = "degraded";
      databaseIntegrity.detail = error instanceof Error ? error.message : String(error);
      databaseIntegrity.durationMs = Math.round(performance.now() - startedAt);
      databaseIntegrity.checkedAt = new Date().toISOString();
      databaseIntegrity.timedOut = false;
      console.warn(`[kontrol] database integrity diagnostic unavailable: ${databaseIntegrity.detail}`);
      return;
    }
    integrityScanActive = true;
    integrityWorker = worker;
    const releaseScan = (): void => {
      if (integrityWorker === worker) integrityWorker = undefined;
      integrityScanActive = false;
    };
    let settled = false;
    const finish = (result: { ok: boolean; detail: string; durationMs?: number; timedOut?: boolean }): void => {
      if (settled) return;
      settled = true;
      databaseIntegrity.ok = result.ok;
      databaseIntegrity.status = result.ok ? "healthy" : "degraded";
      databaseIntegrity.detail = result.detail;
      databaseIntegrity.durationMs = result.durationMs ?? Math.round(performance.now() - startedAt);
      databaseIntegrity.checkedAt = new Date().toISOString();
      databaseIntegrity.timedOut = result.timedOut === true;
      if (!result.ok) {
        console.warn(`[kontrol] database integrity diagnostic degraded: ${result.detail}`);
      }
    };
    const deadline = setTimeout(() => {
      finish({
        ok: false,
        detail: `quick_check exceeded ${INTEGRITY_DEADLINE_MS}ms diagnostic deadline`,
        durationMs: INTEGRITY_DEADLINE_MS,
        timedOut: true,
      });
      void worker.terminate().finally(releaseScan);
    }, INTEGRITY_DEADLINE_MS);
    deadline.unref?.();
    worker.once("message", (result: { ok?: boolean; detail?: string; durationMs?: number }) => {
      clearTimeout(deadline);
      finish({
        ok: result.ok === true,
        detail: result.detail ?? "quick_check returned no result",
        durationMs: result.durationMs,
      });
    });
    worker.once("error", (error) => {
      clearTimeout(deadline);
      finish({ ok: false, detail: error instanceof Error ? error.message : String(error) });
      void worker.terminate().finally(releaseScan);
    });
    worker.once("exit", (code) => {
      clearTimeout(deadline);
      if (!settled) finish({ ok: false, detail: `integrity worker exited without a result (code ${code})` });
      releaseScan();
    });
  };
  // Start asynchronously after construction. The initial server bind and all
  // liveness/readiness routes remain available while this diagnostic runs.
  refreshDatabaseIntegrity();
  const databaseIntegrityTimer = setInterval(refreshDatabaseIntegrity, INTEGRITY_INTERVAL_MS);
  databaseIntegrityTimer.unref?.();
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
    runtimeReconciliationCursor = page.hasMore ? page.nextAfterId : undefined;
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
    maintenanceStopped = true;
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
    clearInterval(maintenanceTimer);
    clearInterval(databaseIntegrityTimer);
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
    if (integrityWorker) {
      const worker = integrityWorker;
      integrityWorker = undefined;
      integrityScanActive = false;
      worker.removeAllListeners();
      // A failed bind must not wait indefinitely for a diagnostic worker that
      // is still loading a packaged/tsx module. Stop waiting after a short
      // cleanup bound and unref the worker so the failed server can exit.
      worker.unref?.();
      await Promise.race([
        worker.terminate().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    }
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
