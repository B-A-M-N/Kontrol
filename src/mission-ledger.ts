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

export interface MissionCriterionInput {
  id?: string;
  description: string;
  priority?: "required" | "preferred";
  verificationType?: "test" | "code_inspection" | "runtime_behavior" | "security_review" | "manual_review";
  verificationCommand?: string;
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
  requiredVerification?: unknown[];
  status?: FindingStatus;
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
  snapshotCommit?: string;
  /** Review generation the evidence and approval decision belong to. */
  reviewEpoch?: number;
}

export interface MissionEvidenceInput {
  criterionId?: string;
  submissionId?: string;
  reviewEpoch?: number;
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
}

export interface MissionLedger {
  createMission(input: MissionContractInput): ReturnType<typeof rowToMission>;
  getMissionByWorkSession(workSessionId: string): ReturnType<typeof rowToMission> | undefined;
  addFindings(missionId: string, findings: ReviewFindingInput[]): Array<ReturnType<typeof rowToFinding>>;
  updateCriterionStatus(missionId: string, updates: Array<{ id: string; status: Exclude<CriterionStatus, "verified"> }>): void;
  updateFindingStatus(missionId: string, updates: Array<{ id: string; status: FindingStatus; waiverReason?: string; resolutionSubmissionId?: string; disposition?: FindingDisposition }>): void;
  createWorkOrder(missionId: string, workSessionId: string, input: WorkOrderInput): ReturnType<typeof rowToWorkOrder>;
  /** Legacy reviewer path: source is assigned by the server, never by input. */
  recordEvidence(missionId: string, entries: MissionEvidenceInput[]): void;
  recordReviewerEvidence(missionId: string, entries: MissionEvidenceInput[]): void;
  recordVerifierEvidence(missionId: string, entries: MissionEvidenceInput[]): void;
  recordRuntimeProbeEvidence(missionId: string, entries: MissionEvidenceInput[]): void;
  recordAgentEvidence(missionId: string, entries: MissionEvidenceInput[]): void;
  recordCompletionReport(missionId: string, input: { submissionId: string; snapshotCommit: string; status: "passed" | "failed"; results: unknown; reviewCoverage?: string[]; uncertainty?: unknown[] }): void;
  recordReviewCoverage(missionId: string, input: { submissionId: string; snapshotCommit: string; reviewCoverage?: string[]; uncertainty?: unknown[] }): void;
  getCompletionReportHash(workSessionId: string, context: CurrentApprovalContext): string | undefined;
  getPacket(workSessionId: string, approvalContext?: CurrentApprovalContext): MissionReviewPacket;
  canApprove(workSessionId: string, context?: CurrentApprovalContext): ApprovalPredicate;
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

export function createMissionLedger(stateDirOrHandle: string | DatabaseHandle): MissionLedger {
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;

  function createMission(input: MissionContractInput) {
    const now = new Date().toISOString();
    const requiredCriteria = (input.acceptanceCriteria ?? []).filter((c) => (c.priority ?? "required") === "required");
    if (requiredCriteria.length === 0) {
      throw new Error("Mission requires at least one required acceptance criterion.");
    }
    validateCriterionGraph(input.acceptanceCriteria ?? []);
    const existing = getMissionByWorkSession(input.workSessionId);
    if (existing) return existing;
    const missionId = `mission_${randomUUID()}`;
    database.db.transaction(() => {
      database.db.insert(missionContracts).values({
        id: missionId,
        workSessionId: input.workSessionId,
        workspaceSessionId: input.workspaceSessionId,
        revision: 1,
        objective: input.objective,
        desiredOutcome: input.desiredOutcome ?? input.objective,
        constraintsJson: JSON.stringify(input.constraints ?? []),
        nonGoalsJson: JSON.stringify(input.nonGoals ?? []),
        userLockedFieldsJson: JSON.stringify(input.userLockedFields ?? ["objective", "desiredOutcome", "constraints", "nonGoals"]),
        supervisorInstructions: input.supervisorInstructions ?? null,
        baselineCommit: input.baselineCommit ?? null,
        correctionRounds: 0,
        maxCorrectionRounds: input.maxCorrectionRounds ?? 5,
        finalVerificationJson: JSON.stringify(input.finalVerification ?? []),
        reviewCoverageJson: JSON.stringify(input.reviewCoverage ?? []),
        createdAt: now,
        updatedAt: now,
      }).run();
      for (const criterion of input.acceptanceCriteria ?? []) {
        database.db.insert(missionAcceptanceCriteria).values({
          id: criterion.id ?? `crit_${randomUUID()}`,
          missionId,
          description: criterion.description,
          priority: criterion.priority ?? "required",
          verificationType: criterion.verificationType ?? "manual_review",
          verificationCommand: criterion.verificationCommand ?? null,
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
        const id = finding.id ?? `find_${randomUUID()}`;
        // Default scope: a finding tied to a submission the agent produced is a
        // regression; otherwise callers should classify explicitly. We never
        // default to out_of_scope (that would silently let real issues through).
        const scope: FindingScope = finding.scope ?? (finding.introducedInSubmissionId ? "regression" : "in_scope");
        const severity = finding.severity ?? "medium";
        const disposition: FindingDisposition = finding.disposition ?? (scope === "out_of_scope" || !["blocker", "high"].includes(severity) ? "advisory" : "blocking");
        const fingerprint = semanticFindingFingerprint({
          category: finding.category ?? "correctness",
          scope,
          description: finding.description,
          requiredAction: finding.requiredAction,
          evidence: finding.evidence,
        });
        const equivalent = existingRows.find((row) =>
          !["verified_resolved", "waived"].includes(row.status) &&
          (row.fingerprint === fingerprint || (!row.fingerprint && semanticFindingFingerprint(row) === fingerprint)),
        );
        if (equivalent) {
          const oldEvidence = parseJson<unknown[]>(equivalent.evidenceJson, []);
          const mergedEvidence = mergeEvidence(oldEvidence, finding.evidence ?? []);
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

  function updateFindingStatus(missionId: string, updates: Array<{ id: string; status: FindingStatus; waiverReason?: string; resolutionSubmissionId?: string; disposition?: FindingDisposition }>): void {
    const now = new Date().toISOString();
    for (const update of updates) {
      if (update.status === "waived" && !update.waiverReason?.trim()) {
        throw new Error(`Waiving finding ${update.id} requires a waiverReason.`);
      }
      database.db.update(missionReviewFindings)
        .set({
          status: update.status,
          ...(update.disposition ? { disposition: update.disposition } : {}),
          waiverReason: update.waiverReason ?? null,
          resolutionSubmissionId: update.resolutionSubmissionId ?? null,
          updatedAt: now,
        })
        .where(and(eq(missionReviewFindings.id, update.id), eq(missionReviewFindings.missionId, missionId)))
        .run();
    }
    touchMission(missionId);
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
    source: "server_test_runner" | "runtime_probe" | "reviewer_manual_attestation" | "agent_claim",
  ): void {
    const now = new Date().toISOString();
    for (const entry of entries) {
      if (entry.criterionId) {
        const criterion = database.db.select().from(missionAcceptanceCriteria)
          .where(and(eq(missionAcceptanceCriteria.id, entry.criterionId), eq(missionAcceptanceCriteria.missionId, missionId)))
          .get();
        if (!criterion) throw new Error(`Criterion ${entry.criterionId} does not belong to mission ${missionId}.`);
      }
      const details = { ...(typeof entry.details === "object" && entry.details ? entry.details as Record<string, unknown> : { value: entry.details }), source };
      database.db.insert(missionEvidence).values({
        id: `ev_${randomUUID()}`,
        missionId,
        criterionId: entry.criterionId ?? null,
        submissionId: entry.submissionId ?? null,
        reviewEpoch: entry.reviewEpoch ?? null,
        snapshotCommit: entry.snapshotCommit ?? null,
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
      if (entry.criterionId && entry.submissionId && entry.snapshotCommit) {
        const newStatus = entry.status === "passed" && source !== "agent_claim" ? "verified" : entry.status === "failed" ? "failed" : "unverified";
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
    if (!mission) return { criteria: [], findings: [], workOrders: [], evidence: [], completionReports: [], approval: { allowed: true, reasons: [] } };
    const criteria = database.db.select().from(missionAcceptanceCriteria).where(eq(missionAcceptanceCriteria.missionId, mission.id)).orderBy(asc(missionAcceptanceCriteria.createdAt)).all().map(rowToCriterion);
    const findings = database.db.select().from(missionReviewFindings).where(eq(missionReviewFindings.missionId, mission.id)).orderBy(asc(missionReviewFindings.createdAt)).all().map(rowToFinding);
    const workOrders = database.db.select().from(missionWorkOrders).where(eq(missionWorkOrders.missionId, mission.id)).orderBy(desc(missionWorkOrders.createdAt)).all().map(rowToWorkOrder);
    const evidence = database.db.select().from(missionEvidence).where(eq(missionEvidence.missionId, mission.id)).orderBy(desc(missionEvidence.createdAt)).all().map(rowToEvidence);
    const completionReports = database.db.select().from(missionCompletionReports).where(eq(missionCompletionReports.missionId, mission.id)).orderBy(desc(missionCompletionReports.createdAt)).all().map(rowToCompletionReport);
    return { mission, criteria, findings, workOrders, evidence, completionReports, approval: canApprove(workSessionId, approvalContext) };
  }

  // P1 #26: Derive the current approval context from the latest pending
  // submission, so callers that don't pass an explicit context still get
  // consistent evidence-bound approval reasoning.
  function getCurrentApprovalContext(workSessionId: string): CurrentApprovalContext {
    const row = database.db.select({
      submissionId: workSessionSubmissions.id,
      snapshotCommit: workSessionSubmissions.snapshotCommit,
      reviewEpoch: workSessionSubmissions.reviewEpoch,
    }).from(workSessionSubmissions)
      .where(eq(workSessionSubmissions.workSessionId, workSessionId))
      .orderBy(desc(workSessionSubmissions.submissionNumber))
      .limit(1)
      .get();
    return row?.submissionId
      ? { submissionId: row.submissionId, snapshotCommit: row.snapshotCommit ?? undefined, reviewEpoch: row.reviewEpoch }
      : {};
  }

  function canApprove(workSessionId: string, context?: CurrentApprovalContext): ApprovalPredicate {
    const mission = getMissionByWorkSession(workSessionId);
    if (!mission) return { allowed: true, reasons: [] };
    const currentContext = context ?? getCurrentApprovalContext(workSessionId);
    const packet = getPacketWithoutApproval(mission.id);
    const reasons: string[] = [];
    const criteriaById = new Map(packet.criteria.map((c) => [c.id, c]));

    // P1 #25: Effective criterion status — a criterion cannot be effectively
    // verified unless all its dependencies are effectively verified.
    const effectiveStatus = new Map<string, "verified" | "unverified">();
    const dependencyCycles = new Set<string>();
    const computeEffective = (criterionId: string, stack: Set<string>): "verified" | "unverified" => {
      if (effectiveStatus.has(criterionId)) return effectiveStatus.get(criterionId)!;
      if (stack.has(criterionId)) {
        dependencyCycles.add(criterionId);
        effectiveStatus.set(criterionId, "unverified");
        return "unverified";
      }
      stack.add(criterionId);
      const criterion = criteriaById.get(criterionId);
      if (!criterion) {
        stack.delete(criterionId);
        effectiveStatus.set(criterionId, "unverified");
        return "unverified";
      }
      const depsOk = (criterion.dependsOnCriterionIds ?? []).every((depId) => computeEffective(depId, stack) === "verified");
      stack.delete(criterionId);
      // Dependencies are current-snapshot claims too. Persisted `verified`
      // status alone is not evidence that the dependency passed this review
      // generation.
      const selfOk = criterion.status === "verified"
        && Boolean(latestCurrentEvidence(mission.id, criterion.id, currentContext));
      const result = selfOk && depsOk ? "verified" : "unverified";
      effectiveStatus.set(criterionId, result);
      return result;
    };

    for (const criterion of packet.criteria) {
      if (criterion.priority === "required") {
        const eff = computeEffective(criterion.id, new Set());
        if (eff !== "verified") {
          if (criterion.status === "verified" && !latestCurrentEvidence(mission.id, criterion.id, currentContext)) {
            reasons.push(`Required criterion ${criterion.id} has no current non-agent evidence for submission ${currentContext.submissionId ?? "(unknown)"}.`);
          } else {
            reasons.push(`Required criterion ${criterion.id} is ${criterion.status}: ${criterion.description}`);
          }
          continue;
        }
        const evidence = latestCurrentEvidence(mission.id, criterion.id, currentContext);
        if (!evidence) {
          reasons.push(`Required criterion ${criterion.id} has no current non-agent evidence for submission ${currentContext.submissionId ?? "(unknown)"}.`);
        }
      }
    }
    for (const cycle of dependencyCycles) reasons.push(`Dependency cycle detected at criterion ${cycle}.`);
    for (const finding of packet.findings) {
      // Out-of-scope findings are advisory only — they never block approval.
      // This is the anti-runaway guard: a reviewer can surface a pre-existing
      // issue for visibility without trapping the loop forever.
      if (finding.scope === "out_of_scope") continue;
      if (finding.disposition === "blocking" && !["verified_resolved", "waived"].includes(finding.status)) {
        reasons.push(`${finding.severity} finding ${finding.id} is ${finding.status}: ${finding.description}`);
      }
    }
    if (mission.finalVerification.length) {
      const report = currentContext.submissionId && currentContext.snapshotCommit
        ? database.db.select().from(missionCompletionReports).where(and(eq(missionCompletionReports.missionId, mission.id), eq(missionCompletionReports.submissionId, currentContext.submissionId), eq(missionCompletionReports.snapshotCommit, currentContext.snapshotCommit))).orderBy(desc(missionCompletionReports.createdAt)).get()
        : undefined;
      if (!report || report.status !== "passed") reasons.push("Mission-level final integration verification has not passed for the current submission.");
    }
    if (mission.reviewCoverage.length) {
      const report = currentContext.submissionId && currentContext.snapshotCommit
        ? database.db.select().from(missionCompletionReports).where(and(eq(missionCompletionReports.missionId, mission.id), eq(missionCompletionReports.submissionId, currentContext.submissionId), eq(missionCompletionReports.snapshotCommit, currentContext.snapshotCommit))).orderBy(desc(missionCompletionReports.createdAt)).get()
        : undefined;
      const covered = new Set(report ? parseJson<string[]>(report.reviewCoverageJson, []) : []);
      const missing = mission.reviewCoverage.filter((area) => !covered.has(area));
      if (missing.length) reasons.push(`Review coverage is incomplete; missing: ${missing.join(", ")}.`);
    }
    return { allowed: reasons.length === 0, reasons };
  }

  function recordCompletionReport(missionId: string, input: { submissionId: string; snapshotCommit: string; status: "passed" | "failed"; results: unknown; reviewCoverage?: string[]; uncertainty?: unknown[] }): void {
    const resultsJson = JSON.stringify(input.results);
    // P1 #14: keep one authoritative report per
    // {missionId, submissionId, snapshotCommit}. If reviewer coverage was
    // recorded first, the verifier's report must MERGE it — otherwise the
    // newer row would displace covered lenses and block approval forever.
    const prior = database.db.select().from(missionCompletionReports).where(and(
      eq(missionCompletionReports.missionId, missionId),
      eq(missionCompletionReports.submissionId, input.submissionId),
      eq(missionCompletionReports.snapshotCommit, input.snapshotCommit),
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
      snapshotCommit: input.snapshotCommit,
      status: input.status,
      resultsJson,
      reviewCoverageJson: JSON.stringify(input.reviewCoverage ?? []),
      uncertaintyJson: JSON.stringify(input.uncertainty ?? []),
      reportSha256: createHash("sha256").update(resultsJson).digest("hex"),
      createdAt: new Date().toISOString(),
    }).run();
  }

  /** P2 #34/#35: Record which review lenses a reviewer covered and what remains uncertain. */
  function recordReviewCoverage(missionId: string, input: { submissionId: string; snapshotCommit: string; reviewCoverage?: string[]; uncertainty?: unknown[] }): void {
    const mission = database.db.select().from(missionContracts).where(eq(missionContracts.id, missionId)).get();
    if (!mission) throw new Error(`No mission contract ${missionId}.`);
    const existing = database.db.select().from(missionCompletionReports).where(and(
      eq(missionCompletionReports.missionId, missionId),
      eq(missionCompletionReports.submissionId, input.submissionId),
      eq(missionCompletionReports.snapshotCommit, input.snapshotCommit),
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
      snapshotCommit: input.snapshotCommit,
      status: "failed",
      resultsJson: JSON.stringify([]),
      reviewCoverageJson: JSON.stringify(input.reviewCoverage ?? []),
      uncertaintyJson: JSON.stringify(input.uncertainty ?? []),
      reportSha256: createHash("sha256").update(JSON.stringify([])).digest("hex"),
      createdAt: new Date().toISOString(),
    }).run();
  }

  function getCompletionReportHash(workSessionId: string, context: CurrentApprovalContext): string | undefined {
    const mission = getMissionByWorkSession(workSessionId);
    if (!mission?.finalVerification.length || !context.submissionId || !context.snapshotCommit) return undefined;
    if (context.reviewEpoch !== undefined) {
      const submission = database.db.select({ reviewEpoch: workSessionSubmissions.reviewEpoch })
        .from(workSessionSubmissions)
        .where(and(eq(workSessionSubmissions.id, context.submissionId), eq(workSessionSubmissions.workSessionId, workSessionId)))
        .get();
      if (!submission || submission.reviewEpoch !== context.reviewEpoch) return undefined;
    }
    return database.db.select().from(missionCompletionReports)
      .where(and(eq(missionCompletionReports.missionId, mission.id), eq(missionCompletionReports.submissionId, context.submissionId), eq(missionCompletionReports.snapshotCommit, context.snapshotCommit), eq(missionCompletionReports.status, "passed")))
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

    // No new blocking work → the loop has converged. Nothing to extend; the
    // approval predicate decides whether remaining open findings block.
    if (newBlocking.length === 0) {
      return {
        extend: false,
        round: mission.correctionRounds,
        maxRounds: mission.maxCorrectionRounds,
        reason: "Round surfaced no new blocking in-scope findings; loop has converged.",
        ceilingHit: false,
      };
    }

    const nextRound = mission.correctionRounds + 1;
    const madeProgress = round.progress?.madeProgress
      ?? (round.resolvedFindingIds?.length ?? 0) > 0;

    // Progress-aware ceiling: if the round is actually resolving prior findings,
    // grant a little headroom so genuinely-needed work is never cut off just for
    // hitting a round number. Runaway (new findings but nothing ever resolved)
    // gets no headroom and stops hard at the ceiling.
    const effectiveMax = mission.maxCorrectionRounds + (madeProgress ? 2 : 0);

    if (nextRound > effectiveMax) {
      return {
        extend: false,
        round: mission.correctionRounds,
        maxRounds: effectiveMax,
        reason: `Correction ceiling reached (${mission.correctionRounds}/${effectiveMax}). New findings recorded but the loop will not auto-extend; a human must decide to continue or ship.`,
        ceilingHit: true,
      };
    }

    database.db.update(missionContracts).set({ correctionRounds: nextRound, updatedAt: new Date().toISOString() }).where(eq(missionContracts.id, mission.id)).run();
    return {
      extend: true,
      round: nextRound,
      maxRounds: effectiveMax,
      reason: `Extending correction loop: ${newBlocking.length} new blocking in-scope finding(s), round ${nextRound}/${effectiveMax}${madeProgress ? " (progress: prior findings resolved)" : ""}.`,
      ceilingHit: false,
    };
  }

  function latestCurrentEvidence(missionId: string, criterionId: string, context: CurrentApprovalContext) {
    if (!context.submissionId || !context.snapshotCommit) return undefined;
    const rows = database.db.select().from(missionEvidence)
      .where(and(eq(missionEvidence.missionId, missionId), eq(missionEvidence.criterionId, criterionId)))
      .orderBy(desc(missionEvidence.createdAt))
      .all()
      .map(rowToEvidence);
    return rows.find((row) => {
      const details = typeof row.details === "object" && row.details ? row.details as Record<string, unknown> : {};
      return row.status === "passed" &&
        row.submissionId === context.submissionId &&
        row.snapshotCommit === context.snapshotCommit &&
        (context.reviewEpoch === undefined || row.reviewEpoch === context.reviewEpoch) &&
        details.source !== "agent_claim";
    });
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
    evaluateLoopExtension,
    setWorkOrderPreferredAgent,
    // P1 #11: DB owned by server
    close: () => { },
  };
}

function rowToMission(row: MissionContractRow) {
  return {
    id: row.id,
    workSessionId: row.workSessionId,
    workspaceSessionId: row.workspaceSessionId,
    revision: row.revision,
    objective: row.objective,
    desiredOutcome: row.desiredOutcome,
    constraints: parseJson(row.constraintsJson, []),
    nonGoals: parseJson(row.nonGoalsJson, []),
    userLockedFields: parseJson(row.userLockedFieldsJson, []),
    supervisorInstructions: row.supervisorInstructions ?? undefined,
    baselineCommit: row.baselineCommit ?? undefined,
    correctionRounds: row.correctionRounds ?? 0,
    maxCorrectionRounds: row.maxCorrectionRounds ?? 5,
    finalVerification: parseJson(row.finalVerificationJson, []),
    reviewCoverage: parseJson<string[]>(row.reviewCoverageJson, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function validateCriterionGraph(criteria: MissionCriterionInput[]): void {
  const ids = new Set<string>();
  for (const criterion of criteria) {
    if (criterion.id) {
      if (ids.has(criterion.id)) throw new Error(`Duplicate mission criterion id: ${criterion.id}`);
      ids.add(criterion.id);
    }
    if (criterion.dependsOnCriterionIds?.length && !criterion.id) throw new Error("A criterion with dependencies must have a stable id.");
  }
  for (const criterion of criteria) {
    for (const dependency of criterion.dependsOnCriterionIds ?? []) {
      if (!ids.has(dependency)) throw new Error(`Criterion ${criterion.id ?? "(generated)"} depends on unknown criterion ${dependency}.`);
      if (dependency === criterion.id) throw new Error(`Criterion ${criterion.id} cannot depend on itself.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(criteria.filter((criterion): criterion is MissionCriterionInput & { id: string } => Boolean(criterion.id)).map((criterion) => [criterion.id, criterion]));
  const walk = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Mission criterion dependency cycle detected at ${id}.`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOnCriterionIds ?? []) walk(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) walk(id);
}

function rowToCriterion(row: MissionAcceptanceCriterionRow) {
  return {
    id: row.id,
    missionId: row.missionId,
    description: row.description,
    priority: row.priority,
    verificationType: row.verificationType,
    verificationCommand: row.verificationCommand ?? undefined,
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
    waiverReason: row.waiverReason ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeFindingText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:line|ln|at)\s*\d+\b/gi, "line")
    .replace(/\b\d+(?::\d+)+\b/g, "position")
    .replace(/[^a-z0-9_./ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function semanticFindingFingerprint(finding: {
  category?: string | null;
  scope?: string | null;
  description: string;
  requiredAction: string;
  evidence?: unknown[] | string | null;
}): string {
  const rawEvidence = typeof finding.evidence === "string" ? parseJson<unknown[]>(finding.evidence, []) : finding.evidence ?? [];
  const locations = rawEvidence.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    return [value.file, value.path, value.symbol]
      .filter((part): part is string => typeof part === "string")
      .map(normalizeFindingText);
  }).sort();
  return sha256(JSON.stringify({
    category: normalizeFindingText(finding.category ?? "correctness"),
    scope: normalizeFindingText(finding.scope ?? "in_scope"),
    locations: [...new Set(locations)],
    requiredAction: normalizeFindingText(finding.requiredAction),
    description: normalizeFindingText(finding.description),
  }));
}

function mergeEvidence(existing: unknown[], incoming: unknown[]): unknown[] {
  const seen = new Set(existing.map((entry) => JSON.stringify(entry)));
  const merged = [...existing];
  for (const entry of incoming) {
    const encoded = JSON.stringify(entry);
    if (!seen.has(encoded)) {
      seen.add(encoded);
      merged.push(entry);
    }
  }
  return merged;
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
  return {
    id: row.id,
    missionId: row.missionId,
    criterionId: row.criterionId ?? undefined,
    submissionId: row.submissionId ?? undefined,
    reviewEpoch: row.reviewEpoch ?? undefined,
    snapshotCommit: row.snapshotCommit ?? undefined,
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
  return {
    id: row.id,
    missionId: row.missionId,
    submissionId: row.submissionId,
    snapshotCommit: row.snapshotCommit,
    status: row.status,
    results: parseJson(row.resultsJson, []),
    reportSha256: row.reportSha256,
    createdAt: row.createdAt,
  };
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
