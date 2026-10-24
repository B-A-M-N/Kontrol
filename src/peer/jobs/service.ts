/**
 * M3 peer job service: validation layer over the store. Receipt validation
 * is fail-closed with concrete coded errors; peer job caps are enforced on
 * create.
 */
import { createHash } from "node:crypto";
import type { LoggingConfig } from "../../logger.js";
import { PeerJobError } from "./contracts.js";
import type {
  PeerActorClass,
  PeerAttempt,
  PeerJob,
  PeerJobResultReceipt,
} from "./contracts.js";
import type { PeerJobStore } from "./store.js";

export interface PeerJobsServiceConfig {
  peer: { maxClaimedJobs: number };
}

export interface PeerJobsServiceDeps {
  store: PeerJobStore;
  config: PeerJobsServiceConfig;
  logging: LoggingConfig;
}

const MAX_SUMMARY_BYTES = 4 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Hard cap on the UTF-8 size of job instructions (256 KiB). */
export const MAX_INSTRUCTION_BYTES = 256 * 1024;

function activeJobCount(store: PeerJobStore, peerId: string): number {
  return store.listJobsForPeer(peerId).filter(
    (job) =>
      job.status === "pending" ||
      job.status === "claimed" ||
      job.status === "running" ||
      job.status === "awaiting_reconciliation",
  ).length;
}

/** Enforce the per-peer active-job cap before create. */
export function enforcePeerJobsCap(store: PeerJobStore, peerId: string, config: PeerJobsServiceConfig): void {
  if (activeJobCount(store, peerId) >= config.peer.maxClaimedJobs) {
    throw new PeerJobError(
      "peer_jobs_cap_exceeded",
      `Peer ${peerId} already holds the maximum number of active jobs (${config.peer.maxClaimedJobs})`,
      429,
    );
  }
}

/** Validate a result receipt's actorClass against the M3 honesty policy. */
export function validateActorClass(actorClass: unknown): asserts actorClass is PeerActorClass {
  if (actorClass === "muse_vm_process") return;
  if (actorClass === "meta_muse_agent") {
    throw new PeerJobError(
      "actor_class_unverified",
      "meta_muse_agent requires verified Muse-agent activation evidence (C3), which is not implemented",
      422,
    );
  }
  throw new PeerJobError("invalid_actor_class", `actorClass must be "muse_vm_process" (got ${JSON.stringify(actorClass)})`, 422);
}

interface CanonicalFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

/**
 * Normalize a manifest path to its canonical relative form: reject absolute
 * paths, backslashes, and any ".." segment (path traversal); collapse
 * duplicate slashes and drop "." and empty segments. Throws PeerJobError on
 * any violation.
 */
export function canonicalizeManifestPath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new PeerJobError("invalid_manifest_path", "manifest paths must be nonempty strings", 422);
  }
  const normalized = rawPath.replace(/\/{2,}/g, "/");
  if (normalized.startsWith("/") || normalized.includes("\\") || /^[A-Za-z]:/.test(normalized)) {
    throw new PeerJobError("path_traversal", `manifest path ${JSON.stringify(rawPath)} must be relative with forward slashes only`, 422);
  }
  const segments = normalized.split("/").filter((segment) => segment !== "." && segment !== "");
  if (segments.some((segment) => segment === "..")) {
    throw new PeerJobError("path_traversal", `manifest path ${JSON.stringify(rawPath)} must not contain ".."`, 422);
  }
  if (segments.length === 0) {
    throw new PeerJobError("invalid_manifest_path", `manifest path ${JSON.stringify(rawPath)} canonicalizes to an empty path`, 422);
  }
  return segments.join("/");
}

/**
 * Normalize job.allowedOutputs entries into canonical RELATIVE path prefixes:
 * strip a single trailing "/", reject "..", backslashes, and absolute paths.
 * The literal "*" is the explicit match-all escape and is kept as-is.
 * Throws PeerJobError with a concrete code on any violation.
 */
export function normalizeAllowedOutputs(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    throw new PeerJobError("invalid_allowed_outputs", "allowedOutputs must be an array of relative path prefix strings", 422);
  }
  const normalized: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new PeerJobError("invalid_allowed_outputs", "every allowedOutputs entry must be a nonempty string", 422);
    }
    if (entry === "*") {
      normalized.push("*");
      continue;
    }
    let candidate = entry.replace(/\/{2,}/g, "/");
    if (candidate.endsWith("/")) candidate = candidate.slice(0, -1);
    if (candidate.startsWith("/") || candidate.includes("\\") || /^[A-Za-z]:/.test(candidate)) {
      throw new PeerJobError("path_traversal", `allowedOutputs entry ${JSON.stringify(entry)} must be relative with forward slashes only`, 422);
    }
    const segments = candidate.split("/").filter((segment) => segment !== "." && segment !== "");
    if (segments.some((segment) => segment === "..")) {
      throw new PeerJobError("path_traversal", `allowedOutputs entry ${JSON.stringify(entry)} must not contain ".."`, 422);
    }
    if (segments.length === 0) {
      throw new PeerJobError("invalid_allowed_outputs", `allowedOutputs entry ${JSON.stringify(entry)} canonicalizes to an empty prefix`, 422);
    }
    normalized.push(segments.join("/"));
  }
  return [...new Set(normalized)];
}

