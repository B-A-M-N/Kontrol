/**
 * Workspace-app resource fast path and static asset routes. Extracted
 * verbatim from src/server.ts (P1.2); the createServer closures become an
 * explicit dependency object.
 *
 * P0 resource admission: the Workspace App resource is a multi-megabyte JSON
 * serialization. Serving it was previously unbounded — any authenticated
 * client could hammer concurrent `resources/read` calls without ever
 * touching admission control. Reads now acquire a dedicated resource
 * admission permit (independent of execution/waiter pools so neither class
 * can starve the other) and release it on response finish/close or client
 * abort, whichever fires first.
 */
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Request, RequestHandler, Response } from "express";
import express from "express";
import type { ServerConfig } from "../config.js";
import { logEvent, sessionIdPrefix } from "../logger.js";
import type { McpAdmission } from "./mcp-admission.js";
import {
  DEVDESKTOP_WORKSPACE_APP_URI,
  LEGACY_WORKSPACE_APP_URI,
  OPENAI_WORKSPACE_APP_URI,
  WORKSPACE_APP_URI,
  WORKSPACE_APP_BUILD_ID,
  isWorkspaceAppHashedUri,
  workspaceAppResource,
  workspaceAppResourceKind,
} from "../workspace-app-resource.js";
import { uiBuildDirectory, setAssetHeaders, type WorkspaceAppResourceMetrics } from "./mcp-session-state.js";

const gzipAsync = promisify(gzip);
const workspaceAppEventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
workspaceAppEventLoopDelay.enable();
const MAX_WORKSPACE_APP_CACHE_ENTRIES = 4;
const MAX_WORKSPACE_APP_CACHE_BYTES = 64 * 1024 * 1024;
const workspaceAppContentJson = new Map<string, { json: string; bytes: number }>();
let workspaceAppContentJsonBytes = 0;
let workspaceAppContentJsonMetrics: WorkspaceAppResourceMetrics | undefined;
const reportedStaleWorkspaceUris = new Set<string>();
function cachedWorkspaceAppContentJson(kind: string, uri: string): string {
  const key = `${kind}:${uri}`;
  const existing = workspaceAppContentJson.get(key);
  if (existing) return existing.json;
  const resource = workspaceAppResource(uri);
  if (!resource) throw new Error(`Workspace App resource registry has no entry for ${uri}`);
  const content = {
    uri,
    mimeType: resource.mimeType,
    text: resource.html,
    ...(resource.metadata ? { _meta: resource.metadata } : {}),
  };
  const json = JSON.stringify(content);
  if (workspaceAppContentJson.size >= MAX_WORKSPACE_APP_CACHE_ENTRIES) {
    const oldest = workspaceAppContentJson.keys().next().value as string | undefined;
    if (oldest) {
      const removed = workspaceAppContentJson.get(oldest);
      workspaceAppContentJson.delete(oldest);
      workspaceAppContentJsonBytes -= removed?.bytes ?? 0;
    }
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= MAX_WORKSPACE_APP_CACHE_BYTES) {
    workspaceAppContentJson.set(key, { json, bytes });
    workspaceAppContentJsonBytes += bytes;
  }
  if (workspaceAppContentJsonMetrics) {
    workspaceAppContentJsonMetrics.cacheEntries = workspaceAppContentJson.size;
    workspaceAppContentJsonMetrics.cacheBytes = workspaceAppContentJsonBytes;
    workspaceAppContentJsonMetrics.maxCacheEntries = Math.max(workspaceAppContentJsonMetrics.maxCacheEntries, workspaceAppContentJson.size);
    workspaceAppContentJsonMetrics.maxCacheBytes = Math.max(workspaceAppContentJsonMetrics.maxCacheBytes, workspaceAppContentJsonBytes);
  }
  return json;
}

