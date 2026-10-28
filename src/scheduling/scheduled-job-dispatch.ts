/**
 * Authorized dispatch for durable scheduled jobs (S02/S03).
 *
 * The scheduler decides WHEN a job runs; this module reuses the canonical
 * dispatch and work-session primitives for either a direct ACP agent or a
 * durable peer-pull job. It never duplicates delegation-tool policy: it is
 * invoked by the Kontrol-owned runtime, not by an untrusted MCP caller.
 */
import { createHash } from "node:crypto";
import { callRemoteAgent, probeAgent, selectHealthyAgent } from "../acp-gateway.js";
import type { ReadOnlyExecutionReceipt } from "../acp-gateway.js";
import type { BridgeConfig } from "../bridge/context.js";
import { acquireCheckoutModifyLease, checkoutLeaseMetadata, workSessionInstructions } from "../bridge/shared.js";
import type { ScheduledJob, ScheduledJobStore } from "./scheduled-job-store.js";
import type { PeerJobStore } from "../peer/jobs/store.js";
import { enforcePeerJobsCap } from "../peer/jobs/service.js";
import { isPathInsideRootCanonical } from "../roots.js";

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
  peerJobStore?: PeerJobStore;
}

export function scheduledPeerJobId(dispatchId: string): string {
  return deterministicPeerJobId(`kontrol-scheduled-peer-job-v1:${dispatchId}`);
}

export function scheduledPeerContinuationJobId(continuationId: string): string {
  return deterministicPeerJobId(`kontrol-scheduled-peer-continuation-v1:${continuationId}`);
}

