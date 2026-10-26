/**
 * M5 WebUI visibility: `list_peer_status` — reviewer/owner visibility into the
 * peer surface. UI is a consumer of durable state, not authority.
 *
 * This tool is NEVER in any peer capability profile (see tool-profile.ts) and
 * the peer execution guard denies unmapped tools; the handler ALSO denies
 * peer/worker roles as defense in depth. Output is deliberately secret-free:
 * no claimToken, no credentialHash, no raw instructions ever leave here.
 */
import * as z from "zod/v4";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import type { PrincipalRole } from "../policy-enforcement.js";
import type { PeerJobStore } from "./jobs/store.js";
import type { PeerJob, PeerJobStatus } from "./jobs/contracts.js";
import { workspaceAppCallableToolMeta } from "../workspace-app-resource.js";
import type { DispatchOutbox } from "../dispatch-outbox.js";
import type { MutationReceiptStore } from "../mutation-receipts.js";
import { runWithMutationReceipt } from "../mutation-receipts.js";
import type { WorkSessionManager } from "../work-sessions/index.js";

export interface PeerStatusToolDeps {
  /** Only the peer section of the server config is consumed. */
  config: Pick<ServerConfig, "peer">;
  principalRole: PrincipalRole;
  store: PeerJobStore | undefined;
  dispatchOutbox?: DispatchOutbox;
  mutationReceipts?: MutationReceiptStore;
  mutationPrincipalId?: string;
  workSessions?: WorkSessionManager;
  now?: () => number;
}

const PEER_STATUS_DISPLAY_HINTS: Record<PeerJobStatus, string> = {
  pending: "awaiting_peer_poll (requires Muse-side pickup)",
  claimed: "claimed; awaiting start or lease expiry",
  running: "executing (VM process)",
  staging: "validating and staging result artifacts",
  awaiting_review: "submitted to the existing reviewer workflow",
  review_changes_requested: "reviewer requested changes; this job is complete and a new bounded job may be enqueued",
  awaiting_reconciliation: "requires_owner_reconciliation",
  result_received: "receipt accepted; result processing has not completed",
  completed: "terminal",
  failed: "terminal",
  cancelled: "terminal",
};

function forbidden(): { content: [{ type: "text"; text: string }]; isError: true } {
  return {
    content: [{ type: "text", text: "Forbidden: list_peer_status requires owner or reviewer authority." }],
    isError: true,
  };
}

