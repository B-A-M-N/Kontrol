#!/usr/bin/env node
// P1 (stage 4): qualification-controller ownership.
//
// A single controller owns admission, run identity, dependencies, deadlines,
// and recovery for one receipt path. The lease guarantees that two writers
// never append to the same qualification receipt: a live owner blocks a
// second gate, and a dead owner is reconciled (its unsettled "running"
// phases become "interrupted") before a successor starts.
//
// All side effects are injected so the policy is unit-testable without
// touching the real filesystem or signaling real processes.
export const INTERRUPTED = "interrupted";

export function reconcilePhases(phases = [], reason) {
  let interruptedCount = 0;
  const reconciled = (phases ?? []).map((phase) => {
    if (phase?.status === "running") {
      interruptedCount += 1;
      return { ...phase, status: INTERRUPTED, finishedAt: new Date().toISOString(), reason };
    }
    return phase;
  });
  return { phases: reconciled, interruptedCount };
}

export function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

// A live pid alone does not prove ownership: pids are recycled. The lease is
// honored only when the process behind it is plausibly this controller
// (its command line names the gate script). Anything else is stale.
export function defaultReadCmdline(pid, readFileSync) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

function isPlausibleOwner(cmdline, gateMarker = "beta-gate.mjs") {
  return typeof cmdline === "string" && cmdline.includes(gateMarker);
}

export function acquireControllerLease({
  leasePath,
  runId,
  receiptPath,
  readFileSync,
  writeFileSync,
  mkdirSync,
  pid = process.pid,
  startedAt = new Date().toISOString(),
  isPidAlive = defaultIsPidAlive,
  readCmdline = (ownerPid) => defaultReadCmdline(ownerPid, readFileSync),
  gateMarker = "beta-gate.mjs",
}) {
  let existing = null;
  try {
    existing = JSON.parse(readFileSync(leasePath, "utf8"));
  } catch {
    existing = null;
  }
  if (existing && typeof existing?.pid === "number" && typeof existing?.runId === "string") {
    let alive = false;
    try {
      alive = isPidAlive(existing.pid);
    } catch {
      alive = false;
    }
    if (alive && isPlausibleOwner(readCmdline(existing.pid), gateMarker)) {
      return {
        acquired: false,
        reason: `qualification receipt ${receiptPath} is owned by live controller run ${existing.runId} (pid ${existing.pid}); refusing to run a second writer`,
        owner: { runId: existing.runId, pid: existing.pid },
      };
    }
    // Stale lease: dead owner, or a live pid that is not this controller
    // (recycled pid). The successor reconciles and takes over.
    const lease = { runId, pid, startedAt, receiptPath, supersedes: existing.runId };
    mkdirSync?.(leasePath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
    writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`);
    return { acquired: true, reconciled: { priorRunId: existing.runId, priorPid: existing.pid }, lease };
  }
  const lease = { runId, pid, startedAt, receiptPath };
  try {
    mkdirSync?.(leasePath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  } catch {
    // Directory creation is best-effort; the write below fails closed.
  }
  writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`);
  return { acquired: true, lease };
}

export function releaseControllerLease({ leasePath, runId, readFileSync, rmSync }) {
  try {
    const existing = JSON.parse(readFileSync(leasePath, "utf8"));
    // Only the owner releases its own lease; a successor's lease is never
    // removed by a stale owner shutting down late.
    if (existing?.runId === runId) rmSync?.(leasePath, { force: true });
  } catch {
    // Best-effort: a missing lease on shutdown is not a failure.
  }
}
