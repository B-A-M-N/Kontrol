/**
 * Server shutdown orchestration: per-transport close with deadline, the
 * single finalizeClose drain of every subsystem, and the soft drain that
 * rejects new admission before closing live transports. Extracted verbatim
 * from src/server.ts (P1.2); the createServer closures become an explicit
 * dependency object.
 */
import type { Transport } from "../mcp/workspace-server.js";
import type { McpSessionState, RunningServer } from "./mcp-session-state.js";
import type { McpAdmission } from "./mcp-admission.js";
import type { McpSessionLifecycle } from "./mcp-session-lifecycle.js";
import type { DatabaseHandle } from "../db/client.js";
import type { ServerConfig } from "../config.js";

export interface ShutdownDeps {
  readonly config: ServerConfig;
  readonly db: DatabaseHandle;
  readonly transports: Map<string, Transport>;
  readonly mcpSessions: Map<string, McpSessionState>;
  readonly sessionLifecycle: McpSessionLifecycle;
  readonly mcpAdmission: McpAdmission;
  readonly mcpWaiterAdmission: McpAdmission;
  readonly mcpResourceAdmission: McpAdmission;
  readonly startupReconciliation: { stop(): void };
  readonly maintenance: { stop(): void };
  readonly reviewCheckpoints: { drain(): Promise<unknown> };
  readonly dispatcher: { stop(): void } | undefined;
  readonly supervisorRuntime: { stop(): void } | undefined;
  readonly supervisorRuns: { close(): void };
  readonly mcpSessionChurnTimer: ReturnType<typeof setInterval>;
  readonly shuttingDown: { value: boolean };
  readonly oauthProvider: { close(): void } | null;
  readonly workspaceStore: { close?(): void };
  readonly workSessions: { close?(): void };
  readonly agentRegistry: { drain?(): Promise<unknown>; close(): void };
  readonly eventStore: { close(): void };
  readonly continuationManager: { close(): void };
  readonly dispatchOutbox: { close(): void };
  readonly processSessions: { shutdown(): Promise<unknown> };
  readonly shutdownMissionVerifiers: () => Promise<unknown>;
  readonly integrity: { stop(): Promise<unknown> };
}

/**
 * The returned object satisfies the createServer return contract: `close`
 * finalizes every subsystem; `drain` first rejects new MCP admission so long
 * polls wake before the Node HTTP server waits on connection closure.
 */
export function createShutdownController(deps: ShutdownDeps): Pick<RunningServer, "close" | "drain"> {
  const {
    transports,
    mcpSessions,
    sessionLifecycle,
    mcpAdmission,
    mcpWaiterAdmission,
    mcpResourceAdmission,
    startupReconciliation,
    maintenance,
  } = deps;
  let closed = false;
  let draining: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const { recordMcpSessionEnd } = sessionLifecycle;
  const closeTransport = async (transport: Transport): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => transport.close()),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); }),
      ]);
    } catch {
      // A transport that rejects during drain is already unusable; continue
      // closing the rest of the generation.
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const finalizeClose = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const errors: Array<{ phase: string; error: unknown }> = [];
      const phase = async (name: string, action: () => unknown, timeoutMs = 5_000): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(action),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`${name} shutdown timed out`)), timeoutMs);
            }),
          ]);
        } catch (error) {
          errors.push({ phase: name, error });
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      await phase("startup-reconciliation", () => startupReconciliation.stop());
      await phase("maintenance", () => maintenance.stop());
      // P0 #4: Drain in-flight filesystem capture transactions before exit. A
      // graceful stop finishes active publishes and clears their staging; a hard
      // kill is covered by the durable transaction journal on next startup.
      await phase("review-checkpoints", () => deps.reviewCheckpoints.drain());
      await phase("dispatcher", () => deps.dispatcher?.stop());
      await phase("supervisor-runtime", () => deps.supervisorRuntime?.stop());
      await phase("supervisor-runs", () => deps.supervisorRuns.close());
      await phase("mcp-admission", () => mcpAdmission.close());
      await phase("mcp-waiter-admission", () => mcpWaiterAdmission.close());
      await phase("mcp-resource-admission", () => mcpResourceAdmission.close());
      await phase("mcp-timers", () => {
        clearInterval(sessionLifecycle.reaper);
        clearInterval(sessionLifecycle.memorySampler);
        clearInterval(deps.mcpSessionChurnTimer);
      });
      await phase("mcp-session-records", () => {
        const shutdownAt = Date.now();
        for (const state of mcpSessions.values()) {
          try {
            state.closing = true;
            recordMcpSessionEnd(state, "server_shutdown", shutdownAt);
          } catch (error) {
            errors.push({ phase: "mcp-session-record", error });
          }
        }
      });
      await phase("mcp-transports", () => Promise.all([...transports.values()].map(closeTransport)));
      transports.clear();
      mcpSessions.clear();
      await phase("mission-verifiers", () => deps.shutdownMissionVerifiers());
      await phase("event-store", () => deps.eventStore.close());
      await phase("continuations", () => deps.continuationManager.close());
      await phase("dispatch-outbox", () => deps.dispatchOutbox.close());
      await phase("process-sessions", () => deps.processSessions.shutdown());
      await phase("agent-drain", () => deps.agentRegistry.drain?.());
      await phase("oauth-provider", () => deps.oauthProvider?.close());
      await phase("workspace-store", () => deps.workspaceStore.close?.());
      await phase("work-sessions", () => deps.workSessions?.close?.());
      await phase("agent-registry", () => deps.agentRegistry.close());
      await phase("integrity", () => deps.integrity.stop());
      await phase("database", () => deps.db.close());
      if (errors.length > 0) {
        throw new AggregateError(errors.map(({ error }) => error), `Kontrol shutdown completed with ${errors.length} failed phase(s)`);
      }
    })().finally(() => {
      closed = true;
    });
    return closePromise;
  };
  return {
    close: finalizeClose,
    drain: async () => {
      if (closed) return;
      if (draining) return draining;
      draining = (async () => {
        // Reject new MCP admission first, then close transports so long polls
        // are woken before the Node HTTP server waits for connection closure.
        deps.shuttingDown.value = true;
        mcpAdmission.close();
        mcpWaiterAdmission.close();
        mcpResourceAdmission.close();
        const activeTransports = [...transports.values()];
        for (const state of mcpSessions.values()) state.closing = true;
        await Promise.all(activeTransports.map(closeTransport));
        await finalizeClose();
      })();
      return draining;
    },
  };
}
