/**
 * Startup-level ingress authorization matrix (audit P0-02 acceptance).
 *
 * The audit requires that "every invalid matrix combination fails in
 * loadConfig(), buildIngressPlan(), and integration tests" and that
 * "disabled standby profiles must remain possible without taking ownership of
 * an active route". This file proves the loadConfig() half against the real
 * configuration loader, not only against the pure validator.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { buildIngressPlan } from "./profile-status.js";
import type { IngressProfile } from "./types.js";

const configDir = mkdtempSync(join(tmpdir(), "kontrol-ingress-config-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-ingress-state-"));
const root = mkdtempSync(join(tmpdir(), "kontrol-ingress-root-"));
const CANONICAL_ORIGIN = "https://kontrol-node.tail-scale.ts.net";
const CANONICAL_HOST = "kontrol-node.tail-scale.ts.net";

const peerRegistry = join(configDir, "peers.json");
writeFileSync(peerRegistry, JSON.stringify({
  version: 1,
  peers: [{
    id: "muse",
    credentialId: "muse-peer",
    credentialHash: "b".repeat(64),
    capabilities: ["workspace:inspect"],
    grantedRoots: [root],
  }],
}));
try { chmodSync(peerRegistry, 0o600); } catch { /* windows test hosts */ }

const baseEnv = {
  KONTROL_CONFIG_DIR: configDir,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_OAUTH_OWNER_TOKEN: "ingress-matrix-owner-token-long-enough",
  KONTROL_POLICY_MODE: "allow",
  KONTROL_PUBLIC_BASE_URL: CANONICAL_ORIGIN,
};

const peerEnv = {
  ...baseEnv,
  KONTROL_PEER_ENABLED: "1",
  KONTROL_PEER_PORT: "7677",
  KONTROL_PEER_CREDENTIAL_FILE: peerRegistry,
};

const tunnelEnv = { ...baseEnv, KONTROL_AUTH_MODE: "tunnel" };

function profile(overrides: Partial<IngressProfile> = {}): IngressProfile {
  return {
    id: "profile-1",
    kind: "tailscale_serve",
    audience: "peer",
    externalOrigin: "https://node.tail-scale.ts.net:8443",
    target: "peer_listener",
    enabled: true,
    managedByKontrol: false,
    allowedHosts: ["node.tail-scale.ts.net:8443"],
    ...overrides,
  };
}

function withProfile(env: Record<string, string>, value: IngressProfile): Record<string, string> {
  return { ...env, KONTROL_INGRESS_PROFILES: JSON.stringify([value]) };
}

function rejectsStartup(env: Record<string, string>, value: IngressProfile, pattern: RegExp, message: string): void {
  assert.throws(
    () => loadConfig(withProfile(env, value) as NodeJS.ProcessEnv),
    (error: Error) => {
      assert.match(error.message, /^ingress_profiles_invalid: /, message);
      assert.match(error.message, pattern, message);
      return true;
    },
    message,
  );
}

// --- the baseline deployment must load ---
assert.doesNotThrow(() => loadConfig(baseEnv as NodeJS.ProcessEnv), "the baseline deployment loads");

// --- every invalid matrix combination fails at startup ---
rejectsStartup(peerEnv, profile({ audience: "owner_public" }), /peer_listener requires peer audience/,
  "a peer listener must carry the peer audience");
rejectsStartup(peerEnv, profile({ audience: "peer", target: "public_oauth_listener", externalOrigin: CANONICAL_ORIGIN, allowedHosts: [CANONICAL_HOST] }), /public_oauth_listener requires owner_public audience/,
  "the public OAuth listener must carry the owner_public audience");
rejectsStartup(baseEnv, profile(), /peer listener is not enabled with credentials/,
  "an enabled peer profile requires the peer listener");
rejectsStartup(peerEnv, profile({ kind: "tailscale_funnel" }), /only tailscale_serve may expose the peer listener/,
  "funnel may never target the peer listener");
rejectsStartup(peerEnv, profile({ kind: "https_bridge", externalOrigin: "https://bridge.example.com", allowedHosts: ["bridge.example.com"] }), /only tailscale_serve may expose the peer listener/,
  "a bridge may never target the peer listener");
rejectsStartup(peerEnv, profile({ kind: "https_bridge", audience: "owner_public", target: "secure_tunnel_listener", externalOrigin: "https://bridge.example.com", allowedHosts: ["bridge.example.com"] }), /only secure_mcp_tunnel profiles may use that target/,
  "a bridge may never target the secure tunnel listener");
