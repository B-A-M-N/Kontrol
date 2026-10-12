import { atomicWriteJson, readJsonOr } from "./managed-agent-process.mjs";

const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RECEIPT_MAX_ENTRIES = 10_000;

export async function loadAdapterDispatchReceipts(path) {
  const stored = await readJsonOr(path, []);
  const now = Date.now();
  const receipts = new Map();
  for (const item of Array.isArray(stored) ? stored : []) {
    if (typeof item?.key !== "string" || typeof item?.remoteRunId !== "string" || typeof item?.createdAt !== "number") continue;
    if (item.createdAt < now - RECEIPT_RETENTION_MS) continue;
    receipts.set(item.key, item);
  }
  trimReceipts(receipts, now);
  return receipts;
}

export function findAdapterDispatchReceipt(receipts, key) {
  return receipts.get(key);
}

export async function recordAdapterDispatchReceipt(path, receipts, key, remoteRunId, status = "running") {
  const now = Date.now();
  receipts.set(key, { key, remoteRunId, status, createdAt: now, updatedAt: now });
  trimReceipts(receipts, now);
  await atomicWriteJson(path, [...receipts.values()]);
}

function trimReceipts(receipts, now) {
  const cutoff = now - RECEIPT_RETENTION_MS;
  for (const [key, receipt] of receipts) {
    if (receipt.createdAt < cutoff) receipts.delete(key);
  }
  while (receipts.size > RECEIPT_MAX_ENTRIES) {
    const oldest = receipts.keys().next().value;
    if (!oldest) break;
    receipts.delete(oldest);
  }
}
