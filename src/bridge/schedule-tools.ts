/**
 * Durable scheduled-job MCP tools.
 *
 * These tools create/read bounded one-shot jobs. They do not grant arbitrary
 * shell authority; execution policy is enforced by signed ACP grants and the
 * worker's operating-system sandbox.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig } from "./context.js";
import { registerMutationAppTool } from "./app-tool.js";
import { forbidden, isReviewer, liveOwnerContextId, requireWorkSessionMutation } from "./shared.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { createScheduledJobStore, schedulingOperation } from "../scheduling/scheduled-job-store.js";
import type { ScheduledJob, ScheduledJobStore } from "../scheduling/scheduled-job-store.js";
import { randomUUID } from "node:crypto";
import { cancelRemoteRun } from "../acp-gateway.js";
import { hasConfirmedWorkerAttemptExit } from "../acp-registry.js";
import { parseScheduledVerificationCommand } from "../scheduling/verification-profiles.js";
import { verifyScheduledJob } from "../scheduling/scheduled-verification.js";
import { projectScheduledVerification, scheduledVerificationFingerprints } from "../scheduling/scheduled-verification-projection.js";
import { z } from "zod/v4";

function scheduledJobStore(config: BridgeConfig): ScheduledJobStore | undefined {
  return config.scheduledJobs;
}

export function scheduledJobAccessAllowed(
  job: Pick<ScheduledJob, "principalId" | "ownerContextId">,
  identity: { authenticatedPrincipalId?: string; ownerContextId: string },
): boolean {
  const principal = identity.authenticatedPrincipalId?.trim();
  return principal ? job.principalId === principal : job.ownerContextId === identity.ownerContextId;
}

export function sliceScheduledReportPage(text: string, offset: number, limit: number): { page: string; nextOffset?: number } {
  const points = Array.from(text);
  const start = Math.max(0, Math.min(points.length, offset - 1));
  const end = Math.min(points.length, start + limit);
  let bytes = 0;
  let cursor = start;
  for (; cursor < end; cursor += 1) {
    const nextBytes = Buffer.byteLength(points[cursor]!, "utf8");
    if (bytes + nextBytes > 48_000) break;
    bytes += nextBytes;
  }
  return { page: points.slice(start, cursor).join(""), ...(cursor < points.length ? { nextOffset: cursor + 1 } : {}) };
}

export function registerScheduleTools(server: McpServer, config: BridgeConfig): void {
  const jobs = scheduledJobStore(config);
  const authenticatedPrincipalId = config.connectionContext?.authenticatedPrincipalId?.trim();
  const ownerContextId = liveOwnerContextId(config) ?? config.principalId ?? "unknown-owner";
  const requireScheduledJobRead = (): { content: Array<{ type: "text"; text: string }>; isError: true } | undefined => {
    if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "scheduled_job_result_read");
    return undefined;
  };
  const mayReadJob = (job: ScheduledJob): boolean => scheduledJobAccessAllowed(job, {
    authenticatedPrincipalId,
    ownerContextId,
  });

  registerMutationAppTool(
    server,
    "schedule_job",
    {
      title: "Schedule bounded job",
      description: "Create a durable future job for a workspace. Current execution mode is read_only_audit; work is dispatched through the normal ACP path at the requested UTC time.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID from open_workspace."),
        runAt: z.string().datetime({ offset: true }).describe("UTC execution deadline."),
        instructions: z.string().trim().min(1).describe("Bounded task instructions."),
        executionMode: z.enum(["read_only_audit", "bounded_file_write"]).default("read_only_audit"),
        allowedOutputs: z.array(z.object({
          path: z.string().trim().min(1).max(1_024),
          operation: z.enum(["create", "replace"]),
          expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
          overwrite: z.enum(["deny", "expected_hash"]),
          expectedPreviousSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        })).max(8).optional(),
        maxRuntimeMinutes: z.number().int().min(1).max(24 * 60).default(90),
        verificationCommands: z.array(z.string().trim().min(1).max(1_024)).max(5).optional()
          .describe("Optional allowlisted tests to run later against a disposable copy of the submitted snapshot."),
        agentName: z.string().optional(),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: {
        scheduledJobId: z.string(),
        status: z.string(),
        revision: z.number(),
        runAt: z.string(),
      },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ workspaceId, runAt, instructions, executionMode, allowedOutputs, maxRuntimeMinutes, verificationCommands, agentName, clientMutationId }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "schedule_job");
      // A workspace ID is not a work-session ID. Authorization for scheduling
      // is reviewer role plus authenticated ownership of that workspace, which
      // is checked below after the workspace record is resolved.
      if (!liveOwnerContextId(config) && config.connectionContext) return forbidden(config.principalRole, "missing transport identity");
      if (!jobs) {
        return { content: [{ type: "text" as const, text: "Scheduled jobs are unavailable: the scheduler store is not configured." }], isError: true };
      }
      try {
        const checkedVerificationCommands = (verificationCommands ?? []).map((command: string) => {
          parseScheduledVerificationCommand(command);
          return command;
        });
        const outputs = executionMode === "bounded_file_write" ? (allowedOutputs ?? []) : [];
        if (executionMode === "bounded_file_write" && outputs.length === 0) {
          throw new Error("bounded_file_write requires at least one exact authorized output.");
        }
        if (executionMode !== "bounded_file_write" && allowedOutputs?.length) {
          throw new Error("allowedOutputs are only valid with bounded_file_write.");
        }
        for (const output of outputs) {
          if (output.path.includes("\\") || output.path.startsWith("/") || output.path.includes("..")) {
            throw new Error("Authorized output paths must be relative workspace paths.");
          }
          if (output.overwrite === "deny" && output.expectedPreviousSha256) {
            throw new Error("expectedPreviousSha256 requires overwrite=expected_hash.");
          }
          if (output.overwrite === "expected_hash" && !output.expectedPreviousSha256) {
            throw new Error("overwrite=expected_hash requires expectedPreviousSha256.");
          }
        }
        const workspace = config.workspaces.getWorkspace(workspaceId);
        // The workspace registry itself is the workspace authority here: only
        // registered allowlisted roots are addressable, and the authenticated
        // reviewer identity is recorded as the job owner rather than passing
        // a workspace ID into a work-session authorization helper.
        const job = jobs.create({
          principalId: authenticatedPrincipalId ?? `context:${ownerContextId}`,
          ownerContextId,
          projectId: workspace.id,
          workspaceRoot: workspace.root,
          runAt,
          instructionJson: { instructions },
          executionMode,
          policySnapshotJson: {
            ...(executionMode === "bounded_file_write"
              ? {
                workspaceAccess: "staged_write",
                mutate: true,
                allowedOutputs: outputs,
              }
              : {
                workspaceAccess: "read_only",
                mutate: false,
              }),
            verificationCommands: checkedVerificationCommands,
            verificationPolicy: {
              capability: "read_only_verification",
              sandboxRequired: true,
              network: "disabled",
              workspace: "disposable_submitted_snapshot",
              maxCommands: 5,
              maxRuntimeMs: Math.min(maxRuntimeMinutes * 60_000, 15 * 60_000),
              maxOutputBytes: 20_000,
            },
          },
          agentName,
          maxRuntimeMs: maxRuntimeMinutes * 60_000,
          clientMutationId,
        });
        config.onScheduledJobCreated?.();
        return {
          content: [{ type: "text" as const, text: `Scheduled job ${job.id} for ${job.runAt}.` }],
          structuredContent: { scheduledJobId: job.id, status: job.status, revision: job.revision, runAt: job.runAt },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  );

  const readTool = (name: string, title: string, description: string) => {
    // Read tools are registered inline to avoid mutating receipts.
    registerAppTool(server, name as any, {
      title,
      description,
      inputSchema: {
        scheduledJobId: z.string(),
        ...(name === "get_scheduled_job_result" ? {
          reportOffset: z.number().int().positive().optional(),
          reportLimit: z.number().int().positive().max(48_000).optional(),
          reportSha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Immutable report identity returned by the first page."),
        } : {}),
      },
      outputSchema: {
        scheduledJobId: z.string(),
        status: z.string(),
        revision: z.number(),
        runAt: z.string().optional(),
        workSessionId: z.string().optional(),
        lastError: z.string().optional(),
        outputPreview: z.string().optional(),
        ...(name === "get_scheduled_job_result" ? {
          resultReceipt: z.object({
            jobId: z.string(),
            dispatchId: z.string().optional(),
            workSessionId: z.string().optional(),
            runId: z.string().optional(),
            agentIdentity: z.string().optional(),
            startedAt: z.string().optional(),
            executionTerminalAt: z.string().optional(),
            terminalAt: z.string().optional(),
            blockedAt: z.string().optional(),
            operatorInterventionAt: z.string().optional(),
            lastStateChangedAt: z.string().optional(),
            scheduledJobStatus: z.string(),
            executionStatus: z.string(),
            reportAvailability: z.enum(["available", "pending_finalization", "no_output", "unavailable"]),
            workerStatus: z.enum(["not_started", "running", "completed", "failed", "failed_protocol", "cancelled"]),
            publicationStatus: z.enum(["pending", "committed", "failed", "not_applicable"]),
            outcomeObserved: z.boolean(),
            dispatchStatus: z.string().optional(),
            dispatchRetryCount: z.number().int().nonnegative(),
            dispatchNextEligibleAt: z.string().optional(),
            dispatchAttempts: z.array(z.object({
              attemptId: z.string(),
              dispatchId: z.string(),
              startedAt: z.string(),
              completedAt: z.string().optional(),
              selectedAgent: z.string().optional(),
              transportStatus: z.string(),
              runId: z.string().optional(),
              attemptNumber: z.number().int().optional(),
              failureClass: z.string().optional(),
              failureReason: z.string().optional(),
              probeResult: z.record(z.string(), z.unknown()).optional(),
              nextEligibleAt: z.string().optional(),
            })),
            reviewStatus: z.string(),
            verificationStatus: z.enum(["passed", "failed", "inconclusive", "not_performed"]),
            workerCompleted: z.boolean(),
            workerExecutionOutcome: z.enum(["completed", "failed", "failed_protocol", "cancelled"]).optional(),
            workerExecutionAt: z.string().optional(),
            workerFailureEvidence: z.object({
              phase: z.enum(["admission", "spawn", "execution", "reporting"]),
              category: z.string(),
              exitCode: z.number().int().optional(),
              signal: z.string().optional(),
              sanitizedStderrTail: z.string().optional(),
              eventId: z.string().optional(),
              runId: z.string(),
              attemptNumber: z.number().int().positive(),
            }).optional(),
            reviewApproved: z.boolean(),
            verificationLevel: z.enum(["not_performed", "implementation", "integration", "outcome", "operational"]),
            independentOutcomeObserved: z.boolean(),
            verificationEvidenceIds: z.array(z.string()),
            verificationReportSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
            verificationResults: z.array(z.object({
              criterionId: z.string(), command: z.string(), status: z.enum(["passed", "failed", "inconclusive"]),
              exitCode: z.number().nullable(), signal: z.string().nullable(), durationMs: z.number(), outputTail: z.string(),
              outputSha256: z.string(), failureSetSha256: z.string(),
            })),
            executionReceipt: z.object({
              issuer: z.literal("kontrol"),
              work_session_id: z.string(),
              workspace_session_id: z.string(),
              parent_run_id: z.string(),
              remote_run_id: z.string(),
              attempt_number: z.number().int().positive(),
              dispatch_idempotency_key: z.string(),
              grant_expires_at: z.number().int().positive(),
              grant_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
              network_policy: z.enum(["disabled", "host"]),
              confinement: z.enum(["bubblewrap-read-only-workspace-no-network", "bubblewrap-read-only-workspace-host-network"]),
            }).optional(),
            resultSnapshot: z.object({
              submissionId: z.string().optional(),
              snapshotKind: z.string().optional(),
              snapshotRef: z.string().optional(),
              reviewEpoch: z.number().optional(),
            }),
            verificationBlockers: z.array(z.string()),
            unresolvedBlockers: z.array(z.string()),
            reportFinalizationStatus: z.enum(["pending", "completed"]).optional(),
            reportFinalizationError: z.string().optional(),
            snapshotKind: z.string().optional(),
            snapshotRef: z.string().optional(),
            error: z.string().optional(),
            artifactReferences: z.array(z.object({
              kind: z.string(),
              id: z.string(),
              sha256: z.string().optional(),
              snapshotKind: z.string().optional(),
              snapshotRef: z.string().optional(),
            })),
          }),
          report: z.string().optional(),
          reportSha256: z.string().optional(),
          reportOffset: z.number().int().optional().describe("One-based Unicode code point offset."),
          reportNextOffset: z.number().int().optional().describe("One-based Unicode code point offset for the next page."),
          reportTruncated: z.boolean().optional(),
        } : {}),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    } as any, async (input: unknown) => {
      const { scheduledJobId, reportOffset, reportLimit, reportSha256: requestedReportSha256 } = input as { scheduledJobId?: string; reportOffset?: number; reportLimit?: number; reportSha256?: string };
      if (!scheduledJobId) {
        return { content: [{ type: "text" as const, text: "Missing scheduledJobId." }], isError: true };
      }
      if (!jobs) {
        return { content: [{ type: "text" as const, text: "Scheduled jobs are unavailable." }], isError: true };
      }
      const job = jobs.get(scheduledJobId);
      if (!job) {
        return { content: [{ type: "text" as const, text: `Unknown scheduled job: ${scheduledJobId}` }], isError: true };
      }
      const roleAccess = requireScheduledJobRead();
      if (roleAccess) return roleAccess;
      if (!mayReadJob(job)) {
        return forbidden(config.principalRole, name);
      }
      if (name === "get_scheduled_job_result" && (reportOffset ?? 1) > 1 && !requestedReportSha256) {
        return { content: [{ type: "text" as const, text: "Later report pages require the reportSha256 returned by the first page." }], isError: true };
      }
      const run = job.workSessionId ? config.agentRegistry.getRunByWorkSessionId(job.workSessionId) : undefined;
      const attempt = jobs.getAttempt(job.id);
      const session = job.workSessionId ? config.workSessions.get(job.workSessionId) : undefined;
      let reportArtifact;
      if (requestedReportSha256) {
        reportArtifact = jobs.getReport(job.id, requestedReportSha256);
        if (!reportArtifact) {
          return { content: [{ type: "text" as const, text: "The requested immutable report artifact is unavailable." }], isError: true };
        }
      } else if (attempt?.acpRunId && attempt.acpAttemptNumber) {
        reportArtifact = jobs.getReportForAttempt(job.id, attempt.acpRunId, attempt.acpAttemptNumber);
      }
      const reportText = reportArtifact?.reportText ?? "";
      const outputPreview = reportText.slice(0, 2_000) || undefined;
      const resultReceipt = name === "get_scheduled_job_result" ? (() => {
        const latest = session?.latestSubmission;
        const snapshotKind = latest?.snapshotKind;
        const snapshotRef = latest?.snapshotRef ?? latest?.snapshotCommit;
        let mission;
        let missionLedgerUnavailable = false;
        if (session && config.missionLedger) {
          try {
            mission = config.missionLedger.getResultReceipt(session.id, latest ? {
              submissionId: latest.id,
              snapshotKind,
              snapshotRef,
              snapshotCommit: latest.snapshotCommit,
              reviewEpoch: latest.reviewEpoch,
            } : undefined);
          } catch {
            // The execution receipt is backed by the scheduled-job and ACP
            // ledgers. A mission projection failure must not make that
            // operational receipt unreadable or imply that verification ran.
            missionLedgerUnavailable = true;
          }
        }
        const completionReport = mission?.completionReport;
        const fingerprints = scheduledVerificationFingerprints({ policySnapshotJson: job.policySnapshotJson, serverConfig: config.serverConfig });
        const scheduledVerification = latest && session
          ? jobs.getLatestVerificationExecution({
              jobId: job.id,
              workSessionId: session.id,
              submissionId: latest.id,
              reviewEpoch: latest.reviewEpoch,
              snapshotKind: (snapshotKind ?? "git") as "git" | "filesystem",
              snapshotRef: snapshotRef ?? "",
              commandFingerprint: fingerprints.commandFingerprint,
              policyFingerprint: fingerprints.policyFingerprint,
            })
          : undefined;
        const verification = projectScheduledVerification({ mission, scheduled: scheduledVerification });
        const finalization = attempt?.acpRunId && attempt.acpAttemptNumber
          ? jobs.getReportFinalization(job.id, attempt.acpRunId, attempt.acpAttemptNumber)
          : undefined;
        const reportAvailability = reportArtifact
          ? "available"
          : finalization?.status === "pending" ? "pending_finalization"
            : finalization?.status === "no_output" ? "no_output"
              : !finalization && attempt
                && (attempt.transportStatus === "accepted" || attempt.transportStatus === "uncertain" || attempt.executionActiveSince)
                  ? "pending_finalization"
                  : "unavailable";
        const reviewStatus = !session ? "not_started"
          : session.status === "approved" ? "approved"
            : session.status === "rejected" ? "rejected"
              : session.status === "cancelled" ? "cancelled"
                : session.status === "failed" || session.status === "failed_protocol" ? "failed"
                  : session.status === "awaiting_review" || session.status === "in_review" || session.status === "review_in_progress" ? "pending"
                    : session.status === "changes_requested" ? "changes_requested"
                      : latest ? "pending" : "not_submitted";
        const artifactReferences: Array<{ kind: string; id: string; sha256?: string; snapshotKind?: string; snapshotRef?: string }> = [];
        const reportSha256 = reportArtifact?.reportSha256;
        if (reportArtifact && reportSha256) artifactReferences.push({ kind: "acp_run_output", id: reportArtifact.runId, sha256: reportSha256 });
        if (latest) artifactReferences.push({
          kind: "work_session_submission",
          id: latest.id,
          sha256: latest.diffSha256,
          snapshotKind,
          snapshotRef,
        });
        if (completionReport) artifactReferences.push({
          kind: "mission_completion_report",
          id: completionReport.id,
          sha256: completionReport.reportSha256,
          snapshotKind: completionReport.snapshotKind,
          snapshotRef: completionReport.snapshotRef,
        });
        for (const evidence of mission?.evidence ?? []) artifactReferences.push({ kind: "mission_evidence", id: evidence.id, sha256: evidence.outputDigest, snapshotKind: evidence.snapshotKind, snapshotRef: evidence.snapshotRef });
        if (scheduledVerification) artifactReferences.push({
          kind: "scheduled_verification_report",
          id: scheduledVerification.executionIdentity,
          sha256: scheduledVerification.reportSha256,
          snapshotKind: scheduledVerification.snapshotKind,
          snapshotRef: scheduledVerification.snapshotRef,
        });
        const executionStatus = attempt?.workerExecutionOutcome
          ?? (attempt?.transportStatus === "rejected" ? "dispatch_rejected"
            : attempt?.transportStatus === "uncertain" ? "dispatch_uncertain"
              : attempt?.transportStatus === "unstarted" ? "not_started"
                : attempt?.executionActiveSince ? "running"
                  : attempt?.executionStartedAt ? "stopped"
                    : attempt?.transportStatus === "accepted" ? "accepted"
                      : job.status);
        const workerFailureEvidence = jobs.getWorkerFailureEvidence?.(job.id);
        const unresolvedBlockers = [...verification.unresolvedBlockers];
        const reportOnlyVerificationBlocker = !latest && session && job.executionMode === "read_only_audit"
          ? "Scheduled verification is unavailable for this report-only audit because no submitted immutable snapshot exists."
          : undefined;
        if (reportOnlyVerificationBlocker) unresolvedBlockers.push(reportOnlyVerificationBlocker);
        if (missionLedgerUnavailable) {
          unresolvedBlockers.push("Mission evidence is unavailable because the mission ledger could not be read.");
        }
        if (finalization?.status === "pending") {
          unresolvedBlockers.push(finalization.lastError
            ? `Worker report finalization is pending: ${finalization.lastError}`
            : "Worker report finalization is pending.");
        }
        return {
          receipt: {
            jobId: job.id,
            dispatchId: attempt?.dispatchId,
            workSessionId: job.workSessionId,
            runId: run?.runId ?? attempt?.acpRunId,
            agentIdentity: run?.agentName ?? attempt?.agentName ?? job.agentName,
            startedAt: attempt?.startedAt,
            executionTerminalAt: attempt?.workerExecutionAt,
            dispatchStatus: attempt?.transportStatus,
            dispatchRetryCount: job.dispatchRetryCount,
            dispatchNextEligibleAt: job.dispatchNextEligibleAt,
            dispatchAttempts: jobs.listDispatchAttempts?.(job.id, 50) ?? [],
            terminalAt: ["completed", "failed", "cancelled"].includes(job.status) ? job.terminalAt : undefined,
            blockedAt: job.blockedAt,
            operatorInterventionAt: job.operatorInterventionAt,
            lastStateChangedAt: job.lastStateChangedAt,
            scheduledJobStatus: job.status,
            executionStatus,
            reportAvailability,
            workerStatus: attempt?.workerExecutionOutcome ?? (attempt?.executionActiveSince ? "running" : "not_started"),
            publicationStatus: job.executionMode === "bounded_file_write"
              ? (attempt?.publicationReceipts?.some((r) => r.outcome === "committed")
                ? "committed"
                : attempt?.publicationReceipts?.some((r) => r.outcome === "conflict" || r.outcome === "rejected")
                  ? "failed"
                  : "pending")
              : "not_applicable",
            outcomeObserved: job.executionMode === "bounded_file_write"
              ? (attempt?.publicationReceipts?.some((r) => r.outcome === "committed" && r.readBackVerified === true) ?? false)
              : verification.independentOutcomeObserved,
            workerExecutionOutcome: attempt?.workerExecutionOutcome,
            workerExecutionAt: attempt?.workerExecutionAt,
            workerFailureEvidence,
            reviewStatus,
            verificationStatus: verification.verificationStatus,
            workerCompleted: attempt?.workerExecutionOutcome === "completed",
            reviewApproved: session?.status === "approved",
            verificationLevel: verification.verificationLevel,
            independentOutcomeObserved: verification.independentOutcomeObserved,
            verificationEvidenceIds: verification.verificationEvidenceIds,
            verificationReportSha256: verification.verificationReportSha256,
            verificationResults: verification.verificationResults,
            ...(attempt?.executionReceipt ? { executionReceipt: attempt.executionReceipt } : {}),
            resultSnapshot: {
              submissionId: latest?.id,
              snapshotKind,
              snapshotRef,
              reviewEpoch: latest?.reviewEpoch,
            },
            verificationBlockers: reportOnlyVerificationBlocker
              ? [...verification.verificationBlockers, reportOnlyVerificationBlocker]
              : verification.verificationBlockers,
            unresolvedBlockers,
            ...(finalization ? {
              reportFinalizationStatus: finalization.status,
              ...(finalization.lastError ? { reportFinalizationError: finalization.lastError } : {}),
            } : {}),
            snapshotKind,
            snapshotRef,
            error: job.lastError ?? run?.errorMessage,
            artifactReferences,
          },
          reportSha256,
        };
      })() : undefined;
      const reportStart = reportOffset ?? 1;
      const reportPageLimit = Math.max(1, Math.min(48_000, reportLimit ?? 48_000));
      const reportPageData = resultReceipt ? sliceScheduledReportPage(reportText, reportStart, reportPageLimit) : undefined;
      const reportPage = reportPageData?.page;
      const reportNextOffset = reportPageData?.nextOffset;
      return {
        content: [{ type: "text" as const, text: `${job.id}: ${job.status}` }],
        structuredContent: {
          scheduledJobId: job.id,
          status: job.status,
          revision: job.revision,
          runAt: job.runAt,
          workSessionId: job.workSessionId,
          lastError: job.lastError,
          outputPreview,
          ...(resultReceipt ? {
            resultReceipt: resultReceipt.receipt,
            report: reportPage,
            reportSha256: resultReceipt.reportSha256,
            reportOffset: reportStart,
            ...(reportNextOffset ? { reportNextOffset } : {}),
            reportTruncated: reportNextOffset !== undefined,
          } : {}),
        },
      };
    });
  };

  readTool("get_scheduled_job", "Get scheduled job", "Retrieve a durable scheduled job by ID.");
  readTool("get_scheduled_job_result", "Get scheduled job result", "Retrieve the current scheduled-job correlation and terminal outcome.");

  registerAppTool(server, "verify_scheduled_job", {
    title: "Run scheduled verification",
    description: "Run the job's predeclared allowlisted tests against a disposable copy of its exact submitted snapshot. Requires Linux bubblewrap; network access is disabled and the checkout stays unchanged.",
    inputSchema: { scheduledJobId: z.string(), clientMutationId: z.string().min(1).max(200).optional() },
    outputSchema: {
      scheduledJobId: z.string(),
      executionId: z.string(),
      executionIdentity: z.string(),
      status: z.enum(["running", "completed", "failed"]),
      reused: z.boolean(),
      verificationReportSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      submissionId: z.string().optional(),
      snapshotKind: z.enum(["git", "filesystem"]).optional(),
      snapshotRef: z.string().optional(),
      failureReason: z.string().optional(),
      results: z.array(z.object({
        criterionId: z.string(), command: z.string(), status: z.enum(["passed", "failed", "inconclusive"]),
        exitCode: z.number().nullable(), signal: z.string().nullable(), durationMs: z.number(),
        outputTail: z.string(), outputSha256: z.string(), failureSetSha256: z.string(),
      })).optional(),
    },
    _meta: {},
    annotations: { readOnlyHint: false, destructiveHint: false },
  } as any, async (input: unknown) => {
    if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "verify_scheduled_job");
    if (!jobs || !config.workSessions || !config.workspaces || !config.reviewCheckpoints) {
      return { content: [{ type: "text" as const, text: "Scheduled verification is unavailable: required workspace services are not configured." }], isError: true };
    }
    const value = input as { scheduledJobId?: string; clientMutationId?: string } | undefined;
    const scheduledJobId = value?.scheduledJobId;
    if (!scheduledJobId) return { content: [{ type: "text" as const, text: "Missing scheduledJobId." }], isError: true };
    const job = jobs.get(scheduledJobId);
    if (!job) return { content: [{ type: "text" as const, text: `Unknown scheduled job: ${scheduledJobId}` }], isError: true };
    if (!mayReadJob(job)) return forbidden(config.principalRole, "verify_scheduled_job");
    try {
      const verification = await verifyScheduledJob({
        job,
        jobs,
        workSessions: config.workSessions,
        workspaces: config.workspaces,
        reviewCheckpoints: config.reviewCheckpoints,
        serverConfig: config.serverConfig,
        clientMutationId: value?.clientMutationId,
      });
      const report = verification.report;
      const passed = report?.results.filter((result) => result.status === "passed").length ?? 0;
      const resultCount = report?.results.length ?? 0;
      return {
        content: [{ type: "text" as const, text: verification.status === "running"
          ? `Scheduled verification ${verification.executionIdentity} is already running.`
          : verification.status === "failed" && !report
            ? `Scheduled verification failed: ${verification.failureReason ?? "no failure detail"}`
            : `${passed}/${resultCount} verification commands passed${verification.reused ? " (existing execution)" : ""}.` }],
        structuredContent: {
          scheduledJobId: job.id,
          executionId: verification.executionId,
          executionIdentity: verification.executionIdentity,
          status: verification.status,
          reused: verification.reused,
          ...(verification.reportSha256 ? { verificationReportSha256: verification.reportSha256 } : {}),
          ...(report ? {
            submissionId: report.submissionId,
            snapshotKind: report.snapshotKind,
            snapshotRef: report.snapshotRef,
            results: report.results.map((result) => ({ ...result, outputTail: result.outputTail.slice(-2_000) })),
          } : {}),
          ...(verification.failureReason ? { failureReason: verification.failureReason } : {}),
        },
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  registerAppTool(server, "get_scheduled_job_verification", {
    title: "Get scheduled verification report",
    description: "Read a persisted verification receipt by its report hash, with bounded pagination across the immutable report.",
    inputSchema: {
      scheduledJobId: z.string(),
      reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
      reportOffset: z.number().int().positive().optional(),
      reportLimit: z.number().int().positive().max(48_000).optional(),
    },
    outputSchema: {
      scheduledJobId: z.string(), reportSha256: z.string(), reportOffset: z.number(), report: z.string(), reportTruncated: z.boolean(), reportNextOffset: z.number().optional(),
    },
    _meta: {},
    annotations: { readOnlyHint: true },
  } as any, async (input: unknown) => {
    if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "get_scheduled_job_verification");
    if (!jobs) return { content: [{ type: "text" as const, text: "Scheduled verification reports are unavailable." }], isError: true };
    const value = input as { scheduledJobId?: string; reportSha256?: string; reportOffset?: number; reportLimit?: number } | undefined;
    const job = value?.scheduledJobId ? jobs.get(value.scheduledJobId) : undefined;
    if (!job || !value?.reportSha256) return { content: [{ type: "text" as const, text: "Unknown scheduled job or missing verification report identity." }], isError: true };
    if (!mayReadJob(job)) return forbidden(config.principalRole, "get_scheduled_job_verification");
    const artifact = jobs.getVerificationReport(job.id, value.reportSha256);
    if (!artifact?.reportText) {
      return { content: [{ type: "text" as const, text: "Unknown scheduled verification report." }], isError: true };
    }
    const offset = value.reportOffset ?? 1;
    const { page, nextOffset } = sliceScheduledReportPage(artifact.reportText, offset, value.reportLimit ?? 48_000);
    return {
      content: [{ type: "text" as const, text: `${job.id}: verification report ${artifact.reportSha256}` }],
      structuredContent: {
        scheduledJobId: job.id,
        reportSha256: artifact.reportSha256,
        reportOffset: offset,
        report: page,
        reportTruncated: nextOffset !== undefined,
        ...(nextOffset ? { reportNextOffset: nextOffset } : {}),
      },
    };
  });

  registerAppTool(server, "reconcile_scheduled_job", {
    title: "Reconcile uncertain scheduled job",
    description: "Ask the scheduler to inspect the original adapter receipt for an operator-intervention job. This never launches a worker.",
    inputSchema: { scheduledJobId: z.string() },
    outputSchema: { scheduledJobId: z.string(), status: z.string(), revision: z.number(), lastError: z.string().optional() },
    _meta: {},
    annotations: { readOnlyHint: false },
  } as any, async (input: unknown) => {
    if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "reconcile_scheduled_job");
    if (!jobs || !config.reconcileScheduledJob) {
      return { content: [{ type: "text" as const, text: "Scheduled-job reconciliation is unavailable." }], isError: true };
    }
    const scheduledJobId = (input as { scheduledJobId?: string } | undefined)?.scheduledJobId;
    if (!scheduledJobId) return { content: [{ type: "text" as const, text: "Missing scheduledJobId." }], isError: true };
    const before = jobs.get(scheduledJobId);
    if (!before) return { content: [{ type: "text" as const, text: `Unknown scheduled job: ${scheduledJobId}` }], isError: true };
    if (!mayReadJob(before)) return forbidden(config.principalRole, "reconcile_scheduled_job");
    if (before.status !== "operator_intervention") {
      return { content: [{ type: "text" as const, text: "Only operator-intervention jobs can be manually reconciled." }], isError: true };
    }
    try {
      const reconciled = await config.reconcileScheduledJob(scheduledJobId);
      if (!reconciled) return { content: [{ type: "text" as const, text: "Scheduled job disappeared during reconciliation." }], isError: true };
      return {
        content: [{ type: "text" as const, text: `${reconciled.id}: ${reconciled.status}` }],
        structuredContent: {
          scheduledJobId: reconciled.id,
          status: reconciled.status,
          revision: reconciled.revision,
          lastError: reconciled.lastError,
        },
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  registerAppTool(server, "retry_scheduled_job", {
    title: "Retry blocked scheduled job",
    description: "Retry a permanently blocked scheduled job after its workspace or adapter configuration has been corrected. Temporary agent outages retry automatically with bounded backoff.",
    inputSchema: { scheduledJobId: z.string() },
    outputSchema: { scheduledJobId: z.string(), status: z.string(), revision: z.number(), dispatchRetryCount: z.number().int().nonnegative() },
    _meta: {},
    annotations: { readOnlyHint: false, destructiveHint: false },
  } as any, async (input: unknown) => {
    if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "retry_scheduled_job");
    if (!jobs) return { content: [{ type: "text" as const, text: "Scheduled jobs are unavailable." }], isError: true };
    const scheduledJobId = (input as { scheduledJobId?: string } | undefined)?.scheduledJobId;
    if (!scheduledJobId) return { content: [{ type: "text" as const, text: "Missing scheduledJobId." }], isError: true };
    const job = jobs.get(scheduledJobId);
    if (!job) return { content: [{ type: "text" as const, text: `Unknown scheduled job: ${scheduledJobId}` }], isError: true };
    if (!mayReadJob(job)) return forbidden(config.principalRole, "retry_scheduled_job");
    if (job.status === "blocked" && job.dispatchBlockerKind !== "permanent_configuration") {
      return { content: [{ type: "text" as const, text: "Only permanently blocked scheduled jobs require a reviewer retry." }], isError: true };
    }
    try {
      const retried = jobs.retryBlockedJob({ jobId: job.id, expectedRevision: job.revision });
      return {
        content: [{ type: "text" as const, text: `${retried.id}: ${retried.status}` }],
        structuredContent: {
          scheduledJobId: retried.id,
          status: retried.status,
          revision: retried.revision,
          dispatchRetryCount: retried.dispatchRetryCount,
        },
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });

  registerAppTool(
    server,
    "list_scheduled_jobs",
    {
      title: "List scheduled jobs",
      description: "List durable scheduled jobs owned by this reviewer context, for inbox/rehydration views.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional().describe("Job ID cursor from the previous page."),
      },
      outputSchema: {
        jobs: z.array(z.object({
          scheduledJobId: z.string(),
          status: z.string(),
          revision: z.number(),
          runAt: z.string(),
          workSessionId: z.string().optional(),
        })),
        nextCursor: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    } as any,
    async (input: unknown) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "list_scheduled_jobs");
      if (!jobs) return { content: [{ type: "text" as const, text: "Scheduled jobs are unavailable." }], isError: true };
      const { limit, cursor } = (input ?? {}) as { limit?: number; cursor?: string };
      const boundedLimit = Math.max(1, Math.min(200, limit ?? 100));
      const owned = authenticatedPrincipalId
        ? jobs.listForPrincipal(authenticatedPrincipalId, boundedLimit, cursor)
        : jobs.listForOwner(ownerContextId, boundedLimit, cursor);
      return {
        content: [{ type: "text" as const, text: `${owned.length} scheduled job(s).` }],
        structuredContent: {
          jobs: owned.map((job) => ({
            scheduledJobId: job.id,
            status: job.status,
            revision: job.revision,
            runAt: job.runAt,
            workSessionId: job.workSessionId,
          })),
          ...(owned.length === boundedLimit ? { nextCursor: owned[owned.length - 1]?.id } : {}),
        },
      };
    },
  );

  registerMutationAppTool(
    server,
    "cancel_scheduled_job",
    {
      title: "Cancel scheduled job",
      description: "Cancel a durable scheduled job before or instead of its execution, using CAS on its revision. Idempotent for an already-terminal cancellation.",
      inputSchema: {
        scheduledJobId: z.string(),
        expectedRevision: z.number().int().min(1),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: {
        scheduledJobId: z.string(),
        status: z.string(),
        revision: z.number(),
        cancellationRequestId: z.string().optional(),
        lastConfirmedRemoteState: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ scheduledJobId, expectedRevision, clientMutationId }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "cancel_scheduled_job");
      if (!jobs) return { content: [{ type: "text" as const, text: "Scheduled jobs are unavailable." }], isError: true };
      const job = jobs.get(scheduledJobId);
      if (!job) return { content: [{ type: "text" as const, text: `Unknown scheduled job: ${scheduledJobId}` }], isError: true };
      if (!mayReadJob(job)) {
        return forbidden(config.principalRole, "cancel_scheduled_job");
      }
      if (job.status === "cancelled" || job.status === "failed" || job.status === "completed") {
        return {
          content: [{ type: "text" as const, text: `Scheduled job ${scheduledJobId} is already ${job.status}.` }],
          structuredContent: { scheduledJobId: job.id, status: job.status, revision: job.revision },
        };
      }
      try {
        let cancellation = jobs.requestCancellation({
          jobId: scheduledJobId,
          expectedRevision,
          requestId: clientMutationId ? `cancel:${clientMutationId}` : `cancel:${randomUUID()}`,
          reason: "Operator cancellation requested; awaiting worker-state confirmation.",
        });
        const requestId = cancellation.cancellationRequestId;
        if (!requestId) throw new Error("Scheduled cancellation request identity was not persisted.");
        if (cancellation.cancellationLastConfirmedState === "not_dispatched") {
          cancellation = jobs.finalizeCancellation({
            jobId: cancellation.id,
            requestId,
            lastConfirmedState: "not_dispatched",
            reason: "Cancelled before any worker dispatch began.",
          });
        } else if (jobs.claimCancellationAttempt({ jobId: cancellation.id, requestId, minimumIntervalMs: 30_000 })) {
          const session = cancellation.workSessionId ? config.workSessions.get(cancellation.workSessionId) : undefined;
          const run = cancellation.workSessionId
            ? config.agentRegistry.getRunByWorkSessionId(cancellation.workSessionId)
            : undefined;
          if (!session || !run) {
            cancellation = jobs.recordCancellationEvidence({
              jobId: cancellation.id,
              requestId,
              state: "unknown",
              lastError: "Cancellation is durable, but the correlated worker state is not available yet.",
            });
          } else if (["cancelled"].includes(run.status) || session.status === "cancelled") {
            cancellation = jobs.recordCancellationEvidence({
              jobId: cancellation.id,
              requestId,
              state: "worker_cancelled",
              lastError: "The correlated worker reported cancellation.",
            });
            cancellation = jobs.finalizeCancellation({ jobId: cancellation.id, requestId, lastConfirmedState: "worker_cancelled" });
          } else if (["approved", "rejected", "failed", "failed_protocol"].includes(run.status)) {
            cancellation = jobs.recordCancellationEvidence({
              jobId: cancellation.id,
              requestId,
              state: "unknown",
              lastError: `The correlated run is already terminal (${run.status}); lifecycle reconciliation will determine the job outcome.`,
            });
          } else if (hasConfirmedWorkerAttemptExit(run, config.agentRegistry.getLatestDispatchAttemptForRun(run.runId))) {
            config.reviewWorkflow.cancelSession({ sessionId: session.id, reason: "scheduled job cancellation requested" });
            config.reviewWorkflow.finalizeCancellation({ sessionId: session.id, reason: "the current worker attempt had already exited" });
            cancellation = jobs.recordCancellationEvidence({
              jobId: cancellation.id,
              requestId,
              state: "worker_stopped",
              lastError: "The current worker attempt had already exited; the pending review was cancelled.",
            });
            cancellation = jobs.finalizeCancellation({
              jobId: cancellation.id,
              requestId,
              lastConfirmedState: "worker_stopped",
            });
          } else {
            config.reviewWorkflow.cancelSession({ sessionId: session.id, reason: "scheduled job cancellation requested" });
            const remote = await cancelRemoteRun(
              {
                agentRegistry: config.agentRegistry,
                workspaces: config.workspaces,
                workSessions: config.workSessions,
                adapterSecret: config.adapterSecret,
              },
              run,
            );
            cancellation = jobs.recordCancellationEvidence({
              jobId: cancellation.id,
              requestId,
              state: remote.acknowledged ? "termination_acknowledged" : "unknown",
              lastError: remote.acknowledged
                ? "Remote termination was acknowledged; waiting for the worker cancellation event."
                : remote.status === 404
                  ? "The adapter reports no active run; a durable terminal event is still required to confirm worker shutdown."
                  : `Remote worker state is unknown because termination was not confirmed: ${remote.error ?? "unavailable"}`,
            });
          }
        }
        return {
          content: [{ type: "text" as const, text: cancellation.status === "cancelled"
            ? `Cancelled scheduled job ${scheduledJobId}.`
            : `Cancellation for scheduled job ${scheduledJobId} is recorded; worker shutdown is not confirmed yet.` }],
          structuredContent: {
            scheduledJobId: cancellation.id,
            status: cancellation.status,
            revision: cancellation.revision,
            cancellationRequestId: cancellation.cancellationRequestId,
            lastConfirmedRemoteState: cancellation.cancellationLastConfirmedState,
          },
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  );
}

void schedulingOperation;
