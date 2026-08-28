import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeLauncher = "tmux-stack" | "systemd" | "dev-watch" | "serve";

export interface RuntimeLockRecord {
  lockToken: string;
  launcher: RuntimeLauncher;
  launcherPid: number;
  launcherStartToken: string;
  generationId: string;
  buildId: string;
  artifactPath: string;
  port: number;
  acquiredAt: string;
}

export interface RuntimeLockMetadata {
  launcher: RuntimeLauncher;
  generationId?: string;
  buildId?: string;
  artifactPath?: string;
  port: number;
  launcherPid?: number;
  launcherStartToken?: string;
}

export interface RuntimeLockHandle {
  path: string;
  record: RuntimeLockRecord;
}

export function runtimeLockPath(stateDir: string): string {
  return join(stateDir, "runtime.lock");
}

function runtimeLockGuardPath(stateDir: string): string {
  return `${runtimeLockPath(stateDir)}.guard`;
}

/** Linux's /proc start token prevents a reused PID from owning an old lock. */
export function processStartToken(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen >= 0) {
      const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
      const startTime = fields[19];
      if (startTime) return `proc:${startTime}`;
    }
  } catch {
    // Non-Linux and inaccessible /proc use a timestamp token.
  }
  return `started:${new Date().toISOString()}`;
}

function processIsLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    // kill(pid, 0) also succeeds for zombies. A zombie has exited and cannot
    // own a serving generation, so treat it as stale for lock recovery.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen >= 0 && stat.slice(closingParen + 2).trim().split(/\s+/)[0] === "Z") return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readRuntimeLock(stateDir: string): RuntimeLockRecord | undefined {
  const path = runtimeLockPath(stateDir);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RuntimeLockRecord;
  } catch (error) {
    throw new Error(`Kontrol runtime lock exists but cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function isRuntimeLockLive(record: RuntimeLockRecord): boolean {
  if (!record || !Number.isInteger(record.launcherPid) || typeof record.launcherStartToken !== "string") return false;
  if (!processIsLive(record.launcherPid)) return false;
  return record.launcherStartToken.startsWith("started:")
    || processStartToken(record.launcherPid) === record.launcherStartToken;
}

interface RuntimeLockGuardRecord {
  token: string;
  pid: number;
  startToken: string;
}

function isRuntimeLockGuardLive(record: RuntimeLockGuardRecord | undefined): boolean {
  if (!record || !Number.isInteger(record.pid) || typeof record.startToken !== "string") return false;
  if (!processIsLive(record.pid)) return false;
  return record.startToken.startsWith("started:") || processStartToken(record.pid) === record.startToken;
}

async function acquireRuntimeLockGuard(stateDir: string): Promise<RuntimeLockGuardRecord> {
  const path = runtimeLockGuardPath(stateDir);
  const guard: RuntimeLockGuardRecord = {
    token: `guard_${randomUUID()}`,
    pid: process.pid,
    startToken: processStartToken(process.pid),
  };
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      writeFileSync(path, `${JSON.stringify(guard)}\n`, { flag: "wx", mode: 0o600 });
      return guard;
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== "EEXIST") throw error;
      let existing: RuntimeLockGuardRecord | undefined;
      try { existing = JSON.parse(readFileSync(path, "utf8")) as RuntimeLockGuardRecord; } catch { /* reclaim malformed guard atomically */ }
      if (isRuntimeLockGuardLive(existing)) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for Kontrol runtime-lock arbitration.");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        continue;
      }
      // Rename is the arbitration step for stale takeover. Only the process
      // that wins this atomic rename may remove the stale guard and retry O_EXCL.
      const reclaimPath = `${path}.reclaim-${guard.token}`;
      try {
        renameSync(path, reclaimPath);
        unlinkSync(reclaimPath);
      } catch {
        // Another contender won the stale-guard race; re-read and retry.
      }
    }
  }
}

function releaseRuntimeLockGuard(stateDir: string, guard: RuntimeLockGuardRecord): void {
  const path = runtimeLockGuardPath(stateDir);
  try {
    const current = JSON.parse(readFileSync(path, "utf8")) as RuntimeLockGuardRecord;
    if (current.token === guard.token) unlinkSync(path);
  } catch {
    // The guard was already reclaimed after this process lost ownership.
  }
}

async function withRuntimeLockGuard<T>(stateDir: string, action: () => T | Promise<T>): Promise<T> {
  const guard = await acquireRuntimeLockGuard(stateDir);
  try {
    return await action();
  } finally {
    releaseRuntimeLockGuard(stateDir, guard);
  }
}

export function runtimeLockConflict(record: RuntimeLockRecord): Error {
  return new Error(
    `Kontrol is already managed by ${record.launcher}:\n` +
      `  pid: ${record.launcherPid}\n` +
      `  generation: ${record.generationId}\n` +
      `  build: ${record.buildId}\n` +
      `Use the owning launcher to restart it.`,
  );
}

export async function acquireRuntimeLock(
  stateDir: string,
  metadata: RuntimeLockMetadata,
): Promise<RuntimeLockHandle> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = runtimeLockPath(stateDir);
  const record: RuntimeLockRecord = {
    lockToken: `lock_${randomUUID()}`,
    launcher: metadata.launcher,
    launcherPid: metadata.launcherPid ?? process.pid,
    launcherStartToken: metadata.launcherStartToken ?? processStartToken(metadata.launcherPid ?? process.pid),
    generationId: metadata.generationId ?? `gen-${Date.now()}-${process.pid}`,
    buildId: metadata.buildId ?? "unknown",
    artifactPath: metadata.artifactPath ?? "unknown",
    port: metadata.port,
    acquiredAt: new Date().toISOString(),
  };

  const guard = await acquireRuntimeLockGuard(stateDir);
  try {
    for (;;) {
      try {
        writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        return { path, record };
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno.code !== "EEXIST") throw error;
        const existing = readRuntimeLock(stateDir);
        if (existing && isRuntimeLockLive(existing)) throw runtimeLockConflict(existing);
        // Every compliant contender holds the arbitration guard while making
        // the stale-owner decision, so this unlink cannot erase a new owner.
        rmSync(path, { force: true });
      }
    }
  } finally {
    releaseRuntimeLockGuard(stateDir, guard);
  }
}

export function assertRuntimeLock(stateDir: string, lockToken: string): RuntimeLockRecord {
  const record = readRuntimeLock(stateDir);
  if (!record || record.lockToken !== lockToken || !isRuntimeLockLive(record)) {
    throw new Error("Kontrol runtime lock is missing, stale, or owned by another generation.");
  }
  return record;
}

export async function updateRuntimeLock(
  stateDir: string,
  lockToken: string,
  update: Partial<Pick<RuntimeLockRecord, "launcherPid" | "launcherStartToken" | "generationId" | "buildId" | "artifactPath" | "port">>,
): Promise<RuntimeLockRecord> {
  return withRuntimeLockGuard(stateDir, () => {
    const current = assertRuntimeLock(stateDir, lockToken);
    const updated = { ...current, ...update };
    const temporary = `${runtimeLockPath(stateDir)}.${lockToken}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    // A lock consumer always validates the token after reading the atomically
    // replaced file; metadata updates cannot transfer ownership.
    renameSync(temporary, runtimeLockPath(stateDir));
    return updated;
  });
}

