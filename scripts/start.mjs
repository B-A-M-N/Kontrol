// npm start launcher with explicit artifact identity semantics.
//
// P0 fix (build→start identity): `npm run build` produces an immutable
// candidate at releases/<buildId>/ and writes .kontrol-build-result.json; it
// deliberately never mutates dist/. The old `npm start` unconditionally ran
// node dist/cli.js, so in a source checkout it silently launched whatever
// stale projection happened to sit in dist/ — possibly weeks old. The
// launcher resolves the artifact explicitly:
//
//   1. KONTROL_START_ARTIFACT_PATH — explicit override, still validated.
//   2. .kontrol-build-result.json — the atomic build result; its artifactPath
//      is verified against the release's build-meta.json buildId.
//   3. dist/ as a symlink into releases/ — the committed projection.
//   4. dist/ as a regular directory — accepted only when its build identity
//      matches the current git HEAD; a stale projection is REFUSED with the
//      exact remediation, never launched.
//
// Installed npm packages (no git checkout) keep running their packaged
// dist/cli.js: the identity concern is a source-checkout problem.
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
// KONTROL_BUILD_RESULT_PATH mirrors build-atomic.mjs, letting callers (and
// tests) relocate the atomic build result.
const buildResultPath = (checkoutRoot) => process.env.KONTROL_BUILD_RESULT_PATH
  ? resolve(checkoutRoot, process.env.KONTROL_BUILD_RESULT_PATH)
  : join(checkoutRoot, ".kontrol-build-result.json");

function isSourceCheckout() {
  return existsSync(join(root, ".git")) && existsSync(join(root, "src", "cli.ts"));
}

function gitHead() {
  try {
    return execGit(["rev-parse", "HEAD"]);
  } catch {
    return undefined;
  }
}

