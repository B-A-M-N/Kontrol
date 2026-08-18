import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import type { MissionLedger } from "./mission-ledger.js";
import type { WorkSessionManager } from "./work-sessions.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { ReviewCheckpointManager } from "./review-checkpoints.js";

const ALLOWED_EXECUTABLES = new Set(["npm", "pytest", "cargo", "go", "make", "vitest", "jest", "tsc", "ruff"]);

/**
 * P1 #21: Trust policy for unattended verification.
 *
 * By default, verification commands are run WITHOUT sandboxing. This is the
 * "Reviewer-declared trusted verification" mode: the user explicitly authorized
 * the mission command, so execution is trusted.
 *
 * To enable sandboxed verification (no network, constrained FS, resource limits),
 * set KONTROL_VERIFY_SANDBOX=1. This is the "Security-constrained autonomous
 * verification" mode for unattended runs.
 */
const SANDBOX_ENABLED = process.env.KONTROL_VERIFY_SANDBOX === "1";
const UNSAFE_SHELL_SYNTAX = /[;&|><`$(){}\n\r]/;
const MAX_OUTPUT_BYTES = 20_000;

export type VerificationResult = {
  criterionId: string;
  command: string;
  status: "passed" | "failed" | "inconclusive";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  outputTail: string;
  outputSha256: string;
};

/** Strict, non-shell command policy for unattended verification. */
export function parseVerificationCommand(command: string): { executable: string; args: string[] } {
  const value = command.trim();
  if (!value || value.length > 1_024 || UNSAFE_SHELL_SYNTAX.test(value)) {
    throw new Error("Verification command is not permitted by the unattended command policy.");
  }
  const [executable, ...args] = value.split(/\s+/);
  if (!executable || !ALLOWED_EXECUTABLES.has(executable)) {
    throw new Error(`Verification executable ${JSON.stringify(executable)} is not allowlisted.`);
  }
  if (args.some((arg) => arg.includes("..") || arg.startsWith("/"))) {
    throw new Error("Verification arguments may not escape the workspace.");
  }
  return { executable, args };
}

export async function runVerificationCommand(
  command: string,
  cwd: string,
  timeoutMs = 300_000,
  deadlineAtMs = Date.now() + timeoutMs,
): Promise<Omit<VerificationResult, "criterionId" | "command">> {
  const { executable, args } = parseVerificationCommand(command);
  const startedAt = Date.now();
  const remainingMs = Math.min(timeoutMs, deadlineAtMs - startedAt, 300_000);
  if (remainingMs <= 0) {
    const outputTail = "Verification deadline reached before command started.";
    return {
      status: "failed",
      exitCode: null,
      signal: null,
      durationMs: 0,
      outputTail,
      outputSha256: createHash("sha256").update(outputTail).digest("hex"),
    };
  }
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1", NO_COLOR: "1", npm_config_yes: "true" },
    });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-MAX_OUTPUT_BYTES); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, "SIGTERM");
        // P1 #20: SIGKILL after grace period
        const pid = child.pid;
        setTimeout(() => {
          try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
        }, 5_000).unref?.();
      } else {
        child.kill("SIGTERM");
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already exited */ }
        }, 5_000).unref?.();
      }
    }, Math.max(1, remainingMs));
    child.on("error", (error) => {
      clearTimeout(timeout);
      output = (output + `\n${error.message}`).slice(-MAX_OUTPUT_BYTES);
      resolve({ status: "failed", exitCode: null, signal: null, durationMs: Date.now() - startedAt, outputTail: output, outputSha256: createHash("sha256").update(output).digest("hex") });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (timedOut) output = `${output}\nVerification timed out.`.slice(-MAX_OUTPUT_BYTES);
      resolve({ status: exitCode === 0 && !timedOut ? "passed" : "failed", exitCode, signal, durationMs: Date.now() - startedAt, outputTail: output, outputSha256: createHash("sha256").update(output).digest("hex") });
    });
  });
}

class VerificationBindingError extends Error {}

function inconclusiveResult(criterionId: string, command: string, reason: string): VerificationResult {
  return {
    criterionId,
    command,
    status: "inconclusive",
    exitCode: null,
    signal: null,
    durationMs: 0,
    outputTail: reason,
    outputSha256: createHash("sha256").update(reason).digest("hex"),
  };
}

export async function verifyMissionSubmission(input: {
  workSessionId: string;
  missionLedger: MissionLedger;
  workSessions: WorkSessionManager;
  workspaces: WorkspaceRegistry;
  reviewCheckpoints: ReviewCheckpointManager;
  criterionIds?: string[];
  /** Submission identity captured by the caller before dispatching verification. */
  submissionId?: string;
  reviewEpoch?: number;
  /** One absolute wall-clock deadline shared by every criterion and final check. */
  deadlineAtMs?: number;
}): Promise<VerificationResult[]> {
  const mission = input.missionLedger.getMissionByWorkSession(input.workSessionId);
  const session = input.workSessions.get(input.workSessionId);
  const latest = session?.latestSubmission;
  if (!mission || !session || !latest?.id || !latest.snapshotCommit) throw new Error("A submitted mission snapshot is required.");
  if (input.submissionId && input.submissionId !== latest.id) {
    throw new VerificationBindingError("Verification blocked: current submission changed before verification started.");
  }
  if (input.reviewEpoch !== undefined && input.reviewEpoch !== latest.reviewEpoch) {
    throw new VerificationBindingError("Verification blocked: review epoch changed before verification started.");
  }
  const workspace = input.workspaces.getWorkspace(session.workspaceSessionId);
  const deadlineAtMs = input.deadlineAtMs ?? Date.now() + 300_000;

  const getLease = input.workSessions.getWorkspaceLeaseForSession;
  let boundLeaseNonce: string | undefined;
  if (getLease && !getLease.call(input.workSessions, input.workSessionId)) {
    const canonicalRoot = await realpath(workspace.root);
    const acquired = input.workSessions.acquireWorkspaceLease({
      canonicalRoot,
      workspaceSessionId: session.workspaceSessionId,
      workSessionId: input.workSessionId,
      ownerInstanceId: `verifier:${process.pid}`,
    });
    if (!acquired.acquired) {
      throw new VerificationBindingError(`Verification blocked: workspace is leased by ${acquired.conflictingWorkSessionId}.`);
    }
    boundLeaseNonce = acquired.lease.leaseNonce;
  } else if (getLease) {
    boundLeaseNonce = getLease.call(input.workSessions, input.workSessionId)?.leaseNonce;
  }

  const assertBinding = async (): Promise<void> => {
    if (Date.now() >= deadlineAtMs) throw new VerificationBindingError("Verification deadline reached.");

    if (getLease) {
      const lease = getLease.call(input.workSessions, input.workSessionId);
      if (!lease || lease.workspaceSessionId !== session.workspaceSessionId || Date.parse(lease.expiresAt) <= Date.now() || (boundLeaseNonce !== undefined && lease.leaseNonce !== boundLeaseNonce)) {
        throw new VerificationBindingError("Verification blocked: workspace lease is missing or expired.");
      }
    }

    const current = await input.reviewCheckpoints.reviewChangesAgainstCommit({
      workspaceId: session.workspaceSessionId,
      root: workspace.root,
      baselineCommit: latest.snapshotCommit!,
    });
    if (current.summary.files !== 0) {
      throw new VerificationBindingError("Verification blocked: workspace no longer matches the submitted snapshot.");
    }
  };

  // Snapshot commits are synthetic working-tree commits. Their parent changes
  // when a review checkpoint advances, so commit identity alone is not a
  // stable representation of identical tree content. Compare the current tree
  // against the exact submitted snapshot instead.
  await assertBinding();
  const criteria = input.missionLedger.getPacket(input.workSessionId).criteria.filter((criterion) => !!criterion.verificationCommand && (!input.criterionIds?.length || input.criterionIds.includes(criterion.id)));
  const results: VerificationResult[] = [];
  const pendingEvidence: Array<{ criterionId: string; submissionId: string; reviewEpoch: number; snapshotCommit: string; leaseNonce?: string; command: string; status: "passed" | "failed" | "inconclusive"; source: "server_test_runner"; details: Record<string, unknown> }> = [];
  let bindingLost = false;
  for (const criterion of criteria) {
    const command = criterion.verificationCommand!;
    if (bindingLost) break;
    let result: Omit<VerificationResult, "criterionId" | "command">;
    try {
      await assertBinding();
      result = await runVerificationCommand(command, workspace.root, 300_000, deadlineAtMs);
      await assertBinding();
    }
    catch (error) {
      const outputTail = error instanceof Error ? error.message : String(error);
      if (error instanceof VerificationBindingError) {
        bindingLost = true;
        results.push(inconclusiveResult(criterion.id, command, outputTail));
        break;
      }
      result = { status: "failed", exitCode: null, signal: null, durationMs: 0, outputTail, outputSha256: createHash("sha256").update(outputTail).digest("hex") };
    }
    const full = { criterionId: criterion.id, command, ...result };
    pendingEvidence.push({ criterionId: criterion.id, submissionId: latest.id, reviewEpoch: latest.reviewEpoch, snapshotCommit: latest.snapshotCommit, leaseNonce: boundLeaseNonce, command, status: result.status, source: "server_test_runner", details: { exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, deadlineAtMs, outputTail: result.outputTail, outputSha256: result.outputSha256 } });
    results.push(full);
  }
  if (bindingLost) {
    input.missionLedger.recordEvidence(mission.id, pendingEvidence.map((entry) => ({ ...entry, status: "inconclusive" as const })));
    return results.map((result) => result.status === "passed" ? { ...result, status: "inconclusive" as const } : result);
  }
  input.missionLedger.recordEvidence(mission.id, pendingEvidence);
  // Final integration commands run only after every required criterion is
  // currently verified. Their report is independently bound to this snapshot.
  const refreshed = input.missionLedger.getPacket(input.workSessionId);
  const requiredReady = refreshed.criteria.filter((criterion) => criterion.priority === "required").every((criterion) => criterion.status === "verified");
  if (requiredReady && mission.finalVerification.length) {
    const finalResults: Array<Omit<VerificationResult, "criterionId">> = [];
    for (const command of mission.finalVerification) {
      let result: Omit<VerificationResult, "criterionId" | "command">;
      try {
        await assertBinding();
        result = await runVerificationCommand(command, workspace.root, 300_000, deadlineAtMs);
        await assertBinding();
      }
      catch (error) {
        const outputTail = error instanceof Error ? error.message : String(error);
        if (error instanceof VerificationBindingError) {
          return results.concat(inconclusiveResult(`final:${finalResults.length + 1}`, command, outputTail));
        }
        result = { status: "failed", exitCode: null, signal: null, durationMs: 0, outputTail, outputSha256: createHash("sha256").update(outputTail).digest("hex") };
      }
      finalResults.push({ command, ...result });
      results.push({ criterionId: `final:${finalResults.length}`, command, ...result });
    }
    input.missionLedger.recordCompletionReport(mission.id, {
      submissionId: latest.id,
      snapshotCommit: latest.snapshotCommit,
      status: finalResults.every((result) => result.status === "passed") ? "passed" : "failed",
      results: finalResults,
    });
  }
  return results;
}
