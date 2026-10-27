import { eq, and, gt, isNull, or } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  policyApprovalGrants,
  type PolicyApprovalGrantRow,
} from "./db/schema.js";
import type { EffectiveGrantPage, GrantRecord, GrantStore } from "./policy.js";

/**
 * SQLite-backed durable grant store. Approvals survive Kontrol restarts.
 * A grant is effective while it is not revoked and not past its optional
 * expiry. Work-session grants are revoked by the work-session lifecycle hook
 * when the session becomes terminal.
 */
export function createSqliteGrantStore(
  stateDirOrHandle: string | DatabaseHandle,
): GrantStore {
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;
  const sqlite = (database as { sqlite: { exec(q: string): unknown } }).sqlite;
  const listWorkspaceEffective = database.sqlite.prepare(`
    select g.id, g.principal_id as principalId, g.scope, g.scope_id as scopeId,
      g.approval_key as approvalKey, g.created_at as createdAt,
      g.expires_at as expiresAt, g.revoked_at as revokedAt, g.reviewer_id as reviewerId
    from policy_approval_grants g
    where g.revoked_at is null
      and (g.expires_at is null or g.expires_at > ?)
      and g.id > ?
      and (
        (g.scope = 'workspace' and g.scope_id = ?)
        or (g.scope = 'work_session' and exists (
          select 1 from work_sessions ws
          where ws.id = g.scope_id and ws.workspace_session_id = ?
        ))
      )
      and (? is null or g.principal_id = ? or (g.scope = 'work_session' and exists (
        select 1 from work_sessions owner_ws
        where owner_ws.id = g.scope_id and owner_ws.workspace_session_id = ? and owner_ws.owner_context_id = ?
      )))
    order by g.id asc
    limit ?
  `);

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

    revokeGrant(grantId: string): void {
      database.db
        .update(policyApprovalGrants)
        .set({ revokedAt: new Date().toISOString() })
        .where(
          and(
            eq(policyApprovalGrants.id, grantId),
            isNull(policyApprovalGrants.revokedAt),
          ),
        )
        .run();
    },

    hasEffective(principalId: string, scope: GrantRecord["scope"], scopeId: string, approvalKey: string): boolean {
      const now = new Date().toISOString();
      return database.db
        .select({ id: policyApprovalGrants.id })
        .from(policyApprovalGrants)
        .where(and(
          eq(policyApprovalGrants.principalId, principalId),
          eq(policyApprovalGrants.scope, scope),
          eq(policyApprovalGrants.scopeId, scopeId),
          eq(policyApprovalGrants.approvalKey, approvalKey),
          isNull(policyApprovalGrants.revokedAt),
          or(isNull(policyApprovalGrants.expiresAt), gt(policyApprovalGrants.expiresAt, now)),
        ))
        .limit(1)
        .get() !== undefined;
    },

    getEffective(grantId: string): GrantRecord | undefined {
      const now = new Date().toISOString();
      const row = database.db
        .select()
        .from(policyApprovalGrants)
        .where(and(
          eq(policyApprovalGrants.id, grantId),
          isNull(policyApprovalGrants.revokedAt),
          or(isNull(policyApprovalGrants.expiresAt), gt(policyApprovalGrants.expiresAt, now)),
        ))
        .get();
      return row ? rowToGrant(row) : undefined;
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

    listEffectiveForWorkspace(workspaceSessionId, afterId, limit, ownerContextId): EffectiveGrantPage {
      const now = new Date().toISOString();
      const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100;
      const rows = listWorkspaceEffective.all(
        now,
        afterId ?? "",
        workspaceSessionId,
        workspaceSessionId,
        ownerContextId ?? null,
        ownerContextId ?? null,
        workspaceSessionId,
        ownerContextId ?? "",
        boundedLimit + 1,
      ) as PolicyApprovalGrantRow[];
      const hasMore = rows.length > boundedLimit;
      const pageRows = hasMore ? rows.slice(0, boundedLimit) : rows;
      return {
        grants: pageRows.map(rowToGrant),
        ...(hasMore && pageRows.length ? { nextCursor: pageRows[pageRows.length - 1]!.id } : {}),
      };
    },
  };
}
