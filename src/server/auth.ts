/**
 * Auth-mode derivation for the HTTP surface: OAuth provider + bearer
 * middleware when authMode=oauth, otherwise undefined. Extracted verbatim
 * from src/server.ts (P1.2); the createServer closures become an explicit
 * dependency object.
 */
import type { Request, Response } from "express";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { ServerConfig } from "../config.js";
import { SingleUserOAuthProvider } from "../oauth-provider.js";

export interface DerivedAuth {
  readonly oauthEnabled: boolean;
  readonly oauthProvider: SingleUserOAuthProvider | null;
  readonly bearerAuth: ((req: Request, res: Response, next: (error?: unknown) => void) => void) | undefined;
  readonly resourceServerUrl: URL | undefined;
}

export function deriveAuth(config: ServerConfig): DerivedAuth {
  const oauthEnabled = config.authMode === "oauth";
  let oauthProvider: SingleUserOAuthProvider | null = null;
  let bearerAuth:
    | ((req: Request, res: Response, next: (error?: unknown) => void) => void)
    | undefined;
  let resourceServerUrl: URL | undefined;
  if (oauthEnabled) {
    const mcpUrl = new URL("/mcp", config.publicBaseUrl);
    resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
    oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
    bearerAuth = requireBearerAuth({
      verifier: oauthProvider,
      requiredScopes: [config.oauth.scopes[0] ?? "kontrol"],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
    });
  }
  return { oauthEnabled, oauthProvider, bearerAuth, resourceServerUrl };
}
