/**
 * Express app assembly: host validation, request logging, auth-mode route
 * mounting (OAuth router or tunnel discovery metadata), protocol body gates,
 * and static workspace-app assets. Extracted verbatim from src/server.ts
 * (P1.2); the createServer closures become an explicit dependency object.
 */
import { randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { hostHeaderValidation, localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { ServerConfig } from "../config.js";
import type { SingleUserOAuthProvider } from "../oauth-provider.js";
import { logEvent, requestPath } from "../logger.js";
import { requestLogFields } from "../mcp/workspace-server.js";
import {
  authenticatedAcpBodyGate,
  rejectOversizedBody,
  setAssetHeaders,
  ACP_HTTP_BODY_LIMIT_BYTES,
  MCP_HTTP_BODY_LIMIT_BYTES,
  uiBuildDirectory,
} from "./mcp-session-state.js";
import type { RequestHandler } from "express";

export interface HttpAppDeps {
  readonly config: ServerConfig;
  readonly oauthProvider: SingleUserOAuthProvider | null;
  readonly resourceServerUrl: URL | undefined;
  readonly bearerAuth: ((req: Request, res: Response, next: (error?: unknown) => void) => void) | undefined;
}

export function createHttpApp(deps: HttpAppDeps): { app: Express } {
  const { config } = deps;
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

  if (config.logging.trustProxy) {
    app.set(
      "trust proxy",
      config.logging.trustProxy === "true" ? true : config.logging.trustProxy,
    );
  }

  app.use((req: Request, res: Response, next: NextFunction) => {
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

  if (deps.oauthProvider) {
    app.use(
      mcpAuthRouter({
        provider: deps.oauthProvider,
        issuerUrl: new URL(config.publicBaseUrl),
        baseUrl: new URL(config.publicBaseUrl),
        resourceServerUrl: deps.resourceServerUrl,
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
    app.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(404).json({ error: { code: "not_found", message: "OAuth disabled in tunnel mode" } });
    });
  }

  // Authenticate protected requests before consuming their bodies, then parse
  // each protocol with its own explicit finite limit. This keeps a large
  // unauthenticated request from spending parser memory and avoids the SDK's
  // unconditional ~100 KB parser.
  if (deps.bearerAuth) {
    app.use("/mcp", (req: Request, res: Response, next: NextFunction) => deps.bearerAuth!(req, res, next));
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

  return { app };
}

export function mountWorkspaceAppAssets(app: Express): void {
  app.options("/mcp-app-assets/{*asset}", ((_req: Request, res: Response) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  }) as RequestHandler);

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );
}
