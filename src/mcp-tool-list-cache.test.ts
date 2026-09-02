import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodType } from "zod/v4";
import { installCachedToolList, toolListCacheDiagnostics } from "./mcp-tool-list-cache.js";

function fakeServer(original: (...args: any[]) => Promise<unknown>) {
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>([["tools/list", original]]);
  const protocol = {
    _requestHandlers: handlers,
    setRequestHandler(_schema: ZodType, handler: (...args: any[]) => Promise<unknown>) {
      handlers.set("tools/list", handler);
    },
  };
  return { server: protocol, handlers } as unknown as McpServer & { handlers: typeof handlers };
}

const before = toolListCacheDiagnostics()[0]?.metrics ?? { hits: 0, misses: 0 };
let calls = 0;
const server = fakeServer(async () => ({ calls: ++calls }));
const cache = new Map<string, Promise<unknown>>();
assert.equal(installCachedToolList(server, "descriptor-a", cache, {} as ZodType), true);
const handler = (server as any).handlers.get("tools/list");
assert.deepEqual(await handler({}, {}), { calls: 1 });
assert.deepEqual(await handler({}, {}), { calls: 1 });
const after = toolListCacheDiagnostics()[0]?.metrics;
assert.equal((after?.misses ?? 0) - before.misses, 1, "one cache miss is counted once");
assert.equal((after?.hits ?? 0) - before.hits, 1, "one cache hit is counted once");

let attempt = 0;
const retryServer = fakeServer(async () => {
  attempt += 1;
  if (attempt === 1) throw new Error("transient tools/list failure");
  return { ok: true };
});
const retryCache = new Map<string, Promise<unknown>>();
assert.equal(installCachedToolList(retryServer, "descriptor-b", retryCache, {} as ZodType), true);
const retryHandler = (retryServer as any).handlers.get("tools/list");
await assert.rejects(() => retryHandler({}, {}), /transient tools\/list failure/);
assert.equal(retryCache.has("descriptor-b"), false, "rejected descriptor promises are evicted");
assert.deepEqual(await retryHandler({}, {}), { ok: true });
assert.equal(attempt, 2, "a rejected tools/list call can be retried");

console.log("mcp-tool-list-cache.test.ts: all assertions passed");
