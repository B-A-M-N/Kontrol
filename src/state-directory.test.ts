import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimStateDirectory } from "./state-directory.js";

const dataHome = mkdtempSync(join(tmpdir(), "kontrol-state-test-data-"));
const previousXdg = process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = dataHome;
const prodDir = join(dataHome, "kontrol");
const projectRoot = mkdtempSync(join(tmpdir(), "kontrol-state-test-proj-"));

try {
  // Fresh directory: claim establishes the owner record.
  const fresh = join(tmpdir(), `kontrol-state-fresh-${process.pid}`);
  const record = claimStateDirectory(fresh, { profile: "production", launcherContext: "systemd" });
  assert.equal(record.profile, "production");
  assert.ok(existsSync(join(fresh, "state-owner.json")), "owner record written");
  // Same claim verifies cleanly.
  assert.equal(claimStateDirectory(fresh, { profile: "production", launcherContext: "systemd" }).stateId, record.stateId);
  // Profile mismatch refuses.
  assert.throws(
    () => claimStateDirectory(fresh, { profile: "development", projectRoot, launcherContext: "serve" }),
    /profile mismatch/,
  );

  // A database without an owner record refuses implicit adoption.
  const unowned = mkdtempSync(join(tmpdir(), "kontrol-state-unowned-"));
  writeFileSync(join(unowned, "kontrol.sqlite"), "not a real db");
  assert.throws(
    () => claimStateDirectory(unowned, { profile: "production", launcherContext: "systemd" }),
    /Refusing implicit adoption/,
  );

  // Non-production cannot open the legacy production directory.
  assert.throws(
    () => claimStateDirectory(prodDir, { profile: "development", projectRoot, launcherContext: "serve" }),
    /non-production/,
  );

  // Development claim binds the checkout identity.
  const dev = join(tmpdir(), `kontrol-state-dev-${process.pid}`);
  claimStateDirectory(dev, { profile: "development", projectRoot, launcherContext: "serve" });
  const otherProject = mkdtempSync(join(tmpdir(), "kontrol-state-other-proj-"));
  assert.throws(
    () => claimStateDirectory(dev, { profile: "development", projectRoot: otherProject, launcherContext: "serve" }),
    /different checkout/,
  );
} finally {
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdg;
  rmSync(dataHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
}

console.log("state-directory.test.ts: all assertions passed");
