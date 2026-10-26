import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { dispatchScheduledJob } from "./scheduled-job-dispatch.js";
import { openPeerJobStore } from "../peer/jobs/store.js";
import { createPeerArtifactStore } from "../peer/jobs/artifacts.js";
import { createPeerJobResultProcessor } from "../peer/jobs/result-processor.js";
import { manifestSha256 } from "../peer/jobs/service.js";

let modeCapability: Record<string, unknown> = {
  supported: true,
  grantPolicy: "kontrol_signed_attempt_bound",
  confinementAvailable: false,
  executableAvailable: true,
  toolchainAvailable: true,
  cliInputContract: "hermes_public_acp_v1_session_prompt",
  networkPolicies: ["disabled", "host"],
};

const server = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    ready: true,
    executionCapabilities: {
      read_only_audit: modeCapability,
    },
  }));
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const agent = {
    id: "agent-hermes",
    name: "hermes-agent",
    url: `http://127.0.0.1:${address.port}`,
    role: "agent",
    capabilities: ["scheduled:read_only_audit"],
  };
  let sessionCreations = 0;
  const config = {
    workspaces: { getWorkspace: () => ({ root: "/tmp/scheduled-preflight" }) },
    agentRegistry: { listAlive: () => [agent] },
    adapterSecret: undefined,
    workSessions: {
      create: () => { sessionCreations += 1; return { id: "must-not-start" }; },
      updateStatus: () => undefined,
    },
    serverConfig: { readOnlyExecutionNetworkPolicy: "disabled" },
  } as any;
  const job = {
    id: "scheduled-preflight",
    projectId: "project-preflight",
    workspaceRoot: "/tmp/scheduled-preflight",
    agentName: "hermes-agent",
    executionMode: "read_only_audit",
    instructionJson: { instructions: "Audit safely." },
    ownerContextId: "owner-preflight",
    principalId: "principal-preflight",
    maxRuntimeMs: 60_000,
  } as any;

  const incompatible = await dispatchScheduledJob(config, {} as any, { ...job, executionMode: "bounded_file_write" });
  assert.equal(incompatible.status, "blocked");
  assert.equal(incompatible.blockerKind, "permanent_configuration");
  assert.equal(incompatible.failureClass, "execution_mode_unsupported");
  assert.equal(sessionCreations, 0, "an adapter without the exact mode capability is rejected before work-session creation");

  const unavailableSandbox = await dispatchScheduledJob(config, {} as any, job);
  assert.equal(unavailableSandbox.status, "blocked");
  assert.equal(unavailableSandbox.blockerKind, "permanent_configuration");
  assert.equal(unavailableSandbox.failureClass, "execution_mode_preflight_failed");
  assert.equal(unavailableSandbox.probeResult?.selectedAgent, "hermes-agent");
  assert.match(unavailableSandbox.reason ?? "", /bubblewrap\/prlimit confinement is unavailable/);
  assert.equal(sessionCreations, 0, "a sandbox failure is classified before any scheduled worker can start");

  modeCapability = { ...modeCapability, confinementAvailable: true, toolchainAvailable: false, toolchainFailure: "acp_python_packages_not_allowlisted" };
  const unavailableToolchain = await dispatchScheduledJob(config, {} as any, job);
  assert.equal(unavailableToolchain.status, "blocked");
  assert.equal(unavailableToolchain.failureClass, "execution_mode_preflight_failed");
  assert.equal(unavailableToolchain.probeResult?.toolchainAvailable, false);
  assert.match(unavailableToolchain.reason ?? "", /Python runtime or ACP SDK.*approved sandbox toolchains/);
  assert.equal(sessionCreations, 0, "a missing Hermes toolchain is rejected before scheduled worker creation");

  const peerState = mkdtempSync(join(tmpdir(), "scheduled-peer-dispatch-"));
  const peerStore = openPeerJobStore(peerState, { level: "silent", format: "json", requests: false, assets: false, toolCalls: false, shellCommands: false } as any);
  try {
    const worktreeRoot = join(peerState, "worktree");
    const repositoryRoot = join(peerState, "repository");
    mkdirSync(worktreeRoot, { recursive: true });
    mkdirSync(repositoryRoot, { recursive: true });
    const baseRevision = "0123456789abcdef0123456789abcdef01234567";
    let scheduledJob: any = {
      ...job,
      id: "scheduled-peer-job",
      projectId: "workspace-peer-worktree",
      dispatchTarget: { kind: "peer_pull", peerId: "peer-a" },
      agentName: undefined,
      executionMode: "read_only_audit",
      instructionJson: { instructions: "Inspect the code and report findings." },
      policySnapshotJson: { allowedOutputs: [{ path: "reports/audit.md" }] },
    };
    let session: any;
    let workSessionCreates = 0;
    const schedulerConfig = {
      workspaces: {
        getWorkspace: () => ({
          id: "workspace-peer-worktree",
          root: worktreeRoot,
          mode: "worktree",
          sourceRoot: repositoryRoot,
          worktree: { managed: true, baseSha: baseRevision },
        }),
      },
      workSessions: {
        create: (input: any) => {
          workSessionCreates += 1;
          session = { id: "wsess-scheduled-peer", workspaceSessionId: input.workspaceSessionId, status: "in_progress" };
          return session;
        },
        get: () => session,
        updateStatus: () => undefined,
      },
      serverConfig: {
        peer: {
          enabled: true,
          maxClaimedJobs: 2,
          allowedPeers: [{ id: "peer-a", capabilities: ["job:claim", "job:complete"], grantedRoots: [repositoryRoot] }],
        },
      },
    } as any;
    const scheduledStore = {
      get: () => scheduledJob,
      bindWorkSession: (input: any) => { scheduledJob = { ...scheduledJob, workSessionId: input.workSessionId }; return scheduledJob; },
    } as any;
    const dispatchOptions = {
      dispatchId: "dispatch-scheduled-peer-1",
      dispatchAttemptId: "scheduled-attempt-1",
      peerJobStore: peerStore,
    };
    const first = await dispatchScheduledJob(schedulerConfig, scheduledStore, scheduledJob, dispatchOptions);
    assert.equal(first.status, "dispatched");
    assert.equal(first.workSessionId, "wsess-scheduled-peer");
    const firstPeerJobId = first.probeResult?.peerJobId as string;
    assert.match(firstPeerJobId, /^job_[0-9a-f-]{36}$/i);
    const firstPeerJob = peerStore.getJob(firstPeerJobId)!;
    assert.equal(firstPeerJob.workspaceSessionId, "workspace-peer-worktree");
    assert.equal(firstPeerJob.schedulerDispatchId, dispatchOptions.dispatchId, "the peer job is bound to the exact scheduler dispatch identity");
    assert.equal(firstPeerJob.repositoryId, repositoryRoot);
    assert.equal(firstPeerJob.baseRevision, baseRevision);
    assert.deepEqual(firstPeerJob.allowedOutputs, ["reports/audit.md"]);
    assert.match(firstPeerJob.instructions, /reports\/audit\.md/);

    const retry = await dispatchScheduledJob(schedulerConfig, scheduledStore, scheduledJob, dispatchOptions);
    assert.equal(retry.status, "dispatched");
    assert.equal(retry.probeResult?.peerJobId, firstPeerJobId, "response-loss retry returns the exact durable peer job");
    assert.equal(workSessionCreates, 1, "retry reuses the already bound logical work session");
    assert.equal(peerStore.listJobsForPeer("peer-a", { includeTerminal: true }).length, 1, "retry never creates a duplicate peer job");

    // Exercise the existing peer receipt -> managed worktree -> reviewer flow
    // using the exact durable job created by scheduled dispatch.
    const artifactStore = createPeerArtifactStore(peerState);
    const claimed = peerStore.claimNextJob("peer-a", Date.now());
    assert.ok(claimed, "the scheduled peer job is visible to the existing peer claim path");
    peerStore.markStarted(claimed.attempt.attemptId, claimed.attempt.claimToken, "peer-a", Date.now(), "peer-run-scheduled");
    const report = Buffer.from("Scheduled audit result\n", "utf8");
    const uploaded = artifactStore.put({ job: claimed.job, attemptId: claimed.attempt.attemptId, path: "reports/audit.md", bytes: report });
    const resultReceipt = {
      jobId: claimed.job.jobId,
      attemptId: claimed.attempt.attemptId,
      actorClass: "muse_vm_process" as const,
      baseRevision,
      manifestSha256: manifestSha256(baseRevision, [{ path: uploaded.path, sha256: uploaded.sha256, bytes: uploaded.bytes }]),
      files: [{ path: uploaded.path, sha256: uploaded.sha256, bytes: uploaded.bytes }],
      totalBytes: uploaded.bytes,
      terminalState: "succeeded" as const,
      summary: "Scheduled audit complete",
    };
    peerStore.completeAttempt(claimed.attempt.attemptId, claimed.attempt.claimToken, "peer-a", resultReceipt, Date.now());
    const submissions: any[] = [];
    const processor = createPeerJobResultProcessor({
      store: peerStore,
      artifacts: artifactStore,
      workspaces: {
        getWorkspace: () => ({ id: "workspace-peer-worktree", root: worktreeRoot, mode: "worktree", sourceRoot: repositoryRoot, worktree: { managed: true, baseSha: baseRevision } }),
      } as any,
      workSessions: {
        get: () => session,
        getSubmissions: () => [],
        acquireWorkspaceLease: () => ({ acquired: true, lease: { leaseNonce: "peer-lease" } }),
        releaseWorkspaceLeaseForSession: () => undefined,
      } as any,
      reviewCheckpoints: {
        reviewChangesAgainstCommit: async () => ({
          files: [{ path: "reports/audit.md" }],
          patch: "+Scheduled audit result\\n",
          summary: { additions: 1, removals: 0 },
          snapshotKind: "git",
          snapshotRef: "a".repeat(40),
        }),
      } as any,
      reviewWorkflow: {
        submitForReview: async (input: any) => {
          submissions.push(input);
          return { submissionId: "submission-scheduled-peer", reviewEpoch: 1 };
        },
      } as any,
    });
    await processor.process(peerStore.getJob(firstPeerJobId)!);
    const awaitingReview = peerStore.getJob(firstPeerJobId)!;
    assert.equal(awaitingReview.status, "awaiting_review");
    assert.equal(awaitingReview.workSessionId, "wsess-scheduled-peer");
    assert.equal(awaitingReview.resultProcessing?.submissionId, "submission-scheduled-peer");
    assert.equal(submissions.length, 1, "exactly one review submission is created from the peer receipt");
    assert.equal(submissions[0].workSessionId, "wsess-scheduled-peer");
    assert.equal(readFileSync(join(worktreeRoot, "reports/audit.md"), "utf8"), report.toString("utf8"));
    const finalized = peerStore.finalizeReview(firstPeerJobId, {
      submissionId: "submission-scheduled-peer",
      reviewEpoch: 1,
      feedbackId: "feedback-scheduled-peer",
      verdict: "changes_requested",
    }, Date.now());
    assert.equal(finalized.status, "review_changes_requested", "authenticated reviewer feedback remains attached to the scheduled peer job");
  } finally {
    peerStore.close();
    rmSync(peerState, { recursive: true, force: true });
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log("scheduled-job-dispatch.test.ts: all assertions passed");
