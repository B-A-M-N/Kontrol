import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { createDispatchOutbox } from "../dispatch-outbox.js";
import { openDatabase } from "../db/client.js";
import { createScheduledJobStore } from "../scheduling/scheduled-job-store.js";
import { registerScheduleTools } from "./schedule-tools.js";

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
const server = {
  registerTool(name: string, definition: unknown, handler: (input: any) => Promise<any>) {
    definitions.set(name, definition);
    handlers.set(name, handler);
  },
} as any;

try {
  const created = jobs.create({
    principalId: "principal-a",
    ownerContextId: "principal:principal-a|transport:A",
    projectId: "project-a",
    workspaceRoot: "/tmp/project-a",
    runAt: new Date(Date.now() - 1_000).toISOString(),
    instructionJson: { instructions: "Produce a reviewable report." },
    executionMode: "read_only_audit",
    policySnapshotJson: { workspaceAccess: "read_only", mutate: false },
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
  });

  const config: any = {
    principalRole: "reviewer",
    principalId: "principal-a",
    connectionContext: { authenticatedPrincipalId: "principal-a", mcpSessionId: "transport-B" },
    scheduledJobs: jobs,
    workspaces: { getWorkspace: () => ({ id: "project-a", root: "/tmp/project-a" }) },
    workSessions: { get: (id: string) => id === session.id
      ? { ...session, status: sessionStatus }
      : id === cancelSession.id ? cancelSession
        : id === reviewStoppedSession.id ? reviewStoppedSession
          : undefined },
    agentRegistry: { getRunByWorkSessionId: (id: string) => id === session.id
      ? run
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

  const resultTool = handlers.get("get_scheduled_job_result");
  assert.ok(resultTool, "scheduled result retrieval is registered");
  const firstPage = await resultTool({ scheduledJobId: created.id, reportLimit: 100 });
  assert.equal(firstPage.structuredContent.resultReceipt.executionStatus, "completed",
    "a finished worker turn is reported as execution completion");
  assert.equal(firstPage.structuredContent.resultReceipt.executionTerminalAt, run.finishedAt);
  assert.equal(firstPage.structuredContent.resultReceipt.terminalAt, undefined,
    "the scheduled job has no terminal timestamp while review is pending");
  assert.equal(firstPage.structuredContent.resultReceipt.reviewStatus, "pending",
    "worker completion does not claim review approval");
  assert.equal(firstPage.structuredContent.resultReceipt.verificationStatus, "not_performed",
    "worker completion alone is not independent verification");
  assert.equal(firstPage.structuredContent.resultReceipt.outcomeVerified, false);
  assert.equal(firstPage.structuredContent.report.length, 100);
  assert.equal(firstPage.structuredContent.reportSha256, expectedReportSha256,
    "the full persisted report hash is independent of the returned page size");
  assert.equal(firstPage.structuredContent.reportNextOffset, 101);
  assert.equal(firstPage.structuredContent.reportTruncated, true);
  assert.equal(firstPage.structuredContent.resultReceipt.runId, run.runId);
  assert.equal(firstPage.structuredContent.resultReceipt.workSessionId, session.id);
  assert.ok(firstPage.structuredContent.resultReceipt.artifactReferences.some((item: any) => item.kind === "acp_run_output"));
  assert.equal(z.object(definitions.get("get_scheduled_job_result").outputSchema).safeParse(firstPage.structuredContent).success, true,
    "result receipt matches the published tool output schema");

  missionReceipt = {
    completionReport: {
      id: "completion-1",
      status: "passed",
      reportSha256: "e".repeat(64),
      snapshotKind: "git",
      snapshotRef: "snapshot-1",
    },
    approval: { allowed: true, reasons: [] },
    evidence: [{ id: "evidence-1", outputDigest: "f".repeat(64), snapshotKind: "git", snapshotRef: "snapshot-1" }],
  };
  const verified = await resultTool({ scheduledJobId: created.id, reportOffset: 101, reportLimit: 200 });
  assert.equal(verified.structuredContent.report.length, 200);
  assert.equal(verified.structuredContent.resultReceipt.reviewStatus, "pending",
    "verification and human review remain independently visible");
  assert.equal(verified.structuredContent.resultReceipt.verificationStatus, "passed");
  assert.equal(verified.structuredContent.resultReceipt.outcomeVerified, true);
  assert.ok(verified.structuredContent.resultReceipt.artifactReferences.some((item: any) => item.kind === "mission_completion_report"));
  assert.ok(verified.structuredContent.resultReceipt.artifactReferences.some((item: any) => item.kind === "mission_evidence"));

  sessionStatus = "approved";
  const approved = await resultTool({ scheduledJobId: created.id, reportOffset: 301, reportLimit: 200 });
  assert.equal(approved.structuredContent.resultReceipt.reviewStatus, "approved");
  assert.equal(approved.structuredContent.resultReceipt.outcomeVerified, true);
  jobs.projectEvent({
    id: "submission-event-1",
    seq: 1,
    durable: true,
    type: "review.submitted",
    sessionId: session.id,
    payload: { runId: run.runId, submissionId: submission.id },
    createdAt: "2026-10-12T12:00:30.000Z",
  });
  jobs.projectEvent({
    id: "approval-event-2",
    seq: 2,
    durable: true,
    type: "agent.run.approved",
    sessionId: session.id,
    payload: { runId: run.runId },
    createdAt: "2026-10-12T12:01:00.000Z",
  });
  const terminal = await resultTool({ scheduledJobId: created.id, reportOffset: 501, reportLimit: 200 });
  assert.equal(terminal.structuredContent.resultReceipt.terminalAt, jobs.get(created.id)?.updatedAt,
    "the job terminal timestamp is recorded when lifecycle projection completes");

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
  console.log("bridge/schedule-tools.test.ts: all assertions passed");
} finally {
  jobs.close();
  outbox.close();
  await rm(root, { recursive: true, force: true });
}
