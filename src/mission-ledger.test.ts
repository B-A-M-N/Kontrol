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
    objective: "Fix the bridge",
    acceptanceCriteria: [
      { id: "crit-tests-renamed", description: "Regression tests pass", priority: "required", verificationType: "test", verificationCommand: "npm test" },
      { id: "crit-docs", description: "Docs are coherent", priority: "preferred", verificationType: "manual_review" },
    ],
  }), /Mission contract conflict/, "changing a criterion id changes the contract identity");

  // P1-02: integration_verified without finalVerification is now a contract
  // impossibility rejected before durable side effects.
  assert.throws(() => ledger.createMission({
    workSessionId: session.id,
    workspaceSessionId: "workspace-1",
    objective: "Fix the bridge",
    acceptanceCriteria: [
      { id: "crit-tests", description: "Regression tests pass", priority: "required", verificationType: "test", verificationCommand: "npm test" },
      { id: "crit-docs", description: "Docs are coherent", priority: "preferred", verificationType: "manual_review" },
    ],
    outcomeEvidence: "integration_verified",
  }), /integration_verified requires at least one finalVerification/, "integration_verified without finalVerification is rejected");

  // changing outcomeEvidence with valid finalVerification changes the contract identity
  assert.throws(() => ledger.createMission({
    workSessionId: session.id,
    workspaceSessionId: "workspace-1",
    objective: "Fix the bridge",
    acceptanceCriteria: [
      { id: "crit-tests", description: "Regression tests pass", priority: "required", verificationType: "test", verificationCommand: "npm test" },
      { id: "crit-docs", description: "Docs are coherent", priority: "preferred", verificationType: "manual_review" },
    ],
    outcomeEvidence: "integration_verified",
    finalVerification: ["npm run test:integration"],
  }), /Mission contract conflict/, "changing outcomeEvidence changes the contract identity");

  // Fingerprint definition version participates in identity: all fingerprints
  // are versioned so canonical-payload changes are explicit, not silent.
  const { MISSION_CONTRACT_FINGERPRINT_VERSION } = await import("./mission/contract-authority.js");
  assert.equal(typeof MISSION_CONTRACT_FINGERPRINT_VERSION, "number");
  assert.equal(MISSION_CONTRACT_FINGERPRINT_VERSION > 1, true, "current canonical definition is versioned above the pre-ID/v1 payload");

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
  assert.throws(() => ledger.resolveFinding(mission.id, "find-security", currentContext), /not effectively resolved/);
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

  // --- F01: a later failure supersedes an earlier passing result -----------
  const f01Session = workSessions.create({
    workspaceSessionId: "workspace-1",
    submittedBy: "webui",
    title: "F01 superseding evidence",
    completionPolicy: "webui_approval_required",
  });
  const f01Mission = ledger.createMission({
    workSessionId: f01Session.id,
    workspaceSessionId: "workspace-1",
    objective: "Superseding verification must block approval",
    acceptanceCriteria: [{ id: "f01-crit", description: "behavior passes", priority: "required", verificationType: "test", verificationCommand: "npm test" }],
  });
  const f01Submission = workSessions.submitForReview({
    workSessionId: f01Session.id,
    diff: "F01",
    snapshotKind: "git",
    snapshotRef: "f01-snap",
    snapshotCommit: "f01-snap",
  });
  const f01Context = { submissionId: f01Submission.id, snapshotKind: "git" as const, snapshotRef: "f01-snap", snapshotCommit: "f01-snap", reviewEpoch: f01Submission.reviewEpoch };
  ledger.recordVerifierEvidence(f01Mission.id, [{ criterionId: "f01-crit", ...f01Context, command: "npm test", status: "passed", details: { exitCode: 0 } }]);
  assert.equal(ledger.canApprove(f01Session.id, f01Context).allowed, true);
  ledger.recordVerifierEvidence(f01Mission.id, [{ criterionId: "f01-crit", ...f01Context, command: "npm test", status: "failed", details: { exitCode: 1 } }]);
  const f01Blocked = ledger.canApprove(f01Session.id, f01Context);
  assert.equal(f01Blocked.allowed, false, "a later failed attempt must supersede an earlier pass");
  assert.match(f01Blocked.reasons.join("\n"), /f01-crit/);
  ledger.recordVerifierEvidence(f01Mission.id, [{ criterionId: "f01-crit", ...f01Context, command: "npm test", status: "passed", details: { exitCode: 0 } }]);
  assert.equal(ledger.canApprove(f01Session.id, f01Context).allowed, true, "a new passing attempt after a failure restores verification");

  // --- F02: verified_resolved findings require renewal on a new submission --
  const f02Session = workSessions.create({
    workspaceSessionId: "workspace-1",
    submittedBy: "webui",
    title: "F02 stale resolution",
    completionPolicy: "webui_approval_required",
  });
  const f02Mission = ledger.createMission({
    workSessionId: f02Session.id,
    workspaceSessionId: "workspace-1",
    objective: "Resolved findings must stay resolved only for their submission",
    acceptanceCriteria: [{ id: "f02-crit", description: "works", priority: "required", verificationType: "test", verificationCommand: "npm test" }],
  });
  const [f02Finding] = ledger.addFindings(f02Mission.id, [{ id: "f02-finding", description: "defect", requiredAction: "fix", requiredVerification: ["npm test"], severity: "blocker", scope: "in_scope" }]);
  const f02aSubmission = workSessions.submitForReview({ workSessionId: f02Session.id, diff: "A", snapshotKind: "git", snapshotRef: "f02-a", snapshotCommit: "f02-a" });
  const f02aContext = { submissionId: f02aSubmission.id, snapshotKind: "git" as const, snapshotRef: "f02-a", snapshotCommit: "f02-a", reviewEpoch: f02aSubmission.reviewEpoch };
  ledger.recordVerifierEvidence(f02Mission.id, [
    { criterionId: "f02-crit", ...f02aContext, command: "npm test", status: "passed", details: { exitCode: 0 } },
    { findingId: "f02-finding", ...f02aContext, command: "npm test", status: "passed", details: { exitCode: 0 } },
  ]);
  ledger.updateFindingStatus(f02Mission.id, [{ id: "f02-finding", status: "claimed_resolved" }]);
  ledger.resolveFinding(f02Mission.id, "f02-finding", f02aContext);
  assert.equal(ledger.canApprove(f02Session.id, f02aContext).allowed, true);

  workSessions.updateStatus(f02Session.id, "changes_requested");
  const f02bSubmission = workSessions.submitForReview({ workSessionId: f02Session.id, diff: "B", snapshotKind: "git", snapshotRef: "f02-b", snapshotCommit: "f02-b" });
  const f02bContext = { submissionId: f02bSubmission.id, snapshotKind: "git" as const, snapshotRef: "f02-b", snapshotCommit: "f02-b", reviewEpoch: f02bSubmission.reviewEpoch };
  ledger.recordVerifierEvidence(f02Mission.id, [{ criterionId: "f02-crit", ...f02bContext, command: "npm test", status: "passed", details: { exitCode: 0 } }]);
  const f02Stale = ledger.canApprove(f02Session.id, f02bContext);
  assert.equal(f02Stale.allowed, false, "a resolution verified for submission A cannot approve submission B");
  assert.match(f02Stale.reasons.join("\n"), /f02-finding/);
  ledger.recordVerifierEvidence(f02Mission.id, [{ findingId: "f02-finding", ...f02bContext, command: "npm test", status: "passed", details: { exitCode: 0 } }]);
  ledger.updateFindingStatus(f02Mission.id, [{ id: "f02-finding", status: "claimed_resolved" }]);
  ledger.resolveFinding(f02Mission.id, "f02-finding", f02bContext);
  assert.equal(ledger.canApprove(f02Session.id, f02bContext).allowed, true, "renewed resolution evidence for submission B restores approval");

  // --- F08: stronger outcome evidence requires a passing final report ------
  const f08Session = workSessions.create({
    workspaceSessionId: "workspace-1",
    submittedBy: "webui",
    title: "F08 outcome evidence",
    completionPolicy: "webui_approval_required",
  });
  const f08Mission = ledger.createMission({
    workSessionId: f08Session.id,
    workspaceSessionId: "workspace-1",
    objective: "Require integration-level independent evidence",
    acceptanceCriteria: [{ id: "f08-crit", description: "works", priority: "required", verificationType: "manual_review" }],
    outcomeEvidence: "integration_verified",
    finalVerification: ["echo integration-check"],
  });
  const f08Submission = workSessions.submitForReview({ workSessionId: f08Session.id, diff: "A", snapshotKind: "git", snapshotRef: "f08-a", snapshotCommit: "f08-a" });
  const f08Context = { submissionId: f08Submission.id, snapshotKind: "git" as const, snapshotRef: "f08-a", snapshotCommit: "f08-a", reviewEpoch: f08Submission.reviewEpoch };
  ledger.recordReviewerEvidence(f08Mission.id, [{ criterionId: "f08-crit", ...f08Context, status: "passed", details: { reviewerIndependentlyConfirmed: true } }]);
  const f08Blocked = ledger.canApprove(f08Session.id, f08Context);
  assert.equal(f08Blocked.allowed, false, "integration_verified outcome evidence requires a passing final report");
  assert.match(f08Blocked.reasons.join("\n"), /integration_verified/);
  // An empty passing report cannot certify integration evidence.
  ledger.recordCompletionReport(f08Mission.id, { submissionId: f08Submission.id, snapshotKind: "git", snapshotRef: "f08-a", status: "passed", results: [] });
  const f08Empty = ledger.canApprove(f08Session.id, f08Context);
  assert.equal(f08Empty.allowed, false, "an empty passing report cannot certify integration evidence");
  ledger.recordCompletionReport(f08Mission.id, { submissionId: f08Submission.id, snapshotKind: "git", snapshotRef: "f08-a", status: "passed", results: [{ command: "npm test", status: "passed" }] });
  assert.equal(ledger.canApprove(f08Session.id, f08Context).allowed, true, "a passing final report with real results satisfies integration evidence");
  const f08Receipt = ledger.getResultReceipt(f08Session.id, f08Context);
  assert.equal(f08Receipt?.currentSubmissionId, f08Submission.id);
  assert.equal(f08Receipt?.completionReport?.snapshotRef, "f08-a");
  assert.equal(f08Receipt?.approval.allowed, true);
  assert.ok(f08Receipt?.evidence.some((item) => item.criterionId === "f08-crit"), "result receipt includes bounded evidence IDs for the exact submission");
  workSessions.updateStatus(f08Session.id, "changes_requested");
  const f08NextSubmission = workSessions.submitForReview({ workSessionId: f08Session.id, diff: "B", snapshotKind: "git", snapshotRef: "f08-b", snapshotCommit: "f08-b" });
  const f08NextReceipt = ledger.getResultReceipt(f08Session.id, {
    submissionId: f08NextSubmission.id,
    snapshotKind: "git",
    snapshotRef: "f08-b",
    snapshotCommit: "f08-b",
    reviewEpoch: f08NextSubmission.reviewEpoch,
  });
  assert.equal(f08NextReceipt?.completionReport, undefined, "a report for an earlier snapshot is never presented as the current result");
  assert.equal(f08NextReceipt?.evidence.length, 0);
  // P2-03: outcome_verified is now supported with an external-observation
  // receipt, but requires an explicit expected-behavior contract.
  assert.throws(() => ledger.createMission({
    workSessionId: f08Session.id,
    workspaceSessionId: "workspace-1",
    objective: "outcome level",
    acceptanceCriteria: [{ id: "x", description: "x", priority: "required", verificationType: "manual_review" }],
    outcomeEvidence: "outcome_verified",
  }), /outcomeExpectedBehavior/, "outcome_verified requires an expected-behavior contract");

  // operationally_stable remains locked.
  assert.throws(() => ledger.createMission({
    workSessionId: f08Session.id,
    workspaceSessionId: "workspace-1",
    objective: "stable level",
    acceptanceCriteria: [{ id: "x", description: "x", priority: "required", verificationType: "manual_review" }],
    outcomeEvidence: "operationally_stable",
    outcomeExpectedBehavior: "still works after 24h",
  }), /operationally_stable is not yet supported/, "operationally_stable is refused until sustained-operation oracle support exists");

  // --- Re-review P0: a later failure on the same submission supersedes a
  // verified resolution. The finding must block approval until fresh passing
  // evidence is recorded.
  const rrSession = workSessions.create({
    workspaceSessionId: "workspace-1",
    submittedBy: "webui",
    title: "Re-review superseded resolution",
    completionPolicy: "webui_approval_required",
  });
  const rrMission = ledger.createMission({
    workSessionId: rrSession.id,
    workspaceSessionId: "workspace-1",
    objective: "Resolution must follow the latest evidence",
    acceptanceCriteria: [{ id: "rr-crit", description: "works", priority: "required", verificationType: "test", verificationCommand: "npm test" }],
  });
  const [rrFinding] = ledger.addFindings(rrMission.id, [{ id: "rr-finding", description: "defect", requiredAction: "fix", requiredVerification: ["npm test"], severity: "blocker", scope: "in_scope" }]);
  const rrSubmission = workSessions.submitForReview({ workSessionId: rrSession.id, diff: "RR", snapshotKind: "git", snapshotRef: "rr-snap", snapshotCommit: "rr-snap" });
  const rrContext = { submissionId: rrSubmission.id, snapshotKind: "git" as const, snapshotRef: "rr-snap", snapshotCommit: "rr-snap", reviewEpoch: rrSubmission.reviewEpoch };
  ledger.recordVerifierEvidence(rrMission.id, [
    { criterionId: "rr-crit", ...rrContext, command: "npm test", status: "passed", details: { exitCode: 0 } },
    { findingId: "rr-finding", ...rrContext, command: "npm test", status: "passed", details: { exitCode: 0 } },
  ]);
  ledger.updateFindingStatus(rrMission.id, [{ id: "rr-finding", status: "claimed_resolved" }]);
  ledger.resolveFinding(rrMission.id, "rr-finding", rrContext);
  assert.equal(ledger.canApprove(rrSession.id, rrContext).allowed, true);

  // Later failed attempt on the same submission supersedes the resolution.
  ledger.recordVerifierEvidence(rrMission.id, [{ findingId: "rr-finding", ...rrContext, command: "npm test", status: "failed", details: { exitCode: 1 } }]);
  const rrSuperseded = ledger.canApprove(rrSession.id, rrContext);
  assert.equal(rrSuperseded.allowed, false, "a later failed verification must supersede a prior verified resolution");
  assert.match(rrSuperseded.reasons.join("\n"), /rr-finding/);

  // An inconclusive attempt also blocks.
  ledger.recordVerifierEvidence(rrMission.id, [{ findingId: "rr-finding", ...rrContext, command: "npm test", status: "inconclusive", details: { reason: "interrupted" } }]);
  const rrInconclusive = ledger.canApprove(rrSession.id, rrContext);
  assert.equal(rrInconclusive.allowed, false, "an inconclusive latest attempt blocks the resolution");

  // A new passing attempt restores the resolution.
  ledger.updateFindingStatus(rrMission.id, [{ id: "rr-finding", status: "claimed_resolved" }]);
  ledger.recordVerifierEvidence(rrMission.id, [{ findingId: "rr-finding", ...rrContext, command: "npm test", status: "passed", details: { exitCode: 0 } }]);
  ledger.resolveFinding(rrMission.id, "rr-finding", rrContext);
  assert.equal(ledger.canApprove(rrSession.id, rrContext).allowed, true, "a fresh passing attempt restores the resolution");

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

  // missionApproved is derived from the authoritative canApprove() gate. The
  // loop test mission has an unverified criterion, so the gate denies approval
  // and the round escalates instead of converging.
  const unresolved = ledger.evaluateLoopExtension(loopSession.id, { newFindingIds: [] });
  assert.equal(unresolved.extend, false);
  assert.match(unresolved.reason, /unresolved mission requirements/);
  // A round with demonstrated progress and unresolved actionable work remains
  // eligible for bounded continuation instead of premature escalation.
  const progressSession2 = workSessions.create({
    workspaceSessionId: "workspace-1",
    submittedBy: "webui",
    title: "progressing rounds",
    completionPolicy: "webui_approval_required",
  });
  ledger.createMission({
    workSessionId: progressSession2.id,
    workspaceSessionId: "workspace-1",
    objective: "progressing rounds",
    acceptanceCriteria: [{ id: "p2-crit", description: "works", priority: "required", verificationType: "test", verificationCommand: "npm test" }],
    maxCorrectionRounds: 2,
  });
  const progressing = ledger.evaluateLoopExtension(progressSession2.id, {
    newFindingIds: [],
    resolvedFindingIds: ["some-resolved"],
  });
  assert.equal(progressing.extend, true, "demonstrated progress earns bounded continuation");
  assert.equal(progressing.round, 1);
  // Without progress the same unresolved state escalates.
  const stagnant = ledger.evaluateLoopExtension(progressSession2.id, { newFindingIds: [], resolvedFindingIds: [] });
  assert.equal(stagnant.extend, false);
  assert.match(stagnant.reason, /no demonstrated progress/);

  // missionApproved is derived from the authoritative gate: a caller asserting
  // convergence cannot bypass a denied approval predicate.
  const callerConvergence = ledger.evaluateLoopExtension(loopSession.id, { newFindingIds: [], missionApproved: true } as never);
  assert.equal(callerConvergence.extend, false, "a caller-supplied approval claim cannot converge a denied mission");
  assert.match(callerConvergence.reason, /unresolved mission requirements/);

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
  assert.throws(() => restartLedger.resolveFinding(restartMission.id, restartFinding.id, correctedContext), /missing current verification/);
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

  // P0-02: mixed criterion/finding evidence must use mission-wide ordering.
  {
    const mixedSession = workSessions.create({
      workspaceSessionId: "workspace-1", submittedBy: "webui", title: "P0-02 mixed ordering",
      completionPolicy: "webui_approval_required",
    });
    const mixedMission = ledger.createMission({
      workSessionId: mixedSession.id, workspaceSessionId: "workspace-1", objective: "Mixed evidence ordering",
      acceptanceCriteria: [{ id: "mc-crit", description: "works", priority: "required", verificationType: "manual_review" }],
    });
    const mixedSubmission = workSessions.submitForReview({ workSessionId: mixedSession.id, diff: "A", snapshotKind: "git", snapshotRef: "mixed-a", snapshotCommit: "mixed-a" });
    const mixedContext = { submissionId: mixedSubmission.id, snapshotKind: "git" as const, snapshotRef: "mixed-a", snapshotCommit: "mixed-a", reviewEpoch: mixedSubmission.reviewEpoch };
    // Add a blocking finding that must be resolved.
    const mixedFindings = ledger.addFindings(mixedMission.id, [
      { description: "mixed ordering finding", requiredAction: "fix", severity: "blocker", scope: "in_scope", requiredVerification: ["check-finding"] },
    ]);
    const findingId = mixedFindings[0]!.id;
    ledger.updateFindingStatus(mixedMission.id, [{ id: findingId, status: "claimed_resolved" }]);
    // 1) Insert finding-only evidence at attempt 1 (passes).
    ledger.recordVerifierEvidence(mixedMission.id, [{ findingId, command: "check-finding", ...mixedContext, status: "passed" as const, details: {} }]);
    // 2) Insert a second finding-only passing evidence (attempt 2).
    ledger.recordVerifierEvidence(mixedMission.id, [{ findingId, command: "check-finding", ...mixedContext, status: "passed" as const, details: {} }]);
    // 3) Insert a dual-associated (criterion + finding) evidence that also passes.
    //    Under P0-02 this must receive attempt=3 (not attempt=1) because the
    //    mission-wide counter is authoritative, so the later observation wins.
    //    The criterion is manual_review, so the criterion side needs a reviewer
    //    attestation; the finding side carries the verifier evidence.
    ledger.recordReviewerEvidence(mixedMission.id, [{ criterionId: "mc-crit", ...mixedContext, status: "passed" as const, details: {} }]);
    ledger.recordVerifierEvidence(mixedMission.id, [{ findingId, command: "check-finding", ...mixedContext, status: "passed" as const, details: {} }]);
    const resolution = ledger.resolveFinding(mixedMission.id, findingId, mixedContext);
    assert.ok(resolution.evidenceIds.length >= 1, "dual-associated evidence resolves");
    // The resolution receipt must contain only current, qualifying evidence IDs.
    const packet = ledger.getPacket(mixedSession.id, mixedContext);
    const finding = packet.findings.find((f) => f.id === findingId)!;
    const allResolutionIds = finding.resolutionEvidenceIds ?? [];
    for (const evidenceId of allResolutionIds) {
      const record = packet.evidence.find((entry) => entry.id === evidenceId);
      assert.ok(record, "resolution evidence ID exists");
      assert.equal(record.submissionId, mixedSubmission.id, "resolution evidence is bound to the current submission");
    }
  }

  // P0-02: evidence batch atomicity.
  {
    const atomicSession = workSessions.create({
      workspaceSessionId: "workspace-1", submittedBy: "webui", title: "Evidence batch atomicity",
      completionPolicy: "webui_approval_required",
    });
    const atomicMission = ledger.createMission({
      workSessionId: atomicSession.id, workspaceSessionId: "workspace-1", objective: "Atomic evidence batch",
      acceptanceCriteria: [{ id: "atom-crit", description: "works", priority: "required", verificationType: "test", verificationCommand: "npm test" }],
    });
    const atomicSubmission = workSessions.submitForReview({ workSessionId: atomicSession.id, diff: "A", snapshotKind: "git", snapshotRef: "atomic-a", snapshotCommit: "atomic-a" });
    const atomicContext = { submissionId: atomicSubmission.id, snapshotKind: "git" as const, snapshotRef: "atomic-a", snapshotCommit: "atomic-a", reviewEpoch: atomicSubmission.reviewEpoch };
    const beforeCount = ledger.getPacket(atomicSession.id, atomicContext).evidence.length;
    // The second entry has an invalid criterion ID; the entire batch must reject.
    assert.throws(() => ledger.recordVerifierEvidence(atomicMission.id, [
      { criterionId: "atom-crit", ...atomicContext, status: "passed" as const },
      { criterionId: "atom-invalid", ...atomicContext, status: "passed" as const },
    ]), /does not belong to mission/);
    const afterCount = ledger.getPacket(atomicSession.id, atomicContext).evidence.length;
    assert.equal(afterCount, beforeCount, "invalid later entry leaves no partial evidence batch");
  }

  // P0-03: canApprove without submission returns a valid denial, not a crash.
  {
    const noSubmitSession = workSessions.create({
      workspaceSessionId: "workspace-1", submittedBy: "webui", title: "Approval without submission",
      completionPolicy: "webui_approval_required",
    });
    ledger.createMission({
      workSessionId: noSubmitSession.id, workspaceSessionId: "workspace-1", objective: "No submission approval",
      acceptanceCriteria: [{ id: "ns-crit", description: "works", priority: "required", verificationType: "manual_review" }],
    });
    assert.doesNotThrow(() => ledger.canApprove(noSubmitSession.id), "canApprove without submission does not throw");
    assert.doesNotThrow(() => ledger.getPacket(noSubmitSession.id), "getPacket without submission does not throw");
    const approvalResult = ledger.canApprove(noSubmitSession.id);
    assert.equal(approvalResult.allowed, false, "canApprove without submission is denied");
    assert.ok(approvalResult.reasons.length > 0, "denial has a reason");
  }

  // --- P2-03: outcome_verified requires an external outcome observation ----
  {
    const ovs = workSessions.create({
      workspaceSessionId: "workspace-1", submittedBy: "webui", title: "Outcome verified",
      completionPolicy: "webui_approval_required",
    });
    const ovm = ledger.createMission({
      workSessionId: ovs.id, workspaceSessionId: "workspace-1", objective: "Outcome-verified mission",
      acceptanceCriteria: [{ id: "ov-crit", description: "works", priority: "required", verificationType: "manual_review" }],
      outcomeEvidence: "outcome_verified",
      outcomeExpectedBehavior: "User sees the fix in the UI after reload",
    });
    const ovSub = workSessions.submitForReview({ workSessionId: ovs.id, diff: "A", snapshotKind: "git", snapshotRef: "ov-a", snapshotCommit: "ov-a" });
    const ovCtx = { submissionId: ovSub.id, snapshotKind: "git" as const, snapshotRef: "ov-a", snapshotCommit: "ov-a", reviewEpoch: ovSub.reviewEpoch };
    ledger.recordReviewerEvidence(ovm.id, [{ criterionId: "ov-crit", ...ovCtx, status: "passed" as const }]);
    // No observations yet → denied.
    const noObs = ledger.canApprove(ovs.id, ovCtx);
    assert.equal(noObs.allowed, false, "outcome_verified without observations is denied");
    assert.match(noObs.reasons.join("\n"), /no outcome observations exist/, "denial cites missing outcome observation");
    // A rejection blocks approval even if an earlier confirmation exists.
    ledger.recordOutcomeObservation(ovm.id, { ...ovCtx, observerIdentity: "human:alice", expectedBehavior: "fix visible", actualBehavior: "not visible", status: "rejected" });
    const rejected = ledger.canApprove(ovs.id, ovCtx);
    assert.equal(rejected.allowed, false, "rejected observation blocks approval");
    assert.match(rejected.reasons.join("\n"), /rejected the expected behavior/, "denial cites the rejection");
    // A rejection is authoritative: a later confirmation does NOT silently
    // undo it. The reviewer must supersede with a new submission or an
    // explicit second-round review, not just add a confirm record.
    ledger.recordOutcomeObservation(ovm.id, { ...ovCtx, observerIdentity: "human:bob", expectedBehavior: "fix visible", actualBehavior: "fix visible after reload", status: "confirmed" });
    const confirmedAfterRejection = ledger.canApprove(ovs.id, ovCtx);
    assert.equal(confirmedAfterRejection.allowed, false, "a rejection is authoritative even after a later confirmation");
  }

  workSessions.close();
  ledger.close();
  db.close();
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
