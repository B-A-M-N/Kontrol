import { createHash } from "node:crypto";
import type { DatabaseHandle } from "./db/client.js";

export interface MutationReceiptStore {
  begin(input: {
    principalId: string;
    operation: string;
    clientMutationId?: string;
    request: unknown;
  }): MutationReceiptDecision;
  complete(input: {
    principalId: string;
    operation: string;
    clientMutationId: string;
    request: unknown;
    result: unknown;
  }): void;
  /**
   * Reconcile durable receipts without guessing the outcome of a pending
   * mutation. Completed receipts are retained for a bounded period; pending
   * rows are reported and deliberately never deleted because their outcome is
   * not recoverable from the receipt table alone.
   */
  reconcile(input?: { retentionMs?: number; limit?: number; now?: Date }): MutationReceiptMaintenance;
}

export interface MutationReceiptMaintenance {
  deletedCompleted: number;
  pendingSample: Array<{ principalId: string; operation: string; clientMutationId: string; updatedAt: string }>;
  pendingHasMore: boolean;
}

export type MutationReceiptDecision =
  | { kind: "disabled" }
  | { kind: "new" }
  | { kind: "replay"; result: unknown }
  | { kind: "pending" }
  | { kind: "conflict" };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function requestHash(operation: string, request: unknown): string {
  return createHash("sha256").update(`${operation}\n${canonicalJson(request)}`).digest("hex");
}

function receiptKey(input: { principalId: string; operation: string; clientMutationId: string }): string {
  return `${input.principalId}\u0000${input.operation}\u0000${input.clientMutationId}`;
}

export function createMutationReceiptStore(database: DatabaseHandle): MutationReceiptStore {
  const beginStatement = database.sqlite.prepare(`
    insert or ignore into client_mutation_receipts
      (principal_id, operation, client_mutation_id, request_hash, status, created_at, updated_at)
    values (?, ?, ?, ?, 'pending', ?, ?)
  `);
  const readStatement = database.sqlite.prepare(`
    select request_hash, status, result_json
      from client_mutation_receipts
     where principal_id = ? and operation = ? and client_mutation_id = ?
  `);
  const completeStatement = database.sqlite.prepare(`
    update client_mutation_receipts
       set status = 'completed', result_json = ?, updated_at = ?
     where principal_id = ? and operation = ? and client_mutation_id = ?
       and request_hash = ? and status = 'pending'
  `);
  const deleteCompletedStatement = database.sqlite.prepare(`
    delete from client_mutation_receipts
     where rowid in (
       select rowid
         from client_mutation_receipts
        where status = 'completed' and updated_at < ?
        order by updated_at asc
        limit ?
     )
  `);
  const pendingStatement = database.sqlite.prepare(`
    select principal_id, operation, client_mutation_id, updated_at
      from client_mutation_receipts
     where status = 'pending'
     order by updated_at asc, principal_id asc, operation asc, client_mutation_id asc
     limit ?
  `);

  const beginTransaction = database.sqlite.transaction((input: {
    principalId: string;
    operation: string;
    clientMutationId: string;
    hash: string;
    now: string;
  }) => {
    const inserted = beginStatement.run(input.principalId, input.operation, input.clientMutationId, input.hash, input.now, input.now);
    const row = readStatement.get(input.principalId, input.operation, input.clientMutationId) as { request_hash: string; status: string; result_json?: string | null } | undefined;
    return { insertedChanges: inserted.changes, row };
  });

  return {
    begin(input) {
      if (!input.clientMutationId) return { kind: "disabled" };
      const hash = requestHash(input.operation, input.request);
      const now = new Date().toISOString();
      const { insertedChanges, row } = beginTransaction({
        principalId: input.principalId,
        operation: input.operation,
        clientMutationId: input.clientMutationId,
        hash,
        now,
      });
      if (!row || row.request_hash !== hash) return { kind: "conflict" };
      if (row.status === "completed") {
        try {
          return { kind: "replay", result: JSON.parse(row.result_json ?? "null") };
        } catch {
          return { kind: "conflict" };
        }
      }
      if (row.status !== "pending") return { kind: "conflict" };
      // The insert is ignored for an existing pending row. It may belong to a
      // request that committed before a process crash; never execute it again.
      return insertedChanges === 1 ? { kind: "new" } : { kind: "pending" };
    },
    complete(input) {
      const hash = requestHash(input.operation, input.request);
      const now = new Date().toISOString();
      const serialized = JSON.stringify(input.result);
      if (typeof serialized !== "string") throw new Error("Mutation receipt result is not JSON-serializable.");
      const result = completeStatement.run(serialized, now, input.principalId, input.operation, input.clientMutationId, hash);
      if (result.changes !== 1) throw new Error("Mutation receipt could not be finalized; operation outcome is unknown.");
    },
    reconcile(input = {}) {
      const retentionMs = input.retentionMs ?? 30 * 24 * 60 * 60 * 1000;
      const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
      if (!Number.isFinite(retentionMs) || retentionMs < 0) throw new Error("Mutation receipt retention must be a non-negative finite duration.");
      const cutoff = new Date((input.now?.getTime() ?? Date.now()) - retentionMs).toISOString();
      const deletedCompleted = Number(deleteCompletedStatement.run(cutoff, limit).changes);
      const rows = pendingStatement.all(limit + 1) as Array<{
        principal_id: string;
        operation: string;
        client_mutation_id: string;
        updated_at: string;
      }>;
      return {
        deletedCompleted,
        pendingSample: rows.slice(0, limit).map((row) => ({
          principalId: row.principal_id,
          operation: row.operation,
          clientMutationId: row.client_mutation_id,
          updatedAt: row.updated_at,
        })),
        pendingHasMore: rows.length > limit,
      };
    },
  };
}

export function mutationReceiptResult(decision: Exclude<MutationReceiptDecision, { kind: "disabled" | "new" }>): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const text = decision.kind === "pending"
    ? "This mutation is already in progress or its prior outcome is unknown. Reconcile authoritative state before retrying."
    : decision.kind === "conflict"
      ? "This client mutation ID was already used with different request content."
      : "Stored mutation result could not be replayed.";
  return { content: [{ type: "text", text }], isError: true };
}

export async function runWithMutationReceipt<T>(input: {
  store?: MutationReceiptStore;
  principalId: string;
  operation: string;
  clientMutationId?: string;
  request: unknown;
  execute: () => Promise<T> | T;
}): Promise<T> {
  if (!input.store || !input.clientMutationId) return input.execute();
  const decision = input.store.begin(input);
  if (decision.kind === "disabled") return input.execute();
  if (decision.kind === "replay") return decision.result as T;
  if (decision.kind !== "new") return mutationReceiptResult(decision) as T;

  let result: T;
  try {
    result = await input.execute();
  } catch (error) {
    result = {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    } as T;
  }
  try {
    input.store.complete({
      principalId: input.principalId,
      operation: input.operation,
      clientMutationId: input.clientMutationId,
      request: input.request,
      result,
    });
  } catch {
    return {
      content: [{ type: "text", text: "Mutation committed, but its durable receipt could not be finalized. Reconcile authoritative state before retrying." }],
      isError: true,
    } as T;
  }
  return result;
}

export function mutationPrincipalId(principalId: string | undefined, role: string | undefined): string {
  return principalId?.trim() || `role:${role ?? "anonymous"}`;
}

export function mutationReceiptKey(input: { principalId: string; operation: string; clientMutationId: string }): string {
  return receiptKey(input);
}
