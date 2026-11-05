// Manifest-driven integration runner (Stage 3).
//
// Executes every entry in scripts/test-suites.json as an isolated child
// through the shared qualification executor, with a per-entry absolute
// deadline. Each entry gets a distinct result line:
//
//   <id>: <STATUS> in <ms>ms (exit <code>, cleanup verified|FAILED: ...)
//
// A test that passes its assertions but fails teardown reports CLEANUP_FAILED
// and fails the run; it is never reported as a pass. The run exits 0 only
// when every entry reports PASSED.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runQualificationProcess } from "./lib/qualification-process.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = process.env.KONTROL_TEST_MANIFEST ?? join(root, "scripts", "test-suites.json");
const onlyId = process.env.KONTROL_TEST_ONLY_ID ?? null;
const runId = process.env.KONTROL_BETA_RUN_ID ?? `integration-${Date.now().toString(36)}`;
// Each runner owns its suite slice of the manifest; the UI runner consumes
// suite "ui" the same way. Running another suite's entries here would
// duplicate coverage and misattribute the failure domain.
const suiteFilter = process.env.KONTROL_TEST_SUITE ?? "integration";
// UI entries are only meaningful with a freshly built candidate, which is
// the UI runner's setup (KONTROL_UI_TEST_CANDIDATE_DIR). Without it the
// browser/contract tests silently fall back to a stale dist/ projection and
// misattribute the failure domain — refuse instead of running them wrong.
if (suiteFilter === "ui" && !process.env.KONTROL_UI_TEST_CANDIDATE_DIR) {
  throw new Error(
    'suite "ui" entries require KONTROL_UI_TEST_CANDIDATE_DIR (a freshly built candidate); ' +
    "run them via npm run test:ui, not through the integration runner",
  );
}

function loadManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read execution manifest at ${manifestPath}: ${error.message}`);
  }
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error(`unsupported execution manifest at ${manifestPath}: expected { version: 1, entries: [...] }`);
  }
  const seen = new Set();
  for (const [index, entry] of manifest.entries.entries()) {
    const where = `test-suites.json entries[${index}]`;
    if (typeof entry?.id !== "string" || !entry.id) throw new Error(`${where}: id is required`);
    if (seen.has(entry.id)) throw new Error(`${where}: duplicate id "${entry.id}"`);
    seen.add(entry.id);
    if (!Array.isArray(entry.command) || entry.command.length === 0 || entry.command.some((t) => typeof t !== "string")) {
      throw new Error(`${where} ("${entry.id}"): command must be a non-empty string array`);
    }
    if (!Number.isFinite(entry.timeoutMs) || entry.timeoutMs <= 0) {
      throw new Error(`${where} ("${entry.id}"): timeoutMs must be a positive millisecond count`);
    }
  }
  return manifest.entries;
}

const entries = loadManifest()
  .filter((entry) => (entry.suite ?? "integration") === suiteFilter)
  .filter((entry) => !onlyId || entry.id === onlyId);
if (onlyId && entries.length === 0) {
  throw new Error(`KONTROL_TEST_ONLY_ID="${onlyId}" matches no entry in ${manifestPath}`);
}
if (!onlyId && entries.length === 0) {
  throw new Error(`suite filter "${suiteFilter}" selected no entries in ${manifestPath}; refusing a vacuous pass`);
}

const results = [];
for (const entry of entries) {
  const [command, ...args] = entry.command;
  const receipt = await runQualificationProcess({
    runId,
    phaseId: entry.id,
    command,
    args,
    cwd: root,
    deadlineMs: entry.timeoutMs,
  });
  results.push({ id: entry.id, receipt });
  const cleanup = receipt.cleanupVerified ? "cleanup verified" : `cleanup FAILED: ${receipt.cleanupFailures.join("; ")}`;
  console.log(`${entry.id}: ${receipt.status} in ${receipt.durationMs}ms (exit ${receipt.exitCode ?? "n/a"}${receipt.signal ? `/${receipt.signal}` : ""}, ${cleanup})`);
  if (receipt.status !== "PASSED" && receipt.outputTail) {
    process.stderr.write(`--- output tail for ${entry.id} ---\n` + receipt.outputTail + (receipt.outputTail.endsWith("\n") ? "" : "\n"));
  }
}

const passed = results.filter(({ receipt }) => receipt.status === "PASSED").length;
const byStatus = new Map();
for (const { receipt } of results) byStatus.set(receipt.status, (byStatus.get(receipt.status) ?? 0) + 1);
console.log(`[integration] ${passed}/${results.length} entries PASSED (${[...byStatus].map(([s, n]) => `${s}:${n}`).join(", ")})`);
if (passed !== results.length) {
  const bad = results.filter(({ receipt }) => receipt.status !== "PASSED").map(({ id, receipt }) => `${id}=${receipt.status}`);
  console.error(`[integration] FAILED entries: ${bad.join(", ")}`);
  process.exitCode = 1;
}
