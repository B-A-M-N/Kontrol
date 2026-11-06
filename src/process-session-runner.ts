import { createReadStream, readFileSync, readdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveShellCommand } from "./process-platform.js";
import { buildChildEnvironment } from "./process-environment.js";

interface LinuxProcessRecord {
  state: string;
  processGroupId: number;
  startTime: string;
}

function readLinuxProcessRecord(pid: number): LinuxProcessRecord | undefined {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid < 1) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const endOfCommand = stat.lastIndexOf(")");
    if (endOfCommand < 0) return undefined;
    const fields = stat.slice(endOfCommand + 1).trim().split(/\s+/);
    const state = fields[0];
    const processGroupId = Number(fields[2]);
    const startTime = fields[19];
    if (!state || !Number.isInteger(processGroupId) || !startTime) return undefined;
    return { state, processGroupId, startTime };
  } catch {
    return undefined;
  }
}

/** PID-reuse-safe identity for the Linux production parent process. */
export function linuxProcessIdentity(pid: number): string | undefined {
  const record = readLinuxProcessRecord(pid);
  if (!record) return undefined;
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return bootId ? `${bootId}:${record.startTime}` : undefined;
  } catch {
    return undefined;
  }
}

/** Owner identity persisted with a checkout lease. The start-time component
 * prevents a recycled PID from being mistaken for the process that launched
 * a detached shell runner. */
export function linuxProcessOwnerInstanceId(pid: number): string | undefined {
  const identity = linuxProcessIdentity(pid);
  return identity ? `linux-process:${pid}:${identity}` : undefined;
}

export function parseLinuxProcessOwnerInstanceId(value: string): { pid: number; identity: string } | undefined {
  const match = /^linux-process:(\d+):(.+)$/.exec(value);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1 || !match[2]) return undefined;
  return { pid, identity: match[2] };
}

/** True while a detached process-session runner launched by this exact Linux
 * owner is still draining its process group. The runner exits only after the
 * shell and all descendants have stopped. */
export function findLinuxProcessSessionRunnerOwners(owners: readonly { pid: number; identity: string }[]): Set<string> {
  const found = new Set<string>();
  if (process.platform !== "linux") {
    for (const owner of owners) found.add(`${owner.pid}:${owner.identity}`);
    return found;
  }
  const wanted = new Set(owners.map((owner) => `${owner.pid}:${owner.identity}`));
  if (wanted.size === 0) return found;
  try {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (pid === process.pid) continue;
      const record = readLinuxProcessRecord(pid);
      if (!record || record.state === "Z" || record.state === "X") continue;
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const runnerIndex = args.findIndex((arg) => /(?:^|\/)process-session-runner\.(?:js|ts)$/.test(arg));
      if (runnerIndex < 0) continue;
      const key = `${args[runnerIndex + 1]}:${args[runnerIndex + 2]}`;
      if (wanted.has(key)) found.add(key);
      if (found.size === wanted.size) return found;
    }
    return found;
  } catch {
    // Failure to inspect /proc is not proof that detached execution ended.
    return wanted;
  }
}

function hasOtherLiveProcessInGroup(processGroupId: number): boolean {
  try {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (pid === process.pid) continue;
      const record = readLinuxProcessRecord(pid);
      if (record?.processGroupId === processGroupId && record.state !== "Z" && record.state !== "X") return true;
    }
  } catch {
    // If /proc cannot be inspected, retain the runner until its parent dies;
    // process-session limits still bound the number of these workers.
    return true;
  }
  return false;
}

async function readLaunchGate(): Promise<{ command: string }> {
  const gate = createReadStream("/dev/null", { fd: 3, autoClose: false });
  return await new Promise((resolve, reject) => {
    let input = "";
    const timeout = setTimeout(() => reject(new Error("process-session launch gate timed out")), 5_000);
    gate.setEncoding("utf8");
    gate.on("data", (chunk) => {
      input += String(chunk);
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      gate.destroy();
      try {
        const request = JSON.parse(input.slice(0, newline)) as { command?: unknown };
        if (typeof request.command !== "string") throw new Error("invalid process-session launch request");
        resolve({ command: request.command });
      } catch (error) {
        reject(error);
      }
    });
    gate.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    gate.once("end", () => {
      clearTimeout(timeout);
      reject(new Error("process-session launch gate closed"));
    });
  });
}

async function runProcessSession(command: string, ownerPid: number, ownerIdentity: string): Promise<void> {
  if (process.platform !== "linux" || !Number.isInteger(ownerPid) || !ownerIdentity.trim()) {
    throw new Error("process-session crash fencing requires Linux parent identity");
  }
  if (linuxProcessIdentity(ownerPid) !== ownerIdentity) return;

  const shell = resolveShellCommand(command);
  // The runner itself receives the manager's already-scrubbed child env. Keep
  // those explicit per-session additions while reapplying the credential
  // namespace filter at this second process boundary.
  const childEnv = buildChildEnvironment({ source: process.env, additionalKeys: Object.keys(process.env) });
  let shellProcess: ChildProcess;
  try {
    shellProcess = spawn(shell.executable, shell.args, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
    });
  } catch (error) {
    throw error;
  }

  if (!shellProcess.stdin || !shellProcess.stdout || !shellProcess.stderr) {
    shellProcess.kill("SIGKILL");
    throw new Error("process-session shell streams were not created");
  }

  process.stdin.on("error", () => undefined);
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);
  process.stdin.pipe(shellProcess.stdin);
  shellProcess.stdout.pipe(process.stdout);
  shellProcess.stderr.pipe(process.stderr);
  shellProcess.stdin.on("error", () => undefined);

  let shellExited = false;
  let exitCode = 1;
  shellProcess.once("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    shellExited = true;
  });
  shellProcess.once("close", (code, signal) => {
    shellExited = true;
    exitCode = code ?? (signal === "SIGTERM" ? 143 : 1);
  });

  const processGroupId = process.pid;
  await new Promise<void>((resolve) => {
    const watchdog = setInterval(() => {
      const owner = readLinuxProcessRecord(ownerPid);
      if (!owner || owner.state === "Z" || owner.state === "X" || linuxProcessIdentity(ownerPid) !== ownerIdentity) {
        // All ordinary descendants inherit this process group. SIGKILL is
        // deliberate here: the controller is gone, so no reviewer can observe
        // or approve a graceful drain, and continuing would permit late writes.
        try { process.kill(-processGroupId, "SIGKILL"); }
        catch { process.exit(1); }
        return;
      }
      if (shellExited && !hasOtherLiveProcessInGroup(processGroupId)) {
        clearInterval(watchdog);
        process.exitCode = exitCode;
        resolve();
      }
    }, 100);
  });
}

async function main(): Promise<void> {
  try {
    const ownerPid = Number(process.argv[2]);
    const ownerIdentity = process.argv[3] ?? "";
    const launch = await readLaunchGate();
    await runProcessSession(launch.command, ownerPid, ownerIdentity);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) void main();
