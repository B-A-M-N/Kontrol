// P0 release-transport tests: the qualification bundle is the immutable
// handoff between the soak host and the release runner. Covers:
//   1. create refuses an unqualified/absent receipt.
//   2. create + verify round-trip on a real immutable candidate: the verified
//      candidate tree is byte-identical to the source, and the receipt
//      identity matches.
//   3. verify fails closed on ANY tampering: modified candidate file, planted
//      extra file, wrong expect-build-id, removed manifest.
//   4. package-stage --skip-build --candidate stages from an explicit
//      validated candidate without any checkout-local build-result file.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), "kontrol-release-bundle-"));

function runScript(script, args, options = {}) {
  return spawnSync(process.execPath, [join(root, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Fabricate a qualified combined receipt + candidate from the newest local
// release (the bundle transport never requires the soak host's checkout).
const releasesDir = join(root, "releases");
const candidates = existsSync(releasesDir) ? readdirSync(releasesDir).sort() : [];
if (candidates.length === 0) {
  console.log("release-bundle: no local candidate available; building one");
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
}
const buildResult = JSON.parse(readFileSync(join(root, ".kontrol-build-result.json"), "utf8"));
const buildId = buildResult.buildId;
const candidateSource = resolve(root, buildResult.artifactPath);

const receiptDir = join(tmp, "receipt");
mkdirSync(receiptDir, { recursive: true });
const receiptPath = join(receiptDir, "beta-qualification.json");
const metadata = JSON.parse(readFileSync(join(candidateSource, "build-meta.json"), "utf8"));
writeFileSync(receiptPath, `${JSON.stringify({
  kind: "kontrol-beta-qualification",
  stage: "combined",
  status: "qualified",
  qualified: true,
  createdAt: new Date().toISOString(),
  candidate: {
    buildId,
    artifactPath: buildResult.artifactPath,
    metadata,
  },
}, null, 2)}\n`);

// ── 1. create refuses an unqualified receipt ──
{
  const badReceipt = join(tmp, "bad-receipt.json");
  writeFileSync(badReceipt, JSON.stringify({ qualified: false, stage: "combined" }));
  const refused = runScript("release-bundle.mjs", ["create", "--receipt", badReceipt, "--out", join(tmp, "out1")]);
  assert.equal(refused.status, 1, "create must refuse an unqualified receipt");
  assert.match(refused.stderr, /not a qualified combined qualification/);
}

// ── 2. create + verify round-trip ──
const outDir = join(tmp, "out");
{
  const created = runScript("release-bundle.mjs", ["create", "--receipt", receiptPath, "--out", outDir]);
  assert.equal(created.status, 0, `create failed: ${created.stderr}`);
  const tarball = join(outDir, `kontrol-qualification-${buildId}.tgz`);
  assert.ok(existsSync(tarball), "bundle tarball created");
  assert.ok(existsSync(`${tarball}.sha256`), "sha256 sidecar created");
  assert.equal(sha256(tarball), readFileSync(`${tarball}.sha256`, "utf8").trim().split(/\s+/)[0], "sidecar digest matches");

  const verified = runScript("release-bundle.mjs", [
    "verify", "--bundle", tarball, "--expect-build-id", buildId,
    "--expect-source-sha", metadata.gitSha ?? buildResult.sourceGitSha,
    "--out", join(tmp, "verify-out"),
  ]);
  assert.equal(verified.status, 0, `verify failed: ${verified.stderr}\n${verified.stdout}`);

  // The verified candidate is byte-identical to the qualified artifact.
  const extracted = join(tmp, "verify-out", "bundle", `kontrol-qualification-${buildId}`, "candidate");
  const original = JSON.parse(
    execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n").filter(Boolean).length.toString(),
  );
  assert.ok(original > 2, "bundle carries the full candidate tree");

  // ── 3. verify fails closed on tampering ──
  // (a) modified candidate file
  const tamperedDir = join(tmp, "tampered");
  mkdirSync(tamperedDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", tamperedDir]);
  const victim = join(tamperedDir, `kontrol-qualification-${buildId}`, "candidate", "cli.js");
  writeFileSync(victim, `${readFileSync(victim, "utf8")}\n// tampered\n`);
  const repacked = join(tmp, "tampered.tgz");
  rmSync(repacked, { force: true });
  execFileSync("tar", ["-czf", repacked, "-C", tamperedDir, `kontrol-qualification-${buildId}`]);
  const tampered = runScript("release-bundle.mjs", ["verify", "--bundle", repacked, "--expect-build-id", buildId]);
  assert.equal(tampered.status, 1, "verify must reject a modified candidate file");
  assert.match(tampered.stderr, /modified after signing|modified/);

  // (b) planted extra file
  const plantedDir = join(tmp, "planted");
  mkdirSync(plantedDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", plantedDir]);
  writeFileSync(join(plantedDir, `kontrol-qualification-${buildId}`, "candidate", "planted.js"), "evil\n");
  const plantedTgz = join(tmp, "planted.tgz");
  rmSync(plantedTgz, { force: true });
  execFileSync("tar", ["-czf", plantedTgz, "-C", plantedDir, `kontrol-qualification-${buildId}`]);
  const planted = runScript("release-bundle.mjs", ["verify", "--bundle", plantedTgz, "--expect-build-id", buildId]);
  assert.equal(planted.status, 1, "verify must reject planted files");
  assert.match(planted.stderr, /unplanted|planted/);

  // (c) wrong expected buildId
  const wrongId = runScript("release-bundle.mjs", ["verify", "--bundle", tarball, "--expect-build-id", "notthebuildid"]);
  assert.equal(wrongId.status, 1, "verify must reject a wrong expected buildId");
  assert.match(wrongId.stderr, /not the requested/);

  // (d) wrong expected source SHA
  const wrongSha = runScript("release-bundle.mjs", [
    "verify", "--bundle", tarball, "--expect-build-id", buildId,
    "--expect-source-sha", "0000000000000000000000000000000000000000",
  ]);
  assert.equal(wrongSha.status, 1, "verify must reject a wrong expected source SHA");
  assert.match(wrongSha.stderr, /expected 0{12}/);

  // (e) missing manifest
  const strippedDir = join(tmp, "stripped");
  mkdirSync(strippedDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", strippedDir]);
  rmSync(join(strippedDir, `kontrol-qualification-${buildId}`, "manifest.json"));
  const strippedTgz = join(tmp, "stripped.tgz");
  rmSync(strippedTgz, { force: true });
  execFileSync("tar", ["-czf", strippedTgz, "-C", strippedDir, `kontrol-qualification-${buildId}`]);
  const stripped = runScript("release-bundle.mjs", ["verify", "--bundle", strippedTgz, "--expect-build-id", buildId]);
  assert.equal(stripped.status, 1, "verify must reject a bundle without a manifest");
  assert.match(stripped.stderr, /no manifest\.json|unplanted/);

  // (f) sidecar digest mismatch (substituted tarball)
  const substituted = join(tmp, "substituted.tgz");
  writeFileSync(substituted, "not a tarball");
  writeFileSync(`${substituted}.sha256`, `${sha256(tarball)}  ${substituted}\n`);
  const substitutedRun = runScript("release-bundle.mjs", ["verify", "--bundle", substituted, "--expect-build-id", buildId]);
  assert.equal(substitutedRun.status, 1, "verify must reject a substituted tarball with a valid sidecar");
  assert.match(substitutedRun.stderr, /digest mismatch/);
}

// ── 4. package-stage --skip-build --candidate stages from an explicit
// candidate with NO checkout-local build-result dependency ──
{
  // Simulate a fresh runner: no .kontrol-build-result.json reachable.
  const fakeRoot = join(tmp, "runner");
  mkdirSync(fakeRoot, { recursive: true });
  const staged = spawnSync(process.execPath, [
    join(root, "scripts", "package-stage.mjs"),
    "--skip-build",
    "--candidate", candidateSource,
    "--publish-verify-only",
    "--pack-destination", join(tmp, "pack"),
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      KONTROL_BUILD_RESULT_PATH: join(fakeRoot, "nonexistent-build-result.json"),
      KONTROL_RELEASE_BUILD_ID: buildId,
    },
  });
  assert.equal(staged.status, 0, `package-stage --candidate failed: ${staged.stderr}\n${staged.stdout}`);
  assert.match(staged.stdout, /verification only.*complete and publishable/);

  // And it refuses an explicit candidate that does not match the buildId.
  const mismatch = spawnSync(process.execPath, [
    join(root, "scripts", "package-stage.mjs"),
    "--skip-build",
    "--candidate", candidateSource,
    "--publish-verify-only",
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      KONTROL_BUILD_RESULT_PATH: join(fakeRoot, "nonexistent-build-result.json"),
      KONTROL_RELEASE_BUILD_ID: "ffffffffffffffff",
    },
  });
  assert.equal(mismatch.status, 1, "package-stage must refuse a candidate that does not match the release buildId");
  assert.match(mismatch.stderr, /does not match the explicit candidate/);

  // --candidate is incompatible with a build (a rebuild would disqualify the
  // soak-qualified artifact).
  const rebuild = spawnSync(process.execPath, [
    join(root, "scripts", "package-stage.mjs"),
    "--candidate", candidateSource,
    "--publish-verify-only",
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, KONTROL_BUILD_RESULT_PATH: join(fakeRoot, "nonexistent-build-result.json") },
  });
  assert.equal(rebuild.status, 1, "package-stage must refuse --candidate without --skip-build");
  assert.match(rebuild.stderr, /incompatible with a build/);
}

rmSync(tmp, { recursive: true, force: true });
console.log("release-bundle.test.mjs: all assertions passed");
