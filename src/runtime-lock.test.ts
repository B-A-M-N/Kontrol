import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRuntimeLock,
  assertRuntimeLock,
  processStartToken,
  readRuntimeLock,
  releaseRuntimeLock,
  runtimeLockPath,
  updateRuntimeLock,
} from "./runtime-lock.js";

const stateDir = await mkdtemp(join(tmpdir(), "kontrol-runtime-lock-"));
try {
  const metadata = {
    launcher: "serve" as const,
    generationId: "generation-a",
    buildId: "build-a",
    artifactPath: "/releases/build-a",
    port: 7676,
  };
  const results = await Promise.allSettled([
    acquireRuntimeLock(stateDir, metadata),
    acquireRuntimeLock(stateDir, { ...metadata, generationId: "generation-b", buildId: "build-b" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const winner = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireRuntimeLock>>> => result.status === "fulfilled");
  assert.ok(winner);
  assert.equal(assertRuntimeLock(stateDir, winner.value.record.lockToken).generationId, winner.value.record.generationId);

  const handedOff = await updateRuntimeLock(stateDir, winner.value.record.lockToken, { launcherPid: process.pid });
  assert.equal(handedOff.generationId, winner.value.record.generationId);
  assert.equal(handedOff.buildId, winner.value.record.buildId);
  assert.equal(handedOff.artifactPath, winner.value.record.artifactPath);

  await writeFile(join(stateDir, "runtime.lock"), JSON.stringify({
    ...handedOff,
    lockToken: "stale-token",
    launcherPid: process.pid,
    launcherStartToken: "proc:not-the-current-start-token",
  }));
  const recovered = await acquireRuntimeLock(stateDir, { ...metadata, generationId: "generation-recovered" });
  assert.equal(recovered.record.generationId, "generation-recovered");
  assert.equal(processStartToken(process.pid).startsWith("proc:"), process.platform === "linux");
  assert.equal(await releaseRuntimeLock(recovered), true);
  assert.equal(await releaseRuntimeLock(recovered), false);

  // Exercise stale takeover with real OS processes. In-process Promise
  // concurrency is insufficient here because the critical fs operations are
  // synchronous and cannot expose a cross-process arbitration race.
  for (let round = 0; round < 3; round += 1) {
    await writeFile(runtimeLockPath(stateDir), JSON.stringify({
      ...metadata,
      lockToken: `stale-${round}`,
      launcherPid: 999_999_999,
      launcherStartToken: "proc:stale",
    }));
    const children = Array.from({ length: 6 }, (_, index) => {
      const child = spawn(process.execPath, [
        "--import", "tsx", "src/runtime-lock.ts", "acquire",
        "--state-dir", stateDir,
        "--launcher", "serve",
        "--generation-id", `child-${round}-${index}`,
        "--build-id", `build-${round}-${index}`,
        "--artifact-path", `/releases/child-${round}-${index}`,
        "--port", "7676",
        "--hold-ms", "1500",
      ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      const firstResult = new Promise<{ pid: number; acquired: boolean }>((resolve) => {
        let settled = false;
        const settle = (result: { pid: number; acquired: boolean }) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        child.stdout.on("data", () => settle({ pid: child.pid!, acquired: true }));
        child.once("close", () => settle({ pid: child.pid!, acquired: false }));
      });
      const done = new Promise<{ pid: number; code: number | null }>((resolve) => {
        child.once("close", (code) => resolve({ pid: child.pid!, code }));
      });
      return { child, firstResult, done };
    });
    try {
      const firstResults = await Promise.all(children.map((child) => child.firstResult));
      const first = firstResults.find((result) => result.acquired);
      assert.ok(first, "one child must acquire the stale lock");
      const current = readRuntimeLock(stateDir);
      assert.ok(current, "winner lock remains durable while its owner is alive");
      assert.ok(children.some((child) => child.child.pid === current.launcherPid), "lock PID belongs to a contender");
      assert.equal(processStartToken(current.launcherPid), current.launcherStartToken, "winner start token is authoritative");
      const results = await Promise.all(children.map((child) => child.done));
      assert.equal(results.filter((result) => result.code === 0).length, 1, "exactly one real child wins stale takeover");
      assert.ok(readRuntimeLock(stateDir), "winner lock still exists after the winner exits");
      await releaseRuntimeLock({ path: runtimeLockPath(stateDir), record: current });
    } finally {
      for (const child of children) child.child.kill("SIGTERM");
    }
  }
  console.log("runtime-lock.test.ts: all assertions passed");
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
