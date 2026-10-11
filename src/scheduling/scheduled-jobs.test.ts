import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createDispatchOutbox } from "../dispatch-outbox.js";
import { createScheduledJobStore, schedulingOperation } from "./scheduled-job-store.js";

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

  db.close();
  outbox.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("scheduling/scheduled-jobs.test.ts: all assertions passed");

void schedulingOperation;
