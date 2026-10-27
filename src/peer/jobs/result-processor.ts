/** Reconcile a peer result into a bounded local snapshot and the reviewer workflow. */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ReviewCheckpointManager } from "../../review-checkpoints.js";
import type { ReviewWorkflowService } from "../../review-workflow.js";
import type { WorkSessionManager } from "../../work-sessions/index.js";
import type { WorkspaceRegistry } from "../../workspaces.js";
import { assertNoSymlinkComponentsSync, isPathInsideRoot } from "../../roots.js";
import { PeerJobError } from "./contracts.js";
import type { PeerJob, PeerJobResultReceipt } from "./contracts.js";
import type { PeerArtifactStore } from "./artifacts.js";
import type { PeerJobStore } from "./store.js";
import type { MissionLedger } from "../../mission-ledger.js";
import type { ServerConfig } from "../../config.js";
import { verifyMissionSubmission } from "../../mission-verifier.js";
import { missionVerificationOptionsFromConfig } from "../../bridge/verification-options.js";

function receiptIdentity(receipt: PeerJobResultReceipt): string {
  const files = [...receipt.files].map((file) => ({
    path: file.path,
    sha256: file.sha256,
    bytes: file.bytes,
  })).sort((a, b) => a.path.localeCompare(b.path));
  return createHash("sha256").update(JSON.stringify({
    jobId: receipt.jobId,
    attemptId: receipt.attemptId,
    baseRevision: receipt.baseRevision,
    manifestSha256: receipt.manifestSha256,
    files,
    totalBytes: receipt.totalBytes,
  })).digest("hex");
}

