// Run diagnostics against the exact immutable candidate produced by
// build-atomic.mjs. That build intentionally does not mutate dist/.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseProbeEnvironment } from "./lib/tool-environment.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const resultPath = process.env.KONTROL_BUILD_RESULT_PATH
  ? resolve(root, process.env.KONTROL_BUILD_RESULT_PATH)
  : join(root, ".kontrol-build-result.json");
if (!existsSync(resultPath)) throw new Error(`Build result is missing: ${resultPath}`);
const result = JSON.parse(readFileSync(resultPath, "utf8"));
if (typeof result.artifactPath !== "string" || !result.artifactPath) throw new Error("Build result has no artifactPath");
const artifactPath = resolve(root, result.artifactPath);
const cliPath = join(artifactPath, "cli.js");
if (!existsSync(cliPath)) throw new Error(`Build candidate is missing cli.js: ${cliPath}`);

const probeRoot = mkdtempSync(join(tmpdir(), "kontrol-doctor-build-"));
const configDir = join(probeRoot, "config");
const stateDir = join(probeRoot, "state");
const worktreeRoot = join(probeRoot, "worktrees");
mkdirSync(configDir, { recursive: true, mode: 0o700 });
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 });

try {
  execFileSync(process.execPath, [cliPath, "doctor"], {
    cwd: root,
    // P1.10: explicit allowlist; use disposable, pre-created paths so this
    // probe never depends on or mutates an operator's local Kontrol state.
    env: releaseProbeEnvironment(process.env, {
      overrides: {
        KONTROL_ALLOWED_ROOTS: root,
        KONTROL_CONFIG_DIR: configDir,
        KONTROL_STATE_DIR: stateDir,
        KONTROL_WORKTREE_ROOT: worktreeRoot,
        KONTROL_OAUTH_OWNER_TOKEN: "ci-doctor-token-that-is-long-enough",
        KONTROL_PUBLIC_BASE_URL: "http://127.0.0.1:17677",
        PORT: "17676",
      },
    }),
    stdio: "inherit",
  });
} finally {
  rmSync(probeRoot, { recursive: true, force: true });
}
