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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "../config.js";
import type { PrincipalRole } from "../policy-enforcement.js";
import type { PeerJobStore } from "./jobs/store.js";
import type { PeerJob, PeerJobStatus } from "./jobs/contracts.js";
import { workspaceAppCallableToolMeta } from "../workspace-app-resource.js";

export interface PeerStatusToolDeps {
  /** Only the peer section of the server config is consumed. */
  config: Pick<ServerConfig, "peer">;
  principalRole: PrincipalRole;
  store: PeerJobStore | undefined;
  now?: () => number;
}

const PEER_STATUS_DISPLAY_HINTS: Record<PeerJobStatus, string> = {
  pending: "awaiting_peer_poll (requires Muse-side pickup)",
  claimed: "claimed; awaiting start or lease expiry",
  running: "executing (VM process)",
  staging: "artifact staging (follow-on; not implemented)",
  awaiting_review: "review binding (follow-on; not implemented)",
  awaiting_reconciliation: "requires_owner_reconciliation",
  result_received: "result received; NOT an approvable review submission",
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
    taskClass: z.string(),
    repositoryId: z.string(),
    status: z.string(),
    createdAt: z.string(),
    displayHint: z.string(),
    actorClass: z.string().optional(),
    outcomeCertainty: z.string().optional(),
    terminalReason: z.string().optional(),
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
    async ({ peerId }) => {
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
      // The store has no all-peers listing; iterate registry descriptors (the
      // authority for which peers exist) so an unknown peerId errors instead
      // of silently returning nothing.
      const allJobs: PeerJob[] = [];
      if (deps.store) {
        for (const descriptor of descriptors) {
          allJobs.push(...deps.store.listJobsForPeer(descriptor.id, { includeTerminal: true }));
        }
      }
      if (peerId !== undefined && !descriptors.some((candidate) => candidate.id === peerId)) {
        return {
          content: [{ type: "text", text: "Forbidden: unknown peerId (not in the peer credential registry)." }],
          isError: true,
        };
      }
      const filtered = peerId === undefined ? allJobs : allJobs.filter((job) => job.peerId === peerId);
      const jobRows = filtered.map((job) => {
        const attempts = deps.store?.listAttemptsForJob(job.jobId) ?? [];
        let actorClass: string | undefined;
        let outcomeCertainty: string | undefined;
        for (let index = attempts.length - 1; index >= 0; index -= 1) {
          const attempt = attempts[index];
          if (actorClass === undefined && attempt.receipt !== undefined) actorClass = attempt.receipt.actorClass;
          if (outcomeCertainty === undefined) outcomeCertainty = attempt.outcomeCertainty;
          if (actorClass !== undefined) break;
        }
        return {
          jobId: job.jobId,
          peerId: job.peerId,
          taskClass: job.taskClass,
          repositoryId: job.repositoryId,
          status: job.status,
          createdAt: job.createdAt,
          // Safe fallback: a corrupted sidecar can carry an unexpected status;
          // the output schema must never carry an undefined displayHint.
          displayHint: PEER_STATUS_DISPLAY_HINTS[job.status] ?? "unknown status; inspect job details",
          actorClass,
          outcomeCertainty,
          terminalReason: job.terminalReason,
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
        terminal: jobRows.filter((job) => ["completed", "failed", "cancelled"].includes(job.status)).length,
      };
      notes.push(
        "actorClass reflects only what the peer reported; muse_vm_process results are never evidence of hosted-Muse-agent (C3) execution",
        "Peer job results are reports. Approval authority remains with the existing reviewer workflow; peer delivery alone approves nothing.",
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
        counts,
        notes,
      };
      const activeJobs = jobRows.filter((job) => !["completed", "failed", "cancelled"].includes(job.status)).length;
      return {
        content: [{
          type: "text",
          text: `Peer listener: ${peer ? "enabled" : "disabled"}; ${peers.length} enrolled peer(s); ${activeJobs} active job(s).`,
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
}
