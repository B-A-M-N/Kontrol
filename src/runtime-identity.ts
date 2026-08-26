import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildIdentity {
  version?: string;
  gitSha?: string;
  gitDirty?: number;
  buildTimestamp?: string;
  schemaHash?: string;
  buildId?: string;
  nodeVersion?: string;
}

export interface RuntimeIdentity {
  pid: number;
  processStartTime: string;
  instanceId: string;
  buildId: string;
  buildSha: string;
  buildDirty: number;
  buildTimestamp?: string;
  startedAt: string;
  command: string;
  /** Launcher generation this server belongs to. */
  generationId?: string;
}

export function runtimeIdentityPath(stateDir: string): string {
  return join(stateDir, "server.identity.json");
}

/**
 * Linux exposes a stable per-process start-time tick in /proc/<pid>/stat.
 * Store it beside the PID so a later doctor/restart can distinguish PID reuse.
 * Other platforms retain the process start timestamp and instance UUID, which
 * still provide useful diagnostics even when an OS start token is unavailable.
 */
export function processStartToken(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen >= 0) {
      const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
      const startTime = fields[19]; // Linux field 22; fields start at field 3.
      if (startTime) return `proc:${startTime}`;
    }
  } catch {
    // Non-Linux or an inaccessible /proc is handled by the timestamp/UUID.
  }
  return `started:${new Date().toISOString()}`;
}

export function readBuildIdentity(path: string): BuildIdentity {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BuildIdentity;
  } catch {
    return {};
  }
}

export function createRuntimeIdentity(
  stateDir: string,
  build: BuildIdentity,
  command = process.argv.join(" "),
): RuntimeIdentity {
  const identity: RuntimeIdentity = {
    pid: process.pid,
    processStartTime: processStartToken(process.pid),
    instanceId: `srv_${randomUUID()}`,
    buildId: build.buildId ?? "dev",
    buildSha: build.gitSha ?? "unknown",
    buildDirty: Number(build.gitDirty ?? 0),
    ...(build.buildTimestamp ? { buildTimestamp: build.buildTimestamp } : {}),
    startedAt: new Date().toISOString(),
    command: command.slice(0, 2_000),
    ...(process.env.KONTROL_LAUNCH_GENERATION_ID
      ? { generationId: process.env.KONTROL_LAUNCH_GENERATION_ID }
      : {}),
  };
  const path = runtimeIdentityPath(stateDir);
  const temporary = `${path}.${identity.instanceId}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return identity;
}

export function readRuntimeIdentity(stateDir: string): RuntimeIdentity | undefined {
  try {
    return JSON.parse(readFileSync(runtimeIdentityPath(stateDir), "utf8")) as RuntimeIdentity;
  } catch {
    return undefined;
  }
}

export function isRuntimeIdentityLive(identity: RuntimeIdentity): boolean {
  try {
    process.kill(identity.pid, 0);
  } catch {
    return false;
  }
  // On platforms without /proc, processStartTime is a best-effort timestamp
  // rather than an OS-provided PID generation token. Liveness still catches
  // stopped processes; Linux gets the stronger PID-reuse check below.
  if (identity.processStartTime.startsWith("started:")) return true;
  return processStartToken(identity.pid) === identity.processStartTime;
}

export function removeRuntimeIdentity(stateDir: string, instanceId: string): boolean {
  const current = readRuntimeIdentity(stateDir);
  if (!current || current.instanceId !== instanceId) return false;
  try {
    rmSync(runtimeIdentityPath(stateDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function hasRuntimeIdentity(stateDir: string): boolean {
  return existsSync(runtimeIdentityPath(stateDir));
}
