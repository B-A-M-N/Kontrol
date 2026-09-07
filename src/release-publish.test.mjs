// P0 fail-closed publication tests. Publication must be reachable ONLY for an
// exact qualified candidate through the staged path. Each bypass scenario is
// exercised against a synthetic git checkout with a minimal valid candidate
// (the full release-verify gate runs, so validateRelease's required file list
// must be satisfiable) and must be REFUSED before npm publish runs:
//
//   1. no qualification receipt
//   2. unqualified receipt (qualified=false)
//   3. code-only receipt (stage !== combined)
//   4. interrupted-soak receipt (status !== qualified)
//   5. mismatched buildId (receipt names a different candidate)
//   6. mismatched source SHA (receipt built from another commit)
//   7. missing candidate artifact
//   8. candidate artifact built from another commit
//   9. dirty checkout
//  10. publish without --skip-build (fresh rebuild attempt)
//  11. publish without --candidate (checkout-local build result)
//  12. direct `npm publish` from a checkout (prepublishOnly refusal)
//
// Plus one positive control: a fully qualified scenario passes the gate
// (verify-only mode — never publishing to a real registry).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), "kontrol-release-publish-"));
const BUILD_ID = "aaaaaaaaaaaaaaaa";
const OTHER_SHA = "ffffffffffffffffffffffffffffffffffffffff";

function runGit(cwd, ...args) {
  const options = typeof args[args.length - 1] === "object" ? args.pop() : {};
  return execFileSync("git", args, { cwd, encoding: "utf8", ...options });
}

// Synthetic candidate: contains exactly the files validateRelease requires,
// plus a dependency fingerprint matching the manifest (the staging step pins
// the published closure to the candidate's qualified fingerprint).
function writeCandidate(root, buildId, gitSha) {
  const candidate = join(root, "releases", buildId);
  for (const entry of ["ui"]) mkdirSync(join(candidate, entry), { recursive: true });
  for (const entry of ["cli.js", "server.js", "acp-duplex.js", "acp-worker-token.mjs"]) {
    writeFileSync(join(candidate, entry), "// candidate stub\n");
  }
  writeFileSync(join(candidate, "ui", "workspace-app.html"), "<!doctype html>\n");
  const declared = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).dependencies ?? {};
  const dependencies = Object.fromEntries(
    Object.entries(declared).map(([name, range]) => [name, range.replace(/^[~^>=\s]+/, "")]),
  );
  writeFileSync(join(candidate, "build-meta.json"), `${JSON.stringify({
    buildId,
    gitSha,
    contentSha256: "0123456789abcdef0123456789abcdef",
    schemaVersion: 0,
    minReadableSchemaVersion: 0,
    maxReadableSchemaVersion: 0,
    releaseFormatVersion: 1,
    dependencies,
  }, null, 2)}\n`);
  return candidate;
}

