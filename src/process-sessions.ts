import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";
import { buildChildEnvironment } from "./process-environment.js";

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
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface StartCommandInput {
  workspaceId: string;
  /** Stable owner for this MCP transport; never infer cross-client ownership from workspace alone. */
  ownerId?: string;
  workSessionId?: string;
  command: string;
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
}

export interface WriteStdinInput {
  workspaceId: string;
  sessionId: string;
  ownerId?: string;
  workSessionId?: string;
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
}

interface LaunchRecord {
  fingerprint: string;
  sessionId: string;
  finalSnapshot?: ProcessSnapshot;
  cleanupTimer?: NodeJS.Timeout;
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
}

export interface ProcessSessionMetrics {
  running: number;
  total: number;
  maxRunningProcesses: number;
  maxRunningProcessesPerOwner: number;
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

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function sliceCodePoints(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function takeHead(value: string, count: number): string {
  if (count <= 0) return "";
  return sliceCodePoints(value, 0, count);
}

function takeTail(value: string, count: number): string {
  if (count <= 0) return "";
  const characters = Array.from(value);
  return characters.slice(Math.max(0, characters.length - count)).join("");
}

function splitBudget(maxCharacters: number): { head: number; tail: number } {
  return {
    head: Math.ceil(maxCharacters / 2),
    tail: Math.floor(maxCharacters / 2),
  };
}

function formatHeadTail(head: string, tail: string, omittedCharacters: number): string {
  if (omittedCharacters <= 0) return head + tail;
  return `${head}\n... output truncated (${omittedCharacters} characters omitted) ...\n${tail}`;
}

export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private totalCharacters = 0;

  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Head/tail buffer limit must be a positive integer.");
    }
  }

  append(output: string): void {
    if (!output) return;

    const previousTotal = this.totalCharacters;
    this.totalCharacters += codePointLength(output);

    if (this.totalCharacters <= this.maxCharacters) {
      this.head += output;
      return;
    }

    const budget = splitBudget(this.maxCharacters);
    if (previousTotal <= this.maxCharacters) {
      const fullOutput = this.head + output;
      this.head = takeHead(fullOutput, budget.head);
      this.tail = takeTail(fullOutput, budget.tail);
      return;
    }

    this.tail = takeTail(this.tail + output, budget.tail);
  }

  hasOutput(): boolean {
    return this.totalCharacters > 0;
  }

  drain(maxCharacters: number): { output: string; truncated: boolean } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output limit must be a positive integer.");
    }

    const omittedByBuffer = Math.max(
      0,
      this.totalCharacters - codePointLength(this.head) - codePointLength(this.tail),
    );
    const retained = formatHeadTail(this.head, this.tail, omittedByBuffer);
    const output = truncateOutput(retained, maxCharacters);
    const truncated = omittedByBuffer > 0 || output.truncated;

    this.head = "";
    this.tail = "";
    this.totalCharacters = 0;

    return { output: output.output, truncated };
  }
}

function truncateOutput(output: string, maxCharacters: number): { output: string; truncated: boolean } {
  const outputCharacters = codePointLength(output);
  if (outputCharacters <= maxCharacters) return { output, truncated: false };

  const marker = "\n... output truncated ...\n";
  const markerCharacters = codePointLength(marker);
  const available = Math.max(0, maxCharacters - markerCharacters);
  const budget = splitBudget(available);
  return {
    output: takeHead(output, budget.head) + marker + takeTail(output, budget.tail),
    truncated: true,
  };
}

/**
 * Bounded, monotonically indexed output log (P0: nondestructive polling).
 *
 * Appends are assigned consecutive character cursors. Reads NEVER destroy
 * data: a read at a given cursor returns the same bytes until the chunk is
 * evicted by the retention bound. This is what makes poll_process retry-safe
 * (a lost response can be re-read at the same cursor) and allows multiple
 * observers to follow one process independently.
 */
