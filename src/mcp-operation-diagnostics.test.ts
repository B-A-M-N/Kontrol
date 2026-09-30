import assert from "node:assert/strict";
import { McpOperationDiagnostics } from "./server/mcp-operation-diagnostics.js";

const diagnostics = new McpOperationDiagnostics(1, 2);
diagnostics.begin({
  operationId: "operation-1",
  requestId: "request-1",
  externalCorrelationId: "ray-1",
  generationId: "generation-1",
  sessionIdPrefix: "session1",
  method: "POST",
  rpcMethod: "tools/call",
  toolName: "read",
  startedAtMs: 1_000,
  admissionClass: "execution",
});
diagnostics.begin({ operationId: "operation-overflow", method: "GET", startedAtMs: 1_000, admissionClass: "stream" });
assert.equal(diagnostics.snapshot(1_500).activeCount, 1);
assert.equal(diagnostics.snapshot(1_500).droppedActiveCount, 1);
assert.equal(diagnostics.snapshot(1_500).active[0]?.ageMs, 500);

diagnostics.finish("operation-1", {
  finishedAtMs: 1_700,
  httpStatus: 200,
  responseBytes: 42,
  responseCloseClassification: "response_finished",
  admissionWaitMs: 5,
  executionDurationMs: 100,
  handlerStillRunning: false,
  executionAdmission: { active: 0 },
  resourceAdmission: { active: 0 },
  sessionInFlight: 0,
  connectionMetrics: { inFlightRequests: 0 },
});
const snapshot = diagnostics.snapshot();
assert.equal(snapshot.activeCount, 0);
assert.equal(snapshot.recent[0]?.operationId, "operation-1");
assert.equal(snapshot.recent[0]?.responseBytes, 42);
assert.equal(snapshot.recent[0]?.externalCorrelationId, "ray-1");
assert.equal(snapshot.recent[0]?.generationId, "generation-1");
assert.equal(Object.hasOwn(snapshot.recent[0]!, "arguments"), false);

console.log("mcp-operation-diagnostics.test.ts: all assertions passed");
