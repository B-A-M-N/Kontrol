import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteJson,
  prepareOwnedChild,
  processStartToken,
  reconcileOwnedProcesses,
} from "./managed-agent-process.mjs";
import {
  loadAdapterDispatchReceipts,
  reconcileAdapterDispatchReceipts,
  recordAdapterDispatchReceipt,
} from "./adapter-dispatch-receipts.mjs";

const root = await mkdtemp(join(tmpdir(), "kontrol-adapter-launch-recovery-"));
try {
  async function createScenario(name) {
    const marker = join(root, `${name}.started`);
    const receiptsPath = join(root, `${name}.receipts.json`);
    const ownersPath = join(root, `${name}.owners.json`);
    const key = `dispatch-${name}`;
    const remoteRunId = `remote-${name}`;
    const receipts = await loadAdapterDispatchReceipts(receiptsPath);
    await recordAdapterDispatchReceipt(receiptsPath, receipts, key, remoteRunId, "dispatching", {
      launchGateVersion: 1,
    });
    const workerCode = `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "started\\n"); setTimeout(() => {}, 60000)`;
    const gate = await prepareOwnedChild(process.execPath, ["-e", workerCode], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    const owner = {
      remoteRunId,
      dispatchIdempotencyKey: key,
      pid: gate.child.pid,
      processGroupId: gate.child.pid,
      processStartToken: processStartToken(gate.child.pid),
      launchState: "prepared",
    };
    return { gate, key, marker, owner, ownersPath, receipts, receiptsPath, remoteRunId };
  }

  // A crash before creating a wrapper leaves a claim that is provably unstarted.
  const beforeWrapper = await loadAdapterDispatchReceipts(join(root, "before-wrapper.receipts.json"));
  const beforeWrapperPath = join(root, "before-wrapper.receipts.json");
  await recordAdapterDispatchReceipt(beforeWrapperPath, beforeWrapper, "dispatch-before-wrapper", "remote-before-wrapper", "dispatching", {
    launchGateVersion: 1,
  });
  const beforeWrapperOutcomes = await reconcileAdapterDispatchReceipts(beforeWrapperPath, beforeWrapper, []);
  assert.equal(beforeWrapperOutcomes[0].status, "unstarted");
  assert.equal(beforeWrapperOutcomes[0].receipt.authoritativelyUnstarted, true);

  // A prepared wrapper is durably owned but cannot execute before start().
  const prepared = await createScenario("prepared");
  await atomicWriteJson(prepared.ownersPath, [prepared.owner]);
  const preparedExit = once(prepared.gate.child, "exit");
  const preparedOwnership = await reconcileOwnedProcesses(prepared.ownersPath, "launch-recovery-test");
  await preparedExit;
  const preparedOutcomes = await reconcileAdapterDispatchReceipts(
    prepared.receiptsPath,
    await loadAdapterDispatchReceipts(prepared.receiptsPath),
    preparedOwnership.records,
  );
  assert.equal(preparedOutcomes[0].status, "unstarted");
  await assert.rejects(access(prepared.marker), { code: "ENOENT" });

  // If the wrapper exists before its ownership write, closing the parent's pipe
  // still proves that its closed gate never ran the agent.
  const beforeOwnership = await createScenario("before-ownership");
  const beforeOwnershipExit = once(beforeOwnership.gate.child, "exit");
  beforeOwnership.gate.abort();
  await beforeOwnershipExit;
  const beforeOwnershipReceipts = await loadAdapterDispatchReceipts(beforeOwnership.receiptsPath);
  const beforeOwnershipOutcomes = await reconcileAdapterDispatchReceipts(
    beforeOwnership.receiptsPath,
    beforeOwnershipReceipts,
    [],
  );
  assert.equal(beforeOwnershipOutcomes[0].status, "unstarted");
  await assert.rejects(access(beforeOwnership.marker), { code: "ENOENT" });

  // A durable start intent is conservative even if the crash preceded the
  // actual gate signal. Recovery must fail the run rather than replay it.
  const afterStartIntent = await createScenario("after-start-intent");
  afterStartIntent.owner.launchState = "start_requested";
  await atomicWriteJson(afterStartIntent.ownersPath, [afterStartIntent.owner]);
  await recordAdapterDispatchReceipt(afterStartIntent.receiptsPath, afterStartIntent.receipts,
    afterStartIntent.key, afterStartIntent.remoteRunId, "dispatching", { launchState: "start_requested" });
  const intentExit = once(afterStartIntent.gate.child, "exit");
  const intentOwnership = await reconcileOwnedProcesses(afterStartIntent.ownersPath, "launch-recovery-test");
  await intentExit;
  const intentOutcomes = await reconcileAdapterDispatchReceipts(
    afterStartIntent.receiptsPath,
    await loadAdapterDispatchReceipts(afterStartIntent.receiptsPath),
    intentOwnership.records,
  );
  assert.equal(intentOutcomes[0].status, "failed");
  await assert.rejects(access(afterStartIntent.marker), { code: "ENOENT" });

  // A worker can execute before the adapter records accepted/running or returns
  // HTTP 202. The persisted start intent and owner make that outcome failed,
  // never authoritatively unstarted, after restart.
  const afterSpawn = await createScenario("after-spawn");
  afterSpawn.owner.launchState = "start_requested";
  await atomicWriteJson(afterSpawn.ownersPath, [afterSpawn.owner]);
  await recordAdapterDispatchReceipt(afterSpawn.receiptsPath, afterSpawn.receipts,
    afterSpawn.key, afterSpawn.remoteRunId, "dispatching", { launchState: "start_requested" });
  await afterSpawn.gate.start();
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await access(afterSpawn.marker); break; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  assert.equal((await readFile(afterSpawn.marker, "utf8")).trim(), "started");
  const spawnExit = once(afterSpawn.gate.child, "exit");
  const spawnOwnership = await reconcileOwnedProcesses(afterSpawn.ownersPath, "launch-recovery-test");
  await spawnExit;
  const spawnOutcomes = await reconcileAdapterDispatchReceipts(
    afterSpawn.receiptsPath,
    await loadAdapterDispatchReceipts(afterSpawn.receiptsPath),
    spawnOwnership.records,
  );
  assert.equal(spawnOutcomes[0].status, "failed");
  assert.equal((await readFile(afterSpawn.marker, "utf8")).trim().split("\n").length, 1,
    "reconciliation does not launch a second worker after the first executed");

  // The same invariant applies after the accepted receipt is durable but before
  // the caller can receive the adapter's 202 response.
  const beforeResponse = await createScenario("before-response");
  beforeResponse.owner.launchState = "start_requested";
  await atomicWriteJson(beforeResponse.ownersPath, [beforeResponse.owner]);
  await recordAdapterDispatchReceipt(beforeResponse.receiptsPath, beforeResponse.receipts,
    beforeResponse.key, beforeResponse.remoteRunId, "dispatching", { launchState: "start_requested" });
  await beforeResponse.gate.start();
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await access(beforeResponse.marker); break; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  await recordAdapterDispatchReceipt(beforeResponse.receiptsPath, beforeResponse.receipts,
    beforeResponse.key, beforeResponse.remoteRunId, "running", { launchState: "worker_started" });
  const responseExit = once(beforeResponse.gate.child, "exit");
  const responseOwnership = await reconcileOwnedProcesses(beforeResponse.ownersPath, "launch-recovery-test");
  await responseExit;
  const responseOutcomes = await reconcileAdapterDispatchReceipts(
    beforeResponse.receiptsPath,
    await loadAdapterDispatchReceipts(beforeResponse.receiptsPath),
    responseOwnership.records,
  );
  assert.equal(responseOutcomes[0].status, "failed");
  assert.equal((await readFile(beforeResponse.marker, "utf8")).trim().split("\n").length, 1);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("adapter-launch-recovery.test.mjs: all assertions passed");
