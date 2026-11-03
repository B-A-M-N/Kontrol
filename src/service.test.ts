import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "./db/client.js";
import { captureMigrationBackup } from "./db/deployment-backup.js";
import { LATEST_SCHEMA_VERSION } from "./db/migrations.js";
import { readServiceBuild, renderServiceComponentUnit, renderUserServiceUnit, requireTunnelReviewerWiring, runServiceCommand, servicePaths, withTunnelReviewerAuth } from "./service.js";
import { writeKontrolAuth, writeKontrolConfig } from "./user-config.js";

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
const normalizedUnitPaths = unit.replaceAll("\\\\", "/");
assert.match(unit, /WorkingDirectory=".*working directory"/);
assert.match(unit, /EnvironmentFile=-".*environment with spaces"/);
assert.match(unit, /Environment="KONTROL_ARTIFACT_PATH=.*release with spaces"/);
assert.match(normalizedUnitPaths, /ExecStart=\/usr\/bin\/env node ".*release with spaces\/cli\.js" serve/);
assert.doesNotMatch(unit, /tsx|src\/config|kontrol-user-service\.sh/);

const paths = servicePaths({
  XDG_CONFIG_HOME: join(root, "config home"),
  XDG_DATA_HOME: join(root, "data home"),
  KONTROL_STATE_DIR: join(root, "state override"),
  KONTROL_USER_SERVICE_NAME: "kontrol-test.service",
});
assert.equal(paths.serviceName, "kontrol-test.service");
assert.equal(paths.stateDir, join(root, "state override"));
assert.match(paths.releasesRoot.replaceAll("\\", "/"), /data home\/kontrol\/releases$/);

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
    // Hermetic: install validation reads serviceComponents/authMode from the
    // config dir, so the fixture must not inherit the operator's ~/.kontrol.
    KONTROL_CONFIG_DIR: join(lifecycleRoot, "kontrol config"),
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

