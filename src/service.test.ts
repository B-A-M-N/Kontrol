import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "./db/client.js";
import { captureMigrationBackup } from "./db/deployment-backup.js";
import { LATEST_SCHEMA_VERSION } from "./db/migrations.js";
import { readServiceBuild, renderUserServiceUnit, runServiceCommand, servicePaths } from "./service.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-service-test-"));
const artifact = join(root, "release with spaces");
mkdirSync(artifact, { recursive: true });
writeFileSync(join(artifact, "cli.js"), "#!/usr/bin/env node\n");
writeFileSync(join(artifact, "build-meta.json"), JSON.stringify({
  buildId: "build-test-1",
  contentSha256: "0123456789abcdef",
  schemaVersion: 52,
  minReadableSchemaVersion: 0,
  maxReadableSchemaVersion: 52,
}));

const build = readServiceBuild(artifact);
assert.equal(build.buildId, "build-test-1");
const unit = renderUserServiceUnit({
  ...build,
  serviceName: "kontrol-test.service",
  deploymentId: "deployment-test",
  stateDir: join(root, "state with spaces"),
  environmentFile: join(root, "environment with spaces"),
  workingDirectory: join(root, "working directory"),
});
assert.match(unit, /WorkingDirectory=".*working directory"/);
assert.match(unit, /EnvironmentFile=-".*environment with spaces"/);
assert.match(unit, /Environment="KONTROL_ARTIFACT_PATH=.*release with spaces"/);
assert.match(unit, /ExecStart=\/usr\/bin\/env node ".*release with spaces\/cli\.js" serve/);
assert.doesNotMatch(unit, /tsx|src\/config|kontrol-user-service\.sh/);

const paths = servicePaths({
  XDG_CONFIG_HOME: join(root, "config home"),
  XDG_DATA_HOME: join(root, "data home"),
  KONTROL_STATE_DIR: join(root, "state override"),
  KONTROL_USER_SERVICE_NAME: "kontrol-test.service",
});
assert.equal(paths.serviceName, "kontrol-test.service");
assert.equal(paths.stateDir, join(root, "state override"));
assert.match(paths.releasesRoot, /data home\/kontrol\/releases$/);

assert.throws(
  () => readServiceBuild(artifact.replace("release with spaces", "../bad")),
  /Invalid Kontrol release artifact|invalid|ENOENT/i,
);

