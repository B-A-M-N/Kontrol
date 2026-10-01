import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const releaseRoot = mkdtempSync(join(tmpdir(), "kontrol-wa-release-registry-"));
const releases = join(releaseRoot, "releases");
const currentRelease = join(releases, "current-build");
const historicalReleases = Array.from({ length: 9 }, (_, index) => join(releases, `history-build-${index + 1}`));
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
const currentHtmlPath = join(currentRelease, "ui", "workspace-app.html");
const previousOverride = process.env.KONTROL_WORKSPACE_APP_HTML_PATH;
const history = historicalReleases.map((release, index) => {
  const releaseBuildId = `history-build-${index + 1}`;
  const html = appHtml(`historical-${index + 1}`);
  const workspaceAppBuildId = createHash("sha256").update(html).digest("hex").slice(0, 12);
  const buildTimestamp = new Date(Date.now() - (index + 1) * 60_000).toISOString();
  return { release, releaseBuildId, html, workspaceAppBuildId, buildTimestamp };
});

try {
  for (const release of [currentRelease, ...historicalReleases]) {
    mkdirSync(join(release, "ui"), { recursive: true });
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(currentHtmlPath, currentHtml);
  for (const item of history) {
    writeFileSync(join(item.release, "ui", "workspace-app.html"), item.html);
    writeFileSync(join(item.release, "build-meta.json"), JSON.stringify({
      buildId: item.releaseBuildId,
      workspaceAppBuildId: item.workspaceAppBuildId,
      buildTimestamp: item.buildTimestamp,
    }));
  }
  const currentBuildId = createHash("sha256").update(currentHtml).digest("hex").slice(0, 12);
  writeFileSync(join(currentRelease, "build-meta.json"), JSON.stringify({
    buildId: "current-build",
    workspaceAppBuildId: currentBuildId,
    workspaceAppHistory: history.map(({ releaseBuildId, workspaceAppBuildId, buildTimestamp }) => ({ releaseBuildId, workspaceAppBuildId, buildTimestamp })),
  }));
  writeFileSync(join(stateDir, "generation.json"), JSON.stringify({
    status: "rolled_back",
    artifactPath: currentRelease,
    previousBuildId: history[0].releaseBuildId,
    previousArtifactPath: history[0].release,
    lastKnownGoodBuildId: history[1].releaseBuildId,
    lastKnownGoodArtifactPath: history[1].release,
  }));

  process.env.KONTROL_WORKSPACE_APP_HTML_PATH = currentHtmlPath;
  const resourceModule = await import(`./workspace-app-resource.ts?registry-test=${Date.now()}`);
  resourceModule.configureWorkspaceAppResourceRegistry(stateDir);
  const entries = resourceModule.workspaceAppResourceEntries();
  for (const item of history) {
    const modernUri = `ui://kontrol/workspace-app-${item.workspaceAppBuildId}.html`;
    const skybridgeUri = `ui://kontrol/workspace-app-${item.workspaceAppBuildId}.skybridge.html`;
    const modern = resourceModule.workspaceAppResource(modernUri);
    const skybridge = resourceModule.workspaceAppResource(skybridgeUri);
    assert.equal(modern?.kind, "previous");
    assert.equal(modern?.html, undefined, "historical HTML must remain unloaded until requested");
    assert.equal(modern?.mimeType, "text/html;profile=mcp-app");
    assert.equal(resourceModule.workspaceAppResourceHtml(modern), item.html, "each retained modern URI maps to its exact historical HTML");
    assert.equal(skybridge?.mimeType, "text/html+skybridge");
    assert.equal(resourceModule.workspaceAppResourceHtml(skybridge), item.html, "each retained compatibility URI maps to the same exact historical HTML");
  }
  assert.equal(entries.filter((entry) => entry.kind === "previous").length, history.length * 2,
    "all nine previous builds retain both standards-based and compatibility resource URIs");
  assert.equal(entries.find((entry) => entry.kind === "current")?.html, currentHtml);
  assert.equal(resourceModule.workspaceAppResource("ui://kontrol/workspace-app-000000000000.html"), undefined,
    "an unknown hash must not alias to the current bundle");
  assert.equal(resourceModule.workspaceAppResource("ui://kontrol/workspace-app-000000000000.skybridge.html"), undefined,
    "an unknown compatibility hash must not alias to the current bundle");
  assert.equal(resourceModule.isWorkspaceAppHashedUri("ui://kontrol/workspace-app-000000000000.skybridge.html"), true,
    "unknown hashed compatibility resources must still be classified as stale hashes");
  const tampered = history[8];
  writeFileSync(join(tampered.release, "ui", "workspace-app.html"), appHtml("tampered"));
  assert.throws(
    () => resourceModule.workspaceAppResourceHtml(resourceModule.workspaceAppResource(`ui://kontrol/workspace-app-${tampered.workspaceAppBuildId}.html`)),
    /does not match its immutable build identity/,
    "lazy historical reads must fail closed if an immutable artifact was changed",
  );
  console.log("workspace-app-resource-registry.test.mjs: bounded lazy historical artifact retention passed");
} finally {
  if (previousOverride === undefined) delete process.env.KONTROL_WORKSPACE_APP_HTML_PATH;
  else process.env.KONTROL_WORKSPACE_APP_HTML_PATH = previousOverride;
  rmSync(releaseRoot, { recursive: true, force: true });
}
