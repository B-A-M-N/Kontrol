import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databasePath, openDatabase } from "./db/client.js";
import { LATEST_SCHEMA_VERSION } from "./db/migrations.js";
import { inspectDeploymentReconciliation } from "./deployment-reconciliation.js";
import { processStartToken } from "./runtime-identity.js";

const stateDir = mkdtempSync(join(tmpdir(), "kontrol-generation-reconciliation-"));
try {
  const db = openDatabase(stateDir);
  db.close();
  const databaseFile = databasePath(stateDir);
  const dbHash = () => createHash("sha256").update(readFileSync(databaseFile)).digest("hex");
  const before = dbHash();
  const artifactPath = join(stateDir, "releases", "build-schema-109");
  mkdirSync(artifactPath, { recursive: true });
  writeFileSync(join(artifactPath, "build-meta.json"), JSON.stringify({
    buildId: "build-schema-109",
    schemaVersion: 109,
    minReadableSchemaVersion: 0,
    maxReadableSchemaVersion: 109,
  }));
  const generation = {
    status: "active",
    requestedBuildId: "build-schema-109",
    activeBuildId: "build-schema-109",
    generationId: "generation-109",
    artifactPath,
  };
  writeFileSync(join(stateDir, "generation.json"), JSON.stringify(generation));
  writeFileSync(join(stateDir, "server.identity.json"), JSON.stringify({
    pid: process.pid,
    processStartTime: processStartToken(process.pid),
    instanceId: "test-server",
    buildId: "build-schema-109",
    buildSha: "test-sha",
    buildDirty: 0,
    startedAt: new Date().toISOString(),
    command: "test",
    generationId: "generation-109",
    artifactPath,
  }));

  const report = inspectDeploymentReconciliation(stateDir);
  assert.equal(report.recordedGeneration.status, "PASS");
  assert.equal(report.observedRuntime.status, "PASS");
  assert.equal(report.activeArtifact.status, "PASS");
  assert.equal(report.databaseCompatibility.status, "FAIL");
  assert.match(report.databaseCompatibility.detail, new RegExp(`database=${LATEST_SCHEMA_VERSION} artifact=build-schema-109`));
  assert.equal(dbHash(), before, "generation reconciliation does not change database bytes");

  writeFileSync(join(stateDir, "generation.json"), JSON.stringify({ ...generation, activeBuildId: "different-build" }));
  assert.equal(inspectDeploymentReconciliation(stateDir).activeArtifact.status, "FAIL",
    "stale generation pointers are reported without being rewritten");
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log("deployment-reconciliation.test.ts: all assertions passed");
