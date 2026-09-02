import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateRelease } from "../scripts/validate-release.mjs";

const repoRoot = process.cwd();
const fixtureRoot = mkdtempSync(join(tmpdir(), "kontrol-release-fixture-"));

function writeRequiredFiles(artifact) {
  mkdirSync(join(artifact, "ui"), { recursive: true });
  writeFileSync(join(artifact, "build-meta.json"), JSON.stringify({
    buildId: "fixture",
    contentSha256: "0123456789abcdef",
    schemaVersion: 50,
    minReadableSchemaVersion: 0,
    maxReadableSchemaVersion: 50,
    releaseFormatVersion: 3,
  }) + "\n");
  for (const file of ["cli.js", "server.js", "acp-duplex.js", "acp-worker-token.mjs"]) {
    writeFileSync(join(artifact, file), "export {};\n");
  }
  writeFileSync(join(artifact, "ui", "workspace-app.html"), "<!doctype html>\n");
}

try {
  const badArtifact = join(fixtureRoot, "bad");
  const externalModule = join(fixtureRoot, "external.mjs");
  mkdirSync(badArtifact, { recursive: true });
  writeRequiredFiles(badArtifact);
  writeFileSync(externalModule, "export const escaped = true;\n");
  writeFileSync(join(badArtifact, "acp-worker-token.mjs"), 'export * from "../external.mjs";\n');
  assert.throws(
    () => validateRelease(badArtifact),
    /escapes release/,
    "a relocated release must reject an import that resolves outside its artifact",
  );

  const absoluteBadArtifact = join(fixtureRoot, "absolute-bad");
  mkdirSync(absoluteBadArtifact, { recursive: true });
  writeRequiredFiles(absoluteBadArtifact);
  writeFileSync(join(absoluteBadArtifact, "cli.js"), `import ${JSON.stringify(externalModule)};\n`);
  assert.throws(
    () => validateRelease(absoluteBadArtifact),
    /escapes release/,
    "a release must reject absolute file imports into the source checkout",
  );

  const layoutBadArtifact = join(fixtureRoot, "layout-bad");
  mkdirSync(layoutBadArtifact, { recursive: true });
  writeRequiredFiles(layoutBadArtifact);
  writeFileSync(join(layoutBadArtifact, "cli.js"), "import 'scripts/lib/acp-worker-token.mjs';\n");
  assert.throws(
    () => validateRelease(layoutBadArtifact),
    /forbidden application import/,
    "a release must reject bare imports that depend on repository layout",
  );

  const goodArtifact = join(fixtureRoot, "good");
  mkdirSync(goodArtifact, { recursive: true });
  writeRequiredFiles(goodArtifact);
  assert.equal(validateRelease(goodArtifact).buildId, "fixture");

  // The atomic builder produces an immutable candidate but must not move or
  // replace the active dist projection. This is the incident regression that
  // prevents a failed candidate from erasing the last-known-good generation.
  const distPath = join(repoRoot, "dist");
  const originalDist = lstatSync(distPath);
  const originalDistTarget = originalDist.isSymbolicLink() ? readlinkSync(distPath) : undefined;
  const resultPath = join(fixtureRoot, "build-result.json");
  execFileSync("npm", ["run", "build"], {
    cwd: repoRoot,
    env: { ...process.env, KONTROL_BUILD_RESULT_PATH: resultPath },
    stdio: "ignore",
  });
  const afterDist = lstatSync(distPath);
  assert.equal(afterDist.isSymbolicLink(), originalDist.isSymbolicLink(), "atomic build must preserve dist node type");
  if (originalDistTarget !== undefined) assert.equal(readlinkSync(distPath), originalDistTarget, "atomic build must not rotate dist");
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.match(result.artifactPath, /releases\//);
  assert.equal(existsSync(join(result.artifactPath, "acp-worker-token.mjs")), true);
  const metadata = JSON.parse(readFileSync(join(result.artifactPath, "build-meta.json"), "utf8"));
  assert.equal(metadata.schemaVersion, metadata.maxReadableSchemaVersion);
  assert.equal(metadata.minReadableSchemaVersion, 0);
  assert.equal(metadata.schemaCompatibility, "upgrade-in-place; downgrade-via-versioned-backup");
  assert.equal(metadata.releaseFormatVersion, 3);
  assert.match(metadata.contentSha256, /^[a-f0-9]{16}$/);

  // Exercise the exact release probe used by start-all.sh. Static required-file
  // checks alone would not catch a relocated module whose import resolves
  // outside the immutable artifact.
  execFileSync(process.execPath, ["scripts/probe-release.mjs", "--boot", result.artifactPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  console.log("release-artifact.test.mjs: release closure, real boot probe, and non-promoting build passed");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
