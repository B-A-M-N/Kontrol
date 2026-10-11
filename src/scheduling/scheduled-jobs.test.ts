import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createDispatchOutbox } from "../dispatch-outbox.js";
import { createScheduledJobStore, schedulingOperation } from "./scheduled-job-store.js";
import { createScheduledJobRuntime } from "./scheduled-job-runtime.js";

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

  jobs.transition({ jobId: job.id, expectedRevision: 1, nextStatus: "dispatching" });
  let rejected = false;
  try {
    jobs.transition({ jobId: job.id, expectedRevision: 1, nextStatus: "running" });
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "stale job revision cannot drive the state machine");

  jobs.transition({ jobId: job.id, expectedRevision: 2, nextStatus: "cancelled", lastError: "operator cancelled" });
  assert.equal(jobs.get(job.id)?.status, "cancelled");

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
        return "dispatched";
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

  db.close();
  outbox.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("scheduling/scheduled-jobs.test.ts: all assertions passed");

void schedulingOperation;
