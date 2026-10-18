import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createDispatchOutbox } from "../dispatch-outbox.js";
import { createEventStore } from "../event-log.js";
import { createScheduledJobStore, schedulingOperation, type ScheduledJob } from "./scheduled-job-store.js";
import { createScheduledJobRuntime, scheduledDispatchRetryDelayMs } from "./scheduled-job-runtime.js";
import { scheduledJobAccessAllowed } from "../bridge/schedule-tools.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-scheduling-test-"));

try {
  const db = openDatabase(root);
  const outbox = createDispatchOutbox(db);
  const jobs = createScheduledJobStore(db, outbox);
  const runAt = new Date(Date.now() + 60_000).toISOString();

  const clientMutationId = "schedule-job-once";
  const job = jobs.create({
    principalId: "user-a",
    ownerContextId: "owner-a",
    projectId: "project-a",
    workspaceRoot: "/tmp/project-a",
    runAt,
    instructionJson: { instructions: "Audit", artifactsRequired: true },
    executionMode: "read_only_audit",
    policySnapshotJson: { workspaceAccess: "read_only" },
    maxRuntimeMs: 90 * 60_000,
    clientMutationId,
  });
  assert.match(job.id, /^sched_/);
  assert.equal(job.revision, 1);
  assert.equal(job.status, "pending");
  assert.equal(scheduledJobAccessAllowed(job, { authenticatedPrincipalId: "user-a", ownerContextId: "principal:user-a|transport:B" }), true,
    "a returning authenticated principal can recover a job created on another transport");
  assert.equal(scheduledJobAccessAllowed(job, { authenticatedPrincipalId: "user-b", ownerContextId: "principal:user-b|transport:B" }), false,
    "a different principal cannot read another user's job");
  assert.equal(jobs.listForPrincipal("user-a", 10).some((candidate) => candidate.id === job.id), true,
    "recovery listing uses durable principal ownership rather than the original transport context");
  assert.equal(jobs.listForPrincipal("user-b", 10).some((candidate) => candidate.id === job.id), false);
  const due = outbox.listByAggregate(job.id).find((event) => event.eventType === "scheduled_job.due");
  assert.ok(due, "committed job has a recoverable execution event");
  assert.equal(due.aggregateRevision, 1);
  assert.equal(due.availableAt, runAt);

  const replay = jobs.create({
    principalId: "user-a",
    ownerContextId: "owner-a",
    projectId: "project-a",
    workspaceRoot: "/tmp/project-a",
    runAt,
    instructionJson: { instructions: "Audit", artifactsRequired: true },
    executionMode: "read_only_audit",
    policySnapshotJson: { workspaceAccess: "read_only" },
    maxRuntimeMs: 90 * 60_000,
    clientMutationId,
  });
  assert.equal(replay.id, job.id, "durable scheduling retry returns the original job");

  // ── K10: history reads stay page-bounded and due dispatch has a fixed pool. ──
  {
    const scaleRoot = await mkdtemp(join(tmpdir(), "kontrol-scheduling-scale-"));
    const scaleDb = openDatabase(scaleRoot);
    const scaleOutbox = createDispatchOutbox(scaleDb);
    const scaleJobs = createScheduledJobStore(scaleDb, scaleOutbox);
    const futureRunAt = new Date(Date.now() + 60 * 60_000).toISOString();
    try {
      const historyCount = 1_200;
      for (let index = 0; index < historyCount; index += 1) {
        scaleJobs.create({
          principalId: "history-principal",
          ownerContextId: "history-owner",
          projectId: "project-history",
          workspaceRoot: "/tmp/project-history",
          runAt: futureRunAt,
          instructionJson: { instructions: `History record ${index}` },
          executionMode: "read_only_audit",
          policySnapshotJson: { workspaceAccess: "read_only" },
          maxRuntimeMs: 60_000,
        });
      }
      const seen = new Set<string>();
      let cursor: string | undefined;
      while (true) {
        const page = scaleJobs.listForPrincipal("history-principal", 73, cursor);
        assert.ok(page.length <= 73, "SQL-backed owner history page never exceeds its requested bound");
        for (const item of page) {
          assert.equal(seen.has(item.id), false, "keyset history pages do not overlap");
          seen.add(item.id);
        }
        if (page.length < 73) break;
        cursor = page.at(-1)?.id;
      }
      assert.equal(seen.size, historyCount, "all historical jobs remain recoverable across bounded pages");

      const dispatchJobs: ScheduledJob[] = [];
      for (let index = 0; index < 3; index += 1) {
        dispatchJobs.push(scaleJobs.create({
          principalId: "dispatch-principal",
          ownerContextId: "dispatch-owner",
          projectId: "project-dispatch",
          workspaceRoot: "/tmp/project-dispatch",
          runAt: new Date(Date.now() - 1_000).toISOString(),
          instructionJson: { instructions: `Dispatch ${index}` },
          executionMode: "read_only_audit",
          policySnapshotJson: { workspaceAccess: "read_only" },
          maxRuntimeMs: 60_000,
        }));
      }
      let releaseSlowDispatch!: () => void;
      const slowDispatchGate = new Promise<void>((resolve) => { releaseSlowDispatch = resolve; });
      let resolveFirstWave!: () => void;
      const firstWave = new Promise<void>((resolve) => { resolveFirstWave = resolve; });
      let active = 0;
      let maxActive = 0;
      let slowJobId: string | undefined;
      const dispatched: string[] = [];
      const runtime = createScheduledJobRuntime({
        database: scaleDb,
        jobs: scaleJobs,
        dispatchOutbox: scaleOutbox,
        dispatchConcurrency: 2,
        pollMs: 60_000,
        dispatch: async (jobId) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          dispatched.push(jobId);
          if (dispatched.length === 1) slowJobId = jobId;
          if (dispatched.length >= 2) resolveFirstWave();
          if (jobId === slowJobId) await slowDispatchGate;
          active -= 1;
          return { status: "dispatched", workSessionId: `ws-${jobId}` };
        },
      });
      runtime.start();
      const firstDrain = runtime.drainOnce();
      await Promise.race([
        firstWave,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dispatch pool did not start its bounded first wave")), 2_000)),
      ]);
      assert.equal(dispatched.length, 2, "the scheduler launches only its configured first-wave pool");
      let eventLoopResponsive = false;
      setImmediate(() => { eventLoopResponsive = true; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(eventLoopResponsive, true, "a delayed adapter wait does not block the serving event loop");
      assert.equal(maxActive, 2, "scheduler dispatch concurrency never exceeds its configured bound");
      releaseSlowDispatch();
      await firstDrain;
      await runtime.drainOnce();
      runtime.stop();
      assert.equal(dispatched.length, 3, "remaining due work proceeds on the next bounded drain");
      assert.equal(maxActive, 2, "later drains preserve the same concurrency ceiling");
      assert.equal(dispatchJobs.every((item) => scaleJobs.get(item.id)?.status === "running"), true);
    } finally {
      scaleJobs.close();
      scaleOutbox.close();
      await rm(scaleRoot, { recursive: true, force: true });
    }
  }

  // ── K-R04: temporary dispatch blockers back off across scheduler restart. ──
  {
    const retryRoot = await mkdtemp(join(tmpdir(), "kontrol-scheduling-retry-"));
    const retryDb = openDatabase(retryRoot);
    const retryOutbox = createDispatchOutbox(retryDb);
    const retryJobs = createScheduledJobStore(retryDb, retryOutbox);
    const dueAt = new Date(Date.now() - 1_000).toISOString();
    try {
      const temporaryJob = retryJobs.create({
        principalId: "retry-principal",
        ownerContextId: "retry-owner",
        projectId: "retry-project",
        workspaceRoot: "/tmp/retry-project",
        runAt: dueAt,
        instructionJson: { instructions: "Retry after a temporary adapter outage" },
        executionMode: "read_only_audit",
        policySnapshotJson: { workspaceAccess: "read_only" },
        maxRuntimeMs: 60_000,
      });
      let temporaryDispatchCalls = 0;
      const firstRuntime = createScheduledJobRuntime({
        database: retryDb,
        jobs: retryJobs,
        dispatchOutbox: retryOutbox,
        pollMs: 60_000,
        dispatch: async () => {
          temporaryDispatchCalls += 1;
          return {
            status: "blocked",
            blockerKind: "temporary_dependency",
            lastAttemptedAgent: "offline-agent",
            reason: "adapter temporarily unavailable",
          };
        },
      });
      await firstRuntime.drainOnce();
      const waitingRetry = retryJobs.get(temporaryJob.id)!;
      assert.equal(waitingRetry.status, "due");
      assert.equal(waitingRetry.dispatchRetryCount, 1);
      assert.equal(waitingRetry.dispatchLastAttemptedAgent, "offline-agent");
      assert.equal(waitingRetry.dispatchBlockerKind, "temporary_dependency");
      assert.ok(Date.parse(waitingRetry.dispatchNextEligibleAt!) - Date.now() >= 1_500,
        "the first temporary retry is durably delayed instead of immediately looping");
      assert.equal(scheduledDispatchRetryDelayMs(1, () => 0), 1_600);
      assert.equal(scheduledDispatchRetryDelayMs(16, () => 1), 300_000,
        "exponential retry delay is capped at five minutes");
      await firstRuntime.drainOnce();
      assert.equal(temporaryDispatchCalls, 1, "a repeated immediate drain cannot bypass the retry window");
      firstRuntime.stop();

      const restartedRuntime = createScheduledJobRuntime({
        database: retryDb,
        jobs: retryJobs,
        dispatchOutbox: retryOutbox,
        pollMs: 60_000,
        dispatch: async () => {
          temporaryDispatchCalls += 1;
          return { status: "dispatched", workSessionId: "retry-work-session" };
        },
      });
      await restartedRuntime.drainOnce();
      assert.equal(temporaryDispatchCalls, 1, "restart preserves the durable retry delay");
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(waitingRetry.dispatchNextEligibleAt!) - Date.now() + 20)));
      await restartedRuntime.drainOnce();
      assert.equal(temporaryDispatchCalls, 2, "the restored scheduler dispatches once after the retry window");
      assert.equal(retryJobs.get(temporaryJob.id)?.status, "running");
      await restartedRuntime.drainOnce();
      assert.equal(temporaryDispatchCalls, 2, "accepted work is never launched again by a subsequent drain");
      restartedRuntime.stop();

      const permanentJob = retryJobs.create({
        principalId: "retry-principal",
        ownerContextId: "retry-owner",
        projectId: "retry-project",
        workspaceRoot: "/tmp/retry-project",
        runAt: dueAt,
        instructionJson: { instructions: "Require reviewer correction after a permanent adapter mismatch" },
        executionMode: "read_only_audit",
        policySnapshotJson: { workspaceAccess: "read_only" },
        maxRuntimeMs: 60_000,
      });
      let permanentDispatchCalls = 0;
      let permanentConfigurationFixed = false;
      const permanentRuntime = createScheduledJobRuntime({
        database: retryDb,
        jobs: retryJobs,
        dispatchOutbox: retryOutbox,
        pollMs: 60_000,
        dispatch: async () => {
          permanentDispatchCalls += 1;
          if (permanentConfigurationFixed) return { status: "dispatched", workSessionId: "corrected-work-session" };
          return {
            status: "blocked",
            blockerKind: "permanent_configuration",
            lastAttemptedAgent: "unsupported-agent",
            reason: "configured agent does not support the required protocol",
          };
        },
      });
      await permanentRuntime.drainOnce();
      const blockedPermanently = retryJobs.get(permanentJob.id)!;
      assert.equal(blockedPermanently.status, "blocked");
      assert.equal(blockedPermanently.dispatchRetryCount, 0, "permanent configuration failures do not enter automatic retry");
      await permanentRuntime.drainOnce();
      assert.equal(permanentDispatchCalls, 1);
      retryJobs.retryBlockedJob({ jobId: permanentJob.id, expectedRevision: blockedPermanently.revision });
      permanentConfigurationFixed = true;
      await permanentRuntime.drainOnce();
      assert.equal(permanentDispatchCalls, 2, "reviewer retry adds one deliberate dispatch after correcting configuration");
      assert.equal(retryJobs.get(permanentJob.id)?.status, "running",
        "the job dispatches after the reviewer corrects its permanent configuration blocker");
      permanentRuntime.stop();
    } finally {
      retryJobs.close();
      retryOutbox.close();
      await rm(retryRoot, { recursive: true, force: true });
    }
  }

  jobs.transition({ jobId: job.id, expectedRevision: 1, nextStatus: "due", expectedSourceStatuses: ["pending"] });
  jobs.transition({ jobId: job.id, expectedRevision: 2, nextStatus: "dispatching", expectedSourceStatuses: ["due"] });
  let rejected = false;
  try {
    jobs.transition({ jobId: job.id, expectedRevision: 1, nextStatus: "running", expectedSourceStatuses: ["dispatching"] });
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "stale job revision cannot drive the state machine");

  let illegalSource = false;
  try {
    jobs.transition({ jobId: job.id, expectedRevision: 2, nextStatus: "cancelled", expectedSourceStatuses: ["due"], lastError: "operator cancelled" });
  } catch {
    illegalSource = true;
  }
  assert.ok(illegalSource, "illegal source status cannot drive a transition");
  const earlyCancellation = jobs.requestCancellation({ jobId: job.id, expectedRevision: 3, requestId: "cancel-before-dispatch" });
  assert.equal(earlyCancellation.status, "cancellation_requested");
  assert.equal(earlyCancellation.cancellationLastConfirmedState, "not_dispatched");
  const earlyCancelled = jobs.finalizeCancellation({
    jobId: job.id,
    requestId: "cancel-before-dispatch",
    lastConfirmedState: "not_dispatched",
  });
  assert.equal(earlyCancelled.status, "cancelled");

  // ── P1-01: interrupted dispatches reconcile against the run registry,
  //     preserving accepted work and never blindly relaunching uncertainty. ──
  {
    const acceptedJob = jobs.create({
      principalId: "user-a",
      ownerContextId: "owner-a",
      projectId: "project-a",
      workspaceRoot: "/tmp/project-a",
      runAt: new Date(Date.now() - 1_000).toISOString(),
      instructionJson: { instructions: "Audit" },
      executionMode: "read_only_audit",
      policySnapshotJson: { workspaceAccess: "read_only" },
      maxRuntimeMs: 60_000,
    });
    jobs.transition({ jobId: acceptedJob.id, expectedRevision: 1, nextStatus: "due", expectedSourceStatuses: ["pending"] });
    const acceptedClaim = jobs.claimDispatch({ jobId: acceptedJob.id, expectedRevision: 2, dispatcherInstanceId: "crashed-scheduler" });
    jobs.completeDispatch({
      jobId: acceptedJob.id,
      dispatchAttemptId: acceptedClaim.attemptId,
      expectedRevision: acceptedClaim.revision,
      dispatcherInstanceId: "crashed-scheduler",
      outcome: "uncertain",
      workSessionId: "ws-accepted",
      acpRunId: "run-accepted",
      lastError: "adapter accepted but response was lost",
    });
    assert.equal(jobs.get(acceptedJob.id)?.activeDispatchAttemptId, acceptedClaim.attemptId, "uncertain launch retains its attempt association");
    const uncertainAttempt = db.sqlite.prepare("select completed_at, outcome, transport_status from scheduled_job_attempts where id = ?").get(acceptedClaim.attemptId) as { completed_at: string | null; outcome: string | null; transport_status: string };
    assert.equal(uncertainAttempt.completed_at, null, "uncertain transport does not finalize the attempt");
    assert.equal(uncertainAttempt.outcome, null, "transport uncertainty is not a worker outcome");
    assert.equal(uncertainAttempt.transport_status, "uncertain");
    const acceptedRuntime = createScheduledJobRuntime({
      database: db,
      jobs,
      dispatchOutbox: outbox,
      pollMs: 60_000,
      reconcileDispatch: async (input) => {
        assert.equal(input.dispatchId, acceptedClaim.dispatchId);
        return { status: "accepted", workSessionId: "ws-accepted", runId: "run-accepted" };
      },
    });
    acceptedRuntime.start();
    await acceptedRuntime.drainOnce();
    acceptedRuntime.stop();
    assert.equal(jobs.get(acceptedJob.id)?.status, "running");
    assert.equal(jobs.get(acceptedJob.id)?.workSessionId, "ws-accepted");
    const acceptedAttempt = db.sqlite.prepare("select acp_run_id from scheduled_job_attempts where id = ?").get(acceptedClaim.attemptId) as { acp_run_id: string | null };
    assert.equal(acceptedAttempt.acp_run_id, "run-accepted");

    const unresolvedJob = jobs.create({
      principalId: "user-a",
      ownerContextId: "owner-a",
      projectId: "project-a",
      workspaceRoot: "/tmp/project-a",
      runAt: new Date(Date.now() - 1_000).toISOString(),
      instructionJson: { instructions: "Audit" },
      executionMode: "read_only_audit",
      policySnapshotJson: { workspaceAccess: "read_only" },
      maxRuntimeMs: 60_000,
    });
    jobs.transition({ jobId: unresolvedJob.id, expectedRevision: 1, nextStatus: "due", expectedSourceStatuses: ["pending"] });
    const unresolvedClaim = jobs.claimDispatch({ jobId: unresolvedJob.id, expectedRevision: 2, dispatcherInstanceId: "crashed-scheduler" });
    db.sqlite.prepare("update scheduled_job_attempts set lease_expires_at = ? where id = ?").run("2000-01-01T00:00:00.000Z", unresolvedClaim.attemptId);
    const unresolvedRuntime = createScheduledJobRuntime({
      database: db,
      jobs,
      dispatchOutbox: outbox,
      pollMs: 60_000,
      reconcileDispatch: async () => ({ status: "unresolved", reason: "registry unavailable" }),
    });
    unresolvedRuntime.start();
    await unresolvedRuntime.drainOnce();
    unresolvedRuntime.stop();
    assert.equal(jobs.get(unresolvedJob.id)?.status, "uncertain_dispatch");
    assert.match(jobs.get(unresolvedJob.id)?.lastError ?? "", /registry unavailable/);
    assert.equal(jobs.get(unresolvedJob.id)?.activeDispatchAttemptId, unresolvedClaim.attemptId);

    const terminalJob = jobs.create({
      principalId: "user-a",
      ownerContextId: "owner-a",
      projectId: "project-a",
      workspaceRoot: "/tmp/project-a",
      runAt: new Date(Date.now() - 1_000).toISOString(),
      instructionJson: { instructions: "Audit" },
      executionMode: "read_only_audit",
      policySnapshotJson: { workspaceAccess: "read_only" },
      maxRuntimeMs: 60_000,
    });
    jobs.transition({ jobId: terminalJob.id, expectedRevision: 1, nextStatus: "due", expectedSourceStatuses: ["pending"] });
    const terminalClaim = jobs.claimDispatch({ jobId: terminalJob.id, expectedRevision: 2, dispatcherInstanceId: "crashed-scheduler" });
    db.sqlite.prepare("update scheduled_job_attempts set lease_expires_at = ? where id = ?").run("2000-01-01T00:00:00.000Z", terminalClaim.attemptId);
    const terminalRuntime = createScheduledJobRuntime({
      database: db,
      jobs,
      dispatchOutbox: outbox,
      pollMs: 60_000,
      reconcileDispatch: async () => ({ status: "terminal", terminalStatus: "completed", workSessionId: "ws-terminal" }),
    });
    terminalRuntime.start();
    await terminalRuntime.drainOnce();
    terminalRuntime.stop();
    assert.equal(jobs.get(terminalJob.id)?.status, "completed");
    assert.equal(jobs.get(terminalJob.id)?.workSessionId, "ws-terminal");
  }

  // Active runtime accounting pauses during reviewer wait and resumes only on
  // an authenticated start event for the current attempt.
  {
    const makeActiveJob = (suffix: string, maxRuntimeMs: number) => {
      const job = jobs.create({
        principalId: "user-a",
        ownerContextId: "owner-a",
        projectId: "project-a",
        workspaceRoot: "/tmp/project-a",
        runAt: new Date(Date.now() - 1_000).toISOString(),
        instructionJson: { instructions: "Account only active worker time." },
        executionMode: "read_only_audit",
        policySnapshotJson: { workspaceAccess: "read_only" },
        maxRuntimeMs,
        workSessionId: `ws-runtime-${suffix}`,
      });
      jobs.transition({ jobId: job.id, expectedRevision: job.revision, nextStatus: "due", expectedSourceStatuses: ["pending"] });
      const claim = jobs.claimDispatch({ jobId: job.id, expectedRevision: 2, dispatcherInstanceId: `runtime-${suffix}` });
      jobs.completeDispatch({
        jobId: job.id,
        dispatchAttemptId: claim.attemptId,
        expectedRevision: claim.revision,
        dispatcherInstanceId: `runtime-${suffix}`,
        outcome: "dispatched",
        workSessionId: `ws-runtime-${suffix}`,
        acpRunId: `run-runtime-${suffix}`,
        acpDispatchId: claim.dispatchId,
        acpAttemptNumber: 1,
        acpRemoteRunId: `remote-runtime-${suffix}`,
      });
      return { job, claim };
    };
    const startEvent = (suffix: string, dispatchId: string, seq: number, createdAt: string) => ({
      id: `start-${suffix}-${seq}`,
      seq,
      durable: true,
      type: "agent.run.started",
      sessionId: `ws-runtime-${suffix}`,
      payload: {
        runId: `run-runtime-${suffix}`,
        dispatchId,
        attemptNumber: 1,
        remoteRunId: `remote-runtime-${suffix}`,
      },
      createdAt,
    });

    const overdue = makeActiveJob("overdue", 1_000);
    jobs.projectEvent(startEvent("overdue", overdue.claim.dispatchId, 1, new Date(Date.now() - 5_000).toISOString()) as any);
    const deadlineRuntime = createScheduledJobRuntime({ database: db, jobs, pollMs: 60_000 });
    await deadlineRuntime.drainOnce();
    assert.equal(jobs.get(overdue.job.id)?.status, "cancellation_requested",
      "a worker exceeding maxRuntimeMs while actively executing receives a durable cancellation request");

    const reviewWait = makeActiveJob("review-wait", 1_000);
    const startAt = new Date(Date.now() - 20_000).toISOString();
    jobs.projectEvent(startEvent("review-wait", reviewWait.claim.dispatchId, 1, startAt) as any);
    jobs.projectEvent({
      id: "review-submitted-runtime",
      seq: 2,
      durable: true,
      type: "review.submitted",
      sessionId: "ws-runtime-review-wait",
      payload: {
        runId: "run-runtime-review-wait",
        dispatchId: reviewWait.claim.dispatchId,
        attemptNumber: 1,
        remoteRunId: "remote-runtime-review-wait",
      },
      createdAt: new Date(Date.now() - 10_000).toISOString(),
    });
    const reviewWaitRuntime = createScheduledJobRuntime({ database: db, jobs, pollMs: 60_000 });
    await reviewWaitRuntime.drainOnce();
    const waiting = jobs.get(reviewWait.job.id)!;
    const waitingAttempt = jobs.getAttempt(reviewWait.job.id)!;
    assert.equal(waiting.status, "awaiting_approval");
    assert.equal(waitingAttempt.executionActiveSince, undefined, "review submission closes the active execution segment");
    assert.ok(waitingAttempt.activeRuntimeMs >= 10_000, "only the completed worker segment contributes to active runtime");
    assert.equal(waiting.status, "awaiting_approval", "review wait beyond maxRuntimeMs does not request worker cancellation");

    const resumeAt = new Date().toISOString();
    jobs.projectEvent({
      id: "resume-runtime-review-wait",
      seq: 3,
      durable: true,
      type: "agent.run.started",
      sessionId: "ws-runtime-review-wait",
      payload: {
        runId: "run-runtime-review-wait",
        dispatchId: "runtime-resume-dispatch",
        attemptNumber: 2,
        remoteRunId: "remote-runtime-review-wait-2",
      },
      createdAt: resumeAt,
    } as any);
    assert.equal(jobs.get(reviewWait.job.id)?.status, "running", "a new current attempt resumes an awaiting review job");
    assert.equal(jobs.getAttempt(reviewWait.job.id)?.executionActiveSince, resumeAt, "resumed work starts a new active segment");
  }

  // ── P0-04: dispatch completion/release is fenced by the exact attempt.
  {
    const fencedJob = jobs.create({
      principalId: "user-a",
      ownerContextId: "owner-a",
      projectId: "project-a",
      workspaceRoot: "/tmp/project-a",
      runAt: new Date(Date.now() - 1_000).toISOString(),
      instructionJson: { instructions: "Audit" },
      executionMode: "read_only_audit",
      policySnapshotJson: { workspaceAccess: "read_only" },
      maxRuntimeMs: 60_000,
    });
    jobs.transition({ jobId: fencedJob.id, expectedRevision: 1, nextStatus: "due", expectedSourceStatuses: ["pending"] });
    const claimA = jobs.claimDispatch({
      jobId: fencedJob.id,
      expectedRevision: 2,
      dispatcherInstanceId: "scheduler-a",
    });
    // A late adapter acceptance is attached to the original attempt. The
    // durable cancellation still fences the job until shutdown evidence.
    const cancellation = jobs.requestCancellation({ jobId: fencedJob.id, expectedRevision: claimA.revision, requestId: "cancel-while-dispatching" });
    const acceptedAfterIntent = jobs.completeDispatch({
      jobId: fencedJob.id,
      dispatchAttemptId: claimA.attemptId,
      expectedRevision: claimA.revision,
      dispatcherInstanceId: "scheduler-a",
      outcome: "dispatched",
      workSessionId: "ws-fenced-cancel",
    });
    assert.equal(acceptedAfterIntent.status, "cancellation_requested");
    assert.equal(acceptedAfterIntent.activeDispatchAttemptId, claimA.attemptId);
    assert.equal(acceptedAfterIntent.workSessionId, "ws-fenced-cancel");

    const attemptsA = db.sqlite.prepare("select * from scheduled_job_attempts where id = ?").all(claimA.attemptId) as Array<{ outcome: string | null }>;
    assert.equal(attemptsA[0]?.outcome, null, "acceptance is not a terminal worker outcome");
    jobs.recordCancellationEvidence({ jobId: fencedJob.id, requestId: cancellation.cancellationRequestId!, state: "termination_acknowledged" });
    assert.throws(() => jobs.finalizeCancellation({ jobId: fencedJob.id, requestId: cancellation.cancellationRequestId!, lastConfirmedState: "worker_cancelled" }));
    jobs.recordCancellationEvidence({ jobId: fencedJob.id, requestId: cancellation.cancellationRequestId!, state: "worker_cancelled" });
    assert.equal(jobs.finalizeCancellation({ jobId: fencedJob.id, requestId: cancellation.cancellationRequestId!, lastConfirmedState: "worker_cancelled" }).status, "cancelled");

    // A fresh claim is bound to its attempt ID and dispatcher instance.
    const claimFenceJob = jobs.create({
      principalId: "user-a",
      ownerContextId: "owner-a",
      projectId: "project-a",
      workspaceRoot: "/tmp/project-a",
      runAt: new Date(Date.now() - 1_000).toISOString(),
      instructionJson: { instructions: "Audit" },
      executionMode: "read_only_audit",
      policySnapshotJson: { workspaceAccess: "read_only" },
      maxRuntimeMs: 60_000,
    });
    jobs.transition({ jobId: claimFenceJob.id, expectedRevision: claimFenceJob.revision, nextStatus: "due", expectedSourceStatuses: ["pending"] });
    const beforeClaimB = jobs.get(claimFenceJob.id)!;
    const claimB = jobs.claimDispatch({ jobId: claimFenceJob.id, expectedRevision: beforeClaimB.revision, dispatcherInstanceId: "scheduler-b" });
    let wrongOwner = false;
    try {
      jobs.releaseDispatch({ jobId: claimFenceJob.id, dispatchAttemptId: claimB.attemptId, expectedRevision: claimB.revision, dispatcherInstanceId: "scheduler-a" });
    } catch {
      wrongOwner = true;
    }
    assert.ok(wrongOwner, "a different scheduler instance cannot release the active attempt");
    assert.equal(jobs.get(claimFenceJob.id)?.status, "dispatching");
    assert.equal(jobs.get(claimFenceJob.id)?.activeDispatchAttemptId, claimB.attemptId);

    let wrongAttempt = false;
    try {
      jobs.completeDispatch({ jobId: claimFenceJob.id, dispatchAttemptId: claimA.attemptId, expectedRevision: claimB.revision, dispatcherInstanceId: "scheduler-b", outcome: "dispatched" });
    } catch {
      wrongAttempt = true;
    }
    assert.ok(wrongAttempt, "an obsolete attempt ID cannot complete the newer attempt");

    const released = jobs.releaseDispatch({ jobId: claimFenceJob.id, dispatchAttemptId: claimB.attemptId, expectedRevision: claimB.revision, dispatcherInstanceId: "scheduler-b" });
    assert.equal(released.status, "due");
    assert.equal(released.activeDispatchAttemptId, undefined);
    let duplicateRelease = false;
    try {
      jobs.releaseDispatch({ jobId: claimFenceJob.id, dispatchAttemptId: claimB.attemptId, expectedRevision: released.revision, dispatcherInstanceId: "scheduler-b" });
    } catch {
      duplicateRelease = true;
    }
    assert.ok(duplicateRelease, "an attempt cannot be released twice");

    const claimC = jobs.claimDispatch({ jobId: claimFenceJob.id, expectedRevision: released.revision, dispatcherInstanceId: "scheduler-c" });
    const completed = jobs.completeDispatch({
      jobId: claimFenceJob.id,
      dispatchAttemptId: claimC.attemptId,
      expectedRevision: claimC.revision,
      dispatcherInstanceId: "scheduler-c",
      outcome: "dispatched",
      workSessionId: "ws-fenced",
    });
    assert.equal(completed.status, "running");
    assert.equal(completed.workSessionId, "ws-fenced");
    assert.equal(completed.activeDispatchAttemptId, claimC.attemptId);
    let duplicateCompletion = false;
    try {
      jobs.completeDispatch({ jobId: claimFenceJob.id, dispatchAttemptId: claimC.attemptId, expectedRevision: completed.revision, dispatcherInstanceId: "scheduler-c", outcome: "failed" });
    } catch {
      duplicateCompletion = true;
    }
    assert.ok(duplicateCompletion, "an attempt cannot complete twice");
    assert.equal(jobs.get(claimFenceJob.id)?.status, "running");
  }

  // ── S02: the runtime triggers exactly one authorized dispatch per due job,
  //    and startup reconciliation re-arms lost triggers without duplicate work.
  {
    const dispatchLog: string[] = [];
    const runtime = createScheduledJobRuntime({
      database: db,
      jobs,
      dispatchOutbox: outbox,
      pollMs: 60_000,
      dispatch: async (jobId) => {
        dispatchLog.push(jobId);
        return {
          status: "dispatched",
          workSessionId: `ws-${jobId}`,
          executionReceipt: {
            issuer: "kontrol",
            work_session_id: `ws-${jobId}`,
            workspace_session_id: "project-a",
            parent_run_id: `run-${jobId}`,
            remote_run_id: `remote-${jobId}`,
            attempt_number: 1,
            dispatch_idempotency_key: `dispatch-${jobId}`,
            grant_expires_at: Date.now() + 60_000,
            grant_fingerprint: "c".repeat(64),
            network_policy: "disabled",
            confinement: "bubblewrap-read-only-workspace-no-network",
          },
        };
      },
    });

    const dueJob = jobs.create({
      principalId: "user-a",
      ownerContextId: "owner-a",
      projectId: "project-a",
      workspaceRoot: "/tmp/project-a",
      runAt: new Date(Date.now() - 1_000).toISOString(),
      instructionJson: { instructions: "Audit" },
      executionMode: "read_only_audit",
      policySnapshotJson: { workspaceAccess: "read_only" },
      maxRuntimeMs: 60_000,
    });

    // Startup reconciliation re-arms a nonterminal future job and marks past-due
    // jobs due. Drive one deterministic drain pass.
    runtime.start();
    await runtime.drainOnce();
    assert.deepEqual(dispatchLog, [dueJob.id], "exactly one dispatch for the due job");
    assert.equal(jobs.get(dueJob.id)?.status, "running", "a dispatched job advances to running");
    assert.equal(jobs.get(dueJob.id)?.workSessionId, `ws-${dueJob.id}`, "the dispatch result's work-session correlation is persisted on the job");
    assert.equal(jobs.getAttempt(dueJob.id)?.executionReceipt?.dispatch_idempotency_key, `dispatch-${dueJob.id}`,
      "the production dispatch outcome persists its correlated read-only execution receipt");

    // A second drain must not re-dispatch: the trigger is consumed.
    await runtime.drainOnce();
    assert.deepEqual(dispatchLog, [dueJob.id], "no duplicate dispatch on a subsequent drain");

    // Re-arming the same (jobId, revision) logical trigger stays idempotent.
    outbox.enqueue({ eventType: "scheduled_job.due", aggregateId: dueJob.id, aggregateRevision: 1, availableAt: new Date(0).toISOString(), payload: {} });
    outbox.enqueue({ eventType: "scheduled_job.due", aggregateId: dueJob.id, aggregateRevision: 1, availableAt: new Date(0).toISOString(), payload: {} });
    await runtime.drainOnce();
    assert.deepEqual(dispatchLog, [dueJob.id], "a running job is not re-dispatched even if a stale trigger reappears");

    runtime.stop();
  }

  // ── K06: cancellation intent survives adapter timeouts and a server restart.
  {
    for (const activeState of ["dispatching", "running", "uncertain_dispatch", "awaiting_approval", "operator_intervention"] as const) {
      const activeJob = jobs.create({
        principalId: "user-a",
        ownerContextId: "owner-a",
        projectId: "project-a",
        workspaceRoot: "/tmp/project-a",
        runAt: new Date(Date.now() - 1_000).toISOString(),
        instructionJson: { instructions: "Audit" },
        executionMode: "read_only_audit",
        policySnapshotJson: { workspaceAccess: "read_only" },
        maxRuntimeMs: 60_000,
      });
      const active = jobs.transition({
        jobId: activeJob.id,
        expectedRevision: activeJob.revision,
        nextStatus: activeState,
        expectedSourceStatuses: ["pending"],
        workSessionId: `ws-cancel-${activeState}`,
      });
      const requestId = `cancel-${activeState}`;
      const cancellation = jobs.requestCancellation({ jobId: active.id, expectedRevision: active.revision, requestId });
      assert.equal(cancellation.status, "cancellation_requested", `${activeState} cancellation is durable and fenced`);
      assert.equal(cancellation.cancellationLastConfirmedState, "unknown", `${activeState} does not infer worker absence from missing remote metadata`);
      const afterIntent = new Date(Date.parse(cancellation.cancellationRequestedAt!) + 1_000).toISOString();
      jobs.projectEvent({ id: `late-approval-${activeState}`, seq: 1, durable: true, type: "agent.run.approved", sessionId: active.workSessionId!, payload: {}, createdAt: afterIntent });
      assert.equal(jobs.get(active.id)?.status, "cancellation_requested", "a late approval cannot erase a prior cancellation intent");
      jobs.projectEvent({ id: `confirmed-cancel-${activeState}`, seq: 2, durable: true, type: "agent.run.cancelled", sessionId: active.workSessionId!, payload: {}, createdAt: new Date(Date.parse(afterIntent) + 1_000).toISOString() });
      assert.equal(jobs.get(active.id)?.status, "cancellation_requested", "a lifecycle event without a current attempt identity cannot confirm worker shutdown");
    }

    for (const terminalWorkerEvent of ["worker.turn.completed", "worker.attempt.failed", "worker.attempt.exited", "agent.run.failed"] as const) {
      const eventSessionId = `ws-cancel-confirm-${terminalWorkerEvent}`;
      const eventJob = jobs.create({
        principalId: "user-a",
        ownerContextId: "owner-a",
        projectId: "project-a",
        workspaceRoot: "/tmp/project-a",
        runAt: new Date(Date.now() - 1_000).toISOString(),
        instructionJson: { instructions: "Cancel after worker exit." },
        executionMode: "read_only_audit",
        policySnapshotJson: { workspaceAccess: "read_only" },
        workSessionId: eventSessionId,
        maxRuntimeMs: 60_000,
      });
      const active = jobs.transition({
        jobId: eventJob.id,
        expectedRevision: eventJob.revision,
        nextStatus: "running",
        expectedSourceStatuses: ["pending"],
      });
      const cancellation = jobs.requestCancellation({
        jobId: active.id,
        expectedRevision: active.revision,
        requestId: `cancel-after-${terminalWorkerEvent}`,
      });
      const exitEvent = {
        id: `exit-${terminalWorkerEvent}`,
        seq: 1,
        durable: true,
        type: terminalWorkerEvent,
        sessionId: eventSessionId,
        payload: {},
        createdAt: new Date(Date.parse(cancellation.cancellationRequestedAt!) + 1_000).toISOString(),
      };
      const unresolved = jobs.projectEvent(exitEvent);
      assert.equal(unresolved?.status, "cancellation_requested", `${terminalWorkerEvent} without attempt identity cannot confirm shutdown`);
    }

    const attemptJob = jobs.create({
      principalId: "user-a",
      ownerContextId: "owner-a",
      projectId: "project-a",
      workspaceRoot: "/tmp/project-a",
      runAt: new Date(Date.now() - 1_000).toISOString(),
      instructionJson: { instructions: "Cancel exact current attempt." },
      executionMode: "read_only_audit",
      policySnapshotJson: { workspaceAccess: "read_only" },
      maxRuntimeMs: 60_000,
    });
    jobs.transition({ jobId: attemptJob.id, expectedRevision: attemptJob.revision, nextStatus: "due", expectedSourceStatuses: ["pending"] });
    const attemptClaim = jobs.claimDispatch({ jobId: attemptJob.id, expectedRevision: 2, dispatcherInstanceId: "test-scheduler" });
    const activeRun = jobs.completeDispatch({
      jobId: attemptJob.id,
      dispatchAttemptId: attemptClaim.attemptId,
      expectedRevision: attemptClaim.revision,
      dispatcherInstanceId: "test-scheduler",
      outcome: "dispatched",
      workSessionId: "ws-current-attempt",
      acpRunId: "run-current-attempt",
      acpDispatchId: attemptClaim.dispatchId,
      acpAttemptNumber: 2,
      acpRemoteRunId: "remote-current-attempt",
    });
    const cancellation = jobs.requestCancellation({ jobId: activeRun.id, expectedRevision: activeRun.revision, requestId: "cancel-current-attempt" });
    const staleExit = jobs.projectEvent({
      id: "stale-attempt-exit",
      seq: 1,
      durable: true,
      type: "worker.attempt.exited",
      sessionId: "ws-current-attempt",
      payload: { runId: "run-current-attempt", dispatchId: "old-dispatch", attemptNumber: 1, remoteRunId: "remote-old" },
      createdAt: new Date(Date.parse(cancellation.cancellationRequestedAt!) + 1_000).toISOString(),
    });
    assert.equal(staleExit?.status, "cancellation_requested", "a delayed older exit cannot confirm the current worker stopped");
    const currentExit = jobs.projectEvent({
      id: "current-attempt-exit",
      seq: 2,
      durable: true,
      type: "worker.attempt.exited",
      sessionId: "ws-current-attempt",
      payload: {
        runId: "run-current-attempt",
        dispatchId: attemptClaim.dispatchId,
        attemptNumber: 2,
        remoteRunId: "remote-current-attempt",
      },
      createdAt: new Date(Date.parse(cancellation.cancellationRequestedAt!) + 2_000).toISOString(),
    });
    assert.equal(currentExit?.status, "cancelled", "the exact current attempt can confirm cancellation");

    const cancelRoot = await mkdtemp(join(tmpdir(), "kontrol-cancel-restart-"));
    let cancelDb = openDatabase(cancelRoot);
    let cancelOutbox = createDispatchOutbox(cancelDb);
    let cancelJobs = createScheduledJobStore(cancelDb, cancelOutbox);
    const pendingCancel = cancelJobs.create({
      principalId: "user-a",
      ownerContextId: "principal:user-a|transport:A",
      projectId: "project-a",
      workspaceRoot: "/tmp/project-a",
      runAt: new Date(Date.now() - 1_000).toISOString(),
      instructionJson: { instructions: "Audit" },
      executionMode: "read_only_audit",
      policySnapshotJson: { workspaceAccess: "read_only" },
      maxRuntimeMs: 60_000,
    });
    cancelJobs.transition({ jobId: pendingCancel.id, expectedRevision: pendingCancel.revision, nextStatus: "due", expectedSourceStatuses: ["pending"] });
    const dispatchClaim = cancelJobs.claimDispatch({ jobId: pendingCancel.id, expectedRevision: 2, dispatcherInstanceId: "scheduler-cancel" });
    const intent = cancelJobs.requestCancellation({ jobId: pendingCancel.id, expectedRevision: dispatchClaim.revision, requestId: "cancel-after-restart" });
    const replayedIntent = cancelJobs.requestCancellation({ jobId: pendingCancel.id, expectedRevision: 1, requestId: "different-retry-id" });
    assert.equal(replayedIntent.cancellationRequestId, intent.cancellationRequestId, "retries reattach to one cancellation identity");

    const firstCancellationRuntime = createScheduledJobRuntime({
      database: cancelDb,
      jobs: cancelJobs,
      dispatchOutbox: cancelOutbox,
      reconcileCancellation: async () => ({ state: "worker_active", reason: "simulated adapter timeout" }),
    });
    await firstCancellationRuntime.drainOnce();
    firstCancellationRuntime.stop();
    assert.equal(cancelJobs.get(pendingCancel.id)?.status, "cancellation_requested", "a timeout never falsely marks the worker stopped");
    cancelDb.sqlite.prepare("update scheduled_jobs set cancellation_last_attempt_at = ? where id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), pendingCancel.id);
    cancelJobs.close();

    cancelDb = openDatabase(cancelRoot);
    cancelOutbox = createDispatchOutbox(cancelDb);
    cancelJobs = createScheduledJobStore(cancelDb, cancelOutbox);
    const restartedCancellationRuntime = createScheduledJobRuntime({
      database: cancelDb,
      jobs: cancelJobs,
      dispatchOutbox: cancelOutbox,
      reconcileCancellation: async () => ({ state: "worker_cancelled", reason: "worker confirmed shutdown after restart" }),
    });
    await restartedCancellationRuntime.drainOnce();
    assert.equal(cancelJobs.get(pendingCancel.id)?.status, "cancelled", "restart reconciliation commits only confirmed worker shutdown");
    assert.equal(cancelJobs.get(pendingCancel.id)?.cancellationRequestId, intent.cancellationRequestId);
    assert.equal(restartedCancellationRuntime.getMetrics().cancellationRequests, 0);
    restartedCancellationRuntime.stop();
    cancelJobs.close();
    await rm(cancelRoot, { recursive: true, force: true });
  }

  // ── K-01/K-03/K-04: an accepted-but-response-lost launch survives restart,
  //    and its durable review lifecycle remains event-driven and idempotent. ──
  {
    const recoveryRoot = await mkdtemp(join(tmpdir(), "kontrol-scheduling-restart-test-"));
    try {
      const firstDb = openDatabase(recoveryRoot);
      const firstOutbox = createDispatchOutbox(firstDb);
      const firstJobs = createScheduledJobStore(firstDb, firstOutbox);
      const lostResponseJob = firstJobs.create({
        principalId: "user-a",
        ownerContextId: "owner-a",
        projectId: "project-a",
        workspaceRoot: "/tmp/project-a",
        runAt: new Date(Date.now() - 1_000).toISOString(),
        instructionJson: { instructions: "Audit" },
        executionMode: "read_only_audit",
        policySnapshotJson: { workspaceAccess: "read_only" },
        maxRuntimeMs: 1_000,
      });
      firstJobs.transition({ jobId: lostResponseJob.id, expectedRevision: 1, nextStatus: "due", expectedSourceStatuses: ["pending"] });
      const claim = firstJobs.claimDispatch({ jobId: lostResponseJob.id, expectedRevision: 2, dispatcherInstanceId: "scheduler-before-restart" });
      firstJobs.completeDispatch({
        jobId: lostResponseJob.id,
        dispatchAttemptId: claim.attemptId,
        expectedRevision: claim.revision,
        dispatcherInstanceId: "scheduler-before-restart",
        outcome: "uncertain",
        workSessionId: "ws-lost-response",
        acpRunId: "run-original",
        acpDispatchId: claim.dispatchId,
        acpAttemptNumber: 1,
        executionReceipt: {
          issuer: "kontrol",
          work_session_id: "ws-lost-response",
          workspace_session_id: "project-a",
          parent_run_id: "run-original",
          remote_run_id: "remote-original",
          attempt_number: 1,
          dispatch_idempotency_key: claim.dispatchId,
          grant_expires_at: Date.now() + 60_000,
          grant_fingerprint: "b".repeat(64),
          network_policy: "disabled",
          confinement: "bubblewrap-read-only-workspace-no-network",
        },
      });
      firstOutbox.close();
      firstDb.close();

      const restartedDb = openDatabase(recoveryRoot);
      const restartedOutbox = createDispatchOutbox(restartedDb);
      const restartedJobs = createScheduledJobStore(restartedDb, restartedOutbox);
      assert.equal(restartedJobs.getAttempt(lostResponseJob.id)?.executionReceipt?.dispatch_idempotency_key, claim.dispatchId,
        "the exact read-only execution receipt survives a server restart with its dispatch attempt");
      const events = createEventStore(restartedDb);
      let reconciliationCalls = 0;
      const runtime = createScheduledJobRuntime({
        database: restartedDb,
        jobs: restartedJobs,
        events,
        dispatchOutbox: restartedOutbox,
        pollMs: 60_000,
        reconcileDispatch: async (input) => {
          reconciliationCalls++;
          assert.equal(input.dispatchId, claim.dispatchId);
          assert.equal(input.dispatchAttemptId, claim.attemptId);
          return { status: "accepted", workSessionId: "ws-lost-response", runId: "run-original", dispatchId: claim.dispatchId, attemptNumber: 1 };
        },
      });
      assert.equal(runtime.getMetrics().uncertainLaunches, 1,
        "uncertain launches remain observable before restart reconciliation");
      runtime.start();
      await runtime.drainOnce();
      assert.equal(reconciliationCalls, 1, "restart reconciles the original attempt exactly once");
      assert.equal(restartedJobs.get(lostResponseJob.id)?.status, "running");
      assert.equal(runtime.getMetrics().uncertainLaunches, 0,
        "authoritative acceptance removes the launch from the uncertain metric");

      events.appendEvent({ type: "agent.run.started", sessionId: "ws-lost-response", payload: { runId: "run-original", dispatchId: claim.dispatchId, attemptNumber: 1, remoteRunId: "remote-original" } });
      events.appendEvent({ type: "agent.run.completed", sessionId: "ws-lost-response", payload: { runId: "run-original", dispatchId: claim.dispatchId, attemptNumber: 1, remoteRunId: "remote-original" } });
      await runtime.drainOnce();
      assert.equal(restartedJobs.get(lostResponseJob.id)?.status, "running", "worker turn completion cannot claim review approval");
      const finishedAttempt = restartedDb.sqlite.prepare("select completed_at, outcome, execution_active_since, execution_stopped_at from scheduled_job_attempts where id = ?")
        .get(claim.attemptId) as { completed_at: string | null; outcome: string | null; execution_active_since: string | null; execution_stopped_at: string | null };
      assert.equal(finishedAttempt.completed_at, null, "a worker turn pauses the attempt but keeps it open for review or continuation");
      assert.equal(finishedAttempt.execution_active_since, null, "worker completion closes the active runtime segment");
      assert.ok(finishedAttempt.execution_stopped_at, "worker completion persists its execution stop boundary");
      assert.equal(finishedAttempt.outcome, null, "worker completion remains distinct from reviewer approval");

      const submitted = events.appendEvent({ type: "review.submitted", sessionId: "ws-lost-response", payload: { runId: "run-original", submissionId: "sub-original" } });
      await runtime.drainOnce();
      const awaiting = restartedJobs.get(lostResponseJob.id)!;
      assert.equal(awaiting.status, "awaiting_approval", "submission advances after the dispatch request has ended");
      const awaitingRevision = awaiting.revision;
      restartedJobs.projectEvent(submitted);
      assert.equal(restartedJobs.get(lostResponseJob.id)?.revision, awaitingRevision, "replayed event is idempotent");

      runtime.stop();
      // The approval is appended while the event consumer is stopped. A fresh
      // server-owned consumer must catch it up from the persisted cursor.
      events.appendEvent({ type: "agent.run.approved", sessionId: "ws-lost-response", payload: { runId: "run-original" } });
      const restartedRuntime = createScheduledJobRuntime({
        database: restartedDb,
        jobs: restartedJobs,
        events,
        dispatchOutbox: restartedOutbox,
        pollMs: 60_000,
      });
      restartedRuntime.start();
      await restartedRuntime.drainOnce();
      assert.equal(restartedJobs.get(lostResponseJob.id)?.status, "completed", "approval after restart completes the job");
      restartedRuntime.stop();

      restartedOutbox.close();
      restartedDb.close();
    } finally {
      await rm(recoveryRoot, { recursive: true, force: true });
    }
  }

  // Reviewer reconciliation reattaches the original uncertain run and never
  // dispatches a replacement; durable late lifecycle evidence still resolves it.
  {
    const operatorJob = jobs.create({
      principalId: "user-a",
      ownerContextId: "owner-a",
      projectId: "project-a",
      workspaceRoot: "/tmp/project-a",
      runAt: new Date(Date.now() - 1_000).toISOString(),
      instructionJson: { instructions: "Reconcile original dispatch." },
      executionMode: "read_only_audit",
      policySnapshotJson: { workspaceAccess: "read_only" },
      maxRuntimeMs: 60_000,
    });
    jobs.transition({ jobId: operatorJob.id, expectedRevision: 1, nextStatus: "due", expectedSourceStatuses: ["pending"] });
    const operatorClaim = jobs.claimDispatch({ jobId: operatorJob.id, expectedRevision: 2, dispatcherInstanceId: "test-scheduler" });
    const uncertain = jobs.completeDispatch({
      jobId: operatorJob.id,
      dispatchAttemptId: operatorClaim.attemptId,
      expectedRevision: operatorClaim.revision,
      dispatcherInstanceId: "test-scheduler",
      outcome: "uncertain",
      workSessionId: "ws-operator-intervention",
      acpRunId: "run-operator-intervention",
      acpDispatchId: operatorClaim.dispatchId,
      acpAttemptNumber: 1,
      acpRemoteRunId: "remote-operator-intervention",
    });
    const operatorState = jobs.resolveDispatch({
      jobId: operatorJob.id,
      dispatchAttemptId: operatorClaim.attemptId,
      expectedRevision: uncertain.revision,
      resolution: "operator_intervention",
      workSessionId: "ws-operator-intervention",
      acpRunId: "run-operator-intervention",
      acpDispatchId: operatorClaim.dispatchId,
      acpAttemptNumber: 1,
      acpRemoteRunId: "remote-operator-intervention",
    });
    assert.equal(operatorState.status, "operator_intervention");
    const interventionMetrics = createScheduledJobRuntime({ database: db, jobs, pollMs: 60_000 }).getMetrics();
    assert.ok(interventionMetrics.operatorInterventionJobs >= 1,
      "authenticated scheduler diagnostics count jobs that need operator reconciliation");
    assert.ok(interventionMetrics.serviceability.reasons.some((reason) => /operator reconciliation/.test(reason)),
      "operator intervention degrades scheduler serviceability without changing process liveness");
    let dispatchCalls = 0;
    const reconciliation = createScheduledJobRuntime({
      database: db,
      jobs,
      pollMs: 60_000,
      dispatch: async () => { dispatchCalls++; return { status: "dispatched" }; },
      reconcileDispatch: async ({ dispatchId }) => {
        assert.equal(dispatchId, operatorClaim.dispatchId);
        return {
          status: "accepted",
          workSessionId: "ws-operator-intervention",
          runId: "run-operator-intervention",
          remoteRunId: "remote-operator-intervention",
          dispatchId: operatorClaim.dispatchId,
          attemptNumber: 1,
        };
      },
    });
    const recovered = await reconciliation.reconcileJob(operatorJob.id);
    assert.equal(recovered?.status, "running", "authoritative adapter lookup reattaches the original run");
    assert.equal(dispatchCalls, 0, "manual reconciliation never launches a second worker");
    const lateTerminal = jobs.projectEvent({
      id: "late-original-terminal",
      seq: 1,
      durable: true,
      type: "agent.run.failed",
      sessionId: "ws-operator-intervention",
      payload: {
        runId: "run-operator-intervention",
        dispatchId: operatorClaim.dispatchId,
        attemptNumber: 1,
        remoteRunId: "remote-operator-intervention",
      },
      createdAt: new Date().toISOString(),
    });
    assert.equal(lateTerminal?.status, "failed", "late terminal evidence for the recovered original run remains projectable");

    const diagnosticJob = jobs.create({
      principalId: "user-a",
      ownerContextId: "owner-a",
      projectId: "project-a",
      workspaceRoot: "/tmp/project-a",
      runAt: new Date(Date.now() - 1_000).toISOString(),
      instructionJson: { instructions: "Exercise scheduler failure diagnostics." },
      executionMode: "read_only_audit",
      policySnapshotJson: { workspaceAccess: "read_only" },
      workSessionId: "ws-scheduler-diagnostic",
      maxRuntimeMs: 60_000,
    });
    jobs.transition({ jobId: diagnosticJob.id, expectedRevision: diagnosticJob.revision, nextStatus: "running", expectedSourceStatuses: ["pending"] });
    let failProjection = true;
    const durableFailures: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const diagnosticEventStore = createEventStore(db);
    const diagnosticEvents = {
      getEventsAfter: () => { if (failProjection) throw new Error("injected projection database read failure"); return []; },
      appendEvent: (event: { type: string; sessionId: string; payload: Record<string, unknown> }, options?: { publish?: boolean }) => {
        durableFailures.push(event);
        return diagnosticEventStore.appendEvent(event, options);
      },
      subscribeAll: () => () => undefined,
    } as any;
    const diagnosticRuntime = createScheduledJobRuntime({ database: db, jobs, events: diagnosticEvents, pollMs: 60_000 });
    await diagnosticRuntime.drainOnce();
    const diagnostics = diagnosticRuntime.getMetrics();
    assert.equal(diagnostics.serviceability.status, "degraded", "authenticated scheduler metrics report a drain failure separately from liveness");
    assert.equal(diagnostics.lastDrainFailurePhase, "project_lifecycle_events");
    assert.equal(diagnostics.recentDrainFailures, 1);
    assert.equal(durableFailures[0]?.type, "scheduled_job.scheduler_error");
    assert.equal(durableFailures[0]?.payload.retryEligible, true);
    assert.equal(durableFailures[0]?.payload.operationPhase, "project_lifecycle_events");
    assert.equal(durableFailures[0]?.payload.recurrenceCount, 1);
    await diagnosticRuntime.drainOnce();
    const repeatedDiagnostics = diagnosticRuntime.getMetrics();
    assert.equal(repeatedDiagnostics.recentDrainFailures, 2);
    assert.equal(repeatedDiagnostics.lastDrainFailureRecurrenceCount, 2,
      "repeated scheduler failures stay visible with a durable recurrence count");
    failProjection = false;
    await diagnosticRuntime.drainOnce();

    const faultRoot = join(root, "scheduler-fault-diagnostics");
    const faultDb = openDatabase(faultRoot);
    const faultOutbox = createDispatchOutbox(faultDb);
    const faultJobs = createScheduledJobStore(faultDb, faultOutbox);
    const faultEventStore = createEventStore(faultDb);
    const faultEvents: Array<{ type: string; sessionId: string; payload: Record<string, unknown> }> = [];
    const makeFaultEventStore = (getEventsAfter: (sessionId: string, cursor: number) => any[] = () => []) => ({
      getEventsAfter,
      appendEvent: (event: { type: string; sessionId: string; payload: Record<string, unknown> }, options?: { publish?: boolean }) => {
        faultEvents.push(event);
        return faultEventStore.appendEvent(event, options);
      },
      subscribeAll: () => () => undefined,
    }) as any;
    const makeFailureJob = (suffix: string, workSessionId?: string) => faultJobs.create({
      principalId: "failure-user",
      ownerContextId: "failure-owner",
      projectId: "failure-project",
      workspaceRoot: "/tmp/failure-project",
      runAt: new Date(Date.now() - 1_000).toISOString(),
      instructionJson: { instructions: `Exercise ${suffix} recovery.` },
      executionMode: "read_only_audit",
      policySnapshotJson: { workspaceAccess: "read_only" },
      workSessionId,
      maxRuntimeMs: 60_000,
    });
    const beginDispatch = (target: ScheduledJob, dispatcherInstanceId: string) => {
      faultJobs.transition({ jobId: target.id, expectedRevision: target.revision, nextStatus: "due", expectedSourceStatuses: ["pending"] });
      return faultJobs.claimDispatch({ jobId: target.id, expectedRevision: target.revision + 1, dispatcherInstanceId });
    };

    // A raw scheduler query failure must be durably attributed and the same
    // runtime must keep polling; the due job dispatches on the next pass.
    {
      const rawReadJob = makeFailureJob("raw scheduler read");
      let injectReadFailure = true;
      const failingSqlite = new Proxy(faultDb.sqlite, {
        get(target, property) {
          if (property === "prepare") return (statement: string) => {
            if (injectReadFailure && statement.includes("select id, revision, run_at, status from scheduled_jobs")) {
              injectReadFailure = false;
              throw new Error("injected scheduler database read failure");
            }
            return target.prepare(statement);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const failingDatabase = { sqlite: failingSqlite, db: faultDb.db, close: faultDb.close } as any;
      const events = makeFaultEventStore();
      let dispatchCalls = 0;
      const runtime = createScheduledJobRuntime({
        database: failingDatabase,
        jobs: faultJobs,
        dispatchOutbox: faultOutbox,
        events,
        pollMs: 60_000,
        dispatch: async () => { dispatchCalls += 1; return { status: "failed", reason: "test dispatch complete" }; },
      });
      await runtime.drainOnce();
      const readFailure = faultEvents.find((event) => event.payload.operationPhase === "reconcile_nonterminal_jobs");
      assert.ok(readFailure, "raw scheduler database read failures persist a phase-attributed event");
      assert.equal(readFailure.payload.retryEligible, true);
      assert.equal(runtime.getMetrics().serviceability.status, "degraded");
      await runtime.drainOnce();
      assert.equal(dispatchCalls, 1, "the scheduler continues polling and dispatches due work after the read recovers");
      assert.equal(faultJobs.get(rawReadJob.id)?.status, "failed");
    }

    // An exception while applying an otherwise readable lifecycle event is
    // retained at the projection cursor and retried on the very next drain.
    {
      const projectionJob = makeFailureJob("projection application", "ws-projection-application-fault");
      const claim = beginDispatch(projectionJob, "projection-fault-scheduler");
      faultJobs.completeDispatch({
        jobId: projectionJob.id,
        dispatchAttemptId: claim.attemptId,
        expectedRevision: claim.revision,
        dispatcherInstanceId: "projection-fault-scheduler",
        outcome: "dispatched",
        workSessionId: "ws-projection-application-fault",
        acpRunId: "run-projection-application-fault",
        acpDispatchId: claim.dispatchId,
        acpAttemptNumber: 1,
      });
      const event = {
        id: "projection-application-fault-event",
        seq: 1,
        durable: true,
        type: "agent.run.started",
        sessionId: "ws-projection-application-fault",
        payload: { runId: "run-projection-application-fault", dispatchId: claim.dispatchId, attemptNumber: 1 },
        createdAt: new Date().toISOString(),
      };
      let projectCalls = 0;
      let injectProjectionFailure = true;
      const failingJobs = new Proxy(faultJobs, {
        get(target, property, receiver) {
          if (property === "projectEvent") return (candidate: typeof event) => {
            projectCalls += 1;
            if (injectProjectionFailure) {
              injectProjectionFailure = false;
              throw new Error("injected lifecycle projection application failure");
            }
            return target.projectEvent(candidate as any);
          };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const events = makeFaultEventStore((sessionId, cursor) => sessionId === event.sessionId && cursor < event.seq ? [event] : []);
      const runtime = createScheduledJobRuntime({ database: faultDb, jobs: failingJobs, dispatchOutbox: faultOutbox, events, pollMs: 60_000 });
      await runtime.drainOnce();
      assert.equal(runtime.getMetrics().lastDrainFailurePhase, "project_lifecycle_events");
      assert.equal(faultEvents.find((item) => item.payload.operationPhase === "project_lifecycle_events")?.payload.retryEligible, true);
      assert.equal(projectCalls, 1);
      await runtime.drainOnce();
      assert.equal(projectCalls, 2, "failed projection retries from the same bounded target on the next drain");
    }

    // Cancellation adapter errors leave the durable cancellation request
    // fenced and retryable until a later callback confirms worker shutdown.
    {
      const cancellationJob = makeFailureJob("cancellation adapter lookup", "ws-cancellation-adapter-fault");
      const claim = beginDispatch(cancellationJob, "cancellation-fault-scheduler");
      const current = faultJobs.get(cancellationJob.id)!;
      const cancellation = faultJobs.requestCancellation({ jobId: current.id, expectedRevision: current.revision, requestId: "cancel-after-adapter-error" });
      let injectCancellationFailure = true;
      const events = makeFaultEventStore();
      const runtime = createScheduledJobRuntime({
        database: faultDb,
        jobs: faultJobs,
        dispatchOutbox: faultOutbox,
        events,
        pollMs: 60_000,
        reconcileCancellation: async () => {
          if (injectCancellationFailure) {
            injectCancellationFailure = false;
            throw new Error("injected cancellation adapter lookup failure");
          }
          return { state: "worker_cancelled", reason: "adapter confirmed shutdown" };
        },
      });
      await runtime.drainOnce();
      assert.equal(faultJobs.get(cancellationJob.id)?.status, "cancellation_requested");
      const cancellationFailure = faultEvents.find((event) => event.payload.operationPhase === "reconcile_cancellation");
      assert.ok(cancellationFailure, "cancellation adapter lookup failure is durably attributed");
      assert.equal(cancellationFailure.payload.scheduledJobId, cancellationJob.id);
      assert.equal(cancellationFailure.payload.dispatchAttemptId, claim.attemptId);
      assert.equal(cancellationFailure.payload.retryEligible, true);
      assert.equal(runtime.getMetrics().lastDrainFailurePhase, "reconcile_cancellation");
      faultDb.sqlite.prepare("update scheduled_jobs set cancellation_last_attempt_at = ? where id = ?")
        .run(new Date(Date.now() - 60_000).toISOString(), cancellationJob.id);
      await runtime.drainOnce();
      assert.equal(faultJobs.get(cancellationJob.id)?.status, "cancelled", "the same durable cancellation recovers after adapter lookup returns");
      assert.equal(faultJobs.get(cancellationJob.id)?.cancellationRequestId, cancellation.cancellationRequestId);
    }

    // Interrupted-dispatch adapter lookup errors preserve the original
    // attempt, emit retryable diagnostics, and later reattach without launch.
    {
      const lookupJob = makeFailureJob("dispatch adapter lookup", "ws-dispatch-adapter-fault");
      const claim = beginDispatch(lookupJob, "dispatch-fault-scheduler");
      faultDb.sqlite.prepare("update scheduled_job_attempts set lease_expires_at = ? where id = ?")
        .run("2000-01-01T00:00:00.000Z", claim.attemptId);
      let injectLookupFailure = true;
      let injectJobReadFailure = true;
      const failingJobs = new Proxy(faultJobs, {
        get(target, property, receiver) {
          if (property === "get") return (jobId: string) => {
            if (injectJobReadFailure) {
              injectJobReadFailure = false;
              throw new Error("injected scheduler job read failure while recording adapter lookup error");
            }
            return target.get(jobId);
          };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const events = makeFaultEventStore();
      let dispatchCalls = 0;
      const runtime = createScheduledJobRuntime({
        database: faultDb,
        jobs: failingJobs,
        dispatchOutbox: faultOutbox,
        events,
        pollMs: 60_000,
        dispatch: async () => { dispatchCalls += 1; return { status: "failed" }; },
        reconcileDispatch: async () => {
          if (injectLookupFailure) {
            injectLookupFailure = false;
            throw new Error("injected adapter dispatch receipt lookup failure");
          }
          return {
            status: "accepted",
            workSessionId: "ws-dispatch-adapter-fault",
            runId: "run-dispatch-adapter-fault",
            dispatchId: claim.dispatchId,
            attemptNumber: 1,
          };
        },
      });
      await runtime.drainOnce();
      const lookupFailure = faultEvents.find((event) => event.payload.operationPhase === "reconcile_dispatch");
      assert.ok(lookupFailure, "adapter receipt lookup error is persisted even if job attribution lookup also fails");
      assert.equal(lookupFailure.payload.scheduledJobId, lookupJob.id);
      assert.equal(lookupFailure.payload.dispatchAttemptId, claim.attemptId);
      assert.equal(lookupFailure.payload.retryEligible, true);
      assert.equal(faultJobs.get(lookupJob.id)?.status, "uncertain_dispatch");
      assert.equal(runtime.getMetrics().serviceability.status, "degraded");
      await runtime.drainOnce();
      assert.equal(faultJobs.get(lookupJob.id)?.status, "running", "later authoritative lookup reattaches the same remote attempt");
      assert.equal(dispatchCalls, 0, "receipt recovery never launches a duplicate worker");
    }

    faultEventStore.close();
    faultJobs.close();
    faultOutbox.close();
    faultDb.close();
    diagnosticEventStore.close();
  }

  db.close();
  outbox.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("scheduling/scheduled-jobs.test.ts: all assertions passed");

void schedulingOperation;
