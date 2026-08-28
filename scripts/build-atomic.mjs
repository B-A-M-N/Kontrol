import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempDist = mkdtempSync(join(root, ".kontrol-build-"));
const releasesDir = join(root, "releases");
// Bump when the release metadata/loader contract changes in a way that must
// invalidate an older immutable directory. build-meta.json is excluded from
// the byte hash because it carries the final build ID, so this stable marker
// prevents an old artifact with the same executable bytes from being reused
// after a metadata contract change.
const RELEASE_FORMAT_VERSION = 2;
const resultPath = process.env.KONTROL_BUILD_RESULT_PATH
  ? resolve(root, process.env.KONTROL_BUILD_RESULT_PATH)
  : join(root, ".kontrol-build-result.json");

rmSync(resultPath, { force: true });

function run(command, args, environment = {}) {
  execFileSync(command, args, {
    cwd: root,
    // kontrol-env-exception: build tooling spawns the project's own vite/tsc on
    // trusted build inputs (not repository content); needs PATH/npm lifecycle.
    env: { ...process.env, KONTROL_BUILD_OUTPUT_DIR: tempDist, ...environment },
    stdio: "inherit",
  });
}

try {
  // Every producer writes only to the isolated candidate tree. The live dist/
  // directory is untouched until all source, UI, metadata, and entrypoint
  // checks pass.
  run("npm", ["run", "build:app"]);
  run("npx", ["tsc", "-p", "tsconfig.build.json", "--outDir", tempDist]);

  // The source shim imports through the repository layout and cannot be moved
  // into an immutable release. Ship the implementation itself so every
  // relative dependency remains release-local.
  const workerToken = join(root, "scripts/lib/acp-worker-token.mjs");
  if (existsSync(workerToken)) copyFileSync(workerToken, join(tempDist, "acp-worker-token.mjs"));
  chmodSync(join(tempDist, "cli.js"), 0o755);

  for (const required of ["cli.js", "server.js", "acp-duplex.js", "build-meta.json", "ui/workspace-app.html"]) {
    if (required !== "build-meta.json" && !existsSync(join(tempDist, required))) {
      throw new Error(`Atomic build candidate is missing ${required}`);
    }
  }

  // The build ID is derived from the final executable/UI bytes. Metadata is
  // deliberately excluded because it contains a timestamp and records this
  // already-computed ID. This gives one authoritative ID for one candidate.
  const artifactHash = createHash("sha256");
  artifactHash.update(`kontrol-release-format:${RELEASE_FORMAT_VERSION}\n`);
  function hashTree(directory, relativeDirectory = "") {
    for (const entry of readdirSync(directory).sort()) {
      const absolute = join(directory, entry);
      const relative = join(relativeDirectory, entry);
      if (relative === "build-meta.json") continue;
      const stats = statSync(absolute);
      if (stats.isDirectory()) hashTree(absolute, relative);
      else artifactHash.update(relative).update(readFileSync(absolute));
    }
  }
  hashTree(tempDist);
  const buildId = artifactHash.digest("hex").slice(0, 16);
  run(process.execPath, ["scripts/generate-build-meta.mjs"], {
    KONTROL_BUILD_ID: buildId,
    KONTROL_RELEASE_FORMAT_VERSION: String(RELEASE_FORMAT_VERSION),
  });

  const metaPath = join(tempDist, "build-meta.json");
  const buildMeta = JSON.parse(readFileSync(metaPath, "utf8"));
  if (buildMeta.buildId !== buildId) {
    throw new Error(`Build metadata identity mismatch: expected ${buildId}, got ${buildMeta.buildId ?? "missing"}`);
  }

  run(process.execPath, ["scripts/validate-release.mjs", tempDist]);

  const releasePath = join(releasesDir, buildId);
  mkdirSync(releasesDir, { recursive: true });
  if (existsSync(releasePath)) {
    // Identical executable bytes: keep the existing candidate tree, but the
    // freshly generated build-meta.json is authoritative. An earlier build of
    // the same bytes from a dirty tree would otherwise keep reporting its
    // stale gitSha/gitDirty forever (build-meta.json is excluded from the
    // byte hash precisely so this refresh is safe).
    copyFileSync(join(tempDist, "build-meta.json"), join(releasePath, "build-meta.json"));
    rmSync(tempDist, { recursive: true, force: true });
  } else {
    renameSync(tempDist, releasePath);
  }

  const result = {
    buildId,
    artifactPath: releasePath,
    preparedAt: new Date().toISOString(),
  };
  mkdirSync(resolve(resultPath, ".."), { recursive: true, mode: 0o700 });
  const temporaryResultPath = `${resultPath}.tmp-${process.pid}`;
  writeFileSync(temporaryResultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryResultPath, resultPath);
  console.log(`[build-atomic] built immutable candidate ${buildId} at ${releasePath}; active generation was not changed`);
} catch (error) {
  console.error(`[build-atomic] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (existsSync(tempDist)) rmSync(tempDist, { recursive: true, force: true });
}
