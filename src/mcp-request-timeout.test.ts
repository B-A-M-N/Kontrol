import assert from "node:assert/strict";
import { handleMcpRequestWithDeadline, McpExecutionTimeoutError, McpAdmission } from "./server/mcp-admission.js";
import { ExpiredMcpOperationTracker } from "./server/mcp-expired-operations.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class TimeoutResponse {
  statusCode = 200;
  ended = false;
  jsonCalls = 0;
  lateWriteAttempts = 0;
  body: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    assert.equal(this.ended, false, "the timeout response must only be written once");
    this.jsonCalls++;
    this.body = body;
    this.ended = true;
    return this;
  }

  write(_chunk: unknown): boolean {
    if (this.ended) {
      this.lateWriteAttempts++;
      const error = new Error("write after HTTP deadline response");
      error.name = "ERR_STREAM_WRITE_AFTER_END";
      throw error;
    }
    return true;
  }
}

const makeExpiredRecord = (operationId: string, toolName: string, startedAtMs: number) => ({
  operationId,
  requestId: operationId,
  sessionIdPrefix: "session1",
  rpcMethod: "tools/call",
  toolName,
  ownerHash: "0123456789abcdef",
  startedAtMs,
  expiredAtMs: Date.now(),
});

// A timed-out operation may still try to write to the already-completed HTTP
// response. The write failure is observed, tracked, and does not close the
// shared MCP transport or produce a second response.
{
  const gate = deferred();
  let closeCalls = 0;
  let settled = false;
  let timedOut = false;
  const tracker = new ExpiredMcpOperationTracker();
  const response = new TimeoutResponse();
  const startedAtMs = Date.now();
  const transport = {
    handleRequest: async (_req: unknown, target: TimeoutResponse) => {
      await gate.promise;
      target.write("late response");
    },
    close: async () => { closeCalls++; },
  } as any;
  const operationId = "late-write-1";
  const running = handleMcpRequestWithDeadline(
    transport,
    {} as any,
    response as any,
    {},
    10,
    () => { settled = true; },
    () => {
      timedOut = true;
      tracker.markExpired(makeExpiredRecord(operationId, "read", startedAtMs));
    },
    (outcome, error) => tracker.markTerminated(operationId, outcome, error),
  );
  await assert.rejects(running, (error: unknown) => error instanceof McpExecutionTimeoutError);
  response.status(504).json({ jsonrpc: "2.0", id: 1, error: { code: -32008, message: "deadline" } });
  assert.equal(response.jsonCalls, 1);
  assert.equal(timedOut, true);
  assert.equal(closeCalls, 0, "a request timeout must not close a shared MCP transport");
  assert.equal(settled, false, "timeout does not claim the late handler is finished");
  assert.equal(tracker.snapshot().activeCount, 1);
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(response.lateWriteAttempts, 1, "the late SDK write must be contained after the HTTP response ends");
  assert.equal(response.jsonCalls, 1, "late SDK work cannot send a second protocol response");
  assert.equal(settled, true, "handler completion transfers ownership after a timeout");
  const afterLateWrite = tracker.snapshot();
  assert.equal(afterLateWrite.activeCount, 0);
  assert.equal(afterLateWrite.recentTerminated[0]?.outcome, "failed");
  assert.equal(afterLateWrite.recentTerminated[0]?.errorName, "ERR_STREAM_WRITE_AFTER_END");
}

// Multiple handlers that never settle retain their execution permits. The
// expired-handler diagnostics must report the unavailable capacity accurately.
{
  const admission = new McpAdmission(2, 2, 0);
  const tracker = new ExpiredMcpOperationTracker();
  const firstRelease = deferred();
  const secondRelease = deferred();
  const firstPermit = await admission.acquire("session-a", 100, 1);
  const secondPermit = await admission.acquire("session-b", 100, 1);
  assert.ok(firstPermit && secondPermit);

  const makeOperation = (operationId: string, toolName: string, gate: ReturnType<typeof deferred>, permit: () => void) => {
    const transport = { handleRequest: async () => { await gate.promise; } } as any;
    return handleMcpRequestWithDeadline(
      transport,
      {} as any,
      {} as any,
      {},
      10,
      permit,
      () => tracker.markExpired(makeExpiredRecord(operationId, toolName, Date.now() - 20)),
      (outcome, error) => tracker.markTerminated(operationId, outcome, error),
    );
  };

  const first = makeOperation("never-1", "grep", firstRelease, firstPermit);
  const second = makeOperation("never-2", "glob", secondRelease, secondPermit);
  const outcomes = await Promise.allSettled([first, second]);
  assert.ok(outcomes.every((outcome) => outcome.status === "rejected" && outcome.reason instanceof McpExecutionTimeoutError));
  const admissionStats = admission.getStats();
  const expiredStats = tracker.snapshot();
  assert.equal(admissionStats.active, 2);
  assert.equal(admissionStats.availableWeight, 0);
  assert.equal(await admission.acquire("session-c", 0, 1), null, "new work must be rejected when timed-out handlers still own capacity");
  assert.equal(expiredStats.activeCount, 2);
  assert.equal(expiredStats.active[0]?.state, "expired_but_running");
  assert.ok(Number(expiredStats.active[0]?.expiredAgeMs) >= 0);
  assert.equal(expiredStats.active[0]?.toolName, "grep");

  firstRelease.resolve();
  secondRelease.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(admission.getStats().active, 0, "capacity is released only after the real handlers terminate");
  assert.equal(tracker.snapshot().activeCount, 0);
  assert.equal(tracker.snapshot().totalTerminated, 2);
}

console.log("mcp-request-timeout.test.ts: all assertions passed");
