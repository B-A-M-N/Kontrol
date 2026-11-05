// Review #8: UI test chain that can never silently skip the built-artifact
// gates. The size test builds a fresh candidate into a temp dir (via
// KONTROL_BUILD_OUTPUT_DIR), asserts the byte budgets, then hands the same
// candidate to the contract test via KONTROL_UI_TEST_CANDIDATE_DIR so its
// built-artifact assertions execute against a REAL build on clean checkouts.
//
// Stage 3: the UI entries live in scripts/test-suites.json (suite "ui") and
// run in manifest order through the shared qualification executor with a
// per-entry absolute deadline. A hung UI test can no longer stall the chain
// silently, and every entry gets a distinct PASSED/FAILED/TIMED_OUT/
// INTERRUPTED/INFRA_ERROR/CLEANUP_FAILED result.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runQualificationProcess } from "./lib/qualification-process.mjs";
import { testHarnessEnvironment } from "../src/process-environment.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const candidateDir = mkdtempSync(join(tmpdir(), "kontrol-ui-candidate-"));
const childEnvironment = testHarnessEnvironment();
childEnvironment.KONTROL_UI_TEST_CANDIDATE_DIR = candidateDir;
for (const key of [
  "npm_execpath",
  "KONTROL_UI_SCREENSHOT_DIR",
  "KONTROL_UI_SCREENSHOT_LABEL",
  "KONTROL_BROWSER_PATH",
  "KONTROL_BROWSER_NO_SANDBOX",
]) {
  if (process.env[key] !== undefined) childEnvironment[key] = process.env[key];
}

const RUN_ID = `ui-tests-${Date.now().toString(36)}`;
const manifestPath = process.env.KONTROL_TEST_MANIFEST ?? join(root, "scripts", "test-suites.json");

function loadUiEntries() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error(`unsupported execution manifest at ${manifestPath}`);
  }
  const onlyId = process.env.KONTROL_TEST_ONLY_ID ?? null;
  const allEntries = manifest.entries.filter((entry) => entry?.suite === "ui");
  // The contract and browser gates execute against the candidate the size
  // entry builds; a single-entry rerun of either must include its build
  // prerequisite or it would silently test a missing artifact.
  const PREREQUISITES = {
    "workspace-app-contract": ["workspace-app-size"],
    "workspace-app-browser": ["workspace-app-size"],
  };
  const wanted = !onlyId ? null : new Set([onlyId, ...(PREREQUISITES[onlyId] ?? [])]);
  const entries = !wanted ? allEntries : allEntries.filter((entry) => wanted.has(entry.id));
  if (entries.length === 0) {
    throw new Error(onlyId
      ? `KONTROL_TEST_ONLY_ID="${onlyId}" matches no suite "ui" entry in ${manifestPath}`
      : `no suite "ui" entries in ${manifestPath}`);
  }
  return entries;
}

try {
  for (const entry of loadUiEntries()) {
    const [command, ...args] = entry.command;
    const receipt = await runQualificationProcess({
      runId: RUN_ID,
      phaseId: entry.id,
      command,
      args,
      cwd: root,
      env: childEnvironment,
      deadlineMs: entry.timeoutMs,
    });
    const summary = `${entry.id}: ${receipt.status} in ${receipt.durationMs}ms` +
      ` (exit ${receipt.exitCode ?? "n/a"}${receipt.signal ? `/${receipt.signal}` : ""}` +
      `, cleanup ${receipt.cleanupVerified ? "verified" : "FAILED: " + receipt.cleanupFailures.join("; ")})`;
    if (receipt.status !== "PASSED") {
      if (receipt.outputTail) process.stderr.write(receipt.outputTail + (receipt.outputTail.endsWith("\n") ? "" : "\n"));
      throw new Error(
        `ui test ${summary}; ` +
        (receipt.status === "TIMED_OUT"
          ? `exceeded deadline ${receipt.deadlineMs}ms${receipt.escalated ? " (SIGTERM ignored, escalated to SIGKILL)" : ""}`
          : `see output above`),
      );
    }
    console.log(summary);
  }
} finally {
  // Keep cleanup reliable when any individual suite fails.
  rmSync(candidateDir, { recursive: true, force: true });
}
