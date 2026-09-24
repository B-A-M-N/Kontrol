import assert from "node:assert/strict";
import { handleMcpRequestWithDeadline, McpExecutionTimeoutError } from "./server/mcp-admission.js";

let closeCalls = 0;
let release!: () => void;
const blocked = new Promise<void>((resolve) => { release = resolve; });
const transport = {
  handleRequest: async () => { await blocked; },
  close: async () => { closeCalls += 1; },
} as any;
const req = {} as any;
const res = {} as any;
const running = handleMcpRequestWithDeadline(transport, req, res, {}, 5);
await assert.rejects(running, (error: unknown) => error instanceof McpExecutionTimeoutError);
assert.equal(closeCalls, 0, "a request timeout must not close a shared MCP transport");
release();
console.log("mcp-request-timeout.test.ts: all assertions passed");
