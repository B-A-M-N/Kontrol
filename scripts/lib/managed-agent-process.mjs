import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { once } from "node:events";

const atomicWriteQueues = new Map();
const ATOMIC_RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160];
const TRANSIENT_RENAME_ERROR_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

async function withAtomicWriteLock(path, operation) {
  const preceding = atomicWriteQueues.get(path) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  atomicWriteQueues.set(path, current);
  await preceding.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (atomicWriteQueues.get(path) === current) atomicWriteQueues.delete(path);
  }
}

/**
 * Small shared lifecycle primitive for detached ACP children.
 *
 * The adapter process is allowed to restart independently of its child. The
 * ownership file therefore records enough identity to either terminate the
 * old process safely or prove that the PID was reused and discard the record.
 */
export function adapterStatePath(adapterName, fileName) {
  const root = process.env.KONTROL_STATE_DIR || join(process.env.TMPDIR || "/tmp", "kontrol-state");
  return join(root, "adapters", adapterName, fileName);
}

export function processStartToken(pid) {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParen = value.lastIndexOf(")");
    if (closingParen >= 0) {
      const fields = value.slice(closingParen + 2).trim().split(/\s+/);
      if (fields[19]) return `proc:${fields[19]}`;
    }
  } catch { /* non-Linux or process already gone */ }
  return undefined;
}

export function processAlive(record) {
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); } catch { return false; }
  return !record.processStartToken || processStartToken(pid) === record.processStartToken;
}

