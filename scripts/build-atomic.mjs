import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildToolEnvironment } from "./lib/tool-environment.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempDist = mkdtempSync(join(root, ".kontrol-build-"));
const releasesDir = join(root, "releases");
// Bump when the release metadata/loader contract changes in a way that must
// invalidate an older immutable directory. build-meta.json is excluded from
// the content hash because it carries the final build identity.
const RELEASE_FORMAT_VERSION = 4;
const MAX_WORKSPACE_APP_HISTORY = 64;
const MAX_WORKSPACE_APP_HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const resultPath = process.env.KONTROL_BUILD_RESULT_PATH
  ? resolve(root, process.env.KONTROL_BUILD_RESULT_PATH)
  : join(root, ".kontrol-build-result.json");

rmSync(resultPath, { force: true });

function run(command, args, environment = {}) {
  execFileSync(command, args, {
    cwd: root,
    // P1.10: explicit allowlist so an ambient launcher environment (deploy
    // id, lock tokens) cannot ride into the build toolchain.
    env: buildToolEnvironment(process.env, { overrides: { KONTROL_BUILD_OUTPUT_DIR: tempDist, ...environment } }),
    stdio: "inherit",
  });
}

function hashTree(directory, artifactHash, relativeDirectory = "") {
  for (const entry of readdirSync(directory).sort()) {
    const absolute = join(directory, entry);
    const relative = join(relativeDirectory, entry);
    if (relative === "build-meta.json") continue;
    const stats = statSync(absolute);
    if (stats.isDirectory()) hashTree(absolute, artifactHash, relative);
    else artifactHash.update(relative).update(readFileSync(absolute));
  }
}

function artifactHashFor(directory) {
  const artifactHash = createHash("sha256");
  artifactHash.update(`kontrol-release-format:${RELEASE_FORMAT_VERSION}\n`);
  hashTree(directory, artifactHash);
  return artifactHash.digest("hex").slice(0, 16);
}

function collectWorkspaceAppHistory() {
  if (!existsSync(releasesDir)) return [];
  const directories = readdirSync(releasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9._-]{1,128}$/.test(entry.name))
    .map((entry) => ({ buildId: entry.name, path: join(releasesDir, entry.name) }));
  const metadataByBuildId = new Map();
  const historyHints = new Map();
  for (const directory of directories) {
    try {
      const metadata = JSON.parse(readFileSync(join(directory.path, "build-meta.json"), "utf8"));
      if (metadata.buildId !== directory.buildId) continue;
      metadataByBuildId.set(directory.buildId, metadata);
      if (Array.isArray(metadata.workspaceAppHistory)) {
        for (const history of metadata.workspaceAppHistory) {
          if (typeof history?.releaseBuildId !== "string"
            || typeof history?.workspaceAppBuildId !== "string"
            || !/^[A-Za-z0-9._-]{1,128}$/.test(history.releaseBuildId)
            || !/^[a-f0-9]{12}$/i.test(history.workspaceAppBuildId)) continue;
          if (!historyHints.has(history.releaseBuildId)) historyHints.set(history.releaseBuildId, history.workspaceAppBuildId.toLowerCase());
        }
      }
    } catch {
      // Ignore incomplete candidate directories and keep the immutable build
      // process independent from abandoned temporary output.
    }
  }

  const now = Date.now();
  const candidates = directories.map((directory) => {
    const metadata = metadataByBuildId.get(directory.buildId);
    if (!metadata) return undefined;
    let builtAt = Date.parse(metadata.buildTimestamp);
    if (!Number.isFinite(builtAt)) {
      try { builtAt = statSync(directory.path).mtimeMs; } catch { return undefined; }
    }
    if (builtAt > now + 5 * 60_000 || now - builtAt > MAX_WORKSPACE_APP_HISTORY_AGE_MS) return undefined;
    return { ...directory, metadata, builtAt };
  }).filter(Boolean).sort((a, b) => b.builtAt - a.builtAt).slice(0, MAX_WORKSPACE_APP_HISTORY);

  const results = [];
  const seenAppBuildIds = new Set();
  for (const candidate of candidates) {
    const htmlPath = join(candidate.path, "ui", "workspace-app.html");
    let appBuildId = candidate.metadata.workspaceAppBuildId;
    if (typeof appBuildId !== "string" || !/^[a-f0-9]{12}$/i.test(appBuildId)) {
      appBuildId = historyHints.get(candidate.buildId);
    }
    if (typeof appBuildId !== "string" || !/^[a-f0-9]{12}$/i.test(appBuildId)) {
      try {
        const stats = statSync(htmlPath);
        if (!stats.isFile() || stats.size > 20 * 1024 * 1024) continue;
        appBuildId = createHash("sha256").update(readFileSync(htmlPath)).digest("hex").slice(0, 12);
      } catch {
        continue;
      }
    }
    appBuildId = appBuildId.toLowerCase();
    if (seenAppBuildIds.has(appBuildId)) continue;
    seenAppBuildIds.add(appBuildId);
    results.push({
      releaseBuildId: candidate.buildId,
      workspaceAppBuildId: appBuildId,
      buildTimestamp: new Date(candidate.builtAt).toISOString(),
    });
  }
  return results;
}

