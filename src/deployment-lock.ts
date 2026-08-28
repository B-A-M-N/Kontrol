import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processStartToken } from "./runtime-lock.js";

/**
 * Serializes deployment controllers without owning the serving runtime.
 * runtime.lock protects the active generation; this lock protects the
 * prepare/stop/activate/rollback transaction that changes it.
 */
export interface DeploymentLockRecord {
  token: string;
  pid: number;
  processStartToken: string;
  operation: string;
  deploymentId: string;
  startedAt: string;
}

export interface DeploymentLockHandle {
  path: string;
  record: DeploymentLockRecord;
}

export function deploymentLockPath(stateDir: string): string {
  return join(stateDir, "deployment.lock");
}

function deploymentLockGuardPath(stateDir: string): string {
  return `${deploymentLockPath(stateDir)}.guard`;
}

function processIsLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    // kill(pid, 0) also succeeds for zombies. A zombie has exited and cannot
    // own a deployment transaction, so treat it as stale for lock recovery.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen >= 0 && stat.slice(closingParen + 2).trim().split(/\s+/)[0] === "Z") return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readDeploymentLock(stateDir: string): DeploymentLockRecord | undefined {
  const path = deploymentLockPath(stateDir);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DeploymentLockRecord;
  } catch (error) {
    throw new Error(`Kontrol deployment lock exists but cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function isDeploymentLockLive(record: DeploymentLockRecord | undefined): boolean {
  if (!record || !Number.isInteger(record.pid) || typeof record.processStartToken !== "string") return false;
  if (!processIsLive(record.pid)) return false;
  return record.processStartToken.startsWith("started:")
    || processStartToken(record.pid) === record.processStartToken;
}

interface GuardRecord {
  token: string;
  pid: number;
  startToken: string;
}

function isGuardLive(record: GuardRecord | undefined): boolean {
  if (!record || !Number.isInteger(record.pid) || typeof record.startToken !== "string") return false;
  if (!processIsLive(record.pid)) return false;
  return record.startToken.startsWith("started:") || processStartToken(record.pid) === record.startToken;
}

async function acquireGuard(stateDir: string): Promise<GuardRecord> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = deploymentLockGuardPath(stateDir);
  const guard = {
    token: `guard_${randomUUID()}`,
    pid: process.pid,
    startToken: processStartToken(process.pid),
  } satisfies GuardRecord;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      writeFileSync(path, `${JSON.stringify(guard)}\n`, { flag: "wx", mode: 0o600 });
      return guard;
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== "EEXIST") throw error;
      let existing: GuardRecord | undefined;
      try { existing = JSON.parse(readFileSync(path, "utf8")) as GuardRecord; } catch { /* reclaim malformed guard */ }
      if (isGuardLive(existing)) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for Kontrol deployment-lock arbitration.");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        continue;
      }
      const reclaimPath = `${path}.reclaim-${guard.token}`;
      try {
        renameSync(path, reclaimPath);
        unlinkSync(reclaimPath);
      } catch {
        // Another contender won the stale-guard race; retry the exclusive create.
      }
    }
  }
}

function releaseGuard(stateDir: string, guard: GuardRecord): void {
  const path = deploymentLockGuardPath(stateDir);
  try {
    const current = JSON.parse(readFileSync(path, "utf8")) as GuardRecord;
    if (current.token === guard.token) unlinkSync(path);
  } catch {
    // The guard was already reclaimed or removed.
  }
}

async function withGuard<T>(stateDir: string, action: () => T | Promise<T>): Promise<T> {
  const guard = await acquireGuard(stateDir);
  try {
    return await action();
  } finally {
    releaseGuard(stateDir, guard);
  }
}

export function deploymentLockConflict(record: DeploymentLockRecord): Error {
  return new Error(
    `Kontrol deployment is already in progress:\n` +
      `  pid: ${record.pid}\n` +
      `  deployment: ${record.deploymentId}\n` +
      `  operation: ${record.operation}\n`,
  );
}

export async function acquireDeploymentLock(
  stateDir: string,
  metadata: { operation?: string; deploymentId?: string; pid?: number; processStartToken?: string },
): Promise<DeploymentLockHandle> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = deploymentLockPath(stateDir);
  const pid = metadata.pid ?? process.pid;
  const record: DeploymentLockRecord = {
    token: `deployment_${randomUUID()}`,
    pid,
    processStartToken: metadata.processStartToken ?? processStartToken(pid),
    operation: metadata.operation ?? "deploy",
    deploymentId: metadata.deploymentId ?? `deployment-${Date.now()}-${pid}`,
    startedAt: new Date().toISOString(),
  };

  return withGuard(stateDir, () => {
    for (;;) {
      try {
        writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        return { path, record };
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno.code !== "EEXIST") throw error;
        const existing = readDeploymentLock(stateDir);
        if (existing && isDeploymentLockLive(existing)) throw deploymentLockConflict(existing);
        rmSync(path, { force: true });
      }
    }
  });
}

export function assertDeploymentLock(stateDir: string, token: string): DeploymentLockRecord {
  const record = readDeploymentLock(stateDir);
  if (!record || record.token !== token || !isDeploymentLockLive(record)) {
    throw new Error("Kontrol deployment lock is missing, stale, or owned by another deployment.");
  }
  return record;
}

export async function releaseDeploymentLock(stateDir: string, token: string): Promise<boolean> {
  return withGuard(stateDir, () => {
    const path = deploymentLockPath(stateDir);
    const current = readDeploymentLock(stateDir);
    if (!current || current.token !== token) return false;
    rmSync(path, { force: true });
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
  if (!stateDir) throw new Error("deployment-lock requires --state-dir");
  if (command === "acquire") {
    const handle = await acquireDeploymentLock(stateDir, {
      operation: value("--operation"),
      deploymentId: value("--deployment-id"),
      pid: Number(value("--pid") ?? process.pid),
    });
    process.stdout.write(`${handle.record.token}\n`);
    const holdMs = Number(value("--hold-ms") ?? 0);
    if (Number.isFinite(holdMs) && holdMs > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, holdMs));
    }
    return;
  }
  if (command === "check") {
    const token = value("--token");
    if (!token) throw new Error("deployment-lock check requires --token");
    assertDeploymentLock(stateDir, token);
    return;
  }
  if (command === "release") {
    const token = value("--token");
    if (!token) throw new Error("deployment-lock release requires --token");
    await releaseDeploymentLock(stateDir, token);
    return;
  }
  throw new Error("Usage: deployment-lock {acquire|check|release} --state-dir PATH");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
