// Staged npm packaging: build once, then pack/publish a COMPLETE COPY of the
// package tree in a temporary directory.
//
// P1 fix (crash-vulnerable prepack dist swap): the old flow ran `npm run
// build && node scripts/package-dist.mjs prepare` as npm's prepack hook and
// restored dist/ in postpack. Process death between the two hooks left the
// checkout with a swapped dist and packaging state the next run could
// misclassify. The repository tree is now never mutated at all: this script
// stages package.json (lifecycle hooks stripped), the declared files list,
// and dist/ copied from the immutable build candidate into a temp directory,
// then runs `npm pack` (default) or `npm publish` (--publish) INSIDE the
// staged tree. A crash at any point leaves only a temp dir behind.
//
// The staged package.json carries the real version/fields, so the tarball is
// byte-equivalent to what the old flow produced — minus any possibility of
// corrupting the checkout.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildToolEnvironment } from "./lib/tool-environment.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const publish = process.argv.includes("--publish");
const verifyOnly = process.argv.includes("--publish-verify-only");
const skipBuild = process.argv.includes("--skip-build");
const destination = option("--pack-destination");
// P0 (release transport): an explicit, already-validated candidate directory.
// The release workflow passes the extracted qualification-bundle candidate so
// publish never depends on a checkout-local build-result file (which a fresh
// runner cannot possess — the candidate comes from the durable bundle store).
const explicitCandidate = option("--candidate") ? resolve(root, option("--candidate")) : undefined;
if (explicitCandidate && !skipBuild) {
  throw new Error("--candidate is incompatible with a build: pass --skip-build --candidate <qualified-candidate-dir>");
}

