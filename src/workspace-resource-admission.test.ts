// P0 regression: Workspace App resource reads must be bounded by the dedicated
// resource admission pool, must never leak permits on response finish/close or
// client abort, and capacity must return to zero after load. Uses a stubbed
// express Response so no HTTP server is needed.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { gunzipSync } from "node:zlib";
import { createWorkspaceAppResourceServer } from "./server/workspace-resource-route.js";
import { McpAdmission } from "./server/mcp-admission.js";
import { WORKSPACE_APP_URI } from "./workspace-app-resource.js";
import type { ServerConfig } from "./config.js";
import type { Response } from "express";

function stubConfig(): ServerConfig {
  return {
    logging: { level: "error", format: "text", file: undefined },
    // The queue deadline must comfortably exceed the synchronous cost of
    // stringifying + gzipping the ~10 MB artifact inside the first admitted
    // serve: that work blocks the event loop, and a short deadline would time
    // out queued waiters before the test can observe them waiting.
    mcpAdmissionTimeoutMs: 10_000,
  } as unknown as ServerConfig;
}

class StubResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableFinished = false;
  body: unknown;
  /** When true, json() defers completion until release() is called, so the
   * in-flight admission window can be observed deterministically. */
  holdOpen = false;
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  headers: Record<string, string> = {};
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }
  json(value: unknown): void {
    this.headersSent = true;
    this.body = value;
    if (this.holdOpen) return;
    this.complete();
  }
  /** Completes a held-open response that has already been served. */
  release(): void {
    if (!this.holdOpen || this.writableFinished || this.body === null || this.body === undefined) return;
    this.complete();
  }
  /** Whether this response has been served but not yet released. */
  get needsRelease(): boolean {
    return this.holdOpen && !this.writableFinished && this.body !== undefined && this.body !== null;
  }
  private complete(): void {
    this.writableFinished = true;
    this.emit("finish");
  }
  end(value?: unknown): void {
    if (value !== undefined && this.body === undefined) this.body = value;
    if (this.holdOpen) return;
    this.writableFinished = true;
    this.emit("finish");
  }
}

function resourceBody(id: number) {
  return { id, params: { uri: WORKSPACE_APP_URI } };
}

async function drain(queue: number = 0): Promise<void> {
  for (let i = 0; i <= queue; i++) await new Promise((r) => setImmediate(r));
}

