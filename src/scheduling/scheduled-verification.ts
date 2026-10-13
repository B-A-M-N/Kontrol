import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { ServerConfig } from "../config.js";
import { createVerificationExecutionContext, createVerificationWorkspace, parseVerificationCommand, runVerificationCommand, type VerificationResult } from "../mission-verifier.js";
import { normalizeWorkspaceSnapshotIdentity, type ReviewCheckpointManager, type WorkspaceSnapshot } from "../review-checkpoints.js";
import type { ScheduledJob, ScheduledJobStore } from "./scheduled-job-store.js";
import type { WorkSessionManager } from "../work-sessions.js";
import type { WorkspaceRegistry } from "../workspaces.js";

const MAX_COMMANDS = 5;
const MAX_TOTAL_RUNTIME_MS = 15 * 60_000;
const PER_COMMAND_RUNTIME_MS = 5 * 60_000;

export interface ScheduledVerificationResult {
  reportSha256: string;
  reportText: string;
  report: {
    version: 1;
    scheduledJobId: string;
    workSessionId: string;
    submissionId: string;
    snapshotKind: "git" | "filesystem";
    snapshotRef: string;
    executionPolicy: {
      capability: "read_only_verification";
      allowedExecutables: string[];
      commands: Array<{
        command: string;
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
}): Promise<ScheduledVerificationResult> {
  const { job } = input;
  if (job.status !== "awaiting_approval") throw new Error("Scheduled verification is available only while the submitted result awaits review.");
  if (!job.workSessionId) throw new Error("Scheduled job has no correlated work session.");
  const commands = job.policySnapshotJson?.verificationCommands;
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > MAX_COMMANDS || commands.some((command) => typeof command !== "string")) {
    throw new Error(`Scheduled job must declare between 1 and ${MAX_COMMANDS} allowlisted verification commands before dispatch.`);
  }
  const parsedCommands = commands.map((command) => ({ command, ...parseVerificationCommand(command) }));
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
  // Scheduled verification is always confined. Unlike ordinary reviewer-run
  // mission checks, it never inherits an unsandboxed execution setting.
  const executionContext = await createVerificationExecutionContext({
    sandbox: true,
    childEnvironmentAllowlist: serverConfig?.childEnvironmentAllowlist,
    verifyToolchainPaths: serverConfig?.verifyToolchainPaths,
    sandboxExecutablePath: serverConfig?.verifySandboxExecutable,
  });
  if (typeof input.reviewCheckpoints.materializeSnapshot !== "function") {
    throw new Error("Scheduled verification requires immutable snapshot materialization.");
  }
  const verificationWorkspace = await createVerificationWorkspace(
    session.workspaceSessionId,
    workspace.root,
    snapshot,
    input.reviewCheckpoints,
  );
  try {
    const results: VerificationResult[] = [];
    for (const { command } of parsedCommands) {
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
        allowedExecutables: [...new Set(parsedCommands.map((command) => command.executable))],
        commands: parsedCommands.map(({ command, executable, args }) => ({
          command,
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
    const persisted = input.jobs.persistReport(job.id, `verification:${latest.id}:${randomUUID()}`, reportText);
    return { reportSha256: persisted.reportSha256, reportText: persisted.reportText, report };
  } finally {
    await verificationWorkspace.cleanup();
  }
}
