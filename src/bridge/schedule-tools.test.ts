import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { createDispatchOutbox } from "../dispatch-outbox.js";
import { createEventStore } from "../event-log.js";
import { openDatabase } from "../db/client.js";
import { createScheduledJobStore } from "../scheduling/scheduled-job-store.js";
import { scheduledVerificationFingerprints } from "../scheduling/scheduled-verification-projection.js";
import { registerScheduleTools, sliceScheduledReportPage } from "./schedule-tools.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-scheduled-result-"));
const database = openDatabase(root);
const outbox = createDispatchOutbox(database);
const jobs = createScheduledJobStore(database, outbox);
const largeReport = "R".repeat(49_000);
const expectedReportSha256 = createHash("sha256").update(largeReport).digest("hex");
let missionReceipt: any = {
  approval: { allowed: false, reasons: ["independent verification has not passed"] },
  evidence: [],
};
let sessionStatus = "awaiting_review";
const submission = {
  id: "submission-1",
  snapshotKind: "git",
  snapshotRef: "snapshot-1",
  snapshotCommit: "snapshot-1",
  reviewEpoch: 1,
  diffSha256: "d".repeat(64),
};
const session = {
  id: "work-session-1",
  status: sessionStatus,
  principalId: "principal-a",
  updatedAt: "2026-10-12T12:00:00.000Z",
  latestSubmission: submission,
};
const cancelSession = { id: "work-session-cancel", status: "running", updatedAt: "2026-10-12T11:58:00.000Z" };
const cancelRun = { runId: "run-cancel", status: "running", agentName: "codex" };
const reviewStoppedSession = { id: "work-session-review-stopped", status: "awaiting_review", updatedAt: "2026-10-12T11:58:00.000Z" };
const reviewStoppedAt = new Date(Date.now() - 30_000).toISOString();
const reviewStoppedRun = { runId: "run-review-stopped", status: "awaiting_review", agentName: "codex", finishedAt: reviewStoppedAt };
const run = {
  runId: "run-1",
  status: "completed",
  agentName: "codex",
  finishedAt: "2026-10-12T11:59:00.000Z",
  outputJson: JSON.stringify({ output: [{ parts: [{ content: largeReport }] }] }),
};
const handlers = new Map<string, (input: any) => Promise<any>>();
const definitions = new Map<string, any>();
let reviewCancellationFinalizations = 0;
let manualReconciliationCalls = 0;
let reconciliationTargetId = "";
const server = {
  registerTool(name: string, definition: unknown, handler: (input: any) => Promise<any>) {
    definitions.set(name, definition);
    handlers.set(name, handler);
  },
} as any;

