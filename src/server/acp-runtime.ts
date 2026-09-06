/**
 * Singleton continuation dispatcher + supervisor runtime composition. The
 * dispatcher is owned by the Kontrol process, not by an individual MCP client
 * connection, and shares the SAME liveWaiters instance used by every
 * createMcpServer so a parked agent suppresses duplicate dispatch. Extracted
 * verbatim from src/server.ts (P1.2); the createServer closures become an
 * explicit dependency object.
 */
import { createHash } from "node:crypto";
import {
  createContinuationDispatcher,
  type BridgeConfig,
  type ContinuationDispatcher,
  type LiveWaiterRegistry,
} from "../acp-bridge.js";
import { createSupervisorRuntime } from "../supervisor-runtime.js";
import { verifyMissionSubmission } from "../mission-verifier.js";
import { evaluateSupervisorMission } from "../supervisor-evaluator.js";
import type { ServerConfig } from "../config.js";

type SupervisorRuntime = ReturnType<typeof createSupervisorRuntime>;
type DispatchOutbox = NonNullable<BridgeConfig["dispatchOutbox"]>;
type MissionLedger = NonNullable<BridgeConfig["missionLedger"]>;
type SupervisorRuns = NonNullable<BridgeConfig["supervisorRuns"]>;
type RecordPhaseTiming = (phase: string, ms: number) => void;

export interface AcpRuntimeDeps {
  readonly config: ServerConfig;
  readonly bridge: Omit<BridgeConfig, "onSupervisorResume" | "knownAgents" | "adapterSecret" | "reviewWorkflow" | "db" | "approvalRequests"> & {
    dispatchOutbox: DispatchOutbox;
    missionLedger: MissionLedger;
    supervisorRuns: SupervisorRuns;
  };
  readonly reviewWorkflow: import("../review-workflow.js").ReviewWorkflowService;
  readonly recordPhaseTiming: RecordPhaseTiming;
}

export interface AcpRuntimeHandles {
  readonly dispatcher: ContinuationDispatcher;
  readonly supervisorRuntime: SupervisorRuntime;
}

