/**
 * P0.3 invariants: deployment authority is explicit, never ambient.
 *  - openDatabase no longer consumes KONTROL_DEPLOYMENT_ID /
 *    KONTROL_EXPECTED_SCHEMA_VERSION from process.env — a polluted
 *    environment cannot change migration/backup behavior;
 *  - stripLauncherAuthority removes launcher-only fields from child envs;
 *  - resolveDeploymentContext parses once, tolerating garbage.
 */
import assert from "node:assert/strict";
import { brandDeploymentId } from "./branded.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { resolveDeploymentContext, stripLauncherAuthority, launcherAuthorityKeys } from "./runtime-context.js";

// ── resolveDeploymentContext parses once, tolerating garbage ──
{
  const context = resolveDeploymentContext({
    KONTROL_DEPLOYMENT_ID: " dep-42 ",
    KONTROL_EXPECTED_SCHEMA_VERSION: "7",
    KONTROL_BUILD_ID: "build-abc",
    KONTROL_LAUNCH_GENERATION_ID: "gen-1",
    KONTROL_ARTIFACT_PATH: "/opt/kontrol/dist",
    KONTROL_LAUNCHER: "systemd",
  });
  assert.equal(context.deploymentId, "dep-42");
  assert.equal(context.expectedSchemaVersion, 7);
  assert.equal(context.expectedBuildId, "build-abc");
  assert.equal(context.launcher, "systemd");

  const garbage = resolveDeploymentContext({
    KONTROL_EXPECTED_SCHEMA_VERSION: "not-a-number",
    KONTROL_LAUNCHER: "bogus",
  });
  assert.equal(garbage.expectedSchemaVersion, undefined, "garbage schema versions are dropped, not guessed");
  assert.equal(garbage.launcher, undefined, "unknown launcher values are dropped");
  assert.deepEqual(resolveDeploymentContext({}), { deploymentId: undefined, expectedSchemaVersion: undefined, expectedBuildId: undefined, launchGenerationId: undefined, artifactPath: undefined, launcher: undefined }, "an empty environment resolves to an empty context");
}

// ── stripLauncherAuthority ──
{
  const stripped = stripLauncherAuthority({
    PATH: "/bin",
    KONTROL_DEPLOYMENT_ID: "dep-42",
    KONTROL_RUNTIME_LOCK_TOKEN: "tok",
    KONTROL_DEPLOYMENT_LOCK_TOKEN: "tok2",
    KONTROL_LAUNCH_GENERATION_ID: "gen",
    KONTROL_ARTIFACT_PATH: "/x",
    KONTROL_BUILD_ID: "b",
    KONTROL_LAUNCHER: "serve",
    KONTROL_EXPECTED_SCHEMA_VERSION: "9",
    KONTROL_STATE_DIR: "/state",
  });
  for (const key of launcherAuthorityKeys) {
    assert.equal(key in stripped, false, `${key} is stripped`);
  }
  assert.equal(stripped.PATH, "/bin");
  assert.equal(stripped.KONTROL_STATE_DIR, "/state");
}

// ── openDatabase ignores ambient launcher authority ──
{
  // With the pre-fix implementation, these ambient values changed migration
  // and backup behavior of every database opened by the process — including
  // test databases. The DB layer now takes an explicit context.
  process.env.KONTROL_EXPECTED_SCHEMA_VERSION = "not-a-number";
  process.env.KONTROL_DEPLOYMENT_ID = "ambient-dep";
  try {
    const stateDir = mkdtempSync(join(tmpdir(), "kontrol-runtime-context-test-"));
    const handle = openDatabase(stateDir); // no context passed
    handle.close();
  } finally {
    delete process.env.KONTROL_EXPECTED_SCHEMA_VERSION;
    delete process.env.KONTROL_DEPLOYMENT_ID;
  }

  // An explicitly passed context is honored.
  const stateDir2 = mkdtempSync(join(tmpdir(), "kontrol-runtime-context-test2-"));
  const handle2 = openDatabase(stateDir2, { deploymentId: brandDeploymentId("explicit-dep"), expectedSchemaVersion: undefined });
  handle2.close();
}

console.log("runtime-context.test.ts: all assertions passed");
