/**
 * P1 #42: compatibility adapter for the tools/list descriptor cache.
 *
 * This optimization reaches into MCP SDK internals (`_requestHandlers`) to
 * memoize the tool-list descriptor. That is fragile across SDK upgrades, so
 * ALL internal access is funnelled through this one module, which:
 *   1. runtime-checks the expected SDK shape before touching anything,
 *   2. falls back cleanly to uncached behavior when the shape changes,
 *   3. records why caching is unavailable for diagnostics.
 *
 * If the SDK internals change, the only failure mode is losing the cache —
 * never breaking tools/list.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodType } from "zod/v4";

type InternalRequestHandler = (request: unknown, extra: unknown) => Promise<unknown> | unknown;

export interface ToolListCacheMetrics {
  hits: number;
  misses: number;
  unavailableReason?: string;
}

const metricsByServer = new Map<McpServer, ToolListCacheMetrics>();

function metricsFor(server: McpServer): ToolListCacheMetrics {
  let m = metricsByServer.get(server);
  if (!m) {
    m = { hits: 0, misses: 0 };
    metricsByServer.set(server, m);
  }
  return m;
}

/** Diagnostics view of cache health, including any unavailability reason. */
export function toolListCacheDiagnostics(): Array<{ metrics: ToolListCacheMetrics }> {
  // Aggregate across per-server instances: a fresh MCP session installs a new
  // cached handler, but the descriptor cache itself is shared, so hits/misses
  // are meaningful only summed across instances.
  const total: ToolListCacheMetrics = { hits: 0, misses: 0 };
  for (const m of metricsByServer.values()) {
    total.hits += m.hits;
    total.misses += m.misses;
    if (!total.unavailableReason && m.unavailableReason) total.unavailableReason = m.unavailableReason;
  }
  return [{ metrics: total }];
}

/**
 * Install the descriptor cache. Returns true when caching is active; false
 * when the SDK's internal shape did not match expectations (uncached path
 * remains fully functional).
 */
export function installCachedToolList(
  server: McpServer,
  cacheKey: string,
  cache: Map<string, Promise<unknown>>,
  listToolsSchema: ZodType,
): boolean {
  const metrics = metricsFor(server);
  // Runtime shape check against the exact internals we depend on.
  const protocol = server.server as unknown as {
    _requestHandlers?: Map<string, InternalRequestHandler>;
    setRequestHandler?: (schema: ZodType, handler: InternalRequestHandler) => void;
  };
  if (!protocol || typeof protocol.setRequestHandler !== "function" || !(protocol._requestHandlers instanceof Map)) {
    metrics.unavailableReason = "SDK internals changed: _requestHandlers/setRequestHandler not found";
    return false;
  }
  const original = protocol._requestHandlers.get("tools/list");
  if (!original) {
    metrics.unavailableReason = "no tools/list handler registered before cache install";
    return false;
  }

  protocol.setRequestHandler(listToolsSchema, async (request, extra) => {
    let cached = cache.get(cacheKey);
    if (!cached) {
      metrics.misses++;
      cached = Promise.resolve(original(request, extra));
      cache.set(cacheKey, cached);
    } else metrics.hits++;
    return await cached;
  });
  return true;
}
