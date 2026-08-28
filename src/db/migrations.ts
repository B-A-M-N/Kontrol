import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { DEFAULT_DIRECT_APPROVAL_REATTACH_GRACE_MS } from "../policy-approval-defaults.js";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

const migrations: Migration[] = [
  { version: 1, name: "workspace-state", up: migrateWorkspaceState },
  { version: 2, name: "oauth-state", up: migrateOAuthState },
  { version: 3, name: "work-sessions", up: migrateWorkSessions },
  { version: 4, name: "agent-registry", up: migrateAgentRegistry },
  { version: 5, name: "review-feedback-structured", up: migrateReviewFeedbackStructured },
  { version: 6, name: "event-log", up: migrateEventLog },
  { version: 7, name: "continuations", up: migrateContinuations },
  { version: 8, name: "agent-registry-role", up: migrateAgentRegistryRole },
  { version: 9, name: "continuation-claim", up: migrateContinuationClaim },
  { version: 10, name: "work-session-consumed-feedback", up: migrateWorkSessionConsumedFeedback },
  { version: 11, name: "acp-runs-workflow", up: migrateAcpRunsWorkflow },
  { version: 12, name: "policy-approvals", up: migratePolicyApprovals },
  { version: 13, name: "dispatch-outbox", up: migrateDispatchOutbox },
  { version: 14, name: "approval-requests", up: migrateApprovalRequests },
  { version: 15, name: "work-session-completion-policy", up: migrateWorkSessionCompletionPolicy },
  { version: 16, name: "work-session-snapshot-binding", up: migrateWorkSessionSnapshotBinding },
  { version: 17, name: "supervisor-mission-ledger", up: migrateSupervisorMissionLedger },
  { version: 18, name: "mission-scope-guard", up: migrateMissionScopeGuard },
  { version: 19, name: "workspace-leases", up: migrateWorkspaceLeases },
  { version: 20, name: "dispatch-outbox-logical-key", up: migrateDispatchOutboxLogicalKey },
  { version: 21, name: "dispatch-outbox-failure-count", up: migrateDispatchOutboxFailureCount },
  { version: 22, name: "agent-messages", up: migrateAgentMessages },
  { version: 23, name: "supervisor-runs", up: migrateSupervisorRuns },
  { version: 24, name: "supervisor-run-pause", up: migrateSupervisorRunPause },
  { version: 25, name: "mission-completion-reports", up: migrateMissionCompletionReports },
  { version: 26, name: "supervisor-convergence-fingerprint", up: migrateSupervisorConvergenceFingerprint },
  { version: 27, name: "mission-criterion-dependencies", up: migrateMissionCriterionDependencies },
  { version: 28, name: "supervisor-run-deadline", up: migrateSupervisorRunDeadline },
  { version: 29, name: "feedback-completion-report-binding", up: migrateFeedbackCompletionReportBinding },
  { version: 30, name: "verification-lease-identity", up: migrateVerificationLeaseIdentity },
  { version: 31, name: "supervisor-lease-fencing", up: migrateSupervisorLeaseFencing },
  { version: 32, name: "workspace-project-identity", up: migrateWorkspaceProjectIdentity },
  { version: 33, name: "approval-principal-and-expiry-index", up: migrateApprovalPrincipalAndExpiryIndex },
  { version: 34, name: "feedback-session-created-index", up: migrateFeedbackSessionCreatedIndex },
  { version: 35, name: "mission-evidence-actor-principal", up: migrateMissionEvidenceActorPrincipal },
  { version: 36, name: "event-workspace-correlation", up: migrateEventWorkspaceCorrelation },
  { version: 37, name: "agent-registry-uniqueness", up: migrateAgentRegistryUniqueness },
  { version: 38, name: "webhook-queue-claims", up: migrateWebhookQueueClaims },
  { version: 39, name: "acp-run-agent-binding", up: migrateAcpRunAgentBinding },
  { version: 40, name: "supervisor-progress-policy", up: migrateSupervisorProgressPolicy },
  { version: 41, name: "mission-verification-scheduling", up: migrateMissionVerificationScheduling },
  { version: 42, name: "semantic-finding-deduplication", up: migrateSemanticFindingDeduplication },
  { version: 43, name: "mission-review-coverage-uncertainty", up: migrateMissionReviewCoverageUncertainty },
  { version: 44, name: "agent-per-agent-credential", up: migrateAgentPerAgentCredential },
  { version: 45, name: "submission-file-metadata", up: migrateSubmissionFileMetadata },
  { version: 46, name: "policy-approval-waiter-identity", up: migratePolicyApprovalWaiterIdentity },
  { version: 47, name: "policy-approval-live-waiter", up: migratePolicyApprovalLiveWaiter },
  { version: 48, name: "policy-approval-operation-lifecycle", up: migratePolicyApprovalOperationLifecycle },
  { version: 49, name: "policy-approval-once-consumption", up: migratePolicyApprovalOnceConsumption },
  { version: 50, name: "policy-approval-direct-reconnect-deadline", up: migratePolicyApprovalDirectReconnectDeadline },
];

