import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-oauth-test-"));

try {
  const stateDir = join(root, "state");
  const oauthConfig = {
    ownerToken: "test-owner-token-that-is-long-enough",
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 2592000,
    scopes: ["devspace"],
    allowedRedirectHosts: ["chatgpt.com"],
  };
  const mcpUrl = new URL("https://agent.example.com/mcp");

  const firstStore = new SqliteOAuthStore(stateDir);
  const firstClients = new SqliteOAuthClientsStore(firstStore, oauthConfig.allowedRedirectHosts);
  const registeredClient = firstClients.registerClient({
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    client_name: "ChatGPT",
  });
  const accessToken = "access-token-example";
  const refreshToken = "refresh-token-example";
  firstStore.saveAccessToken(hashToken(accessToken), {
    clientId: registeredClient.client_id,
    scopes: ["devspace"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    resource: mcpUrl.href,
  });
  firstStore.saveRefreshToken(hashToken(refreshToken), {
    clientId: registeredClient.client_id,
    scopes: ["devspace"],
    expiresAt: Math.floor(Date.now() / 1000) + 2592000,
    resource: mcpUrl.href,
  });
  firstStore.close();

  const secondStore = new SqliteOAuthStore(stateDir);
  const secondClients = new SqliteOAuthClientsStore(secondStore, oauthConfig.allowedRedirectHosts);
  const restoredClient = secondClients.getClient(registeredClient.client_id);
  assert.ok(restoredClient);
  assert.equal(restoredClient.client_id, registeredClient.client_id);
  assert.deepEqual(
    restoredClient.redirect_uris.map((uri) => String(uri)),
    ["https://chatgpt.com/connector_platform_oauth_redirect"],
  );

  const restoredAccess = secondStore.getAccessToken(hashToken(accessToken));
  assert.ok(restoredAccess);
  assert.equal(restoredAccess.clientId, registeredClient.client_id);
  assert.deepEqual(restoredAccess.scopes, ["devspace"]);
  assert.equal(restoredAccess.resource, mcpUrl.href);

  const restoredRefresh = secondStore.getRefreshToken(hashToken(refreshToken));
  assert.ok(restoredRefresh);
  assert.equal(restoredRefresh.clientId, registeredClient.client_id);
  secondStore.close();

  const firstProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const providerClient = await firstProvider.clientsStore.registerClient?.({
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    client_name: "ChatGPT",
  });
  assert.ok(providerClient);

  const code = "code-test-123";
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const resource = mcpUrl;
  firstProvider["codes"].set(code, {
    clientId: providerClient.client_id,
    params: {
      redirectUri,
      codeChallenge: "challenge",
      scopes: ["devspace"],
      resource,
    },
    expiresAtMs: Date.now() + 60_000,
  });

  const issued = await firstProvider.exchangeAuthorizationCode(
    providerClient,
    code,
    undefined,
    redirectUri,
    resource,
  );
  assert.ok(issued.access_token);
  assert.ok(issued.refresh_token);

  const secondProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const verified = await secondProvider.verifyAccessToken(issued.access_token);
  assert.equal(verified.clientId, providerClient.client_id);
  assert.deepEqual(verified.scopes, ["devspace"]);

  const refreshed = await secondProvider.exchangeRefreshToken(
    providerClient,
    issued.refresh_token!,
    ["devspace"],
    resource,
  );
  assert.ok(refreshed.access_token);
  assert.notEqual(refreshed.access_token, issued.access_token);
} finally {
  await rm(root, { recursive: true, force: true });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}