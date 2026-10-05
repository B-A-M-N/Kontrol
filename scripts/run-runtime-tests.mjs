#!/usr/bin/env node
// Run the runtime test chain with a temporary built Workspace App. Several
// server tests load the app during module initialization, but test setup must
// not create an incomplete dist/ projection in the user's checkout.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactDirectory = mkdtempSync(join(tmpdir(), "kontrol-runtime-ui-"));
const npmExecPath = process.env.npm_execpath;

if (!npmExecPath) {
  rmSync(artifactDirectory, { recursive: true, force: true });
  throw new Error("test:runtime must be invoked through npm");
}

const env = {
  ...process.env,
  KONTROL_BUILD_OUTPUT_DIR: artifactDirectory,
  KONTROL_WORKSPACE_APP_HTML_PATH: join(artifactDirectory, "ui", "workspace-app.html"),
};

function compileRuntimeArtifact() {
  const result = spawnSync(process.execPath, [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p", join(root, "tsconfig.build.json"),
    "--outDir", artifactDirectory,
  ], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`temporary runtime artifact compile failed with status ${result.status ?? "unknown"}`);
  }
}

function run(script) {
  // This runner invokes only the repository's fixed npm test scripts.
  if (script === "test:adapters") compileRuntimeArtifact();
  const result = spawnSync(process.execPath, [npmExecPath, "run", script], {
    cwd: root,
    env: script === "test:adapters"
      ? { ...env, KONTROL_ARTIFACT_PATH: artifactDirectory }
      : env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm run ${script} failed with status ${result.status ?? "unknown"}`);
  }
}

try {
  for (const script of [
    "test:syntax",
    "test:manifest",
    "build:app",
    "test:unit",
    "test:adapters",
    "test:ui",
    "test:security",
    "test:policy",
    "test:lifecycle",
  ]) {
    run(script);
  }
} finally {
  rmSync(artifactDirectory, { recursive: true, force: true });
}
