/**
 * Intercept the SDK's public `setRequestHandler` registration API so catalog
 * observation and descriptor caching remain independent. The fingerprint
 * observer is mandatory for acknowledgement; the cache is optional. If the
 * registration hook is unavailable, tools/list remains uncached and
 * diagnostics explain why catalog verification is unavailable.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodType } from "zod/v4";

type InternalRequestHandler = (request: unknown, extra: unknown) => Promise<unknown> | unknown;

export interface ToolListCacheMetrics {
  hits: number;
  misses: number;
  unavailableReason?: string;
  fingerprintObservationUnavailableReason?: string;
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
  if (metrics.fingerprintObservationUnavailableReason && !cumulativeMetrics.fingerprintObservationUnavailableReason) {
    cumulativeMetrics.fingerprintObservationUnavailableReason = metrics.fingerprintObservationUnavailableReason;
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
    ...(cumulativeMetrics.fingerprintObservationUnavailableReason
      ? { fingerprintObservationUnavailableReason: cumulativeMetrics.fingerprintObservationUnavailableReason }
      : {}),
  };
  return [{ metrics: total }];
}

function registrationInterceptor(
  server: McpServer,
  listToolsSchema: ZodType,
  wrap: (handler: InternalRequestHandler) => InternalRequestHandler,
  onUnavailable: (metrics: ToolListCacheMetrics) => void,
): { finalizeRegistration(): boolean } {
  const metrics = metricsFor(server);
  const protocol = server.server as unknown as {
    setRequestHandler?: (schema: ZodType, handler: InternalRequestHandler) => void;
  };
  if (!protocol || typeof protocol.setRequestHandler !== "function") {
    onUnavailable(metrics);
    foldMetrics(metrics);
    return { finalizeRegistration: () => false };
  }
  const originalSetRequestHandler = protocol.setRequestHandler.bind(protocol);
  let listHandlerObserved = false;
  protocol.setRequestHandler = (schema, originalHandler) => {
    if (schema !== listToolsSchema) {
      originalSetRequestHandler(schema, originalHandler);
      return;
    }
    listHandlerObserved = true;
    originalSetRequestHandler(schema, wrap(originalHandler));
  };
  return {
    finalizeRegistration() {
      if (!listHandlerObserved) {
        onUnavailable(metrics);
        foldMetrics(metrics);
      }
      return listHandlerObserved;
    },
  };
}

/**
 * Observe the exact tools/list response emitted by the SDK. Install this
 * before registering tools. It is independent of the descriptor cache so
 * cache failure cannot make catalog acknowledgement unavailable.
 */
export function observeToolListDescriptors(
  server: McpServer,
  listToolsSchema: ZodType,
  onDescriptor: (descriptor: unknown) => void,
): { finalizeRegistration(): boolean } {
  return registrationInterceptor(server, listToolsSchema, (handler) => async (request, extra) => {
    const descriptor = await handler(request, extra);
    onDescriptor(descriptor);
    return descriptor;
  }, (metrics) => {
    metrics.fingerprintObservationUnavailableReason = "SDK tools/list registration hook was not observed; catalog verification is unavailable";
  });
}

/**
 * Install the optional descriptor cache using the SDK's public handler
 * registration API. Cache failure leaves the list handler untouched.
 */
export function installCachedToolList(
  server: McpServer,
  cacheKey: string,
  cache: Map<string, Promise<unknown>>,
  listToolsSchema: ZodType,
): { finalizeRegistration(): boolean } {
  return registrationInterceptor(server, listToolsSchema, (originalHandler) => async (request, extra) => {
    const metrics = metricsFor(server);
    let cached = cache.get(cacheKey);
    if (!cached) {
      metrics.misses++;
      foldMetrics(metrics, "miss");
      // Do not retain a transient failure as the descriptor forever. The
      // identity check prevents a late rejection from deleting a newer retry.
      const pending = Promise.resolve(originalHandler(request, extra));
      cached = pending.catch((error) => {
        if (cache.get(cacheKey) === cached) cache.delete(cacheKey);
        throw error;
      });
      cache.set(cacheKey, cached);
    } else {
      metrics.hits++;
      foldMetrics(metrics, "hit");
    }
    return cached;
  }, (metrics) => {
    metrics.unavailableReason = "SDK tools/list registration hook was not observed; descriptor caching is disabled";
  });
}

/**
 * Filter the tools/list descriptor for a restricted registration profile (e.g.
 * a peer capability profile). Installed like the cache/observer wrappers; the
 * filter applies AFTER descriptor retrieval so cached descriptors stay
 * profile-independent while each response exposes only permitted tools.
 */
export function installToolListFilter(
  server: McpServer,
  listToolsSchema: ZodType,
  isVisible: (toolName: string) => boolean,
): { finalizeRegistration(): boolean } {
  return registrationInterceptor(server, listToolsSchema, (handler) => async (request, extra) => {
    const descriptor = (await handler(request, extra)) as { tools?: Array<{ name?: unknown }> } | undefined;
    if (descriptor && Array.isArray(descriptor.tools)) {
      descriptor.tools = descriptor.tools.filter((tool) =>
        typeof tool?.name === "string" && isVisible(tool.name));
    }
    return descriptor;
  }, (metrics) => {
    metrics.unavailableReason = "SDK tools/list registration hook was not observed; peer tool filtering is unavailable";
  });
}