function migrateSubmissionFileMetadata(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "work_session_submissions", "files_json", "text");
}

function migratePolicyApprovalWaiterIdentity(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "approval_requests", "approval_key", "text");
  addColumnIfMissing(sqlite, "approval_requests", "mcp_session_id", "text");
  addColumnIfMissing(sqlite, "approval_requests", "mcp_request_id", "text");
  addColumnIfMissing(sqlite, "approval_requests", "waiter_key", "text");
  sqlite.exec("create index if not exists approval_requests_waiter_key_idx on approval_requests(waiter_key, status)");
}

/**
 * P0.3/P0.4: durable approval rows now also store the live waiter id so a
 * reconnecting MCP request can reattach to the same card and resume under
 * the eventual reviewer decision. The card itself lives longer than the
 * caller; the live waiter id marks whether ANY caller is currently attached.
 */
function migratePolicyApprovalLiveWaiter(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "approval_requests", "live_waiter_id", "text");
}

function migratePolicyApprovalOperationLifecycle(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "approval_requests", "origin", "text");
  addColumnIfMissing(sqlite, "approval_requests", "conversation_id", "text");
  addColumnIfMissing(sqlite, "approval_requests", "orphaned_at", "text");
  addColumnIfMissing(sqlite, "approval_requests", "reattach_deadline", "text");
  sqlite.exec("create index if not exists approval_requests_reattach_idx on approval_requests(status, reattach_deadline)");
}

function migratePolicyApprovalOnceConsumption(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "approval_requests", "consumed_at", "text");
  sqlite.exec("create index if not exists approval_requests_waiter_consumed_idx on approval_requests(waiter_key, status, consumed_at)");
}

/** Legacy direct approvals were created before the bounded reconnect window
 * existed. Derive conservative deadlines from their original creation time so
 * startup reconciliation can cancel old zombie cards immediately. */
function migratePolicyApprovalDirectReconnectDeadline(sqlite: Database.Database): void {
  const rows = sqlite.prepare(`
    select id, created_at
      from approval_requests
     where status = 'pending'
       and kind = 'tool'
       and work_session_id is null
       and (origin is null or origin = 'direct_mcp')
       and reattach_deadline is null
  `).all() as Array<{ id: string; created_at: string }>;
  const update = sqlite.prepare(`
    update approval_requests
       set origin = coalesce(origin, 'direct_mcp'),
           orphaned_at = coalesce(orphaned_at, ?),
           reattach_deadline = ?
     where id = ?
  `);
  for (const row of rows) {
    const createdAtMs = Date.parse(row.created_at);
    const base = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
    const orphanedAt = Number.isFinite(createdAtMs) ? new Date(createdAtMs).toISOString() : new Date().toISOString();
    update.run(orphanedAt, new Date(base + DEFAULT_DIRECT_APPROVAL_REATTACH_GRACE_MS).toISOString(), row.id);
  }
}

/** Canonical current schema version — readiness requires exact equality. */
export const LATEST_SCHEMA_VERSION = migrations[migrations.length - 1]!.version;

/** Ordered migration chain (exported for migration fixture tests). */
export const migrationChain = migrations;

function migrateAgentPerAgentCredential(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "agent_registry", "agent_credential_hash", "text");
}

function migrateSupervisorProgressPolicy(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "supervisor_runs", "max_stagnant_cycles", "integer not null default 2");
  addColumnIfMissing(sqlite, "supervisor_runs", "repeated_failure_fingerprint_limit", "integer not null default 3");
  addColumnIfMissing(sqlite, "supervisor_runs", "stagnant_cycle_count", "integer not null default 0");
  addColumnIfMissing(sqlite, "supervisor_runs", "progress_json", "text");
  addColumnIfMissing(sqlite, "supervisor_runs", "stall_reason", "text");
  sqlite.exec(`
    create table if not exists supervisor_progress_snapshots (
      id text primary key,
      supervisor_run_id text not null,
      work_session_id text not null,
      cycle_number integer not null,
      snapshot_json text not null,
      delta_json text not null,
      created_at text not null,
      foreign key (supervisor_run_id) references supervisor_runs(id) on delete cascade
    );
    create index if not exists supervisor_progress_run_idx
      on supervisor_progress_snapshots(supervisor_run_id, cycle_number);
  `);
}

function migrateMissionVerificationScheduling(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "mission_acceptance_criteria", "verification_group", "text");
  addColumnIfMissing(sqlite, "mission_acceptance_criteria", "verification_scope", "text not null default 'full'");
  addColumnIfMissing(sqlite, "mission_acceptance_criteria", "final_only", "integer not null default 0");
  addColumnIfMissing(sqlite, "mission_acceptance_criteria", "mutates_workspace", "integer not null default 0");
  addColumnIfMissing(sqlite, "mission_acceptance_criteria", "command_version", "text");
}

function migrateSemanticFindingDeduplication(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "mission_review_findings", "disposition", "text not null default 'blocking'");
  addColumnIfMissing(sqlite, "mission_review_findings", "fingerprint", "text");
  sqlite.exec("create index if not exists mission_findings_fingerprint_idx on mission_review_findings(mission_id, fingerprint, status)");
}

