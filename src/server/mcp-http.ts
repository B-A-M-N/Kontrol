/**
 * The /mcp HTTP route: request lifecycle, admission, session establishment,
 * worker/reviewer authentication envelope, and transport wiring. Extracted
 * verbatim from src/server.ts (P1.2); createServer closures become an
 * explicit dependency object destructured at function entry.
 */
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Socket } from "node:net";
import { createMcpHandler, InMemoryServerEventBus, isInitializeRequest, isLegacyRequest, checkResourceAllowed } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toWebRequest } from "@modelcontextprotocol/node";
import type { ServerConfig } from "../config.js";
import {
  handleMcpRequestWithDeadline,
  mcpAdmissionWeight,
  McpAdmissionUnavailableError,
  mcpRequestHasExecutionDeadline,
  McpExecutionTimeoutError,
  type McpAdmission,
} from "./mcp-admission.js";
import {
  conversationId,
  logicalClientId,
  logicalClientIdentity,
  mcpSessionLabel,
  sendJsonRpcError,
  type McpPolicyWaiter,
  type McpSessionState,
} from "./mcp-session-state.js";
import type { McpSessionLifecycle } from "./mcp-session-lifecycle.js";
import type { ExpiredMcpOperationTracker } from "./mcp-expired-operations.js";
import { sendCatalogRefreshNotification } from "./catalog-refresh.js";
import type { McpOperationDiagnostics } from "./mcp-operation-diagnostics.js";
import type { McpQualificationEvidenceJournal } from "./mcp-qualification-evidence.js";
import type { McpPolicyWaiterRegistry } from "./policy-waiters.js";
import type { LogicalContinuityIndex } from "../mcp-logical-continuity.js";
import { startMcpSseHeartbeat } from "./mcp-sse-heartbeat.js";
import { logEvent, requestPath, sessionIdPrefix } from "../logger.js";
import { verifyWorkerToken, type WorkerTokenClaims } from "../acp-worker-token.mjs";
import {
  constantTimeStringEqual,
  createMcpServer,
  requestLogFields,
  type ConnectionContext,
  mcpRequestContext,
  type Transport,
} from "../mcp/workspace-server.js";
import type { PolicyWaitContext, PolicyWaitOutcome } from "../policy-enforcement.js";
import {
  DEVDESKTOP_WORKSPACE_APP_URI,
  LEGACY_WORKSPACE_APP_URI,
  OPENAI_WORKSPACE_APP_URI,
  WORKSPACE_APP_URI,
  isWorkspaceAppHashedUri,
  workspaceAppResourceKind,
} from "../workspace-app-resource.js";
import type { DatabaseHandle } from "../db/client.js";
import type { MutationReceiptStore } from "../mutation-receipts.js";
import type { LiveWaiterRegistry } from "../acp-bridge.js";
import type { Request, Response } from "express";
import { readMcpToolSurface } from "../mcp/tool-names.js";
import { fingerprintToolCatalog, TOOL_CATALOG_ACK_METHOD } from "../mcp/tool-catalog-handshake.js";

function externalCorrelation(req: Request): string | undefined {
  for (const name of ["cf-ray", "x-kontrol-correlation-id", "x-request-id"]) {
    const value = req.header(name)?.trim();
    if (value && value.length <= 128 && /^[A-Za-z0-9._:/-]+$/.test(value)) return value;
  }
  return undefined;
}

function qualificationCaptureId(req: Request): string | undefined {
  const value = req.header("x-kontrol-qualification-capture-id")?.trim();
  return value && value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value) ? value : undefined;
}

function authenticatedConnection(req: Request, deps: McpHttpDeps, requestId?: string): {
  context: ConnectionContext;
  workerClaims?: WorkerTokenClaims;
} {
  const { config } = deps;
  const peer = req.peerPrincipal;
  const body = req.body as {
    params?: {
      clientInfo?: { name?: unknown };
      _meta?: Record<string, unknown>;
    };
    clientInfo?: { name?: unknown };
  } | undefined;
  const clientName = body?.params?.clientInfo?.name ?? body?.clientInfo?.name;
  const clientPlatformHint = typeof clientName === "string" ? clientName.slice(0, 200) : undefined;
  const clientCapabilities = body?.params?._meta?.["io.modelcontextprotocol/clientCapabilities"];
  const capabilities = clientCapabilities && typeof clientCapabilities === "object"
    ? clientCapabilities as { extensions?: Record<string, unknown> }
    : undefined;
  if (peer) {
    return {
      context: {
        authenticatedRole: "peer",
        authSource: "peer_token",
        authenticatedPrincipalId: peer.principalId,
        listenerKind: "peer",
        peerCapabilities: peer.capabilities,
        peerGrantedRoots: peer.grantedRoots,
        conversationId: conversationId(req),
        clientPlatformHint,
        clientCapabilities: capabilities,
      },
    };
  }

  let workerClaims: WorkerTokenClaims | undefined;
  const workerToken = req.header("x-kontrol-worker-token");
  if (workerToken && config.acpAgentSecret) {
    try {
      workerClaims = verifyWorkerToken(workerToken, config.acpAgentSecret);
    } catch (error) {
      logEvent(config.logging, "warn", "worker_token_rejected", {
        requestId,
        reason: error instanceof Error ? error.message : String(error),
        ...requestLogFields(req, config),
      });
    }
  }
  const verifiedReviewer = constantTimeStringEqual(req.header("x-kontrol-reviewer-token"), config.acpReviewerSecret);
  const verifiedTunnelReviewer = config.authMode === "tunnel"
    && constantTimeStringEqual(req.header("x-kontrol-tunnel-reviewer"), config.tunnelReviewerSecret);
  const oauthScopes = Array.isArray(req.auth?.scopes) ? req.auth.scopes : [];
  const verifiedOAuthReviewer = deps.oauthEnabled() && oauthScopes.some((scope) =>
    scope === "kontrol" || scope === "kontrol:review" || scope === "kontrol:approve"
      || scope === "kontrol:mission" || scope === "kontrol:dispatch",
  );
  const context: ConnectionContext = {
    authenticatedRole: workerClaims
      ? "worker"
      : verifiedReviewer || verifiedTunnelReviewer || verifiedOAuthReviewer
        ? "reviewer"
        : "client",
    listenerKind: deps.publicListener?.() ? "owner_public" : "owner",
    authSource: workerClaims
      ? "worker_token"
      : verifiedReviewer
        ? "reviewer_token"
        : verifiedTunnelReviewer
          ? "tunnel_reviewer"
          : deps.oauthEnabled()
            ? "oauth"
            : "anonymous",
    authenticatedPrincipalId: workerClaims
      ? `worker-work-session:${workerClaims.workSessionId}`
      : req.auth?.clientId
        ? `oauth-client:${req.auth.clientId}`
        : verifiedReviewer
          ? "reviewer-token"
          : verifiedTunnelReviewer
            ? "tunnel-reviewer"
            : undefined,
    workspaceSessionId: workerClaims?.workspaceSessionId || req.header("x-kontrol-workspace-session") || undefined,
    workSessionId: workerClaims?.workSessionId,
    runId: workerClaims?.runId || req.header("x-kontrol-run") || undefined,
    continuationId: workerClaims?.continuationId || req.header("x-kontrol-continuation") || undefined,
    workspaceLeaseNonce:
      (workerClaims as (WorkerTokenClaims & { workspaceLeaseNonce?: string }) | undefined)?.workspaceLeaseNonce
      || (workerClaims ? req.header("x-kontrol-workspace-lease-nonce") ?? undefined : undefined),
    conversationId: conversationId(req),
    clientPlatformHint,
    clientCapabilities: capabilities,
  };
  return { context, workerClaims };
}

