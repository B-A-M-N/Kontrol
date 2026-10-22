import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/** Durable per-fragment adapter receipts. The payload is nulled only after a
 * coalesced event-log row commits; event_id and event_log_id remain as an
 * idempotency tombstone/mapping. */
/** Durable one-shot scheduled-job lifecycle. SQLite is authoritative and this
 * row is only created atomically with its recoverable outbox wakeup. */
export const scheduledJobs = sqliteTable("scheduled_jobs", {
  id: text("id").primaryKey(),
  principalId: text("principal_id").notNull(),
  ownerContextId: text("owner_context_id").notNull(),
  projectId: text("project_id").notNull(),
  workspaceRoot: text("workspace_root").notNull(),
  runAt: text("run_at").notNull(),
  instructionJson: text("instruction_json").notNull(),
  executionMode: text("execution_mode").notNull().default("read_only_audit"),
  policySnapshotJson: text("policy_snapshot_json").notNull(),
  agentName: text("agent_name"),
  status: text("status").notNull().default("pending"),
  revision: integer("revision").notNull().default(1),
  workSessionId: text("work_session_id"),
  /** Last durable work-session event projected into this job lifecycle. */
  lifecycleEventCursor: integer("lifecycle_event_cursor").notNull().default(0),
  /** Durable cancellation identity and latest worker-state evidence. */
  cancellationRequestId: text("cancellation_request_id"),
  cancellationPreviousStatus: text("cancellation_previous_status"),
  cancellationRequestedAt: text("cancellation_requested_at"),
  cancellationLastAttemptAt: text("cancellation_last_attempt_at"),
  cancellationLastConfirmedState: text("cancellation_last_confirmed_state"),
  /** Active dispatch-attempt fence; cleared when the attempt completes/releases. */
  activeDispatchAttemptId: text("active_dispatch_attempt_id"),
  maxRuntimeMs: integer("max_runtime_ms").notNull(),
  dispatchRetryCount: integer("dispatch_retry_count").notNull().default(0),
  dispatchNextEligibleAt: text("dispatch_next_eligible_at"),
  dispatchLastAttemptedAgent: text("dispatch_last_attempted_agent"),
  dispatchBlockerKind: text("dispatch_blocker_kind"),
  /** Durable retry receipt key; null for tools that omit retry protection. */
  clientMutationId: text("client_mutation_id"),
  requestFingerprint: text("request_fingerprint").notNull().default("{}"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  terminalAt: text("terminal_at"),
  blockedAt: text("blocked_at"),
  operatorInterventionAt: text("operator_intervention_at"),
  lastStateChangedAt: text("last_state_changed_at"),
}, (table) => [
  index("scheduled_jobs_status_due_idx").on(table.status, table.runAt),
  index("scheduled_jobs_owner_idx").on(table.ownerContextId, table.runAt),
  index("scheduled_jobs_owner_cursor_idx").on(table.ownerContextId, table.id),
  index("scheduled_jobs_principal_cursor_idx").on(table.principalId, table.id),
  index("scheduled_jobs_cancellation_idx").on(table.status, table.cancellationLastAttemptAt, table.id),
  uniqueIndex("scheduled_jobs_principal_mutation_unique").on(table.principalId, table.clientMutationId).where(sql`${table.clientMutationId} is not null`),
]);

export type ScheduledJobRow = typeof scheduledJobs.$inferSelect;
export type NewScheduledJobRow = typeof scheduledJobs.$inferInsert;

/** Bounded per-attempt dispatch/execution correlation. */
export const scheduledJobAttempts = sqliteTable("scheduled_job_attempts", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => scheduledJobs.id, { onDelete: "cascade" }),
  dispatchId: text("dispatch_id").notNull(),
  startedAt: text("started_at").notNull(),
  /** First server-authenticated worker start, distinct from scheduler dispatch claim time. */
  executionStartedAt: text("execution_started_at"),
  /** Current active worker segment; null while waiting for a reviewer or terminal result. */
  executionActiveSince: text("execution_active_since"),
  activeRuntimeMs: integer("active_runtime_ms").notNull().default(0),
  executionStoppedAt: text("execution_stopped_at"),
  executionReceiptJson: text("execution_receipt_json"),
  /** Durable artifact-publication receipts from the bounded-write publisher. */
  publicationReceiptsJson: text("publication_receipts_json"),
  /** Durable exponential-backoff for uncertain dispatch reconciliation. */
  reconcileProbeCount: integer("reconcile_probe_count").notNull().default(0),
  nextReconcileAt: text("next_reconcile_at"),
  lastReconcileEvidence: text("last_reconcile_evidence"),
  /** Authenticated result for the latest bound ACP execution attempt. */
  workerExecutionOutcome: text("worker_execution_outcome"),
  workerExecutionAt: text("worker_execution_at"),
  completedAt: text("completed_at"),
  /** External adapter handshake state, distinct from the final worker outcome. */
  transportStatus: text("transport_status").notNull().default("dispatching"),
  dispatcherInstanceId: text("dispatcher_instance_id"),
  leaseExpiresAt: text("lease_expires_at"),
  agentName: text("agent_name"),
  acpRunId: text("acp_run_id"),
  acpDispatchId: text("acp_dispatch_id"),
  acpAttemptNumber: integer("acp_attempt_number"),
  acpRemoteRunId: text("acp_remote_run_id"),
  dispatchFailureClass: text("dispatch_failure_class"),
  dispatchFailureReason: text("dispatch_failure_reason"),
  dispatchProbeResultJson: text("dispatch_probe_result_json"),
  nextEligibleAt: text("next_eligible_at"),
  outcome: text("outcome"),
}, (table) => [
  index("scheduled_job_attempts_job_idx").on(table.jobId, table.startedAt),
]);

export type ScheduledJobAttemptRow = typeof scheduledJobAttempts.$inferSelect;
export type NewScheduledJobAttemptRow = typeof scheduledJobAttempts.$inferInsert;

/** Immutable full worker report keyed by the scheduled logical job and ACP run. */
export const scheduledJobReports = sqliteTable("scheduled_job_reports", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => scheduledJobs.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull(),
  reportSha256: text("report_sha256").notNull(),
  reportText: text("report_text").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("scheduled_job_reports_job_run_unique").on(table.jobId, table.runId),
  index("scheduled_job_reports_hash_idx").on(table.jobId, table.reportSha256),
]);

export type ScheduledJobReportRow = typeof scheduledJobReports.$inferSelect;

