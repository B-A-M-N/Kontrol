import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Version marker used when a guarded mutation expects a path not to exist. */
export const MISSING_FILE_VERSION = "missing";

// All MCP transports in one Kontrol process share this coordinator. Keys are
// canonical absolute paths, so independent tabs serialize only overlapping
// file mutations and never hold a project-wide lock while reasoning or waiting
// for policy approval.
const mutationTails = new Map<string, Promise<void>>();

export async function withFileMutationLock<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
  const keys = [...new Set(paths)].sort();
  if (keys.length === 0) return operation();

  let release!: () => void;
  const ticket = new Promise<void>((resolve) => { release = resolve; });
  const predecessors = keys.map((key) => mutationTails.get(key) ?? Promise.resolve());
  for (const key of keys) mutationTails.set(key, ticket);

  try {
    await Promise.all(predecessors);
    return await operation();
  } finally {
    release();
    for (const key of keys) {
      if (mutationTails.get(key) === ticket) mutationTails.delete(key);
    }
  }
}

/**
 * Hash the current bytes of a regular file. A missing path is represented by a
 * stable marker so create-file and move-destination preconditions are possible.
 */
export async function readFileVersion(path: string): Promise<string> {
  try {
    const bytes = await readFile(path);
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return MISSING_FILE_VERSION;
    throw error;
  }
}
