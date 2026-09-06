import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { buildToolEnvironment } from "./lib/tool-environment.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const watchRoots = ["src"].map((entry) => join(repoRoot, entry));
const restartDelayMs = 750;
const crashDelayMs = 1500;
const maxCrashDelayMs = 30_000;

// P0 source-mode resolution: the server must serve a BUILT, self-contained
// Workspace App, never the Vite input template under src/ui. Build the UI
// once into a dedicated development directory up front, point the runtime at
// the exact artifact via KONTROL_WORKSPACE_APP_HTML_PATH, and rebuild on UI
// source changes (the change also restarts the server, which reloads the
// artifact from disk).
const devUiDir = process.env.KONTROL_DEV_UI_DIR || join(tmpdir(), `kontrol-dev-ui-${process.pid}`);
const devUiArtifact = join(devUiDir, "workspace-app.html");

function buildDevUi() {
  mkdirSync(devUiDir, { recursive: true });
  const result = spawnSync("npx", ["vite", "build"], {
    cwd: repoRoot,
    env: buildToolEnvironment(process.env, { overrides: { KONTROL_BUILD_OUTPUT_DIR: devUiDir } }),
    stdio: "inherit",
  });
  if (result.status !== 0 || !existsSync(devUiArtifact)) {
    throw new Error(`development UI build failed (status ${result.status ?? "unknown"}); cannot start dev server`);
  }
  console.error(`[kontrol:dev] workspace app artifact: ${devUiArtifact}`);
}

buildDevUi();

function resolveRuntimeConfig() {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", [
    'import { loadConfig } from "./src/config.ts";',
    'const config = loadConfig();',
    'process.stdout.write(JSON.stringify({ stateDir: config.stateDir, port: config.port }));',
  ].join(" ")], {
    cwd: repoRoot,
    // P1.10: this local watcher resolves its own config before spawning the
    // local server; the child gets the tool allowlist.
    env: buildToolEnvironment(process.env),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error((result.stderr || "could not load Kontrol config").trim());
  return JSON.parse(result.stdout);
}

function runtimeLockCommand(command, args) {
  return spawnSync(process.execPath, ["--import", "tsx", join(repoRoot, "src/runtime-lock.ts"), command, ...args], {
    cwd: repoRoot,
    // P1.10: this local watcher invokes its own runtime-lock helper; the
    // child receives the tool allowlist, not a control-plane environment.
    env: buildToolEnvironment(process.env),
    encoding: "utf8",
  });
}

const runtimeConfig = resolveRuntimeConfig();
const runtimeStateDir = process.env.KONTROL_STATE_DIR || runtimeConfig.stateDir || join(homedir(), ".local", "share", "kontrol");
const generationId = `dev-${Date.now()}-${process.pid}`;
const lockResult = runtimeLockCommand("acquire", [
  "--state-dir", runtimeStateDir,
  "--launcher", "dev-watch",
  "--launcher-pid", String(process.pid),
  "--generation-id", generationId,
  "--build-id", "dev",
  "--artifact-path", join(repoRoot, "src"),
  "--port", String(runtimeConfig.port ?? 7676),
]);
if (lockResult.status !== 0) {
  throw new Error((lockResult.stderr || lockResult.stdout || "Kontrol runtime lock acquisition failed").trim());
}
const runtimeLockToken = lockResult.stdout.trim();
// P1.10: dev-watch IS a launcher for its child, so it deliberately
// establishes the runtime identity below; every other variable comes from
// the explicit tool allowlist, not wholesale process.env inheritance.
const childEnvironment = buildToolEnvironment(process.env, {
  overrides: {
    KONTROL_LAUNCHER: "dev-watch",
    KONTROL_LAUNCH_GENERATION_ID: generationId,
    KONTROL_RUNTIME_LOCK_TOKEN: runtimeLockToken,
    KONTROL_ARTIFACT_PATH: join(repoRoot, "src"),
    KONTROL_WORKSPACE_APP_HTML_PATH: devUiArtifact,
  },
});

let child;
let restartTimer;
let stoppingForRestart = false;
let shuttingDown = false;
let crashBackoffMs = crashDelayMs;
let childStartedAt = 0;