/** Durable single-flight record and immutable report for reviewer-run scheduled verification. */
export const scheduledJobVerifications = sqliteTable("scheduled_job_verifications", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => scheduledJobs.id, { onDelete: "cascade" }),
  requestKey: text("request_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  clientMutationId: text("client_mutation_id"),
  executionIdentity: text("execution_identity").notNull().unique(),
  workSessionId: text("work_session_id").notNull(),
  submissionId: text("submission_id").notNull(),
  reviewEpoch: integer("review_epoch").notNull(),
  snapshotKind: text("snapshot_kind").notNull(),
  snapshotRef: text("snapshot_ref").notNull(),
  commandFingerprint: text("command_fingerprint").notNull(),
  policyFingerprint: text("policy_fingerprint").notNull(),
  status: text("status").notNull().default("running"),
  deadlineAt: text("deadline_at").notNull(),
  reportSha256: text("report_sha256"),
  reportText: text("report_text"),
  failureReason: text("failure_reason"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
}, (table) => [
  uniqueIndex("scheduled_job_verifications_request_unique").on(table.jobId, table.requestKey),
  uniqueIndex("scheduled_job_verifications_active_identity_unique").on(
    table.jobId,
    table.workSessionId,
    table.submissionId,
    table.reviewEpoch,
    table.snapshotKind,
    table.snapshotRef,
    table.commandFingerprint,
    table.policyFingerprint,
  ).where(sql`${table.status} = 'running'`),
  index("scheduled_job_verifications_current_idx").on(table.jobId, table.submissionId, table.reviewEpoch, table.createdAt),
  index("scheduled_job_verifications_status_deadline_idx").on(table.status, table.deadlineAt, table.id),
  index("scheduled_job_verifications_hash_idx").on(table.jobId, table.reportSha256),
]);

export type ScheduledJobVerificationRow = typeof scheduledJobVerifications.$inferSelect;

/** Retryable finalization obligations for worker output after an authenticated terminal lifecycle event. */
export const scheduledJobReportFinalizations = sqliteTable("scheduled_job_report_finalizations", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => scheduledJobs.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  eventId: text("event_id").notNull(),
  status: text("status").notNull().default("pending"),
  reportText: text("report_text"),
  reportSha256: text("report_sha256"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("scheduled_job_report_finalizations_attempt_unique").on(table.jobId, table.runId, table.attemptNumber),
  index("scheduled_job_report_finalizations_pending_idx").on(table.status, table.updatedAt, table.id),
]);

export type ScheduledJobReportFinalizationRow = typeof scheduledJobReportFinalizations.$inferSelect;

export const telemetryIngress = sqliteTable("telemetry_ingress", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").notNull().unique(),
  sessionId: text("session_id").notNull(),
  workspaceSessionId: text("workspace_session_id"),
  type: text("type").notNull(),
  payloadJson: text("payload_json"),
  payloadSha256: text("payload_sha256").notNull(),
  publish: integer("publish", { mode: "boolean" }).notNull().default(true),
  status: text("status").notNull().default("pending"),
  eventLogId: text("event_log_id"),
  receivedAt: text("received_at").notNull(),
  committedAt: text("committed_at"),
}, (table) => [
  index("telemetry_ingress_pending_idx").on(table.status, table.sequence),
  index("telemetry_ingress_session_idx").on(table.sessionId, table.status, table.sequence),
  index("telemetry_ingress_event_log_idx").on(table.eventLogId),
  index("telemetry_ingress_retention_idx").on(table.status, table.committedAt, table.sequence),
]);

export const workspaceProjects = sqliteTable("workspace_projects", {
  id: text("id").primaryKey(),
  canonicalRoot: text("canonical_root").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at").notNull(),
}, (table) => [
  uniqueIndex("workspace_projects_root_unique").on(table.canonicalRoot),
]);

export const workspaceSessions = sqliteTable("workspace_sessions", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  root: text("root").notNull(),
  status: text("status").notNull().default("active"),
  mode: text("mode").notNull().default("checkout"),
  sourceRoot: text("source_root"),
  baseRef: text("base_ref"),
  baseSha: text("base_sha"),
  managed: text("managed").notNull().default("false"),
  retiredAt: text("retired_at"),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at").notNull(),
}, (table) => [
  index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
  index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
]);

export const loadedAgentFiles = sqliteTable("loaded_agent_files", {
  workspaceSessionId: text("workspace_session_id")
    .notNull()
    .references(() => workspaceSessions.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  contentHash: text("content_hash").notNull(),
  content: text("content").notNull(),
  loadedAt: text("loaded_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceSessionId, table.path] }),
  index("loaded_agent_files_path_idx").on(table.path),
]);

export const oauthClients = sqliteTable("oauth_clients", {
  clientId: text("client_id").primaryKey(),
  clientJson: text("client_json").notNull(),
  issuedAt: integer("issued_at").notNull(),
});

export const oauthAccessTokens = sqliteTable("oauth_access_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  clientId: text("client_id").notNull().references(() => oauthClients.clientId, { onDelete: "cascade" }),
  scopesJson: text("scopes_json").notNull(),
  expiresAt: integer("expires_at").notNull(),
  resource: text("resource"),
});

export const oauthRefreshTokens = sqliteTable("oauth_refresh_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  clientId: text("client_id").notNull().references(() => oauthClients.clientId, { onDelete: "cascade" }),
  scopesJson: text("scopes_json").notNull(),
  expiresAt: integer("expires_at").notNull(),
  resource: text("resource"),
});

/** Durable client-side mutation identity. A response loss must never cause a
 * reconnecting WebUI to execute the same logical mutation twice. */
