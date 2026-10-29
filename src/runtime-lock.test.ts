import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRuntimeLock,
  assertRuntimeLock,
  processIsLive,
  processStartToken,
  readRuntimeLock,
  releaseRuntimeLock,
  runtimeLockPath,
  updateRuntimeLock,
} from "./runtime-lock.js";

const stateDir = await mkdtemp(join(tmpdir(), "kontrol-runtime-lock-"));
try {
  if (process.platform === "win32") {
    const shell = spawn("bash", ["-c", "printf '%s\\n' \"$$\"; exec sleep 30"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      const shellPid = await new Promise<number>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => reject(new Error("Git Bash did not report its PID")), 5_000);
        shell.stdout.setEncoding("utf8");
        shell.stdout.on("data", (chunk: string) => {
          output += chunk;
          const match = output.match(/^(\d+)\r?\n/);
          if (!match) return;
          clearTimeout(timeout);
          resolve(Number(match[1]));
        });
        shell.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      assert.equal(
        processIsLive(shellPid),
        true,
        `a live Git Bash $$ PID (${shellPid}) must be recognized by the runtime lock`,
      );
    } finally {
      shell.kill("SIGTERM");
      await new Promise<void>((resolve) => shell.once("close", () => resolve()));
    }
  }

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
    const barrierPath = join(stateDir, `contenders-ready-${round}`);
    const children = Array.from({ length: 6 }, (_, index) => {
      const child = spawn(process.execPath, [
        "--import", "tsx", "--input-type=module", "-e",
        `import { access } from "node:fs/promises";
         import { setTimeout as delay } from "node:timers/promises";
         import { acquireRuntimeLock } from "./src/runtime-lock.ts";
         const [stateDir, generationId, barrierPath] = process.argv.slice(1);
         process.stdout.write("ready\\n");
         while (true) { try { await access(barrierPath); break; } catch { await delay(10); } }
         await acquireRuntimeLock(stateDir, {
           launcher: "serve", generationId, buildId: generationId,
           artifactPath: "/releases/" + generationId, port: 7676,
         });
         process.stdout.write("acquired\\n");
         await delay(10000);`,
        stateDir,
        `child-${round}-${index}`,
        barrierPath,
      ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      const lines = createInterface({ input: child.stdout });
      const ready = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("runtime lock contender did not reach the arbitration barrier")), 30_000);
        lines.on("line", (line) => {
          if (line !== "ready") return;
          clearTimeout(timeout);
          resolve(child.pid!);
        });
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timeout);
          if (code !== 0) reject(new Error(`runtime lock contender exited before arbitration (status ${code})`));
        });
      });
      const acquired = new Promise<number>((resolve) => {
        lines.on("line", (line) => { if (line === "acquired") resolve(child.pid!); });
      });
      const done = new Promise<{ pid: number; code: number | null }>((resolve) => {
        child.once("close", (code) => {
          lines.close();
          resolve({ pid: child.pid!, code });
        });
      });
      return { child, ready, acquired, done };
    });
    try {
      await Promise.all(children.map((child) => child.ready));
      await writeFile(barrierPath, "start all contenders together");
      const first = await Promise.race(children.map((child) => child.acquired));
      const current = readRuntimeLock(stateDir);
      assert.ok(current, "winner lock remains durable while its owner is alive");
      assert.ok(children.some((child) => child.child.pid === current.launcherPid), "lock PID belongs to a contender");
      assert.equal(first, current.launcherPid, "the observed winner matches the durable lock owner");
      if (process.platform === "linux") {
        assert.equal(processStartToken(current.launcherPid), current.launcherStartToken, "winner start token is authoritative");
      } else {
        assert.match(current.launcherStartToken, /^started:/, "non-Linux platforms use PID liveness without a /proc start token");
      }
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
