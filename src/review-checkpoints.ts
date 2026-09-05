import { mkdtemp, rm } from "node:fs/promises";
import { mkdir, readFile as readFileAsync, readdir, lstat, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, relative, resolve, dirname, sep } from "node:path";
import { git, getGitEligibility, safeWorkspaceRefSegment } from "./git.js";
import { FilesystemSnapshotStore, type FilesystemSnapshotLimits } from "./filesystem-snapshot-store.js";

export type ReviewSince = "last_shown" | "last_review" | "workspace_open" | "work_session";

export interface ReviewSummary {
  files: number;
  additions: number;
  removals: number;
}

export interface ReviewFile {
  path: string;
  previousPath?: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  additions: number;
  removals: number;
}

export type WorkspaceSnapshotKind = "git" | "filesystem";

export interface WorkspaceSnapshot {
  kind: WorkspaceSnapshotKind;
  ref: string;
  createdAt: string;
}

export interface CheckpointBackend {
  readonly kind: WorkspaceSnapshotKind;
  capture(root: string): Promise<WorkspaceSnapshot>;
  diff(root: string, baseline: WorkspaceSnapshot, current: WorkspaceSnapshot): Promise<Pick<ReviewChangesResult, "summary" | "files" | "patch">>;
  compare(root: string, expected: WorkspaceSnapshot): Promise<boolean>;
  materialize?(snapshot: WorkspaceSnapshot, destination: string): Promise<void>;
}

export interface ReviewChangesResult {
  result: string;
  summary: ReviewSummary;
  files: ReviewFile[];
  patch: string;
  /** Explicit backend-neutral identity of the captured workspace snapshot. */
  snapshot: WorkspaceSnapshot;
  snapshotKind: WorkspaceSnapshotKind;
  snapshotRef: string;
  /** @deprecated Compatibility projection for legacy Git-bound callers. */
  snapshotCommit: string;
}

interface WorkspaceReviewState {
  root: string;
  gitRoot?: string;
  workspaceRelativePath?: string;
  openRef: string;
  presentationRef: string;
  legacyBaselineRef: string;
  diagnostic?: string;
  backend?: CheckpointBackend;
  filesystemBaselines?: {
    open: WorkspaceSnapshot;
    presentation: WorkspaceSnapshot;
    legacy: WorkspaceSnapshot;
    sessions: Map<string, WorkspaceSnapshot>;
  };
}

/**
 * P0 #4: Single-flight, awaitable initialization. The state object exists
 * immediately (so the workspace is visible), but the `initialization` promise
 * must be awaited before any review operation can proceed. This eliminates
 * the race where reviewChanges() could run against a half-initialized state.
 */
interface WorkspaceReviewStateWithInit extends WorkspaceReviewState {
  initialization: Promise<void>;
}

export interface ReviewCheckpointManager {
  initializeWorkspace(input: { workspaceId: string; root: string }): Promise<void>;
  getSnapshotInfo(input: { workspaceId: string; root: string }): Promise<{ kind: WorkspaceSnapshotKind; available: boolean; diagnostic?: string }>;
  reviewChanges(input: {
    workspaceId: string;
    root: string;
    since?: ReviewSince;
    markReviewed?: boolean;
    workSessionId?: string;
  }): Promise<ReviewChangesResult>;
  reviewChangesAgainstCommit(input: {
    workspaceId: string;
    root: string;
    baselineCommit: string;
  }): Promise<ReviewChangesResult>;
  reviewChangesAgainstSnapshot(input: {
    workspaceId: string;
    root: string;
    baseline: WorkspaceSnapshot;
  }): Promise<ReviewChangesResult>;
  /** Cheap exact-tree binding check for verifiers; does not build a diff. */
  assertTreeMatchesCommit(input: { workspaceId: string; root: string; baselineCommit: string }): Promise<boolean>;
  assertSnapshotMatches(input: { workspaceId: string; root: string; expected: WorkspaceSnapshot }): Promise<boolean>;
  materializeSnapshot(input: { workspaceId: string; root: string; snapshot: WorkspaceSnapshot; destination: string }): Promise<void>;
  /**
   * Commit the review checkpoint to an exact previously-captured snapshot.
   * Advances baselineRef to `snapshotCommit` WITHOUT recomputing the working
   * tree (which may have changed since capture). Call only after the review
   * submission was persisted, so a failure cannot silently drop the diff.
   */
  commitReviewed(input: { workspaceId: string; root: string; snapshotCommit: string; workSessionId?: string }): Promise<void>;
  commitReviewedSnapshot(input: { workspaceId: string; root: string; snapshot: WorkspaceSnapshot; workSessionId?: string }): Promise<void>;
  /**
   * Awaits the workspace's initial filesystem baseline (or git refs) before any
   * mutation-capable operation proceeds. Resolves immediately once the workspace
   * is ready (or ineligible for filesystem capture). Used as a central mutation
   * preflight so mutations cannot race the initial baseline.
   */
  awaitWorkspaceReady(input: { workspaceId: string; root: string }): Promise<void>;
  /** Graceful shutdown: stop accepting new captures, drain active ones. */
  drain(): Promise<void>;
  /** Raw store surface for maintenance/CLI (GC, stats, reconciliation). */
  getSnapshotStore(): FilesystemSnapshotStore;
  /** Drop a terminal work-session's baseline pin so GC can reclaim it. */
  releaseWorkSessionBaseline(input: { workspaceId: string; workSessionId: string }): Promise<void>;
}

