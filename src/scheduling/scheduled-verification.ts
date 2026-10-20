import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { ServerConfig } from "../config.js";
import { createVerificationExecutionContext, createVerificationWorkspace, runVerificationCommand, type VerificationResult } from "../mission-verifier.js";
import { normalizeWorkspaceSnapshotIdentity, type ReviewCheckpointManager, type WorkspaceSnapshot } from "../review-checkpoints.js";
import type { ScheduledJob, ScheduledJobStore } from "./scheduled-job-store.js";
import type { WorkSessionManager } from "../work-sessions.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import type { ScheduledVerificationExecution } from "./scheduled-job-store.js";
import { scheduledVerificationFingerprints } from "./scheduled-verification-projection.js";

const MAX_COMMANDS = 5;
const MAX_TOTAL_RUNTIME_MS = 15 * 60_000;
const PER_COMMAND_RUNTIME_MS = 5 * 60_000;

export interface ScheduledVerificationResult {
  executionId: string;
  executionIdentity: string;
  status: "running" | "completed" | "failed";
  reused: boolean;
  reportSha256?: string;
  reportText?: string;
  failureReason?: string;
  report?: {
    version: 1;
    scheduledJobId: string;
    workSessionId: string;
    submissionId: string;
    snapshotKind: "git" | "filesystem";
    snapshotRef: string;
    executionPolicy: {
      capability: "read_only_verification";
      allowedExecutables: string[];
      allowedProfiles: string[];
      commands: Array<{
        command: string;
        profile: string;
        executable: string;
        args: string[];
        argumentPolicy: "exact_predeclared_argv_no_shell_path_traversal_denied";
        maxRuntimeMs: number;
      }>;
      workspace: "disposable_submitted_snapshot";
      writablePaths: string[];
      network: "disabled";
      environment: { policy: "explicit_child_environment_allowlist"; allowedNames: string[] };
      maxRuntimeMs: number;
      maxOutputBytes: number;
      reportRetention: "immutable_job_report";
    };
    results: VerificationResult[];
    createdAt: string;
  };
}

