// P0 regression: source-mode Workspace App resolution must never serve the
// Vite input template. The resolver in src/workspace-app-resource.ts refuses
// non-self-contained HTML and requires an explicitly built artifact in a
// source checkout. This suite exercises the resolver's decision rules against
// on-disk fixture trees with real tsx imports of the module under test.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));

// A minimal self-contained app body: inlined script, no external references.
const SELF_CONTAINED_HTML = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="UTF-8"><title>Kontrol Diff</title>',
  "<style>#app{color:red}</style>",
  "</head><body><main id=\"app\"></main>",
  "<script>(function(){window.__KONTROL_WORKSPACE_APP_BOOTSTRAPPED=true})();</script>",
  "</body></html>",
].join("\n");

// The actual Vite input template shape — external stylesheet + module script.
const VITE_TEMPLATE_HTML = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="UTF-8"><title>Kontrol Diff</title>',
  '<link rel="stylesheet" href="./workspace-app.css" />',
  "</head><body><main id=\"app\" class=\"shell\"></main>",
  '<script type="module" src="./workspace-app.tsx"></script>',
  "</body></html>",
].join("\n");

// Runs src/workspace-app-resource.ts under tsx in a working directory where
// the candidate layout has been staged, and prints the module's exported
// resolution facts (or its rejection) as JSON.
const TSX_LOADER = join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");
function resolveIn(cwd, env = {}) {
  const script = [
    "import { WORKSPACE_APP_HTML, WORKSPACE_APP_ARTIFACT_SOURCE } from",
    `  ${JSON.stringify(join(repoRoot, "src", "workspace-app-resource.ts"))};`,
    "process.stdout.write(JSON.stringify({",
    "  html: WORKSPACE_APP_HTML,",
    "  provenance: WORKSPACE_APP_ARTIFACT_SOURCE.provenance,",
    "  path: WORKSPACE_APP_ARTIFACT_SOURCE.path,",
    "}));",
  ].join("\n");
  const result = execFileSync(process.execPath, ["--import", TSX_LOADER, "--input-type=module", "-e", script], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
  });
  return JSON.parse(result);
}