const GATED_CHILD_SOURCE = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const controlInput = fs.createReadStream(null, { fd: 3, autoClose: false });
const controlOutput = fs.createWriteStream(null, { fd: 4, autoClose: false });
const lines = createInterface({ input: controlInput, crlfDelay: Infinity });
let launch;
let started = false;
let worker;
let reportedWorkerExitCode;
const idleGateTimer = setTimeout(() => {
  if (!started) process.exit(0);
}, 60_000).unref();
const send = (message, callback) => controlOutput.write(JSON.stringify(message) + "\n", callback);
lines.on("line", (line) => {
  if (!launch) {
    try {
      launch = JSON.parse(line);
      if (typeof launch.command !== "string" || !Array.isArray(launch.args)
        || typeof launch.cwd !== "string" || !launch.env || typeof launch.env !== "object") {
        throw new Error("invalid launch specification");
      }
      send({ type: "ready", pid: process.pid });
    } catch (error) {
      send({ type: "wrapper_error", message: error.message }, () => process.exit(78));
    }
    return;
  }
  if (line === "abort" && !started) {
    process.exit(0);
    return;
  }
  if (line !== "start" || started) return;
  started = true;
  clearTimeout(idleGateTimer);
  try {
    worker = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: "inherit",
      windowsHide: true,
    });
    worker.once("spawn", () => send({ type: "worker_spawned", pid: worker.pid }));
    worker.once("error", (error) => {
      reportedWorkerExitCode = 127;
      send({ type: "worker_error", message: error.message, code: error.code });
      setTimeout(() => process.exit(reportedWorkerExitCode), 250).unref();
    });
    worker.once("exit", (code, signal) => {
      reportedWorkerExitCode = code ?? 1;
      send({ type: "worker_exit", code, signal });
      // Let the owner observe worker_exit and close the control pipe. That
      // closes this wrapper deterministically while preserving the worker's
      // exit code for the adapter lifecycle event.
      setTimeout(() => process.exit(reportedWorkerExitCode), 250).unref();
    });
  } catch (error) {
    send({ type: "worker_error", message: error.message, code: error.code }, () => process.exit(127));
  }
});
controlInput.once("end", () => {
  if (!started) process.exit(0);
  if (reportedWorkerExitCode !== undefined) process.exit(reportedWorkerExitCode);
});
lines.once("close", () => {
  if (!started) process.exit(0);
  if (reportedWorkerExitCode !== undefined) process.exit(reportedWorkerExitCode);
});
process.on("SIGTERM", () => {
  if (worker?.pid) {
    try { worker.kill("SIGTERM"); } catch { /* group termination remains authoritative */ }
  }
});
`;

/**
 * Start a detached process-group leader that cannot launch its worker until
 * the caller has durably recorded this PID as the owner. If the adapter exits
 * before start(), EOF closes the gate without executing the requested command.
 */
export async function prepareOwnedChild(command, args, options = {}) {
  if (typeof command !== "string" || !command || !Array.isArray(args)) {
    throw new TypeError("owned child requires a command and argument array");
  }
  const cwd = options.cwd;
  const env = options.env;
  if (typeof cwd !== "string" || !env || typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError("owned child requires an explicit cwd and environment");
  }
  const child = spawn(process.execPath, ["-e", GATED_CHILD_SOURCE], {
    cwd: "/",
    detached: options.detached !== false,
    env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const controlInput = child.stdio[3];
  const controlOutput = child.stdio[4];
  const messages = [];
  const waiters = new Set();
  let buffered = "";
  let closed = false;
  const rejectWaiters = (error) => {
    closed = true;
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  };
  controlOutput.setEncoding("utf8");
  controlOutput.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.type === "worker_exit" || message.type === "worker_error") controlInput.destroy();
      const waiter = [...waiters].find((item) => item.predicate(message));
      if (waiter) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else messages.push(message);
    }
  });
  controlOutput.once("end", () => rejectWaiters(new Error("owned child launch gate closed")));
  controlOutput.once("error", rejectWaiters);
  controlInput.once("error", rejectWaiters);
  child.once("error", rejectWaiters);

  const waitFor = (predicate, timeoutMs = 10_000) => {
    const queuedIndex = messages.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(messages.splice(queuedIndex, 1)[0]);
    if (closed) return Promise.reject(new Error("owned child launch gate closed"));
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("timed out waiting for owned child launch gate"));
      }, timeoutMs);
      waiters.add(waiter);
    });
  };
  const sendControl = async (value) => {
    const line = `${typeof value === "string" ? value : JSON.stringify(value)}\n`;
    if (controlInput.destroyed || controlInput.writableEnded) throw new Error("owned child launch gate is closed");
    const drained = once(controlInput, "drain");
    if (!controlInput.write(line)) await drained;
  };

  try {
    await once(child, "spawn");
    await sendControl({ command, args, cwd, env });
    const ready = await waitFor((message) => ["ready", "wrapper_error"].includes(message.type));
    if (ready.type !== "ready" || ready.pid !== child.pid) {
      throw new Error(ready.message || "owned child launch gate returned an invalid identity");
    }
  } catch (error) {
    controlInput.end();
    if (child.pid) await terminateProcessGroup({ pid: child.pid, processGroupId: child.pid, processStartToken: processStartToken(child.pid) }, 1_000).catch(() => {});
    throw error;
  }

  let startRequested = false;
  return {
    child,
    async start() {
      if (startRequested) throw new Error("owned child launch gate has already been opened");
      startRequested = true;
      await sendControl("start");
      const result = await waitFor((message) => ["worker_spawned", "worker_error"].includes(message.type));
      if (result.type !== "worker_spawned") {
        const error = new Error(result.message || "owned worker process failed to spawn");
        if (result.code) error.code = result.code;
        throw error;
      }
      return result;
    },
    abort() {
      if (startRequested) return;
      try { controlInput.write("abort\n"); } catch { /* closing the descriptor is the fallback */ }
      controlInput.end();
    },
  };
}

export async function atomicWriteJson(path, value) {
  return withAtomicWriteLock(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Unique temporary names plus per-path serialization keep concurrent
    // lifecycle callbacks from colliding on Windows destination replacement.
    // fsync makes the ownership/replay record durable before publication.
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const handle = await open(temporary, "w", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  });
}

/** Retry short-lived destination locks (notably Windows antivirus/indexer
 * handles) without weakening the atomic replace or hiding persistent errors. */
export async function renameWithRetry(source, destination, renameOperation = rename) {
  for (let attempt = 0; ; attempt++) {
    try {
      await renameOperation(source, destination);
      return;
    } catch (error) {
      const delayMs = ATOMIC_RENAME_RETRY_DELAYS_MS[attempt];
      if (!delayMs || !TRANSIENT_RENAME_ERROR_CODES.has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function readJsonOr(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

function groupAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    // EPERM still proves that a process exists in the group. The managed
    // adapters normally run as the same user, but treating permission errors
    // as dead would make a terminal event unsafe on a hardened host.
    return error?.code === "EPERM";
  }
}

function groupBelongsToRecord(record, processGroupId) {
  const recordedStartToken = record?.processStartToken;
  if (!recordedStartToken) return true;
  const currentLeaderStartToken = processStartToken(processGroupId);
  // If the original leader is gone, Linux no longer exposes a token for the
  // group id. If a new process has reused that PID as a group leader, however,
  // its token differs and signalling it would be unsafe.
  return !currentLeaderStartToken || currentLeaderStartToken === recordedStartToken;
}

export async function terminateProcessGroup(record, graceMs = 5_000) {
  const pid = Number(record?.pid);
  const processGroupId = Number(record?.processGroupId ?? pid);
  if (!Number.isInteger(pid) || pid <= 1 || !Number.isInteger(processGroupId) || processGroupId <= 1) return true;

  // The leader may already have exited while a detached descendant is still
  // alive. Check the group independently so that we never release a lease
  // merely because the recorded leader disappeared.
  if (!processAlive(record) && !groupAlive(processGroupId)) return true;
  if (!processAlive(record) && !groupBelongsToRecord(record, processGroupId)) return false;

  try { process.kill(-processGroupId, "SIGTERM"); } catch {
    // If the leader is still ours, a direct signal is a safe fallback for
    // platforms without process-group signalling. Otherwise the group is
    // alive but cannot be safely terminated; keep the run non-terminal.
    if (processAlive(record)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* poll below */ }
    }
  }
  const deadline = Date.now() + Math.max(250, graceMs);
  while (Date.now() < deadline) {
    if (!groupAlive(processGroupId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(-processGroupId, "SIGKILL"); } catch {
    if (processAlive(record)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* poll below */ }
    }
  }
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline) {
    if (!groupAlive(processGroupId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !groupAlive(processGroupId);
}

export async function reconcileOwnedProcesses(path, logPrefix = "adapter") {
  if (!existsSync(path)) return { records: [], terminated: 0 };
  const records = await readJsonOr(path, []);
  if (!Array.isArray(records)) {
    await atomicWriteJson(path, []);
    return { records: [], terminated: 0 };
  }
  let terminated = 0;
  for (const record of records) {
    const processGroupId = Number(record?.processGroupId ?? record?.pid);
    if (processAlive(record) || (Number.isInteger(processGroupId) && processGroupId > 1 && groupAlive(processGroupId))) {
      console.warn(`[${logPrefix}] terminating orphaned detached child pid=${record.pid} run=${record.remoteRunId ?? "unknown"}`);
      if (!await terminateProcessGroup(record, 5_000)) {
        throw new Error(`could not terminate orphaned detached child pid=${record.pid}`);
      }
      terminated += 1;
    }
  }
  await atomicWriteJson(path, []);
  return { records, terminated };
}
