import assert from "node:assert/strict";
import { correlateHostStreamEvidence } from "./lib/mcp-stream-correlation.mjs";

const report = correlateHostStreamEvidence({
  har: {
    log: {
      entries: [{
        startedDateTime: "2026-09-30T18:00:00.000Z",
        time: 2500,
        request: {
          url: "https://chatgpt.example/backend-api/conversation",
          headers: [],
        },
        response: { status: 0, bodySize: -1, headers: [{ name: "cf-ray", value: "ray-abc" }] },
        _error: "net::ERR_HTTP2_PROTOCOL_ERROR",
      }],
    },
  },
  kontrolRecords: [{
    operationId: "operation-1",
    externalCorrelationId: "ray-abc",
    startedAt: "2026-09-30T17:59:59.000Z",
    finishedAt: "2026-09-30T18:00:01.000Z",
    rpcMethod: "tools/call",
    toolName: "read",
    httpStatus: 200,
    responseBytes: 400,
    responseCloseClassification: "response_finished",
    handlerStillRunning: false,
  }],
});
assert.equal(report.matchedHostRequests, 1);
assert.equal(report.observations[0]?.correlationKind, "exact_external_id");
assert.equal(report.observations[0]?.browserOutcome, "browser_network_error");
assert.equal(report.observations[0]?.interpretation, "mcp_completion_temporally_near_host_request_causation_unproven");
assert.match(report.limitations.join(" "), /does not expose all ChatGPT server-to-tool dispatch/);

const noMcpActivity = correlateHostStreamEvidence({
  har: { log: { entries: [{ startedDateTime: "2026-09-30T18:00:00.000Z", request: { url: "https://chatgpt.example/backend-api/conversation" }, response: { status: 0 }, _error: "closed" }] } },
});
assert.equal(noMcpActivity.observations[0]?.interpretation, "no_mcp_operation_observed_within_correlation_window");

console.log("analyze-mcp-stream-failure.test.mjs: correlation tests passed");