// Release coupling: when invoked under a release buildId, the staged
// candidate must BE that candidate. A rebuild is never acceptable (the
// 12-hour soak qualifies an exact artifact), so any mismatch is fatal.
const releaseBuildId = process.env.KONTROL_RELEASE_BUILD_ID;
if (skipBuild && releaseBuildId) {
  // Enforced after the build result is read below.
}
const buildResultPath = process.env.KONTROL_BUILD_RESULT_PATH
  ? resolve(root, process.env.KONTROL_BUILD_RESULT_PATH)
  : join(root, ".kontrol-build-result.json");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: buildToolEnvironment(process.env, { overrides: options.env ?? {} }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

// 1. Build the immutable candidate (or reuse a just-produced build result, or
// accept an explicitly validated candidate from the qualification bundle).
let buildResult;
let candidatePath;
if (explicitCandidate) {
  candidatePath = explicitCandidate;
  // Minimal identity probe; the full validation ran in release-bundle verify.
  const metadataPath = join(candidatePath, "build-meta.json");
  if (!existsSync(metadataPath)) {
    throw new Error(`explicit candidate ${candidatePath} has no build-meta.json`);
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  buildResult = { buildId: metadata.buildId, artifactPath: candidatePath };
  if (releaseBuildId && buildResult.buildId !== releaseBuildId) {
    throw new Error(
      `release buildId ${releaseBuildId} does not match the explicit candidate ${buildResult.buildId}. `
      + "Publish the exact soak-qualified buildId.",
    );
  }
} else {
  if (!skipBuild) {
    run("npm", ["run", "build"]);
  }
  if (!existsSync(buildResultPath)) {
    throw new Error(`no build result at ${buildResultPath}; run \`npm run build\` first (or drop --skip-build)`);
  }
  buildResult = JSON.parse(readFileSync(buildResultPath, "utf8"));
  candidatePath = resolve(root, buildResult.artifactPath);
  if (!existsSync(join(candidatePath, "cli.js"))) {
    throw new Error(`build result artifact ${candidatePath} has no cli.js`);
  }
  if (releaseBuildId && buildResult.buildId !== releaseBuildId) {
    throw new Error(
      `release buildId ${releaseBuildId} does not match the build result candidate ${buildResult.buildId}. `
      + "Never publish a rebuilt candidate: run the release workflow for the exact soak-qualified buildId.",
    );
  }
  if (releaseBuildId && !candidatePath.includes(releaseBuildId)) {
    throw new Error(`candidate artifact path ${candidatePath} does not contain release buildId ${releaseBuildId}`);
  }
}

// 2. Stage the complete package tree in a temp directory.
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const staging = mkdtempSync(join(tmpdir(), "kontrol-package-stage-"));
const stagedPkg = join(staging, "package");
mkdirSync(join(stagedPkg, "dist"), { recursive: true });

// dist/ comes from the immutable candidate — never from the checkout's dist
// projection, which may be stale, absent, or a controller-managed symlink.
cpSync(candidatePath, join(stagedPkg, "dist"), { recursive: true });

// Non-dist files from the declared files list (README/LICENSE/SECURITY/docs/
// adapter scripts). Symlinked entries are dereferenced by cpSync dereference
// default; missing optional entries fail loudly — the tarball must be
// complete.
const declaredFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
for (const entry of declaredFiles) {
  if (entry === "dist") continue;
  if (entry.includes("*")) throw new Error(`glob entries are not supported by the staging packer: ${entry}`);
  const source = join(root, entry);
  if (!existsSync(source)) throw new Error(`declared package file is missing from the checkout: ${entry}`);
  const target = join(stagedPkg, entry);
  mkdirSync(resolve(target, ".."), { recursive: true });
  cpSync(source, target, { recursive: true, dereference: true });
}

// The staged package.json is identical except lifecycle hooks: a build/pack
// hook inside the staged tree would re-run the toolchain for no benefit and
// reintroduce exactly the mutation risk this flow removes.
const stagedPackageJson = { ...packageJson };
delete stagedPackageJson.scripts.prepack;
delete stagedPackageJson.scripts.postpack;
delete stagedPackageJson.scripts.prepublishOnly;

// P0 (published dependency closure): pin the published dependencies to the
// EXACT versions recorded in the candidate's build identity — the closure the
// soak actually qualified. A caret range would let a later `npm install`
// resolve newer dependency releases than anything the 12-hour soak exercised,
// so @b-a-m-n/kontrol@X would no longer identify the qualified runtime.
const buildIdentity = JSON.parse(readFileSync(join(candidatePath, "build-meta.json"), "utf8"));
if (buildIdentity.dependencies && typeof buildIdentity.dependencies === "object") {
  const declared = stagedPackageJson.dependencies ?? {};
  const unpinned = [];
  for (const [name, exact] of Object.entries(buildIdentity.dependencies)) {
    if (typeof exact !== "string" || !exact) {
      throw new Error(`candidate dependency fingerprint has no usable version for ${name}`);
    }
    if (!(name in declared)) {
      throw new Error(`candidate was qualified against ${name}@${exact}, which the package manifest no longer declares`);
    }
    declared[name] = exact;
  }
  for (const name of Object.keys(declared)) {
    if (!(name in buildIdentity.dependencies)) {
      unpinned.push(name);
    }
  }
  if (unpinned.length > 0) {
    throw new Error(
      `package manifest declares runtime dependencies absent from the candidate's qualification fingerprint: ${unpinned.join(", ")}. `
      + "The published closure must be exactly the qualified closure.",
    );
  }
  stagedPackageJson.dependencies = Object.fromEntries(Object.entries(declared).sort(([a], [b]) => a.localeCompare(b)));
} else {
  throw new Error(
    "candidate build identity has no dependency fingerprint (rebuild with the current scripts/generate-build-meta.mjs). "
    + "Publishing without an exact dependency closure would let installers resolve an unqualified dependency set.",
  );
}
writeFileSync(join(stagedPkg, "package.json"), `${JSON.stringify(stagedPackageJson, null, 2)}\n`);

if (verifyOnly) {
  console.log(`[package-stage] verification only: staged tree ${stagedPkg} from candidate ${buildResult.buildId} is complete and publishable`);
  process.exit(0);
}

// 3. Pack or publish INSIDE the staged tree.
const packArgs = publish
  ? ["publish", "--access", String(stagedPackageJson.publishConfig?.access ?? "public")]
  : ["pack"];
const packDestination = destination ?? join(root, "dist-pack");
if (!publish) {
  mkdirSync(packDestination, { recursive: true });
  packArgs.push("--pack-destination", packDestination);
}
run("npm", packArgs, { cwd: stagedPkg });

if (publish) {
  console.log(`[package-stage] published ${stagedPackageJson.name}@${stagedPackageJson.version} from staged tree ${stagedPkg} (candidate ${buildResult.buildId})`);
} else {
  const tarball = readdirSync(packDestination)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => ({ name, at: join(packDestination, name) }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .pop();
  if (!tarball) throw new Error("npm pack produced no tarball");
  console.log(`[package-stage] staged pack complete: ${tarball.at} (candidate ${buildResult.buildId})`);
}

// Cleanup the staging tree unless the caller wants to inspect it.
if (!process.argv.includes("--keep-staging")) {
  rmSync(staging, { recursive: true, force: true });
} else {
  console.log(`[package-stage] staging tree kept at ${stagedPkg}`);
}