export async function releaseRuntimeLock(handle: RuntimeLockHandle): Promise<boolean> {
  return withRuntimeLockGuard(dirname(handle.path), () => {
    const current = readRuntimeLock(dirname(handle.path));
    if (!current || current.lockToken !== handle.record.lockToken) return false;
    rmSync(handle.path, { force: true });
    return true;
  });
}

async function runCli(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const stateDir = value("--state-dir");
  if (!stateDir) throw new Error("runtime-lock requires --state-dir");
  if (command === "acquire") {
    const handle = await acquireRuntimeLock(stateDir, {
      launcher: (value("--launcher") ?? "tmux-stack") as RuntimeLauncher,
      generationId: value("--generation-id"),
      buildId: value("--build-id"),
      artifactPath: value("--artifact-path"),
      port: Number(value("--port") ?? 7676),
      launcherPid: Number(value("--launcher-pid") ?? process.pid),
    });
    process.stdout.write(`${handle.record.lockToken}\n`);
    const holdMs = Number(value("--hold-ms") ?? 0);
    if (Number.isFinite(holdMs) && holdMs > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, holdMs));
    }
    return;
  }
  if (command === "release") {
    const token = value("--token");
    if (!token) throw new Error("runtime-lock release requires --token");
    const record = readRuntimeLock(stateDir);
    if (record?.lockToken === token) {
      await releaseRuntimeLock({ path: runtimeLockPath(stateDir), record });
    }
    return;
  }
  if (command === "check") {
    const token = value("--token");
    if (!token) throw new Error("runtime-lock check requires --token");
    assertRuntimeLock(stateDir, token);
    return;
  }
  if (command === "update") {
    const token = value("--token");
    if (!token) throw new Error("runtime-lock update requires --token");
    const update: Partial<Pick<RuntimeLockRecord, "launcherPid" | "launcherStartToken" | "generationId" | "buildId" | "artifactPath" | "port">> = {};
    const generationId = value("--generation-id");
    const buildId = value("--build-id");
    const artifactPath = value("--artifact-path");
    const launcherPid = value("--launcher-pid");
    const port = value("--port");
    if (generationId !== undefined) update.generationId = generationId;
    if (buildId !== undefined) update.buildId = buildId;
    if (artifactPath !== undefined) update.artifactPath = artifactPath;
    if (launcherPid !== undefined) {
      update.launcherPid = Number(launcherPid);
      update.launcherStartToken = processStartToken(Number(launcherPid));
    }
    if (port !== undefined) update.port = Number(port);
    await updateRuntimeLock(stateDir, token, update);
    return;
  }
  throw new Error("Usage: runtime-lock {acquire|release|check|update} --state-dir PATH");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
