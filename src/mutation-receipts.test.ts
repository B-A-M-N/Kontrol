import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { createMutationReceiptStore, runWithMutationReceipt, type MutationReceiptStore } from "./mutation-receipts.js";

const stateDir = mkdtempSync(join(tmpdir(), "kontrol-mutation-receipts-"));
let database = openDatabase(stateDir);
try {
  let store = createMutationReceiptStore(database);
  let executions = 0;
  const execute = async () => {
    executions += 1;
    return { content: [{ type: "text" as const, text: "committed" }], structuredContent: { executions } };
  };

  const first = await runWithMutationReceipt({
    store,
    principalId: "conversation:test",
    operation: "test_mutation",
    clientMutationId: "mutation-1",
    request: { b: 2, a: 1 },
    execute,
  });
  assert.equal(first.structuredContent.executions, 1);

  const replay = await runWithMutationReceipt({
    store,
    principalId: "conversation:test",
    operation: "test_mutation",
    clientMutationId: "mutation-1",
    request: { a: 1, b: 2 },
    execute,
  });
  assert.deepEqual(replay, first, "canonical request ordering replays the durable result");
  assert.equal(executions, 1, "a response retry does not execute the mutation twice");

  const conflict = await runWithMutationReceipt({
    store,
    principalId: "conversation:test",
    operation: "test_mutation",
    clientMutationId: "mutation-1",
    request: { a: 99 },
    execute,
  });
  assert.equal((conflict as { isError?: boolean }).isError, true, "reusing an ID with different content is rejected");
  assert.equal(executions, 1);

  store.begin({
    principalId: "conversation:test",
    operation: "pending_mutation",
    clientMutationId: "mutation-pending",
    request: { value: true },
  });
  const pending = await runWithMutationReceipt({
    store,
    principalId: "conversation:test",
    operation: "pending_mutation",
    clientMutationId: "mutation-pending",
    request: { value: true },
    execute,
  });
  assert.equal((pending as { isError?: boolean }).isError, true, "an unresolved receipt fails closed instead of replaying the mutation");
  assert.equal(executions, 1);

  let releaseConcurrent!: () => void;
  let concurrentStarted!: () => void;
  const concurrentStartedPromise = new Promise<void>((resolve) => { concurrentStarted = resolve; });
  const concurrentBarrier = new Promise<void>((resolve) => { releaseConcurrent = resolve; });
  let concurrentExecutions = 0;
  const concurrentExecute = async () => {
    concurrentExecutions += 1;
    concurrentStarted();
    await concurrentBarrier;
    return { content: [{ type: "text" as const, text: "concurrent" }] };
  };
  const firstConcurrent = runWithMutationReceipt({
    store,
    principalId: "conversation:test",
    operation: "concurrent_mutation",
    clientMutationId: "mutation-concurrent",
    request: { value: 1 },
    execute: concurrentExecute,
  });
  await concurrentStartedPromise;
  const secondConcurrent = await runWithMutationReceipt({
    store,
    principalId: "conversation:test",
    operation: "concurrent_mutation",
    clientMutationId: "mutation-concurrent",
    request: { value: 1 },
    execute: concurrentExecute,
  });
  assert.equal((secondConcurrent as { isError?: boolean }).isError, true, "a concurrent retry cannot execute a pending mutation");
  releaseConcurrent();
  await firstConcurrent;
  assert.equal(concurrentExecutions, 1);

  let failedExecutions = 0;
  const failed = await runWithMutationReceipt({
    store,
    principalId: "conversation:test",
    operation: "failed_mutation",
    clientMutationId: "mutation-failed",
    request: { value: 1 },
    execute: async () => {
      failedExecutions += 1;
      throw new Error("handler failed");
    },
  });
  assert.equal((failed as { isError?: boolean }).isError, true, "handler errors are durable outcomes");
  const failedReplay = await runWithMutationReceipt({
    store,
    principalId: "conversation:test",
    operation: "failed_mutation",
    clientMutationId: "mutation-failed",
    request: { value: 1 },
    execute: async () => {
      failedExecutions += 1;
      return { content: [{ type: "text" as const, text: "must not execute" }] };
    },
  });
  assert.deepEqual(failedReplay, failed);
  assert.equal(failedExecutions, 1);

  await runWithMutationReceipt({
    store,
    principalId: "conversation:test",
    operation: "corruptible_mutation",
    clientMutationId: "mutation-corrupt",
    request: { value: 1 },
    execute: async () => ({ content: [{ type: "text" as const, text: "stored" }] }),
  });
  database.sqlite.prepare(`update client_mutation_receipts set result_json = ? where client_mutation_id = ?`).run("{not-json", "mutation-corrupt");
  let corruptExecutions = 0;
  const corruptReplay = await runWithMutationReceipt({
    store,
    principalId: "conversation:test",
    operation: "corruptible_mutation",
    clientMutationId: "mutation-corrupt",
    request: { value: 1 },
    execute: async () => {
      corruptExecutions += 1;
      return { content: [{ type: "text" as const, text: "must not execute" }] };
    },
  });
  assert.equal((corruptReplay as { isError?: boolean }).isError, true, "corrupt durable results fail closed");
  assert.equal(corruptExecutions, 0);

  const finalizationFailureStore: MutationReceiptStore = {
    begin: () => ({ kind: "new" }),
    complete: () => { throw new Error("database unavailable"); },
    reconcile: () => ({ deletedCompleted: 0, pendingSample: [], pendingHasMore: false }),
  };
  const finalizationFailure = await runWithMutationReceipt({
    store: finalizationFailureStore,
    principalId: "conversation:test",
    operation: "unfinalized_mutation",
    clientMutationId: "mutation-unfinalized",
    request: { value: 1 },
    execute: async () => ({ content: [{ type: "text" as const, text: "committed" }] }),
  });
  assert.equal((finalizationFailure as { isError?: boolean }).isError, true, "receipt finalization failure is reported as unknown outcome");

  database.close();
  database = openDatabase(stateDir);
  store = createMutationReceiptStore(database);
  const restartReplay = await runWithMutationReceipt({
    store,
    principalId: "conversation:test",
    operation: "test_mutation",
    clientMutationId: "mutation-1",
    request: { a: 1, b: 2 },
    execute: async () => ({ content: [{ type: "text" as const, text: "must not execute" }] }),
  });
  assert.deepEqual(restartReplay, first, "completed receipts survive database restart");
  assert.equal(executions, 1);

  const maintenance = store.reconcile({ retentionMs: 0, now: new Date(Date.now() + 1_000), limit: 10 });
  assert.ok(maintenance.deletedCompleted >= 1, "completed receipts are pruned only by the bounded retention pass");
  assert.ok(maintenance.pendingSample.some((receipt) => receipt.clientMutationId === "mutation-pending"), "pending receipts remain discoverable for reconciliation");

  console.log("mutation-receipts.test.ts: all assertions passed");
} finally {
  database.close();
  rmSync(stateDir, { recursive: true, force: true });
}
