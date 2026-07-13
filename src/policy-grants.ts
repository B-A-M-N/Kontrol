import { eq, and, isNull } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  policyApprovalGrants,
  type PolicyApprovalGrantRow,
} from "./db/schema.js";
import type { GrantRecord, GrantStore } from "./policy.js";

/**
 * SQLite-backed durable grant store. Approvals survive DevSpace restarts.
 * A grant is effective while it is not revoked and not past its optional
 * expiry. Work-session grants are revoked by the caller when the session
 * becomes terminal (the workflow service calls revokeForScope).
 */
export function createSqliteGrantStore(
  stateDirOrHandle: string | DatabaseHandle,
): GrantStore {
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;
  const sqlite = (database as { sqlite: { exec(q: string): unknown } }).sqlite;

  // Ensure tables exist (idempotent; migration 12 creates them on fresh DBs).
  sqlite.exec(`
    create table if not exists policy_approval_grants (
      id text primary key,
      principal_id text not null,
      scope text not null,
      scope_id text not null,
      approval_key text not null,
      created_at text not null,
      expires_at text,
      revoked_at text,
      reviewer_id text
    );
  `);

  function rowToGrant(row: PolicyApprovalGrantRow): GrantRecord {
    return {
      id: row.id,
      principalId: row.principalId,
      scope: row.scope as GrantRecord["scope"],
      scopeId: row.scopeId,
      approvalKey: row.approvalKey,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt ?? undefined,
      revokedAt: row.revokedAt ?? undefined,
      reviewerId: row.reviewerId ?? undefined,
    };
  }

  return {
    insert(grant: GrantRecord): void {
      database.db
        .insert(policyApprovalGrants)
        .values({
          id: grant.id,
          principalId: grant.principalId,
          scope: grant.scope,
          scopeId: grant.scopeId,
          approvalKey: grant.approvalKey,
          createdAt: grant.createdAt,
          expiresAt: grant.expiresAt ?? null,
          revokedAt: null,
          reviewerId: grant.reviewerId ?? null,
        })
        .run();
    },

    revokeForScope(scope: GrantRecord["scope"], scopeId: string): void {
      const now = new Date().toISOString();
      database.db
        .update(policyApprovalGrants)
        .set({ revokedAt: now })
        .where(
          and(
            eq(policyApprovalGrants.scope, scope),
            eq(policyApprovalGrants.scopeId, scopeId),
            isNull(policyApprovalGrants.revokedAt),
          ),
        )
        .run();
    },

    listEffective(): GrantRecord[] {
      const now = new Date().toISOString();
      const rows = database.db
        .select()
        .from(policyApprovalGrants)
        .where(isNull(policyApprovalGrants.revokedAt))
        .all();
      return rows
        .filter((r) => !r.expiresAt || r.expiresAt > now)
        .map(rowToGrant);
    },
  };
}
