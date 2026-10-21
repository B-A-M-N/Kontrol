export class CdpCommandError extends Error {
  readonly method: string;
  readonly effectUncertain: boolean;
  readonly code?: number;

  constructor(message: string, input: { method: string; effectUncertain?: boolean; code?: number }) {
    super(message);
    this.name = "CdpCommandError";
    this.method = input.method;
    this.effectUncertain = input.effectUncertain ?? false;
    this.code = input.code;
  }
}

interface PendingCommand {
  method: string;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

type CdpEvent = (params: Record<string, unknown>, sessionId?: string) => void;

export class CdpClient {
  private socket?: WebSocket;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Map<string, Set<CdpEvent>>();

  constructor(private readonly endpoint: string, private readonly commandTimeoutMs = 10_000) {}

  async connect(): Promise<this> {
    const url = new URL(this.endpoint);
    if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
      throw new Error("CDP only accepts a loopback ws:// endpoint.");
    }
    if (typeof WebSocket !== "function") throw new Error("Native WebSocket support requires Node 22 or newer.");
    const socket = new WebSocket(url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to the local Chromium CDP endpoint.")), this.commandTimeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not connect to the local Chromium CDP endpoint.")); }, { once: true });
    });
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => this.onClose());
    socket.addEventListener("error", () => this.onClose());
    return this;
  }

  on(method: string, listener: CdpEvent): () => void {
    const listeners = this.listeners.get(method) ?? new Set<CdpEvent>();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = this.commandTimeoutMs,
  ): Promise<T> {
    if (!this.socket || this.closed) return Promise.reject(new Error("CDP connection is closed."));
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpCommandError(`CDP command timed out: ${method}`, { method, effectUncertain: true }));
      }, timeoutMs);
      this.pending.set(id, { method, timer, resolve: (value) => resolve(value as T), reject });
      try { this.socket!.send(message); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpCommandError(error instanceof Error ? error.message : String(error), { method, effectUncertain: false }));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    this.rejectPending(new Error("CDP connection closed."), true);
  }

  private onMessage(raw: unknown): void {
    const text = typeof raw === "string" ? raw : String(raw);
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) return this.onClose(new Error("CDP response exceeded 8 MiB."));
    let message: any;
    try { message = JSON.parse(text); } catch { return; }
    if (Number.isInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new CdpCommandError(String(message.error.message ?? "CDP command failed"), {
        method: pending.method, code: Number(message.error.code), effectUncertain: false,
      }));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method !== "string") return;
    for (const listener of this.listeners.get(message.method) ?? []) {
      try { listener(message.params ?? {}, typeof message.sessionId === "string" ? message.sessionId : undefined); } catch { /* event observers are isolated */ }
    }
  }

  private onClose(reason = new Error("CDP connection closed.")): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(reason, true);
    for (const listener of this.listeners.get("CDP.connectionClosed") ?? []) {
      try { listener({ reason: reason.message }); } catch { /* observer isolation */ }
    }
  }

  private rejectPending(reason: Error, effectUncertain = false): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(effectUncertain
        ? new CdpCommandError(reason.message, { method: pending.method, effectUncertain: true })
        : reason);
    }
    this.pending.clear();
  }
}