const REVIEW_REF_PREFIX = "refs/kontrol/review";

export function createReviewCheckpointManager(options: {
  snapshotStoreRoot?: string;
  snapshotLimits?: FilesystemSnapshotLimits;
  fsStore?: FilesystemSnapshotStore;
} = {}): ReviewCheckpointManager {
  const states = new Map<string, WorkspaceReviewStateWithInit>();
  // Created lazily on first filesystem use so tests that never capture an
  // ordinary directory don't touch a store at all. The facade exposes the
  // review-policy surface (capture/diff/compare/materialize); raw store
  // operations (GC, stats, reconciliation) go through `.store`.
  let fsBackend: FilesystemCheckpointBackend | undefined;
  const getFsBackend = (): FilesystemCheckpointBackend => {
    if (!fsBackend) {
      fsBackend = new FilesystemCheckpointBackend({
        storeRoot: options.snapshotStoreRoot ?? join(tmpdir(), "kontrol-workspace-snapshots"),
        store: options.fsStore,
        limits: options.snapshotLimits,
      });
    }
    return fsBackend;
  };
  // Alias used by review-change paths that need the raw store.
  const getFsStore = (): FilesystemSnapshotStore => getFsBackend().store;

  /**
   * P1 #15: Retryable initialization. Track state explicitly.
   * If initialization fails with a transient error (not "not a git repo"),
   * the next call will retry. Permanent errors (not a git repo) are cached.
   */
  async function ensureInitialized(workspaceId: string, root: string): Promise<WorkspaceReviewStateWithInit> {
    const existing = states.get(workspaceId);
    if (existing) {
      await existing.initialization;
      // P1 #15: If previous init failed with transient error, retry
      if (existing.diagnostic && !existing.gitRoot) {
        // Check if it's a retryable error (not "not a git repo")
        if (!existing.diagnostic.includes("not a git repo") && !existing.diagnostic.includes("requires a Git workspace")) {
          states.delete(workspaceId);
        } else {
          return existing;
        }
      } else {
        return existing;
      }
    }
    // Create the state immediately so the workspace is visible, but the
    // initialization promise gates all review operations.
    let resolveInit!: () => void;
    const initPromise = new Promise<void>((resolve) => { resolveInit = resolve; });
    const refs = reviewRefs(workspaceId);
    const state: WorkspaceReviewStateWithInit = { root, ...refs, initialization: initPromise };
    states.set(workspaceId, state);

    try {
      const eligibility = await getGitEligibility(root);
      if (!eligibility.ok || !eligibility.gitRoot) {
        const store = getFsStore();
        state.backend = getFsBackend();
        // P0 #2: Load the persisted baseline FIRST. Only capture a fresh tree
        // when there is no valid persisted baseline for this root. The old code
        // captured unconditionally, so every restart wrote another unreferenced
        // full-tree snapshot before checking whether a baseline existed.
        const persisted = await store.loadBaselines(workspaceId);
        if (persisted && persisted.root === resolve(root) && await store.validateSnapshot(persisted.open)) {
          state.filesystemBaselines = {
            open: persisted.open,
            presentation: persisted.presentation,
            legacy: persisted.legacy,
            sessions: new Map(Object.entries(persisted.sessions)),
          };
        } else {
          await store.runStartupReconciliation();
          const open = await store.capture(root);
          state.filesystemBaselines = { open, presentation: open, legacy: open, sessions: new Map() };
          await store.saveBaselines(workspaceId, root, state.filesystemBaselines);
        }
        state.diagnostic = undefined;
        resolveInit();
        return state;
      }

      state.gitRoot = eligibility.gitRoot;
      state.workspaceRelativePath = relative(eligibility.gitRoot, root) || ".";
      const commit = await createWorkingTreeSnapshot(eligibility.gitRoot, state.workspaceRelativePath);
      await git(eligibility.gitRoot, ["update-ref", state.openRef, commit]);
      await git(eligibility.gitRoot, ["update-ref", state.presentationRef, commit]);
      await git(eligibility.gitRoot, ["update-ref", state.legacyBaselineRef, commit]);
      // P1 #15: Clear diagnostic on success
      state.diagnostic = undefined;
      state.backend = new GitCheckpointBackend();
    } catch (error) {
      state.diagnostic = error instanceof Error ? error.message : String(error);
    } finally {
      resolveInit();
    }
    return state;
  }

  return {
    async initializeWorkspace({ workspaceId, root }) {
      await ensureInitialized(workspaceId, root);
    },

    async getSnapshotInfo({ workspaceId, root }) {
      const state = await ensureInitialized(workspaceId, root);
      return {
        kind: state.backend?.kind ?? "filesystem",
        available: Boolean(state.backend),
        diagnostic: state.diagnostic,
      };
    },

    async reviewChanges({ workspaceId, root, since = "last_shown", markReviewed = true, workSessionId }) {
      const state = await ensureInitialized(workspaceId, root);

      if (state.backend?.kind === "filesystem") {
        const baselines = state.filesystemBaselines!;
        const baseline = since === "workspace_open"
          ? baselines.open
          : since === "work_session" || since === "last_review"
            ? (workSessionId ? baselines.sessions.get(workSessionId) : undefined) ?? baselines.open
            : baselines.presentation;
        const current = await state.backend.capture(state.root);
        const diff = await state.backend.diff(state.root, baseline, current);
        if (markReviewed) {
          if (since === "work_session" || since === "last_review") {
            if (workSessionId) baselines.sessions.set(workSessionId, current);
          } else {
            baselines.presentation = current;
          }
          await getFsStore().saveBaselines(workspaceId, state.root, baselines);
        }
        return formatReviewResult(diff, current, since === "workspace_open" ? "workspace open" : "last shown changes");
      }

      if (!state?.gitRoot) {
        throw new Error(state?.diagnostic ?? "show_changes checkpoint backend unavailable.");
      }

      const baselineRef = await resolveBaselineRef(state, workspaceId, since, workSessionId);
      const baseline = (await git(state.gitRoot, ["rev-parse", "--verify", `${baselineRef}^{commit}`])).stdout.trim();
      const scope = state.workspaceRelativePath ?? ".";
      const current = await createWorkingTreeSnapshot(state.gitRoot, scope);
      const diffArgs = ["diff", "--binary", "--no-color", baseline, current, "--", scope];
      const patch = (await git(state.gitRoot, diffArgs, {
        maxBuffer: 50 * 1024 * 1024,
      })).stdout;
      const numstat = (await git(state.gitRoot, ["diff", "--numstat", "-z", baseline, current, "--", scope], {
        maxBuffer: 50 * 1024 * 1024,
      })).stdout;
      const files = parseNumstat(numstat);
      const summary = summarizeFiles(files);

      if (markReviewed) {
        await git(state.gitRoot, ["update-ref", checkpointRefForMark(state, workspaceId, since, workSessionId), current]);
      }

      return {
        result:
          summary.files === 0
            ? `No changes since ${since === "workspace_open" ? "workspace open" : "last shown changes"}.`
            : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`,
        summary,
        files,
        patch,
        snapshot: gitSnapshot(current),
        snapshotKind: "git" as const,
        snapshotRef: current,
        snapshotCommit: current,
      };
    },

    async reviewChangesAgainstSnapshot({ workspaceId, root, baseline }) {
      const state = await ensureInitialized(workspaceId, root);
      if (baseline.kind === "filesystem") {
        if (state.backend?.kind !== "filesystem") throw new Error("Filesystem snapshot cannot be compared with a Git workspace.");
        const current = await state.backend.capture(root);
        const diff = await state.backend.diff(root, baseline, current);
        return formatReviewResult(diff, current, "mission baseline");
      }
      return this.reviewChangesAgainstCommit({ workspaceId, root, baselineCommit: baseline.ref });
    },

    async reviewChangesAgainstCommit({ workspaceId, root, baselineCommit }) {
      const state = await ensureInitialized(workspaceId, root);
      if (!state?.gitRoot) {
        throw new Error(state?.diagnostic ?? "show_changes requires a Git workspace in this version.");
      }
      const baseline = (await git(state.gitRoot, ["rev-parse", "--verify", `${baselineCommit}^{commit}`])).stdout.trim();
      const scope = state.workspaceRelativePath ?? ".";
      const current = await createWorkingTreeSnapshot(state.gitRoot, scope);
      const patch = (await git(state.gitRoot, ["diff", "--binary", "--no-color", baseline, current, "--", scope], {
        maxBuffer: 50 * 1024 * 1024,
      })).stdout;
      const numstat = (await git(state.gitRoot, ["diff", "--numstat", "-z", baseline, current, "--", scope], {
        maxBuffer: 50 * 1024 * 1024,
      })).stdout;
      const files = parseNumstat(numstat);
      const summary = summarizeFiles(files);
      return {
        result:
          summary.files === 0
            ? "No changes since mission baseline."
            : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}) since mission baseline.`,
        summary,
        files,
        patch,
        snapshot: gitSnapshot(current),
        snapshotKind: "git" as const,
        snapshotRef: current,
        snapshotCommit: current,
      };
    },

    async assertSnapshotMatches({ workspaceId, root, expected }) {
      const state = await ensureInitialized(workspaceId, root);
      if (!state.backend || state.backend.kind !== expected.kind) return false;
      return state.backend.compare(root, expected);
    },

    async materializeSnapshot({ workspaceId, root, snapshot, destination }) {
      const state = await ensureInitialized(workspaceId, root);
      if (!state.backend?.materialize) throw new Error(`Snapshot backend ${snapshot.kind} cannot materialize this snapshot.`);
      await state.backend.materialize(snapshot, destination);
    },

    async assertTreeMatchesCommit({ workspaceId, root, baselineCommit }) {
      const state = await ensureInitialized(workspaceId, root);
      if (!state?.gitRoot) throw new Error(state?.diagnostic ?? "show_changes requires a Git workspace in this version.");
      const expectedTree = (await git(state.gitRoot, ["rev-parse", "--verify", `${baselineCommit}^{tree}`])).stdout.trim();
      const currentTree = await createWorkingTreeTree(state.gitRoot, state.workspaceRelativePath ?? ".");
      return currentTree === expectedTree;
    },

    async commitReviewed({ workspaceId, root, snapshotCommit, workSessionId }) {
      return this.commitReviewedSnapshot({ workspaceId, root, snapshot: gitSnapshot(snapshotCommit), workSessionId });
    },

    async commitReviewedSnapshot({ workspaceId, root, snapshot, workSessionId }) {
      const state = await ensureInitialized(workspaceId, root);
      if (snapshot.kind === "filesystem") {
        if (state.backend?.kind !== "filesystem") throw new Error("Filesystem snapshot cannot be committed to a Git workspace.");
        const baselines = state.filesystemBaselines!;
        if (workSessionId) baselines.sessions.set(workSessionId, snapshot);
        else baselines.presentation = snapshot;
        await getFsStore().saveBaselines(workspaceId, state.root, baselines);
        return;
      }
      if (!state?.gitRoot) {
        throw new Error(state?.diagnostic ?? "show_changes checkpoint backend unavailable.");
      }
      // Advance baseline to the EXACT captured snapshot (no recompute — the tree
      // may have changed between capture and persistence).
      await git(state.gitRoot, ["update-ref", sessionBaselineRef(workspaceId, workSessionId), snapshot.ref]);
    },

    async awaitWorkspaceReady({ workspaceId, root }) {
      const state = await ensureInitialized(workspaceId, root);
      // `ensureInitialized` already awaited the initialization promise; if the
      // state is permanently ineligible (not a git repo and not capturable),
      // there is nothing more to wait for.
      if (state.backend?.kind !== "filesystem") return;
      // Filesystem workspaces are ready once their baselines are saved.
      if (state.filesystemBaselines) return;
      await state.initialization;
    },

    async drain() {
      await getFsStore().close();
    },

    getSnapshotStore() {
      return getFsStore();
    },

    async releaseWorkSessionBaseline({ workspaceId, workSessionId }) {
      await getFsStore().releaseWorkSessionBaseline(workspaceId, workSessionId);
    },
  };
}

