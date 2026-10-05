import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  missionAcceptanceCriteria,
  missionContracts,
  missionCompletionReports,
  missionEvidence,
  missionReviewFindings,
  missionWorkOrders,
  workSessionSubmissions,
  type MissionAcceptanceCriterionRow,
  type MissionContractRow,
  type MissionEvidenceRow,
  type MissionReviewFindingRow,
  type MissionWorkOrderRow,
  type MissionCompletionReportRow,
} from "./db/schema.js";
import { normalizeWorkspaceSnapshotIdentity, type WorkspaceSnapshotKind } from "./review-checkpoints.js";
import { fingerprintMissionContract, fingerprintStoredMissionContract, validateMissionCriterionContract } from "./mission/contract-authority.js";
import { evaluateFindingResolutionEvidence, findCurrentCriterionEvidence, isEvidenceSourceAllowed } from "./mission/evidence-authority.js";
import { assertFindingStatusTransition, fingerprintFinding, mergeFindingEvidence } from "./mission/finding-authority.js";
import { evaluateCorrectionPolicy } from "./mission/correction-policy.js";
import { evaluateEffectiveCriteria, evaluateMissionOutcome } from "./mission/outcome-evaluator.js";

export type CriterionStatus = "unverified" | "partially_verified" | "verified" | "failed";
export type FindingStatus = "open" | "claimed_resolved" | "verified_resolved" | "waived";
export type FindingDisposition = "blocking" | "required_followup" | "advisory" | "future_improvement";
/**
 * Scope classification for a review finding — the core of the anti-runaway
 * guard. Only `in_scope` and `regression` findings may block approval and extend
 * the correction loop:
 *   - in_scope:     the finding is about the mission's stated objective /
 *                   acceptance criteria (the work the agent was asked to do).
 *   - regression:   the agent's own edits broke something (introducedInSubmissionId
 *                   points at a submission the agent produced).
 *   - out_of_scope: a pre-existing issue unrelated to this mission. Recorded for
 *                   visibility, but it does NOT gate approval — otherwise the AI
 *                   could perpetually "find one more thing" and never converge.
 */
export type FindingScope = "in_scope" | "regression" | "out_of_scope";
export type MissionEvidenceSource = "server_test_runner" | "runtime_probe" | "reviewer_manual_attestation" | "agent_claim";

export interface RuntimeProbeInput {
  url: string;
  method?: "GET" | "HEAD";
  expectedStatus?: number;
  bodyIncludes?: string;
}

export interface MissionCriterionInput {
  id?: string;
  description: string;
  priority?: "required" | "preferred";
  verificationType?: "test" | "code_inspection" | "runtime_behavior" | "security_review" | "manual_review";
  verificationCommand?: string;
  runtimeProbe?: RuntimeProbeInput;
  affectedAreas?: string[];
  dependsOnCriterionIds?: string[];
  verificationGroup?: string;
  verificationScope?: "focused" | "affected" | "full";
  finalOnly?: boolean;
  mutatesWorkspace?: boolean;
  commandVersion?: string;
}

export interface ReviewFindingInput {
  id?: string;
  introducedInSubmissionId?: string;
  scope?: FindingScope;
  severity?: "blocker" | "high" | "medium" | "low";
  category?: "correctness" | "architecture" | "security" | "testing" | "scope" | "maintainability" | "user_intent";
  disposition?: FindingDisposition;
  description: string;
  evidence?: unknown[];
  requiredAction: string;
  requiredVerification?: string[];
  status?: Exclude<FindingStatus, "verified_resolved">;
}

export interface WorkOrderInput {
  objectiveForThisTurn: string;
  requiredFindingIds?: string[];
  acceptanceCriterionIds?: string[];
  requiredActions?: string[];
  prohibitedActions?: string[];
  requiredVerification?: unknown[];
  expectedDeliverables?: string[];
  contextReferences?: string[];
  preferredAgent?: string;
}

export interface MissionContractInput {
  workSessionId: string;
  workspaceSessionId: string;
  objective: string;
  desiredOutcome?: string;
  constraints?: unknown[];
  nonGoals?: string[];
  acceptanceCriteria?: MissionCriterionInput[];
  userLockedFields?: string[];
  supervisorInstructions?: string;
  baselineKind?: WorkspaceSnapshotKind;
  baselineRef?: string;
  /** @deprecated Legacy Git projection. */
  baselineCommit?: string;
  /** Backstop ceiling on auto-extended correction rounds. Default 5. */
  maxCorrectionRounds?: number;
  /** Commands that must pass together against the exact final submission. */
  finalVerification?: string[];
  /** Review lenses that must be explicitly covered before completion. */
  reviewCoverage?: string[];
}

export interface ApprovalPredicate {
  allowed: boolean;
  reasons: string[];
}

export interface CurrentApprovalContext {
  submissionId?: string;
  snapshotKind?: WorkspaceSnapshotKind;
  snapshotRef?: string;
  snapshotCommit?: string;
  /** Review generation the evidence and approval decision belong to. */
  reviewEpoch?: number;
}

export interface MissionEvidenceInput {
  criterionId?: string;
  findingId?: string;
  submissionId?: string;
  reviewEpoch?: number;
  snapshotKind?: WorkspaceSnapshotKind;
  snapshotRef?: string;
  snapshotCommit?: string;
  leaseNonce?: string;
  command?: string;
  status: "passed" | "failed" | "inconclusive";
  details?: unknown;
  actorPrincipal?: string;
}

export interface MissionReviewPacket {
  mission?: ReturnType<typeof rowToMission>;
  criteria: Array<ReturnType<typeof rowToCriterion>>;
  findings: Array<ReturnType<typeof rowToFinding>>;
  workOrders: Array<ReturnType<typeof rowToWorkOrder>>;
  evidence: Array<ReturnType<typeof rowToEvidence>>;
  completionReports: Array<ReturnType<typeof rowToCompletionReport>>;
  approval: ApprovalPredicate;
  criterionStates: EffectiveCriterionState[];
}

export interface EffectiveCriterionState {
  criterionId: string;
  status: CriterionStatus;
  evidenceId?: string;
  staleReason?: string;
  dependenciesSatisfied: boolean;
}