function migrateMissionReviewCoverageUncertainty(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "mission_contracts", "review_coverage_json", "text not null default '[]'");
  addColumnIfMissing(sqlite, "mission_completion_reports", "review_coverage_json", "text not null default '[]'");
  addColumnIfMissing(sqlite, "mission_completion_reports", "uncertainty_json", "text not null default '[]'");
}

function migrateAcpRunAgentBinding(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "acp_runs", "agent_id", "text");
}

function migrateAgentRegistryUniqueness(sqlite: Database.Database): void {
  // Keep the newest registration for each logical name before enforcing the
  // invariant. Re-home historical run references first: deleting a duplicate
  // registry row without doing this leaves old acp_runs.agent_id values
  // pointing at an identity that no longer exists.
  sqlite.exec(`
    create table if not exists agent_registry_identity_aliases (
      legacy_agent_id text primary key,
      canonical_agent_id text not null,
      original_name text not null,
      migrated_at text not null
    );
  `);

  const duplicates = sqlite.prepare(`
    select id, name from (
      select id, name, row_number() over (
        partition by name order by last_heartbeat desc, created_at desc, id desc
      ) as rn
      from agent_registry
    ) where rn > 1
  `).all() as Array<{ id: string; name: string }>;
  const canonicalForName = sqlite.prepare(`
    select id from agent_registry
     where name = ?
     order by last_heartbeat desc, created_at desc, id desc
     limit 1
  `);
  const alias = sqlite.prepare(`
    insert or ignore into agent_registry_identity_aliases
      (legacy_agent_id, canonical_agent_id, original_name, migrated_at)
    values (?, ?, ?, ?)
  `);
  const rehomeRuns = sqlite.prepare("update acp_runs set agent_id = ? where agent_id = ?");
  const removeDuplicate = sqlite.prepare("delete from agent_registry where id = ?");
  for (const duplicate of duplicates) {
    const canonical = canonicalForName.get(duplicate.name) as { id?: string } | undefined;
    if (!canonical?.id || canonical.id === duplicate.id) continue;
    alias.run(duplicate.id, canonical.id, duplicate.name, new Date().toISOString());
    rehomeRuns.run(canonical.id, duplicate.id);
    removeDuplicate.run(duplicate.id);
  }
  sqlite.exec("create unique index if not exists agent_registry_name_unique on agent_registry(name);");
}

function migrateWebhookQueueClaims(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "agent_webhook_queue", "claimed_by", "text");
  addColumnIfMissing(sqlite, "agent_webhook_queue", "claim_expires_at", "text");
  sqlite.exec("create index if not exists webhook_queue_claim_idx on agent_webhook_queue(status, claim_expires_at)");
}

function migrateApprovalPrincipalAndExpiryIndex(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "approval_requests", "principal_id", "text");
  sqlite.exec("create index if not exists approval_requests_status_expiry_idx on approval_requests(status, expires_at)");
}

function migrateFeedbackSessionCreatedIndex(sqlite: Database.Database): void {
  sqlite.exec("create index if not exists work_session_feedback_session_created_idx on work_session_feedback(work_session_id, created_at)");
}

function migrateMissionEvidenceActorPrincipal(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "mission_evidence", "actor_principal", "text");
}

function migrateEventWorkspaceCorrelation(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "event_log", "workspace_session_id", "text");
  sqlite.exec("create index if not exists event_log_workspace_seq_idx on event_log(workspace_session_id, seq)");
  sqlite.exec(`
    update event_log
       set workspace_session_id = coalesce(
         (select ws.workspace_session_id from work_sessions ws where ws.id = event_log.session_id),
         (select wss.id from workspace_sessions wss where wss.id = event_log.session_id)
       )
     where workspace_session_id is null;
  `);
}

