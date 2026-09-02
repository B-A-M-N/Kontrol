// Run diagnostics against the exact immutable candidate produced by
// build-atomic.mjs. That build intentionally does not mutate dist/.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const resultPath = join(root, ".kontrol-build-result.json");
if (!existsSync(resultPath)) throw new Error(`Build result is missing: ${resultPath}`);
const result = JSON.parse(readFileSync(resultPath, "utf8"));
if (typeof result.artifactPath !== "string" || !result.artifactPath) throw new Error("Build result has no artifactPath");
const artifactPath = resolve(root, result.artifactPath);
const cliPath = join(artifactPath, "cli.js");
if (!existsSync(cliPath)) throw new Error(`Build candidate is missing cli.js: ${cliPath}`);

execFileSync(process.execPath, [cliPath, "doctor"], {
  cwd: root,
  env: {
    ...process.env,
    KONTROL_ALLOWED_ROOTS: process.env.KONTROL_ALLOWED_ROOTS || root,
    KONTROL_OAUTH_OWNER_TOKEN: process.env.KONTROL_OAUTH_OWNER_TOKEN || "ci-doctor-token-that-is-long-enough",
    KONTROL_PUBLIC_BASE_URL: process.env.KONTROL_PUBLIC_BASE_URL || "http://127.0.0.1:7676",
  },
  stdio: "inherit",
});