export const clientMutationReceipts = sqliteTable("client_mutation_receipts", {
  principalId: text("principal_id").notNull(),
  operation: text("operation").notNull(),
  clientMutationId: text("client_mutation_id").notNull(),
  requestHash: text("request_hash").notNull(),
  status: text("status").notNull().default("pending"),
  resultJson: text("result_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.principalId, table.operation, table.clientMutationId] }),
  index("client_mutation_receipts_updated_idx").on(table.updatedAt),
]);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;

export const workSessions = sqliteTable("work_sessions", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  workspaceSessionId: text("workspace_session_id")
    .notNull()
    .references(() => workspaceSessions.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("in_progress"),
  runtimeState: text("runtime_state").notNull().default("pending"),
  runtimeClassifiedAt: text("runtime_classified_at"),
  completionPolicy: text("completion_policy").notNull().default("agent_completion"),
  reviewEpoch: integer("review_epoch").notNull().default(0),
  submittedBy: text("submitted_by").notNull(),
  /** Trusted conversation/transport owner that created this durable session. */
  ownerContextId: text("owner_context_id"),
  /** Durable authenticated principal for reconnect-stable job ownership. */
  principalId: text("principal_id"),
  title: text("title"),
  lastConsumedFeedbackId: text("last_consumed_feedback_id"),
  lastConsumedReviewEpoch: integer("last_consumed_review_epoch").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  /** Immutable moment the session reached a terminal status. Drives snapshot
   * retention (GC ages terminal snapshots from this, never from updated_at or
   * manifest mtime). Backfilled from updated_at for pre-existing rows. */
  terminalAt: text("terminal_at"),
}, (table) => [
  index("work_sessions_workspace_idx").on(table.workspaceSessionId, table.updatedAt),
  index("work_sessions_status_idx").on(table.status, table.updatedAt),
]);

export const workSessionSubmissions = sqliteTable("work_session_submissions", {
  id: text("id").primaryKey(),
  workSessionId: text("work_session_id")
    .notNull()
    .references(() => workSessions.id, { onDelete: "cascade" }),
  submissionNumber: integer("submission_number").notNull(),
  diff: text("diff"),
  diffSha256: text("diff_sha256"),
  /** Structured file metadata captured by the checkpoint layer. */
  filesJson: text("files_json"),
  /** JSON CheckpointCoverage: structured-mutation paths the review checkpoint
   * could not represent, so reviewers see the blind spot and an ordinary
   * approval is refused until explicitly accepted. Null = fully covered. */
  coverageJson: text("coverage_json"),
  /** Exact working-tree snapshot commit the diff was captured against. Bound to
   * the submission so approval can require the workspace to still equal this
   * tree (fixes stale-approval after a concurrent submission in the same
   * workspace). Legacy compatibility only; new rows use snapshotKind/ref. */
  snapshotCommit: text("snapshot_commit"),
  snapshotKind: text("snapshot_kind"),
  snapshotRef: text("snapshot_ref"),
  reviewEpoch: integer("review_epoch").notNull().default(1),
  message: text("message"),
  summaryJson: text("summary_json"),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("wss_work_session_idx").on(table.workSessionId, table.submissionNumber),
  uniqueIndex("work_session_submission_number_unique").on(table.workSessionId, table.submissionNumber),
]);

export const workSessionFeedback = sqliteTable("work_session_feedback", {
  id: text("id").primaryKey(),
  workSessionId: text("work_session_id")
    .notNull()
    .references(() => workSessions.id, { onDelete: "cascade" }),
  submissionId: text("submission_id")
    .notNull()
    .references(() => workSessionSubmissions.id, { onDelete: "cascade" }),
  verdict: text("verdict").notNull(),
  comments: text("comments"),
  filesJson: text("files_json"),
  requiredActionsJson: text("required_actions_json"),
  allowedNextActionsJson: text("allowed_next_actions_json"),
  reviewerId: text("reviewer_id"),
  completionReportSha256: text("completion_report_sha256"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("work_session_feedback_submission_unique").on(table.submissionId),
  index("work_session_feedback_session_created_idx").on(table.workSessionId, table.createdAt),
]);

export const workSessionToolEvents = sqliteTable("work_session_tool_events", {
  id: text("id").primaryKey(),
  workSessionId: text("work_session_id")
    .notNull()
    .references(() => workSessions.id, { onDelete: "cascade" }),
  workspaceSessionId: text("workspace_session_id"),
  tool: text("tool").notNull(),
  inputJson: text("input_json").notNull(),
  outputSummary: text("output_summary"),
  path: text("path"),
  success: integer("success").notNull().default(1),
  elapsedMs: integer("elapsed_ms").notNull().default(0),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("wste_work_session_idx").on(table.workSessionId, table.createdAt, table.id),
]);

export type WorkSessionRow = typeof workSessions.$inferSelect;
export type NewWorkSessionRow = typeof workSessions.$inferInsert;

export const workspaceLeases = sqliteTable("workspace_leases", {
  canonicalRoot: text("canonical_root").primaryKey(),
  workspaceSessionId: text("workspace_session_id")
    .notNull()
    .references(() => workspaceSessions.id, { onDelete: "cascade" }),
  workSessionId: text("work_session_id")
    .notNull()
    .references(() => workSessions.id, { onDelete: "cascade" }),
  leaseKind: text("lease_kind").notNull().default("modify"),
  ownerInstanceId: text("owner_instance_id").notNull(),
  leaseNonce: text("lease_nonce").notNull().default("legacy"),
  acquiredAt: text("acquired_at").notNull(),
  heartbeatAt: text("heartbeat_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (table) => [
  index("workspace_leases_session_idx").on(table.workSessionId),
  index("workspace_leases_expires_idx").on(table.expiresAt),
]);

export type WorkspaceLeaseRow = typeof workspaceLeases.$inferSelect;
export type NewWorkspaceLeaseRow = typeof workspaceLeases.$inferInsert;

export type WorkSessionSubmissionRow = typeof workSessionSubmissions.$inferSelect;
export type NewWorkSessionSubmissionRow = typeof workSessionSubmissions.$inferInsert;
export type WorkSessionFeedbackRow = typeof workSessionFeedback.$inferSelect;
export type NewWorkSessionFeedbackRow = typeof workSessionFeedback.$inferInsert;
export type WorkSessionToolEventRow = typeof workSessionToolEvents.$inferSelect;
export type NewWorkSessionToolEventRow = typeof workSessionToolEvents.$inferInsert;

export const agentRegistry = sqliteTable("agent_registry", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  description: text("description"),
  publicKey: text("public_key"),
  capabilitiesJson: text("capabilities_json"),
  tags: text("tags"),
  role: text("role"),
  /** P1 #11: sha256 of the per-agent opaque credential (never the raw secret). */
  agentCredentialHash: text("agent_credential_hash"),
  lastHeartbeat: text("last_heartbeat").notNull(),
  createdAt: text("created_at").notNull(),
  ttlSeconds: integer("ttl_seconds").notNull().default(60),
}, (table) => [
  uniqueIndex("agent_registry_name_unique").on(table.name),
  index("agent_registry_heartbeat_idx").on(table.lastHeartbeat),
]);

export const acpRuns = sqliteTable("acp_runs", {
  runId: text("run_id").primaryKey(),
  agentName: text("agent_name").notNull(),
  agentId: text("agent_id"),
  workspaceSessionId: text("workspace_session_id"),
  workSessionId: text("work_session_id"),
  remoteRunId: text("remote_run_id"),
  attemptNumber: integer("attempt_number").notNull().default(1),
  /** Server-owned execution authority, persisted before the adapter request. */
  scheduledExecutionMode: text("scheduled_execution_mode"),
  status: text("status").notNull().default("created"),
  inputPreview: text("input_preview"),
  outputPreview: text("output_preview"),
  outputJson: text("output_json"),
  errorMessage: text("error_message"),
  webhookUrl: text("webhook_url"),
  webhookDelivered: integer("webhook_delivered").notNull().default(0),
  lastHeartbeatAt: text("last_heartbeat_at"),
  workerLeaseUntil: text("worker_lease_until"),
  createdAt: text("created_at").notNull(),
  finishedAt: text("finished_at"),
}, (table) => [
  index("acp_runs_status_idx").on(table.status, table.createdAt),
  index("acp_runs_workspace_idx").on(table.workspaceSessionId),
  uniqueIndex("acp_runs_one_logical_run_per_session")
    .on(table.workSessionId)
    .where(sql`${table.workSessionId} is not null`),
]);

/** One durable idempotency identity for each outbound ACP execution attempt. */
export const acpRunDispatchAttempts = sqliteTable("acp_run_dispatch_attempts", {
  dispatchIdempotencyKey: text("dispatch_idempotency_key").primaryKey(),
  runId: text("run_id").notNull().references(() => acpRuns.runId, { onDelete: "cascade" }),
  agentId: text("agent_id"),
  attemptNumber: integer("attempt_number").notNull(),
  remoteRunId: text("remote_run_id"),
  status: text("status").notNull().default("dispatching"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("acp_run_dispatch_attempts_run_attempt_unique").on(table.runId, table.attemptNumber),
  index("acp_run_dispatch_attempts_run_idx").on(table.runId, table.attemptNumber),
]);

export const agentWebhookQueue = sqliteTable("agent_webhook_queue", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => acpRuns.runId, { onDelete: "cascade" }),
  targetUrl: text("target_url").notNull(),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull().default("pending"),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  lastError: text("last_error"),
  claimedBy: text("claimed_by"),
  claimExpiresAt: text("claim_expires_at"),
  createdAt: text("created_at").notNull(),
  nextRetryAt: text("next_retry_at"),
}, (table) => [
  index("webhook_queue_status_idx").on(table.status, table.nextRetryAt),
  index("webhook_queue_claim_idx").on(table.status, table.claimExpiresAt),
]);

export type AgentRegistryRow = typeof agentRegistry.$inferSelect;
export type NewAgentRegistryRow = typeof agentRegistry.$inferInsert;
export type AcpRunRow = typeof acpRuns.$inferSelect;
export type NewAcpRunRow = typeof acpRuns.$inferInsert;
export type AgentWebhookQueueRow = typeof agentWebhookQueue.$inferSelect;
export type NewAgentWebhookQueueRow = typeof agentWebhookQueue.$inferInsert;

export const continuations = sqliteTable("continuations", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  reviewId: text("review_id").notNull(),
  feedbackEventId: text("feedback_event_id").notNull(),
  reviewEpoch: integer("review_epoch").notNull().default(1),
  verdict: text("verdict").notNull(),
  requiredActionsJson: text("required_actions_json").notNull().default("[]"),
  allowedNextActionsJson: text("allowed_next_actions_json").notNull().default("[]"),
  reviewedDiffHash: text("reviewed_diff_hash"),
  feedbackSummary: text("feedback_summary"),
  resumeInstructions: text("resume_instructions"),
  status: text("status").notNull().default("pending"),
  target: text("target"),
  claimOwner: text("claim_owner"),
  claimedAt: text("claimed_at"),
  promptText: text("prompt_text").notNull(),
  createdAt: text("created_at").notNull(),
  deliveredAt: text("delivered_at"),
  consumedAt: text("consumed_at"),
}, (table) => [
  index("continuations_session_status_idx").on(table.sessionId, table.status),
  index("continuations_status_idx").on(table.status, table.createdAt),
]);