const lifecycleRoot = mkdtempSync(join(tmpdir(), "kontrol-service-lifecycle-test-"));
try {
  const artifactA = join(lifecycleRoot, "checkout A");
  const artifactB = join(lifecycleRoot, "checkout B");
  const writeArtifact = (path: string, buildId: string, contentSha256: string, schemaVersion: number) => {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "cli.js"), `#!/usr/bin/env node\n// ${buildId}\n`);
    writeFileSync(join(path, "build-meta.json"), JSON.stringify({
      buildId,
      contentSha256,
      schemaVersion,
      minReadableSchemaVersion: 0,
      maxReadableSchemaVersion: schemaVersion,
    }));
  };
  writeArtifact(artifactA, "build-a", "aaaaaaaaaaaaaaaa", LATEST_SCHEMA_VERSION);
  writeArtifact(artifactB, "build-b", "bbbbbbbbbbbbbbbb", LATEST_SCHEMA_VERSION + 1);

  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(lifecycleRoot, "config home"),
    KONTROL_SERVICE_DATA_DIR: join(lifecycleRoot, "service data"),
    KONTROL_STATE_DIR: join(lifecycleRoot, "database state"),
    KONTROL_USER_SERVICE_NAME: "kontrol-fixture.service",
  };
  const calls: string[] = [];
  const dependencies = {
    currentArtifactPath: () => artifactA,
    requireSystemd: () => undefined,
    systemctl: (paths: ReturnType<typeof servicePaths>, args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] !== "start") return;
      const installed = JSON.parse(readFileSync(paths.statePath, "utf8")) as { buildId: string; deploymentId: string; schemaVersion: number };
      if (installed.buildId !== "build-b") return;
      const sqlite = new Database(databasePath(paths.stateDir));
      try {
        captureMigrationBackup(sqlite, databasePath(paths.stateDir), paths.stateDir, installed.deploymentId, LATEST_SCHEMA_VERSION + 1);
        sqlite.exec("create table candidate_only_after_migration (id text primary key not null)");
        sqlite.prepare("insert into kontrol_schema_migrations (version, name, applied_at) values (?, ?, ?)").run(
          LATEST_SCHEMA_VERSION + 1,
          "fixture_candidate_migration",
          new Date().toISOString(),
        );
      } finally {
        sqlite.close();
      }
    },
    waitForReady: async (_paths: ReturnType<typeof servicePaths>, expected: { buildId: string }) => {
      if (expected.buildId === "build-b") throw new Error("fixture candidate failed readiness");
    },
  };

  await runServiceCommand(["install"], env, dependencies);
  const initial = openDatabase(servicePaths(env).stateDir);
  initial.close();
  await assert.rejects(
    () => runServiceCommand(["upgrade"], env, { ...dependencies, currentArtifactPath: () => artifactB }),
    /Candidate build-b failed readiness; previous build build-a and database were restored/,
  );

  const pathsAfterRollback = servicePaths(env);
  const restoredState = JSON.parse(readFileSync(pathsAfterRollback.statePath, "utf8")) as { buildId: string; artifactPath: string };
  assert.equal(restoredState.buildId, "build-a");
  assert.match(restoredState.artifactPath, /releases[\\/]build-a$/);
  const restored = new Database(databasePath(pathsAfterRollback.stateDir), { readonly: true });
  try {
    const schema = restored.prepare("select max(version) as version from kontrol_schema_migrations").get() as { version: number };
    assert.equal(schema.version, LATEST_SCHEMA_VERSION, "rollback restores the pre-migration schema");
    assert.throws(() => restored.prepare("select * from candidate_only_after_migration").get(), /no such table/);
  } finally {
    restored.close();
  }
  const upgradeRecords = calls.filter((call) => call.includes("start") || call.includes("stop"));
  assert.deepEqual(upgradeRecords.slice(-4), [
    "stop kontrol-fixture.service",
    "start kontrol-fixture.service",
    "stop kontrol-fixture.service",
    "start kontrol-fixture.service",
  ]);
  const deploymentRecordName = readdirSync(pathsAfterRollback.stateDir).find((name) => {
    if (!name.startsWith("deployment.") || !name.endsWith(".json")) return false;
    const record = JSON.parse(readFileSync(join(pathsAfterRollback.stateDir, name), "utf8")) as { operation?: string };
    return record.operation === "upgrade";
  });
  assert.ok(deploymentRecordName, "upgrade deployment record is persisted");
  const deploymentRecord = JSON.parse(readFileSync(join(pathsAfterRollback.stateDir, deploymentRecordName!), "utf8")) as { stage: string; databaseRestore?: { restored?: boolean } };
  assert.equal(deploymentRecord.stage, "commit", "rollback completion is persisted as a committed recovery");
  assert.equal(deploymentRecord.databaseRestore?.restored, true, "deployment record includes database restoration evidence");
  const migrationRecordName = readdirSync(pathsAfterRollback.stateDir).find((name) => name.startsWith("database-migration.") && name.endsWith(".json"));
  assert.ok(migrationRecordName, "migration journal is persisted");
  const migrationRecord = JSON.parse(readFileSync(join(pathsAfterRollback.stateDir, migrationRecordName!), "utf8")) as { restoredAt?: string };
  assert.ok(migrationRecord.restoredAt, "migration rollback remains inspectable");
} finally {
  rmSync(lifecycleRoot, { recursive: true, force: true });
}

console.log("service.test.ts: all assertions passed");
