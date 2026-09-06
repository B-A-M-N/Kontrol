/**
 * Workspace-app resource fast path and static asset routes. Extracted
 * verbatim from src/server.ts (P1.2); the createServer closures become an
 * explicit dependency object.
 */
import type { Request, RequestHandler, Response } from "express";
import express from "express";
import type { ServerConfig } from "../config.js";
import { logEvent } from "../logger.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
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
): {
  serve: (res: Response, requestId: string | undefined, body: { id?: unknown; params?: { uri?: unknown } }, sessionless: boolean) => boolean;
  assetRoutes: RequestHandler[];
} {
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

    if (kind === "current") metrics.currentHashed++;
    else if (kind === "openai") metrics.openAiCompatibility++;
    else if (kind === "legacy") metrics.legacyKontrol++;
    else if (kind === "devdesktop") metrics.devDesktopMigration++;

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
    metrics.servedTotal++;
    metrics.lastDurationMs = totalMs;
    if (totalMs > metrics.maxDurationMs) metrics.maxDurationMs = totalMs;
    logEvent(config.logging, "info", "workspace_app_resource_served", {
      requestId,
      sessionless,
      resourceFastPath: true,
      resourceUri: uri,
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
