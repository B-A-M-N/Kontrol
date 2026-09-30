import assert from "node:assert/strict";
import { setServerToolHost, callServerToolChecked } from "./server-tool-call.js";

const calls: string[] = [];
let current: { name: string; callServerTool(request: any): Promise<any> } | null = {
  name: "old",
  async callServerTool() { throw new Error("old transport lost"); },
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