export function registerPeerStatusTool(server: McpServer, deps: PeerStatusToolDeps): void {
  const jobSchema = z.object({
    jobId: z.string(),
    peerId: z.string(),
    workspaceSessionId: z.string().optional(),
    workSessionId: z.string().optional(),
    taskClass: z.string(),
    repositoryId: z.string(),
    status: z.string(),
    createdAt: z.string(),
    cancelRequestedAt: z.string().optional(),
    displayHint: z.string(),
    actorClass: z.string().optional(),
    outcomeCertainty: z.string().optional(),
    terminalReason: z.string().optional(),
    submissionId: z.string().optional(),
    reviewEpoch: z.number().optional(),
    snapshotKind: z.enum(["git", "filesystem"]).optional(),
    snapshotRef: z.string().optional(),
    resultProcessingFailure: z.string().optional(),
    verificationStatus: z.enum(["passed", "failed", "inconclusive", "not_configured"]).optional(),
    verificationEvidenceSha256: z.string().optional(),
    reviewVerdict: z.enum(["approve", "changes_requested", "reject"]).optional(),
  });
  registerAppTool(
    server,
    "list_peer_status",
    {
      title: "List peer status",
      description:
        "Reviewer/owner visibility into the peer surface: listener state, enrolled peers, and durable peer job states. "
        + "Read-only; deliberately excludes credential hashes, claim tokens, and raw instructions.",
      inputSchema: {
        peerId: z.string().optional().describe("Filter jobs by peer id."),
        limit: z.number().int().min(1).max(40).default(20).describe("Maximum jobs in this page; capped at 40."),
        cursor: z.string().max(1024).optional().describe("Opaque cursor returned by the previous page."),
      },
      outputSchema: {
        peer: z.object({
          enabled: z.boolean(),
          bindHost: z.string().optional(),
          port: z.number().optional(),
        }),
        peers: z.array(z.object({
          id: z.string(),
          credentialId: z.string(),
          capabilities: z.array(z.string()),
          grantedRoots: z.array(z.string()),
        })),
        jobs: z.array(jobSchema),
        nextCursor: z.string().optional(),
        pageSize: z.number(),
        counts: z.object({
          pending: z.number(),
          claimed: z.number(),
          running: z.number(),
          awaitingReconciliation: z.number(),
          resultReceived: z.number(),
          staging: z.number(),
          awaitingReview: z.number(),
          terminal: z.number(),
        }),
        notes: z.array(z.string()),
      },
      _meta: workspaceAppCallableToolMeta(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ peerId, limit, cursor }) => {
      const pageLimit = Math.max(1, Math.min(40, Number.isInteger(limit) ? limit : 20));
      // Handler-level role gate FIRST. Undefined never reaches here (the call
      // site defaults to "client"), but peer and worker are explicitly denied
      // even though the profile/execution-guard defense already applies.
      if (deps.principalRole !== "client" && deps.principalRole !== "reviewer") {
        return forbidden();
      }
      const notes: string[] = [];
      const peer = deps.config.peer;
      const descriptors = peer?.allowedPeers ?? [];
      if (peer) {
        notes.push("Credential liveness/revocation is registry-authoritative — the operator-owned credential registry JSON file that the KONTROL_PEER_CREDENTIAL_FILE environment variable names — and hot-reloads without restart.");
      }
      if (peerId !== undefined && !descriptors.some((candidate) => candidate.id === peerId)) {
        return {
          content: [{ type: "text", text: "Forbidden: unknown peerId (not in the peer credential registry)." }],
          isError: true,
        };
      }
      let cursorTuple: { createdAt: string; jobId: string } | undefined;
      if (cursor !== undefined) {
        try {
          const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
          if (typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt))
            || typeof parsed.jobId !== "string" || !/^job_[A-Za-z0-9_-]{1,64}$/.test(parsed.jobId)) {
            throw new Error("invalid cursor fields");
          }
          cursorTuple = { createdAt: parsed.createdAt, jobId: parsed.jobId };
        } catch {
          return { content: [{ type: "text", text: "Invalid peer status cursor." }], isError: true };
        }
      }
      const pageCandidates: PeerJob[] = [];
      if (deps.store) {
        const selectedDescriptors = peerId === undefined
          ? descriptors
          : descriptors.filter((descriptor) => descriptor.id === peerId);
        for (const descriptor of selectedDescriptors) {
          // SQL does the cursor seek and per-peer limit. Fetch one extra row
          // per peer so the merged global page can determine whether another
          // page exists without loading every peer's history into memory.
          pageCandidates.push(...deps.store.listJobsForPeerPage(descriptor.id, {
            includeTerminal: true,
            after: cursorTuple,
            limit: pageLimit + 1,
          }));
        }
      }
      pageCandidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId));
      const page = pageCandidates.slice(0, pageLimit);
      const hasMore = pageCandidates.length > page.length;
      const jobRows = page.map((job) => {
        const attemptSummary = deps.store?.getAttemptSummaryForJob(job.jobId);
        return {
          jobId: job.jobId,
          peerId: job.peerId,
          workspaceSessionId: job.workspaceSessionId,
          workSessionId: job.workSessionId,
          taskClass: job.taskClass,
          repositoryId: job.repositoryId,
          status: job.status,
          createdAt: job.createdAt,
          cancelRequestedAt: job.cancelRequestedAt,
          // Safe fallback: a corrupted sidecar can carry an unexpected status;
          // the output schema must never carry an undefined displayHint.
          displayHint: PEER_STATUS_DISPLAY_HINTS[job.status] ?? "unknown status; inspect job details",
          actorClass: attemptSummary?.latestReceipt?.receipt?.actorClass,
          outcomeCertainty: attemptSummary?.latest?.outcomeCertainty,
          terminalReason: job.terminalReason,
          submissionId: job.resultProcessing?.submissionId,
          reviewEpoch: job.resultProcessing?.reviewEpoch,
          snapshotKind: job.resultProcessing?.snapshotKind,
          snapshotRef: job.resultProcessing?.snapshotRef,
          resultProcessingFailure: job.resultProcessing?.failure,
          verificationStatus: job.resultProcessing?.verificationStatus,
          verificationEvidenceSha256: job.resultProcessing?.verificationEvidenceSha256,
          reviewVerdict: job.resultProcessing?.reviewVerdict,
        };
      });
      const counts = {
        pending: jobRows.filter((job) => job.status === "pending").length,
        claimed: jobRows.filter((job) => job.status === "claimed").length,
        running: jobRows.filter((job) => job.status === "running").length,
        awaitingReconciliation: jobRows.filter((job) => job.status === "awaiting_reconciliation").length,
        resultReceived: jobRows.filter((job) => job.status === "result_received").length,
        staging: jobRows.filter((job) => job.status === "staging").length,
        awaitingReview: jobRows.filter((job) => job.status === "awaiting_review").length,
        terminal: jobRows.filter((job) => ["completed", "failed", "cancelled", "review_changes_requested"].includes(job.status)).length,
      };
      notes.push(
        "Counts apply to the current page; use nextCursor to inspect later jobs.",
        "actorClass reflects only what the peer reported; muse_vm_process results are never evidence of hosted-Muse-agent (C3) execution",
        "Peer artifacts are untrusted inputs staged into the bound managed worktree and submitted through the existing reviewer workflow; peer delivery alone approves nothing.",
      );
      const peers = descriptors.map((descriptor) => ({
        id: descriptor.id,
        credentialId: descriptor.credentialId,
        capabilities: [...descriptor.capabilities],
        grantedRoots: [...descriptor.grantedRoots],
      }));
      const structuredContent = {
        peer: peer
          ? { enabled: true as const, bindHost: peer.bindHost, port: peer.port }
          : { enabled: false as const },
        peers,
        jobs: jobRows,
        ...(hasMore && page.length > 0
          ? { nextCursor: Buffer.from(JSON.stringify({ createdAt: page[page.length - 1].createdAt, jobId: page[page.length - 1].jobId }), "utf8").toString("base64url") }
          : {}),
        pageSize: jobRows.length,
        counts,
        notes,
      };
      const activeJobs = jobRows.filter((job) => !["completed", "failed", "cancelled", "review_changes_requested"].includes(job.status)).length;
      return {
        content: [{
          type: "text",
          text: `Peer listener: ${peer ? "enabled" : "disabled"}; ${peers.length} enrolled peer(s); ${activeJobs} active job(s) in this page${structuredContent.nextCursor ? "; more jobs available" : ""}.`,
        }],
        structuredContent,
        _meta: {
          tool: "list_peer_status",
          card: {
            tool: "list_peer_status",
            summary: structuredContent,
          },
        },
      };
    },
  );

  registerAppTool(
    server,
    "cancel_peer_job",
    {
      title: "Cancel peer job",
      description: "Owner/reviewer cancellation. Pending jobs cancel immediately; claimed, running, or uncertain jobs remain fenced until the exact peer attempt confirms cancellation.",
      inputSchema: {
        jobId: z.string().min(1),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: {
        jobId: z.string(),
        status: z.string(),
        cancelRequestedAt: z.string().optional(),
        message: z.string(),
      },
      _meta: workspaceAppCallableToolMeta(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ jobId, clientMutationId }) => {
      const execute = () => {
        if (deps.principalRole !== "client" && deps.principalRole !== "reviewer") return forbidden();
        if (!deps.store) return { content: [{ type: "text" as const, text: "Peer job cancellation is unavailable because the durable peer job store is not active." }], isError: true as const };
        const job = deps.store.getJob(jobId);
        if (!job) return { content: [{ type: "text" as const, text: `Peer job ${jobId} was not found.` }], isError: true as const };
        try {
          let updated: PeerJob;
          if (job.status === "pending") {
            updated = deps.store.cancelUnclaimedJob(jobId, (deps.now ?? Date.now)());
          } else if (["claimed", "running", "awaiting_reconciliation"].includes(job.status)) {
            updated = deps.store.requestCancel(jobId, (deps.now ?? Date.now)());
          } else {
            return { content: [{ type: "text" as const, text: `Peer job ${jobId} is ${job.status}; only pending, claimed, running, or uncertain jobs can be cancelled.` }], isError: true as const };
          }
          if (updated.status === "cancelled" && deps.workSessions && updated.workSessionId) {
            const lease = deps.workSessions.getWorkspaceLeaseForSession(updated.workSessionId);
            if (lease?.leaseKind === "peer_job" && lease.ownerInstanceId === `peer-job:${updated.jobId}`) {
              deps.workSessions.releaseWorkspaceLeaseForSession(updated.workSessionId, lease.leaseNonce);
            }
          }
          const message = updated.status === "cancelled"
            ? "Pending peer job cancelled; its workspace reservation was released."
            : "Cancellation requested. The workspace stays fenced until the exact peer attempt confirms shutdown.";
          return {
            content: [{ type: "text" as const, text: message }],
            structuredContent: { jobId: updated.jobId, status: updated.status, cancelRequestedAt: updated.cancelRequestedAt, message },
          };
        } catch (error) {
          return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true as const };
        }
      };
      return runWithMutationReceipt({
        store: deps.mutationReceipts,
        principalId: deps.mutationPrincipalId ?? `peer-status:${deps.principalRole}`,
        operation: "cancel_peer_job",
        clientMutationId,
        request: { jobId },
        execute,
      });
    },
  );

  registerAppTool(
    server,
    "reconcile_peer_job_result",
    {
      title: "Retry peer result processing",
      description: "Reviewer/owner recovery for a peer job in awaiting_reconciliation. Retries local staging and verification from the exact successful receipt already stored by Kontrol. It never relaunches the peer job, changes the checkpoint, or approves the result.",
      inputSchema: {
        jobId: z.string().min(1),
        expectedFailure: z.string().min(1).max(1000).describe("Exact current result-processing failure shown by list_peer_status; protects against stale recovery actions."),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: {
        jobId: z.string(),
        status: z.string(),
        retryRevision: z.number().int().optional(),
        message: z.string(),
      },
      _meta: workspaceAppCallableToolMeta(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ jobId, expectedFailure, clientMutationId }) => {
      const execute = () => {
        if (deps.principalRole !== "client" && deps.principalRole !== "reviewer") return forbidden();
        if (!deps.store || !deps.dispatchOutbox) {
          return { content: [{ type: "text" as const, text: "Peer result recovery is unavailable because the durable peer job services are not active." }], isError: true as const };
        }
        try {
          const job = deps.store.retryResultProcessing(jobId, expectedFailure, (deps.now ?? Date.now)());
          const attempt = [...deps.store.listAttemptsForJob(jobId)].reverse().find((candidate) => candidate.receipt?.terminalState === "succeeded");
          if (!attempt) throw new Error("Successful stored peer receipt disappeared during recovery.");
          const retryRevision = job.resultProcessing?.retryRevision ?? 1;
          deps.dispatchOutbox.enqueue({
            eventType: "peer_job.result_retry",
            aggregateId: job.jobId,
            aggregateRevision: retryRevision,
            payload: { jobId: job.jobId, attemptId: attempt.attemptId, generation: attempt.generation, retryRevision },
          });
          return {
            content: [{ type: "text" as const, text: `Queued local result-processing retry ${retryRevision} for ${job.jobId} using its exact stored receipt. No peer execution was started.` }],
            structuredContent: {
              jobId: job.jobId,
              status: job.status,
              retryRevision,
              message: "Only local result processing was queued; reviewer approval remains required.",
            },
          };
        } catch (error) {
          return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true as const };
        }
      };
      return runWithMutationReceipt({
        store: deps.mutationReceipts,
        principalId: deps.mutationPrincipalId ?? `peer-status:${deps.principalRole}`,
        operation: "reconcile_peer_job_result",
        clientMutationId,
        request: { jobId, expectedFailure },
        execute,
      });
    },
  );
}
