/**
 * Tests for src/peer/tool-profile.ts — capability-to-tool-name mapping and
 * stable profile keys. Style: plain tsx script with node:assert/strict.
 */
import assert from "node:assert/strict";
import { peerAllowedToolNames, peerToolProfileKey } from "./tool-profile.js";
import { toolNames } from "../mcp/tool-names.js";

const inspectTools = [
  toolNames.openWorkspace,
  toolNames.listManagedWorktrees,
  toolNames.read,
  toolNames.grep,
  toolNames.glob,
  toolNames.ls,
  toolNames.gitStatus,
  toolNames.gitLog,
  toolNames.gitDiff,
  toolNames.gitShow,
];

// Empty capabilities → read-only baseline (inspect set only).
assert.deepEqual([...peerAllowedToolNames([])].sort(), [...inspectTools].sort(), "empty capabilities fall back to the read-only inspect surface");

// Inspect set matches the read-only surface exactly.
const inspectOnly = peerAllowedToolNames(["workspace:inspect"]);
assert.deepEqual([...inspectOnly].sort(), [...inspectTools].sort(), "inspect set is exactly the read-only surface");
assert.equal(inspectOnly.has(toolNames.write), false);
assert.equal(inspectOnly.has(toolNames.edit), false);
assert.equal(inspectOnly.has(toolNames.shell), false);

// propose_patch adds exactly the three mutation tools.
const withPatch = peerAllowedToolNames(["workspace:inspect", "workspace:propose_patch"]);
for (const name of [...inspectTools, toolNames.write, toolNames.edit, toolNames.stagedWrite]) {
  assert.equal(withPatch.has(name), true, `propose_patch profile includes ${name}`);
}
assert.equal(withPatch.has(toolNames.shell), false, "propose_patch does not include bash");
assert.equal(withPatch.size, inspectTools.length + 3);

// run_bounded adds exactly the three execution tools.
const withRun = peerAllowedToolNames(["workspace:inspect", "workspace:run_bounded"]);
for (const name of [...inspectTools, toolNames.shell, toolNames.pollProcess, toolNames.writeStdin]) {
  assert.equal(withRun.has(name), true, `run_bounded profile includes ${name}`);
}
assert.equal(withRun.has(toolNames.write), false, "run_bounded does not include write");
assert.equal(withRun.size, inspectTools.length + 3);

// Full grant: 10 inspect + 3 patch + 3 run.
const full = peerAllowedToolNames(["workspace:inspect", "workspace:propose_patch", "workspace:run_bounded"]);
assert.equal(full.size, inspectTools.length + 6);

// Unknown capability strings are ignored (never widen the surface).
const unknown = peerAllowedToolNames(["workspace:inspect", "job:claim", "totally:unknown"] as never);
assert.deepEqual([...unknown].sort(), [...inspectTools].sort(), "non-mapping capabilities add no tools");

// Bridge/policy/reviewer tools are never included under any profile.
for (const tool of ["discover_agents", "submit_for_review", "await_review_feedback", "show_changes", "show_workspace_ui"]) {
  assert.equal(full.has(tool), false, `${tool} never peer-visible`);
}

// Profile key: sorted, joined, or "none".
assert.equal(peerToolProfileKey(undefined), "none");
assert.equal(peerToolProfileKey([]), "none");
assert.equal(peerToolProfileKey(["workspace:run_bounded", "workspace:inspect"]), "workspace:inspect,workspace:run_bounded");
assert.equal(
  peerToolProfileKey(["workspace:inspect", "workspace:run_bounded"]),
  peerToolProfileKey(["workspace:run_bounded", "workspace:inspect"]),
  "profile key is order-independent",
);

console.log("src/peer/tool-profile.test.ts: all assertions passed");
