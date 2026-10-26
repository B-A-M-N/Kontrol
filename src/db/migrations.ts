import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { getTableName, isTable } from "drizzle-orm";
import { DEFAULT_DIRECT_APPROVAL_REATTACH_GRACE_MS } from "../policy-approval-defaults.js";
import * as drizzleSchema from "./schema.js";

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
  { version: 51, name: "work-session-stable-chronology", up: migrateWorkSessionStableChronology },
  { version: 52, name: "client-mutation-receipts", up: migrateClientMutationReceipts },
  { version: 53, name: "backend-neutral-snapshot-identities", up: migrateBackendNeutralSnapshotIdentities },
  { version: 54, name: "work-session-terminal-at", up: migrateWorkSessionTerminalAt },
  { version: 55, name: "submission-checkpoint-coverage", up: migrateSubmissionCheckpointCoverage },
  { version: 56, name: "work-session-owner-context", up: migrateWorkSessionOwnerContext },
  { version: 57, name: "approval-owner-context", up: migrateApprovalOwnerContext },
  { version: 58, name: "approval-direct-operation-hash", up: migrateApprovalDirectOperationHash },
  { version: 59, name: "durable-telemetry-ingress", up: migrateDurableTelemetryIngress },
  { version: 60, name: "managed-worktree-retirement", up: migrateManagedWorktreeRetirement },
  { version: 61, name: "telemetry-ingress-retention-index", up: migrateTelemetryIngressRetentionIndex },
  { version: 62, name: "mission-outcome-authority", up: migrateMissionOutcomeAuthority },
  { version: 63, name: "canonical-snapshot-report-identity", up: migrateCanonicalSnapshotReportIdentity },
  { version: 64, name: "mission-evidence-attempt-ordering", up: migrateMissionEvidenceAttemptOrdering },
  { version: 65, name: "mission-evidence-mission-wide-attempt-ordering", up: migrateMissionEvidenceMissionWideAttemptOrdering },
  { version: 66, name: "mission-outcome-observations", up: migrateMissionOutcomeObservations },
  { version: 67, name: "scheduled-job-lifecycle", up: migrateScheduledJobLifecycle },
  { version: 68, name: "agent-reply-delivery", up: migrateAgentReplyDelivery },
  { version: 69, name: "review-handoff-routing", up: migrateReviewHandoffRouting },
  { version: 70, name: "dispatch-outbox-claim-fencing", up: migrateDispatchOutboxClaimFencing },
  { version: 71, name: "supervisor-oscillation-fingerprints", up: migrateSupervisorOscillationFingerprints },
  { version: 72, name: "review-route-session-uniqueness", up: migrateReviewRouteSessionUniqueness },
  { version: 73, name: "scheduled-dispatch-fencing", up: migrateScheduledDispatchFencing },
  { version: 74, name: "scheduled-dispatch-outcome-separation", up: migrateScheduledDispatchOutcomeSeparation },
  { version: 75, name: "acp-dispatch-idempotency-lookup", up: migrateAcpDispatchIdempotencyLookup },
  { version: 76, name: "scheduled-job-owner-cursors", up: migrateScheduledJobOwnerCursors },
  { version: 77, name: "scheduled-job-cancellation-state", up: migrateScheduledJobCancellationState },
  { version: 78, name: "scheduled-job-acp-attempt-identity", up: migrateScheduledJobAcpAttemptIdentity },
  { version: 79, name: "scheduled-job-immutable-reports", up: migrateScheduledJobImmutableReports },
  { version: 80, name: "scheduled-job-execution-accounting", up: migrateScheduledJobExecutionAccounting },
  { version: 81, name: "acp-run-scheduled-execution-mode", up: migrateAcpRunScheduledExecutionMode },
  { version: 82, name: "scheduled-job-result-ownership", up: migrateScheduledJobResultOwnership },
  { version: 83, name: "scheduled-state-times-and-verification-single-flight", up: migrateScheduledStateTimesAndVerificationSingleFlight },
  { version: 84, name: "mcp-qualification-evidence", up: migrateMcpQualificationEvidence },
  { version: 85, name: "external-catalog-observations-and-associations", up: migrateExternalCatalogObservationsAndAssociations },
  { version: 86, name: "work-session-principal-identity", up: migrateWorkSessionPrincipalIdentity },
  { version: 87, name: "scheduled-job-publication-receipts", up: migrateScheduledJobPublicationReceipts },
  { version: 88, name: "scheduled-job-reconcile-backoff", up: migrateScheduledJobReconcileBackoff },
  { version: 89, name: "historical-schema-drift-repair", up: migrateHistoricalSchemaDrift },
  { version: 90, name: "scheduled-dispatch-attempt-diagnostics", up: migrateScheduledDispatchAttemptDiagnostics },
  { version: 91, name: "persistent-review-threads", up: migratePersistentReviewThreads },
  { version: 92, name: "review-handoff-claim-leases", up: migrateReviewHandoffClaimLeases },
  { version: 93, name: "browser-review-transport", up: migrateBrowserReviewTransport },
  { version: 94, name: "review-browser-auth-state", up: migrateReviewerBrowserAuthState },
  { version: 95, name: "authenticated-outcome-observation-receipts", up: migrateAuthenticatedOutcomeObservationReceipts },
  { version: 96, name: "review-browser-attempt-recovery-receipts", up: migrateReviewBrowserAttemptRecoveryReceipts },
  { version: 97, name: "review-browser-generation-observations", up: migrateReviewBrowserGenerationObservations },
  { version: 98, name: "scheduler-error-fingerprint-index", up: migrateSchedulerErrorFingerprintIndex },
  { version: 99, name: "filesystem-snapshot-root-indexes", up: migrateFilesystemSnapshotRootIndexes },
  { version: 100, name: "sqlite-peer-job-storage", up: migratePeerJobStorage },
  { version: 101, name: "durable-agent-pty-bindings", up: migrateAgentPtyBindings },
  { version: 102, name: "acp-run-exact-input-task", up: migrateAcpRunExactInputTask },
  { version: 103, name: "review-browser-binding-revision-fence", up: migrateReviewBrowserBindingRevisionFence },
];

function migrateReviewBrowserBindingRevisionFence(sqlite: Database.Database): void {
  // Historical attempts do not have enough evidence to reconstruct which
  // exact conversation binding they observed. Leave their revision NULL so
  // transition/retry checks fail closed until the attempt is reconciled.
  addColumnIfMissing(sqlite, "review_browser_turns", "binding_revision", "integer");
}

function migrateAcpRunExactInputTask(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "acp_runs", "input_task", "text");
  addColumnIfMissing(sqlite, "acp_runs", "input_task_sha256", "text");
}

