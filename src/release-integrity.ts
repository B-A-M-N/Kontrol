import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const RELEASE_FORMAT_VERSION = 4;

function hashTree(directory: string, hash: ReturnType<typeof createHash>, relativeDirectory = ""): void {
  for (const entry of readdirSync(directory).sort()) {
    const absolute = join(directory, entry);
    const relative = join(relativeDirectory, entry);
    if (relative === "build-meta.json") continue;
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error(`release contains a symlink and cannot be verified: ${absolute}`);
    if (info.isDirectory()) hashTree(absolute, hash, relative);
    else if (info.isFile()) hash.update(relative).update(readFileSync(absolute));
    else throw new Error(`release contains an unsupported filesystem entry: ${absolute}`);
  }
}

export interface ArtifactVerification {
  ok: boolean;
  buildId?: string;
  contentSha256?: string;
  reason?: string;
}

/**
 * Recompute the content identity of an immutable release artifact and
 * compare it with its build metadata. A tampered file under an intact
 * build-meta.json fails here; metadata alone is never trusted.
 */
export function verifyArtifactContent(artifactPath: string): ArtifactVerification {
  const root = resolve(artifactPath);
  try {
    const info = lstatSync(root);
    if (!info.isDirectory()) return { ok: false, reason: "not a directory" };
    let metadata: Record<string, unknown> | undefined;
    try {
      metadata = JSON.parse(readFileSync(join(root, "build-meta.json"), "utf8")) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "missing or invalid build metadata/cli" };
    }
    if (!metadata || typeof metadata.buildId !== "string" || typeof metadata.contentSha256 !== "string"
      || !/^[a-f0-9]{16,64}$/.test(metadata.contentSha256) || !existsSync(join(root, "cli.js"))) {
      return { ok: false, reason: "missing or invalid build metadata/cli" };
    }
    const hash = createHash("sha256").update(`kontrol-release-format:${RELEASE_FORMAT_VERSION}\n`);
    hashTree(root, hash);
    const actual = hash.digest("hex").slice(0, 16);
    if (actual !== metadata.contentSha256) return { ok: false, reason: `content hash mismatch (${actual})` };
    return { ok: true, buildId: metadata.buildId, contentSha256: actual };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Throw unless the artifact tree still matches its recorded content identity. */
export function assertArtifactContent(artifactPath: string): void {
  const verification = verifyArtifactContent(artifactPath);
  if (!verification.ok) {
    throw new Error(`refusing to use unverified release artifact ${artifactPath}: ${verification.reason}`);
  }
}