try {
  const reportRestartRoot = join(root, "report-restart");
  let reportRestartDb: ReturnType<typeof openDatabase> | undefined = openDatabase(reportRestartRoot);
  let reportRestartOutbox: ReturnType<typeof createDispatchOutbox> | undefined = createDispatchOutbox(reportRestartDb);
  let reportRestartJobs: ReturnType<typeof createScheduledJobStore> | undefined = createScheduledJobStore(reportRestartDb, reportRestartOutbox);
  try {
    const reportJob = reportRestartJobs.create({
      principalId: "principal-restart",
      ownerContextId: "principal:principal-restart|transport:A",
      projectId: "project-restart",
      workspaceRoot: "/tmp/project-restart",
      runAt: new Date().toISOString(),
      instructionJson: { instructions: "Keep the exact report across restart." },
      executionMode: "read_only_audit",
      policySnapshotJson: { workspaceAccess: "read_only", mutate: false },
      maxRuntimeMs: 60_000,
    });
    const originalText = `A😀B\n${"R".repeat(40)}`;
    const originalHash = createHash("sha256").update(originalText, "utf8").digest("hex");
    reportRestartJobs.persistReport(reportJob.id, "verification:before-restart", originalText);
    assert.throws(
      () => reportRestartJobs!.persistReport(reportJob.id, "verification:before-restart", "partial output changed later"),
      /changed after its immutable artifact was recorded/,
      "a later partial or terminal output cannot replace an immutable report for the same execution identity",
    );
    const durableVerificationInput = {
      jobId: reportJob.id,
      requestKey: "mutation:verification-across-restart",
      requestFingerprint: "f".repeat(64),
      clientMutationId: "verification-across-restart",
      executionIdentity: "verification:across-restart",
      workSessionId: "work-session-restart",
      submissionId: "submission-restart",
      reviewEpoch: 1,
      snapshotKind: "git" as const,
      snapshotRef: "snapshot-restart",
      commandFingerprint: "c".repeat(64),
      policyFingerprint: "p".repeat(64),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const durableVerification = reportRestartJobs.claimVerificationExecution(durableVerificationInput);
    assert.equal(durableVerification.owner, true);
    const runningRetry = reportRestartJobs.claimVerificationExecution({
      ...durableVerificationInput,
      executionIdentity: "verification:retry-before-response",
    });
    assert.equal(runningRetry.owner, false);
    assert.equal(runningRetry.execution.id, durableVerification.execution.id,
      "concurrent idempotent claims return the same durable running record");
    const distinctRunningRequest = reportRestartJobs.claimVerificationExecution({
      ...durableVerificationInput,
      requestKey: "mutation:verification-distinct-active-request",
      requestFingerprint: "1".repeat(64),
      clientMutationId: "verification-distinct-active-request",
      executionIdentity: "verification:distinct-active-request",
    });
    assert.equal(distinctRunningRequest.owner, false);
    assert.equal(distinctRunningRequest.execution.id, durableVerification.execution.id,
      "different reviewer request IDs join the active execution for the same snapshot and verification policy");
    assert.throws(
      () => reportRestartJobs!.claimVerificationExecution({
        ...durableVerificationInput,
        requestFingerprint: "d".repeat(64),
        executionIdentity: "verification:conflicting-request",
      }),
      /already used with different submission or verification content/,
      "the durable claim rejects conflicting reuse of a reviewer mutation ID",
    );
    const verificationReportText = "immutable scheduled verification across restart";
    const completedVerification = reportRestartJobs.completeVerificationExecution({
      executionId: durableVerification.execution.id,
      reportText: verificationReportText,
    });
    const sequentialFreshVerification = reportRestartJobs.claimVerificationExecution({
      ...durableVerificationInput,
      requestKey: "mutation:verification-sequential-fresh",
      requestFingerprint: "2".repeat(64),
      clientMutationId: "verification-sequential-fresh",
      executionIdentity: "verification:sequential-fresh",
    });
    assert.equal(sequentialFreshVerification.owner, true,
      "a distinct request can start a fresh equivalent verification after the prior execution completes");
    assert.notEqual(sequentialFreshVerification.execution.id, completedVerification.id);
    reportRestartJobs.completeVerificationExecution({
      executionId: sequentialFreshVerification.execution.id,
      reportText: "second sequential verification report",
    });
    const staleVerificationInput = {
      ...durableVerificationInput,
      requestKey: "mutation:verification-interrupted-by-restart",
      requestFingerprint: "e".repeat(64),
      clientMutationId: "verification-interrupted-by-restart",
      executionIdentity: "verification:interrupted-by-restart",
      deadlineAt: new Date(Date.now() - 1_000).toISOString(),
    };
    const interruptedVerification = reportRestartJobs.claimVerificationExecution(staleVerificationInput);
    assert.equal(interruptedVerification.execution.status, "running");

    reportRestartJobs.close();
    reportRestartJobs = undefined;
    reportRestartOutbox.close();
    reportRestartOutbox = undefined;
    reportRestartDb.close();
    reportRestartDb = undefined;

    reportRestartDb = openDatabase(reportRestartRoot);
    reportRestartOutbox = createDispatchOutbox(reportRestartDb);
    reportRestartJobs = createScheduledJobStore(reportRestartDb, reportRestartOutbox);
    const completedRetry = reportRestartJobs.claimVerificationExecution({
      ...durableVerificationInput,
      executionIdentity: "verification:retry-after-restart",
    });
    assert.equal(completedRetry.owner, false);
    assert.equal(completedRetry.execution.id, completedVerification.id);
    assert.equal(completedRetry.execution.status, "completed",
      "completed verification receipts remain idempotently retrievable after restart");
    assert.equal(reportRestartJobs.getVerificationReport(reportJob.id, completedVerification.reportSha256!)?.reportText, verificationReportText);
    assert.equal(reportRestartJobs.reconcileStaleVerificationExecutions(25), 1,
      "restart recovery converts expired in-flight verification into a durable failure");
    const reconciledInterrupted = reportRestartJobs.getLatestVerificationExecution({
      jobId: reportJob.id,
      workSessionId: staleVerificationInput.workSessionId,
      submissionId: staleVerificationInput.submissionId,
      reviewEpoch: staleVerificationInput.reviewEpoch,
      snapshotKind: staleVerificationInput.snapshotKind,
      snapshotRef: staleVerificationInput.snapshotRef,
      commandFingerprint: staleVerificationInput.commandFingerprint,
      policyFingerprint: staleVerificationInput.policyFingerprint,
    });
    assert.equal(reconciledInterrupted?.status, "failed");
    const laterText = "newer report after restart";
    reportRestartJobs.persistReport(reportJob.id, "verification:after-restart", laterText);
    const pinned = reportRestartJobs.getReport(reportJob.id, originalHash);
    assert.equal(pinned?.reportText, originalText, "reopening the database preserves the original immutable report artifact");

    const pages: string[] = [];
    let offset = 1;
    while (true) {
      const page = sliceScheduledReportPage(pinned!.reportText, offset, 5);
      pages.push(page.page);
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    const reconstructed = pages.join("");
    assert.equal(reconstructed, originalText, "restart-safe pages reconstruct the exact pinned report despite a newer run");
    assert.equal(createHash("sha256").update(reconstructed, "utf8").digest("hex"), originalHash,
      "the full report digest remains stable across pagination and database restart");
  } finally {
    reportRestartJobs?.close();
    reportRestartOutbox?.close();
    reportRestartDb?.close();
  }

  const created = jobs.create({
    principalId: "principal-a",
    ownerContextId: "principal:principal-a|transport:A",
    projectId: "project-a",
    workspaceRoot: "/tmp/project-a",
    runAt: new Date(Date.now() - 1_000).toISOString(),
    instructionJson: { instructions: "Produce a reviewable report." },
    executionMode: "read_only_audit",
    policySnapshotJson: { workspaceAccess: "read_only", mutate: false, verificationCommands: ["npm test"] },
    maxRuntimeMs: 60_000,
  });
  jobs.transition({ jobId: created.id, expectedRevision: created.revision, nextStatus: "due", expectedSourceStatuses: ["pending"] });
  const dispatch = jobs.claimDispatch({ jobId: created.id, expectedRevision: 2, dispatcherInstanceId: "test-scheduler" });
  jobs.completeDispatch({
    jobId: created.id,
    dispatchAttemptId: dispatch.attemptId,
    expectedRevision: dispatch.revision,
    dispatcherInstanceId: "test-scheduler",
    outcome: "dispatched",
    workSessionId: session.id,
    acpRunId: run.runId,
    acpDispatchId: dispatch.dispatchId,
    acpAttemptNumber: 1,
    executionReceipt: {
      issuer: "kontrol",
      work_session_id: session.id,
      workspace_session_id: "project-a",
      parent_run_id: run.runId,
      remote_run_id: "remote-run-1",
      attempt_number: 1,
      dispatch_idempotency_key: dispatch.dispatchId,
      grant_expires_at: Date.now() + 60_000,
      grant_fingerprint: "a".repeat(64),
      network_policy: "disabled",
      confinement: "bubblewrap-read-only-workspace-no-network",
    },
  });
  const lifecycleBase = new Date().toISOString();
  jobs.projectEvent({
    id: "scheduled-worker-started",
    seq: 1,
    durable: true,
    type: "agent.run.started",
    sessionId: session.id,
    payload: { runId: run.runId, dispatchId: dispatch.dispatchId, attemptNumber: 1, remoteRunId: "remote-run-1" },
    createdAt: lifecycleBase,
  });
  jobs.projectEvent({
    id: "scheduled-review-submitted",
    seq: 2,
    durable: true,
    type: "review.submitted",
    sessionId: session.id,
    payload: { runId: run.runId, submissionId: submission.id },
    createdAt: new Date(Date.parse(lifecycleBase) + 1).toISOString(),
  });
  jobs.projectEvent({
    id: "scheduled-worker-turn-completed",
    seq: 3,
    durable: true,
    type: "worker.turn.completed",
    sessionId: session.id,
    payload: {
      runId: run.runId,
      dispatchId: dispatch.dispatchId,
      attemptNumber: 1,
      remoteRunId: "remote-run-1",
      final_output: "R".repeat(49_000),
    },
    createdAt: new Date(Date.parse(lifecycleBase) + 2).toISOString(),
  });

  const config: any = {
    principalRole: "reviewer",
    principalId: "principal-a",
    connectionContext: { authenticatedPrincipalId: "principal-a", mcpSessionId: "transport-B" },
    scheduledJobs: jobs,
    reconcileScheduledJob: async (jobId: string) => {
      manualReconciliationCalls++;
      assert.equal(jobId, reconciliationTargetId);
      return jobs.get(jobId);
    },
    workspaces: { getWorkspace: () => ({ id: "project-a", root: "/tmp/project-a" }) },
    workSessions: { get: (id: string) => id === session.id
      ? { ...session, status: sessionStatus }
      : id === "work-session-unpersisted" ? { id, status: "awaiting_review", updatedAt: "2026-10-12T12:00:00.000Z" }
      : id === cancelSession.id ? cancelSession
        : id === reviewStoppedSession.id ? reviewStoppedSession
          : undefined },
    agentRegistry: { getRunByWorkSessionId: (id: string) => id === session.id
      ? run
      : id === "work-session-finalization" ? {
          runId: "run-finalization",
          status: "completed",
          agentName: "codex",
          outputJson: JSON.stringify({ output: [{ parts: [{ content: "stale first-attempt report must not be reused" }] }] }),
        }
      : id === "work-session-unpersisted" ? {
          runId: "run-unpersisted",
          status: "completed",
          agentName: "codex",
          finishedAt: "2026-10-12T12:01:00.000Z",
          outputJson: JSON.stringify({ output: [{ parts: [{ content: "not yet persisted" }] }] }),
        }
      : id === cancelSession.id ? cancelRun
        : id === reviewStoppedSession.id ? reviewStoppedRun
          : undefined,
      getLatestDispatchAttemptForRun: (runId: string) => runId === reviewStoppedRun.runId
        ? { createdAt: new Date(Date.parse(reviewStoppedAt) - 60_000).toISOString() }
        : undefined,
      listAlive: () => { throw new Error("remote cancellation must not be attempted after confirmed worker exit"); } },
    reviewWorkflow: {
      cancelSession: () => ({ status: "cancellation_requested" }),
      finalizeCancellation: () => {
        reviewCancellationFinalizations++;
        return { status: "cancelled" };
      },
    },
    missionLedger: { getResultReceipt: (_id: string, identity: unknown) => {
      assert.deepEqual(identity, {
        submissionId: submission.id,
        snapshotKind: submission.snapshotKind,
        snapshotRef: submission.snapshotRef,
        snapshotCommit: submission.snapshotCommit,
        reviewEpoch: submission.reviewEpoch,
      }, "result verification is bound to the exact active submission snapshot and review epoch");
      return missionReceipt;
    } },
  };
  registerScheduleTools(server, config);

  const operatorJob = jobs.create({
    principalId: "principal-a",
    ownerContextId: "principal:principal-a|transport:A",
    projectId: "project-a",
    workspaceRoot: "/tmp/project-a",
    runAt: new Date(Date.now() - 1_000).toISOString(),
    instructionJson: { instructions: "Reconcile an uncertain dispatch." },
    executionMode: "read_only_audit",
    policySnapshotJson: { workspaceAccess: "read_only", mutate: false },
    maxRuntimeMs: 60_000,
  });
  reconciliationTargetId = operatorJob.id;
  jobs.transition({ jobId: operatorJob.id, expectedRevision: 1, nextStatus: "due", expectedSourceStatuses: ["pending"] });
  const operatorClaim = jobs.claimDispatch({ jobId: operatorJob.id, expectedRevision: 2, dispatcherInstanceId: "test-scheduler" });
  const uncertainDispatch = jobs.completeDispatch({
    jobId: operatorJob.id,
    dispatchAttemptId: operatorClaim.attemptId,
    expectedRevision: operatorClaim.revision,
    dispatcherInstanceId: "test-scheduler",
    outcome: "uncertain",
    workSessionId: "ws-operator-tool",
    acpRunId: "run-operator-tool",
    acpDispatchId: operatorClaim.dispatchId,
    acpAttemptNumber: 1,
    acpRemoteRunId: "remote-operator-tool",
  });
  jobs.resolveDispatch({
    jobId: operatorJob.id,
    dispatchAttemptId: operatorClaim.attemptId,
    expectedRevision: uncertainDispatch.revision,
    resolution: "operator_intervention",
    workSessionId: "ws-operator-tool",
    acpRunId: "run-operator-tool",
    acpDispatchId: operatorClaim.dispatchId,
    acpAttemptNumber: 1,
    acpRemoteRunId: "remote-operator-tool",
  });
  const reconcileTool = handlers.get("reconcile_scheduled_job");
  assert.ok(reconcileTool, "reviewer reconciliation is registered");
  const reconciledJob = await reconcileTool({ scheduledJobId: operatorJob.id });
  assert.equal(reconciledJob.structuredContent.status, "operator_intervention",
    "manual reconciliation returns current durable state when the adapter receipt remains unresolved");
  assert.equal(manualReconciliationCalls, 1);
  assert.equal(jobs.get(operatorJob.id)?.status, "operator_intervention",
    "an inconclusive lookup does not clear operator intervention");
  const savedRole = config.principalRole;
  config.principalRole = "agent";
  const deniedReconciliation = await reconcileTool({ scheduledJobId: operatorJob.id });
  config.principalRole = savedRole;
  assert.equal(deniedReconciliation.isError, true, "only reviewers can manually reconcile an uncertain dispatch");
  assert.equal(manualReconciliationCalls, 1, "forbidden reconciliation does not contact the adapter receipt lookup");

  const resultTool = handlers.get("get_scheduled_job_result");
  assert.ok(resultTool, "scheduled result retrieval is registered");
  const savedResultRole = config.principalRole;
  config.principalRole = "agent";
  const foreignResult = await resultTool({ scheduledJobId: created.id });
  config.principalRole = savedResultRole;
  assert.equal(foreignResult.isError, true, "non-reviewers cannot read scheduled results");
  const jobReadTool = handlers.get("get_scheduled_job");
  assert.ok(jobReadTool, "scheduled job retrieval is registered");
  config.principalRole = "agent";
  const foreignJobRead = await jobReadTool({ scheduledJobId: created.id });
  config.principalRole = savedResultRole;
  assert.equal(foreignJobRead.isError, true, "non-reviewers cannot read scheduled jobs");
  const unpersistedJob = jobs.create({
    principalId: "principal-a",
    ownerContextId: "principal:principal-a|transport:A",
    projectId: "project-a",
    workspaceRoot: "/tmp/project-a",
    runAt: new Date().toISOString(),
    instructionJson: { instructions: "Read a result without creating its artifact." },
    executionMode: "read_only_audit",
    policySnapshotJson: { workspaceAccess: "read_only", mutate: false },
    workSessionId: "work-session-unpersisted",
    maxRuntimeMs: 60_000,
  });
  const reportRowsBeforeReads = Number((database.sqlite.prepare("select count(*) as count from scheduled_job_reports").get() as { count: number }).count);
  const priorMissionLedger = config.missionLedger;
  config.missionLedger = { getResultReceipt: () => { throw new Error("no such column: outcome_evidence"); } } as any;
  const noArtifactResult = await resultTool({ scheduledJobId: unpersistedJob.id });
  const noArtifactStatus = await jobReadTool({ scheduledJobId: unpersistedJob.id });
  config.missionLedger = priorMissionLedger;
  assert.equal(noArtifactResult.structuredContent.resultReceipt.workerCompleted, false,
    "a finishedAt value alone does not prove authoritative worker completion");
  assert.equal(noArtifactResult.structuredContent.report, "",
    "result reads do not manufacture an immutable report from live ACP output");
  assert.equal(noArtifactStatus.structuredContent.scheduledJobId, unpersistedJob.id);
  assert.equal(noArtifactResult.structuredContent.resultReceipt.verificationStatus, "not_performed",
    "mission-ledger failure cannot manufacture a passing verification result");
  assert.ok(noArtifactResult.structuredContent.resultReceipt.unresolvedBlockers.some((item: string) => item.includes("mission ledger could not be read")),
    "the ordinary execution receipt remains readable and exposes its mission-evidence limitation");
  assert.equal(noArtifactResult.structuredContent.resultReceipt.verificationStatus, "not_performed");
  assert.ok(noArtifactResult.structuredContent.resultReceipt.verificationBlockers.some((item: string) => item.includes("no submitted immutable snapshot")),
    "report-only audits never imply that scheduled verification ran without a submitted baseline");
  assert.equal(Number((database.sqlite.prepare("select count(*) as count from scheduled_job_reports").get() as { count: number }).count), reportRowsBeforeReads,
    "both read-only job getters leave the report table unchanged when no artifact exists");

  const rejectedJob = jobs.create({
    principalId: "principal-a",
    ownerContextId: "principal:principal-a|transport:A",
    projectId: "project-a",
    workspaceRoot: "/tmp/project-a",
    runAt: new Date(Date.now() - 1_000).toISOString(),
    instructionJson: { instructions: "Reject before worker spawn." },
    executionMode: "read_only_audit",
    policySnapshotJson: { workspaceAccess: "read_only", mutate: false },
    maxRuntimeMs: 60_000,
  });
  jobs.transition({ jobId: rejectedJob.id, expectedRevision: rejectedJob.revision, nextStatus: "due", expectedSourceStatuses: ["pending"] });
  const rejectedClaim = jobs.claimDispatch({ jobId: rejectedJob.id, expectedRevision: 2, dispatcherInstanceId: "test-scheduler" });
  jobs.completeDispatch({
    jobId: rejectedJob.id,
    dispatchAttemptId: rejectedClaim.attemptId,
    expectedRevision: rejectedClaim.revision,
    dispatcherInstanceId: "test-scheduler",
    outcome: "failed",
    lastError: "Adapter rejected admission before spawn.",
  });
  const rejectedReceipt = await resultTool({ scheduledJobId: rejectedJob.id });
  assert.equal(rejectedReceipt.structuredContent.resultReceipt.dispatchStatus, "rejected");
  assert.equal(rejectedReceipt.structuredContent.resultReceipt.workerCompleted, false,
    "definitive pre-spawn rejection never becomes worker completion");
  assert.equal(rejectedReceipt.structuredContent.resultReceipt.executionStatus, "dispatch_rejected");
  assert.equal(rejectedReceipt.structuredContent.resultReceipt.reviewApproved, false);
  assert.equal(rejectedReceipt.structuredContent.resultReceipt.verificationStatus, "not_performed");

  const interruptedJob = jobs.create({
    principalId: "principal-a",
    ownerContextId: "principal:principal-a|transport:A",
    projectId: "project-a",
    workspaceRoot: "/tmp/project-a",
    runAt: new Date(Date.now() - 1_000).toISOString(),
    instructionJson: { instructions: "Recover a lost adapter acknowledgement." },
    executionMode: "read_only_audit",
    policySnapshotJson: { workspaceAccess: "read_only", mutate: false },
    maxRuntimeMs: 60_000,
  });
  jobs.transition({ jobId: interruptedJob.id, expectedRevision: interruptedJob.revision, nextStatus: "due", expectedSourceStatuses: ["pending"] });
  const interruptedClaim = jobs.claimDispatch({ jobId: interruptedJob.id, expectedRevision: 2, dispatcherInstanceId: "test-scheduler" });
  jobs.completeDispatch({
    jobId: interruptedJob.id,
    dispatchAttemptId: interruptedClaim.attemptId,
    expectedRevision: interruptedClaim.revision,
    dispatcherInstanceId: "test-scheduler",
    outcome: "uncertain",
    workSessionId: "work-session-interrupted-dispatch",
    acpRunId: "run-interrupted-dispatch",
    agentName: "cli-coding-agent",
    lastError: "Adapter response was lost after start intent.",
    failureClass: "adapter_acceptance_uncertain",
    probeResult: { executionMode: "read_only_audit", healthProbe: "healthy" },
  });
  const interruptedReceipt = await resultTool({ scheduledJobId: interruptedJob.id });
  assert.equal(interruptedReceipt.structuredContent.resultReceipt.scheduledJobStatus, "uncertain_dispatch");
  assert.equal(interruptedReceipt.structuredContent.resultReceipt.dispatchStatus, "uncertain");
  assert.equal(interruptedReceipt.structuredContent.resultReceipt.executionStatus, "dispatch_uncertain");
  assert.equal(interruptedReceipt.structuredContent.resultReceipt.workerCompleted, false,
    "an interrupted acknowledgement is distinct from a started or completed worker");
  assert.equal(interruptedReceipt.structuredContent.resultReceipt.dispatchAttempts[0]?.failureClass, "adapter_acceptance_uncertain");

  const unavailableSandboxJob = jobs.create({
    principalId: "principal-a",
    ownerContextId: "principal:principal-a|transport:A",
    projectId: "project-a",
    workspaceRoot: "/tmp/project-a",
    runAt: new Date(Date.now() - 1_000).toISOString(),
    instructionJson: { instructions: "Fail closed when read-only confinement is unavailable." },
    executionMode: "read_only_audit",
    policySnapshotJson: { workspaceAccess: "read_only", mutate: false },
    maxRuntimeMs: 60_000,
  });
  jobs.transition({ jobId: unavailableSandboxJob.id, expectedRevision: unavailableSandboxJob.revision, nextStatus: "due", expectedSourceStatuses: ["pending"] });
  const unavailableSandboxClaim = jobs.claimDispatch({ jobId: unavailableSandboxJob.id, expectedRevision: 2, dispatcherInstanceId: "test-scheduler" });
  jobs.releaseDispatch({
    jobId: unavailableSandboxJob.id,
    dispatchAttemptId: unavailableSandboxClaim.attemptId,
    expectedRevision: unavailableSandboxClaim.revision,
    dispatcherInstanceId: "test-scheduler",
    blocker: {
      kind: "permanent_configuration",
      reason: "Scheduled read_only_audit preflight failed: required bubblewrap confinement is unavailable.",
      lastAttemptedAgent: "cli-coding-agent",
      failureClass: "execution_mode_preflight_failed",
      probeResult: { executionMode: "read_only_audit", healthProbe: "healthy", confinementAvailable: false },
    },
  });
  const unavailableSandboxReceipt = await resultTool({ scheduledJobId: unavailableSandboxJob.id });
  assert.equal(unavailableSandboxReceipt.structuredContent.resultReceipt.scheduledJobStatus, "blocked");
  assert.equal(unavailableSandboxReceipt.structuredContent.resultReceipt.dispatchStatus, "unstarted");
  assert.equal(unavailableSandboxReceipt.structuredContent.resultReceipt.workerCompleted, false);
  assert.equal(unavailableSandboxReceipt.structuredContent.resultReceipt.dispatchAttempts[0]?.failureClass, "execution_mode_preflight_failed");
  assert.equal(unavailableSandboxReceipt.structuredContent.resultReceipt.dispatchAttempts[0]?.probeResult?.confinementAvailable, false);
  assert.match(unavailableSandboxReceipt.structuredContent.resultReceipt.dispatchAttempts[0]?.failureReason ?? "", /bubblewrap confinement is unavailable/);

  const failedExecutionJob = jobs.create({
    principalId: "principal-a",
    ownerContextId: "principal:principal-a|transport:A",
    projectId: "project-a",
    workspaceRoot: "/tmp/project-a",
    runAt: new Date(Date.now() - 1_000).toISOString(),
    instructionJson: { instructions: "Fail after worker start." },
    executionMode: "read_only_audit",
    policySnapshotJson: { workspaceAccess: "read_only", mutate: false },
    workSessionId: "work-session-failed-execution",
    maxRuntimeMs: 60_000,
  });
  jobs.transition({ jobId: failedExecutionJob.id, expectedRevision: failedExecutionJob.revision, nextStatus: "due", expectedSourceStatuses: ["pending"] });
  const failedExecutionClaim = jobs.claimDispatch({ jobId: failedExecutionJob.id, expectedRevision: 2, dispatcherInstanceId: "test-scheduler" });
  jobs.completeDispatch({
    jobId: failedExecutionJob.id,
    dispatchAttemptId: failedExecutionClaim.attemptId,
    expectedRevision: failedExecutionClaim.revision,
    dispatcherInstanceId: "test-scheduler",
    outcome: "dispatched",
    workSessionId: "work-session-failed-execution",
    acpRunId: "run-failed-execution",
    acpDispatchId: failedExecutionClaim.dispatchId,
    acpAttemptNumber: 1,
  });
  jobs.projectEvent({
    id: "failed-execution-started",
    seq: 1,
    durable: true,
    type: "agent.run.started",
    sessionId: "work-session-failed-execution",
    payload: { runId: "run-failed-execution", dispatchId: failedExecutionClaim.dispatchId, attemptNumber: 1 },
    createdAt: lifecycleBase,
  });
  jobs.projectEvent({
    id: "failed-execution-terminal",
    seq: 2,
    durable: true,
    type: "agent.run.failed",
    sessionId: "work-session-failed-execution",
    payload: {
      runId: "run-failed-execution",
      dispatchId: failedExecutionClaim.dispatchId,
      attemptNumber: 1,
      final_output: "worker exited unsuccessfully",
    },
    createdAt: new Date(Date.parse(lifecycleBase) + 3).toISOString(),
  });
  const durableFailureEvents = createEventStore(database);
  durableFailureEvents.appendEvent({
    id: "failed-execution-diagnostic-event",
    type: "agent.run.failed",
    sessionId: "work-session-failed-execution",
    payload: {
      runId: "run-failed-execution",
      dispatchId: failedExecutionClaim.dispatchId,
      attemptNumber: 1,
      exit_code: 1,
      stderr: "ERROR\\nNo prompt provided.\\nAuthorization: Bearer legacy-secret-value",
    },
  });
  durableFailureEvents.appendEvent({
    id: "failed-execution-reason-only-event",
    type: "agent.run.failed",
    sessionId: "work-session-failed-execution",
    payload: {
      runId: "run-failed-execution",
      dispatchId: failedExecutionClaim.dispatchId,
      attemptNumber: 1,
      reason: "worker process exited",
    },
  });
  const failedExecutionReceipt = await resultTool({ scheduledJobId: failedExecutionJob.id });
  assert.equal(failedExecutionReceipt.structuredContent.resultReceipt.workerCompleted, false);
  assert.equal(failedExecutionReceipt.structuredContent.resultReceipt.workerExecutionOutcome, "failed");
  assert.equal(failedExecutionReceipt.structuredContent.resultReceipt.executionStatus, "failed",
    "a started worker's unsuccessful exit remains an execution failure");
  assert.equal(failedExecutionReceipt.structuredContent.resultReceipt.reviewApproved, false);
  assert.equal(failedExecutionReceipt.structuredContent.resultReceipt.verificationStatus, "not_performed");
  assert.equal(failedExecutionReceipt.structuredContent.resultReceipt.workerFailureEvidence?.exitCode, 1);
  assert.match(failedExecutionReceipt.structuredContent.resultReceipt.workerFailureEvidence?.sanitizedStderrTail ?? "", /No prompt provided/);
  assert.doesNotMatch(failedExecutionReceipt.structuredContent.resultReceipt.workerFailureEvidence?.sanitizedStderrTail ?? "", /legacy-secret-value/,
    "legacy stderr is redacted before it is exposed by a scheduled result");
  assert.equal(failedExecutionReceipt.structuredContent.resultReceipt.workerFailureEvidence?.eventId, "failed-execution-diagnostic-event");

  durableFailureEvents.appendEvent({
    id: "structured-failed-execution-diagnostic-event",
    type: "agent.run.failed",
    sessionId: "work-session-failed-execution",
    payload: {
      runId: "run-failed-execution",
      dispatchId: failedExecutionClaim.dispatchId,
      attemptNumber: 1,
      workerFailureEvidence: {
        phase: "execution",
        category: "nonzero_exit",
        exitCode: 1,
        sanitizedStderrTail: "ERROR\\nNo prompt provided.",
        eventId: "failed-execution-terminal",
        runId: "run-failed-execution",
        attemptNumber: 1,
      },
    },
  });
  const structuredFailureReceipt = await resultTool({ scheduledJobId: failedExecutionJob.id });
  assert.equal(structuredFailureReceipt.structuredContent.resultReceipt.workerFailureEvidence?.eventId, "failed-execution-terminal",
    "new structured worker evidence remains preferred when available");

  const finalizationJob = jobs.create({
    principalId: "principal-a",
    ownerContextId: "principal:principal-a|transport:A",
    projectId: "project-a",
    workspaceRoot: "/tmp/project-a",
    runAt: new Date(Date.now() - 1_000).toISOString(),
    instructionJson: { instructions: "Recover terminal report persistence." },
    executionMode: "read_only_audit",
    policySnapshotJson: { workspaceAccess: "read_only", mutate: false },
    workSessionId: "work-session-finalization",
    maxRuntimeMs: 60_000,
  });
  jobs.transition({ jobId: finalizationJob.id, expectedRevision: 1, nextStatus: "due", expectedSourceStatuses: ["pending"] });
  const finalizationClaim = jobs.claimDispatch({ jobId: finalizationJob.id, expectedRevision: 2, dispatcherInstanceId: "test-scheduler" });
  jobs.completeDispatch({
    jobId: finalizationJob.id,
    dispatchAttemptId: finalizationClaim.attemptId,
    expectedRevision: finalizationClaim.revision,
    dispatcherInstanceId: "test-scheduler",
    outcome: "dispatched",
    workSessionId: "work-session-finalization",
    acpRunId: "run-finalization",
    acpDispatchId: finalizationClaim.dispatchId,
    acpAttemptNumber: 1,
  });
  database.sqlite.exec(`create trigger fail_scheduled_report_insert before insert on scheduled_job_reports when new.job_id = '${finalizationJob.id}' begin select raise(fail, 'simulated artifact persistence failure'); end`);
  jobs.projectEvent({
    id: "finalization-worker-terminal",
    seq: 1,
    durable: true,
    type: "worker.turn.completed",
    sessionId: "work-session-finalization",
    payload: {
      runId: "run-finalization",
      dispatchId: finalizationClaim.dispatchId,
      attemptNumber: 1,
      final_output: "durable output awaiting artifact recovery",
    },
    createdAt: lifecycleBase,
  });
  const pendingFinalization = jobs.getReportFinalization(finalizationJob.id, "run-finalization", 1);
  assert.equal(pendingFinalization?.status, "pending");
  assert.match(pendingFinalization?.lastError ?? "", /simulated artifact persistence failure/);
  database.sqlite.exec("drop trigger fail_scheduled_report_insert");
  assert.equal(jobs.reconcilePendingReportFinalizations(25), 1,
    "terminal report persistence is retried by the scheduler without a result read");
  assert.equal(jobs.getReportFinalization(finalizationJob.id, "run-finalization", 1)?.status, "completed");
  assert.equal(jobs.getReportForAttempt(finalizationJob.id, "run-finalization", 1)?.reportText, "durable output awaiting artifact recovery");
  const firstAttemptState = jobs.get(finalizationJob.id)!;
  const nextAttemptDue = jobs.transition({
    jobId: finalizationJob.id,
    expectedRevision: firstAttemptState.revision,
    nextStatus: "due",
    expectedSourceStatuses: ["running"],
  });
  const secondFinalizationClaim = jobs.claimDispatch({
    jobId: finalizationJob.id,
    expectedRevision: nextAttemptDue.revision,
    dispatcherInstanceId: "test-scheduler",
  });
  jobs.completeDispatch({
    jobId: finalizationJob.id,
    dispatchAttemptId: secondFinalizationClaim.attemptId,
    expectedRevision: secondFinalizationClaim.revision,
    dispatcherInstanceId: "test-scheduler",
    outcome: "dispatched",
    workSessionId: "work-session-finalization",
    acpRunId: "run-finalization",
    acpDispatchId: secondFinalizationClaim.dispatchId,
    acpAttemptNumber: 2,
  });
  jobs.projectEvent({
    id: "finalization-second-attempt-no-output",
    seq: 2,
    durable: true,
    type: "worker.turn.completed",
    sessionId: "work-session-finalization",
    payload: {
      runId: "run-finalization",
      dispatchId: secondFinalizationClaim.dispatchId,
      attemptNumber: 2,
      report_availability: "no_output",
    },
    createdAt: new Date(Date.parse(lifecycleBase) + 4).toISOString(),
  });
  assert.equal(jobs.getReportForAttempt(finalizationJob.id, "run-finalization", 1)?.reportText,
    "durable output awaiting artifact recovery", "the first attempt's immutable output remains available");
  assert.equal(jobs.getReportFinalization(finalizationJob.id, "run-finalization", 2)?.status, "no_output");
  assert.equal(jobs.getReportForAttempt(finalizationJob.id, "run-finalization", 2), undefined,
    "an attempt without authoritative text has no report artifact");
  const missingAttemptReport = await resultTool({ scheduledJobId: finalizationJob.id });
  assert.equal(missingAttemptReport.structuredContent.resultReceipt.reportAvailability, "no_output");
  assert.equal(missingAttemptReport.structuredContent.report, "");
  assert.equal(missingAttemptReport.structuredContent.outputPreview, undefined,
    "the previous attempt's outputJson cannot masquerade as the new attempt's audit report");
  const resultOutputSchema = z.object(definitions.get("get_scheduled_job_result").outputSchema);
  assert.equal(resultOutputSchema.safeParse(missingAttemptReport.structuredContent).success, true,
    "a valid no_output report-finalization state remains readable through the declared result schema");
  for (const reportFinalizationStatus of ["pending", "completed", "no_output", "unavailable"] as const) {
    const candidate = {
      ...missingAttemptReport.structuredContent,
      resultReceipt: { ...missingAttemptReport.structuredContent.resultReceipt, reportFinalizationStatus },
    };
    assert.equal(resultOutputSchema.safeParse(candidate).success, true,
      `report finalization state ${reportFinalizationStatus} is accepted by the result schema`);
  }

  const firstPage = await resultTool({ scheduledJobId: created.id, reportLimit: 100 });
  assert.equal(firstPage.structuredContent.resultReceipt.executionStatus, "completed",
    "a finished worker turn is reported as execution completion");
  assert.equal(firstPage.structuredContent.resultReceipt.workerStatus, "completed");
  assert.equal(firstPage.structuredContent.resultReceipt.publicationStatus, "not_applicable");
  assert.equal(firstPage.structuredContent.resultReceipt.outcomeObserved, false,
    "worker completion alone cannot claim independent outcome observation");
  assert.equal(firstPage.structuredContent.resultReceipt.reportAvailability, "available");
  assert.equal(firstPage.structuredContent.outputPreview, largeReport.slice(0, 2_000),
    "the result preview comes from the persisted attempt report");
  assert.equal(firstPage.structuredContent.resultReceipt.executionTerminalAt, new Date(Date.parse(lifecycleBase) + 2).toISOString());
  assert.equal(firstPage.structuredContent.resultReceipt.workerExecutionOutcome, "completed");
  assert.equal(firstPage.structuredContent.resultReceipt.workerCompleted, true);
  assert.equal(firstPage.structuredContent.resultReceipt.terminalAt, undefined,
    "the scheduled job has no terminal timestamp while review is pending");
  assert.equal(firstPage.structuredContent.resultReceipt.reviewStatus, "pending",
    "worker completion does not claim review approval");
  assert.equal(firstPage.structuredContent.resultReceipt.verificationStatus, "not_performed",
    "worker completion alone is not independent verification");
  assert.equal(firstPage.structuredContent.resultReceipt.independentOutcomeObserved, false);
  assert.equal(firstPage.structuredContent.resultReceipt.reviewApproved, false);
  assert.equal(firstPage.structuredContent.resultReceipt.verificationLevel, "not_performed");
  assert.equal(firstPage.structuredContent.report.length, 100);
  assert.equal(jobs.getReport(created.id, firstPage.structuredContent.reportSha256)?.reportText, largeReport,
    "the first page pins a durable immutable report for retrieval after restart");
  assert.equal(firstPage.structuredContent.reportSha256, expectedReportSha256,
    "the full persisted report hash is independent of the returned page size");
  assert.equal(firstPage.structuredContent.reportNextOffset, 101);
  assert.equal(firstPage.structuredContent.reportTruncated, true);
  assert.equal(firstPage.structuredContent.resultReceipt.runId, run.runId);
  assert.equal(firstPage.structuredContent.resultReceipt.workSessionId, session.id);
  assert.equal(firstPage.structuredContent.resultReceipt.executionReceipt.dispatch_idempotency_key, dispatch.dispatchId,
    "the scheduled result exposes the exact accepted read-only execution receipt");
  assert.ok(firstPage.structuredContent.resultReceipt.artifactReferences.some((item: any) => item.kind === "acp_run_output"));
  assert.equal(z.object(definitions.get("get_scheduled_job_result").outputSchema).safeParse(firstPage.structuredContent).success, true,
    "result receipt matches the published tool output schema");

  const unpinnedPage = await resultTool({ scheduledJobId: created.id, reportOffset: 101, reportLimit: 200 });
  assert.equal(unpinnedPage.isError, true, "later result pages require the first page's immutable report hash");

  assert.deepEqual(sliceScheduledReportPage("a😀b", 2, 1), { page: "😀", nextOffset: 3 },
    "Unicode pagination counts complete code points and never splits a surrogate pair");
  const emojiPage = sliceScheduledReportPage("😀".repeat(12_001), 1, 48_000);
  assert.equal(Buffer.byteLength(emojiPage.page, "utf8"), 48_000,
    "report pages obey the structured result UTF-8 byte cap");
  assert.equal(emojiPage.nextOffset, 12_001);

  const stateTimeJob = jobs.create({
    principalId: "principal-a",
    ownerContextId: "principal:principal-a|transport:A",
    projectId: "project-a",
    workspaceRoot: "/tmp/project-a",
    runAt: new Date(Date.now() - 1_000).toISOString(),
    instructionJson: { instructions: "Track recoverable and terminal state times." },
    executionMode: "read_only_audit",
    policySnapshotJson: { workspaceAccess: "read_only", mutate: false },
    maxRuntimeMs: 60_000,
  });
  const stateTimeDue = jobs.transition({ jobId: stateTimeJob.id, expectedRevision: stateTimeJob.revision, nextStatus: "due", expectedSourceStatuses: ["pending"] });
  const blockedClaim = jobs.claimDispatch({ jobId: stateTimeJob.id, expectedRevision: stateTimeDue.revision, dispatcherInstanceId: "test-scheduler" });
  const blockedJob = jobs.releaseDispatch({
    jobId: stateTimeJob.id,
    dispatchAttemptId: blockedClaim.attemptId,
    expectedRevision: blockedClaim.revision,
    dispatcherInstanceId: "test-scheduler",
    blocker: { kind: "permanent_configuration", reason: "test blocker" },
  });
  assert.ok(blockedJob.blockedAt);
  assert.equal(blockedJob.terminalAt, undefined, "recoverable blocked state does not set terminalAt");
  const retriedJob = jobs.retryBlockedJob({ jobId: blockedJob.id, expectedRevision: blockedJob.revision });
  assert.equal(retriedJob.status, "due");
  assert.ok(retriedJob.blockedAt, "the blocked timestamp remains visible after a reviewer retry");
  assert.equal(retriedJob.terminalAt, undefined);
  const runningClaim = jobs.claimDispatch({ jobId: retriedJob.id, expectedRevision: retriedJob.revision, dispatcherInstanceId: "test-scheduler" });
  const runningJob = jobs.completeDispatch({
    jobId: retriedJob.id,
    dispatchAttemptId: runningClaim.attemptId,
    expectedRevision: runningClaim.revision,
    dispatcherInstanceId: "test-scheduler",
    outcome: "dispatched",
  });
  assert.equal(runningJob.status, "running");
  assert.equal(runningJob.terminalAt, undefined);
  const awaitingApprovalJob = jobs.transition({ jobId: runningJob.id, expectedRevision: runningJob.revision, nextStatus: "awaiting_approval", expectedSourceStatuses: ["running"] });
  assert.equal(awaitingApprovalJob.terminalAt, undefined);
  assert.ok(awaitingApprovalJob.lastStateChangedAt);
  const completedStateTimeJob = jobs.transition({ jobId: awaitingApprovalJob.id, expectedRevision: awaitingApprovalJob.revision, nextStatus: "completed", expectedSourceStatuses: ["awaiting_approval"] });
  assert.ok(completedStateTimeJob.terminalAt);
  assert.equal(completedStateTimeJob.terminalAt, completedStateTimeJob.lastStateChangedAt,
    "only the definitive completed transition establishes terminalAt");

  const stateOperatorJob = jobs.create({
    principalId: "principal-a",
    ownerContextId: "principal:principal-a|transport:A",
    projectId: "project-a",
    workspaceRoot: "/tmp/project-a",
    runAt: new Date(Date.now() - 1_000).toISOString(),
    instructionJson: { instructions: "Track operator intervention time." },
    executionMode: "read_only_audit",
    policySnapshotJson: { workspaceAccess: "read_only", mutate: false },
    maxRuntimeMs: 60_000,
  });
  const operatorDue = jobs.transition({ jobId: stateOperatorJob.id, expectedRevision: stateOperatorJob.revision, nextStatus: "due", expectedSourceStatuses: ["pending"] });
  const stateOperatorClaim = jobs.claimDispatch({ jobId: stateOperatorJob.id, expectedRevision: operatorDue.revision, dispatcherInstanceId: "test-scheduler" });
  const operatorInterventionJob = jobs.resolveDispatch({
    jobId: stateOperatorJob.id,
    dispatchAttemptId: stateOperatorClaim.attemptId,
    expectedRevision: stateOperatorClaim.revision,
    resolution: "operator_intervention",
    lastError: "manual reconciliation needed",
  });
  assert.ok(operatorInterventionJob.operatorInterventionAt);
  assert.equal(operatorInterventionJob.terminalAt, undefined,
    "operator intervention remains recoverable and does not set terminalAt");

  const fingerprints = scheduledVerificationFingerprints({ policySnapshotJson: created.policySnapshotJson, serverConfig: config.serverConfig });
  const verificationIdentity = {
    jobId: created.id,
    workSessionId: session.id,
    submissionId: submission.id,
    reviewEpoch: submission.reviewEpoch,
    snapshotKind: submission.snapshotKind as "git" | "filesystem",
    snapshotRef: submission.snapshotRef,
    commandFingerprint: fingerprints.commandFingerprint,
    policyFingerprint: fingerprints.policyFingerprint,
  };
  const verificationRequestFingerprint = createHash("sha256").update(JSON.stringify(verificationIdentity)).digest("hex");
  const claimVerification = (mutationId: string, executionIdentity: string, requestFingerprint = verificationRequestFingerprint) => jobs.claimVerificationExecution({
    ...verificationIdentity,
    requestKey: `mutation:${mutationId}`,
    requestFingerprint,
    clientMutationId: mutationId,
    executionIdentity,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const verificationReportText = (status: "passed" | "failed") => JSON.stringify({
    version: 1,
    scheduledJobId: created.id,
    workSessionId: session.id,
    submissionId: submission.id,
    snapshotKind: submission.snapshotKind,
    snapshotRef: submission.snapshotRef,
    results: [{
      criterionId: "scheduled:1",
      command: "npm test",
      status,
      exitCode: status === "passed" ? 0 : 1,
      signal: null,
      durationMs: 42,
      outputTail: status === "passed" ? "ok" : "failed",
      outputSha256: (status === "passed" ? "a" : "b").repeat(64),
      failureSetSha256: (status === "passed" ? "c" : "d").repeat(64),
    }],
  });
  config.missionLedger = undefined;
  const runningVerification = claimVerification("verify-pass", "verification:pass");
  assert.equal(runningVerification.owner, true);
  const identicalVerificationRetry = claimVerification("verify-pass", "verification:retry");
  assert.equal(identicalVerificationRetry.owner, false, "an identical idempotency retry reuses the running execution claim");
  assert.equal(identicalVerificationRetry.execution.id, runningVerification.execution.id);
  const distinctActiveVerificationRequest = claimVerification("verify-distinct-active", "verification:distinct-active");
  assert.equal(distinctActiveVerificationRequest.owner, false,
    "a distinct reviewer request cannot launch a concurrent equivalent verification suite");
  assert.equal(distinctActiveVerificationRequest.execution.id, runningVerification.execution.id);
  const runningReceipt = await resultTool({ scheduledJobId: created.id });
  assert.equal(runningReceipt.structuredContent.resultReceipt.verificationStatus, "inconclusive",
    "an active verification is visible as unresolved instead of falling back to an older pass");
  const passingVerificationText = verificationReportText("passed");
  const passingVerification = jobs.completeVerificationExecution({ executionId: runningVerification.execution.id, reportText: passingVerificationText });
  assert.equal(passingVerification.status, "completed");
  const repeatedCompletedClaim = claimVerification("verify-pass", "verification:later-retry");
  assert.equal(repeatedCompletedClaim.owner, false);
  assert.equal(repeatedCompletedClaim.execution.executionIdentity, passingVerification.executionIdentity,
    "a lost-response retry returns the existing completed report instead of executing commands again");
  const sequentialFreshVerification = claimVerification("verify-pass-sequential", "verification:sequential-fresh");
  assert.equal(sequentialFreshVerification.owner, true,
    "a fresh request is allowed after the previous equivalent verification completes");
  jobs.completeVerificationExecution({
    executionId: sequentialFreshVerification.execution.id,
    reportText: verificationReportText("passed"),
  });
  assert.throws(() => claimVerification("verify-pass", "verification:conflict", "0".repeat(64)), /different submission or verification content/,
    "a reused idempotency key cannot bind different verification content");
  const passedScheduledReceipt = await resultTool({ scheduledJobId: created.id });
  assert.equal(passedScheduledReceipt.structuredContent.resultReceipt.verificationStatus, "passed",
    "scheduled verification passes are visible even without a mission ledger");
  assert.equal(passedScheduledReceipt.structuredContent.resultReceipt.verificationLevel, "implementation");
  assert.equal(passedScheduledReceipt.structuredContent.resultReceipt.independentOutcomeObserved, false,
    "scheduled tests do not claim independent outcome verification");
  assert.equal(passedScheduledReceipt.structuredContent.resultReceipt.verificationReportSha256, passingVerification.reportSha256);
  assert.equal(passedScheduledReceipt.structuredContent.resultReceipt.verificationResults[0].status, "passed");
  assert.ok(passedScheduledReceipt.structuredContent.resultReceipt.artifactReferences.some((item: any) => item.kind === "scheduled_verification_report"));

  const getVerificationReportTool = handlers.get("get_scheduled_job_verification");
  assert.ok(getVerificationReportTool);
  const verificationReportRead = await getVerificationReportTool({ scheduledJobId: created.id, reportSha256: passingVerification.reportSha256, reportLimit: 100 });
  assert.equal(verificationReportRead.structuredContent.report, passingVerificationText.slice(0, 100));
  assert.equal(z.object(definitions.get("get_scheduled_job_verification").outputSchema).safeParse(verificationReportRead.structuredContent).success, true);

  const failedVerificationClaim = claimVerification("verify-fresh-failure", "verification:fresh-failure");
  const failedVerification = jobs.completeVerificationExecution({
    executionId: failedVerificationClaim.execution.id,
    reportText: verificationReportText("failed"),
  });
  const latestFailedReceipt = await resultTool({ scheduledJobId: created.id });
  assert.equal(latestFailedReceipt.structuredContent.resultReceipt.verificationStatus, "failed",
    "a newer failed command cannot be hidden by an older passing report");
  assert.equal(latestFailedReceipt.structuredContent.resultReceipt.verificationReportSha256, failedVerification.reportSha256);
  assert.equal(latestFailedReceipt.structuredContent.resultReceipt.verificationResults[0].status, "failed");
  assert.ok(latestFailedReceipt.structuredContent.resultReceipt.unresolvedBlockers.some((item: string) => item.includes("failed: npm test")));

  const savedSubmission = session.latestSubmission;
  session.latestSubmission = { ...submission, id: "submission-2", snapshotRef: "snapshot-2", snapshotCommit: "snapshot-2", reviewEpoch: 2 };
  const changedSubmissionReceipt = await resultTool({ scheduledJobId: created.id });
  assert.equal(changedSubmissionReceipt.structuredContent.resultReceipt.verificationStatus, "not_performed",
    "verification reports from an older submission never qualify for a changed snapshot");
  assert.equal(changedSubmissionReceipt.structuredContent.resultReceipt.verificationReportSha256, undefined);
  session.latestSubmission = savedSubmission;

  config.missionLedger = priorMissionLedger;
  missionReceipt = {
    completionReport: {
      id: "completion-1",
      status: "passed",
      reportSha256: "e".repeat(64),
      snapshotKind: "git",
      snapshotRef: "snapshot-1",
    },
    approval: { allowed: true, reasons: [] },
    requiredEvidenceLevel: "integration_verified",
    verificationEvidenceIds: ["evidence-1"],
    outcomeObservationIds: [],
    evidence: [{ id: "evidence-1", outputDigest: "f".repeat(64), snapshotKind: "git", snapshotRef: "snapshot-1" }],
  };
  const verified = await resultTool({ scheduledJobId: created.id, reportSha256: firstPage.structuredContent.reportSha256, reportOffset: 101, reportLimit: 200 });
  assert.equal(verified.structuredContent.report.length, 200);
  assert.equal(verified.structuredContent.report, largeReport.slice(100, 300),
    "later pages read the pinned report artifact even if run output is unavailable");
  assert.equal(verified.structuredContent.resultReceipt.reviewStatus, "pending",
    "verification and human review remain independently visible");
  assert.equal(verified.structuredContent.resultReceipt.verificationStatus, "failed",
    "a passing mission receipt cannot hide a newer failed scheduled command for the same submission");
  assert.equal(verified.structuredContent.resultReceipt.verificationLevel, "integration");
  assert.equal(verified.structuredContent.resultReceipt.independentOutcomeObserved, false,
    "integration verification does not claim independent outcome observation");
  assert.ok(verified.structuredContent.resultReceipt.artifactReferences.some((item: any) => item.kind === "mission_completion_report"));
  assert.ok(verified.structuredContent.resultReceipt.artifactReferences.some((item: any) => item.kind === "mission_evidence"));

  missionReceipt = { ...missionReceipt, outcomeObservationIds: ["outcome-observation-1"] };
  const observedOutcome = await resultTool({ scheduledJobId: created.id, reportSha256: firstPage.structuredContent.reportSha256, reportOffset: 101, reportLimit: 200 });
  assert.equal(observedOutcome.structuredContent.resultReceipt.verificationLevel, "outcome");
  assert.equal(observedOutcome.structuredContent.resultReceipt.independentOutcomeObserved, true);
  assert.ok(observedOutcome.structuredContent.resultReceipt.verificationEvidenceIds.includes("outcome-observation-1"),
    "the result receipt retains the exact independent outcome evidence ID");

  sessionStatus = "approved";
  const approved = await resultTool({ scheduledJobId: created.id, reportSha256: firstPage.structuredContent.reportSha256, reportOffset: 301, reportLimit: 200 });
  assert.equal(approved.structuredContent.resultReceipt.reviewStatus, "approved");
  assert.equal(approved.structuredContent.resultReceipt.reviewApproved, true);
  assert.equal(approved.structuredContent.resultReceipt.independentOutcomeObserved, true);
  jobs.projectEvent({
    id: "submission-event-1",
    seq: 4,
    durable: true,
    type: "review.submitted",
    sessionId: session.id,
    payload: { runId: run.runId, submissionId: submission.id },
    createdAt: "2026-10-12T12:00:30.000Z",
  });
  jobs.projectEvent({
    id: "approval-event-2",
    seq: 5,
    durable: true,
    type: "agent.run.approved",
    sessionId: session.id,
    payload: { runId: run.runId },
    createdAt: "2026-10-12T12:01:00.000Z",
  });
  const terminal = await resultTool({ scheduledJobId: created.id, reportSha256: firstPage.structuredContent.reportSha256, reportOffset: 501, reportLimit: 200 });
  assert.equal(terminal.structuredContent.resultReceipt.terminalAt, jobs.get(created.id)?.terminalAt,
    "the job terminal timestamp is the persisted definitive terminal transition time");
  assert.ok(terminal.structuredContent.resultReceipt.terminalAt);
  assert.equal(terminal.structuredContent.resultReceipt.blockedAt, undefined);

  const activeCancelJob = jobs.create({
    principalId: "principal-a",
    ownerContextId: "principal:principal-a|transport:A",
    projectId: "project-a",
    workspaceRoot: "/tmp/project-a",
    runAt: new Date(Date.now() - 1_000).toISOString(),
    instructionJson: { instructions: "Long running audit." },
    executionMode: "read_only_audit",
    policySnapshotJson: { workspaceAccess: "read_only", mutate: false },
    workSessionId: cancelSession.id,
    maxRuntimeMs: 60_000,
  });
  jobs.transition({ jobId: activeCancelJob.id, expectedRevision: activeCancelJob.revision, nextStatus: "due", expectedSourceStatuses: ["pending"] });
  const cancelDispatch = jobs.claimDispatch({ jobId: activeCancelJob.id, expectedRevision: 2, dispatcherInstanceId: "test-scheduler" });
  const activeJob = jobs.completeDispatch({
    jobId: activeCancelJob.id,
    dispatchAttemptId: cancelDispatch.attemptId,
    expectedRevision: cancelDispatch.revision,
    dispatcherInstanceId: "test-scheduler",
    outcome: "dispatched",
    workSessionId: cancelSession.id,
    acpRunId: cancelRun.runId,
  });
  const cancelled = await handlers.get("cancel_scheduled_job")!({
    scheduledJobId: activeJob.id,
    expectedRevision: activeJob.revision,
    clientMutationId: "cancel-without-remote-id",
  });
  assert.equal(cancelled.structuredContent.status, "cancellation_requested",
    "missing remote-run metadata does not make a running job terminal");
  assert.equal(cancelled.structuredContent.lastConfirmedRemoteState, "unknown",
    "missing remote-run metadata does not claim either worker shutdown or confirmed activity");
  assert.match(cancelled.structuredContent.cancellationRequestId, /^cancel:/);
  assert.equal(z.object(definitions.get("cancel_scheduled_job").outputSchema).safeParse(cancelled.structuredContent).success, true,
    "durable cancellation identity and remote-state evidence match the published output schema");
  const cancellationReceipt = await resultTool({ scheduledJobId: activeJob.id });
  assert.equal(cancellationReceipt.structuredContent.resultReceipt.scheduledJobStatus, "cancellation_requested");
  assert.equal(cancellationReceipt.structuredContent.resultReceipt.cancellationRequestId, cancelled.structuredContent.cancellationRequestId);
  assert.equal(cancellationReceipt.structuredContent.resultReceipt.cancellationLastConfirmedState, "unknown");
  assert.equal(cancellationReceipt.structuredContent.resultReceipt.workerCompleted, false,
    "a pending cancellation is readable without claiming confirmed worker shutdown");

  const reviewStoppedJob = jobs.create({
    principalId: "principal-a",
    ownerContextId: "principal:principal-a|transport:A",
    projectId: "project-a",
    workspaceRoot: "/tmp/project-a",
    runAt: new Date(Date.now() - 1_000).toISOString(),
    instructionJson: { instructions: "Cancel an already-exited worker awaiting review." },
    executionMode: "read_only_audit",
    policySnapshotJson: { workspaceAccess: "read_only", mutate: false },
    workSessionId: reviewStoppedSession.id,
    maxRuntimeMs: 60_000,
  });
  jobs.transition({ jobId: reviewStoppedJob.id, expectedRevision: reviewStoppedJob.revision, nextStatus: "due", expectedSourceStatuses: ["pending"] });
  const reviewStoppedDispatch = jobs.claimDispatch({ jobId: reviewStoppedJob.id, expectedRevision: 2, dispatcherInstanceId: "test-scheduler" });
  const reviewStoppedActive = jobs.completeDispatch({
    jobId: reviewStoppedJob.id,
    dispatchAttemptId: reviewStoppedDispatch.attemptId,
    expectedRevision: reviewStoppedDispatch.revision,
    dispatcherInstanceId: "test-scheduler",
    outcome: "dispatched",
    workSessionId: reviewStoppedSession.id,
    acpRunId: reviewStoppedRun.runId,
  });
  const reviewStoppedCancellation = await handlers.get("cancel_scheduled_job")!({
    scheduledJobId: reviewStoppedActive.id,
    expectedRevision: reviewStoppedActive.revision,
    clientMutationId: "cancel-after-worker-exit",
  });
  assert.equal(reviewStoppedCancellation.structuredContent.status, "cancelled",
    "human-review cancellation finalizes when the current worker attempt is durably known to have exited");
  assert.equal(reviewStoppedCancellation.structuredContent.lastConfirmedRemoteState, "worker_stopped");
  assert.equal(reviewCancellationFinalizations, 1);
  const cancelledReceipt = await resultTool({ scheduledJobId: reviewStoppedJob.id });
  assert.equal(cancelledReceipt.structuredContent.resultReceipt.scheduledJobStatus, "cancelled");
  assert.equal(cancelledReceipt.structuredContent.resultReceipt.cancellationLastConfirmedState, "worker_stopped");
  assert.equal(cancelledReceipt.structuredContent.resultReceipt.workerCompleted, false);
  assert.equal(cancelledReceipt.structuredContent.resultReceipt.reviewApproved, false);
  assert.equal(cancelledReceipt.structuredContent.resultReceipt.verificationStatus, "not_performed");
  console.log("bridge/schedule-tools.test.ts: all assertions passed");
} finally {
  jobs.close();
  outbox.close();
  await rm(root, { recursive: true, force: true });
}
