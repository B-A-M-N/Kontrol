/**
 * Authorized dispatch for durable scheduled jobs (S02/S03).
 *
 * The scheduler decides WHEN a job runs; this module reuses the canonical ACP
 * dispatch primitives (agent selection, workspace leasing, run creation) so a
 * due job launches exactly one logical worker without an active ChatGPT
 * conversation. It never duplicates delegation-tool policy: it is invoked by
 * the Kontrol-owned runtime, not by an untrusted MCP caller.
 */
import { callRemoteAgent, selectHealthyAgent } from "../acp-gateway.js";
import type { ReadOnlyExecutionReceipt } from "../acp-gateway.js";
import type { BridgeConfig } from "../bridge/context.js";
import { acquireCheckoutModifyLease, checkoutLeaseMetadata, workSessionInstructions } from "../bridge/shared.js";
import type { ScheduledJob, ScheduledJobStore } from "./scheduled-job-store.js";

export interface ScheduledDispatchResult {
  status: "dispatched" | "blocked" | "failed" | "uncertain";
  blockerKind?: "temporary_dependency" | "permanent_configuration";
  lastAttemptedAgent?: string;
  workSessionId?: string;
  runId?: string;
  remoteRunId?: string;
  attemptNumber?: number;
  executionReceipt?: ReadOnlyExecutionReceipt;
  reason?: string;
}

/**
 * Dispatch one due job. The job must already be in a nonterminal dispatchable
 * state; the caller owns the CAS transition from `due` → `dispatching`.
 * Returns `uncertain` when the adapter transport failed in a way that cannot
 * prove the remote worker was not accepted — never a blind retry.
 */
export interface ScheduledDispatchOptions {
  /** Durable logical launch identity supplied by the runtime dispatch claim. */
  dispatchId?: string;
}