function migratePeerJobStorage(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists peer_jobs (
      job_id text primary key not null,
      peer_id text not null,
      status text not null,
      created_at text not null,
      task_class text not null,
      repository_id text not null,
      workspace_session_id text,
      work_session_id text,
      record_json text not null
    );
    create index if not exists peer_jobs_peer_created_cursor_idx
      on peer_jobs(peer_id, created_at, job_id);
    create index if not exists peer_jobs_peer_status_created_idx
      on peer_jobs(peer_id, status, created_at, job_id);
    create index if not exists peer_jobs_status_created_idx
      on peer_jobs(status, created_at, job_id);
    create index if not exists peer_jobs_work_session_idx
      on peer_jobs(work_session_id, job_id);

    create table if not exists peer_job_attempts (
      attempt_id text primary key not null,
      job_id text not null references peer_jobs(job_id) on delete cascade,
      status text not null,
      generation integer not null,
      created_at text not null,
      lease_expires_at text not null,
      outcome_certainty text not null,
      record_json text not null
    );
    create index if not exists peer_job_attempts_job_created_idx
      on peer_job_attempts(job_id, created_at, attempt_id);
    create index if not exists peer_job_attempts_job_generation_idx
      on peer_job_attempts(job_id, generation);
    create index if not exists peer_job_attempts_active_lease_idx
      on peer_job_attempts(status, lease_expires_at, attempt_id);

    create table if not exists peer_job_store_metadata (
      key text primary key not null,
      value text not null
    );
  `);
}

function migrateAgentPtyBindings(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists agent_pty_bindings (
      id text primary key not null,
      process_session_id text not null unique,
      workspace_session_id text not null references workspace_sessions(id) on delete cascade,
      work_session_id text not null references work_sessions(id) on delete cascade,
      run_id text not null references acp_runs(run_id) on delete restrict,
      agent_name text not null,
      owner_principal_id text not null,
      process_generation integer not null,
      output_cursor integer not null default 0,
      status text not null,
      created_at text not null,
      updated_at text not null,
      finished_at text,
      unique (work_session_id, process_generation)
    );
    create index if not exists agent_pty_bindings_work_session_idx
      on agent_pty_bindings(work_session_id, created_at, id);
    create index if not exists agent_pty_bindings_run_idx
      on agent_pty_bindings(run_id, process_generation);
    create index if not exists agent_pty_bindings_status_idx
      on agent_pty_bindings(status, updated_at);
  `);
}

function migrateReviewerBrowserAuthState(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "review_browser_profiles", "auth_state", "text not null default 'unknown'");
}

function migrateAuthenticatedOutcomeObservationReceipts(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "mission_outcome_observations", "review_epoch", "integer");
  addColumnIfMissing(sqlite, "mission_outcome_observations", "observer_principal_id", "text");
  addColumnIfMissing(sqlite, "mission_outcome_observations", "observation_source", "text not null default 'legacy_operator_reported'");
  addColumnIfMissing(sqlite, "mission_outcome_observations", "external_evidence_sha256", "text");
}

