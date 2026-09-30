// P1 #31 / review #8: the size gate must never silently skip. The artifact is
// built into a temporary candidate directory (via KONTROL_BUILD_OUTPUT_DIR)
// and tested at that explicit path — a clean CI checkout gets a real build,
// not an ambient stale dist/. A missing candidate artifact is a FAILURE.
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WORKSPACE_APP_BUNDLE_LIMITS } from "../../scripts/check-workspace-app-bundle.mjs";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

// Reuse an existing candidate when chained (e.g. contract test -> size test),
// otherwise build fresh.
const candidateDir =
  process.env.KONTROL_UI_TEST_CANDIDATE_DIR ?? mkdtempSync(join(tmpdir(), "kontrol-ui-candidate-"));
process.env.KONTROL_BUILD_OUTPUT_DIR = candidateDir;
if (!existsSync(join(candidateDir, "ui", "workspace-app.html"))) {
  execFileSync("npm", ["run", "build:app"], { cwd: repoRoot, stdio: "inherit" });
}

const htmlPath = join(candidateDir, "ui", "workspace-app.html");
assert.ok(
  existsSync(htmlPath),
  `UI build produced no artifact at ${htmlPath} — the release size gate cannot pass without a real build`,
);

try {
  const raw = readFileSync(htmlPath);
  const gzipped = gzipSync(raw);

  // Keep the UI test aligned with the production bundle gate so neither path
  // can silently reintroduce the oversized app artifact.
  const MAX_RAW_BYTES = WORKSPACE_APP_BUNDLE_LIMITS.workspaceAppRawBytes;
  const MAX_GZIP_BYTES = WORKSPACE_APP_BUNDLE_LIMITS.workspaceAppGzipBytes;

  assert.ok(
    raw.length <= MAX_RAW_BYTES,
    `Workspace App raw size ${raw.length} bytes exceeds budget ${MAX_RAW_BYTES} bytes (${(raw.length / 1024 / 1024).toFixed(2)} MB). Measure the new dependency before raising the ceiling.`,
  );
  assert.ok(
    gzipped.length <= MAX_GZIP_BYTES,
    `Workspace App gzip size ${gzipped.length} bytes exceeds budget ${MAX_GZIP_BYTES} bytes (${(gzipped.length / 1024 / 1024).toFixed(2)} MB). The tunnel transfers gzip; this is the user-facing cost.`,
  );

  console.log(`workspace-app-size.test.mjs: within budget (raw ${(raw.length / 1024 / 1024).toFixed(2)} MB / gzip ${(gzipped.length / 1024 / 1024).toFixed(2)} MB). Wire delivery of the gzip envelope (content-encoding + actual bytes on the socket) is regression-tested in src/workspace-resource-admission.test.ts case 7.`);
} finally {
  if (!process.env.KONTROL_UI_TEST_CANDIDATE_DIR) {
    rmSync(candidateDir, { recursive: true, force: true });
  }
}
