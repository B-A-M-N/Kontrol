// Qualification-bundle transport (public-beta audit P0): the 12-hour soak runs
// on the deployment host, so a fresh CI runner can never possess the
// soak-qualified artifacts from a git checkout — receipts and releases/ are
// deliberately gitignored. This script is the immutable handoff:
//
//   create  — bundle the qualified candidate + final receipt + per-file digests
//             into one tarball with a sidecar sha256, refusing unqualified
//             receipts.
//   verify  — recompute every digest from the tarball, validate the candidate
//             release tree, and check the receipt names exactly the expected
//             buildId and source SHA. Fails closed on any mismatch.
//
// The bundle is uploaded to a durable store (a GitHub Release keyed
// `qualification-<buildId>`); the release workflow downloads it, verifies it,
// and stages the package from the extracted candidate — never a rebuild
// (the soak qualifies an exact artifact).
//
// Usage:
//   node scripts/release-bundle.mjs create [--receipt p] [--out dir]
//   node scripts/release-bundle.mjs verify --bundle t.tgz --expect-build-id ID
//                                          [--expect-source-sha SHA] [--out dir]
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fail = (message) => {
  console.error(`[release-bundle] REFUSED: ${message}`);
  process.exit(1);
};

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Deterministic per-file digest map over the bundle contents (relative POSIX
// paths, sorted) — the verifier recomputes exactly this.
function digestTree(directory, relativeDirectory = "", out = {}) {
  for (const entry of readdirSync(directory).sort()) {
    const absolute = join(directory, entry);
    const relative = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
    if (statSync(absolute).isDirectory()) digestTree(absolute, relative, out);
    else out[relative] = sha256File(absolute);
  }
  return out;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

const command = process.argv[2];

// ── create ───────────────────────────────────────────────────────────────────
if (command === "create") {
  const receiptPath = option("--receipt")
    ? resolve(root, option("--receipt"))
    : join(root, "beta-qualification.json");
  const outDir = option("--out") ? resolve(root, option("--out")) : join(root, "dist-qualification");

  if (!existsSync(receiptPath)) {
    fail(`no qualification receipt at ${receiptPath}. Run the code gate + soak + gate:beta:final first.`);
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (error) {
    fail(`receipt unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (receipt.qualified !== true || receipt.stage !== "combined") {
    fail(`receipt is not a qualified combined qualification (qualified=${receipt.qualified}, stage=${receipt.stage ?? "missing"})`);
  }
  const buildId = receipt.candidate?.buildId;
  const artifactPath = receipt.candidate?.artifactPath ? resolve(root, receipt.candidate.artifactPath) : undefined;
  if (!buildId || !/^[A-Za-z0-9._-]+$/.test(buildId)) fail(`receipt candidate has no usable buildId: ${String(buildId)}`);
  if (!artifactPath || !existsSync(join(artifactPath, "build-meta.json"))) {
    fail(`receipt names candidate ${buildId} at ${artifactPath ?? "nowhere"}, which does not exist. The soak-qualified artifact must be bundled unmodified.`);
  }
  const metadata = JSON.parse(readFileSync(join(artifactPath, "build-meta.json"), "utf8"));
  if (metadata.buildId !== buildId) fail(`candidate build-meta buildId ${metadata.buildId} != receipt buildId ${buildId}`);
  if (receipt.candidate?.metadata?.contentSha256 && metadata.contentSha256 !== receipt.candidate.metadata.contentSha256) {
    fail("candidate contentSha256 changed since qualification");
  }

  mkdirSync(outDir, { recursive: true });
  const bundleDir = join(outDir, `kontrol-qualification-${buildId}`);
  rmSync(bundleDir, { recursive: true, force: true });
  const candidateDir = join(bundleDir, "candidate");
  mkdirSync(candidateDir, { recursive: true });
  cpSync(artifactPath, candidateDir, { recursive: true });
  cpSync(receiptPath, join(bundleDir, "beta-qualification.json"));

  const manifest = {
    kind: "kontrol-qualification-bundle",
    bundleVersion: 1,
    buildId,
    sourceGitSha: metadata.gitSha ?? receipt.candidate?.sourceGitSha,
    candidateContentSha256: metadata.contentSha256,
    files: digestTree(bundleDir),
  };
  writeFileSync(join(bundleDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const tarball = join(outDir, `kontrol-qualification-${buildId}.tgz`);
  rmSync(tarball, { force: true });
  run("tar", ["-czf", tarball, "-C", outDir, `kontrol-qualification-${buildId}`]);
  const digest = sha256File(tarball);
  writeFileSync(`${tarball}.sha256`, `${digest}  ${tarball}\n`);
  console.log(`[release-bundle] created ${tarball}`);
  console.log(`[release-bundle] sha256 ${digest}`);
  console.log(`[release-bundle] upload both files to the durable store, e.g.:`);
  console.log(`  gh release create qualification-${buildId} --draft --title "qualification ${buildId}" --notes "soak-qualified candidate" ${tarball} ${tarball}.sha256`);
  process.exit(0);
}

// ── verify ───────────────────────────────────────────────────────────────────
if (command === "verify") {
  const bundlePath = option("--bundle");
  if (!bundlePath) fail("verify requires --bundle <tarball>");
  const tarball = resolve(root, bundlePath);
  if (!existsSync(tarball)) fail(`bundle tarball missing: ${tarball}`);
  const expectBuildId = option("--expect-build-id") ?? process.env.KONTROL_RELEASE_BUILD_ID;
  const expectSourceSha = option("--expect-source-sha") ?? process.env.KONTROL_RELEASE_EXPECT_SOURCE_SHA;
  const outDir = option("--out") ? resolve(root, option("--out")) : mkdtempSync(join(tmpdir(), "kontrol-qualification-verify-"));

  // Sidecar digest, when transported: the durable store itself must not be
  // able to hand us a silently substituted tarball.
  const sidecar = `${tarball}.sha256`;
  if (existsSync(sidecar)) {
    const expected = readFileSync(sidecar, "utf8").trim().split(/\s+/)[0];
    const actual = sha256File(tarball);
    if (expected !== actual) fail(`bundle digest mismatch: sidecar says ${expected}, tarball is ${actual}`);
  }

  const extractDir = join(outDir, "bundle");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", extractDir]);
  const entries = readdirSync(extractDir);
  if (entries.length !== 1) fail(`bundle tarball must contain exactly one top-level directory, got: ${entries.join(", ")}`);
  const bundleDir = join(extractDir, entries[0]);

  const manifestPath = join(bundleDir, "manifest.json");
  if (!existsSync(manifestPath)) fail("bundle has no manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`manifest.json unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.kind !== "kontrol-qualification-bundle") fail(`not a qualification bundle (kind=${manifest.kind})`);

  // Recompute every digest. The candidate tree inside the bundle is the thing
  // that gets published; a single changed byte fails here.
  const expectedFiles = { ...manifest.files, "manifest.json": sha256File(manifestPath) };
  const actualFiles = digestTree(bundleDir);
  const changed = Object.keys(expectedFiles).filter((f) => actualFiles[f] !== expectedFiles[f]);
  const unexpected = Object.keys(actualFiles).filter((f) => !(f in expectedFiles));
  if (changed.length > 0) fail(`bundle contents modified after signing: ${changed.join(", ")}`);
  if (unexpected.length > 0) fail(`bundle contains unplanted files: ${unexpected.join(", ")}`);

  // Receipt identity inside the bundle.
  const receiptPath = join(bundleDir, "beta-qualification.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (receipt.qualified !== true || receipt.stage !== "combined") {
    fail(`bundled receipt is not a qualified combined qualification (qualified=${receipt.qualified}, stage=${receipt.stage ?? "missing"})`);
  }
  const receiptBuildId = receipt.candidate?.buildId;
  if (manifest.buildId !== receiptBuildId) fail(`manifest buildId ${manifest.buildId} != receipt buildId ${receiptBuildId}`);
  if (expectBuildId && receiptBuildId !== expectBuildId) {
    fail(`bundled qualification is for ${receiptBuildId}, not the requested ${expectBuildId}`);
  }
  const metadata = JSON.parse(readFileSync(join(bundleDir, "candidate", "build-meta.json"), "utf8"));
  if (metadata.buildId !== receiptBuildId) fail(`candidate buildId ${metadata.buildId} != receipt ${receiptBuildId}`);
  if (manifest.candidateContentSha256 && metadata.contentSha256 !== manifest.candidateContentSha256) {
    fail("candidate contentSha256 does not match the bundle manifest");
  }
  if (expectSourceSha && manifest.sourceGitSha && manifest.sourceGitSha !== expectSourceSha) {
    fail(`bundle candidate was built from ${String(manifest.sourceGitSha).slice(0, 12)}, expected ${expectSourceSha.slice(0, 12)}`);
  }

  // Full release-local validation of the bundled candidate tree.
  execFileSync(process.execPath, [join(root, "scripts", "validate-release.mjs"), join(bundleDir, "candidate")], {
    cwd: root,
    stdio: "inherit",
  });

  console.log(`[release-bundle] OK: ${receiptBuildId} (source ${String(manifest.sourceGitSha ?? "unknown").slice(0, 12)}) verified from ${tarball}`);
  console.log(`[release-bundle] candidate=${join(bundleDir, "candidate")}`);
  console.log(`[release-bundle] receipt=${receiptPath}`);
  process.exit(0);
}

fail(`unknown command: ${String(command)} (expected "create" or "verify")`);
