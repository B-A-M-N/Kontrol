import assert from "node:assert/strict";
import { getToolDisplay, getToolLabel, toolNameFromMeta, toolNameFromResult } from "./tool-display.js";

const base = { content: [], isError: false } as const;
assert.equal(toolNameFromMeta({ ...base, _meta: { tool: "read" } } as never), "read");
assert.equal(toolNameFromResult({ ...base, _meta: {} } as never, { tool: "grep" }), "grep",
  "structuredContent.tool is a validated fallback when _meta.tool is absent");
assert.equal(toolNameFromResult({ ...base, _meta: { card: { tool: "ls" } } } as never, {}, { tool: "ls" }), "ls",
  "card.tool is a validated fallback when host metadata omits _meta.tool");
assert.equal(toolNameFromResult({ ...base, _meta: {} } as never, { tool: "not-a-tool" }, { tool: "write" }), "write");
assert.equal(toolNameFromResult({ ...base, _meta: {} } as never, { tool: "not-a-tool" }, { tool: "not-a-tool" }), undefined,
  "unknown fallback values must not render as a tool card");
const displayedChanges = { tool: "show_changes", summary: { files: 2 } } as const;
const acknowledgedChanges = { tool: "acknowledge_changes", summary: { acknowledged: true } } as const;
assert.match(getToolDisplay(displayedChanges as never).title, /Show Changes/);
assert.equal(getToolLabel(acknowledgedChanges as never), "Acknowledged displayed snapshot");
assert.equal(getToolDisplay(acknowledgedChanges as never).title, "Acknowledge Changes");
console.log("tool-display.test.ts: all assertions passed");
