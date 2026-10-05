#!/usr/bin/env node
/**
 * P1.1: every test file must be reachable from the canonical test chain.
 *
 * A regression test a developer has to remember to invoke manually does not
 * protect a release. This check walks src/ and scripts/ for *.test.* files
 * and fails when one is not referenced by:
 *   - package.json test scripts, or
 *   - scripts/run-ui-tests.mjs (the test:ui runner), or
 *   - scripts/test-manifest-allowlist.json (deliberate exclusions, each
 *     requiring a reason).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SELF = "scripts/test-manifest.mjs";

function collectTestFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, acc);
    else if (/\.test\.(ts|tsx|mjs|js)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const allTests = collectTestFiles(join(root, "src"))
  .concat(collectTestFiles(join(root, "scripts")))
  .map((path) => relative(root, path))
  .sort();

const packageJson = readFileSync(join(root, "package.json"), "utf8");
const uiRunner = readFileSync(join(root, "scripts/run-ui-tests.mjs"), "utf8");
let allowlist = { excluded: [] };
try {
  allowlist = JSON.parse(readFileSync(join(root, "scripts/test-manifest-allowlist.json"), "utf8"));
} catch {
  // No allowlist yet — every test must be wired.
}
const excluded = new Map(Object.entries(allowlist.excluded ?? {}));

const wiredCorpus = `${packageJson}\n${uiRunner}`;
const orphans = allTests.filter((path) => {
  const base = path.replace(/\\/g, "/");
  if (wiredCorpus.includes(base)) return false;
  return !excluded.has(base);
});

if (orphans.length > 0) {
  console.error(`test-manifest: ${orphans.length} orphaned test file(s) — not reachable from the canonical test chain:`);
  for (const path of orphans) {
    const reason = excluded.get(path);
    console.error(`  ${path}${reason ? ` (allowlisted: ${reason})` : ""}`);
  }
  console.error("Wire each test into a package.json test:<suite> script, the test:ui runner, or scripts/test-manifest-allowlist.json with a documented reason.");
  process.exit(1);
}

for (const path of excluded.keys()) {
  if (!allTests.includes(path)) {
    console.error(`test-manifest: allowlist entry no longer exists: ${path} — remove it.`);
    process.exit(1);
  }
}

console.log(`test-manifest: ${allTests.length} test files all reachable from the canonical chain`);
