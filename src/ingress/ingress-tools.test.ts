import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendIngressHealthObservation } from "./health-store.js";
import { readIngressManagementProjection } from "./ingress-tools.js";
import type { ServerConfig } from "../config.js";
import type { TailscaleFacts } from "./tailscale-status.js";

const stateDir = mkdtempSync(join(tmpdir(), "kontrol-ingress-panel-"));
try {
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
  const config = {
    authMode: "oauth",
    publicBaseUrl: "https://kontrol.example.test",
    publicMcp: { port: 7678 },
    stateDir,
    ingress: { profiles: [{
      id: "public",
      kind: "https_bridge",
      audience: "owner_public",
      externalOrigin: "https://kontrol.example.test",
      target: "public_oauth_listener",
      enabled: true,
      managedByKontrol: false,
      allowedHosts: ["kontrol.example.test"],
    }] },
  } as unknown as ServerConfig;
  const projectionDeps = {
    readFacts: async () => facts,
    localProbe: async () => true,
    now: () => new Date("2026-10-25T12:00:00.000Z"),
  };

  const configured = await readIngressManagementProjection(config, projectionDeps);
  assert.equal(configured.profiles[0]?.classification, "EXTERNAL_UNVERIFIED");
  assert.equal(configured.profiles[0]?.localObserved, true);
  assert.equal(configured.profiles[0]?.externalTest, "unverified");
  assert.equal(configured.profiles[0]?.tls, "unverified");
  assert.equal(configured.profiles[0]?.authentication, "unverified");

  appendIngressHealthObservation(stateDir, {
    profileId: "public",
    listener: "public_oauth_listener",
    buildId: "build-test",
    probeOrigin: "https://kontrol.example.test/",
    principalClass: "owner_public",
    state: "READY",
    evidenceTier: "public_internet",
    observedAt: "2026-10-25T11:55:00.000Z",
    checks: { externalHttps: true, oauthChallenge: true, mcpInitialize: true },
  });
  const qualified = await readIngressManagementProjection(config, projectionDeps);
  assert.equal(qualified.profiles[0]?.externalTest, "passed");
  assert.equal(qualified.profiles[0]?.tls, "verified externally");
  assert.equal(qualified.profiles[0]?.authentication, "verified externally");
  assert.equal(qualified.profiles[0]?.qualification?.evidenceTier, "public_internet");
  console.log("ingress-tools.test.ts: panel projection preserves qualification evidence tiers");
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
