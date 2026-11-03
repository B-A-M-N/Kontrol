/**
 * Finding 2: diagnostics build-meta lookup defect.
 *
 * Packaged layout keeps build-meta.json at releases/<id>/build-meta.json,
 * ABOVE server/diagnostics.js. The old handler resolved it adjacent to the
 * diagnostics module and silently swallowed the miss, so live /diagnostics
 * returned a build string fallback with no buildMeta.
 *
 * These tests stage a packaged-shaped tree (release root + server/ subdir),
 * mount the REAL /diagnostics route over loopback HTTP, and assert the
 * buildMeta identity fields plus schema/runtime fields flow through.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { loadConfig } from "../config.js";
import { handleDiagnostics } from "./diagnostics.js";
import type { DiagnosticsDeps } from "./diagnostics.js";
import { resolveReleaseBuildMeta } from "../build-identity.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-diagnostics-test-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-diagnostics-state-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-diagnostics-config-"));
const agentDir = join(root, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });

// Packaged-shaped fixture: release root holds build-meta.json, the route
// module lives one level down in server/ — exactly like
// releases/<id>/build-meta.json above releases/<id>/server/diagnostics.js.
const releaseRoot = join(root, "pkg");
const moduleDir = join(releaseRoot, "server");
mkdirSync(moduleDir, { recursive: true });
const META = {
  buildId: "pkg-build-1",
  version: "1.0.4",
  gitSha: "0123456789abcdef0123456789abcdef01234567",
  gitDirty: 0,
  schemaVersion: 42,
  buildTimestamp: "2026-11-02T00:00:00.000Z",
};
writeFileSync(join(releaseRoot, "build-meta.json"), JSON.stringify(META));
writeFileSync(join(stateDir, "generation.json"), JSON.stringify({
  status: "active",
  requestedBuildId: "pkg-build-1",
  activeBuildId: "pkg-build-1",
}));

const config = loadConfig({
  KONTROL_CONFIG_DIR: configDir,
  // Pin the state dir too: the live deployment generation.json (with its
  // own activeBuildId) would otherwise leak in as the validation baseline.
  KONTROL_STATE_DIR: stateDir,
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_WORKTREE_ROOT: join(root, ".kontrol", "worktrees"),
  KONTROL_AGENT_DIR: agentDir,
  KONTROL_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  KONTROL_DIAGNOSTICS_SECRET: "test-diagnostics-secret-that-is-long",
  PORT: "1",
});

const noAdmission = { getStats: () => ({ active: 0, activeWeight: 0 }) };
function makeDeps(overrides: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  return {
    config,
    mcpSessions: new Map(),
    mcpAdmission: noAdmission,
    mcpWaiterAdmission: noAdmission,
    mcpResourceAdmission: noAdmission,
    expiredMcpOperations: { snapshot: () => ({}) },
    operationDiagnostics: { snapshot: () => ({}) },
    qualificationEvidence: {
      listRecent: () => [],
      listQualificationAssociations: () => [],
      listExternalCatalogObservations: () => [],
    },
    sessionLifecycle: {
      metrics: { created: 0, evicted: 0 },
      mcpSseDiagnostics: () => ({ active: 0, byClient: {} }),
      mapNumberCounts: () => ({}),
      lastCapacityRejection: () => undefined,
      mcpTimingDiagnostics: () => ({}),
      getMemoryPressureState: () => ({}),
      estimateMcpSessionMemoryCost: () => ({}),
      mcpSessionReuseMetrics: () => ({}),
      mcpSessionTerminationMetrics: () => ({}),
    },
    policyWaiters: { diagnostics: () => ({}) },
    workspaceAppResourceMetrics: {},
    mcpConnectionMetrics: {
      unknownSessionRequests: 0, freshInitializations: 0, reconnectAttempts: 0,
      reconnects: 0, watcherRequests: 0, watcherCompletions: 0, watcherAborts: 0,
      responseChannelClosures: 0, explicitDeletes: 0, admissionExhaustions: 0,
      stalledSseWriters: 0, transportClosures: 0, events: {}, byGeneration: {},
      byTransport: {}, timeline: [],
    },
    logicalContinuity: { size: () => 0, snapshot: () => [] },
    startupRecovery: {},
    databaseIntegrity: { available: false },
    maintenanceStats: {},
    snapshotStoreDiagnostics: async () => ({ available: false }),
    degradedAuditSnapshot: () => ({}),
    processSessionMetrics: () => ({}),
    countActiveWorkSessions: () => 0,
    countPendingReviews: () => 0,
    countAliveAgents: () => 0,
    listPendingApprovals: () => [],
    sqlite: () => undefined,
    ...overrides,
  } as unknown as DiagnosticsDeps;
}

async function getDiagnostics(deps: DiagnosticsDeps): Promise<{ status: number; body: any }> {
  const app = express();
  app.get("/diagnostics", (req, res) => {
    void handleDiagnostics(deps, req, res);
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object", "server binds an ephemeral loopback port");
    const response = await fetch(`http://127.0.0.1:${address.port}/diagnostics`, {
      headers: { "x-kontrol-diagnostics": "test-diagnostics-secret-that-is-long" },
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

try {
  // Resolution unit: packaged nested layout resolves from the release root.
  const resolved = resolveReleaseBuildMeta({ moduleDir });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.meta?.buildId, "pkg-build-1");

  // Resolution unit: nothing to find yields an explicit missing state.
  const emptyDir = mkdtempSync(join(tmpdir(), "kontrol-diagnostics-empty-"));
  assert.equal(resolveReleaseBuildMeta({ moduleDir: emptyDir }).status, "missing");

  // Resolution unit: corrupt metadata is invalid, never silently absorbed.
  const corruptRoot = mkdtempSync(join(tmpdir(), "kontrol-diagnostics-corrupt-"));
  writeFileSync(join(corruptRoot, "build-meta.json"), "{not json");
  assert.equal(resolveReleaseBuildMeta({ moduleDir: corruptRoot }).status, "invalid");

  // Resolution unit: generation expectation mismatch is reported with ids.
  const mismatched = resolveReleaseBuildMeta({ moduleDir, expectedBuildId: "other-build" });
  assert.equal(mismatched.status, "mismatched");
  assert.equal(mismatched.actualBuildId, "pkg-build-1");
  assert.equal(mismatched.expectedBuildId, "other-build");

  // Route: packaged artifact serves buildMeta identity through /diagnostics.
  const { status, body } = await getDiagnostics(makeDeps({ buildMetaModuleDir: moduleDir }));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.buildMeta?.buildId, "pkg-build-1");
  assert.equal(body.buildMeta?.gitSha, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(body.buildMeta?.gitDirty, 0);
  assert.equal(typeof body.schema, "number", "schema field present");
  assert.equal(typeof body.schemaExpected, "number", "schemaExpected field present");
  assert.equal(body.buildMetaStatus?.status, "resolved");

  // Route: mismatched generation expectation surfaces instead of vanishing.
  const mismatchDeps = makeDeps({ buildMetaModuleDir: moduleDir });
  writeFileSync(join(stateDir, "generation.json"), JSON.stringify({
    status: "active",
    requestedBuildId: "other-build",
    activeBuildId: "other-build",
  }));
  const mismatchRoute = await getDiagnostics(mismatchDeps);
  assert.equal(mismatchRoute.status, 200);
  assert.equal(mismatchRoute.body.buildMeta?.buildId, "pkg-build-1");
  assert.equal(mismatchRoute.body.buildMetaStatus?.status, "mismatched");
  assert.equal(mismatchRoute.body.buildMetaStatus?.expectedBuildId, "other-build");
  assert.equal(mismatchRoute.body.buildMetaStatus?.actualBuildId, "pkg-build-1");

  // Route: missing metadata is an explicit state, not a silent fallback.
  writeFileSync(join(stateDir, "generation.json"), JSON.stringify({
    status: "active",
    requestedBuildId: "pkg-build-1",
    activeBuildId: "pkg-build-1",
  }));
  const missingRoute = await getDiagnostics(makeDeps({ buildMetaModuleDir: emptyDir }));
  assert.equal(missingRoute.status, 200);
  assert.equal(missingRoute.body.buildMeta, undefined);
  assert.equal(missingRoute.body.buildMetaStatus?.status, "missing");
  assert.equal(missingRoute.body.buildMetaStatus?.expectedBuildId, "pkg-build-1");

  console.log("server/diagnostics.test.ts: all assertions passed");
} finally {
  const { rmSync } = await import("node:fs");
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
}
