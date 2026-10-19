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
import { FileHandle, constants, open, lstat, mkdir, readFile, readlink, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
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
}

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
  try {
    if (request.path !== request.output.path) {
      receipt.reason = "path_policy_mismatch";
      return receipt;
    }
    const root = resolve(request.workspaceRoot);
    if (request.path.startsWith("/") || request.path.includes("..") || request.path.includes("\\")) {
      receipt.reason = "path_not_relative";
      return receipt;
    }
    const absolutePath = resolve(root, request.path);
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

    // Canonicalize all existing parents and reject symlink escapes.
    try {
      await canonicalizeParent(root, absolutePath);
    } catch (error) {
      receipt.reason = error instanceof Error ? error.message : String(error);
      return receipt;
    }

    const existing = await lstat(absolutePath).catch(() => undefined);
    let previousSha256: string | undefined;
    if (existing) {
      if (existing.isDirectory()) {
        receipt.reason = "destination_is_directory";
        return receipt;
      }
      const previousContent = await readFile(absolutePath);
      previousSha256 = sha256(previousContent);
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

    // Ensure parent directories exist (mkdir recursive is safe for existing paths).
    const parent = dirname(absolutePath);
    await mkdir(parent, { recursive: true });

    // Race-safe same-directory publication. open() with O_EXCL prevents a
    // concurrent writer from being overwritten by this create; expected-hash
    // replacement rechecks just before the bounded clobber rename.
    const tempPath = join(parent, `.${request.path.replace(/[/\\]/g, "_")}.tmp-${randomUUID()}`);
    let fileDescriptor: FileHandle | undefined;
    try {
      fileDescriptor = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
      await writeFile(fileDescriptor, request.content);
      await fileDescriptor.sync();
      await fileDescriptor.close();
      fileDescriptor = undefined;

      const current = await lstat(absolutePath).catch(() => undefined);
      if (request.output.operation === "create") {
        if (current) {
          receipt.outcome = "conflict";
          receipt.reason = "destination_created_after_create_check";
          return receipt;
        }
      } else {
        const currentContent = await readFile(absolutePath);
        const currentSha256 = sha256(currentContent);
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
      }
      await rename(tempPath, absolutePath);
      const directoryDescriptor = await open(parent, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_DIRECTORY));
      try {
        await directoryDescriptor.sync();
      } finally {
        await directoryDescriptor.close();
      }
    } catch (writeError) {
      if (fileDescriptor !== undefined) await fileDescriptor.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      throw writeError;
    }

    // Independent read-back verification: read the final destination and
    // confirm the bytes match. This is the authoritative success proof.
    const readBack = await readFile(absolutePath);
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
    receipt.readBackVerified = true;
    return receipt;
  } catch (error) {
    receipt.reason = error instanceof Error ? error.message : String(error);
    return receipt;
  }
}
