import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createDispatchOutbox } from "../dispatch-outbox.js";
import { createEventStore } from "../event-log.js";
import { createScheduledJobStore, schedulingOperation, type ScheduledJob } from "./scheduled-job-store.js";
import { createScheduledJobRuntime } from "./scheduled-job-runtime.js";
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
        return { status: "dispatched", workSessionId: `ws-${jobId}` };
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
      assert.equal(jobs.get(active.id)?.status, "cancelled", "the canonical worker-cancelled event confirms terminal cancellation");
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
      const resolved = jobs.projectEvent(exitEvent);
      assert.equal(resolved?.status, "cancelled", `${terminalWorkerEvent} confirms shutdown while preserving cancellation intent`);
      const revision = resolved?.revision;
      const replayed = jobs.projectEvent(exitEvent);
      assert.equal(replayed?.revision, revision, `${terminalWorkerEvent} replay is idempotent`);
    }

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
      });
      firstOutbox.close();
      firstDb.close();

      const restartedDb = openDatabase(recoveryRoot);
      const restartedOutbox = createDispatchOutbox(restartedDb);
      const restartedJobs = createScheduledJobStore(restartedDb, restartedOutbox);
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
          return { status: "accepted", workSessionId: "ws-lost-response", runId: "run-original" };
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

      restartedDb.sqlite.prepare("update scheduled_job_attempts set started_at = ? where id = ?")
        .run(new Date(Date.now() - 120_000).toISOString(), claim.attemptId);
      events.appendEvent({ type: "agent.run.completed", sessionId: "ws-lost-response", payload: { runId: "run-original" } });
      await runtime.drainOnce();
      assert.equal(restartedJobs.get(lostResponseJob.id)?.status, "running", "worker turn completion cannot claim review approval");
      const finishedAttempt = restartedDb.sqlite.prepare("select completed_at, outcome from scheduled_job_attempts where id = ?")
        .get(claim.attemptId) as { completed_at: string | null; outcome: string | null };
      assert.ok(finishedAttempt.completed_at, "worker completion closes the execution runtime window");
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

  db.close();
  outbox.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("scheduling/scheduled-jobs.test.ts: all assertions passed");

void schedulingOperation;