export type ContinuationRow = typeof continuations.$inferSelect;
export type NewContinuationRow = typeof continuations.$inferInsert;

export const policyApprovalRequests = sqliteTable("policy_approval_requests", {
  id: text("id").primaryKey(),
  principalId: text("principal_id").notNull(),
  workspaceId: text("workspace_session_id").notNull(),
  workSessionId: text("work_session_id"),
  tool: text("tool").notNull(),
  path: text("path"),
  command: text("command"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("policy_approval_requests_workspace_idx").on(table.workspaceId, table.createdAt),
]);

export const policyApprovalGrants = sqliteTable("policy_approval_grants", {
  id: text("id").primaryKey(),
  principalId: text("principal_id").notNull(),
  scope: text("scope").notNull(),
  scopeId: text("scope_id").notNull(),
  approvalKey: text("approval_key").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  reviewerId: text("reviewer_id"),
}, (table) => [
  index("policy_approval_grants_principal_idx").on(
    table.principalId, table.scope, table.scopeId, table.approvalKey,
  ),
]);

export type PolicyApprovalRequestRow = typeof policyApprovalRequests.$inferSelect;
export type NewPolicyApprovalRequestRow = typeof policyApprovalRequests.$inferInsert;
export type PolicyApprovalGrantRow = typeof policyApprovalGrants.$inferSelect;
export type NewPolicyApprovalGrantRow = typeof policyApprovalGrants.$inferInsert;

export const approvalRequests = sqliteTable("approval_requests", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  workspaceSessionId: text("workspace_session_id").notNull(),
  workSessionId: text("work_session_id"),
  ownerContextId: text("owner_context_id"),
  runId: text("run_id"),
  agentId: text("agent_id"),
  principalId: text("principal_id"),
  approvalKey: text("approval_key"),
  operationHash: text("operation_hash"),
  mcpSessionId: text("mcp_session_id"),
  mcpRequestId: text("mcp_request_id"),
  waiterKey: text("waiter_key"),
  liveWaiterId: text("live_waiter_id"),
  origin: text("origin"),
  conversationId: text("conversation_id"),
  orphanedAt: text("orphaned_at"),
  reattachDeadline: text("reattach_deadline"),
  title: text("title").notNull(),
  description: text("description"),
  risk: text("risk"),
  tool: text("tool"),
  command: text("command"),
  path: text("path"),
  optionsJson: text("options_json").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at"),
  resolvedAt: text("resolved_at"),
  resolutionJson: text("resolution_json"),
  consumedAt: text("consumed_at"),
}, (table) => [
  index("approval_requests_workspace_status_idx").on(table.workspaceSessionId, table.status, table.createdAt),
  index("approval_requests_work_session_status_idx").on(table.workSessionId, table.status, table.createdAt),
  index("approval_requests_run_idx").on(table.runId, table.createdAt),
  index("approval_requests_status_expiry_idx").on(table.status, table.expiresAt),
  index("approval_requests_waiter_consumed_idx").on(table.waiterKey, table.status, table.consumedAt),
  index("approval_requests_direct_operation_idx").on(table.principalId, table.workspaceSessionId, table.ownerContextId, table.operationHash, table.status, table.consumedAt),
]);