function migrateReviewBrowserAttemptRecoveryReceipts(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists review_browser_turn_resolutions (
      attempt_id text primary key not null references review_browser_turns(id) on delete cascade,
      review_thread_id text not null,
      route_epoch integer not null,
      reviewer_principal_id text not null,
      resolution text not null,
      evidence_sha256 text not null,
      created_at text not null
    );
    create index if not exists review_browser_turn_resolutions_thread_idx
      on review_browser_turn_resolutions(review_thread_id, created_at);
  `);
}

function migrateReviewBrowserGenerationObservations(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "review_browser_turns", "generation_started_at", "text");
  addColumnIfMissing(sqlite, "review_browser_turns", "generation_started_observation_id", "text");
  addColumnIfMissing(sqlite, "review_browser_turns", "generation_finished_observation_id", "text");
}

function migrateBrowserReviewTransport(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "review_routes", "delivery_transport", "text not null default 'mcp_app'");
  addColumnIfMissing(sqlite, "review_routes", "browser_profile_id", "text");
  for (const [column, definition] of [
    ["reviewer_binding_id", "text"], ["browser_profile_id", "text"], ["browser_generation", "integer"],
    ["browser_target_id", "text"], ["browser_cdp_session_id", "text"], ["conversation_url", "text"],
    ["conversation_key", "text"], ["conversation_fingerprint", "text"], ["conversation_binding_revision", "integer"],
    ["conversation_binding_status", "text"], ["conversation_binding_assurance", "text"],
    ["resume_challenge_sha256", "text"], ["resume_challenge_expires_at", "text"],
    ["binding_generation", "integer not null default 0"],
  ] as const) {
    const columns = sqlite.prepare("pragma table_info(review_threads)").all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) sqlite.exec(`alter table review_threads add column ${column} ${definition}`);
  }
  sqlite.exec(`
    create table if not exists review_browser_turns (
      id text primary key not null,
      review_message_id text not null references review_thread_messages(id) on delete cascade,
      review_thread_id text not null,
      route_epoch integer not null,
      profile_id text not null,
      conversation_fingerprint text not null,
      attempt_number integer not null,
      browser_generation integer,
      lease_owner text,
      lease_expires_at text,
      lease_token_sha256 text,
      state text not null,
      prompt_sha256 text not null,
      baseline_user_message_count integer,
      baseline_assistant_message_count integer,
      submitted_at text,
      generation_finished_at text,
      feedback_committed_at text,
      error_code text,
      created_at text not null,
      unique(review_message_id, attempt_number)
    );
    create index if not exists review_browser_turns_state_lease_idx
      on review_browser_turns(state, lease_expires_at);
    create unique index if not exists review_browser_turns_message_active_unique
      on review_browser_turns(review_message_id)
      where state in ('leased', 'browser_ready', 'dispatching', 'prompt_accepted', 'model_generating', 'generation_finished', 'awaiting_feedback', 'uncertain');
    create unique index if not exists review_browser_turns_thread_active_unique
      on review_browser_turns(review_thread_id)
      where state in ('leased', 'browser_ready', 'dispatching', 'prompt_accepted', 'model_generating', 'generation_finished', 'awaiting_feedback', 'uncertain');
    create table if not exists review_browser_profiles (
      id text primary key not null,
      owner_principal_id text not null,
      browser_engine text not null default 'chromium',
      mode text not null default 'headed',
      status text not null default 'stopped',
      generation integer not null default 0,
      last_verified_at text,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists review_browser_profiles_owner_idx
      on review_browser_profiles(owner_principal_id, status);
  `);
}

function migrateReviewHandoffClaimLeases(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "review_handoffs", "claim_expires_at", "text");
  sqlite.exec(`
    update review_handoffs
       set claim_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+15 minutes')
     where status = 'claimed' and claimed_at is not null and claim_expires_at is null;
    update review_handoffs
       set claim_expires_at = '1970-01-01T00:00:00.000Z'
     where status = 'claimed' and claimed_at is null and claim_expires_at is null;
  `);
}

function migratePersistentReviewThreads(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "review_routes", "admitted_review_rounds", "integer not null default 0");
  sqlite.exec(`
    update review_routes
       set admitted_review_rounds = max(admitted_review_rounds, completed_review_rounds),
           completed_review_rounds = (
             select count(*) from review_handoffs h
              where h.route_id = review_routes.id and h.status = 'feedback_committed'
           );
  `);
  sqlite.exec(`
    create table if not exists review_threads (
      id text primary key not null,
      route_id text not null references review_routes(id) on delete cascade,
      route_epoch integer not null,
      work_session_id text not null references work_sessions(id) on delete cascade,
      owner_principal_id text not null,
      reviewer_principal_id text,
      reviewer_context_id text,
      host_kind text not null default 'kontrol_ui',
      host_conversation_id text,
      host_binding_verified integer not null default 0,
      status text not null default 'pending_activation',
      max_rounds integer not null,
      revision integer not null default 1,
      created_at text not null,
      activated_at text,
      closed_at text
    );
    create unique index if not exists review_threads_route_epoch_unique
      on review_threads(route_id, route_epoch);
    create index if not exists review_threads_session_status_idx
      on review_threads(work_session_id, status);
    create table if not exists review_thread_activations (
      id text primary key not null,
      thread_id text not null references review_threads(id) on delete cascade,
      route_id text not null,
      route_epoch integer not null,
      principal_id text not null,
      activation_secret_sha256 text not null unique,
      created_at text not null,
      expires_at text not null,
      consumed_at text,
      revoked_at text
    );
    create index if not exists review_thread_activations_thread_expiry_idx
      on review_thread_activations(thread_id, expires_at);
    create table if not exists review_thread_messages (
      id text primary key not null,
      thread_id text not null references review_threads(id) on delete cascade,
      route_epoch integer not null,
      work_session_id text not null,
      handoff_id text not null,
      submission_id text not null,
      review_epoch integer not null,
      round_number integer not null,
      kind text not null,
      payload_json text not null,
      payload_sha256 text not null,
      status text not null default 'awaiting_activation',
      revision integer not null default 1,
      created_at text not null,
      updated_at text not null
    );
    create unique index if not exists review_thread_messages_submission_unique
      on review_thread_messages(thread_id, submission_id, review_epoch);
    create index if not exists review_thread_messages_delivery_idx
      on review_thread_messages(thread_id, status, created_at);
  `);
}

function migrateScheduledStateTimesAndVerificationSingleFlight(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "scheduled_jobs", "terminal_at", "text");
  addColumnIfMissing(sqlite, "scheduled_jobs", "blocked_at", "text");
  addColumnIfMissing(sqlite, "scheduled_jobs", "operator_intervention_at", "text");
  addColumnIfMissing(sqlite, "scheduled_jobs", "last_state_changed_at", "text");
  sqlite.exec(`
    with ranked as (
      select id,
             row_number() over (
               partition by job_id, work_session_id, submission_id, review_epoch,
                            snapshot_kind, snapshot_ref, command_fingerprint, policy_fingerprint
               order by created_at, id
             ) as position
        from scheduled_job_verifications
       where status = 'running'
    )
    update scheduled_job_verifications
       set status = 'failed',
           failure_reason = 'Superseded while installing the single-flight verification policy.',
           finished_at = coalesce(finished_at, created_at)
     where id in (select id from ranked where position > 1);

    create unique index if not exists scheduled_job_verifications_active_identity_unique
      on scheduled_job_verifications(
        job_id, work_session_id, submission_id, review_epoch,
        snapshot_kind, snapshot_ref, command_fingerprint, policy_fingerprint
      ) where status = 'running';
  `);
}

function migrateScheduledJobResultOwnership(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "scheduled_jobs", "dispatch_retry_count", "integer not null default 0");
  addColumnIfMissing(sqlite, "scheduled_jobs", "dispatch_next_eligible_at", "text");
  addColumnIfMissing(sqlite, "scheduled_jobs", "dispatch_last_attempted_agent", "text");
  addColumnIfMissing(sqlite, "scheduled_jobs", "dispatch_blocker_kind", "text");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "worker_execution_outcome", "text");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "worker_execution_at", "text");
  sqlite.exec(`
    create table if not exists scheduled_job_verifications (
      id text primary key,
      job_id text not null references scheduled_jobs(id) on delete cascade,
      request_key text not null,
      request_fingerprint text not null,
      client_mutation_id text,
      execution_identity text not null unique,
      work_session_id text not null,
      submission_id text not null,
      review_epoch integer not null,
      snapshot_kind text not null,
      snapshot_ref text not null,
      command_fingerprint text not null,
      policy_fingerprint text not null,
      status text not null default 'running',
      deadline_at text not null,
      report_sha256 text,
      report_text text,
      failure_reason text,
      created_at text not null,
      started_at text not null,
      finished_at text
    );
    create unique index if not exists scheduled_job_verifications_request_unique
      on scheduled_job_verifications(job_id, request_key);
    create index if not exists scheduled_job_verifications_current_idx
      on scheduled_job_verifications(job_id, submission_id, review_epoch, created_at);
    create index if not exists scheduled_job_verifications_status_deadline_idx
      on scheduled_job_verifications(status, deadline_at, id);
    create index if not exists scheduled_job_verifications_hash_idx
      on scheduled_job_verifications(job_id, report_sha256);

    create table if not exists scheduled_job_report_finalizations (
      id text primary key,
      job_id text not null references scheduled_jobs(id) on delete cascade,
      run_id text not null,
      attempt_number integer not null,
      event_id text not null,
      status text not null default 'pending',
      report_text text,
      report_sha256 text,
      last_error text,
      created_at text not null,
      updated_at text not null
    );
    create unique index if not exists scheduled_job_report_finalizations_attempt_unique
      on scheduled_job_report_finalizations(job_id, run_id, attempt_number);
    create index if not exists scheduled_job_report_finalizations_pending_idx
      on scheduled_job_report_finalizations(status, updated_at, id);
  `);
}

function migrateAcpRunScheduledExecutionMode(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "acp_runs", "scheduled_execution_mode", "text");
  sqlite.exec(`
    update acp_runs
       set scheduled_execution_mode = 'read_only_audit'
     where scheduled_execution_mode is null
       and exists (
         select 1 from scheduled_jobs job
          where job.work_session_id = acp_runs.work_session_id
            and job.execution_mode = 'read_only_audit'
       )
  `);
}

function migrateScheduledJobAcpAttemptIdentity(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "acp_dispatch_id", "text");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "acp_attempt_number", "integer");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "acp_remote_run_id", "text");
  sqlite.exec(`
    update scheduled_job_attempts
       set acp_dispatch_id = coalesce(acp_dispatch_id, dispatch_id)
     where acp_run_id is not null;
  `);
}

function migrateScheduledJobImmutableReports(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists scheduled_job_reports (
      id text primary key,
      job_id text not null references scheduled_jobs(id) on delete cascade,
      run_id text not null,
      report_sha256 text not null,
      report_text text not null,
      created_at text not null
    );
    create unique index if not exists scheduled_job_reports_job_run_unique
      on scheduled_job_reports(job_id, run_id);
    create index if not exists scheduled_job_reports_hash_idx
      on scheduled_job_reports(job_id, report_sha256);
  `);
}