export async function dispatchScheduledJob(
  config: BridgeConfig,
  jobs: ScheduledJobStore,
  job: ScheduledJob,
  options: ScheduledDispatchOptions = {},
): Promise<ScheduledDispatchResult> {
  const workspaceSessionId = job.projectId;
  let workspace: { root: string };
  try {
    workspace = config.workspaces.getWorkspace(workspaceSessionId);
  } catch {
    return {
      status: "blocked",
      blockerKind: "permanent_configuration",
      reason: `Unknown workspace for scheduled job: ${workspaceSessionId}`,
    };
  }

  const candidates = config.agentRegistry.listAlive().filter((agent) => agent.role === "agent" && (!job.agentName || agent.name === job.agentName));
  const selection = await selectHealthyAgent(candidates, {
    name: job.agentName,
    role: "agent",
    adapterSecret: config.adapterSecret,
  });
  if (!selection.agent) {
    const blockerKind = selection.permanentBlocker || (Boolean(job.agentName) && candidates.length === 0)
      ? "permanent_configuration"
      : "temporary_dependency";
    return {
      status: "blocked",
      blockerKind,
      lastAttemptedAgent: candidates[0]?.name ?? job.agentName,
      reason: selection.deadUrls.length
        ? `No healthy dispatchable ACP agent is registered: ${selection.deadUrls.join("; ")}`
        : job.agentName && candidates.length === 0
          ? `Configured ACP agent ${job.agentName} is not registered.`
          : "No healthy dispatchable ACP agent is registered.",
    };
  }
  const peer = selection.agent;

  // The job's execution-policy snapshot is read-only for a read-only audit. It
  // is enforced by the worker sandbox and policy boundary, not by prompt text.
  const instruction = typeof job.instructionJson.instructions === "string"
    ? job.instructionJson.instructions
    : "Perform the scheduled bounded task and report results with execution receipts.";

  const created = config.workSessions.create({
    workspaceSessionId,
    submittedBy: "scheduler",
    title: instruction.slice(0, 80),
    completionPolicy: job.executionMode === "bounded_file_write" ? "agent_completion" : "webui_approval_required",
    ownerContextId: job.ownerContextId,
    principalId: job.principalId,
  });
  const workSessionId = created.id;
  const isReadOnlyAudit = job.executionMode === "read_only_audit";
  const isBoundedFileWrite = job.executionMode === "bounded_file_write";

  // Read-only audit jobs must never take a checkout mutation lease. The
  // scheduled agent still needs the work-session identity and tool-boundary
  // policy, but the original checkout remains untouched by the scheduler.
  const leaseError = isReadOnlyAudit
    ? undefined
    : (isBoundedFileWrite
      ? undefined
      : await acquireCheckoutModifyLease(config, workspaceSessionId, workSessionId, { takeover: false }));
  if (leaseError) {
    config.workSessions.updateStatus(workSessionId, "failed");
    return { status: "blocked", workSessionId, reason: leaseError.content[0]?.text ?? "Workspace lease unavailable." };
  }

  try {
    const task = `${instruction}\n\n${workSessionInstructions(workSessionId, peer)}`;
    const result = await callRemoteAgent(
      {
        agentRegistry: config.agentRegistry,
        workspaces: config.workspaces,
        workSessions: config.workSessions,
        adapterSecret: config.adapterSecret,
        readOnlyExecutionNetworkPolicy: config.serverConfig?.readOnlyExecutionNetworkPolicy ?? "disabled",
      },
      {
        agentUrl: peer.url,
        agentName: peer.name,
        agentId: peer.id,
        task,
        dispatchIdempotencyKey: options.dispatchId,
        workspaceSessionId,
        workSessionId,
        ...(isReadOnlyAudit || isBoundedFileWrite ? {} : checkoutLeaseMetadata(config, workSessionId)),
        ...(isReadOnlyAudit ? {
          scheduledExecutionPolicy: {
            executionMode: job.executionMode,
            workspaceAccess: "read_only",
            mutate: false,
            executionGrantTtlMs: job.maxRuntimeMs + 5 * 60_000,
            maxRuntimeMs: job.maxRuntimeMs,
          },
        } : isBoundedFileWrite ? {
          scheduledExecutionPolicy: {
            executionMode: job.executionMode,
            workspaceAccess: "staged_write",
            mutate: true,
            allowedOutputs: Array.isArray(job.policySnapshotJson.allowedOutputs)
              ? job.policySnapshotJson.allowedOutputs.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
              : [],
            executionGrantTtlMs: job.maxRuntimeMs + 5 * 60_000,
            maxRuntimeMs: job.maxRuntimeMs,
          },
        } : {}),
        mode: "async",
        fireAndForget: true,
      },
    );
    if (result.status === "uncertain") {
      // Keep the logical session and its policy authority alive until the
      // original adapter launch is authoritatively resolved.
      return {
        status: "uncertain",
        lastAttemptedAgent: peer.name,
        workSessionId,
        runId: result.runId,
        remoteRunId: result.remoteRunId,
        attemptNumber: result.attemptNumber,
        reason: result.error ?? "Scheduled ACP dispatch failed.",
      };
    }
    if (result.status === "failed") {
      config.workSessions.updateStatus(workSessionId, "failed");
      return {
        status: "failed",
        lastAttemptedAgent: peer.name,
        workSessionId,
        runId: result.runId,
        remoteRunId: result.remoteRunId,
        attemptNumber: result.attemptNumber,
        reason: result.error ?? "Scheduled ACP dispatch failed.",
      };
    }
    return {
      status: "dispatched",
      lastAttemptedAgent: peer.name,
      workSessionId,
      runId: result.runId,
      remoteRunId: result.remoteRunId,
      attemptNumber: result.attemptNumber,
      executionReceipt: result.executionReceipt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const uncertain = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|network/i.test(message);
    if (!uncertain) config.workSessions.updateStatus(workSessionId, "failed");
    return { status: uncertain ? "uncertain" : "failed", lastAttemptedAgent: peer.name, workSessionId, reason: message };
  }
}
