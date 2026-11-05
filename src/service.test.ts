import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "./db/client.js";
import { captureMigrationBackup } from "./db/deployment-backup.js";
import { acquireDeploymentLock, releaseDeploymentLock } from "./deployment-lock.js";
import { readInstalledPort } from "./service.js";
import { LATEST_SCHEMA_VERSION } from "./db/migrations.js";
import { probeTunnelChannel, readServiceBuild, recoverTunnel, renderServiceComponentUnit, renderUserServiceUnit, requireTunnelReviewerWiring, runServiceCommand, servicePaths, waitForCoreReady, withTunnelReviewerAuth } from "./service.js";
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
// Bare paths (no quotes): systemd 249 — the production host's version —
// rejects a quoted WorkingDirectory as "not absolute", and silently
// ignores a quoted EnvironmentFile (verified live: the service then
// starts without its environment and exits "not configured"). Quoting
// either encodes a unit the host cannot run. The spaces in the fixture
// paths prove no quotes are emitted even when quoting looks tempting.
assert.match(unit, /WorkingDirectory=.*working directory/);
assert.doesNotMatch(unit, /WorkingDirectory="/);
assert.match(unit, /EnvironmentFile=.*environment with spaces/);
assert.doesNotMatch(unit, /EnvironmentFile="/);
assert.doesNotMatch(unit, /EnvironmentFile=-/);
assert.match(unit, /RestartPreventExitStatus=78/);
// Target stop drains the whole stack, core included: the lifecycle stop
// verification requires it, and the mini-systemd model assumes it.
assert.match(unit, /PartOf=kontrol\.target/);
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
    KONTROL_USER_ENV_FILE: join(lifecycleRoot, "environment"),
  };
  mkdirSync(join(lifecycleRoot, "config home", "kontrol"), { recursive: true });
  writeFileSync(join(lifecycleRoot, "environment"), "PORT=7676\n", { mode: 0o600 });
  // Mini-systemd: stopping the target drains every member (PartOf); starting
  // the target brings the whole stack up. The harness, not the test prose,
  // is what the stop/start verification logic observes.
  const activeUnits = new Set<string>();
  const calls: string[] = [];
  const dependencies = {
    currentArtifactPath: () => artifactA,
    requireSystemd: () => undefined,
    systemctl: (paths: ReturnType<typeof servicePaths>, args: string[]) => {
      calls.push(args.join(" "));
      const [op, ...rest] = args;
      const unit = rest.at(-1) ?? "";
      if (op === "stop") {
        activeUnits.delete(unit);
        if (unit === "kontrol.target") activeUnits.delete("kontrol-fixture.service");
      }
      if ((op === "enable" && rest.includes("--now")) || op === "start" || op === "restart") {
        activeUnits.add(unit);
        if (unit === "kontrol.target") activeUnits.add("kontrol-fixture.service");
      }
      // Candidate activation migrates the live database, exactly as a real
      // candidate start would before its readiness probe fails.
      if (op === "enable" && rest.includes("--now")) {
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
      }
    },
    probeUnitActive: (unit: string) => activeUnits.has(unit),
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
  // The whole stack — not the core alone — stops and starts on both the
  // candidate attempt and the verified rollback.
  const stopCalls = calls.filter((call) => call === "stop kontrol.target");
  const startCalls = calls.filter((call) => call === "enable --now kontrol.target");
  assert.deepEqual(stopCalls, ["stop kontrol.target", "stop kontrol.target"]);
  assert.deepEqual(startCalls, ["enable --now kontrol.target", "enable --now kontrol.target"]);
  assert.ok(!calls.some((call) => /(^|\s)(start|stop|restart) kontrol-fixture\.service($|\s)/.test(call)), "upgrade never addresses the core alone");
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
      KONTROL_USER_ENV_FILE: join(componentRoot, "environment"),
    };
    writeFileSync(join(componentRoot, "environment"), "PORT=7676\n", { mode: 0o600 });
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
    // The fixture service name is kontrol-fixture.service; the graph is
    // generated from the manifest, never hardcoded to kontrol-core.service.
    assert.match(targetUnit, /Wants=kontrol-fixture\.service/);
    // The manifest-generated graph names every auxiliary member so the
    // aggregate stack starts together, and Requires pins the core so a
    // dead core fails the aggregate instead of reporting healthy.
    assert.match(targetUnit, /Wants=.*kontrol-hermes\.service/);
    assert.match(targetUnit, /Wants=.*kontrol-tunnel\.service/);
    assert.match(targetUnit, /Requires=kontrol-fixture\.service/);
    assert.match(targetUnit, /WantedBy=default\.target/);

    // Install's daemon-reload happens once after the whole unit set lands.
    assert.ok(calls.some((call) => call === "daemon-reload"), "daemon-reload after component install");

    // Status reports the target and each configured component. Units are
    // stubbed inactive: fixture component names collide with real
    // production units on a live machine, and the tunnel channel probe
    // must never touch a non-fixture endpoint from a hermetic test.
    calls.length = 0;
    await runServiceCommand(["status"], env, { ...dependencies, requireSystemd: () => undefined, probeUnit: () => "inactive" as const });
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

// --- Lifecycle gates: preflight refusal, required env, aggregate target, stop verification, status verdict ---
{
  const gateRoot = mkdtempSync(join(tmpdir(), "kontrol-service-gates-"));
  try {
    const makeArtifact = (dirName: string, buildId: string, schemaVersion: number, maxReadable: number, minReadable = 0): string => {
      const path = join(gateRoot, dirName);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "cli.js"), "#!/usr/bin/env node\n");
      writeFileSync(join(path, "build-meta.json"), JSON.stringify({
        buildId,
        contentSha256: "aaaaaaaaaaaaaaaa",
        schemaVersion,
        minReadableSchemaVersion: minReadable,
        maxReadableSchemaVersion: maxReadable,
      }));
      return path;
    };
    const writeRawDb = (stateDir: string, version: number): void => {
      mkdirSync(stateDir, { recursive: true });
      const sqlite = new Database(join(stateDir, "kontrol.sqlite"));
      try {
        sqlite.exec("create table if not exists kontrol_schema_migrations (version integer primary key, name text not null, applied_at text not null)");
        sqlite.prepare("insert into kontrol_schema_migrations (version, name, applied_at) values (?, ?, ?)").run(version, "fixture", new Date().toISOString());
      } finally {
        sqlite.close();
      }
    };
    const gateEnv = (tag: string): NodeJS.ProcessEnv => ({
      ...process.env,
      XDG_CONFIG_HOME: join(gateRoot, tag, "config home"),
      KONTROL_SERVICE_DATA_DIR: join(gateRoot, tag, "service data"),
      KONTROL_STATE_DIR: join(gateRoot, tag, "database state"),
      KONTROL_USER_SERVICE_NAME: `kontrol-gate-${tag}.service`,
      KONTROL_CONFIG_DIR: join(gateRoot, tag, "kontrol config"),
      KONTROL_USER_ENV_FILE: join(gateRoot, tag, "environment"),
    });
    const staleArtifact = makeArtifact("stale artifact", "build-stale", 100, 113);
    const freshArtifact = makeArtifact("fresh artifact", "build-fresh", 116, 116);
    const writeEnvFile = (tag: string): void => {
      mkdirSync(join(gateRoot, tag), { recursive: true });
      writeFileSync(join(gateRoot, tag, "environment"), "PORT=9\n", { mode: 0o600 });
    };

    // 1. Install refuses an incompatible candidate before any mutation.
    {
      const env = gateEnv("refuse-install");
      const stateDir = join(gateRoot, "refuse-install", "database state");
      writeRawDb(stateDir, 116);
      writeEnvFile("refuse-install");
      const calls: string[] = [];
      await assert.rejects(
        () => runServiceCommand(["install"], env, {
          currentArtifactPath: () => staleArtifact,
          requireSystemd: () => undefined,
          systemctl: (_paths: ReturnType<typeof servicePaths>, args: string[]) => { calls.push(args.join(" ")); },
          waitForReady: async () => undefined,
        }),
        /database schema 116 exceeds candidate read limit 113/,
      );
      const fixturePaths = servicePaths(env);
      assert.equal(existsSync(fixturePaths.statePath), false, "rejected install writes no installed state");
      assert.equal(existsSync(fixturePaths.releasesRoot), false, "rejected install copies no release");
      assert.deepEqual(calls, [], "rejected install touches systemctl");
    }

    // 2. Install refuses a missing environment file without logging secrets.
    {
      const env = gateEnv("missing-env");
      await assert.rejects(
        () => runServiceCommand(["install"], env, {
          currentArtifactPath: () => freshArtifact,
          requireSystemd: () => undefined,
          systemctl: () => undefined,
          waitForReady: async () => undefined,
        }),
        /environment file is missing/,
      );
    }

    // 3. Start/stop/restart address the aggregate target; stop verifies.
    {
      const env = gateEnv("target-ops");
      writeEnvFile("target-ops");
      const calls: string[] = [];
      const baseDeps = {
        currentArtifactPath: () => freshArtifact,
        requireSystemd: () => undefined,
        systemctl: (_paths: ReturnType<typeof servicePaths>, args: string[]) => { calls.push(args.join(" ")); },
        waitForReady: async () => undefined,
        probeUnitActive: () => false,
      };
      await runServiceCommand(["install"], env, baseDeps);
      calls.length = 0;
      await runServiceCommand(["start"], env, baseDeps);
      assert.ok(calls.some((call) => call === "enable --now kontrol.target"), `start enables the aggregate target: ${calls.join(" | ")}`);
      assert.ok(!calls.some((call) => call.includes("kontrol-gate-target-ops.service") && call.startsWith("enable --now kontrol-gate")), "start does not enable only the core");
      calls.length = 0;
      await runServiceCommand(["restart"], env, baseDeps);
      assert.ok(calls.some((call) => call === "restart kontrol.target"), `restart restarts the aggregate target: ${calls.join(" | ")}`);
      calls.length = 0;
      await runServiceCommand(["stop"], env, baseDeps);
      assert.ok(calls.some((call) => call === "stop kontrol.target"), `stop stops the aggregate target: ${calls.join(" | ")}`);
      await assert.rejects(
        () => runServiceCommand(["stop"], env, { ...baseDeps, probeUnitActive: () => true }),
        /still active/,
        "partial shutdown is a failure, not a success",
      );
      // A draining stack (PartOf stop propagates, the core exits ~0.5s
      // later) passes: the verification polls briefly instead of failing
      // on the first probe while the core is still deactivating.
      {
        let probes = 0;
        await runServiceCommand(["stop"], env, { ...baseDeps, probeUnitActive: () => ++probes <= 3 });
        assert.ok(probes > 1, "stop verification polls while the stack drains");
      }
    }

    // 4. Start preflight refuses a build that cannot read the live database.
    {
      const env = gateEnv("refuse-start");
      writeEnvFile("refuse-start");
      const deps = {
        currentArtifactPath: () => staleArtifact,
        requireSystemd: () => undefined,
        systemctl: () => undefined,
        waitForReady: async () => undefined,
        probeUnitActive: () => false,
      };
      await runServiceCommand(["install"], env, deps);
      writeRawDb(join(gateRoot, "refuse-start", "database state"), 116);
      await assert.rejects(
        () => runServiceCommand(["start"], env, deps),
        /database schema 116 exceeds candidate read limit 113/,
        "start refuses a doomed build instead of launching a crash loop",
      );
    }

    // 5. Upgrade preflight leaves the installed deployment untouched.
    {
      const env = gateEnv("refuse-upgrade");
      writeEnvFile("refuse-upgrade");
      const installDeps = {
        currentArtifactPath: () => freshArtifact,
        requireSystemd: () => undefined,
        systemctl: () => undefined,
        waitForReady: async () => undefined,
      };
      await runServiceCommand(["install"], env, installDeps);
      writeRawDb(join(gateRoot, "refuse-upgrade", "database state"), 116);
      await assert.rejects(
        () => runServiceCommand(["upgrade"], env, { ...installDeps, currentArtifactPath: () => staleArtifact }),
        /database schema 116 exceeds candidate read limit 113/,
      );
      const restored = JSON.parse(readFileSync(servicePaths(env).statePath, "utf8")) as { buildId: string };
      assert.equal(restored.buildId, "build-fresh", "rejected upgrade keeps the installed build");
    }

    // 6a. The readiness port comes from the installed environment, with a
    // safe default for missing or malformed values.
    {
      const env = gateEnv("installed-port");
      const fixturePaths = servicePaths(env);
      mkdirSync(join(gateRoot, "installed-port"), { recursive: true });
      writeFileSync(join(gateRoot, "installed-port", "environment"), "PORT=8765\n", { mode: 0o600 });
      assert.equal(readInstalledPort(fixturePaths), 8765);
      writeFileSync(join(gateRoot, "installed-port", "environment"), "export PORT=\"not-a-port\"\n", { mode: 0o600 });
      assert.equal(readInstalledPort(fixturePaths), 7676);
      rmSync(join(gateRoot, "installed-port", "environment"));
      assert.equal(readInstalledPort(fixturePaths), 7676);
      assert.equal(readInstalledPort({ ...fixturePaths, environmentFile: join(gateRoot, "installed-port", "environment") }), 7676);
    }

    // 6b. Concurrent lifecycle attempts fail closed on the deployment lock.
    {
      const env = gateEnv("concurrent");
      writeEnvFile("concurrent");
      const fixturePaths = servicePaths(env);
      const held = await acquireDeploymentLock(fixturePaths.stateDir, {
        operation: "systemd-install",
        deploymentId: "gate-concurrent-holder",
        pid: process.pid,
      });
      try {
        await assert.rejects(
          () => runServiceCommand(["install"], env, {
            currentArtifactPath: () => freshArtifact,
            requireSystemd: () => undefined,
            systemctl: () => undefined,
            waitForReady: async () => undefined,
          }),
          /deployment/i,
          "a second lifecycle operation cannot mutate while one holds the lock",
        );
      } finally {
        await releaseDeploymentLock(fixturePaths.stateDir, held.record.token);
      }
    }

    // 6c. Upgrade success commits the candidate; repeated stop is idempotent.
    {
      const env = gateEnv("success-path");
      writeEnvFile("success-path");
      const upgradedArtifact = makeArtifact("upgraded artifact", "build-upgraded", 116, 116);
      const calls: string[] = [];
      const deps = {
        currentArtifactPath: () => freshArtifact,
        requireSystemd: () => undefined,
        systemctl: (_paths: ReturnType<typeof servicePaths>, args: string[]) => { calls.push(args.join(" ")); },
        waitForReady: async () => undefined,
        probeUnitActive: () => false,
      };
      await runServiceCommand(["install"], env, deps);
      await runServiceCommand(["upgrade"], env, { ...deps, currentArtifactPath: () => upgradedArtifact });
      const committed = JSON.parse(readFileSync(servicePaths(env).statePath, "utf8")) as { buildId: string };
      assert.equal(committed.buildId, "build-upgraded", "successful upgrade commits the candidate");
      const callsBeforeStops = calls.length;
      await runServiceCommand(["stop"], env, deps);
      await runServiceCommand(["stop"], env, deps);
      const stopCalls = calls.slice(callsBeforeStops).filter((call) => call === "stop kontrol.target");
      assert.equal(stopCalls.length, 2, "repeated stop re-runs cleanly");
    }

    // 6. Status reports BLOCKED with the exact incompatibility reason.
    {
      const env = gateEnv("status-blocked");
      writeEnvFile("status-blocked");
      const deps = {
        currentArtifactPath: () => staleArtifact,
        requireSystemd: () => undefined,
        systemctl: () => undefined,
        waitForReady: async () => undefined,
        probeUnit: (unit: string) => (unit === "kontrol-gate-status-blocked.service" ? "failed" as const : "active" as const),
      };
      await runServiceCommand(["install"], env, deps);
      writeRawDb(join(gateRoot, "status-blocked", "database state"), 116);
      const logged: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
      try {
        await runServiceCommand(["status"], env, deps);
      } finally {
        console.log = originalLog;
      }
      const report = logged.join("\n");
      assert.match(report, /kontrol service status: BLOCKED/);
      assert.match(report, /installed build build-stale cannot read live database schema 116/);
      assert.match(report, /DRIFT|no live core identity/);
    }

    type GateDeps = Parameters<typeof runServiceCommand>[2];
    const captureStatus = async (env: NodeJS.ProcessEnv, deps: GateDeps): Promise<string> => {
      const logged: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
      try {
        await runServiceCommand(["status"], env, deps);
      } finally {
        console.log = originalLog;
      }
      return logged.join("\n");
    };

    // 7. An upgrade that adds a component rolls the added unit back when
    // post-upgrade readiness fails: the added unit disappears and the
    // surviving units are byte-identical to their pre-upgrade snapshots.
    {
      const env = gateEnv("upgrade-add-rollback");
      writeEnvFile("upgrade-add-rollback");
      writeKontrolConfig({ serviceComponents: [{ name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] }] }, env);
      const addedArtifact = makeArtifact("added artifact", "build-added", 116, 116);
      await runServiceCommand(["install"], env, {
        currentArtifactPath: () => freshArtifact,
        requireSystemd: () => undefined,
        systemctl: () => undefined,
        waitForReady: async () => undefined,
        probeUnitActive: () => false,
      });
      const fixturePaths = servicePaths(env);
      const fixtureUnitDir = dirname(fixturePaths.unitPath);
      const tunnelUnitBefore = readFileSync(join(fixtureUnitDir, "kontrol-tunnel.service"), "utf8");
      writeKontrolConfig({
        serviceComponents: [
          { name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] },
          { name: "hermes", kind: "adapter", command: ["node", "agent.js"], port: 9911 },
        ],
      }, env);
      let targetStarted = false;
      const upgradeDeps: GateDeps = {
        currentArtifactPath: () => addedArtifact,
        requireSystemd: () => undefined,
        systemctl: (_paths, args) => {
          const call = args.join(" ");
          if (call === "stop kontrol.target") targetStarted = false;
          if (call === "enable --now kontrol.target" || call === "start kontrol.target" || call === "restart kontrol.target") targetStarted = true;
        },
        waitForReady: async (_paths, state) => {
          if (state.buildId === "build-added") throw new Error("added component never became ready");
        },
        probeUnitActive: () => targetStarted,
        probeUnit: () => (targetStarted ? "active" : "inactive"),
      };
      await assert.rejects(
        () => runServiceCommand(["upgrade"], env, upgradeDeps),
        /failed readiness; previous build build-fresh and database were restored/,
      );
      assert.equal(existsSync(join(fixtureUnitDir, "kontrol-hermes.service")), false, "added component unit is removed by rollback");
      assert.equal(readFileSync(join(fixtureUnitDir, "kontrol-tunnel.service"), "utf8"), tunnelUnitBefore, "surviving component unit is restored byte-identical");
      const restored = JSON.parse(readFileSync(fixturePaths.statePath, "utf8")) as { buildId: string };
      assert.equal(restored.buildId, "build-fresh", "rejected upgrade keeps the installed build");
    }

    // 8. An existing but unreadable database blocks install, start, and
    // status instead of letting any gate skip compatibility validation.
    {
      const env = gateEnv("unreadable-db");
      writeEnvFile("unreadable-db");
      const deps: GateDeps = {
        currentArtifactPath: () => freshArtifact,
        requireSystemd: () => undefined,
        systemctl: () => undefined,
        waitForReady: async () => undefined,
        probeUnitActive: () => false,
        probeUnit: () => "active",
      };
      await runServiceCommand(["install"], env, deps);
      const fixturePaths = servicePaths(env);
      writeFileSync(join(fixturePaths.stateDir, "kontrol.sqlite"), "this is not a database\n");
      await assert.rejects(
        () => runServiceCommand(["install"], env, deps),
        /cannot be inspected/,
        "reinstall over an unreadable database is refused",
      );
      await assert.rejects(
        () => runServiceCommand(["start"], env, deps),
        /cannot be inspected/,
        "start over an unreadable database is refused",
      );
      const report = await captureStatus(env, deps);
      assert.match(report, /kontrol service status: BLOCKED/);
      assert.match(report, /cannot be inspected/);
    }

    // 9. A candidate whose minimum readable schema exceeds the live schema
    // is refused: the compatibility gate enforces both bounds, not just max.
    {
      const env = gateEnv("min-bound");
      writeEnvFile("min-bound");
      writeRawDb(join(gateRoot, "min-bound", "database state"), 116);
      const narrowArtifact = makeArtifact("narrow artifact", "build-narrow", 118, 118, 118);
      await assert.rejects(
        () => runServiceCommand(["install"], env, {
          currentArtifactPath: () => narrowArtifact,
          requireSystemd: () => undefined,
          systemctl: () => undefined,
          waitForReady: async () => undefined,
        }),
        /predates candidate minimum readable schema 118/,
      );
      assert.equal(existsSync(servicePaths(env).statePath), false, "min-bound refusal writes no installed state");
    }

    // 10. Environment writes are transactional: a failure after credential
    // materialization restores the exact prior bytes and commits nothing.
    // The control proves materialization really happens with these inputs,
    // so the restore assert below is not vacuous.
    {
      const tunnelEnv = (tag: string): NodeJS.ProcessEnv => ({
        ...gateEnv(tag),
        KONTROL_AUTH_MODE: "tunnel",
        KONTROL_ACP_REVIEWER_SECRET: "fixture-legacy-secret",
      });
      const controlEnv = tunnelEnv("env-materializes");
      mkdirSync(join(gateRoot, "env-materializes"), { recursive: true });
      writeFileSync(join(gateRoot, "env-materializes", "environment"), "PORT=9\n", { mode: 0o600 });
      writeKontrolConfig({ serviceComponents: [{ name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] }] }, controlEnv);
      await runServiceCommand(["install"], controlEnv, {
        currentArtifactPath: () => freshArtifact,
        requireSystemd: () => undefined,
        systemctl: () => undefined,
        waitForReady: async () => undefined,
      });
      assert.match(
        readFileSync(join(gateRoot, "env-materializes", "environment"), "utf8"),
        /^KONTROL_TUNNEL_REVIEWER_SECRET=fixture-legacy-secret$/m,
        "tunnel authMode with a legacy credential materializes the canonical secret",
      );
      const env = tunnelEnv("env-restore");
      mkdirSync(join(gateRoot, "env-restore"), { recursive: true });
      const envFile = join(gateRoot, "env-restore", "environment");
      writeFileSync(envFile, "PORT=9\n", { mode: 0o600 });
      writeKontrolConfig({ serviceComponents: [{ name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] }] }, env);
      await assert.rejects(
        () => runServiceCommand(["install"], env, {
          currentArtifactPath: () => freshArtifact,
          requireSystemd: () => undefined,
          systemctl: (_paths, args) => {
            if (args.join(" ").includes("daemon-reload")) throw new Error("daemon reload failed");
          },
          waitForReady: async () => undefined,
        }),
        /daemon reload failed/,
      );
      assert.equal(readFileSync(envFile, "utf8"), "PORT=9\n", "failed install restores the environment file byte-for-byte");
      assert.equal(existsSync(servicePaths(env).statePath), false, "failed install commits no installed state");
      assert.equal(existsSync(join(dirname(servicePaths(env).unitPath), "kontrol-tunnel.service")), false, "failed install removes the units it added");
    }

    // 11. A systemd-active tunnel whose health endpoint is unreachable
    // degrades status: the MCP channel cannot be operational when its
    // admin surface does not answer.
    {
      const env = gateEnv("status-aux-down");
      const coreServer = createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => coreServer.listen(0, "127.0.0.1", () => resolve()));
      const corePort = (coreServer.address() as { port: number }).port;
      const deadListener = createTcpServer();
      await new Promise<void>((resolve) => deadListener.listen(0, "127.0.0.1", () => resolve()));
      const deadPort = (deadListener.address() as { port: number }).port;
      await new Promise<void>((resolve) => deadListener.close(() => resolve()));
      try {
        mkdirSync(join(gateRoot, "status-aux-down"), { recursive: true });
        writeFileSync(join(gateRoot, "status-aux-down", "environment"), `PORT=${corePort}\n`, { mode: 0o600 });
        writeKontrolConfig({ serviceComponents: [{ name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"], port: deadPort }] }, env);
        const deps: GateDeps = {
          currentArtifactPath: () => freshArtifact,
          requireSystemd: () => undefined,
          systemctl: () => undefined,
          waitForReady: async () => undefined,
          probeUnit: () => "active",
        };
        await runServiceCommand(["install"], env, deps);
        const fixturePaths = servicePaths(env);
        const installed = JSON.parse(readFileSync(fixturePaths.statePath, "utf8")) as { buildId: string; artifactPath: string };
        writeFileSync(join(fixturePaths.stateDir, "server.identity.json"), JSON.stringify({ buildId: installed.buildId, artifactPath: installed.artifactPath }));
        const report = await captureStatus(env, deps);
        assert.match(report, /kontrol service status: DEGRADED/);
        assert.match(report, new RegExp(`MCP channel not operational on 127\\.0\\.0\\.1:${deadPort}`));
      } finally {
        await new Promise<void>((resolve) => coreServer.close(() => resolve()));
      }
    }

    // 12. Full functional readiness through real local endpoints reports
    // READY: live HTTP core plus an operational tunnel MCP channel,
    // identity matched. A merely TCP-reachable tunnel is not enough.
    {
      const env = gateEnv("status-ready");
      const coreServer = createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => coreServer.listen(0, "127.0.0.1", () => resolve()));
      const corePort = (coreServer.address() as { port: number }).port;
      const tunnelServer = createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"channels":[{"name":"main","enabled":true,"probe_status":"ok"}]}');
      });
      await new Promise<void>((resolve) => tunnelServer.listen(0, "127.0.0.1", () => resolve()));
      const tunnelPort = (tunnelServer.address() as { port: number }).port;
      try {
        mkdirSync(join(gateRoot, "status-ready"), { recursive: true });
        writeFileSync(join(gateRoot, "status-ready", "environment"), `PORT=${corePort}\n`, { mode: 0o600 });
        writeKontrolConfig({ serviceComponents: [{ name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"], port: tunnelPort }] }, env);
        const deps: GateDeps = {
          currentArtifactPath: () => freshArtifact,
          requireSystemd: () => undefined,
          systemctl: () => undefined,
          waitForReady: async () => undefined,
          probeUnit: () => "active",
        };
        await runServiceCommand(["install"], env, deps);
        const fixturePaths = servicePaths(env);
        const installed = JSON.parse(readFileSync(fixturePaths.statePath, "utf8")) as { buildId: string; artifactPath: string };
        writeFileSync(join(fixturePaths.stateDir, "server.identity.json"), JSON.stringify({ buildId: installed.buildId, artifactPath: installed.artifactPath }));
        const report = await captureStatus(env, deps);
        assert.match(report, /kontrol service status: READY/);
        assert.match(report, new RegExp(`readiness port ${corePort} \\(installed environment\\)`));
        assert.match(report, new RegExp(`tunnel \\(kontrol-tunnel\\.service\\): active, tunnel MCP channel operational \\(127\\.0\\.0\\.1:${tunnelPort}\\)`));
      } finally {
        await new Promise<void>((resolve) => coreServer.close(() => resolve()));
        await new Promise<void>((resolve) => tunnelServer.close(() => resolve()));
      }
    }

    // 13. Upgrade removing a member stops its process, drops its enablement,
    // and verifies it is gone; rollback restores the file plus enablement
    // and disables candidate-added members (reboot-persistence).
    {
      const env = gateEnv("member-reconcile");
      writeEnvFile("member-reconcile");
      writeKontrolConfig({ serviceComponents: [
        { name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] },
        { name: "hermes", kind: "adapter", command: ["node", "agent.js"] },
      ] }, env);
      const reconcileArtifact = makeArtifact("reconcile artifact", "build-reconcile", 116, 116);
      const calls: string[] = [];
      const active = new Set<string>();
      let targetStarted = false;
      const enabled = new Set<string>(["kontrol-tunnel.service", "kontrol-hermes.service"]);
      const unitDirOf = (): string => dirname(servicePaths(env).unitPath);
      const deps: GateDeps = {
        currentArtifactPath: () => freshArtifact,
        requireSystemd: () => undefined,
        systemctl: (_paths, args) => {
          const call = args.join(" ");
          calls.push(call);
          if (call === "stop kontrol.target") { targetStarted = false; active.clear(); }
          else if (call === "enable --now kontrol.target") {
            targetStarted = true;
            for (const file of readdirSync(unitDirOf())) {
              if (/^kontrol-.+\.service$/.test(file)) active.add(file);
            }
          } else if (call.startsWith("stop ")) active.delete(call.slice(5));
          else if (call.startsWith("enable ") && !call.includes("--now")) {
            for (const unit of call.slice("enable ".length).split(" ").filter(Boolean)) enabled.add(unit);
          } else if (call.startsWith("disable ")) {
            for (const unit of call.slice("disable ".length).split(" ").filter(Boolean)) enabled.delete(unit);
          }
        },
        waitForReady: async () => undefined,
        probeUnitActive: (unit) => (unit === "kontrol.target" ? targetStarted : active.has(unit)),
        probeUnitEnabled: (unit) => enabled.has(unit),
      };
      await runServiceCommand(["install"], env, deps);
      const hermesBefore = readFileSync(join(unitDirOf(), "kontrol-hermes.service"), "utf8");
      // v2 removes hermes and adds crush; the candidate fails readiness.
      writeKontrolConfig({ serviceComponents: [
        { name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] },
        { name: "crush", kind: "adapter", command: ["node", "crush.js"] },
      ] }, env);
      await assert.rejects(
        () => runServiceCommand(["upgrade"], env, {
          ...deps,
          currentArtifactPath: () => reconcileArtifact,
          waitForReady: async (_paths, state) => {
            if (state.buildId === "build-reconcile") throw new Error("candidate failed");
          },
        }),
        /failed readiness; previous build build-fresh and database were restored/,
      );
      assert.ok(calls.includes("stop kontrol-hermes.service"), `removed member is stopped: ${calls.join(" | ")}`);
      assert.ok(calls.includes("disable kontrol-hermes.service"), `removed member is disabled: ${calls.join(" | ")}`);
      assert.ok(calls.includes("disable kontrol-crush.service"), `candidate-added member is disabled on rollback: ${calls.join(" | ")}`);
      assert.ok(
        calls.includes("enable kontrol-hermes.service kontrol-tunnel.service"),
        `restored members regain enablement on rollback: ${calls.join(" | ")}`,
      );
      assert.equal(readFileSync(join(unitDirOf(), "kontrol-hermes.service"), "utf8"), hermesBefore, "removed member file is restored byte-identical");
      assert.equal(existsSync(join(unitDirOf(), "kontrol-crush.service")), false, "candidate-added member file is gone after rollback");
      assert.deepEqual([...enabled].sort(), ["kontrol-hermes.service", "kontrol-tunnel.service"], "enablement matches the restored membership");
      const restored = JSON.parse(readFileSync(servicePaths(env).statePath, "utf8")) as { buildId: string };
      assert.equal(restored.buildId, "build-fresh", "rejected upgrade keeps the installed build");
    }

    // 14. A removed member that survives its stop fails the upgrade: removal
    // ends stopped, never as a live process behind a deleted file.
    {
      const env = gateEnv("obsolete-survivor");
      writeEnvFile("obsolete-survivor");
      writeKontrolConfig({ serviceComponents: [
        { name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] },
        { name: "hermes", kind: "adapter", command: ["node", "agent.js"] },
      ] }, env);
      const survivorArtifact = makeArtifact("survivor artifact", "build-survivor", 116, 116);
      let targetStarted = false;
      const active = new Set<string>();
      const unitDirOf = (): string => dirname(servicePaths(env).unitPath);
      const deps: GateDeps = {
        currentArtifactPath: () => freshArtifact,
        requireSystemd: () => undefined,
        systemctl: (_paths, args) => {
          const call = args.join(" ");
          if (call === "stop kontrol.target") { targetStarted = false; active.clear(); }
          else if (call === "enable --now kontrol.target") {
            targetStarted = true;
            for (const file of readdirSync(unitDirOf())) {
              if (/^kontrol-.+\.service$/.test(file)) active.add(file);
            }
          }
        },
        waitForReady: async () => undefined,
        // hermes ignores every stop: the process survives its unit removal.
        probeUnitActive: (unit) => (unit === "kontrol-hermes.service" ? true : unit === "kontrol.target" ? targetStarted : active.has(unit)),
        probeUnitEnabled: () => false,
      };
      await runServiceCommand(["install"], env, deps);
      writeKontrolConfig({ serviceComponents: [{ name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] }] }, env);
      const unitDir = dirname(servicePaths(env).unitPath);
      await assert.rejects(
        () => runServiceCommand(["upgrade"], env, { ...deps, currentArtifactPath: () => survivorArtifact }),
        /failed readiness; previous build build-fresh and database were restored \(cause: removed members still active after stop: kontrol-hermes\.service\)/,
        "a surviving obsolete member fails the upgrade instead of orphaning",
      );
      assert.ok(existsSync(join(unitDir, "kontrol-hermes.service")), "rollback restores the removed member file");
      const restored = JSON.parse(readFileSync(servicePaths(env).statePath, "utf8")) as { buildId: string };
      assert.equal(restored.buildId, "build-fresh", "rejected upgrade keeps the installed build");
    }

    // 17. Out-of-band migrated database: when the live schema was already
    // newer than the installed build before the upgrade (migrated by an
    // earlier generation), a failed candidate rolls back files and state
    // without demanding a database restore there is nothing to undo — and
    // leaves the database byte-identical.
    {
      const env = gateEnv("outband-db");
      writeEnvFile("outband-db");
      writeKontrolConfig({ serviceComponents: [
        { name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] },
      ] }, env);
      const staleBuild = makeArtifact("outband stale", "build-outband-stale", 113, 113);
      const candidateBuild = makeArtifact("outband candidate", "build-outband", 116, 116);
      const fixturePaths = servicePaths(env);
      let targetStarted = false;
      const active = new Set<string>();
      const unitDirOf = (): string => dirname(servicePaths(env).unitPath);
      const deps: GateDeps = {
        currentArtifactPath: () => staleBuild,
        requireSystemd: () => undefined,
        systemctl: (_paths, args) => {
          const call = args.join(" ");
          if (call === "stop kontrol.target") { targetStarted = false; active.clear(); }
          else if (call === "enable --now kontrol.target") {
            targetStarted = true;
            for (const file of readdirSync(unitDirOf())) {
              if (/^kontrol-.+\.service$/.test(file)) active.add(file);
            }
          }
        },
        waitForReady: async () => undefined,
        probeUnitActive: (unit) => (unit === "kontrol.target" ? targetStarted : active.has(unit)),
        probeUnitEnabled: () => true,
      };
      await runServiceCommand(["install"], env, deps);
      // The earlier generation migrates the live database past what the
      // installed build can read; the candidate is compatible with it.
      writeRawDb(join(gateRoot, "outband-db", "database state"), 116);
      const dbBefore = readFileSync(join(fixturePaths.stateDir, "kontrol.sqlite"));
      await assert.rejects(
        () => runServiceCommand(["upgrade"], env, {
          ...deps,
          currentArtifactPath: () => candidateBuild,
          waitForReady: async (_paths, state) => {
            if (state.buildId === "build-outband") throw new Error("candidate failed");
          },
        }),
        /failed readiness; previous build build-outband-stale and database were restored/,
        "an untouched newer database does not block rollback",
      );
      assert.deepEqual(readFileSync(join(fixturePaths.stateDir, "kontrol.sqlite")), dbBefore, "rollback leaves the out-of-band database byte-identical");
      const restored = JSON.parse(readFileSync(fixturePaths.statePath, "utf8")) as { buildId: string };
      assert.equal(restored.buildId, "build-outband-stale", "rejected upgrade keeps the installed build");
    }

    // 16. Rollback restores exact prior enablement: a member that was
    // disabled before the upgrade ends disabled even though the candidate
    // enabled it; an unknowable prior is conservatively re-enabled but
    // journaled as unresolved, never silently claimed exact.
    {
      const env = gateEnv("enablement-restore");
      writeEnvFile("enablement-restore");
      writeKontrolConfig({ serviceComponents: [
        { name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] },
        { name: "hermes", kind: "adapter", command: ["node", "agent.js"] },
      ] }, env);
      const enableArtifact = makeArtifact("enable artifact", "build-enable", 116, 116);
      const calls: string[] = [];
      const active = new Set<string>();
      let targetStarted = false;
      // hermes starts persistently disabled; tunnel stays enabled.
      const enabled = new Set<string>(["kontrol-tunnel.service"]);
      const unitDirOf = (): string => dirname(servicePaths(env).unitPath);
      const deps: GateDeps = {
        currentArtifactPath: () => freshArtifact,
        requireSystemd: () => undefined,
        systemctl: (_paths, args) => {
          const call = args.join(" ");
          calls.push(call);
          if (call === "stop kontrol.target") { targetStarted = false; active.clear(); }
          else if (call === "enable --now kontrol.target") {
            targetStarted = true;
            for (const file of readdirSync(unitDirOf())) {
              if (/^kontrol-.+\.service$/.test(file)) active.add(file);
            }
          } else if (call.startsWith("stop ")) active.delete(call.slice(5));
          else if (call.startsWith("enable ") && !call.includes("--now")) {
            for (const unit of call.slice("enable ".length).split(" ").filter(Boolean)) enabled.add(unit);
          } else if (call.startsWith("disable ")) {
            for (const unit of call.slice("disable ".length).split(" ").filter(Boolean)) enabled.delete(unit);
          }
        },
        waitForReady: async () => undefined,
        probeUnitActive: (unit) => (unit === "kontrol.target" ? targetStarted : active.has(unit)),
        // hermes was persistently disabled; tunnel's prior state is unknowable.
        probeUnitEnabled: (unit) => (unit === "kontrol-hermes.service" ? false : null),
      };
      await runServiceCommand(["install"], env, deps);
      await assert.rejects(
        () => runServiceCommand(["upgrade"], env, {
          ...deps,
          currentArtifactPath: () => enableArtifact,
          waitForReady: async (_paths, state) => {
            if (state.buildId === "build-enable") throw new Error("candidate failed");
          },
        }),
        /failed readiness; previous build build-fresh and database were restored/,
      );
      const enableIdx = calls.findIndex((call) => call === "enable kontrol-tunnel.service kontrol-hermes.service");
      const disableIdx = calls.findIndex((call) => call === "disable kontrol-hermes.service");
      assert.ok(enableIdx >= 0 && disableIdx > enableIdx, `disabled member re-disabled after candidate enable: ${calls.join(" | ")}`);
      assert.ok(!enabled.has("kontrol-hermes.service"), "rollback leaves the previously disabled member disabled");
      assert.ok(enabled.has("kontrol-tunnel.service"), "unknown prior is conservatively re-enabled");
      const fixturePaths = servicePaths(env);
      const journals = readdirSync(fixturePaths.stateDir)
        .filter((file) => file.startsWith("deployment.") && file.endsWith(".json"))
        .map((file) => JSON.parse(readFileSync(join(fixturePaths.stateDir, file), "utf8")) as { memberRestore?: unknown });
      const withRestore = journals.filter((journal) => journal.memberRestore !== undefined);
      assert.equal(withRestore.length, 1, "exactly the rollback journal records member restoration");
      assert.deepEqual(withRestore[0].memberRestore, {
        disabled: ["kontrol-hermes.service"],
        enabled: ["kontrol-tunnel.service"],
        unresolved: ["kontrol-tunnel.service"],
      });
    }

    // 15. Readiness is evidence-explicit, never silently fully qualified: a
    // required adapter auxiliary without a port stays READY on systemd
    // state, but the report says its qualification is systemd-only.
    // (Tunnel components always get the HTTP channel probe — default port
    // 8080 when unconfigured — so a tunnel can never be systemd-only.)
    {
      const env = gateEnv("status-state-only");
      const coreServer = createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => coreServer.listen(0, "127.0.0.1", () => resolve()));
      const corePort = (coreServer.address() as { port: number }).port;
      try {
        mkdirSync(join(gateRoot, "status-state-only"), { recursive: true });
        writeFileSync(join(gateRoot, "status-state-only", "environment"), `PORT=${corePort}\n`, { mode: 0o600 });
        writeKontrolConfig({ serviceComponents: [{ name: "cache", kind: "adapter", command: ["node", "agent.js"] }] }, env);
        const deps: GateDeps = {
          currentArtifactPath: () => freshArtifact,
          requireSystemd: () => undefined,
          systemctl: () => undefined,
          waitForReady: async () => undefined,
          probeUnit: () => "active",
        };
        await runServiceCommand(["install"], env, deps);
        const fixturePaths = servicePaths(env);
        const installed = JSON.parse(readFileSync(fixturePaths.statePath, "utf8")) as { buildId: string; artifactPath: string };
        writeFileSync(join(fixturePaths.stateDir, "server.identity.json"), JSON.stringify({ buildId: installed.buildId, artifactPath: installed.artifactPath }));
        const report = await captureStatus(env, deps);
        assert.match(report, /kontrol service status: READY/);
        assert.match(report, /cache \(kontrol-cache\.service\): active, systemd state only; no functional probe configured/);
        assert.match(report, /core readiness verified; all required components active/);
      } finally {
        await new Promise<void>((resolve) => coreServer.close(() => resolve()));
      }
    }

    // 18. Tunnel startup gate fails closed when the core is unavailable:
    // connection refused rejects with the endpoint and the bound.
    {
      const stateDir = join(gateRoot, "gate-down", "state");
      mkdirSync(stateDir, { recursive: true });
      const deadListener = createTcpServer();
      await new Promise<void>((resolve) => deadListener.listen(0, "127.0.0.1", () => resolve()));
      const deadPort = (deadListener.address() as { port: number }).port;
      await new Promise<void>((resolve) => deadListener.close(() => resolve()));
      const started = Date.now();
      await assert.rejects(
        () => waitForCoreReady({ stateDir, port: deadPort, timeoutMs: 200, intervalMs: 10 }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return /core was not ready within 200ms/.test(message)
            && new RegExp(`127\\.0\\.0\\.1:${deadPort}`).test(message);
        },
        "unavailable core rejects with endpoint and bound",
      );
      assert.ok(Date.now() - started < 5_000, "the gate never blocks indefinitely");
    }

    // 19. The gate resolves once the core becomes ready after a delay, and
    // 20. rejects within a finite bound when the core never becomes ready.
    {
      const stateDir = join(gateRoot, "gate-delayed", "state");
      mkdirSync(stateDir, { recursive: true });
      let calls = 0;
      const flakyFetch = (async () => {
        calls += 1;
        if (calls <= 2) throw new Error("connect ECONNREFUSED");
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }) as unknown as typeof fetch;
      await waitForCoreReady({ stateDir, port: 1, fetchImpl: flakyFetch, timeoutMs: 5_000, intervalMs: 5 });
      assert.equal(calls, 3, "the gate polls until the core answers");
      const neverFetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
      const started = Date.now();
      await assert.rejects(
        () => waitForCoreReady({ stateDir, port: 1, fetchImpl: neverFetch, timeoutMs: 150, intervalMs: 5 }),
        /core was not ready within 150ms/,
      );
      assert.ok(Date.now() - started < 5_000, "a never-ready core still fails within a finite bound");
    }

    // 21. The gate requires HTTP 200 + ok=true and the exact expected
    // build: wrong payloads and identity drift fail closed.
    {
      const stateDir = join(gateRoot, "gate-identity", "state");
      mkdirSync(stateDir, { recursive: true });
      const okFetch = (async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response)) as unknown as typeof fetch;
      await waitForCoreReady({ stateDir, port: 1, fetchImpl: okFetch, timeoutMs: 500, intervalMs: 5 });
      const notOkFetch = (async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) } as unknown as Response)) as unknown as typeof fetch;
      await assert.rejects(
        () => waitForCoreReady({ stateDir, port: 1, fetchImpl: notOkFetch, timeoutMs: 100, intervalMs: 5 }),
        /ok !== true/,
        "ok=false never passes the gate",
      );
      writeFileSync(join(stateDir, "server.identity.json"), JSON.stringify({ buildId: "build-other", artifactPath: "/other" }));
      await assert.rejects(
        () => waitForCoreReady({ stateDir, port: 1, fetchImpl: okFetch, timeoutMs: 100, intervalMs: 5, expectedBuildId: "build-expected", expectedArtifactPath: "/expected" }),
        /does not match expected build-expected/,
        "identity drift fails closed",
      );
      writeFileSync(join(stateDir, "server.identity.json"), JSON.stringify({ buildId: "build-expected", artifactPath: "/expected" }));
      await waitForCoreReady({ stateDir, port: 1, fetchImpl: okFetch, timeoutMs: 500, intervalMs: 5, expectedBuildId: "build-expected", expectedArtifactPath: "/expected" });
    }

    // 22. Only tunnel units carry the startup gate: adapters and the core
    // render no ExecStartPre, so no unrelated unit changes behavior.
    {
      const tunnelUnit = renderServiceComponentUnit(
        { name: "t", kind: "tunnel", command: ["tunnel-client", "run"] },
        { artifactPath: "/a", buildId: "b", environmentFile: "/e", workingDirectory: "/w" },
      );
      assert.match(tunnelUnit, /ExecStartPre=\/usr\/bin\/env node "\/a\/cli\.js" service wait-core-ready --timeout-ms 60000/);
      const adapterUnit = renderServiceComponentUnit(
        { name: "a", kind: "adapter", command: ["agent"] },
        { artifactPath: "/a", buildId: "b", environmentFile: "/e", workingDirectory: "/w" },
      );
      assert.doesNotMatch(adapterUnit, /ExecStartPre/);
      const coreUnit = renderUserServiceUnit({
        serviceName: "kontrol-core.service",
        artifactPath: "/a",
        buildId: "b",
        schemaVersion: 1,
        maxReadableSchemaVersion: 1,
        deploymentId: "d",
        stateDir: "/s",
        environmentFile: "/e",
        workingDirectory: "/w",
      });
      assert.doesNotMatch(coreUnit, /ExecStartPre/);
      assert.match(coreUnit, /PartOf=kontrol\.target/);
    }

    // 23. wait-core-ready classifies identity on flags, not environment:
    // a systemd unit exports KONTROL_EXPECTED_BUILD_ID without flags, so
    // the gate must use the installed service, not demand --artifact-path.
    // A partial explicit identity (one flag only) still fails closed.
    {
      const env = gateEnv("wait-core-ready-env-identity");
      const coreServer = createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => coreServer.listen(0, "127.0.0.1", () => resolve()));
      const corePort = (coreServer.address() as { port: number }).port;
      try {
        mkdirSync(join(gateRoot, "wait-core-ready-env-identity"), { recursive: true });
        writeFileSync(join(gateRoot, "wait-core-ready-env-identity", "environment"), `PORT=${corePort}\n`, { mode: 0o600 });
        writeKontrolConfig({ serviceComponents: [{ name: "cache", kind: "adapter", command: ["node", "agent.js"] }] }, env);
        const deps: GateDeps = {
          currentArtifactPath: () => freshArtifact,
          requireSystemd: () => undefined,
          systemctl: () => undefined,
          waitForReady: async () => undefined,
          probeUnit: () => "active",
        };
        await runServiceCommand(["install"], env, deps);
        const fixturePaths = servicePaths(env);
        const installed = JSON.parse(readFileSync(fixturePaths.statePath, "utf8")) as { buildId: string; artifactPath: string };
        writeFileSync(join(fixturePaths.stateDir, "server.identity.json"), JSON.stringify({ buildId: installed.buildId, artifactPath: installed.artifactPath }));
        // Environment-only identity (what a systemd component unit exports):
        // no flags, so the installed-service path is used and the gate passes.
        await runServiceCommand(["wait-core-ready", "--timeout-ms", "5000"], { ...env, KONTROL_EXPECTED_BUILD_ID: installed.buildId }, deps);
        // One explicit flag without its pair still fails closed.
        await assert.rejects(
          () => runServiceCommand(["wait-core-ready", "--timeout-ms", "5000", "--expected-build-id", installed.buildId], env, deps),
          /requires --expected-build-id and --artifact-path/,
        );
      } finally {
        await new Promise<void>((resolve) => coreServer.close(() => resolve()));
      }
    }

    // 22b. The channel probe parses the live /api/status shape: an enabled
    // main channel with a non-failed probe is operational; a disabled or
    // failed one is not; transport failures are unreachable, never healthy.
    {
      const body = (payload: unknown) => ({
        ok: true,
        status: 200,
        json: async () => payload,
      }) as unknown as Response;
      const fetchOf = (payload: unknown) => (async () => body(payload)) as unknown as typeof fetch;
      const liveDisabled = await probeTunnelChannel(1, fetchOf({
        channels: [{ name: "main", enabled: false, server_kind: "external", transport_kind: "http-streamable", probe_status: "failed", probe_error: "dial tcp: connection refused", reason: "initial mcp probe failed" }],
      }));
      assert.equal(liveDisabled.reachable, true);
      assert.equal(liveDisabled.operational, false);
      assert.equal(liveDisabled.mainEnabled, false);
      assert.equal(liveDisabled.probeStatus, "failed");
      assert.match(liveDisabled.detail ?? "", /main\.enabled=false/);
      const liveEnabled = await probeTunnelChannel(1, fetchOf({ channels: [{ name: "main", enabled: true, probe_status: "ok" }] }));
      assert.equal(liveEnabled.operational, true);
      const unreachable = await probeTunnelChannel(1, (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch);
      assert.equal(unreachable.reachable, false);
      assert.equal(unreachable.operational, undefined);
      const nonJson = await probeTunnelChannel(1, (async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })) as unknown as typeof fetch);
      assert.equal(nonJson.reachable, true);
      assert.equal(nonJson.operational, false);
    }

    // 23. Status distinguishes the layers: core ready, tunnel process
    // alive, but the MCP channel disabled reports DEGRADED (never READY)
    // with the channel — not the process — named as the failure.
    {
      const env = gateEnv("status-channel-down");
      const coreServer = createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => coreServer.listen(0, "127.0.0.1", () => resolve()));
      const corePort = (coreServer.address() as { port: number }).port;
      try {
        mkdirSync(join(gateRoot, "status-channel-down"), { recursive: true });
        writeFileSync(join(gateRoot, "status-channel-down", "environment"), `PORT=${corePort}\n`, { mode: 0o600 });
        writeKontrolConfig({ serviceComponents: [{ name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] }] }, env);
        const deps: GateDeps = {
          currentArtifactPath: () => freshArtifact,
          requireSystemd: () => undefined,
          systemctl: () => undefined,
          waitForReady: async () => undefined,
          probeUnit: () => "active",
          probeTunnelChannel: async () => ({
            reachable: true,
            operational: false,
            mainEnabled: false,
            probeStatus: "failed",
            detail: "main.enabled=false probe_status=failed reason=initial mcp probe failed",
          }),
        };
        await runServiceCommand(["install"], env, deps);
        const fixturePaths = servicePaths(env);
        const installed = JSON.parse(readFileSync(fixturePaths.statePath, "utf8")) as { buildId: string; artifactPath: string };
        writeFileSync(join(fixturePaths.stateDir, "server.identity.json"), JSON.stringify({ buildId: installed.buildId, artifactPath: installed.artifactPath }));
        const report = await captureStatus(env, deps);
        assert.match(report, /kontrol service status: DEGRADED/);
        assert.doesNotMatch(report, /kontrol service status: READY/);
        assert.match(report, /MCP channel not operational/);
        assert.match(report, /main\.enabled=false/);
        assert.doesNotMatch(report, /has not confirmed/, "core readiness itself is verified; only the channel failed");
      } finally {
        await new Promise<void>((resolve) => coreServer.close(() => resolve()));
      }
    }

    // 24. Recovery restarts only the tunnel unit when the core is ready
    // but the channel is disabled: exactly one restart, core and adapters
    // untouched, unit/environment bytes and reviewer header preserved.
    {
      const env = gateEnv("recover-once");
      const coreServer = createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => coreServer.listen(0, "127.0.0.1", () => resolve()));
      const corePort = (coreServer.address() as { port: number }).port;
      try {
        mkdirSync(join(gateRoot, "recover-once"), { recursive: true });
        writeFileSync(join(gateRoot, "recover-once", "environment"), `PORT=${corePort}\n`, { mode: 0o600 });
        writeKontrolConfig({
          serviceComponents: [
            { name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run", "--mcp.extra-headers", "X-Kontrol-Tunnel-Reviewer: env:KONTROL_ACP_REVIEWER_SECRET"] },
            { name: "cache", kind: "adapter", command: ["node", "agent.js"] },
          ],
        }, env);
        const systemctlCalls: string[][] = [];
        const deps: GateDeps = {
          currentArtifactPath: () => freshArtifact,
          requireSystemd: () => undefined,
          systemctl: (_paths, args) => { systemctlCalls.push(args); },
          waitForReady: async () => undefined,
          probeUnit: () => "active",
        };
        await runServiceCommand(["install"], env, deps);
        const fixturePaths = servicePaths(env);
        const installed = JSON.parse(readFileSync(fixturePaths.statePath, "utf8")) as { buildId: string; artifactPath: string };
        writeFileSync(join(fixturePaths.stateDir, "server.identity.json"), JSON.stringify({ buildId: installed.buildId, artifactPath: installed.artifactPath }));
        const unitDir = dirname(fixturePaths.unitPath);
        const before = new Map<string, string>();
        for (const file of [fixturePaths.unitPath, join(unitDir, "kontrol-tunnel.service"), join(unitDir, "kontrol-cache.service"), join(gateRoot, "recover-once", "environment")]) {
          before.set(file, readFileSync(file, "utf8"));
        }
        assert.match(before.get(join(unitDir, "kontrol-tunnel.service")) ?? "", /X-Kontrol-Tunnel-Reviewer/, "reviewer assertion is installed inline");
        const observedPorts: number[] = [];
        let channelCalls = 0;
        systemctlCalls.length = 0;
        const result = await recoverTunnel(servicePaths(env), deps, env, {
          settleTimeoutMs: 2_000,
          settleIntervalMs: 5,
          probeChannel: async (healthPort: number) => {
            observedPorts.push(healthPort);
            channelCalls += 1;
            return channelCalls === 1
              ? { reachable: true, operational: false, mainEnabled: false, probeStatus: "failed", detail: "main.enabled=false probe_status=failed" }
              : { reachable: true, operational: true, mainEnabled: true, probeStatus: "ok", detail: "main channel enabled (probe ok)" };
          },
        });
        assert.equal(result.outcome, "recovered");
        assert.equal(result.restartedUnit, "kontrol-tunnel.service");
        assert.deepEqual(systemctlCalls, [["restart", "kontrol-tunnel.service"]], "exactly one restart, core and adapters never addressed");
        assert.deepEqual(observedPorts, [8080, 8080], "tunnel without an explicit port probes the default health port");
        for (const [file, bytes] of before) {
          assert.equal(readFileSync(file, "utf8"), bytes, `recovery rewrites no files: ${file}`);
        }
        assert.match(readFileSync(join(unitDir, "kontrol-tunnel.service"), "utf8"), /X-Kontrol-Tunnel-Reviewer/, "reviewer authorization survives recovery");
      } finally {
        await new Promise<void>((resolve) => coreServer.close(() => resolve()));
      }
    }

    // 25. Recovery leaves the tunnel untouched while the core is down, and
    // recovers once the core returns: no restart storm during an outage.
    {
      const env = gateEnv("recover-core-down");
      const deadListener = createTcpServer();
      await new Promise<void>((resolve) => deadListener.listen(0, "127.0.0.1", () => resolve()));
      const corePort = (deadListener.address() as { port: number }).port;
      await new Promise<void>((resolve) => deadListener.close(() => resolve()));
      mkdirSync(join(gateRoot, "recover-core-down"), { recursive: true });
      writeFileSync(join(gateRoot, "recover-core-down", "environment"), `PORT=${corePort}\n`, { mode: 0o600 });
      writeKontrolConfig({ serviceComponents: [{ name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] }] }, env);
      const systemctlCalls: string[][] = [];
      const deps: GateDeps = {
        currentArtifactPath: () => freshArtifact,
        requireSystemd: () => undefined,
        systemctl: (_paths, args) => { systemctlCalls.push(args); },
        waitForReady: async () => undefined,
        probeUnit: () => "active",
      };
      await runServiceCommand(["install"], env, deps);
      const fixturePaths = servicePaths(env);
      const installed = JSON.parse(readFileSync(fixturePaths.statePath, "utf8")) as { buildId: string; artifactPath: string };
      writeFileSync(join(fixturePaths.stateDir, "server.identity.json"), JSON.stringify({ buildId: installed.buildId, artifactPath: installed.artifactPath }));
      systemctlCalls.length = 0;
      const disabled = { reachable: true, operational: false, mainEnabled: false, probeStatus: "failed", detail: "main.enabled=false" };
      const down = await recoverTunnel(servicePaths(env), deps, env, { probeChannel: async () => disabled });
      assert.equal(down.outcome, "core-not-ready");
      assert.deepEqual(systemctlCalls, [], "no restart while the core is down");
      const coreServer = createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => coreServer.listen(corePort, "127.0.0.1", () => resolve()));
      try {
        let channelCalls = 0;
        const up = await recoverTunnel(servicePaths(env), deps, env, {
          settleTimeoutMs: 2_000,
          settleIntervalMs: 5,
          probeChannel: async () => {
            channelCalls += 1;
            return channelCalls === 1 ? disabled : { reachable: true, operational: true, detail: "main channel enabled (probe ok)" };
          },
        });
        assert.equal(up.outcome, "recovered");
        assert.deepEqual(systemctlCalls, [["restart", "kontrol-tunnel.service"]]);
      } finally {
        await new Promise<void>((resolve) => coreServer.close(() => resolve()));
      }
    }

    // 26. Recovery refuses to restart once the attempt budget is spent
    // inside the window: bounded backoff, no restart storm.
    {
      const env = gateEnv("recover-budget");
      const coreServer = createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => coreServer.listen(0, "127.0.0.1", () => resolve()));
      const corePort = (coreServer.address() as { port: number }).port;
      try {
        mkdirSync(join(gateRoot, "recover-budget"), { recursive: true });
        writeFileSync(join(gateRoot, "recover-budget", "environment"), `PORT=${corePort}\n`, { mode: 0o600 });
        writeKontrolConfig({ serviceComponents: [{ name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] }] }, env);
        const systemctlCalls: string[][] = [];
        const deps: GateDeps = {
          currentArtifactPath: () => freshArtifact,
          requireSystemd: () => undefined,
          systemctl: (_paths, args) => { systemctlCalls.push(args); },
          waitForReady: async () => undefined,
          probeUnit: () => "active",
        };
        await runServiceCommand(["install"], env, deps);
        const fixturePaths = servicePaths(env);
        const installed = JSON.parse(readFileSync(fixturePaths.statePath, "utf8")) as { buildId: string; artifactPath: string };
        writeFileSync(join(fixturePaths.stateDir, "server.identity.json"), JSON.stringify({ buildId: installed.buildId, artifactPath: installed.artifactPath }));
        systemctlCalls.length = 0;
        const now = Date.now();
        writeFileSync(
          join(fixturePaths.stateDir, "tunnel-recovery.json"),
          JSON.stringify({ attempts: [now, now - 60_000, now - 120_000].map((stamp) => new Date(stamp).toISOString()) }),
        );
        await assert.rejects(
          () => recoverTunnel(servicePaths(env), deps, env, {
            probeChannel: async () => ({ reachable: true, operational: false, detail: "still down" }),
          }),
          /recovery budget exhausted/,
        );
        assert.deepEqual(systemctlCalls, [], "exhausted budget performs no restart");
      } finally {
        await new Promise<void>((resolve) => coreServer.close(() => resolve()));
      }
    }

    // 27. An observed healthy channel clears the attempt journal, and
    // 28. recovery with no tunnel configured is a no-op without restarts.
    {
      const env = gateEnv("recover-reset");
      const coreServer = createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => coreServer.listen(0, "127.0.0.1", () => resolve()));
      const corePort = (coreServer.address() as { port: number }).port;
      try {
        mkdirSync(join(gateRoot, "recover-reset"), { recursive: true });
        writeFileSync(join(gateRoot, "recover-reset", "environment"), `PORT=${corePort}\n`, { mode: 0o600 });
        writeKontrolConfig({ serviceComponents: [{ name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] }] }, env);
        const systemctlCalls: string[][] = [];
        const deps: GateDeps = {
          currentArtifactPath: () => freshArtifact,
          requireSystemd: () => undefined,
          systemctl: (_paths, args) => { systemctlCalls.push(args); },
          waitForReady: async () => undefined,
          probeUnit: () => "active",
        };
        await runServiceCommand(["install"], env, deps);
        const fixturePaths = servicePaths(env);
        const installed = JSON.parse(readFileSync(fixturePaths.statePath, "utf8")) as { buildId: string; artifactPath: string };
        writeFileSync(join(fixturePaths.stateDir, "server.identity.json"), JSON.stringify({ buildId: installed.buildId, artifactPath: installed.artifactPath }));
        systemctlCalls.length = 0;
        writeFileSync(join(fixturePaths.stateDir, "tunnel-recovery.json"), JSON.stringify({ attempts: [new Date().toISOString()] }));
        const reset = await recoverTunnel(servicePaths(env), deps, env, {
          probeChannel: async () => ({ reachable: true, operational: true, detail: "main channel enabled (probe ok)" }),
        });
        assert.equal(reset.outcome, "already-operational");
        assert.deepEqual(JSON.parse(readFileSync(join(fixturePaths.stateDir, "tunnel-recovery.json"), "utf8")), { attempts: [] });
        assert.deepEqual(systemctlCalls, [], "a healthy channel needs no restart");
      } finally {
        await new Promise<void>((resolve) => coreServer.close(() => resolve()));
      }
      const bareEnv = gateEnv("recover-no-tunnel");
      mkdirSync(join(gateRoot, "recover-no-tunnel"), { recursive: true });
      writeFileSync(join(gateRoot, "recover-no-tunnel", "environment"), "PORT=9\n", { mode: 0o600 });
      writeKontrolConfig({ serviceComponents: [] }, bareEnv);
      const bareCalls: string[][] = [];
      await runServiceCommand(["install"], bareEnv, {
        currentArtifactPath: () => freshArtifact,
        requireSystemd: () => undefined,
        systemctl: (_paths, args) => { bareCalls.push(args); },
        waitForReady: async () => undefined,
      });
      bareCalls.length = 0;
      const noop = await recoverTunnel(servicePaths(bareEnv), {
        requireSystemd: () => undefined,
        systemctl: (_paths, args) => { bareCalls.push(args); },
      }, bareEnv);
      assert.equal(noop.outcome, "already-operational");
      assert.deepEqual(bareCalls, [], "no tunnel means no restart");
    }

    // 29. Recovery serializes on the deployment lock: a live holder fails
    // the second caller closed instead of stacking a second restart.
    {
      const env = gateEnv("recover-locked");
      const coreServer = createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => coreServer.listen(0, "127.0.0.1", () => resolve()));
      const corePort = (coreServer.address() as { port: number }).port;
      try {
        mkdirSync(join(gateRoot, "recover-locked"), { recursive: true });
        writeFileSync(join(gateRoot, "recover-locked", "environment"), `PORT=${corePort}\n`, { mode: 0o600 });
        writeKontrolConfig({ serviceComponents: [{ name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run"] }] }, env);
        const systemctlCalls: string[][] = [];
        const deps: GateDeps = {
          currentArtifactPath: () => freshArtifact,
          requireSystemd: () => undefined,
          systemctl: (_paths, args) => { systemctlCalls.push(args); },
          waitForReady: async () => undefined,
          probeUnit: () => "active",
        };
        await runServiceCommand(["install"], env, deps);
        const fixturePaths = servicePaths(env);
        const installed = JSON.parse(readFileSync(fixturePaths.statePath, "utf8")) as { buildId: string; artifactPath: string };
        writeFileSync(join(fixturePaths.stateDir, "server.identity.json"), JSON.stringify({ buildId: installed.buildId, artifactPath: installed.artifactPath }));
        systemctlCalls.length = 0;
        const held = await acquireDeploymentLock(fixturePaths.stateDir, { operation: "test-holder", deploymentId: "test", pid: process.pid });
        try {
          await assert.rejects(
            () => recoverTunnel(servicePaths(env), deps, env, {
              probeChannel: async () => ({ reachable: true, operational: false, detail: "still down" }),
            }),
            /already in progress/,
          );
          assert.deepEqual(systemctlCalls, [], "a fenced-out recovery performs no restart");
        } finally {
          await releaseDeploymentLock(fixturePaths.stateDir, held.record.token);
        }
      } finally {
        await new Promise<void>((resolve) => coreServer.close(() => resolve()));
      }
    }
  } finally {
    rmSync(gateRoot, { recursive: true, force: true });
  }
}

console.log("service.test.ts: all assertions passed");
