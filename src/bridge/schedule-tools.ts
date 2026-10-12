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
import { forbidden, isReviewer, liveOwnerContextId } from "./shared.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { createScheduledJobStore, schedulingOperation } from "../scheduling/scheduled-job-store.js";
import type { ScheduledJobStore } from "../scheduling/scheduled-job-store.js";
import { cancelRemoteRun } from "../acp-gateway.js";
import { z } from "zod/v4";

function scheduledJobStore(config: BridgeConfig): ScheduledJobStore | undefined {
  return config.scheduledJobs;
}

export function registerScheduleTools(server: McpServer, config: BridgeConfig): void {
  const jobs = scheduledJobStore(config);

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
      if (!jobs) {
        return { content: [{ type: "text" as const, text: "Scheduled jobs are unavailable: the scheduler store is not configured." }], isError: true };
      }
      try {
        const workspace = config.workspaces.getWorkspace(workspaceId);
        const job = jobs.create({
          principalId: config.principalId ?? `role:${config.principalRole ?? "client"}`,
          ownerContextId: liveOwnerContextId(config) ?? config.principalId ?? "unknown-owner",
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
      },
      outputSchema: {
        scheduledJobId: z.string(),
        status: z.string(),
        revision: z.number(),
        runAt: z.string().optional(),
        workSessionId: z.string().optional(),
        lastError: z.string().optional(),
        outputPreview: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    } as any, async (input: unknown) => {
      const { scheduledJobId } = input as { scheduledJobId?: string };
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
      if (job.ownerContextId !== (liveOwnerContextId(config) ?? config.principalId ?? "unknown-owner")) {
        return forbidden(config.principalRole, name);
      }
      const run = job.workSessionId ? config.agentRegistry.getRunByWorkSessionId(job.workSessionId) : undefined;
      let outputPreview: string | undefined;
      if (run?.outputJson) {
        try {
          const parsed = JSON.parse(run.outputJson) as { output?: Array<{ parts?: Array<{ content?: string }> }> };
          outputPreview = parsed.output?.flatMap((message) => message.parts?.map((part) => part.content ?? "") ?? []).join("\n") || undefined;
        } catch {
          outputPreview = undefined;
        }
      }
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
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
      outputSchema: {
        jobs: z.array(z.object({
          scheduledJobId: z.string(),
          status: z.string(),
          revision: z.number(),
          runAt: z.string(),
          workSessionId: z.string().optional(),
        })),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    } as any,
    async (input: unknown) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "list_scheduled_jobs");
      if (!jobs) return { content: [{ type: "text" as const, text: "Scheduled jobs are unavailable." }], isError: true };
      const { limit } = (input ?? {}) as { limit?: number };
      const owner = liveOwnerContextId(config) ?? config.principalId ?? "unknown-owner";
      const owned = jobs.listForOwner(owner, limit);
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
      outputSchema: { scheduledJobId: z.string(), status: z.string(), revision: z.number() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ scheduledJobId, expectedRevision }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "cancel_scheduled_job");
      if (!jobs) return { content: [{ type: "text" as const, text: "Scheduled jobs are unavailable." }], isError: true };
      const job = jobs.get(scheduledJobId);
      if (!job) return { content: [{ type: "text" as const, text: `Unknown scheduled job: ${scheduledJobId}` }], isError: true };
      if (job.ownerContextId !== (liveOwnerContextId(config) ?? config.principalId ?? "unknown-owner")) {
        return forbidden(config.principalRole, "cancel_scheduled_job");
      }
      if (job.status === "cancelled" || job.status === "failed" || job.status === "completed" || job.status === "blocked") {
        return {
          content: [{ type: "text" as const, text: `Scheduled job ${scheduledJobId} is already ${job.status}.` }],
          structuredContent: { scheduledJobId: job.id, status: job.status, revision: job.revision },
        };
      }
      if (job.status === "running" && job.workSessionId) {
        const run = config.agentRegistry.getRunByWorkSessionId(job.workSessionId);
        if (run) {
          const remote = await cancelRemoteRun(
            {
              agentRegistry: config.agentRegistry,
              workspaces: config.workspaces,
              workSessions: config.workSessions,
              adapterSecret: config.adapterSecret,
            },
            run,
          );
          const cancellation = jobs.transition({
            jobId: scheduledJobId,
            expectedRevision,
            nextStatus: "cancellation_requested",
            lastError: remote.acknowledged
              ? "Remote termination acknowledged; awaiting cancellation."
              : `Remote termination not confirmed: ${remote.error ?? "unavailable"}`,
          });
          return {
            content: [{ type: "text" as const, text: remote.acknowledged
              ? `Scheduled job ${scheduledJobId}: remote termination requested.`
              : `Scheduled job ${scheduledJobId}: remote termination could not be confirmed.` }],
            structuredContent: { scheduledJobId: cancellation.id, status: cancellation.status, revision: cancellation.revision, remoteAcknowledged: remote.acknowledged },
          };
        }
      }
      try {
        const cancelled = jobs.transition({ jobId: scheduledJobId, expectedRevision, nextStatus: "cancelled", lastError: "operator cancelled" });
        return {
          content: [{ type: "text" as const, text: `Cancelled scheduled job ${scheduledJobId}.` }],
          structuredContent: { scheduledJobId: cancelled.id, status: cancelled.status, revision: cancelled.revision },
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  );
}

void schedulingOperation;
