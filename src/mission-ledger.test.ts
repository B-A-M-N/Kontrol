import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createMissionLedger } from "./mission-ledger.js";
import { createWorkSessionManager } from "./work-sessions.js";
import { databasePath, openDatabase } from "./db/client.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-mission-ledger-test-"));

try {
  const db = openDatabase(root);
  seedWorkspace(root, "workspace-1");
  const workSessions = createWorkSessionManager(db);
  const ledger = createMissionLedger(db);
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
      { id: "crit-tests", description: "Regression tests pass", priority: "required", verificationType: "test" },
      { id: "crit-docs", description: "Docs are coherent", priority: "preferred", verificationType: "manual_review" },
    ],
  });

  let approval = ledger.canApprove(session.id);
  assert.equal(approval.allowed, false);
  assert.match(approval.reasons.join("\n"), /crit-tests/);

  ledger.recordEvidence(mission.id, [{
    criterionId: "crit-tests",
    submissionId: "sub-old",
    snapshotCommit: "snap-old",
    status: "passed",
    command: "npm test",
    details: { exitCode: 0 },
  }]);
  approval = ledger.canApprove(session.id, { submissionId: "sub-current", snapshotCommit: "snap-current" });
  assert.equal(approval.allowed, false);
  assert.match(approval.reasons.join("\n"), /no current non-agent evidence/);

  ledger.recordAgentEvidence(mission.id, [{
    criterionId: "crit-tests",
    submissionId: "sub-current",
    snapshotCommit: "snap-current",
    status: "passed",
    command: "npm test",
    details: { claimed: true },
  }]);
  approval = ledger.canApprove(session.id, { submissionId: "sub-current", snapshotCommit: "snap-current" });
  assert.equal(approval.allowed, false);

  ledger.recordEvidence(mission.id, [{
    criterionId: "crit-tests",
    submissionId: "sub-current",
    snapshotCommit: "snap-current",
    status: "passed",
    command: "npm test",
    reviewEpoch: 1,
    details: { exitCode: 0 },
  }]);
  approval = ledger.canApprove(session.id, { submissionId: "sub-current", snapshotCommit: "snap-current", reviewEpoch: 2 });
  assert.equal(approval.allowed, false, "evidence from an older review epoch cannot approve the current card");
  ledger.recordEvidence(mission.id, [{
    criterionId: "crit-tests",
    submissionId: "sub-current",
    snapshotCommit: "snap-current",
    reviewEpoch: 2,
    status: "passed",
    command: "npm test",
    details: { exitCode: 0 },
  }]);
  approval = ledger.canApprove(session.id, { submissionId: "sub-current", snapshotCommit: "snap-current", reviewEpoch: 2 });
  assert.equal(approval.allowed, true);

  ledger.addFindings(mission.id, [{
    id: "find-security",
    severity: "high",
    category: "security",
    description: "Permission request is one-way only",
    requiredAction: "Return the WebUI decision to the blocked agent",
  }]);
  approval = ledger.canApprove(session.id, { submissionId: "sub-current", snapshotCommit: "snap-current" });
  assert.equal(approval.allowed, false);
  assert.match(approval.reasons.join("\n"), /find-security/);

  ledger.updateFindingStatus(mission.id, [{ id: "find-security", status: "verified_resolved" }]);
  const packet = ledger.getPacket(session.id);
  assert.equal(ledger.canApprove(session.id, { submissionId: "sub-current", snapshotCommit: "snap-current" }).allowed, true);
  assert.equal(packet.evidence.length, 4);
  assert.equal(packet.findings[0].status, "verified_resolved");

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
    acceptanceCriteria: [{ id: "loop-crit", description: "Feature X works", priority: "required", verificationType: "test" }],
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
    snapshotCommit: "snap_cov",
    reviewCoverage: ["security"],
    uncertainty: [{ area: "performance", level: "not inspected" }],
  });
  const partial = ledger.canApprove(covSession.id, { submissionId: "sub_cov", snapshotCommit: "snap_cov" });
  assert.ok(partial.reasons.some((r) => r.includes("correctness")), "missing coverage lens must block approval");
  assert.ok(!partial.reasons.some((r) => r.includes("security")), "covered lens must not block");
  ledger.recordReviewCoverage(covMission.id, {
    submissionId: "sub_cov",
    snapshotCommit: "snap_cov",
    reviewCoverage: ["correctness"],
  });
  const covered = ledger.canApprove(covSession.id, { submissionId: "sub_cov", snapshotCommit: "snap_cov" });
  assert.ok(!covered.reasons.some((r) => r.includes("Review coverage is incomplete")), "all lenses covered → no coverage reason");

  // P1 #14: both orderings produce identical approval semantics — a later
  // verification report must MERGE prior coverage, not displace it.
  ledger.recordCompletionReport(covMission.id, {
    submissionId: "sub_cov",
    snapshotCommit: "snap_cov",
    status: "passed",
    results: [{ command: "npm test", status: "passed" }],
  });
  const afterVerify = ledger.canApprove(covSession.id, { submissionId: "sub_cov", snapshotCommit: "snap_cov" });
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
    acceptanceCriteria: [{ id: "p-crit", description: "works", priority: "required", verificationType: "test" }],
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
