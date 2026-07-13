import type Database from "better-sqlite3";

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
];

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
      created_at text not null,
      next_retry_at text,
      foreign key (run_id) references acp_runs(run_id) on delete cascade
    );

    create index if not exists webhook_queue_status_idx
      on agent_webhook_queue(status, next_retry_at);
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
      payload text not null,
      created_at text not null
    );

    create index if not exists event_log_session_seq_idx
      on event_log(session_id, seq);

    create index if not exists event_log_type_idx
      on event_log(type, seq);
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
  table: "workspace_sessions" | "work_sessions" | "work_session_submissions" | "work_session_feedback" | "agent_registry" | "continuations" | "acp_runs",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