function writeArtifact(root: string, path: string, bytes: Buffer): void {
  const target = resolve(root, path);
  if (!isPathInsideRoot(target, root) || target === resolve(root)) {
    throw new PeerJobError("path_traversal", "Artifact path escapes the managed workspace", 422);
  }
  const parent = dirname(target);
  assertNoSymlinkComponentsSync(parent);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  assertNoSymlinkComponentsSync(parent);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new PeerJobError("unsafe_artifact_target", `Refusing to replace non-file workspace target ${path}`, 409);
    }
    const current = readFileSync(target);
    if (createHash("sha256").update(current).digest("hex") === createHash("sha256").update(bytes).digest("hex")) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  const temporary = `${target}.${expectedHash}.peer.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    assertExpectedTemporary(temporary, expectedHash, path);
  }
  assertNoSymlinkComponentsSync(parent);
  renameSync(temporary, target);
  const dirFd = openSync(parent, "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

/** Complete only the exact content-addressed temp left by this receipt. */
function recoverArtifactTemporary(root: string, path: string, bytes: Buffer): void {
  const target = resolve(root, path);
  if (!isPathInsideRoot(target, root) || target === resolve(root)) {
    throw new PeerJobError("path_traversal", "Artifact path escapes the managed workspace", 422);
  }
  const parent = dirname(target);
  assertNoSymlinkComponentsSync(parent);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const temporary = `${target}.${hash}.peer.tmp`;
  try {
    lstatSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  assertExpectedTemporary(temporary, hash, path);
  assertNoSymlinkComponentsSync(parent);
  renameSync(temporary, target);
  const dirFd = openSync(parent, "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

function assertExpectedTemporary(temporary: string, expectedHash: string, path: string): void {
  const stat = lstatSync(temporary);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new PeerJobError("unsafe_artifact_temporary", `Refusing to recover non-file temporary for ${path}`, 409);
  }
  const actualHash = createHash("sha256").update(readFileSync(temporary)).digest("hex");
  if (actualHash !== expectedHash) {
    throw new PeerJobError("artifact_temporary_conflict", `Temporary content for ${path} does not match the active receipt`, 409);
  }
}

export interface PeerJobResultProcessorDeps {
  store: PeerJobStore;
  artifacts: PeerArtifactStore;
  workspaces: WorkspaceRegistry;
  workSessions: WorkSessionManager;
  reviewCheckpoints: ReviewCheckpointManager;
  reviewWorkflow: ReviewWorkflowService;
  missionLedger?: MissionLedger;
  serverConfig?: ServerConfig;
}

export function createPeerJobResultProcessor(deps: PeerJobResultProcessorDeps) {
  const active = new Set<string>();
  const workspaceTails = new Map<string, Promise<void>>();

  async function acquireWorkspace(workspaceSessionId: string): Promise<() => void> {
    const previous = workspaceTails.get(workspaceSessionId);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    workspaceTails.set(workspaceSessionId, tail);
    await previous;
    return () => {
      release();
      if (workspaceTails.get(workspaceSessionId) === tail) workspaceTails.delete(workspaceSessionId);
    };
  }

  async function process(job: PeerJob): Promise<void> {
    const canRecoverVerification = job.status === "awaiting_review"
      && job.resultProcessing?.verificationStatus === undefined;
    if (active.has(job.jobId) || (job.status !== "result_received" && job.status !== "staging" && !canRecoverVerification)) return;
    active.add(job.jobId);
    let releaseWorkspace = () => {};
    let peerLeaseNonce: string | undefined;
    try {
      if (!job.workspaceSessionId) {
        throw new PeerJobError("result_target_missing", "Peer result has no bound workspace", 409);
      }
      const targetWorkspace = deps.workspaces.getWorkspace(job.workspaceSessionId);
      // Workspace IDs are owner/session scoped and can differ while pointing
      // at the same managed checkout. Serialize mutations by the canonical
      // filesystem root so aliases cannot stage competing results in parallel.
      const canonicalRoot = await realpath(targetWorkspace.root);
      releaseWorkspace = await acquireWorkspace(canonicalRoot);
      // The job object may have been captured before another queued receipt
      // finished staging. Re-read authoritative status only after taking the
      // workspace lock, so stale callers cannot stage a second result against
      // a worktree that has already advanced.
      const currentJob = deps.store.getJob(job.jobId);
      const currentNeedsVerification = currentJob?.status === "awaiting_review"
        && currentJob.resultProcessing?.verificationStatus === undefined;
      if (!currentJob || (currentJob.status !== "result_received" && currentJob.status !== "staging" && !currentNeedsVerification)) return;
      job = currentJob;
      if (!job.workSessionId) {
        throw new PeerJobError("result_target_missing", "Peer result has no bound work session", 409);
      }
      const reservation = deps.workSessions.acquireWorkspaceLease({
        canonicalRoot,
        workspaceSessionId: job.workspaceSessionId,
        workSessionId: job.workSessionId,
        ownerInstanceId: `peer-job:${job.jobId}`,
        leaseKind: "peer_job",
        // This is a durable workflow reservation, not a worker heartbeat
        // lease. It remains fenced through uncertain result recovery and is
        // released only after the local snapshot is linked to reviewer state.
        ttlMs: 100 * 365 * 24 * 60 * 60 * 1000,
      });
      if (!reservation.acquired) {
        throw new PeerJobError("workspace_lease_conflict", `Workspace is reserved by work session ${reservation.conflictingWorkSessionId}`, 409);
      }
      peerLeaseNonce = reservation.lease.leaseNonce;
      const attempts = deps.store.listAttemptsForJob(job.jobId);
      const attempt = [...attempts].reverse().find((candidate) => candidate.receipt?.terminalState === "succeeded");
      const receipt = attempt?.receipt;
      if (!attempt || !receipt) {
        // `result_received` is only valid when its successful receipt is
        // durable. Treat a missing receipt as an explicit reconciliation
        // failure; silently returning here would leave the job looking
        // retryable while its long-lived workspace reservation stayed held.
        throw new PeerJobError("result_receipt_missing", "Peer result has no durable successful receipt to stage", 409);
      }
      const receiptSha256 = receiptIdentity(receipt);
      deps.store.markStaging(job.jobId, receiptSha256, Date.now());

      if (!job.workSessionId || !job.workspaceSessionId) {
        throw new PeerJobError("result_target_missing", "Peer result has no bound work session and workspace", 409);
      }
      const workSession = deps.workSessions.get(job.workSessionId);
      if (!workSession || workSession.workspaceSessionId !== job.workspaceSessionId) {
        throw new PeerJobError("result_target_mismatch", "Bound work session no longer matches the job workspace", 409);
      }
      if (!["in_progress", "changes_requested", "resuming"].includes(workSession.status)) {
        throw new PeerJobError("work_session_not_submittable", `Bound work session is ${workSession.status}`, 409);
      }
      const workspace = deps.workspaces.getWorkspace(job.workspaceSessionId);
      if (workspace.mode !== "worktree" || workspace.worktree?.managed !== true || workspace.sourceRoot !== job.repositoryId || workspace.worktree.baseSha !== job.baseRevision) {
        throw new PeerJobError("result_workspace_mismatch", "Bound workspace is not the expected managed worktree and base", 409);
      }
      const files = deps.artifacts.readReceipt(job, attempt.attemptId, receipt);
      const expectedPaths = new Set(files.keys());

      // A crash after writing and fsyncing a temporary but before rename must
      // not turn that known, receipt-bound file into an unrelated workspace
      // mutation on restart. Recover only a content-addressed temp for one of
      // this receipt's declared output paths; unknown files remain untouched.
      for (const [path, bytes] of files) recoverArtifactTemporary(workspace.root, path, bytes);

      // A restart may find a partially staged result. Allow only changes to
      // declared paths, and only when each current file is already the exact
      // expected content. This makes replay idempotent without clobbering
      // unrelated workspace edits.
      const before = await deps.reviewCheckpoints.reviewChangesAgainstCommit({
        workspaceId: workspace.id,
        root: workspace.root,
        baselineCommit: job.baseRevision,
      });
      for (const changed of before.files) {
        if (!expectedPaths.has(changed.path)) {
          throw new PeerJobError("workspace_changed_during_peer_job", `Workspace contains an undeclared change at ${changed.path}`, 409);
        }
        const expected = files.get(changed.path)!;
        try {
          const current = readFileSync(resolve(workspace.root, changed.path));
          if (createHash("sha256").update(current).digest("hex") !== createHash("sha256").update(expected).digest("hex")) {
            throw new PeerJobError("workspace_changed_during_peer_job", `Workspace content differs from the peer artifact at ${changed.path}`, 409);
          }
        } catch (error) {
          if (error instanceof PeerJobError) throw error;
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      for (const [path, bytes] of files) writeArtifact(workspace.root, path, bytes);

      const changes = await deps.reviewCheckpoints.reviewChangesAgainstCommit({
        workspaceId: workspace.id,
        root: workspace.root,
        baselineCommit: job.baseRevision,
      });
      for (const changed of changes.files) {
        if (!expectedPaths.has(changed.path)) {
          throw new PeerJobError("workspace_changed_during_peer_job", `Snapshot contains an undeclared change at ${changed.path}`, 409);
        }
      }
      const diffSha256 = createHash("sha256").update(changes.patch, "utf8").digest("hex");
      const existingSubmission = deps.workSessions.getSubmissions(job.workSessionId).find((submission) =>
        submission.diffSha256 === diffSha256 &&
        submission.snapshotKind === changes.snapshotKind &&
        submission.snapshotRef === changes.snapshotRef,
      );
      const submission = existingSubmission
        ? { submissionId: existingSubmission.id, reviewEpoch: existingSubmission.reviewEpoch }
        : await deps.reviewWorkflow.submitForReview({
            workSessionId: job.workSessionId,
            diff: changes.patch,
            diffSha256,
            message: `Peer job ${job.jobId}: ${receipt.summary ?? "result submitted for review"}`,
            summaryJson: JSON.stringify(changes.summary),
            files: changes.files.length,
            changedFiles: changes.files,
            additions: changes.summary.additions,
            removals: changes.summary.removals,
            snapshotKind: changes.snapshotKind,
            snapshotRef: changes.snapshotRef,
          });
      let verificationReceipt: {
        status: "passed" | "failed" | "inconclusive" | "not_configured";
        evidenceSha256?: string;
      } | undefined;
      const mission = deps.missionLedger?.getMissionByWorkSession(job.workSessionId);
      if (!mission) {
        verificationReceipt = { status: "not_configured" };
      } else {
        if (!deps.serverConfig) throw new PeerJobError("verification_configuration_missing", "Mission verification configuration is unavailable", 503);
        let verification: Awaited<ReturnType<typeof verifyMissionSubmission>>;
        try {
          verification = await verifyMissionSubmission({
            workSessionId: job.workSessionId,
            missionLedger: deps.missionLedger!,
            workSessions: deps.workSessions,
            workspaces: deps.workspaces,
            reviewCheckpoints: deps.reviewCheckpoints,
            submissionId: submission.submissionId,
            reviewEpoch: submission.reviewEpoch,
            verificationScope: "full",
            verificationPhase: "final",
            ...missionVerificationOptionsFromConfig(deps.serverConfig),
          });
        } catch (error) {
          const category = error instanceof PeerJobError ? error.code : error instanceof Error ? error.name : "verification_failed";
          verificationReceipt = {
            status: "inconclusive",
            evidenceSha256: createHash("sha256").update(category).digest("hex"),
          };
          verification = [];
        }
        if (!verificationReceipt) {
          const statuses = new Set(verification.map((result) => result.status));
          const status = verification.length === 0
            ? "inconclusive"
            : statuses.has("failed")
            ? "failed"
            : statuses.has("inconclusive") ? "inconclusive" : "passed";
          const evidence = verification.map((result) => ({ criterionId: result.criterionId, status: result.status, outputSha256: result.outputSha256, failureSetSha256: result.failureSetSha256, source: result.source }));
          verificationReceipt = {
            status,
            evidenceSha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
          };
        }
      }
      // Persist review linkage and the result's verification receipt in one
      // SQLite transition. A crash cannot leave an awaiting_review job whose
      // required verification state was skipped by startup reconciliation.
      deps.store.markAwaitingReview(job.jobId, {
        receiptSha256,
        submissionId: submission.submissionId,
        reviewEpoch: submission.reviewEpoch,
        snapshotKind: changes.snapshotKind,
        snapshotRef: changes.snapshotRef,
        diffSha256,
        verificationStatus: verificationReceipt.status,
        verificationEvidenceSha256: verificationReceipt.evidenceSha256,
      }, Date.now());
      if (peerLeaseNonce) {
        deps.workSessions.releaseWorkspaceLeaseForSession(job.workSessionId, peerLeaseNonce);
        peerLeaseNonce = undefined;
      }
    } catch (error) {
      const reason = error instanceof PeerJobError ? error.code : error instanceof Error ? error.name : "unknown_result_processing_failure";
      deps.store.markAwaitingReconciliation(job.jobId, reason, Date.now());
    } finally {
      releaseWorkspace();
      active.delete(job.jobId);
    }
  }

  return { process };
}
