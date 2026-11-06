import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";
import { buildChildEnvironment } from "./process-environment.js";
import { linuxProcessIdentity } from "./process-session-runner.js";
import type { AgentPtyBindingStore } from "./agent-pty-bindings.js";
import { isReadOnlyShellInspectionCommand } from "./read-only-shell.js";
import { HeadTailBuffer, OutputLog } from "./process-output.js";

export { HeadTailBuffer, OutputLog };

// P1: detachment exists to return control (and a live process card) to the
// reviewer quickly; a 10s request hold is long enough to trip intermediary
// timeouts and makes the UI feel absent on short long-running operations.
const DEFAULT_EXEC_YIELD_MS = 2_000;
// A stdin write commonly wakes a shell/child before the child performs its
// final output and exit. 250 ms is too short under ordinary machine load and
// causes callers to receive a misleading still-running snapshot. Callers that
// need an immediate yield may still pass an explicit shorter value.
const DEFAULT_INTERACTIVE_YIELD_MS = 1_000;
const DEFAULT_POLL_YIELD_MS = 5_000;
const MAX_COMMAND_YIELD_MS = 30_000;
const MAX_POLL_YIELD_MS = 110_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_CHARACTERS = 1_000_000;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_RUNNING_PROCESSES = 64;
const DEFAULT_MAX_RUNNING_PROCESSES_PER_OWNER = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_MAX_RUNTIME_MS = 60 * 60 * 1_000;
const DEFAULT_REAPER_INTERVAL_MS = 30_000;
const MAX_PROCESS_RECOVERY_CAPABILITIES = 1_024;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface StartCommandInput {
  workspaceId: string;
  /** Stable owner for this MCP transport; never infer cross-client ownership from workspace alone. */
  ownerId?: string;
  workSessionId?: string;
  /** Authenticated principal for output-only recovery after a transport reconnect. */
  principalId?: string;
  command: string;
  /** True only for the narrow read-only shell inspection allowlist. */
  readOnlyInspection?: boolean;
  cwd: string;
  tty?: boolean;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  /** Optional per-command child lifetime; this never extends the MCP request.
   *  Bounded by the manager's configured max runtime (processMaxRuntimeMs),
   *  not a hard-coded constant. */
  timeoutMs?: number;
  /** Stable caller identity for exact launch retries. Scoped to ownerId. */
  clientMutationId?: string;
  /** Explicitly identifies an authenticated worker's interactive PTY. Ordinary
   * shells stay outside the agent-binding lifecycle. */
  agentPtyBinding?: {
    workspaceSessionId: string;
    runId: string;
    ownerPrincipalId: string;
    createReviewCredential?: (binding: import("./agent-pty-bindings.js").AgentPtyBinding) => {
      credentialFilePath: string;
      cleanup(): void;
    };
  };
}

export interface WriteStdinInput {
  workspaceId: string;
  sessionId: string;
  ownerId?: string;
  workSessionId?: string;
  principalId?: string;
  recoveryCapability?: string;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  /**
   * Read output strictly after this cursor WITHOUT advancing the session's
   * read pointer. A retry of the same afterCursor returns the same logical
   * output (until retention evicts it), which makes lost poll responses
   * recoverable — the transport-resilience contract (P0).
   */
  afterCursor?: number;
}

export interface ProcessSnapshot {
  sessionId?: string;
  command: string;
  output: string;
  outputTruncated: boolean;
  running: boolean;
  exitCode?: number;
  signal?: string;
  wallTimeMs: number;
  /** Monotonic output-stream cursor this snapshot read up to. */
  outputCursor: number;
  /** Oldest cursor still retained; earlier ranges have been evicted. */
  oldestAvailableCursor: number;
  /** Epoch ms when the child was launched; lets a UI advance elapsed time
   *  locally between polls (P1: live process-card elapsed). */
  startedAtEpochMs: number;
  /** Opaque, expiring output-poll authority; never permits input or signals. */
  recoveryCapability?: string;
}

interface ManagedProcess {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  resize?(columns: number, rows: number): void;
}

interface ProcessSession {
  id: string;
  workspaceId: string;
  ownerId: string;
  workSessionId?: string;
  principalId?: string;
  recoveryCapability?: string;
  recoveryCapabilityHash?: string;
  command: string;
  process?: ManagedProcess;
  startedAt: number;
  columns: number;
  rows: number;
  buffer: OutputLog;
  /** Reader position for the destructive-free default read (session consumer). */
  readCursor: number;
  running: boolean;
  exitCode?: number;
  signal?: string;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  cleanupTimer?: NodeJS.Timeout;
  lastClientActivityAt: number;
  lastProcessActivityAt: number;
  timeoutTimer?: NodeJS.Timeout;
  launchKey?: string;
  agentPtyBinding?: { processSessionId: string; processGeneration: number };
  agentPtyCredentialFilePath?: string;
  agentPtyCredentialCleanup?: () => void;
}