/** Execute reviewer-declared allowlisted checks against a disposable submitted snapshot. */
export async function verifyScheduledJob(input: {
  job: ScheduledJob;
  jobs: ScheduledJobStore;
  workSessions: WorkSessionManager;
  workspaces: WorkspaceRegistry;
  reviewCheckpoints: ReviewCheckpointManager;
  serverConfig?: ServerConfig;
  clientMutationId?: string;
}): Promise<ScheduledVerificationResult> {
  const { job } = input;
  if (job.status !== "awaiting_approval") throw new Error("Scheduled verification is available only while the submitted result awaits review.");
  if (!job.workSessionId) throw new Error("Scheduled job has no correlated work session.");
  const commands = job.policySnapshotJson?.verificationCommands;
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > MAX_COMMANDS || commands.some((command) => typeof command !== "string")) {
    throw new Error(`Scheduled job must declare between 1 and ${MAX_COMMANDS} allowlisted verification commands before dispatch.`);
  }
  const fingerprints = scheduledVerificationFingerprints({
    policySnapshotJson: job.policySnapshotJson,
    serverConfig: input.serverConfig,
  });
  if (!fingerprints.commandPolicyValid) {
    throw new Error("Scheduled verification command is not permitted.");
  }
  if (fingerprints.commands.length !== commands.length) {
    throw new Error(`Scheduled job must declare between 1 and ${MAX_COMMANDS} allowlisted verification commands before dispatch.`);
  }
  const session = input.workSessions.get(job.workSessionId);
  const latest = session?.latestSubmission;
  const identity = latest ? normalizeWorkspaceSnapshotIdentity(latest) : undefined;
  if (!session || !latest?.id || !identity) throw new Error("A submitted workspace snapshot is required before verification.");
  const workspace = input.workspaces.getWorkspace(job.projectId);
  if (workspace.id !== job.projectId) throw new Error("Scheduled verification workspace identity changed.");
  const [currentRoot, scheduledRoot] = await Promise.all([realpath(workspace.root), realpath(job.workspaceRoot)]);
  if (currentRoot !== scheduledRoot) throw new Error("Scheduled verification workspace root changed after job creation.");
  const snapshot: WorkspaceSnapshot = {
    kind: identity.kind,
    ref: identity.ref,
    createdAt: latest.createdAt,
  };
  const isSnapshotCurrent = async () => input.reviewCheckpoints.assertSnapshotMatches({
    workspaceId: session.workspaceSessionId,
    root: workspace.root,
    expected: snapshot,
  });
  if (!await isSnapshotCurrent()) throw new Error("The current workspace no longer matches the submitted snapshot.");

  const serverConfig = input.serverConfig;
  const totalRuntimeMs = Math.min(MAX_TOTAL_RUNTIME_MS, job.maxRuntimeMs);
  const deadlineAtMs = Date.now() + totalRuntimeMs;
  const requestIdentity = {
    jobId: job.id,
    workSessionId: job.workSessionId,
    submissionId: latest.id,
    reviewEpoch: latest.reviewEpoch,
    snapshotKind: identity.kind,
    snapshotRef: identity.ref,
    commandFingerprint: fingerprints.commandFingerprint,
    policyFingerprint: fingerprints.policyFingerprint,
  };
  const requestFingerprint = createHash("sha256").update(JSON.stringify(requestIdentity), "utf8").digest("hex");
  const clientMutationId = input.clientMutationId?.trim();
  if (clientMutationId && (clientMutationId.length > 200 || /[\u0000-\u001f]/.test(clientMutationId))) {
    throw new Error("clientMutationId must be at most 200 printable characters.");
  }
  const requestKey = clientMutationId ? `mutation:${clientMutationId}` : `canonical:${requestFingerprint}`;
  const executionIdentity = `verification:${randomUUID()}`;
  const claimed = input.jobs.claimVerificationExecution({
    ...requestIdentity,
    requestKey,
    requestFingerprint,
    ...(clientMutationId ? { clientMutationId } : {}),
    executionIdentity,
    deadlineAt: new Date(deadlineAtMs).toISOString(),
  });
  if (!claimed.owner) return resultFromExistingExecution(claimed.execution);

  // Scheduled verification is always confined. Unlike ordinary reviewer-run
  // mission checks, it never inherits an unsandboxed execution setting.
  let verificationWorkspace: Awaited<ReturnType<typeof createVerificationWorkspace>> | undefined;
  try {
    const executionContext = await createVerificationExecutionContext({
      sandbox: true,
      childEnvironmentAllowlist: serverConfig?.childEnvironmentAllowlist,
      verifyToolchainPaths: serverConfig?.verifyToolchainPaths,
      sandboxExecutablePath: serverConfig?.verifySandboxExecutable,
    });
    if (typeof input.reviewCheckpoints.materializeSnapshot !== "function") {
      throw new Error("Scheduled verification requires immutable snapshot materialization.");
    }
    verificationWorkspace = await createVerificationWorkspace(
      session.workspaceSessionId,
      workspace.root,
      snapshot,
      input.reviewCheckpoints,
    );
    const results: VerificationResult[] = [];
    for (const { command } of fingerprints.commands) {
      if (!await isSnapshotCurrent()) throw new Error("The workspace changed while scheduled verification was running.");
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) throw new Error("Scheduled verification reached its total runtime limit.");
      const result = await runVerificationCommand(
        command,
        verificationWorkspace.root,
        Math.min(PER_COMMAND_RUNTIME_MS, remainingMs),
        deadlineAtMs,
        true,
        serverConfig?.childEnvironmentAllowlist,
        serverConfig?.verifyToolchainPaths,
        serverConfig?.verifySandboxExecutable,
        executionContext,
      );
      results.push({ criterionId: `scheduled:${results.length + 1}`, command, ...result });
    }
    if (!await isSnapshotCurrent()) throw new Error("The workspace changed before scheduled verification could be recorded.");
    const report = {
      version: 1 as const,
      scheduledJobId: job.id,
      workSessionId: job.workSessionId,
      submissionId: latest.id,
      snapshotKind: identity.kind,
      snapshotRef: identity.ref,
      executionPolicy: {
        capability: "read_only_verification" as const,
        allowedExecutables: [...new Set(fingerprints.commands.map((command) => command.executable))],
        allowedProfiles: [...new Set(fingerprints.commands.map((command) => command.profile))],
        commands: fingerprints.commands.map(({ command, executable, args, profile }) => ({
          command,
          profile,
          executable,
          args,
          argumentPolicy: "exact_predeclared_argv_no_shell_path_traversal_denied" as const,
          maxRuntimeMs: PER_COMMAND_RUNTIME_MS,
        })),
        workspace: "disposable_submitted_snapshot" as const,
        writablePaths: ["/workspace (disposable submitted snapshot)", "/tmp (private temporary filesystem)"],
        network: "disabled" as const,
        environment: {
          policy: "explicit_child_environment_allowlist" as const,
          allowedNames: [...(serverConfig?.childEnvironmentAllowlist ?? [])],
        },
        maxRuntimeMs: totalRuntimeMs,
        maxOutputBytes: 20_000,
        reportRetention: "immutable_job_report" as const,
      },
      results,
      createdAt: new Date().toISOString(),
    };
    const reportText = JSON.stringify(report);
    const persisted = input.jobs.completeVerificationExecution({ executionId: claimed.execution.id, reportText });
    return {
      executionId: persisted.id,
      executionIdentity: persisted.executionIdentity,
      status: "completed",
      reused: false,
      reportSha256: persisted.reportSha256,
      reportText: persisted.reportText,
      report,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failed = input.jobs.failVerificationExecution({ executionId: claimed.execution.id, reason });
    return {
      executionId: failed?.id ?? claimed.execution.id,
      executionIdentity: failed?.executionIdentity ?? claimed.execution.executionIdentity,
      status: "failed",
      reused: false,
      failureReason: failed?.failureReason ?? reason,
      ...(failed?.reportSha256 ? { reportSha256: failed.reportSha256 } : {}),
    };
  } finally {
    await verificationWorkspace?.cleanup();
  }
}

function resultFromExistingExecution(execution: ScheduledVerificationExecution): ScheduledVerificationResult {
  let report: ScheduledVerificationResult["report"];
  if (execution.reportText) {
    try { report = JSON.parse(execution.reportText) as ScheduledVerificationResult["report"]; }
    catch { report = undefined; }
  }
  return {
    executionId: execution.id,
    executionIdentity: execution.executionIdentity,
    status: execution.status,
    reused: true,
    reportSha256: execution.reportSha256,
    reportText: execution.reportText,
    failureReason: execution.failureReason,
    report,
  };
}
