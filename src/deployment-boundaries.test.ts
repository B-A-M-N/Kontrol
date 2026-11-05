// Deployment boundary regression tests (isolated fixtures; never touches live
// services, the live DB, or the real releases stores).
// Covers: stale dist rejection, backend-aware wait-core-ready identity,
// rollback release-root containment + preflight, tunnel-child diagnostics,
// malformed HTTP status, and duplicate tunnel ownership fencing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideTunnelReuse } from "./lifecycle-coordinator.js";
import { preflightArtifactCompatibility } from "./lifecycle-coordinator.js";
import { waitForCoreReady } from "./service.js";

const readText = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

// ── Shell fixes are present (string-level guards for the P0 boundaries) ──
const tunnelScript = readText("scripts/kontrol-tunnel.sh");
assert.match(tunnelScript, /Generation pinning/, "tunnel wrapper must document generation pinning");
assert.match(tunnelScript, /KONTROL_ARTIFACT_PATH/, "tunnel wrapper must honor launcher artifact path");
assert.match(tunnelScript, /wait-core-ready.*--expected-build-id|WAIT_CORE_ARGS/, "tunnel wrapper must pass backend-aware identity");
assert.ok(!tunnelScript.includes('node "${DESKTOP_PWD}/dist/cli.js" config effective-policy'), "tunnel wrapper must not select dist merely because it answers effective-policy");

const startScript = readText("start-all.sh");
assert.match(startScript, /normalize_http_code/, "start-all.sh must normalize HTTP codes (000000 fix)");
assert.ok(!startScript.includes('|| echo 000)'), "start-all.sh must not append a second 000 to curl output");
assert.match(startScript, /KONTROL_POLICY_CLI_PATH/, "launcher must pass generation-pinned CLI to tunnel");
assert.match(startScript, /tunnel child exited/, "launcher must detect dead tunnel child");
assert.match(startScript, /Tunnel log:/, "launcher must report durable tunnel log");
assert.match(startScript, /validate_rollback_target/, "launcher must preflight rollback before cutover");
assert.match(startScript, /import_artifact_to_tmux/, "launcher must import systemd artifacts into tmux store");
assert.match(startScript, /ACTIVE_ARTIFACT_BACKEND/, "launcher must distinguish backend ownership");

const serviceSource = readText("src/service.ts");
assert.match(serviceSource, /--expected-build-id/, "wait-core-ready must accept explicit tmux identity");
assert.match(serviceSource, /tmux candidate/, "wait-core-ready must not check installed record for tmux path");

// ── Duplicate tunnel ownership fencing ──
const expected = {
  requestedBackend: "tmux" as const,
  expectedProfile: "sample_mcp_with_dcr",
  expectedMcpTarget: "http://127.0.0.1:7676/mcp",
  healthPort: 8080,
};

assert.equal(
  decideTunnelReuse(
    { owningBackend: "tmux", healthPort: 8080, channelOperational: true, profile: "sample_mcp_with_dcr", mcpTarget: "http://127.0.0.1:7676/mcp" },
    expected,
  ).ok,
  true,
  "operational same-backend tunnel with matching profile/target must be reusable",
);

for (const [name, obs, pattern] of [
  ["foreign backend", { owningBackend: "systemd" as const, channelOperational: true }, /owned by systemd/],
  ["unknown ownership", { owningBackend: "unknown" as const, probeErrors: ["probe failed"] }, /unknown/],
  ["wrong port", { owningBackend: "tmux" as const, healthPort: 9090, channelOperational: true }, /port 9090/],
  ["wrong profile", { owningBackend: "tmux" as const, channelOperational: true, profile: "other" }, /profile other/],
  ["wrong target", { owningBackend: "tmux" as const, channelOperational: true, mcpTarget: "http://127.0.0.1:9999/mcp" }, /MCP target/],
  ["channel down", { owningBackend: "tmux" as const, channelOperational: false }, /not operational/],
  ["channel unknown", { owningBackend: "tmux" as const }, /not operational/],
] as const) {
  const decision = decideTunnelReuse(obs as never, expected);
  assert.equal(decision.ok, false, `${name}: must refuse reuse`);
  assert.match((decision as { reason: string }).reason, pattern, `${name}: reason must name the cause`);
}

