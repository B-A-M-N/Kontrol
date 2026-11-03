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

/** SSE writer ownership, heartbeat, closure, and release. Moved verbatim from mcp-http.ts. */
export type CatalogRefreshPhase = "initialized" | "get_stream" | "request_retry";

const modernEventBuses = new WeakMap<McpHttpDeps, InMemoryServerEventBus>();
const modernCatalogs = new WeakMap<McpHttpDeps, Map<string, { sha256: string; toolCount: number }>>();
const modernCatalogAcknowledgements = new WeakMap<McpHttpDeps, Map<string, boolean>>();

export function modernEventBus(deps: McpHttpDeps): InMemoryServerEventBus {
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

export function modernCatalogMap(deps: McpHttpDeps): Map<string, { sha256: string; toolCount: number }> {
  let catalogs = modernCatalogs.get(deps);
  if (!catalogs) {
    catalogs = new Map();
    modernCatalogs.set(deps, catalogs);
  }
  return catalogs;
}

export function modernCatalogAcknowledgementMap(deps: McpHttpDeps): Map<string, boolean> {
  let acknowledgements = modernCatalogAcknowledgements.get(deps);
  if (!acknowledgements) {
    acknowledgements = new Map();
    modernCatalogAcknowledgements.set(deps, acknowledgements);
  }
  return acknowledgements;
}

export function responseChunkBytes(chunk: unknown, encoding: unknown): number {
  if (typeof chunk === "string") {
    try { return Buffer.byteLength(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8"); }
    catch { return Buffer.byteLength(chunk, "utf8"); }
  }
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  return 0;
}

export function catalogRefreshStats(state: McpSessionState) {
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

export function rearmCatalogRefreshDelivery(state: McpSessionState): void {
  const refresh = state.catalogRefresh;
  if (!refresh) return;
  refresh.toolListRefreshSent = false;
  refresh.resourceListRefreshSent = false;
  refresh.toolListRefreshAttempts = 0;
  refresh.resourceListRefreshAttempts = 0;
  refresh.toolListRefreshLastAttemptMs = undefined;
  refresh.resourceListRefreshLastAttemptMs = undefined;
}

export function clearStandaloneSseDelivery(state: McpSessionState, ownedGeneration?: number): void {
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

export async function sendCatalogRefreshPulse(
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