function migrateSupervisorRuns(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists supervisor_runs (
      id text primary key,
      mission_id text not null unique,
      work_session_id text not null unique,
      workspace_session_id text not null,
      status text not null default 'created',
      revision integer not null default 1,
      cycle_number integer not null default 0,
      max_cycles integer not null default 10,
      owner_instance_id text,
      lease_expires_at text,
      heartbeat_at text,
      last_processed_event_seq integer not null default 0,
      last_submission_id text,
      last_snapshot_commit text,
      next_action_at text,
      failure_count integer not null default 0,
      last_error text,
      autonomy_mode text not null default 'manual',
      approval_mode text not null default 'human_required',
      created_at text not null,
      updated_at text not null,
      foreign key (mission_id) references mission_contracts(id) on delete cascade,
      foreign key (work_session_id) references work_sessions(id) on delete cascade,
      foreign key (workspace_session_id) references workspace_sessions(id) on delete cascade
    );
    create index if not exists supervisor_runs_status_next_idx on supervisor_runs(status, next_action_at);
    create index if not exists supervisor_runs_lease_idx on supervisor_runs(lease_expires_at);
  `);
}

function migrateSupervisorLeaseFencing(sqlite: Database.Database): void {
  const columns = sqlite.prepare("pragma table_info(supervisor_runs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "lease_nonce")) {
    sqlite.exec("alter table supervisor_runs add column lease_nonce text");
  }
  sqlite.exec("create index if not exists supervisor_runs_lease_nonce_idx on supervisor_runs(owner_instance_id, lease_nonce)");
}

// A workspace session is an opening/worktree instance, not the durable
// project identity. Backfill one project row for every canonical checkout
// root and attach historical workspace/work-session rows without deleting or
// merging their instance identities.
function migrateWorkspaceProjectIdentity(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_projects (
      id text primary key,
      canonical_root text not null unique,
      created_at text not null,
      last_used_at text not null
    );
    create index if not exists workspace_projects_last_used_idx
      on workspace_projects(last_used_at desc);
  `);
  addColumnIfMissing(sqlite, "workspace_sessions", "project_id", "text");
  addColumnIfMissing(sqlite, "work_sessions", "project_id", "text");
  addColumnIfMissing(sqlite, "work_sessions", "runtime_state", "text not null default 'pending'");
  addColumnIfMissing(sqlite, "work_sessions", "runtime_classified_at", "text");

  const rows = sqlite.prepare("select id, root, mode, source_root, created_at, last_used_at from workspace_sessions").all() as Array<{
    id: string;
    root: string;
    mode: string;
    source_root?: string | null;
    created_at: string;
    last_used_at: string;
  }>;
  const projectByRoot = new Map<string, string>();
  const projectIdForRoot = (rawRoot: string): string => {
    let canonicalRoot = rawRoot;
    try { canonicalRoot = realpathSync(rawRoot); } catch { /* preserve historical path */ }
    const existing = projectByRoot.get(canonicalRoot);
    if (existing) return existing;
    const id = `project_${createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 24)}`;
    const timestamps = rows.filter((row) => {
      const candidate = row.mode === "worktree" && row.source_root ? row.source_root : row.root;
      let resolved = candidate;
      try { resolved = realpathSync(candidate); } catch { /* preserve historical path */ }
      return resolved === canonicalRoot;
    });
    const createdAt = timestamps.map((row) => row.created_at).sort()[0] ?? new Date().toISOString();
    const lastUsedAt = timestamps.map((row) => row.last_used_at).sort().at(-1) ?? createdAt;
    sqlite.prepare("insert or ignore into workspace_projects (id, canonical_root, created_at, last_used_at) values (?, ?, ?, ?)").run(id, canonicalRoot, createdAt, lastUsedAt);
    projectByRoot.set(canonicalRoot, id);
    return id;
  };

  for (const row of rows) {
    const projectRoot = row.mode === "worktree" && row.source_root ? row.source_root : row.root;
    const projectId = projectIdForRoot(projectRoot);
    sqlite.prepare("update workspace_sessions set project_id = ? where id = ?").run(projectId, row.id);
  }
  sqlite.exec(`
    update work_sessions
       set project_id = (select project_id from workspace_sessions where workspace_sessions.id = work_sessions.workspace_session_id)
     where project_id is null;
    create index if not exists workspace_sessions_project_idx
      on workspace_sessions(project_id, last_used_at desc);
    create index if not exists work_sessions_project_idx
      on work_sessions(project_id, updated_at desc);
    create index if not exists work_sessions_runtime_state_idx
      on work_sessions(runtime_state, updated_at desc);
  `);
}

function migrateSupervisorRunPause(sqlite: Database.Database): void {
  const columns = sqlite.prepare("pragma table_info(supervisor_runs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "resume_status")) {
    sqlite.exec("alter table supervisor_runs add column resume_status text");
  }
}

function migrateMissionCompletionReports(sqlite: Database.Database): void {
  const columns = sqlite.prepare("pragma table_info(mission_contracts)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "final_verification_json")) {
    sqlite.exec("alter table mission_contracts add column final_verification_json text not null default '[]'");
  }
  sqlite.exec(`
    create table if not exists mission_completion_reports (
      id text primary key,
      mission_id text not null,
      submission_id text not null,
      snapshot_commit text not null,
      status text not null,
      results_json text not null,
      report_sha256 text not null,
      created_at text not null,
      foreign key (mission_id) references mission_contracts(id) on delete cascade
    );
    create index if not exists mission_completion_reports_current_idx
      on mission_completion_reports(mission_id, submission_id, snapshot_commit, created_at desc);
  `);
}