function gitSnapshot(ref: string): WorkspaceSnapshot {
  return { kind: "git", ref, createdAt: new Date().toISOString() };
}

interface FilesystemManifestEntry {
  path: string;
  type: "file" | "symlink";
  sha256: string;
  size: number;
  executable: boolean;
  target?: string;
}

interface FilesystemManifest {
  version: 1;
  entries: FilesystemManifestEntry[];
}

const FS_REF_PREFIX = "fs:sha256:";
const MAX_FS_DIFF_BYTES = 512 * 1024;
const MAX_FS_TEXT_BYTES = 128 * 1024;

/**
 * Content-addressed checkpoint backend for ordinary directories. It uses
 * lstat/readdir and never follows a workspace symlink, never initializes Git,
 * and never writes into the workspace itself.
 */
export class FilesystemCheckpointBackend implements CheckpointBackend {
  readonly kind = "filesystem" as const;
  /** The transactional store backing this backend. */
  readonly store: FilesystemSnapshotStore;

  constructor(options: { storeRoot?: string; store?: FilesystemSnapshotStore; limits?: FilesystemSnapshotLimits } = {}) {
    this.store = options.store ?? new FilesystemSnapshotStore({ storeRoot: options.storeRoot, limits: options.limits });
  }

  async capture(root: string, context?: { workSessionStatus?: string; createdAt?: string }): Promise<WorkspaceSnapshot> {
    return this.store.capture(root, context);
  }

