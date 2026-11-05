/**
 * Shared qualification child-process executor (P0-A).
 *
 * Single lifecycle authority for qualification scripts: one spawn path with an
 * absolute wall-clock deadline, process-group supervision on POSIX, SIGTERM
 * grace with SIGKILL escalation, bounded output, optional log streaming, and
 * post-exit verification that the owned process group is actually gone.
 *
 * Lifecycle: CREATED -> RUNNING -> STOPPING -> REAPED. The terminal outcome
 * is reported separately from lifecycle so a timeout, signal, interruption,
 * infrastructure error, or failed cleanup is never mistaken for a pass:
 * PASSED | FAILED | TIMED_OUT | INTERRUPTED | INFRA_ERROR | CLEANUP_FAILED
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const QUALIFICATION_STATUSES = Object.freeze([
  "PASSED",
  "FAILED",
  "TIMED_OUT",
  "INTERRUPTED",
  "INFRA_ERROR",
  "CLEANUP_FAILED",
]);

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

// A zombie member holds no resources and will be reaped by its subreaper;
// only non-zombie members count as surviving. kill(-pgid, 0) cannot see
// this distinction, so on Linux read /proc directly and fall back to the
// kill probe only when /proc is unavailable.
function procState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    // fields after comm: state(3) ppid(4) pgrp(5) session(6) ...
    if (fields.length < 3) return null;
    return { state: fields[0], ppid: Number(fields[1]), pgrp: Number(fields[2]) };
  } catch {
    return null;
  }
}

function groupHasLiveMembers(pgid) {
  if (process.platform === "win32" || !pgid) return false;
  try {
    const entries = readdirSync("/proc");
    let sawProc = false;
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      sawProc = true;
      const info = procState(entry);
      if (info && info.pgrp === pgid && info.state !== "Z" && info.state !== "X" && info.state !== "x") {
        return true;
      }
    }
    if (!sawProc) throw new Error("/proc unavailable");
    return false;
  } catch {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }
}

function pidHasLiveProcess(pid) {
  if (!pid) return false;
  const info = procState(pid);
  if (info) return info.state !== "Z" && info.state !== "X" && info.state !== "x";
  if (info === null) {
    // No /proc entry (or unreadable): confirm with the kill probe.
    try {
      process.kill(pid, 0);
      // /proc unreadable but the pid signals: conservatively live.
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }
  return false;
}

function killGroup(pid, signal) {
  if (process.platform === "win32" || !pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitFor(predicate, timeoutMs, intervalMs = 50) {
  const startedAt = Date.now();
  for (;;) {
    if (!predicate()) return true;
    if (Date.now() - startedAt >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Run one qualification child to a terminal receipt.
 *
 * @param {object} options
 * @param {string} options.runId stable qualification run id
 * @param {string} options.phaseId phase id within the run
 * @param {string} [options.attemptId] attempt id, defaults to "1"
 * @param {string} options.command executable path
 * @param {string[]} [options.args] argv
 * @param {string} [options.cwd] working directory
 * @param {object} [options.env] environment (defaults to process.env)
 * @param {number} options.deadlineMs absolute wall-clock deadline, required
 * @param {number} [options.graceMs] SIGTERM grace before SIGKILL escalation
 * @param {number} [options.maxOutputBytes] bounded stdout+stderr tail
 * @param {string} [options.logDir] stream full output to a run-specific file
 * @param {number[]} [options.extraPids] caller-declared test-owned pids that
 *   must also be gone before cleanup counts as verified
 * @param {AbortSignal} [options.abortSignal] aborts the run as INTERRUPTED
 */