function deterministicPeerJobId(identity: string): string {
  const bytes = createHash("sha256").update(identity).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `job_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function dispatchScheduledJob(
  config: BridgeConfig,
  jobs: ScheduledJobStore,
  job: ScheduledJob,
  options: ScheduledDispatchOptions = {},
): Promise<ScheduledDispatchResult> {
  const workspaceSessionId = job.projectId;
  let workspace: ReturnType<BridgeConfig["workspaces"]["getWorkspace"]>;
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

  const dispatchTarget = job.dispatchTarget ?? { kind: "direct_acp" as const };
  if (dispatchTarget.kind === "peer_pull") {
    const peerConfig = config.serverConfig?.peer;
    const descriptor = peerConfig?.allowedPeers.find((candidate) => candidate.id === dispatchTarget.peerId);
    if (!peerConfig?.enabled || !descriptor) {
      return {
        status: "blocked",
        blockerKind: "permanent_configuration",
        failureClass: "peer_target_unavailable",
        reason: `Scheduled peer target ${dispatchTarget.peerId} is not in the enabled trusted peer registry.`,
        probeResult: { dispatchTarget: "peer_pull", peerRegistered: false },
      };
    }
    const requiredCapabilities = ["job:claim", "job:complete", ...(job.executionMode === "bounded_file_write" ? ["workspace:propose_patch"] : [])];
    const missingCapabilities = requiredCapabilities.filter((capability) => !descriptor.capabilities.includes(capability as typeof descriptor.capabilities[number]));
    if (missingCapabilities.length) {
      return {
        status: "blocked",
        blockerKind: "permanent_configuration",
        failureClass: "peer_capability_missing",
        reason: `Scheduled peer ${descriptor.id} lacks required capabilities: ${missingCapabilities.join(", ")}.`,
        probeResult: { dispatchTarget: "peer_pull", peerId: descriptor.id, missingCapabilities },
      };
    }
    if (workspace.mode !== "worktree" || workspace.worktree?.managed !== true || !workspace.sourceRoot || !workspace.worktree.baseSha) {
      return {
        status: "blocked",
        blockerKind: "permanent_configuration",
        failureClass: "peer_workspace_not_managed_worktree",
        reason: "Peer-pull scheduled work requires a managed worktree with a persisted immutable base revision.",
        probeResult: { dispatchTarget: "peer_pull", workspaceMode: workspace.mode, managedWorktree: workspace.worktree?.managed === true },
      };
    }
    if (!descriptor.grantedRoots.some((root) => isPathInsideRootCanonical(workspace.sourceRoot!, root))) {
      return {
        status: "blocked",
        blockerKind: "permanent_configuration",
        failureClass: "peer_root_not_granted",
        reason: `Peer ${descriptor.id} is not granted the selected worktree source repository.`,
        probeResult: { dispatchTarget: "peer_pull", peerId: descriptor.id, sourceRepositoryGranted: false },
      };
    }
    if (!options.peerJobStore || !options.dispatchId || !options.dispatchAttemptId) {
      return {
        status: "blocked",
        blockerKind: "permanent_configuration",
        failureClass: "peer_dispatch_store_unavailable",
        reason: "Peer-pull dispatch requires the durable peer-job store and scheduler attempt identity.",
        probeResult: { dispatchTarget: "peer_pull", peerJobStoreAvailable: Boolean(options.peerJobStore) },
      };
    }
    const peerJobId = scheduledPeerJobId(options.dispatchId);
    try {
      if (!options.peerJobStore.getJob(peerJobId)) {
        enforcePeerJobsCap(options.peerJobStore, descriptor.id, { peer: { maxClaimedJobs: peerConfig.maxClaimedJobs } });
      }
    } catch (error) {
      return {
        status: "blocked",
        blockerKind: "temporary_dependency",
        failureClass: error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "peer_job_capacity_unavailable",
        reason: error instanceof Error ? error.message : String(error),
        probeResult: { dispatchTarget: "peer_pull", peerId: descriptor.id, capacityAvailable: false },
      };
    }
    const instruction = typeof job.instructionJson.instructions === "string"
      ? job.instructionJson.instructions
      : "Perform the scheduled bounded task and report results with execution receipts.";
    const currentJob = jobs.get(job.id) ?? job;
    let workSessionId = currentJob.workSessionId;
    let createdWorkSessionThisAttempt = false;
    if (workSessionId) {
      const existingSession = config.workSessions.get(workSessionId);
      if (!existingSession || existingSession.workspaceSessionId !== workspaceSessionId
        || !["in_progress", "changes_requested", "resuming"].includes(existingSession.status)) {
        return {
          status: "blocked",
          blockerKind: "permanent_configuration",
          workSessionId,
          failureClass: "peer_work_session_unavailable",
          reason: "The scheduled peer dispatch is bound to a missing, mismatched, or terminal work session.",
          probeResult: { dispatchTarget: "peer_pull", peerId: descriptor.id, workSessionBound: true },
        };
      }
    } else {
      const created = config.workSessions.create({
        workspaceSessionId,
        submittedBy: "scheduler",
        title: instruction.slice(0, 80),
        completionPolicy: "webui_approval_required",
        ownerContextId: job.ownerContextId,
        principalId: job.principalId,
      });
      workSessionId = created.id;
      createdWorkSessionThisAttempt = true;
      if (options.dispatchId && options.dispatchAttemptId) {
        try {
          jobs.bindWorkSession({ jobId: job.id, dispatchAttemptId: options.dispatchAttemptId, workSessionId });
        } catch (error) {
          config.workSessions.updateStatus(workSessionId, "failed");
          return {
            status: "failed",
            workSessionId,
            reason: `Could not bind scheduled work session before peer dispatch: ${error instanceof Error ? error.message : String(error)}`,
            failureClass: "dispatch_identity_binding_failed",
          };
        }
      }
    }
    try {
      const taskClass = job.executionMode === "bounded_file_write" ? "propose_patch" : "read_only_audit";
      const allowedOutputs = Array.isArray(job.policySnapshotJson.allowedOutputs)
        ? job.policySnapshotJson.allowedOutputs.map((output) => (output as { path?: unknown }).path).filter((path): path is string => typeof path === "string")
        : [];
      const peerInstruction = taskClass === "read_only_audit"
        ? `${instruction}\n\nReturn findings only in these declared report files: ${allowedOutputs.join(", ")}. Do not modify other workspace files.`
        : instruction;
      const created = options.peerJobStore.createJob({
        jobId: peerJobId,
        peerId: descriptor.id,
        workSessionId,
        workspaceSessionId,
        schedulerDispatchId: options.dispatchId,
        repositoryId: workspace.sourceRoot,
        baseRevision: workspace.worktree.baseSha,
        taskClass,
        instructionHash: createHash("sha256").update(peerInstruction).digest("hex"),
        instructions: peerInstruction,
        allowedOutputs,
        maxRuntimeMs: job.maxRuntimeMs,
        maxArtifactBytes: 64 * 1024 * 1024,
      });
      return {
        status: "dispatched",
        workSessionId,
        probeResult: {
          dispatchTarget: "peer_pull",
          peerId: descriptor.id,
          peerJobId: created.jobId,
          workSessionId,
          workspaceSessionId,
          baseRevision: workspace.worktree.baseSha,
        },
      };
    } catch (error) {
      if (createdWorkSessionThisAttempt) config.workSessions.updateStatus(workSessionId, "failed");
      return {
        status: "failed",
        workSessionId,
        reason: error instanceof Error ? error.message : String(error),
        failureClass: "peer_job_enqueue_failed",
        probeResult: { dispatchTarget: "peer_pull", peerId: descriptor.id },
      };
    }
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
    ...(inputContract === "hermes_public_acp_v1_session_prompt" && modeCapability?.toolchainAvailable !== true
      ? ["Hermes Python runtime or ACP SDK is unavailable in explicitly approved sandbox toolchains"]
      : []),
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
    ...(inputContract === "hermes_public_acp_v1_session_prompt" ? {
      toolchainAvailable: modeCapability?.toolchainAvailable === true,
      ...(typeof modeCapability?.toolchainFailure === "string" ? { toolchainFailure: modeCapability.toolchainFailure } : {}),
    } : {}),
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
        eventStore: config.eventStore,
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