function migrateScheduledJobExecutionAccounting(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "execution_started_at", "text");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "execution_active_since", "text");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "active_runtime_ms", "integer not null default 0");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "execution_stopped_at", "text");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "execution_receipt_json", "text");
  // Existing accepted workers predate authenticated start-event accounting.
  // Preserve their conservative dispatch-based deadline while all new attempts
  // start their execution clock only when the ACP start event is observed.
  sqlite.exec(`
    update scheduled_job_attempts
       set execution_started_at = coalesce(execution_started_at, started_at),
           execution_active_since = coalesce(execution_active_since, started_at)
     where completed_at is null
       and transport_status = 'accepted'
       and exists (
         select 1 from scheduled_jobs job
          where job.active_dispatch_attempt_id = scheduled_job_attempts.id
            and job.status = 'running'
       )
  `);
}

// v64: verification attempts need durable monotonic ordering because ISO
// timestamps can collide. Backfill attempts within each evidence scope from
// chronological order; newer records then receive an explicit attempt number
// assigned by the ledger before insertion.
// v64: outcome evidence strength is part of the durable contract so a mission
// cannot silently lower its required independent evidence level after creation.
function migrateMissionEvidenceAttemptOrdering(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "mission_contracts", "outcome_evidence", "text");
  addColumnIfMissing(sqlite, "mission_evidence", "attempt", "integer");
  sqlite.exec(`
    with scoped as (
      select rowid, row_number() over (
        partition by mission_id, coalesce(criterion_id, finding_id, '(mission)')
        order by created_at, rowid
      ) as attempt
      from mission_evidence
      where attempt is null
    )
    update mission_evidence
       set attempt = (select attempt from scoped where scoped.rowid = mission_evidence.rowid)
     where attempt is null;
  `);
  sqlite.exec("create index if not exists mission_evidence_attempt_idx on mission_evidence(mission_id, criterion_id, finding_id, attempt)");
}

// v65: replace per-criterion/finding attempt scopes with one mission-wide
// monotonic sequence. Dual-associated evidence allocated through a different
// scope key must not outrank a later observation. Backfill uses durable
// insertion order (rowid), then enforces uniqueness for non-null attempts.
function migrateMissionEvidenceMissionWideAttemptOrdering(sqlite: Database.Database): void {
  // Re-backfill every mission from rowid order because the v64 scoped
  // backfill may have already assigned per-scope attempts that are not
  // globally unique, and "attempt is null" filtering would skip them.
  sqlite.exec(`
    with mission_wide as (
      select rowid, row_number() over (
        partition by mission_id
        order by created_at, rowid
      ) as attempt
      from mission_evidence
    )
    update mission_evidence
       set attempt = (select attempt from mission_wide where mission_wide.rowid = mission_evidence.rowid);
  `);
  // A unique index independently detects duplicate attempt assignment even
  // if a nontransactional writer races the select-then-insert sequence.
  sqlite.exec("create unique index if not exists mission_evidence_attempt_unique_idx on mission_evidence(mission_id, attempt) where attempt is not null");
}

// v69: submission-scoped review handoffs and explicit routing modes. Legacy
// sessions default to isolated/manual review; no background ChatGPT injection.
function migrateReviewHandoffRouting(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists review_routes (
      id text primary key,
      work_session_id text not null references work_sessions(id) on delete cascade,
      owner_principal_id text not null,
      owner_context_id text not null,
      mode text not null default 'isolated_review',
      delivery_policy text not null default 'explicit_user_action',
      pinned_conversation_id text,
      max_review_rounds integer not null default 3,
      completed_review_rounds integer not null default 0,
      status text not null default 'disabled',
      route_epoch integer not null default 1,
      revision integer not null default 1,
      warning_acknowledged_at text,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists review_routes_work_session_idx
      on review_routes(work_session_id, status);
    create unique index if not exists review_routes_work_session_unique
      on review_routes(work_session_id);
    create table if not exists review_handoffs (
      id text primary key,
      route_id text not null references review_routes(id) on delete cascade,
      work_session_id text not null references work_sessions(id) on delete cascade,
      submission_id text not null,
      review_epoch integer not null,
      snapshot_kind text not null,
      snapshot_ref text not null,
      diff_sha256 text not null,
      route_epoch integer not null,
      round_number integer not null,
      destination_conversation_id text,
      claimed_by_principal_id text,
      claimed_by_owner_context_id text,
      status text not null default 'queued',
      revision integer not null default 1,
      created_at text not null,
      claimed_at text,
      completed_at text
    );
    create index if not exists review_handoffs_session_submission_idx
      on review_handoffs(work_session_id, submission_id);
    create index if not exists review_handoffs_status_idx
      on review_handoffs(status, created_at);
    create unique index if not exists review_handoffs_submission_active_unique
      on review_handoffs(submission_id, review_epoch);
  `);
}

// v68: immutable reviewer replies and durable cold-start waiting intent. Legacy
// resolved messages are deliberately not treated as verified deliveries.
function migrateAgentReplyDelivery(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists agent_message_replies (
      id text primary key,
      message_id text not null references agent_messages(id) on delete cascade,
      work_session_id text not null references work_sessions(id) on delete cascade,
      reply_revision integer not null default 1,
      body text not null,
      body_sha256 text not null,
      reviewer_principal_id text not null,
      status text not null default 'pending_delivery',
      created_at text not null,
      acknowledged_at text,
      acknowledged_run_id text,
      acknowledged_attempt integer,
      acknowledged_actor_id text
    );
    create unique index if not exists agent_message_replies_message_revision_unique
      on agent_message_replies(message_id, reply_revision);
    create index if not exists agent_message_replies_session_idx
      on agent_message_replies(work_session_id, status);
    create table if not exists agent_reply_waits (
      id text primary key,
      message_id text not null references agent_messages(id) on delete cascade,
      work_session_id text not null references work_sessions(id) on delete cascade,
      run_id text,
      worker_attempt integer not null default 1,
      expects_reply integer not null default 1,
      resume_on_reply integer not null default 0,
      active integer not null default 1,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists agent_reply_waits_message_active_idx
      on agent_reply_waits(message_id, active);
    create index if not exists agent_reply_waits_session_idx
      on agent_reply_waits(work_session_id, active);
  `);
}