export type ApprovalRequestRow = typeof approvalRequests.$inferSelect;
export type NewApprovalRequestRow = typeof approvalRequests.$inferInsert;

// v13: dispatch outbox for durable auto-resume
export const dispatchOutbox = sqliteTable("dispatch_outbox", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  aggregateRevision: integer("aggregate_revision").notNull().default(0),
  payloadJson: text("payload_json").notNull().default("{}"),
  status: text("status").notNull().default("pending"),
  /** Claim odometer — bumped every time claimNext() hands this row to a worker.
   * Observability only; NOT the dead-letter trigger (see failureCount). */
  attemptCount: integer("attempt_count").notNull().default(0),
  /** Genuine dispatch failures (markFailed). Drives backoff + dead-lettering. */
  failureCount: integer("failure_count").notNull().default(0),
  availableAt: text("available_at").notNull(),
  claimedBy: text("claimed_by"),
  claimExpiresAt: text("claim_expires_at"),
  /** Fencing token minted by the successful claimNext() CAS. Every claimed
   * transition must present this exact token; a stale claimant whose lease was
   * reaped and re-claimed by another worker cannot acknowledge foreign work. */
  claimToken: text("claim_token"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  index("dispatch_outbox_status_available_idx").on(table.status, table.availableAt),
  index("dispatch_outbox_aggregate_idx").on(table.aggregateId),
  uniqueIndex("dispatch_outbox_logical_unique").on(table.eventType, table.aggregateId, table.aggregateRevision),
]);

export type DispatchOutboxRow = typeof dispatchOutbox.$inferSelect;
export type NewDispatchOutboxRow = typeof dispatchOutbox.$inferInsert;

export const missionContracts = sqliteTable("mission_contracts", {
  id: text("id").primaryKey(),
  workSessionId: text("work_session_id").notNull().references(() => workSessions.id, { onDelete: "cascade" }),
  workspaceSessionId: text("workspace_session_id").notNull().references(() => workspaceSessions.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(1),
  contractFingerprint: text("contract_fingerprint"),
  objective: text("objective").notNull(),
  desiredOutcome: text("desired_outcome").notNull(),
  constraintsJson: text("constraints_json").notNull().default("[]"),
  nonGoalsJson: text("non_goals_json").notNull().default("[]"),
  userLockedFieldsJson: text("user_locked_fields_json").notNull().default("[]"),
  supervisorInstructions: text("supervisor_instructions"),
  baselineCommit: text("baseline_commit"),
  baselineKind: text("baseline_kind"),
  baselineRef: text("baseline_ref"),
  correctionRounds: integer("correction_rounds").notNull().default(0),
  maxCorrectionRounds: integer("max_correction_rounds").notNull().default(5),
  finalVerificationJson: text("final_verification_json").notNull().default("[]"),
  reviewCoverageJson: text("review_coverage_json").notNull().default("[]"),
  outcomeEvidence: text("outcome_evidence"),
  outcomeExpectedBehavior: text("outcome_expected_behavior"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("mission_contracts_work_session_unique").on(table.workSessionId),
  index("mission_contracts_workspace_idx").on(table.workspaceSessionId, table.updatedAt),
]);

export const supervisorRuns = sqliteTable("supervisor_runs", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missionContracts.id, { onDelete: "cascade" }),
  workSessionId: text("work_session_id").notNull().references(() => workSessions.id, { onDelete: "cascade" }),
  workspaceSessionId: text("workspace_session_id").notNull().references(() => workspaceSessions.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("created"), resumeStatus: text("resume_status"), revision: integer("revision").notNull().default(1),
  cycleNumber: integer("cycle_number").notNull().default(0), maxCycles: integer("max_cycles").notNull().default(25),
  maxStagnantCycles: integer("max_stagnant_cycles").notNull().default(2),
  repeatedFailureFingerprintLimit: integer("repeated_failure_fingerprint_limit").notNull().default(3),
  stagnantCycleCount: integer("stagnant_cycle_count").notNull().default(0),
  progressJson: text("progress_json"), stallReason: text("stall_reason"),
  ownerInstanceId: text("owner_instance_id"), leaseNonce: text("lease_nonce"), leaseExpiresAt: text("lease_expires_at"), heartbeatAt: text("heartbeat_at"),
  lastProcessedEventSeq: integer("last_processed_event_seq").notNull().default(0), lastSubmissionId: text("last_submission_id"), lastSnapshotCommit: text("last_snapshot_commit"), lastSnapshotKind: text("last_snapshot_kind"), lastSnapshotRef: text("last_snapshot_ref"),
  nextActionAt: text("next_action_at"), failureCount: integer("failure_count").notNull().default(0), lastError: text("last_error"),
  lastFailureFingerprint: text("last_failure_fingerprint"), repeatedFailureCount: integer("repeated_failure_count").notNull().default(0),
  /** C04: distinct failure fingerprints observed WITHOUT resolution, so an
   * alternating break/restore cycle accumulates even when the consecutive
   * fingerprint counter resets on every alternation. */
  failureFingerprintSetJson: text("failure_fingerprint_set_json").notNull().default("{}"),
  deadlineAt: text("deadline_at"),
  autonomyMode: text("autonomy_mode").notNull().default("manual"), approvalMode: text("approval_mode").notNull().default("human_required"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("supervisor_runs_mission_unique").on(table.missionId), uniqueIndex("supervisor_runs_work_session_unique").on(table.workSessionId), index("supervisor_runs_status_next_idx").on(table.status, table.nextActionAt)]);

export const supervisorProgressSnapshots = sqliteTable("supervisor_progress_snapshots", {
  id: text("id").primaryKey(),
  supervisorRunId: text("supervisor_run_id").notNull().references(() => supervisorRuns.id, { onDelete: "cascade" }),
  workSessionId: text("work_session_id").notNull(),
  cycleNumber: integer("cycle_number").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  deltaJson: text("delta_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("supervisor_progress_run_idx").on(table.supervisorRunId, table.cycleNumber)]);
export type SupervisorProgressSnapshotRow = typeof supervisorProgressSnapshots.$inferSelect;

export const missionCompletionReports = sqliteTable("mission_completion_reports", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missionContracts.id, { onDelete: "cascade" }),
  submissionId: text("submission_id").notNull(),
  snapshotCommit: text("snapshot_commit").notNull(),
  snapshotKind: text("snapshot_kind"),
  snapshotRef: text("snapshot_ref"),
  status: text("status").notNull(),
  resultsJson: text("results_json").notNull(),
  reviewCoverageJson: text("review_coverage_json").notNull().default("[]"),
  uncertaintyJson: text("uncertainty_json").notNull().default("[]"),
  reportSha256: text("report_sha256").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("mission_completion_reports_current_idx").on(table.missionId, table.submissionId, table.snapshotCommit, table.createdAt),
  index("mission_completion_reports_identity_idx").on(table.missionId, table.submissionId, table.snapshotKind, table.snapshotRef, table.createdAt),
]);
export type MissionCompletionReportRow = typeof missionCompletionReports.$inferSelect;

export const missionOutcomeObservations = sqliteTable("mission_outcome_observations", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missionContracts.id, { onDelete: "cascade" }),
  submissionId: text("submission_id").notNull(),
  reviewEpoch: integer("review_epoch"),
  snapshotKind: text("snapshot_kind").notNull(),
  snapshotRef: text("snapshot_ref").notNull(),
  /** Explicit external observer identity; server_test_runner is not valid here. */
  observerIdentity: text("observer_identity").notNull(),
  observerPrincipalId: text("observer_principal_id"),
  observationSource: text("observation_source").notNull().default("legacy_operator_reported"),
  externalEvidenceSha256: text("external_evidence_sha256"),
  /** Declared user-visible behavior that the observer confirmed or rejected. */
  expectedBehavior: text("expected_behavior").notNull(),
  actualBehavior: text("actual_behavior").notNull(),
  status: text("status").notNull(),
  observedAt: text("observed_at").notNull(),
  /** Hash of the observation payload so receipts are tamper-evident. */
  observationSha256: text("observation_sha256").notNull(),
}, (table) => [
  index("mission_outcome_observations_current_idx").on(table.missionId, table.submissionId, table.snapshotRef, table.observedAt),
]);
export type MissionOutcomeObservationRow = typeof missionOutcomeObservations.$inferSelect;

export const missionAcceptanceCriteria = sqliteTable("mission_acceptance_criteria", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missionContracts.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  priority: text("priority").notNull().default("required"),
  verificationType: text("verification_type").notNull().default("manual_review"),
  verificationCommand: text("verification_command"),
  runtimeProbeJson: text("runtime_probe_json"),
  affectedAreasJson: text("affected_areas_json").notNull().default("[]"),
  dependsOnJson: text("depends_on_json").notNull().default("[]"),
  verificationGroup: text("verification_group"),
  verificationScope: text("verification_scope").notNull().default("full"),
  finalOnly: integer("final_only", { mode: "boolean" }).notNull().default(false),
  mutatesWorkspace: integer("mutates_workspace", { mode: "boolean" }).notNull().default(false),
  commandVersion: text("command_version"),
  status: text("status").notNull().default("unverified"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("mission_criteria_mission_idx").on(table.missionId, table.status),
]);

export const missionReviewFindings = sqliteTable("mission_review_findings", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missionContracts.id, { onDelete: "cascade" }),
  introducedInSubmissionId: text("introduced_in_submission_id"),
  scope: text("scope").notNull().default("in_scope"),
  severity: text("severity").notNull().default("medium"),
  category: text("category").notNull().default("correctness"),
  disposition: text("disposition").notNull().default("blocking"),
  fingerprint: text("fingerprint"),
  description: text("description").notNull(),
  evidenceJson: text("evidence_json").notNull().default("[]"),
  requiredAction: text("required_action").notNull(),
  requiredVerificationJson: text("required_verification_json").notNull().default("[]"),
  status: text("status").notNull().default("open"),
  resolutionSubmissionId: text("resolution_submission_id"),
  resolutionEvidenceJson: text("resolution_evidence_json").notNull().default("[]"),
  waiverReason: text("waiver_reason"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("mission_findings_mission_status_idx").on(table.missionId, table.status, table.severity),
]);