// --- P1.9: auxiliary component units + kontrol.target ---
{
  const componentRoot = mkdtempSync(join(tmpdir(), "kontrol-service-components-"));
  try {
    const configHome = join(componentRoot, "config home");
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      KONTROL_SERVICE_DATA_DIR: join(componentRoot, "service data"),
      KONTROL_STATE_DIR: join(componentRoot, "database state"),
      KONTROL_USER_SERVICE_NAME: "kontrol-fixture.service",
      KONTROL_CONFIG_DIR: join(componentRoot, "kontrol config"),
    };
    writeKontrolConfig({
      serviceComponents: [
        { name: "hermes", kind: "adapter", command: ["node", "@ARTIFACT/../scripts/acp-hermes-native-adapter.mjs"], port: 9911 },
        { name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run", "--profile", "sample_mcp_with_dcr"] },
      ],
    }, env);

    const calls: string[] = [];
    const dependencies = {
      currentArtifactPath: () => artifact,
      requireSystemd: () => undefined,
      systemctl: (_paths: ReturnType<typeof servicePaths>, args: string[]) => { calls.push(args.join(" ")); },
      waitForReady: async () => undefined,
    };
    await runServiceCommand(["install"], env, dependencies);

    const unitDir = join(configHome, "systemd", "user");
    const hermesUnit = readFileSync(join(unitDir, "kontrol-hermes.service"), "utf8");
    const normalizedHermesUnitPaths = hermesUnit.replaceAll("\\\\", "/");
    assert.match(hermesUnit, /Description=Kontrol ACP adapter \(hermes\)/);
    assert.match(hermesUnit, /PartOf=kontrol\.target/);
    assert.match(hermesUnit, /After=kontrol-core\.service/);
    assert.match(hermesUnit, /Restart=on-failure/);
    assert.match(hermesUnit, /WantedBy=kontrol\.target/);
    assert.match(normalizedHermesUnitPaths, /ExecStart=\/usr\/bin\/env node .*releases.*build-test-1.*scripts\/acp-hermes-native-adapter\.mjs/);
    const tunnelUnit = readFileSync(join(unitDir, "kontrol-tunnel.service"), "utf8");
    assert.match(tunnelUnit, /Description=Kontrol Secure MCP Tunnel \(tunnel\)/);
    // A bare tunnel-client command must not reach the unit: the installer
    // auto-wires the reviewer-assertion header (never a secret value). The
    // header names the dedicated variable (server precedence #1), never the
    // legacy ACP secret.
    assert.match(tunnelUnit, /ExecStart=\/usr\/bin\/env tunnel-client run --profile sample_mcp_with_dcr --mcp\.extra-headers "X-Kontrol-Tunnel-Reviewer: env:KONTROL_TUNNEL_REVIEWER_SECRET"/);
    assert.doesNotMatch(tunnelUnit, /bearer|token=\S+|secret=\S+/i);
    // Adapter units are unaffected by tunnel reviewer wiring.
    assert.doesNotMatch(hermesUnit, /X-Kontrol-Tunnel-Reviewer/);
    const targetUnit = readFileSync(join(unitDir, "kontrol.target"), "utf8");
    assert.match(targetUnit, /Wants=kontrol-core\.service/);
    assert.match(targetUnit, /WantedBy=default\.target/);

    // Install's daemon-reload happens once after the whole unit set lands.
    assert.ok(calls.some((call) => call === "daemon-reload"), "daemon-reload after component install");

    // Status reports the target and each configured component.
    calls.length = 0;
    await runServiceCommand(["status"], env, { ...dependencies, requireSystemd: () => undefined });
    assert.ok(calls.some((call) => call.includes("kontrol.target") && call.includes("kontrol-hermes.service") && call.includes("kontrol-tunnel.service")), `status calls: ${calls.join(" | ")}`);

    // Removing a component from the configuration deletes its unit at install.
    writeKontrolConfig({
      serviceComponents: [
        { name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] },
      ],
    }, env);
    await runServiceCommand(["install"], env, dependencies);
    assert.equal(existsSync(join(unitDir, "kontrol-hermes.service")), false, "removed component unit is deleted");
    assert.ok(existsSync(join(unitDir, "kontrol-tunnel.service")), "remaining component unit survives");

    // Invalid component configuration fails install closed.
    writeKontrolConfig({ serviceComponents: [{ name: "bad name!", kind: "adapter", command: ["agent"] }] }, env);
    await assert.rejects(() => runServiceCommand(["install"], env, dependencies), /Invalid service component name/);
    writeKontrolConfig({ serviceComponents: [{ name: "shell", kind: "adapter", command: ["bash", "-c", "boom"] }] }, env);
    await assert.rejects(() => runServiceCommand(["install"], env, dependencies), /plain executable name/);

    // Uninstall removes component units and the target.
    writeKontrolConfig({ serviceComponents: [{ name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] }] }, env);
    await runServiceCommand(["install"], env, dependencies);
    await runServiceCommand(["uninstall"], env, dependencies);
    assert.equal(existsSync(join(unitDir, "kontrol-tunnel.service")), false, "component unit removed on uninstall");
    assert.equal(existsSync(join(unitDir, "kontrol.target")), false, "target removed on uninstall");
  } finally {
    rmSync(componentRoot, { recursive: true, force: true });
  }
}

