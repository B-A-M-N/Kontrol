import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const RELEASE_FORMAT_VERSION = 5;
const LEGACY_RELEASE_FORMAT_VERSION = 4;

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

/** Legacy v4 content digest: deliberately kept for read-only verification
 * of retained format-4 releases. The framing is ambiguous (path and bytes
 * concatenated un-delimited), so it is never used for new releases. */
function legacyTreeContentSha256(directory: string): string {
  const hash = createHash("sha256").update(`kontrol-release-format:${LEGACY_RELEASE_FORMAT_VERSION}\n`);
  hashTree(directory, hash);
  return hash.digest("hex").slice(0, 16);
}

function hashTreeV5(directory: string, hash: ReturnType<typeof createHash>, relativeDirectory = ""): void {
  for (const entry of readdirSync(directory).sort()) {
    const absolute = join(directory, entry);
    const relative = join(relativeDirectory, entry);
    if (relative === "build-meta.json") continue;
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error(`release contains a symlink and cannot be verified: ${absolute}`);
    if (info.isDirectory()) {
      hashTreeV5(absolute, hash, relative);
    } else if (info.isFile()) {
      const bytes = readFileSync(absolute);
      // Unambiguous framing: path byte-length, path bytes, file-type tag,
      // content byte-length, content bytes. No two distinct trees can
      // serialize to the same byte stream.
      const pathBytes = Buffer.from(relative, "utf8");
      const pathLength = Buffer.alloc(4);
      pathLength.writeUInt32BE(pathBytes.length);
      const contentLength = Buffer.alloc(8);
      contentLength.writeBigUInt64BE(BigInt(bytes.length));
      hash.update(pathLength).update(pathBytes).update("f").update(contentLength).update(bytes);
    } else {
      throw new Error(`release contains an unsupported filesystem entry: ${absolute}`);
    }
  }
}

/** Canonical release content digest (v5): full SHA-256 over the framed
 * tree serialization. */
export function treeContentSha256(directory: string): string {
  const hash = createHash("sha256").update(`kontrol-release-format:${RELEASE_FORMAT_VERSION}\n`);
  hashTreeV5(resolve(directory), hash);
  return hash.digest("hex");
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
 * build-meta.json fails here; metadata alone is never trusted. Format-4
 * releases verify under the legacy algorithm (read-only compatibility);
 * format-5 releases under the framed full-digest algorithm.
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
    const formatVersion = typeof metadata?.releaseFormatVersion === "number" ? metadata.releaseFormatVersion : undefined;
    if (!metadata || typeof metadata.buildId !== "string" || typeof metadata.contentSha256 !== "string"
      || !/^[a-f0-9]{16,64}$/.test(metadata.contentSha256) || !existsSync(join(root, "cli.js"))) {
      return { ok: false, reason: "missing or invalid build metadata/cli" };
    }
    let actual: string;
    if (formatVersion === LEGACY_RELEASE_FORMAT_VERSION || (formatVersion === undefined && metadata.contentSha256.length === 16)) {
      actual = legacyTreeContentSha256(root);
    } else if (formatVersion === RELEASE_FORMAT_VERSION) {
      actual = treeContentSha256(root);
    } else {
      return { ok: false, reason: `unsupported release format version ${String(formatVersion)}` };
    }
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