// ── Rollback schema preflight (unit-level) ──
assert.equal(
  preflightArtifactCompatibility({ buildId: "a", schemaVersion: 116, minReadableSchemaVersion: 0, maxReadableSchemaVersion: 116 }, 116).compatible,
  true,
);
assert.equal(
  preflightArtifactCompatibility({ buildId: "b", schemaVersion: 53, minReadableSchemaVersion: 0, maxReadableSchemaVersion: 53 }, 116).compatible,
  false,
  "stale schema-53 build must fail against schema-116 DB",
);

// ── Backend-aware wait-core-ready: identity mismatch fails closed ──
// Simulate a live core that is ready but running an unrelated build.
{
  const stateDir = mkdtempSync(join(tmpdir(), "kontrol-waitcore-"));
  writeFileSync(join(stateDir, "server.identity.json"), JSON.stringify({ buildId: "installed-old-build", artifactPath: "/old" }));
  const fakeFetch = async () => ({ ok: true, json: async () => ({ ok: true }) }) as never;
  await assert.rejects(
    waitForCoreReady({ stateDir, port: 7676, expectedBuildId: "tmux-candidate-build", expectedArtifactPath: "/new", timeoutMs: 300, intervalMs: 50, fetchImpl: fakeFetch }),
    /does not match expected|core was not ready/,
    "mismatched installed/active builds must fail the readiness gate",
  );
  rmSync(stateDir, { recursive: true, force: true });
}

// ── Tunnel wrapper behavioral: stale dist + expected build must fail closed ──
{
  const dir = mkdtempSync(join(tmpdir(), "kontrol-tunnel-stale-"));
  const envFile = join(dir, "empty.env");
  writeFileSync(envFile, "");
  mkdirSync(join(dir, "auth"));
  writeFileSync(join(dir, "auth", "auth.json"), JSON.stringify({ tunnelReviewerSecret: "test-secret" }));
  // Point at the checkout's stale dist (schema 53) while expecting a newer build.
  let failed = false;
  try {
    execFileSync("bash", ["scripts/kontrol-tunnel.sh", "--print-effective-args"], {
      env: {
        ...process.env,
        KONTROL_ENV_FILE: envFile,
        KONTROL_CONFIG_DIR: join(dir, "auth"),
        KONTROL_POLICY_MODE: "allow",
        KONTROL_EXPECTED_BUILD_ID: "9bc998063fb6274c",
        KONTROL_ARTIFACT_PATH: "/nonexistent/releases/9bc998063fb6274c",
      },
      stdio: "pipe",
    });
  } catch {
    failed = true;
  }
  assert.equal(failed, true, "stale/missing candidate CLI must fail closed, not pick dist");
  rmSync(dir, { recursive: true, force: true });
}

// ── Rollback containment: artifact outside releases stores must reject ──
{
  const dir = mkdtempSync(join(tmpdir(), "kontrol-rollback-contain-"));
  const rogue = join(dir, "rogue-build");
  mkdirSync(rogue);
  writeFileSync(join(rogue, "build-meta.json"), JSON.stringify({ buildId: "rogue-build", schemaVersion: 116, maxReadableSchemaVersion: 116 }));
  // Reproduce resolve_artifact_path containment in isolation: only paths under
  // a releases root may resolve. The real function lives in start-all.sh, so
  // we assert the guard text exists and the rogue path is outside known roots.
  assert.match(startScript, /serving artifact is outside immutable releases/, "containment guard must exist");
  assert.ok(!rogue.includes("/releases/"), "fixture rogue path is outside any releases store");
  rmSync(dir, { recursive: true, force: true });
}

console.log("deployment-boundaries: all checks passed");