export const missionWorkOrders = sqliteTable("mission_work_orders", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missionContracts.id, { onDelete: "cascade" }),
  workSessionId: text("work_session_id").notNull().references(() => workSessions.id, { onDelete: "cascade" }),
  missionRevision: integer("mission_revision").notNull(),
  objectiveForThisTurn: text("objective_for_this_turn").notNull(),
  requiredFindingIdsJson: text("required_finding_ids_json").notNull().default("[]"),
  acceptanceCriterionIdsJson: text("acceptance_criterion_ids_json").notNull().default("[]"),
  requiredActionsJson: text("required_actions_json").notNull().default("[]"),
  prohibitedActionsJson: text("prohibited_actions_json").notNull().default("[]"),
  requiredVerificationJson: text("required_verification_json").notNull().default("[]"),
  expectedDeliverablesJson: text("expected_deliverables_json").notNull().default("[]"),
  contextReferencesJson: text("context_references_json").notNull().default("[]"),
  preferredAgent: text("preferred_agent"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("mission_work_orders_session_idx").on(table.workSessionId, table.createdAt),
  index("mission_work_orders_mission_idx").on(table.missionId, table.createdAt),
]);

export const missionEvidence = sqliteTable("mission_evidence", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missionContracts.id, { onDelete: "cascade" }),
  criterionId: text("criterion_id"),
  findingId: text("finding_id"),
  submissionId: text("submission_id"),
  reviewEpoch: integer("review_epoch"),
  snapshotCommit: text("snapshot_commit"),
  snapshotKind: text("snapshot_kind"),
  snapshotRef: text("snapshot_ref"),
  leaseNonce: text("lease_nonce"),
  actorPrincipal: text("actor_principal"),
  command: text("command"),
  outputDigest: text("output_digest"),
  attempt: integer("attempt"),
  status: text("status").notNull().default("inconclusive"),
  detailsJson: text("details_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("mission_evidence_mission_idx").on(table.missionId, table.createdAt),
  index("mission_evidence_criterion_idx").on(table.criterionId, table.createdAt),
]);

export type MissionContractRow = typeof missionContracts.$inferSelect;
export type NewMissionContractRow = typeof missionContracts.$inferInsert;
export type MissionAcceptanceCriterionRow = typeof missionAcceptanceCriteria.$inferSelect;
export type NewMissionAcceptanceCriterionRow = typeof missionAcceptanceCriteria.$inferInsert;
export type MissionReviewFindingRow = typeof missionReviewFindings.$inferSelect;
export type NewMissionReviewFindingRow = typeof missionReviewFindings.$inferInsert;
export type MissionWorkOrderRow = typeof missionWorkOrders.$inferSelect;
export type NewMissionWorkOrderRow = typeof missionWorkOrders.$inferInsert;
export type MissionEvidenceRow = typeof missionEvidence.$inferSelect;
export type NewMissionEvidenceRow = typeof missionEvidence.$inferInsert;

