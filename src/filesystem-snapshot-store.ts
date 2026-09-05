/**
 * Transactional content-addressed filesystem snapshot store.
 *
 * This is the crash-consistent home for filesystem checkpoints. Unlike the
 * old walker, which wrote blobs directly into final CAS paths one at a time
 * and only wrote the manifest at the very end (so any interruption left every
 * newly-created blob permanently orphaned), captures here are explicit
 * transactions:
 *
 *   begin capture
 *     -> staging/<capture-id>/
 *     -> walk/hash workspace (streaming, sharded blobs)
 *     -> stage new content
 *     -> build complete manifest
 *     -> validate capture
 *     -> atomically publish blobs (no-clobber, hash-verified)
 *     -> atomically publish manifest LAST
 *     -> commit
 *     -> remove transaction/staging record
 *
 * Nothing is ever written directly into a final CAS path. Blobs and manifests
 * land via temp-file -> fsync -> rename; an existing destination is verified
 * rather than blindly trusted from `EEXIST`. A durable capture journal
 * (workspace-snapshots/transactions/<capture-id>.json) records the state of
 * every in-flight capture, and startup reconciliation removes/interrupts
 * anything not `committed`.
 *
 * Reachability GC is a bounded, resumable mark/sweep (`gcSlice`) so a single
 * maintenance slice cannot monopolize the serving thread. Strong roots come
 * from persisted baselines plus the durable snapshot identities held in
 * SQLite (submit/review/evidence/verification), so a submitted snapshot that
 * is no longer a baseline can never be reaped mid-review.
 *
 * Store layout (new captures; legacy flat `blobs/<sha256>` is read as a
 * fallback until it is collected):
 *
 *   workspace-snapshots/
 *     transactions/
 *     staging/
 *     baselines/<workspace>.json
 *     manifests/<sha256>.json
 *     blobs/⟨00..ff⟩/<sha256>
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  open,
} from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { safeWorkspaceRefSegment } from "./git.js";

export type WorkspaceSnapshotKind = "git" | "filesystem";

export interface WorkspaceSnapshot {
  kind: WorkspaceSnapshotKind;
  ref: string;
  createdAt: string;
}

/** Filesystem snapshot limits. All optional; an unset limit is unbounded. */
export interface FilesystemSnapshotLimits {
  /** Maximum number of files captured in one snapshot. */
  maxFiles?: number;
  /** Maximum total logical bytes captured in one snapshot. */
  maxBytes?: number;
  /** Maximum bytes of any single file read into a snapshot. */
  maxFileBytes?: number;
  /** Store high-water mark; GC is attempted above it and new captures fail closed above it. */
  highWaterBytes?: number;
  /** Store low-water mark; captures resume once store drops to/below it. */
  lowWaterBytes?: number;
  /** Retention (ms) for terminal-session unpinned manifests; stays pinned before expiry. */
  retentionMs?: number;
  /** Number of most-recent terminal snapshots per workspace to retain after TTL. */
  retainPerWorkspace?: number;
  /** Orphan grace (ms): very new unpinned objects are never reaped within this window. */
  orphanGraceMs?: number;
}

export interface FilesystemSnapshotStoreOptions {
  storeRoot?: string;
  limits?: FilesystemSnapshotLimits;
}

export interface FilesystemManifestEntry {
  path: string;
  type: "file" | "symlink";
  sha256: string;
  size: number;
  executable: boolean;
  target?: string;
}

export interface FilesystemManifest {
  version: 1;
  entries: FilesystemManifestEntry[];
}

export const FS_REF_PREFIX = "fs:sha256:";
const HASH_RE = /^[a-f0-9]{64}$/;

type CaptureState = "walking" | "published_blobs" | "published_manifest" | "committed";

interface CaptureJournal {
  captureId: string;
  state: CaptureState;
  startedAt: string;
  manifestRef?: string;
  blobHashes?: string[];
  files?: number;
  bytes?: number;
  /** Progress indication: number of blobs published so far (publish phase). */
  published?: number;
}

export interface StoreStats {
  manifests: number;
  blobs: number;
  blobBytes: number;
  stagingBytes: number;
  activeCaptures: number;
  incompleteTransactions: number;
  lastGcStartedAt?: string;
  lastGcCompletedAt?: string;
  lastGcReclaimedBlobs?: number;
  lastGcReclaimedBytes?: number;
  corruptionCount: number;
}

interface LoadBaselineResult {
  baselines?: {
    root: string;
    open: WorkspaceSnapshot;
    presentation: WorkspaceSnapshot;
    legacy: WorkspaceSnapshot;
    sessions: Record<string, WorkspaceSnapshot>;
  };
  corrupt?: boolean;
}

export interface RetainedManifestRef {
  ref: string;
  /** Present when the pin is a terminal (expiry-tracked) session snapshot. */
  terminalAt?: string;
}

