import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync, truncateSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDiskHeadroom, executeReleaseRetentionPlan, planReleaseRetention, verifyReleaseArtifact } from "./release-retention.mjs";

const root = mkdtempSync(join(tmpdir(), "kontrol-release-retention-"));
const releasesRoot = join(root, "releases");
const stateDir = join(root, "state");
mkdirSync(releasesRoot);
mkdirSync(stateDir);

function makeRelease(buildId, { ageMs = 0, corrupt = false } = {}) {
  const path = join(releasesRoot, buildId);
  mkdirSync(path);
  const content = `executable-${buildId}${corrupt ? "-bad" : ""}`;
  writeFileSync(join(path, "cli.js"), content);
  const expectedContent = `executable-${buildId}`;
  const hash = createHash("sha256").update("kontrol-release-format:4\n").update("cli.js").update(expectedContent).digest("hex").slice(0, 16);
  writeFileSync(join(path, "build-meta.json"), JSON.stringify({ buildId, contentSha256: hash }));
  const old = new Date(Date.now() - ageMs);
  utimesSync(path, old, old);
  return path;
}

try {
  const active = makeRelease("active", { ageMs: 90 * 24 * 60 * 60 * 1000 });
  const previous = makeRelease("previous", { ageMs: 90 * 24 * 60 * 60 * 1000 });
  const pending = makeRelease("pending", { ageMs: 90 * 24 * 60 * 60 * 1000 });
  const stale = makeRelease("stale", { ageMs: 90 * 24 * 60 * 60 * 1000 });
  const young = makeRelease("young");
  const corrupt = makeRelease("corrupt", { ageMs: 90 * 24 * 60 * 60 * 1000, corrupt: true });
  writeFileSync(join(stateDir, "generation.json"), JSON.stringify({
    activeArtifactPath: active,
    previousArtifactPath: previous,
    lastKnownGoodArtifactPath: previous,
  }));
  writeFileSync(join(stateDir, "service.json"), JSON.stringify({ artifactPath: active }));
  writeFileSync(join(stateDir, "deployment.inflight.json"), JSON.stringify({
    stage: "activate", previous: { artifactPath: active }, candidate: { artifactPath: pending },
  }));

  assert.equal(verifyReleaseArtifact(stale).ok, true);
  const plan = planReleaseRetention({ releasesRoot, stateDir, now: Date.now(), graceMs: 30 * 24 * 60 * 60 * 1000 });
  const byName = new Map([...plan.retained, ...plan.deletable].map((entry) => [entry.buildId, entry]));
  for (const name of ["active", "previous", "pending", "young", "corrupt"]) {
    assert.equal(byName.get(name)?.action, "retain", `${name} stays protected`);
  }
  assert.equal(byName.get("stale")?.action, "delete", "verified unreferenced old artifact is eligible");
  const dryRun = executeReleaseRetentionPlan(plan);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.deleted.length, 0);
  assert.equal(statSync(stale).isDirectory(), true, "dry-run does not delete artifacts");
  assert.throws(() => executeReleaseRetentionPlan(plan, { apply: true, deploymentLockToken: "test-token-123" }),
    /requires a live deployment lock/);
  assert.equal(statSync(stale).isDirectory(), true, "apply without an owned deployment lock cannot delete");
  writeFileSync(join(stateDir, "deployment.lock"), JSON.stringify({
    token: "test-token-123", pid: process.pid, processStartToken: "started:test", deploymentId: "test",
  }));
  const applied = executeReleaseRetentionPlan(plan, { apply: true, deploymentLockToken: "test-token-123" });
  assert.deepEqual(applied.deleted, [stale]);
  assert.equal(statSync(active).isDirectory(), true);

  writeFileSync(join(stateDir, "deployment.unreadable.json"), "not-json");
  const conservative = planReleaseRetention({ releasesRoot, stateDir, now: Date.now(), graceMs: 0 });
  assert.ok(conservative.retained.every((entry) => entry.reasons.includes("deployment journal state is unreadable")));

  const oldUnreferenced = makeRelease("old-unreferenced", { ageMs: 90 * 24 * 60 * 60 * 1000 });
  const generationRecord = readFileSync(join(stateDir, "generation.json"), "utf8");
  writeFileSync(join(stateDir, "generation.json"), "{truncated");
  const unreadableGeneration = planReleaseRetention({ releasesRoot, stateDir, now: Date.now(), graceMs: 0 });
  assert.ok(unreadableGeneration.retained.every((entry) => entry.reasons.includes("active deployment reference state is unreadable")),
    "an unreadable generation record conservatively protects every release");
  assert.equal(unreadableGeneration.deletable.length, 0);
  writeFileSync(join(stateDir, "generation.json"), generationRecord);

  const serviceRecord = readFileSync(join(stateDir, "service.json"), "utf8");
  writeFileSync(join(stateDir, "service.json"), "not-json");
  const unreadableService = planReleaseRetention({ releasesRoot, stateDir, now: Date.now(), graceMs: 0 });
  assert.ok(unreadableService.retained.every((entry) => entry.reasons.includes("active deployment reference state is unreadable")),
    "an unreadable service record conservatively protects every release");
  assert.equal(unreadableService.deletable.length, 0);
  writeFileSync(join(stateDir, "service.json"), serviceRecord);
  assert.equal(statSync(oldUnreferenced).isDirectory(), true, "planning under unreadable authority never removes an old release");

  const largeState = join(root, "large-state");
  mkdirSync(largeState);
  writeFileSync(join(largeState, "kontrol.sqlite"), "");
  truncateSync(join(largeState, "kontrol.sqlite"), 13 * 1024 * 1024 * 1024);
  const headroom = assertDiskHeadroom({
    path: root,
    requiredBytes: 0,
    stateDir: largeState,
    minimumReserveBytes: 1,
    reserveFraction: 0.05,
  });
  assert.equal(headroom.footprintBytes, 13 * 1024 * 1024 * 1024);
  assert.equal(headroom.reserveBytes, Math.ceil(headroom.footprintBytes * 0.05), "reserve scales with current state footprint");
  assert.throws(() => assertDiskHeadroom({ path: root, requiredBytes: Number.MAX_SAFE_INTEGER, minimumReserveBytes: 1 }), /Insufficient disk headroom/);
  console.log("release-retention.test.mjs: all assertions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
