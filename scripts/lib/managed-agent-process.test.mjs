import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteJson,
  processAlive,
  processStartToken,
  readJsonOr,
  reconcileOwnedProcesses,
} from "./managed-agent-process.mjs";

const root = await mkdtemp(join(tmpdir(), "kontrol-managed-agent-process-"));
try {
  const statePath = join(root, "state.json");
  await Promise.all(
    Array.from({ length: 24 }, (_, index) => atomicWriteJson(statePath, { writer: index })),
  );
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(typeof state.writer, "number", "overlapping writes leave valid JSON");
  assert.deepEqual(await readdir(root), ["state.json"], "atomic writes leave no temporary files");

  const ownedPath = join(root, "owned.json");
  await atomicWriteJson(ownedPath, [{ pid: 999_999_999, processStartToken: "proc:never" }]);
  const stale = await reconcileOwnedProcesses(ownedPath, "test");
  assert.equal(stale.terminated, 0, "dead ownership records need no termination");
  assert.deepEqual(await readJsonOr(ownedPath, null), [], "reconciliation clears stale ownership records");

  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    detached: true,
    stdio: "ignore",
  });
  await once(child, "spawn");
  child.unref();
  const pid = child.pid;
  assert.ok(pid && processAlive({ pid, processStartToken: processStartToken(pid) }));
  await atomicWriteJson(ownedPath, [{ pid, processStartToken: processStartToken(pid), remoteRunId: "orphan" }]);
  const reconciled = await reconcileOwnedProcesses(ownedPath, "test");
  assert.equal(reconciled.terminated, 1, "live orphaned children are terminated before readiness");
  assert.equal(processAlive({ pid, processStartToken: processStartToken(pid) }), false, "orphaned child is gone");

  // The detached leader can disappear before reconciliation while a child it
  // spawned remains in the same process group. Reconciliation must inspect and
  // terminate the group, not only the recorded leader PID.
  const descendantPidPath = join(root, "descendant.pid");
  const parent = spawn(process.execPath, ["-e", `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)", ${JSON.stringify(descendantPidPath)}], { stdio: "ignore" }); child.unref();`], {
    detached: true,
    stdio: "ignore",
  });
  await once(parent, "spawn");
  parent.unref();
  const parentPid = parent.pid;
  assert.ok(parentPid, "detached parent must have a PID");
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await access(descendantPidPath); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  const descendantPid = Number(await readFile(descendantPidPath, "utf8"));
  assert.ok(descendantPid > 1, "detached descendant must report its PID");
  await atomicWriteJson(ownedPath, [{ pid: parentPid, processGroupId: parentPid, processStartToken: processStartToken(parentPid), remoteRunId: "orphan-with-descendant" }]);
  const groupReconciled = await reconcileOwnedProcesses(ownedPath, "test");
  assert.equal(groupReconciled.terminated, 1, "orphan process groups are terminated even after leader exit");
  assert.equal(processAlive({ pid: descendantPid, processStartToken: processStartToken(descendantPid) }), false, "orphan descendants are gone");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("managed-agent-process.test.mjs: all assertions passed");
