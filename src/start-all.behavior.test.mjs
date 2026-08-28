// Black-box lifecycle coverage for the real start-all.sh controller. The fake
// binaries model tmux/curl/node/npm/sleep at the process boundary so these
// assertions exercise shell control flow, durable records, artifact promotion,
// rollback, and lock handoff rather than source-text shape.
import assert from "node:assert/strict";
import {
  cpSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const harnessRoot = mkdtempSync(join(tmpdir(), "kontrol-launcher-behavior-"));
const behaviorLockPath = join(tmpdir(), "kontrol-start-all-behavior.lock");
const fakeBin = join(harnessRoot, "bin");
const fakeTmuxState = join(harnessRoot, "tmux");
mkdirSync(fakeBin, { recursive: true });
mkdirSync(fakeTmuxState, { recursive: true });

function writeExecutable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const realNode = shellQuote(process.execPath);

writeExecutable(join(fakeBin, "node"), [
  "#!/bin/sh",
  "set -eu",
  "if [ \"${FAKE_PAUSE_RUNTIME_LOCK_ACQUIRE:-false}\" = \"true\" ] && [ \"${1:-}\" = \"--import\" ] && [ \"${3:-}\" = \"src/runtime-lock.ts\" ] && [ \"${4:-}\" = \"acquire\" ] && [ -n \"${FAKE_PAUSE_MARKER:-}\" ]; then",
  "  printf '%s\\n' \"$$\" > \"$FAKE_PAUSE_MARKER\"",
  "  exec /bin/sleep 300",
  "fi",
  "REAL_NODE=__REAL_NODE__",
  "if [ \"${FAKE_FAIL_RUNTIME_LOCK_ACQUIRE_ONCE:-false}\" = \"true\" ] && [ \"${1:-}\" = \"--import\" ] && [ \"${3:-}\" = \"src/runtime-lock.ts\" ] && [ \"${4:-}\" = \"acquire\" ] && [ -n \"${FAKE_RUNTIME_LOCK_FAILURE_MARKER:-}\" ] && [ -f \"$FAKE_RUNTIME_LOCK_FAILURE_MARKER\" ]; then",
  "  rm -f \"$FAKE_RUNTIME_LOCK_FAILURE_MARKER\"",
  "  echo 'injected runtime ownership acquisition failure' >&2",
  "  exit 91",
  "fi",
  "if [ \"${FAKE_PAUSE_RELEASE_PROBE:-false}\" = \"true\" ] && [ -n \"${FAKE_PAUSE_MARKER:-}\" ]; then",
  "  for arg in \"$@\"; do",
  "    if [ \"$arg\" = \"scripts/probe-release.mjs\" ]; then",
  "      printf '%s\\n' \"$$\" > \"$FAKE_PAUSE_MARKER\"",
  "      exec /bin/sleep 300",
  "    fi",
  "  done",
  "fi",
  "if [ \"${FAKE_FAIL_DEPLOYMENT_LOCK_CHECK_ONCE:-false}\" = \"true\" ] && [ \"${KONTROL_USE_EXISTING_DIST:-false}\" = \"true\" ] && [ \"${1:-}\" = \"--import\" ] && [ \"${3:-}\" = \"src/deployment-lock.ts\" ] && [ \"${4:-}\" = \"check\" ] && [ -n \"${FAKE_DEPLOYMENT_LOCK_FAILURE_MARKER:-}\" ] && [ -f \"$FAKE_DEPLOYMENT_LOCK_FAILURE_MARKER\" ]; then",
  "  rm -f \"$FAKE_DEPLOYMENT_LOCK_FAILURE_MARKER\"",
  "  if [ \"${FAKE_REMOVE_DEPLOYMENT_LOCK_ON_CHECK_ONCE:-false}\" = \"true\" ]; then rm -f \"$KONTROL_STATE_DIR/deployment.lock\"; fi",
  "  echo 'injected deployment ownership check failure' >&2",
  "  exit 92",
  "fi",
  "for arg in \"$@\"; do",
  "  case \"$arg\" in",
  "    scripts/probe-workspace-app.mjs|scripts/probe-kontrol-readiness.mjs|scripts/probe-release.mjs|scripts/validate-release.mjs) exit 0 ;;",
  "  esac",
  "done",
  "exec \"$REAL_NODE\" \"$@\"",
  "",
].join("\n").replace("__REAL_NODE__", realNode));

writeExecutable(join(fakeBin, "sleep"), [
  "#!/bin/sh",
  "exit 0",
  "",
].join("\n"));

writeExecutable(join(fakeBin, "curl"), [
  "#!/bin/sh",
  "set -eu",
  "url=\"\"",
  "for arg in \"$@\"; do",
  "  case \"$arg\" in http://*|https://*) url=\"$arg\" ;; esac",
  "done",
  "code=200",
  "if [ \"$FAKE_FAIL_ALL\" = \"true\" ]; then",
  "  case \"$url\" in *healthz*|*core-readyz*) code=503 ;; esac",
  "elif [ -n \"$FAKE_FAIL_BUILD_ID\" ] && [ \"$KONTROL_EXPECTED_BUILD_ID\" = \"$FAKE_FAIL_BUILD_ID\" ]; then",
  "  case \"$url\" in *healthz*|*core-readyz*) code=503 ;; esac",
  "fi",
  "printf '%s' \"$code\"",
  "",
].join("\n"));

writeExecutable(join(fakeBin, "tmux"), [
  "#!/bin/sh",
  "set -eu",
  "state=\"$FAKE_TMUX_STATE\"",
  "mkdir -p \"$state\"",
  "command=\"\${1:-}\"",
  "target=\"\"",
  "previous=\"\"",
  "last=\"\"",
  "for arg in \"$@\"; do",
  "  last=\"$arg\"",
  "  if [ \"$previous\" = \"-s\" ] || [ \"$previous\" = \"-t\" ]; then target=\"$arg\"; fi",
  "  previous=\"$arg\"",
  "done",
  "pid_file() { printf '%s/%s.pid' \"$state\" \"$1\"; }",
  "case \"$command\" in",
  "  new-session)",
  "    [ -n \"$target\" ] || exit 1",
  "    if [ \"$target\" = \"kontrol-server\" ] && [ -n \"${FAKE_FAIL_SERVER_LAUNCH_MARKER:-}\" ] && [ -f \"$FAKE_FAIL_SERVER_LAUNCH_MARKER\" ]; then",
  "      remaining=\"$(cat \"$FAKE_FAIL_SERVER_LAUNCH_MARKER\")\"",
  "      if [ \"$remaining\" -gt 0 ]; then",
  "        printf '%s\\n' \"$((remaining - 1))\" > \"$FAKE_FAIL_SERVER_LAUNCH_MARKER\"",
  "        echo 'injected kontrol-server launch failure' >&2",
  "        exit 93",
  "      fi",
  "    fi",
  "    file=\"$(pid_file \"$target\")\"",
  "    if [ -f \"$file\" ]; then",
  "      old_pid=\"$(cat \"$file\")\"",
  "      old_state=\"\"",
  "      if [ -r \"/proc/$old_pid/stat\" ]; then old_state=\"$(awk '{print $3}' \"/proc/$old_pid/stat\")\"; fi",
  "      if [ \"$old_state\" != \"Z\" ] && kill -0 \"$old_pid\" 2>/dev/null; then exit 1; fi",
  "      rm -f \"$file\"",
  "    fi",
  "    /usr/bin/setsid /usr/bin/sleep 300 </dev/null >/dev/null 2>&1 &",
  "    child_pid=\"$!\"",
  "    printf '%s\\n' \"$child_pid\" > \"$file\"",
  "    if [ \"$target\" = \"kontrol-supervisor\" ]; then",
  "      status_file=\"$(printf '%s\\n' \"$last\" | sed -n 's/.*--status-file \\([^ ]*\\).*/\\1/p')\"",
  "      if [ -n \"$status_file\" ]; then",
  "        mkdir -p \"$(dirname \"$status_file\")\"",
  "        printf '%s\\n' '{\"state\": \"healthy\"}' > \"$status_file\"",
  "      fi",
  "    fi",
  "    ;;",
  "  has-session)",
  "    file=\"$(pid_file \"$target\")\"",
  "    [ -f \"$file\" ] || exit 1",
  "    pid=\"$(cat \"$file\")\"",
  "    if kill -0 \"$pid\" 2>/dev/null; then exit 0; fi",
  "    rm -f \"$file\"",
  "    exit 1",
  "    ;;",
  "  send-keys)",
  "    exit 0",
  "    ;;",
  "  kill-session)",
  "    file=\"$(pid_file \"$target\")\"",
  "    if [ -f \"$file\" ]; then",
  "      pid=\"$(cat \"$file\")\"",
  "      kill \"$pid\" 2>/dev/null || true",
  "      rm -f \"$file\"",
  "    fi",
  "    ;;",
  "  list-panes)",
  "    file=\"$(pid_file \"$target\")\"",
  "    [ -f \"$file\" ] || exit 1",
  "    cat \"$file\"",
  "    ;;",
  "  *)",
  "    exit 1",
  "    ;;",
  "esac",
  "",
].join("\n"));

writeExecutable(join(fakeBin, "npm"), [
  "#!/bin/sh",
  "set -eu",
  "printf '%s\\n' \"$*\" >> \"$FAKE_NPM_LOG\"",
  "task=\"\"",
  "for arg in \"$@\"; do",
  "  case \"$arg\" in",
  "    run|--silent) ;;",
  "    *) task=\"$arg\" ;;",
  "  esac",
  "done",
  "if [ \"$task\" = \"typecheck\" ]; then",
  "  if [ \"${FAKE_FAIL_TYPECHECK:-false}\" = \"true\" ]; then exit 42; fi",
  "  exit 0",
  "fi",
  "if [ \"$task\" = \"build\" ]; then",
  "  if [ -n \"${FAKE_BUILD_DELAY_SECONDS:-}\" ]; then /bin/sleep \"$FAKE_BUILD_DELAY_SECONDS\"; fi",
  "  candidate=\"$FAKE_REPO_ROOT/releases/$FAKE_CANDIDATE_BUILD_ID\"",
  "  mkdir -p \"$candidate/ui\"",
  "  printf '{\"buildId\":\"%s\",\"schemaVersion\":0,\"minReadableSchemaVersion\":0,\"maxReadableSchemaVersion\":0,\"releaseFormatVersion\":2}\\n' \"$FAKE_CANDIDATE_BUILD_ID\" > \"$candidate/build-meta.json\"",
  "  : > \"$candidate/cli.js\"",
  "  : > \"$candidate/server.js\"",
  "  : > \"$candidate/acp-duplex.js\"",
  "  : > \"$candidate/acp-worker-token.mjs\"",
  "  : > \"$candidate/ui/workspace-app.html\"",
  "  printf '{\"buildId\":\"%s\",\"artifactPath\":\"%s\"}\\n' \"$FAKE_CANDIDATE_BUILD_ID\" \"$candidate\" > \"$KONTROL_BUILD_RESULT_PATH\"",
  "  exit 0",
  "fi",
  "echo \"unexpected fake npm command: $*\" >&2",
  "exit 1",
  "",
].join("\n"));

function linkSnapshot(path) {
  try {
    const stats = lstatSync(path);
    if (!stats.isSymbolicLink()) return { kind: "non-link" };
    return { kind: "link", target: readlinkSync(path) };
  } catch {
    return undefined;
  }
}

function removeLink(path) {
  try {
    const stats = lstatSync(path);
    if (!stats.isSymbolicLink()) throw new Error("behavior harness refuses to remove non-link " + path);
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function removeGeneratedArtifact(path, originalBackup) {
  const snapshot = linkSnapshot(path);
  if (!snapshot) return;
  if (snapshot.kind === "link") {
    unlinkSync(path);
    return;
  }
  // A non-link is removable here only when the original non-link was moved to
  // the harness backup during setup. This keeps the test from deleting an
  // operator-owned checkout artifact if setup failed before the move.
  if (originalBackup && pathExists(originalBackup)) rmSync(path, { recursive: true, force: true });
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function processStartToken(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    const fields = closingParen >= 0 ? stat.slice(closingParen + 2).trim().split(/\s+/) : [];
    return fields[19] ? `proc:${fields[19]}` : undefined;
  } catch {
    return undefined;
  }
}

function liveOwner(lock) {
  const pid = Number(lock?.pid);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    const token = processStartToken(pid);
    return !lock.startToken || !token || token === lock.startToken;
  } catch {
    return false;
  }
}

function liveRuntimeOwner(lock) {
  const pid = Number(lock?.launcherPid);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    const token = processStartToken(pid);
    return !lock.launcherStartToken || !token || token === lock.launcherStartToken;
  } catch {
    return false;
  }
}

function acquireBehaviorLock() {
  const lock = { pid: process.pid, startToken: processStartToken(process.pid) };
  for (;;) {
    try {
      writeFileSync(behaviorLockPath, `${JSON.stringify(lock)}\n`, { flag: "wx", mode: 0o600 });
      return lock;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let existing;
      try { existing = JSON.parse(readFileSync(behaviorLockPath, "utf8")); } catch { /* stale or partial test lock */ }
      if (liveOwner(existing)) {
        rmSync(harnessRoot, { recursive: true, force: true });
        throw new Error(`start-all.behavior.test.mjs is already running (pid ${existing.pid})`);
      }
      const reclaimPath = `${behaviorLockPath}.reclaim-${process.pid}`;
      try {
        renameSync(behaviorLockPath, reclaimPath);
        rmSync(reclaimPath, { force: true });
      } catch {
        // Another test reclaimed the stale lock; retry the exclusive create.
      }
    }
  }
}

function stopFakeSessions() {
  for (const entry of readdirSync(fakeTmuxState)) {
    if (!entry.endsWith(".pid")) continue;
    const path = join(fakeTmuxState, entry);
    try {
      process.kill(Number(readFileSync(path, "utf8").trim()), "SIGTERM");
    } catch { /* already gone */ }
    rmSync(path, { force: true });
  }
}

const behaviorLock = acquireBehaviorLock();

function writeEnvironment(stateDir, port, options) {
  const opts = options || {};
  const envPath = join(harnessRoot, "environment-" + port + ".env");
  writeFileSync(envPath, [
    "HOST=127.0.0.1",
    "PORT=" + port,
    "KONTROL_AUTH_MODE=tunnel",
    "KONTROL_ALLOWED_ROOTS=" + root,
    "KONTROL_ALLOWED_HOSTS=127.0.0.1,localhost",
    "KONTROL_PUBLIC_BASE_URL=http://127.0.0.1:" + port,
    "KONTROL_STATE_DIR=" + stateDir,
    "KONTROL_WORKTREE_ROOT=" + join(harnessRoot, "worktrees-" + port),
    "KONTROL_ACP_ENABLED=false",
    // Launcher behavior suite: boots exercise lifecycle plumbing, not the
    // approval boundary; the ask baseline would trip the tunnel reviewer gate.
    "KONTROL_POLICY_MODE=allow",
    "START_CRUSH_ADAPTER=false",
    "START_HERMES_ADAPTER=false",
    "KONTROL_TUNNEL_DOCTOR=false",
    "KONTROL_STARTUP_PROFILE=dev-fast",
    "KONTROL_USE_EXISTING_DIST=" + (opts.useExistingDist ? "true" : "false"),
    "FAKE_CANDIDATE_BUILD_ID=" + candidateBuildId,
    "FAKE_FAIL_BUILD_ID=" + (opts.failBuildId || ""),
    "FAKE_FAIL_ALL=" + (opts.failAll ? "true" : "false"),
    "FAKE_FAIL_RUNTIME_LOCK_ACQUIRE_ONCE=" + (opts.failRuntimeLockAcquireOnce ? "true" : "false"),
    "FAKE_RUNTIME_LOCK_FAILURE_MARKER=" + (opts.runtimeLockFailureMarker || ""),
    "FAKE_FAIL_DEPLOYMENT_LOCK_CHECK_ONCE=" + (opts.failDeploymentLockCheckOnce ? "true" : "false"),
    "FAKE_REMOVE_DEPLOYMENT_LOCK_ON_CHECK_ONCE=" + (opts.removeDeploymentLockOnCheckOnce ? "true" : "false"),
    "FAKE_DEPLOYMENT_LOCK_FAILURE_MARKER=" + (opts.deploymentLockFailureMarker || ""),
    "FAKE_FAIL_SERVER_LAUNCH_MARKER=" + (opts.failServerLaunchMarker || ""),
    "FAKE_BUILD_DELAY_SECONDS=" + (opts.buildDelaySeconds || ""),
    "FAKE_PAUSE_RELEASE_PROBE=" + (opts.pauseReleaseProbe ? "true" : "false"),
    "FAKE_PAUSE_RUNTIME_LOCK_ACQUIRE=" + (opts.pauseRuntimeLockAcquire ? "true" : "false"),
    "FAKE_PAUSE_MARKER=" + (opts.pauseMarker || ""),
  ].join("\n") + "\n");
  return envPath;
}

function runLauncher(envPath, extraEnv = {}) {
  return spawnSync("bash", ["start-all.sh"], {
    cwd: root,
    detached: true,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      PATH: fakeBin + ":" + process.env.PATH,
      KONTROL_ENV_FILE: envPath,
      FAKE_REPO_ROOT: root,
      FAKE_TMUX_STATE: fakeTmuxState,
      FAKE_NPM_LOG: join(harnessRoot, "npm.log"),
      FAKE_CANDIDATE_BUILD_ID: candidateBuildId,
      ...extraEnv,
    },
  });
}