export class OutputLog {
  /** Chunks of retained output; each carries its start cursor. */
  private chunks: Array<{ startCursor: number; text: string }> = [];
  private retainedCharacters = 0;
  private writeCursor = 0;

  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output log limit must be a positive integer.");
    }
  }

  append(output: string): number {
    if (!output) return this.writeCursor;
    this.chunks.push({ startCursor: this.writeCursor, text: output });
    this.retainedCharacters += codePointLength(output);
    this.writeCursor += codePointLength(output);
    this.evict();
    return this.writeCursor;
  }

  get cursor(): number {
    return this.writeCursor;
  }

  hasOutput(): boolean {
    return this.retainedCharacters > 0;
  }

  /** Oldest cursor still retained; earlier ranges were evicted. */
  get oldestCursor(): number {
    return this.chunks.length > 0 ? this.chunks[0].startCursor : this.writeCursor;
  }

  /**
   * Read up to maxCharacters starting strictly after afterCursor. Returns
   * cursorLapsed=true when the requested range was already evicted (the
   * caller fell behind retention and MUST be told, never silently given a
   * hole).
   */
  read(afterCursor: number, maxCharacters: number): {
    output: string;
    nextCursor: number;
    oldestAvailableCursor: number;
    cursorLapsed: boolean;
    truncated: boolean;
  } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output limit must be a positive integer.");
    }
    if (!Number.isInteger(afterCursor) || afterCursor < 0) {
      throw new Error("afterCursor must be a non-negative integer.");
    }

    const oldestAvailableCursor = this.oldestCursor;
    const cursorLapsed = afterCursor < oldestAvailableCursor;
    const effectiveStart = Math.max(afterCursor, oldestAvailableCursor);

    // Assemble retained text from effectiveStart onward.
    let assembled = "";
    for (const chunk of this.chunks) {
      const chunkEnd = chunk.startCursor + codePointLength(chunk.text);
      if (chunkEnd <= effectiveStart) continue;
      const offset = Math.max(0, effectiveStart - chunk.startCursor);
      assembled += sliceCodePoints(chunk.text, offset);
    }

    const availableCharacters = this.writeCursor - effectiveStart;
    const truncatedByLimit = codePointLength(assembled) > maxCharacters;
    const clipped = truncatedByLimit
      ? takeHead(assembled, maxCharacters)
      : assembled;
    const output = truncateOutput(clipped, maxCharacters);

    return {
      output: output.output,
      nextCursor: effectiveStart + codePointLength(clipped),
      oldestAvailableCursor,
      cursorLapsed: cursorLapsed || availableCharacters > codePointLength(assembled),
      truncated: output.truncated || truncatedByLimit || cursorLapsed,
    };
  }

  private evict(): void {
    while (this.retainedCharacters > this.maxCharacters && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.retainedCharacters -= codePointLength(dropped.text);
    }
    // A single oversized chunk is retained as-is; reads bound what they return.
  }
}

export class ProcessSessionManager {
  private readonly sessions = new Map<string, ProcessSession>();
  private readonly launches = new Map<string, LaunchRecord>();
  private readonly maxBufferCharacters: number;
  private readonly completedSessionTtlMs: number;
  private readonly maxRunningProcesses: number;
  private readonly maxRunningProcessesPerOwner: number;
  private readonly idleTimeoutMs: number;
  private readonly maxRuntimeMs: number;
  private readonly childEnvironmentAllowlist: string[];
  private readonly reaperTimer: NodeJS.Timeout;

