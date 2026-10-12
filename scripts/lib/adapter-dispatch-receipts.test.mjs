import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findAdapterDispatchReceipt,
  loadAdapterDispatchReceipts,
  recordAdapterDispatchReceipt,
} from "./adapter-dispatch-receipts.mjs";

const root = await mkdtemp(join(tmpdir(), "kontrol-adapter-dispatch-receipts-"));
const path = join(root, "dispatch-receipts.json");
try {
  const first = await loadAdapterDispatchReceipts(path);
  await recordAdapterDispatchReceipt(path, first, "disp_accept-response-lost", "remote-1", "running");
  const restarted = await loadAdapterDispatchReceipts(path);
  assert.deepEqual(findAdapterDispatchReceipt(restarted, "disp_accept-response-lost"), {
    key: "disp_accept-response-lost",
    remoteRunId: "remote-1",
    status: "running",
    createdAt: findAdapterDispatchReceipt(restarted, "disp_accept-response-lost")?.createdAt,
    updatedAt: findAdapterDispatchReceipt(restarted, "disp_accept-response-lost")?.updatedAt,
  });
  assert.equal(findAdapterDispatchReceipt(restarted, "missing"), undefined);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("adapter-dispatch-receipts.test.mjs: all assertions passed");
