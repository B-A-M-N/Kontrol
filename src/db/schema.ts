import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const workspaceSessions = sqliteTable("workspace_sessions", {
  id: text("id").primaryKey(),
  root: text("root").notNull(),
  status: text("status").notNull().default("active"),
  mode: text("mode").notNull().default("checkout"),
  sourceRoot: text("source_root"),
  baseRef: text("base_ref"),
  baseSha: text("base_sha"),
  managed: text("managed").notNull().default("false"),
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

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;

export const workSessions = sqliteTable("work_sessions", {
  id: text("id").primaryKey(),
  workspaceSessionId: text("workspace_session_id")
    .notNull()
    .references(() => workspaceSessions.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("in_progress"),
  completionPolicy: text("completion_policy").notNull().default("agent_completion"),
  reviewEpoch: integer("review_epoch").notNull().default(0),
  submittedBy: text("submitted_by").notNull(),
  title: text("title"),
  lastConsumedFeedbackId: text("last_consumed_feedback_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
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
  /** Exact working-tree snapshot commit the diff was captured against. Bound to
   * the submission so approval can require the workspace to still equal this
   * tree (fixes stale-approval after a concurrent submission in the same
   * workspace). */
  snapshotCommit: text("snapshot_commit"),
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
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("work_session_feedback_submission_unique").on(table.submissionId),
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
  index("wste_work_session_idx").on(table.workSessionId, table.createdAt),
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
  lastHeartbeat: text("last_heartbeat").notNull(),
  createdAt: text("created_at").notNull(),
  ttlSeconds: integer("ttl_seconds").notNull().default(60),
}, (table) => [
  index("agent_registry_name_idx").on(table.name),
  index("agent_registry_heartbeat_idx").on(table.lastHeartbeat),
]);

export const acpRuns = sqliteTable("acp_runs", {
  runId: text("run_id").primaryKey(),
  agentName: text("agent_name").notNull(),
  workspaceSessionId: text("workspace_session_id"),
  workSessionId: text("work_session_id"),
  remoteRunId: text("remote_run_id"),
  attemptNumber: integer("attempt_number").notNull().default(1),
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

export const agentWebhookQueue = sqliteTable("agent_webhook_queue", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => acpRuns.runId, { onDelete: "cascade" }),
  targetUrl: text("target_url").notNull(),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull().default("pending"),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  nextRetryAt: text("next_retry_at"),
}, (table) => [
  index("webhook_queue_status_idx").on(table.status, table.nextRetryAt),
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
  runId: text("run_id"),
  agentId: text("agent_id"),
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
}, (table) => [
  index("approval_requests_workspace_status_idx").on(table.workspaceSessionId, table.status, table.createdAt),
  index("approval_requests_work_session_status_idx").on(table.workSessionId, table.status, table.createdAt),
  index("approval_requests_run_idx").on(table.runId, table.createdAt),
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
  attemptCount: integer("attempt_count").notNull().default(0),
  availableAt: text("available_at").notNull(),
  claimedBy: text("claimed_by"),
  claimExpiresAt: text("claim_expires_at"),
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
  objective: text("objective").notNull(),
  desiredOutcome: text("desired_outcome").notNull(),
  constraintsJson: text("constraints_json").notNull().default("[]"),
  nonGoalsJson: text("non_goals_json").notNull().default("[]"),
  userLockedFieldsJson: text("user_locked_fields_json").notNull().default("[]"),
  supervisorInstructions: text("supervisor_instructions"),
  baselineCommit: text("baseline_commit"),
  correctionRounds: integer("correction_rounds").notNull().default(0),
  maxCorrectionRounds: integer("max_correction_rounds").notNull().default(5),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("mission_contracts_work_session_unique").on(table.workSessionId),
  index("mission_contracts_workspace_idx").on(table.workspaceSessionId, table.updatedAt),
]);

export const missionAcceptanceCriteria = sqliteTable("mission_acceptance_criteria", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missionContracts.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  priority: text("priority").notNull().default("required"),
  verificationType: text("verification_type").notNull().default("manual_review"),
  verificationCommand: text("verification_command"),
  affectedAreasJson: text("affected_areas_json").notNull().default("[]"),
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
  description: text("description").notNull(),
  evidenceJson: text("evidence_json").notNull().default("[]"),
  requiredAction: text("required_action").notNull(),
  requiredVerificationJson: text("required_verification_json").notNull().default("[]"),
  status: text("status").notNull().default("open"),
  resolutionSubmissionId: text("resolution_submission_id"),
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
  submissionId: text("submission_id"),
  snapshotCommit: text("snapshot_commit"),
  command: text("command"),
  outputDigest: text("output_digest"),
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