interface LaunchRecord {
  fingerprint: string;
  sessionId: string;
  finalSnapshot?: ProcessSnapshot;
  cleanupTimer?: NodeJS.Timeout;
}

interface ProcessRecoveryCapability {
  sessionId: string;
  workspaceId: string;
  principalId: string;
  workSessionId?: string;
  expiresAt: number;
  operations: readonly ["poll_output"];
}

export interface ProcessSessionManagerOptions {
  maxBufferCharacters?: number;
  completedSessionTtlMs?: number;
  maxRunningProcesses?: number;
  maxRunningProcessesPerOwner?: number;
  idleTimeoutMs?: number;
  maxRuntimeMs?: number;
  reaperIntervalMs?: number;
  childEnvironmentAllowlist?: string[];
  agentPtyBindings?: AgentPtyBindingStore;
}

export interface ProcessSessionMetrics {
  running: number;
  total: number;
  maxRunningProcesses: number;
  maxRunningProcessesPerOwner: number;
}

export interface AgentPtyObservation {
  binding: import("./agent-pty-bindings.js").AgentPtyBinding;
  output: string;
  outputCursor: number;
  oldestAvailableCursor: number;
  outputTruncated: boolean;
  running: boolean;
  exitCode?: number;
  signal?: string;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Duration and output limits must be non-negative.");
  }
  return Math.min(Math.floor(value), maximum);
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive finite number.`);
  }
  return Math.floor(value);
}

function terminalSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Terminal dimensions must be integers between 1 and 1000.");
  }
  return value;
}

export function processEnvironment(additionalKeys?: Iterable<string>): Record<string, string> {
  return buildChildEnvironment({ additionalKeys });
}


export class ProcessSessionManager {
  private readonly sessions = new Map<string, ProcessSession>();
  private readonly fencedWorkSessions = new Set<string>();
  private readonly launches = new Map<string, LaunchRecord>();
  private readonly maxBufferCharacters: number;
  private readonly completedSessionTtlMs: number;
  private readonly maxRunningProcesses: number;
  private readonly maxRunningProcessesPerOwner: number;
  private readonly idleTimeoutMs: number;
  private readonly maxRuntimeMs: number;
  private readonly childEnvironmentAllowlist: string[];
  private readonly agentPtyBindings?: AgentPtyBindingStore;
  private readonly recoveryCapabilities = new Map<string, ProcessRecoveryCapability>();
  private readonly reaperTimer: NodeJS.Timeout;

  constructor(options: ProcessSessionManagerOptions = {}) {
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
    this.maxRunningProcesses = positiveLimit(options.maxRunningProcesses, DEFAULT_MAX_RUNNING_PROCESSES, "maxRunningProcesses");
    this.maxRunningProcessesPerOwner = positiveLimit(options.maxRunningProcessesPerOwner, DEFAULT_MAX_RUNNING_PROCESSES_PER_OWNER, "maxRunningProcessesPerOwner");
    this.idleTimeoutMs = positiveLimit(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, "idleTimeoutMs");
    this.maxRuntimeMs = positiveLimit(options.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS, "maxRuntimeMs");
    this.childEnvironmentAllowlist = options.childEnvironmentAllowlist ?? [];
    this.agentPtyBindings = options.agentPtyBindings;
    const reaperIntervalMs = positiveLimit(options.reaperIntervalMs, DEFAULT_REAPER_INTERVAL_MS, "reaperIntervalMs");
    this.reaperTimer = setInterval(() => this.reapExpired(), reaperIntervalMs);
    this.reaperTimer.unref?.();
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    if (input.workSessionId && this.fencedWorkSessions.has(input.workSessionId)) {
      throw new Error("Work session is terminal; new process operations are fenced.");
    }
    if (input.readOnlyInspection && !isReadOnlyShellInspectionCommand(input.command)) {
      throw new Error("Command is not permitted in read-only shell inspection mode.");
    }
    if (input.agentPtyBinding && (!input.tty || process.platform === "win32" || !this.agentPtyBindings)) {
      throw new Error("Agent PTY binding requires an interactive Unix PTY and durable binding store.");
    }
    const launchKey = this.launchKey(input);
    const launchFingerprint = this.launchFingerprint(input);
    if (launchKey) {
      const existing = this.launches.get(launchKey);
      if (existing) {
        if (existing.fingerprint !== launchFingerprint) {
          throw new Error(`Client mutation ID ${input.clientMutationId} was already used for a different command launch.`);
        }
        const existingSession = this.sessions.get(existing.sessionId);
        if (!existingSession) {
          if (existing.finalSnapshot) return { ...existing.finalSnapshot };
          throw new Error(`Command launch ${input.clientMutationId} is already in progress; retry after reconciliation.`);
        }
        const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_COMMAND_YIELD_MS);
        await this.waitForExit(existingSession, yieldTimeMs);
        const snapshot = this.consume(existingSession, input.maxOutputTokens);
        if (!existingSession.running) this.removeSession(existingSession.id);
        return snapshot;
      }
    }
    this.assertCapacity(input.ownerId ?? `workspace:${input.workspaceId}`);
    const session = this.createSession(input);
    session.launchKey = launchKey;
    this.sessions.set(session.id, session);
    if (launchKey) this.launches.set(launchKey, { fingerprint: launchFingerprint, sessionId: session.id });

    try {
      if (input.agentPtyBinding) {
        const binding = this.agentPtyBindings!.attach({
          processSessionId: session.id,
          workspaceSessionId: input.agentPtyBinding.workspaceSessionId,
          workSessionId: input.workSessionId ?? "",
          runId: input.agentPtyBinding.runId,
          ownerPrincipalId: input.agentPtyBinding.ownerPrincipalId,
          running: true,
          outputCursor: session.buffer.cursor,
        });
        session.agentPtyBinding = {
          processSessionId: session.id,
          processGeneration: binding.processGeneration,
        };
        const credential = input.agentPtyBinding.createReviewCredential?.(binding);
        if (credential) {
          session.agentPtyCredentialFilePath = credential.credentialFilePath;
          session.agentPtyCredentialCleanup = credential.cleanup;
        }
      }
      if (input.tty && process.platform !== "win32") await this.startPty(session, input);
      else this.startPipe(session, input);
      // P1: a user-supplied child lifetime is bounded by the SAME configured
      // process-runtime ceiling the reaper enforces (processMaxRuntimeMs) —
      // never by a hard-coded constant. An explicit timeout can only shorten
      // (or, up to the ceiling, extend) the manager's own max-runtime kill.
      const timeoutMs = boundedInteger(input.timeoutMs, 0, this.maxRuntimeMs);
      if (timeoutMs > 0) {
        session.timeoutTimer = setTimeout(() => {
          if (!session.running) return;
          session.process?.kill("SIGTERM");
          void this.escalateIfRunning(session);
        }, timeoutMs);
        session.timeoutTimer.unref?.();
      }
    } catch (error) {
      if (session.agentPtyBinding) {
        try {
          this.agentPtyBindings?.finish(
            session.agentPtyBinding.processSessionId,
            session.agentPtyBinding.processGeneration,
            session.buffer.cursor,
          );
        } catch { /* preserve the original launch failure */ }
      }
      this.cleanupAgentPtyCredential(session);
      this.removeSession(session.id);
      if (launchKey) this.launches.delete(launchKey);
      throw error;
    }

    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_COMMAND_YIELD_MS);
    await this.waitForExit(session, yieldTimeMs);

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    const chars = input.chars ?? "";
    const interactionRequested =
      chars.length > 0 || input.columns !== undefined || input.rows !== undefined;
    const session = input.recoveryCapability
      ? this.getRecoverySession(
          input.workspaceId,
          input.sessionId,
          input.principalId,
          input.workSessionId,
          input.recoveryCapability,
          interactionRequested,
        )
      : this.getOwnedSession(input.workspaceId, input.sessionId, input.ownerId, input.workSessionId)
        ?? this.getDurablePrincipalSession(input.workspaceId, input.sessionId, input.principalId, input.workSessionId, interactionRequested);
    session.lastClientActivityAt = Date.now();

    if (input.columns !== undefined || input.rows !== undefined) {
      session.columns = terminalSize(input.columns, session.columns);
      session.rows = terminalSize(input.rows, session.rows);
      if (!session.process?.resize) {
        throw new Error(`Process session ${session.id} is not a PTY and cannot be resized.`);
      }
      session.process.resize(session.columns, session.rows);
    }

    const interruptRequested = chars.includes("\u0003") && session.running;
    if (interruptRequested) {
      session.process?.kill("SIGINT");
    }
    const writableChars = chars.replaceAll("\u0003", "");
    if (writableChars && session.running) session.process?.write(writableChars);

    // Cursor reads are pure observations: only wait when the requested range
    // has not been produced yet AND the process is still running.
    const awaitingNewOutput =
      input.afterCursor !== undefined && session.running && session.buffer.cursor <= input.afterCursor;
    if ((interactionRequested || awaitingNewOutput || (!input.afterCursor && !session.buffer.hasOutput())) && session.running) {
      const fallback = interactionRequested ? DEFAULT_INTERACTIVE_YIELD_MS : DEFAULT_POLL_YIELD_MS;
      const maximum = interactionRequested ? MAX_COMMAND_YIELD_MS : MAX_POLL_YIELD_MS;
      const yieldTimeMs = boundedInteger(input.yieldTimeMs, fallback, maximum);
      await this.waitForExit(session, yieldTimeMs);
    }

    const snapshot = this.consume(session, input.maxOutputTokens, input.afterCursor);
    // Explicit-cursor reads are observations; they never retire a completed
    // session, so a later observer can still read the final output.
    if (!session.running && input.afterCursor === undefined) this.removeSession(session.id);
    return snapshot;
  }

  terminate(workspaceId: string, sessionId: string, ownerId?: string, workSessionId?: string): void {
    const session = this.getOwnedSession(workspaceId, sessionId, ownerId, workSessionId);
    if (session?.running) session.process?.kill("SIGTERM");
  }

  revokeRecoveryCapability(recoveryCapability: string, principalId: string): boolean {
    const tokenHash = this.hashRecoveryCapability(recoveryCapability);
    const capability = this.recoveryCapabilities.get(tokenHash);
    if (!capability || capability.principalId !== principalId) return false;
    this.recoveryCapabilities.delete(tokenHash);
    const session = this.sessions.get(capability.sessionId);
    if (session?.recoveryCapabilityHash === tokenHash) {
      session.recoveryCapability = undefined;
      session.recoveryCapabilityHash = undefined;
    }
    return true;
  }

  /** Terminate all live sessions belonging to one MCP transport owner. */
  async terminateByOwner(ownerId: string, timeoutMs = 2_000): Promise<void> {
    // A principal-bound recovery capability gives the original requester a
    // short read-only reconnect window. Its bounded idle/runtime reaper still
    // owns cleanup; transport teardown must not erase the output being recovered.
    const running = [...this.sessions.values()].filter((session) => session.running
      && session.ownerId === ownerId
      && !session.recoveryCapabilityHash);
    for (const session of running) session.process?.kill("SIGTERM");
    await this.waitForSessions(running, timeoutMs);
    for (const session of running) {
      if (session.running) session.process?.kill("SIGKILL");
    }
    await this.waitForSessions(running, Math.min(timeoutMs, 500));
  }

  /** Fence new launches, revoke poll capabilities, and confirm all children
   * attributed to a terminal work session have stopped before its checkout
   * lease may be released. A survivor is a hard failure and keeps the lease. */
  async terminateByWorkSession(workSessionId: string, timeoutMs = 2_000): Promise<void> {
    this.fencedWorkSessions.add(workSessionId);
    const running = [...this.sessions.values()].filter((session) =>
      session.running && session.workSessionId === workSessionId);
    for (const session of running) {
      if (session.recoveryCapabilityHash && session.recoveryCapability && session.principalId) {
        this.revokeRecoveryCapability(session.recoveryCapability, session.principalId);
      }
      session.process?.kill("SIGTERM");
    }
    await this.waitForSessions(running, timeoutMs);
    for (const session of running) {
      if (session.running) session.process?.kill("SIGKILL");
    }
    await this.waitForSessions(running, Math.min(timeoutMs, 1_000));
    const survivors = running.filter((session) => session.running);
    if (survivors.length > 0) {
      throw new Error(`Work session process shutdown is unconfirmed for ${survivors.length} child process(es).`);
    }
  }

  getMetrics(): ProcessSessionMetrics {
    return {
      running: [...this.sessions.values()].filter((session) => session.running).length,
      total: this.sessions.size,
      maxRunningProcesses: this.maxRunningProcesses,
      maxRunningProcessesPerOwner: this.maxRunningProcessesPerOwner,
    };
  }

  listAgentPtyBindings(workSessionId: string): import("./agent-pty-bindings.js").AgentPtyBinding[] {
    return this.agentPtyBindings?.listForWorkSession(workSessionId) ?? [];
  }

  observeAgentPty(input: {
    workSessionId: string;
    processSessionId: string;
    afterCursor?: number;
    maxOutputCharacters?: number;
  }): AgentPtyObservation | undefined {
    const binding = this.agentPtyBindings?.getByProcessSession(input.processSessionId);
    if (!binding || binding.workSessionId !== input.workSessionId) return undefined;
    const session = this.sessions.get(input.processSessionId);
    const maxOutputCharacters = Math.max(1, Math.min(20_000, Math.floor(input.maxOutputCharacters ?? 4_000)));
    const afterCursor = input.afterCursor ?? Math.max(0, (session?.buffer.cursor ?? binding.outputCursor) - maxOutputCharacters);
    if (!session) {
      return {
        binding,
        output: "",
        outputCursor: binding.outputCursor,
        oldestAvailableCursor: binding.outputCursor,
        outputTruncated: binding.outputCursor > afterCursor,
        running: false,
      };
    }
    const read = session.buffer.read(afterCursor, maxOutputCharacters);
    return {
      binding,
      output: read.output,
      outputCursor: read.nextCursor,
      oldestAvailableCursor: read.oldestAvailableCursor,
      outputTruncated: read.truncated,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
    };
  }

  /** Number of live child processes fenced to one persisted workspace. */
  countRunningForWorkspace(workspaceId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.running && session.workspaceId === workspaceId) count++;
    }
    return count;
  }

  async shutdown(timeoutMs = 2_000): Promise<void> {
    clearInterval(this.reaperTimer);
    const running = [...this.sessions.values()].filter((session) => session.running);
    for (const session of running) {
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
      if (session.running) session.process?.kill("SIGTERM");
    }
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([Promise.all(running.map((session) => session.exitPromise)), timeout]);
    // P0 #6: SIGTERM survivors must not outlive Kontrol while the ownership
    // record is being discarded. Escalate to a hard process-tree kill before
    // clearing state, mirroring ACP adapter shutdown semantics.
    for (const session of running) {
      if (!session.running) continue;
      try {
        session.process?.kill("SIGKILL");
      } catch {
        // Already gone — fine.
      }
    }
    await this.waitForSessions(running, Math.min(timeoutMs, 500));
    this.sessions.clear();
    this.recoveryCapabilities.clear();
    for (const launch of this.launches.values()) {
      if (launch.cleanupTimer) clearTimeout(launch.cleanupTimer);
    }
    this.launches.clear();
  }

  private assertCapacity(ownerId: string): void {
    const running = [...this.sessions.values()].filter((session) => session.running);
    if (running.length >= this.maxRunningProcesses) {
      throw new Error(`Process session limit reached (${this.maxRunningProcesses} running processes).`);
    }
    const ownerRunning = running.filter((session) => session.ownerId === ownerId).length;
    if (ownerRunning >= this.maxRunningProcessesPerOwner) {
      throw new Error(`Process session limit reached for owner (${this.maxRunningProcessesPerOwner} running processes).`);
    }
  }

  private async reapExpired(): Promise<void> {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.running) continue;
      const idle = now - Math.max(session.lastClientActivityAt, session.lastProcessActivityAt) >= this.idleTimeoutMs;
      const overRuntime = now - session.startedAt >= this.maxRuntimeMs;
      if (idle || overRuntime) {
        session.process?.kill("SIGTERM");
        void this.escalateIfRunning(session);
      }
    }
  }

  private async escalateIfRunning(session: ProcessSession): Promise<void> {
    await Promise.race([session.exitPromise, new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      timer.unref?.();
    })]);
    if (session.running) session.process?.kill("SIGKILL");
  }

  private async waitForSessions(sessions: ProcessSession[], timeoutMs: number): Promise<void> {
    if (sessions.length === 0) return;
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([Promise.all(sessions.map((session) => session.exitPromise)), timeout]);
  }

  private async waitForExit(session: ProcessSession, yieldTimeMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.exitPromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, yieldTimeMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async stopUnboundSession(session: ProcessSession): Promise<boolean> {
    try { session.process?.kill("SIGTERM"); } catch { /* already gone */ }
    await this.waitForExit(session, 2_000);
    if (session.running) {
      try { session.process?.kill("SIGKILL"); } catch { /* already gone */ }
      await this.waitForExit(session, 500);
    }
    return !session.running;
  }

  private createSession(input: StartCommandInput): ProcessSession {
    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const session: ProcessSession = {
      id: `proc_${randomUUID()}`,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId ?? `workspace:${input.workspaceId}`,
      workSessionId: input.workSessionId,
      principalId: input.principalId,
      command: input.command,
      startedAt: Date.now(),
      columns: terminalSize(input.columns, DEFAULT_COLUMNS),
      rows: terminalSize(input.rows, DEFAULT_ROWS),
      buffer: new OutputLog(this.maxBufferCharacters),
      readCursor: 0,
      running: true,
      exitPromise,
      resolveExit,
      lastClientActivityAt: Date.now(),
      lastProcessActivityAt: Date.now(),
    };
    if (input.principalId?.trim()) this.issueRecoveryCapability(session, input.principalId);
    return session;
  }

  private issueRecoveryCapability(session: ProcessSession, principalId: string): void {
    this.pruneRecoveryCapabilities();
    if (this.recoveryCapabilities.size >= MAX_PROCESS_RECOVERY_CAPABILITIES) return;
    const token = randomBytes(32).toString("base64url");
    const tokenHash = this.hashRecoveryCapability(token);
    session.recoveryCapability = token;
    session.recoveryCapabilityHash = tokenHash;
    this.recoveryCapabilities.set(tokenHash, {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      principalId,
      workSessionId: session.workSessionId,
      expiresAt: session.startedAt + this.maxRuntimeMs + this.completedSessionTtlMs,
      operations: ["poll_output"],
    });
  }

  private hashRecoveryCapability(capability: string): string {
    return createHash("sha256").update(capability, "utf8").digest("hex");
  }

  private pruneRecoveryCapabilities(now = Date.now()): void {
    for (const [tokenHash, capability] of this.recoveryCapabilities) {
      if (capability.expiresAt <= now || !this.sessions.has(capability.sessionId)) {
        this.recoveryCapabilities.delete(tokenHash);
        const session = this.sessions.get(capability.sessionId);
        if (session?.recoveryCapabilityHash === tokenHash) {
          session.recoveryCapability = undefined;
          session.recoveryCapabilityHash = undefined;
        }
      }
    }
  }

  private getRecoverySession(
    workspaceId: string,
    sessionId: string,
    principalId: string | undefined,
    workSessionId: string | undefined,
    recoveryCapability: string,
    interactionRequested: boolean,
  ): ProcessSession {
    if (interactionRequested) {
      throw new Error("Process recovery capabilities permit output polling only; input, resize, and signals require the original owner.");
    }
    if (!principalId?.trim()) throw new Error("Process recovery requires an authenticated principal.");
    this.pruneRecoveryCapabilities();
    const tokenHash = this.hashRecoveryCapability(recoveryCapability);
    const capability = this.recoveryCapabilities.get(tokenHash);
    if (!capability || capability.expiresAt <= Date.now() || !capability.operations.includes("poll_output")) {
      throw new Error("Process recovery capability is invalid, expired, or revoked.");
    }
    if (capability.principalId !== principalId) throw new Error("Process recovery capability belongs to another principal.");
    if (capability.workspaceId !== workspaceId) throw new Error("Process recovery capability belongs to another workspace.");
    if (capability.sessionId !== sessionId) throw new Error("Process recovery capability belongs to another process.");
    if (capability.workSessionId !== workSessionId) throw new Error("Process recovery capability is bound to another work session.");
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.recoveryCapabilityHash !== tokenHash) throw new Error("Process recovery capability has been revoked.");
    session.lastClientActivityAt = Date.now();
    return session;
  }

  private startPipe(session: ProcessSession, input: StartCommandInput): void {
    const shell = resolveShellCommand(input.command);
    const detached = process.platform !== "win32";
    const env = processEnvironment(this.childEnvironmentAllowlist);
    if (input.readOnlyInspection) {
      Object.assign(env, {
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        PAGER: "cat",
        GIT_CONFIG_COUNT: "5",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/dev/null",
        GIT_CONFIG_KEY_1: "core.fsmonitor",
        GIT_CONFIG_VALUE_1: "false",
        GIT_CONFIG_KEY_2: "core.untrackedCache",
        GIT_CONFIG_VALUE_2: "false",
        GIT_CONFIG_KEY_3: "credential.helper",
        GIT_CONFIG_VALUE_3: "",
        GIT_CONFIG_KEY_4: "diff.external",
        GIT_CONFIG_VALUE_4: "",
      });
    }
    const crashFenced = process.platform === "linux";
    let command = input.command;
    if (crashFenced) {
      const ownerIdentity = linuxProcessIdentity(process.pid);
      if (!ownerIdentity) throw new Error("Cannot establish Linux process identity; refusing to launch an unfenced shell command.");
      const moduleDir = dirname(fileURLToPath(import.meta.url));
      const javascriptRunner = resolve(moduleDir, "process-session-runner.js");
      const typescriptRunner = resolve(moduleDir, "process-session-runner.ts");
      const runnerPath = existsSync(javascriptRunner) ? javascriptRunner : typescriptRunner;
      const runnerArgs = existsSync(javascriptRunner)
        ? [runnerPath, String(process.pid), ownerIdentity]
        : ["--import", import.meta.resolve("tsx"), runnerPath, String(process.pid), ownerIdentity];
      const quotedRunnerArgs = runnerArgs.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
      // The runner is the detached process-group leader. It waits on a private
      // launch pipe until this manager has attached all ownership/output
      // handlers, then forwards the exact shell args and streams. If the core
      // dies, the runner kills every descendant still in its process group.
      command = `exec ${[`'${process.execPath.replaceAll("'", "'\\''")}'`, quotedRunnerArgs].join(" ")}`;
    }
    const child = spawn(crashFenced ? shell.executable : input.command, crashFenced ? [...shell.args.slice(0, -1), command] : [], {
      cwd: input.cwd,
      env,
      stdio: crashFenced ? ["pipe", "pipe", "pipe", "pipe"] : "pipe",
      windowsHide: true,
      detached,
      ...(!crashFenced && { shell: shell.executable }),
    });

    session.process = {
      write: (data) => child.stdin.write(data),
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
      resize: input.tty ? () => undefined : undefined,
    };
    const handleStreamError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ECONNRESET") return;
      this.append(session, `Process stream error (${error.code ?? "unknown"}).\n`);
    };
    child.stdin?.on("error", handleStreamError);
    child.stdout?.on("error", handleStreamError);
    child.stderr?.on("error", handleStreamError);
    child.stdout?.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.stderr?.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.on("error", (error) => this.append(session, `${error.message}\n`));
    child.on("close", (code, signal) => this.finish(session, code ?? undefined, signal ?? undefined));
    if (crashFenced) {
      const launchGate = child.stdio[3];
      if (!launchGate || typeof launchGate === "number" || !("write" in launchGate)) {
        child.kill("SIGKILL");
        throw new Error("Could not establish process-session ownership launch gate.");
      }
      launchGate.on("error", handleStreamError);
      launchGate.write(`${JSON.stringify({ command: input.command })}\n`);
    }
  }

  private async startPty(session: ProcessSession, input: StartCommandInput): Promise<void> {
    let nodePty: typeof import("node-pty");
    try {
      nodePty = await import("node-pty");
    } catch {
      throw new Error("PTY support requires the optional node-pty dependency.");
    }

    const shell = resolveShellCommand(input.command);
    let pty: import("node-pty").IPty;
    try {
      const env = processEnvironment(this.childEnvironmentAllowlist);
      if (session.agentPtyCredentialFilePath) {
        env.KONTROL_AGENT_PTY_CREDENTIAL_FILE = session.agentPtyCredentialFilePath;
      }
      pty = nodePty.spawn(shell.executable, shell.args, {
        cwd: input.cwd,
        env,
        name: "xterm-256color",
        cols: session.columns,
        rows: session.rows,
      });
    } catch (error) {
      throw error;
    }

    session.process = {
      write: (data) => pty.write(data),
      kill: (signal) => pty.kill(signal),
      resize: (columns, rows) => pty.resize(columns, rows),
    };
    pty.onData((data) => this.append(session, data));
    pty.onExit(({ exitCode, signal }) => {
      this.finish(session, exitCode, signal === 0 ? undefined : String(signal));
    });
  }

  private finish(session: ProcessSession, exitCode?: number, signal?: string): void {
    if (!session.running) return;
    session.running = false;
    if (session.timeoutTimer) {
      clearTimeout(session.timeoutTimer);
      session.timeoutTimer = undefined;
    }
    session.exitCode = exitCode;
    session.signal = signal;
    session.resolveExit();
    if (session.agentPtyBinding) {
      try {
        this.agentPtyBindings?.finish(
          session.agentPtyBinding.processSessionId,
          session.agentPtyBinding.processGeneration,
          session.buffer.cursor,
        );
      } catch (error) {
        console.error(`[kontrol] could not persist agent PTY exit for ${session.id}:`, error);
      }
    }
    this.cleanupAgentPtyCredential(session);
    session.cleanupTimer = setTimeout(
      () => this.removeSession(session.id),
      this.completedSessionTtlMs,
    );
    session.cleanupTimer.unref();
    if (session.launchKey) {
      const launch = this.launches.get(session.launchKey);
      if (launch) {
        launch.cleanupTimer = setTimeout(() => this.launches.delete(session.launchKey!), this.completedSessionTtlMs);
        launch.cleanupTimer.unref();
      }
    }
  }

  private cleanupAgentPtyCredential(session: ProcessSession): void {
    const cleanup = session.agentPtyCredentialCleanup;
    session.agentPtyCredentialCleanup = undefined;
    session.agentPtyCredentialFilePath = undefined;
    try { cleanup?.(); }
    catch (error) { console.error(`[kontrol] could not remove agent PTY review credential for ${session.id}:`, error); }
  }

  private append(session: ProcessSession, output: string): void {
    if (output) session.lastProcessActivityAt = Date.now();
    session.buffer.append(output);
    if (session.agentPtyBinding) {
      try {
        this.agentPtyBindings?.advanceOutputCursor(
          session.agentPtyBinding.processSessionId,
          session.agentPtyBinding.processGeneration,
          session.buffer.cursor,
        );
      } catch (error) {
        console.error(`[kontrol] could not persist agent PTY output cursor for ${session.id}:`, error);
        session.process?.kill("SIGTERM");
      }
    }
  }

  /**
   * P0 (nondestructive polling): read NEW output since the session's last
   * read without destroying the log. A repeated read at the same position
   * (lost response, retried poll) returns the same bytes until retention
   * evicts them. `write()` with afterCursor delegates here with an explicit
   * cursor and never moves the session's own read pointer.
   */
  private consume(session: ProcessSession, maxOutputTokens?: number, afterCursor?: number): ProcessSnapshot {
    const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const maxCharacters = Math.max(256, limit * 4);
    const useExplicitCursor = afterCursor !== undefined;
    const from = useExplicitCursor ? afterCursor : session.readCursor;
    const read = session.buffer.read(from, maxCharacters);
    if (!useExplicitCursor) session.readCursor = read.nextCursor;

    const snapshot = {
      sessionId: session.running ? session.id : undefined,
      command: session.command,
      output: read.output,
      outputTruncated: read.truncated,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      wallTimeMs: Date.now() - session.startedAt,
      outputCursor: read.nextCursor,
      oldestAvailableCursor: read.oldestAvailableCursor,
      startedAtEpochMs: session.startedAt,
      ...(session.running && session.recoveryCapability ? { recoveryCapability: session.recoveryCapability } : {}),
    };
    if (!snapshot.running && session.launchKey) {
      const launch = this.launches.get(session.launchKey);
      if (launch && !useExplicitCursor) launch.finalSnapshot = { ...snapshot };
    }
    return snapshot;
  }

  private launchKey(input: StartCommandInput): string | undefined {
    if (!input.clientMutationId) return undefined;
    return `${input.ownerId ?? `workspace:${input.workspaceId}`}\u0000${input.clientMutationId}`;
  }

  private launchFingerprint(input: StartCommandInput): string {
    return JSON.stringify({
      workspaceId: input.workspaceId,
      workSessionId: input.workSessionId ?? null,
      command: input.command,
      readOnlyInspection: Boolean(input.readOnlyInspection),
      cwd: input.cwd,
      tty: Boolean(input.tty),
      columns: input.columns ?? null,
      rows: input.rows ?? null,
      timeoutMs: input.timeoutMs ?? null,
      agentPtyBinding: input.agentPtyBinding ? {
        workspaceSessionId: input.agentPtyBinding.workspaceSessionId,
        runId: input.agentPtyBinding.runId,
        ownerPrincipalId: input.agentPtyBinding.ownerPrincipalId,
      } : null,
    });
  }

  private getOwnedSession(workspaceId: string, sessionId: string, ownerId?: string, workSessionId?: string): ProcessSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
    }
    const expectedOwner = ownerId ?? `workspace:${workspaceId}`;
    if (session.ownerId !== expectedOwner) {
      // A verified durable principal may inspect output across transports,
      // but this helper deliberately returns undefined so control/input still
      // requires the original owner or an explicit recovery capability.
      return undefined;
    }
    if (session.workSessionId !== workSessionId) {
      throw new Error(`Process session ${sessionId} is bound to another work session.`);
    }
    return session;
  }

  private getDurablePrincipalSession(
    workspaceId: string,
    sessionId: string,
    principalId: string | undefined,
    workSessionId: string | undefined,
    interactionRequested: boolean,
  ): ProcessSession {
    if (interactionRequested) {
      throw new Error(`Process session ${sessionId} is owned by another client; input and process control require the original owner.`);
    }
    if (!principalId?.trim()) {
      throw new Error(`Process session ${sessionId} is owned by another client.`);
    }
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
    }
    if (session.principalId !== principalId) {
      throw new Error(`Process session ${sessionId} belongs to another principal.`);
    }
    if (session.workSessionId !== workSessionId) {
      throw new Error(`Process session ${sessionId} is bound to another work session.`);
    }
    return session;
  }

  private removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
    this.sessions.delete(sessionId);
    for (const [tokenHash, capability] of this.recoveryCapabilities) {
      if (capability.sessionId === sessionId) this.recoveryCapabilities.delete(tokenHash);
    }
  }
}
