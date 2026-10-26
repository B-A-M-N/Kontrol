import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ZodType } from "zod/v4";
import {
  installCachedToolList,
  observeToolListDescriptors,
  toolListCacheDiagnostics,
  toolListDescriptorCacheKey,
} from "./mcp-tool-list-cache.js";
import {
  evaluateToolCatalogAcknowledgement,
  fingerprintToolCatalog,
} from "./mcp/tool-catalog-handshake.js";

function fakeServer(original: (...args: any[]) => Promise<unknown>) {
  const handlers = new Map<ZodType, (...args: any[]) => Promise<unknown>>();
  const protocol = {
    setRequestHandler(schema: ZodType, handler: (...args: any[]) => Promise<unknown>) {
      handlers.set(schema, handler);
    },
  };
  return {
    server: protocol,
    handlers,
    registerToolsList(schema: ZodType) {
      protocol.setRequestHandler(schema, original);
    },
  } as unknown as McpServer & {
    handlers: typeof handlers;
    registerToolsList(schema: ZodType): void;
  };
}

const before = toolListCacheDiagnostics()[0]?.metrics ?? { hits: 0, misses: 0 };
let calls = 0;
const server = fakeServer(async () => ({ calls: ++calls }));
const cache = new Map<string, Promise<unknown>>();
const listToolsSchema = {} as ZodType;
const installation = installCachedToolList(server, "descriptor-a", cache, listToolsSchema);
server.registerToolsList(listToolsSchema);
assert.equal(installation.finalizeRegistration(), true);
const handler = (server as any).handlers.get(listToolsSchema);
assert.deepEqual(await handler({}, {}), { calls: 1 });
assert.deepEqual(await handler({}, {}), { calls: 1 });
const after = toolListCacheDiagnostics()[0]?.metrics;
assert.equal((after?.misses ?? 0) - before.misses, 1, "one cache miss is counted once");
assert.equal((after?.hits ?? 0) - before.hits, 1, "one cache hit is counted once");
assert.notEqual(
  toolListDescriptorCacheKey("profile-with-scheduled-jobs", "owner"),
  toolListDescriptorCacheKey("profile-without-scheduled-jobs", "owner"),
  "different effective registration profiles cannot share descriptors",
);
assert.notEqual(
  toolListDescriptorCacheKey("same-registration", "peer:inspect"),
  toolListDescriptorCacheKey("same-registration", "peer:inspect,job:claim"),
  "different restricted visibility profiles receive distinct cache identities",
);

const boundedCache = new Map<string, Promise<unknown>>();
for (const cacheKey of ["profile-a", "profile-b", "profile-c"]) {
  const boundedServer = fakeServer(async () => ({ cacheKey }));
  const boundedInstall = installCachedToolList(boundedServer, cacheKey, boundedCache, listToolsSchema, 2);
  boundedServer.registerToolsList(listToolsSchema);
  assert.equal(boundedInstall.finalizeRegistration(), true);
  await (boundedServer as any).handlers.get(listToolsSchema)({}, {});
}
assert.deepEqual([...boundedCache.keys()], ["profile-b", "profile-c"], "descriptor cache evicts oldest profiles at its configured bound");

let attempt = 0;
const retryServer = fakeServer(async () => {
  attempt += 1;
  if (attempt === 1) throw new Error("transient tools/list failure");
  return { ok: true };
});
const retryCache = new Map<string, Promise<unknown>>();
const retryInstallation = installCachedToolList(retryServer, "descriptor-b", retryCache, listToolsSchema);
retryServer.registerToolsList(listToolsSchema);
assert.equal(retryInstallation.finalizeRegistration(), true);
const retryHandler = (retryServer as any).handlers.get(listToolsSchema);
await assert.rejects(() => retryHandler({}, {}), /transient tools\/list failure/);
assert.equal(retryCache.has("descriptor-b"), false, "rejected descriptor promises are evicted");
assert.deepEqual(await retryHandler({}, {}), { ok: true });
assert.equal(attempt, 2, "a rejected tools/list call can be retried");

// The cache installer deliberately misses the registration schema, while the
// independent catalog observer still sees the exact uncached response.
const uncachedDescriptor = { tools: [{ name: "read", inputSchema: { type: "object" } }] };
const uncachedServer = fakeServer(async () => uncachedDescriptor);
let uncachedFingerprint: ReturnType<typeof fingerprintToolCatalog> | undefined;
const observation = observeToolListDescriptors(uncachedServer, listToolsSchema, (descriptor) => {
  uncachedFingerprint = fingerprintToolCatalog(descriptor);
});
const cacheInstallation = installCachedToolList(
  uncachedServer,
  "descriptor-uncached",
  new Map<string, Promise<unknown>>(),
  {} as ZodType,
);
uncachedServer.registerToolsList(listToolsSchema);
assert.equal(observation.finalizeRegistration(), true, "catalog observation must not depend on cache installation");
assert.equal(cacheInstallation.finalizeRegistration(), false, "an incompatible cache hook should remain an optimization miss");
const uncachedHandler = (uncachedServer as any).handlers.get(listToolsSchema);
assert.deepEqual(await uncachedHandler({}, {}), uncachedDescriptor,
  "tools/list continues working through the uncached handler");
assert.deepEqual(uncachedFingerprint, fingerprintToolCatalog(uncachedDescriptor),
  "the uncached descriptor still populates the acknowledgement fingerprint authority");
assert.deepEqual(evaluateToolCatalogAcknowledgement({
  expected: uncachedFingerprint,
  received: {
    serverVersion: "1.0.0+uncached",
    hostCatalogSha256: uncachedFingerprint!.sha256,
    hostToolCount: uncachedFingerprint!.toolCount,
  },
  authoritativeServerVersion: "1.0.0+uncached",
  clientSupportsExtension: true,
}), { status: "accepted" }, "an exact acknowledgement succeeds when tools/list was served uncached");
assert.equal(evaluateToolCatalogAcknowledgement({
  expected: uncachedFingerprint,
  received: {
    serverVersion: "1.0.0+uncached",
    hostCatalogSha256: "0".repeat(64),
    hostToolCount: uncachedFingerprint!.toolCount,
  },
  authoritativeServerVersion: "1.0.0+uncached",
  clientSupportsExtension: true,
}).reason, "host_catalog_fingerprint_mismatch", "incorrect uncached-path acknowledgements still fail closed");

// If the observation hook itself cannot identify the tools/list registration,
// serving remains available but catalog verification is visibly unavailable.
const unsupportedServer = fakeServer(async () => uncachedDescriptor);
const unsupportedObservation = observeToolListDescriptors(unsupportedServer, listToolsSchema, () => {});
const changedSdkListSchema = {} as ZodType;
unsupportedServer.registerToolsList(changedSdkListSchema);
assert.equal(unsupportedObservation.finalizeRegistration(), false);
assert.deepEqual(await (unsupportedServer as any).handlers.get(changedSdkListSchema)({}, {}), uncachedDescriptor);
const unsupportedMetrics = toolListCacheDiagnostics()[0]?.metrics;
assert.match(unsupportedMetrics?.fingerprintObservationUnavailableReason ?? "", /catalog verification is unavailable/);

console.log("mcp-tool-list-cache.test.ts: all assertions passed");
