/** Durable, private staging area for bounded peer result bytes. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { syncDirectory } from "../../fs-durability.js";
import { PeerJobError } from "./contracts.js";
import type { PeerJob, PeerJobResultReceipt } from "./contracts.js";
import { canonicalizeManifestPath } from "./service.js";

interface UploadIndex {
  version: 1;
  files: Record<string, { sha256: string; bytes: number }>;
}

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PeerJobError("artifact_store_unavailable", "Peer artifact storage is not a private directory", 503);
  }
  chmodSync(path, 0o700);
}

function readIndex(path: string): UploadIndex {
  if (!existsSync(path)) return { version: 1, files: {} };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe index file");
    if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o600);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as UploadIndex;
    if (parsed.version !== 1 || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) throw new Error("invalid shape");
    return parsed;
  } catch {
    throw new PeerJobError("artifact_index_corrupt", "Peer artifact upload state is unreadable; refusing to overwrite it", 503);
  }
}

function writeIndex(path: string, index: UploadIndex): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(index));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function peerJobDirectory(stateDir: string, jobId: string, attemptId: string): string {
  if (!/^job_[0-9a-f-]{36}$/i.test(jobId) || !/^att_[0-9a-f-]{36}$/i.test(attemptId)) {
    throw new PeerJobError("invalid_artifact_scope", "Invalid job or attempt identity", 422);
  }
  const root = join(stateDir, "peer-job-artifacts");
  ensurePrivateDirectory(root);
  const jobDir = join(root, jobId);
  ensurePrivateDirectory(jobDir);
  const attemptDir = join(jobDir, attemptId);
  ensurePrivateDirectory(attemptDir);
  return attemptDir;
}

export interface PeerArtifactStore {
  put(input: { job: PeerJob; attemptId: string; path: string; bytes: Buffer }): { path: string; sha256: string; bytes: number; idempotent: boolean };
  readReceipt(job: PeerJob, attemptId: string, receipt: PeerJobResultReceipt): Map<string, Buffer>;
}

export function createPeerArtifactStore(stateDir: string): PeerArtifactStore {
  return {
    put({ job, attemptId, path: inputPath, bytes }) {
      const path = canonicalizeManifestPath(inputPath);
      if (!job.allowedOutputs.some((entry) => entry === "*" || path === entry || path.startsWith(`${entry}/`))) {
        throw new PeerJobError("output_not_allowed", `Artifact path ${JSON.stringify(path)} is not allowed by the job`, 422);
      }
      if (!Buffer.isBuffer(bytes) || bytes.byteLength > job.maxArtifactBytes) {
        throw new PeerJobError("artifact_bytes_exceeded", "Artifact exceeds the job byte limit", 413);
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      const directory = peerJobDirectory(stateDir, job.jobId, attemptId);
      const indexPath = join(directory, "index.json");
      const index = readIndex(indexPath);
      const existing = Object.hasOwn(index.files, path) ? index.files[path] : undefined;
      if (existing && (existing.sha256 !== digest || existing.bytes !== bytes.byteLength)) {
        throw new PeerJobError("artifact_conflict", `Artifact ${JSON.stringify(path)} was already uploaded with different bytes`, 409);
      }
      const totalBytes = Object.entries(index.files)
        .filter(([existingPath]) => existingPath !== path)
        .reduce((total, [, entry]) => total + entry.bytes, 0) + bytes.byteLength;
      if (totalBytes > job.maxArtifactBytes) {
        throw new PeerJobError("artifact_bytes_exceeded", "Uploaded artifacts exceed the job byte limit", 413);
      }
      if (!existing && Object.keys(index.files).length >= 4096) {
        throw new PeerJobError("artifact_count_exceeded", "A peer job may upload at most 4096 files", 413);
      }
      const blobPath = join(directory, digest);
      if (existsSync(blobPath)) {
        const stat = lstatSync(blobPath);
        if (!stat.isFile() || stat.isSymbolicLink() || createHash("sha256").update(readFileSync(blobPath)).digest("hex") !== digest) {
          throw new PeerJobError("artifact_corrupt", "Existing content-addressed artifact is unsafe or corrupt", 503);
        }
        if ((stat.mode & 0o077) !== 0) chmodSync(blobPath, 0o600);
      } else {
        const temporary = `${blobPath}.${randomUUID()}.tmp`;
        const fd = openSync(temporary, "wx", 0o600);
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temporary, blobPath);
        syncDirectory(directory);
      }
      Object.defineProperty(index.files, path, { value: { sha256: digest, bytes: bytes.byteLength }, enumerable: true, configurable: true, writable: true });
      writeIndex(indexPath, index);
      return { path, sha256: digest, bytes: bytes.byteLength, idempotent: Boolean(existing) };
    },

    readReceipt(job, attemptId, receipt) {
      const directory = peerJobDirectory(stateDir, job.jobId, attemptId);
      const index = readIndex(join(directory, "index.json"));
      const output = new Map<string, Buffer>();
      for (const file of receipt.files) {
        const path = canonicalizeManifestPath(file.path);
        const uploaded = Object.hasOwn(index.files, path) ? index.files[path] : undefined;
        if (!uploaded || uploaded.sha256 !== file.sha256 || uploaded.bytes !== file.bytes) {
          throw new PeerJobError("artifact_missing_or_mismatched", `Uploaded bytes do not match receipt entry ${JSON.stringify(path)}`, 422);
        }
        const blobPath = join(directory, uploaded.sha256);
        const stat = lstatSync(blobPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new PeerJobError("artifact_corrupt", `Stored artifact is not a regular file for ${JSON.stringify(path)}`, 503);
        }
        if ((stat.mode & 0o077) !== 0) chmodSync(blobPath, 0o600);
        const bytes = readFileSync(blobPath);
        const actualHash = createHash("sha256").update(bytes).digest("hex");
        if (actualHash !== file.sha256 || bytes.byteLength !== file.bytes) {
          throw new PeerJobError("artifact_corrupt", `Stored bytes failed validation for ${JSON.stringify(path)}`, 503);
        }
        output.set(path, bytes);
      }
      if (Object.keys(index.files).some((path) => !receipt.files.some((entry) => canonicalizeManifestPath(entry.path) === path))) {
        throw new PeerJobError("artifact_manifest_mismatch", "Uploaded artifacts include files omitted from the final receipt", 422);
      }
      return output;
    },
  };
}