function execGit(args) {
  const { execFileSync } = require("node:child_process");
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function readBuildMeta(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, "build-meta.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function validateArtifactDirectory(directory) {
  if (!existsSync(join(directory, "cli.js"))) {
    return `artifact at ${directory} has no cli.js`;
  }
  const meta = readBuildMeta(directory);
  if (!meta) return `artifact at ${directory} has no build-meta.json`;
  return undefined;
}

/**
 * Resolve and validate the artifact `npm start` must run. Returns
 * { artifactPath, buildId } or { refusal, reason }.
 */
export function resolveStartArtifact(options = {}) {
  const sourceCheckout = options.sourceCheckout ?? isSourceCheckout();
  const rootOverride = options.root ?? root;

  const explicit = options.explicitArtifactPath;
  if (explicit) {
    const artifactPath = resolve(rootOverride, explicit);
    const problem = validateArtifactDirectory(artifactPath);
    if (problem) return { refusal: true, reason: `KONTROL_START_ARTIFACT_PATH: ${problem}` };
    const meta = readBuildMeta(artifactPath);
    return { artifactPath, buildId: meta?.buildId };
  }

  // Installed package: run the packaged artifact as before.
  if (!sourceCheckout) {
    const packaged = join(rootOverride, "dist");
    const problem = validateArtifactDirectory(packaged);
    if (problem) return { refusal: true, reason: `installed package: ${problem}` };
    return { artifactPath: packaged, buildId: readBuildMeta(packaged)?.buildId };
  }

  // Source checkout — the identity-sensitive path.
  const head = options.gitHead ?? gitHead();

  // 1. Atomic build result: the artifact `npm run build` just produced.
  const resultPath = buildResultPath(rootOverride);
  if (existsSync(resultPath)) {
    try {
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      if (result.artifactPath) {
        const artifactPath = resolve(rootOverride, result.artifactPath);
        if (!existsSync(artifactPath)) {
          return {
            refusal: true,
            reason: `build result names artifact ${artifactPath} which no longer exists. Run \`npm run build\` again.`,
          };
        }
        const artifactReal = realpathSync(artifactPath);
        const meta = readBuildMeta(artifactReal);
        if (meta?.buildId && result.buildId && meta.buildId !== result.buildId) {
          return {
            refusal: true,
            reason: `build result identity ${result.buildId} does not match artifact ${meta.buildId} at ${artifactPath}. Run \`npm run build\` again.`,
          };
        }
        const problem = validateArtifactDirectory(artifactReal);
        if (problem) return { refusal: true, reason: problem };
        return { artifactPath: artifactReal, buildId: result.buildId ?? meta?.buildId };
      }
    } catch (error) {
      return {
        refusal: true,
        reason: `.kontrol-build-result.json is unreadable (${error instanceof Error ? error.message : String(error)}). Remove it or run \`npm run build\`.`,
      };
    }
  }

  // 2. dist/ as a symlink into releases/ — the committed projection written
  //    by a successful activation. Its identity is trusted because the
  //    controller only points it at a validated release.
  const dist = join(rootOverride, "dist");
  const distIsSymlink = (() => {
    try { return lstatSync(dist).isSymbolicLink(); } catch { return false; }
  })();
  if (distIsSymlink) {
    let target;
    try {
      target = realpathSync(dist);
    } catch {
      const raw = readlinkSync(dist);
      return {
        refusal: true,
        reason: `dist/ is a broken symlink (${raw}). Run \`npm run build\` and \`npm start\`, or use start-all.sh.`,
      };
    }
    const problem = validateArtifactDirectory(target);
    if (problem) return { refusal: true, reason: problem };
    return { artifactPath: target, buildId: readBuildMeta(target)?.buildId };
  }

  // 3. dist/ as a regular directory: only trustworthy when it was built from
  //    exactly the current source state. Anything else is a stale projection
  //    and must never launch.
  if (existsSync(dist)) {
    const problem = validateArtifactDirectory(dist);
    if (problem) return { refusal: true, reason: problem };
    const meta = readBuildMeta(dist);
    if (head && meta?.gitSha && meta.gitSha !== head) {
      return {
        refusal: true,
        reason: [
          `dist/ is a stale projection: built from ${String(meta.gitSha).slice(0, 12)} but HEAD is ${head.slice(0, 12)}.`,
          "Refusing to launch an artifact that does not match this checkout.",
          "Run:  npm run build && npm start",
          "Or use the transactional controller: bash start-all.sh",
        ].join("\n"),
      };
    }
    if (Number(meta?.gitDirty ?? 0) > 0 && !options.allowDirty) {
      return {
        refusal: true,
        reason: [
          `dist/ was built from a dirty checkout (${meta?.gitDirty} changed paths).`,
          "For development iteration run: bash start-all.sh (or npm run dev).",
          "For a release candidate run: npm run build && npm start.",
        ].join("\n"),
      };
    }
    return { artifactPath: dist, buildId: meta?.buildId };
  }

  return {
    refusal: true,
    reason: [
      "No built artifact found.",
      "Run:  npm run build && npm start",
      "Or use the transactional controller: bash start-all.sh",
    ].join("\n"),
  };
}

async function main() {
  const resolved = resolveStartArtifact({
    explicitArtifactPath: process.env.KONTROL_START_ARTIFACT_PATH,
  });
  if (resolved.refusal) {
    console.error(`[npm start] ${resolved.reason}`);
    process.exitCode = 1;
    return;
  }
  if (process.env.KONTROL_START_RESOLVE_ONLY === "true") {
    // Resolution/identity check without launching (used by tests and tooling).
    process.stdout.write(`${JSON.stringify({ artifactPath: resolved.artifactPath, buildId: resolved.buildId })}\n`);
    return;
  }
  const entry = join(resolved.artifactPath, "cli.js");
  const child = spawn(process.execPath, [entry, "serve"], {
    cwd: root,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    if (signal) process.exitCode = 1;
    else if (typeof code === "number" && code !== 0) process.exitCode = code;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[npm start] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
