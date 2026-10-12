/**
 * Durable scheduled-job MCP tools.
 *
 * These tools create/read bounded one-shot jobs. They do not grant arbitrary
 * shell authority; execution remains read_only_audit until its policy layer is
 * fully wired in a later phase.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig } from "./context.js";
import { registerMutationAppTool } from "./app-tool.js";
import { forbidden, isReviewer, liveOwnerContextId, requireWorkSessionMutation } from "./shared.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { createScheduledJobStore, schedulingOperation } from "../scheduling/scheduled-job-store.js";
import type { ScheduledJob, ScheduledJobStore } from "../scheduling/scheduled-job-store.js";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { cancelRemoteRun } from "../acp-gateway.js";
import { hasConfirmedWorkerAttemptExit } from "../acp-registry.js";
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

export function registerScheduleTools(server: McpServer, config: BridgeConfig): void {
  const jobs = scheduledJobStore(config);
  const authenticatedPrincipalId = config.connectionContext?.authenticatedPrincipalId?.trim();
  const ownerContextId = liveOwnerContextId(config) ?? config.principalId ?? "unknown-owner";
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
        executionMode: z.literal("read_only_audit").default("read_only_audit"),
        maxRuntimeMinutes: z.number().int().min(1).max(24 * 60).default(90),
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
    async ({ workspaceId, runAt, instructions, executionMode, maxRuntimeMinutes, agentName, clientMutationId }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "schedule_job");
      // A workspace ID is not a work-session ID. Authorization for scheduling
      // is reviewer role plus authenticated ownership of that workspace, which
      // is checked below after the workspace record is resolved.
      if (!liveOwnerContextId(config) && config.connectionContext) return forbidden(config.principalRole, "missing transport identity");
      if (!jobs) {
        return { content: [{ type: "text" as const, text: "Scheduled jobs are unavailable: the scheduler store is not configured." }], isError: true };
      }
      try {
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
          policySnapshotJson: { workspaceAccess: "read_only", mutate: false },
          agentName,
          maxRuntimeMs: maxRuntimeMinutes * 60_000,
          clientMutationId,
        });
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
            scheduledJobStatus: z.string(),
            executionStatus: z.string(),
            reviewStatus: z.string(),
            verificationStatus: z.enum(["passed", "failed", "inconclusive", "not_performed"]),
            outcomeVerified: z.boolean(),
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
          reportOffset: z.number().int().optional(),
          reportNextOffset: z.number().int().optional(),
          reportTruncated: z.boolean().optional(),
        } : {}),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    } as any, async (input: unknown) => {
      const { scheduledJobId, reportOffset, reportLimit } = input as { scheduledJobId?: string; reportOffset?: number; reportLimit?: number };
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
      if (!mayReadJob(job)) {
        return forbidden(config.principalRole, name);
      }
      const run = job.workSessionId ? config.agentRegistry.getRunByWorkSessionId(job.workSessionId) : undefined;
      const attempt = jobs.getAttempt(job.id);
      const session = job.workSessionId ? config.workSessions.get(job.workSessionId) : undefined;
      let outputPreview: string | undefined;
      let reportText = "";
      if (run?.outputJson) {
        try {
          const parsed = JSON.parse(run.outputJson) as { output?: Array<{ parts?: Array<{ content?: string }> }> };
          reportText = parsed.output?.flatMap((message) => message.parts?.map((part) => part.content ?? "") ?? []).join("\n") ?? "";
          outputPreview = reportText.slice(0, 2_000) || undefined;
        } catch {
          outputPreview = undefined;
          reportText = "";
        }
      }
      const resultReceipt = name === "get_scheduled_job_result" ? (() => {
        const latest = session?.latestSubmission;
        const snapshotKind = latest?.snapshotKind;
        const snapshotRef = latest?.snapshotRef ?? latest?.snapshotCommit;
        const mission = session && config.missionLedger
          ? config.missionLedger.getResultReceipt(session.id, latest ? {
              submissionId: latest.id,
              snapshotKind,
              snapshotRef,
              snapshotCommit: latest.snapshotCommit,
              reviewEpoch: latest.reviewEpoch,
            } : undefined)
          : undefined;
        const completionReport = mission?.completionReport;
        const verificationStatus = completionReport?.status === "failed"
          ? "failed"
          : completionReport?.status === "passed" && mission?.approval.allowed
            ? "passed"
            : completionReport
              ? "inconclusive"
              : "not_performed";
        const reviewStatus = !session ? "not_started"
          : session.status === "approved" ? "approved"
            : session.status === "rejected" ? "rejected"
              : session.status === "cancelled" ? "cancelled"
                : session.status === "failed" || session.status === "failed_protocol" ? "failed"
                  : session.status === "awaiting_review" || session.status === "in_review" || session.status === "review_in_progress" ? "pending"
                    : session.status === "changes_requested" ? "changes_requested"
                      : latest ? "pending" : "not_submitted";
        const artifactReferences: Array<{ kind: string; id: string; sha256?: string; snapshotKind?: string; snapshotRef?: string }> = [];
        const reportSha256 = reportText ? createHash("sha256").update(reportText).digest("hex") : undefined;
        if (run && reportSha256) artifactReferences.push({ kind: "acp_run_output", id: run.runId, sha256: reportSha256 });
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
        return {
          receipt: {
            jobId: job.id,
            dispatchId: attempt?.dispatchId,
            workSessionId: job.workSessionId,
            runId: run?.runId ?? attempt?.acpRunId,
            agentIdentity: run?.agentName ?? attempt?.agentName ?? job.agentName,
            startedAt: attempt?.startedAt,
            executionTerminalAt: run?.finishedAt,
            terminalAt: ["completed", "failed", "cancelled", "blocked", "operator_intervention"].includes(job.status)
              ? job.updatedAt
              : undefined,
            scheduledJobStatus: job.status,
            executionStatus: run?.status ?? attempt?.transportStatus ?? job.status,
            reviewStatus,
            verificationStatus,
            outcomeVerified: completionReport?.status === "passed" && Boolean(mission?.approval.allowed),
            snapshotKind,
            snapshotRef,
            error: job.lastError ?? run?.errorMessage,
            artifactReferences,
          },
          reportSha256,
        };
      })() : undefined;
      const reportStart = Math.max(0, (reportOffset ?? 1) - 1);
      const reportPageLimit = Math.max(1, Math.min(48_000, reportLimit ?? 48_000));
      const reportPage = resultReceipt ? reportText.slice(reportStart, reportStart + reportPageLimit) : undefined;
      const reportNextOffset = resultReceipt && reportStart + reportPageLimit < reportText.length
        ? reportStart + reportPageLimit + 1
        : undefined;
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
            reportOffset: reportOffset ?? 1,
            ...(reportNextOffset ? { reportNextOffset } : {}),
            reportTruncated: reportNextOffset !== undefined,
          } : {}),
        },
      };
    });
  };

  readTool("get_scheduled_job", "Get scheduled job", "Retrieve a durable scheduled job by ID.");
  readTool("get_scheduled_job_result", "Get scheduled job result", "Retrieve the current scheduled-job correlation and terminal outcome.");

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
