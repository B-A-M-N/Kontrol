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

// The map is keyed by a per-session McpServer instance. A strong map here
// would pin the entire server — and with it every registered tool's zod
// schema universe — for the process lifetime, which is a multi-megabyte leak
// per MCP session. Weak-keyed storage lets a closed session's server be
// collected; the metrics it observed are summarized into the cumulative
// totals below before that happens.
const metricsByServer = new WeakMap<McpServer, ToolListCacheMetrics>();
const cumulativeMetrics: ToolListCacheMetrics = { hits: 0, misses: 0 };

function metricsFor(server: McpServer): ToolListCacheMetrics {
  let m = metricsByServer.get(server);
  if (!m) {
    m = { hits: 0, misses: 0 };
    metricsByServer.set(server, m);
  }
  return m;
}

/** Fold one instance's counters into the cumulative totals. */
function foldMetrics(metrics: ToolListCacheMetrics, event?: "hit" | "miss"): void {
  if (event === "hit") cumulativeMetrics.hits += 1;
  if (event === "miss") cumulativeMetrics.misses += 1;
  if (metrics.unavailableReason && !cumulativeMetrics.unavailableReason) {
    cumulativeMetrics.unavailableReason = metrics.unavailableReason;
  }
}

/** Diagnostics view of cache health, including any unavailability reason. */
export function toolListCacheDiagnostics(): Array<{ metrics: ToolListCacheMetrics }> {
  // A WeakMap cannot be iterated, so per-instance counters are folded into
  // the cumulative totals at their mutation sites (see foldMetrics callers).
  // A collected server therefore never takes counts with it: every hit,
  // miss, and unavailability reason is folded the moment it is observed.
  const total: ToolListCacheMetrics = {
    hits: cumulativeMetrics.hits,
    misses: cumulativeMetrics.misses,
    ...(cumulativeMetrics.unavailableReason ? { unavailableReason: cumulativeMetrics.unavailableReason } : {}),
  };
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
    foldMetrics(metrics);
    return false;
  }
  const original = protocol._requestHandlers.get("tools/list");
  if (!original) {
    metrics.unavailableReason = "no tools/list handler registered before cache install";
    foldMetrics(metrics);
    return false;
  }

  protocol.setRequestHandler(listToolsSchema, async (request, extra) => {
    let cached = cache.get(cacheKey);
    if (!cached) {
      metrics.misses++;
      foldMetrics(metrics, "miss");
      // Do not retain a transient failure as the descriptor forever. The
      // identity check prevents a late rejection from deleting a newer retry.
      const pending = Promise.resolve(original(request, extra));
      cached = pending.catch((error) => {
        if (cache.get(cacheKey) === cached) cache.delete(cacheKey);
        throw error;
      });
      cache.set(cacheKey, cached);
    } else {
      metrics.hits++;
      foldMetrics(metrics, "hit");
    }
    return await cached;
  });
  return true;
}
