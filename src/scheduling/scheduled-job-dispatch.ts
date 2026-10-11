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
import type { BridgeConfig } from "../bridge/context.js";
import { acquireCheckoutModifyLease, checkoutLeaseMetadata, workSessionInstructions } from "../bridge/shared.js";
import type { ScheduledJob, ScheduledJobStore } from "./scheduled-job-store.js";

export interface ScheduledDispatchResult {
  status: "dispatched" | "blocked" | "failed" | "uncertain";
  workSessionId?: string;
  runId?: string;
  reason?: string;
}

/**
 * Dispatch one due job. The job must already be in a nonterminal dispatchable
 * state; the caller owns the CAS transition from `due` → `dispatching`.
 * Returns `uncertain` when the adapter transport failed in a way that cannot
 * prove the remote worker was not accepted — never a blind retry.
 */
export async function dispatchScheduledJob(
  config: BridgeConfig,
  jobs: ScheduledJobStore,
  job: ScheduledJob,
): Promise<ScheduledDispatchResult> {
  const workspaceSessionId = job.projectId;
  let workspace: { root: string };
  try {
    workspace = config.workspaces.getWorkspace(workspaceSessionId);
  } catch {
    return { status: "blocked", reason: `Unknown workspace for scheduled job: ${workspaceSessionId}` };
  }

  const selection = await selectHealthyAgent(config.agentRegistry.listAlive(), {
    name: job.agentName,
    role: "agent",
    adapterSecret: config.adapterSecret,
  });
  if (!selection.agent) {
    return { status: "blocked", reason: "No healthy dispatchable ACP agent is registered." };
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
    completionPolicy: "webui_approval_required",
    ownerContextId: job.ownerContextId,
  });
  const workSessionId = created.id;

  const leaseError = await acquireCheckoutModifyLease(config, workspaceSessionId, workSessionId, { takeover: false });
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
      },
      {
        agentUrl: peer.url,
        agentName: peer.name,
        agentId: peer.id,
        task,
        workspaceSessionId,
        workSessionId,
        ...checkoutLeaseMetadata(config, workSessionId),
        mode: "async",
        fireAndForget: true,
      },
    );
    if (result.status === "failed") {
      // callRemoteAgent maps transport errors to status:"failed" without
      // proving the adapter rejected the request. Treat an unproven rejection
      // as uncertain so the job is not blindly relaunched.
      const uncertain = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|network/i.test(result.error ?? "");
      config.workSessions.updateStatus(workSessionId, "failed");
      return {
        status: uncertain ? "uncertain" : "failed",
        workSessionId,
        runId: result.runId,
        reason: result.error ?? "Scheduled ACP dispatch failed.",
      };
    }
    return { status: "dispatched", workSessionId, runId: result.runId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const uncertain = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|network/i.test(message);
    config.workSessions.updateStatus(workSessionId, "failed");
    return { status: uncertain ? "uncertain" : "failed", workSessionId, reason: message };
  }

}