  async diff(_root: string, baseline: WorkspaceSnapshot, current: WorkspaceSnapshot): Promise<Pick<ReviewChangesResult, "summary" | "files" | "patch">> {
    const before = await this.store.readManifest(baseline);
    const after = await this.store.readManifest(current);
    const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
    const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
    const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort();
    const files: ReviewFile[] = [];
    const patches: string[] = [];
    let patchBytes = 0;
    for (const path of paths) {
      const oldEntry = beforeByPath.get(path);
      const newEntry = afterByPath.get(path);
      if (oldEntry && newEntry && entriesEqual(oldEntry, newEntry)) continue;
      const oldBytes = oldEntry?.type === "file" ? await this.store.readBlobBuffer(oldEntry.sha256) : undefined;
      const newBytes = newEntry?.type === "file" ? await this.store.readBlobBuffer(newEntry.sha256) : undefined;
      const additions = newBytes ? countLines(newBytes) : 0;
      const removals = oldBytes ? countLines(oldBytes) : 0;
      files.push({ path, type: !oldEntry ? "new" : !newEntry ? "deleted" : "change", additions, removals });
      const rendered = renderFilesystemPatch(path, oldEntry, newEntry, oldBytes, newBytes);
      if (patchBytes < MAX_FS_DIFF_BYTES) {
        const remaining = MAX_FS_DIFF_BYTES - patchBytes;
        const bounded = Buffer.from(rendered, "utf8").subarray(0, remaining).toString("utf8");
        patches.push(bounded);
        patchBytes += Buffer.byteLength(bounded, "utf8");
      }
    }
    if (patchBytes >= MAX_FS_DIFF_BYTES) patches.push("\n[filesystem diff truncated at 512 KiB]\n");
    return { summary: summarizeFiles(files), files, patch: patches.join("") };
  }

