import assert from "node:assert/strict";
import {
  isEditTool,
  isExpandableCard,
  isPatchTool,
  isShellTool,
  isToolName,
} from "./card-types.js";
import { toolNameFromResult } from "./tool-display.js";

for (const tool of ["apply_patch", "exec_command", "write_stdin", "poll_process", "list_peer_status", "ingress_management"]) {
  assert.equal(isToolName(tool), true, `${tool} should be a recognized card tool`);
}
assert.equal(isToolName("not_a_tool"), false);

// toolNameFromResult resolves list_peer_status through _meta, structured
// content, and card fallbacks — the card must render for every connector.
{
  const result = { _meta: { tool: "list_peer_status" } } as any;
  assert.equal(toolNameFromResult(result, {}), "list_peer_status", "_meta.tool path");
  assert.equal(toolNameFromResult({ _meta: {} } as any, { tool: "list_peer_status" }), "list_peer_status", "structuredContent path");
  assert.equal(toolNameFromResult({ _meta: {} } as any, {}, { tool: "list_peer_status" }), "list_peer_status", "card fallback path");
  assert.equal(toolNameFromResult({ _meta: {} } as any, {}, {}), undefined, "unrelated result stays unclassified");
}

assert.equal(isPatchTool("apply_patch"), true);
assert.equal(isEditTool("apply_patch"), false);
assert.equal(isShellTool("exec_command"), true);
assert.equal(isShellTool("write_stdin"), true);
assert.equal(isShellTool("poll_process"), true);
assert.equal(isEditTool("exec_command"), false);
assert.equal(isShellTool("apply_patch"), false);

assert.equal(
  isExpandableCard({ tool: "apply_patch", payload: { patch: "diff --git a/a b/a" } }),
  true,
);
assert.equal(isExpandableCard({ tool: "apply_patch" }), false);
