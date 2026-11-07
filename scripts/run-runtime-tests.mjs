#!/usr/bin/env node
// Run the runtime test chain with a temporary built Workspace App. Several
// server tests load the app during module initialization, but test setup must
// not create an incomplete dist/ projection in the user's checkout.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
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
  // Adapter child tests use this exact artifact directory as
  // KONTROL_ARTIFACT_PATH. Ship the self-contained grant/sandbox modules into
  // it just as build-atomic does for an immutable release. Both modules must
  // be present: the Hermes adapter resolves bounded-file-write.mjs from the
  // artifact directory whenever KONTROL_ARTIFACT_PATH is set, with no
  // fallback, so shipping only read-only-execution.mjs crashes adapter
  // startup in exactly the legs that set the variable.
  const readOnlyExecution = join(artifactDirectory, "read-only-execution.mjs");
  copyFileSync(join(root, "scripts", "lib", "read-only-execution.mjs"), readOnlyExecution);
  if (!existsSync(readOnlyExecution)) throw new Error("temporary runtime artifact is missing read-only-execution.mjs");
  const boundedFileWrite = join(artifactDirectory, "bounded-file-write.mjs");
  copyFileSync(join(root, "scripts", "lib", "bounded-file-write.mjs"), boundedFileWrite);
  if (!existsSync(boundedFileWrite)) throw new Error("temporary runtime artifact is missing bounded-file-write.mjs");
}

// A suite that spawns a bundled adapter child needs the compiled runtime
// artifact, not a stale dist/ projection in the checkout: the adapter
// resolves acp-duplex.js, read-only-execution.mjs, and bounded-file-write.mjs
// from KONTROL_ARTIFACT_PATH and falls back to ../dist/ only when it is unset.
// The artifact directory is compiled once and stays valid for every later
// step, so each step that spawns an adapter is given the same directory.
const artifactSteps = new Set(["test:adapters", "test:lifecycle", "test:review-thread"]);
let artifactCompiled = false;

// Outer safety barrier per suite: a test that passes its assertions but keeps
// event-loop handles alive (or hangs outright) must fail fast with the suite
// identity attached, instead of blocking the whole runtime chain forever.
// Timeouts are generous wall-clock ceilings, not performance targets.
const suiteTimeoutsMs = {
  "test:syntax": 10 * 60_000,
  "test:manifest": 5 * 60_000,
  "build:app": 10 * 60_000,
  "test:unit": 45 * 60_000,
  "test:find-compat": 10 * 60_000,
  "test:adapters": 30 * 60_000,
  "test:ui": 20 * 60_000,
  "test:security": 20 * 60_000,
  "test:policy": 10 * 60_000,
  "test:lifecycle": 60 * 60_000,
};
const TERMINATE_GRACE_MS = 5_000;

function suiteTimeoutMs(script) {
  const overrideKey = `KONTROL_TEST_TIMEOUT_MS_${script.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  const override = process.env[overrideKey];
  if (override !== undefined) {
    const parsed = Number(override);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${overrideKey} must be a positive millisecond count, got ${JSON.stringify(override)}`);
    }
    return parsed;
  }
  return suiteTimeoutsMs[script] ?? 30 * 60_000;
}

function killProcessGroup(child, signal) {
  // The child is spawned detached, so negative-pid signaling reaches the npm
  // wrapper and every descendant it spawned — not just the wrapper alone.
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function run(script) {
  // This runner invokes only the repository's fixed npm test scripts.
  if (artifactSteps.has(script) && !artifactCompiled) {
    compileRuntimeArtifact();
    artifactCompiled = true;
  }
  const timeoutMs = suiteTimeoutMs(script);
  const startedAt = Date.now();
  const elapsedMs = () => Date.now() - startedAt;
  const childEnv = artifactSteps.has(script)
    ? { ...env, KONTROL_ARTIFACT_PATH: artifactDirectory }
    : env;
  const child = spawn(process.execPath, [npmExecPath, "run", script], {
    cwd: root,
    env: childEnv,
    stdio: "inherit",
    detached: true,
  });
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ spawnError: error });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  if (outcome.spawnError) throw outcome.spawnError;
  if (outcome.timedOut) {
    killProcessGroup(child, "SIGTERM");
    const exited = await new Promise((resolve) => {
      const grace = setTimeout(() => resolve(false), TERMINATE_GRACE_MS);
      grace.unref?.();
      child.once("close", () => {
        clearTimeout(grace);
        resolve(true);
      });
    });
    if (!exited) killProcessGroup(child, "SIGKILL");
    throw new Error(
      `npm run ${script} timed out after ${timeoutMs}ms (elapsed ${elapsedMs()}ms): ` +
      `sent SIGTERM to the process group, then ${exited ? "it exited during" : "SIGKILL after"} ` +
      `a ${TERMINATE_GRACE_MS}ms grace period. Timeout and abnormal termination are failures ` +
      `regardless of any assertion output above.`,
    );
  }
  if (outcome.code !== 0) {
    throw new Error(
      `npm run ${script} failed after ${elapsedMs()}ms with ` +
      `${outcome.signal ? `signal ${outcome.signal}` : `status ${outcome.code ?? "unknown"}`}`,
    );
  }
}

try {
  for (const script of [
    "test:syntax",
    "test:manifest",
    "build:app",
    "test:review-browser",
    "test:review-loop-integration",
    "test:release",
    "test:unit",
    "test:find-compat",
    "test:adapters",
    "test:ui",
    "test:security",
    "test:policy",
    "test:lifecycle",
    "test:review-thread",
  ]) {
    await run(script);
  }
} finally {
  rmSync(artifactDirectory, { recursive: true, force: true });
}