  constructor(options: ProcessSessionManagerOptions = {}) {
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
    this.maxRunningProcesses = positiveLimit(options.maxRunningProcesses, DEFAULT_MAX_RUNNING_PROCESSES, "maxRunningProcesses");
    this.maxRunningProcessesPerOwner = positiveLimit(options.maxRunningProcessesPerOwner, DEFAULT_MAX_RUNNING_PROCESSES_PER_OWNER, "maxRunningProcessesPerOwner");
    this.idleTimeoutMs = positiveLimit(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, "idleTimeoutMs");
    this.maxRuntimeMs = positiveLimit(options.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS, "maxRuntimeMs");
    this.childEnvironmentAllowlist = options.childEnvironmentAllowlist ?? [];
    const reaperIntervalMs = positiveLimit(options.reaperIntervalMs, DEFAULT_REAPER_INTERVAL_MS, "reaperIntervalMs");
    this.reaperTimer = setInterval(() => this.reapExpired(), reaperIntervalMs);
    this.reaperTimer.unref?.();
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
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
      this.sessions.delete(session.id);
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
    const session = this.getOwnedSession(input.workspaceId, input.sessionId, input.ownerId, input.workSessionId);
    session.lastClientActivityAt = Date.now();
    const chars = input.chars ?? "";
    const interactionRequested =
      chars.length > 0 || input.columns !== undefined || input.rows !== undefined;

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
    if (session.running) session.process?.kill("SIGTERM");
  }

  /** Terminate all live sessions belonging to one MCP transport owner. */
  async terminateByOwner(ownerId: string, timeoutMs = 2_000): Promise<void> {
    const running = [...this.sessions.values()].filter((session) => session.running && session.ownerId === ownerId);
    for (const session of running) session.process?.kill("SIGTERM");
    await this.waitForSessions(running, timeoutMs);
    for (const session of running) {
      if (session.running) session.process?.kill("SIGKILL");
    }
    await this.waitForSessions(running, Math.min(timeoutMs, 500));
  }

  getMetrics(): ProcessSessionMetrics {
    return {
      running: [...this.sessions.values()].filter((session) => session.running).length,
      total: this.sessions.size,
      maxRunningProcesses: this.maxRunningProcesses,
      maxRunningProcessesPerOwner: this.maxRunningProcessesPerOwner,
    };
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

  private createSession(input: StartCommandInput): ProcessSession {
    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    return {
      id: `proc_${randomUUID()}`,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId ?? `workspace:${input.workspaceId}`,
      workSessionId: input.workSessionId,
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
  }

  private startPipe(session: ProcessSession, input: StartCommandInput): void {
    const shell = resolveShellCommand(input.command);
    const detached = process.platform !== "win32";
    const child = spawn(input.command, {
      cwd: input.cwd,
      env: processEnvironment(this.childEnvironmentAllowlist),
      stdio: "pipe",
      windowsHide: true,
      detached,
      shell: shell.executable,
    });

    session.process = {
      write: (data) => child.stdin.write(data),
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
      resize: input.tty ? () => undefined : undefined,
    };
    child.stdout.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.stderr.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.on("error", (error) => this.append(session, `${error.message}\n`));
    child.on("close", (code, signal) => this.finish(session, code ?? undefined, signal ?? undefined));
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
      pty = nodePty.spawn(shell.executable, shell.args, {
        cwd: input.cwd,
        env: processEnvironment(this.childEnvironmentAllowlist),
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
    session.cleanupTimer = setTimeout(
      () => this.sessions.delete(session.id),
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

  private append(session: ProcessSession, output: string): void {
    if (output) session.lastProcessActivityAt = Date.now();
    session.buffer.append(output);
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
      cwd: input.cwd,
      tty: Boolean(input.tty),
      columns: input.columns ?? null,
      rows: input.rows ?? null,
      timeoutMs: input.timeoutMs ?? null,
    });
  }

  private getOwnedSession(workspaceId: string, sessionId: string, ownerId?: string, workSessionId?: string): ProcessSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
    }
    const expectedOwner = ownerId ?? `workspace:${workspaceId}`;
    if (session.ownerId !== expectedOwner) {
      throw new Error(`Process session ${sessionId} is owned by another client.`);
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
  }
}