function responseChunkBytes(chunk: unknown, encoding: unknown): number {
  if (typeof chunk === "string") {
    try { return Buffer.byteLength(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8"); }
    catch { return Buffer.byteLength(chunk, "utf8"); }
  }
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  return 0;
}

export interface McpHttpDeps {
  readonly config: ServerConfig;
  readonly db: DatabaseHandle;
  readonly transports: Map<string, Transport>;
  readonly mcpServers: Map<string, McpServer>;
  readonly mcpSessions: Map<string, McpSessionState>;
  readonly logicalContinuity: LogicalContinuityIndex;
  readonly policyWaiters: McpPolicyWaiterRegistry;
  readonly mcpAdmission: McpAdmission;
  readonly mcpWaiterAdmission: McpAdmission;
  readonly mcpResourceAdmission: McpAdmission;
  readonly expiredMcpOperations: ExpiredMcpOperationTracker;
  readonly operationDiagnostics: McpOperationDiagnostics;
  readonly qualificationEvidence: McpQualificationEvidenceJournal;
  readonly sessionLifecycle: McpSessionLifecycle;
  readonly recordUnknownSessionRequest?: (sessionId: string) => void;
  readonly recordFreshInitialization?: (reconnected: boolean, durationMs?: number) => void;
  readonly recordMcpConnectionEvent?: (event: { kind: string; sessionId?: string; requestId?: string; operationId?: string; requestKind?: string; toolName?: string; failureClass?: string; durationMs?: number }) => void;
  readonly workspaceAppResourceMetrics: { currentHashed: number; previousHashed: number; staleHashMisses: number; openAiCompatibility: number; legacyKontrol: number; devDesktopMigration: number };
  trackSocketAbort(socket: Socket, controller: AbortController): () => void;
  bearerAuth(): ((req: Request, res: Response, next: (error?: unknown) => void) => void) | undefined;
  resourceServerUrl(): URL | undefined;
  oauthEnabled(): boolean;
  shuttingDown(): boolean;
  /**
   * True when this handler serves the separately-authenticated peer listener.
   * Peer requests carry a registry-verified req.peerPrincipal instead of OAuth
   * context; on the peer listener a missing peer principal is always rejected.
   */
  isPeerListener?: () => boolean;
  /**
   * True only on the public OAuth MCP listener (P0-02). Structurally no peer
   * principal can exist there: the peer middleware is never mounted on the
   * public app, so peer identity derivation is unreachable and sessions are
   * fenced to "owner_public".
   */
  publicListener?: () => boolean;
  serveWorkspaceAppResource(res: Response, requestId: string | undefined, body: { id?: unknown; params?: { uri?: unknown } }, sessionless: boolean, clientKey: string, abortSignal: AbortSignal | undefined, acceptEncoding?: string | undefined, context?: { sessionId?: string; generationId?: string }): Promise<boolean>;
  createServerForSession(
    connectionContext: ConnectionContext,
    onToolCatalogHandshake?: (sessionId: string | undefined, result: {
      status: "accepted" | "rejected";
      serverVersion: string;
      captureId?: string;
      serverCatalogSha256?: string;
      hostCatalogSha256: string;
      toolCount?: number;
      acceptedAt: string;
      reason?: string;
    }) => void,
  ): McpServer;
  supervisorWake(workSessionId: string): void;
  onScheduledJobCreated?: () => void;
  mutationReceipts: MutationReceiptStore;
  workspaces: import("../workspaces.js").WorkspaceRegistry;
  reviewCheckpoints: import("../review-checkpoints.js").ReviewCheckpointManager;
  processSessions: import("../process-sessions.js").ProcessSessionManager;
  workSessions: import("../work-sessions.js").WorkSessionManager;
  agentRegistry: import("../acp-registry.js").AgentRegistryManager;
  eventStore: import("../event-log.js").EventStore;
  continuationManager: import("../continuation.js").ContinuationManager;
  dispatchOutbox: import("../dispatch-outbox.js").DispatchOutbox;
  policyEngine: import("../policy.js").PolicyEngine;
  policyEnforcer: import("../policy-enforcement.js").PolicyEnforcer;
  approvalRequests: import("../approval-requests.js").ApprovalRequestManager;
  missionLedger: import("../mission-ledger.js").MissionLedger;
  reviewWorkflow: import("../review-workflow.js").ReviewWorkflowService;
  liveWaiters: LiveWaiterRegistry;
  agentMessages: import("../agent-messages.js").AgentMessageManager;
  supervisorRuns: import("../supervisor-runs.js").SupervisorRuns;
  scheduledJobs?: import("../scheduling/scheduled-job-store.js").ScheduledJobStore;
  reviewRoutes?: import("../review-handoff/route-store.js").ReviewRouteStore;
  reviewBrowserController?: import("../review-browser/browser-controller.js").ReviewerBrowserController;
  reviewThreads?: import("../review-thread/thread-store.js").ReviewThreadStore;
}

type CatalogRefreshPhase = "initialized" | "get_stream" | "request_retry";

const modernEventBuses = new WeakMap<McpHttpDeps, InMemoryServerEventBus>();
const modernCatalogs = new WeakMap<McpHttpDeps, Map<string, { sha256: string; toolCount: number }>>();
const modernCatalogAcknowledgements = new WeakMap<McpHttpDeps, Map<string, boolean>>();

function modernEventBus(deps: McpHttpDeps): InMemoryServerEventBus {
  let bus = modernEventBuses.get(deps);
  if (!bus) {
    bus = new InMemoryServerEventBus((error) => {
      logEvent(deps.config.logging, "warn", "mcp_modern_event_listener_failed", {
        reason: error.message,
      });
    });
    modernEventBuses.set(deps, bus);
  }
  return bus;
}

function modernCatalogMap(deps: McpHttpDeps): Map<string, { sha256: string; toolCount: number }> {
  let catalogs = modernCatalogs.get(deps);
  if (!catalogs) {
    catalogs = new Map();
    modernCatalogs.set(deps, catalogs);
  }
  return catalogs;
}

function modernCatalogAcknowledgementMap(deps: McpHttpDeps): Map<string, boolean> {
  let acknowledgements = modernCatalogAcknowledgements.get(deps);
  if (!acknowledgements) {
    acknowledgements = new Map();
    modernCatalogAcknowledgements.set(deps, acknowledgements);
  }
  return acknowledgements;
}

function requestAdmissionTimeout(state: McpSessionState | undefined, config: ServerConfig): number {
  return state?.durableWorkerSession ? config.mcpAdmissionTimeoutMs : config.mcpInteractiveAdmissionTimeoutMs;
}

function catalogRefreshStats(state: McpSessionState) {
  return state.catalogRefresh ??= {
    initializedPulseAttempted: false,
    getStreamPulseAttempted: false,
    deferredNoStreamAttempts: 0,
    staleDeliveries: 0,
    toolListRefreshSent: false,
    resourceListRefreshSent: false,
    toolListRefreshAttempts: 0,
    resourceListRefreshAttempts: 0,
    toolListRefreshSuccesses: 0,
    resourceListRefreshSuccesses: 0,
    toolListRefreshFailures: 0,
    resourceListRefreshFailures: 0,
    toolListRefreshInFlight: false,
    resourceListRefreshInFlight: false,
  };
}

/**
 * Delivery state belongs to the standalone stream that carries it. When that
 * stream ends the channels are re-armed: the next standalone stream has to be
 * able to deliver, because a success recorded against a stream that has since
 * disappeared may never have reached the host.
 */
function rearmCatalogRefreshDelivery(state: McpSessionState): void {
  const refresh = state.catalogRefresh;
  if (!refresh) return;
  refresh.toolListRefreshSent = false;
  refresh.resourceListRefreshSent = false;
  refresh.toolListRefreshAttempts = 0;
  refresh.resourceListRefreshAttempts = 0;
  refresh.toolListRefreshLastAttemptMs = undefined;
  refresh.resourceListRefreshLastAttemptMs = undefined;
}

/**
 * The standalone GET SSE stream is gone. The transport can no longer carry a
 * server-initiated notification on it, and nothing recorded against it may
 * suppress the delivery on the next standalone stream.
 *
 * The clear is fenced to the surface that owned it: a request that ends after
 * a successor stream already established a new surface must not re-arm that
 * successor. The owner passes the generation it established, and the clear
 * only applies while the session still carries that surface.
 */
function clearStandaloneSseDelivery(state: McpSessionState, ownedGeneration?: number): void {
  if (ownedGeneration !== undefined && (state.deliveryGeneration ?? 0) !== ownedGeneration) {
    // A successor surface already replaced this one. The successor owns the
    // delivery state; this late clear must not touch it.
    return;
  }
  if (state.standaloneSseEstablished === true) {
    // The surface identity changes, so a send that resolves against the surface
    // that just ended is discarded instead of marking the channel sent. A
    // second clear of the same surface changes nothing.
    state.deliveryGeneration = (state.deliveryGeneration ?? 0) + 1;
  }
  state.standaloneSseEstablished = false;
  rearmCatalogRefreshDelivery(state);
}

async function sendCatalogRefreshPulse(
  deps: McpHttpDeps,
  sessionId: string,
  phase: CatalogRefreshPhase,
  retryDepth = 0,
): Promise<void> {
  const state = deps.mcpSessions.get(sessionId);
  const server = deps.mcpServers.get(sessionId);
  if (!state || !server || state.closing || state.closed) return;
  modernEventBus(deps).publish({ kind: "tools_list_changed" });
  modernEventBus(deps).publish({ kind: "resources_list_changed" });
  const refresh = catalogRefreshStats(state);
  if (phase === "initialized") {
    refresh.initializedPulseAttempted = true;
  } else if (phase === "get_stream") {
    refresh.getStreamPulseAttempted = true;
  }
  refresh.lastAttemptAt = new Date().toISOString();

  // A server-initiated notification is only observable on a live standalone
  // GET SSE channel. Without one the transport drops the message but still
  // resolves the send, so recording that as a success would permanently
  // suppress the pulse on the very channel that can carry it. Defer instead:
  // the channel stays eligible and the GET-stream phase delivers the pulse.
  if (state.standaloneSseEstablished !== true) {
    refresh.deferredNoStreamAttempts += 1;
    logEvent(deps.config.logging, "debug", "mcp_catalog_refresh_deferred", {
      sessionIdPrefix: sessionIdPrefix(sessionId),
      phase,
      activeSseStreams: state.activeSseStreams,
    });
    return;
  }

  // The delivery surface that carries this pulse. When it ends while the send
  // is in flight, the resolved send is discarded instead of marking the
  // channel sent: a success recorded against a surface that has gone away may
  // never have reached the host.
  const deliveryGeneration = state.deliveryGeneration ?? 0;
  const isDeliveryStillValid = (): boolean =>
    (state.deliveryGeneration ?? 0) === deliveryGeneration
    && state.standaloneSseEstablished === true;

  const sendOne = async (
    method: "tools" | "resources",
    send: () => Promise<void>,
  ): Promise<"stale" | "delivered"> => {
    const outcome = await sendCatalogRefreshNotification(refresh, method, send, (error) => {
      logEvent(deps.config.logging, "warn", "mcp_catalog_refresh_failed", {
        sessionIdPrefix: sessionIdPrefix(sessionId),
        phase,
        method,
        surfaceVersion: state.toolSurfaceVersion,
        error: error instanceof Error ? error.message : String(error),
      });
    }, Date.now(), { isDeliveryStillValid });
    if (outcome !== "stale") return "delivered";
    refresh.staleDeliveries += 1;
    logEvent(deps.config.logging, "warn", "mcp_catalog_refresh_stale", {
      sessionIdPrefix: sessionIdPrefix(sessionId),
      phase,
      method,
      deliveryGeneration,
    });
    return "stale";
  };

  const outcomes = await Promise.all([
    sendOne("tools", () => server.server.sendToolListChanged()),
    sendOne("resources", () => server.server.sendResourceListChanged()),
  ]);

  if (outcomes.includes("stale") && retryDepth === 0 && state.standaloneSseEstablished === true) {
    // A successor surface is live and the host is still owed the notification.
    // Pay it there instead of waiting for the next pulse opportunity. One
    // follow-up per pulse invocation, and the retry is bounded to one round.
    void sendCatalogRefreshPulse(deps, sessionId, phase, retryDepth + 1);
  }
}

export async function handleMcpHttpRequest(deps: McpHttpDeps, req: Request, res: Response): Promise<unknown> {
  // Keep the established stateful 2025 route intact. Only requests classified
  // as 2026 per-request traffic take the stateless handler below.
  const webRequest = await toWebRequest(req, req.body);
  if (!(await isLegacyRequest(webRequest, req.body))) {
    return handleModernMcpHttpRequest(deps, req, res, webRequest);
  }

  const {
    config,
    db,
    transports,
    mcpServers,
    mcpSessions,
    logicalContinuity,
    policyWaiters,
    mcpAdmission,
    mcpWaiterAdmission,
    mcpResourceAdmission,
    expiredMcpOperations,
    operationDiagnostics,
    qualificationEvidence,
    sessionLifecycle,
    workspaceAppResourceMetrics,
    trackSocketAbort,
    serveWorkspaceAppResource,
    supervisorWake,
    mutationReceipts,
    liveWaiters,
  } = deps;
  const bearerAuth = deps.bearerAuth();
  const resourceServerUrl = deps.resourceServerUrl();
  const oauthEnabled = deps.oauthEnabled();
  const shuttingDown = deps.shuttingDown();
  const {
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
    reviewWorkflow,
    agentMessages,
    supervisorRuns,
    scheduledJobs,
    reviewRoutes,
  } = deps;
  const {
    recordMcpTiming,
    recordPhaseTiming,
    recordMcpCapacityRejection,
    recordMcpWindowEvent,
    recordMcpSessionCreated,
    getMemoryPressureState,
    finalizeMcpSession,
    reapIdleMcpSessions,
  } = sessionLifecycle;
  const requestStartedAt = performance.now();
  const requestStartedAtMs = Date.now();
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
    const operationId = randomUUID();
    const externalCorrelationId = externalCorrelation(req);
    const operationSessionState = sessionId ? mcpSessions.get(sessionId) : undefined;
    const operationSessionIdSha256 = sessionId ? createHash("sha256").update(sessionId).digest("hex") : undefined;
    const operationServerVersion = operationSessionState?.toolSurfaceVersion;
    const operationCaptureId = qualificationCaptureId(req);
    operationDiagnostics.begin({
      operationId,
      requestId,
      externalCorrelationId,
      generationId: config.launchGenerationId,
      sessionIdPrefix: sessionIdPrefix(sessionId),
      sessionIdSha256: operationSessionIdSha256,
      serverBuildId: config.expectedBuildId,
      serverVersion: operationServerVersion,
      method: req.method,
      rpcMethod: requestRpcMethod,
      toolName: requestToolName,
      startedAtMs: requestStartedAtMs,
      admissionClass,
    });
    deps.recordMcpConnectionEvent?.({
      kind: requestRpcMethod === "initialize" ? "initialize_started" : requestRpcMethod === "tools/call" ? "tool_call_started" : "request_started",
      sessionId,
      requestId: requestId ?? operationId,
      operationId,
      requestKind: requestRpcMethod ?? req.method,
      ...(requestToolName ? { toolName: requestToolName } : {}),
    });
    res.setHeader("x-kontrol-operation-id", operationId);
    res.setHeader("x-kontrol-request-id", requestId ?? operationId);
    if (externalCorrelationId) res.setHeader("x-kontrol-correlation-id", externalCorrelationId);
    let handlerStartedAt = 0;
    let handlerSettled = false;
    let requestAdmissionWeight = 1;
    let responseBytes = 0;
    let heartbeatBytes = 0;
    let responseCloseClassification: string | undefined;
    let requestErrorClass: string | undefined;
    let transport: Transport | undefined;
    let sessionState: McpSessionState | undefined;
    let stopSseHeartbeat: (() => void) | undefined;
    // True only for the request that established the standalone delivery
    // surface. A rejected or duplicate GET must not tear down the surface that
    // another live stream still carries.
    let standaloneStreamEstablished = false;
    // The delivery generation this request established. A late teardown of
    // this request must not re-arm a successor surface that already replaced
    // it.
    let standaloneStreamGeneration: number | undefined;
    const requestAbort = new AbortController();
    const instrumentedResponse = res as unknown as {
      write: (...args: unknown[]) => unknown;
      end: (...args: unknown[]) => unknown;
      setHeader: (...args: unknown[]) => unknown;
      writeHead: (...args: unknown[]) => unknown;
    };
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const originalSetHeader = res.setHeader.bind(res);
    const originalWriteHead = res.writeHead.bind(res);
    let responseWritersRestored = false;
    const prepareSseHeaders = () => {
      if (res.headersSent) return;
      originalSetHeader("X-Accel-Buffering", "no");
      originalSetHeader("Cache-Control", "no-cache, no-transform");
    };
    const ensureSseHeartbeat = () => {
      const contentType = res.getHeader("content-type")?.toString().toLowerCase() ?? "";
      if (!contentType.includes("text/event-stream")) return;
      prepareSseHeaders();
      if (!stopSseHeartbeat) {
        const requestKind = req.method === "GET" ? "sse_stream" : "post_response";
        stopSseHeartbeat = startMcpSseHeartbeat(res, config.mcpSseHeartbeatMs, () => {
          deps.recordMcpConnectionEvent?.({ kind: "sse_writer_stalled", sessionId, requestKind });
          logEvent(config.logging, "warn", "mcp_sse_writer_stalled", {
            requestId,
            sessionIdPrefix: sessionIdPrefix(sessionId),
            requestKind,
          });
        }, () => {
          deps.recordMcpConnectionEvent?.({ kind: "sse_recovered", sessionId, requestKind });
          deps.recordMcpConnectionEvent?.({ kind: "sse_writer_drained", sessionId, requestKind });
          logEvent(config.logging, "info", "mcp_sse_writer_drained", {
            requestId,
            sessionIdPrefix: sessionIdPrefix(sessionId),
            requestKind,
          });
        }, (bytes) => {
          heartbeatBytes += bytes;
        }, {
          maxStallMs: config.mcpSseMaxStallMs,
          onStallTimeout: ({ stalledSince, lastSuccessfulWriteAt, consecutiveStallCount }) => {
            deps.recordMcpConnectionEvent?.({ kind: "sse_stall_timeout", sessionId, requestKind, durationMs: Math.max(0, Date.now() - stalledSince) });
            logEvent(config.logging, "warn", "mcp_sse_stall_timeout", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(sessionId),
              requestKind,
              stalledSince: new Date(stalledSince).toISOString(),
              lastSuccessfulWriteAt: new Date(lastSuccessfulWriteAt).toISOString(),
              consecutiveStallCount,
            });
          },
        });
      }
      if (req.method === "GET" && sessionId) {
        // The transport registers the standalone GET stream before it writes
        // these SSE headers, so a notification sent from here is deliverable
        // on this channel.
        const streamState = deps.mcpSessions.get(sessionId);
        if (streamState && streamState.standaloneSseEstablished !== true) {
          // A new delivery surface. Its identity changes, so a send that
          // resolves against a previous surface can never mark the channel
          // sent for this one.
          streamState.standaloneSseEstablished = true;
          streamState.deliveryGeneration = (streamState.deliveryGeneration ?? 0) + 1;
          standaloneStreamEstablished = true;
          standaloneStreamGeneration = streamState.deliveryGeneration;
        }
        void sendCatalogRefreshPulse(deps, sessionId, "get_stream");
      }
    };
    const restoreResponseWriters = () => {
      if (responseWritersRestored) return;
      responseWritersRestored = true;
      instrumentedResponse.write = originalWrite as unknown as (...args: unknown[]) => unknown;
      instrumentedResponse.end = originalEnd as unknown as (...args: unknown[]) => unknown;
      instrumentedResponse.setHeader = originalSetHeader as unknown as (...args: unknown[]) => unknown;
      instrumentedResponse.writeHead = originalWriteHead as unknown as (...args: unknown[]) => unknown;
    };
    instrumentedResponse.setHeader = ((name: string, value: unknown, ...args: unknown[]) => {
      const isSseContentType = name.toLowerCase() === "content-type"
        && typeof value === "string"
        && value.toLowerCase().includes("text/event-stream");
      if (isSseContentType) prepareSseHeaders();
      const result = Reflect.apply(originalSetHeader, res, [name, value, ...args]);
      if (isSseContentType) ensureSseHeartbeat();
      return result;
    }) as unknown as (...args: unknown[]) => unknown;
    instrumentedResponse.writeHead = ((statusCode: number, ...args: unknown[]) => {
      const headers = args.find((arg) => arg && typeof arg === "object" && !Array.isArray(arg)) as Record<string, unknown> | undefined;
      const contentType = headers?.["content-type"] ?? headers?.["Content-Type"] ?? res.getHeader("content-type");
      if (typeof contentType === "string" && contentType.toLowerCase().includes("text/event-stream")) {
        if (headers) {
          headers["X-Accel-Buffering"] ??= "no";
          headers["Cache-Control"] = "no-cache, no-transform";
        } else prepareSseHeaders();
      }
      const result = Reflect.apply(originalWriteHead, res, [statusCode, ...args]);
      ensureSseHeartbeat();
      return result;
    }) as unknown as (...args: unknown[]) => unknown;
    instrumentedResponse.write = (...args: unknown[]) => {
      ensureSseHeartbeat();
      const bytes = !res.writableEnded && !res.destroyed ? responseChunkBytes(args[0], args[1]) : 0;
      const isHeartbeat = args[0] === ": kontrol-heartbeat\n\n";
      try {
        const result = Reflect.apply(originalWrite, res, args);
        if (!isHeartbeat) responseBytes += bytes;
        return result;
      } catch (error) {
        throw error;
      }
    };
    instrumentedResponse.end = (...args: unknown[]) => {
      ensureSseHeartbeat();
      const bytes = !res.writableEnded && !res.destroyed ? responseChunkBytes(args[0], args[1]) : 0;
      try {
        const result = Reflect.apply(originalEnd, res, args);
        responseBytes += bytes;
        return result;
      } catch (error) {
        throw error;
      }
    };
    let operationDiagnosticFinalized = false;
    const finalizeOperationDiagnostic = () => {
      if (operationDiagnosticFinalized) return;
      operationDiagnosticFinalized = true;
      const finishedAtMs = Date.now();
      const completedResponseCloseClassification = responseCloseClassification
        ?? (res.writableFinished ? "response_finished" : "response_incomplete");
      const executionDurationMs = handlerStartedAt > 0
        ? Math.max(0, Math.round(performance.now() - handlerStartedAt))
        : 0;
      const sessionInFlight = sessionId ? mcpSessions.get(sessionId)?.inFlightRequests : undefined;
      const observedSession = sessionId ? mcpSessions.get(sessionId) : undefined;
      const connectionMetrics = {
        activeSseStreams: observedSession?.activeSseStreams ?? 0,
        activeLongPolls: observedSession?.activeLongPollCount ?? 0,
        activePolicyWaiters: observedSession?.activePolicyWaiters ?? 0,
        inFlightRequests: observedSession?.inFlightRequests ?? 0,
        transportClosed: observedSession?.closed ?? false,
      };
      const executionAdmission = mcpAdmission.getStats();
      const resourceAdmission = mcpResourceAdmission.getStats();
      operationDiagnostics.finish(operationId, {
        finishedAtMs,
        httpStatus: res.statusCode,
        responseBytes,
        heartbeatBytes,
        responseCloseClassification: completedResponseCloseClassification,
        admissionWaitMs: Math.max(0, Math.round(admissionWaitMs)),
        executionDurationMs,
        handlerStillRunning: !handlerSettled,
        ...(requestErrorClass ? { errorClass: requestErrorClass } : {}),
        executionAdmission,
        resourceAdmission,
        sessionInFlight,
        connectionMetrics,
      });
      deps.recordMcpConnectionEvent?.({
        kind: completedResponseCloseClassification === "response_finished" ? "response_finished" : "stream_aborted",
        sessionId,
        requestId: requestId ?? operationId,
        operationId,
        requestKind: requestRpcMethod ?? req.method,
        ...(requestToolName ? { toolName: requestToolName } : {}),
        ...(requestErrorClass ? { failureClass: requestErrorClass } : {}),
        durationMs: Math.max(0, finishedAtMs - requestStartedAtMs),
      });
      try {
        const responseContentType = res.getHeader("content-type")?.toString().toLowerCase() ?? "";
        qualificationEvidence.recordCompletedSseOperation({
          operationId,
          qualificationCaptureId: operationCaptureId,
          serverBuildId: config.expectedBuildId,
          serverVersion: operationServerVersion,
          sessionIdSha256: operationSessionIdSha256,
          httpMethod: req.method,
          rpcMethod: requestRpcMethod,
          toolName: requestToolName,
          startedAt: new Date(requestStartedAtMs).toISOString(),
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs: Math.max(0, finishedAtMs - requestStartedAtMs),
          isSseResponse: responseContentType.includes("text/event-stream"),
          httpStatus: res.statusCode,
          responseBytes,
          heartbeatBytes,
          responseCloseClassification: completedResponseCloseClassification,
          handlerStillRunning: !handlerSettled,
        });
      } catch (error) {
        logEvent(config.logging, "error", "mcp_qualification_evidence_write_failed", {
          operationId,
          recordType: "external_sse",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      logEvent(config.logging, "debug", "mcp_operation_finished", {
        operationId,
        requestId,
        externalCorrelationId,
        generationId: config.launchGenerationId,
        sessionIdPrefix: sessionIdPrefix(sessionId),
        rpcMethod: requestRpcMethod,
        toolName: requestToolName,
        startedAt: new Date(requestStartedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        httpStatus: res.statusCode,
        responseBytes,
        heartbeatBytes,
        responseCloseClassification: completedResponseCloseClassification,
        admissionWaitMs: Math.max(0, Math.round(admissionWaitMs)),
        executionDurationMs,
        handlerStillRunning: !handlerSettled,
        executionAdmission,
        resourceAdmission,
        sessionInFlight,
        connectionMetrics,
      });
    };
    // A lost HTTP response ends this request, not the shared MCP session.
    // In particular, a client may close the standalone GET SSE stream while
    // another POST is still executing on the same Streamable HTTP transport.
    // The SDK's standalone stream cancellation cleans up that stream; closing
    // the transport here would incorrectly terminate the whole session.
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
      restoreResponseWriters();
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
      if (standaloneStreamEstablished && sessionId) {
        // The standalone GET stream that carried the delivery surface ended.
        // This handler is registered before the transport registers its own
        // stream cancellation, so the surface is cleared before the transport
        // drops the stream.
        const state = mcpSessions.get(sessionId);
        if (state) clearStandaloneSseDelivery(state, standaloneStreamGeneration);
      }
      // Cancel downstream work for this HTTP request, but preserve the MCP
      // session and any other concurrent requests sharing its transport. The
      // SDK owns individual SSE stream cancellation and session close() is
      // reserved for explicit DELETE, server shutdown, timeout, and expiry.
      if (!res.writableFinished) {
        responseCloseClassification = "response_closed_before_finish";
        deps.recordMcpConnectionEvent?.({
          kind: requestIsSseStream ? "stream_aborted" : requestIsWaiter ? "watcher_aborted" : "response_channel_closed",
          sessionId,
          requestKind: requestIsSseStream ? "sse_stream" : req.method === "POST" ? "post_response" : "http_response",
        });
        const state = sessionId ? mcpSessions.get(sessionId) : undefined;
        logEvent(config.logging, "debug", "mcp_request_disconnected", {
          requestId,
          sessionIdPrefix: sessionIdPrefix(sessionId),
          sessionLabel: state?.sessionLabel,
          rpcMethod: requestRpcMethod,
          toolName: requestToolName,
          requestKind: requestIsSseStream ? "sse_stream" : req.method === "POST" ? "post_response" : "http_response",
          activeRequests: state?.inFlightRequests ?? 0,
          activeSseStreams: state?.activeSseStreams ?? 0,
          generationId: config.launchGenerationId,
          buildId: config.expectedBuildId,
          terminationReason: "response_channel_closed",
        });
      }
      stopSseHeartbeat?.();
      stopSseHeartbeat = undefined;
      abortIfDisconnected();
      cleanupRequestListeners();
    };
    const onResponseFinish = () => {
      responseCloseClassification ??= "response_finished";
      if (standaloneStreamEstablished && sessionId) {
        const state = mcpSessions.get(sessionId);
        if (state) clearStandaloneSseDelivery(state, standaloneStreamGeneration);
      }
      const finishedAt = performance.now();
      recordPhaseTiming("mcp.response", finishedAt - requestStartedAt);
      if (handlerStartedAt > 0) recordPhaseTiming("mcp.serialization", finishedAt - handlerStartedAt);
      // A completed tools/list response is a later, useful retry opportunity:
      // the transport is demonstrably carrying a response, and a failed
      // initialize/stream notification can be retried without duplicating a
      // channel that already accepted its change pulse.
      if (req.method === "POST" && requestRpcMethod === "tools/list" && sessionId) {
        void sendCatalogRefreshPulse(deps, sessionId, "request_retry");
      }
      if (req.method === "DELETE" && sessionId) {
        deps.recordMcpConnectionEvent?.({ kind: "explicit_delete", sessionId, requestKind: "delete" });
        const state = mcpSessions.get(sessionId);
        logEvent(config.logging, "debug", "mcp_request_disconnected", {
          requestId,
          sessionIdPrefix: sessionIdPrefix(sessionId),
          sessionLabel: state?.sessionLabel,
          requestKind: "delete",
          activeRequests: state?.inFlightRequests ?? 0,
          activeSseStreams: state?.activeSseStreams ?? 0,
          generationId: config.launchGenerationId,
          buildId: config.expectedBuildId,
          terminationReason: "explicit_delete",
        });
      }
      stopSseHeartbeat?.();
      stopSseHeartbeat = undefined;
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
      const waiter = policyWaiters.waiters.get(policyWaiterId);
      policyWaiters.waiters.delete(policyWaiterId);
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
      policyWaiters.waiters.set(id, {
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
        policyWaiters.recordDisconnect();
      }
      if (context.outcome !== "approved") {
        restoreSessionExecutionCount();
        return;
      }
      const admissionStartedAt = performance.now();
      const acquired = await mcpAdmission.acquire(
        sessionId ?? logicalClientId(req),
        requestAdmissionTimeout(sessionState ?? (sessionId ? mcpSessions.get(sessionId) : undefined), config),
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
      policyWaiters.recordResume();
      if (waiter) {
        logEvent(config.logging, "debug", "mcp_policy_waiter_resumed", {
          requestId,
          approvalId: waiter.approvalId,
          sessionIdPrefix: sessionIdPrefix(sessionId),
          admissionWaitMs: Math.round(admissionWaitMs),
        });
      }
    };

    try {
    if (shuttingDown) {
      return res.status(503).json({
        jsonrpc: "2.0",
        id: (req.body as { id?: unknown } | undefined)?.id ?? null,
        error: { code: -32000, message: "KONTROL is draining; retry after restart." },
      });
    }

    // Peer-authenticated requests (peer listener only) carry a registry-
    // verified principal instead of OAuth context. The peer credential is the
    // whole trust boundary: no OAuth resource assertion applies, and unsigned
    // worker/reviewer/conversation headers are never evaluated for promotion.
    const peerPrincipal = req.peerPrincipal;
    if (peerPrincipal) {
      logEvent(config.logging, "debug", "peer_request_authenticated", {
        requestId,
        peerId: peerPrincipal.peerId,
        credentialId: peerPrincipal.credentialId,
        method: req.method,
        path: requestPath(req),
      });
    } else {
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
      if (deps.isPeerListener?.()) {
        // Defense in depth: the peer middleware normally rejects unauthenticated
        // requests before this handler runs; never serve one that slipped through.
        logEvent(config.logging, "warn", "auth_denied", {
          requestId,
          method: req.method,
          path: requestPath(req),
          reason: "missing_peer_principal",
        });
        sendJsonRpcError(res, 401, -32001, "Unauthorized");
        return;
      }
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
          deps.recordUnknownSessionRequest?.(sessionId);
          logEvent(config.logging, "info", "mcp_unknown_session", {
            requestId,
            sessionIdPrefix: sessionIdPrefix(sessionId),
            generationId: config.launchGenerationId,
            buildId: config.expectedBuildId,
            outcome: "fresh_initialize_required",
          });
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
        sessionState = mcpSessions.get(sessionId);
        // Identity continuity: an authenticated session (OAuth owner or peer)
        // may only be resumed by the same logical client. A peer session's
        // logical client IS the peer principal, so a rotated/revoked
        // credential - or an owner/peer token presented on the other listener
        // - cannot attach to an existing session.
        // Authorization continuity: a peer session must be resumed only by a
        // principal carrying the exact authorization revision/hash used at
        // initialization. Credential rotation or grant changes create a fresh
        // initialize and never let old transports exercise stale authority.
        if (
          peerPrincipal
          && sessionState
          && (sessionState.peerAuthorizationRevision !== peerPrincipal.grantRevision
            || sessionState.peerAuthorizationHash !== peerPrincipal.grantHash)
        ) {
          logEvent(config.logging, "warn", "mcp_session_authorization_stale", {
            requestId,
            sessionIdPrefix: sessionIdPrefix(sessionId),
            expectedRevision: sessionState.peerAuthorizationRevision,
            actualRevision: peerPrincipal.grantRevision,
          });
          // Rejection alone leaves a stale standalone SSE transport attached.
          // Close the transport and run the same lifecycle cleanup as an
          // explicit close so direct process ownership and waiters are fenced.
          finalizeMcpSession(sessionId, "client_closed", { evictionReason: "peer_authorization_superseded" });
          sendJsonRpcError(res, 403, -32001, "MCP session authorization has been superseded; initialize a fresh session");
          return;
        }
        if (
          sessionState
          && (config.authMode === "oauth" || sessionState.authSource === "peer_token")
          && sessionState.logicalClientId !== logicalClientId(req)
        ) {
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
        // Fail-closed listener fence (P2-1): the request's listener kind must
        // EQUAL the session's. A missing session record (transport without
        // state — an anomaly) or an unknown kind is a mismatch, never a skip.
        const requestListenerKind: "owner" | "peer" | "owner_public" = peerPrincipal
          ? "peer"
          : deps.publicListener?.()
            ? "owner_public"
            : "owner";
        if (sessionState?.listenerKind !== requestListenerKind) {
          logEvent(config.logging, "warn", "mcp_session_listener_mismatch", {
            requestId,
            sessionIdPrefix: sessionIdPrefix(sessionId),
            expectedListener: sessionState?.listenerKind,
            actualListener: requestListenerKind,
          });
          sendJsonRpcError(res, 403, -32001, "MCP session belongs to another listener");
          return;
        }
        if (
          config.mcpToolCatalogAckRequired === true
          && requestRpcMethod === "tools/call"
          && sessionState?.toolCatalogHandshake?.status !== "accepted"
        ) {
          logEvent(config.logging, "warn", "mcp_tool_catalog_call_rejected", {
            requestId,
            sessionIdPrefix: sessionIdPrefix(sessionId),
            toolName: requestToolName,
            handshakeStatus: sessionState?.toolCatalogHandshake?.status ?? "missing",
          });
          sendJsonRpcError(res, 200, -32012,
            "Kontrol requires the client to acknowledge its registered tools/list catalog before calling tools. Follow the kontrol.dev/tool-catalog-ack-v1 capability.",
            (req.body as { id?: unknown })?.id ?? null);
          return;
        }
        if (sessionState) {
          if (requestIsWaiter) {
            deps.recordMcpConnectionEvent?.({ kind: "watcher_started", sessionId, requestKind: requestToolName });
          }
          const activityAt = Date.now();
          sessionState.lastTransportActivityAt = activityAt;
          if (!requestIsSseStream) sessionState.lastApplicationActivityAt = activityAt;
          if (sessionState.identitySource !== "client_info_fallback") {
            logicalContinuity.touch(sessionState.logicalClientId, sessionState.sessionId, activityAt);
          }
          sessionRequestClass = requestIsSseStream ? "stream" : requestIsWaiter ? "waiter" : "execution";
          if (sessionRequestClass === "stream") {
            sessionState.activeSseStreams++;
            sessionState.transportAttached = true;
          }
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
        const requestedResourceUri = (req.body as { params?: { uri?: unknown } })?.params?.uri;
        if (requestRpcMethod === "resources/read" && (workspaceAppResourceKind(requestedResourceUri) || isWorkspaceAppHashedUri(requestedResourceUri))) {
          if (sessionState) {
            const activityAt = Date.now();
            sessionState.lastTransportActivityAt = activityAt;
            sessionState.lastApplicationActivityAt = activityAt;
            if (sessionState.identitySource !== "client_info_fallback") {
              logicalContinuity.touch(sessionState.logicalClientId, sessionState.sessionId, activityAt);
            }
          }
          // P0 resource admission: bounded even on the session fast path —
          // the large static serialization must never run outside admission control.
          try {
            await serveWorkspaceAppResource(
              res,
              requestId,
              req.body as { id?: unknown; params?: { uri?: unknown } },
              false,
              sessionId ?? logicalClientId(req),
              requestAbort.signal,
              req.header("accept-encoding"),
              { sessionId, generationId: config.launchGenerationId },
            );
          } finally {
            handlerSettled = true;
          }
          return;
        }
      } else if (initializeRequest) {
        // P1 #31: Admission pressure control — enforce caps at session creation
        const clientIdentity = logicalClientIdentity(req);
        const clientId = clientIdentity.id;
        const requestConversationId = conversationId(req);
        if (
          requestConversationId
          && clientIdentity.source !== "client_info_fallback"
          && logicalContinuity.has(clientId)
        ) {
          deps.recordMcpConnectionEvent?.({ kind: "reconnect_attempt", requestKind: "initialize" });
        }
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
        // Peer sessions are capped independently of the global session budget
        // so a peer can never starve owner MCP traffic.
        if (peerPrincipal && config.peer) {
          const peerSessionCount = [...mcpSessions.values()].filter((entry) => entry.authSource === "peer_token").length;
          if (peerSessionCount >= config.peer.maxActiveSessions) {
            logEvent(config.logging, "warn", "mcp_session_rejected", {
              requestId,
              reason: "peer_session_limit_reached",
              peerId: peerPrincipal.peerId,
              current: peerSessionCount,
              maxActiveSessions: config.peer.maxActiveSessions,
            });
            return res.status(503).json({
              jsonrpc: "2.0",
              id: (req.body as { id?: unknown } | undefined)?.id ?? null,
              error: { code: -32000, message: "Peer session limit reached. Try again later." },
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
        let sessionMcpServer: McpServer | undefined;
        transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            boundSessionId = newSessionId;
            if (transport) {
              transports.set(newSessionId, transport);
              mcpSessions.set(newSessionId, {
                sessionId: newSessionId,
                sessionLabel: mcpSessionLabel(clientId, newSessionId, requestConversationId),
                logicalClientId: clientId,
                identitySource: clientIdentity.source,
                authenticatedRole: connectionContext.authenticatedRole ?? "client",
                authenticatedPrincipalId: connectionContext.authenticatedPrincipalId,
                authSource: connectionContext.authSource ?? "anonymous",
                listenerKind: peerPrincipal ? "peer" : deps.publicListener?.() ? "owner_public" : "owner",
                peerAuthorizationRevision: peerPrincipal?.grantRevision,
                peerAuthorizationHash: peerPrincipal?.grantHash,
                conversationId: requestConversationId,
                approvalCorrelationId: clientIdentity.source === "client_info_fallback" ? undefined : clientId,
                workSessionId: connectionContext.workSessionId,
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
                transportAttached: false,
                activePolicyWaiters: 0,
                closing: false,
                closed: false,
                endRecorded: false,
                durableWorkerSession: connectionContext.authenticatedRole === "worker"
                  || Boolean(connectionContext.workSessionId),
                lastRpcMethod: "initialize",
                toolCatalogHandshake: { status: "pending" },
              });
              const createdState = mcpSessions.get(newSessionId)!;
              createdState.toolSurfaceVersion = readMcpToolSurface().version;
              catalogRefreshStats(createdState);
              if (sessionMcpServer) mcpServers.set(newSessionId, sessionMcpServer);
              let continuityAttachment: ReturnType<LogicalContinuityIndex["attach"]> | undefined;
              if (requestConversationId && clientIdentity.source !== "client_info_fallback") {
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
                deps.recordFreshInitialization?.(true, Math.round(performance.now() - requestStartedAt));
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
              } else {
                deps.recordFreshInitialization?.(false, Math.round(performance.now() - requestStartedAt));
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
            deps.recordMcpConnectionEvent?.({ kind: "transport_closed", sessionId: closedSessionId, requestKind: "transport" });
            const state = mcpSessions.get(closedSessionId);
            logEvent(config.logging, "debug", "mcp_transport_closed", {
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
              sessionLabel: state?.sessionLabel,
              activeRequests: state?.inFlightRequests ?? 0,
              activeSseStreams: state?.activeSseStreams ?? 0,
              generationId: config.launchGenerationId,
              buildId: config.expectedBuildId,
              terminationReason: state?.closing ? "server_shutdown" : "transport_closed",
            });
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
        // Authorization is resolved identically for modern and stateful legacy
        // requests. Client identity hints remain dispatch preferences only.
        const { context: connectionContext } = authenticatedConnection(req, deps, requestId);

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
          supervisorWake,
          deps.onScheduledJobCreated,
          db,
          mutationReceipts,
          (uri) => {
            if (uri === WORKSPACE_APP_URI) workspaceAppResourceMetrics.currentHashed++;
            else if (workspaceAppResourceKind(uri) === "previous") workspaceAppResourceMetrics.previousHashed++;
            else if (uri === OPENAI_WORKSPACE_APP_URI) workspaceAppResourceMetrics.openAiCompatibility++;
            else if (uri === LEGACY_WORKSPACE_APP_URI) workspaceAppResourceMetrics.legacyKontrol++;
            else if (uri === DEVDESKTOP_WORKSPACE_APP_URI) workspaceAppResourceMetrics.devDesktopMigration++;
          },
          recordPhaseTiming,
          scheduledJobs,
          reviewRoutes,
          (catalogSessionId, handshake) => {
            if (!catalogSessionId) return;
            const state = mcpSessions.get(catalogSessionId);
            if (!state) return;
            const evidence = qualificationEvidence.recordCatalogAcknowledgement({
              sessionId: catalogSessionId,
              captureId: handshake.captureId,
              serverBuildId: config.expectedBuildId,
              serverVersion: handshake.serverVersion || state.toolSurfaceVersion || "unknown",
              status: handshake.status,
              serverCatalogSha256: handshake.serverCatalogSha256,
              hostCatalogSha256: handshake.hostCatalogSha256,
              toolCount: handshake.toolCount,
              rejectionReason: handshake.reason,
              observedAt: handshake.acceptedAt,
            });
            state.toolCatalogHandshake = { ...handshake, evidenceId: evidence.recordId };
            logEvent(config.logging, handshake.status === "accepted" ? "info" : "warn", "mcp_tool_catalog_handshake", {
              sessionIdPrefix: sessionIdPrefix(catalogSessionId),
              status: handshake.status,
              serverCatalogSha256: handshake.serverCatalogSha256,
              hostCatalogSha256: handshake.hostCatalogSha256,
              toolCount: handshake.toolCount,
              acceptedAt: handshake.acceptedAt,
              reason: handshake.reason,
            });
          },
          undefined,
          qualificationEvidence,
          deps.reviewBrowserController,
          deps.reviewThreads,
        );
        sessionMcpServer = server;
        const initializedHandler = server.server.oninitialized;
        server.server.oninitialized = () => {
          initializedHandler?.();
          const initializedSessionId = transport?.sessionId ?? boundSessionId;
          if (initializedSessionId) void sendCatalogRefreshPulse(deps, initializedSessionId, "initialized");
        };
        const initializedSessionState = boundSessionId ? mcpSessions.get(boundSessionId) : undefined;
        if (initializedSessionState) {
          initializedSessionState.toolSurfaceVersion = readMcpToolSurface().version;
          mcpServers.set(boundSessionId!, server);
        }
        const serverCreateMs = performance.now() - serverCreateStarted;
        const transportConnectStarted = performance.now();
        await server.connect(transport);
        const state = (sessionId ? mcpSessions.get(sessionId) : undefined)
          ?? (transport.sessionId ? mcpSessions.get(transport.sessionId) : undefined);
        if (state) {
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
        (workspaceAppResourceKind((req.body as { params?: { uri?: unknown } } | undefined)?.params?.uri)
          || isWorkspaceAppHashedUri((req.body as { params?: { uri?: unknown } } | undefined)?.params?.uri))
      ) {
        // The OpenAI tunnel fetches app resources on a separate, sessionless
        // channel after initialization. Resources are read-only and the outer
        // bearer/tunnel authentication above has already succeeded, so serve
        // this one protocol method statelessly rather than constructing the
        // complete file/shell/ACP/policy tool universe just to return a static
        // HTML document. P0: still bounded — the stateless path acquires the
        // same resource admission permit under the client identity key.
        await serveWorkspaceAppResource(
          res,
          requestId,
          req.body as { id?: unknown; params?: { uri?: unknown } },
          true,
          logicalClientId(req),
          requestAbort.signal,
          req.header("accept-encoding"),
          { generationId: config.launchGenerationId },
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
        requestAdmissionWeight = admissionWeight;
        const admissionStartedAt = performance.now();
        let acquiredAdmission: (() => void) | null;
        try {
          acquiredAdmission = await admission.acquire(
            sessionId ?? logicalClientId(req),
            requestAdmissionTimeout(sessionState, config),
            admissionWeight,
            requestAbort.signal,
          );
        } catch (error) {
          handlerSettled = true;
          throw error;
        }
        admissionWaitMs = performance.now() - admissionStartedAt;
        if (!acquiredAdmission) {
          responseCloseClassification = "admission_rejected";
          handlerSettled = true;
          deps.recordMcpConnectionEvent?.({ kind: "admission_exhaustion", sessionId, requestKind: admissionClass });
          if (requestIsWaiter) {
            deps.recordMcpConnectionEvent?.({
              kind: "watcher_aborted",
              sessionId,
              requestKind: "admission_exhaustion",
              durationMs: Math.round(performance.now() - requestStartedAt),
            });
          }
          if (!requestIsWaiter) recordMcpCapacityRejection(requestToolName, admissionWeight, requestId);
          logEvent(config.logging, "warn", "mcp_request_rejected", {
            requestId,
            reason: "admission_queue_full_or_deadline",
            sessionIdPrefix: sessionIdPrefix(sessionId),
            admissionClass,
            admissionWaitMs: Math.round(admissionWaitMs),
            admission: admission.getStats(),
          });
          res.setHeader("Retry-After", "1");
          return res.status(503).json({
            jsonrpc: "2.0",
            id: (req.body as { id?: unknown })?.id ?? null,
            error: { code: -32029, message: "MCP request capacity is temporarily exhausted. Retry later." },
          });
        }
        admissionRelease = acquiredAdmission;
        res.setHeader("x-kontrol-admission-wait-ms", String(Math.round(admissionWaitMs)));
      }

      handlerStartedAt = performance.now();
      await mcpRequestContext.run({
        signal: requestAbort.signal,
        mcpSessionId: sessionId,
        mcpRequestId: requestId,
        conversationId: sessionState?.conversationId,
        principalId: sessionState?.authenticatedPrincipalId,
        approvalCorrelationId: sessionState?.approvalCorrelationId,
        onPolicyWaitStart,
        onPolicyWaitEnd,
      }, async () => {
        if (!requestIsSseStream && mcpRequestHasExecutionDeadline(requestRpcMethod, requestToolName)) {
          // Keep the timeout tracker and general operation diagnostics keyed
          // by the same durable per-request correlation ID.
          const expiredOperationId = operationId;
          await handleMcpRequestWithDeadline(
            transport!,
            req,
            res,
            req.body,
            config.mcpExecutionTimeoutMs,
            () => {
              handlerSettled = true;
              admissionRelease?.();
              admissionRelease = undefined;
              if (sessionId && sessionRequestClass === "execution" && sessionExecutionCounted) {
                const state = mcpSessions.get(sessionId);
                if (state && state.inFlightRequests > 0) state.inFlightRequests--;
                sessionExecutionCounted = false;
              }
            },
            () => {
              expiredMcpOperations.markExpired({
                operationId: expiredOperationId,
                requestId,
                generationId: config.launchGenerationId,
                sessionIdPrefix: sessionIdPrefix(sessionId),
                rpcMethod: requestRpcMethod,
                toolName: requestToolName,
                ownerHash: createHash("sha256")
                  .update(sessionState?.logicalClientId ?? sessionId ?? "unowned")
                  .digest("hex")
                  .slice(0, 16),
                ...(sessionState?.workSessionId ? {
                  workSessionHash: createHash("sha256").update(sessionState.workSessionId).digest("hex").slice(0, 16),
                } : {}),
                admissionWeight: requestAdmissionWeight,
                startedAtMs: requestStartedAtMs,
                expiredAtMs: Date.now(),
              });
              // Signal tools and policy waits that support cancellation. This
              // request-local abort never closes the shared MCP transport.
              requestAbort.abort(new McpExecutionTimeoutError(config.mcpExecutionTimeoutMs));
            },
            (outcome, error) => {
              expiredMcpOperations.markTerminated(expiredOperationId, outcome, error);
            },
          );
        } else {
          await transport!.handleRequest(req, res, req.body).finally(() => {
            handlerSettled = true;
          });
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
      requestErrorClass = error instanceof Error ? error.name : "UnknownError";
      responseCloseClassification = error instanceof McpExecutionTimeoutError
        ? "deadline_response"
        : error instanceof McpAdmissionUnavailableError
          ? "post_approval_admission_rejected"
          : "request_error";
      if (handlerStartedAt === 0 || !(error instanceof McpExecutionTimeoutError)) {
        handlerSettled = true;
      }
      logEvent(config.logging, "error", "mcp_request_error", {
        operationId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
        timedOut: error instanceof McpExecutionTimeoutError,
        admissionUnavailable: error instanceof McpAdmissionUnavailableError,
      });
      if (!res.headersSent) {
        if (error instanceof McpAdmissionUnavailableError) res.setHeader("Retry-After", "1");
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
      stopSseHeartbeat?.();
      stopSseHeartbeat = undefined;
      removePolicyWaiter();
      if (handlerSettled) {
        admissionRelease?.();
        admissionRelease = undefined;
      }
      // A timed-out SDK handler remains the owner of its permit and in-flight
      // count until the underlying operation actually terminates.
      if (sessionId && handlerSettled) {
        const state = mcpSessions.get(sessionId);
        if (state && sessionRequestClass) {
          if (sessionRequestClass === "stream" && state.activeSseStreams > 0) {
            state.activeSseStreams--;
            state.transportAttached = state.activeSseStreams > 0;
            if (state.activeSseStreams === 0 && standaloneStreamEstablished) {
              clearStandaloneSseDelivery(state, standaloneStreamGeneration);
            }
          }
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
      if (requestIsWaiter && handlerSettled) {
        deps.recordMcpConnectionEvent?.({
          kind: "watcher_completed",
          sessionId,
          requestKind: requestToolName,
          durationMs: Math.round(performance.now() - requestStartedAt),
        });
      }
      finalizeOperationDiagnostic();
    }
    } finally {
      finalizeOperationDiagnostic();
    }
}

async function handleModernMcpHttpRequest(
  deps: McpHttpDeps,
  req: Request,
  res: Response,
  webRequest: globalThis.Request,
): Promise<void> {
  if (deps.shuttingDown()) {
    res.setHeader("Retry-After", "1");
    res.status(503).json({
      jsonrpc: "2.0",
      id: (req.body as { id?: unknown } | undefined)?.id ?? null,
      error: { code: -32000, message: "KONTROL is draining; retry after restart." },
    });
    return;
  }

  if (deps.isPeerListener?.() && !req.peerPrincipal) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { context: connectionContext, workerClaims } = authenticatedConnection(
    req,
    deps,
    res.locals.requestId as string | undefined,
  );
  const conversation = connectionContext.conversationId;
  const principalId = connectionContext.authenticatedPrincipalId;
  const peer = req.peerPrincipal;
  const catalogIdentity = principalId
    ? JSON.stringify([
        connectionContext.listenerKind,
        principalId,
        connectionContext.authenticatedRole,
        connectionContext.workSessionId,
        connectionContext.workspaceSessionId,
        conversation,
        [...(connectionContext.peerCapabilities ?? [])].sort(),
      ])
    : undefined;
  const catalogMap = modernCatalogMap(deps);
  const acknowledgementMap = modernCatalogAcknowledgementMap(deps);
  const contextForModernRequest: ConnectionContext = {
    ...connectionContext,
    toolCatalogFingerprint: catalogIdentity ? catalogMap.get(catalogIdentity) : undefined,
  };

  const requestId = res.locals.requestId as string | undefined;
  const requestBody = req.body as { method?: unknown; id?: unknown; params?: { name?: unknown } } | undefined;
  if (
    deps.config.mcpToolCatalogAckRequired === true
    && requestBody?.method === "tools/call"
    && (!catalogIdentity || acknowledgementMap.get(catalogIdentity) !== true)
  ) {
    res.status(200).json({
      jsonrpc: "2.0",
      id: requestBody.id ?? null,
      error: {
        code: -32012,
        message: "Kontrol requires the client to acknowledge its registered tools/list catalog before calling tools. Follow the kontrol.dev/tool-catalog-ack-v1 capability.",
      },
    });
    return;
  }
  const requestKey = peer?.principalId ?? workerClaims?.workSessionId ?? req.auth?.clientId ?? req.ip ?? "anonymous";
  const controller = new AbortController();
  const abortFromWeb = () => controller.abort(webRequest.signal.reason);
  webRequest.signal.addEventListener("abort", abortFromWeb, { once: true });
  if (webRequest.signal.aborted) abortFromWeb();
  let released = false;
  let handlerSettled = false;
  let responseFinished = false;
  let releaseAdmission: (() => void) | undefined;
  let closeModernHandler: (() => void) | undefined;
  const releaseWhenQuiescent = () => {
    if (!handlerSettled || !responseFinished || released) return;
    released = true;
    closeModernHandler?.();
    closeModernHandler = undefined;
    releaseAdmission?.();
    releaseAdmission = undefined;
    webRequest.signal.removeEventListener("abort", abortFromWeb);
    res.off("close", onResponseClose);
    res.off("finish", onResponseFinish);
  };
  const onResponseClose = () => {
    if (!res.writableFinished) controller.abort(new Error("HTTP response closed"));
    responseFinished = true;
    releaseWhenQuiescent();
  };
  const onResponseFinish = () => {
    responseFinished = true;
    releaseWhenQuiescent();
  };
  const release = () => {
    if (released) return;
    released = true;
    releaseAdmission?.();
    releaseAdmission = undefined;
    webRequest.signal.removeEventListener("abort", abortFromWeb);
    res.off("close", onResponseClose);
    res.off("finish", onResponseFinish);
  };
  res.once("close", onResponseClose);
  res.once("finish", onResponseFinish);

  try {
    const acquired = await deps.mcpAdmission.acquire(
      requestKey,
      deps.config.mcpInteractiveAdmissionTimeoutMs,
      1,
      controller.signal,
    );
    if (!acquired) {
      res.setHeader("Retry-After", "1");
      res.status(503).json({
        jsonrpc: "2.0",
        id: requestBody?.id ?? null,
        error: { code: -32029, message: "MCP request capacity is temporarily exhausted. Retry later." },
      });
      release();
      return;
    }
    releaseAdmission = acquired;

    const handler = createMcpHandler(
      () => deps.createServerForSession(contextForModernRequest, (_sessionId, handshake) => {
        if (!catalogIdentity) return;
        if (!acknowledgementMap.has(catalogIdentity) && acknowledgementMap.size >= 256) {
          const oldest = acknowledgementMap.keys().next().value as string | undefined;
          if (oldest !== undefined) acknowledgementMap.delete(oldest);
        }
        acknowledgementMap.set(catalogIdentity, handshake.status === "accepted");
        logEvent(deps.config.logging, handshake.status === "accepted" ? "info" : "warn", "mcp_modern_tool_catalog_handshake", {
          requestId,
          status: handshake.status,
          serverCatalogSha256: handshake.serverCatalogSha256,
          hostCatalogSha256: handshake.hostCatalogSha256,
          toolCount: handshake.toolCount,
          reason: handshake.reason,
        });
      }),
      { legacy: "reject", bus: modernEventBus(deps) },
    );
    closeModernHandler = () => { void handler.close(); };
    const rpcId = typeof requestBody?.id === "string" || typeof requestBody?.id === "number"
      ? String(requestBody.id)
      : undefined;
    const scopedRequest = new Request(webRequest, { signal: controller.signal });
    const executionDeadline = mcpRequestHasExecutionDeadline(
      typeof requestBody?.method === "string" ? requestBody.method : undefined,
      typeof requestBody?.params?.name === "string" ? requestBody.params.name : undefined,
    );
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const fetchPromise = mcpRequestContext.run({
      signal: controller.signal,
      mcpRequestId: rpcId ?? requestId,
      conversationId: connectionContext.conversationId,
      principalId: connectionContext.authenticatedPrincipalId,
      approvalCorrelationId: conversation && principalId ? `${principalId}|conversation:${conversation}` : undefined,
    }, () => handler.fetch(scopedRequest));
    void fetchPromise.then(
      () => {
        handlerSettled = true;
        releaseWhenQuiescent();
      },
      () => {
        handlerSettled = true;
        releaseWhenQuiescent();
      },
    );
    let response: globalThis.Response;
    if (executionDeadline) {
      const timedOut = Symbol("mcp_execution_timeout");
      const outcome = await Promise.race([
        fetchPromise,
        new Promise<typeof timedOut>((resolve) => {
          deadlineTimer = setTimeout(() => {
            controller.abort(new McpExecutionTimeoutError(deps.config.mcpExecutionTimeoutMs));
            resolve(timedOut);
          }, deps.config.mcpExecutionTimeoutMs);
          deadlineTimer.unref?.();
        }),
      ]);
      if (outcome === timedOut) {
        res.status(504).json({
          jsonrpc: "2.0",
          id: requestBody?.id ?? null,
          error: { code: -32001, message: "MCP request execution exceeded its deadline." },
        });
        responseFinished = true;
        releaseWhenQuiescent();
        return;
      }
      response = outcome;
    } else {
      response = await fetchPromise;
    }
    if (deadlineTimer) clearTimeout(deadlineTimer);

    if (catalogIdentity && requestBody?.method === "tools/list" && response.ok) {
      try {
        const payload = await response.clone().json() as { result?: unknown };
        const fingerprint = fingerprintToolCatalog(payload.result);
        if (fingerprint) {
          // Keep only a bounded set of authenticated client/profile receipts.
          if (!catalogMap.has(catalogIdentity) && catalogMap.size >= 256) {
            const oldest = catalogMap.keys().next().value as string | undefined;
            if (oldest !== undefined) catalogMap.delete(oldest);
          }
          catalogMap.delete(catalogIdentity);
          catalogMap.set(catalogIdentity, fingerprint);
          if (!contextForModernRequest.toolCatalogFingerprint
            || contextForModernRequest.toolCatalogFingerprint.sha256 !== fingerprint.sha256) {
            acknowledgementMap.set(catalogIdentity, false);
          }
        }
      } catch {
        // The catalog is cached only when the exact JSON response can be
        // fingerprinted. An absent receipt makes strict acknowledgement fail closed.
      }
    }

    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    if (!response.body) {
      res.end();
      return;
    }
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>).pipe(res);
  } catch (error) {
    handlerSettled = true;
    if (!res.headersSent) responseFinished = true;
    releaseWhenQuiescent();
    if (res.headersSent || res.destroyed) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    logEvent(deps.config.logging, "error", "mcp_modern_request_failed", {
      requestId,
      reason: error instanceof Error ? error.message : String(error),
      method: typeof requestBody?.method === "string" ? requestBody.method : undefined,
    });
    res.status(500).json({
      jsonrpc: "2.0",
      id: requestBody?.id ?? null,
      error: { code: -32603, message: "Internal MCP request error" },
    });
  }
}