export interface GcSliceResult {
  manifestsRetained: number;
  manifestsExpired: number;
  blobsReachable: number;
  blobsReclaimed: number;
  bytesReclaimed: number;
  corrupt: number;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The content-addressed filesystem backend. Implements the capture transaction
 * plus reachability GC and store stats. Kept independent of review/checkpoint
 * policy (which lives in review-checkpoints.ts).
 */
export class FilesystemSnapshotStore {
  private readonly storeRoot: string;
  private readonly limits: FilesystemSnapshotLimits & {
    highWaterBytes: number;
    lowWaterBytes: number;
    retentionMs: number;
    retainPerWorkspace: number;
    orphanGraceMs: number;
  };
  private readonly activeCaptures = new Map<string, Promise<unknown>>();
  private readonly corruptionBucket = new Map<string, number>();
  private readonly corruptionSamples = new Map<string, string>();
  private stopped = false;
  // GC state (cross-slice resumable). A full collection is decomposed into:
  //   phase 0: mark retained manifests (roots already known)
  //   phase 1: sweep blobs in bounded pages
  private gcState: {
    phase: 0 | 1;
    retained: Set<string>;
    marked: Set<string>;
    blobCursor: number;
    dirty: boolean;
    /** Cached blob listing for the current sweep phase, so the full directory
     * isn't re-enumerated on every bounded slice (O(n) total, not O(n²)). */
    allBlobs: Array<{ hash: string; path: string }> | null;
  } = {
    phase: 0,
    retained: new Set(),
    marked: new Set(),
    blobCursor: 0,
    dirty: false,
    allBlobs: null,
  };
  private retentionMs: number;
  private retainPerWorkspace: number;
  private orphanGraceMs: number;
  private corruptCount = 0;
  private lastGcStartedAt: string | undefined;
  private lastGcCompletedAt: string | undefined;
  private lastGcReclaimedBlobs = 0;
  private lastGcReclaimedBytes = 0;

  constructor(options: FilesystemSnapshotStoreOptions = {}) {
    this.storeRoot = resolve(options.storeRoot ?? join(tmpdir(), "kontrol-workspace-snapshots"));
    this.limits = {
      highWaterBytes: options.limits?.highWaterBytes ?? 40 * GB,
      lowWaterBytes: options.limits?.lowWaterBytes ?? 25 * GB,
      retentionMs: options.limits?.retentionMs ?? 30 * 24 * 60 * 60_000,
      retainPerWorkspace: options.limits?.retainPerWorkspace ?? 10,
      orphanGraceMs: options.limits?.orphanGraceMs ?? 5 * 60_000,
      maxFiles: options.limits?.maxFiles,
      maxBytes: options.limits?.maxBytes,
      maxFileBytes: options.limits?.maxFileBytes,
    };
    this.retentionMs = this.limits.retentionMs;
    this.retainPerWorkspace = this.limits.retainPerWorkspace;
    this.orphanGraceMs = this.limits.orphanGraceMs;
  }

  get storePath(): string {
    return this.storeRoot;
  }

  getStoreStatsForMetrics(): { manifests: number; activeCaptures: number; corruptionCount: number } {
    return {
      manifests: this.manifestsNow(),
      activeCaptures: this.activeCaptures.size,
      corruptionCount: this.corruptCount,
    };
  }

  private manifestsNow(): number {
    return this.gcState.retained.size;
  }

  async stopAccepting(): Promise<void> {
    this.stopped = true;
  }

  /** Graceful drain: reject new captures and wait for the active ones. */
  async close(): Promise<void> {
    await this.stopAccepting();
    await Promise.allSettled([...this.activeCaptures.values()]);
    await this.runStartupReconciliation();
  }

  async capture(
    root: string,
    context: { workSessionStatus?: string; createdAt?: string } = {},
  ): Promise<WorkspaceSnapshot> {
    if (this.stopped) throw new Error("Filesystem snapshot store is closed; refusing new captures.");
    const captureId = randomUUID();
    const startedAt = new Date().toISOString();
    const journalPath = this.journalPath(captureId);
    const stagingRoot = this.stagingPath(captureId);
    const run = (async () => this.doCapture(root, captureId, journalPath, stagingRoot, startedAt, context))();
    this.activeCaptures.set(captureId, run);
    try {
      return await run;
    } finally {
      this.activeCaptures.delete(captureId);
    }
  }

  private async doCapture(
    root: string,
    captureId: string,
    journalPath: string,
    stagingRoot: string,
    startedAt: string,
    context: { workSessionStatus?: string; createdAt?: string },
  ): Promise<WorkspaceSnapshot> {
    await mkdir(this.transactionsPath(), { recursive: true, mode: 0o700 });
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });

    const writeJournal = (state: CaptureState, extra: Partial<CaptureJournal> = {}) =>
      writeFile(journalPath, JSON.stringify({ captureId, state, startedAt, ...extra }), { encoding: "utf8", mode: 0o600 });
    await writeJournal("walking");

    const absoluteRoot = resolve(root);
    const manifest: FilesystemManifest = { version: 1, entries: [] };
    const stagedByHash = new Map<string, string>();
    // Track logical byte total as we walk (capped by limits.maxBytes, and an
    // estimate used for the journal).
    let generated = 0;
    await this.enforceHighWater();
    try {
      await this.walk(absoluteRoot, absoluteRoot, manifest.entries, {
        maxFiles: this.limits.maxFiles,
        maxBytes: this.limits.maxBytes,
        maxFileBytes: this.limits.maxFileBytes,
      }, stagedByHash, stagingRoot);
    } catch (error) {
      await this.abort(stagingRoot, journalPath);
      throw error;
    }

    generated = manifest.entries.reduce((sum, entry) => sum + (entry.size || 0), 0);

    manifest.entries.sort((a, b) => a.path.localeCompare(b.path));
    const serialized = JSON.stringify(manifest);
    const ref = FS_REF_PREFIX + hashBytes(Buffer.from(serialized, "utf8"));
    const blobHashes = [...stagedByHash.keys()];
    await writeJournal("published_blobs", { manifestRef: ref, blobHashes, files: manifest.entries.length, bytes: generated });

