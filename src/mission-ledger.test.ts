import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createMissionLedger } from "./mission-ledger.js";
import { normalizeWorkspaceSnapshotIdentity } from "./review-checkpoints.js";
import { createWorkSessionManager } from "./work-sessions.js";
import { databasePath, openDatabase } from "./db/client.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-mission-ledger-test-"));

try {
  assert.deepEqual(normalizeWorkspaceSnapshotIdentity({ snapshotRef: "fs:sha256:abc", snapshotCommit: "fs:sha256:abc" }), {
    kind: "filesystem",
    ref: "fs:sha256:abc",
  });
  assert.throws(() => normalizeWorkspaceSnapshotIdentity({
    snapshotKind: "git",
    snapshotRef: "snapshot-modern",
    snapshotCommit: "snapshot-legacy",
  }), /Conflicting snapshotRef and legacy snapshotCommit/);
  assert.throws(() => normalizeWorkspaceSnapshotIdentity({ snapshotKind: "git", snapshotRef: "fs:sha256:abc" }), /conflicts with snapshot reference/);
  assert.throws(() => normalizeWorkspaceSnapshotIdentity({ snapshotKind: "git" }), /without a snapshot reference/);

  const db = openDatabase(root);
  seedWorkspace(root, "workspace-1");
  const workSessions = createWorkSessionManager(db);
  const ledger = createMissionLedger(db);
  const invalidTestSession = workSessions.create({ workspaceSessionId: "workspace-1", submittedBy: "webui" });
  assert.throws(() => ledger.createMission({
    workSessionId: invalidTestSession.id,
    workspaceSessionId: "workspace-1",
    objective: "invalid test criterion",
    acceptanceCriteria: [{ id: "missing-command", description: "needs a real test", verificationType: "test" }],
  }), /requires a verificationCommand/);
  const invalidRuntimeSession = workSessions.create({ workspaceSessionId: "workspace-1", submittedBy: "webui" });
  assert.throws(() => ledger.createMission({
    workSessionId: invalidRuntimeSession.id,
    workspaceSessionId: "workspace-1",
    objective: "invalid runtime criterion",
    acceptanceCriteria: [{ id: "missing-probe", description: "needs a real probe", verificationType: "runtime_behavior" }],
  }), /requires a runtimeProbe/);
  const runtimeSession = workSessions.create({ workspaceSessionId: "workspace-1", submittedBy: "webui" });
  const runtimeMission = ledger.createMission({
    workSessionId: runtimeSession.id,
    workspaceSessionId: "workspace-1",
    objective: "verify a runtime behavior",
    acceptanceCriteria: [{
      id: "runtime-criterion",
      description: "health endpoint responds",
      verificationType: "runtime_behavior",
      runtimeProbe: { url: "http://127.0.0.1:7676/healthz", expectedStatus: 200 },
    }],
  });
  const runtimeSubmission = workSessions.submitForReview({
    workSessionId: runtimeSession.id,
    diff: "runtime probe target",
    snapshotKind: "git",
    snapshotRef: "runtime-snapshot",
    snapshotCommit: "runtime-snapshot",
  });
  const runtimeContext = {
    submissionId: runtimeSubmission.id,
    snapshotKind: "git" as const,
    snapshotRef: "runtime-snapshot",
    snapshotCommit: "runtime-snapshot",
    reviewEpoch: runtimeSubmission.reviewEpoch,
  };
  assert.throws(() => ledger.recordRuntimeProbeEvidence(runtimeMission.id, [{
    criterionId: "runtime-criterion",
    submissionId: runtimeSubmission.id,
    reviewEpoch: runtimeSubmission.reviewEpoch,
    snapshotKind: "git",
    snapshotRef: "snapshot-modern",
    snapshotCommit: "snapshot-legacy",
    status: "passed",
    command: "GET http://127.0.0.1:7676/healthz",
  }]), /Conflicting snapshotRef and legacy snapshotCommit/);
  assert.throws(() => ledger.recordReviewerEvidence(runtimeMission.id, [{
    criterionId: "runtime-criterion",
    ...runtimeContext,
    status: "passed",
  }]), /cannot satisfy runtime_behavior criterion/);
  ledger.recordRuntimeProbeEvidence(runtimeMission.id, [{
    criterionId: "runtime-criterion",
    ...runtimeContext,
    status: "passed",
    command: "GET http://127.0.0.1:7676/healthz",
    details: { statusCode: 200 },
  }]);
  assert.equal(ledger.canApprove(runtimeSession.id, runtimeContext).allowed, true,
    "only a server runtime probe can satisfy runtime_behavior criteria");
  const session = workSessions.create({
    workspaceSessionId: "workspace-1",
    submittedBy: "webui",
    title: "mission test",
    completionPolicy: "webui_approval_required",
  });
  const mission = ledger.createMission({
    workSessionId: session.id,
    workspaceSessionId: "workspace-1",
    objective: "Fix the bridge",
    acceptanceCriteria: [
      { id: "crit-tests", description: "Regression tests pass", priority: "required", verificationType: "test", verificationCommand: "npm test" },
      { id: "crit-docs", description: "Docs are coherent", priority: "preferred", verificationType: "manual_review" },
    ],
  });
  assert.equal(ledger.createMission({
    workSessionId: session.id,
    workspaceSessionId: "workspace-1",
    objective: "Fix the bridge",
    acceptanceCriteria: [
      { id: "crit-tests", description: "Regression tests pass", priority: "required", verificationType: "test", verificationCommand: "npm test" },
      { id: "crit-docs", description: "Docs are coherent", priority: "preferred", verificationType: "manual_review" },
    ],
  }).id, mission.id, "identical mission creation is idempotent");
  assert.throws(() => ledger.createMission({
    workSessionId: session.id,
    workspaceSessionId: "workspace-1",
    objective: "Silently replace the original contract",
    acceptanceCriteria: [{ id: "crit-tests", description: "Regression tests pass", priority: "required", verificationType: "test", verificationCommand: "npm test" }],
  }), /Mission contract conflict/, "different mission intent cannot be silently ignored");

  const firstSubmission = workSessions.submitForReview({
    workSessionId: session.id,
    diff: "diff --git a/src/bridge.ts b/src/bridge.ts",
    snapshotKind: "git",
    snapshotRef: "snap-current",
    snapshotCommit: "snap-current",
  });
  const firstContext = { submissionId: firstSubmission.id, snapshotKind: "git" as const, snapshotRef: "snap-current", snapshotCommit: "snap-current", reviewEpoch: firstSubmission.reviewEpoch };

  let approval = ledger.canApprove(session.id);
  assert.equal(approval.allowed, false);
  assert.match(approval.reasons.join("\n"), /crit-tests/);

  assert.throws(() => ledger.recordReviewerEvidence(mission.id, [{
    criterionId: "crit-tests",
    ...firstContext,
    status: "passed",
    command: "npm test",
    details: { exitCode: 0, reviewerClaim: true },
  }]), /cannot satisfy test criterion/, "manual reviewer evidence cannot certify a test criterion");
  ledger.recordAgentEvidence(mission.id, [{
    criterionId: "crit-tests",
    ...firstContext,
    status: "passed",
    command: "npm test",
    details: { claimed: true },
  }]);
  approval = ledger.canApprove(session.id, firstContext);
  assert.equal(approval.allowed, false, "agent claims cannot satisfy an automated criterion");

  ledger.recordVerifierEvidence(mission.id, [{
    criterionId: "crit-tests",
    ...firstContext,
    status: "passed",
    command: "npm test",
    details: { exitCode: 0 },
  }]);
  approval = ledger.canApprove(session.id, firstContext);
  assert.equal(approval.allowed, true);

  workSessions.updateStatus(session.id, "changes_requested");
  const currentSubmission = workSessions.submitForReview({
    workSessionId: session.id,
    diff: "diff --git a/src/bridge.ts b/src/bridge.ts",
    snapshotKind: "git",
    snapshotRef: "snap-current",
    snapshotCommit: "snap-current",
  });
  const currentContext = { submissionId: currentSubmission.id, snapshotKind: "git" as const, snapshotRef: "snap-current", snapshotCommit: "snap-current", reviewEpoch: currentSubmission.reviewEpoch };
  approval = ledger.canApprove(session.id, currentContext);
  assert.equal(approval.allowed, false, "evidence from the prior review epoch is stale");
  ledger.recordVerifierEvidence(mission.id, [{ criterionId: "crit-tests", ...currentContext, status: "passed", command: "npm test", details: { exitCode: 0 } }]);
  assert.equal(ledger.canApprove(session.id, currentContext).allowed, true);

  ledger.addFindings(mission.id, [{
    id: "find-security",
    severity: "high",
    category: "security",
    description: "Permission request is one-way only",
    requiredAction: "Return the WebUI decision to the blocked agent",
    requiredVerification: [],
  }]);
  approval = ledger.canApprove(session.id, currentContext);
  assert.equal(approval.allowed, false);
  assert.match(approval.reasons.join("\n"), /find-security/);

  assert.throws(() => (ledger.updateFindingStatus as any)(mission.id, [{ id: "find-security", status: "verified_resolved", resolutionSubmissionId: currentSubmission.id }]), /cannot be directly marked verified_resolved/);
  ledger.updateFindingStatus(mission.id, [{ id: "find-security", status: "claimed_resolved" }]);
  ledger.recordReviewerEvidence(mission.id, [{
    findingId: "find-security",
    ...firstContext,
    status: "passed",
    details: { reviewerIndependentlyConfirmed: true },
  }]);
  assert.throws(() => ledger.resolveFinding(mission.id, "find-security", currentContext), /no independent evidence for the current submitted snapshot/);
  ledger.recordReviewerEvidence(mission.id, [{
    findingId: "find-security",
    ...currentContext,
    status: "passed",
    details: { reviewerIndependentlyConfirmed: true },
  }]);
  const [findingWithCommand] = ledger.addFindings(mission.id, [{
    id: "find-test-required",
    severity: "high",
    description: "Automated finding requires a regression test",
    requiredAction: "Fix the defect",
    requiredVerification: ["npm test"],
  }]);
  ledger.updateFindingStatus(mission.id, [{ id: findingWithCommand.id, status: "claimed_resolved" }]);
  assert.throws(() => ledger.recordReviewerEvidence(mission.id, [{ findingId: findingWithCommand.id, ...currentContext, status: "passed" }]), /cannot satisfy finding/);
  ledger.recordVerifierEvidence(mission.id, [{ findingId: findingWithCommand.id, ...currentContext, status: "passed", command: "npm test", details: { exitCode: 0 } }]);
  const resolution = ledger.resolveFinding(mission.id, "find-security", currentContext);
  assert.ok(resolution.evidenceIds.length > 0);
  ledger.resolveFinding(mission.id, findingWithCommand.id, currentContext);
  const packet = ledger.getPacket(session.id);
  assert.equal(ledger.canApprove(session.id, currentContext).allowed, true);
  assert.equal(packet.evidence.length, 6);
  assert.equal(packet.findings.find((finding) => finding.id === "find-security")?.status, "verified_resolved");
  assert.ok(packet.findings.find((finding) => finding.id === findingWithCommand.id)?.resolutionEvidenceIds.length);

  assert.throws(
    () => ledger.updateFindingStatus(mission.id, [{ id: "find-security", status: "waived" }]),
    /requires a waiverReason/,
  );

  assert.throws(
    () => ledger.createMission({
      workSessionId: "empty-session",
      workspaceSessionId: "workspace-1",
      objective: "Empty mission",
      acceptanceCriteria: [],
    }),
    /requires at least one required acceptance criterion/,
  );

  // --- Anti-runaway loop guard -------------------------------------------
  const loopSession = workSessions.create({
    workspaceSessionId: "workspace-1",
    submittedBy: "webui",
    title: "loop guard test",
    completionPolicy: "webui_approval_required",
  });
  const loopMission = ledger.createMission({
    workSessionId: loopSession.id,
    workspaceSessionId: "workspace-1",
    objective: "Add feature X",
    acceptanceCriteria: [{ id: "loop-crit", description: "Feature X works", priority: "required", verificationType: "test", verificationCommand: "npm test" }],
    maxCorrectionRounds: 2,
  });

  // An out-of-scope finding is advisory: it must NOT block approval on its own.
  const [oos] = ledger.addFindings(loopMission.id, [
    { description: "Pre-existing typo in unrelated module", requiredAction: "ignore", severity: "high", scope: "out_of_scope" },
  ]);
  assert.equal(oos.scope, "out_of_scope");
  // (criterion still unverified blocks, but the finding itself does not add a reason)
  const oosApproval = ledger.canApprove(loopSession.id);
  assert.ok(!oosApproval.reasons.some((r) => r.includes(oos.id)), "out_of_scope finding must not block");

  const [deduped] = ledger.addFindings(loopMission.id, [{
    description: "Parser crashes on null input",
    requiredAction: "handle null input",
    severity: "high",
    evidence: [{ path: "src/parser.ts", line: 12 }],
  }]);
  const duplicate = ledger.addFindings(loopMission.id, [{
    description: " parser   crashes on NULL input ",
    requiredAction: "handle null input",
    severity: "blocker",
    evidence: [{ path: "src/parser.ts", line: 18 }],
  }]);
  assert.equal(duplicate.length, 0, "semantically identical open findings should not create another row");
  const merged = ledger.getPacket(loopSession.id).findings.find((finding) => finding.id === deduped.id);
  assert.equal(merged?.severity, "blocker", "duplicate evidence can raise severity");
  assert.equal(merged?.evidence.length, 2, "duplicate finding evidence is merged onto the canonical row");
  const advisory = ledger.addFindings(loopMission.id, [{
    description: "Consider documenting parser inputs",
    requiredAction: "document parser inputs",
    severity: "high",
    disposition: "advisory",
  }]);
  assert.ok(advisory[0]);
  assert.ok(!ledger.canApprove(loopSession.id).reasons.some((r) => r.includes(advisory[0].id)), "advisory findings do not block approval");

  // A round with no new blocking findings has converged — no extension.
  const converged = ledger.evaluateLoopExtension(loopSession.id, { newFindingIds: [] });
  assert.equal(converged.extend, false);
  assert.match(converged.reason, /converged/);

  // P2 #34/#35: review-coverage contract. A mission declaring coverage lenses
  // blocks approval until a completion report records every lens as covered;
  // uncertainty is persisted alongside for honest review termination.
  const covSession = workSessions.create({
    workspaceSessionId: "workspace-1",
    submittedBy: "webui",
    title: "coverage test",
    completionPolicy: "webui_approval_required",
  });
  const covMission = ledger.createMission({
    workSessionId: covSession.id,
    workspaceSessionId: "workspace-1",
    objective: "Audit the repo",
    acceptanceCriteria: [{ id: "cov-crit", description: "Audit complete", priority: "required", verificationType: "manual_review" }],
    reviewCoverage: ["security", "correctness"],
  });
  ledger.recordReviewCoverage(covMission.id, {
    submissionId: "sub_cov",
    snapshotKind: "git",
    snapshotRef: "snap_cov",
    reviewCoverage: ["security"],
    uncertainty: [{ area: "performance", level: "not inspected" }],
  });
  const partial = ledger.canApprove(covSession.id, { submissionId: "sub_cov", snapshotKind: "git", snapshotRef: "snap_cov" });
  assert.ok(partial.reasons.some((r) => r.includes("correctness")), "missing coverage lens must block approval");
  assert.ok(!partial.reasons.some((r) => r.includes("security")), "covered lens must not block");
  ledger.recordReviewCoverage(covMission.id, {
    submissionId: "sub_cov",
    snapshotKind: "git",
    snapshotRef: "snap_cov",
    reviewCoverage: ["correctness"],
  });
  const covered = ledger.canApprove(covSession.id, { submissionId: "sub_cov", snapshotKind: "git", snapshotRef: "snap_cov" });
  assert.ok(!covered.reasons.some((r) => r.includes("Review coverage is incomplete")), "all lenses covered → no coverage reason");

  // P1 #14: both orderings produce identical approval semantics — a later
  // verification report must MERGE prior coverage, not displace it.
  ledger.recordCompletionReport(covMission.id, {
    submissionId: "sub_cov",
    snapshotKind: "git",
    snapshotRef: "snap_cov",
    status: "passed",
    results: [{ command: "npm test", status: "passed" }],
  });
  const afterVerify = ledger.canApprove(covSession.id, { submissionId: "sub_cov", snapshotKind: "git", snapshotRef: "snap_cov" });
  assert.ok(!afterVerify.reasons.some((r) => r.includes("Review coverage is incomplete")), "verification report must preserve earlier reviewer coverage");

  // A new blocking in-scope finding extends the loop (round 1).
  const [blk1] = ledger.addFindings(loopMission.id, [
    { description: "Feature X crashes on empty input", requiredAction: "handle empty", severity: "blocker", scope: "in_scope" },
  ]);
  const ext1 = ledger.evaluateLoopExtension(loopSession.id, { newFindingIds: [blk1.id] });
  assert.equal(ext1.extend, true);
  assert.equal(ext1.round, 1);

  // Runaway (new blocking findings, nothing ever resolved) stops HARD at the
  // ceiling (max 2, no progress headroom).
  const [blk2] = ledger.addFindings(loopMission.id, [
    { description: "Another new blocker", requiredAction: "fix", severity: "blocker", scope: "in_scope" },
  ]);
  const ext2 = ledger.evaluateLoopExtension(loopSession.id, { newFindingIds: [blk2.id] });
  assert.equal(ext2.extend, true, "round 2 within ceiling");
  const [blk3] = ledger.addFindings(loopMission.id, [
    { description: "Yet another new blocker", requiredAction: "fix", severity: "blocker", scope: "in_scope" },
  ]);
  const ext3 = ledger.evaluateLoopExtension(loopSession.id, { newFindingIds: [blk3.id] });
  assert.equal(ext3.extend, false, "ceiling backstop stops the runaway");
  assert.equal(ext3.ceilingHit, true);

  // Progress headroom: a round that RESOLVES prior findings earns extra rounds
  // beyond the raw ceiling, so genuinely-needed work is not cut off.
  const progressSession = workSessions.create({
    workspaceSessionId: "workspace-1",
    submittedBy: "webui",
    title: "progress headroom test",
    completionPolicy: "webui_approval_required",
  });
  const progressMission = ledger.createMission({
    workSessionId: progressSession.id,
    workspaceSessionId: "workspace-1",
    objective: "Iterate with progress",
    acceptanceCriteria: [{ id: "p-crit", description: "works", priority: "required", verificationType: "test", verificationCommand: "npm test" }],
    maxCorrectionRounds: 1,
  });
  const [pf1] = ledger.addFindings(progressMission.id, [{ description: "b1", requiredAction: "fix", severity: "blocker", scope: "in_scope" }]);
  const p1 = ledger.evaluateLoopExtension(progressSession.id, { newFindingIds: [pf1.id] });
  assert.equal(p1.extend, true); // round 1 == ceiling 1
  const [pf2] = ledger.addFindings(progressMission.id, [{ description: "b2", requiredAction: "fix", severity: "blocker", scope: "in_scope" }]);
  // Without progress this would exceed ceiling 1; WITH a resolved finding it gets headroom.
  const p2 = ledger.evaluateLoopExtension(progressSession.id, { newFindingIds: [pf2.id], resolvedFindingIds: [pf1.id] });
  assert.equal(p2.extend, true, "progress earns headroom past the raw ceiling");
  assert.ok(p2.maxRounds > progressMission.maxCorrectionRounds, "effective ceiling raised by progress");

  // setWorkOrderPreferredAgent (session handoff keeps mission routing in sync).
  const wo = ledger.createWorkOrder(mission.id, session.id, {
    objectiveForThisTurn: "investigate",
    preferredAgent: "crush",
  });
  assert.equal(wo.preferredAgent, "crush");
  const changed = ledger.setWorkOrderPreferredAgent(session.id, "hermes");
  assert.equal(changed, 1, "the active work order should be repointed");
  assert.equal(
    ledger.getPacket(session.id).workOrders[0]?.preferredAgent,
    "hermes",
    "handoff must update the active work order's preferredAgent so the dispatcher routes to the new agent",
  );
  // No mission for an unknown session → no-op, not a throw.
  assert.equal(ledger.setWorkOrderPreferredAgent("ws_no_mission", "hermes"), 0);

  const graphSession = workSessions.create({ workspaceSessionId: "workspace-1", submittedBy: "webui", title: "dependency graph", completionPolicy: "webui_approval_required" });
  const graphMission = ledger.createMission({
    workSessionId: graphSession.id,
    workspaceSessionId: "workspace-1",
    objective: "dependency graph",
    acceptanceCriteria: [
      { id: "base", description: "base requirement", priority: "required" },
      { id: "integration", description: "integration requirement", priority: "required", dependsOnCriterionIds: ["base"] },
    ],
  });
  assert.deepEqual(ledger.getPacket(graphSession.id).criteria.find((criterion) => criterion.id === "integration")?.dependsOnCriterionIds, ["base"]);
  const cyclicSession = workSessions.create({ workspaceSessionId: "workspace-1", submittedBy: "webui", title: "cycle", completionPolicy: "webui_approval_required" });
  assert.throws(() => ledger.createMission({
    workSessionId: cyclicSession.id,
    workspaceSessionId: "workspace-1",
    objective: "cycle",
    acceptanceCriteria: [
      { id: "a", description: "a", priority: "required", dependsOnCriterionIds: ["b"] },
      { id: "b", description: "b", priority: "required", dependsOnCriterionIds: ["a"] },
    ],
  }), /dependency cycle/);

  // A restart between a failed first pass and correction resubmission must
  // preserve the mission contract while keeping snapshot-A evidence stale.
  const restartRoot = mkdtempSync(join(root, "mission-restart-"));
  const restartBootstrapDb = openDatabase(restartRoot);
  restartBootstrapDb.close();
  seedWorkspace(restartRoot, "workspace-restart");
  let restartDb = openDatabase(restartRoot);
  let restartSessions = createWorkSessionManager(restartDb);
  let restartLedger = createMissionLedger(restartDb);
  const restartSession = restartSessions.create({
    workspaceSessionId: "workspace-restart",
    submittedBy: "webui",
    completionPolicy: "webui_approval_required",
  });
  const restartMission = restartLedger.createMission({
    workSessionId: restartSession.id,
    workspaceSessionId: "workspace-restart",
    objective: "Correct and verify after restart",
    acceptanceCriteria: [{
      id: "restart-test",
      description: "Regression test passes on the submitted snapshot",
      priority: "required",
      verificationType: "test",
      verificationCommand: "npm --version",
    }],
  });
  const [restartFinding] = restartLedger.addFindings(restartMission.id, [{
    id: "restart-finding",
    description: "The initial submitted snapshot fails verification",
    requiredAction: "Correct the implementation",
    requiredVerification: ["npm --version"],
    severity: "blocker",
    scope: "in_scope",
  }]);
  const firstRestartSubmission = restartSessions.submitForReview({
    workSessionId: restartSession.id,
    diff: "first attempt",
    snapshotKind: "git",
    snapshotRef: "restart-snapshot-a",
    snapshotCommit: "restart-snapshot-a",
  });
  const firstRestartContext = {
    submissionId: firstRestartSubmission.id,
    snapshotKind: "git" as const,
    snapshotRef: "restart-snapshot-a",
    snapshotCommit: "restart-snapshot-a",
    reviewEpoch: firstRestartSubmission.reviewEpoch,
  };
  restartLedger.recordVerifierEvidence(restartMission.id, [{
    criterionId: "restart-test",
    findingId: restartFinding.id,
    ...firstRestartContext,
    command: "npm --version",
    status: "failed",
    details: { exitCode: 1 },
  }]);
  restartDb.close(); // Simulated process restart: only durable state survives.

  restartDb = openDatabase(restartRoot);
  restartSessions = createWorkSessionManager(restartDb);
  restartLedger = createMissionLedger(restartDb);
  assert.equal(restartLedger.getMissionByWorkSession(restartSession.id)?.objective, "Correct and verify after restart");
  assert.equal(restartLedger.getPacket(restartSession.id).evidence[0]?.submissionId, firstRestartSubmission.id,
    "failed verifier evidence survives the restart with its original submission binding");
  restartSessions.updateStatus(restartSession.id, "changes_requested");
  restartLedger.updateFindingStatus(restartMission.id, [{ id: restartFinding.id, status: "claimed_resolved" }]);
  const correctedSubmission = restartSessions.submitForReview({
    workSessionId: restartSession.id,
    diff: "corrected attempt",
    snapshotKind: "git",
    snapshotRef: "restart-snapshot-b",
    snapshotCommit: "restart-snapshot-b",
  });
  const correctedContext = {
    submissionId: correctedSubmission.id,
    snapshotKind: "git" as const,
    snapshotRef: "restart-snapshot-b",
    snapshotCommit: "restart-snapshot-b",
    reviewEpoch: correctedSubmission.reviewEpoch,
  };
  assert.equal(restartLedger.evaluateCriteria(restartSession.id, correctedContext)[0]?.status, "unverified",
    "snapshot-A failure or any earlier status cannot certify snapshot B");
  assert.throws(() => restartLedger.resolveFinding(restartMission.id, restartFinding.id, correctedContext), /missing current server verification/);
  restartLedger.recordVerifierEvidence(restartMission.id, [{
    criterionId: "restart-test",
    findingId: restartFinding.id,
    ...correctedContext,
    command: "npm --version",
    status: "passed",
    details: { exitCode: 0 },
  }]);
  restartLedger.resolveFinding(restartMission.id, restartFinding.id, correctedContext);
  restartLedger.recordCompletionReport(restartMission.id, {
    submissionId: correctedSubmission.id,
    snapshotKind: "git",
    snapshotRef: "restart-snapshot-b",
    status: "passed",
    results: [{ command: "npm --version", status: "passed" }],
  });
  assert.equal(restartLedger.canApprove(restartSession.id, correctedContext).allowed, true,
    "fresh server evidence on the exact resubmission closes the durable mission after restart");
  restartDb.close();

  ledger.close();
  console.log("mission-ledger.test.ts: all assertions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function seedWorkspace(dir: string, id: string): void {
  const sqlite = new Database(databasePath(dir));
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(
    `insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) ` +
    `values ('${id}', '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
  );
  sqlite.close();
}
