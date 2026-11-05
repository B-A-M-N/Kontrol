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
import { exchangeAgentPtyReviewCredential } from "../agent-pty-review-credential.js";
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
import type { AgentPtyBindingStore } from "../agent-pty-bindings.js";
import type { MutationReceiptStore } from "../mutation-receipts.js";
import type { LiveWaiterRegistry } from "../acp-bridge.js";
import type { Request, Response } from "express";
import { readMcpToolSurface } from "../mcp/tool-names.js";
import { fingerprintToolCatalog, TOOL_CATALOG_ACK_METHOD } from "../mcp/tool-catalog-handshake.js";

/** Shared HTTP request identity, correlation, and admission context. Moved verbatim from mcp-http.ts. */
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
  goalStore?: import("../goal-store.js").GoalStore;
  workspaces: import("../workspaces.js").WorkspaceRegistry;
  reviewCheckpoints: import("../review-checkpoints.js").ReviewCheckpointManager;
  processSessions: import("../process-sessions.js").ProcessSessionManager;
  agentPtyBindings?: AgentPtyBindingStore;
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

export function externalCorrelation(req: Request): string | undefined {
  for (const name of ["cf-ray", "x-kontrol-correlation-id", "x-request-id"]) {
    const value = req.header(name)?.trim();
    if (value && value.length <= 128 && /^[A-Za-z0-9._:/-]+$/.test(value)) return value;
  }
  return undefined;
}

export function qualificationCaptureId(req: Request): string | undefined {
  const value = req.header("x-kontrol-qualification-capture-id")?.trim();
  return value && value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value) ? value : undefined;
}

export function requestAdmissionTimeout(state: McpSessionState | undefined, config: ServerConfig): number {
  return state?.durableWorkerSession ? config.mcpAdmissionTimeoutMs : config.mcpInteractiveAdmissionTimeoutMs;
}