function validateExistingReleaseMatchesBuildId(releasePath, buildId, contentSha256) {
  const metadata = JSON.parse(readFileSync(join(releasePath, "build-meta.json"), "utf8"));
  if (metadata.buildId !== buildId) {
    throw new Error(`Existing release ${releasePath} has build ID ${metadata.buildId ?? "missing"}, expected ${buildId}`);
  }
  if (metadata.contentSha256 !== contentSha256) {
    throw new Error(`Existing release ${releasePath} content identity ${metadata.contentSha256 ?? "missing"} does not match ${contentSha256}`);
  }
  const actualHash = artifactHashFor(releasePath);
  if (actualHash !== contentSha256) {
    throw new Error(`Existing release ${releasePath} executable hash ${actualHash} does not match content identity ${contentSha256}`);
  }
  execFileSync(process.execPath, [join(root, "scripts/validate-release.mjs"), releasePath], {
    cwd: root,
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

  // The executable/UI content identity is stable, but the immutable release
  // identity also includes source provenance and the build instant. This
  // prevents a byte-identical rebuild from reusing a release directory whose
  // build metadata came from another checkout state.
  const contentSha256 = artifactHashFor(tempDist);
  const buildTimestamp = new Date().toISOString();
  const workspaceAppHistory = JSON.stringify(collectWorkspaceAppHistory());
  run(process.execPath, ["scripts/generate-build-meta.mjs"], {
    KONTROL_BUILD_ID: contentSha256,
    KONTROL_CONTENT_SHA256: contentSha256,
    KONTROL_BUILD_TIMESTAMP: buildTimestamp,
    KONTROL_RELEASE_FORMAT_VERSION: String(RELEASE_FORMAT_VERSION),
    KONTROL_WORKSPACE_APP_HISTORY: workspaceAppHistory,
  });

  const metaPath = join(tempDist, "build-meta.json");
  const provisionalMeta = JSON.parse(readFileSync(metaPath, "utf8"));
  const buildId = createHash("sha256")
    .update(JSON.stringify({
      contentSha256,
      gitSha: provisionalMeta.gitSha ?? "unknown",
      gitDirty: Number(provisionalMeta.gitDirty ?? 0),
      buildTimestamp,
      releaseFormatVersion: RELEASE_FORMAT_VERSION,
    }))
    .digest("hex")
    .slice(0, 16);
  run(process.execPath, ["scripts/generate-build-meta.mjs"], {
    KONTROL_BUILD_ID: buildId,
    KONTROL_CONTENT_SHA256: contentSha256,
    KONTROL_BUILD_TIMESTAMP: buildTimestamp,
    KONTROL_RELEASE_FORMAT_VERSION: String(RELEASE_FORMAT_VERSION),
    KONTROL_WORKSPACE_APP_HISTORY: workspaceAppHistory,
  });

  const buildMeta = JSON.parse(readFileSync(metaPath, "utf8"));
  if (buildMeta.buildId !== buildId || buildMeta.contentSha256 !== contentSha256) {
    throw new Error(`Build metadata identity mismatch: expected release ${buildId} / content ${contentSha256}, got ${buildMeta.buildId ?? "missing"} / ${buildMeta.contentSha256 ?? "missing"}`);
  }

  run(process.execPath, ["scripts/validate-release.mjs", tempDist]);

  const releasePath = join(releasesDir, buildId);
  mkdirSync(releasesDir, { recursive: true });
  if (existsSync(releasePath)) {
    // A release directory is immutable after publication. A repeated build
    // may reuse it only after proving both its metadata and executable tree
    // still correspond to the content-addressed build ID.
    validateExistingReleaseMatchesBuildId(releasePath, buildId, contentSha256);
    rmSync(tempDist, { recursive: true, force: true });
  } else {
    renameSync(tempDist, releasePath);
  }

  const result = {
    buildId,
    contentSha256,
    artifactPath: releasePath,
    preparedAt: new Date().toISOString(),
    sourceGitSha: buildMeta.gitSha ?? "unknown",
    sourceDirty: Number(buildMeta.gitDirty ?? 0) > 0,
    sourceDirtyFileCount: Number(buildMeta.gitDirty ?? 0),
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
