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
    startupReconciliation,
    maintenance,
  } = deps;
  let closed = false;
  let draining: Promise<void> | undefined;
  const { recordMcpSessionEnd } = sessionLifecycle;
  const closeTransport = async (transport: Transport): Promise<void> => {
    try {
      await Promise.race([
        Promise.resolve(transport.close()),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch {
      // A transport that rejects during drain is already unusable; continue
      // closing the rest of the generation.
    }
  };
  const finalizeClose = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    startupReconciliation.stop();
    maintenance.stop();
    // P0 #4: Drain in-flight filesystem capture transactions before exit. A
    // graceful stop finishes active publishes and clears their staging; a hard
    // kill is covered by the durable transaction journal on next startup.
    await deps.reviewCheckpoints.drain().catch(() => undefined);
    deps.dispatcher?.stop();
    deps.supervisorRuntime?.stop();
    deps.supervisorRuns.close();
    mcpAdmission.close();
    mcpWaiterAdmission.close();
    clearInterval(sessionLifecycle.reaper);
    clearInterval(sessionLifecycle.memorySampler);
    clearInterval(deps.mcpSessionChurnTimer);
    const shutdownAt = Date.now();
    for (const state of mcpSessions.values()) {
      state.closing = true;
      recordMcpSessionEnd(state, "server_shutdown", shutdownAt);
    }
    await Promise.all([...transports.values()].map(closeTransport));
    transports.clear();
    mcpSessions.clear();
    await deps.shutdownMissionVerifiers();
    deps.eventStore.close();
    deps.continuationManager.close();
    deps.dispatchOutbox.close();
    await deps.processSessions.shutdown();
    await deps.agentRegistry.drain?.();
    deps.oauthProvider?.close();
    deps.workspaceStore.close?.();
    deps.workSessions?.close?.();
    deps.agentRegistry.close();
    await deps.integrity.stop();
    try { deps.db.close(); } catch { /* ignore */ }
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
        const activeTransports = [...transports.values()];
        for (const state of mcpSessions.values()) state.closing = true;
        await Promise.all(activeTransports.map(closeTransport));
        await finalizeClose();
      })();
      return draining;
    },
  };
}
