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
import { createStartupReconciliation } from "./server/startup-recovery.js";
import { createShutdownController } from "./server/shutdown.js";
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
import { setDefaultAcpTimeout } from "./acp-gateway.js";
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
import { resolveDeploymentContext, type DeploymentContext } from "./runtime-context.js";
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
import { createPolicyWaiterRegistry } from "./server/policy-waiters.js";
import { createMcpSessionLifecycle } from "./server/mcp-session-lifecycle.js";
import { healthz, readinessChecks, sendReadiness } from "./server/readiness.js";
import { handleDiagnostics } from "./server/diagnostics.js";
import { handleMcpHttpRequest, type McpHttpDeps } from "./server/mcp-http.js";
import {
  handleMcpRequestWithDeadline,
  McpAdmission,
  McpAdmissionUnavailableError,
  mcpAdmissionWeight,
  McpExecutionTimeoutError,
  mcpRequestHasExecutionDeadline,
} from "./server/mcp-admission.js";
import {
  ACP_HTTP_BODY_LIMIT_BYTES,
  MCP_HTTP_BODY_LIMIT_BYTES,
} from "./server/mcp-session-state.js";
import {
  authenticatedAcpBodyGate,
  conversationId,
  logicalClientId,
  logicalClientIdentity,
  mcpSessionLabel,
  rejectOversizedBody,
  resolveMcpMemoryBudget,
  sendJsonRpcError,
  setAssetHeaders,
  type McpPolicyWaiter,
  type McpSessionClientMetrics,
  type McpSessionMetrics,
  type McpSessionState,
  type McpSessionWindowKind,
  type McpTimingSample,
  type PhaseTimingSample,
  type RunningServer,
  uiBuildDirectory,
  type WorkspaceAppResourceMetrics,
} from "./server/mcp-session-state.js";
import { deriveAuth } from "./server/auth.js";
import { createWorkspaceAppResourceServer } from "./server/workspace-resource-route.js";
// P1.2 decomposition: admission classes/weights/queue live in
// src/server/mcp-admission.ts; session-state types, identity derivation, and
// body gates live in src/server/mcp-session-state.ts. Re-export the public
// names so existing importers of ./server.js keep working unchanged.
export {
  ACP_HTTP_BODY_LIMIT_BYTES,
  authenticatedAcpBodyGate,
  MCP_HTTP_BODY_LIMIT_BYTES,
  rejectOversizedBody,
  sendJsonRpcError,
} from "./server/mcp-session-state.js";
export {
  McpAdmission,
  McpAdmissionUnavailableError,
  McpExecutionTimeoutError,
} from "./server/mcp-admission.js";
export { type RunningServer } from "./server/mcp-session-state.js";