/** True when the canonical manifest path is covered by the job's allowedOutputs. */
function allowedOutputsMatch(allowedOutputs: readonly string[], canonicalPath: string): boolean {
  return allowedOutputs.some(
    (entry) => entry === "*" || canonicalPath === entry || canonicalPath.startsWith(entry + "/"),
  );
}

/**
 * Canonical manifest JSON: {baseRevision, files:[{path,sha256,bytes}]} with
 * paths CANONICALIZED via canonicalizeManifestPath and sorted (lexicographic),
 * and no extra fields. Clients must compute their manifest hash over these
 * canonical paths so "./out/a" and "out/a" produce the same value.
 */
export function canonicalManifestJson(baseRevision: string, files: CanonicalFileEntry[]): string {
  const canonical = files.map((file) => ({
    path: canonicalizeManifestPath(file.path),
    sha256: file.sha256,
    bytes: file.bytes,
  }));
  const sorted = [...canonical].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify({ baseRevision, files: sorted });
}

/**
 * Validate a result receipt against its job and attempt. Throws PeerJobError
 * with a concrete code on ANY violation. Symlink-looking paths are acceptable
 * as strings but are canonicalized here; traversal, duplicate paths, hash,
 * byte-cap, allowedOutputs, and identity (jobId/attemptId) violations are
 * rejected.
 */
export function validateResultReceipt(job: PeerJob, attempt: PeerAttempt, receipt: PeerJobResultReceipt): void {
  if (receipt.jobId !== job.jobId || receipt.attemptId !== attempt.attemptId) {
    throw new PeerJobError("attempt_mismatch", "receipt.jobId/attemptId do not match the job and attempt being completed", 422);
  }
  validateActorClass(receipt.actorClass);
  if (typeof receipt.baseRevision !== "string" || receipt.baseRevision !== job.baseRevision) {
    throw new PeerJobError("base_revision_mismatch", "receipt.baseRevision must equal job.baseRevision exactly (no silent rebase)", 422);
  }
  if (!Array.isArray(receipt.files)) {
    throw new PeerJobError("invalid_manifest", "receipt.files must be an array", 422);
  }
  if (receipt.terminalState !== "succeeded" && receipt.terminalState !== "failed" && receipt.terminalState !== "cancelled") {
    throw new PeerJobError("invalid_terminal_state", "receipt.terminalState must be succeeded | failed | cancelled", 422);
  }
  if (receipt.summary !== undefined) {
    if (typeof receipt.summary !== "string" || Buffer.byteLength(receipt.summary, "utf8") > MAX_SUMMARY_BYTES) {
      throw new PeerJobError("summary_too_large", "receipt.summary must be a string of at most 4096 bytes", 422);
    }
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of receipt.files) {
    if (typeof file?.path !== "string" || file.path.length === 0) {
      throw new PeerJobError("invalid_manifest_path", "every manifest file needs a nonempty string path", 422);
    }
    const canonicalPath = canonicalizeManifestPath(file.path);
    if (seen.has(canonicalPath)) {
      throw new PeerJobError("duplicate_manifest_path", `duplicate manifest path after normalization: ${canonicalPath}`, 422);
    }
    seen.add(canonicalPath);
    if (!allowedOutputsMatch(job.allowedOutputs, canonicalPath)) {
      throw new PeerJobError("output_not_allowed", `manifest path ${canonicalPath} is not covered by the job's allowedOutputs (empty allowedOutputs permits no file outputs)`, 422);
    }
    if (typeof file.sha256 !== "string" || !SHA256_PATTERN.test(file.sha256)) {
      throw new PeerJobError("invalid_file_hash", `manifest file ${canonicalPath} needs a 64-hex sha256`, 422);
    }
    if (!Number.isInteger(file.bytes) || file.bytes < 0) {
      throw new PeerJobError("invalid_file_bytes", `manifest file ${canonicalPath} needs a nonnegative integer byte count`, 422);
    }
    totalBytes += file.bytes;
  }

  if (totalBytes > job.maxArtifactBytes) {
    throw new PeerJobError("artifact_bytes_exceeded", `manifest totalBytes ${totalBytes} exceeds job.maxArtifactBytes ${job.maxArtifactBytes}`, 422);
  }
  if (receipt.totalBytes !== totalBytes) {
    throw new PeerJobError("total_bytes_mismatch", `receipt.totalBytes ${receipt.totalBytes} does not equal the sum of file bytes ${totalBytes}`, 422);
  }

  // Recompute manifestSha256 over the canonical manifest JSON.
  const canonical = canonicalManifestJson(receipt.baseRevision, receipt.files);
  const recomputed = createHash("sha256").update(canonical).digest("hex");
  if (receipt.manifestSha256 !== recomputed) {
    throw new PeerJobError("manifest_hash_mismatch", "receipt.manifestSha256 does not match the canonical manifest JSON", 422);
  }
}

/** Compute the canonical manifest hash a client must present. */
export function manifestSha256(baseRevision: string, files: CanonicalFileEntry[]): string {
  return createHash("sha256").update(canonicalManifestJson(baseRevision, files)).digest("hex");
}

export function createPeerJobsService(deps: PeerJobsServiceDeps) {
  const { store, config } = deps;
  return {
    store,
    enforcePeerJobsCap(peerId: string): void {
      enforcePeerJobsCap(store, peerId, config);
    },
    validateResultReceipt(job: PeerJob, attempt: PeerAttempt, receipt: PeerJobResultReceipt): void {
      validateResultReceipt(job, attempt, receipt);
    },
  };
}
