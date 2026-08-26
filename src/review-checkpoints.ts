import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { git, getGitEligibility, safeWorkspaceRefSegment } from "./git.js";

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

export interface ReviewChangesResult {
  result: string;
  summary: ReviewSummary;
  files: ReviewFile[];
  patch: string;
  /** The exact working-tree snapshot commit this diff was computed against. */
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
  /** Cheap exact-tree binding check for verifiers; does not build a diff. */
  assertTreeMatchesCommit(input: { workspaceId: string; root: string; baselineCommit: string }): Promise<boolean>;
  /**
   * Commit the review checkpoint to an exact previously-captured snapshot.
   * Advances baselineRef to `snapshotCommit` WITHOUT recomputing the working
   * tree (which may have changed since capture). Call only after the review
   * submission was persisted, so a failure cannot silently drop the diff.
   */
  commitReviewed(input: { workspaceId: string; root: string; snapshotCommit: string; workSessionId?: string }): Promise<void>;
}

const REVIEW_REF_PREFIX = "refs/kontrol/review";

export function createReviewCheckpointManager(): ReviewCheckpointManager {
  const states = new Map<string, WorkspaceReviewStateWithInit>();

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
        state.diagnostic = eligibility.message ?? "show_changes requires a Git workspace in this version.";
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

    async reviewChanges({ workspaceId, root, since = "last_shown", markReviewed = true, workSessionId }) {
      const state = await ensureInitialized(workspaceId, root);

      if (!state?.gitRoot) {
        throw new Error(state?.diagnostic ?? "show_changes requires a Git workspace in this version.");
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
        snapshotCommit: current,
      };
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
        snapshotCommit: current,
      };
    },

    async assertTreeMatchesCommit({ workspaceId, root, baselineCommit }) {
      const state = await ensureInitialized(workspaceId, root);
      if (!state?.gitRoot) throw new Error(state?.diagnostic ?? "show_changes requires a Git workspace in this version.");
      const expectedTree = (await git(state.gitRoot, ["rev-parse", "--verify", `${baselineCommit}^{tree}`])).stdout.trim();
      const currentTree = await createWorkingTreeTree(state.gitRoot, state.workspaceRelativePath ?? ".");
      return currentTree === expectedTree;
    },

    async commitReviewed({ workspaceId, root, snapshotCommit, workSessionId }) {
      const state = await ensureInitialized(workspaceId, root);
      if (!state?.gitRoot) {
        throw new Error(state?.diagnostic ?? "show_changes requires a Git workspace in this version.");
      }
      // Advance baseline to the EXACT captured snapshot (no recompute — the tree
      // may have changed between capture and persistence).
      await git(state.gitRoot, ["update-ref", sessionBaselineRef(workspaceId, workSessionId), snapshotCommit]);
    },
  };
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
