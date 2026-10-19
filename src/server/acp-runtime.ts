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
import { createReplyDispatcher } from "../bridge/reply-dispatcher.js";
import { createScheduledJobRuntime } from "../scheduling/scheduled-job-runtime.js";
import { dispatchScheduledJob } from "../scheduling/scheduled-job-dispatch.js";
import { cancelRemoteRun, lookupPeerDispatch } from "../acp-gateway.js";
import { hasConfirmedWorkerAttemptExit } from "../acp-registry.js";
import { verifyMissionSubmission } from "../mission-verifier.js";
import { missionVerificationOptionsFromConfig } from "../bridge/verification-options.js";
import { evaluateSupervisorMission } from "../supervisor-evaluator.js";
import type { ServerConfig } from "../config.js";
import { normalizeWorkspaceSnapshotIdentity } from "../review-checkpoints.js";

function submissionSnapshotFields(submission?: { snapshotKind?: "git" | "filesystem"; snapshotRef?: string; snapshotCommit?: string }) {
  const identity = submission ? normalizeWorkspaceSnapshotIdentity(submission) : undefined;
  return identity
    ? { snapshotKind: identity.kind, snapshotRef: identity.ref, snapshotCommit: identity.ref }
    : {};
}

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
  /** Server-owned database handle for the scheduler runtime's durable reads. */
  readonly database?: import("../db/client.js").DatabaseHandle;
}

export interface AcpRuntimeHandles {
  readonly dispatcher: ContinuationDispatcher;
  readonly supervisorRuntime: SupervisorRuntime;
  readonly replyDispatcher: import("../bridge/reply-dispatcher.js").ReplyDispatcher;
  readonly scheduledJobRuntime?: import("../scheduling/scheduled-job-runtime.js").ScheduledJobRuntime;
  readonly reconcileScheduledJob: (jobId: string) => Promise<import("../scheduling/scheduled-job-store.js").ScheduledJob | undefined>;
}

