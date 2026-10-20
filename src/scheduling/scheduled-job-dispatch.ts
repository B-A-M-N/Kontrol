/**
 * Authorized dispatch for durable scheduled jobs (S02/S03).
 *
 * The scheduler decides WHEN a job runs; this module reuses the canonical ACP
 * dispatch primitives (agent selection, workspace leasing, run creation) so a
 * due job launches exactly one logical worker without an active ChatGPT
 * conversation. It never duplicates delegation-tool policy: it is invoked by
 * the Kontrol-owned runtime, not by an untrusted MCP caller.
 */
import { callRemoteAgent, probeAgent, selectHealthyAgent } from "../acp-gateway.js";
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
  failureClass?: string;
  probeResult?: Record<string, unknown>;
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
  /** Durable attempt identity supplied by the runtime dispatch claim. */
  dispatchAttemptId?: string;
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
      failureClass: "workspace_not_found",
      probeResult: { executionMode: job.executionMode, workspaceResolved: false },
    };
  }

  const registeredCandidates = config.agentRegistry.listAlive().filter((agent) => agent.role === "agent" && (!job.agentName || agent.name === job.agentName));
  const requiredAgentCapability = `scheduled:${job.executionMode}`;
  const candidates = registeredCandidates.filter((agent) => agent.capabilities.includes(requiredAgentCapability));
  const networkPolicy = config.serverConfig?.readOnlyExecutionNetworkPolicy ?? "disabled";
  if (candidates.length === 0) {
    const waitingForRegistration = registeredCandidates.length === 0 && !job.agentName;
    return {
      status: "blocked",
      blockerKind: waitingForRegistration ? "temporary_dependency" : "permanent_configuration",
      lastAttemptedAgent: job.agentName,
      failureClass: waitingForRegistration ? "no_registered_agents" : "execution_mode_unsupported",
      reason: waitingForRegistration
        ? "No ACP agent is registered for scheduled dispatch."
        : `No registered agent advertises ${job.executionMode} capability${job.agentName ? ` for ${job.agentName}` : ""}.`,
      probeResult: {
        executionMode: job.executionMode,
        registeredCandidateCount: registeredCandidates.length,
        compatibleCandidateCount: 0,
        requiredAgentCapability,
      },
    };
  }
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
      failureClass: blockerKind === "permanent_configuration" ? "agent_probe_permanent_failure" : "agent_probe_unavailable",
      reason: selection.deadUrls.length
        ? `No healthy dispatchable ACP agent is registered; ${selection.deadUrls.length} compatible adapter health probe(s) failed.`
        : "No healthy dispatchable ACP agent is registered.",
      probeResult: {
        executionMode: job.executionMode,
        registeredCandidateCount: registeredCandidates.length,
        compatibleCandidateCount: candidates.length,
        failedHealthProbeCount: selection.deadUrls.length,
        requiredAgentCapability,
      },
    };
  }
  const peer = selection.agent;

  const capabilityProbe = await probeAgent(peer.url, config.adapterSecret);
  const rawModeCapability = capabilityProbe.executionCapabilities?.[job.executionMode];
  const modeCapability = rawModeCapability && typeof rawModeCapability === "object" && !Array.isArray(rawModeCapability)
    ? rawModeCapability as Record<string, unknown>
    : undefined;
  const inputContract = typeof modeCapability?.cliInputContract === "string" ? modeCapability.cliInputContract : undefined;
  const acceptedInputContracts = new Set([
    "crush_positional_instruction_plus_stdin_v1",
    "hermes_public_acp_v1_session_prompt",
  ]);
  const networkPolicies = Array.isArray(modeCapability?.networkPolicies) ? modeCapability.networkPolicies : [];
  const preflightFailures = [
    ...(modeCapability?.supported === true ? [] : ["execution mode is not advertised by the adapter health contract"]),
    ...(modeCapability?.grantPolicy === "kontrol_signed_attempt_bound" ? [] : ["adapter does not accept Kontrol's signed attempt-bound grant policy"]),
    ...(modeCapability?.confinementAvailable === true ? [] : ["required bubblewrap/prlimit confinement is unavailable"]),
    ...(modeCapability?.executableAvailable === true ? [] : ["agent executable or adapter runtime is unavailable"]),
    ...(inputContract && acceptedInputContracts.has(inputContract) ? [] : ["agent input contract is missing or unsupported"]),
    ...(networkPolicies.includes(networkPolicy) ? [] : [`network policy ${networkPolicy} is unsupported`]),
  ];
  const probeResult = {
    executionMode: job.executionMode,
    selectedAgent: peer.name,
    requiredAgentCapability,
    healthProbe: capabilityProbe.healthy ? "healthy" : "failed",
    capabilityContractAdvertised: Boolean(modeCapability),
    confinementAvailable: modeCapability?.confinementAvailable === true,
    executableAvailable: modeCapability?.executableAvailable === true,
    grantPolicy: typeof modeCapability?.grantPolicy === "string" ? modeCapability.grantPolicy : "unavailable",
    cliInputContract: inputContract ?? "unavailable",
    networkPolicy,
  };
  if (preflightFailures.length) {
    return {
      status: "blocked",
      blockerKind: "permanent_configuration",
      lastAttemptedAgent: peer.name,
      failureClass: "execution_mode_preflight_failed",
      reason: `Scheduled ${job.executionMode} preflight failed: ${preflightFailures.join("; ")}.`,
      probeResult,
    };
  }

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
  // Bind correlation before the worker can call Kontrol. Publication and
  // scheduled-policy authorization must not depend on the adapter's
  // synchronous HTTP response, which can arrive after the worker's MCP calls.
  if (options.dispatchId && options.dispatchAttemptId) {
    try {
      jobs.bindWorkSession({
        jobId: job.id,
        dispatchAttemptId: options.dispatchAttemptId,
        workSessionId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      config.workSessions.updateStatus(workSessionId, "failed");
      return {
        status: "failed",
        workSessionId,
        reason: `Could not bind scheduled work session before dispatch: ${message}`,
        failureClass: "dispatch_identity_binding_failed",
        probeResult,
      };
    }
  }
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
    return { status: "blocked", workSessionId, reason: leaseError.content[0]?.text ?? "Workspace lease unavailable.", failureClass: "workspace_lease_unavailable", probeResult };
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
        ...(isBoundedFileWrite ? {
          onAcpAttemptAllocated: (identity: { runId: string; attemptNumber: number; dispatchIdempotencyKey: string }) => {
            if (!options.dispatchAttemptId || !options.dispatchId) {
              throw new Error("bounded_file_write_dispatch_identity_unavailable");
            }
            jobs.bindAcpAttempt({
              jobId: job.id,
              dispatchAttemptId: options.dispatchAttemptId,
              workSessionId,
              dispatchIdempotencyKey: identity.dispatchIdempotencyKey,
              runId: identity.runId,
              attemptNumber: identity.attemptNumber,
            });
          },
        } : {}),
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
        failureClass: "adapter_acceptance_uncertain",
        probeResult,
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
        failureClass: "adapter_rejected_dispatch",
        probeResult,
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
      probeResult,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const uncertain = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|network/i.test(message);
    if (!uncertain) config.workSessions.updateStatus(workSessionId, "failed");
    return {
      status: uncertain ? "uncertain" : "failed",
      lastAttemptedAgent: peer.name,
      workSessionId,
      reason: message,
      failureClass: uncertain ? "adapter_transport_uncertain" : "adapter_dispatch_failed",
      probeResult,
    };
  }
}
