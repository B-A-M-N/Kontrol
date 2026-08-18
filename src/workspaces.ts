import { randomUUID } from "node:crypto";
import type { WorkspaceMode, WorkspaceStore } from "./workspace-store.js";
import { realpath, readFile, stat } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ServerConfig } from "./config.js";
import { createManagedWorktree } from "./git-worktrees.js";
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
  activatedSkillDirs: Set<string>;
  /** Instructions loaded for this workspace, keyed by canonical file path. */
  loadedAgentsFiles: Map<string, LoadedAgentsFile>;
  currentWorkSessionId?: string;
}

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

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {}

  async openWorkspace(input: string | OpenWorkspaceInput): Promise<WorkspaceContext> {
    const options = typeof input === "string" ? { path: input } : input;
    const mode = options.mode ?? "checkout";

    if (mode === "worktree") {
      return this.openWorktreeWorkspace(options.path, options.baseRef);
    }

    return this.openCheckoutWorkspace(options.path);
  }

  getWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      this.store?.touchSession(workspaceId);
      return workspace;
    }

    const session = this.store?.getSession(workspaceId);
    if (!session) {
      throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
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
      activatedSkillDirs: new Set(),
      loadedAgentsFiles: new Map(),
    };
    for (const file of this.loadInitialAgentsFiles(root)) restoredWorkspace.loadedAgentsFiles.set(file.path, file);
    this.store?.touchSession(workspaceId);
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);

    return restoredWorkspace;
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
    if (!isPathInsideRoot(absolutePath, workspace.root)) {
      throw new Error(`Path is outside workspace root: ${inputPath}`);
    }
    assertNoSymlinkComponentsSync(absolutePath);

    return absolutePath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    try {
      return {
        absolutePath: this.resolvePath(workspace, inputPath),
        readRoots: [workspace.root],
      };
    } catch (workspaceError) {
      const skillRead = resolveSkillReadPath(
        workspace.skills,
        workspace.activatedSkillDirs,
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
  async loadApplicableInstructions(workspace: Workspace, inputPath: string): Promise<LoadedAgentsFile[]> {
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

    const newlyLoaded: LoadedAgentsFile[] = [];
    for (const ancestor of ancestors) {
      for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
        const filePath = resolve(ancestor, filename);
        if (workspace.loadedAgentsFiles.has(filePath)) continue;
        try {
          const content = await readFile(filePath, "utf8");
          const file = { path: filePath, content };
          workspace.loadedAgentsFiles.set(filePath, file);
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

  getLoadedAgentsFiles(workspace: Workspace): LoadedAgentsFile[] {
    return [...workspace.loadedAgentsFiles.values()];
  }

  setActiveSession(workspaceId: string, sessionId: string | undefined): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    workspace.currentWorkSessionId = sessionId;
  }

  markReadPathLoaded(workspace: Workspace, readPath: WorkspaceReadPath): void {
    if (readPath.skillRead?.isSkillFile) {
      markSkillActivated(workspace.activatedSkillDirs, readPath.skillRead.skill);
    }
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    const directory = workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;
    return assertAllowedPath(directory, [workspace.root]);
  }

  private async openCheckoutWorkspace(path: string): Promise<WorkspaceContext> {
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
      const existing = this.workspaces.get(existingId);
      if (existing) {
        this.store?.touchSession(existingId);
        const agentsFiles = this.loadInitialAgentsFiles(existing.root);
        const availableAgentsFiles = await this.findAvailableAgentsFiles(existing.root, agentsFiles);
        return { workspace: existing, agentsFiles, availableAgentsFiles };
      }
      // Stale in-memory entry but DB record exists — restore it.
      const session = this.store?.getSession(existingId);
      if (session) {
        const restored = await this.restoreWorkspaceFromSession(session);
        const agentsFiles = this.loadInitialAgentsFiles(restored.root);
        const availableAgentsFiles = await this.findAvailableAgentsFiles(restored.root, agentsFiles);
        return { workspace: restored, agentsFiles, availableAgentsFiles };
      }
    }

    // P0 #4: Check DB for existing workspace with this canonical root (restart-durable).
    if (this.store) {
      const dbExisting = this.store.getLatestByCanonicalRoot(canonicalKey, "checkout");
      if (dbExisting) {
        const restored = await this.restoreWorkspaceFromSession(dbExisting);
        const agentsFiles = this.loadInitialAgentsFiles(restored.root);
        const availableAgentsFiles = await this.findAvailableAgentsFiles(restored.root, agentsFiles);
        return { workspace: restored, agentsFiles, availableAgentsFiles };
      }
    }

    return this.createWorkspaceContext({ root: resolvedRoot, mode: "checkout" });
  }

  private async openWorktreeWorkspace(path: string, baseRef: string | undefined): Promise<WorkspaceContext> {
    const worktree = await createManagedWorktree({
      sourcePath: path,
      baseRef,
      config: this.config,
    });

    return this.createWorkspaceContext({
      root: worktree.path,
      mode: "worktree",
      sourceRoot: worktree.sourceRoot,
      worktree,
    });
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
      activatedSkillDirs: new Set(),
      loadedAgentsFiles: new Map(),
    };
    for (const file of this.loadInitialAgentsFiles(session.root)) workspace.loadedAgentsFiles.set(file.path, file);
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
  }): Promise<WorkspaceContext> {
    const workspace: Workspace = {
      id: `ws_${randomUUID()}`,
      root: input.root,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
      ...this.loadSkillsForWorkspace(input.root),
      activatedSkillDirs: new Set(),
      loadedAgentsFiles: new Map(),
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

    const agentsFiles = this.loadInitialAgentsFiles(workspace.root);
    for (const file of agentsFiles) workspace.loadedAgentsFiles.set(file.path, file);
    // Nested instruction discovery is lazy and path-scoped. Keep this field in
    // the protocol for compatibility, but never recursively enumerate a repo.
    const availableAgentsFiles: AvailableAgentsFile[] = [];

    return { workspace, agentsFiles, availableAgentsFiles };
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
