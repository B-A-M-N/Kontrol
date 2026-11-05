/**
 * Stateless (modern per-request) MCP HTTP handler: no session lifecycle, no
 * SSE stream ownership. Extracted verbatim from src/server/mcp-http.ts; the
 * legacy stateful handler keeps the session state machine. Both paths share
 * the same authorization policy and helper planes (request-context,
 * session-authority, stream-lifecycle).
 */

import { Readable } from "node:stream";
import { createMcpHandler, InMemoryServerEventBus, isInitializeRequest, isLegacyRequest, checkResourceAllowed } from "@modelcontextprotocol/server";
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
import { logEvent, requestPath, sessionIdPrefix } from "../logger.js";
import {
  constantTimeStringEqual,
  createMcpServer,
  requestLogFields,
  type ConnectionContext,
  mcpRequestContext,
  type Transport,
} from "../mcp/workspace-server.js";
import type { Request, Response } from "express";
import { fingerprintToolCatalog, TOOL_CATALOG_ACK_METHOD } from "../mcp/tool-catalog-handshake.js";
import type { McpHttpDeps } from "./request-context.js";
import { authenticatedConnection, isLoopbackAddress, presentsPtyReviewScope, ptyReviewCredential } from "./session-authority.js";
import { type CatalogRefreshPhase, modernCatalogAcknowledgementMap, modernCatalogMap, modernEventBus } from "./stream-lifecycle.js";

export async function handleModernMcpHttpRequest(
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