  async compare(root: string, expected: WorkspaceSnapshot): Promise<boolean> {
    if (expected.kind !== "filesystem") return false;
    // Bound the comparison: capture the current tree and compare manifests
    // directly. Reuses the store's transactional capture so nothing is
    // leaked if the comparison is interrupted.
    try {
      const current = await this.store.capture(root);
      return current.ref === expected.ref;
    } catch {
      return false;
    }
  }

  async materialize(snapshot: WorkspaceSnapshot, destination: string): Promise<void> {
    const manifest = await this.store.readManifest(snapshot);
    const targetRoot = resolve(destination);
    await mkdir(targetRoot, { recursive: true, mode: 0o700 });
    for (const entry of manifest.entries) {
      const output = safeSnapshotPath(targetRoot, entry.path);
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      if (entry.type === "symlink") {
        await symlink(entry.target ?? "", output);
      } else {
        // Stream the blob out rather than forcing it through a whole-file Buffer.
        const buffer = await this.store.readBlobBuffer(entry.sha256);
        await writeFile(output, buffer, { mode: entry.executable ? 0o755 : 0o644 });
      }
    }
  }

  async loadBaselines(workspaceId: string): Promise<{ root: string; open: WorkspaceSnapshot; presentation: WorkspaceSnapshot; legacy: WorkspaceSnapshot; sessions: Record<string, WorkspaceSnapshot> } | undefined> {
    return this.store.loadBaselines(workspaceId);
  }

