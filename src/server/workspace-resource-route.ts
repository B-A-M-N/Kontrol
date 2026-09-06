/**
 * Workspace-app resource fast path and static asset routes. Extracted
 * verbatim from src/server.ts (P1.2); the createServer closures become an
 * explicit dependency object.
 *
 * P0 resource admission: the Workspace App resource is a ~10 MB JSON
 * serialization. Serving it was previously unbounded — any authenticated
 * client could hammer concurrent `resources/read` calls without ever
 * touching admission control. Reads now acquire a dedicated resource
 * admission permit (independent of execution/waiter pools so neither class
 * can starve the other) and release it on response finish/close or client
 * abort, whichever fires first.
 */
import { gzipSync } from "node:zlib";
import type { Request, RequestHandler, Response } from "express";
import express from "express";
import type { ServerConfig } from "../config.js";
import { logEvent } from "../logger.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpAdmission } from "./mcp-admission.js";
import {
  DEVDESKTOP_WORKSPACE_APP_URI,
  LEGACY_WORKSPACE_APP_URI,
  OPENAI_WORKSPACE_APP_URI,
  WORKSPACE_APP_HTML,
  WORKSPACE_APP_URI,
  workspaceAppResourceKind,
  workspaceAppResourceMeta,
} from "../workspace-app-resource.js";
import { uiBuildDirectory, setAssetHeaders, type WorkspaceAppResourceMetrics } from "./mcp-session-state.js";

export function createWorkspaceAppResourceServer(
  config: ServerConfig,
  metrics: WorkspaceAppResourceMetrics,
  resourceAdmission: McpAdmission,
): {
  serve: (res: Response, requestId: string | undefined, body: { id?: unknown; params?: { uri?: unknown } }, sessionless: boolean, clientKey: string, abortSignal: AbortSignal | undefined, acceptEncoding?: string | undefined) => Promise<boolean>;
  assetRoutes: RequestHandler[];
} {
  // P1 perf: the artifact is ~10 MB raw / ~1.8 MB gzipped. The previous
  // implementation always called res.json(), so the ACTUAL wire transfer was
  // the raw size — the "1.82 MiB user-facing cost" implied by local gzipSync
  // measurements was never delivered on the wire. The envelope is compressed
  // per request (never cached whole): the JSON-RPC id and the echoed resource
  // uri vary per request, and a cached deflate stream would replay the first
  // requester's id/uri to everyone behind it.
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
  ): Promise<boolean> {
    const resourceStartedAt = performance.now();
    const uri = typeof body.params?.uri === "string" ? body.params.uri : undefined;
    const kind = workspaceAppResourceKind(uri);
    if (!kind) return false;

    if (kind === "current") metrics.currentHashed++;
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

    // Release exactly once on the first of finish/close/abort. The permit is
    // held only for the serialization window, never across a keep-alive.
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      metrics.active = Math.max(0, metrics.active - 1);
      permit();
      res.off("finish", releaseOnce);
      res.off("close", releaseOnce);
    };
    res.once("finish", releaseOnce);
    res.once("close", releaseOnce);
    if (abortSignal) {
      if (abortSignal.aborted) releaseOnce();
      else abortSignal.addEventListener("abort", releaseOnce, { once: true });
    }

    const isCurrent = kind === "current";
    const content: { uri: string; mimeType: string; text: string; _meta?: Record<string, unknown> } = {
      uri: uri ?? WORKSPACE_APP_URI,
      mimeType: isCurrent ? RESOURCE_MIME_TYPE : "text/html+skybridge",
      text: WORKSPACE_APP_HTML,
      ...(isCurrent ? { _meta: workspaceAppResourceMeta() } : {}),
    };
    const envelope = {
      jsonrpc: "2.0" as const,
      id: body.id ?? null,
      result: { contents: [content] },
    };

    let wireBytes: number;
    if (acceptsGzip(acceptEncoding)) {
      const gzipped = gzipSync(Buffer.from(JSON.stringify(envelope), "utf8"));
      wireBytes = gzipped.length;
      res.setHeader("content-type", "application/json");
      res.setHeader("content-encoding", "gzip");
      res.setHeader("content-length", String(wireBytes));
      res.setHeader("vary", "accept-encoding");
      res.end(gzipped);
    } else {
      const raw = Buffer.from(JSON.stringify(envelope), "utf8");
      wireBytes = raw.length;
      res.setHeader("content-type", "application/json");
      res.setHeader("content-length", String(wireBytes));
      res.end(raw);
    }

    const totalMs = Math.round(performance.now() - resourceStartedAt);
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
      contentEncoding: acceptsGzip(acceptEncoding) ? "gzip" : "identity",
      totalMs,
    });
    return true;
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
  else if (uri === OPENAI_WORKSPACE_APP_URI) metrics.openAiCompatibility++;
  else if (uri === LEGACY_WORKSPACE_APP_URI) metrics.legacyKontrol++;
  else if (uri === DEVDESKTOP_WORKSPACE_APP_URI) metrics.devDesktopMigration++;
}

export type { Request };
