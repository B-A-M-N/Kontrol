/**
 * The /mcp HTTP route: request lifecycle, admission, session establishment,
 * worker/reviewer authentication envelope, and transport wiring. Extracted
 * verbatim from src/server.ts (P1.2); createServer closures become an
 * explicit dependency object destructured at function entry.
 */
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
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
import type { McpPolicyWaiterRegistry } from "./policy-waiters.js";
import type { LogicalContinuityIndex } from "../mcp-logical-continuity.js";
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
  workspaceAppResourceKind,
} from "../workspace-app-resource.js";
import type { DatabaseHandle } from "../db/client.js";
import type { MutationReceiptStore } from "../mutation-receipts.js";
import type { LiveWaiterRegistry } from "../acp-bridge.js";
import type { Request, Response } from "express";

export interface McpHttpDeps {
  readonly config: ServerConfig;
  readonly db: DatabaseHandle;
  readonly transports: Map<string, Transport>;
  readonly mcpSessions: Map<string, McpSessionState>;
  readonly logicalContinuity: LogicalContinuityIndex;
  readonly policyWaiters: McpPolicyWaiterRegistry;
  readonly mcpAdmission: McpAdmission;
  readonly mcpWaiterAdmission: McpAdmission;
  readonly sessionLifecycle: McpSessionLifecycle;
  readonly workspaceAppResourceMetrics: { currentHashed: number; openAiCompatibility: number; legacyKontrol: number; devDesktopMigration: number };
  trackSocketAbort(socket: Socket, controller: AbortController): () => void;
  bearerAuth(): ((req: Request, res: Response, next: (error?: unknown) => void) => void) | undefined;
  resourceServerUrl(): URL | undefined;
  oauthEnabled(): boolean;
  shuttingDown(): boolean;
  serveWorkspaceAppResource(res: Response, requestId: string | undefined, body: { id?: unknown; params?: { uri?: unknown } }, sessionless: boolean): boolean;
  createServerForSession(connectionContext: ConnectionContext): { connect(transport: Transport): Promise<void> };
  supervisorWake(workSessionId: string): void;
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
}

export async function handleMcpHttpRequest(deps: McpHttpDeps, req: Request, res: Response): Promise<unknown> {
  const {
    config,
    db,
    transports,
    mcpSessions,
    logicalContinuity,
    policyWaiters,
    mcpAdmission,
    mcpWaiterAdmission,
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
          supervisorWake,
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
}
