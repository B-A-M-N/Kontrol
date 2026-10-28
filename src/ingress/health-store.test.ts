import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendIngressHealthObservation, classifyIngressHealth, latestIngressHealthByProfile, listIngressHealthObservations } from "./health-store.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-ingress-health-"));
try {
  const stateDir = join(root, "state");
  const base = {
    profileId: "public-main",
    listener: "public_oauth_listener:7678",
    buildId: "build-123",
    probeOrigin: "https://mcp.example.test/",
    principalClass: "owner_public" as const,
    state: "READY" as const,
    evidenceTier: "public_internet" as const,
    observedAt: new Date().toISOString(),
    checks: { daemon: true, mapping: true, localListener: true, externalHttps: true, oauthChallenge: true, mcpInitialize: true, toolsList: true, sse: true, longPost: true },
    metrics: { latencyMs: 12, failures: 0, reconnects: 0, maxHeartbeatGapMs: 15_000 },
    sessionIdentityHash: "a".repeat(64),
  };
  const saved = appendIngressHealthObservation(stateDir, base);
  assert.match(saved.observationId, /^[0-9a-f-]{36}$/);
  if (process.platform !== "win32") assert.equal(statSync(join(stateDir, "ingress-health.json")).mode & 0o777, 0o600);
  assert.equal(listIngressHealthObservations(stateDir, "public-main").length, 1);
  assert.equal(latestIngressHealthByProfile(stateDir)[0]?.profileId, "public-main");
  const persisted = readFileSync(join(stateDir, "ingress-health.json"), "utf8");
  assert.equal(persisted.includes("secret-token"), false);
  assert.equal(classifyIngressHealth({ requiredChecks: ["mcpInitialize", "toolsList"], checks: base.checks, localListener: true, externalExpected: true }), "READY");
  assert.equal(classifyIngressHealth({ requiredChecks: ["mcpInitialize"], checks: { daemon: true, mapping: false }, localListener: true, externalExpected: true }), "DOWN");
  assert.equal(classifyIngressHealth({ requiredChecks: ["mcpInitialize"], checks: { mcpInitialize: true }, localListener: true, externalExpected: true }), "UNVERIFIED");
  assert.equal(classifyIngressHealth({ requiredChecks: ["mcpInitialize"], checks: { mcpInitialize: true, externalHttps: true, sse: false }, localListener: true, externalExpected: true }), "DEGRADED");
  assert.throws(() => appendIngressHealthObservation(stateDir, { ...base, probeOrigin: "https://mcp.example.test/path" }), /origin/);
  assert.throws(() => appendIngressHealthObservation(stateDir, { ...base, token: "secret-token" } as never), /invalid ingress health observation/);
  writeFileSync(join(stateDir, "ingress-health.json"), "{");
  assert.throws(() => appendIngressHealthObservation(stateDir, base), /corrupt/);
  assert.equal(readFileSync(join(stateDir, "ingress-health.json"), "utf8"), "{");
  console.log("ingress health store tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