rejectsStartup(peerEnv, profile({ kind: "secure_mcp_tunnel", audience: "owner_public", target: "public_oauth_listener", externalOrigin: CANONICAL_ORIGIN, allowedHosts: [CANONICAL_HOST] }), /cannot target public_oauth_listener/,
  "a secure tunnel profile may never target the public OAuth listener");
rejectsStartup(peerEnv, profile({ kind: "secure_mcp_tunnel", audience: "owner_public", target: "secure_tunnel_listener", externalOrigin: CANONICAL_ORIGIN, allowedHosts: [CANONICAL_HOST] }), /Secure MCP Tunnel requires a compatible tunnel deployment/,
  "a secure tunnel profile requires a tunnel-mode deployment");
rejectsStartup(tunnelEnv, profile({ audience: "owner_public", target: "public_oauth_listener", externalOrigin: CANONICAL_ORIGIN, allowedHosts: [CANONICAL_HOST] }), /public ingress requires OAuth mode/,
  "public ingress is refused in tunnel mode");
rejectsStartup(peerEnv, profile({ audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://other-node.tail-scale.ts.net", allowedHosts: ["other-node.tail-scale.ts.net"] }), /does not equal the canonical publicBaseUrl/,
  "an enabled owner_public profile must use the canonical public origin");

// --- every valid matrix combination loads ---
assert.doesNotThrow(() => loadConfig(withProfile(peerEnv, profile()) as NodeJS.ProcessEnv),
  "tailscale serve -> peer listener with peer credentials is valid");
assert.doesNotThrow(() => loadConfig(withProfile(peerEnv, profile({ audience: "owner_public", target: "public_oauth_listener", externalOrigin: CANONICAL_ORIGIN, allowedHosts: [CANONICAL_HOST] })) as NodeJS.ProcessEnv),
  "tailscale serve -> public OAuth listener in OAuth mode is valid");
assert.doesNotThrow(() => loadConfig(withProfile(peerEnv, profile({ kind: "tailscale_funnel", audience: "owner_public", target: "public_oauth_listener", externalOrigin: CANONICAL_ORIGIN, allowedHosts: [CANONICAL_HOST] })) as NodeJS.ProcessEnv),
  "tailscale funnel -> public OAuth listener is valid");
assert.doesNotThrow(() => loadConfig(withProfile(peerEnv, profile({ kind: "https_bridge", audience: "owner_public", target: "public_oauth_listener", externalOrigin: CANONICAL_ORIGIN, allowedHosts: [CANONICAL_HOST] })) as NodeJS.ProcessEnv),
  "https bridge -> public OAuth listener is valid");
assert.doesNotThrow(() => loadConfig(withProfile(tunnelEnv, profile({ kind: "secure_mcp_tunnel", audience: "owner_public", target: "secure_tunnel_listener", externalOrigin: CANONICAL_ORIGIN, allowedHosts: [CANONICAL_HOST] })) as NodeJS.ProcessEnv),
  "secure MCP tunnel -> secure tunnel listener in tunnel mode is valid");

// --- a disabled standby profile stays possible without owning a listener ---
assert.doesNotThrow(() => loadConfig(withProfile(baseEnv, profile({ id: "standby", enabled: false })) as NodeJS.ProcessEnv),
  "a disabled standby peer profile does not require the peer listener");
assert.doesNotThrow(() => loadConfig(withProfile(baseEnv, profile({
  id: "standby-public",
  audience: "owner_public",
  target: "public_oauth_listener",
  externalOrigin: "https://standby-node.tail-scale.ts.net",
  allowedHosts: ["standby-node.tail-scale.ts.net"],
  enabled: false,
})) as NodeJS.ProcessEnv),
  "a disabled standby owner_public profile does not take ownership of the canonical origin");
{
  const standby = buildIngressPlan({
    authMode: "oauth",
    publicBaseUrl: CANONICAL_ORIGIN,
    peer: { port: 7677 },
    publicMcp: { port: 7678 },
    ingress: { profiles: [profile({ id: "standby", enabled: false })] },
  });
  assert.equal(standby[0]?.command, undefined, "a standby profile never emits a route command");
  assert.match(standby[0]?.note ?? "", /disabled \(standby\)/);
}

console.log("validate-config: all assertions passed");