// v67: durable one-shot scheduled jobs. Each committed job has an atomic
// outbox wakeup, an immutable instruction/policy record, and attempts bounded
// by a CAS revision state machine.
function migrateScheduledJobLifecycle(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists scheduled_jobs (
      id text primary key,
      principal_id text not null,
      owner_context_id text not null,
      project_id text not null,
      workspace_root text not null,
      run_at text not null,
      instruction_json text not null,
      execution_mode text not null default 'read_only_audit',
      policy_snapshot_json text not null,
      agent_name text,
      status text not null default 'pending',
      revision integer not null default 1,
      work_session_id text,
      max_runtime_ms integer not null,
      client_mutation_id text,
      request_fingerprint text not null default '{}',
      last_error text,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists scheduled_jobs_status_due_idx
      on scheduled_jobs(status, run_at);
    create index if not exists scheduled_jobs_owner_idx
      on scheduled_jobs(owner_context_id, run_at);
    create unique index if not exists scheduled_jobs_principal_mutation_unique
      on scheduled_jobs(principal_id, client_mutation_id)
      where client_mutation_id is not null;
    create table if not exists scheduled_job_attempts (
      id text primary key,
      job_id text not null references scheduled_jobs(id) on delete cascade,
      dispatch_id text not null,
      started_at text not null,
      completed_at text,
      agent_name text,
      acp_run_id text,
      outcome text
    );
    create index if not exists scheduled_job_attempts_job_idx
      on scheduled_job_attempts(job_id, started_at);
  `);
}

// v66: independent outcome observations. A mission that demands
// outcome_verified or operationally_stable evidence cannot be satisfied by a
// passing integration report alone; it needs an explicit external-observer
// receipt bound to the exact submitted snapshot.
function migrateMissionOutcomeObservations(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists mission_outcome_observations (
      id text primary key,
      mission_id text not null references mission_contracts(id) on delete cascade,
      submission_id text not null,
      snapshot_kind text not null,
      snapshot_ref text not null,
      observer_identity text not null,
      expected_behavior text not null,
      actual_behavior text not null,
      status text not null,
      observed_at text not null,
      observation_sha256 text not null
    );
  `);
  sqlite.exec("create index if not exists mission_outcome_observations_current_idx on mission_outcome_observations(mission_id, submission_id, snapshot_ref, observed_at)");
  addColumnIfMissing(sqlite, "mission_contracts", "outcome_expected_behavior", "text");
}

function migrateCanonicalSnapshotReportIdentity(sqlite: Database.Database): void {
  const pairs: Array<[table: string, kind: string, ref: string, legacy: string]> = [
    ["work_session_submissions", "snapshot_kind", "snapshot_ref", "snapshot_commit"],
    ["mission_evidence", "snapshot_kind", "snapshot_ref", "snapshot_commit"],
    ["mission_completion_reports", "snapshot_kind", "snapshot_ref", "snapshot_commit"],
    ["mission_contracts", "baseline_kind", "baseline_ref", "baseline_commit"],
    ["supervisor_runs", "last_snapshot_kind", "last_snapshot_ref", "last_snapshot_commit"],
  ];
  for (const [table, kind, ref, legacy] of pairs) {
    sqlite.exec(`
      update ${table}
         set ${ref} = coalesce(nullif(trim(${ref}), ''), nullif(trim(${legacy}), '')),
             ${kind} = coalesce(nullif(trim(${kind}), ''), case
               when coalesce(nullif(trim(${ref}), ''), nullif(trim(${legacy}), '')) like 'fs:%' then 'filesystem'
               else 'git'
             end)
       where nullif(trim(${legacy}), '') is not null
         and (nullif(trim(${ref}), '') is null or nullif(trim(${kind}), '') is null)
    `);
  }
  sqlite.exec(`
    create index if not exists mission_completion_reports_identity_idx
      on mission_completion_reports(mission_id, submission_id, snapshot_kind, snapshot_ref, created_at desc)
  `);
}

function migrateMissionOutcomeAuthority(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "mission_contracts", "contract_fingerprint", "text");
  addColumnIfMissing(sqlite, "mission_acceptance_criteria", "runtime_probe_json", "text");
  addColumnIfMissing(sqlite, "mission_review_findings", "resolution_evidence_json", "text not null default '[]'");
  addColumnIfMissing(sqlite, "mission_evidence", "finding_id", "text");
  sqlite.exec("create index if not exists mission_evidence_finding_idx on mission_evidence(finding_id, created_at)");
  sqlite.exec("update mission_acceptance_criteria set verification_type = 'test' where verification_type = 'manual_review' and verification_command is not null");
}

function migrateApprovalDirectOperationHash(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "approval_requests", "operation_hash", "text");
  sqlite.exec("create index if not exists approval_requests_direct_operation_idx on approval_requests(principal_id, workspace_session_id, owner_context_id, operation_hash, status, consumed_at)");
}

function migrateDurableTelemetryIngress(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists telemetry_ingress (
      sequence integer primary key autoincrement,
      event_id text not null unique,
      session_id text not null,
      workspace_session_id text,
      type text not null,
      payload_json text,
      payload_sha256 text not null,
      publish integer not null default 1,
      status text not null default 'pending',
      event_log_id text,
      received_at text not null,
      committed_at text
    );
    create index if not exists telemetry_ingress_pending_idx on telemetry_ingress(status, sequence);
    create index if not exists telemetry_ingress_session_idx on telemetry_ingress(session_id, status, sequence);
    create index if not exists telemetry_ingress_event_log_idx on telemetry_ingress(event_log_id);
  `);
}

function migrateManagedWorktreeRetirement(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "workspace_sessions", "retired_at", "text");
  sqlite.exec(`
    create index if not exists workspace_managed_lifecycle_idx
      on workspace_sessions(mode, managed, status, retired_at);
    create index if not exists workspace_managed_lifecycle_created_idx
      on workspace_sessions(mode, managed, status, created_at, id);
  `);
}

function migrateTelemetryIngressRetentionIndex(sqlite: Database.Database): void {
  sqlite.exec("create index if not exists telemetry_ingress_retention_idx on telemetry_ingress(status, committed_at, sequence)");
}

// P1 (audit): checkpoint coverage blind spots. A structured mutation into a
// location the review checkpoint cannot represent (excluded/generated trees,
// git-ignored material) must travel with the submission so the reviewer sees
// exactly which paths are outside checkpoint coverage and an ordinary
// approval is refused until they explicitly accept that condition.
function migrateSubmissionCheckpointCoverage(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "work_session_submissions", "coverage_json", "text");
}

function migrateClientMutationReceipts(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists client_mutation_receipts (
      principal_id text not null,
      operation text not null,
      client_mutation_id text not null,
      request_hash text not null,
      status text not null default 'pending',
      result_json text,
      created_at text not null,
      updated_at text not null,
      primary key (principal_id, operation, client_mutation_id)
    );
    create index if not exists client_mutation_receipts_updated_idx
      on client_mutation_receipts(updated_at);
  `);
}

