import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databasePath, openDatabase } from "./db/client.js";
import { LATEST_SCHEMA_VERSION } from "./db/migrations.js";
import { inspectDeploymentReconciliation, inspectUnifiedDeploymentReconciliation } from "./deployment-reconciliation.js";
import { processStartToken } from "./runtime-identity.js";

const stateDir = mkdtempSync(join(tmpdir(), "kontrol-generation-reconciliation-"));
try {
  const serviceStateDir = join(stateDir, "service-state");
  mkdirSync(serviceStateDir, { recursive: true });
  const serviceDb = openDatabase(serviceStateDir);
  serviceDb.close();
  const serviceArtifact = join(stateDir, "releases", "build-current");
  mkdirSync(serviceArtifact, { recursive: true });
  writeFileSync(join(serviceArtifact, "build-meta.json"), JSON.stringify({
    buildId: "build-current",
    schemaVersion: LATEST_SCHEMA_VERSION,
    minReadableSchemaVersion: 1,
    maxReadableSchemaVersion: LATEST_SCHEMA_VERSION,
  }));
  writeFileSync(join(serviceStateDir, "service.json"), JSON.stringify({
    buildId: "build-current",
    artifactPath: serviceArtifact,
    deploymentId: "deployment-current",
    schemaVersion: LATEST_SCHEMA_VERSION,
    minReadableSchemaVersion: 1,
    maxReadableSchemaVersion: LATEST_SCHEMA_VERSION,
    serviceComponents: [
      { name: "required-adapter", kind: "adapter", command: ["adapter-run"], required: true },
      { name: "optional-tunnel", kind: "tunnel", command: ["tunnel-client", "run"], required: false },
    ],
  }));
  writeFileSync(join(serviceStateDir, "deployment.deployment-current.json"), JSON.stringify({
    deploymentId: "deployment-current",
    operation: "install",
    stage: "commit",
    candidate: {
      buildId: "build-current",
      artifactPath: serviceArtifact,
    },
  }));
  writeFileSync(join(serviceStateDir, "generation.json"), JSON.stringify({
    status: "active", activeBuildId: "build-current", generationId: "generation-current", artifactPath: serviceArtifact,
  }));
  writeFileSync(join(serviceStateDir, "server.identity.json"), JSON.stringify({
    pid: process.pid,
    processStartTime: processStartToken(process.pid),
    instanceId: "service-reconciliation-test",
    buildId: "build-current",
    buildSha: "test",
    buildDirty: 0,
    startedAt: new Date().toISOString(),
    command: "test",
    generationId: "generation-current",
    artifactPath: serviceArtifact,
  }));
  const servicePaths = {
    stateDir: serviceStateDir,
    statePath: join(serviceStateDir, "service.json"),
    unitPath: join(stateDir, "kontrol-core.service"),
    serviceName: "kontrol-core.service",
  };
  const observeSystemd = (unitName = servicePaths.serviceName) => {
    if (unitName === "kontrol.target") return {
      loadState: "loaded", activeState: "active", mainPid: 0, fragmentPath: join(stateDir, "kontrol.target"),
    };
    if (unitName === "kontrol-required-adapter.service" || unitName === "kontrol-optional-tunnel.service") return {
      loadState: "loaded", activeState: "active", mainPid: 0, fragmentPath: join(stateDir, unitName),
    };
    return ({
    loadState: "loaded", activeState: "active", mainPid: process.pid, fragmentPath: servicePaths.unitPath,
  });
  };
  const serviceDatabaseBefore = createHash("sha256").update(readFileSync(databasePath(serviceStateDir))).digest("hex");
  const unified = inspectUnifiedDeploymentReconciliation(servicePaths, { observeSystemd });
  assert.equal(unified.status, "PASS");
  assert.deepEqual(Object.values(unified.evidence).map((item) => item.status), ["PASS", "PASS", "PASS", "PASS", "PASS"]);
  assert.equal(createHash("sha256").update(readFileSync(databasePath(serviceStateDir))).digest("hex"), serviceDatabaseBefore,
    "unified reconciliation inspects SQLite without mutation");
  const inactiveTarget = inspectUnifiedDeploymentReconciliation(servicePaths, {
    observeSystemd: (unitName) => unitName === "kontrol.target"
      ? { ...observeSystemd(unitName), activeState: "inactive" }
      : observeSystemd(unitName),
  });
  assert.equal(inactiveTarget.status, "FAILED", "an inactive grouping target cannot pass reconciliation");
  assert.match(inactiveTarget.evidence.systemd.detail, /kontrol\.target activeState=inactive/);
  const missingRequired = inspectUnifiedDeploymentReconciliation(servicePaths, {
    observeSystemd: (unitName) => unitName === "kontrol-required-adapter.service"
      ? { loadState: "not-found", activeState: "inactive" }
      : observeSystemd(unitName),
  });
  assert.equal(missingRequired.status, "FAILED", "a missing required component fails reconciliation");
  assert.match(missingRequired.evidence.systemd.detail, /required component kontrol-required-adapter\.service loadState=not-found/);
  const inactiveOptional = inspectUnifiedDeploymentReconciliation(servicePaths, {
    observeSystemd: (unitName) => unitName === "kontrol-optional-tunnel.service"
      ? { ...observeSystemd(unitName), activeState: "failed" }
      : observeSystemd(unitName),
  });
  assert.equal(inactiveOptional.status, "DRIFT", "an inactive optional component is surfaced as degradation");
  assert.equal(inactiveOptional.evidence.systemd.status, "WARN");
  assert.match(inactiveOptional.evidence.systemd.detail, /optional component kontrol-optional-tunnel\.service activeState=failed/);
  assert.equal(inspectUnifiedDeploymentReconciliation(servicePaths, {
    observeSystemd: (unitName) => unitName === servicePaths.serviceName
      ? { ...observeSystemd(unitName), mainPid: process.pid + 1 }
      : observeSystemd(unitName),
  }).status, "DRIFT", "systemd/server PID disagreement is surfaced as deployment drift");

  writeFileSync(join(serviceStateDir, "generation.json"), JSON.stringify({
    status: "active", activeBuildId: "stale-build", generationId: "stale-generation", artifactPath: serviceArtifact,
  }));
  assert.equal(inspectUnifiedDeploymentReconciliation(servicePaths, { observeSystemd }).status, "DRIFT",
    "a generation mismatch remains DRIFT even when every other evidence source passes");

  const rollbackArtifact = join(stateDir, "releases", "build-previous");
  mkdirSync(rollbackArtifact, { recursive: true });
  writeFileSync(join(rollbackArtifact, "build-meta.json"), JSON.stringify({
    buildId: "build-previous",
    schemaVersion: LATEST_SCHEMA_VERSION,
    minReadableSchemaVersion: 1,
    maxReadableSchemaVersion: LATEST_SCHEMA_VERSION,
  }));
  writeFileSync(join(serviceStateDir, "service.json"), JSON.stringify({
    buildId: "build-previous",
    artifactPath: rollbackArtifact,
    deploymentId: "deployment-rollback",
    schemaVersion: LATEST_SCHEMA_VERSION,
    minReadableSchemaVersion: 1,
    maxReadableSchemaVersion: LATEST_SCHEMA_VERSION,
  }));
  writeFileSync(join(serviceStateDir, "deployment.deployment-rollback.json"), JSON.stringify({
    deploymentId: "deployment-rollback",
    operation: "upgrade",
    stage: "commit",
    error: "candidate failed readiness",
    databaseRestore: { restored: false, required: false },
    previous: { buildId: "build-previous", artifactPath: rollbackArtifact },
    candidate: { buildId: "build-failed", artifactPath: serviceArtifact },
  }));
  writeFileSync(join(serviceStateDir, "generation.json"), JSON.stringify({
    status: "active", activeBuildId: "build-previous", generationId: "generation-previous", artifactPath: rollbackArtifact,
  }));
  writeFileSync(join(serviceStateDir, "server.identity.json"), JSON.stringify({
    pid: process.pid,
    processStartTime: processStartToken(process.pid),
    instanceId: "service-reconciliation-rollback-test",
    buildId: "build-previous",
    buildSha: "test",
    buildDirty: 0,
    startedAt: new Date().toISOString(),
    command: "test",
    generationId: "generation-previous",
    artifactPath: rollbackArtifact,
  }));
  assert.equal(inspectUnifiedDeploymentReconciliation(servicePaths, { observeSystemd }).status, "PASS",
    "a committed rollback reconciles against its previous state even when no database restore was required");
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log("deployment-reconciliation-unified.test.ts: all assertions passed");
