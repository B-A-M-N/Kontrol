import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDeploymentLock,
  assertDeploymentLock,
  deploymentLockPath,
  readDeploymentLock,
  releaseDeploymentLock,
} from "./deployment-lock.js";

const stateDir = await mkdtemp(join(tmpdir(), "kontrol-deployment-lock-"));
try {
  const metadata = { operation: "restart", deploymentId: "deployment-a" };
  const results = await Promise.allSettled([
    acquireDeploymentLock(stateDir, metadata),
    acquireDeploymentLock(stateDir, { ...metadata, deploymentId: "deployment-b" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const winner = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireDeploymentLock>>> => result.status === "fulfilled");
  assert.ok(winner);
  assert.equal(assertDeploymentLock(stateDir, winner.value.record.token).deploymentId, winner.value.record.deploymentId);
  assert.equal(await releaseDeploymentLock(stateDir, winner.value.record.token), true);
  assert.equal(await releaseDeploymentLock(stateDir, winner.value.record.token), false);

  // A stale deployment controller can be recovered, but the lock remains
  // exclusive while the replacement controller is alive.
  await writeFile(deploymentLockPath(stateDir), JSON.stringify({
    token: "stale",
    pid: 999_999_999,
    processStartToken: "proc:stale",
    operation: "restart",
    deploymentId: "stale-deployment",
    startedAt: new Date(0).toISOString(),
  }));
  const recovered = await acquireDeploymentLock(stateDir, { operation: "restart", deploymentId: "recovered" });
  assert.equal(readDeploymentLock(stateDir)?.token, recovered.record.token);
  await releaseDeploymentLock(stateDir, recovered.record.token);

  // Exercise cross-process contention: one deployment controller wins and all
  // other controllers fail before they can mutate candidate or runtime state.
  const children = Array.from({ length: 6 }, (_, index) => {
    const child = spawn(process.execPath, [
      "--import", "tsx", "src/deployment-lock.ts", "acquire",
      "--state-dir", stateDir,
      "--operation", "restart",
      "--deployment-id", `child-${index}`,
      "--pid", String(process.pid),
      "--hold-ms", "500",
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const output = new Promise<string>((resolve) => {
      let text = "";
      child.stdout.on("data", (chunk) => { text += chunk.toString(); });
      child.once("close", () => resolve(text));
    });
    return { child, output };
  });
  const acquired = await Promise.all(children.map((child) => child.output));
  assert.equal(acquired.filter((text) => text.trim().length > 0).length, 1);
  const current = readDeploymentLock(stateDir);
  assert.ok(current);
  await releaseDeploymentLock(stateDir, current.token);
  assert.equal(existsSync(deploymentLockPath(stateDir)), false);
  console.log("deployment-lock.test.ts: all assertions passed");
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