export function createAcpRuntime(deps: AcpRuntimeDeps): AcpRuntimeHandles {
  const { config, bridge, reviewWorkflow, recordPhaseTiming, database } = deps;
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
    scheduledJobs,
  } = bridge;
  let supervisorRuntime: SupervisorRuntime | undefined;
  let scheduledJobRuntime: import("../scheduling/scheduled-job-runtime.js").ScheduledJobRuntime | undefined;
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
    serverConfig: config,
    liveWaiters,
    scheduledJobs,
    reconcileScheduledJob: undefined,
    onScheduledJobCreated: () => scheduledJobRuntime?.wake(),
  };
  const dispatcher = createContinuationDispatcher(bridgeBase);
  dispatcher.start();
  const replyDispatcher = createReplyDispatcher(bridgeBase);
  replyDispatcher.start();
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
        ...missionVerificationOptionsFromConfig(config),
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
        ...submissionSnapshotFields(latest),
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
      const packet = missionLedger.getPacket(workSessionId, latest?.id ? { submissionId: latest.id, ...submissionSnapshotFields(latest), reviewEpoch: latest.reviewEpoch } : undefined);
      const currentEvidence = packet.evidence.filter((entry) => !latest?.id || entry.submissionId === latest.id);
      const failedEvidence = currentEvidence.filter((entry) => entry.status === "failed");
      const effectiveStatus = new Map(packet.criterionStates.map((criterion) => [criterion.criterionId, criterion.status]));
      const failureSet = failedEvidence.map((entry) => {
        const details = typeof entry.details === "object" && entry.details ? entry.details as Record<string, unknown> : {};
        return { command: entry.command, failureSetSha256: details.failureSetSha256, outputSha256: details.outputSha256, status: entry.status };
      });
      const summary = latest?.summaryJson ? (() => { try { return JSON.parse(latest.summaryJson) as { files?: number }; } catch { return {}; } })() : {};
      return {
        blockingFindingCount: packet.findings.filter((finding) => finding.scope !== "out_of_scope" && ["blocker", "high"].includes(finding.severity) && !["verified_resolved", "waived"].includes(finding.status)).length,
        failedCriterionCount: packet.criteria.filter((criterion) => criterion.priority === "required" && effectiveStatus.get(criterion.id) === "failed").length,
        passedCriterionCount: packet.criterionStates.filter((criterion) => criterion.status === "verified").length,
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
      // L02/L03: the configured review-round maximum is a hard ceiling on
      // automatic correction-driven submissions. When the route budget is
      // exhausted (or the route is paused/disabled), the supervisor must not
      // dispatch another correction; the run escalates to human intervention
      // instead of silently exceeding the user's chosen limit.
      if (bridge.reviewRoutes) {
        const route = bridge.reviewRoutes.getRouteBySession(workSessionId);
        if (route && (route.status !== "active" || route.completedReviewRounds >= route.maxReviewRounds)) {
          const reason = route.status !== "active"
            ? `Review loop is ${route.status}; automatic corrections are stopped.`
            : `Review round budget exhausted (${route.completedReviewRounds}/${route.maxReviewRounds}); automatic corrections are stopped.`;
          eventStore.appendEvent({ type: "review.loop.correction_blocked", sessionId: workSessionId, payload: { routeId: route.id, status: route.status, completedReviewRounds: route.completedReviewRounds, maxReviewRounds: route.maxReviewRounds } });
          throw new Error(`Automatic correction blocked: ${reason}`);
        }
      }
      const packet = missionLedger.getPacket(workSessionId);
      const effectiveStatus = new Map(packet.criterionStates.map((criterion) => [criterion.criterionId, criterion.status]));
      const failedCriteria = packet.criteria.filter((criterion) => criterion.priority === "required" && effectiveStatus.get(criterion.id) !== "verified");
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
        invocationOrigin: "internal_supervisor",
        reviewerId: "supervisor-runtime",
      });
    },
    currentSubmission: (workSessionId) => {
      const session = workSessions.get(workSessionId);
      if (session?.status !== "awaiting_review") return undefined;
      const submission = session.latestSubmission;
      return submission?.id ? { id: submission.id, ...submissionSnapshotFields(submission), reviewEpoch: submission.reviewEpoch } : undefined;
    },
    currentSessionStatus: (workSessionId) => workSessions.get(workSessionId)?.status,
    currentApproval: (workSessionId) => {
      const latest = workSessions.get(workSessionId)?.latestSubmission;
      return missionLedger.canApprove(workSessionId, latest?.id ? { submissionId: latest.id, ...submissionSnapshotFields(latest), reviewEpoch: latest.reviewEpoch } : {});
    },
    onApprove: async (workSessionId) => {
      const session = workSessions.get(workSessionId);
      const latest = session?.latestSubmission;
      if (!session || !latest?.id) throw new Error("Cannot automatically approve without a current submission.");
      const approval = missionLedger.canApprove(workSessionId, { submissionId: latest.id, ...submissionSnapshotFields(latest), reviewEpoch: latest.reviewEpoch });
      if (!approval.allowed) throw new Error(`Automatic approval blocked: ${approval.reasons.join("; ")}`);
      await reviewWorkflow.provideFeedback({
        sessionId: workSessionId,
        submissionId: latest.id,
        diffSha256: latest.diffSha256,
        reviewEpoch: latest.reviewEpoch,
        verdict: "approve",
        comments: "Automatically approved after current trusted mission verification.",
        invocationOrigin: "internal_supervisor",
        reviewerId: "supervisor-runtime",
        completionReportSha256: missionLedger.getCompletionReportHash(workSessionId, { submissionId: latest.id, ...submissionSnapshotFields(latest), reviewEpoch: latest.reviewEpoch }),
      });
    },
  });
  supervisorRuntime.start();

  // S02: durable scheduling. The scheduler triggers the canonical ACP dispatch
  // path for due jobs; it never becomes a second supervisor.
  if (scheduledJobs) {
    if (!database) throw new Error("Scheduled-job runtime requires the server database handle.");
    scheduledJobRuntime = createScheduledJobRuntime({
      database,
      jobs: scheduledJobs,
      events: eventStore,
      dispatchOutbox,
      dispatch: async (jobId, attempt) => {
        const job = scheduledJobs.get(jobId);
        if (!job) return { status: "failed" as const, reason: `Unknown scheduled job: ${jobId}` };
        const outcome = await dispatchScheduledJob(bridgeBase, scheduledJobs, job, {
          dispatchId: attempt.dispatchId,
        });
        if (outcome.workSessionId) {
          // The server-owned scheduled lifecycle projection consumes events
          // independently of this dispatch request's lifetime.
        }
        return {
          status: outcome.status,
          workSessionId: outcome.workSessionId,
          runId: outcome.runId,
          remoteRunId: outcome.remoteRunId,
          attemptNumber: outcome.attemptNumber,
          dispatchId: attempt.dispatchId,
          executionReceipt: outcome.executionReceipt,
          reason: outcome.reason,
        };
      },
      reconcileDispatch: async (input) => {
        const attempt = agentRegistry.getDispatchAttemptByIdempotencyKey(input.dispatchId);
        if (!attempt) {
          return { status: "operator_intervention", reason: `No durable ACP attempt is bound to dispatch ${input.dispatchId}.` };
        }
        const scheduledJob = scheduledJobs.get(input.jobId);
        const scheduledAttempt = scheduledJobs.getAttempt(input.jobId, input.dispatchAttemptId);
        const readOnlyAudit = scheduledJob?.executionMode === "read_only_audit";
        const expectedReceipt = readOnlyAudit ? {
          workSessionId: scheduledJob.workSessionId,
          workspaceSessionId: scheduledJob.projectId,
          parentRunId: attempt.runId,
          attemptNumber: attempt.attemptNumber ?? 1,
          dispatchIdempotencyKey: attempt.dispatchIdempotencyKey,
        } : undefined;
        const run = agentRegistry.getRun(attempt.runId);
        if (!run) return { status: "operator_intervention", reason: `ACP run ${attempt.runId} for dispatch ${input.dispatchId} is missing.` };
        const terminalStatus = (status: string): "completed" | "failed" | "cancelled" | undefined => {
          if (status === "approved") return "completed";
          if (status === "rejected" || status === "failed" || status === "failed_protocol") return "failed";
          if (status === "cancelled") return "cancelled";
          return undefined;
        };
        const terminal = terminalStatus(run.status);
        if (terminal) return {
          status: "terminal",
          terminalStatus: terminal,
          workSessionId: run.workSessionId,
          runId: run.runId,
          remoteRunId: attempt.remoteRunId,
          dispatchId: attempt.dispatchIdempotencyKey,
          attemptNumber: attempt.attemptNumber,
          executionReceipt: scheduledAttempt?.executionReceipt as import("../acp-gateway.js").ReadOnlyExecutionReceipt | undefined,
        };
        if (attempt.status === "unstarted") return { status: "unstarted", reason: run.errorMessage };
        if (attempt.status === "rejected") return { status: "terminal", terminalStatus: "failed", workSessionId: run.workSessionId, runId: run.runId, reason: run.errorMessage };
        if (attempt.status === "accepted") {
          if (run.status === "created" || run.status === "dispatch_uncertain" || run.status === "resuming") {
            agentRegistry.updateRun(run.runId, { status: "running", remoteRunId: attempt.remoteRunId });
          }
          if (!readOnlyAudit || scheduledAttempt?.executionReceipt) {
            return { status: "accepted", workSessionId: run.workSessionId, runId: run.runId, remoteRunId: attempt.remoteRunId, dispatchId: attempt.dispatchIdempotencyKey, attemptNumber: attempt.attemptNumber, executionReceipt: scheduledAttempt?.executionReceipt as import("../acp-gateway.js").ReadOnlyExecutionReceipt | undefined };
          }
        }

        const agent = attempt.agentId ? agentRegistry.get(attempt.agentId) : undefined;
        if (!agent) {
          const ageMs = Date.now() - Date.parse(attempt.createdAt);
          return ageMs >= 10 * 60_000
            ? { status: "operator_intervention", reason: `Registered adapter ${attempt.agentId ?? "(unknown)"} is unavailable for dispatch reconciliation.` }
            : { status: "unresolved", reason: `Registered adapter ${attempt.agentId ?? "(unknown)"} is unavailable; dispatch remains uncertain.` };
        }
        const lookup = await lookupPeerDispatch({
          agentUrl: agent.url,
          adapterSecret: config.acpAdapterSecret,
          dispatchIdempotencyKey: input.dispatchId,
          requireExecutionReceipt: readOnlyAudit,
          expectedReceipt,
        });
        if (lookup.status === "found") {
          agentRegistry.updateDispatchAttempt(input.dispatchId, { status: "accepted", remoteRunId: lookup.remoteRunId });
          if (run.status === "created" || run.status === "dispatch_uncertain" || run.status === "resuming") {
            agentRegistry.updateRun(run.runId, { status: "running", remoteRunId: lookup.remoteRunId });
          }
          return { status: "accepted", workSessionId: run.workSessionId, runId: run.runId, remoteRunId: lookup.remoteRunId, dispatchId: attempt.dispatchIdempotencyKey, attemptNumber: attempt.attemptNumber, executionReceipt: lookup.executionReceipt };
        }
        if (lookup.status === "unstarted") {
          agentRegistry.updateDispatchAttempt(input.dispatchId, { status: "unstarted" });
          return { status: "unstarted", reason: "Adapter lookup authoritatively confirmed no run was accepted." };
        }
        const ageMs = Date.now() - Date.parse(attempt.createdAt);
        return ageMs >= 10 * 60_000
          ? { status: "operator_intervention", reason: "Adapter has no authoritative dispatch record after ten minutes; automatic redelivery remains fenced." }
          : { status: "unresolved", reason: "Adapter lookup has not established whether the dispatch was accepted." };
      },
      reconcileCancellation: async (job) => {
        const requestId = job.cancellationRequestId;
        if (!requestId) return { state: "unknown", reason: "Cancellation has no durable request identity." };
        if (!job.workSessionId) {
          return { state: "unknown", reason: "No correlated work session is available; worker absence is unproven." };
        }
        const session = workSessions.get(job.workSessionId);
        const run = agentRegistry.getRunByWorkSessionId(job.workSessionId);
        if (session?.status === "cancelled" || run?.status === "cancelled") {
          return { state: "worker_cancelled", reason: "The correlated work session or run is durably cancelled." };
        }
        if (!session || !run) {
          return { state: "unknown", reason: "The correlated work session or ACP run is missing; worker absence is unproven." };
        }
        if (["approved", "rejected", "failed", "failed_protocol"].includes(run.status)) {
          return { state: "unknown", reason: `The ACP run is already terminal (${run.status}); waiting for lifecycle projection.` };
        }

        if (hasConfirmedWorkerAttemptExit(run, agentRegistry.getLatestDispatchAttemptForRun(run.runId))) {
          reviewWorkflow.cancelSession({ sessionId: session.id, reason: "scheduled job cancellation requested" });
          reviewWorkflow.finalizeCancellation({ sessionId: session.id, reason: "the current worker attempt had already exited" });
          return { state: "worker_stopped", reason: "The current worker attempt had already exited; the pending review was cancelled." };
        }

        reviewWorkflow.cancelSession({ sessionId: session.id, reason: "scheduled job cancellation requested" });
        if (!run.remoteRunId) {
          const attempt = agentRegistry.getLatestDispatchAttemptForRun(run.runId);
          if (attempt && ["unstarted", "rejected"].includes(attempt.status)) {
            return { state: "not_dispatched", reason: "The durable dispatch attempt confirms the adapter did not accept a run." };
          }
          return { state: "unknown", reason: "Remote run identity is unavailable while dispatch may still be active." };
        }
        const remote = await cancelRemoteRun({
          agentRegistry,
          workspaces,
          workSessions,
          adapterSecret: config.acpAdapterSecret,
        }, run);
        if (remote.status === 404) {
          return {
            state: "unknown",
            reason: "The adapter reports no active run; a durable terminal event is still required to confirm worker shutdown.",
          };
        }
        return remote.acknowledged
          ? { state: "termination_acknowledged", reason: "Adapter acknowledged termination; waiting for the durable worker-cancelled event." }
          : { state: "unknown", reason: `Remote worker state is unknown because termination was not confirmed: ${remote.error ?? "adapter unavailable"}` };
      },
    });
    scheduledJobRuntime.start();
  }

  return {
    dispatcher,
    supervisorRuntime,
    replyDispatcher,
    scheduledJobRuntime,
    reconcileScheduledJob: (jobId) => scheduledJobRuntime?.reconcileJob(jobId) ?? Promise.resolve(undefined),
  };
}