function migrateBackendNeutralSnapshotIdentities(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "work_session_submissions", "snapshot_kind", "text");
  addColumnIfMissing(sqlite, "work_session_submissions", "snapshot_ref", "text");
  addColumnIfMissing(sqlite, "mission_contracts", "baseline_kind", "text");
  addColumnIfMissing(sqlite, "mission_contracts", "baseline_ref", "text");
  addColumnIfMissing(sqlite, "mission_evidence", "snapshot_kind", "text");
  addColumnIfMissing(sqlite, "mission_evidence", "snapshot_ref", "text");
  addColumnIfMissing(sqlite, "mission_completion_reports", "snapshot_kind", "text");
  addColumnIfMissing(sqlite, "mission_completion_reports", "snapshot_ref", "text");
  addColumnIfMissing(sqlite, "supervisor_runs", "last_snapshot_kind", "text");
  addColumnIfMissing(sqlite, "supervisor_runs", "last_snapshot_ref", "text");
}

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

/** Ordered migration chain (exported for migration fixture tests). */
export const migrationChain = migrations;

/** Canonical current schema version — readiness requires exact equality. */
export const LATEST_SCHEMA_VERSION = migrations[migrations.length - 1]!.version;

export interface DatabaseSchemaContract {
  ok: boolean;
  appliedVersion: number;
  expectedVersion: number;
  deployedBuildId?: string;
  expectedTableCount: number;
  missing: Array<{ table: string; columns?: string[] }>;
}

/**
 * Compare every exported Drizzle table and column with the live SQLite schema.
 * Migration history alone is not proof that historical migration source still
 * matches what an existing database actually received.
 */
export function inspectDatabaseSchemaContract(
  sqlite: Database.Database,
  options: { deployedBuildId?: string } = {},
): DatabaseSchemaContract {
  let appliedVersion = 0;
  try {
    const row = sqlite.prepare("select max(version) as version from kontrol_schema_migrations").get() as { version?: number } | undefined;
    appliedVersion = Number(row?.version ?? 0);
  } catch {
    appliedVersion = 0;
  }

  const missing: DatabaseSchemaContract["missing"] = [];
  const columnsSymbol = Symbol.for("drizzle:Columns");
  const tables = Object.values(drizzleSchema).filter((value) => isTable(value));
  for (const table of tables) {
    const tableName = getTableName(table);
    const expectedColumns = Object.values(
      (table as unknown as Record<symbol, Record<string, { name: string }>>)[columnsSymbol] ?? {},
    ).map((column) => column.name);
    const quotedName = tableName.replaceAll('"', '""');
    const deployedColumns = new Set(
      (sqlite.prepare(`pragma table_info("${quotedName}")`).all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (deployedColumns.size === 0) {
      missing.push({ table: tableName, columns: expectedColumns });
      continue;
    }
    const missingColumns = expectedColumns.filter((column) => !deployedColumns.has(column));
    if (missingColumns.length) missing.push({ table: tableName, columns: missingColumns });
  }

  return {
    ok: appliedVersion === LATEST_SCHEMA_VERSION && missing.length === 0,
    appliedVersion,
    expectedVersion: LATEST_SCHEMA_VERSION,
    ...(options.deployedBuildId ? { deployedBuildId: options.deployedBuildId } : {}),
    expectedTableCount: tables.length,
    missing,
  };
}

export function assertDatabaseSchemaContract(
  sqlite: Database.Database,
  options: { deployedBuildId?: string } = {},
): DatabaseSchemaContract {
  const contract = inspectDatabaseSchemaContract(sqlite, options);
  if (!contract.ok) {
    throw new Error(`Database schema contract failed: ${JSON.stringify(contract)}`);
  }
  return contract;
}

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

export function migrateDatabase(sqlite: Database.Database, options: { deployedBuildId?: string } = {}): void {
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
  sqlite.prepare("select 1").get();
  assertDatabaseSchemaContract(sqlite, options);
}

function migrateHistoricalSchemaDrift(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "mission_contracts", "outcome_evidence", "text");
  addColumnIfMissing(sqlite, "review_routes", "warning_acknowledged_at", "text");
}

function migrateScheduledDispatchAttemptDiagnostics(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "dispatch_failure_class", "text");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "dispatch_failure_reason", "text");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "dispatch_probe_result_json", "text");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "next_eligible_at", "text");
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

function migrateWorkSessionStableChronology(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "work_sessions", "last_consumed_review_epoch", "integer not null default 0");
  sqlite.exec(`
    create index if not exists work_session_tool_events_session_created_id_idx
      on work_session_tool_events(work_session_id, created_at desc, id desc);

    create index if not exists work_session_feedback_session_submission_idx
      on work_session_feedback(work_session_id, submission_id);
  `);
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

function migrateSchedulerErrorFingerprintIndex(sqlite: Database.Database): void {
  sqlite.exec(`
    create index if not exists event_log_scheduled_error_fingerprint_time_idx
      on event_log(type, json_extract(payload, '$.fingerprint'), created_at)
      where type = 'scheduled_job.scheduler_error';
  `);
}

