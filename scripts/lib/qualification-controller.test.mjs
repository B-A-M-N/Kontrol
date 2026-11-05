#!/usr/bin/env node
// Stage 4 focused test: one writer per receipt, stale owners reconciled,
// unsettled phases never left "running".
import assert from "node:assert/strict";
import {
  acquireControllerLease,
  INTERRUPTED,
  reconcilePhases,
  releaseControllerLease,
} from "./qualification-controller.mjs";

function memoryFs(files = {}) {
  return {
    files,
    readFileSync: (path) => {
      if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return files[path];
    },
    writeFileSync: (path, content) => { files[path] = String(content); },
    mkdirSync: () => {},
    rmSync: (path) => { delete files[path]; },
  };
}

// 1. Fresh lease acquires.
{
  const fs = memoryFs();
  const result = acquireControllerLease({
    leasePath: "/r/lease.json", runId: "run-1", receiptPath: "/r/receipt.json", ...fs,
  });
  assert.equal(result.acquired, true);
  assert.equal(result.reconciled, undefined);
  console.log("qualification-controller.test: fresh acquire — ok");
}

// 2. Live plausible owner blocks a second writer.
{
  const fs = memoryFs({ "/r/lease.json": JSON.stringify({ runId: "run-1", pid: 111, receiptPath: "/r/receipt.json" }) });
  const result = acquireControllerLease({
    leasePath: "/r/lease.json", runId: "run-2", receiptPath: "/r/receipt.json", ...fs,
    isPidAlive: () => true,
    readCmdline: () => "node scripts/beta-gate.mjs",
  });
  assert.equal(result.acquired, false);
  assert.ok(result.reason.includes("run-1"));
  assert.ok(result.reason.includes("second writer"));
  console.log("qualification-controller.test: live owner blocks duplicate — ok");
}

// 3. Dead owner → successor reconciles and takes over.
{
  const fs = memoryFs({ "/r/lease.json": JSON.stringify({ runId: "run-1", pid: 111, receiptPath: "/r/receipt.json" }) });
  const result = acquireControllerLease({
    leasePath: "/r/lease.json", runId: "run-2", receiptPath: "/r/receipt.json", ...fs,
    isPidAlive: () => false,
  });
  assert.equal(result.acquired, true);
  assert.equal(result.reconciled?.priorRunId, "run-1");
  assert.equal(JSON.parse(fs.files["/r/lease.json"]).runId, "run-2");
  console.log("qualification-controller.test: dead owner reconciled — ok");
}

// 4. Live pid that is NOT the controller (recycled) → stale, take over.
{
  const fs = memoryFs({ "/r/lease.json": JSON.stringify({ runId: "run-1", pid: 111, receiptPath: "/r/receipt.json" }) });
  const result = acquireControllerLease({
    leasePath: "/r/lease.json", runId: "run-2", receiptPath: "/r/receipt.json", ...fs,
    isPidAlive: () => true,
    readCmdline: () => "postgres: checkpointer",
  });
  assert.equal(result.acquired, true);
  assert.equal(result.reconciled?.priorRunId, "run-1");
  console.log("qualification-controller.test: recycled pid not mistaken for owner — ok");
}

// 5. reconcilePhases converts only "running" → "interrupted", keeps the rest.
{
  const { phases, interruptedCount } = reconcilePhases([
    { id: "a", status: "passed" },
    { id: "b", status: "running", startedAt: "t" },
    { id: "c", status: "failed" },
    { id: "d", status: "running", startedAt: "t" },
  ], "prior owner gone");
  assert.equal(interruptedCount, 2);
  assert.deepEqual(phases.map((p) => p.status), ["passed", INTERRUPTED, "failed", INTERRUPTED]);
  assert.ok(phases[1].reason.includes("prior owner gone"));
  assert.ok(typeof phases[1].finishedAt === "string");
  assert.equal(phases[0].finishedAt, undefined);
  console.log("qualification-controller.test: running phases reconciled — ok");
}

// 6. Only the owner releases its own lease.
{
  const fs = memoryFs({ "/r/lease.json": JSON.stringify({ runId: "run-2", pid: 222 }) });
  releaseControllerLease({ leasePath: "/r/lease.json", runId: "run-1", ...fs });
  assert.ok("/r/lease.json" in fs.files, "stale owner must not remove successor lease");
  releaseControllerLease({ leasePath: "/r/lease.json", runId: "run-2", ...fs });
  assert.ok(!("/r/lease.json" in fs.files), "owner releases its own lease");
  console.log("qualification-controller.test: lease release is owner-scoped — ok");
}

console.log("qualification-controller.test: ALL CHECKS PASSED");