function runRestart(envPath, extraEnv = {}) {
  return spawnSync("bash", ["restart-kontrol.sh"], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      PATH: fakeBin + ":" + process.env.PATH,
      KONTROL_ENV_FILE: envPath,
      FAKE_REPO_ROOT: root,
      FAKE_TMUX_STATE: fakeTmuxState,
      FAKE_NPM_LOG: join(harnessRoot, "npm.log"),
      FAKE_CANDIDATE_BUILD_ID: candidateBuildId,
      ...extraEnv,
    },
  });
}

function runRestartAsync(envPath, extraEnv = {}) {
  return startRestartController(envPath, extraEnv).result;
}

function startRestartController(envPath, extraEnv = {}) {
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const child = spawn("bash", ["restart-kontrol.sh"], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      PATH: fakeBin + ":" + process.env.PATH,
      KONTROL_ENV_FILE: envPath,
      FAKE_REPO_ROOT: root,
      FAKE_TMUX_STATE: fakeTmuxState,
      FAKE_NPM_LOG: join(harnessRoot, "npm.log"),
      FAKE_CANDIDATE_BUILD_ID: candidateBuildId,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.once("close", (status, signal) => resolveResult({ status, signal, stdout, stderr }));
  return { child, result };
}

function processParentPid(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    const fields = closingParen >= 0 ? stat.slice(closingParen + 2).trim().split(/\s+/) : [];
    return Number(fields[1]);
  } catch {
    return undefined;
  }
}

