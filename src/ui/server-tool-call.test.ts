import assert from "node:assert/strict";
import { AmbiguousMutationError, setServerToolHost, callServerToolChecked } from "./server-tool-call.js";
import { classifyMcpFailure } from "./mcp-failure.js";

const calls: string[] = [];
let current: { name: string; callServerTool(request: any): Promise<any> } | null = {
  name: "old",
  async callServerTool() { throw new Error("MCP error -32000: Connection closed"); },
};
setServerToolHost({
  getApp: () => current as any,
  async reconnect() {
    current = { name: "new", async callServerTool(request: any) { calls.push(request.name); return { isError: false, content: [] }; } };
  },
});
const result = await callServerToolChecked({ name: "get_workspace_session_surface", arguments: {} });
assert.equal(result.isError, false);
assert.deepEqual(calls, ["get_workspace_session_surface"], "safe retry uses the App instance created by reconnect");
console.log("server-tool-call.test.ts: all assertions passed");

assert.equal(classifyMcpFailure(new Error("Invalid arguments: workspaceId is required")), "tool_error");
assert.equal(classifyMcpFailure({ status: 403, message: "forbidden" }), "authorization_denied");
assert.equal(classifyMcpFailure(new Error("socket hang up")), "connection_reset");
assert.equal(classifyMcpFailure({ status: 404, message: "unknown MCP session" }), "session_expired");
assert.equal(classifyMcpFailure({ code: -32000, message: "Connection closed" }), "transport_closed");
assert.equal(classifyMcpFailure(new Error("response was lost after the request may have committed")), "ambiguous_completion");

let reconnects = 0;
current = { name: "stable", async callServerTool() { throw new Error("Invalid arguments: bad value"); } };
setServerToolHost({
  getApp: () => current as any,
  async reconnect() { reconnects += 1; },
});
for (let index = 0; index < 10; index += 1) {
  await assert.rejects(callServerToolChecked({ name: "write", arguments: { path: "x" } }), /Invalid arguments/);
}
assert.equal(reconnects, 0, "semantic failures never reconnect, even after repeated calls");

let mutationCalls = 0;
current = { name: "mutating", async callServerTool() { mutationCalls += 1; throw new Error("socket hang up"); } };
setServerToolHost({
  getApp: () => current as any,
  async reconnect() { reconnects += 1; current = { name: "recovered", async callServerTool() { mutationCalls += 1; return { isError: false, content: [] }; } }; },
});
await assert.rejects(
  callServerToolChecked({ name: "write", arguments: { path: "x", content: "data" } }),
  (error: unknown) => error instanceof AmbiguousMutationError,
);
assert.equal(mutationCalls, 1, "an ambiguous mutation is not replayed after reconnect");
assert.equal(reconnects, 1, "a confirmed connection reset reconstructs transport once");

current = { name: "ambiguous", async callServerTool() { throw new Error("response was lost after the request may have committed"); } };
await assert.rejects(
  callServerToolChecked({ name: "write", arguments: { path: "x", content: "data" } }),
  (error: unknown) => error instanceof AmbiguousMutationError,
);
assert.equal(reconnects, 1, "an ambiguous completion is surfaced for reconciliation without assuming transport loss");

let obsoleteReconnects = 0;
let obsoleteCalls = 0;
const replacementApp = { name: "replacement", async callServerTool() { return { isError: false, content: [] }; } };
current = {
  name: "obsolete",
  async callServerTool() {
    current = replacementApp as any;
    throw new Error("socket hang up from obsolete App");
  },
};
setServerToolHost({
  getApp: () => current as any,
  async reconnect() { obsoleteReconnects += 1; },
});
await callServerToolChecked({ name: "get_workspace_session_surface", arguments: {} });
obsoleteCalls += 1;
assert.equal(obsoleteCalls, 1);
assert.equal(obsoleteReconnects, 0, "an obsolete App failure cannot trigger a second transport replacement");