function migrateSupervisorConvergenceFingerprint(sqlite: Database.Database): void {
  const columns = sqlite.prepare("pragma table_info(supervisor_runs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "last_failure_fingerprint")) sqlite.exec("alter table supervisor_runs add column last_failure_fingerprint text");
  if (!columns.some((column) => column.name === "repeated_failure_count")) sqlite.exec("alter table supervisor_runs add column repeated_failure_count integer not null default 0");
}

function migrateMissionCriterionDependencies(sqlite: Database.Database): void {
  const columns = sqlite.prepare("pragma table_info(mission_acceptance_criteria)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "depends_on_json")) sqlite.exec("alter table mission_acceptance_criteria add column depends_on_json text not null default '[]'");
}

function migrateSupervisorRunDeadline(sqlite: Database.Database): void {
  const columns = sqlite.prepare("pragma table_info(supervisor_runs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "deadline_at")) sqlite.exec("alter table supervisor_runs add column deadline_at text");
}

function migrateFeedbackCompletionReportBinding(sqlite: Database.Database): void {
  const columns = sqlite.prepare("pragma table_info(work_session_feedback)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "completion_report_sha256")) sqlite.exec("alter table work_session_feedback add column completion_report_sha256 text");
}

function migrateVerificationLeaseIdentity(sqlite: Database.Database): void {
  const leaseColumns = (sqlite.prepare("pragma table_info(workspace_leases)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!leaseColumns.includes("lease_nonce")) {
    sqlite.exec("alter table workspace_leases add column lease_nonce text not null default 'legacy'");
  }
  const evidenceColumns = (sqlite.prepare("pragma table_info(mission_evidence)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!evidenceColumns.includes("review_epoch")) {
    sqlite.exec("alter table mission_evidence add column review_epoch integer");
  }
  if (!evidenceColumns.includes("lease_nonce")) {
    sqlite.exec("alter table mission_evidence add column lease_nonce text");
  }
  sqlite.exec("create index if not exists mission_evidence_binding_idx on mission_evidence(submission_id, review_epoch, snapshot_commit, lease_nonce)");
}

/**
 * Anti-runaway loop guard. A reviewer may extend a running loop when it finds
 * NEW issues, but only bounded ones:
 *   - findings.scope classifies each finding as in_scope / regression /
 *     out_of_scope. Only in_scope + regression findings may block approval and
 *     extend the loop; out_of_scope findings are recorded but do not gate.
 *   - correction_rounds counts how many times the loop was extended for new
 *     findings; max_correction_rounds bounds it so the AI cannot perpetually
 *     invent new issues.
 */
function migrateMissionScopeGuard(sqlite: Database.Database): void {
  const findingCols = (sqlite.prepare("pragma table_info(mission_review_findings)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!findingCols.includes("scope")) {
    sqlite.exec("alter table mission_review_findings add column scope text not null default 'in_scope'");
  }
  const missionCols = (sqlite.prepare("pragma table_info(mission_contracts)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!missionCols.includes("correction_rounds")) {
    sqlite.exec("alter table mission_contracts add column correction_rounds integer not null default 0");
  }
  if (!missionCols.includes("max_correction_rounds")) {
    sqlite.exec("alter table mission_contracts add column max_correction_rounds integer not null default 5");
  }
}

function migrateWorkspaceLeases(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_leases (
      canonical_root text primary key,
      workspace_session_id text not null,
      work_session_id text not null,
      lease_kind text not null default 'modify',
      owner_instance_id text not null,
      acquired_at text not null,
      heartbeat_at text not null,
      expires_at text not null,
      foreign key (workspace_session_id) references workspace_sessions(id) on delete cascade,
      foreign key (work_session_id) references work_sessions(id) on delete cascade
    );

    create index if not exists workspace_leases_session_idx
      on workspace_leases(work_session_id);

    create index if not exists workspace_leases_expires_idx
      on workspace_leases(expires_at);
  `);
}

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists kontrol_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const applied = new Set(
      (
        sqlite.prepare("select version from kontrol_schema_migrations").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version),
    );
    const futureVersions = [...applied].filter((version) => version > LATEST_SCHEMA_VERSION).sort((a, b) => a - b);
    if (futureVersions.length > 0) {
      throw new Error(`Database schema version ${futureVersions[0]} is newer than this Kontrol build (supports ${LATEST_SCHEMA_VERSION}); refusing startup.`);
    }
    const recordMigration = sqlite.prepare(
      "insert into kontrol_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(sqlite);
      recordMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  migrate.immediate();
  // Startup only needs to establish that the migrated connection can execute
  // a bounded query. Full integrity and foreign-key scans are diagnostics and
  // run asynchronously after the HTTP server has bound its socket.
  sqlite.prepare("select 1").get();
}

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);

  addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
}

function migrateSupervisorMissionLedger(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists mission_contracts (
      id text primary key,
      work_session_id text not null unique,
      workspace_session_id text not null,
      revision integer not null default 1,
      objective text not null,
      desired_outcome text not null,
      constraints_json text not null default '[]',
      non_goals_json text not null default '[]',
      user_locked_fields_json text not null default '[]',
      supervisor_instructions text,
      baseline_commit text,
      created_at text not null,
      updated_at text not null,
      foreign key (work_session_id) references work_sessions(id) on delete cascade,
      foreign key (workspace_session_id) references workspace_sessions(id) on delete cascade
    );

    create index if not exists mission_contracts_workspace_idx
      on mission_contracts(workspace_session_id, updated_at desc);

    create table if not exists mission_acceptance_criteria (
      id text primary key,
      mission_id text not null,
      description text not null,
      priority text not null default 'required',
      verification_type text not null default 'manual_review',
      verification_command text,
      affected_areas_json text not null default '[]',
      status text not null default 'unverified',
      created_at text not null,
      updated_at text not null,
      foreign key (mission_id) references mission_contracts(id) on delete cascade
    );

    create index if not exists mission_criteria_mission_idx
      on mission_acceptance_criteria(mission_id, status);

    create table if not exists mission_review_findings (
      id text primary key,
      mission_id text not null,
      introduced_in_submission_id text,
      severity text not null default 'medium',
      category text not null default 'correctness',
      description text not null,
      evidence_json text not null default '[]',
      required_action text not null,
      required_verification_json text not null default '[]',
      status text not null default 'open',
      resolution_submission_id text,
      waiver_reason text,
      created_at text not null,
      updated_at text not null,
      foreign key (mission_id) references mission_contracts(id) on delete cascade
    );

    create index if not exists mission_findings_mission_status_idx
      on mission_review_findings(mission_id, status, severity);

    create table if not exists mission_work_orders (
      id text primary key,
      mission_id text not null,
      work_session_id text not null,
      mission_revision integer not null,
      objective_for_this_turn text not null,
      required_finding_ids_json text not null default '[]',
      acceptance_criterion_ids_json text not null default '[]',
      required_actions_json text not null default '[]',
      prohibited_actions_json text not null default '[]',
      required_verification_json text not null default '[]',
      expected_deliverables_json text not null default '[]',
      context_references_json text not null default '[]',
      preferred_agent text,
      status text not null default 'active',
      created_at text not null,
      foreign key (mission_id) references mission_contracts(id) on delete cascade,
      foreign key (work_session_id) references work_sessions(id) on delete cascade
    );

    create index if not exists mission_work_orders_session_idx
      on mission_work_orders(work_session_id, created_at desc);

    create index if not exists mission_work_orders_mission_idx
      on mission_work_orders(mission_id, created_at desc);

    create table if not exists mission_evidence (
      id text primary key,
      mission_id text not null,
      criterion_id text,
      submission_id text,
      actor_principal text,
      snapshot_commit text,
      command text,
      output_digest text,
      status text not null default 'inconclusive',
      details_json text not null default '{}',
      created_at text not null,
      foreign key (mission_id) references mission_contracts(id) on delete cascade
    );

    create index if not exists mission_evidence_mission_idx
      on mission_evidence(mission_id, created_at desc);

    create index if not exists mission_evidence_criterion_idx
      on mission_evidence(criterion_id, created_at desc);
  `);
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateWorkSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists work_sessions (
      id text primary key,
      workspace_session_id text not null,
      status text not null default 'in_progress',
      completion_policy text not null default 'agent_completion',
      review_epoch integer not null default 0,
      submitted_by text not null,
      title text,
      created_at text not null,
      updated_at text not null,
      foreign key (workspace_session_id) references workspace_sessions(id) on delete cascade
    );

    create index if not exists work_sessions_workspace_idx
      on work_sessions(workspace_session_id, updated_at desc);

    create index if not exists work_sessions_status_idx
      on work_sessions(status, updated_at desc);

    create table if not exists work_session_submissions (
      id text primary key,
      work_session_id text not null,
      submission_number integer not null,
      diff text,
      diff_sha256 text,
      review_epoch integer not null default 1,
      snapshot_commit text,
      message text,
      summary_json text,
      status text not null default 'pending',
      created_at text not null,
      foreign key (work_session_id) references work_sessions(id) on delete cascade
    );

    create index if not exists wss_work_session_idx
      on work_session_submissions(work_session_id, submission_number);

    create table if not exists work_session_feedback (
      id text primary key,
      work_session_id text not null,
      submission_id text not null,
      verdict text not null,
      comments text,
      files_json text,
      created_at text not null,
      foreign key (work_session_id) references work_sessions(id) on delete cascade,
      foreign key (submission_id) references work_session_submissions(id) on delete cascade
    );

    create table if not exists work_session_tool_events (
      id text primary key,
      work_session_id text not null,
      workspace_session_id text,
      tool text not null,
      input_json text not null,
      output_summary text,
      path text,
      success integer not null default 1,
      elapsed_ms integer not null default 0,
      created_at text not null,
      foreign key (work_session_id) references work_sessions(id) on delete cascade
    );

    create index if not exists wste_work_session_idx
      on work_session_tool_events(work_session_id, created_at);
  `);

  addColumnIfMissing(sqlite, "work_sessions", "completion_policy", "text not null default 'agent_completion'");
  addColumnIfMissing(sqlite, "work_sessions", "review_epoch", "integer not null default 0");
  addColumnIfMissing(sqlite, "work_session_submissions", "diff_sha256", "text");
  addColumnIfMissing(sqlite, "work_session_submissions", "review_epoch", "integer not null default 1");
}

function migrateAgentRegistry(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists agent_registry (
      id text primary key,
      name text not null,
      url text not null,
      description text,
      public_key text,
      capabilities_json text,
      tags text,
      last_heartbeat text not null,
      created_at text not null,
      ttl_seconds integer not null default 60
    );

    create index if not exists agent_registry_name_idx
      on agent_registry(name);

    create index if not exists agent_registry_heartbeat_idx
      on agent_registry(last_heartbeat);

    create table if not exists acp_runs (
      run_id text primary key,
      agent_name text not null,
      agent_id text,
      workspace_session_id text,
      work_session_id text,
      status text not null default 'created',
      input_preview text,
      output_preview text,
      output_json text,
      error_message text,
      webhook_url text,
      webhook_delivered integer not null default 0,
      created_at text not null,
      finished_at text
    );

    create index if not exists acp_runs_status_idx
      on acp_runs(status, created_at desc);

    create index if not exists acp_runs_workspace_idx
      on acp_runs(workspace_session_id);

    create table if not exists agent_webhook_queue (
      id text primary key,
      run_id text not null,
      target_url text not null,
      payload_json text not null,
      status text not null default 'pending',
      retry_count integer not null default 0,
      max_retries integer not null default 3,
      last_error text,
      claimed_by text,
      claim_expires_at text,
      created_at text not null,
      next_retry_at text,
      foreign key (run_id) references acp_runs(run_id) on delete cascade
    );

    create index if not exists webhook_queue_status_idx
      on agent_webhook_queue(status, next_retry_at);
    create index if not exists webhook_queue_claim_idx
      on agent_webhook_queue(status, claim_expires_at);
  `);
}

function migrateReviewFeedbackStructured(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "work_session_feedback", "required_actions_json", "text");
  addColumnIfMissing(sqlite, "work_session_feedback", "allowed_next_actions_json", "text");
  addColumnIfMissing(sqlite, "work_session_feedback", "reviewer_id", "text");
}

function migrateContinuations(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists continuations (
      id text primary key,
      session_id text not null,
      review_id text not null,
      feedback_event_id text not null,
      review_epoch integer not null default 1,
      verdict text not null,
      required_actions_json text not null default '[]',
      allowed_next_actions_json text not null default '[]',
      reviewed_diff_hash text,
      feedback_summary text,
      resume_instructions text,
      status text not null default 'pending',
      target text,
      prompt_text text not null,
      created_at text not null,
      delivered_at text,
      consumed_at text
    );

    create index if not exists continuations_session_status_idx
      on continuations(session_id, status);

    create index if not exists continuations_status_idx
      on continuations(status, created_at);
  `);
}

function migrateAgentRegistryRole(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "agent_registry", "role", "text");
}

function migrateContinuationClaim(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "continuations", "claim_owner", "text");
  addColumnIfMissing(sqlite, "continuations", "claimed_at", "text");
}

function migrateWorkSessionConsumedFeedback(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "work_sessions", "last_consumed_feedback_id", "text");
}

function migrateAcpRunsWorkflow(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "acp_runs", "remote_run_id", "text");
  addColumnIfMissing(sqlite, "acp_runs", "attempt_number", "integer not null default 1");
  addColumnIfMissing(sqlite, "acp_runs", "last_heartbeat_at", "text");
  addColumnIfMissing(sqlite, "acp_runs", "worker_lease_until", "text");

  sqlite.exec(`
    delete from acp_runs
    where work_session_id is not null
      and run_id not in (
        select run_id from (
          select run_id, row_number() over (
            partition by work_session_id order by created_at desc
          ) as rn
          from acp_runs
          where work_session_id is not null
        ) where rn = 1
      );
  `);

  sqlite.exec(`
    create unique index if not exists acp_runs_one_logical_run_per_session
      on acp_runs(work_session_id)
      where work_session_id is not null;
  `);

  sqlite.exec(`
    create unique index if not exists work_session_submission_number_unique
      on work_session_submissions(work_session_id, submission_number);
  `);

  sqlite.exec(`
    create unique index if not exists work_session_feedback_submission_unique
      on work_session_feedback(submission_id);
  `);
}

function migrateEventLog(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists event_log (
      seq integer primary key autoincrement,
      id text not null unique,
      type text not null,
      session_id text not null,
      workspace_session_id text,
      payload text not null,
      created_at text not null
    );

    create index if not exists event_log_session_seq_idx
      on event_log(session_id, seq);

    create index if not exists event_log_type_idx
      on event_log(type, seq);

    create index if not exists event_log_workspace_seq_idx
      on event_log(workspace_session_id, seq);
  `);
}

function migratePolicyApprovals(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists policy_approval_requests (
      id text primary key,
      principal_id text not null,
      workspace_session_id text not null,
      work_session_id text,
      tool text not null,
      path text,
      command text,
      created_at text not null
    );

    create index if not exists policy_approval_requests_workspace_idx
      on policy_approval_requests(workspace_session_id, created_at);

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

    create index if not exists policy_approval_grants_principal_idx
      on policy_approval_grants(principal_id, scope, scope_id, approval_key);
  `);
}

function migrateDispatchOutbox(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists dispatch_outbox (
      id text primary key,
      event_type text not null,
      aggregate_id text not null,
      aggregate_revision integer not null default 0,
      payload_json text not null default '{}',
      status text not null default 'pending',
      attempt_count integer not null default 0,
      available_at text not null,
      claimed_by text,
      claim_expires_at text,
      last_error text,
      created_at text not null,
      completed_at text
    );

    create index if not exists dispatch_outbox_status_available_idx
      on dispatch_outbox(status, available_at);

    create index if not exists dispatch_outbox_aggregate_idx
      on dispatch_outbox(aggregate_id);

    create unique index if not exists dispatch_outbox_logical_unique
      on dispatch_outbox(event_type, aggregate_id, aggregate_revision);
  `);
}

/**
 * v21: split "attempts" into two distinct counters.
 *
 * The original schema had a single `attempt_count` that was incremented in
 * `claimNext` (once per claim) but consulted in `markFailed` to decide
 * dead-lettering and exponential backoff. Because a claim can be reaped back to
 * pending after a dispatcher crash WITHOUT ever recording a failure, the counter
 * measured claims, not failures — so an event could dead-letter after fewer than
 * the intended real failures, and backoff was keyed off the wrong exponent.
 *
 * `failure_count` now counts ONLY genuine dispatch failures (markFailed);
 * `attempt_count` is retained purely as a claim odometer for observability. New
 * rows start at 0; existing rows seed `failure_count` from the old `attempt_count`
 * so no in-flight event loses its accrued failure budget on upgrade.
 */
function migrateDispatchOutboxFailureCount(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "dispatch_outbox", "failure_count", "integer not null default 0");
  // Best-effort backfill: treat prior attempt_count as the failure budget already
  // spent. Over-counts slightly for events reaped without failing, which only
  // makes dead-lettering more conservative — never less.
  sqlite.exec("update dispatch_outbox set failure_count = attempt_count where failure_count = 0");
}

/**
 * v22: durable agent→WebUI messages and artifacts. See schema.ts agentMessages.
 */
function migrateAgentMessages(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists agent_messages (
      id text primary key,
      work_session_id text not null references work_sessions(id) on delete cascade,
      run_id text,
      kind text not null,
      author text not null default 'worker',
      title text,
      body text,
      data_json text not null default '{}',
      reply_to_id text,
      status text not null default 'open',
      created_at text not null,
      resolved_at text
    );

    create index if not exists agent_messages_session_idx
      on agent_messages(work_session_id, created_at);

    create index if not exists agent_messages_kind_idx
      on agent_messages(work_session_id, kind, status);
  `);
}

function migrateDispatchOutboxLogicalKey(sqlite: Database.Database): void {
  const columns = sqlite.prepare("pragma table_info(dispatch_outbox)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "aggregate_revision")) {
    sqlite.exec("alter table dispatch_outbox add column aggregate_revision integer not null default 0");
  }
  sqlite.exec(`
    delete from dispatch_outbox
    where rowid not in (
      select min(rowid)
      from dispatch_outbox
      group by event_type, aggregate_id, aggregate_revision
    );

    create unique index if not exists dispatch_outbox_logical_unique
      on dispatch_outbox(event_type, aggregate_id, aggregate_revision);
  `);
}

function migrateApprovalRequests(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists approval_requests (
      id text primary key,
      kind text not null,
      workspace_session_id text not null,
      work_session_id text,
      run_id text,
      agent_id text,
      principal_id text,
      title text not null,
      description text,
      risk text,
      tool text,
      command text,
      path text,
      options_json text not null,
      status text not null default 'pending',
      created_at text not null,
      expires_at text,
      resolved_at text,
      resolution_json text
    );

    create index if not exists approval_requests_workspace_status_idx
      on approval_requests(workspace_session_id, status, created_at);

    create index if not exists approval_requests_work_session_status_idx
      on approval_requests(work_session_id, status, created_at);

    create index if not exists approval_requests_run_idx
      on approval_requests(run_id, created_at);
  `);
}

function migrateWorkSessionCompletionPolicy(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "work_sessions", "completion_policy", "text not null default 'agent_completion'");
  addColumnIfMissing(sqlite, "work_sessions", "review_epoch", "integer not null default 0");
  addColumnIfMissing(sqlite, "work_session_submissions", "diff_sha256", "text");
  addColumnIfMissing(sqlite, "work_session_submissions", "review_epoch", "integer not null default 1");
}

// v16: bind each submission to the exact working-tree snapshot it was captured
// against, and reconcile the well-known WebUI registration to the authoritative
// "reviewer" role (a stale "client" row from an earlier seed must be
// upgraded, not merely heartbeated — see acp-registry ensure() reconcile).
function migrateWorkSessionSnapshotBinding(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "work_session_submissions", "snapshot_commit", "text");
  sqlite.exec(`update agent_registry set role = 'reviewer' where name = 'webui'`);
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "work_sessions" | "work_session_submissions" | "work_session_feedback" | "agent_registry" | "continuations" | "acp_runs" | "agent_webhook_queue" | "dispatch_outbox" | "approval_requests" | "mission_evidence" | "event_log" | "supervisor_runs" | "mission_acceptance_criteria" | "mission_review_findings" | "mission_contracts" | "mission_completion_reports",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