function killController(controller, markerPath, signal = "SIGKILL") {
  const pids = [];
  let current = Number(readFileSync(markerPath, "utf8").trim());
  while (Number.isInteger(current) && current > 1 && current !== process.pid && current !== controller.child.pid && !pids.includes(current)) {
    pids.push(current);
    current = processParentPid(current);
  }
  if (current === controller.child.pid) pids.push(current);
  for (const pid of pids.reverse()) {
    try { process.kill(pid, signal); }
    catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
}

function waitForPath(path, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (pathExists(path)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, 10);
    };
    check();
  });
}

const originalDist = linkSnapshot(join(root, "dist"));
const originalPrevious = linkSnapshot(join(root, "dist.previous"));
const originalDistBackup = join(harnessRoot, "original-dist");
const originalPreviousBackup = join(harnessRoot, "original-dist-previous");

const baseBuildId = "kontrol-test-base-" + process.pid;
const candidateBuildId = "kontrol-test-candidate-" + process.pid;
const baseRelease = join(root, "releases", baseBuildId);
const candidateRelease = join(root, "releases", candidateBuildId);
mkdirSync(join(baseRelease, "ui"), { recursive: true });
writeFileSync(join(baseRelease, "build-meta.json"), JSON.stringify({
  buildId: baseBuildId,
  schemaVersion: 0,
  minReadableSchemaVersion: 0,
  maxReadableSchemaVersion: 0,
  releaseFormatVersion: 2,
}) + "\n");
for (const file of ["cli.js", "server.js", "acp-duplex.js", "ui/workspace-app.html"]) writeFileSync(join(baseRelease, file), "test-artifact\n");