// v22: durable agent→WebUI messages and artifacts. The event log carries the
// wakeup; this table is the durable record so a reloaded WebUI can re-list every
// clarification request, blocker, finding, note, and artifact for a session
// without replaying the entire event stream.
export const agentMessages = sqliteTable("agent_messages", {
  id: text("id").primaryKey(),
  workSessionId: text("work_session_id")
    .notNull()
    .references(() => workSessions.id, { onDelete: "cascade" }),
  runId: text("run_id"),
  /** clarification_request | blocker | finding | artifact | note */
  kind: text("kind").notNull(),
  /** Sender role: "worker" | "agent". Reviewer replies flow via feedback/approval. */
  author: text("author").notNull().default("worker"),
  title: text("title"),
  body: text("body"),
  /** Structured payload (artifact ref, finding evidence, options for a question). */
  dataJson: text("data_json").notNull().default("{}"),
  /** Correlates a reviewer reply back to this message (e.g. a clarification answer). */
  replyToId: text("reply_to_id"),
  status: text("status").notNull().default("open"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
}, (table) => [
  index("agent_messages_session_idx").on(table.workSessionId, table.createdAt),
  index("agent_messages_kind_idx").on(table.workSessionId, table.kind, table.status),
]);

export type AgentMessageRow = typeof agentMessages.$inferSelect;
export type NewAgentMessageRow = typeof agentMessages.$inferInsert;

/** Immutable reviewer answer with its own durable delivery/acknowledgement state. */
export const agentMessageReplies = sqliteTable("agent_message_replies", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => agentMessages.id, { onDelete: "cascade" }),
  workSessionId: text("work_session_id").notNull().references(() => workSessions.id, { onDelete: "cascade" }),
  replyRevision: integer("reply_revision").notNull().default(1),
  body: text("body").notNull(),
  bodySha256: text("body_sha256").notNull(),
  reviewerPrincipalId: text("reviewer_principal_id").notNull(),
  status: text("status").notNull().default("pending_delivery"),
  createdAt: text("created_at").notNull(),
  acknowledgedAt: text("acknowledged_at"),
  acknowledgedRunId: text("acknowledged_run_id"),
  acknowledgedAttempt: integer("acknowledged_attempt"),
  acknowledgedActorId: text("acknowledged_actor_id"),
}, (table) => [
  uniqueIndex("agent_message_replies_message_revision_unique").on(table.messageId, table.replyRevision),
  index("agent_message_replies_session_idx").on(table.workSessionId, table.status),
]);

/** Durable worker waiting intent for a clarification reply (cold-start resumption). */
export const agentReplyWaits = sqliteTable("agent_reply_waits", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => agentMessages.id, { onDelete: "cascade" }),
  workSessionId: text("work_session_id").notNull().references(() => workSessions.id, { onDelete: "cascade" }),
  runId: text("run_id"),
  workerAttempt: integer("worker_attempt").notNull().default(1),
  expectsReply: integer("expects_reply", { mode: "boolean" }).notNull().default(true),
  resumeOnReply: integer("resume_on_reply", { mode: "boolean" }).notNull().default(false),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("agent_reply_waits_message_active_idx").on(table.messageId, table.active),
  index("agent_reply_waits_session_idx").on(table.workSessionId, table.active),
]);

export type AgentMessageReplyRow = typeof agentMessageReplies.$inferSelect;
export type NewAgentMessageReplyRow = typeof agentMessageReplies.$inferInsert;
export type AgentReplyWaitRow = typeof agentReplyWaits.$inferSelect;
export type NewAgentReplyWaitRow = typeof agentReplyWaits.$inferInsert;

/** Durable review routing for a work session. Conversation IDs are correlation
 * only; authorization remains principal/session based. */
export const reviewRoutes = sqliteTable("review_routes", {
  id: text("id").primaryKey(),
  workSessionId: text("work_session_id").notNull().references(() => workSessions.id, { onDelete: "cascade" }),
  ownerPrincipalId: text("owner_principal_id").notNull(),
  ownerContextId: text("owner_context_id").notNull(),
  mode: text("mode").notNull().default("isolated_review"),
  deliveryPolicy: text("delivery_policy").notNull().default("explicit_user_action"),
  deliveryTransport: text("delivery_transport").notNull().default("mcp_app"),
  browserProfileId: text("browser_profile_id"),
  pinnedConversationId: text("pinned_conversation_id"),
  maxReviewRounds: integer("max_review_rounds").notNull().default(3),
  completedReviewRounds: integer("completed_review_rounds").notNull().default(0),
  admittedReviewRounds: integer("admitted_review_rounds").notNull().default(0),
  status: text("status").notNull().default("disabled"),
  routeEpoch: integer("route_epoch").notNull().default(1),
  revision: integer("revision").notNull().default(1),
  warningAcknowledgedAt: text("warning_acknowledged_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("review_routes_work_session_idx").on(table.workSessionId, table.status),
  uniqueIndex("review_routes_work_session_unique").on(table.workSessionId),
]);

export type ReviewRouteRow = typeof reviewRoutes.$inferSelect;
export type NewReviewRouteRow = typeof reviewRoutes.$inferInsert;

/** One submission-scoped review handoff. */
export const reviewHandoffs = sqliteTable("review_handoffs", {
  id: text("id").primaryKey(),
  routeId: text("route_id").notNull().references(() => reviewRoutes.id, { onDelete: "cascade" }),
  workSessionId: text("work_session_id").notNull().references(() => workSessions.id, { onDelete: "cascade" }),
  submissionId: text("submission_id").notNull(),
  reviewEpoch: integer("review_epoch").notNull(),
  snapshotKind: text("snapshot_kind").notNull(),
  snapshotRef: text("snapshot_ref").notNull(),
  diffSha256: text("diff_sha256").notNull(),
  routeEpoch: integer("route_epoch").notNull(),
  roundNumber: integer("round_number").notNull(),
  destinationConversationId: text("destination_conversation_id"),
  claimedByPrincipalId: text("claimed_by_principal_id"),
  claimedByOwnerContextId: text("claimed_by_owner_context_id"),
  status: text("status").notNull().default("queued"),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  claimedAt: text("claimed_at"),
  claimExpiresAt: text("claim_expires_at"),
  completedAt: text("completed_at"),
}, (table) => [
  index("review_handoffs_session_submission_idx").on(table.workSessionId, table.submissionId),
  index("review_handoffs_status_idx").on(table.status, table.createdAt),
  uniqueIndex("review_handoffs_submission_active_unique").on(table.submissionId, table.reviewEpoch),
]);

export type ReviewHandoffRow = typeof reviewHandoffs.$inferSelect;
export type NewReviewHandoffRow = typeof reviewHandoffs.$inferInsert;

/** One application-level reviewer context bound to a route generation. */
export const reviewThreads = sqliteTable("review_threads", {
  id: text("id").primaryKey(),
  routeId: text("route_id").notNull().references(() => reviewRoutes.id, { onDelete: "cascade" }),
  routeEpoch: integer("route_epoch").notNull(),
  workSessionId: text("work_session_id").notNull().references(() => workSessions.id, { onDelete: "cascade" }),
  ownerPrincipalId: text("owner_principal_id").notNull(),
  reviewerPrincipalId: text("reviewer_principal_id"),
  reviewerContextId: text("reviewer_context_id"),
  hostKind: text("host_kind").notNull().default("kontrol_ui"),
  hostConversationId: text("host_conversation_id"),
  hostBindingVerified: integer("host_binding_verified", { mode: "boolean" }).notNull().default(false),
  reviewerBindingId: text("reviewer_binding_id"),
  browserProfileId: text("browser_profile_id"),
  browserGeneration: integer("browser_generation"),
  browserTargetId: text("browser_target_id"),
  browserCdpSessionId: text("browser_cdp_session_id"),
  conversationUrl: text("conversation_url"),
  conversationKey: text("conversation_key"),
  conversationFingerprint: text("conversation_fingerprint"),
  conversationBindingRevision: integer("conversation_binding_revision"),
  conversationBindingStatus: text("conversation_binding_status"),
  conversationBindingAssurance: text("conversation_binding_assurance"),
  resumeChallengeSha256: text("resume_challenge_sha256"),
  resumeChallengeExpiresAt: text("resume_challenge_expires_at"),
  bindingGeneration: integer("binding_generation").notNull().default(0),
  status: text("status").notNull().default("pending_activation"),
  maxRounds: integer("max_rounds").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  activatedAt: text("activated_at"),
  closedAt: text("closed_at"),
}, (table) => [
  uniqueIndex("review_threads_route_epoch_unique").on(table.routeId, table.routeEpoch),
  index("review_threads_session_status_idx").on(table.workSessionId, table.status),
]);

export const reviewThreadActivations = sqliteTable("review_thread_activations", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => reviewThreads.id, { onDelete: "cascade" }),
  routeId: text("route_id").notNull(),
  routeEpoch: integer("route_epoch").notNull(),
  principalId: text("principal_id").notNull(),
  activationSecretSha256: text("activation_secret_sha256").notNull().unique(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  revokedAt: text("revoked_at"),
}, (table) => [
  index("review_thread_activations_thread_expiry_idx").on(table.threadId, table.expiresAt),
]);

