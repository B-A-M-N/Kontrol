/**
 * Bounded scheduled artifact publisher (audit §1.5).
 *
 * The signed worker writes staged bytes inside its sandbox. This module is
 * the only path that materialises them at the final workspace destination.
 * It validates exact paths, rejects symlink escapes, verifies content
 * hashes, performs atomic replacement, and independently reads back the
 * published bytes before returning a receipt. It never grants the worker
 * write authority — if this module is not called, no destination file is
 * created or modified.
 */
import { createHash, randomUUID } from "node:crypto";
import { FileHandle, constants, link, open, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { BoundedFileWriteOutputPolicy } from "./scheduled-job-store.js";

export interface ArtifactPublicationRequest {
  jobId: string;
  workSessionId: string;
  workspaceRoot: string;
  path: string;
  content: Buffer;
  output: BoundedFileWriteOutputPolicy;
  attemptId?: string;
  attemptNumber?: number;
  runId?: string;
  dispatchIdempotencyKey?: string;
  recordPublicationIntent?: (intent: Record<string, unknown>) => void;
  recordPublicationReceipt?: (receipt: ArtifactPublicationReceipt) => void;
  recordPublicationFailure?: (receiptId: string, outcome: "rejected" | "conflict", reason: string) => void;
}

export interface PendingArtifactPublication {
  jobId: string;
  workSessionId: string;
  workspaceRoot: string;
  attemptId: string;
  attemptNumber: number;
  intent: Record<string, unknown>;
}

/**
 * Concurrency contract: creates use the filesystem's atomic no-clobber link
 * primitive. On Linux, parent traversal and publication are anchored to open
 * directory descriptors, which closes parent symlink substitution races.
 * Expected-hash replacement rechecks immediately before atomic rename; POSIX
 * does not expose a portable compare-inode-and-rename primitive, so direct host
 * writes to the same destination must be excluded while a replacement runs.
 */

export type ArtifactPublicationOutcome =
  | "committed"
  | "rejected"
  | "conflict";

export interface ArtifactPublicationReceipt {
  receiptId: string;
  jobId: string;
  workSessionId: string;
  path: string;
  operation: "create" | "replace";
  outcome: ArtifactPublicationOutcome;
  sha256?: string;
  bytes?: number;
  previousSha256?: string;
  attemptId?: string;
  attemptNumber?: number;
  runId?: string;
  dispatchIdempotencyKey?: string;
  readBackVerified?: boolean;
  reason?: string;
  publishedAt: string;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !resolve(rel).startsWith("..") && rel !== "..";
}

/** Canonicalise the parent and reject any symlink escape before mutation. */
async function canonicalizeParent(root: string, absolutePath: string): Promise<string> {
  const parent = dirname(absolutePath);
  const parts = parent.slice(root.length).split(sep).filter(Boolean);
  let canonical = root;
  for (const part of parts) {
    canonical = join(canonical, part);
    const st = await lstat(canonical).catch(() => undefined);
    if (!st) break;
    if (st.isSymbolicLink()) {
      // A symlink component in the destination parent chain is always a
      // potential escape: even if it currently points inside the workspace,
      // it can be retargeted after this check. Fail closed for all symlinks
      // in the parent chain.
      throw new Error(`symlink_escape: ${canonical} is a symbolic link in the destination parent chain`);
    }
    if (st.isFile()) {
      throw new Error(`path_conflict: ${canonical} is a file, not a directory`);
    }
  }
  return canonical;
}

async function openAnchoredParent(root: string, parent: string): Promise<{ path: string; handles: FileHandle[]; close: () => Promise<void> }> {
  if (process.platform !== "linux") return { path: parent, handles: [], close: async () => undefined };
  const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const handles = [rootHandle];
  try {
    const parentRelative = relative(root, parent);
    if (parentRelative === ".." || parentRelative.startsWith(`..${sep}`) || resolve(parentRelative).startsWith("..")) {
      throw new Error("parent_path_escape");
    }
    let current = rootHandle;
    for (const part of parentRelative.split(sep).filter(Boolean)) {
      const next = await open(`/proc/self/fd/${current.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(next);
      current = next;
    }
    return {
      path: `/proc/self/fd/${current.fd}`,
      handles,
      close: async () => { for (const handle of [...handles].reverse()) await handle.close().catch(() => undefined); },
    };
  } catch (error) {
    for (const handle of [...handles].reverse()) await handle.close().catch(() => undefined);
    throw error;
  }
}

function publicationProofPath(parentPath: string, receiptId: string): string {
  return join(parentPath, `.kontrol-publication-${receiptId}.proof`);
}

export async function publishScheduledArtifact(
  request: ArtifactPublicationRequest,
): Promise<ArtifactPublicationReceipt> {
  const now = new Date().toISOString();
  const receipt: ArtifactPublicationReceipt = {
    receiptId: randomUUID(),
    jobId: request.jobId,
    workSessionId: request.workSessionId,
    path: request.path,
    operation: request.output.operation,
    outcome: "rejected",
    publishedAt: now,
  };
  let root = resolve(request.workspaceRoot);
  let absolutePath = "";
  let parentAnchor: Awaited<ReturnType<typeof openAnchoredParent>> | undefined;
  let tempPath: string | undefined;
  let proofPath: string | undefined;
  let fileDescriptor: FileHandle | undefined;
  let intentPersisted = false;
  let destinationCommitted = false;
  let receiptPersisted = false;
  let intentFailurePersisted = false;
  let intent: Record<string, unknown> | undefined;
  try {
    if (request.path !== request.output.path) {
      receipt.reason = "path_policy_mismatch";
      return receipt;
    }
    if (request.path.startsWith("/") || request.path.includes("..") || request.path.includes("\\")) {
      receipt.reason = "path_not_relative";
      return receipt;
    }
    root = await realpath(root);
    absolutePath = resolve(root, request.path);
    if (!isInsideRoot(root, absolutePath)) {
      receipt.reason = "path_escape";
      return receipt;
    }
    if (absolutePath.endsWith(sep)) {
      receipt.reason = "path_is_directory";
      return receipt;
    }

    const contentHash = sha256(request.content);
    if (request.output.expectedSha256 !== undefined && request.output.expectedSha256 !== contentHash) {
      receipt.reason = `content_hash_mismatch: expected ${request.output.expectedSha256}, got ${contentHash}`;
      return receipt;
    }

    try {
      await canonicalizeParent(root, absolutePath);
    } catch (error) {
      receipt.reason = error instanceof Error ? error.message : String(error);
      return receipt;
    }

    const initialPath = absolutePath;
    const existing = await lstat(initialPath).catch(() => undefined);
    let previousSha256: string | undefined;
    if (existing) {
      if (existing.isSymbolicLink() || existing.isDirectory() || !existing.isFile()) {
        receipt.reason = "destination_not_regular_file";
        return receipt;
      }
      previousSha256 = sha256(await readFile(initialPath));
      if (request.output.overwrite === "deny") {
        receipt.outcome = "conflict";
        receipt.reason = "destination_exists_and_overwrite_denied";
        receipt.previousSha256 = previousSha256;
        return receipt;
      }
      if (request.output.overwrite === "expected_hash" && request.output.expectedPreviousSha256 !== previousSha256) {
        receipt.outcome = "conflict";
        receipt.reason = `previous_hash_mismatch: expected ${request.output.expectedPreviousSha256}, got ${previousSha256}`;
        receipt.previousSha256 = previousSha256;
        return receipt;
      }
    } else if (request.output.operation === "replace") {
      receipt.outcome = "conflict";
      receipt.reason = "replace_requires_existing_file";
      return receipt;
    }

    const parent = dirname(absolutePath);
    await mkdir(parent, { recursive: true });
    try {
      await canonicalizeParent(root, absolutePath);
    } catch (error) {
      receipt.reason = error instanceof Error ? error.message : String(error);
      return receipt;
    }
    parentAnchor = await openAnchoredParent(root, parent);
    const anchoredPath = join(parentAnchor.path, basename(absolutePath));
    tempPath = join(parentAnchor.path, `.${basename(absolutePath)}.tmp-${receipt.receiptId}`);
    proofPath = publicationProofPath(parentAnchor.path, receipt.receiptId);

    fileDescriptor = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    await writeFile(fileDescriptor, request.content);
    await fileDescriptor.sync();
    await fileDescriptor.close();
    fileDescriptor = undefined;

    // A proof hard-link survives rename of the staged file to its destination.
    // Recovery accepts only the exact inode pair recorded by this pre-mutation
    // intent, so an unrelated matching file is not treated as worker evidence.
    await link(tempPath, proofPath);
    const pendingIntent = {
      state: "pending",
      receiptId: receipt.receiptId,
      jobId: request.jobId,
      workSessionId: request.workSessionId,
      workspaceRoot: root,
      path: request.path,
      operation: request.output.operation,
      sha256: contentHash,
      bytes: request.content.byteLength,
      previousSha256,
      expectedPreviousSha256: request.output.expectedPreviousSha256,
      attemptId: request.attemptId,
      attemptNumber: request.attemptNumber,
      runId: request.runId,
      dispatchIdempotencyKey: request.dispatchIdempotencyKey,
      createdAt: now,
    };
    if (request.recordPublicationIntent) request.recordPublicationIntent(pendingIntent);
    intent = pendingIntent;
    intentPersisted = Boolean(request.recordPublicationIntent);

    const current = await lstat(anchoredPath).catch(() => undefined);
    if (request.output.operation === "create") {
      if (current) {
        receipt.outcome = "conflict";
        receipt.reason = "destination_created_after_create_check";
        return receipt;
      }
      try {
        await link(tempPath, anchoredPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
          receipt.outcome = "conflict";
          receipt.reason = "destination_created_after_create_check";
          return receipt;
        }
        throw error;
      }
    } else {
      if (!current || !current.isFile() || current.isSymbolicLink()) {
        receipt.outcome = "conflict";
        receipt.reason = "replace_destination_changed_after_check";
        return receipt;
      }
      const currentSha256 = sha256(await readFile(anchoredPath));
      receipt.previousSha256 = currentSha256;
      if (request.output.overwrite === "expected_hash" && request.output.expectedPreviousSha256 !== currentSha256) {
        receipt.outcome = "conflict";
        receipt.reason = `previous_hash_mismatch: expected ${request.output.expectedPreviousSha256}, got ${currentSha256}`;
        return receipt;
      }
      if (request.output.overwrite === "deny") {
        receipt.outcome = "conflict";
        receipt.reason = "destination_exists_and_overwrite_denied";
        return receipt;
      }
      await rename(tempPath, anchoredPath);
    }
    destinationCommitted = true;
    const directoryHandle = parentAnchor.handles.at(-1);
    await directoryHandle?.sync();

    const readBack = await readFile(anchoredPath);
    const readBackHash = sha256(readBack);
    if (readBackHash !== contentHash || !readBack.equals(request.content)) {
      receipt.reason = `read_back_verification_failed: expected ${contentHash}, got ${readBackHash}`;
      return receipt;
    }

    receipt.outcome = "committed";
    receipt.sha256 = readBackHash;
    receipt.bytes = readBack.byteLength;
    receipt.previousSha256 = previousSha256;
    receipt.attemptId = request.attemptId;
    receipt.attemptNumber = request.attemptNumber;
    receipt.runId = request.runId;
    receipt.dispatchIdempotencyKey = request.dispatchIdempotencyKey;
    receipt.readBackVerified = true;
    if (request.recordPublicationReceipt) request.recordPublicationReceipt(receipt);
    receiptPersisted = Boolean(request.recordPublicationReceipt);
    return receipt;
  } catch (error) {
    receipt.outcome = "rejected";
    receipt.reason = error instanceof Error ? error.message : String(error);
    return receipt;
  } finally {
    if (fileDescriptor !== undefined) await fileDescriptor.close().catch(() => undefined);
    if (tempPath) await unlink(tempPath).catch(() => undefined);
    if (intentPersisted && intent && !destinationCommitted && request.recordPublicationFailure) {
      try {
        request.recordPublicationFailure(receipt.receiptId, receipt.outcome === "conflict" ? "conflict" : "rejected", receipt.reason ?? "publication_not_committed");
        intentFailurePersisted = true;
      } catch { /* a still-pending intent cannot authorize recovery without the inode proof */ }
    }
    if (proofPath && (!intentPersisted || receiptPersisted || intentFailurePersisted)) await unlink(proofPath).catch(() => undefined);
    await parentAnchor?.close();
  }
}

/**
 * Recover a receipt only when a durable intent exists and the intended output
 * and its hidden proof link still refer to the same inode and exact bytes.
 */
export async function recoverScheduledArtifactPublication(
  pending: PendingArtifactPublication,
): Promise<ArtifactPublicationReceipt | undefined> {
  const intent = pending.intent;
  const receiptId = typeof intent.receiptId === "string" ? intent.receiptId : "";
  const path = typeof intent.path === "string" ? intent.path : "";
  if (!/^[0-9a-f-]{36}$/i.test(receiptId) || !path || path.startsWith("/") || path.includes("..") || path.includes("\\")) return undefined;
  const root = await realpath(pending.workspaceRoot).catch(() => undefined);
  if (!root) return undefined;
  const target = resolve(root, path);
  if (!isInsideRoot(root, target)) return undefined;
  const parent = dirname(target);
  try { await canonicalizeParent(root, target); } catch { return undefined; }
  const anchor = await openAnchoredParent(root, parent).catch(() => undefined);
  if (!anchor) return undefined;
  try {
    const anchoredTarget = join(anchor.path, basename(target));
    const proofPath = publicationProofPath(anchor.path, receiptId);
    const [targetStat, proofStat] = await Promise.all([
      lstat(anchoredTarget).catch(() => undefined),
      lstat(proofPath).catch(() => undefined),
    ]);
    if (!targetStat?.isFile() || targetStat.isSymbolicLink() || !proofStat?.isFile() || proofStat.isSymbolicLink()
      || targetStat.dev !== proofStat.dev || targetStat.ino !== proofStat.ino) return undefined;
    const bytes = await readFile(anchoredTarget);
    const digest = sha256(bytes);
    if (digest !== intent.sha256 || bytes.byteLength !== intent.bytes) return undefined;
    return {
      receiptId,
      jobId: pending.jobId,
      workSessionId: pending.workSessionId,
      path,
      operation: intent.operation === "replace" ? "replace" : "create",
      outcome: "committed",
      sha256: digest,
      bytes: bytes.byteLength,
      previousSha256: typeof intent.previousSha256 === "string" ? intent.previousSha256 : undefined,
      attemptId: pending.attemptId,
      attemptNumber: pending.attemptNumber,
      runId: typeof intent.runId === "string" ? intent.runId : undefined,
      dispatchIdempotencyKey: typeof intent.dispatchIdempotencyKey === "string" ? intent.dispatchIdempotencyKey : undefined,
      readBackVerified: true,
      publishedAt: typeof intent.createdAt === "string" ? intent.createdAt : new Date().toISOString(),
    };
  } finally {
    await anchor.close();
  }
}

export async function removeScheduledArtifactProof(pending: PendingArtifactPublication): Promise<void> {
  const receiptId = typeof pending.intent.receiptId === "string" ? pending.intent.receiptId : "";
  const path = typeof pending.intent.path === "string" ? pending.intent.path : "";
  if (!/^[0-9a-f-]{36}$/i.test(receiptId) || !path || path.startsWith("/") || path.includes("..") || path.includes("\\")) return;
  const root = await realpath(pending.workspaceRoot).catch(() => undefined);
  if (!root) return;
  const target = resolve(root, path);
  if (!isInsideRoot(root, target)) return;
  const anchor = await openAnchoredParent(root, dirname(target)).catch(() => undefined);
  if (!anchor) return;
  try {
    await unlink(publicationProofPath(anchor.path, receiptId)).catch(() => undefined);
  } finally {
    await anchor.close();
  }
}