export interface MissionLedger {
  createMission(input: MissionContractInput): ReturnType<typeof rowToMission>;
  getMissionByWorkSession(workSessionId: string): ReturnType<typeof rowToMission> | undefined;
  addFindings(missionId: string, findings: ReviewFindingInput[]): Array<ReturnType<typeof rowToFinding>>;
  updateCriterionStatus(missionId: string, updates: Array<{ id: string; status: Exclude<CriterionStatus, "verified"> }>): void;
  updateFindingStatus(missionId: string, updates: Array<{ id: string; status: Exclude<FindingStatus, "verified_resolved">; waiverReason?: string; disposition?: FindingDisposition }>): void;
  resolveFinding(missionId: string, findingId: string, context: CurrentApprovalContext): { evidenceIds: string[] };
  createWorkOrder(missionId: string, workSessionId: string, input: WorkOrderInput): ReturnType<typeof rowToWorkOrder>;
  /** Legacy reviewer path: source is assigned by the server, never by input. */
  recordEvidence(missionId: string, entries: MissionEvidenceInput[]): void;
  recordReviewerEvidence(missionId: string, entries: MissionEvidenceInput[]): void;
  recordVerifierEvidence(missionId: string, entries: MissionEvidenceInput[]): void;
  recordRuntimeProbeEvidence(missionId: string, entries: MissionEvidenceInput[]): void;
  recordAgentEvidence(missionId: string, entries: MissionEvidenceInput[]): void;
  recordCompletionReport(missionId: string, input: { submissionId: string; snapshotKind?: WorkspaceSnapshotKind; snapshotRef?: string; snapshotCommit?: string; status: "passed" | "failed"; results: unknown; reviewCoverage?: string[]; uncertainty?: unknown[] }): void;
  recordReviewCoverage(missionId: string, input: { submissionId: string; snapshotKind?: WorkspaceSnapshotKind; snapshotRef?: string; snapshotCommit?: string; reviewCoverage?: string[]; uncertainty?: unknown[] }): void;
  getCompletionReportHash(workSessionId: string, context: CurrentApprovalContext): string | undefined;
  getPacket(workSessionId: string, approvalContext?: CurrentApprovalContext): MissionReviewPacket;
  canApprove(workSessionId: string, context?: CurrentApprovalContext): ApprovalPredicate;
  evaluateCriteria(workSessionId: string, context?: CurrentApprovalContext): EffectiveCriterionState[];
  /**
   * Decide whether a review round that surfaced new findings may EXTEND the
   * correction loop. Convergence-based, not a hard count: an extension is
   * granted while the round is making progress (it resolved prior findings
   * and/or raised genuinely new, distinct, blocking in-scope findings). The
   * round counter is only a backstop — it bites when rounds stop converging.
   */
  evaluateLoopExtension(workSessionId: string, round: NewRoundInput): LoopExtensionDecision;
  /**
   * Point the active work order at a different agent. Used by session handoff so
   * the mission's preferredAgent (which the continuation dispatcher honors) stays
   * consistent with the reviewer's reassignment. No-op if the session has no
   * mission or no active work order. Returns the number of work orders updated.
   */
  setWorkOrderPreferredAgent(workSessionId: string, preferredAgent: string): number;
  close(): void;
}

export interface NewRoundInput {
  /** Findings raised in THIS review round (already persisted or about to be). */
  newFindingIds: string[];
  /** Findings resolved (verified_resolved/waived) since the last round. */
  resolvedFindingIds?: string[];
  /** Optional deterministic progress vector from the verifier/supervisor. */
  progress?: {
    blockingFindingCount?: number;
    failedCriterionCount?: number;
    passedCriterionCount?: number;
    failingVerificationCount?: number;
    unresolvedRequiredActions?: number;
    madeProgress?: boolean;
  };
}

export interface LoopExtensionDecision {
  extend: boolean;
  round: number;
  maxRounds: number;
  reason: string;
  /** True when the ceiling forced a stop despite apparent progress. */
  ceilingHit: boolean;
}

