import assert from "node:assert/strict";
import { boundInspectionContent, contentText, MAX_INSPECTION_RESULT_BYTES, textBlock } from "./mcp/tool-result.js";
import { processToolResponse } from "./mcp/process-tool-response.js";

const hugeText = "😀important-row\n".repeat(20_000);
const bounded = boundInspectionContent([textBlock(hugeText)], { offset: 10 });
assert.equal(bounded.truncated, true);
assert.ok(bounded.bytes <= MAX_INSPECTION_RESULT_BYTES, "inspection text stays within the byte budget");
assert.ok(contentText(bounded.content).includes("Continue with offset="), "byte truncation gives a continuation instruction");

const originalOutput = "x".repeat(100_000);
const result = processToolResponse("bash", "workspace-wire-test", {
  sessionId: "process-wire-test",
  command: "printf output",
  output: originalOutput,
  outputTruncated: false,
  running: false,
  exitCode: 0,
  wallTimeMs: 1,
  outputCursor: originalOutput.length,
  oldestAvailableCursor: 0,
  startedAtEpochMs: 1,
}, {});
assert.equal("payload" in result._meta.card, false, "ordinary result cards do not duplicate content into _meta");
assert.equal(contentText(result.content), result.structuredContent.result, "plain MCP and structured result content remain equivalent");
const wireBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
const amplification = wireBytes / Buffer.byteLength(originalOutput, "utf8");
assert.ok(amplification <= 2.2, `a large tool result stays below the 2.2x wire amplification budget (observed ${amplification.toFixed(2)}x)`);

console.log("mcp-inspection-output.test.ts: bounded output and wire amplification assertions passed");
