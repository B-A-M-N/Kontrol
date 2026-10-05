// Review #8: UI test chain that can never silently skip the built-artifact
// gates. The size test builds a fresh candidate into a temp dir (via
// KONTROL_BUILD_OUTPUT_DIR), asserts the byte budgets, then hands the same
// candidate to the contract test via KONTROL_UI_TEST_CANDIDATE_DIR so its
// built-artifact assertions execute against a REAL build on clean checkouts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const candidateDir = mkdtempSync(join(tmpdir(), "kontrol-ui-candidate-"));
process.env.KONTROL_UI_TEST_CANDIDATE_DIR = candidateDir;

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`node ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
}

function runTsx(args) {
  runNode([tsxCli, ...args]);
}

try {
  runTsx(["src/ui/card-types.test.ts"]);
  runTsx(["src/ui/patch-display.test.ts"]);
  runTsx(["src/ui/approval-attention.dom.test.ts"]);
  runTsx(["src/ui/policy-grant-revoke.dom.test.tsx"]);
  runTsx(["src/ui/workspace-app.dom.test.tsx"]);

  // Size test builds + enforces byte budgets (missing artifact = failure).
  runNode(["src/ui/workspace-app-size.test.mjs"]);

  // Contract test runs with the candidate exported so built-artifact
  // assertions execute.
  runTsx(["src/ui/workspace-app-contract.test.ts"]);

  // Real Chromium gate: verify the same built single-file artifact in a browser
  // engine, including mobile layout, focus styling, and host theme variables.
  runNode(["scripts/workspace-app-browser.test.mjs"]);
} finally {
  // Keep cleanup reliable when any individual suite fails.
  rmSync(candidateDir, { recursive: true, force: true });
}
