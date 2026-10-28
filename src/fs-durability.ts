import { constants, closeSync, fsyncSync, openSync } from "node:fs";

/** Persist directory-entry changes where the platform exposes syncable directories. */
export function syncDirectory(path: string): void {
  // Node on Windows does not expose a syncable directory descriptor. Files are
  // still fsynced before rename; supported POSIX platforms also sync the entry.
  if (process.platform === "win32") return;
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
