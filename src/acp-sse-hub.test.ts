import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { makeSseHub } from "./acp/http/sse-hub.js";

class ResponseDouble extends EventEmitter {
  writableFinished = false;
  writableEnded = false;
  destroyed = false;
  writableLength = 0;
  chunks: string[] = [];
  write(value: string): boolean { this.chunks.push(value); return true; }
  end(): void { this.writableEnded = true; this.writableFinished = true; this.emit("finish"); }
}

const ctx = { sseClients: new Map<string, Set<ResponseDouble>>(), sseHistory: new Map<string, Array<{ id: string; event: string; data: unknown }>>() } as any;
const hub = makeSseHub(ctx);
const req = new EventEmitter();
const res = new ResponseDouble();
hub.sseSubscribe("run-1", req as never, res as never);
req.emit("finish"); // request completion is not response completion
hub.emitSse("run-1", "run.started", { runId: "run-1" });
assert.equal(ctx.sseClients.get("run-1")?.size, 1, "request completion must not remove an active SSE subscriber");
hub.emitSse("run-1", "run.progress", { runId: "run-1" });
assert.equal(res.chunks.length, 2, "active response receives multiple events");
const firstId = res.chunks[0].match(/^id: (.+)$/m)?.[1];
res.emit("close");
const replayResponse = new ResponseDouble();
hub.sseSubscribe("run-1", new EventEmitter() as never, replayResponse as never, firstId);
assert.match(replayResponse.chunks.join(""), /run.progress/, "cursor reconnect replays events after the supplied event id");
replayResponse.emit("close");
res.emit("close");
assert.equal(ctx.sseClients.get("run-1"), undefined, "response close removes the subscriber exactly once");

const reqAborted = new EventEmitter();
const resAborted = new ResponseDouble();
hub.sseSubscribe("run-2", reqAborted as never, resAborted as never);
reqAborted.emit("aborted");
assert.equal(ctx.sseClients.get("run-2")?.size, 1, "request abort does not remove an independently open response stream");
resAborted.emit("close");
assert.equal(ctx.sseClients.get("run-2"), undefined, "response close remains the authoritative removal");
console.log("acp-sse-hub.test.ts: all assertions passed");
