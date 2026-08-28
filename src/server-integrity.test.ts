import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
import { createRuntimeIdentityRecord, removeRuntimeIdentity, writeRuntimeIdentity } from "./runtime-identity.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-integrity-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-integrity-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-integrity-worktrees-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-integrity-config-"));
const config = loadConfig({
  KONTROL_CONFIG_DIR: configDir,
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  // Database-integrity suite: not exercising the approval boundary.
  KONTROL_POLICY_MODE: "allow",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_DIAGNOSTICS_SECRET: "integrity-test-secret",
});

const previousDelay = process.env.KONTROL_INTEGRITY_TEST_DELAY_MS;
process.env.KONTROL_INTEGRITY_TEST_DELAY_MS = "6000";
const running = createServer(config);
const httpServer = running.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => httpServer.once("listening", resolve));
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const runtimeIdentity = createRuntimeIdentityRecord({}, "server-integrity-test");
writeRuntimeIdentity(stateDir, runtimeIdentity);

try {
  const startedAt = performance.now();
  const [health, coreReady] = await Promise.all([
    fetch(`${baseUrl}/healthz`),
    fetch(`${baseUrl}/core-readyz`),
  ]);
  const elapsedMs = performance.now() - startedAt;
  assert.equal(health.status, 200);
  assert.equal(coreReady.status, 200, await coreReady.clone().text());
  assert.ok(elapsedMs < 1_500, `health/readiness stalled behind diagnostic scan (${Math.round(elapsedMs)}ms)`);
  console.log("server-integrity.test.ts: all assertions passed");
} finally {
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  removeRuntimeIdentity(stateDir, runtimeIdentity.instanceId);
  if (previousDelay === undefined) delete process.env.KONTROL_INTEGRITY_TEST_DELAY_MS;
  else process.env.KONTROL_INTEGRITY_TEST_DELAY_MS = previousDelay;
}