function expectResolutionFailure(cwd, env = {}) {
  const script = [
    "import { WORKSPACE_APP_HTML } from",
    `  ${JSON.stringify(join(repoRoot, "src", "workspace-app-resource.ts"))};`,
    "process.stdout.write(String(WORKSPACE_APP_HTML.length));",
  ].join("\n");
  try {
    execFileSync(process.execPath, ["--import", TSX_LOADER, "--input-type=module", "-e", script], {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return error.stderr.toString();
  }
  assert.fail("expected the resolver to reject this layout");
}

function stageSourceCheckoutLayout(withDistArtifact, artifactHtml = SELF_CONTAINED_HTML) {
  const checkout = mkdtempSync(join(tmpdir(), "kontrol-wa-resolver-"));
  mkdirSync(join(checkout, "src", "ui"), { recursive: true });
  // The source tree ALWAYS has the Vite template; the resolver must never
  // choose it regardless of what else exists.
  writeFileSync(join(checkout, "src", "ui", "workspace-app.html"), VITE_TEMPLATE_HTML);
  if (withDistArtifact) {
    mkdirSync(join(checkout, "dist", "ui"), { recursive: true });
    writeFileSync(join(checkout, "dist", "ui", "workspace-app.html"), artifactHtml);
  }
  return checkout;
}

// 1. The real Vite template must be structurally rejected if it ever ends up
//    in a candidate position.
{
  const checkout = stageSourceCheckoutLayout(false);
  try {
    mkdirSync(join(checkout, "dist", "ui"), { recursive: true });
    writeFileSync(join(checkout, "dist", "ui", "workspace-app.html"), VITE_TEMPLATE_HTML);
    const stderr = expectResolutionFailure(checkout);
    assert.match(stderr, /not a self-contained MCP App/, "template in dist must be rejected with a rebuild instruction");
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}

// 2. Source checkout with a built dist projection: resolver serves the built
//    artifact, never the src/ui template.
{
  const checkout = stageSourceCheckoutLayout(true);
  try {
    const resolved = resolveIn(checkout);
    assert.equal(resolved.html, SELF_CONTAINED_HTML, "source mode must serve the built dist artifact");
    assert.equal(resolved.provenance, "dist-projection");
    assert.ok(!resolved.path.includes(join("src", "ui")), "source checkout must never resolve into src/ui");
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}

// 3. Source checkout with NO built artifact: resolver fails loudly with the
//    rebuild instruction instead of silently serving src/ui template.
{
  const checkout = stageSourceCheckoutLayout(false);
  try {
    const stderr = expectResolutionFailure(checkout);
    assert.match(stderr, /No built Workspace App artifact found/, "missing artifact must name the fix");
    assert.match(stderr, /build:app/, "failure message must name the build command");
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}

// 4. Explicit override wins over everything, in a source checkout.
{
  const checkout = stageSourceCheckoutLayout(true);
  const overrideDir = mkdtempSync(join(tmpdir(), "kontrol-wa-override-"));
  try {
    const overrideArtifact = join(overrideDir, "workspace-app.html");
    writeFileSync(overrideArtifact, `${SELF_CONTAINED_HTML}\n<!-- override -->`);
    const resolved = resolveIn(checkout, { KONTROL_WORKSPACE_APP_HTML_PATH: overrideArtifact });
    assert.ok(resolved.html.includes("override"), "explicit override must win");
    assert.equal(resolved.provenance, "explicit-override");
  } finally {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(overrideDir, { recursive: true, force: true });
  }
}

// 5. Override pointing at a missing file must fail with the path in the error.
{
  const checkout = stageSourceCheckoutLayout(true);
  try {
    const stderr = expectResolutionFailure(checkout, {
      KONTROL_WORKSPACE_APP_HTML_PATH: join(checkout, "does-not-exist.html"),
    });
    assert.match(stderr, /KONTROL_WORKSPACE_APP_HTML_PATH points at a missing/);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}

// 6. Dev-candidate directory override (KONTROL_DEV_UI_DIR) beats the checkout
//    dist projection.
{
  const checkout = stageSourceCheckoutLayout(true);
  const devUiDir = mkdtempSync(join(tmpdir(), "kontrol-wa-devui-"));
  try {
    writeFileSync(join(devUiDir, "workspace-app.html"), `${SELF_CONTAINED_HTML}\n<!-- devui -->`);
    const resolved = resolveIn(checkout, { KONTROL_DEV_UI_DIR: devUiDir });
    assert.ok(resolved.html.includes("devui"), "dev UI candidate must win over checkout dist");
    assert.equal(resolved.provenance, "built-dev-candidate");
  } finally {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(devUiDir, { recursive: true, force: true });
  }
}

// 7. Compiled-release layout: build-meta.json beside the module plus sibling
//    ui/ wins without any environment, and cwd dist is ignored. The module
//    resolves relative to its own location, so the fixture stages a compiled
//    release tree and imports the module copy placed inside it.
{
  const release = mkdtempSync(join(tmpdir(), "kontrol-wa-release-"));
  try {
    mkdirSync(join(release, "ui"), { recursive: true });
    // Outside a package tree tsx would transpile the module as CJS and the
    // named exports would disappear; the fixture must be an ESM package.
    writeFileSync(join(release, "package.json"), '{"type":"module"}\n');
    copyFileSync(join(repoRoot, "src", "workspace-app-resource.ts"), join(release, "workspace-app-resource.ts"));
    writeFileSync(join(release, "build-meta.json"), "{}\n");
    writeFileSync(join(release, "ui", "workspace-app.html"), `${SELF_CONTAINED_HTML}\n<!-- release -->`);
    const script = [
      "import { WORKSPACE_APP_HTML, WORKSPACE_APP_ARTIFACT_SOURCE } from",
      `  ${JSON.stringify(join(release, "workspace-app-resource.ts"))};`,
      "process.stdout.write(JSON.stringify({ html: WORKSPACE_APP_HTML, provenance: WORKSPACE_APP_ARTIFACT_SOURCE.provenance }));",
    ].join("\n");
    const out = execFileSync(process.execPath, ["--import", TSX_LOADER, "--input-type=module", "-e", script], {
      cwd: release,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: "utf8",
    });
    const resolved = JSON.parse(out);
    assert.ok(resolved.html.includes("release"), "compiled release must serve its sibling artifact");
    assert.equal(resolved.provenance, "compiled-release");
  } finally {
    rmSync(release, { recursive: true, force: true });
  }
}

// 8. The repository's own in-repo resolution (this checkout): under tsx, the
//    module must either resolve a built artifact or fail — it must NEVER
//    return the src/ui template body. This is the exact production bug shape.
//    Only derived facts are printed: the real artifact is ~10 MB and would
//    exceed the child exec maxBuffer.
{
  if (existsSync(join(repoRoot, "dist", "ui", "workspace-app.html"))) {
    const script = [
      "import { WORKSPACE_APP_HTML, WORKSPACE_APP_ARTIFACT_SOURCE } from",
      `  ${JSON.stringify(join(repoRoot, "src", "workspace-app-resource.ts"))};`,
      "process.stdout.write(JSON.stringify({",
      "  provenance: WORKSPACE_APP_ARTIFACT_SOURCE.provenance,",
      "  referencesTemplateScript: WORKSPACE_APP_HTML.includes('./workspace-app.tsx'),",
      "  referencesTemplateCss: WORKSPACE_APP_HTML.includes('./workspace-app.css'),",
      "  hasScript: WORKSPACE_APP_HTML.includes('<script'),",
      "  bytes: WORKSPACE_APP_HTML.length,",
      "}));",
    ].join("\n");
    const out = execFileSync(process.execPath, ["--import", TSX_LOADER, "--input-type=module", "-e", script], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: "utf8",
    });
    const facts = JSON.parse(out);
    assert.ok(!facts.referencesTemplateScript, "in-repo source-mode resolution must never serve the Vite template script");
    assert.ok(!facts.referencesTemplateCss, "in-repo source-mode resolution must never reference the external stylesheet");
    assert.ok(facts.hasScript, "resolved artifact must inline its script");
    assert.ok(facts.bytes > 1024 * 1024, `resolved source-mode artifact must be the built app, got ${facts.bytes} bytes`);
  }
}

// 9. Current artifact sanity: the actual built app (if present) must be
//    self-contained per the structural check used by the resolver itself.
{
  const distArtifact = join(repoRoot, "dist", "ui", "workspace-app.html");
  if (existsSync(distArtifact)) {
    const { isSelfContainedWorkspaceAppHtml } = await import(join(repoRoot, "src", "workspace-app-resource.ts"));
    const html = (await import("node:fs")).readFileSync(distArtifact, "utf8");
    assert.ok(isSelfContainedWorkspaceAppHtml(html), "the real dist artifact must pass the structural self-containment check");
  }
}

console.log("workspace-app-resource.test.mjs: source-mode resolution regression suite passed");