// Serialize the static app content once at server-module startup. The
// dynamic JSON-RPC envelope is still built per request, but no request pays a
// synchronous stringify cost for the widget body.
for (const [kind, uri] of [
  ["current", WORKSPACE_APP_URI],
  ["openai", OPENAI_WORKSPACE_APP_URI],
  ["legacy", LEGACY_WORKSPACE_APP_URI],
  ["devdesktop", DEVDESKTOP_WORKSPACE_APP_URI],
] as const) cachedWorkspaceAppContentJson(kind, uri);

export interface WorkspaceAppResourceAdapters {
  serializeContentJson(kind: string, uri: string): string;
  compress(input: Buffer): Promise<Buffer>;
}

export interface WorkspaceAppResourceRequestContext {
  sessionId?: string;
  generationId?: string;
}

export function createWorkspaceAppResourceServer(
  config: ServerConfig,
  metrics: WorkspaceAppResourceMetrics,
  resourceAdmission: McpAdmission,
  adapters: Partial<WorkspaceAppResourceAdapters> = {},
): {
  serve: (res: Response, requestId: string | undefined, body: { id?: unknown; params?: { uri?: unknown } }, sessionless: boolean, clientKey: string, abortSignal: AbortSignal | undefined, acceptEncoding?: string | undefined, context?: WorkspaceAppResourceRequestContext) => Promise<boolean>;
  assetRoutes: RequestHandler[];
} {
  workspaceAppContentJsonMetrics = metrics;
  const serializeContentJson = adapters.serializeContentJson ?? cachedWorkspaceAppContentJson;
  const compress = adapters.compress ?? gzipAsync;
  metrics.cacheEntries = workspaceAppContentJson.size;
  metrics.cacheBytes = workspaceAppContentJsonBytes;
  // P1 perf: the artifact is a large single-file HTML resource. The static
  // content JSON is serialized once at module load; only the small JSON-RPC envelope
  // varies per request. Compression is asynchronous so a second tab cannot
  // monopolize the event loop while mounting the widget.
  function acceptsGzip(acceptEncoding: string | undefined): boolean {
    if (!acceptEncoding) return false;
    return acceptEncoding.split(",").some((part) => {
      const [coding, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? Number(qParam.trim().slice(2)) : 1;
      return (coding.trim() === "gzip" || coding.trim() === "*") && Number.isFinite(q) && q > 0;
    });
  }

  async function serveWorkspaceAppResource(
    res: Response,
    requestId: string | undefined,
    body: { id?: unknown; params?: { uri?: unknown } },
    sessionless: boolean,
    clientKey: string,
    abortSignal: AbortSignal | undefined,
    acceptEncoding?: string | undefined,
    context?: WorkspaceAppResourceRequestContext,
  ): Promise<boolean> {
    const resourceStartedAt = performance.now();
    const uri = typeof body.params?.uri === "string" ? body.params.uri : undefined;
    const kind = workspaceAppResourceKind(uri);
    if (!kind) {
      if (!isWorkspaceAppHashedUri(uri)) return false;
      metrics.staleHashMisses++;
      if (reportedStaleWorkspaceUris.size >= 512) reportedStaleWorkspaceUris.clear();
      if (!reportedStaleWorkspaceUris.has(uri)) {
        reportedStaleWorkspaceUris.add(uri);
        logEvent(config.logging, "warn", "workspace_app_unknown_resource", {
          requestedUri: uri,
          currentUri: WORKSPACE_APP_URI,
          currentBuildId: WORKSPACE_APP_BUILD_ID,
          sessionId: sessionIdPrefix(context?.sessionId),
          generationId: context?.generationId ?? config.launchGenerationId,
          classification: "stale_workspace_app_hash",
        });
      }
      res.status(200).json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: { code: -32002, message: "The requested Workspace App build is no longer retained." },
      });
      return true;
    }

    if (kind === "current") metrics.currentHashed++;
    else if (kind === "previous") metrics.previousHashed++;
    else if (kind === "openai") metrics.openAiCompatibility++;
    else if (kind === "legacy") metrics.legacyKontrol++;
    else if (kind === "devdesktop") metrics.devDesktopMigration++;

    // Admission: bounded concurrency for the multi-megabyte serialization.
    // Rejection is a clean JSON-RPC capacity error, the same contract the
    // execution admission uses, so hosts can retry with backoff.
    const permit = await resourceAdmission.acquire(
      clientKey,
      config.mcpAdmissionTimeoutMs,
      1,
      abortSignal,
    );
    if (!permit) {
      metrics.admissionRejections++;
      logEvent(config.logging, "warn", "workspace_app_resource_rejected", {
        requestId,
        sessionless,
        resourceUri: uri,
        reason: "resource_admission_exhausted",
        admission: resourceAdmission.getStats(),
      });
      res.status(503).json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: { code: -32029, message: "Workspace App resource capacity is temporarily exhausted. Retry later." },
      });
      return true;
    }

    metrics.active++;
    if (metrics.active > metrics.maxActive) metrics.maxActive = metrics.active;

    // Hold the resource permit until the compression work itself has settled.
    // A disconnected caller must not release the permit while gzip is still
    // consuming CPU/memory, otherwise reconnect churn can exceed the pool.
    let released = false;
    let responseDone = false;
    let compressionDone = false;
    let aborted = false;
    let abortListener: (() => void) | undefined;
    const releaseOnce = () => {
      if (released || !responseDone || !compressionDone) return;
      released = true;
      metrics.active = Math.max(0, metrics.active - 1);
      permit();
      res.off("finish", markResponseDone);
      res.off("close", markResponseDone);
      if (abortSignal && abortListener) {
        abortSignal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
    };
    const markResponseDone = () => {
      if (responseDone) return;
      responseDone = true;
      releaseOnce();
    };
    const destroyIncompleteResponse = (originalError: unknown) => {
      try {
        if (!res.destroyed) res.destroy();
      } catch (destroyError) {
        logEvent(config.logging, "error", "workspace_app_resource_response_destroy_failed", {
          requestId,
          errorName: destroyError instanceof Error ? destroyError.name : "UnknownError",
          errorMessage: destroyError instanceof Error ? destroyError.message : String(destroyError),
          originalErrorName: originalError instanceof Error ? originalError.name : "UnknownError",
          originalErrorMessage: originalError instanceof Error ? originalError.message : String(originalError),
        });
      } finally {
        // The response can no longer carry a valid result. If destroy itself
        // fails, do not strand resource capacity behind a response that this
        // handler has abandoned.
        markResponseDone();
      }
    };
    res.once("finish", markResponseDone);
    res.once("close", markResponseDone);
    if (abortSignal) {
      const onAbort = () => {
        aborted = true;
        responseDone = true;
        if (compressionDone) releaseOnce();
      };
      abortListener = onAbort;
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    let failureStage: "serialization" | "compression" | "transmission" = "serialization";
    try {
      const resolvedUri = uri ?? WORKSPACE_APP_URI;
      // Cache the large static content serialization. Only the small JSON-RPC
      // envelope varies per request, and compression is async so two tabs cannot
      // monopolize the event loop with synchronous gzip work.
      const contentJson = serializeContentJson(kind, resolvedUri);
      const envelopeJson = `{"jsonrpc":"2.0","id":${JSON.stringify(body.id ?? null)},"result":{"contents":[${contentJson}]}}`;

      if (aborted || res.destroyed) return true;
      let wireBytes: number;
      let contentEncoding: "gzip" | "identity" = "identity";
      if (acceptsGzip(acceptEncoding)) {
        failureStage = "compression";
        const gzipped = await compress(Buffer.from(envelopeJson, "utf8"));
        if (aborted || res.destroyed) return true;
        wireBytes = gzipped.length;
        contentEncoding = "gzip";
        failureStage = "transmission";
        res.setHeader("content-type", "application/json");
        res.setHeader("content-encoding", "gzip");
        res.setHeader("content-length", String(wireBytes));
        res.setHeader("vary", "accept-encoding");
        res.end(gzipped);
      } else {
        const raw = Buffer.from(envelopeJson, "utf8");
        if (aborted || res.destroyed) return true;
        wireBytes = raw.length;
        failureStage = "transmission";
        res.setHeader("content-type", "application/json");
        res.setHeader("content-length", String(wireBytes));
        res.end(raw);
      }

      const totalMs = Math.round(performance.now() - resourceStartedAt);
      const eventLoopDelayMs = Number.isFinite(workspaceAppEventLoopDelay.mean)
        ? workspaceAppEventLoopDelay.mean / 1e6
        : 0;
      metrics.lastEventLoopDelayMs = eventLoopDelayMs;
      metrics.maxEventLoopDelayMs = Math.max(metrics.maxEventLoopDelayMs, eventLoopDelayMs);
      metrics.servedTotal++;
      metrics.lastDurationMs = totalMs;
      if (totalMs > metrics.maxDurationMs) metrics.maxDurationMs = totalMs;
      metrics.lastWireBytes = wireBytes;
      logEvent(config.logging, "info", "workspace_app_resource_served", {
        requestId,
        sessionless,
        resourceFastPath: true,
        resourceUri: uri,
        wireBytes,
        contentEncoding,
        totalMs,
        eventLoopDelayMs,
      });
      return true;
    } catch (error) {
      if (failureStage === "serialization") metrics.serializationFailures++;
      else if (failureStage === "compression") metrics.compressionFailures++;
      else metrics.transmissionFailures++;
      logEvent(config.logging, "error", "workspace_app_resource_failed", {
        requestId,
        sessionless,
        resourceFastPath: true,
        resourceUri: uri,
        failureStage,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      if (!aborted && !res.destroyed && !res.headersSent) {
        try {
          res.status(500).json({
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: { code: -32603, message: "Internal server error" },
          });
        } catch (sendError) {
          logEvent(config.logging, "error", "workspace_app_resource_failure_response_failed", {
            requestId,
            errorName: sendError instanceof Error ? sendError.name : "UnknownError",
            errorMessage: sendError instanceof Error ? sendError.message : String(sendError),
            originalErrorName: error instanceof Error ? error.name : "UnknownError",
            originalErrorMessage: error instanceof Error ? error.message : String(error),
          });
          destroyIncompleteResponse(error);
        }
      } else if (!aborted && !res.destroyed && res.headersSent) {
        // Once headers or body bytes are committed, a second JSON-RPC error
        // would corrupt the response stream. Close the incomplete response so
        // the peer sees a transport failure and the close listener can return
        // the admission permit.
        destroyIncompleteResponse(error);
      }
      return true;
    } finally {
      // This runs only after serialization/compression has either completed or
      // failed, so abort/close never returns capacity while work is still using
      // the resource pool.
      compressionDone = true;
      releaseOnce();
    }
  }

  const assetOptionsRoute: RequestHandler = (_req: Request, res: Response) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  };

  const assetStaticRoute: RequestHandler = express.static(uiBuildDirectory(), {
    immutable: true,
    maxAge: "1y",
    fallthrough: false,
    setHeaders: setAssetHeaders,
  });

  return { serve: serveWorkspaceAppResource, assetRoutes: [assetOptionsRoute, assetStaticRoute] };
}

export function countWorkspaceAppResourceUri(metrics: WorkspaceAppResourceMetrics, uri: string): void {
  if (uri === WORKSPACE_APP_URI) metrics.currentHashed++;
  else if (workspaceAppResourceKind(uri) === "previous") metrics.previousHashed++;
  else if (uri === OPENAI_WORKSPACE_APP_URI) metrics.openAiCompatibility++;
  else if (uri === LEGACY_WORKSPACE_APP_URI) metrics.legacyKontrol++;
  else if (uri === DEVDESKTOP_WORKSPACE_APP_URI) metrics.devDesktopMigration++;
}

export type { Request };
