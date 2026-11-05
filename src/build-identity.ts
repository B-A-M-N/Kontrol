import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildIdentity } from "./runtime-identity.js";

/** How release build metadata resolved for the serving process. */
export type ReleaseBuildStatus = "resolved" | "missing" | "invalid" | "mismatched";

export interface ReleaseBuildResolution {
  /** Parsed build-meta.json when a well-formed document was found. */
  meta: BuildIdentity | undefined;
  /** Release root that supplied the metadata, when found. */
  releaseRoot: string | undefined;
  status: ReleaseBuildStatus;
  /** Deployed generation expectation the metadata was checked against. */
  expectedBuildId?: string;
  /** Build id carried by the loaded metadata, when present. */
  actualBuildId?: string;
}

/**
 * Resolve immutable release build metadata for a serving module.
 *
 * Packaged layout keeps build-meta.json at the release root, ABOVE
 * server/diagnostics.js (releases/<id>/build-meta.json), while flat
 * single-level layouts (dist/server.js) keep it adjacent. Exactly those two
 * candidate locations are probed — never a wider ancestor walk, so an
 * unrelated build-meta.json elsewhere on disk can never leak in.
 *
 * Source checkouts have no build-meta.json in either spot and resolve to
 * an explicit "missing" state; callers keep their dev fallback.
 *
 * The returned object carries status and build ids only — never filesystem
 * paths, file contents, or credentials.
 */
export function resolveReleaseBuildMeta(options: {
  /** dirname(fileURLToPath(import.meta.url)) of the calling module. */
  moduleDir: string;
  /** Deployed generation expected build id (activeBuildId) for validation. */
  expectedBuildId?: string;
}): ReleaseBuildResolution {
  const { moduleDir, expectedBuildId } = options;
  const candidates = [
    join(moduleDir, "build-meta.json"),
    join(moduleDir, "..", "build-meta.json"),
  ];
  let raw: string | undefined;
  let releaseRoot: string | undefined;
  for (const [index, candidate] of candidates.entries()) {
    try {
      raw = readFileSync(candidate, "utf8");
      releaseRoot = index === 0 ? moduleDir : join(moduleDir, "..");
      break;
    } catch {
      continue;
    }
  }
  if (raw === undefined) {
    return expectedBuildId ? { meta: undefined, releaseRoot: undefined, status: "missing", expectedBuildId } : { meta: undefined, releaseRoot: undefined, status: "missing" };
  }
  let meta: BuildIdentity | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("build metadata must be a JSON object");
    }
    meta = parsed as BuildIdentity;
  } catch {
    return expectedBuildId
      ? { meta: undefined, releaseRoot: undefined, status: "invalid", expectedBuildId }
      : { meta: undefined, releaseRoot: undefined, status: "invalid" };
  }
  const actualBuildId = typeof meta.buildId === "string" && meta.buildId.length > 0 ? meta.buildId : undefined;
  if (actualBuildId === undefined) {
    return expectedBuildId
      ? { meta: undefined, releaseRoot: undefined, status: "invalid", expectedBuildId }
      : { meta: undefined, releaseRoot: undefined, status: "invalid" };
  }
  if (expectedBuildId && expectedBuildId !== actualBuildId) {
    return { meta, releaseRoot, status: "mismatched", expectedBuildId, actualBuildId };
  }
  return expectedBuildId
    ? { meta, releaseRoot, status: "resolved", expectedBuildId, actualBuildId }
    : { meta, releaseRoot, status: "resolved", actualBuildId };
}
