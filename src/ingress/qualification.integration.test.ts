/**
 * Failure isolation for the ingress path (audit matrix row: "Bridge upstream
 * disconnected -> Bridge degraded; Kontrol core stays healthy").
 *
 * The audit's isolation rule is explicit: "A bridge outage cannot restart a
 * healthy Kontrol runtime." This test boots the real core, records a bridge
 * upstream failure, and proves that:
 *
 *   - the bridge profile is classified DOWN (an observed failure, not merely
 *     missing evidence),
 *   - the core's own readiness is untouched,
 *   - the running generation is not replaced: the runtime identity and the
 *     serving listener survive the failure.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { loadConfig } from "../config.js";
import { createServer } from "../server.js";
import { createRuntimeIdentity, readRuntimeIdentity } from "../runtime-identity.js";
import { appendIngressHealthObservation, classifyIngressHealth, latestIngressHealthByProfile } from "./health-store.js";
import { readIngressManagementProjection } from "./ingress-tools.js";
import type { TailscaleFacts } from "./tailscale-status.js";

const configDir = mkdtempSync(join(tmpdir(), "kontrol-ingress-iso-config-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-ingress-iso-state-"));
const root = mkdtempSync(join(tmpdir(), "kontrol-ingress-iso-root-"));
const PUBLIC_ORIGIN = "https://kontrol.example.test";

const config = loadConfig({
  KONTROL_CONFIG_DIR: configDir,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_OAUTH_OWNER_TOKEN: "ingress-isolation-owner-token-long-enough",
  KONTROL_POLICY_MODE: "allow",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_PUBLIC_BASE_URL: PUBLIC_ORIGIN,
  KONTROL_INGRESS_PROFILES: JSON.stringify([{
    id: "bridge-1",
    kind: "https_bridge",
    audience: "owner_public",
    externalOrigin: PUBLIC_ORIGIN,
    target: "public_oauth_listener",
    enabled: true,
    managedByKontrol: false,
    allowedHosts: ["kontrol.example.test"],
  }]),
} as NodeJS.ProcessEnv);

// The core readiness build check compares the live runtime identity against
// the embedded build identity. A source-mode server publishes the "dev"
// identity, exactly as the serving entrypoint does.
createRuntimeIdentity(stateDir, {});

const facts: TailscaleFacts = {
  cliVersion: "test",
  backendState: "Stopped",
  dnsName: null,
  serveMappings: [],
  funnelMappings: [],
  serveStatusSchemaSupported: true,
  serveFunnelAttributionComplete: true,
  funnelFunnelAttributionComplete: true,
  funnelStatusSchemaSupported: true,
  warnings: [],
};

const running = createServer(config);
// `app.listen()` returns the underlying node:http server that owns the
// socket; wait on that, not on the express app.
const httpServer = running.app.listen(0, "127.0.0.1");
await new Promise<void>((resolveListening) => httpServer.once("listening", resolveListening));
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;

try {
  // --- the core is healthy before the bridge failure ---
  const before = await fetch(`${base}/core-readyz`);
  const beforeBody = await before.json() as { ready?: boolean; checks?: Record<string, { ok: boolean; detail?: string }> };
  assert.equal(before.status, 200, "the core is ready before the bridge failure");
  assert.equal(beforeBody.ready, true);
  const identityBefore = readRuntimeIdentity(stateDir);

  // --- the bridge upstream disconnects ---
  const state = classifyIngressHealth({
    requiredChecks: ["externalHttps", "mcpInitialize", "toolsList"],
    checks: { daemon: true, mapping: true, localListener: true, externalHttps: false },
    localListener: true,
    externalExpected: true,
  });
  assert.equal(state, "DOWN", "an observed upstream failure is DOWN, not merely unverified");
  appendIngressHealthObservation(stateDir, {
    profileId: "bridge-1",
    listener: "public_oauth_listener:7678",
    buildId: "build-isolation",
    probeOrigin: PUBLIC_ORIGIN,
    principalClass: "owner_public",
    state,
    evidenceTier: "public_internet",
    observedAt: new Date().toISOString(),
    checks: { daemon: true, mapping: true, localListener: true, externalHttps: false },
    failureClass: "upstream_unreachable",
  });

  // --- the core stays healthy ---
  const after = await fetch(`${base}/core-readyz`);
  const afterBody = await after.json() as { ready?: boolean; checks?: Record<string, { ok: boolean; detail?: string }> };
  assert.equal(after.status, before.status, "a failed bridge path must not change core readiness");
  assert.equal(afterBody.ready, true);
  assert.equal(afterBody.checks?.database?.ok, true);
  assert.equal(afterBody.checks?.schema?.ok, true);
  assert.deepEqual(
    afterBody.checks,
    beforeBody.checks,
    "core readiness must be bit-identical across a bridge failure",
  );

  // --- the generation was not replaced ---
  assert.deepEqual(readRuntimeIdentity(stateDir), identityBefore, "a bridge failure must not replace the running generation");

  // --- the ingress projection reports the bridge failure honestly ---
  const projection = await readIngressManagementProjection(config, {
    readFacts: async () => facts,
    localProbe: async () => true,
  });
  assert.equal(projection.profiles[0]?.externalTest, "failed");
  assert.equal(projection.profiles[0]?.tls, "failed");
  assert.equal(projection.profiles[0]?.recentFailures[0]?.failureClass, "upstream_unreachable");
  assert.equal(latestIngressHealthByProfile(stateDir)[0]?.state, "DOWN");

  console.log("qualification.integration: bridge failure isolation proven");
} finally {
  await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
  await running.close();
}
