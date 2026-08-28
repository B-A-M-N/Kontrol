import { spawn, spawnSync } from "node:child_process";
import { readdirSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const watchRoots = ["src"].map((entry) => join(repoRoot, entry));
const restartDelayMs = 750;
const crashDelayMs = 1500;
const maxCrashDelayMs = 30_000;

function resolveRuntimeConfig() {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", [
    'import { loadConfig } from "./src/config.ts";',
    'const config = loadConfig();',
    'process.stdout.write(JSON.stringify({ stateDir: config.stateDir, port: config.port }));',
  ].join(" ")], {
    cwd: repoRoot,
    // kontrol-env-exception: this local watcher resolves its own config before
    // spawning the local server; no remote/project content is executed here.
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error((result.stderr || "could not load Kontrol config").trim());
  return JSON.parse(result.stdout);
}

function runtimeLockCommand(command, args) {
  return spawnSync(process.execPath, ["--import", "tsx", join(repoRoot, "src/runtime-lock.ts"), command, ...args], {
    cwd: repoRoot,
    // kontrol-env-exception: this local watcher invokes its own runtime-lock
    // helper; the child receives no project-controlled input.
    env: process.env,
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
const childEnvironment = {
  ...process.env,
  KONTROL_LAUNCHER: "dev-watch",
  KONTROL_LAUNCH_GENERATION_ID: generationId,
  KONTROL_RUNTIME_LOCK_TOKEN: runtimeLockToken,
  KONTROL_ARTIFACT_PATH: join(repoRoot, "src"),
};

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

for (const root of watchRoots) {
  watchDirectory(root);
}

log(`watching src; generation ${generationId}; server restarts on changes and after crashes`);
start();
