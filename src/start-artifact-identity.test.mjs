// P0 regression: `npm start` in a source checkout must never launch a stale
// dist/ projection. scripts/start.mjs resolves the artifact explicitly from
// the atomic build result / committed projection / identity-verified dist and
// REFUSES anything whose build identity does not match the checkout. Each
// case stages a fixture checkout and drives the real resolver.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function stageCheckout({ withGit = true, head = "3c5d57caudit0000000000000000000000000000" } = {}) {
  const checkout = mkdtempSync(join(tmpdir(), "kontrol-start-id-"));
  mkdirSync(join(checkout, "src"), { recursive: true });
  writeFileSync(join(checkout, "src", "cli.ts"), "// fixture\n");
  if (withGit) {
    // A .git directory is enough for isSourceCheckout(); gitHead() is
    // injected per-case so no real repo is needed.
    mkdirSync(join(checkout, ".git"), { recursive: true });
  }
  return checkout;
}

function stageRelease(checkout, { buildId, gitSha, gitDirty = 0 }) {
  const release = join(checkout, "releases", buildId);
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "cli.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(release, "build-meta.json"), `${JSON.stringify({ buildId, gitSha, gitDirty, version: "0.0.0-test" })}\n`);
  return release;
}

function stageDist(checkout, meta) {
  const dist = join(checkout, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "cli.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(dist, "build-meta.json"), `${JSON.stringify(meta)}\n`);
  return dist;
}

function resolveIn(checkout, options = {}) {
  const callOptions = {
    sourceCheckout: true,
    root: checkout,
    gitHead: options.head ?? "3c5d57caudit0000000000000000000000000000",
    allowDirty: options.allowDirty === true,
  };
  const script = [
    "import { resolveStartArtifact } from",
    `  ${JSON.stringify(join(repoRoot, "scripts", "start.mjs"))};`,
    `process.stdout.write(JSON.stringify(resolveStartArtifact(${JSON.stringify(callOptions)})));`,
  ].join("\n");
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  if (options.buildResultPath !== undefined) env.KONTROL_BUILD_RESULT_PATH = options.buildResultPath;
  const out = execFileSync(
    process.execPath,
    ["--import", join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs"), "--input-type=module", "-e", script],
    { cwd: checkout, env, encoding: "utf8" },
  );
  return JSON.parse(out.trim());
}

// 1. Atomic build result present: its artifactPath wins and its identity is
//    verified against the release's build-meta.json.
{
  const checkout = stageCheckout();
  const release = stageRelease(checkout, { buildId: "aaaaaaaaaaaaaaaa", gitSha: "f".repeat(40) });
  writeFileSync(join(checkout, ".kontrol-build-result.json"), `${JSON.stringify({ buildId: "aaaaaaaaaaaaaaaa", artifactPath: release })}\n`);
  const resolved = resolveIn(checkout);
  assert.equal(resolved.refusal, undefined, "build result path must resolve");
  assert.equal(resolved.artifactPath, release);
  assert.equal(resolved.buildId, "aaaaaaaaaaaaaaaa");
  rmSync(checkout, { recursive: true, force: true });
}

// 2. Build result naming a MISSING artifact must be refused, not fallen
//    through to dist/.
{
  const checkout = stageCheckout();
  writeFileSync(
    join(checkout, ".kontrol-build-result.json"),
    `${JSON.stringify({ buildId: "bbbbbbbbbbbbbbbb", artifactPath: join(checkout, "releases", "gone") })}\n`,
  );
  stageDist(checkout, { buildId: "cccccccccccccccc", gitSha: "f".repeat(40) });
  const resolved = resolveIn(checkout);
  assert.ok(resolved.refusal, "missing artifact from build result must refuse");
  assert.match(resolved.reason, /no longer exists/);
  rmSync(checkout, { recursive: true, force: true });
}

// 3. Identity mismatch between the build result and the release directory
//    must refuse.
{
  const checkout = stageCheckout();
  const release = stageRelease(checkout, { buildId: "dddddddddddddddd", gitSha: "f".repeat(40) });
  writeFileSync(
    join(checkout, ".kontrol-build-result.json"),
    `${JSON.stringify({ buildId: "eeeeeeeeeeeeeeee", artifactPath: release })}\n`,
  );
  const resolved = resolveIn(checkout);
  assert.ok(resolved.refusal, "build-id mismatch must refuse");
  assert.match(resolved.reason, /does not match artifact/);
  rmSync(checkout, { recursive: true, force: true });
}

// 4. THE core regression: a regular dist/ built from a DIFFERENT git SHA is
//    stale and must never launch.
{
  const checkout = stageCheckout();
  const head = "3c5d57caudit0000000000000000000000000000";
  stageDist(checkout, { buildId: "d063391stale0000", gitSha: "d06339148a2786e789429a994e7d40f39682097c", gitDirty: 0 });
  const resolved = resolveIn(checkout, { head });
  assert.ok(resolved.refusal, "stale dist must be refused");
  assert.match(resolved.reason, /stale projection/);
  assert.match(resolved.reason, /npm run build/, "refusal must name the remediation");
  rmSync(checkout, { recursive: true, force: true });
}

// 5. A dist/ matching HEAD is acceptable when no build result exists.
{
  const checkout = stageCheckout();
  const head = "3c5d57caudit0000000000000000000000000000";
  stageDist(checkout, { buildId: "ffffffffffffffff", gitSha: head, gitDirty: 0 });
  const resolved = resolveIn(checkout, { head });
  assert.equal(resolved.refusal, undefined, "dist matching HEAD must resolve");
  assert.equal(resolved.buildId, "ffffffffffffffff");
  rmSync(checkout, { recursive: true, force: true });
}

// 6. A dist/ built from a dirty checkout is refused for release semantics
//    unless explicitly allowed.
{
  const checkout = stageCheckout();
  const head = "3c5d57caudit0000000000000000000000000000";
  stageDist(checkout, { buildId: "1111111111111111", gitSha: head, gitDirty: 54 });
  const refused = resolveIn(checkout, { head });
  assert.ok(refused.refusal, "dirty-built dist must refuse by default");
  assert.match(refused.reason, /dirty checkout/);
  const allowed = resolveIn(checkout, { head, allowDirty: true });
  assert.equal(allowed.refusal, undefined, "explicit allowDirty may launch a dirty-built dist");
  rmSync(checkout, { recursive: true, force: true });
}

// 7. dist/ as a committed symlink into releases/ is trusted.
{
  const checkout = stageCheckout();
  const release = stageRelease(checkout, { buildId: "2222222222222222", gitSha: "f".repeat(40) });
  symlinkSync(release, join(checkout, "dist"), "dir");
  const resolved = resolveIn(checkout);
  assert.equal(resolved.refusal, undefined, "committed dist symlink must resolve");
  assert.equal(resolved.artifactPath, release);
  assert.equal(resolved.buildId, "2222222222222222");
  rmSync(checkout, { recursive: true, force: true });
}

// 8. No artifact at all must refuse with remediation.
{
  const checkout = stageCheckout();
  const resolved = resolveIn(checkout);
  assert.ok(resolved.refusal, "missing artifact must refuse");
  assert.match(resolved.reason, /No built artifact found/);
  rmSync(checkout, { recursive: true, force: true });
}

// 9. End to end through the real launcher: a stale dist makes `npm start`
//    exit non-zero WITHOUT spawning a server (resolve-only probe).
{
  const checkout = stageCheckout();
  stageDist(checkout, { buildId: "d063391stale0000", gitSha: "d06339148a2786e789429a994e7d40f39682097c", gitDirty: 0 });
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "start.mjs")],
    {
      cwd: checkout,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        KONTROL_START_RESOLVE_ONLY: "true",
        // Isolate the fixture from this checkout's real build result.
        KONTROL_BUILD_RESULT_PATH: join(checkout, "no-build-result.json"),
      },
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 1, `stale dist must exit 1, got ${result.status}`);
  // Without a resolvable git HEAD the fixture cannot match SHA identity, so
  // the launcher may refuse either as stale or as a dirty-built projection —
  // both are identity refusals and both must be explained on stderr.
  assert.match(result.stderr ?? "", /(stale projection|dirty checkout)/, "refusal must be explained on stderr");
  rmSync(checkout, { recursive: true, force: true });
}

console.log("start-artifact-identity.test.mjs: build→start identity regression suite passed");
