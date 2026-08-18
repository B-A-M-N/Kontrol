import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createRuntimeIdentity,
  isRuntimeIdentityLive,
  readRuntimeIdentity,
  removeRuntimeIdentity,
} from "./runtime-identity.js";

const stateDir = await mkdtemp(join(tmpdir(), "kontrol-runtime-identity-"));
try {
  const created = createRuntimeIdentity(stateDir, { gitSha: "abc123", gitDirty: 2, version: "test", buildId: "build-test" }, "node kontrol");
  const loaded = readRuntimeIdentity(stateDir);
  assert.deepEqual(loaded, created);
  assert.equal(isRuntimeIdentityLive(created), true, "the identity must match the live process start token");
  assert.equal(removeRuntimeIdentity(stateDir, "wrong-instance"), false, "a different instance cannot remove the identity");
  assert.equal(removeRuntimeIdentity(stateDir, created.instanceId), true);
  assert.equal(readRuntimeIdentity(stateDir), undefined);
  console.log("runtime-identity.test.ts: all assertions passed");
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
