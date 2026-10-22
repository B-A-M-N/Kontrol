/** Owns a reconnectable upstream MCP client while leaving the downstream server alive. */
export class McpUpstreamConnection {
  #createClient;
  #onState;
  #client = null;
  #transport = null;
  #generation = 0;
  #state = "STARTING";
  #reconnectPromise = null;
  #retryTimer = null;
  #pendingDelay = null;
  #stopping = false;

  constructor({ createClient, onState = () => {}, maxAttempts = 8, baseDelayMs = 250, maxDelayMs = 15_000, recoveryWindowMs = 30_000, random = Math.random }) {
    this.#createClient = createClient;
    this.#onState = onState;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.recoveryWindowMs = recoveryWindowMs;
    this.random = random;
  }

  maxAttempts;
  baseDelayMs;
  maxDelayMs;
  recoveryWindowMs;
  random;

  #wait(ms) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#pendingDelay === finish) this.#pendingDelay = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.#pendingDelay = finish;
    });
  }

  get state() { return this.#state; }
  get generation() { return this.#generation; }

  #setState(state) {
    this.#state = state;
    this.#onState(state, this.#generation);
  }

  async start() {
    if (this.#stopping) return;
    this.#setState("STARTING");
    try {
      await this.#connectOnce();
    } catch {
      this.#setState("DEGRADED");
      void this.reconnect();
    }
  }

  async #connectOnce() {
    if (this.#stopping) throw new Error("Upstream connection is stopping");
    const generation = ++this.#generation;
    const { client, transport } = this.#createClient();
    this.#client = client;
    this.#transport = transport;
    client.onclose = () => {
      if (generation !== this.#generation || this.#stopping) return;
      this.#client = null;
      this.#transport = null;
      this.#setState("DEGRADED");
      void this.reconnect();
    };
    try {
      await client.connect(transport);
      if (generation !== this.#generation || this.#stopping) {
        try { await client.close(); } catch {}
        throw new Error("Obsolete upstream connection generation");
      }
      this.#setState("READY");
    } catch (error) {
      if (generation === this.#generation) {
        this.#client = null;
        this.#transport = null;
      }
      try { await client.close(); } catch {}
      throw error;
    }
  }

  async reconnect() {
    if (this.#stopping) return;
    if (this.#reconnectPromise) return this.#reconnectPromise;
    this.#reconnectPromise = (async () => {
      this.#setState("RECONNECTING");
      for (let attempt = 0; attempt < this.maxAttempts && !this.#stopping; attempt += 1) {
        if (attempt > 0) {
          const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** (attempt - 1)));
          await this.#wait(Math.floor(ceiling * (0.75 + this.random() * 0.5)));
          if (this.#stopping) return;
        }
        try {
          await this.#connectOnce();
          return;
        } catch {
          if (!this.#stopping) this.#setState("RECONNECTING");
        }
      }
      if (this.#stopping) return;
      this.#setState("DEGRADED");
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = null;
        void this.reconnect();
      }, this.recoveryWindowMs);
      this.#retryTimer.unref?.();
    })().finally(() => { this.#reconnectPromise = null; });
    return this.#reconnectPromise;
  }

  requireClient() {
    if (this.#state !== "READY" || !this.#client) {
      throw new Error(`Kontrol upstream is ${this.#state.toLowerCase()}; request was not sent. Retry after the bridge reconnects.`);
    }
    return this.#client;
  }

  async close() {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#setState("STOPPING");
    this.#pendingDelay?.();
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    ++this.#generation;
    const client = this.#client;
    this.#client = null;
    this.#transport = null;
    try { await client?.close(); } catch {}
    this.#setState("STOPPED");
  }
}
