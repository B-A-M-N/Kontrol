import { randomUUID } from "node:crypto";
import type { ManagedWorktreeCursor, WorkspaceMode, WorkspaceSession, WorkspaceStore } from "./workspace-store.js";
import { realpath, readFile, stat } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ServerConfig } from "./config.js";
import {
  createManagedWorktree,
  inspectManagedWorktree,
  removeCleanManagedWorktree,
  resolveManagedWorktreeSourceRoot,
} from "./git-worktrees.js";
import { assertAllowedPath, assertNoSymlinkComponentsSync, isPathInsideRoot, resolveAllowedPath, resolveAllowedPathCanonical } from "./roots.js";
import {
  loadProjectLocalSkills,
  loadSkillIndex,
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  formatPathForPrompt,
  type LoadedSkills,
  type SkillReadResolution,
} from "./skills.js";

export interface LoadedAgentsFile {
  path: string;
  content: string;
}

export interface AvailableAgentsFile {
  path: string;
}

export interface WorkspaceWorktree {
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface Workspace {
  id: string;
  projectId?: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
  skills: LoadedSkills["skills"];
  skillDiagnostics: LoadedSkills["diagnostics"];
}

/** Conversation-sensitive state is owned by one MCP transport, not the shared project record. */
export interface WorkspaceSessionState {
  activatedSkillDirs: Set<string>;
  /** Instructions loaded by this transport, keyed by canonical file path. */
  loadedAgentsFiles: Map<string, LoadedAgentsFile>;
  currentWorkSessionId?: string;
}

const DEFAULT_WORKSPACE_SESSION_ID = "default";

export interface WorkspaceContext {
  workspace: Workspace;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
}

export interface WorkspaceReadPath {
  absolutePath: string;
  readRoots: string[];
  skillRead?: SkillReadResolution;
}

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  /** P0 #5: canonical root → workspace ID, so the same repo reuses its identity. */
  private readonly canonicalRootToId = new Map<string, string>();
  private readonly sessionStates = new Map<string, Map<string, WorkspaceSessionState>>();
  private readonly pendingWorktreeCreationsByProject = new Map<string, number>();
  private pendingWorktreeCreations = 0;
  private managedWorktreeGcCursor?: { retiredAt: string; id: string };

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {}

  async openWorkspace(input: string | OpenWorkspaceInput, sessionId = DEFAULT_WORKSPACE_SESSION_ID): Promise<WorkspaceContext> {
    const options = typeof input === "string" ? { path: input } : input;
    const mode = options.mode ?? "checkout";

    if (mode === "worktree") {
      return this.openWorktreeWorkspace(options.path, options.baseRef, sessionId);
    }

    return this.openCheckoutWorkspace(options.path, sessionId);
  }

