// P1 #31: build budget gate for the single-file Workspace App resource.
// The remote iframe cannot fetch localhost chunks, so the app ships as one
// inlined HTML file. That constraint is legitimate — but payload growth must
// be VISIBLE. This test fails the build when the artifact exceeds the agreed
// ceilings (raw and gzip) so dependency weight increases are a deliberate,
// reviewed decision rather than silent drift.
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const htmlPath = join(fileURLToPath(new URL(".", import.meta.url)), "../../dist/ui/workspace-app.html");

if (!existsSync(htmlPath)) {
  console.log("workspace-app-size.test.mjs: skipped (dist/ui/workspace-app.html not built)");
  process.exit(0);
}

const raw = readFileSync(htmlPath);
const gzipped = gzipSync(raw);

// Ceilings chosen just above the current artifact (~10.5 MB / ~1.91 MB):
// growth beyond these numbers requires an explicit ceiling bump in this file.
const MAX_RAW_BYTES = 11 * 1024 * 1024;
const MAX_GZIP_BYTES = 2 * 1024 * 1024;

assert.ok(
  raw.length <= MAX_RAW_BYTES,
  `Workspace App raw size ${raw.length} bytes exceeds budget ${MAX_RAW_BYTES} bytes (${(raw.length / 1024 / 1024).toFixed(2)} MB). Measure the new dependency before raising the ceiling.`,
);
assert.ok(
  gzipped.length <= MAX_GZIP_BYTES,
  `Workspace App gzip size ${gzipped.length} bytes exceeds budget ${MAX_GZIP_BYTES} bytes (${(gzipped.length / 1024 / 1024).toFixed(2)} MB). The tunnel transfers gzip; this is the user-facing cost.`,
);

console.log(`workspace-app-size.test.mjs: within budget (raw ${(raw.length / 1024 / 1024).toFixed(2)} MB / gzip ${(gzipped.length / 1024 / 1024).toFixed(2)} MB)`);