function releaseRuntimeLock() {
  if (!runtimeLockToken) return;
  runtimeLockCommand("release", ["--state-dir", runtimeStateDir, "--token", runtimeLockToken]);
}

function log(message) {
  console.error(`[kontrol:dev] ${message}`);
}

function start() {
  stoppingForRestart = false;
  childStartedAt = Date.now();
  child = spawn("npx", ["tsx", "src/cli.ts", "serve"], {
    cwd: repoRoot,
    // kontrol-env-exception: local dev server runs the developer's own
    // checkout on their machine; not a remote control-plane spawn path.
    env: childEnvironment,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    child = undefined;
    if (shuttingDown) return;
    if (stoppingForRestart) return;

    if (Date.now() - childStartedAt >= 10_000) crashBackoffMs = crashDelayMs;
    const delay = crashBackoffMs;
    crashBackoffMs = Math.min(maxCrashDelayMs, crashBackoffMs * 2);
    log(`server exited (${signal ?? code ?? "unknown"}); restarting in ${delay}ms`);
    scheduleRestart(delay);
  });
}

function scheduleRestart(delayMs = restartDelayMs) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restart, delayMs);
}

function restart() {
  if (shuttingDown) return;
  clearTimeout(restartTimer);

  if (!child) {
    start();
    return;
  }

  stoppingForRestart = true;
  child.once("exit", () => {
    if (!shuttingDown) start();
  });
  child.kill("SIGTERM");

  setTimeout(() => {
    if (child && stoppingForRestart) child.kill("SIGKILL");
  }, 3000).unref();
}

function watchDirectory(root) {
  const watchers = [];
  const seen = new Set();

  function addDirectory(dir) {
    if (seen.has(dir)) return;
    seen.add(dir);

    const watcher = watch(dir, (event, filename) => {
      if (!filename) {
        scheduleRestart();
        return;
      }

      const path = join(dir, filename.toString());
      if (event === "rename") maybeAddDirectory(path);
      scheduleRestart();
    });
    watchers.push(watcher);

    for (const entry of readdirSync(dir)) {
      maybeAddDirectory(join(dir, entry));
    }
  }

  function maybeAddDirectory(path) {
    try {
      const stats = statSync(path);
      if (stats.isDirectory()) addDirectory(path);
    } catch {
      // The file may have been deleted between the watch event and stat call.
    }
  }

  addDirectory(root);
  return watchers;
}

function shutdown() {
  shuttingDown = true;
  clearTimeout(restartTimer);
  if (!child) {
    releaseRuntimeLock();
    return process.exit(0);
  }

  child.once("exit", () => {
    releaseRuntimeLock();
    process.exit(0);
  });
  child.kill("SIGTERM");
  setTimeout(() => {
    releaseRuntimeLock();
    process.exit(1);
  }, 3000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, shutdown);
}

// Rebuild the UI when src/ui changes. Defined before the watchers below so
// the watcher callbacks can reference it; the server restart (already
// scheduled by the watcher) reloads the new artifact on boot.
let uiRebuildQueued = false;
function scheduleUiRebuild() {
  if (uiRebuildQueued) return;
  uiRebuildQueued = true;
  setTimeout(() => {
    uiRebuildQueued = false;
    if (shuttingDown) return;
    try {
      buildDevUi();
      log("workspace app artifact rebuilt");
    } catch (error) {
      log(`workspace app artifact rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, restartDelayMs).unref();
}

// The UI build input lives under src/ui, which the src watcher already
// covers; a UI source change restarts the server AND refreshes the artifact
// so the restarted server reads the freshly built HTML.
function watchDirectoryWithUiRebuild(rootDirectory) {
  const inner = watchDirectory(rootDirectory);
  // The directory watcher above already schedules a server restart for every
  // change; hook a second watcher on src/ui solely to rebuild the artifact.
  const uiWatcher = watch(join(rootDirectory, "ui"), () => scheduleUiRebuild());
  return [...inner, uiWatcher];
}

for (const root of watchRoots) {
  watchDirectoryWithUiRebuild(root);
}

log(`watching src; generation ${generationId}; server restarts on changes and after crashes`);
start();