  async saveBaselines(workspaceId: string, root: string, baselines: { open: WorkspaceSnapshot; presentation: WorkspaceSnapshot; legacy: WorkspaceSnapshot; sessions: Map<string, WorkspaceSnapshot> }): Promise<void> {
    return this.store.saveBaselines(workspaceId, root, baselines);
  }

  /** Delegate to the transactional store; the commitReviewedSnapshot path uses this. */
  async validateSnapshot(snapshot: WorkspaceSnapshot): Promise<boolean> {
    return this.store.validateSnapshot(snapshot);
  }

  async releaseWorkSessionBaseline(workspaceId: string, workSessionId: string): Promise<void> {
    return this.store.releaseWorkSessionBaseline(workspaceId, workSessionId);
  }

  async pruneSessionBaselines(workspaceId: string, nonterminalIds: Set<string>): Promise<{ dropped: number }> {
    return this.store.pruneSessionBaselines(workspaceId, nonterminalIds);
  }
}

/** Git implementation kept behind the same backend contract for callers that
 * need to materialize or compare a submitted snapshot without naming commits. */
export class GitCheckpointBackend implements CheckpointBackend {
  readonly kind = "git" as const;

  async capture(root: string): Promise<WorkspaceSnapshot> {
    const eligibility = await getGitEligibility(root);
    if (!eligibility.ok || !eligibility.gitRoot) throw new Error(eligibility.message ?? "Git snapshot unavailable.");
    const scope = relative(eligibility.gitRoot, root) || ".";
    return gitSnapshot(await createWorkingTreeSnapshot(eligibility.gitRoot, scope));
  }

  async diff(root: string, baseline: WorkspaceSnapshot, current: WorkspaceSnapshot): Promise<Pick<ReviewChangesResult, "summary" | "files" | "patch">> {
    if (baseline.kind !== "git" || current.kind !== "git") throw new Error("Git backend requires Git snapshots.");
    const eligibility = await getGitEligibility(root);
    if (!eligibility.ok || !eligibility.gitRoot) throw new Error("Git snapshot unavailable.");
    const scope = relative(eligibility.gitRoot, root) || ".";
    const patch = (await git(eligibility.gitRoot, ["diff", "--binary", "--no-color", baseline.ref, current.ref, "--", scope], { maxBuffer: 50 * 1024 * 1024 })).stdout;
    const numstat = (await git(eligibility.gitRoot, ["diff", "--numstat", "-z", baseline.ref, current.ref, "--", scope], { maxBuffer: 50 * 1024 * 1024 })).stdout;
    const files = parseNumstat(numstat);
    return { summary: summarizeFiles(files), files, patch };
  }

