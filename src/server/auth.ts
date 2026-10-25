/**
 * Auth-mode derivation for the HTTP surface: OAuth provider + bearer
 * middleware when authMode=oauth, otherwise undefined. Extracted verbatim
 * from src/server.ts (P1.2); the createServer closures become an explicit
 * dependency object.
 */
import type { Request, Response } from "express";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { ServerConfig } from "../config.js";
import { SingleUserOAuthProvider } from "../oauth-provider.js";

export interface DerivedAuth {
  readonly oauthEnabled: boolean;
  readonly oauthProvider: SingleUserOAuthProvider | null;
  readonly bearerAuth: ((req: Request, res: Response, next: (error?: unknown) => void) => void) | undefined;
  readonly resourceServerUrl: URL | undefined;
  /**
   * The OWNER app's OAuth router instance from deriveAuth (constructed once).
   * F2-A supersedes sharing it with the public listener: a shared router
   * merged owner+public budgets, and with proxyPeerIps unset the public
   * limiter key collapsed onto the owner's loopback bucket — a remote caller
   * could drain the shared budgets and lock the operator's own /authorize.
   * The public app builds its own router with the SDK rate limiters DISABLED
   * (rateLimit: false → no MemoryStore, no setInterval) and relies on its own
   * bounded edge limiter instead.
   */
  readonly oauthRouter: import("express").RequestHandler | undefined;
}

export function deriveAuth(config: ServerConfig): DerivedAuth {
  const oauthEnabled = config.authMode === "oauth";
  let oauthProvider: SingleUserOAuthProvider | null = null;
  let bearerAuth:
    | ((req: Request, res: Response, next: (error?: unknown) => void) => void)
    | undefined;
  let resourceServerUrl: URL | undefined;
  let oauthRouter: import("express").RequestHandler | undefined;
  if (oauthEnabled) {
    const mcpUrl = new URL("/mcp", config.publicBaseUrl);
    resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
    oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
    bearerAuth = requireBearerAuth({
      verifier: oauthProvider,
      requiredScopes: [config.oauth.scopes[0] ?? "kontrol"],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
    });
    oauthRouter = mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "Kontrol",
    });
  }
  return { oauthEnabled, oauthProvider, bearerAuth, resourceServerUrl, oauthRouter };
}
