// Review #8: UI test chain that can never silently skip the built-artifact
// gates. The size test builds a fresh candidate into a temp dir (via
// KONTROL_BUILD_OUTPUT_DIR), asserts the byte budgets, then hands the same
// candidate to the contract test via KONTROL_UI_TEST_CANDIDATE_DIR so its
// built-artifact assertions execute against a REAL build on clean checkouts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const candidateDir = mkdtempSync(join(tmpdir(), "kontrol-ui-candidate-"));
process.env.KONTROL_UI_TEST_CANDIDATE_DIR = candidateDir;

function run(cmd, args) {
  // kontrol-env-exception: test runner spawning the project's own tests on
  // trusted sources; needs PATH/npm resolution, not a control-plane spawn.
  const result = spawnSync(cmd, args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("npx", ["tsx", "src/ui/card-types.test.ts"]);
run("npx", ["tsx", "src/ui/patch-display.test.ts"]);
run("npx", ["tsx", "src/ui/approval-attention.dom.test.ts"]);
run("npx", ["tsx", "src/ui/workspace-app.dom.test.tsx"]);

// Size test builds + enforces byte budgets (missing artifact = failure).
run(process.execPath, ["src/ui/workspace-app-size.test.mjs"]);

// Contract test runs with the candidate exported so built-artifact
// assertions execute.
run("npx", ["tsx", "src/ui/workspace-app-contract.test.ts"]);

// Cleanup after all consumers are done.
rmSync(candidateDir, { recursive: true, force: true });