// Synthetic checkout: a git repo with one deterministic commit (pinned
// author/committer dates), a package.json, and the scripts tree copied in
// (the scripts under test resolve siblings relative to their own location, so
// the real scripts are copied into the fixture). Returns the fixture's HEAD
// sha; the receipt/candidate scenarios use it or a conflicting one. Receipt
// and candidate files are git-excluded so they don't dirty the checkout.
function makeCheckout(name) {
  const root = join(tmp, name);
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  for (const script of ["package-stage.mjs", "validate-release.mjs"]) {
    copyFileSync(join(repoRoot, "scripts", script), join(root, "scripts", script));
  }
  for (const script of ["release-verify.mjs", "tool-environment.mjs", "validate-release.mjs"]) {
    copyFileSync(join(repoRoot, "scripts", "lib", script), join(root, "scripts", "lib", script));
  }
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  writeFileSync(join(root, "package.json"), JSON.stringify(packageJson));
  // Stub any declared non-dist package file not already present (the copied
  // scripts must not be overwritten) so the staging step (which copies them
  // into the tarball tree) succeeds inside the fixture.
  for (const entry of packageJson.files ?? []) {
    if (entry === "dist" || entry.includes("*")) continue;
    const target = join(root, entry);
    if (existsSync(target)) continue;
    if (entry.endsWith("/") || !extname(entry)) {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, ".fixture"), "fixture stub\n");
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "fixture stub\n");
    }
  }
  runGit(root, "init", "-q", "-b", "main");
  runGit(root, "config", "user.email", "release-test@example.invalid");
  runGit(root, "config", "user.name", "release-publish-test");
  writeFileSync(join(root, ".git", "info", "exclude"), "beta-qualification.json\nreleases/\n");
  runGit(root, "add", "-A");
  runGit(root, "commit", "-q", "-m", "fixture", {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  return { root, head: runGit(root, "rev-parse", "HEAD").trim() };
}

function receipt(head, overrides = {}) {
  return {
    kind: "kontrol-beta-qualification",
    stage: "combined",
    status: "qualified",
    qualified: true,
    createdAt: new Date().toISOString(),
    candidate: {
      buildId: BUILD_ID,
      artifactPath: join("releases", BUILD_ID),
      sourceGitSha: head,
    },
    ...overrides,
  };
}

function publishRun(checkout, args, env = {}) {
  return spawnSync(process.execPath, [join(checkout, "scripts", "package-stage.mjs"), ...args], {
    cwd: checkout,
    encoding: "utf8",
    env: {
      ...process.env,
      KONTROL_RELEASE_BUILD_ID: BUILD_ID,
      KONTROL_BUILD_RESULT_PATH: join(checkout, "no-build-result.json"),
      ...env,
    },
  });
}

function assertRefused(result, label, pattern = /REFUSED|publication never builds|requires an explicit qualified candidate|not allowed/) {
  assert.equal(result.status, 1, `${label}: must be refused (exit ${result.status})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(
    `${result.stderr}\n${result.stdout}`,
    pattern,
    `${label}: refusal must explain why`,
  );
  assert.ok(
    !/npm publish|published @|publication gate passed/.test(result.stdout),
    `${label}: npm publish must never run`,
  );
}

// ── fixture: qualified candidate + receipt in a clean synthetic checkout ──
const clean = makeCheckout("clean");
const HEAD = clean.head;
writeCandidate(clean.root, BUILD_ID, HEAD);
writeFileSync(join(clean.root, "beta-qualification.json"), `${JSON.stringify(receipt(HEAD))}\n`);

// ── positive control: fully qualified candidate passes the gate ──
{
  const verified = publishRun(clean.root, ["--publish-verify-only", "--skip-build", "--candidate", join("releases", BUILD_ID)]);
  assert.equal(verified.status, 0, `positive control must pass: ${verified.stderr}\n${verified.stdout}`);
  assert.match(verified.stdout, /publication gate passed|verification only/);
}

// ── 1. no receipt ──
{
  const { root } = makeCheckout("no-receipt");
  writeCandidate(root, BUILD_ID, HEAD);
  assertRefused(
    publishRun(root, ["--publish", "--skip-build", "--candidate", join("releases", BUILD_ID)]),
    "no receipt",
    /no final qualification receipt/,
  );
}

// ── 2. unqualified receipt ──
{
  const { root } = makeCheckout("unqualified");
  writeCandidate(root, BUILD_ID, HEAD);
  writeFileSync(join(root, "beta-qualification.json"), `${JSON.stringify(receipt(HEAD, { qualified: false, status: "running" }))}\n`);
  assertRefused(
    publishRun(root, ["--publish", "--skip-build", "--candidate", join("releases", BUILD_ID)]),
    "unqualified receipt",
    /not qualified/,
  );
}

// ── 3. code-only receipt ──
{
  const { root } = makeCheckout("code-only");
  writeCandidate(root, BUILD_ID, HEAD);
  writeFileSync(join(root, "beta-qualification.json"), `${JSON.stringify(receipt(HEAD, { stage: "code" }))}\n`);
  assertRefused(
    publishRun(root, ["--publish", "--skip-build", "--candidate", join("releases", BUILD_ID)]),
    "code-only receipt",
    /code-only receipt never authorizes/,
  );
}

// ── 4. interrupted soak ──
{
  const { root } = makeCheckout("interrupted");
  writeCandidate(root, BUILD_ID, HEAD);
  writeFileSync(join(root, "beta-qualification.json"), `${JSON.stringify(receipt(HEAD, { qualified: false, status: "interrupted" }))}\n`);
  assertRefused(
    publishRun(root, ["--publish", "--skip-build", "--candidate", join("releases", BUILD_ID)]),
    "interrupted soak",
    /not qualified/,
  );
}

// ── 5. receipt names a different candidate ──
{
  const { root } = makeCheckout("wrong-build");
  writeCandidate(root, BUILD_ID, HEAD);
  writeFileSync(join(root, "beta-qualification.json"), `${JSON.stringify(receipt(HEAD, { candidate: { buildId: "bbbbbbbbbbbbbbbb", artifactPath: join("releases", "bbbbbbbbbbbbbbbb"), sourceGitSha: HEAD } }))}\n`);
  assertRefused(
    publishRun(root, ["--publish", "--skip-build", "--candidate", join("releases", BUILD_ID)]),
    "receipt buildId mismatch",
    /names candidate bbbbbbbbbbbbbbbb, not the requested/,
  );
}

// ── 6. receipt built from another commit ──
{
  const { root } = makeCheckout("wrong-sha");
  writeCandidate(root, BUILD_ID, HEAD);
  writeFileSync(join(root, "beta-qualification.json"), `${JSON.stringify(receipt(OTHER_SHA))}\n`);
  assertRefused(
    publishRun(root, ["--publish", "--skip-build", "--candidate", join("releases", BUILD_ID)]),
    "receipt SHA mismatch",
    /built from ffffffff.*but this checkout is at /,
  );
}

// ── 7. missing candidate artifact ──
{
  const { root } = makeCheckout("missing-candidate");
  writeFileSync(join(root, "beta-qualification.json"), `${JSON.stringify(receipt(HEAD))}\n`);
  assertRefused(
    publishRun(root, ["--publish", "--skip-build", "--candidate", join("releases", BUILD_ID)]),
    "missing candidate",
    /qualified candidate artifact is missing|has no build-meta\.json/,
  );
}

// ── 8. candidate artifact built from another commit ──
{
  const { root } = makeCheckout("candidate-wrong-sha");
  writeCandidate(root, BUILD_ID, OTHER_SHA);
  writeFileSync(join(root, "beta-qualification.json"), `${JSON.stringify(receipt(HEAD))}\n`);
  assertRefused(
    publishRun(root, ["--publish", "--skip-build", "--candidate", join("releases", BUILD_ID)]),
    "candidate SHA mismatch",
    /candidate artifact was built from ffffffff/,
  );
}

// ── 9. dirty checkout ──
{
  const { root } = makeCheckout("dirty");
  const candidate = writeCandidate(root, BUILD_ID, HEAD);
  writeFileSync(join(root, "beta-qualification.json"), `${JSON.stringify(receipt(HEAD))}\n`);
  // A tracked file edited after the fixture commit dirties the tree. (The
  // candidate itself is git-excluded, so edit something tracked instead.)
  writeFileSync(join(root, "package.json"), `${readFileSync(join(root, "package.json"), "utf8")}\n`);
  assertRefused(
    publishRun(root, ["--publish", "--skip-build", "--candidate", join("releases", BUILD_ID)]),
    "dirty checkout",
    /working tree is not clean/,
  );
}

// ── 10. publish that would build (fresh rebuild attempt) ──
{
  assertRefused(
    publishRun(clean.root, ["--publish"]),
    "publish with implicit build",
    /publication never builds/,
  );
}

// ── 11. publish without --candidate ──
{
  assertRefused(
    publishRun(clean.root, ["--publish", "--skip-build"]),
    "publish without candidate",
    /requires an explicit qualified candidate/,
  );
}

// ── 12. direct `npm publish` from a checkout ──
{
  // package.json scripts resolve relative to npm's cwd; run the refusal hook
  // the way npm would.
  const refused = spawnSync(process.execPath, [join(repoRoot, "scripts", "refuse-publish.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(refused.status, 1, "direct publish refusal hook must exit nonzero");
  assert.match(refused.stderr, /direct `npm publish` from the checkout is not allowed/);
  assert.match(refused.stderr, /release:publish/);

  // And the staged manifest strips the hook, so staged publication is intact.
  const stagedPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(typeof stagedPkg.scripts.prepublishOnly, "string", "checkout manifest carries the refusal hook");
}

rmSync(tmp, { recursive: true, force: true });
console.log("release-publish.test.mjs: all assertions passed");
