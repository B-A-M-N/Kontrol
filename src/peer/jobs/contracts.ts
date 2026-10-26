/**
 * M3 durable peer-pull job protocol contracts (capability C2, honestly
 * labeled). Kontrol persists a job; a Muse-VM-side component makes OUTBOUND
 * calls to claim it, executes bounded work, and returns a correlated result.
 *
 * This is NOT evidence the hosted Muse agent consumed it (C3 stays
 * unclaimed): results are labeled actorClass "muse_vm_process" unless
 * separately verified. "meta_muse_agent" exists in the type only so the
 * verification gap is explicit; M3 never sets it.
 */

export const PEER_JOB_STATUSES = [
  "pending",
  "claimed",
  "running",
  "awaiting_reconciliation",
  "result_received",
  "staging",
  "awaiting_review",
  "review_changes_requested",
  "completed",
  "failed",
  "cancelled",
] as const;

export type PeerJobStatus = (typeof PEER_JOB_STATUSES)[number];

export type PeerTaskClass = "read_only_audit" | "propose_patch" | "bounded_execution";

export type PeerOutcomeCertainty = "not_started" | "started" | "unknown" | "terminal_verified";

export type PeerActorClass = "muse_vm_process" | "meta_muse_agent";

export interface PeerJob {
  jobId: string; // job_<uuid>
  /** TRUSTED server assignment from the credential registry id. */
  peerId: string;
  /** Existing reviewer-owned session receiving the eventual peer submission. */
  workSessionId: string;
  /** Exact managed-worktree workspace for the receiving session. */
  workspaceSessionId: string;
  /** Canonical workspace root or repo identifier. */
  repositoryId: string;
  /** Immutable git SHA or snapshot identity. */
  baseRevision: string;
  taskClass: PeerTaskClass;
  /** sha256 hex of the canonical instruction bytes. */
  instructionHash: string;
  /** UTF-8 instruction text; byte-capped at MAX_INSTRUCTION_BYTES (service.ts). */
  instructions: string;
  /**
   * RELATIVE path prefixes permitted in the result manifest. A manifest path
   * matches when canonicalPath === entry or canonicalPath starts with
   * entry + "/". The literal "*" matches everything. An EMPTY array means the
   * job allows NO file outputs at all.
   */
  allowedOutputs: string[];
  maxRuntimeMs: number;
  maxArtifactBytes: number;
  status: PeerJobStatus;
  createdAt: string; // ISO
  cancelRequestedAt?: string;
  terminalAt?: string;
  terminalReason?: string;
  resultProcessing?: {
    receiptSha256?: string;
    submissionId?: string;
    reviewEpoch?: number;
    snapshotKind?: "git" | "filesystem";
    snapshotRef?: string;
    diffSha256?: string;
    reviewVerdict?: "approve" | "changes_requested" | "reject";
    feedbackId?: string;
    verificationStatus?: "passed" | "failed" | "inconclusive" | "not_configured";
    verificationEvidenceSha256?: string;
    failure?: string;
    /** Incremented only by an authenticated owner/reviewer retry of local result processing. */
    retryRevision?: number;
    updatedAt: string;
  };
}

export interface PeerAttempt {
  attemptId: string; // att_<uuid>
  jobId: string;
  /** Random 32 bytes hex; presented on every mutation. */
  claimToken: string;
  /** Trusted, from the authenticated principal. */
  claimOwnerPeerId: string;
  /** Job generation counter; stale attempts fenced. */
  generation: number;
  /** ISO; claim time — the runtime-budget clock starts here if /started is never reported. */
  createdAt: string;
  /** ISO; renewed via /renew (dedicated fenced remote-lease extension). */
  leaseExpiresAt: string;
  lastHeartbeatAt?: string;
  /** Client-advertised, opaque. */
  remoteExecutionId?: string;
  executionStartedAt?: string;
  outcomeCertainty: PeerOutcomeCertainty;
  status: "active" | "completed" | "failed" | "expired" | "superseded";
  /** Persisted with the attempt on terminal completion. */
  receipt?: PeerJobResultReceipt;
}

export interface PeerJobResultReceipt {
  jobId: string;
  attemptId: string;
  actorClass: PeerActorClass;
  /** Must match job.baseRevision exactly (no silent rebase). */
  baseRevision: string;
  /** Over the canonical manifest JSON. */
  manifestSha256: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  totalBytes: number;
  terminalState: "succeeded" | "failed" | "cancelled";
  /** <= 4KB */
  summary?: string;
}

/**
 * Concrete, coded error for the job protocol. Routes map `httpStatus` onto
 * the repo error-envelope style ({error:{code,message}}).
 */
export class PeerJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number = 409,
  ) {
    super(message);
    this.name = "PeerJobError";
  }
}