export async function runQualificationProcess(options) {
  const startedAt = Date.now();
  const attemptId = options?.attemptId ?? "1";
  const base = {
    runId: options?.runId,
    phaseId: options?.phaseId,
    attemptId,
    command: options?.command,
    args: options?.args ?? [],
    deadlineMs: options?.deadlineMs,
    durationMs: 0,
  };
  const fail = (status, detail) => ({ ...base, status, ...detail });
  if (!options || typeof options.runId !== "string" || !options.runId) {
    return fail("INFRA_ERROR", { exitCode: null, signal: null, cleanupVerified: false, cleanupFailures: ["runId is required"], outputTail: "", outputPath: null });
  }
  if (typeof options.phaseId !== "string" || !options.phaseId) {
    return fail("INFRA_ERROR", { exitCode: null, signal: null, cleanupVerified: false, cleanupFailures: ["phaseId is required"], outputTail: "", outputPath: null });
  }
  if (typeof options.command !== "string" || !options.command) {
    return fail("INFRA_ERROR", { exitCode: null, signal: null, cleanupVerified: false, cleanupFailures: ["command is required"], outputTail: "", outputPath: null });
  }
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
    return fail("INFRA_ERROR", { exitCode: null, signal: null, cleanupVerified: false, cleanupFailures: ["deadlineMs must be a positive millisecond count"], outputTail: "", outputPath: null });
  }
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  let outputPath = null;
  if (options.logDir) {
    mkdirSync(options.logDir, { recursive: true });
    outputPath = join(options.logDir, `${options.runId}-${options.phaseId}-${attemptId}.log`);
  }

  let output = "";
  const append = (chunk) => {
    const text = chunk.toString("utf8");
    output = (output + text).slice(-maxOutputBytes);
    if (outputPath) {
      try { appendFileSync(outputPath, text); } catch { /* log streaming is best-effort */ }
    }
  };

  let child;
  try {
    child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  } catch (error) {
    return fail("INFRA_ERROR", {
      exitCode: null, signal: null, cleanupVerified: false,
      cleanupFailures: [`spawn failed: ${error?.message ?? error}`],
      outputTail: output, outputPath,
    });
  }

  const lifecycle = ["CREATED", "RUNNING"];
  let timedOut = false;
  let interrupted = false;
  let escalated = false;
  let exitCode = null;
  let signal = null;
  let stdioDrained = false;
  // Escalation timer is owned by this run and always cleared on settle, so a
  // late SIGKILL can never fire against a recycled process-group id.
  let escalateTimer = undefined;
  const clearEscalation = () => {
    if (escalateTimer !== undefined) {
      clearTimeout(escalateTimer);
      escalateTimer = undefined;
    }
  };

  if (options.abortSignal?.aborted) interrupted = true;
  const onAbort = () => { interrupted = true; terminate("SIGTERM"); };
  options.abortSignal?.addEventListener?.("abort", onAbort, { once: true });

  const terminate = (sig) => {
    if (process.platform !== "win32" && child.pid) killGroup(child.pid, sig);
    else { try { child.kill(sig); } catch { /* already exited */ } }
  };

  let spawnFailure = null;
  // Attach exit AND close listeners synchronously: Node may emit 'close' in
  // the same tick as 'exit', before any await continuation runs. Attaching
  // 'close' later misses it and the run can never settle.
  const exited = new Promise((resolve) => {
    child.once("error", (error) => { spawnFailure = error; resolve(); });
    child.once("exit", resolve);
  });
  let closeCode = null;
  let closeSignal = null;
  let closeSeen = false;
  const closed = new Promise((resolve) => {
    child.once("close", (code, sig) => {
      closeSeen = true;
      closeCode = code;
      closeSignal = sig;
      resolve();
    });
  });
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const deadline = setTimeout(() => {
    timedOut = true;
    lifecycle.push("STOPPING");
    terminate("SIGTERM");
    escalateTimer = setTimeout(() => {
      if (pidHasLiveProcess(child.pid)) {
        escalated = true;
        terminate("SIGKILL");
      }
      escalateTimer = undefined;
    }, graceMs);
    if (escalateTimer.unref) escalateTimer.unref();
  }, Math.max(1, options.deadlineMs));

  if (interrupted) {
    clearTimeout(deadline);
    lifecycle.push("STOPPING");
    terminate("SIGTERM");
  }

  await exited;
  clearTimeout(deadline);
  if (interrupted && !timedOut) {
    // Abort arrived while running: allow the same grace, then escalate.
    escalateTimer = setTimeout(() => {
      if (pidHasLiveProcess(child.pid)) {
        escalated = true;
        terminate("SIGKILL");
      }
      escalateTimer = undefined;
    }, graceMs);
    if (escalateTimer.unref) escalateTimer.unref();
  }
  // A child that exits while a survivor holds its pipes open must not hang
  // the executor: bound the stdio drain with a ref'd timer that is always
  // cleared, then verify the process group instead of inferring cleanup.
  const stdioGraceMs = Math.min(Math.max(graceMs, 1), 5_000);
  let stdioTimer = undefined;
  const stdioSettled = await Promise.race([
    closed.then(() => true),
    new Promise((resolve) => {
      stdioTimer = setTimeout(() => resolve(false), stdioGraceMs);
    }),
  ]);
  if (stdioTimer !== undefined) clearTimeout(stdioTimer);
  stdioDrained = stdioSettled && closeSeen;
  if (closeSeen) {
    exitCode = closeCode;
    signal = closeSignal ?? null;
  } else {
    // Pipes still held open: take the reaped exit status if available.
    exitCode = child.exitCode;
    signal = child.signalCode ?? null;
  }

  // Prove owned-group termination; never infer it from an unref'd timer.
  // Membership is zombie-aware: a reaped-pending zombie is not a survivor.
  let groupReaped = !groupHasLiveMembers(child?.pid);
  if (!groupReaped) {
    terminate("SIGTERM");
    await waitFor(() => !groupHasLiveMembers(child?.pid), graceMs);
    groupReaped = !groupHasLiveMembers(child?.pid);
    if (!groupReaped) {
      escalated = true;
      terminate("SIGKILL");
      await waitFor(() => !groupHasLiveMembers(child?.pid), graceMs);
      groupReaped = !groupHasLiveMembers(child?.pid);
    }
  }
  clearEscalation();
  lifecycle.push("REAPED");

  const cleanupFailures = [];
  if (!groupReaped) {
    cleanupFailures.push(`process group ${child?.pid} survived SIGKILL escalation`);
  }
  const extraPids = Array.isArray(options.extraPids) ? options.extraPids : [];
  const survivingExtra = extraPids.filter((pid) => pidHasLiveProcess(pid));
  if (survivingExtra.length > 0) {
    for (const pid of survivingExtra) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
    }
    await waitFor(() => !extraPids.some((pid) => pidHasLiveProcess(pid)), graceMs);
    const stillAlive = extraPids.filter((pid) => pidHasLiveProcess(pid));
    if (stillAlive.length > 0) {
      cleanupFailures.push(`test-owned pids survived SIGKILL: ${stillAlive.join(",")}`);
    }
  }
  if (!stdioDrained) {
    cleanupFailures.push("child exited while stdio pipes remained open (survivor holds output)");
  }
  const cleanupVerified = groupReaped && survivingExtra.length === 0 && stdioDrained &&
    (extraPids.length === 0 || !extraPids.some((pid) => pidHasLiveProcess(pid)));

  options.abortSignal?.removeEventListener?.("abort", onAbort);
  const durationMs = Date.now() - startedAt;

  if (spawnFailure) {
    return { ...base, status: "INFRA_ERROR", lifecycle, exitCode, signal, durationMs, timedOut: false, escalated, stdioDrained, groupReaped, cleanupVerified: false, cleanupFailures: [`spawn failed: ${spawnFailure.message}`, ...cleanupFailures], outputTail: output, outputPath };
  }
  if (interrupted) {
    return { ...base, status: "INTERRUPTED", lifecycle, exitCode, signal, durationMs, timedOut, escalated, stdioDrained, groupReaped, cleanupVerified, cleanupFailures, outputTail: output, outputPath };
  }
  if (timedOut) {
    return { ...base, status: "TIMED_OUT", lifecycle, exitCode, signal, durationMs, timedOut: true, escalated, stdioDrained, groupReaped, cleanupVerified, cleanupFailures, outputTail: output, outputPath };
  }
  if (!cleanupVerified) {
    return { ...base, status: "CLEANUP_FAILED", lifecycle, exitCode, signal, durationMs, timedOut: false, escalated, stdioDrained, groupReaped, cleanupVerified: false, cleanupFailures, outputTail: output, outputPath };
  }
  return { ...base, status: exitCode === 0 ? "PASSED" : "FAILED", lifecycle, exitCode, signal, durationMs, timedOut: false, escalated, stdioDrained, groupReaped, cleanupVerified: true, cleanupFailures, outputTail: output, outputPath };
}