  /** Reattach one already persisted workspace to the caller's transport state. */
  async openExistingWorkspace(workspaceId: string, sessionId = DEFAULT_WORKSPACE_SESSION_ID): Promise<WorkspaceContext> {
    const workspace = this.getWorkspace(workspaceId);
    const state = this.getOrCreateSessionState(workspace, sessionId);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, [...state.loadedAgentsFiles.values()]);
    return { workspace, agentsFiles: [...state.loadedAgentsFiles.values()], availableAgentsFiles };
  }

  getWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      const persisted = this.store?.getSession(workspaceId);
      if (persisted && persisted.status !== "active") {
        throw new Error(`Workspace ${workspaceId} is ${persisted.status} and can no longer be opened.`);
      }
      this.store?.touchSession(workspaceId);
      return workspace;
    }

    const session = this.store?.getSession(workspaceId);
    if (!session) {
      throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    }
    if (session.status !== "active") {
      throw new Error(`Workspace ${workspaceId} is ${session.status} and can no longer be opened.`);
    }

    const root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
    const restoredWorkspace: Workspace = {
      id: session.id,
      projectId: session.projectId,
      root,
      mode: session.mode,
      sourceRoot: session.sourceRoot,
      worktree:
        session.mode === "worktree"
          ? {
              path: root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha ?? "",
              dirtySource: false,
              detached: true,
              managed: session.managed,
            }
          : undefined,
      ...this.loadSkillsForWorkspace(root),
    };
    this.store?.touchSession(workspaceId);
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);

    return restoredWorkspace;
  }

  private getOrCreateSessionState(workspace: Workspace, sessionId: string): WorkspaceSessionState {
    let byWorkspace = this.sessionStates.get(sessionId);
    if (!byWorkspace) {
      byWorkspace = new Map();
      this.sessionStates.set(sessionId, byWorkspace);
    }
    let state = byWorkspace.get(workspace.id);
    if (!state) {
      state = {
        activatedSkillDirs: new Set(),
        loadedAgentsFiles: new Map(),
      };
      for (const file of this.loadInitialAgentsFiles(workspace.root)) state.loadedAgentsFiles.set(file.path, file);
      byWorkspace.set(workspace.id, state);
    }
    return state;
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
    if (!isPathInsideRoot(absolutePath, workspace.root)) {
      throw new Error(`Path is outside workspace root: ${inputPath}`);
    }
    assertNoSymlinkComponentsSync(absolutePath);

    return absolutePath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string, sessionId = DEFAULT_WORKSPACE_SESSION_ID): WorkspaceReadPath {
    try {
      return {
        absolutePath: this.resolvePath(workspace, inputPath),
        readRoots: [workspace.root],
      };
    } catch (workspaceError) {
      const skillRead = resolveSkillReadPath(
        workspace.skills,
        this.getOrCreateSessionState(workspace, sessionId).activatedSkillDirs,
        inputPath,
      );
      if (!skillRead) throw workspaceError;

      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        skillRead,
      };
    }
  }

  /**
   * Load only instructions applicable to a requested path. This deliberately
   * walks ancestors from the workspace root to the target directory; it never
   * scans descendants looking for AGENTS.md/CLAUDE.md files.
   */
  async loadApplicableInstructions(workspace: Workspace, inputPath: string, sessionId = DEFAULT_WORKSPACE_SESSION_ID): Promise<LoadedAgentsFile[]> {
    const resolved = await resolveAllowedPathCanonical(inputPath, workspace.root, [workspace.root]);
    let directory = resolved;
    try {
      if (!(await stat(resolved)).isDirectory()) directory = dirname(resolved);
    } catch {
      directory = dirname(resolved);
    }

    const ancestors: string[] = [];
    let current = resolve(directory);
    const root = resolve(workspace.root);
    while (isPathInsideRoot(current, root)) {
      ancestors.unshift(current);
      if (current === root) break;
      const parent = resolve(current, "..");
      if (parent === current) break;
      current = parent;
    }

    const sessionState = this.getOrCreateSessionState(workspace, sessionId);
    const newlyLoaded: LoadedAgentsFile[] = [];
    for (const ancestor of ancestors) {
      for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
        const filePath = resolve(ancestor, filename);
        if (sessionState.loadedAgentsFiles.has(filePath)) continue;
        try {
          const content = await readFile(filePath, "utf8");
          const file = { path: filePath, content };
          newlyLoaded.push(file);
          break;
        } catch {
          // Missing or unreadable instruction file: continue to the next name
          // or ancestor. The direct file operation will report real read errors.
        }
      }
    }
    return newlyLoaded;
  }

  /** Mark discovered instructions as delivered only after the owning tool succeeds. */
  acknowledgeApplicableInstructions(
    workspace: Workspace,
    files: LoadedAgentsFile[],
    sessionId = DEFAULT_WORKSPACE_SESSION_ID,
  ): void {
    if (files.length === 0) return;
    const state = this.getOrCreateSessionState(workspace, sessionId);
    for (const file of files) state.loadedAgentsFiles.set(file.path, file);
  }

  getLoadedAgentsFiles(workspace: Workspace, sessionId = DEFAULT_WORKSPACE_SESSION_ID): LoadedAgentsFile[] {
    return [...this.getOrCreateSessionState(workspace, sessionId).loadedAgentsFiles.values()];
  }

  setActiveSession(workspaceId: string, sessionId: string | undefined, mcpSessionId = DEFAULT_WORKSPACE_SESSION_ID): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    this.getOrCreateSessionState(workspace, mcpSessionId).currentWorkSessionId = sessionId;
  }

  getCurrentWorkSessionId(workspaceId: string, mcpSessionId = DEFAULT_WORKSPACE_SESSION_ID): string | undefined {
    const workspace = this.workspaces.get(workspaceId);
    return workspace ? this.getOrCreateSessionState(workspace, mcpSessionId).currentWorkSessionId : undefined;
  }

  markReadPathLoaded(workspace: Workspace, readPath: WorkspaceReadPath, sessionId = DEFAULT_WORKSPACE_SESSION_ID): void {
    if (readPath.skillRead?.isSkillFile) {
      markSkillActivated(this.getOrCreateSessionState(workspace, sessionId).activatedSkillDirs, readPath.skillRead.skill);
    }
  }

  getSessionState(workspace: Workspace, sessionId = DEFAULT_WORKSPACE_SESSION_ID): WorkspaceSessionState {
    return this.getOrCreateSessionState(workspace, sessionId);
  }

  clearSessionState(sessionId: string): void {
    this.sessionStates.delete(sessionId);
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    const directory = workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;
    return assertAllowedPath(directory, [workspace.root]);
  }

  private async openCheckoutWorkspace(path: string, sessionId = DEFAULT_WORKSPACE_SESSION_ID): Promise<WorkspaceContext> {
    const root = assertAllowedPath(path, this.config.allowedRoots);

    // P0 #6: checkout mode must never create the requested project directory.
    // Use realpath + stat to fail closed if it doesn't exist.
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(root);
    } catch {
      throw new Error(`Workspace does not exist: ${path}`);
    }
    const rootStats = await stat(resolvedRoot);
    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root must be a directory: ${resolvedRoot}`);
    }

    // P0 #5b: Re-validate the canonical (realpath) result against allowlist.
    // A symlink at the original path could resolve to an unallowed target.
    const canonicalAllowedRoots = await Promise.all(
      this.config.allowedRoots.map(async (r) => {
        try { return await realpath(r); } catch { return r; }
      })
    );
    const canonicalRoot = assertAllowedPath(resolvedRoot, canonicalAllowedRoots);

    // P0 #5: Canonicalize and reuse workspace identity by canonical root.
    // First check the DB for an existing workspace (durable across restarts).
    const canonicalKey = canonicalRoot;
    const existingId = this.canonicalRootToId.get(canonicalKey);
    if (existingId) {
      const session = this.store?.getSession(existingId);
      if (!this.store || session?.status === "active") {
        const existing = this.workspaces.get(existingId);
        if (existing) {
          this.store?.touchSession(existingId);
          const state = this.getOrCreateSessionState(existing, sessionId);
          const availableAgentsFiles = await this.findAvailableAgentsFiles(existing.root, [...state.loadedAgentsFiles.values()]);
          return { workspace: existing, agentsFiles: [...state.loadedAgentsFiles.values()], availableAgentsFiles };
        }
        if (session?.status === "active") {
          // Stale in-memory entry but DB record exists — restore it.
          const restored = await this.restoreWorkspaceFromSession(session);
          const state = this.getOrCreateSessionState(restored, sessionId);
          const availableAgentsFiles = await this.findAvailableAgentsFiles(restored.root, [...state.loadedAgentsFiles.values()]);
          return { workspace: restored, agentsFiles: [...state.loadedAgentsFiles.values()], availableAgentsFiles };
        }
      }
      this.canonicalRootToId.delete(canonicalKey);
      this.workspaces.delete(existingId);
    }

    // P0 #4: Check DB for existing workspace with this canonical root (restart-durable).
    if (this.store) {
      const dbExisting = this.store.getLatestByCanonicalRoot(canonicalKey, "checkout");
      if (dbExisting) {
        const restored = await this.restoreWorkspaceFromSession(dbExisting);
        const state = this.getOrCreateSessionState(restored, sessionId);
        const availableAgentsFiles = await this.findAvailableAgentsFiles(restored.root, [...state.loadedAgentsFiles.values()]);
        return { workspace: restored, agentsFiles: [...state.loadedAgentsFiles.values()], availableAgentsFiles };
      }
    }

    return this.createWorkspaceContext({ root: resolvedRoot, mode: "checkout" }, sessionId);
  }

  private async openWorktreeWorkspace(path: string, baseRef: string | undefined, sessionId = DEFAULT_WORKSPACE_SESSION_ID): Promise<WorkspaceContext> {
    const sourceRoot = await resolveManagedWorktreeSourceRoot(path, this.config);
    const projectCount = this.store?.countManagedWorktrees(sourceRoot) ?? 0;
    const pendingForProject = this.pendingWorktreeCreationsByProject.get(sourceRoot) ?? 0;
    const globalCount = this.store?.countManagedWorktrees() ?? 0;
    if (projectCount + pendingForProject >= this.config.managedWorktreeProjectLimit) {
      throw new Error(`Managed worktree project limit reached (${this.config.managedWorktreeProjectLimit}) for ${sourceRoot}. Retire a managed worktree first.`);
    }
    if (globalCount + this.pendingWorktreeCreations >= this.config.managedWorktreeGlobalLimit) {
      throw new Error(`Managed worktree global limit reached (${this.config.managedWorktreeGlobalLimit}). Retire a managed worktree first.`);
    }
    this.pendingWorktreeCreations++;
    this.pendingWorktreeCreationsByProject.set(sourceRoot, pendingForProject + 1);
    try {
      const worktree = await createManagedWorktree({
        sourcePath: sourceRoot,
        baseRef,
        config: this.config,
      });
      return await this.createWorkspaceContext({
        root: worktree.path,
        mode: "worktree",
        sourceRoot: worktree.sourceRoot,
        worktree,
      }, sessionId);
    } finally {
      this.pendingWorktreeCreations--;
      const next = (this.pendingWorktreeCreationsByProject.get(sourceRoot) ?? 1) - 1;
      if (next <= 0) this.pendingWorktreeCreationsByProject.delete(sourceRoot);
      else this.pendingWorktreeCreationsByProject.set(sourceRoot, next);
    }
  }

  retireManagedWorktree(workspaceId: string, runningProcesses: number): {
    retired: boolean;
    blockers?: { workSessions: number; pendingReviews: number; pendingApprovals: number; runningProcesses?: number };
    session?: WorkspaceSession;
  } {
    if (!this.store) throw new Error("Workspace persistence is unavailable.");
    const session = this.store.getSession(workspaceId);
    if (!session || session.mode !== "worktree" || !session.managed) {
      throw new Error(`Workspace ${workspaceId} is not a managed worktree.`);
    }
    if (session.status !== "active") return { retired: false, session };
    const result = this.store.retireManagedWorktree(workspaceId, runningProcesses);
    if (result.retired) {
      this.workspaces.delete(workspaceId);
      this.canonicalRootToId.delete(session.root);
      for (const state of this.sessionStates.values()) state.delete(workspaceId);
    }
    return result;
  }

  async listManagedWorktrees(before?: ManagedWorktreeCursor): Promise<{ worktrees: Array<Record<string, unknown>>; nextCursor?: ManagedWorktreeCursor }> {
    if (!this.store) return { worktrees: [] };
    const page = this.store.listManagedWorktrees({ limit: 32, before });
    const rows = page.worktrees;
    const result: Array<Record<string, unknown>> = [];
    // At most four Git inspection subprocess groups run concurrently. The
    // configured global cap bounds the complete listing to 32 records.
    for (let offset = 0; offset < rows.length; offset += 4) {
      const batch = rows.slice(offset, offset + 4);
      result.push(...await Promise.all(batch.map(async (session) => {
        let disposition: Awaited<ReturnType<typeof inspectManagedWorktree>> | undefined;
        let inspectionError: string | undefined;
        try {
          disposition = await inspectManagedWorktree({
            sourceRoot: session.sourceRoot ?? "",
            path: session.root,
            baseSha: session.baseSha ?? "",
            config: this.config,
          });
        } catch (error) {
          inspectionError = error instanceof Error ? error.message : String(error);
        }
        const needsDisposition = session.status === "retired" && disposition?.cleanToBase !== true;
        return {
          workspaceId: session.id,
          projectId: session.projectId,
          sourceRoot: session.sourceRoot,
          path: session.root,
          baseSha: session.baseSha,
          status: session.status,
          retiredAt: session.retiredAt,
          cleanToBase: disposition?.cleanToBase ?? false,
          dispositionRequired: needsDisposition,
          dispositionReason: disposition?.reason ?? inspectionError,
        };
      })));
    }
    return { worktrees: result, nextCursor: page.nextCursor };
  }

  async collectRetiredManagedWorktrees(runningProcessCount: (workspaceId: string) => number, now = Date.now()): Promise<{ removed: number; retained: number; failed: number }> {
    if (!this.store) return { removed: 0, retained: 0, failed: 0 };
    let removed = 0;
    let retained = 0;
    let failed = 0;
    const retiredBefore = new Date(now - this.config.managedWorktreeRetentionMs).toISOString();
    const [session] = this.store.listExpiredRetiredManagedWorktrees(retiredBefore, this.managedWorktreeGcCursor, 1);
    if (!session?.retiredAt) {
      this.managedWorktreeGcCursor = undefined;
      return { removed, retained, failed };
    }
    this.managedWorktreeGcCursor = { retiredAt: session.retiredAt, id: session.id };
    if (runningProcessCount(session.id) > 0 || !this.store.canRemoveRetiredManagedWorktree(session.id)) {
      retained++;
      return { removed, retained, failed };
    }
    try {
      const disposition = await inspectManagedWorktree({
        sourceRoot: session.sourceRoot ?? "",
        path: session.root,
        baseSha: session.baseSha ?? "",
        config: this.config,
      });
      if (!disposition.pathExists && !disposition.registered) {
        if (this.store.markManagedWorktreeRemoved(session.id)) removed++;
        else retained++;
        return { removed, retained, failed };
      }
      if (!disposition.cleanToBase) {
        retained++;
        return { removed, retained, failed };
      }
      await removeCleanManagedWorktree({
        sourceRoot: session.sourceRoot!,
        path: session.root,
        baseSha: session.baseSha!,
        config: this.config,
      });
      if (this.store.markManagedWorktreeRemoved(session.id)) removed++;
      else failed++;
    } catch {
      failed++;
    }
    return { removed, retained, failed };
  }

  private async restoreWorkspaceFromSession(session: {
    id: string;
    projectId?: string;
    root: string;
    mode: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed: boolean;
  }): Promise<Workspace> {
    const workspace: Workspace = {
      id: session.id,
      projectId: session.projectId,
      root: session.root,
      mode: session.mode,
      sourceRoot: session.sourceRoot,
      worktree:
        session.mode === "worktree"
          ? {
              path: session.root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha ?? "",
              dirtySource: false,
              detached: true,
              managed: session.managed,
            }
          : undefined,
      ...this.loadSkillsForWorkspace(session.root),
    };
    this.workspaces.set(workspace.id, workspace);
    const canonicalKey = session.root;
    this.canonicalRootToId.set(canonicalKey, workspace.id);
    return workspace;
  }

  private async createWorkspaceContext(input: {
    root: string;
    mode: WorkspaceMode;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
  }, sessionId = DEFAULT_WORKSPACE_SESSION_ID): Promise<WorkspaceContext> {
    const workspace: Workspace = {
      id: `ws_${randomUUID()}`,
      root: input.root,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
      ...this.loadSkillsForWorkspace(input.root),
    };

    this.store?.createSession({
      id: workspace.id,
      root: workspace.root,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      baseRef: workspace.worktree?.baseRef,
      baseSha: workspace.worktree?.baseSha,
      managed: workspace.worktree?.managed,
    });
    const persisted = this.store?.getSession(workspace.id);
    workspace.projectId = persisted?.projectId;
    this.workspaces.set(workspace.id, workspace);
    // P0 #5: register canonical root mapping.
    this.canonicalRootToId.set(input.root, workspace.id);

    const sessionState = this.getOrCreateSessionState(workspace, sessionId);
    // Nested instruction discovery is lazy and path-scoped. Keep this field in
    // the protocol for compatibility, but never recursively enumerate a repo.
    const availableAgentsFiles: AvailableAgentsFile[] = [];

    return { workspace, agentsFiles: [...sessionState.loadedAgentsFiles.values()], availableAgentsFiles };
  }

  private loadSkillsForWorkspace(root: string): Pick<Workspace, "skills" | "skillDiagnostics"> {
    // P1 #10: Only load project-local skills on open. Global skills are
    // available via the search_skills tool to reduce model context.
    const result = loadProjectLocalSkills(this.config, root);
    return {
      skills: result.skills,
      skillDiagnostics: result.diagnostics,
    };
  }

  private assertWorkspaceRootAllowed(root: string, mode: WorkspaceMode, sourceRoot: string | undefined): string {
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync(root);
    } catch {
      throw new Error(`Persisted workspace no longer exists: ${root}`);
    }
    if (canonicalRoot !== resolve(root)) {
      throw new Error(`Persisted workspace identity changed; refusing to reopen through a symlink: ${root}`);
    }

    if (mode === "worktree") {
      if (!sourceRoot) {
        throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
      }
      let canonicalSource: string;
      try { canonicalSource = realpathSync(sourceRoot); } catch { throw new Error(`Persisted worktree source no longer exists: ${sourceRoot}`); }
      if (canonicalSource !== resolve(sourceRoot)) {
        throw new Error(`Persisted worktree source identity changed: ${sourceRoot}`);
      }
      const canonicalAllowedRoots = this.config.allowedRoots.map((allowed) => {
        try { return realpathSync(allowed); } catch { return resolve(allowed); }
      });
      assertAllowedPath(canonicalSource, canonicalAllowedRoots);
      let canonicalWorktreeRoot: string;
      try { canonicalWorktreeRoot = realpathSync(this.config.worktreeRoot); } catch { canonicalWorktreeRoot = resolve(this.config.worktreeRoot); }
      return assertAllowedPath(canonicalRoot, [canonicalWorktreeRoot]);
    }

    const canonicalAllowedRoots = this.config.allowedRoots.map((allowed) => {
      try { return realpathSync(allowed); } catch { return resolve(allowed); }
    });
    return assertAllowedPath(canonicalRoot, canonicalAllowedRoots);
  }

  private loadInitialAgentsFiles(root: string): LoadedAgentsFile[] {
    const agentDir = resolve(this.config.agentDir);

    return loadProjectContextFiles({ cwd: root, agentDir })
      .filter((file: { path: string }) => {
        const path = resolve(file.path);
        if (isPathInsideRoot(path, agentDir)) return true;
        return isPathInsideRoot(path, root) && dirname(path) === root;
      })
      .map((file: { path: string; content: string }) => ({
        path: resolve(file.path),
        content: file.content,
      }));
  }

  private async findAvailableAgentsFiles(
    root: string,
    loadedFiles: LoadedAgentsFile[],
  ): Promise<AvailableAgentsFile[]> {
    void root;
    void loadedFiles;
    return [];
  }

  /** P2 #53: Observability for context file discovery. Always zero for lazy discovery. */
  lastScanMs = 0;

  /** @deprecated Use findAvailableAgentsFiles() — caching is internal. */
  async findAvailableAgentsFilesCached(root: string, loadedFiles: LoadedAgentsFile[]): Promise<AvailableAgentsFile[]> {
    return this.findAvailableAgentsFiles(root, loadedFiles);
  }
}

const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

export function formatAgentsPath(path: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return path.split(sep).join("/");

  const relationship = relative(workspaceRoot, path);
  if (
    relationship === "" ||
    relationship.startsWith("..") ||
    relationship === ".." ||
    relationship.includes(`..${sep}`)
  ) {
    return path.split(sep).join("/");
  }

  return relationship.split(sep).join("/");
}

/**
 * Load AGENTS.md / CLAUDE.md context files from the agent directory and all
 * ancestors of the working directory up to the filesystem root.
 *
 * Inlined from the now-unavailable @earendel-works/pi-coding-agent package.
 */
function loadProjectContextFiles(options: { cwd?: string; agentDir?: string } = {}): Array<{ path: string; content: string }> {
  const resolvedCwd = options.cwd ?? process.cwd();
  const resolvedAgentDir = options.agentDir;

  const contextFiles: Array<{ path: string; content: string }> = [];
  const seenPaths = new Set<string>();

  // Global context from agent directory.
  if (resolvedAgentDir) {
    const globalFile = loadContextFileFromPath(resolvedAgentDir);
    if (globalFile) {
      contextFiles.push(globalFile);
      seenPaths.add(globalFile.path);
    }
  }

  // Walk ancestors of cwd up to the root.
  const ancestorContextFiles: Array<{ path: string; content: string }> = [];
  let currentDir = resolve(resolvedCwd);
  const root = resolve("/");

  while (true) {
    const contextFile = loadContextFileFromPath(currentDir);
    if (contextFile && !seenPaths.has(contextFile.path)) {
      ancestorContextFiles.unshift(contextFile);
      seenPaths.add(contextFile.path);
    }
    if (currentDir === root) break;
    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  contextFiles.push(...ancestorContextFiles);
  return contextFiles;
}

function loadContextFileFromPath(dir: string): { path: string; content: string } | null {
  const candidates = ["AGENTS.md", "CLAUDE.md"];
  for (const filename of candidates) {
    const filePath = join(dir, filename);
    try {
      const content = readFileSync(filePath, "utf-8");
      return { path: filePath, content };
    } catch {
      // file doesn't exist or unreadable — try next candidate
    }
  }
  return null;
}
