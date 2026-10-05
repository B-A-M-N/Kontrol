// A bounded aggregate of the public bridge, durable ledger, and verifier
// regressions that together qualify Kontrol's supervised mission outcome loop.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testHarnessEnvironment } from "./lib/tool-environment.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const checks = [
  { id: "public-entry-paths-and-review-loop", file: "src/bridge-flow.test.ts" },
  { id: "durable-evidence-and-restart-between-correction", file: "src/mission-ledger.test.ts" },
  { id: "exact-snapshot-verification-and-cache-context", file: "src/mission-verifier.test.ts" },
  { id: "filesystem-exact-snapshot-review", file: "src/review-workflow.filesystem.test.ts" },
];

let failed = false;
for (const check of checks) {
  console.log(`[mission-loop] START ${check.id}`);
  const result = spawnSync(process.execPath, ["--import", "tsx", check.file], {
    cwd: root,
    env: testHarnessEnvironment(process.env),
    stdio: "inherit",
  });
  const passed = result.status === 0 && result.signal === null;
  console.log(`[mission-loop] ${passed ? "PASS" : "FAIL"} ${check.id}`);
  if (!passed) failed = true;
}

if (failed) process.exitCode = 1;
else console.log("[mission-loop] QUALIFIED");