/** Persistence/query facade; mission decisions are delegated to src/mission authorities. */
export function createMissionLedger(stateDirOrHandle: string | DatabaseHandle): MissionLedger {
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;

  function createMission(input: MissionContractInput) {
    const now = new Date().toISOString();
    const baselineIdentity = normalizeWorkspaceSnapshotIdentity({
      snapshotKind: input.baselineKind,
      snapshotRef: input.baselineRef,
      snapshotCommit: input.baselineCommit,
    });
    const normalizedInput: MissionContractInput = {
      ...input,
      baselineKind: baselineIdentity?.kind,
      baselineRef: baselineIdentity?.ref,
      baselineCommit: baselineIdentity?.ref,
    };
    const criteria = (input.acceptanceCriteria ?? []).map((criterion) => ({
      ...criterion,
      verificationType: criterion.verificationType ?? (criterion.verificationCommand ? "test" : "manual_review"),
    }));
    const requiredCriteria = criteria.filter((c) => (c.priority ?? "required") === "required");
    if (requiredCriteria.length === 0) {
      throw new Error("Mission requires at least one required acceptance criterion.");
    }
    validateMissionCriterionContract(criteria);
    const contractFingerprint = fingerprintMissionContract(normalizedInput, criteria);
    const existingRow = database.db.select().from(missionContracts).where(eq(missionContracts.workSessionId, input.workSessionId)).get();
    if (existingRow) {
      const existing = rowToMission(existingRow);
      const existingFingerprint = existingRow.contractFingerprint ?? fingerprintStoredMissionContract(existing, database.db.select().from(missionAcceptanceCriteria).where(eq(missionAcceptanceCriteria.missionId, existing.id)).orderBy(asc(missionAcceptanceCriteria.createdAt)).all().map(rowToCriterion));
      if (existingFingerprint !== contractFingerprint) {
        throw new Error(`Mission contract conflict for work session ${input.workSessionId}; create a new work session or use an explicit mission revision.`);
      }
      if (!existingRow.contractFingerprint) {
        database.db.update(missionContracts).set({ contractFingerprint, updatedAt: now }).where(eq(missionContracts.id, existing.id)).run();
      }
      return existing;
    }
    const missionId = `mission_${randomUUID()}`;
    database.db.transaction(() => {
      database.db.insert(missionContracts).values({
        id: missionId,
        workSessionId: input.workSessionId,
        workspaceSessionId: input.workspaceSessionId,
        revision: 1,
        contractFingerprint,
        objective: input.objective,
        desiredOutcome: input.desiredOutcome ?? input.objective,
        constraintsJson: JSON.stringify(input.constraints ?? []),
        nonGoalsJson: JSON.stringify(input.nonGoals ?? []),
        userLockedFieldsJson: JSON.stringify(input.userLockedFields ?? ["objective", "desiredOutcome", "constraints", "nonGoals"]),
        supervisorInstructions: input.supervisorInstructions ?? null,
        baselineKind: baselineIdentity?.kind ?? null,
        baselineRef: baselineIdentity?.ref ?? null,
        baselineCommit: baselineIdentity?.ref ?? null,
        correctionRounds: 0,
        maxCorrectionRounds: input.maxCorrectionRounds ?? 5,
        finalVerificationJson: JSON.stringify(input.finalVerification ?? []),
        reviewCoverageJson: JSON.stringify(input.reviewCoverage ?? []),
        createdAt: now,
        updatedAt: now,
      }).run();
      for (const criterion of criteria) {
        database.db.insert(missionAcceptanceCriteria).values({
          id: criterion.id ?? `crit_${randomUUID()}`,
          missionId,
          description: criterion.description,
          priority: criterion.priority ?? "required",
          verificationType: criterion.verificationType ?? "manual_review",
          verificationCommand: criterion.verificationCommand ?? null,
          runtimeProbeJson: criterion.runtimeProbe ? JSON.stringify(criterion.runtimeProbe) : null,
          affectedAreasJson: JSON.stringify(criterion.affectedAreas ?? []),
          dependsOnJson: JSON.stringify(criterion.dependsOnCriterionIds ?? []),
          verificationGroup: criterion.verificationGroup ?? null,
          verificationScope: criterion.verificationScope ?? "full",
          finalOnly: criterion.finalOnly ?? false,
          mutatesWorkspace: criterion.mutatesWorkspace ?? false,
          commandVersion: criterion.commandVersion ?? null,
          status: "unverified",
          createdAt: now,
          updatedAt: now,
        }).run();
      }
    });
    return getMissionByWorkSession(input.workSessionId)!;
  }

  function getMissionByWorkSession(workSessionId: string) {
    const row = database.db.select().from(missionContracts).where(eq(missionContracts.workSessionId, workSessionId)).get();
    return row ? rowToMission(row) : undefined;
  }

  function addFindings(missionId: string, findings: ReviewFindingInput[]) {
    const now = new Date().toISOString();
    const created: MissionReviewFindingRow[] = [];
    database.sqlite.transaction(() => {
      const existingRows = database.db.select().from(missionReviewFindings).where(eq(missionReviewFindings.missionId, missionId)).all();
      for (const finding of findings) {
        if (finding.requiredVerification?.some((command) => !command.trim())) {
          throw new Error("Finding requiredVerification entries must be non-empty commands.");
        }
        const id = finding.id ?? `find_${randomUUID()}`;
        // Default scope: a finding tied to a submission the agent produced is a
        // regression; otherwise callers should classify explicitly. We never
        // default to out_of_scope (that would silently let real issues through).
        const scope: FindingScope = finding.scope ?? (finding.introducedInSubmissionId ? "regression" : "in_scope");
        const severity = finding.severity ?? "medium";
        const disposition: FindingDisposition = finding.disposition ?? (scope === "out_of_scope" || !["blocker", "high"].includes(severity) ? "advisory" : "blocking");
        const fingerprint = fingerprintFinding({
          category: finding.category ?? "correctness",
          scope,
          description: finding.description,
          requiredAction: finding.requiredAction,
          evidence: finding.evidence,
        });
        const equivalent = existingRows.find((row) =>
          !["verified_resolved", "waived"].includes(row.status) &&
          (row.fingerprint === fingerprint || (!row.fingerprint && fingerprintFinding(row) === fingerprint)),
        );
        if (equivalent) {
          const oldEvidence = parseJson<unknown[]>(equivalent.evidenceJson, []);
          const mergedEvidence = mergeFindingEvidence(oldEvidence, finding.evidence ?? []);
          const severityRank = (value: string) => ["low", "medium", "high", "blocker"].indexOf(value);
          const mergedSeverity = severityRank(severity) > severityRank(equivalent.severity) ? severity : equivalent.severity;
          database.db.update(missionReviewFindings).set({
            fingerprint,
            evidenceJson: JSON.stringify(mergedEvidence),
            severity: mergedSeverity,
            updatedAt: now,
          }).where(eq(missionReviewFindings.id, equivalent.id)).run();
          const refreshed = database.db.select().from(missionReviewFindings).where(eq(missionReviewFindings.id, equivalent.id)).get();
          if (refreshed) existingRows[existingRows.indexOf(equivalent)] = refreshed;
          continue;
        }
        database.db.insert(missionReviewFindings).values({
          id,
          missionId,
          introducedInSubmissionId: finding.introducedInSubmissionId ?? null,
          scope,
          severity,
          category: finding.category ?? "correctness",
          disposition,
          fingerprint,
          description: finding.description,
          evidenceJson: JSON.stringify(finding.evidence ?? []),
          requiredAction: finding.requiredAction,
          requiredVerificationJson: JSON.stringify(finding.requiredVerification ?? []),
          status: "open",
          resolutionSubmissionId: null,
          waiverReason: null,
          createdAt: now,
          updatedAt: now,
        }).run();
        const row = database.db.select().from(missionReviewFindings).where(eq(missionReviewFindings.id, id)).get();
        if (row) {
          created.push(row);
          existingRows.push(row);
        }
      }
    })();
    return created.map(rowToFinding);
  }

  function updateCriterionStatus(missionId: string, updates: Array<{ id: string; status: Exclude<CriterionStatus, "verified"> }>): void {
    const now = new Date().toISOString();
    for (const update of updates) {
      database.db.update(missionAcceptanceCriteria)
        .set({ status: update.status, updatedAt: now })
        .where(and(eq(missionAcceptanceCriteria.id, update.id), eq(missionAcceptanceCriteria.missionId, missionId)))
        .run();
    }
    touchMission(missionId);
  }

  function updateFindingStatus(missionId: string, updates: Array<{ id: string; status: Exclude<FindingStatus, "verified_resolved">; waiverReason?: string; disposition?: FindingDisposition }>): void {
    const now = new Date().toISOString();
    for (const update of updates) {
      assertFindingStatusTransition(update as { id: string; status: FindingStatus; waiverReason?: string });
      const existing = database.db.select().from(missionReviewFindings)
        .where(and(eq(missionReviewFindings.id, update.id), eq(missionReviewFindings.missionId, missionId)))
        .get();
      if (!existing) throw new Error(`Finding ${update.id} does not belong to mission ${missionId}.`);
      database.db.update(missionReviewFindings)
        .set({
          status: update.status,
          ...(update.disposition ? { disposition: update.disposition } : {}),
          waiverReason: update.waiverReason ?? null,
          resolutionSubmissionId: null,
          resolutionEvidenceJson: "[]",
          updatedAt: now,
        })
        .where(and(eq(missionReviewFindings.id, update.id), eq(missionReviewFindings.missionId, missionId)))
        .run();
    }
    touchMission(missionId);
  }

  function resolveFinding(missionId: string, findingId: string, context: CurrentApprovalContext): { evidenceIds: string[] } {
    const finding = database.db.select().from(missionReviewFindings)
      .where(and(eq(missionReviewFindings.id, findingId), eq(missionReviewFindings.missionId, missionId)))
      .get();
    if (!finding) throw new Error(`Finding ${findingId} does not belong to mission ${missionId}.`);
    if (finding.status !== "claimed_resolved") throw new Error(`Finding ${findingId} must be claimed_resolved before verification.`);
    const snapshot = normalizeWorkspaceSnapshotIdentity(context);
    const snapshotRef = snapshot?.ref;
    const snapshotKind = snapshot?.kind;
    if (!context.submissionId || !snapshotKind || !snapshotRef || context.reviewEpoch === undefined) {
      throw new Error(`Finding ${findingId} resolution requires submission, snapshot, and review-epoch identity.`);
    }
    const mission = database.db.select().from(missionContracts).where(eq(missionContracts.id, missionId)).get();
    if (!mission) throw new Error(`Mission ${missionId} not found.`);
    const latest = getCurrentApprovalContext(mission.workSessionId);
    const latestRef = normalizeWorkspaceSnapshotIdentity(latest)?.ref;
    if (latest.submissionId !== context.submissionId || latest.snapshotKind !== snapshotKind || latestRef !== snapshotRef || latest.reviewEpoch !== context.reviewEpoch) {
      throw new Error(`Finding ${findingId} resolution context is not the current submitted snapshot.`);
    }

    const requiredCommands = parseJson<string[]>(finding.requiredVerificationJson, []);
    const evidence = database.db.select().from(missionEvidence)
      .where(and(eq(missionEvidence.missionId, missionId), eq(missionEvidence.findingId, findingId), eq(missionEvidence.status, "passed")))
      .orderBy(desc(missionEvidence.createdAt)).all()
      .map(rowToEvidence);
    const { eligible, missingCommands } = evaluateFindingResolutionEvidence(evidence, requiredCommands, {
      submissionId: context.submissionId,
      snapshotKind,
      snapshotRef,
      reviewEpoch: context.reviewEpoch,
    });
    if (missingCommands.length) throw new Error(`Finding ${findingId} is missing current server verification: ${missingCommands.join(", ")}.`);
    if (!eligible.length) throw new Error(`Finding ${findingId} has no independent evidence for the current submitted snapshot.`);
    const evidenceIds = [...new Set(eligible.map((entry) => entry.id))];
    database.db.update(missionReviewFindings).set({
      status: "verified_resolved",
      resolutionSubmissionId: context.submissionId,
      resolutionEvidenceJson: JSON.stringify(evidenceIds),
      waiverReason: null,
      updatedAt: new Date().toISOString(),
    }).where(and(eq(missionReviewFindings.id, findingId), eq(missionReviewFindings.missionId, missionId), eq(missionReviewFindings.status, "claimed_resolved"))).run();
    touchMission(missionId);
    return { evidenceIds };
  }

  function createWorkOrder(missionId: string, workSessionId: string, input: WorkOrderInput) {
    const mission = database.db.select().from(missionContracts).where(eq(missionContracts.id, missionId)).get();
    if (!mission) throw new Error(`Mission not found: ${missionId}`);
    const id = `wo_${randomUUID()}`;
    database.db.update(missionWorkOrders)
      .set({ status: "superseded" })
      .where(and(eq(missionWorkOrders.missionId, missionId), eq(missionWorkOrders.status, "active")))
      .run();
    database.db.insert(missionWorkOrders).values({
      id,
      missionId,
      workSessionId,
      missionRevision: mission.revision,
      objectiveForThisTurn: input.objectiveForThisTurn,
      requiredFindingIdsJson: JSON.stringify(input.requiredFindingIds ?? []),
      acceptanceCriterionIdsJson: JSON.stringify(input.acceptanceCriterionIds ?? []),
      requiredActionsJson: JSON.stringify(input.requiredActions ?? []),
      prohibitedActionsJson: JSON.stringify(input.prohibitedActions ?? []),
      requiredVerificationJson: JSON.stringify(input.requiredVerification ?? []),
      expectedDeliverablesJson: JSON.stringify(input.expectedDeliverables ?? []),
      contextReferencesJson: JSON.stringify(input.contextReferences ?? []),
      preferredAgent: input.preferredAgent ?? null,
      status: "active",
      createdAt: new Date().toISOString(),
    }).run();
    const row = database.db.select().from(missionWorkOrders).where(eq(missionWorkOrders.id, id)).get();
    if (!row) throw new Error(`Failed to create work order ${id}`);
    return rowToWorkOrder(row);
  }

  function recordEvidenceWithSource(
    missionId: string,
    entries: MissionEvidenceInput[],
    source: MissionEvidenceSource,
  ): void {
    const now = new Date().toISOString();
    for (const entry of entries) {
      let criterionType: string | undefined;
      const snapshot = normalizeWorkspaceSnapshotIdentity(entry);
      const snapshotRef = snapshot?.ref;
      const snapshotKind = snapshot?.kind;
      if (entry.criterionId) {
        const criterion = database.db.select().from(missionAcceptanceCriteria)
          .where(and(eq(missionAcceptanceCriteria.id, entry.criterionId), eq(missionAcceptanceCriteria.missionId, missionId)))
          .get();
        if (!criterion) throw new Error(`Criterion ${entry.criterionId} does not belong to mission ${missionId}.`);
        criterionType = criterion.verificationType;
        if (source !== "agent_claim" && !isEvidenceSourceAllowed(criterion.verificationType, source)) {
          throw new Error(`Evidence source ${source} cannot satisfy ${criterion.verificationType} criterion ${entry.criterionId}.`);
        }
      }
      if (entry.findingId) {
        const finding = database.db.select().from(missionReviewFindings)
          .where(and(eq(missionReviewFindings.id, entry.findingId), eq(missionReviewFindings.missionId, missionId)))
          .get();
        if (!finding) throw new Error(`Finding ${entry.findingId} does not belong to mission ${missionId}.`);
        const requiredCommands = parseJson<string[]>(finding.requiredVerificationJson, []);
        if (source !== "agent_claim" && (requiredCommands.length ? !["server_test_runner", "runtime_probe"].includes(source) : source !== "reviewer_manual_attestation")) {
          throw new Error(`Evidence source ${source} cannot satisfy finding ${entry.findingId}'s verification policy.`);
        }
      }
      const details = { ...(typeof entry.details === "object" && entry.details ? entry.details as Record<string, unknown> : { value: entry.details }), source };
      database.db.insert(missionEvidence).values({
        id: `ev_${randomUUID()}`,
        missionId,
        criterionId: entry.criterionId ?? null,
        findingId: entry.findingId ?? null,
        submissionId: entry.submissionId ?? null,
        reviewEpoch: entry.reviewEpoch ?? null,
        snapshotKind: snapshotKind ?? null,
        snapshotRef: snapshotRef ?? null,
        snapshotCommit: snapshotRef ?? null,
        leaseNonce: entry.leaseNonce ?? null,
        actorPrincipal: entry.actorPrincipal ?? null,
        command: entry.command ?? null,
        outputDigest: sha256(JSON.stringify(details)),
        status: entry.status,
        detailsJson: JSON.stringify(details),
        createdAt: now,
      }).run();
      // P1 #24: Criterion status is contextual to submissionId + snapshotCommit.
      // A new piece of evidence for a new snapshot overwrites the previous
      // status — a pass on snapshot A does not permanently verify the
      // criterion for snapshot B.
      if (entry.criterionId && entry.submissionId && snapshotRef) {
        const newStatus = entry.status === "passed" && source !== "agent_claim" && isEvidenceSourceAllowed(criterionType ?? "manual_review", source) ? "verified" : entry.status === "failed" ? "failed" : "unverified";
        database.db.update(missionAcceptanceCriteria)
          .set({ status: newStatus, updatedAt: now })
          .where(and(eq(missionAcceptanceCriteria.id, entry.criterionId), eq(missionAcceptanceCriteria.missionId, missionId)))
          .run();
      }
    }
    touchMission(missionId);
  }

  function recordEvidence(missionId: string, entries: MissionEvidenceInput[]): void {
    recordEvidenceWithSource(missionId, entries, "reviewer_manual_attestation");
  }

  function recordReviewerEvidence(missionId: string, entries: MissionEvidenceInput[]): void {
    recordEvidenceWithSource(missionId, entries, "reviewer_manual_attestation");
  }

  function recordVerifierEvidence(missionId: string, entries: MissionEvidenceInput[]): void {
    recordEvidenceWithSource(missionId, entries, "server_test_runner");
  }

  function recordRuntimeProbeEvidence(missionId: string, entries: MissionEvidenceInput[]): void {
    recordEvidenceWithSource(missionId, entries, "runtime_probe");
  }

  function recordAgentEvidence(missionId: string, entries: MissionEvidenceInput[]): void {
    recordEvidenceWithSource(missionId, entries, "agent_claim");
  }

  function getPacket(workSessionId: string, approvalContext?: CurrentApprovalContext): MissionReviewPacket {
    const mission = getMissionByWorkSession(workSessionId);
    if (!mission) return { criteria: [], findings: [], workOrders: [], evidence: [], completionReports: [], approval: { allowed: true, reasons: [] }, criterionStates: [] };
    const criteria = database.db.select().from(missionAcceptanceCriteria).where(eq(missionAcceptanceCriteria.missionId, mission.id)).orderBy(asc(missionAcceptanceCriteria.createdAt)).all().map(rowToCriterion);
    const findings = database.db.select().from(missionReviewFindings).where(eq(missionReviewFindings.missionId, mission.id)).orderBy(asc(missionReviewFindings.createdAt)).all().map(rowToFinding);
    const workOrders = database.db.select().from(missionWorkOrders).where(eq(missionWorkOrders.missionId, mission.id)).orderBy(desc(missionWorkOrders.createdAt)).all().map(rowToWorkOrder);
    const evidence = database.db.select().from(missionEvidence).where(eq(missionEvidence.missionId, mission.id)).orderBy(desc(missionEvidence.createdAt)).all().map(rowToEvidence);
    const completionReports = database.db.select().from(missionCompletionReports).where(eq(missionCompletionReports.missionId, mission.id)).orderBy(desc(missionCompletionReports.createdAt)).all().map(rowToCompletionReport);
    return { mission, criteria, findings, workOrders, evidence, completionReports, approval: canApprove(workSessionId, approvalContext), criterionStates: evaluateCriteria(workSessionId, approvalContext) };
  }

  // P1 #26: Derive the current approval context from the latest pending
  // submission, so callers that don't pass an explicit context still get
  // consistent evidence-bound approval reasoning.
  function getCurrentApprovalContext(workSessionId: string): CurrentApprovalContext {
    const row = database.db.select({
      submissionId: workSessionSubmissions.id,
      snapshotKind: workSessionSubmissions.snapshotKind,
      snapshotRef: workSessionSubmissions.snapshotRef,
      reviewEpoch: workSessionSubmissions.reviewEpoch,
    }).from(workSessionSubmissions)
      .where(eq(workSessionSubmissions.workSessionId, workSessionId))
      .orderBy(desc(workSessionSubmissions.submissionNumber))
      .limit(1)
      .get();
    const snapshot = row ? normalizeWorkspaceSnapshotIdentity(row) : undefined;
    return row?.submissionId
      ? { submissionId: row.submissionId, snapshotKind: snapshot?.kind, snapshotRef: snapshot?.ref, reviewEpoch: row.reviewEpoch }
      : {};
  }

  function canApprove(workSessionId: string, context?: CurrentApprovalContext): ApprovalPredicate {
    const mission = getMissionByWorkSession(workSessionId);
    if (!mission) return { allowed: true, reasons: [] };
    const currentContext = normalizeCurrentApprovalContext(context ?? getCurrentApprovalContext(workSessionId));
    const currentSnapshot = normalizeWorkspaceSnapshotIdentity(currentContext);
    const packet = getPacketWithoutApproval(mission.id);
    const currentReport = currentContext.submissionId && currentSnapshot
      ? database.db.select().from(missionCompletionReports).where(and(
          eq(missionCompletionReports.missionId, mission.id),
          eq(missionCompletionReports.submissionId, currentContext.submissionId),
          eq(missionCompletionReports.snapshotKind, currentSnapshot.kind),
          eq(missionCompletionReports.snapshotRef, currentSnapshot.ref),
        )).orderBy(desc(missionCompletionReports.createdAt)).get()
      : undefined;
    return evaluateMissionOutcome({
      criteria: packet.criteria,
      criterionStates: evaluateCriteria(workSessionId, currentContext),
      findings: packet.findings,
      finalVerification: mission.finalVerification,
      reviewCoverage: mission.reviewCoverage,
      currentReport: currentReport ? {
        status: currentReport.status,
        reviewCoverage: parseJson<string[]>(currentReport.reviewCoverageJson, []),
      } : undefined,
    });
  }

  function evaluateCriteria(workSessionId: string, context?: CurrentApprovalContext): EffectiveCriterionState[] {
    const mission = getMissionByWorkSession(workSessionId);
    if (!mission) return [];
    const currentContext = normalizeCurrentApprovalContext(context ?? getCurrentApprovalContext(workSessionId));
    const criteria = database.db.select().from(missionAcceptanceCriteria)
      .where(eq(missionAcceptanceCriteria.missionId, mission.id))
      .orderBy(asc(missionAcceptanceCriteria.createdAt)).all().map(rowToCriterion);
    return evaluateEffectiveCriteria(
      criteria,
      (criterion, status) => latestCurrentEvidence(mission.id, criterion.id, currentContext, status),
      currentContext,
    );
  }

  function recordCompletionReport(missionId: string, input: { submissionId: string; snapshotKind?: WorkspaceSnapshotKind; snapshotRef?: string; snapshotCommit?: string; status: "passed" | "failed"; results: unknown; reviewCoverage?: string[]; uncertainty?: unknown[] }): void {
    const snapshot = normalizeWorkspaceSnapshotIdentity(input);
    if (!snapshot) throw new Error("Completion report requires a snapshot identity.");
    const resultsJson = JSON.stringify(input.results);
    // P1 #14: keep one authoritative report per
    // {missionId, submissionId, snapshotKind, snapshotRef}. If reviewer coverage was
    // recorded first, the verifier's report must MERGE it — otherwise the
    // newer row would displace covered lenses and block approval forever.
    const prior = database.db.select().from(missionCompletionReports).where(and(
      eq(missionCompletionReports.missionId, missionId),
      eq(missionCompletionReports.submissionId, input.submissionId),
      eq(missionCompletionReports.snapshotKind, snapshot.kind),
      eq(missionCompletionReports.snapshotRef, snapshot.ref),
    )).orderBy(desc(missionCompletionReports.createdAt)).get();
    const mergeInto = (current: string[], incoming?: string[]) => [...new Set([...current, ...(incoming ?? [])])];
    if (prior) {
      const mergedCoverage = mergeInto(parseJson<string[]>(prior.reviewCoverageJson, []), input.reviewCoverage);
      database.db.update(missionCompletionReports).set({
        status: input.status,
        resultsJson,
        reviewCoverageJson: JSON.stringify(mergedCoverage),
        uncertaintyJson: JSON.stringify(input.uncertainty ?? parseJson<unknown[]>(prior.uncertaintyJson, [])),
        reportSha256: createHash("sha256").update(resultsJson).digest("hex"),
      }).where(eq(missionCompletionReports.id, prior.id)).run();
      return;
    }
      database.db.insert(missionCompletionReports).values({
      id: `report_${randomUUID()}`,
      missionId,
        submissionId: input.submissionId,
        snapshotCommit: snapshot.ref,
        snapshotKind: snapshot.kind,
        snapshotRef: snapshot.ref,
      status: input.status,
      resultsJson,
      reviewCoverageJson: JSON.stringify(input.reviewCoverage ?? []),
      uncertaintyJson: JSON.stringify(input.uncertainty ?? []),
      reportSha256: createHash("sha256").update(resultsJson).digest("hex"),
      createdAt: new Date().toISOString(),
    }).run();
  }

  /** P2 #34/#35: Record which review lenses a reviewer covered and what remains uncertain. */
  function recordReviewCoverage(missionId: string, input: { submissionId: string; snapshotKind?: WorkspaceSnapshotKind; snapshotRef?: string; snapshotCommit?: string; reviewCoverage?: string[]; uncertainty?: unknown[] }): void {
    const snapshot = normalizeWorkspaceSnapshotIdentity(input);
    if (!snapshot) throw new Error("Review coverage requires a snapshot identity.");
    const mission = database.db.select().from(missionContracts).where(eq(missionContracts.id, missionId)).get();
    if (!mission) throw new Error(`No mission contract ${missionId}.`);
    const existing = database.db.select().from(missionCompletionReports).where(and(
      eq(missionCompletionReports.missionId, missionId),
      eq(missionCompletionReports.submissionId, input.submissionId),
      eq(missionCompletionReports.snapshotKind, snapshot.kind),
      eq(missionCompletionReports.snapshotRef, snapshot.ref),
    )).orderBy(desc(missionCompletionReports.createdAt)).get();
    const mergeInto = (current: string[], incoming: string[]) => [...new Set([...current, ...incoming])];
    if (existing) {
      // Coverage accumulates across reviewer passes for the same submission.
      const covered = mergeInto(parseJson<string[]>(existing.reviewCoverageJson, []), input.reviewCoverage ?? []);
      const uncertainty = input.uncertainty ?? parseJson<unknown[]>(existing.uncertaintyJson, []);
      const changes: Partial<typeof missionCompletionReports.$inferInsert> = {
        reviewCoverageJson: JSON.stringify(covered),
      };
      if (input.uncertainty !== undefined) changes.uncertaintyJson = JSON.stringify(uncertainty);
      database.db.update(missionCompletionReports).set(changes).where(eq(missionCompletionReports.id, existing.id)).run();
      return;
    }
    // No verifier report exists yet for this submission — create a
    // coverage-only placeholder so the approval gate can see the lenses that
    // were explicitly visited even before final integration verification runs.
    database.db.insert(missionCompletionReports).values({
      id: `report_${randomUUID()}`,
      missionId,
      submissionId: input.submissionId,
      snapshotCommit: snapshot.ref,
      snapshotKind: snapshot.kind,
      snapshotRef: snapshot.ref,
      status: "failed",
      resultsJson: JSON.stringify([]),
      reviewCoverageJson: JSON.stringify(input.reviewCoverage ?? []),
      uncertaintyJson: JSON.stringify(input.uncertainty ?? []),
      reportSha256: createHash("sha256").update(JSON.stringify([])).digest("hex"),
      createdAt: new Date().toISOString(),
    }).run();
  }

  function getCompletionReportHash(workSessionId: string, context: CurrentApprovalContext): string | undefined {
    const snapshot = normalizeWorkspaceSnapshotIdentity(context);
    const mission = getMissionByWorkSession(workSessionId);
    if (!mission?.finalVerification.length || !context.submissionId || !snapshot) return undefined;
    if (context.reviewEpoch !== undefined) {
      const submission = database.db.select({ reviewEpoch: workSessionSubmissions.reviewEpoch })
        .from(workSessionSubmissions)
        .where(and(eq(workSessionSubmissions.id, context.submissionId), eq(workSessionSubmissions.workSessionId, workSessionId)))
        .get();
      if (!submission || submission.reviewEpoch !== context.reviewEpoch) return undefined;
    }
    return database.db.select().from(missionCompletionReports)
      .where(and(
        eq(missionCompletionReports.missionId, mission.id),
        eq(missionCompletionReports.submissionId, context.submissionId),
        eq(missionCompletionReports.snapshotKind, snapshot.kind),
        eq(missionCompletionReports.snapshotRef, snapshot.ref),
        eq(missionCompletionReports.status, "passed"),
      ))
      .orderBy(desc(missionCompletionReports.createdAt)).get()?.reportSha256;
  }

  function evaluateLoopExtension(workSessionId: string, round: NewRoundInput): LoopExtensionDecision {
    const mission = database.db.select().from(missionContracts).where(eq(missionContracts.workSessionId, workSessionId)).get();
    if (!mission) {
      return { extend: false, round: 0, maxRounds: 0, reason: "No mission contract for this session.", ceilingHit: false };
    }

    // Only genuinely blocking, in-scope/regression NEW findings justify another
    // round. Out-of-scope or low/medium findings are advisory and never extend.
    const newBlocking = round.newFindingIds
      .map((id) => database.db.select().from(missionReviewFindings).where(and(eq(missionReviewFindings.id, id), eq(missionReviewFindings.missionId, mission.id))).get())
      .filter((f): f is MissionReviewFindingRow => !!f)
      .filter((f) => f.scope !== "out_of_scope" && f.disposition === "blocking");

    const decision = evaluateCorrectionPolicy({
      currentRound: mission.correctionRounds,
      maxCorrectionRounds: mission.maxCorrectionRounds,
      newBlockingCount: newBlocking.length,
      round,
    });
    if (decision.extend) {
      database.db.update(missionContracts).set({ correctionRounds: decision.round, updatedAt: new Date().toISOString() }).where(eq(missionContracts.id, mission.id)).run();
    }
    return decision;
  }

  function latestCurrentEvidence(missionId: string, criterionId: string, context: CurrentApprovalContext, status: "passed" | "failed" = "passed") {
    const snapshot = normalizeWorkspaceSnapshotIdentity(context);
    const snapshotRef = snapshot?.ref;
    const snapshotKind = snapshot?.kind;
    if (!context.submissionId || !snapshotKind || !snapshotRef) return undefined;
    const criterion = database.db.select().from(missionAcceptanceCriteria)
      .where(and(eq(missionAcceptanceCriteria.id, criterionId), eq(missionAcceptanceCriteria.missionId, missionId)))
      .get();
    if (!criterion) return undefined;
    const rows = database.db.select().from(missionEvidence)
      .where(and(eq(missionEvidence.missionId, missionId), eq(missionEvidence.criterionId, criterionId)))
      .orderBy(desc(missionEvidence.createdAt))
      .all()
      .map(rowToEvidence);
    return findCurrentCriterionEvidence(rows, criterion.verificationType, {
      ...context,
      snapshotKind,
      snapshotRef,
    }, status);
  }

  function getPacketWithoutApproval(missionId: string) {
    return {
      criteria: database.db.select().from(missionAcceptanceCriteria).where(eq(missionAcceptanceCriteria.missionId, missionId)).all().map(rowToCriterion),
      findings: database.db.select().from(missionReviewFindings).where(eq(missionReviewFindings.missionId, missionId)).all().map(rowToFinding),
    };
  }

  function touchMission(missionId: string) {
    database.db.update(missionContracts).set({ updatedAt: new Date().toISOString() }).where(eq(missionContracts.id, missionId)).run();
  }

  function setWorkOrderPreferredAgent(workSessionId: string, preferredAgent: string): number {
    const mission = getMissionByWorkSession(workSessionId);
    if (!mission) return 0;
    const result = database.db.update(missionWorkOrders)
      .set({ preferredAgent })
      .where(and(eq(missionWorkOrders.missionId, mission.id), eq(missionWorkOrders.status, "active")))
      .run();
    return result.changes;
  }

  return {
    createMission,
    getMissionByWorkSession,
    addFindings,
    updateCriterionStatus,
    updateFindingStatus,
    createWorkOrder,
    recordEvidence,
    recordReviewerEvidence,
    recordVerifierEvidence,
    recordRuntimeProbeEvidence,
    recordAgentEvidence,
    recordCompletionReport,
    recordReviewCoverage,
    getCompletionReportHash,
    getPacket,
    canApprove,
    evaluateCriteria,
    evaluateLoopExtension,
    resolveFinding,
    setWorkOrderPreferredAgent,
    // P1 #11: DB owned by server
    close: () => { },
  };
}

