import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { buildChildEnvironment } from "./process-environment.js";
import { git } from "./git.js";
import type { MissionLedger } from "./mission-ledger.js";
import type { WorkSessionManager } from "./work-sessions.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { ReviewCheckpointManager, WorkspaceSnapshot } from "./review-checkpoints.js";

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
const UNSAFE_SHELL_SYNTAX = /[;&|><`$(){}\n\r]/;
const MAX_OUTPUT_BYTES = 20_000;
const VERIFIER_POLICY_VERSION = "mission-verifier-v2";
const DEFAULT_COMMAND_VERSION = "unspecified";
const SANDBOX_RESOURCE_LIMITS = {
  cpuSeconds: "300",
  addressSpaceBytes: "2147483648",
  processCount: "128",
  openFiles: "1024",
  fileBytes: "1073741824",
} as const;

interface ActiveVerifier {
  child: ChildProcess;
  interrupted: boolean;
}

const activeVerifiers = new Map<ChildProcess, ActiveVerifier>();

function sandboxRequested(input?: { sandbox?: boolean }): boolean {
  // P1 #22: injected flag first; env fallback for standalone callers.
  if (input?.sandbox !== undefined) return input.sandbox;
  return process.env.KONTROL_VERIFY_SANDBOX === "1" || process.env.KONTROL_VERIFY_SANDBOX === "true";
}

function sandboxExecutable(): string {
  if (process.platform !== "linux") {
    throw new Error("Verification sandbox requested, but this host has no supported sandbox primitive.");
  }
  for (const candidate of [process.env.KONTROL_BWRAP, "/usr/bin/bwrap", "/bin/bwrap"]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error("Verification sandbox requested, but bubblewrap is unavailable; refusing unsandboxed execution.");
}

function sandboxArguments(
  executable: string,
  args: string[],
  cwd: string,
  environment: Record<string, string>,
  toolchainPaths: string[] = [],
): { command: string; args: string[] } {
  const bwrap = sandboxExecutable();
  const envArgs = Object.entries(environment).flatMap(([key, value]) => ["--setenv", key, value]);
  return {
    command: bwrap,
    args: [
      "--die-with-parent",
      "--unshare-all",
      "--new-session",
      "--clearenv",
      "--ro-bind-try", "/usr", "/usr",
      "--ro-bind-try", "/bin", "/bin",
      "--ro-bind-try", "/lib", "/lib",
      "--ro-bind-try", "/lib64", "/lib64",
      "--ro-bind-try", "/etc", "/etc",
      ...toolchainPaths
        .map((path) => resolve(path))
        .filter((path) => existsSync(path))
        .flatMap((path) => ["--ro-bind-try", path, path]),
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--dir", "/workspace",
      "--bind", cwd, "/workspace",
      "--chdir", "/workspace",
      ...envArgs,
      "/usr/bin/prlimit",
      `--cpu=${SANDBOX_RESOURCE_LIMITS.cpuSeconds}`,
      `--as=${SANDBOX_RESOURCE_LIMITS.addressSpaceBytes}`,
      `--nproc=${SANDBOX_RESOURCE_LIMITS.processCount}`,
      `--nofile=${SANDBOX_RESOURCE_LIMITS.openFiles}`,
      `--fsize=${SANDBOX_RESOURCE_LIMITS.fileBytes}`,
      "--",
      executable,
      ...args,
    ],
  };
}

export type VerificationResult = {
  criterionId: string;
  command: string;
  status: "passed" | "failed" | "inconclusive";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  outputTail: string;
  outputSha256: string;
  failureSetSha256: string;
  source: "executed" | "reused_exact_snapshot";
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

function createFailureSetFingerprint(command: string, output: string, exitCode: number | null, signal: string | null): string {
  const failureLines = output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && /(fail|error|panic|exception|assert|TS\d+|E\d{3,}|✕|not ok)/i.test(line))
    .map((line) => line
      .replace(/\b(?:line|Ln|at)\s*\d+\b/gi, "line")
      .replace(/:\d+(?::\d+)?\b/g, ":position")
      .replace(/\s+/g, " "))
    .sort();
  return createHash("sha256").update(JSON.stringify({ command, exitCode, signal, failureLines })).digest("hex");
}

function verificationCacheKey(command: string, commandVersion: string, environment: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify({
    command,
    commandVersion,
    relevantEnvironment: environment,
    verifierPolicyVersion: VERIFIER_POLICY_VERSION,
  })).digest("hex");
}

function parseDetails(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pathMatchesAffectedArea(path: string, area: string): boolean {
  const normalizedPath = path.replace(/^\.\//, "");
  const normalizedArea = area.trim().replace(/^\.\//, "").replace(/^a\//, "").replace(/^b\//, "");
  if (!normalizedArea) return false;
  if (normalizedArea.endsWith("/**")) return normalizedPath.startsWith(normalizedArea.slice(0, -3));
  if (normalizedArea.endsWith("/*")) return normalizedPath.startsWith(normalizedArea.slice(0, -1)) && !normalizedPath.slice(normalizedArea.length - 1).includes("/");
  return normalizedPath === normalizedArea || normalizedPath.startsWith(`${normalizedArea.replace(/\/$/, "")}/`);
}

export async function runVerificationCommand(
  command: string,
  cwd: string,
  timeoutMs = 300_000,
  deadlineAtMs = Date.now() + timeoutMs,
  sandbox?: boolean,
  childEnvironmentAllowlist?: string[],
  toolchainPaths?: string[],
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
      failureSetSha256: createFailureSetFingerprint(command, outputTail, null, null),
      source: "executed",
    };
  }
  const sandboxEnabled = sandboxRequested({ sandbox });
  const environment = buildChildEnvironment({ sandbox: sandboxEnabled, additionalKeys: childEnvironmentAllowlist });
  const launch = sandboxEnabled
    ? sandboxArguments(executable, args, cwd, environment, toolchainPaths)
    : { command: executable, args };
  return new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
    const active: ActiveVerifier = { child, interrupted: false };
    activeVerifiers.set(child, active);
    let output = "";
    let timedOut = false;
    let settled = false;
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
      if (settled) return;
      settled = true;
      activeVerifiers.delete(child);
      clearTimeout(timeout);
      output = (output + `\n${error.message}`).slice(-MAX_OUTPUT_BYTES);
      resolve({ status: active.interrupted ? "inconclusive" : "failed", exitCode: null, signal: null, durationMs: Date.now() - startedAt, outputTail: active.interrupted ? `${output}\nVerification interrupted during shutdown.` : output, outputSha256: createHash("sha256").update(output).digest("hex"), failureSetSha256: createFailureSetFingerprint(command, output, null, null), source: "executed" });
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      activeVerifiers.delete(child);
      clearTimeout(timeout);
      if (timedOut) output = `${output}\nVerification timed out.`.slice(-MAX_OUTPUT_BYTES);
      if (active.interrupted) output = `${output}\nVerification interrupted during shutdown.`.slice(-MAX_OUTPUT_BYTES);
      resolve({ status: active.interrupted ? "inconclusive" : exitCode === 0 && !timedOut ? "passed" : "failed", exitCode, signal, durationMs: Date.now() - startedAt, outputTail: output, outputSha256: createHash("sha256").update(output, "utf8").digest("hex"), failureSetSha256: createFailureSetFingerprint(command, output, exitCode, signal), source: "executed" });
    });
  });
}

/** Stop every verifier child and wait for its process group to drain. */
export async function shutdownMissionVerifiers(timeoutMs = 2_000): Promise<void> {
  const active = [...activeVerifiers.values()];
  for (const entry of active) {
    entry.interrupted = true;
    killVerifier(entry.child, "SIGTERM");
  }
  await waitForVerifierChildren(active, timeoutMs);
  for (const entry of active) {
    if (activeVerifiers.has(entry.child)) killVerifier(entry.child, "SIGKILL");
  }
  await waitForVerifierChildren(active, Math.min(timeoutMs, 500));
}

function killVerifier(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The child may have exited between the active-set snapshot and the kill.
  }
}

async function waitForVerifierChildren(active: ActiveVerifier[], timeoutMs: number): Promise<void> {
  const pending = active
    .filter((entry) => activeVerifiers.has(entry.child))
    .map((entry) => new Promise<void>((resolve) => entry.child.once("close", () => resolve())));
  if (pending.length === 0) return;
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([Promise.all(pending), timeout]);
}

interface VerificationWorkspace {
  root: string;
  cleanup(): Promise<void>;
}

/**
 * Materialize the submitted commit in a disposable worktree. Verification
 * commands may write there, but the reviewed checkout and its ignored files
 * are never their working directory.
 */
async function createVerificationWorkspace(
  workspaceId: string,
  workspaceRoot: string,
  snapshot: WorkspaceSnapshot,
  checkpoints: ReviewCheckpointManager,
): Promise<VerificationWorkspace> {
  if (snapshot.kind === "filesystem") {
    const parent = await mkdtemp(join(dirname(workspaceRoot), ".kontrol-verifier-"));
    const checkout = join(parent, "snapshot");
    try {
      await checkpoints.materializeSnapshot({ workspaceId, root: workspaceRoot, snapshot, destination: checkout });
      return { root: checkout, cleanup: async () => rm(parent, { recursive: true, force: true }) };
    } catch (error) {
      await rm(parent, { recursive: true, force: true });
      throw new VerificationBindingError(`Verification requires an immutable filesystem snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Lightweight test doubles do not expose the exact-tree binding API. The
  // production manager always does; retaining this fallback keeps command-unit
  // tests focused on verifier semantics rather than Git fixture setup.
  if (typeof checkpoints.assertTreeMatchesCommit !== "function") {
    return { root: workspaceRoot, cleanup: async () => undefined };
  }

  let gitRoot: string;
  try {
    gitRoot = (await git(workspaceRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const workspaceCanonical = await realpath(workspaceRoot);
    const relativeWorkspace = relative(resolve(gitRoot), workspaceCanonical);
    if (relativeWorkspace.startsWith("..")) throw new Error("workspace is not below its Git root");

    const parent = await mkdtemp(join(dirname(workspaceRoot), ".kontrol-verifier-"));
    const checkout = join(parent, "snapshot");
    let added = false;
    try {
      await git(gitRoot, ["worktree", "add", "--detach", checkout, snapshot.ref]);
      added = true;
      const actualCommit = (await git(checkout, ["rev-parse", "HEAD"])).stdout.trim();
      if (actualCommit !== snapshot.ref) throw new Error("materialized verification worktree does not match the submitted snapshot");
      const root = relativeWorkspace ? resolve(checkout, relativeWorkspace) : checkout;
      return {
        root,
        cleanup: async () => {
          if (added) await git(gitRoot, ["worktree", "remove", "--force", checkout]).catch(() => undefined);
          await rm(parent, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (added) await git(gitRoot, ["worktree", "remove", "--force", checkout]).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    throw new VerificationBindingError(`Verification requires a disposable Git snapshot worktree: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    failureSetSha256: createFailureSetFingerprint(command, reason, null, null),
    source: "executed",
  };
}

export async function verifyMissionSubmission(input: {
  workSessionId: string;
  missionLedger: MissionLedger;
  workSessions: WorkSessionManager;
  workspaces: WorkspaceRegistry;
  reviewCheckpoints: ReviewCheckpointManager;
  criterionIds?: string[];
  /** P1 #22: injected configuration (parsed once in config.ts). */
  maxInflight?: number;
  sandbox?: boolean;
  childEnvironmentAllowlist?: string[];
  verifyToolchainPaths?: string[];
  /** Submission identity captured by the caller before dispatching verification. */
  submissionId?: string;
  reviewEpoch?: number;
  /** One absolute wall-clock deadline shared by every criterion and final check. */
  deadlineAtMs?: number;
  /** Progressive verification scope. Focused requires criterionIds; affected uses the submitted diff paths. */
  verificationScope?: "focused" | "affected" | "full";
  /** Progressive checks are safe to run during correction; final checks explicitly unlock finalOnly criteria and final integration. */
  verificationPhase?: "progressive" | "final";
}): Promise<VerificationResult[]> {
  const mission = input.missionLedger.getMissionByWorkSession(input.workSessionId);
  const session = input.workSessions.get(input.workSessionId);
  const latest = session?.latestSubmission;
  const snapshotKind = latest?.snapshotKind ?? (latest?.snapshotCommit?.startsWith("fs:") ? "filesystem" : latest?.snapshotCommit ? "git" : undefined);
  const snapshotRef = latest?.snapshotRef ?? latest?.snapshotCommit;
  if (!mission || !session || !latest?.id || !snapshotKind || !snapshotRef) throw new Error("A submitted mission snapshot is required.");
  const submittedSnapshot: WorkspaceSnapshot = { kind: snapshotKind, ref: snapshotRef, createdAt: latest.createdAt };
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

    const matches = input.reviewCheckpoints.assertSnapshotMatches
      ? await input.reviewCheckpoints.assertSnapshotMatches({ workspaceId: session.workspaceSessionId, root: workspace.root, expected: submittedSnapshot })
      : input.reviewCheckpoints.assertTreeMatchesCommit
        ? await input.reviewCheckpoints.assertTreeMatchesCommit({ workspaceId: session.workspaceSessionId, root: workspace.root, baselineCommit: snapshotRef })
        : (await input.reviewCheckpoints.reviewChangesAgainstCommit({ workspaceId: session.workspaceSessionId, root: workspace.root, baselineCommit: snapshotRef })).summary.files === 0;
    if (!matches) {
      throw new VerificationBindingError("Verification blocked: workspace no longer matches the submitted snapshot.");
    }
  };

  // Snapshot commits are synthetic working-tree commits. Their parent changes
  // when a review checkpoint advances, so commit identity alone is not a
  // stable representation of identical tree content. Compare the current tree
  // against the exact submitted snapshot instead.
  await assertBinding();
  const packet = input.missionLedger.getPacket(input.workSessionId);
  const explicitlySelected = input.criterionIds?.length ? new Set(input.criterionIds) : undefined;
  const requestedScope = input.verificationScope ?? (explicitlySelected ? "focused" : "full");
  const finalPhase = input.verificationPhase === "final";
  // Git's structured numstat metadata is the path protocol. Unified diffs are
  // presentation data and are ambiguous for quoted, renamed, or newline
  // containing paths. Missing metadata on legacy submissions is conservative:
  // affected-area filters cannot skip checks.
  const changedPaths = latest.files?.flatMap((file) => [file.path, file.previousPath].filter((path): path is string => Boolean(path))) ?? [];
  const scopeAllows = (criterion: typeof packet.criteria[number]): boolean => {
    if (requestedScope === "full") return true;
    if (requestedScope === "focused") return Boolean(explicitlySelected?.has(criterion.id));
    if ((criterion.affectedAreas ?? []).length === 0 || changedPaths.length === 0) return true;
    return criterion.affectedAreas!.some((area) => changedPaths.some((path) => pathMatchesAffectedArea(path, area)));
  };
  const selectedWithDependencies = explicitlySelected ? new Set(explicitlySelected) : undefined;
  if (selectedWithDependencies) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const criterion of packet.criteria) {
        if (!selectedWithDependencies.has(criterion.id)) continue;
        for (const dependency of criterion.dependsOnCriterionIds ?? []) {
          if (!selectedWithDependencies.has(dependency)) {
            selectedWithDependencies.add(dependency);
            changed = true;
          }
        }
      }
    }
  }
  const criteria = packet.criteria.filter((criterion) => !!criterion.verificationCommand
    && (!selectedWithDependencies || selectedWithDependencies.has(criterion.id))
    && scopeAllows(criterion)
    && (!criterion.finalOnly || finalPhase || explicitlySelected?.has(criterion.id)));
  const verificationWorkspace = await createVerificationWorkspace(session.workspaceSessionId, workspace.root, submittedSnapshot, input.reviewCheckpoints);
  try {
  const results: VerificationResult[] = [];
  const pendingEvidence: Array<{ criterionId: string; submissionId: string; reviewEpoch: number; snapshotKind: "git" | "filesystem"; snapshotRef: string; snapshotCommit: string; leaseNonce?: string; command: string; status: "passed" | "failed" | "inconclusive"; source: "server_test_runner"; details: Record<string, unknown> }> = [];
  let bindingLost = false;
  const sandboxEnabled = sandboxRequested({ sandbox: input.sandbox });
  const environment = buildChildEnvironment({ sandbox: sandboxEnabled });
  // P1 #22: injected configuration; env fallback for standalone callers.
  const maxVerificationInflight = input.maxInflight ?? parsePositiveInteger(process.env.KONTROL_VERIFY_MAX_INFLIGHT, 3);
  const statuses = new Map<string, VerificationResult["status"]>();
  const remaining = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const packetCriterionById = new Map(packet.criteria.map((criterion) => [criterion.id, criterion]));
  const dependencyStatus = (dependencyId: string): VerificationResult["status"] | undefined => {
    const executed = statuses.get(dependencyId);
    if (executed) return executed;
    const persisted = packetCriterionById.get(dependencyId);
    if (persisted?.status === "verified") return "passed";
    if (persisted?.status === "failed") return "failed";
    return undefined;
  };

  const recordResult = (criterion: typeof criteria[number], result: Omit<VerificationResult, "criterionId" | "command">): VerificationResult => {
    const command = criterion.verificationCommand!;
    const full = { criterionId: criterion.id, command, ...result };
    pendingEvidence.push({ criterionId: criterion.id, submissionId: latest.id, reviewEpoch: latest.reviewEpoch ?? 0, snapshotKind, snapshotRef, snapshotCommit: snapshotRef, leaseNonce: boundLeaseNonce, command, source: "server_test_runner", status: result.status, details: { exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, deadlineAtMs, outputTail: result.outputTail, outputSha256: result.outputSha256, failureSetSha256: result.failureSetSha256, cacheKey: verificationCacheKey(command, criterion.commandVersion ?? DEFAULT_COMMAND_VERSION, environment), provenance: result.source } });
    results.push(full);
    statuses.set(criterion.id, result.status);
    return full;
  };

  const runCriterion = async (criterion: typeof criteria[number]): Promise<VerificationResult> => {
    const command = criterion.verificationCommand!;
    try {
      await assertBinding();
      const cacheKey = verificationCacheKey(command, criterion.commandVersion ?? DEFAULT_COMMAND_VERSION, environment);
      // "unspecified" is not a toolchain identity. Never reuse evidence across
      // verifier invocations unless the mission supplies a deterministic
      // command version (or an equivalent toolchain fingerprint).
      const cached = criterion.commandVersion
        ? packet.evidence.find((entry) => {
            const details = parseDetails(entry.details);
            return entry.criterionId === criterion.id && entry.command === command && entry.submissionId === latest.id && entry.reviewEpoch === (latest.reviewEpoch ?? 0) && entry.snapshotCommit === latest.snapshotCommit && entry.status !== "inconclusive" && details.cacheKey === cacheKey;
          })
        : undefined;
      let result: Omit<VerificationResult, "criterionId" | "command">;
      if (cached) {
        const details = parseDetails(cached.details);
        const cachedStatus: VerificationResult["status"] = cached.status === "passed" || cached.status === "failed" || cached.status === "inconclusive" ? cached.status : "inconclusive";
        result = {
          status: cachedStatus,
          exitCode: typeof details.exitCode === "number" ? details.exitCode : cachedStatus === "passed" ? 0 : null,
          signal: typeof details.signal === "string" ? details.signal : null,
          durationMs: 0,
          outputTail: typeof details.outputTail === "string" ? details.outputTail : "Reused exact-snapshot verification evidence.",
          outputSha256: typeof details.outputSha256 === "string" ? details.outputSha256 : "",
          failureSetSha256: typeof details.failureSetSha256 === "string" ? details.failureSetSha256 : createFailureSetFingerprint(command, String(details.outputTail ?? ""), typeof details.exitCode === "number" ? details.exitCode : null, typeof details.signal === "string" ? details.signal : null),
          source: "reused_exact_snapshot",
        };
      } else {
        result = await runVerificationCommand(command, verificationWorkspace.root, 300_000, deadlineAtMs, sandboxEnabled, input.childEnvironmentAllowlist, input.verifyToolchainPaths);
      }
      await assertBinding();
      return recordResult(criterion, result);
    } catch (error) {
      const outputTail = error instanceof Error ? error.message : String(error);
      if (error instanceof VerificationBindingError) bindingLost = true;
      return recordResult(criterion, inconclusiveResult(criterion.id, command, outputTail));
    }
  };

  while (remaining.size > 0 && !bindingLost) {
    const ready = [...remaining.values()].filter((criterion) => (criterion.dependsOnCriterionIds ?? []).every((dependency) => dependencyStatus(dependency) !== undefined));
    if (ready.length === 0) throw new VerificationBindingError("Verification dependency graph could not be scheduled.");
    const runnable = ready.filter((criterion) => !(criterion.dependsOnCriterionIds ?? []).some((dependency) => dependencyStatus(dependency) !== "passed"));
    const blocked = ready.filter((criterion) => !runnable.includes(criterion));
    const batch = runnable.length > 0 ? runnable.filter((criterion) => !criterion.mutatesWorkspace).slice(0, maxVerificationInflight) : blocked.slice(0, maxVerificationInflight);
    if (batch.length === 0) batch.push(ready[0]!);
    for (const criterion of batch) remaining.delete(criterion.id);
    if (batch.some((criterion) => criterion.mutatesWorkspace)) {
      const criterion = batch.find((candidate) => candidate.mutatesWorkspace)!;
      if ((criterion.dependsOnCriterionIds ?? []).some((dependency) => dependencyStatus(dependency) !== "passed")) recordResult(criterion, inconclusiveResult(criterion.id, criterion.verificationCommand!, "Verification skipped because a prerequisite criterion failed."));
      else await runCriterion(criterion);
    } else {
      await Promise.all(batch.map(async (criterion) => {
        if ((criterion.dependsOnCriterionIds ?? []).some((dependency) => dependencyStatus(dependency) !== "passed")) recordResult(criterion, inconclusiveResult(criterion.id, criterion.verificationCommand!, "Verification skipped because a prerequisite criterion failed."));
        else await runCriterion(criterion);
      }));
    }
  }
  if (bindingLost) {
    const entries = pendingEvidence.map(({ source: _source, ...entry }) => ({ ...entry, status: "inconclusive" as const }));
    if (input.missionLedger.recordVerifierEvidence) input.missionLedger.recordVerifierEvidence(mission.id, entries);
    else input.missionLedger.recordEvidence(mission.id, pendingEvidence.map((entry) => ({ ...entry, status: "inconclusive" as const })));
    return results.map((result) => result.status === "passed" ? { ...result, status: "inconclusive" as const } : result);
  }
  const trustedEntries = pendingEvidence.map(({ source: _source, ...entry }) => entry);
  if (input.missionLedger.recordVerifierEvidence) input.missionLedger.recordVerifierEvidence(mission.id, trustedEntries);
  else input.missionLedger.recordEvidence(mission.id, pendingEvidence);
  // Final integration commands run only after every required criterion is
  // currently verified. Their report is independently bound to this snapshot.
  const refreshed = input.missionLedger.getPacket(input.workSessionId);
  const requiredReady = refreshed.criteria.filter((criterion) => criterion.priority === "required").every((criterion) => criterion.status === "verified");
  if (requiredReady && mission.finalVerification.length) {
    const finalResults: Array<Omit<VerificationResult, "criterionId"> & { cacheKey: string }> = [];
    for (const command of mission.finalVerification) {
      const cacheKey = verificationCacheKey(command, DEFAULT_COMMAND_VERSION, environment);
      let result: Omit<VerificationResult, "criterionId" | "command">;
      try {
        await assertBinding();
        // Final verification has no per-command version field yet, so it is
        // deliberately re-executed on every final pass. This avoids treating a
        // cache key containing "unspecified" as evidence of the same toolchain.
        const cached = undefined as Record<string, unknown> | undefined;
        if (cached) {
          result = {
            status: cached.status as "passed" | "failed",
            exitCode: typeof cached.exitCode === "number" ? cached.exitCode : null,
            signal: typeof cached.signal === "string" ? cached.signal : null,
            durationMs: 0,
            outputTail: typeof cached.outputTail === "string" ? cached.outputTail : "Reused exact-snapshot final verification evidence.",
            outputSha256: typeof cached.outputSha256 === "string" ? cached.outputSha256 : "",
            failureSetSha256: typeof cached.failureSetSha256 === "string" ? cached.failureSetSha256 : "",
            source: "reused_exact_snapshot",
          };
        } else {
          result = await runVerificationCommand(command, verificationWorkspace.root, 300_000, deadlineAtMs, sandboxEnabled, input.childEnvironmentAllowlist, input.verifyToolchainPaths);
        }
        await assertBinding();
      }
      catch (error) {
        const outputTail = error instanceof Error ? error.message : String(error);
        if (error instanceof VerificationBindingError) {
          return results.concat(inconclusiveResult(`final:${finalResults.length + 1}`, command, outputTail));
        }
        result = { status: "failed", exitCode: null, signal: null, durationMs: 0, outputTail, outputSha256: createHash("sha256").update(outputTail).digest("hex"), failureSetSha256: createFailureSetFingerprint(command, outputTail, null, null), source: "executed" };
      }
      finalResults.push({ command, cacheKey, ...result });
      results.push({ criterionId: `final:${finalResults.length}`, command, ...result });
    }
    input.missionLedger.recordCompletionReport(mission.id, {
      submissionId: latest.id,
      snapshotKind,
      snapshotRef,
      snapshotCommit: snapshotRef,
      status: finalResults.every((result) => result.status === "passed") ? "passed" : "failed",
      results: finalResults,
    });
  }
  return results;
  } finally {
    await verificationWorkspace.cleanup();
  }
}
