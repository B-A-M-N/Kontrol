import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADAPTER_DISPATCH_RECEIPT_MAX_ENTRIES,
  acknowledgeAdapterDispatchReceipt,
  adapterDispatchFingerprint,
  findAdapterDispatchReceipt,
  loadAdapterDispatchReceipts,
  reconcileAdapterDispatchReceipts,
  recordAdapterDispatchReceipt,
} from "./adapter-dispatch-receipts.mjs";

const root = await mkdtemp(join(tmpdir(), "kontrol-adapter-dispatch-receipts-"));
const path = join(root, "dispatch-receipts.json");
try {
  const fingerprintBody = {
    dispatch_idempotency_key: "dispatch-1",
    task: "inspect the release",
    workspace_lease_nonce: "lease-a",
    workspace_lease_expires_at: "2026-10-12T13:00:00.000Z",
    read_only_execution_grant: { signature: "grant-a", issuedAt: 1, expiresAt: 2, networkPolicy: "disabled", workspaceRoot: "/tmp/project" },
  };
  const fingerprint = adapterDispatchFingerprint(fingerprintBody);
  assert.equal(adapterDispatchFingerprint({
    ...fingerprintBody,
    workspace_lease_nonce: "lease-b",
    workspace_lease_expires_at: "2026-10-12T14:00:00.000Z",
    read_only_execution_grant: { signature: "grant-b", issuedAt: 2, expiresAt: 3, networkPolicy: "disabled", workspaceRoot: "/tmp/project" },
  }), fingerprint, "retry identity is stable across refreshed authorization credentials");
  assert.notEqual(adapterDispatchFingerprint({
    ...fingerprintBody,
    read_only_execution_grant: { ...fingerprintBody.read_only_execution_grant, networkPolicy: "host" },
  }), fingerprint, "network authority remains part of durable dispatch identity");
  assert.notEqual(adapterDispatchFingerprint({ ...fingerprintBody, task: "change files" }), fingerprint,
    "task content remains part of the durable dispatch fingerprint");

  const first = await loadAdapterDispatchReceipts(path);
  await recordAdapterDispatchReceipt(path, first, "disp_accept-response-lost", "remote-1", "running", { requestFingerprint: "a".repeat(64) });
  await assert.rejects(
    () => recordAdapterDispatchReceipt(path, first, "disp_accept-response-lost", "remote-replacement", "running", { requestFingerprint: "a".repeat(64) }),
    /dispatch receipt conflict/,
    "one idempotency key cannot be rebound to another remote run",
  );
  await assert.rejects(
    () => recordAdapterDispatchReceipt(path, first, "disp_accept-response-lost", "remote-1", "running", { requestFingerprint: "b".repeat(64) }),
    /request fingerprint conflict/,
    "one idempotency key cannot be reused with different dispatch content",
  );
  await recordAdapterDispatchReceipt(path, first, "disp_accept-response-lost", "remote-1", "completed", { requestFingerprint: "a".repeat(64) });
  const restarted = await loadAdapterDispatchReceipts(path);
  assert.deepEqual(findAdapterDispatchReceipt(restarted, "disp_accept-response-lost"), {
    key: "disp_accept-response-lost",
    remoteRunId: "remote-1",
    status: "completed",
    requestFingerprint: "a".repeat(64),
    createdAt: findAdapterDispatchReceipt(restarted, "disp_accept-response-lost")?.createdAt,
    updatedAt: findAdapterDispatchReceipt(restarted, "disp_accept-response-lost")?.updatedAt,
  });
  assert.equal(findAdapterDispatchReceipt(restarted, "missing"), undefined);

  const launchPath = join(root, "launch-receipts.json");
  const launchReceipts = await loadAdapterDispatchReceipts(launchPath);
  await recordAdapterDispatchReceipt(launchPath, launchReceipts, "pre-wrapper", "remote-pre-wrapper", "dispatching", {
    launchGateVersion: 1,
  });
  await recordAdapterDispatchReceipt(launchPath, launchReceipts, "prepared", "remote-prepared", "dispatching", {
    launchGateVersion: 1,
  });
  await recordAdapterDispatchReceipt(launchPath, launchReceipts, "start-requested", "remote-start-requested", "dispatching", {
    launchGateVersion: 1,
    launchState: "start_requested",
  });
  await recordAdapterDispatchReceipt(launchPath, launchReceipts, "crash-after-start-marker", "remote-after-start-marker", "dispatching", {
    launchGateVersion: 1,
    launchState: "start_requested",
  });
  await recordAdapterDispatchReceipt(launchPath, launchReceipts, "already-running", "remote-running", "running", {
    launchGateVersion: 1,
  });
  await recordAdapterDispatchReceipt(launchPath, launchReceipts, "legacy-uncertain", "remote-legacy", "dispatching", {});
  const recoveredLaunches = await reconcileAdapterDispatchReceipts(launchPath, launchReceipts, [
    { dispatchIdempotencyKey: "prepared", launchState: "prepared" },
    { dispatchIdempotencyKey: "start-requested", launchState: "start_requested" },
  ]);
  assert.deepEqual(recoveredLaunches.map(({ receipt, status }) => [receipt.key, status]), [
    ["pre-wrapper", "unstarted"],
    ["prepared", "unstarted"],
    ["start-requested", "failed"],
    ["crash-after-start-marker", "failed"],
    ["already-running", "failed"],
  ], "recovery distinguishes unopened gates from runs whose start may have reached the worker");
  assert.equal(findAdapterDispatchReceipt(launchReceipts, "pre-wrapper")?.authoritativelyUnstarted, true);
  assert.equal(findAdapterDispatchReceipt(launchReceipts, "legacy-uncertain")?.status, "dispatching",
    "legacy receipts without launch-gate evidence remain uncertain");

  const blockedParent = join(root, "not-a-directory");
  await writeFile(blockedParent, "file");
  const failedWritePath = join(blockedParent, "receipts.json");
  const failedWriteReceipts = await loadAdapterDispatchReceipts(failedWritePath);
  await assert.rejects(recordAdapterDispatchReceipt(failedWritePath, failedWriteReceipts,
    "must-not-stay-in-memory", "remote-memory-rollback", "dispatching"));
  assert.equal(findAdapterDispatchReceipt(failedWriteReceipts, "must-not-stay-in-memory"), undefined,
    "failed durable writes roll back the in-memory receipt projection");

  const concurrentPath = join(root, "concurrent-receipts.json");
  const concurrentReceipts = await loadAdapterDispatchReceipts(concurrentPath);
  const concurrentResults = await Promise.allSettled([
    recordAdapterDispatchReceipt(concurrentPath, concurrentReceipts, "same-key", "remote-a", "dispatching"),
    recordAdapterDispatchReceipt(concurrentPath, concurrentReceipts, "same-key", "remote-b", "dispatching"),
  ]);
  assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1,
    "concurrent claims cannot bind one key to two run identities");
  assert.ok(["remote-a", "remote-b"].includes(findAdapterDispatchReceipt(concurrentReceipts, "same-key")?.remoteRunId));

  const expiredStatusPath = join(root, "old-receipts.json");
  const oldCreatedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
  const recentAcknowledgement = Date.now();
  await writeFile(expiredStatusPath, JSON.stringify([
    { key: "unresolved", remoteRunId: "remote-unresolved", status: "running", createdAt: oldCreatedAt, updatedAt: oldCreatedAt },
    { key: "unacknowledged-terminal", remoteRunId: "remote-terminal", attemptNumber: 1, status: "completed", createdAt: oldCreatedAt, updatedAt: oldCreatedAt },
    { key: "acknowledged-terminal", remoteRunId: "remote-acknowledged", attemptNumber: 1, status: "completed", createdAt: oldCreatedAt, updatedAt: oldCreatedAt, controllerAcknowledgedAt: oldCreatedAt, controllerEventId: "event-old" },
    { key: "recently-acknowledged-terminal", remoteRunId: "remote-recent", attemptNumber: 1, status: "completed", createdAt: oldCreatedAt, updatedAt: recentAcknowledgement, controllerAcknowledgedAt: recentAcknowledgement, controllerEventId: "event-recent" },
  ]));
  const retained = await loadAdapterDispatchReceipts(expiredStatusPath);
  assert.ok(findAdapterDispatchReceipt(retained, "unresolved"), "age alone cannot discard the only mapping for a live or unresolved run");
  assert.ok(findAdapterDispatchReceipt(retained, "unacknowledged-terminal"), "a terminal receipt stays pinned until Kontrol confirms durable outcome persistence");
  assert.equal(findAdapterDispatchReceipt(retained, "acknowledged-terminal"), undefined, "an acknowledged terminal receipt ages out from its controller acknowledgement");
  assert.ok(findAdapterDispatchReceipt(retained, "recently-acknowledged-terminal"), "receipt retention starts when Kontrol acknowledges, not when the worker was launched");

  const acknowledgementPath = join(root, "acknowledgement.json");
  const acknowledgementReceipts = await loadAdapterDispatchReceipts(acknowledgementPath);
  await recordAdapterDispatchReceipt(acknowledgementPath, acknowledgementReceipts, "ack-key", "ack-remote", "completed", { attemptNumber: 3 });
  assert.equal(await acknowledgeAdapterDispatchReceipt(acknowledgementPath, acknowledgementReceipts, {
    dispatchIdempotencyKey: "ack-key", remoteRunId: "ack-remote", attemptNumber: 2, eventId: "ack-event",
  }), false, "stale attempt acknowledgements cannot release receipt retention");
  assert.equal(await acknowledgeAdapterDispatchReceipt(acknowledgementPath, acknowledgementReceipts, {
    dispatchIdempotencyKey: "ack-key", remoteRunId: "different-remote", attemptNumber: 3, eventId: "ack-event",
  }), false, "a mismatched remote run cannot release receipt retention");
  assert.equal(await acknowledgeAdapterDispatchReceipt(acknowledgementPath, acknowledgementReceipts, {
    dispatchIdempotencyKey: "ack-key", remoteRunId: "ack-remote", attemptNumber: 3, eventId: "ack-event",
  }), true, "the exact durable terminal outcome acknowledges its receipt");
  assert.equal(findAdapterDispatchReceipt(acknowledgementReceipts, "ack-key")?.controllerEventId, "ack-event");

  const saturatedTerminal = new Map();
  for (let index = 0; index < ADAPTER_DISPATCH_RECEIPT_MAX_ENTRIES; index += 1) {
    const key = `terminal-unacknowledged-${index}`;
    saturatedTerminal.set(key, { key, remoteRunId: `remote-terminal-${index}`, status: "completed", createdAt: oldCreatedAt });
  }
  await assert.rejects(
    () => recordAdapterDispatchReceipt(join(root, "saturated-terminal.json"), saturatedTerminal, "new-terminal", "remote-new-terminal", "dispatching"),
    (error) => error?.code === "dispatch_receipt_capacity",
    "capacity pressure cannot evict an unacknowledged terminal result",
  );

  const saturatedPath = join(root, "saturated-receipts.json");
  const saturated = new Map();
  for (let index = 0; index < ADAPTER_DISPATCH_RECEIPT_MAX_ENTRIES; index += 1) {
    const key = `unresolved-${index}`;
    saturated.set(key, { key, remoteRunId: `remote-${index}`, status: "running", createdAt: Date.now() });
  }
  await assert.rejects(
    () => recordAdapterDispatchReceipt(saturatedPath, saturated, "new-launch", "remote-new", "dispatching"),
    (error) => error?.code === "dispatch_receipt_capacity" && error?.status === 503,
    "new launches fail closed when unresolved evidence fills the bounded receipt store",
  );
  assert.equal(saturated.has("new-launch"), false, "capacity rejection does not mutate the receipt projection");

  const acknowledgedSaturated = new Map();
  for (let index = 0; index < ADAPTER_DISPATCH_RECEIPT_MAX_ENTRIES; index += 1) {
    const key = `acknowledged-${index}`;
    acknowledgedSaturated.set(key, {
      key,
      remoteRunId: `remote-acknowledged-${index}`,
      status: "completed",
      createdAt: Date.now(),
      controllerAcknowledgedAt: Date.now() - index,
    });
  }
  const acknowledgedSaturatedPath = join(root, "acknowledged-saturated.json");
  await recordAdapterDispatchReceipt(acknowledgedSaturatedPath, acknowledgedSaturated, "new-after-ack", "remote-new-after-ack", "dispatching");
  assert.equal(acknowledgedSaturated.has("acknowledged-9999"), false, "capacity pressure reclaims the oldest Kontrol-acknowledged terminal receipt");
  assert.ok(acknowledgedSaturated.has("new-after-ack"), "an acknowledged outcome frees capacity for a new dispatch");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("adapter-dispatch-receipts.test.mjs: all assertions passed");
