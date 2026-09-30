import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const releaseRoot = mkdtempSync(join(tmpdir(), "kontrol-wa-release-registry-"));
const releases = join(releaseRoot, "releases");
const currentRelease = join(releases, "current-build");
const previousRelease = join(releases, "previous-build");
const lastKnownGoodRelease = join(releases, "last-good-build");
const stateDir = join(releaseRoot, "state");
const appHtml = (label) => [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="UTF-8"><title>Kontrol Diff</title>',
  "<style>#app{color:red}</style>",
  "</head><body><main id=\"app\"></main>",
  `<script>window.__KONTROL_WORKSPACE_APP_BOOTSTRAPPED=true;/* ${label} */</script>`,
  "</body></html>",
].join("\n");

const currentHtml = appHtml("current");
const previousHtml = appHtml("previous");
const lastKnownGoodHtml = appHtml("last-known-good");
const currentHtmlPath = join(currentRelease, "ui", "workspace-app.html");
const previousHtmlPath = join(previousRelease, "ui", "workspace-app.html");
const lastKnownGoodHtmlPath = join(lastKnownGoodRelease, "ui", "workspace-app.html");
const previousOverride = process.env.KONTROL_WORKSPACE_APP_HTML_PATH;

try {
  for (const release of [currentRelease, previousRelease, lastKnownGoodRelease]) {
    mkdirSync(join(release, "ui"), { recursive: true });
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(currentHtmlPath, currentHtml);
  writeFileSync(previousHtmlPath, previousHtml);
  writeFileSync(lastKnownGoodHtmlPath, lastKnownGoodHtml);
  writeFileSync(join(stateDir, "generation.json"), JSON.stringify({
    status: "rolled_back",
    artifactPath: currentRelease,
    previousBuildId: "previous-build",
    previousArtifactPath: previousRelease,
    lastKnownGoodBuildId: "last-good-build",
    lastKnownGoodArtifactPath: lastKnownGoodRelease,
  }));

  process.env.KONTROL_WORKSPACE_APP_HTML_PATH = currentHtmlPath;
  const resourceModule = await import(`./workspace-app-resource.ts?registry-test=${Date.now()}`);
  resourceModule.configureWorkspaceAppResourceRegistry(stateDir);
  const entries = resourceModule.workspaceAppResourceEntries();
  const previousId = createHash("sha256").update(previousHtml).digest("hex").slice(0, 12);
  const lastGoodId = createHash("sha256").update(lastKnownGoodHtml).digest("hex").slice(0, 12);
  const previous = resourceModule.workspaceAppResource(`ui://kontrol/workspace-app-${previousId}.html`);
  const lastGood = resourceModule.workspaceAppResource(`ui://kontrol/workspace-app-${lastGoodId}.html`);

  assert.equal(previous?.kind, "previous");
  assert.equal(previous?.html, previousHtml, "the immediate previous hash maps to its exact HTML");
  assert.equal(lastGood?.kind, "previous");
  assert.equal(lastGood?.html, lastKnownGoodHtml, "the distinct last-known-good hash maps to its exact HTML");
  assert.equal(entries.filter((entry) => entry.kind === "previous").length, 2, "the previous-artifact set is bounded");
  assert.equal(entries.find((entry) => entry.kind === "current")?.html, currentHtml);
  assert.equal(resourceModule.workspaceAppResource("ui://kontrol/workspace-app-000000000000.html"), undefined,
    "an unknown hash must not alias to the current bundle");
  console.log("workspace-app-resource-registry.test.mjs: exact previous artifact retention passed");
} finally {
  if (previousOverride === undefined) delete process.env.KONTROL_WORKSPACE_APP_HTML_PATH;
  else process.env.KONTROL_WORKSPACE_APP_HTML_PATH = previousOverride;
  rmSync(releaseRoot, { recursive: true, force: true });
}