export function createServer(config = loadConfig(), deploymentContext: DeploymentContext = resolveDeploymentContext()): RunningServer {
  // P0.3: module-level defaults are injected from parsed config, never read
  // from process.env at import time.
  setDefaultAcpTimeout(config.acpDispatchTimeoutMs);
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
  const policyWaiters = createPolicyWaiterRegistry();
  const mcpPolicyWaiters = policyWaiters.waiters;
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
  const workspaceAppResourceMetrics: WorkspaceAppResourceMetrics = {
    currentHashed: 0,
    openAiCompatibility: 0,
    legacyKontrol: 0,
    devDesktopMigration: 0,
    servedTotal: 0,
    lastDurationMs: 0,
    maxDurationMs: 0,
  };
  const workspaceAppResources = createWorkspaceAppResourceServer(config, workspaceAppResourceMetrics);
  const serveWorkspaceAppResource = workspaceAppResources.serve;
  const { oauthEnabled, oauthProvider, bearerAuth, resourceServerUrl } = deriveAuth(config);
  // ONE shared DB handle for every manager + the review workflow service, so the
  // workflow can commit state + event log in a SINGLE transaction (P1 #15).
  // P0.3: deployment identity flows from the entrypoint-resolved context via
  // config — the DB layer never reads process.env.
  const db: DatabaseHandle = openDatabase(config.stateDir, {
    deploymentId: deploymentContext.deploymentId,
    expectedSchemaVersion: deploymentContext.expectedSchemaVersion,
  });
  const mutationReceipts = createMutationReceiptStore(db);
  const workspaceStore = createWorkspaceStore(db);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager({
    snapshotStoreRoot: join(config.stateDir, "workspace-snapshots"),
    snapshotLimits: {
      // P1.5: operator overrides for capture admission; unset values fall
      // back to the store's bounded defaults (never unbounded).
      ...(config.fsSnapshot.maxFiles !== undefined && { maxFiles: config.fsSnapshot.maxFiles }),
      ...(config.fsSnapshot.maxBytes !== undefined && { maxBytes: config.fsSnapshot.maxBytes }),
      ...(config.fsSnapshot.maxFileBytes !== undefined && { maxFileBytes: config.fsSnapshot.maxFileBytes }),
    },
    // P1.6: operator-extended exclusion list, added to the defaults.
    excludedDirectories: config.fsSnapshot.excludedDirectories,
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

  const sessionLifecycle = createMcpSessionLifecycle({
    config,
    cancelPolicyWaitersForSession: (sessionId, requestId) => policyWaiters.cancelForSession(sessionId, requestId),
    mcpSessions,
    transports,
    logicalContinuity,
    processSessions,
    workspaceAppResourceMetrics,
  });
  const {
    recordMcpTiming,
    recordPhaseTiming,
    recordMcpCapacityRejection,
    mapNumberCounts,
    mcpSseDiagnostics,
    mcpTimingDiagnostics,
    sessionWindowMetrics,
    recordMcpSessionEnd,
    recordMcpSessionCreated,
    recordMcpWindowEvent,
    mcpSessionReuseMetrics,
    estimateMcpSessionMemoryCost,
    getMemoryPressureState,
    finalizeMcpSession,
    reapIdleMcpSessions,
  } = sessionLifecycle;
  const mcpSessionMetrics = sessionLifecycle.metrics;
  const mcpCapacityRejectionsByTool = sessionLifecycle.capacityRejectionsByTool;
  const mcpCapacityRejectionsByWeight = sessionLifecycle.capacityRejectionsByWeight;

  const readinessDeps = {
    config,
    databaseProbe: () => {
      const databaseProbe = db.sqlite.prepare("select 1 as ok").get() as { ok?: number } | undefined;
      if (databaseProbe?.ok !== 1) throw new Error("database probe failed");
    },
    schemaVersion: () => {
      const schema = db.sqlite.prepare("select max(version) as v from kontrol_schema_migrations").get() as { v?: number } | undefined;
      return Number(schema?.v ?? 0);
    },
    executionAdmissionStats: () => mcpAdmission.getStats(),
    workspaceRegistryInitialized: () => Boolean(workspaces && workspaceStore),
    reviewSubsystemInitialized: () => Boolean(reviewWorkflow && workSessions && eventStore),
    acpDispatcherInitialized: () => Boolean(dispatcher),
    buildId: () => buildMeta.buildId,
    listAliveAgents: () => agentRegistry.listAlive(),
  };
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
  startupRecovery.releasedSupervisorLeases = supervisorRuns.releaseExpiredClaims();
  const startupReconciliation = createStartupReconciliation({
    config,
    db,
    startupRecovery,
    approvalRequests,
    workSessions,
    eventStore,
    continuationManager,
    maintenance,
    supervisorRuns,
  });
  const { integrity, databaseIntegrity, terminalWorkSessionStatuses } = startupReconciliation;
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
  // lifecycle callback ran (paged in src/server/startup-recovery.ts).
  startupReconciliation.reconcileTerminalGrants(policyEngine);
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

  app.options("/mcp-app-assets/{*asset}", workspaceAppResources.assetRoutes[0]);

  app.use(
    "/mcp-app-assets",
    workspaceAppResources.assetRoutes[1],
  );
  app.get("/healthz", (_req, res) => healthz(res));

  // Core readiness is used while KONTROL is starting before adapters register.
  app.get("/core-readyz", (_req, res) => sendReadiness(res, readinessChecks(readinessDeps, _req, false), policyCanAsk(config.policy)));
  // Strict readiness is the operational contract used by the tunnel and the
  // persistent supervisor. It must fail when a required worker disappears.
  app.get("/readyz", (req, res) => sendReadiness(res, readinessChecks(readinessDeps, req, true), policyCanAsk(config.policy)));

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
  const supervisorWake = (workSessionId: string): void => {
    supervisorRuntime?.wake(workSessionId);
  };

  const mcpHttpDeps = {
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
    bearerAuth: () => bearerAuth,
    resourceServerUrl: () => resourceServerUrl,
    oauthEnabled: () => oauthEnabled,
    shuttingDown: () => shuttingDown,
    serveWorkspaceAppResource,
    createServerForSession: (connectionContext: ConnectionContext) => createMcpServer(
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
    ),
    mutationReceipts,
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
    liveWaiters,
    agentMessages,
    supervisorRuns,
    supervisorWake,
  };

  const diagnosticsDeps = {
    config,
    mcpSessions,
    mcpAdmission,
    mcpWaiterAdmission,
    sessionLifecycle,
    policyWaiters,
    workspaceAppResourceMetrics,
    logicalContinuity,
    startupRecovery,
    databaseIntegrity,
    maintenanceStats,
    snapshotStoreDiagnostics,
    degradedAuditSnapshot,
    processSessionMetrics: () => processSessions.getMetrics(),
    countActiveWorkSessions: () => workSessions.countActiveWorkSessions(),
    countPendingReviews: () => workSessions.countPendingReviews(),
    countAliveAgents: () => agentRegistry?.listAlive?.()?.length ?? 0,
    listPendingApprovals: () => approvalRequests.listPending(),
    sqlite: () => (db as unknown as { sqlite?: { prepare?: (sql: string) => { get?: () => unknown } } }).sqlite,
  };

  app.get("/diagnostics", (req, res) => {
    void handleDiagnostics(diagnosticsDeps, req, res);
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
  app.all("/mcp", (req, res) => {
    void handleMcpHttpRequest(mcpHttpDeps, req, res);
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
      // P0.3: config-injected; the env fallback inside supervisor-runtime is
      // then dead for server paths.
      maxInflight: config.supervisorMaxInflight,
      onVerify: async (workSessionId, deadlineAt, submission) => {
        await verifyMissionSubmission({
          workSessionId,
          maxInflight: config.verifyMaxInflight,
          sandbox: config.verifySandbox,
          childEnvironmentAllowlist: config.childEnvironmentAllowlist,
          verifyToolchainPaths: config.verifyToolchainPaths,
          sandboxExecutablePath: config.verifySandboxExecutable,
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

  const shutdown = createShutdownController({
    config,
    db,
    transports,
    mcpSessions,
    sessionLifecycle,
    mcpAdmission,
    mcpWaiterAdmission,
    startupReconciliation,
    maintenance,
    reviewCheckpoints,
    dispatcher,
    supervisorRuntime,
    supervisorRuns,
    mcpSessionChurnTimer,
    shuttingDown: { get value() { return shuttingDown; }, set value(v: boolean) { shuttingDown = v; } },
    oauthProvider,
    workspaceStore,
    workSessions,
    agentRegistry,
    eventStore,
    continuationManager,
    dispatchOutbox,
    processSessions,
    shutdownMissionVerifiers,
    integrity,
  });
  return {
    app,
    config,
    dispatcher,
    close: shutdown.close,
    drain: shutdown.drain,
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

export async function runServer(config = loadConfig()): Promise<void> {
  // P0.3: deployment/runtime authority is resolved ONCE here, at the process
  // entrypoint, and passed explicitly downstream. Implementation code no
  // longer reads these fields from process.env.
  const deploymentContext = resolveDeploymentContext();
  const buildMeta = readBuildIdentity(join(dirname(fileURLToPath(import.meta.url)), "build-meta.json"));
  const inheritedLockToken = process.env.KONTROL_RUNTIME_LOCK_TOKEN;
  const runtimeLock: RuntimeLockHandle = inheritedLockToken
    ? { path: runtimeLockPath(config.stateDir), record: assertRuntimeLock(config.stateDir, inheritedLockToken) }
    : await acquireRuntimeLock(config.stateDir, {
      launcher: deploymentContext.launcher ?? "serve",
      generationId: deploymentContext.launchGenerationId,
      buildId: buildMeta.buildId,
      artifactPath: dirname(fileURLToPath(import.meta.url)),
      port: config.port,
    });
  const ownsRuntimeLock = !inheritedLockToken;
  let serverResources: ReturnType<typeof createServer>;
  try {
    serverResources = createServer(config, deploymentContext);
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
