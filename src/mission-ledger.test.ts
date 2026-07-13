import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createMissionLedger } from "./mission-ledger.js";
import { createWorkSessionManager } from "./work-sessions.js";
import { databasePath, openDatabase } from "./db/client.js";

const root = mkdtempSync(join(tmpdir(), "devdesktop-mission-ledger-test-"));

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
    source: "reviewer_manual_attestation",
    command: "npm test",
    details: { exitCode: 0 },
  }]);
  approval = ledger.canApprove(session.id, { submissionId: "sub-current", snapshotCommit: "snap-current" });
  assert.equal(approval.allowed, false);
  assert.match(approval.reasons.join("\n"), /no current non-agent evidence/);

  ledger.recordEvidence(mission.id, [{
    criterionId: "crit-tests",
    submissionId: "sub-current",
    snapshotCommit: "snap-current",
    status: "passed",
    source: "agent_claim",
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
    source: "reviewer_manual_attestation",
    command: "npm test",
    details: { exitCode: 0 },
  }]);
  approval = ledger.canApprove(session.id, { submissionId: "sub-current", snapshotCommit: "snap-current" });
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
  assert.equal(packet.evidence.length, 3);
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

  // A round with no new blocking findings has converged — no extension.
  const converged = ledger.evaluateLoopExtension(loopSession.id, { newFindingIds: [] });
  assert.equal(converged.extend, false);
  assert.match(converged.reason, /converged/);

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
