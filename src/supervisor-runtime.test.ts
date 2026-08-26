import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { createDispatchOutbox } from "./dispatch-outbox.js";
import { createEventStore } from "./event-log.js";
import { parseVerificationCommand } from "./mission-verifier.js";
import { createSupervisorRuns } from "./supervisor-runs.js";
import { createSupervisorRuntime, deterministicFailureFingerprint } from "./supervisor-runtime.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-supervisor-runtime-test-"));
try {
  assert.equal(
    deterministicFailureFingerprint({ decision: "correction_pending", reasons: ["  b  ", "a\nvalue", "b"] }),
    deterministicFailureFingerprint({ decision: "correction_pending", reasons: ["a value", "b"] }),
    "failure fingerprints normalize ordering, duplicate reasons, and whitespace",
  );
  const db = openDatabase(root);
  const createdAt = new Date().toISOString();
  db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, ?, ?, ?, ?, ?, ?)")
    .run("ws_supervisor", "/tmp", "active", "checkout", "false", createdAt, createdAt);
  db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, status, completion_policy, review_epoch, submitted_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("work_supervisor", "ws_supervisor", "in_progress", "webui_approval_required", 0, "test", createdAt, createdAt);
  db.sqlite.prepare("insert into mission_contracts (id, work_session_id, workspace_session_id, objective, desired_outcome, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)")
    .run("mission_supervisor", "work_supervisor", "ws_supervisor", "test", "test", createdAt, createdAt);
  const runs = createSupervisorRuns(db);
  const outbox = createDispatchOutbox(db);
  const events = createEventStore(db);
  const run = runs.create({ missionId: "mission_supervisor", workSessionId: "work_supervisor", workspaceSessionId: "ws_supervisor", autonomyMode: "correction_auto", maxCycles: 2 });
  const active = runs.transition({ id: run.id, expectedStatus: "created", expectedRevision: run.revision, nextStatus: "worker_active" });
  assert.ok(active);
  assert.equal(runs.transition({ id: active.id, expectedStatus: "created", expectedRevision: active.revision, nextStatus: "failed" }), undefined, "stale status/revision must not win CAS");
  const paused = runs.pause(active.id, active.revision);
  assert.ok(paused);
  assert.equal(paused.status, "paused");
  assert.equal(paused.resumeStatus, "worker_active");
  const resumed = runs.resume(paused.id, paused.revision);
  assert.ok(resumed);
  assert.equal(resumed.status, "worker_active");
  const lease = runs.claim(resumed.id, "test-fingerprint", 10_000);
  assert.ok(lease);
  assert.ok(lease.leaseNonce, "claimed supervisor work must carry a fencing nonce");
  assert.equal(
    runs.transition({
      id: lease.id,
      expectedStatus: lease.status,
      expectedRevision: lease.revision,
      nextStatus: "failed",
      lease: { ownerInstanceId: "stale-worker", leaseNonce: "stale-nonce" },
    }),
    undefined,
    "a stale lease owner cannot commit a supervisor transition",
  );
  assert.ok(runs.renew(lease.id, "test-fingerprint", lease.leaseNonce, 10_000), "current lease owner can renew with its nonce");
  assert.equal(runs.noteFailureFingerprint(resumed.id, "test-fingerprint", "same-failure"), 1);
  assert.equal(runs.noteFailureFingerprint(resumed.id, "test-fingerprint", "same-failure"), 2);
  assert.equal(runs.noteFailureFingerprint(resumed.id, "test-fingerprint", "other-failure"), 1, "new failure fingerprint resets the repetition counter");
  runs.release(resumed.id, "test-fingerprint");

  let verified = 0;
  let corrected = 0;
  const runtime = createSupervisorRuntime({
    outbox,
    events,
    runs,
    onVerify: async () => { verified += 1; },
    onEvaluate: async () => ({ decision: "correction_pending", reasons: ["required verification failed"] }),
    onCorrect: async (_workSessionId, reasons) => { corrected += 1; assert.deepEqual(reasons, ["required verification failed"]); },
    onApprove: async () => { throw new Error("approval should not be invoked for a correction"); },
    currentSubmission: () => ({ id: "sub_1", snapshotCommit: "snap_1" }),
    currentSessionStatus: () => "in_progress",
    currentApproval: () => ({ allowed: false, reasons: ["required verification failed"] }),
  });
  runtime.start();
  events.appendEvent({ type: "review.submitted", sessionId: "work_supervisor", payload: { submissionId: "sub_1" } });
  await runtime.drainOnce();
  await runtime.drainOnce();
  runtime.stop();
  const advanced = runs.getByWorkSession("work_supervisor");
  assert.equal(verified, 1);
  assert.equal(corrected, 1);
  assert.equal(advanced?.status, "worker_active");
  assert.equal(advanced?.cycleNumber, 1);
  assert.equal(outbox.listPending().filter((event) => event.eventType === "supervisor.verification.requested").length, 0);

  db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, status, completion_policy, review_epoch, submitted_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("work_approval", "ws_supervisor", "in_progress", "webui_approval_required", 0, "test", createdAt, createdAt);
  db.sqlite.prepare("insert into mission_contracts (id, work_session_id, workspace_session_id, objective, desired_outcome, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)")
    .run("mission_approval", "work_approval", "ws_supervisor", "test", "test", createdAt, createdAt);
  const approvalRun = runs.create({ missionId: "mission_approval", workSessionId: "work_approval", workspaceSessionId: "ws_supervisor", autonomyMode: "full", approvalMode: "policy_auto" });
  const approvalActive = runs.transition({ id: approvalRun.id, expectedStatus: "created", expectedRevision: approvalRun.revision, nextStatus: "worker_active" });
  assert.ok(approvalActive);
  let approvals = 0;
  const approvalRuntime = createSupervisorRuntime({
    outbox, events, runs,
    onVerify: async () => {},
    onEvaluate: async () => ({ decision: "approval_pending", reasons: [] }),
    onCorrect: async () => { throw new Error("correction should not be invoked for approval"); },
    onApprove: async () => { approvals += 1; },
    currentSubmission: (workSessionId) => workSessionId === "work_approval" ? ({ id: "sub_2", snapshotCommit: "snap_2" }) : undefined,
    currentSessionStatus: () => "in_progress",
    currentApproval: () => ({ allowed: true, reasons: [] }),
  });
  approvalRuntime.start();
  events.appendEvent({ type: "review.submitted", sessionId: "work_approval", payload: { submissionId: "sub_2" } });
  await approvalRuntime.drainOnce();
  await approvalRuntime.drainOnce();
  approvalRuntime.stop();
  assert.equal(approvals, 1);
  assert.equal(runs.getByWorkSession("work_approval")?.status, "completed");

  // A hung verifier must consume only its work-session slot. Unrelated
  // sessions should use the remaining pool capacity and continue draining.
  const poolSessions = ["pool_a", "pool_b", "pool_c"];
  for (const workSessionId of poolSessions) {
    const missionId = `mission_${workSessionId}`;
    db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, status, completion_policy, review_epoch, submitted_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(workSessionId, "ws_supervisor", "in_progress", "webui_approval_required", 0, "test", createdAt, createdAt);
    db.sqlite.prepare("insert into mission_contracts (id, work_session_id, workspace_session_id, objective, desired_outcome, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)")
      .run(missionId, workSessionId, "ws_supervisor", "test", "test", createdAt, createdAt);
    const poolRun = runs.create({ missionId, workSessionId, workspaceSessionId: "ws_supervisor", autonomyMode: "verify_only" });
    assert.ok(runs.transition({ id: poolRun.id, expectedStatus: "created", expectedRevision: poolRun.revision, nextStatus: "worker_active" }));
  }
  const previousMaxInflight = process.env.KONTROL_SUPERVISOR_MAX_INFLIGHT;
  process.env.KONTROL_SUPERVISOR_MAX_INFLIGHT = "2";
  let releaseA!: () => void;
  let releaseB!: () => void;
  let releaseC!: () => void;
  const gates = {
    pool_a: new Promise<void>((resolve) => { releaseA = resolve; }),
    pool_b: new Promise<void>((resolve) => { releaseB = resolve; }),
    pool_c: new Promise<void>((resolve) => { releaseC = resolve; }),
  };
  const activePool = new Set<string>();
  let maxObserved = 0;
  const poolRuntime = createSupervisorRuntime({
    outbox, events, runs,
    onVerify: async (workSessionId) => {
      activePool.add(workSessionId);
      maxObserved = Math.max(maxObserved, activePool.size);
      await gates[workSessionId as keyof typeof gates];
      activePool.delete(workSessionId);
    },
    onEvaluate: async () => ({ decision: "awaiting_human", reasons: [] }),
    onCorrect: async () => {}, onApprove: async () => {},
    currentSubmission: (workSessionId) => poolSessions.includes(workSessionId) ? ({ id: `sub_${workSessionId}`, snapshotCommit: `snap_${workSessionId}` }) : undefined,
    currentSessionStatus: () => "in_progress",
    currentApproval: () => ({ allowed: false, reasons: [] }),
  });
  poolRuntime.start();
  poolRuntime.wake("pool_a");
  poolRuntime.wake("pool_b");
  poolRuntime.wake("pool_c");
  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(predicate(), true, "supervisor pool did not reach the expected state");
  };
  await waitFor(() => activePool.size === 2);
  assert.equal(activePool.has("pool_c"), false, "pool saturation should queue the third session");
  releaseB();
  await waitFor(() => activePool.has("pool_c"));
  assert.equal(activePool.has("pool_a"), true, "a hung verifier must not be cancelled by unrelated work");
  releaseA();
  releaseC();
  await waitFor(() => activePool.size === 0);
  poolRuntime.stop();
  if (previousMaxInflight === undefined) delete process.env.KONTROL_SUPERVISOR_MAX_INFLIGHT;
  else process.env.KONTROL_SUPERVISOR_MAX_INFLIGHT = previousMaxInflight;
  assert.equal(maxObserved, 2, "supervisor pool should honor its configured bound");
  assert.deepEqual(poolSessions.map((id) => runs.getByWorkSession(id)?.status), ["awaiting_human", "awaiting_human", "awaiting_human"]);

  db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, status, completion_policy, review_epoch, submitted_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("work_blocked", "ws_supervisor", "in_progress", "webui_approval_required", 0, "test", createdAt, createdAt);
  db.sqlite.prepare("insert into mission_contracts (id, work_session_id, workspace_session_id, objective, desired_outcome, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)")
    .run("mission_blocked", "work_blocked", "ws_supervisor", "test", "test", createdAt, createdAt);
  const blockedRun = runs.create({ missionId: "mission_blocked", workSessionId: "work_blocked", workspaceSessionId: "ws_supervisor", autonomyMode: "verify_only" });
  assert.ok(runs.transition({ id: blockedRun.id, expectedStatus: "created", expectedRevision: blockedRun.revision, nextStatus: "worker_active" }));
  const blockerRuntime = createSupervisorRuntime({
    outbox, events, runs,
    onVerify: async () => {}, onEvaluate: async () => ({ decision: "awaiting_human", reasons: [] }), onCorrect: async () => {}, onApprove: async () => {}, currentSubmission: () => undefined, currentSessionStatus: () => "in_progress", currentApproval: () => ({ allowed: false, reasons: [] }),
  });
  blockerRuntime.start();
  events.appendEvent({ type: "agent.message.posted", sessionId: "work_blocked", payload: { kind: "clarification_request" } });
  blockerRuntime.stop();
  assert.equal(runs.getByWorkSession("work_blocked")?.status, "awaiting_human", "clarification requests safely pause unattended work for a reviewer");

  db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, status, completion_policy, review_epoch, submitted_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("work_recovered", "ws_supervisor", "approved", "webui_approval_required", 0, "test", createdAt, createdAt);
  db.sqlite.prepare("insert into mission_contracts (id, work_session_id, workspace_session_id, objective, desired_outcome, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)")
    .run("mission_recovered", "work_recovered", "ws_supervisor", "test", "test", createdAt, createdAt);
  const recoveredRun = runs.create({ missionId: "mission_recovered", workSessionId: "work_recovered", workspaceSessionId: "ws_supervisor", autonomyMode: "verify_only" });
  assert.ok(runs.transition({ id: recoveredRun.id, expectedStatus: "created", expectedRevision: recoveredRun.revision, nextStatus: "worker_active" }));
  const recoveryRuntime = createSupervisorRuntime({
    outbox, events, runs,
    onVerify: async () => {}, onEvaluate: async () => ({ decision: "awaiting_human", reasons: [] }), onCorrect: async () => {}, onApprove: async () => {}, currentSubmission: () => undefined,
    currentSessionStatus: (workSessionId) => workSessionId === "work_recovered" ? "approved" : "in_progress",
    currentApproval: () => ({ allowed: false, reasons: [] }),
  });
  recoveryRuntime.start();
  recoveryRuntime.stop();
  assert.equal(runs.getByWorkSession("work_recovered")?.status, "completed", "startup reconciliation trusts the durable terminal work-session state");

  // A paused correction is not safe to resume merely by changing its status:
  // the runtime must recreate the lost durable action as well.
  db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, status, completion_policy, review_epoch, submitted_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("work_resume_correction", "ws_supervisor", "changes_requested", "webui_approval_required", 0, "test", createdAt, createdAt);
  db.sqlite.prepare("insert into mission_contracts (id, work_session_id, workspace_session_id, objective, desired_outcome, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)")
    .run("mission_resume_correction", "work_resume_correction", "ws_supervisor", "test", "test", createdAt, createdAt);
  const correctionRun = runs.create({ missionId: "mission_resume_correction", workSessionId: "work_resume_correction", workspaceSessionId: "ws_supervisor", autonomyMode: "correction_auto" });
  const correctionPending = runs.transition({ id: correctionRun.id, expectedStatus: "created", expectedRevision: correctionRun.revision, nextStatus: "correction_pending" });
  assert.ok(correctionPending);
  const correctionPaused = runs.pause(correctionPending.id, correctionPending.revision);
  assert.ok(correctionPaused);
  const correctionResumed = runs.resume(correctionPaused.id, correctionPaused.revision);
  assert.ok(correctionResumed);
  let resumedCorrections = 0;
  const resumeRuntime = createSupervisorRuntime({
    outbox, events, runs,
    onVerify: async () => {}, onEvaluate: async () => ({ decision: "awaiting_human", reasons: [] }),
    onCorrect: async () => { resumedCorrections += 1; }, onApprove: async () => {},
    currentSubmission: (workSessionId) => workSessionId === "work_resume_correction" ? ({ id: "sub_resume", snapshotCommit: "snap_resume" }) : undefined,
    currentSessionStatus: () => "changes_requested",
    currentApproval: () => ({ allowed: false, reasons: [] }),
  });
  resumeRuntime.start();
  resumeRuntime.wake("work_resume_correction");
  await resumeRuntime.drainOnce();
  resumeRuntime.stop();
  assert.equal(resumedCorrections, 1, "resuming a paused correction requeues exactly one correction action");
  assert.equal(runs.getByWorkSession("work_resume_correction")?.status, "worker_active");

  // A process restart between a native turn ending and the review event being
  // consumed must still verify the already-persisted submission.
  db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, status, completion_policy, review_epoch, submitted_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("work_submission_recovery", "ws_supervisor", "awaiting_review", "webui_approval_required", 0, "test", createdAt, createdAt);
  db.sqlite.prepare("insert into mission_contracts (id, work_session_id, workspace_session_id, objective, desired_outcome, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)")
    .run("mission_submission_recovery", "work_submission_recovery", "ws_supervisor", "test", "test", createdAt, createdAt);
  const submissionRecoveryRun = runs.create({ missionId: "mission_submission_recovery", workSessionId: "work_submission_recovery", workspaceSessionId: "ws_supervisor", autonomyMode: "verify_only" });
  assert.ok(runs.transition({ id: submissionRecoveryRun.id, expectedStatus: "created", expectedRevision: submissionRecoveryRun.revision, nextStatus: "awaiting_submission" }));
  let recoveredVerifications = 0;
  const submissionRecoveryRuntime = createSupervisorRuntime({
    outbox, events, runs,
    onVerify: async () => { recoveredVerifications += 1; }, onEvaluate: async () => ({ decision: "awaiting_human", reasons: [] }), onCorrect: async () => {}, onApprove: async () => {},
    currentSubmission: (workSessionId) => workSessionId === "work_submission_recovery" ? ({ id: "sub_recovered", snapshotCommit: "snap_recovered" }) : undefined,
    currentSessionStatus: () => "awaiting_review",
    currentApproval: () => ({ allowed: false, reasons: [] }),
  });
  submissionRecoveryRuntime.start();
  await submissionRecoveryRuntime.drainOnce();
  submissionRecoveryRuntime.stop();
  assert.equal(recoveredVerifications, 1, "startup recovery verifies a submission already persisted while awaiting submission");
  assert.equal(runs.getByWorkSession("work_submission_recovery")?.status, "awaiting_human");

  assert.deepEqual(parseVerificationCommand("npm test"), { executable: "npm", args: ["test"] });
  assert.throws(() => parseVerificationCommand("npm test; rm -rf /"), /not permitted/);
  assert.throws(() => parseVerificationCommand("node -e process.exit(0)"), /not permitted/);
  assert.throws(() => parseVerificationCommand("sh tests.sh"), /not allowlisted/);
  events.close(); outbox.close(); runs.close(); db.close();
  console.log("supervisor-runtime.test.ts: all assertions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