// --- Tunnel reviewer-auth wiring ---
{
  // Pure helper: auto-append is idempotent, exact, and adapters never match.
  assert.deepEqual(
    withTunnelReviewerAuth(["tunnel-client", "run", "--profile", "sample_mcp_with_dcr"]),
    ["tunnel-client", "run", "--profile", "sample_mcp_with_dcr", "--mcp.extra-headers", "X-Kontrol-Tunnel-Reviewer: env:KONTROL_TUNNEL_REVIEWER_SECRET"],
  );
  const explicit = ["tunnel-client", "run", "--mcp.extra-headers", "X-Kontrol-Tunnel-Reviewer: env:KONTROL_TUNNEL_REVIEWER_SECRET"];
  assert.deepEqual(withTunnelReviewerAuth(explicit), explicit, "explicit header is never duplicated or rewritten");
  // A header naming another variable is still an exact header: left alone.
  const legacyExplicit = ["tunnel-client", "run", "--mcp.extra-headers", "X-Kontrol-Tunnel-Reviewer: env:KONTROL_ACP_REVIEWER_SECRET"];
  assert.deepEqual(withTunnelReviewerAuth(legacyExplicit), legacyExplicit, "explicit legacy header is preserved, not rewritten");
  // Malformed reviewer headers fail closed instead of stacking flags.
  assert.throws(
    () => withTunnelReviewerAuth(["tunnel-client", "run", "--mcp.extra-headers", "X-Kontrol-Tunnel-Reviewer bogus"]),
    /malformed reviewer header/,
    "malformed reviewer header is rejected, not papered over",
  );
  assert.throws(
    () => withTunnelReviewerAuth(["tunnel-client", "run", "--mcp.extra-headers"]),
    /malformed reviewer header/,
    "dangling extra-headers flag is rejected",
  );
  // Substring lookalikes do not count as wiring: the flag must be exact.
  assert.deepEqual(
    withTunnelReviewerAuth(["tunnel-client", "run", "--note", "mentions X-Kontrol-Tunnel-Reviewer in passing"]),
    ["tunnel-client", "run", "--note", "mentions X-Kontrol-Tunnel-Reviewer in passing", "--mcp.extra-headers", "X-Kontrol-Tunnel-Reviewer: env:KONTROL_TUNNEL_REVIEWER_SECRET"],
    "header name in an unrelated argument is not valid wiring",
  );
  assert.equal(
    renderServiceComponentUnit({ name: "t", kind: "tunnel", command: ["tunnel-client", "run"] }, { artifactPath: "/a", buildId: "b", environmentFile: "/e", workingDirectory: "/w" }).match(/X-Kontrol-Tunnel-Reviewer/g)?.length,
    1,
    "rendered tunnel unit carries exactly one reviewer header",
  );
  assert.doesNotMatch(
    renderServiceComponentUnit({ name: "a", kind: "adapter", command: ["agent"] }, { artifactPath: "/a", buildId: "b", environmentFile: "/e", workingDirectory: "/w" }),
    /X-Kontrol-Tunnel-Reviewer/,
    "adapter units never gain the tunnel reviewer header",
  );

  // Install-time gate: tunnel authMode + ask-capable policy without any
  // reviewer secret must fail closed instead of producing a client-only unit.
  const wiringRoot = mkdtempSync(join(tmpdir(), "kontrol-service-wiring-"));
  try {
    const baseEnv = {
      ...process.env,
      XDG_CONFIG_HOME: join(wiringRoot, "config home"),
      KONTROL_SERVICE_DATA_DIR: join(wiringRoot, "service data"),
      KONTROL_STATE_DIR: join(wiringRoot, "database state"),
      KONTROL_USER_SERVICE_NAME: "kontrol-wiring.service",
      KONTROL_CONFIG_DIR: join(wiringRoot, "kontrol config"),
      KONTROL_AUTH_MODE: "tunnel",
      KONTROL_POLICY_MODE: "ask",
      KONTROL_TUNNEL_REVIEWER_SECRET: undefined,
      KONTROL_ACP_REVIEWER_SECRET: undefined,
    };
    const wiringDeps = {
      currentArtifactPath: () => artifact,
      requireSystemd: () => undefined,
      systemctl: () => undefined,
      waitForReady: async () => undefined,
    };
    const tunnelComponent: { name: string; kind: "tunnel"; command: string[] } = { name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] };
    const fixtureEnvFile = join(wiringRoot, "config home", "kontrol", "environment");
    const resetEnvFile = () => rmSync(fixtureEnvFile, { force: true });
    const installWith = (env: NodeJS.ProcessEnv) => {
      writeKontrolConfig({ serviceComponents: [{ ...tunnelComponent }] }, env);
      return runServiceCommand(["install"], env, wiringDeps);
    };
    await assert.rejects(
      () => installWith(baseEnv),
      /reviewer assertion/,
      "ask-capable tunnel without a reviewer secret fails install closed",
    );
    // dedicated-only: header names the dedicated variable; the value is
    // ensured in the env file so the service runtime (not install env)
    // provides it to tunnel-client.
    resetEnvFile();
    await installWith({ ...baseEnv, KONTROL_TUNNEL_REVIEWER_SECRET: "wiring-dedicated-secret" });
    const unitDir = join(wiringRoot, "config home", "systemd", "user");
    const dedicatedUnit = readFileSync(join(unitDir, "kontrol-tunnel.service"), "utf8");
    assert.match(dedicatedUnit, /X-Kontrol-Tunnel-Reviewer: env:KONTROL_TUNNEL_REVIEWER_SECRET/);
    assert.doesNotMatch(dedicatedUnit, /wiring-dedicated-secret/, "secret value never lands in the unit");
    // legacy-only: header still names the dedicated variable; the value is
    // materialized into the 0600 service EnvironmentFile for tunnel-client.
    resetEnvFile();
    await installWith({ ...baseEnv, KONTROL_ACP_REVIEWER_SECRET: "wiring-legacy-secret" });
    const legacyUnit = readFileSync(join(unitDir, "kontrol-tunnel.service"), "utf8");
    assert.match(legacyUnit, /X-Kontrol-Tunnel-Reviewer: env:KONTROL_TUNNEL_REVIEWER_SECRET/);
    assert.doesNotMatch(legacyUnit, /wiring-legacy-secret/, "secret value never lands in the unit");
    const envFileAfterLegacy = readFileSync(fixtureEnvFile, "utf8");
    assert.ok(envFileAfterLegacy.includes("KONTROL_TUNNEL_REVIEWER_SECRET=wiring-legacy-secret"), "legacy secret is materialized for the tunnel runtime");
    // both-different: the dedicated credential wins on both sides.
    resetEnvFile();
    await installWith({ ...baseEnv, KONTROL_TUNNEL_REVIEWER_SECRET: "wiring-dedicated-secret", KONTROL_ACP_REVIEWER_SECRET: "wiring-legacy-secret" });
    const bothUnit = readFileSync(join(unitDir, "kontrol-tunnel.service"), "utf8");
    assert.match(bothUnit, /env:KONTROL_TUNNEL_REVIEWER_SECRET/);
    assert.doesNotMatch(bothUnit, /env:KONTROL_ACP_REVIEWER_SECRET/, "header must not reference the losing credential");
    // auth-file-only: the 0600 auth file satisfies the guard and the value
    // is materialized into the service EnvironmentFile for tunnel-client.
    resetEnvFile();
    writeKontrolAuth({ tunnelReviewerSecret: "wiring-authfile-secret" }, baseEnv);
    await installWith(baseEnv);
    const authFileUnit = readFileSync(join(unitDir, "kontrol-tunnel.service"), "utf8");
    assert.match(authFileUnit, /env:KONTROL_TUNNEL_REVIEWER_SECRET/);
    assert.doesNotMatch(authFileUnit, /wiring-authfile-secret/, "secret value never lands in the unit");
    const envFileAfterAuth = readFileSync(fixtureEnvFile, "utf8");
    assert.ok(envFileAfterAuth.includes("KONTROL_TUNNEL_REVIEWER_SECRET=wiring-authfile-secret"), "auth-file secret is materialized for the tunnel runtime");
    // Non-tunnel authMode is unaffected by the gate.
    requireTunnelReviewerWiring(
      [{ name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] }],
      { ...baseEnv, KONTROL_AUTH_MODE: "oauth" },
    );
  } finally {
    rmSync(wiringRoot, { recursive: true, force: true });
  }
}

console.log("service.test.ts: all assertions passed");
