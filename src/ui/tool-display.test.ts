import assert from "node:assert/strict";
import { toolNameFromMeta, toolNameFromResult } from "./tool-display.js";

const base = { content: [], isError: false } as const;
assert.equal(toolNameFromMeta({ ...base, _meta: { tool: "read" } } as never), "read");
assert.equal(toolNameFromResult({ ...base, _meta: {} } as never, { tool: "grep" }), "grep",
  "structuredContent.tool is a validated fallback when _meta.tool is absent");
assert.equal(toolNameFromResult({ ...base, _meta: { card: { tool: "ls" } } } as never, {}, { tool: "ls" }), "ls",
  "card.tool is a validated fallback when host metadata omits _meta.tool");
assert.equal(toolNameFromResult({ ...base, _meta: {} } as never, { tool: "not-a-tool" }, { tool: "write" }), "write");
assert.equal(toolNameFromResult({ ...base, _meta: {} } as never, { tool: "not-a-tool" }, { tool: "not-a-tool" }), undefined,
  "unknown fallback values must not render as a tool card");
console.log("tool-display.test.ts: all assertions passed");