export const reviewThreadMessages = sqliteTable("review_thread_messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => reviewThreads.id, { onDelete: "cascade" }),
  routeEpoch: integer("route_epoch").notNull(),
  workSessionId: text("work_session_id").notNull(),
  handoffId: text("handoff_id").notNull(),
  submissionId: text("submission_id").notNull(),
  reviewEpoch: integer("review_epoch").notNull(),
  roundNumber: integer("round_number").notNull(),
  kind: text("kind").notNull(),
  payloadJson: text("payload_json").notNull(),
  payloadSha256: text("payload_sha256").notNull(),
  status: text("status").notNull().default("awaiting_activation"),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("review_thread_messages_submission_unique").on(table.threadId, table.submissionId, table.reviewEpoch),
  index("review_thread_messages_delivery_idx").on(table.threadId, table.status, table.createdAt),
]);

export const reviewBrowserTurns = sqliteTable("review_browser_turns", {
  id: text("id").primaryKey(),
  reviewMessageId: text("review_message_id").notNull().references(() => reviewThreadMessages.id, { onDelete: "cascade" }),
  reviewThreadId: text("review_thread_id").notNull(),
  routeEpoch: integer("route_epoch").notNull(),
  profileId: text("profile_id").notNull(),
  conversationFingerprint: text("conversation_fingerprint").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  browserGeneration: integer("browser_generation"),
  leaseOwner: text("lease_owner"),
  leaseTokenSha256: text("lease_token_sha256"),
  leaseExpiresAt: text("lease_expires_at"),
  state: text("state").notNull(),
  promptSha256: text("prompt_sha256").notNull(),
  baselineUserMessageCount: integer("baseline_user_message_count"),
  baselineAssistantMessageCount: integer("baseline_assistant_message_count"),
  submittedAt: text("submitted_at"),
  generationStartedAt: text("generation_started_at"),
  generationStartedObservationId: text("generation_started_observation_id"),
  generationFinishedAt: text("generation_finished_at"),
  generationFinishedObservationId: text("generation_finished_observation_id"),
  feedbackCommittedAt: text("feedback_committed_at"),
  errorCode: text("error_code"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("review_browser_turns_message_number_unique").on(table.reviewMessageId, table.attemptNumber),
  index("review_browser_turns_state_lease_idx").on(table.state, table.leaseExpiresAt),
  uniqueIndex("review_browser_turns_message_active_unique").on(table.reviewMessageId).where(sql`${table.state} in ('leased', 'browser_ready', 'dispatching', 'prompt_accepted', 'model_generating', 'generation_finished', 'awaiting_feedback', 'uncertain')`),
  uniqueIndex("review_browser_turns_thread_active_unique").on(table.reviewThreadId).where(sql`${table.state} in ('leased', 'browser_ready', 'dispatching', 'prompt_accepted', 'model_generating', 'generation_finished', 'awaiting_feedback', 'uncertain')`),
]);

export const reviewBrowserTurnResolutions = sqliteTable("review_browser_turn_resolutions", {
  attemptId: text("attempt_id").primaryKey().references(() => reviewBrowserTurns.id, { onDelete: "cascade" }),
  reviewThreadId: text("review_thread_id").notNull(),
  routeEpoch: integer("route_epoch").notNull(),
  reviewerPrincipalId: text("reviewer_principal_id").notNull(),
  resolution: text("resolution").notNull(),
  evidenceSha256: text("evidence_sha256").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("review_browser_turn_resolutions_thread_idx").on(table.reviewThreadId, table.createdAt),
]);

export const reviewBrowserProfiles = sqliteTable("review_browser_profiles", {
  id: text("id").primaryKey(),
  ownerPrincipalId: text("owner_principal_id").notNull(),
  browserEngine: text("browser_engine").notNull().default("chromium"),
  mode: text("mode").notNull().default("headed"),
  status: text("status").notNull().default("stopped"),
  authState: text("auth_state").notNull().default("unknown"),
  generation: integer("generation").notNull().default(0),
  lastVerifiedAt: text("last_verified_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("review_browser_profiles_owner_idx").on(table.ownerPrincipalId, table.status),
]);
