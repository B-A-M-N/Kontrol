import { mkdir, open, readFile, rename } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

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

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // A per-write name prevents overlapping lifecycle callbacks from clobbering
  // one another's temporary file. fsync makes the durable ownership/replay
  // record survive a process crash, not merely an orderly shutdown.
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
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