function migrateFilesystemSnapshotRootIndexes(sqlite: Database.Database): void {
  sqlite.exec(`
    create index if not exists wss_filesystem_snapshot_roots_idx
      on work_session_submissions(snapshot_ref, work_session_id)
      where snapshot_kind = 'filesystem' and snapshot_ref is not null;
    create index if not exists mission_evidence_filesystem_snapshot_roots_idx
      on mission_evidence(snapshot_ref)
      where snapshot_kind = 'filesystem' and snapshot_ref is not null;
    create index if not exists mission_completion_reports_filesystem_snapshot_roots_idx
      on mission_completion_reports(snapshot_ref)
      where snapshot_kind = 'filesystem' and snapshot_ref is not null;
    create index if not exists supervisor_runs_filesystem_snapshot_roots_idx
      on supervisor_runs(last_snapshot_ref)
      where last_snapshot_kind = 'filesystem' and last_snapshot_ref is not null;
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
/**
 * v70 (F01): fencing token for claimed outbox events. `markCompleted`,
 * `release`, and `markFailed` previously accepted a bare event id, so a
 * claimant whose lease expired and whose event was re-claimed by another
 * worker could still acknowledge the new claimant's work. Every claimed
 * transition now requires the exact `claim_token` minted by the claiming
 * `claimNext()` CAS. Pre-existing claimed rows have no token and therefore
 * cannot be acknowledged by a stale holder; they are reaped back to pending
 * and re-claimed with a fresh token.
 */
/**
 * v71 (C04): accumulate distinct unresolved failure fingerprints so an
 * alternating break/restore cycle (A, B, A, B, ...) is detected even though it
 * resets the consecutive-fingerprint counter on every alternation.
 */
function migrateSupervisorOscillationFingerprints(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "supervisor_runs", "failure_fingerprint_set_json", "text not null default '{}'");
}

function migrateScheduledDispatchFencing(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "scheduled_jobs", "active_dispatch_attempt_id", "text");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "dispatcher_instance_id", "text");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "lease_expires_at", "text");
  sqlite.exec(`
    create index if not exists scheduled_job_attempts_incomplete_idx
      on scheduled_job_attempts(job_id, completed_at);
    create index if not exists scheduled_jobs_active_attempt_idx
      on scheduled_jobs(active_dispatch_attempt_id);
  `);
}

function migrateScheduledDispatchOutcomeSeparation(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "scheduled_jobs", "lifecycle_event_cursor", "integer not null default 0");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "transport_status", "text not null default 'dispatching'");
  sqlite.exec(`
    update scheduled_job_attempts
       set transport_status = case outcome
         when 'dispatched' then 'accepted'
         when 'uncertain' then 'uncertain'
         when 'failed' then 'rejected'
         when 'released' then 'unstarted'
         else transport_status
       end;

    -- For jobs that are still executing or waiting for review, the legacy
    -- completed_at/outcome pair only recorded adapter acceptance. Reopen that
    -- attempt's worker outcome so a later durable lifecycle event can close it.
    update scheduled_job_attempts
       set completed_at = null, outcome = null, transport_status = 'accepted'
     where id in (
       select attempt.id
         from scheduled_job_attempts attempt
         join scheduled_jobs job on job.id = attempt.job_id
        where attempt.outcome = 'dispatched'
          and job.status in ('running','awaiting_approval','cancellation_requested')
     );

    -- Repair rows written by the previous uncertain-dispatch implementation:
    -- it completed the attempt and cleared its only job association. Restore
    -- the latest uncertain attempt as the active reconciliation target.
    update scheduled_jobs
       set active_dispatch_attempt_id = (
         select attempt.id
           from scheduled_job_attempts attempt
          where attempt.job_id = scheduled_jobs.id
            and attempt.outcome = 'uncertain'
          order by attempt.started_at desc, attempt.id desc
          limit 1
       )
     where scheduled_jobs.status = 'uncertain_dispatch'
       and scheduled_jobs.active_dispatch_attempt_id is null
       and exists (
         select 1 from scheduled_job_attempts attempt
          where attempt.job_id = scheduled_jobs.id and attempt.outcome = 'uncertain'
       );

    update scheduled_job_attempts
       set completed_at = null, outcome = null, transport_status = 'uncertain'
     where id in (
       select active_dispatch_attempt_id from scheduled_jobs
        where status = 'uncertain_dispatch' and active_dispatch_attempt_id is not null
     );

    create index if not exists scheduled_jobs_work_session_idx on scheduled_jobs(work_session_id, id);
    create index if not exists scheduled_jobs_projection_idx on scheduled_jobs(status, work_session_id, id);
  `);
}

function migrateAcpDispatchIdempotencyLookup(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists acp_run_dispatch_attempts (
      dispatch_idempotency_key text primary key,
      run_id text not null references acp_runs(run_id) on delete cascade,
      agent_id text,
      attempt_number integer not null,
      remote_run_id text,
      status text not null default 'dispatching',
      created_at text not null,
      updated_at text not null,
      unique (run_id, attempt_number)
    );
    create index if not exists acp_run_dispatch_attempts_run_idx
      on acp_run_dispatch_attempts(run_id, attempt_number);
  `);
}

function migrateScheduledJobOwnerCursors(sqlite: Database.Database): void {
  sqlite.exec(`
    create index if not exists scheduled_jobs_owner_cursor_idx
      on scheduled_jobs(owner_context_id, id);
    create index if not exists scheduled_jobs_principal_cursor_idx
      on scheduled_jobs(principal_id, id);
  `);
}

function migrateScheduledJobCancellationState(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "scheduled_jobs", "cancellation_request_id", "text");
  addColumnIfMissing(sqlite, "scheduled_jobs", "cancellation_previous_status", "text");
  addColumnIfMissing(sqlite, "scheduled_jobs", "cancellation_requested_at", "text");
  addColumnIfMissing(sqlite, "scheduled_jobs", "cancellation_last_attempt_at", "text");
  addColumnIfMissing(sqlite, "scheduled_jobs", "cancellation_last_confirmed_state", "text");
  sqlite.exec(`
    update scheduled_jobs
       set cancellation_request_id = coalesce(cancellation_request_id, 'legacy-cancel:' || id),
           cancellation_requested_at = coalesce(cancellation_requested_at, updated_at),
           cancellation_last_confirmed_state = coalesce(cancellation_last_confirmed_state, 'unknown')
     where status = 'cancellation_requested';
  `);
  sqlite.exec("create index if not exists scheduled_jobs_cancellation_idx on scheduled_jobs(status, cancellation_last_attempt_at, id)");
}

function migrateReviewRouteSessionUniqueness(sqlite: Database.Database): void {
  // Enforce one durable review route per work session. Historical duplicates
  // retain their canonical route (oldest), and dependent handoffs remain
  // attached through the route-level cascade.
  sqlite.exec(`
    delete from review_routes
     where id not in (
       select keep.id from review_routes keep
       join (
         select work_session_id, min(id) as keep_id
           from review_routes
          group by work_session_id
       ) canonical on canonical.work_session_id = keep.work_session_id
        and canonical.keep_id = keep.id
     );
  `);
  sqlite.exec("create unique index if not exists review_routes_work_session_unique on review_routes(work_session_id)");
}

function migrateDispatchOutboxClaimFencing(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "dispatch_outbox", "claim_token", "text");
  // Any in-flight claim from an older binary carries no token and must not be
  // completed under the new fenced interface. Return it to pending so it is
  // picked up with a freshly minted token; the claim odometer already records
  // the interrupted attempt.
  sqlite.exec("update dispatch_outbox set status = 'pending', claimed_by = null, claim_expires_at = null where status = 'claimed' and claim_token is null");
}

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

// P0: terminal snapshot retention must age from the actual terminal moment,
// not from `updated_at` (mutable after terminal) or the snapshot manifest's
// filesystem mtime (which is capture time, so a 35-day session would look
// 35 days expired the day it terminates). Backfill existing terminal rows
// from updated_at: for rows already terminal at migration time that is the
// best available terminal timestamp, and it only lengthens retention.
function migrateWorkSessionTerminalAt(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "work_sessions", "terminal_at", "text");
  sqlite.exec(`
    update work_sessions
       set terminal_at = updated_at
     where terminal_at is null
       and status in ('approved', 'rejected', 'cancelled', 'failed', 'failed_protocol')
  `);
}

