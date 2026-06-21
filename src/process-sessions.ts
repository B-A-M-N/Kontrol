import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const DEFAULT_YIELD_MS = 10_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_CHARACTERS = 1_000_000;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;

export interface StartCommandInput {
  workspaceId: string;
  command: string;
  cwd: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface WriteStdinInput {
  workspaceId: string;
  sessionId: string;
  chars?: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface ProcessSnapshot {
  sessionId?: string;
  output: string;
  outputTruncated: boolean;
  running: boolean;
  exitCode?: number;
  signal?: NodeJS.Signals;
  wallTimeMs: number;
}

interface ProcessSession {
  id: string;
  workspaceId: string;
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  buffer: string;
  bufferStart: number;
  consumedThrough: number;
  running: boolean;
  exitCode?: number;
  signal?: NodeJS.Signals;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  cleanupTimer?: NodeJS.Timeout;
}

interface ProcessSessionManagerOptions {
  maxBufferCharacters?: number;
  completedSessionTtlMs?: number;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new Error("Duration and output limits must be non-negative.");
  return Math.min(Math.floor(value), maximum);
}

function shellCommand(command: string): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      executable: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }

  return {
    executable: process.env.SHELL ?? "/bin/bash",
    args: ["-lc", command],
  };
}

function truncateOutput(output: string, maxOutputTokens: number): { output: string; truncated: boolean } {
  const maxCharacters = Math.max(256, maxOutputTokens * 4);
  if (output.length <= maxCharacters) return { output, truncated: false };

  const marker = "\n... output truncated ...\n";
  const available = maxCharacters - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return {
    output: output.slice(0, head) + marker + output.slice(output.length - tail),
    truncated: true,
  };
}

export class ProcessSessionManager {
  private readonly sessions = new Map<string, ProcessSession>();
  private readonly maxBufferCharacters: number;
  private readonly completedSessionTtlMs: number;

  constructor(options: ProcessSessionManagerOptions = {}) {
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    const id = randomUUID();
    const shell = shellCommand(input.command);
    const child = spawn(shell.executable, shell.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: "pipe",
      windowsHide: true,
    });

    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const session: ProcessSession = {
      id,
      workspaceId: input.workspaceId,
      child,
      startedAt: Date.now(),
      buffer: "",
      bufferStart: 0,
      consumedThrough: 0,
      running: true,
      exitPromise,
      resolveExit,
    };
    this.sessions.set(id, session);

    child.stdout.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.stderr.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.on("error", (error) => this.append(session, `${error.message}\n`));
    child.on("close", (code, signal) => {
      session.running = false;
      session.exitCode = code ?? undefined;
      session.signal = signal ?? undefined;
      session.resolveExit();
      session.cleanupTimer = setTimeout(() => this.sessions.delete(id), this.completedSessionTtlMs);
      session.cleanupTimer.unref();
    });

    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_YIELD_MS, 30_000);
    await Promise.race([
      session.exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, yieldTimeMs)),
    ]);

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    const session = this.getOwnedSession(input.workspaceId, input.sessionId);
    const chars = input.chars ?? "";

    if (chars.includes("\u0003") && session.running) {
      session.child.kill("SIGINT");
    }
    const writableChars = chars.replaceAll("\u0003", "");
    if (writableChars && session.running) session.child.stdin.write(writableChars);

    const hasUnreadOutput = session.consumedThrough < session.bufferStart + session.buffer.length;
    if (!hasUnreadOutput && session.running) {
      const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_YIELD_MS, 30_000);
      await Promise.race([
        session.exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, yieldTimeMs)),
      ]);
    }

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  terminate(workspaceId: string, sessionId: string): void {
    const session = this.getOwnedSession(workspaceId, sessionId);
    if (session.running) session.child.kill("SIGTERM");
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      if (session.running) session.child.kill("SIGTERM");
    }
    this.sessions.clear();
  }

  private append(session: ProcessSession, output: string): void {
    session.buffer += output;
    if (session.buffer.length <= this.maxBufferCharacters) return;

    const remove = session.buffer.length - this.maxBufferCharacters;
    session.buffer = session.buffer.slice(remove);
    session.bufferStart += remove;
  }

  private consume(session: ProcessSession, maxOutputTokens?: number): ProcessSnapshot {
    const missedOutput = session.consumedThrough < session.bufferStart;
    const start = Math.max(0, session.consumedThrough - session.bufferStart);
    const unread = session.buffer.slice(start);
    session.consumedThrough = session.bufferStart + session.buffer.length;

    const limit = boundedInteger(
      maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
      100_000,
    );
    const truncated = truncateOutput(unread, limit);

    return {
      sessionId: session.running ? session.id : undefined,
      output: truncated.output,
      outputTruncated: missedOutput || truncated.truncated,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      wallTimeMs: Date.now() - session.startedAt,
    };
  }

  private getOwnedSession(workspaceId: string, sessionId: string): ProcessSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
    }
    return session;
  }

  private removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
    this.sessions.delete(sessionId);
  }
}