export function createAcpRuntime(deps: AcpRuntimeDeps): AcpRuntimeHandles {
  const { config, bridge, reviewWorkflow, recordPhaseTiming } = deps;
  const {
    workspaces,
    workSessions,
    reviewCheckpoints,
    agentRegistry,
    eventStore,
    continuationManager,
    dispatchOutbox,
    missionLedger,
    supervisorRuns,
    agentMessages,
    liveWaiters,
  } = bridge;
  let supervisorRuntime: SupervisorRuntime | undefined;
  const bridgeBase: BridgeConfig = {
    workspaces,
    workSessions,
    reviewCheckpoints,
    agentRegistry,
    eventStore,
    continuationManager,
    dispatchOutbox,
    reviewWorkflow,
    missionLedger,
    supervisorRuns,
    onSupervisorResume: (workSessionId) => supervisorRuntime?.wake(workSessionId),
    agentMessages,
    knownAgents: config.acpKnownAgents,
    adapterSecret: config.acpAdapterSecret,
    liveWaiters,
  };
  const dispatcher = createContinuationDispatcher(bridgeBase);
  dispatcher.start();
  supervisorRuntime = createSupervisorRuntime({
    outbox: dispatchOutbox,
    events: eventStore,
    runs: supervisorRuns,
    // P0.3: config-injected; the env fallback inside supervisor-runtime is
    // then dead for server paths.
    maxInflight: config.supervisorMaxInflight,
    onVerify: async (workSessionId, deadlineAt, submission) => {
      await verifyMissionSubmission({
        workSessionId,
        maxInflight: config.verifyMaxInflight,
        sandbox: config.verifySandbox,
        childEnvironmentAllowlist: config.childEnvironmentAllowlist,
        verifyToolchainPaths: config.verifyToolchainPaths,
        sandboxExecutablePath: config.verifySandboxExecutable,
        missionLedger,
        workSessions,
        workspaces,
        reviewCheckpoints,
        deadlineAtMs: deadlineAt ? Date.parse(deadlineAt) : undefined,
        submissionId: submission?.id,
        reviewEpoch: submission?.reviewEpoch,
      });
    },
    onEvaluate: async (workSessionId) => {
      const run = supervisorRuns.getByWorkSession(workSessionId);
      const latest = workSessions.get(workSessionId)?.latestSubmission;
      return evaluateSupervisorMission(missionLedger, workSessionId, {
        submissionId: latest?.id,
        snapshotKind: latest?.snapshotKind,
        snapshotRef: latest?.snapshotRef ?? latest?.snapshotCommit,
        snapshotCommit: latest?.snapshotRef ?? latest?.snapshotCommit,
        cycleNumber: run?.cycleNumber ?? 0,
        emergencyCycleCeiling: run?.maxCycles,
      });
    },
    onTiming: (sample) => {
      recordPhaseTiming(`supervisor.${sample.stage}.event_to_claim`, sample.eventToClaimMs);
      recordPhaseTiming(`supervisor.${sample.stage}.total`, sample.totalMs);
      if (sample.verificationMs !== undefined) recordPhaseTiming("supervisor.verification.duration", sample.verificationMs);
      if (sample.evaluationMs !== undefined) recordPhaseTiming("supervisor.evaluation.duration", sample.evaluationMs);
    },
    getProgressSnapshot: (workSessionId, evaluation) => {
      const session = workSessions.get(workSessionId);
      const latest = session?.latestSubmission;
      const packet = missionLedger.getPacket(workSessionId, latest?.id ? { submissionId: latest.id, snapshotKind: latest.snapshotKind, snapshotRef: latest.snapshotRef ?? latest.snapshotCommit, snapshotCommit: latest.snapshotRef ?? latest.snapshotCommit, reviewEpoch: latest.reviewEpoch } : undefined);
      const currentEvidence = packet.evidence.filter((entry) => !latest?.id || entry.submissionId === latest.id);
      const failedEvidence = currentEvidence.filter((entry) => entry.status === "failed");
      const failureSet = failedEvidence.map((entry) => {
        const details = typeof entry.details === "object" && entry.details ? entry.details as Record<string, unknown> : {};
        return { command: entry.command, failureSetSha256: details.failureSetSha256, outputSha256: details.outputSha256, status: entry.status };
      });
      const summary = latest?.summaryJson ? (() => { try { return JSON.parse(latest.summaryJson) as { files?: number }; } catch { return {}; } })() : {};
      return {
        blockingFindingCount: packet.findings.filter((finding) => finding.scope !== "out_of_scope" && ["blocker", "high"].includes(finding.severity) && !["verified_resolved", "waived"].includes(finding.status)).length,
        failedCriterionCount: packet.criteria.filter((criterion) => criterion.priority === "required" && criterion.status === "failed").length,
        passedCriterionCount: packet.criteria.filter((criterion) => criterion.status === "verified").length,
        failingVerificationCount: failedEvidence.length,
        verificationFailureFingerprint: failureSet.length ? createHash("sha256").update(JSON.stringify(failureSet)).digest("hex") : evaluation.failureSetSha256,
        changedRelevantFiles: typeof summary.files === "number" ? summary.files : 0,
        unresolvedRequiredActions: packet.workOrders[0]?.requiredActions.length ?? 0,
        submissionId: latest?.id ?? "",
        reviewEpoch: latest?.reviewEpoch ?? 0,
      };
    },
    onCorrect: async (workSessionId, reasons) => {
      const mission = missionLedger.getMissionByWorkSession(workSessionId);
      const session = workSessions.get(workSessionId);
      const latest = session?.latestSubmission;
      if (!mission || !latest?.id || !session) throw new Error("Cannot create a correction without a current mission submission.");
      const packet = missionLedger.getPacket(workSessionId);
      const failedCriteria = packet.criteria.filter((criterion) => criterion.priority === "required" && criterion.status !== "verified");
      const openFindings = packet.findings.filter((finding) => finding.scope !== "out_of_scope" && ["blocker", "high"].includes(finding.severity) && !["verified_resolved", "waived"].includes(finding.status));
      const workOrder = missionLedger.createWorkOrder(mission.id, workSessionId, {
        objectiveForThisTurn: "Resolve the current failed mission verification and resubmit the exact workspace snapshot for review.",
        acceptanceCriterionIds: failedCriteria.map((criterion) => criterion.id),
        requiredFindingIds: openFindings.map((finding) => finding.id),
        requiredActions: reasons,
        prohibitedActions: mission.userLockedFields.map((field) => `Do not alter user-locked mission field: ${field}`),
        requiredVerification: failedCriteria.map((criterion) => criterion.verificationCommand).filter(Boolean),
        expectedDeliverables: ["A corrected submission with verification-ready workspace state."],
      });
      await reviewWorkflow.provideFeedback({
        sessionId: workSessionId,
        submissionId: latest.id,
        diffSha256: latest.diffSha256,
        reviewEpoch: latest.reviewEpoch,
        verdict: "changes_requested",
        comments: `Automatic verification requires correction:\n${reasons.join("\n")}`,
        requiredActions: workOrder.requiredActions,
        reviewerId: "supervisor-runtime",
      });
    },
    currentSubmission: (workSessionId) => {
      const session = workSessions.get(workSessionId);
      if (session?.status !== "awaiting_review") return undefined;
      const submission = session.latestSubmission;
      return submission?.id ? { id: submission.id, snapshotKind: submission.snapshotKind, snapshotRef: submission.snapshotRef ?? submission.snapshotCommit, snapshotCommit: submission.snapshotRef ?? submission.snapshotCommit, reviewEpoch: submission.reviewEpoch } : undefined;
    },
    currentSessionStatus: (workSessionId) => workSessions.get(workSessionId)?.status,
    currentApproval: (workSessionId) => {
      const latest = workSessions.get(workSessionId)?.latestSubmission;
      return missionLedger.canApprove(workSessionId, latest?.id ? { submissionId: latest.id, snapshotKind: latest.snapshotKind, snapshotRef: latest.snapshotRef ?? latest.snapshotCommit, snapshotCommit: latest.snapshotRef ?? latest.snapshotCommit, reviewEpoch: latest.reviewEpoch } : {});
    },
    onApprove: async (workSessionId) => {
      const session = workSessions.get(workSessionId);
      const latest = session?.latestSubmission;
      if (!session || !latest?.id) throw new Error("Cannot automatically approve without a current submission.");
      const approval = missionLedger.canApprove(workSessionId, { submissionId: latest.id, snapshotKind: latest.snapshotKind, snapshotRef: latest.snapshotRef ?? latest.snapshotCommit, snapshotCommit: latest.snapshotRef ?? latest.snapshotCommit, reviewEpoch: latest.reviewEpoch });
      if (!approval.allowed) throw new Error(`Automatic approval blocked: ${approval.reasons.join("; ")}`);
      await reviewWorkflow.provideFeedback({
        sessionId: workSessionId,
        submissionId: latest.id,
        diffSha256: latest.diffSha256,
        reviewEpoch: latest.reviewEpoch,
        verdict: "approve",
        comments: "Automatically approved after current trusted mission verification.",
        reviewerId: "supervisor-runtime",
        completionReportSha256: missionLedger.getCompletionReportHash(workSessionId, { submissionId: latest.id, snapshotKind: latest.snapshotKind, snapshotRef: latest.snapshotRef ?? latest.snapshotCommit, snapshotCommit: latest.snapshotRef ?? latest.snapshotCommit, reviewEpoch: latest.reviewEpoch }),
      });
    },
  });
  supervisorRuntime.start();
  return { dispatcher, supervisorRuntime };
}
