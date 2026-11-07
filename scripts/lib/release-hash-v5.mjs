// Shared release content-hash (v5) for build tooling. build-atomic.mjs
// cannot import dist/ (it creates it), so the canonical algorithm in
// src/release-integrity.ts is mirrored here; release-integrity.test.ts
// asserts this helper and the canonical implementation agree on fixture
// trees. Framing: path byte-length, path bytes, type tag, content
// byte-length, content bytes — no two distinct trees serialize equally.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const RELEASE_CONTENT_HASH_FORMAT_VERSION = 5;

export function releaseContentHashV5(directory) {
  const hash = createHash("sha256").update(`kontrol-release-format:${RELEASE_CONTENT_HASH_FORMAT_VERSION}\n`);
  hashTree(directory, hash, "");
  return hash.digest("hex");
}

function hashTree(directory, hash, relativeDirectory) {
  for (const entry of readdirSync(directory).sort()) {
    const absolute = join(directory, entry);
    const relative = join(relativeDirectory, entry);
    if (relative === "build-meta.json") continue;
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) throw new Error(`release contains a symlink: ${absolute}`);
    if (stats.isDirectory()) {
      hashTree(absolute, hash, relative);
    } else if (stats.isFile()) {
      const bytes = readFileSync(absolute);
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
