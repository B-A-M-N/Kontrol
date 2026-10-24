/**
 * Peer-facing HTTP application assembly (M1): a separate Express app that
 * mounts ONLY the peer-authenticated MCP surface, /peer/* endpoints, and
 * minimal liveness. It deliberately has no ACP router, no owner OAuth flow,
 * no diagnostics, no policy-approval router, and no static Workspace App
 * assets. All state (DB, workspaces, sessions) is shared with the owner app
 * through injected dependencies — this is one Kontrol process, one runtime
 * lock, one build identity.
 */
import { randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { ServerConfig } from "../config.js";
import { logEvent, requestPath } from "../logger.js";
import { requestLogFields } from "../mcp/workspace-server.js";
import { createPeerAuthMiddleware, type PeerCredentialRegistry } from "../peer/auth.js";
import {
  MCP_HTTP_BODY_LIMIT_BYTES,
  rejectOversizedBody,
  sendJsonRpcError,
} from "./mcp-session-state.js";

export interface PeerHttpAppDeps {
  readonly config: ServerConfig;
  readonly registry: PeerCredentialRegistry;
  /** Bound MCP request handler (handleMcpHttpRequest with peer-listener deps). */
  readonly handleMcpRequest: (req: Request, res: Response) => void;
}

export function createPeerHttpApp(deps: PeerHttpAppDeps): Express {
  const { config } = deps;
  const peer = config.peer;
  if (!peer) throw new Error("createPeerHttpApp requires config.peer (KONTROL_PEER_ENABLED=1).");

  const app = express();
  // DNS-rebinding protection scoped to the peer interface. Unlike the owner
  // app there is no "*" escape hatch: the peer bind host is always specific.
  app.use(hostHeaderValidation([peer.bindHost, "localhost", "127.0.0.1"]));

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
      logEvent(config.logging, "info", "http_request", {
        requestId,
        listener: "peer",
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        rpcMethod: typeof req.body?.method === "string" ? req.body.method : undefined,
        ...requestLogFields(req, config),
      });
    });
    next();
  });

  // Unauthenticated liveness: boolean status only, mirroring /healthz. This
  // route is registered BEFORE app.use("/peer", peerAuth) below, so Express
  // matches it first and liveness requires no peer bearer token.
  app.get("/peer/healthz", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, name: "kontrol-peer" });
  });

  // Authenticate before consuming bodies; the peer credential registry is the
  // only trust boundary on this listener.
  const peerAuth = createPeerAuthMiddleware(deps.registry, config);
  app.use("/mcp", peerAuth);
  app.use("/peer", peerAuth);

  const mcpBodyLimit = Math.min(peer.requestBytesLimit, MCP_HTTP_BODY_LIMIT_BYTES);
  app.use(
    "/mcp",
    rejectOversizedBody(mcpBodyLimit, "mcp"),
    express.json({ limit: mcpBodyLimit }),
  );
  app.use(
    "/peer",
    rejectOversizedBody(peer.requestBytesLimit, "peer"),
    express.json({ limit: peer.requestBytesLimit }),
  );

  app.all("/mcp", (req: Request, res: Response) => deps.handleMcpRequest(req, res));

  // M1 exposes no /peer job endpoints yet; authenticated 404 keeps the shape
  // explicit for the follow-on outbound job protocol.
  app.use("/peer", (_req: Request, res: Response) => {
    res.status(404).json({ error: { code: "not_found", message: "Unknown peer endpoint" } });
  });

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

  return app;
}