try {
  if (originalDist?.kind === "link") removeLink(join(root, "dist"));
  if (originalDist?.kind === "non-link") {
    cpSync(join(root, "dist"), originalDistBackup, { recursive: true });
    rmSync(join(root, "dist"), { recursive: true, force: true });
  }
  if (originalPrevious?.kind === "link") removeLink(join(root, "dist.previous"));
  if (originalPrevious?.kind === "non-link") {
    cpSync(join(root, "dist.previous"), originalPreviousBackup, { recursive: true });
    rmSync(join(root, "dist.previous"), { recursive: true, force: true });
  }
  symlinkSync(baseRelease, join(root, "dist"));

  const successfulState = mkdtempSync(join(harnessRoot, "state-success-"));
  const successfulEnv = writeEnvironment(successfulState, 17676, { useExistingDist: true });
  const first = runLauncher(successfulEnv);
  assert.equal(first.status, 0, "successful fake generation failed:\n" + first.stdout + "\n" + first.stderr);
  const activeGeneration = JSON.parse(readFileSync(join(successfulState, "generation.json"), "utf8"));
  const activeLock = JSON.parse(readFileSync(join(successfulState, "runtime.lock"), "utf8"));
  assert.equal(activeGeneration.status, "active");
  assert.equal(activeGeneration.activeBuildId, baseBuildId);
  assert.equal(activeGeneration.artifactPath, baseRelease);
  assert.equal(activeLock.launcher, "tmux-stack");
  assert.equal(activeLock.buildId, baseBuildId);
  assert.equal(activeLock.artifactPath, baseRelease);
  const activeDeploymentName = readdirSync(successfulState).find((name) => name.startsWith("deployment.") && name.endsWith(".json"));
  assert.ok(activeDeploymentName, "successful activation must persist a deployment record");
  const activeDeployment = JSON.parse(readFileSync(join(successfulState, activeDeploymentName), "utf8"));
  assert.equal(activeDeployment.status, "committed");
  assert.equal(activeDeployment.outcome, "active");
  assert.doesNotThrow(() => process.kill(activeLock.launcherPid, 0), "supervisor must own the handed-off lock");

  const generationBeforeFailedRestart = readFileSync(join(successfulState, "generation.json"), "utf8");
  const lockBeforeFailedRestart = readFileSync(join(successfulState, "runtime.lock"), "utf8");
  const failedRestart = runRestart(successfulEnv, { FAKE_FAIL_TYPECHECK: "true" });
  assert.notEqual(failedRestart.status, 0, "restart must fail when candidate preflight fails");
  assert.match(failedRestart.stdout + "\n" + failedRestart.stderr, /current Kontrol generation was left running/);
  assert.doesNotThrow(() => process.kill(activeLock.launcherPid, 0), "failed candidate preparation must leave the old supervisor alive");
  assert.equal(readFileSync(join(successfulState, "generation.json"), "utf8"), generationBeforeFailedRestart, "failed preflight must not rewrite generation state");
  assert.equal(readFileSync(join(successfulState, "runtime.lock"), "utf8"), lockBeforeFailedRestart, "failed preflight must not change runtime ownership");

  const npmLogBeforeConflict = readFileSync(join(harnessRoot, "npm.log"), "utf8");
  const second = runLauncher(successfulEnv);
  assert.notEqual(second.status, 0, "a second launcher must be rejected before preflight/build mutation");
  assert.match(second.stdout + "\n" + second.stderr, /already managed by tmux-stack/, `second launch output (status=${second.status}, error=${second.error?.message ?? "none"}):\n${second.stdout}\n${second.stderr}`);
  assert.equal(readFileSync(join(successfulState, "generation.json"), "utf8"), JSON.stringify(activeGeneration, null, 2) + "\n");
  assert.equal(readFileSync(join(harnessRoot, "npm.log"), "utf8"), npmLogBeforeConflict, "rejected launch must not invoke the build gate");
  process.kill(activeLock.launcherPid, "SIGTERM");
  stopFakeSessions();

  // A clean restart after the process/supervisor disappeared may legitimately
  // select the same committed immutable release. It must not be mistaken for
  // a rollback attempting to restore the failed candidate to itself.
  const sameGenerationRestart = runLauncher(successfulEnv);
  assert.equal(sameGenerationRestart.status, 0, "restarting the committed release should be allowed:\n" + sameGenerationRestart.stdout + "\n" + sameGenerationRestart.stderr);
  const sameGeneration = JSON.parse(readFileSync(join(successfulState, "generation.json"), "utf8"));
  assert.equal(sameGeneration.status, "active");
  assert.equal(sameGeneration.activeBuildId, baseBuildId);
  const sameGenerationLock = JSON.parse(readFileSync(join(successfulState, "runtime.lock"), "utf8"));
  process.kill(sameGenerationLock.launcherPid, "SIGTERM");
  stopFakeSessions();

  // A deployment-lock command can fail transiently without the durable lock
  // being lost. The controller must keep the live token and continue the
  // transaction rather than spawning a competing recovery controller.
  const transientDeploymentMarker = join(harnessRoot, "fail-transient-deployment-check-once");
  writeFileSync(transientDeploymentMarker, "fail once\n");
  const transientDeploymentEnv = writeEnvironment(successfulState, 17676, {
    useExistingDist: true,
    failDeploymentLockCheckOnce: true,
    deploymentLockFailureMarker: transientDeploymentMarker,
  });
  const transientDeploymentRestart = runRestart(transientDeploymentEnv);
  assert.equal(transientDeploymentRestart.status, 0, "transient deployment-lock check failure should not break restart:\n" + transientDeploymentRestart.stdout + "\n" + transientDeploymentRestart.stderr);
  assert.match(transientDeploymentRestart.stdout + "\n" + transientDeploymentRestart.stderr, /injected deployment ownership check failure/);
  const transientDeploymentGeneration = JSON.parse(readFileSync(join(successfulState, "generation.json"), "utf8"));
  assert.equal(transientDeploymentGeneration.status, "active");
  const transientDeploymentLock = JSON.parse(readFileSync(join(successfulState, "runtime.lock"), "utf8"));
  process.kill(transientDeploymentLock.launcherPid, "SIGTERM");
  stopFakeSessions();

  // Two deployment controllers must serialize before either can overwrite
  // candidate state or stop the serving generation.
  removeLink(join(root, "dist"));
  symlinkSync(baseRelease, join(root, "dist"));
  const concurrentState = mkdtempSync(join(harnessRoot, "state-concurrent-"));
  const concurrentEnv = writeEnvironment(concurrentState, 17681, { useExistingDist: true, buildDelaySeconds: "2" });
  const concurrentStart = runLauncher(concurrentEnv);
  assert.equal(concurrentStart.status, 0, "concurrent baseline generation failed:\n" + concurrentStart.stdout + "\n" + concurrentStart.stderr);
  const firstConcurrent = runRestartAsync(concurrentEnv);
  const deploymentLockPath = join(concurrentState, "deployment.lock");
  const lockDeadline = Date.now() + 5_000;
  while (!pathExists(deploymentLockPath) && Date.now() < lockDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(pathExists(deploymentLockPath), true, "first restart must hold deployment ownership during preparation");
  const secondConcurrent = await runRestartAsync(concurrentEnv);
  assert.notEqual(secondConcurrent.status, 0, "second concurrent restart must be rejected before it can stop the generation");
  assert.match(secondConcurrent.stdout + "\n" + secondConcurrent.stderr, /deployment is already in progress/);
  const firstResult = await firstConcurrent;
  assert.equal(firstResult.status, 0, "first concurrent restart must complete:\n" + firstResult.stdout + "\n" + firstResult.stderr);
  const concurrentGeneration = JSON.parse(readFileSync(join(concurrentState, "generation.json"), "utf8"));
  assert.equal(concurrentGeneration.status, "active");
  assert.equal(concurrentGeneration.activeBuildId, candidateBuildId);
  assert.equal(pathExists(deploymentLockPath), false, "deployment lock must be released after the transaction");
  const concurrentLock = JSON.parse(readFileSync(join(concurrentState, "runtime.lock"), "utf8"));
  process.kill(concurrentLock.launcherPid, "SIGTERM");
  stopFakeSessions();

  // A deployment controller can disappear without running EXIT cleanup. If
  // that happens during candidate preparation, the serving generation must
  // remain intact and a later controller must be able to reclaim the stale
  // deployment lock and complete a new handoff.
  removeLink(join(root, "dist"));
  symlinkSync(baseRelease, join(root, "dist"));
  const prepareCrashState = mkdtempSync(join(harnessRoot, "state-controller-crash-prepare-"));
  const prepareCrashEnv = writeEnvironment(prepareCrashState, 17684, { useExistingDist: true });
  const prepareCrashStart = runLauncher(prepareCrashEnv);
  assert.equal(prepareCrashStart.status, 0, "controller-crash preparation baseline failed:\n" + prepareCrashStart.stdout + "\n" + prepareCrashStart.stderr);
  const prepareCrashLock = JSON.parse(readFileSync(join(prepareCrashState, "runtime.lock"), "utf8"));
  const prepareCrashMarker = join(harnessRoot, "pause-release-probe");
  writeEnvironment(prepareCrashState, 17684, { pauseReleaseProbe: true, pauseMarker: prepareCrashMarker });
  const prepareCrashController = startRestartController(prepareCrashEnv);
  assert.equal(await waitForPath(prepareCrashMarker), true, "controller must reach candidate preparation before SIGKILL");
  killController(prepareCrashController, prepareCrashMarker);
  const prepareCrashResult = await prepareCrashController.result;
  assert.equal(prepareCrashResult.signal, "SIGKILL", "preparation controller must be killed abruptly");
  assert.equal(liveRuntimeOwner(prepareCrashLock), true, "abrupt preparation death must leave the old serving owner alive");
  assert.equal(pathExists(join(prepareCrashState, "deployment.lock")), true, "abrupt preparation death must leave a reclaimable deployment record");
  const prepareCrashRecovery = runRestart(writeEnvironment(prepareCrashState, 17684, { useExistingDist: true }));
  assert.equal(prepareCrashRecovery.status, 0, "a later controller must recover after preparation-controller death:\n" + prepareCrashRecovery.stdout + "\n" + prepareCrashRecovery.stderr);
  const prepareCrashGeneration = JSON.parse(readFileSync(join(prepareCrashState, "generation.json"), "utf8"));
  assert.equal(prepareCrashGeneration.status, "active");
  assert.equal(prepareCrashGeneration.activeBuildId, candidateBuildId);
  const prepareCrashRecoveredLock = JSON.parse(readFileSync(join(prepareCrashState, "runtime.lock"), "utf8"));
  process.kill(prepareCrashRecoveredLock.launcherPid, "SIGTERM");
  stopFakeSessions();

  // A second crash point is after stop-all has removed A but before the new
  // controller has acquired serving ownership. The next controller must
  // converge by activating a candidate and, when that candidate is unhealthy,
  // restoring the exact committed A release rather than leaving no owner.
  removeLink(join(root, "dist"));
  symlinkSync(baseRelease, join(root, "dist"));
  const postStopCrashState = mkdtempSync(join(harnessRoot, "state-controller-crash-post-stop-"));
  const postStopCrashEnv = writeEnvironment(postStopCrashState, 17685, { useExistingDist: true });
  const postStopCrashStart = runLauncher(postStopCrashEnv);
  assert.equal(postStopCrashStart.status, 0, "controller-crash post-stop baseline failed:\n" + postStopCrashStart.stdout + "\n" + postStopCrashStart.stderr);
  const postStopCrashMarker = join(harnessRoot, "pause-runtime-lock-acquire");
  writeEnvironment(postStopCrashState, 17685, { pauseRuntimeLockAcquire: true, pauseMarker: postStopCrashMarker });
  const postStopCrashController = startRestartController(postStopCrashEnv);
  assert.equal(await waitForPath(postStopCrashMarker), true, "controller must reach post-stop ownership handoff before SIGKILL");
  assert.equal(pathExists(join(fakeTmuxState, "kontrol-server.pid")), false, "post-stop pause must occur after the old server session is gone");
  killController(postStopCrashController, postStopCrashMarker);
  const postStopCrashResult = await postStopCrashController.result;
  assert.equal(postStopCrashResult.signal, "SIGKILL", "post-stop controller must be killed abruptly");
  const postStopGenerationBeforeRecovery = JSON.parse(readFileSync(join(postStopCrashState, "generation.json"), "utf8"));
  assert.equal(postStopGenerationBeforeRecovery.activeBuildId, baseBuildId, "an interrupted handoff must retain A as the committed generation");
  assert.equal(pathExists(join(postStopCrashState, "deployment.lock")), true, "post-stop controller death must leave a reclaimable deployment record");
  writeEnvironment(postStopCrashState, 17685, { failBuildId: candidateBuildId });
  const postStopCrashRecovery = runRestart(postStopCrashEnv);
  assert.equal(postStopCrashRecovery.status, 0, "a later controller must restore A after post-stop controller death:\n" + postStopCrashRecovery.stdout + "\n" + postStopCrashRecovery.stderr);
  const postStopCrashGeneration = JSON.parse(readFileSync(join(postStopCrashState, "generation.json"), "utf8"));
  assert.equal(postStopCrashGeneration.status, "rolled_back");
  assert.equal(postStopCrashGeneration.activeBuildId, baseBuildId);
  assert.equal(postStopCrashGeneration.lastKnownGoodBuildId, baseBuildId);
  const postStopCrashLock = JSON.parse(readFileSync(join(postStopCrashState, "runtime.lock"), "utf8"));
  assert.equal(postStopCrashLock.buildId, baseBuildId);
  process.kill(postStopCrashLock.launcherPid, "SIGTERM");
  stopFakeSessions();

  removeLink(join(root, "dist"));
  removeGeneratedArtifact(join(root, "dist.previous"), originalPreviousBackup);
  symlinkSync(baseRelease, join(root, "dist"));

  // Exercise the complete restart handoff: A remains healthy during
  // preparation, is stopped only after B is built, and B's failed readiness
  // returns the immutable A release through the same controller.
  const handoffState = mkdtempSync(join(harnessRoot, "state-handoff-"));
  const handoffEnv = writeEnvironment(handoffState, 17679, { useExistingDist: true, failBuildId: candidateBuildId });
  const handoffStart = runLauncher(handoffEnv);
  assert.equal(handoffStart.status, 0, "handoff baseline generation failed:\n" + handoffStart.stdout + "\n" + handoffStart.stderr);
  const handoffRestart = runRestart(handoffEnv);
  assert.equal(handoffRestart.status, 0, "failed candidate activation should roll back to A:\n" + handoffRestart.stdout + "\n" + handoffRestart.stderr);
  const handoffGeneration = JSON.parse(readFileSync(join(handoffState, "generation.json"), "utf8"));
  assert.equal(handoffGeneration.status, "rolled_back");
  assert.equal(handoffGeneration.requestedBuildId, candidateBuildId);
  assert.equal(handoffGeneration.activeBuildId, baseBuildId);
  assert.equal(handoffGeneration.lastKnownGoodBuildId, baseBuildId);
  assert.equal(handoffGeneration.lastKnownGoodArtifactPath, baseRelease);
  assert.equal(readlinkSync(join(root, "dist")), baseRelease);

  // Rebuild the same failing candidate again. Rollback must continue to use
  // the committed A record; the failed B candidate must never become the
  // last-known-good pointer merely because it was prepared twice.
  const handoffRestartAgain = runRestart(handoffEnv);
  assert.equal(handoffRestartAgain.status, 0, "repeated failed candidate activation should roll back to A:\n" + handoffRestartAgain.stdout + "\n" + handoffRestartAgain.stderr);
  const repeatedHandoffGeneration = JSON.parse(readFileSync(join(handoffState, "generation.json"), "utf8"));
  assert.equal(repeatedHandoffGeneration.status, "rolled_back");
  assert.equal(repeatedHandoffGeneration.requestedBuildId, candidateBuildId);
  assert.equal(repeatedHandoffGeneration.activeBuildId, baseBuildId);
  assert.equal(repeatedHandoffGeneration.lastKnownGoodBuildId, baseBuildId);
  assert.equal(repeatedHandoffGeneration.lastKnownGoodArtifactPath, baseRelease);
  assert.notEqual(repeatedHandoffGeneration.lastKnownGoodBuildId, candidateBuildId);
  assert.equal(readlinkSync(join(root, "dist")), baseRelease);
  const repeatedHandoffLock = JSON.parse(readFileSync(join(handoffState, "runtime.lock"), "utf8"));
  process.kill(repeatedHandoffLock.launcherPid, "SIGTERM");
  stopFakeSessions();

  // The old generation is stopped before activation starts. Force the first
  // runtime-lock acquisition in that activation to fail; the activation trap
  // must reacquire ownership and restore A rather than leaving the stack down.
  removeLink(join(root, "dist"));
  symlinkSync(baseRelease, join(root, "dist"));
  const gapState = mkdtempSync(join(harnessRoot, "state-handoff-gap-"));
  const gapMarker = join(harnessRoot, "fail-runtime-lock-once");
  const gapEnv = writeEnvironment(gapState, 17680, { useExistingDist: true, failRuntimeLockAcquireOnce: true, runtimeLockFailureMarker: gapMarker });
  const gapStart = runLauncher(gapEnv);
  assert.equal(gapStart.status, 0, "handoff-gap baseline generation failed:\n" + gapStart.stdout + "\n" + gapStart.stderr);
  writeFileSync(gapMarker, "fail once\n");
  const gapRestart = runRestart(gapEnv);
  if (!/injected runtime ownership acquisition failure/.test(gapRestart.stdout + "\n" + gapRestart.stderr)) {
    throw new Error("post-stop failure injection did not fire:\n" + gapRestart.stdout + "\n" + gapRestart.stderr);
  }
  assert.equal(gapRestart.status, 0, "post-stop lock failure must recover the previous generation:\n" + gapRestart.stdout + "\n" + gapRestart.stderr);
  const gapGeneration = JSON.parse(readFileSync(join(gapState, "generation.json"), "utf8"));
  assert.equal(gapGeneration.status, "rolled_back", `post-stop recovery lost rollback provenance: ${JSON.stringify(gapGeneration)}\n${gapRestart.stdout}\n${gapRestart.stderr}`);
  assert.equal(gapGeneration.activeBuildId, baseBuildId);
  assert.equal(gapGeneration.lastKnownGoodBuildId, baseBuildId);
  const gapLock = JSON.parse(readFileSync(join(gapState, "runtime.lock"), "utf8"));
  assert.equal(gapLock.buildId, baseBuildId);
  process.kill(gapLock.launcherPid, "SIGTERM");
  stopFakeSessions();

  // The deployment-lock check itself is another post-stop boundary. A fresh
  // controller must recover the exact committed release instead of exiting
  // with no runtime owner and no rollback attempt.
  removeLink(join(root, "dist"));
  symlinkSync(baseRelease, join(root, "dist"));
  const deploymentGapState = mkdtempSync(join(harnessRoot, "state-deployment-gap-"));
  const deploymentGapMarker = join(harnessRoot, "fail-deployment-check-once");
  const deploymentGapEnv = writeEnvironment(deploymentGapState, 17682, {
    useExistingDist: true,
    failDeploymentLockCheckOnce: true,
    removeDeploymentLockOnCheckOnce: true,
    deploymentLockFailureMarker: deploymentGapMarker,
  });
  const deploymentGapStart = runLauncher(deploymentGapEnv);
  assert.equal(deploymentGapStart.status, 0, "deployment-gap baseline generation failed:\n" + deploymentGapStart.stdout + "\n" + deploymentGapStart.stderr);
  writeFileSync(deploymentGapMarker, "fail once\n");
  const deploymentGapRestart = runRestart(deploymentGapEnv);
  assert.match(deploymentGapRestart.stdout + "\n" + deploymentGapRestart.stderr, /injected deployment ownership check failure/);
  assert.equal(deploymentGapRestart.status, 0, "post-stop deployment-lock failure must recover the previous generation:\n" + deploymentGapRestart.stdout + "\n" + deploymentGapRestart.stderr);
  const deploymentGapGeneration = JSON.parse(readFileSync(join(deploymentGapState, "generation.json"), "utf8"));
  assert.equal(deploymentGapGeneration.status, "rolled_back");
  assert.equal(deploymentGapGeneration.activeBuildId, baseBuildId);
  assert.equal(deploymentGapGeneration.lastKnownGoodBuildId, baseBuildId);
  const deploymentGapLock = JSON.parse(readFileSync(join(deploymentGapState, "runtime.lock"), "utf8"));
  assert.equal(deploymentGapLock.buildId, baseBuildId);
  process.kill(deploymentGapLock.launcherPid, "SIGTERM");
  stopFakeSessions();

  removeLink(join(root, "dist"));
  removeGeneratedArtifact(join(root, "dist.previous"), originalPreviousBackup);
  symlinkSync(baseRelease, join(root, "dist"));
  const rollbackState = mkdtempSync(join(harnessRoot, "state-rollback-"));
  const rollbackEnv = writeEnvironment(rollbackState, 17677, { useExistingDist: false, failBuildId: candidateBuildId });
  const rollback = runLauncher(rollbackEnv);
  assert.equal(rollback.status, 0, "candidate rollback failed:\n" + rollback.stdout + "\n" + rollback.stderr);
  assert.match(rollback.stdout + "\n" + rollback.stderr, /KONTROL READY — ROLLED BACK/);
  const rollbackGeneration = JSON.parse(readFileSync(join(rollbackState, "generation.json"), "utf8"));
  assert.equal(rollbackGeneration.status, "rolled_back");
  assert.equal(rollbackGeneration.rollback, true);
  assert.equal(rollbackGeneration.requestedBuildId, candidateBuildId);
  assert.equal(rollbackGeneration.failedBuildId, candidateBuildId);
  assert.equal(rollbackGeneration.activeBuildId, baseBuildId);
  assert.equal(rollbackGeneration.artifactPath, baseRelease);
  const rollbackDeploymentName = readdirSync(rollbackState).find((name) => name.startsWith("deployment.") && name.endsWith(".json"));
  assert.ok(rollbackDeploymentName, "rollback must persist a deployment record");
  const rollbackDeployment = JSON.parse(readFileSync(join(rollbackState, rollbackDeploymentName), "utf8"));
  assert.equal(rollbackDeployment.status, "committed");
  assert.equal(rollbackDeployment.outcome, "rolled_back");
  assert.equal(rollbackDeployment.requestedBuildId, candidateBuildId);
  assert.equal(rollbackDeployment.failedBuildId, candidateBuildId);
  assert.equal(rollbackDeployment.lastKnownGoodBuildId, baseBuildId);
  assert.equal(readlinkSync(join(root, "dist")), baseRelease);
  assert.ok(pathExists(candidateRelease), "failed candidate release must be retained for forensics");
  assert.equal(readlinkSync(join(root, "dist")), baseRelease, "failed candidate must not replace the active projection");
  const rollbackLock = JSON.parse(readFileSync(join(rollbackState, "runtime.lock"), "utf8"));
  process.kill(rollbackLock.launcherPid, "SIGTERM");
  stopFakeSessions();

  // Force both the candidate activation and start-all's first in-process
  // rollback attempt to fail. restart-kontrol.sh must then recover through
  // its outer emergency trap, using the candidate record's build ID rather
  // than silently recording "unknown" provenance.
  removeLink(join(root, "dist"));
  symlinkSync(baseRelease, join(root, "dist"));
  const outerRecoveryState = mkdtempSync(join(harnessRoot, "state-outer-recovery-"));
  const outerRecoveryMarker = join(harnessRoot, "fail-server-launch-twice");
  const outerRecoveryEnv = writeEnvironment(outerRecoveryState, 17683, { useExistingDist: true, failServerLaunchMarker: outerRecoveryMarker });
  const outerRecoveryStart = runLauncher(outerRecoveryEnv);
  assert.equal(outerRecoveryStart.status, 0, "outer-recovery baseline generation failed:\n" + outerRecoveryStart.stdout + "\n" + outerRecoveryStart.stderr);
  writeFileSync(outerRecoveryMarker, "2\n");
  const outerRecoveryRestart = runRestart(outerRecoveryEnv);
  assert.equal(outerRecoveryRestart.status, 0, "outer emergency recovery should restore A:\n" + outerRecoveryRestart.stdout + "\n" + outerRecoveryRestart.stderr);
  assert.match(outerRecoveryRestart.stdout + "\n" + outerRecoveryRestart.stderr, /injected kontrol-server launch failure/);
  assert.match(outerRecoveryRestart.stdout + "\n" + outerRecoveryRestart.stderr, /exact previous-generation recovery/);
  const outerRecoveryGeneration = JSON.parse(readFileSync(join(outerRecoveryState, "generation.json"), "utf8"));
  assert.equal(outerRecoveryGeneration.status, "rolled_back");
  assert.equal(outerRecoveryGeneration.rollback, true);
  assert.equal(outerRecoveryGeneration.requestedBuildId, candidateBuildId);
  assert.equal(outerRecoveryGeneration.failedBuildId, candidateBuildId);
  assert.equal(outerRecoveryGeneration.activeBuildId, baseBuildId);
  assert.equal(outerRecoveryGeneration.lastKnownGoodBuildId, baseBuildId);
  const outerRecoveryLock = JSON.parse(readFileSync(join(outerRecoveryState, "runtime.lock"), "utf8"));
  process.kill(outerRecoveryLock.launcherPid, "SIGTERM");
  stopFakeSessions();

  removeLink(join(root, "dist"));
  removeGeneratedArtifact(join(root, "dist.previous"), originalPreviousBackup);
  symlinkSync(baseRelease, join(root, "dist"));
  const failedRollbackState = mkdtempSync(join(harnessRoot, "state-rollback-failed-"));
  const failedRollbackEnv = writeEnvironment(failedRollbackState, 17678, { useExistingDist: false, failAll: true });
  const failedRollback = runLauncher(failedRollbackEnv);
  assert.notEqual(failedRollback.status, 0, "failed restored generation must fail deterministically");
  const failedGeneration = JSON.parse(readFileSync(join(failedRollbackState, "generation.json"), "utf8"));
  assert.equal(failedGeneration.status, "failed");
  assert.equal(failedGeneration.rollback, true);
  assert.equal(failedGeneration.failedBuildId, candidateBuildId);
  assert.equal(pathExists(join(failedRollbackState, "runtime.lock")), false, "failed controller must release its lock");
  assert.equal(readlinkSync(join(root, "dist")), baseRelease);
  console.log("start-all.behavior.test.mjs: startup, lock handoff, conflict, crash recovery, rollback, and failed rollback passed");
} finally {
  stopFakeSessions();
  for (const path of [join(root, "dist"), join(root, "dist.previous")]) {
    removeGeneratedArtifact(path, path.endsWith("dist") ? originalDistBackup : originalPreviousBackup);
  }
  for (const entry of readdirSync(root)) {
    if (entry.startsWith("dist.failed-")) {
      const path = join(root, entry);
      if (linkSnapshot(path)) removeLink(path);
    }
  }
  rmSync(baseRelease, { recursive: true, force: true });
  rmSync(candidateRelease, { recursive: true, force: true });
  if (originalDist?.kind === "link") symlinkSync(originalDist.target, join(root, "dist"));
  if (originalDist?.kind === "non-link") cpSync(originalDistBackup, join(root, "dist"), { recursive: true });
  if (originalPrevious?.kind === "link") symlinkSync(originalPrevious.target, join(root, "dist.previous"));
  if (originalPrevious?.kind === "non-link") cpSync(originalPreviousBackup, join(root, "dist.previous"), { recursive: true });
  if (!originalDist) removeLink(join(root, "dist"));
  if (!originalPrevious) removeLink(join(root, "dist.previous"));
  rmSync(harnessRoot, { recursive: true, force: true });
  try {
    const currentLock = JSON.parse(readFileSync(behaviorLockPath, "utf8"));
    if (currentLock.pid === behaviorLock.pid && currentLock.startToken === behaviorLock.startToken) {
      rmSync(behaviorLockPath, { force: true });
    }
  } catch { /* lock was reclaimed after an interrupted test */ }
}
