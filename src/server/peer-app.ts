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
import type { ServerConfig } from "../config.js";
import { strictHostHeaderValidation } from "../ingress/host-policy.js";
import { logEvent, requestPath } from "../logger.js";
import { requestLogFields } from "../mcp/workspace-server.js";
import { createPeerAuthMiddleware, type PeerCredentialRegistry } from "../peer/auth.js";
import { registerPeerJobRoutes } from "../peer/jobs/routes.js";
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
  /** Returns true while the process is shutting down (job claims refused). */
  readonly isShuttingDown?: () => boolean;
}

export function createPeerHttpApp(deps: PeerHttpAppDeps): Express {
  const { config } = deps;
  const peer = config.peer;
  if (!peer) throw new Error("createPeerHttpApp requires config.peer (KONTROL_PEER_ENABLED=1).");

  const app = express();
  // DNS-rebinding protection scoped to the peer listener. Loopback remains
  // permitted for local probes; enabled peer ingress profiles contribute
  // exact external FQDNs only (never wildcards/forwarded authority).
  const peerProfileHosts = (config.ingress?.profiles ?? [])
    .filter((profile) => profile.enabled && profile.target === "peer_listener")
    .flatMap((profile) => profile.allowedHosts);
  app.use(strictHostHeaderValidation([
    peer.bindHost,
    "localhost",
    "127.0.0.1",
    ...new Set(peerProfileHosts),
  ]));

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

  // M3 durable peer-pull job protocol (C2, honestly labeled). The job store
  // is opened on the first registerPeerJobRoutes call and kept as a
  // module-level singleton; store lifecycle binds to the process and the
  // durable sidecar (stateDir/peer-jobs.json, atomic temp-write+rename)
  // makes restart safe. peerAuth above already guards /peer/*.
  // The routes handle is retained on app.locals so the server shutdown and
  // candidate-rollback paths can stop the lease reaper and close the store.
  (app.locals as Record<string, unknown>).peerJobRoutesHandle = registerPeerJobRoutes(app, {
    registry: deps.registry,
    config: { stateDir: config.stateDir, peer },
    logging: config.logging,
    isShuttingDown: deps.isShuttingDown,
  });

  // Any /peer endpoint not explicitly mounted above keeps its authenticated
  // 404 shape.
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