  async compare(root: string, expected: WorkspaceSnapshot): Promise<boolean> {
    if (expected.kind !== "git") return false;
    const eligibility = await getGitEligibility(root);
    if (!eligibility.ok || !eligibility.gitRoot) return false;
    const expectedTree = (await git(eligibility.gitRoot, ["rev-parse", "--verify", `${expected.ref}^{tree}`])).stdout.trim();
    const currentTree = await createWorkingTreeTree(eligibility.gitRoot, relative(eligibility.gitRoot, root) || ".");
    return currentTree === expectedTree;
  }
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function entriesEqual(left: FilesystemManifestEntry, right: FilesystemManifestEntry): boolean {
  return left.type === right.type && left.sha256 === right.sha256 && left.size === right.size && left.executable === right.executable && left.target === right.target;
}

function countLines(value: Buffer): number {
  if (value.byteLength === 0) return 0;
  return value.toString("utf8").split("\n").length - (value[value.byteLength - 1] === 10 ? 1 : 0);
}

function isText(value: Buffer): boolean {
  return !value.subarray(0, Math.min(value.byteLength, MAX_FS_TEXT_BYTES)).includes(0);
}

function renderFilesystemPatch(path: string, oldEntry: FilesystemManifestEntry | undefined, newEntry: FilesystemManifestEntry | undefined, oldBytes: Buffer | undefined, newBytes: Buffer | undefined): string {
  if (oldEntry?.type === "symlink" || newEntry?.type === "symlink") {
    return `--- a/${path}\n+++ b/${path}\n@@ symlink target changed @@\n- ${oldEntry?.target ?? ""}\n+ ${newEntry?.target ?? ""}\n`;
  }
  const oldContent = oldBytes ?? Buffer.alloc(0);
  const newContent = newBytes ?? Buffer.alloc(0);
  if ((oldBytes && !isText(oldBytes)) || (newBytes && !isText(newBytes))) return `Binary files a/${path} and b/${path} differ\n`;
  const oldText = oldContent.byteLength > MAX_FS_TEXT_BYTES ? `${oldContent.subarray(0, MAX_FS_TEXT_BYTES).toString("utf8")}\n[old file truncated]\n` : oldContent.toString("utf8");
  const newText = newContent.byteLength > MAX_FS_TEXT_BYTES ? `${newContent.subarray(0, MAX_FS_TEXT_BYTES).toString("utf8")}\n[new file truncated]\n` : newContent.toString("utf8");
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  return `--- a/${path}\n+++ b/${path}\n@@\n${oldLines.map((line) => `-${line}`).join("\n")}\n${newLines.map((line) => `+${line}`).join("\n")}\n`;
}

function formatReviewResult(diff: Pick<ReviewChangesResult, "summary" | "files" | "patch">, current: WorkspaceSnapshot, baselineLabel: string): ReviewChangesResult {
  return {
    result: diff.summary.files === 0
      ? `No changes since ${baselineLabel}.`
      : `Changed ${diff.summary.files} ${diff.summary.files === 1 ? "file" : "files"} (+${diff.summary.additions} -${diff.summary.removals}) since ${baselineLabel}.`,
    ...diff,
    snapshot: current,
    snapshotKind: current.kind,
    snapshotRef: current.ref,
    snapshotCommit: current.ref,
  };
}

function safeSnapshotPath(root: string, path: string): string {
  const output = resolve(root, path);
  if (output !== root && !output.startsWith(`${root}${sep}`)) throw new Error(`Snapshot path escapes materialization root: ${path}`);
  return output;
}

function reviewRefs(workspaceId: string): Pick<WorkspaceReviewState, "openRef" | "presentationRef" | "legacyBaselineRef"> {
  const segment = safeWorkspaceRefSegment(workspaceId);
  return {
    openRef: `${REVIEW_REF_PREFIX}/${segment}/open`,
    presentationRef: `refs/kontrol/presentation/${segment}/last-shown`,
    legacyBaselineRef: `${REVIEW_REF_PREFIX}/${segment}/baseline`,
  };
}

async function resolveBaselineRef(
  state: WorkspaceReviewState,
  workspaceId: string,
  since: ReviewSince,
  workSessionId: string | undefined,
): Promise<string> {
  if (since === "workspace_open") return state.openRef;
  if (since === "work_session" || since === "last_review") {
    const ref = sessionBaselineRef(workspaceId, workSessionId);
    await ensureRef(state.gitRoot!, ref, state.openRef);
    return ref;
  }
  return state.presentationRef;
}

function checkpointRefForMark(
  state: WorkspaceReviewState,
  workspaceId: string,
  since: ReviewSince,
  workSessionId: string | undefined,
): string {
  if (since === "work_session" || since === "last_review") return sessionBaselineRef(workspaceId, workSessionId);
  return state.presentationRef;
}

function sessionBaselineRef(workspaceId: string, workSessionId: string | undefined): string {
  const workspaceSegment = safeWorkspaceRefSegment(workspaceId);
  const sessionSegment = workSessionId ? safeWorkspaceRefSegment(workSessionId) : "_legacy";
  return `refs/kontrol/session/${workspaceSegment}/${sessionSegment}/baseline`;
}

async function ensureRef(gitRoot: string, ref: string, fallbackRef: string): Promise<void> {
  try {
    await git(gitRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return;
  } catch {
    const fallback = (await git(gitRoot, ["rev-parse", "--verify", `${fallbackRef}^{commit}`])).stdout.trim();
    await git(gitRoot, ["update-ref", ref, fallback]);
  }
}

async function createWorkingTreeSnapshot(gitRoot: string, workspaceRelativePath = "."): Promise<string> {
  const tree = await createWorkingTreeTree(gitRoot, workspaceRelativePath);
  const parent = (await git(gitRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  const tempDir = await mkdtemp(join(tmpdir(), "kontrol-review-index-"));
  const indexPath = join(tempDir, "index");
  const env = checkpointEnv(indexPath);

  try {
    return (await git(gitRoot, ["commit-tree", tree, "-p", parent, "-m", "Kontrol review snapshot"], { env })).stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function createWorkingTreeTree(gitRoot: string, workspaceRelativePath = "."): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "kontrol-review-index-"));
  const indexPath = join(tempDir, "index");
  const env = checkpointEnv(indexPath);

  try {
    await git(gitRoot, ["read-tree", "HEAD"], { env });
    await git(gitRoot, ["add", "-A", "--", workspaceRelativePath], { env });
    return (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function checkpointEnv(indexPath: string): NodeJS.ProcessEnv {
  return {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "Kontrol",
    GIT_AUTHOR_EMAIL: "kontrol@users.noreply.local",
    GIT_COMMITTER_NAME: "Kontrol",
    GIT_COMMITTER_EMAIL: "kontrol@users.noreply.local",
  };
}

function parseNumstat(output: string): ReviewFile[] {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const files: ReviewFile[] = [];

  for (let index = 0; index < fields.length;) {
    const header = fields[index++] ?? "";
    const parts = header.split("\t");
    const additions = parseStatNumber(parts[0]);
    const removals = parseStatNumber(parts[1]);

    if (parts.length >= 3) {
      const path = parts[2] ?? "";
      if (path) files.push({ path, type: fileType(path, undefined, additions, removals), additions, removals });
      continue;
    }

    const previousPath = fields[index++];
    const path = fields[index++];
    if (!path) continue;

    files.push({
      path,
      previousPath,
      type: fileType(path, previousPath, additions, removals),
      additions,
      removals,
    });
  }

  return files;
}

function parseStatNumber(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileType(
  path: string,
  previousPath: string | undefined,
  additions: number,
  removals: number,
): ReviewFile["type"] {
  if (previousPath) return additions === 0 && removals === 0 ? "rename-pure" : "rename-changed";
  if (additions > 0 && removals === 0) return "new";
  if (additions === 0 && removals > 0) return "deleted";
  return "change";
}

function summarizeFiles(files: ReviewFile[]): ReviewSummary {
  return files.reduce<ReviewSummary>(
    (summary, file) => ({
      files: summary.files + 1,
      additions: summary.additions + file.additions,
      removals: summary.removals + file.removals,
    }),
    { files: 0, additions: 0, removals: 0 },
  );
}
