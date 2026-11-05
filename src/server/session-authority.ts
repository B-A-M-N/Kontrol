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

import type { McpHttpDeps } from "./request-context.js";

/** Authenticated session attachment and authorization continuity. Moved verbatim from mcp-http.ts. */
export function ptyReviewCredential(req: Request, deps: McpHttpDeps): {
  claims: WorkerTokenClaims;
  binding: NonNullable<ReturnType<AgentPtyBindingStore["getByProcessSession"]>>;
} | undefined {
  const token = req.header("x-kontrol-worker-token");
  if (!token || !deps.config.acpAgentSecret || !deps.agentPtyBindings) return undefined;
  try {
    const claims = verifyWorkerToken(token, deps.config.acpAgentSecret);
    const scope = claims.agentPtyReview;
    if (!scope || !Number.isSafeInteger(scope.processGeneration) || scope.processGeneration < 1) return undefined;
    const binding = deps.agentPtyBindings.getByProcessSession(scope.processSessionId);
    if (!binding || binding.id !== scope.bindingId || binding.processGeneration !== scope.processGeneration
      || !["attached", "detached"].includes(binding.status)
      || binding.workSessionId !== claims.workSessionId
      || binding.workspaceSessionId !== claims.workspaceSessionId
      || binding.runId !== claims.runId
      || binding.ownerPrincipalId !== `worker-work-session:${claims.workSessionId}`) return undefined;
    return { claims, binding };
  } catch {
    return undefined;
  }
}

export function presentsPtyReviewScope(token: string | undefined): boolean {
  if (!token) return false;
  try {
    const payload = token.split(".")[1];
    if (!payload) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { agentPtyReview?: unknown };
    return claims.agentPtyReview !== undefined;
  } catch {
    return false;
  }
}

export function authenticatedConnection(req: Request, deps: McpHttpDeps, requestId?: string): {
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
  const ptyCredential = ptyReviewCredential(req, deps);
  if (workerClaims?.agentPtyReview && !ptyCredential) workerClaims = undefined;
  if (ptyCredential) workerClaims = ptyCredential.claims;
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
    ...(ptyCredential ? { agentPtyReviewBinding: {
      bindingId: ptyCredential.binding.id,
      processSessionId: ptyCredential.binding.processSessionId,
      processGeneration: ptyCredential.binding.processGeneration,
    } } : {}),
    workspaceLeaseNonce:
      (workerClaims as (WorkerTokenClaims & { workspaceLeaseNonce?: string }) | undefined)?.workspaceLeaseNonce
      || (workerClaims ? req.header("x-kontrol-workspace-lease-nonce") ?? undefined : undefined),
    conversationId: conversationId(req),
    clientPlatformHint,
    clientCapabilities: capabilities,
  };
  return { context, workerClaims };
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
