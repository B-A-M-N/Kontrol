import { atomicWriteJson, readJsonOr } from "./managed-agent-process.mjs";
import { createHash } from "node:crypto";

const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ADAPTER_DISPATCH_RECEIPT_MAX_ENTRIES = 10_000;
const receiptMutationQueues = new Map();
const TERMINAL_STATUSES = new Set(["completed", "failed", "failed_protocol", "cancelled", "rejected", "unstarted"]);
const EPHEMERAL_DISPATCH_FIELDS = new Set([
  "dispatch_idempotency_key",
  "token",
  "worker_token",
  "workspace_lease_nonce",
  "workspace_lease_expires_at",
  "read_only_execution_grant",
]);

export async function loadAdapterDispatchReceipts(path) {
  const stored = await readJsonOr(path, []);
  const now = Date.now();
  const receipts = new Map();
  for (const item of Array.isArray(stored) ? stored : []) {
    if (typeof item?.key !== "string" || typeof item?.remoteRunId !== "string" || typeof item?.createdAt !== "number") continue;
    if (TERMINAL_STATUSES.has(item.status) && item.createdAt < now - RECEIPT_RETENTION_MS) continue;
    receipts.set(item.key, item);
  }
  trimReceipts(receipts, now);
  if (receipts.size > ADAPTER_DISPATCH_RECEIPT_MAX_ENTRIES) {
    throw new AdapterDispatchReceiptCapacityError("Unresolved adapter dispatch receipts exceed the durable receipt capacity; refusing to discard recovery evidence.");
  }
  return receipts;
}

export class AdapterDispatchReceiptCapacityError extends Error {
  constructor(message = "Adapter dispatch receipt capacity is exhausted by live or unresolved runs.") {
    super(message);
    this.name = "AdapterDispatchReceiptCapacityError";
    this.code = "dispatch_receipt_capacity";
    this.status = 503;
  }
}

export function findAdapterDispatchReceipt(receipts, key) {
  return receipts.get(key);
}

export function isTerminalAdapterDispatchStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Resolve launch-gated claims after a restart. With launchGateVersion 1, a
 * missing owner or an owner still in prepared state proves that the start
 * signal was never durably authorized only when no start_requested marker was
 * written. Once that marker exists, restart cleanup may stop a worker whose
 * exact outcome was lost, so retain a terminal failure receipt rather than
 * risking a duplicate execution.
 */
export async function reconcileAdapterDispatchReceipts(path, receipts, ownedRecords = []) {
  const owners = new Map(ownedRecords
    .filter((record) => typeof record?.dispatchIdempotencyKey === "string")
    .map((record) => [record.dispatchIdempotencyKey, record]));
  const outcomes = [];
  for (const receipt of receipts.values()) {
    if (receipt.launchGateVersion !== 1 || isTerminalAdapterDispatchStatus(receipt.status)) continue;
    if (!["dispatching", "running"].includes(receipt.status)) continue;
    const owner = owners.get(receipt.key);
    const authoritativelyUnstarted = receipt.status === "dispatching"
      && receipt.launchState !== "start_requested"
      && (!owner || owner.launchState === "prepared");
    const status = authoritativelyUnstarted ? "unstarted" : "failed";
    const updated = await recordAdapterDispatchReceipt(path, receipts, receipt.key, receipt.remoteRunId, status, {
      authoritativelyUnstarted,
      lastError: authoritativelyUnstarted
        ? "Adapter restarted before the durable start request; the launch gate never allowed the worker to execute."
        : "Adapter restarted after the durable start request and stopped the owned process group before recording a terminal result.",
    });
    outcomes.push({ receipt: updated, status, owner });
  }
  return outcomes;
}

/** Fingerprint the immutable dispatch content, excluding ephemeral worker tokens. */
export function adapterDispatchFingerprint(body) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().filter((key) => !EPHEMERAL_DISPATCH_FIELDS.has(key))
      .map((key) => [key, stable(value[key])]));
  };
  return createHash("sha256").update(JSON.stringify(stable(body ?? {}))).digest("hex");
}

export async function recordAdapterDispatchReceipt(path, receipts, key, remoteRunId, status = "running", details = {}) {
  return withReceiptMutationLock(path, async () => {
    const prior = receipts.get(key);
    if (prior?.requestFingerprint && details?.requestFingerprint && prior.requestFingerprint !== details.requestFingerprint) {
      throw new Error(`dispatch receipt request fingerprint conflict for ${key}`);
    }
    if (prior && prior.remoteRunId !== remoteRunId) {
      throw new Error(`dispatch receipt conflict for ${key}: existing remote run ${prior.remoteRunId} cannot be replaced`);
    }
    if (prior && TERMINAL_STATUSES.has(prior.status) && status !== prior.status) {
      if (!TERMINAL_STATUSES.has(status)) status = prior.status;
      else throw new Error(`dispatch receipt conflict for ${key}: terminal status ${prior.status} cannot change to ${status}`);
    }
    const now = Date.now();
    const nextReceipts = new Map(receipts);
    trimReceipts(nextReceipts, now);
    if (!prior && nextReceipts.size >= ADAPTER_DISPATCH_RECEIPT_MAX_ENTRIES) {
      // Terminal entries may be evicted early under capacity pressure; live
      // and unresolved entries remain durable regardless of age.
      const oldestTerminal = [...nextReceipts]
        .filter(([, receipt]) => TERMINAL_STATUSES.has(receipt.status))
        .sort((left, right) => (left[1].updatedAt ?? left[1].createdAt) - (right[1].updatedAt ?? right[1].createdAt))[0]?.[0];
      if (oldestTerminal) nextReceipts.delete(oldestTerminal);
    }
    if (!prior && nextReceipts.size >= ADAPTER_DISPATCH_RECEIPT_MAX_ENTRIES) {
      throw new AdapterDispatchReceiptCapacityError();
    }
    const receipt = {
      ...prior,
      ...(details && typeof details === "object" ? details : {}),
      key,
      remoteRunId,
      status,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    nextReceipts.set(key, receipt);
    trimReceipts(nextReceipts, now);
    await atomicWriteJson(path, [...nextReceipts.values()]);
    receipts.clear();
    for (const [nextKey, nextReceipt] of nextReceipts) receipts.set(nextKey, nextReceipt);
    return receipt;
  });
}

async function withReceiptMutationLock(path, operation) {
  const preceding = receiptMutationQueues.get(path) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  receiptMutationQueues.set(path, current);
  await preceding.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (receiptMutationQueues.get(path) === current) receiptMutationQueues.delete(path);
  }
}

function trimReceipts(receipts, now) {
  const cutoff = now - RECEIPT_RETENTION_MS;
  for (const [key, receipt] of receipts) {
    if (TERMINAL_STATUSES.has(receipt.status) && receipt.createdAt < cutoff) receipts.delete(key);
  }
  while (receipts.size > ADAPTER_DISPATCH_RECEIPT_MAX_ENTRIES) {
    const oldest = [...receipts].find(([, receipt]) => TERMINAL_STATUSES.has(receipt.status))?.[0];
    if (!oldest) break;
    receipts.delete(oldest);
  }
}