function rowToMission(row: MissionContractRow) {
  const baselineIdentity = normalizeWorkspaceSnapshotIdentity({
    snapshotKind: row.baselineKind,
    snapshotRef: row.baselineRef,
    snapshotCommit: row.baselineCommit,
  });
  return {
    id: row.id,
    workSessionId: row.workSessionId,
    workspaceSessionId: row.workspaceSessionId,
    revision: row.revision,
    contractFingerprint: row.contractFingerprint ?? undefined,
    objective: row.objective,
    desiredOutcome: row.desiredOutcome,
    constraints: parseJson(row.constraintsJson, []),
    nonGoals: parseJson(row.nonGoalsJson, []),
    userLockedFields: parseJson(row.userLockedFieldsJson, []),
    supervisorInstructions: row.supervisorInstructions ?? undefined,
    baselineKind: baselineIdentity?.kind,
    baselineRef: baselineIdentity?.ref,
    baselineCommit: baselineIdentity?.ref,
    correctionRounds: row.correctionRounds ?? 0,
    maxCorrectionRounds: row.maxCorrectionRounds ?? 5,
    finalVerification: parseJson(row.finalVerificationJson, []),
    reviewCoverage: parseJson<string[]>(row.reviewCoverageJson, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToCriterion(row: MissionAcceptanceCriterionRow) {
  return {
    id: row.id,
    missionId: row.missionId,
    description: row.description,
    priority: row.priority,
    verificationType: row.verificationType,
    verificationCommand: row.verificationCommand ?? undefined,
    runtimeProbe: row.runtimeProbeJson ? parseJson<RuntimeProbeInput | undefined>(row.runtimeProbeJson, undefined) : undefined,
    affectedAreas: parseJson(row.affectedAreasJson, []),
    dependsOnCriterionIds: parseJson(row.dependsOnJson, []),
    verificationGroup: row.verificationGroup ?? undefined,
    verificationScope: row.verificationScope ?? "full",
    finalOnly: Boolean(row.finalOnly),
    mutatesWorkspace: Boolean(row.mutatesWorkspace),
    commandVersion: row.commandVersion ?? undefined,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToFinding(row: MissionReviewFindingRow) {
  return {
    id: row.id,
    missionId: row.missionId,
    introducedInSubmissionId: row.introducedInSubmissionId ?? undefined,
    scope: (row.scope ?? "in_scope") as FindingScope,
    severity: row.severity,
    category: row.category,
    disposition: (row.disposition ?? "blocking") as FindingDisposition,
    fingerprint: row.fingerprint ?? undefined,
    description: row.description,
    evidence: parseJson(row.evidenceJson, []),
    requiredAction: row.requiredAction,
    requiredVerification: parseJson(row.requiredVerificationJson, []),
    status: row.status,
    resolutionSubmissionId: row.resolutionSubmissionId ?? undefined,
    resolutionEvidenceIds: parseJson<string[]>(row.resolutionEvidenceJson, []),
    waiverReason: row.waiverReason ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToWorkOrder(row: MissionWorkOrderRow) {
  return {
    id: row.id,
    missionId: row.missionId,
    workSessionId: row.workSessionId,
    missionRevision: row.missionRevision,
    objectiveForThisTurn: row.objectiveForThisTurn,
    requiredFindingIds: parseJson(row.requiredFindingIdsJson, []),
    acceptanceCriterionIds: parseJson(row.acceptanceCriterionIdsJson, []),
    requiredActions: parseJson(row.requiredActionsJson, []),
    prohibitedActions: parseJson(row.prohibitedActionsJson, []),
    requiredVerification: parseJson(row.requiredVerificationJson, []),
    expectedDeliverables: parseJson(row.expectedDeliverablesJson, []),
    contextReferences: parseJson(row.contextReferencesJson, []),
    preferredAgent: row.preferredAgent ?? undefined,
    status: row.status,
    createdAt: row.createdAt,
  };
}

function rowToEvidence(row: MissionEvidenceRow) {
  const snapshot = normalizeWorkspaceSnapshotIdentity({
    snapshotKind: row.snapshotKind,
    snapshotRef: row.snapshotRef,
    snapshotCommit: row.snapshotCommit,
  });
  return {
    id: row.id,
    missionId: row.missionId,
    criterionId: row.criterionId ?? undefined,
    findingId: row.findingId ?? undefined,
    submissionId: row.submissionId ?? undefined,
    reviewEpoch: row.reviewEpoch ?? undefined,
    snapshotKind: snapshot?.kind,
    snapshotRef: snapshot?.ref,
    snapshotCommit: snapshot?.ref,
    leaseNonce: row.leaseNonce ?? undefined,
    actorPrincipal: row.actorPrincipal ?? undefined,
    command: row.command ?? undefined,
    outputDigest: row.outputDigest ?? undefined,
    status: row.status,
    details: parseJson(row.detailsJson, {}),
    createdAt: row.createdAt,
  };
}

function rowToCompletionReport(row: MissionCompletionReportRow) {
  const snapshot = normalizeWorkspaceSnapshotIdentity({
    snapshotKind: row.snapshotKind,
    snapshotRef: row.snapshotRef,
    snapshotCommit: row.snapshotCommit,
  });
  return {
    id: row.id,
    missionId: row.missionId,
    submissionId: row.submissionId,
    snapshotKind: snapshot?.kind,
    snapshotRef: snapshot?.ref,
    snapshotCommit: snapshot?.ref,
    status: row.status,
    results: parseJson(row.resultsJson, []),
    reportSha256: row.reportSha256,
    createdAt: row.createdAt,
  };
}

function normalizeCurrentApprovalContext(context: CurrentApprovalContext): CurrentApprovalContext {
  const snapshot = normalizeWorkspaceSnapshotIdentity(context);
  if (!snapshot) return context;
  const canonicalContext: CurrentApprovalContext = { ...context };
  delete canonicalContext.snapshotCommit;
  return { ...canonicalContext, snapshotKind: snapshot.kind, snapshotRef: snapshot.ref };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