function migrateApprovalOwnerContext(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "approval_requests", "owner_context_id", "text");
  sqlite.exec("create index if not exists approval_requests_owner_context_idx on approval_requests(owner_context_id, status, created_at)");
}

function migrateWorkSessionOwnerContext(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "work_sessions", "owner_context_id", "text");
  sqlite.exec("create index if not exists work_sessions_owner_context_idx on work_sessions(owner_context_id, updated_at)");
}

function migrateMcpQualificationEvidence(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists mcp_qualification_evidence (
      record_id text primary key not null,
      record_type text not null check (record_type in ('catalog_acknowledgement', 'external_sse')),
      capture_id text,
      server_build_id text,
      server_version text not null,
      session_id_sha256 text not null,
      operation_id text,
      observed_at text not null,
      expires_at text not null,
      content_sha256 text not null,
      accepted integer,
      server_catalog_sha256 text,
      host_catalog_sha256 text,
      tool_count integer,
      rejection_reason text,
      http_method text,
      rpc_method text,
      tool_name text,
      started_at text,
      finished_at text,
      duration_ms integer,
      http_status integer,
      response_bytes integer,
      heartbeat_bytes integer,
      response_close_classification text,
      handler_still_running integer
    );
    create index if not exists mcp_qualification_evidence_build_idx
      on mcp_qualification_evidence(server_build_id, observed_at, record_id);
    create index if not exists mcp_qualification_evidence_capture_idx
      on mcp_qualification_evidence(capture_id, observed_at, record_id);
    create index if not exists mcp_qualification_evidence_session_idx
      on mcp_qualification_evidence(session_id_sha256, observed_at, record_id);
    create unique index if not exists mcp_qualification_evidence_operation_idx
      on mcp_qualification_evidence(operation_id) where operation_id is not null;
    create index if not exists mcp_qualification_evidence_expiry_idx
      on mcp_qualification_evidence(expires_at, observed_at);
  `);
}

// v86: durable authenticated principal on a work session. Conversation and
// transport context remain session-scope keys; this column lets a returned
// owner recover its own delegated job without making sessions globally readable.
function migrateWorkSessionPrincipalIdentity(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "work_sessions", "principal_id", "text");
  sqlite.exec(`
    create index if not exists work_sessions_principal_idx
      on work_sessions(principal_id, updated_at);
    update work_sessions
       set principal_id = owner_context_id
     where principal_id is null
       and owner_context_id like 'principal:%';
  `);
}

function migrateExternalCatalogObservationsAndAssociations(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists mcp_external_catalog_observations (
      record_id text primary key not null,
      capture_id text not null,
      host_kind text not null,
      server_build_id text,
      server_version text not null,
      session_id_sha256 text not null,
      captured_at text not null,
      submitted_at text not null,
      observation_source text not null check (observation_source in ('operator_reported')),
      status text not null check (status in ('host_capture_unsupported', 'operator_reported_match', 'operator_reported_mismatch')),
      server_catalog_sha256 text not null,
      host_catalog_sha256 text,
      host_tool_count integer,
      record_json text not null,
      content_sha256 text not null,
      work_session_id text,
      handoff_id text,
      expires_at text not null
    );
    create index if not exists mcp_external_catalog_observations_build_idx
      on mcp_external_catalog_observations(server_build_id, submitted_at, record_id);
    create index if not exists mcp_external_catalog_observations_capture_idx
      on mcp_external_catalog_observations(capture_id, submitted_at, record_id);
    create index if not exists mcp_external_catalog_observations_session_idx
      on mcp_external_catalog_observations(session_id_sha256, submitted_at, record_id);
    create index if not exists mcp_external_catalog_observations_handoff_idx
      on mcp_external_catalog_observations(handoff_id, submitted_at, record_id);
    create index if not exists mcp_external_catalog_observations_expiry_idx
      on mcp_external_catalog_observations(expires_at, submitted_at);

    create table if not exists mcp_qualification_associations (
      record_id text primary key not null,
      server_build_id text not null,
      capture_id text not null,
      session_id_sha256 text not null,
      soak_id text,
      observation_record_id text,
      acknowledgement_record_id text,
      external_sse_record_id text,
      created_at text not null,
      content_sha256 text not null,
      expires_at text not null
    );
    create index if not exists mcp_qualification_associations_build_idx
      on mcp_qualification_associations(server_build_id, created_at, record_id);
    create index if not exists mcp_qualification_associations_capture_idx
      on mcp_qualification_associations(capture_id, created_at, record_id);
    create index if not exists mcp_qualification_associations_session_idx
      on mcp_qualification_associations(session_id_sha256, created_at, record_id);
    create unique index if not exists mcp_qualification_associations_evidence_unique
      on mcp_qualification_associations(
        server_build_id,
        capture_id,
        session_id_sha256,
        acknowledgement_record_id,
        ifnull(external_sse_record_id, ''),
        ifnull(observation_record_id, ''),
        ifnull(soak_id, '')
      );
    create index if not exists mcp_qualification_associations_expiry_idx
      on mcp_qualification_associations(expires_at, created_at);

    create table if not exists review_handoff_external_catalog_attachments (
      attachment_id text primary key not null,
      observation_record_id text not null,
      work_session_id text not null,
      handoff_id text not null,
      reviewer_principal_id text not null,
      reviewer_owner_context_id text not null,
      investigation_direction text not null,
      attached_at text not null,
      content_sha256 text not null,
      expires_at text not null,
      unique (observation_record_id, handoff_id)
    );
    create index if not exists review_handoff_catalog_attachments_handoff_idx
      on review_handoff_external_catalog_attachments(handoff_id, attached_at, attachment_id);
    create index if not exists review_handoff_catalog_attachments_expiry_idx
      on review_handoff_external_catalog_attachments(expires_at, attached_at);
  `);
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "work_sessions" | "work_session_submissions" | "work_session_feedback" | "agent_registry" | "continuations" | "acp_runs" | "agent_webhook_queue" | "dispatch_outbox" | "approval_requests" | "mission_evidence" | "event_log" | "supervisor_runs" | "mission_acceptance_criteria" | "mission_review_findings" | "mission_contracts" | "mission_completion_reports" | "scheduled_jobs" | "scheduled_job_attempts" | "review_routes" | "review_handoffs" | "review_threads" | "review_browser_turns" | "review_browser_profiles" | "mission_outcome_observations",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}

function migrateScheduledJobPublicationReceipts(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "publication_receipts_json", "text");
}

function migrateScheduledJobReconcileBackoff(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "reconcile_probe_count", "integer not null default 0");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "next_reconcile_at", "text");
  addColumnIfMissing(sqlite, "scheduled_job_attempts", "last_reconcile_evidence", "text");
  sqlite.exec("create index if not exists scheduled_job_attempts_reconcile_idx on scheduled_job_attempts(next_reconcile_at)");
}