async function main() {
  const config = stubConfig();
  const metrics = {
    currentHashed: 0, openAiCompatibility: 0, legacyKontrol: 0, devDesktopMigration: 0,
    servedTotal: 0, lastDurationMs: 0, maxDurationMs: 0,
    admissionRejections: 0, active: 0, maxActive: 0, lastWireBytes: 0,
  };
  // Deliberately tiny: 2 concurrent, 1 per client, queue 4.
  const pool = new McpAdmission(2, 1, 4);
  const { serve } = createWorkspaceAppResourceServer(config, metrics, pool);

  // 1. Single read: served, permit released on finish.
  {
    const res = new StubResponse();
    const served = await serve(res as unknown as Response, "r1", resourceBody(1), false, "client-a", undefined);
    assert.ok(served);
    await drain();
    assert.equal(metrics.servedTotal, 1);
    assert.equal(metrics.active, 0, "permit must be released on finish");
    assert.equal(pool.getStats().active, 0);
  }

  // 2. Concurrency bound: 8 distinct clients race with held-open responses;
  //    at most 2 in flight, queue holds 4, remaining 2 rejected. Capacity
  //    returns to zero after release.
  {
    metrics.admissionRejections = 0;
    const responses: StubResponse[] = [];
    const pending = [];
    for (let i = 0; i < 8; i++) {
      const res = new StubResponse();
      res.holdOpen = true;
      responses.push(res);
      pending.push(serve(res as unknown as Response, `r-${i}`, resourceBody(i), false, `client-${i}`, undefined));
    }
    // While queued: active must be within the cap.
    await drain(4);
    const statsMid = pool.getStats();
    assert.ok(statsMid.active <= 2, `active ${statsMid.active} exceeded cap 2`);
    assert.ok(statsMid.active + statsMid.queued >= 6, "requests must be admitted or queued, not dropped silently");
    assert.ok(metrics.maxActive <= 2, `observed maxActive ${metrics.maxActive} must respect the cap`);
    for (const res of responses) res.release();
    await Promise.all(pending);
    // Released permits admit queued waiters, which also hold open; keep
    // releasing until every response has finished.
    for (let round = 0; round < 32; round++) {
      await drain();
      if (pool.getStats().active === 0 && pool.getStats().queued === 0) break;
      for (const res of responses.filter((r) => r.needsRelease)) res.release();
    }
    await Promise.all(pending);
    await drain(4);
    const servedCount = responses.filter((r) => r.statusCode === 200).length;
    const rejectedCount = responses.filter((r) => r.statusCode === 503).length;
    assert.equal(servedCount + rejectedCount, 8, "every request must receive exactly one answer");
    assert.ok(servedCount >= 2, "at least the concurrent cap must be served");
    assert.equal(metrics.admissionRejections, rejectedCount, "rejections must be counted");
    await drain();
    assert.equal(pool.getStats().active, 0, "capacity must return to zero after load");
    assert.equal(pool.getStats().queued, 0, "queue must drain to zero");
    assert.equal(metrics.active, 0);
  }

  // 3. Per-client cap: a single client cannot hold two permits at once.
  {
    const resA = new StubResponse();
    const resB = new StubResponse();
    const first = serve(resA as unknown as Response, "pa", resourceBody(1), false, "solo-client", undefined);
    const second = serve(resB as unknown as Response, "pb", resourceBody(2), false, "solo-client", undefined);
    await drain(2);
    // resB (per-client cap exceeded, queue large enough) waits for resA.
    assert.equal(resA.writableFinished, true, "first request served");
    assert.ok(!(resB as StubResponse).needsRelease, "second concurrent request from one client must wait");
    await second;
    assert.ok((resB as unknown as StubResponse).body !== undefined, "second request served after release");
    assert.equal(pool.getStats().active, 0);
  }

  // 4. Abort cleanup: a client disconnecting mid-serialization releases the
  //    permit without a finish event.
  {
    const controller = new AbortController();
    const res = new StubResponse();
    res.holdOpen = true;
    const pending = serve(res as unknown as Response, "abort-1", resourceBody(1), false, "client-abort", controller.signal);
    await drain();
    assert.equal(pool.getStats().active, 1, "permit held while serialization pending");
    controller.abort();
    await drain();
    assert.equal(pool.getStats().active, 0, "abort must release the permit");
    await pending;
  }

  // 5. Close cleanup: response 'close' without 'finish' (dropped socket)
  //    releases the permit exactly once.
  {
    const res = new StubResponse();
    res.holdOpen = true;
    const pending = serve(res as unknown as Response, "close-1", resourceBody(1), false, "client-close", undefined);
    await drain();
    assert.equal(pool.getStats().active, 1);
    res.emit("close");
    await drain();
    res.emit("close"); // duplicate close must be idempotent
    await drain();
    assert.equal(pool.getStats().active, 0, "close must release the permit exactly once");
    await pending;
  }

  // 6. Non-workspace URIs are not intercepted.
  {
    const res = new StubResponse();
    const served = await serve(res as unknown as Response, "x", { id: 9, params: { uri: "file:///etc/passwd" } }, false, "client-x", undefined);
    assert.equal(served, false, "non-workspace URIs must not be handled by this route");
    assert.equal(res.writableFinished, false);
  }

  // 7. Wire delivery: an Accept-Encoding: gzip client receives the gzipped
  //    envelope, and lastWireBytes records the ACTUAL transferred size — not
  //    the raw ~10 MB serialization that res.json() used to ship.
  {
    const gzipRes = new StubResponse();
    const identityRes = new StubResponse();
    const servedGzip = await serve(gzipRes as unknown as Response, "gz", resourceBody(1), false, "client-gzip", undefined, "gzip, deflate, br");
    assert.ok(servedGzip);
    const servedIdentity = await serve(identityRes as unknown as Response, "id", resourceBody(2), false, "client-identity", undefined);
    assert.ok(servedIdentity);
    await drain();

    assert.equal(gzipRes.getHeader("content-encoding"), "gzip", "gzip-capable client must receive encoded content");
    assert.equal(gzipRes.getHeader("vary"), "accept-encoding");
    assert.equal(identityRes.getHeader("content-encoding"), undefined, "identity client must not receive encoded content");

    const gzipBytes = gzipRes.headers["content-length"];
    const identityBytes = identityRes.headers["content-length"];
    assert.ok(gzipBytes && identityBytes, "both responses must declare content-length");
    assert.ok(Number(gzipBytes) < Number(identityBytes), `wire gzip size ${gzipBytes} must be smaller than raw ${identityBytes}`);
    assert.equal(metrics.lastWireBytes, Number(identityBytes), "lastWireBytes must track the most recent wire transfer");
    assert.ok(Number(gzipBytes) < 2_500_000, `gzipped wire size ${gzipBytes} should stay near the ~1.8 MiB envelope, not the raw artifact`);
    assert.equal(pool.getStats().active, 0, "permits released after both transfers");

    // Regression: each response must echo ITS OWN request id and uri. The
    // gzip envelope is compressed per request — a cached deflate stream would
    // replay the first requester's id/uri to later requests.
    const gzipParsed = JSON.parse(gunzipSync(gzipRes.body as Buffer).toString("utf8")) as {
      id: unknown;
      result: { contents: Array<{ uri: string }> };
    };
    const identityParsed = JSON.parse(String(identityRes.body)) as {
      id: unknown;
      result: { contents: Array<{ uri: string }> };
    };
    assert.equal(gzipParsed.id, 1, "gzipped envelope must carry the requesting id");
    assert.equal(gzipParsed.result.contents[0].uri, WORKSPACE_APP_URI);
    assert.equal(identityParsed.id, 2, "identity envelope must carry its own requesting id");
    assert.equal(identityParsed.result.contents[0].uri, WORKSPACE_APP_URI);
  }

  console.log("workspace-resource-admission.test.ts: resource admission bounds + permit-leak regression suite passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
