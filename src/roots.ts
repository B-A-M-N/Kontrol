import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(expandHomePath(path));
  const resolvedRoot = resolve(expandHomePath(root));
  const relationship = relative(resolvedRoot, resolvedPath);

  // Reject exact parent traversal components only. A child named `..cache`
  // is a legitimate relative path and must not be falsely rejected.
  const components = relationship.split(sep).filter(Boolean);
  return (
    relationship === "" ||
    (!isAbsolute(relationship) && !components.includes(".."))
  );
}

/** Compare existing filesystem roots after resolving OS aliases such as macOS /var. */
export function isPathInsideRootCanonical(path: string, root: string): boolean {
  try {
    return isPathInsideRoot(realpathSync(path), realpathSync(root));
  } catch {
    // Preserve lexical behavior for configured paths that do not exist yet.
    return isPathInsideRoot(path, root);
  }
}

export function assertAllowedPath(path: string, allowedRoots: string[]): string {
  const resolvedPath = resolve(expandHomePath(path));
  if (allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
    return resolvedPath;
  }

  throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}

export function resolveAllowedPath(inputPath: string, cwd: string, allowedRoots: string[]): string {
  const absolutePath = resolve(cwd, inputPath);
  return assertAllowedPath(absolutePath, allowedRoots);
}

/** Synchronous counterpart used immediately before filesystem mutations. */
export function assertNoSymlinkComponentsSync(absolutePath: string, trustedRoot?: string): void {
  const target = resolve(absolutePath);
  let current: string = sep;
  let components: string[];
  if (trustedRoot !== undefined) {
    const root = resolve(trustedRoot);
    const rootRelative = relative(root, target);
    if (isAbsolute(rootRelative) || rootRelative === ".." || rootRelative.startsWith(`..${sep}`)) {
      throw new AccessDeniedError(`Path is outside workspace root: ${absolutePath}`);
    }
    // Check from the workspace boundary down. OS path aliases such as
    // macOS /var -> /private/var may contain symlinks before the boundary;
    // they do not redirect a child outside the already-authorized root.
    const rootMetadata = lstatSync(root);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new AccessDeniedError(`Workspace root must be a regular directory: ${root}`);
    }
    current = root;
    components = rootRelative.split(sep).filter(Boolean);
  } else {
    components = target.split(sep).filter(Boolean);
  }
  for (const component of components) {
    current = resolve(current, component);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) {
        throw new AccessDeniedError(`Symlink path components are not permitted: ${absolutePath}`);
      }
      if (!metadata.isDirectory() && current !== target) {
        throw new AccessDeniedError(`Path component is not a directory: ${current}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }
}

/**
 * P0 #5b: Resolve a path and verify the canonical (realpath) result is still
 * within the allowed roots. This prevents symlink escapes where a path passes
 * the lexical allowlist check but resolves to an unallowed target.
 */
export async function resolveAllowedPathCanonical(inputPath: string, cwd: string, allowedRoots: string[], trustedRoot?: string): Promise<string> {
  const absolutePath = resolve(cwd, inputPath);
  const canonicalRoots = await getCanonicalRoots(allowedRoots);
  const symlinkBoundary = trustedRoot && isPathInsideRoot(absolutePath, trustedRoot)
    ? trustedRoot
    : allowedRoots.find((root) => isPathInsideRoot(absolutePath, root));
  try {
    await rejectSymlinkComponents(absolutePath, symlinkBoundary);
    const canonical = await realpath(absolutePath);
    return assertAllowedPath(canonical, canonicalRoots);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return resolveWritablePath(absolutePath, canonicalRoots, symlinkBoundary);
  }
}

/**
 * P0 #5c: Resolve a writable path (e.g. a new file). The target itself may
 * not exist yet, so we walk up to the nearest existing ancestor, canonicalize
 * that, then reattach the remainder. Rejects any existing symlink component
 * that escapes the canonical workspace.
 */
export async function resolveWritablePath(absolutePath: string, canonicalRoots?: string[], trustedRoot?: string): Promise<string> {
  const roots = canonicalRoots ?? await getCanonicalRoots([process.cwd()]);
  await rejectSymlinkComponents(absolutePath, trustedRoot);

  let existing = absolutePath;
  while (true) {
    try {
      const metadata = await lstat(existing);
      if (!metadata.isDirectory() && existing !== absolutePath) {
        throw new AccessDeniedError(`Cannot create a child beneath a non-directory: ${existing}`);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = resolve(existing, "..");
      if (parent === existing) throw new AccessDeniedError(`Cannot resolve a writable path for: ${absolutePath}`);
      existing = parent;
    }
  }

  const canonicalExisting = await realpath(existing);
  if (!roots.some((root) => isPathInsideRoot(canonicalExisting, root))) {
    throw new AccessDeniedError(`Cannot resolve a writable path for: ${absolutePath}`);
  }

  // Return a path rooted at the canonical existing directory. Any symlink
  // component would already have been rejected above, so a later mkdir/rename
  // cannot silently redirect the write outside the allowlist.
  return resolve(canonicalExisting, relative(existing, absolutePath));
}

/** Reject symlink traversal, including symlinks that point back inside root. */
async function rejectSymlinkComponents(absolutePath: string, trustedRoot?: string): Promise<void> {
  let current: string = sep;
  let components: string[];
  if (trustedRoot !== undefined) {
    const root = resolve(trustedRoot);
    const rootRelative = relative(root, absolutePath);
    if (isAbsolute(rootRelative) || rootRelative === ".." || rootRelative.startsWith(`..${sep}`)) {
      throw new AccessDeniedError(`Path is outside workspace root: ${absolutePath}`);
    }
    // OS aliases such as macOS /var -> /private/var may contain symlinks
    // before an already-authorized workspace root. Validate the root itself
    // and every descendant, while leaving those system ancestors untouched.
    const rootMetadata = await lstat(root);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new AccessDeniedError(`Workspace root must be a regular directory: ${root}`);
    }
    current = root;
    components = rootRelative.split(sep).filter(Boolean);
  } else {
    components = absolutePath.split(sep).filter(Boolean);
  }
  for (const component of components) {
    current = resolve(current, component);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new AccessDeniedError(`Symlink path components are not permitted: ${absolutePath}`);
      }
      if (!metadata.isDirectory() && current !== absolutePath) {
        throw new AccessDeniedError(`Path component is not a directory: ${current}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }
}

async function getCanonicalRoots(roots: string[]): Promise<string[]> {
  return Promise.all(roots.map(async (r) => {
    try { return await realpath(r); } catch { return r; }
  }));
}
