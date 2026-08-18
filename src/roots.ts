import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { lstatSync } from "node:fs";

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

  return (
    relationship === "" ||
    (!isAbsolute(relationship) &&
      !relationship.startsWith("..") &&
      relationship !== ".." &&
      !relationship.includes(`..${sep}`))
  );
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
export function assertNoSymlinkComponentsSync(absolutePath: string): void {
  let current: string = sep;
  const components = resolve(absolutePath).split(sep).filter(Boolean);
  for (const component of components) {
    current = resolve(current, component);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) {
        throw new AccessDeniedError(`Symlink path components are not permitted: ${absolutePath}`);
      }
      if (!metadata.isDirectory() && current !== resolve(absolutePath)) {
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
export async function resolveAllowedPathCanonical(inputPath: string, cwd: string, allowedRoots: string[]): Promise<string> {
  const absolutePath = resolve(cwd, inputPath);
  const canonicalRoots = await getCanonicalRoots(allowedRoots);
  try {
    await rejectSymlinkComponents(absolutePath);
    const canonical = await realpath(absolutePath);
    return assertAllowedPath(canonical, canonicalRoots);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return resolveWritablePath(absolutePath, canonicalRoots);
  }
}

/**
 * P0 #5c: Resolve a writable path (e.g. a new file). The target itself may
 * not exist yet, so we walk up to the nearest existing ancestor, canonicalize
 * that, then reattach the remainder. Rejects any existing symlink component
 * that escapes the canonical workspace.
 */
export async function resolveWritablePath(absolutePath: string, canonicalRoots?: string[]): Promise<string> {
  const roots = canonicalRoots ?? await getCanonicalRoots([process.cwd()]);
  await rejectSymlinkComponents(absolutePath);

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
async function rejectSymlinkComponents(absolutePath: string): Promise<void> {
  let current: string = sep;
  const components = absolutePath.split(sep).filter(Boolean);
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