    // Publish blobs from staging (no-clobber, hash-verified), then the manifest LAST.
    const publishedHashes = new Set<string>();
    for (let i = 0; i < blobHashes.length; i++) {
      const hash = blobHashes[i];
      await this.publishBlob(stagedByHash.get(hash)!, hash);
      publishedHashes.add(hash);
      if ((i + 1) % 32 === 0) await writeJournal("published_blobs", { manifestRef: ref, blobHashes, files: manifest.entries.length, bytes: generated, published: i + 1 });
    }
    await writeJournal("published_manifest", { manifestRef: ref, blobHashes, files: manifest.entries.length, bytes: generated });
    const tempManifest = await this.stageBytes(Buffer.from(serialized, "utf8"));
    await this.publishManifestNoClobber(ref, serialized, tempManifest, publishedHashes);
    await writeJournal("committed", { manifestRef: ref, blobHashes, files: manifest.entries.length, bytes: generated });
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(journalPath, { force: true });

    return { kind: "filesystem", ref, createdAt: context.createdAt ?? startedAt };
  }

  /** Emergency brake: refuse new captures when the store is over its high-water
   * mark and a bounded GC attempt did not bring it back under. Guards against
   * filling the host disk. */
  private async enforceHighWater(): Promise<void> {
    if (!(await this.overHighWater())) return;
    // Attempt one bounded GC slice first (respects orphan grace).
    try {
      await this.gcSlice({ budgetMs: 1000, pageSize: 500, dryRun: false });
    } catch {
      /* GC failure surfaces via maintenance; continue to fail closed below */
    }
    if (await this.overHighWater()) {
      const approx = await this.approxStoreBytes();
      throw new FilesystemStoreOverHighWaterError(
        `Filesystem snapshot store is over its high-water mark (blobBytes=${approx.blobBytes}); refusing new captures. Run \`kontrol snapshots gc\` or raise KONTROL_FS_SNAPSHOT_STORE_HIGH_WATER_BYTES.`,
      );
    }
  }

  private async walk(
    root: string,
    current: string,
    entries: FilesystemManifestEntry[],
    limits: { maxFiles?: number; maxBytes?: number; maxFileBytes?: number },
    stagedByHash: Map<string, string>,
    stagingRoot: string,
  ): Promise<void> {
    if (this.stopped) throw new Error("Filesystem snapshot store closed during capture.");
    const children = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (this.stopped) throw new Error("Filesystem snapshot store closed during capture.");
      if (limits.maxFiles && entries.length + 1 > limits.maxFiles) {
        throw new FilesystemCaptureTooLargeError(`snapshot exceeds maxFiles ${limits.maxFiles}`);
      }
      const absolute = join(current, child.name);
      const relativePath = relative(root, absolute).split(sep).join("/");
      if (child.isDirectory()) {
        await this.walk(root, absolute, entries, limits, stagedByHash, stagingRoot);
        continue;
      }
      let info;
      try {
        info = await lstat(absolute);
      } catch {
        continue; // vanished during traversal; skip it
      }
      if (info.isSymbolicLink()) {
        let target;
        try {
          target = await readlink(absolute);
        } catch {
          continue;
        }
        const size = Buffer.byteLength(target);
        entries.push({ path: relativePath, type: "symlink", target, sha256: hashBytes(Buffer.from(target)), size, executable: (info.mode & 0o111) !== 0 });
        continue;
      }
      if (!info.isFile()) continue;
      if (typeof info.size === "number" && limits.maxFileBytes && info.size > limits.maxFileBytes) {
        throw new FilesystemCaptureTooLargeError(`file ${relativePath} (${info.size} bytes) exceeds maxFileBytes ${limits.maxFileBytes}`);
      }
      const { sha256, size } = await this.stageFile(absolute, stagingRoot, stagedByHash);
      entries.push({ path: relativePath, type: "file", sha256, size, executable: (info.mode & 0o111) !== 0 });
      if (limits.maxBytes) {
        const total = entries.reduce((sum, e) => sum + (e.size || 0), 0);
        if (total > limits.maxBytes) {
          throw new FilesystemCaptureTooLargeError(`snapshot exceeds maxBytes ${limits.maxBytes}`);
        }
      }
    }
  }

  /**
   * Stream a workspace file into the staging area, computing SHA-256 on the
   * fly, and record every staged path in `stagedByHash`. Content is addressed
   * by its digest at publish time. If the same content was already staged in
   * this capture, it is not staged twice (CAS dedup).
   */
  private async stageFile(src: string, stagingRoot: string, stagedByHash: Map<string, string>): Promise<{ sha256: string; size: number }> {
    const inStream = createReadStream(src);
    const staging = join(stagingRoot, "content-" + randomUUID());
    const outStream = createWriteStream(staging, { mode: 0o600 });
    let size = 0;
    const hasher = createHash("sha256");
    const hashTransform = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hasher.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      await pipeline(inStream, hashTransform, outStream);
    } catch (error) {
      outStream.close();
      await rm(staging, { force: true });
      throw error;
    }
    await this.fsyncFile(staging);
    const sha256 = hasher.digest("hex");
    const existing = stagedByHash.get(sha256);
    if (existing !== undefined) {
      // Duplicate content within this capture; drop the redundant staged file.
      outStream.close();
      await rm(staging, { force: true });
    } else {
      stagedByHash.set(sha256, staging);
    }
    return { sha256, size };
  }

  /** Atomically publish a blob from staging into its sharded final path. */
  private async publishBlob(stagedFile: string, hash: string): Promise<void> {
    const target = this.blobPath(hash);
    const info = await lstat(stagedFile).catch(() => undefined);
    if (!info || !info.isFile()) throw new Error(`Staged content for blob ${hash.slice(0, 12)} missing before publish.`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await rename(stagedFile, target);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        // Never trust a blind EEXIST: verify the existing blob's size/hash.
        const verified = await this.verifyBlob(hash);
        if (verified.ok) {
          // Both staging and final fine; drop the duplicate staged file.
          await rm(stagedFile, { force: true });
          return;
        }
        // Corrupt/truncated existing blob at the full expected name. Replace
        // it atomically rather than silently trusting it.
        const tmp = `${target}.tmp.${randomUUID()}`;
        await rename(stagedFile, tmp);
        try {
          await rename(tmp, target);
        } catch {
          await rm(tmp, { force: true });
          await this.verifyBlob(hash);
        }
        return;
      }
      throw error;
    }
  }

  private async stageBytes(content: Buffer): Promise<string> {
    const temp = join(this.storeRoot, ".tmp-" + randomUUID());
    const fh = await open(temp, "w", 0o600);
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    return temp;
  }

  private async publishManifestNoClobber(
    ref: string,
    serialized: string,
    tempManifest: string,
    publishedHashes: Set<string>,
  ): Promise<void> {
    const manifestPath = this.manifestPath(ref);
    await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
    // Verify all referenced blobs are present/valid before the manifest lands.
    for (const entry of JSON.parse(serialized).entries as FilesystemManifestEntry[]) {
      if (entry.type !== "file") continue;
      if (!publishedHashes.has(entry.sha256)) {
        const verified = await this.verifyBlob(entry.sha256);
        if (!verified.ok) throw new Error(`Blob ${entry.sha256.slice(0, 12)} missing before manifest publish.`);
      }
    }
    try {
      await rename(tempManifest, manifestPath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        // Same manifest already published by a concurrent writer.
        const existing = await readFile(manifestPath, "utf8").catch(() => undefined);
        const existingHash = existing ? FS_REF_PREFIX + hashBytes(Buffer.from(existing, "utf8")) : undefined;
        if (existingHash !== ref || existingHash === undefined) {
          // Verify the concurrent result is the same logical manifest; if it
          // differs this is a true (extremely rare) SHA-256 collision.
          await rm(tempManifest, { force: true });
          throw new Error("Concurrent manifest with identical ref has different content.");
        }
        await rm(tempManifest, { force: true });
        return;
      }
      throw error;
    }
  }

  /** Verify a final blob's existence, length and (optionally) hash. */
  async verifyBlob(hash: string): Promise<{ ok: boolean; size: number; reason?: string }> {
    if (!HASH_RE.test(hash)) return { ok: false, size: 0, reason: "invalid hash" };
    // Sharded layout first; fall back to the legacy flat location for stores
    // that predate sharding (so validation and byte accounting work before GC).
    const targets = [this.blobPath(hash), this.legacyBlobPath(hash)];
    for (const target of targets) {
      let st;
      try {
        st = await stat(target);
      } catch {
        continue;
      }
      if (!st.isFile()) return { ok: false, size: st.size, reason: "not a regular file" };
      return { ok: true, size: st.size, reason: undefined };
    }
    return { ok: false, size: 0, reason: "missing" };
  }

  /** bol-path with sharded layout; falls back to legacy flat location on read. */
  blobPath(hash: string): string {
    if (!HASH_RE.test(hash)) throw new Error(`Invalid filesystem blob hash: ${hash}`);
    return join(this.storeRoot, "blobs", hash.slice(0, 2), hash.slice(2));
  }

  private legacyBlobPath(hash: string): string {
    if (!HASH_RE.test(hash)) throw new Error(`Invalid filesystem blob hash: ${hash}`);
    return join(this.storeRoot, "blobs", hash);
  }

  manifestPath(ref: string): string {
    if (!ref.startsWith(FS_REF_PREFIX)) throw new Error(`Invalid filesystem snapshot ref: ${ref}`);
    return join(this.storeRoot, "manifests", `${ref.slice(FS_REF_PREFIX.length)}.json`);
  }

  baselinePath(workspaceId: string): string {
    return join(this.storeRoot, "baselines", `${safeWorkspaceRefSegment(workspaceId)}.json`);
  }

  private transactionsPath(): string {
    return join(this.storeRoot, "transactions");
  }

  private journalPath(captureId: string): string {
    return join(this.transactionsPath(), `${captureId}.json`);
  }

  private stagingPath(captureId: string): string {
    return join(this.storeRoot, "staging", captureId);
  }

  async readBlobStream(hash: string): Promise<Readable> {
    const target = this.blobPath(hash);
    if (await pathExists(target)) {
      return createReadStream(target);
    }
    const legacy = this.legacyBlobPath(hash);
    if (await pathExists(legacy)) {
      return createReadStream(legacy);
    }
    throw new Error(`Filesystem blob not found: ${hash.slice(0, 12)}`);
  }

  async readBlobBuffer(hash: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of (await this.readBlobStream(hash)) as unknown as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async readManifest(snapshot: WorkspaceSnapshot): Promise<FilesystemManifest> {
    if (snapshot.kind !== "filesystem") throw new Error("Expected a filesystem snapshot.");
    const manifest = JSON.parse(await readFile(this.manifestPath(snapshot.ref), "utf8")) as FilesystemManifest;
    if (manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new Error("Invalid filesystem snapshot manifest.");
    return manifest;
  }

  async validateSnapshot(snapshot: WorkspaceSnapshot | undefined): Promise<boolean> {
    if (!snapshot || snapshot.kind !== "filesystem") return false;
    try {
      const manifest = await this.readManifest(snapshot);
      for (const entry of manifest.entries) {
        if (entry.type !== "file") continue;
        const verified = await this.verifyBlob(entry.sha256);
        if (!verified.ok) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async captureStreamingTestRoot(_root: string): Promise<void> { /* no-op placeholder */ }

  /** Load persisted baselines; distinguishes missing vs corrupt. */
  async loadBaselines(workspaceId: string): Promise<{ root: string; open: WorkspaceSnapshot; presentation: WorkspaceSnapshot; legacy: WorkspaceSnapshot; sessions: Record<string, WorkspaceSnapshot> } | undefined> {
    const result = await this.loadBaselinesWithDiagnostic(workspaceId);
    return result.baselines;
  }

  async loadBaselinesWithDiagnostic(workspaceId: string): Promise<LoadBaselineResult> {
    const path = this.baselinePath(workspaceId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return {};
      }
      return {};
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      await this.recordCorruption(`baseline:${workspaceId}`, "invalid JSON in baseline file");
      return { corrupt: true };
    }
    const obj = value as { root?: string; open?: WorkspaceSnapshot; presentation?: WorkspaceSnapshot; legacy?: WorkspaceSnapshot; sessions?: Record<string, WorkspaceSnapshot> };
    if (!obj || typeof obj !== "object") {
      await this.recordCorruption(`baseline:${workspaceId}`, "baseline file is not an object");
      return { corrupt: true };
    }
    if (!obj.root || typeof obj.root !== "string" || !obj.open || obj.open.kind !== "filesystem" || !obj.presentation || obj.presentation.kind !== "filesystem" || !obj.legacy || obj.legacy.kind !== "filesystem" || !obj.sessions || typeof obj.sessions !== "object") {
      await this.recordCorruption(`baseline:${workspaceId}`, "baseline file has an invalid structure");
      return { corrupt: true };
    }
    return { baselines: { root: obj.root, open: obj.open, presentation: obj.presentation, legacy: obj.legacy, sessions: obj.sessions } };
  }

  /** Atomically persist baselines (tmp + fsync + rename). */
  async saveBaselines(workspaceId: string, root: string, baselines: { open: WorkspaceSnapshot; presentation: WorkspaceSnapshot; legacy: WorkspaceSnapshot; sessions: Map<string, WorkspaceSnapshot> }): Promise<void> {
    await mkdir(join(this.storeRoot, "baselines"), { recursive: true, mode: 0o700 });
    const sessions = Object.fromEntries([...baselines.sessions.entries()].sort(([left], [right]) => left.localeCompare(right)));
    const serialized = JSON.stringify({ root: resolve(root), open: baselines.open, presentation: baselines.presentation, legacy: baselines.legacy, sessions });
    const temp = await this.stageBytes(Buffer.from(serialized, "utf8"));
    const target = this.baselinePath(workspaceId);
    await rename(temp, target);
  }

  /** Remove a stale session baseline pin so GC can reclaim it. */
  async releaseWorkSessionBaseline(workspaceId: string, workSessionId: string): Promise<void> {
    const loaded = await this.loadBaselinesWithDiagnostic(workspaceId);
    const baselines = loaded.baselines;
    if (!baselines) return;
    const sessions = new Map(Object.entries(baselines.sessions));
    sessions.delete(workSessionId);
    await this.saveBaselines(workspaceId, baselines.root, { open: baselines.open, presentation: baselines.presentation, legacy: baselines.legacy, sessions });
  }

  /** Atomically drop session pins whose keys are no longer nonterminal sessions. */
  async pruneSessionBaselines(workspaceId: string, nonterminalIds: Set<string>): Promise<{ dropped: number }> {
    const loaded = await this.loadBaselinesWithDiagnostic(workspaceId);
    const baselines = loaded.baselines;
    if (!baselines) return { dropped: 0 };
    const sessions = new Map(Object.entries(baselines.sessions));
    let dropped = 0;
    for (const key of [...sessions.keys()]) {
      if (!nonterminalIds.has(key)) {
        sessions.delete(key);
        dropped++;
      }
    }
    if (dropped > 0) {
      await this.saveBaselines(workspaceId, baselines.root, { open: baselines.open, presentation: baselines.presentation, legacy: baselines.legacy, sessions });
    }
    return { dropped };
  }

  /**
   * Reconcile interrupted capture transactions on startup. Anything in
   * `transactions/<capture-id>.json` not `committed` has its staging removed
   * (and, if it was mid-publish, whatever staged content remains). This covers
   * process death, not merely normal exceptions.
   */
  async runStartupReconciliation(): Promise<{ removed: number }> {
    const txDir = this.transactionsPath();
    let files: string[] = [];
    try {
      files = (await readdir(txDir)).filter((name) => name.endsWith(".json"));
    } catch {
      return { removed: 0 };
    }
    let removed = 0;
    for (const file of files) {
      const journalPath = join(txDir, file);
      try {
        const journal = JSON.parse(await readFile(journalPath, "utf8")) as CaptureJournal;
        if (journal.state === "committed") {
          // Committed journals may remain only if the final cleanup didn't run;
          // the blobs/manifest are already published, so just clear the record.
          await rm(journalPath, { force: true });
          await rm(this.stagingPath(journal.captureId), { recursive: true, force: true });
          removed++;
          continue;
        }
        await rm(this.stagingPath(journal.captureId), { recursive: true, force: true });
        await rm(journalPath, { force: true });
        removed++;
      } catch (error) {
        // A corrupt journal for a non-existent capture: remove the record.
        await rm(this.stagingPath(file.replace(/\.json$/, "")), { recursive: true, force: true });
        await rm(journalPath, { force: true }).catch(() => undefined);
        removed++;
      }
    }
    // Also remove any orphaned staging dirs with no journal (crashed before
    // the journal was even written).
    const stagingParent = join(this.storeRoot, "staging");
    let stagingEntries: string[] = [];
    try {
      stagingEntries = await readdir(stagingParent);
    } catch {
      stagingEntries = [];
    }
    for (const entry of stagingEntries) {
      await rm(join(stagingParent, entry), { recursive: true, force: true });
      removed++;
    }
    return { removed };
  }

  /**
   * Compute strong roots: current baseline refs for every persisted baseline,
   * plus durable filesystem snapshot identities held in SQLite. The `listDbSnapshots`
   * callback returns filesystem refs (e.g. from work_session_submissions,
   * mission_evidence, mission_completion_reports, supervisor_runs), triaged by
   * whether the owning work session is terminal (for retention) or still
   * nonterminal (always pinned).
   */
  private async collectRoots(listDbSnapshots?: () => Array<{ ref: string; terminal?: boolean }>): Promise<{
    /** Strong pins: never expire during the collection. */
    strong: Set<string>;
    /** Retention-tracked terminal refs (expire after retentionMs; the newest
     * `retainPerWorkspace` of them survive beyond the TTL). */
    terminal: Array<{ ref: string; refMtimeMs: number }>;
  }> {
    const strong = new Set<string>();
    const terminal: Array<{ ref: string; refMtimeMs: number }> = [];
    // 1. Persisted baselines: open/presentation/legacy + session pins are
    //    strong pins (they are the live top-of-workspace refs).
    const baselineDir = join(this.storeRoot, "baselines");
    let baselineFiles: string[] = [];
    try {
      baselineFiles = (await readdir(baselineDir)).filter((name) => name.endsWith(".json"));
    } catch {
      baselineFiles = [];
    }
    for (const file of baselineFiles) {
      const raw = await readFile(join(baselineDir, file), "utf8").catch(() => undefined);
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const obj = parsed as { open?: WorkspaceSnapshot; presentation?: WorkspaceSnapshot; legacy?: WorkspaceSnapshot; sessions?: Record<string, WorkspaceSnapshot> };
      for (const key of ["open", "presentation", "legacy"] as const) {
        const snap = obj[key];
        if (snap && snap.kind === "filesystem" && snap.ref) strong.add(snap.ref);
      }
      if (obj.sessions && typeof obj.sessions === "object") {
        for (const sref of Object.values(obj.sessions)) {
          const snap = sref as WorkspaceSnapshot | undefined;
          if (snap && snap.kind === "filesystem" && snap.ref) strong.add(snap.ref);
        }
      }
    }
    // 2. Durable DB roots: nonterminal refs are strong pins; terminal refs are
    //    retention-tracked (age from the manifest file's mtime).
    if (listDbSnapshots) {
      for (const snap of listDbSnapshots()) {
        if (!snap || !snap.ref) continue;
        if (snap.terminal) {
          const refMtimeMs = await this.manifestMtimeMs(snap.ref);
          if (refMtimeMs !== undefined) terminal.push({ ref: snap.ref, refMtimeMs });
          // A terminal ref whose manifest was already collected simply isn't a
          // live ref anymore; nothing to pin.
        } else {
          strong.add(snap.ref);
        }
      }
    }
    return { strong, terminal };
  }

  /**
   * Run one bounded GC slice. The full mark/sweep is decomposed into small
   * phases and a wall-clock budget so it never monopolizes the serving thread;
   * state is kept on `this.gcState` and resumed on the next call.
   *
   * phase 0 — mark retained manifests: compute strong roots (persisted
   *   baselines + durable SQLite snapshot refs), expire old unpinned
   *   manifests (honoring orphan grace), then parse every retained
   *   manifest and mark the blob hashes it references.
   *
   * phase 1 — sweep: iterate blobs (sharded) in bounded pages and delete the
   *   unmarked ones, subject to orphan grace. This phase is resumable: it
   *   holds a cursor into the blob listing so a slice gap cannot repeatedly
   *   rescan the same prefix.
   *
   * phase transitions when `hasMore` is true mean the caller should schedule
   * another slice; when false the collection is complete.
   */
  async gcSlice(options: {
    budgetMs: number;
    pageSize?: number;
    listDbSnapshots?: () => Array<{ ref: string; terminal?: boolean }>;
    dryRun?: boolean;
  }): Promise<{ result: GcSliceResult; hasMore: boolean }> {
    const startedAt = performance.now();
    const pageSize = options.pageSize ?? 200;
    const nowMs = Date.now();
    const result: GcSliceResult = {
      manifestsRetained: 0,
      manifestsExpired: 0,
      blobsReachable: 0,
      blobsReclaimed: 0,
      bytesReclaimed: 0,
      corrupt: 0,
    };

    // ----- phase 0: roots + retained manifests + mark blobs -----
    if (this.gcState.phase === 0) {
      const { strong, terminal } = await this.collectRoots(options.listDbSnapshots);
      const retained = new Set<string>();
      // Retain the newest `retainPerWorkspace` terminal refs beyond their TTL so
      // operators keep a bounded recent tail even after retention expires.
      const protectedAfterTtl = new Set([...terminal]
        .sort((a, b) => b.refMtimeMs - a.refMtimeMs)
        .slice(0, this.retainPerWorkspace)
        .map((t) => t.ref));
      const expired: string[] = [];
      for (const f of await this.listManifestFiles()) {
        const ref = FS_REF_PREFIX + f.replace(/\.json$/, "");
        // A manifest that still exists is retained if it is a strong pin,
        // within its retention window (terminal), or fresh (orphan grace).
        const isStrong = strong.has(ref);
        const terminalRef = terminal.find((t) => t.ref === ref);
        const withinRetention = terminalRef !== undefined && nowMs - terminalRef.refMtimeMs < this.retentionMs;
        if (isStrong || withinRetention || protectedAfterTtl.has(ref)) {
          retained.add(ref);
        } else {
          expired.push(ref);
        }
      }
      // Honoring orphan grace for very new manifests: anything fresh is kept.
      for (const ref of expired) {
        const mt = await this.manifestMtimeMs(ref);
        const isNew = mt !== undefined && nowMs - mt < this.orphanGraceMs;
        if (isNew) {
          retained.add(ref);
        } else {
          if (!options.dryRun) await rm(this.manifestPath(ref), { force: true }).catch(() => undefined);
          result.manifestsExpired++;
        }
      }
      result.manifestsRetained = retained.size;
      // Mark blobs referenced by every retained manifest.
      for (const ref of retained) {
        try {
          const manifest = await this.readManifest({ kind: "filesystem", ref, createdAt: new Date(0).toISOString() });
          for (const entry of manifest.entries) {
            if (entry.type === "file" && entry.sha256) this.gcState.marked.add(entry.sha256);
          }
        } catch (error) {
          await this.recordCorruption(`manifest:${ref}`, error instanceof Error ? error.message : String(error));
          result.corrupt++;
        }
      }
      this.gcState.retained = retained;
      this.gcState.phase = 1;
      this.gcState.blobCursor = 0;
      this.gcState.dirty = true;
      // Snapshot the blob listing once for this sweep; reused across slices.
      this.gcState.allBlobs = await this.listBlobFiles();
      if (this.lastGcStartedAt === undefined) this.lastGcStartedAt = new Date().toISOString();
      return { result, hasMore: true };
    }

    // ----- phase 1: sweep blobs in bounded pages -----
    const allBlobs = this.gcState.allBlobs ?? (await this.listBlobFiles());
    const marked = this.gcState.marked;
    let scanned = 0;
    let index = this.gcState.blobCursor;
    while (index < allBlobs.length && performance.now() - startedAt < options.budgetMs && scanned < pageSize) {
      const blobFile = allBlobs[index];
      const hash = blobFile.hash;
      if (marked.has(hash)) {
        result.blobsReachable++;
      } else {
        const fullPath = blobFile.path;
        const sz = await this.sizeOf(fullPath);
        // Recency check only matters when a safe grace window is configured; at
        // grace 0 nothing can be "too fresh", so skip the extra stat entirely.
        const isNew = this.orphanGraceMs > 0
          ? ((await this.mtimeMs(fullPath)) ?? 0) - nowMs > -this.orphanGraceMs
          : false;
        if (isNew) {
          // Too fresh to safely reclaim; treat as reachable this slice.
          result.blobsReachable++;
        } else {
          if (!options.dryRun) await rm(fullPath, { force: true }).catch(() => undefined);
          result.blobsReclaimed++;
          result.bytesReclaimed += sz;
        }
      }
      scanned++;
      index++;
      this.gcState.blobCursor = index;
    }

    const hasMore = index < allBlobs.length;
    if (hasMore) {
      return { result, hasMore: true };
    }

    // Collection complete.
    this.gcState.phase = 0;
    this.gcState.marked.clear();
    this.gcState.retained.clear();
    this.gcState.blobCursor = 0;
    this.gcState.allBlobs = null;
    if (!this.lastGcStartedAt) this.lastGcStartedAt = new Date().toISOString();
    this.lastGcCompletedAt = new Date().toISOString();
    this.lastGcReclaimedBlobs = result.blobsReclaimed;
    this.lastGcReclaimedBytes = result.bytesReclaimed;
    return { result, hasMore: false };
  }

  private async listManifestFiles(): Promise<string[]> {
    const dir = join(this.storeRoot, "manifests");
    try {
      return (await readdir(dir)).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
  }

  private async listBlobFiles(): Promise<Array<{ hash: string; path: string }>> {
    const out: Array<{ hash: string; path: string }> = [];
    const blobsRoot = join(this.storeRoot, "blobs");
    let shardDirs: string[] = [];
    try {
      shardDirs = (await readdir(blobsRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      // treat whole blobs dir as flat legacy if no shard subdirs exist
      shardDirs = [];
    }
    if (shardDirs.length === 0) {
      // legacy flat layout: each entry is the full 64-hex hash.
      try {
        for (const name of await readdir(blobsRoot)) {
          if (HASH_RE.test(name)) out.push({ hash: name, path: join(blobsRoot, name) });
        }
      } catch {
        /* ignore */
      }
      return out;
    }
    for (const shard of shardDirs) {
      const shardPath = join(blobsRoot, shard);
      let names: string[] = [];
      try {
        names = await readdir(shardPath);
      } catch {
        continue;
      }
      for (const name of names) {
        // Sharded layout stores <2hex-shard>/<hash-without-prefix>, so the
        // on-disk name is 62 hex; rebuild the full 64-hex hash for the mark set.
        const fullHash = shard + name;
        if (HASH_RE.test(fullHash)) out.push({ hash: fullHash, path: join(shardPath, name) });
      }
    }
    return out;
  }

  private async manifestMtimeMs(ref: string): Promise<number | undefined> {
    try {
      const st = await stat(this.manifestPath(ref));
      return st.mtimeMs;
    } catch {
      return undefined;
    }
  }

  private async mtimeMs(file: string): Promise<number | undefined> {
    try {
      const st = await stat(file);
      return st.mtimeMs;
    } catch {
      return undefined;
    }
  }

  private async sizeOf(file: string): Promise<number> {
    try {
      const st = await stat(file);
      return st.size;
    } catch {
      return 0;
    }
  }

  /** Directory byte usage (sharded + legacy, recursion for shards). */
  async approxStoreBytes(): Promise<{ blobs: number; blobBytes: number; manifests: number; stagingBytes: number }> {
    const blobs = await this.listBlobFiles();
    let blobBytes = 0;
    for (const b of blobs) blobBytes += await this.sizeOf(b.path);
    let stagingBytes = 0;
    try {
      const stagingParent = join(this.storeRoot, "staging");
      for (const entry of await readdir(stagingParent)) {
        stagingBytes += await this.dirBytes(join(stagingParent, entry));
      }
    } catch {
      /* ignore */
    }
    return {
      blobs: blobs.length,
      blobBytes,
      manifests: await this.listManifestFiles().then((f) => f.length),
      stagingBytes,
    };
  }

  private async dirBytes(dir: string): Promise<number> {
    let total = 0;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) total += await this.dirBytes(full);
      else {
        try {
          const st = await stat(full);
          total += st.size;
        } catch {
          /* ignore */
        }
      }
    }
    return total;
  }

  async storeStats(): Promise<StoreStats> {
    const approx = await this.approxStoreBytes();
    return {
      manifests: approx.manifests,
      blobs: approx.blobs,
      blobBytes: approx.blobBytes,
      stagingBytes: approx.stagingBytes,
      activeCaptures: this.activeCaptures.size,
      incompleteTransactions: await this.countIncompleteTransactions(),
      lastGcStartedAt: this.lastGcStartedAt,
      lastGcCompletedAt: this.lastGcCompletedAt,
      lastGcReclaimedBlobs: this.lastGcReclaimedBlobs,
      lastGcReclaimedBytes: this.lastGcReclaimedBytes,
      corruptionCount: this.corruptCount,
    };
  }

  /** Number of unfinished capture-transaction journals in the store. */
  async countIncompleteTransactionsPublic(): Promise<number> {
    return this.countIncompleteTransactions();
  }

  private async countIncompleteTransactions(): Promise<number> {
    try {
      const files = await readdir(this.transactionsPath());
      let count = 0;
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const j = JSON.parse(await readFile(join(this.transactionsPath(), f), "utf8")) as CaptureJournal;
          if (j.state !== "committed") count++;
        } catch {
          count++;
        }
      }
      return count;
    } catch {
      return 0;
    }
  }

  private async recordCorruption(key: string, detail: string): Promise<void> {
    this.corruptCount++;
    this.corruptionBucket.set(key, (this.corruptionBucket.get(key) ?? 0) + 1);
    if (!this.corruptionSamples.has(key)) this.corruptionSamples.set(key, detail);
  }

  /**
   * Compute the reachable blob set/bytes WITHOUT mutating GC state. Used by
   * diagnostics and the operator stats command. Roots come from the persisted
   * baselines plus the optional DB root collector (same production roots GC
   * uses). This does not delete anything.
   */
  async estimateReachableBytes(listDbSnapshots?: () => Array<{ ref: string; terminal?: boolean }>): Promise<{
    blobs: number;
    bytes: number;
    manifests: number;
  }> {
    const { strong, terminal } = await this.collectRoots(listDbSnapshots);
    const now = Date.now();
    const roots = new Set(strong);
    for (const t of terminal) {
      // Count terminal refs as reachable within their retention window and the
      // bounded recent tail, mirroring gcSlice's retention logic.
      if (now - t.refMtimeMs < this.retentionMs || [...terminal].sort((a, b) => b.refMtimeMs - a.refMtimeMs).slice(0, this.retainPerWorkspace).some((x) => x.ref === t.ref)) {
        roots.add(t.ref);
      }
    }
    const marked = new Set<string>();
    let manifests = 0;
    let bytes = 0;
    for (const manifestFile of await this.listManifestFiles()) {
      const ref = FS_REF_PREFIX + manifestFile.replace(/\.json$/, "");
      if (!roots.has(ref)) continue;
      manifests++;
      try {
        const manifest = await this.readManifest({ kind: "filesystem", ref, createdAt: new Date(0).toISOString() });
        for (const entry of manifest.entries) {
          if (entry.type !== "file" || marked.has(entry.sha256)) continue;
          marked.add(entry.sha256);
          const v = await this.verifyBlob(entry.sha256);
          if (v.ok) bytes += v.size;
        }
      } catch {
        /* corrupt manifest; skip */
      }
    }
    return { blobs: marked.size, bytes, manifests };
  }

  private async abort(stagingRoot: string, journalPath: string): Promise<void> {
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(journalPath, { force: true });
  }

  private async fsyncFile(file: string): Promise<void> {
    const fh = await open(file, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  /** Whether the store is currently over its high-water mark. */
  async overHighWater(): Promise<boolean> {
    const approx = await this.approxStoreBytes();
    return approx.blobBytes > this.limits.highWaterBytes;
  }
}

class FilesystemCaptureTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilesystemCaptureTooLargeError";
  }
}

export class FilesystemStoreOverHighWaterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilesystemStoreOverHighWaterError";
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

export default FilesystemSnapshotStore;