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

// Empty capabilities → NO tools. Even inspection must be explicitly granted;
// job-only credentials must not read a workspace or resources by stale-catalog
// tool-name guessing.
const none = peerAllowedToolNames([]);
assert.equal(none.size, 0, "empty capabilities grant no tools");

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

// workspace:run_bounded is reserved and grants no process tools until a
// dedicated OS-confined peer execution boundary exists.
const withRun = peerAllowedToolNames(["workspace:run_bounded"]);
assert.equal(withRun.size, 0, "run_bounded is reserved and adds no process tools");
for (const name of [toolNames.shell, toolNames.pollProcess, toolNames.writeStdin]) {
  assert.equal(withRun.has(name), false, `run_bounded must not expose ${name}`);
}

// Job-only credentials cannot inspect by tool-name guessing.
const jobOnly = peerAllowedToolNames(["job:claim", "job:complete", "job:cancel_ack"]);
assert.equal(jobOnly.size, 0, "job-only credentials expose no workspace tools");
for (const name of inspectTools) {
  assert.equal(jobOnly.has(name), false, `job-only credential cannot call ${name}`);
}

// Full currently-supported grant: inspect + patch only.
const full = peerAllowedToolNames(["workspace:inspect", "workspace:propose_patch", "workspace:run_bounded"]);
assert.equal(full.size, inspectTools.length + 3);

// Unknown capability strings are ignored (never widen the surface).
const unknown = peerAllowedToolNames(["workspace:inspect", "job:claim", "totally:unknown"] as never);
assert.deepEqual([...unknown].sort(), [...inspectTools].sort(), "non-inspect capabilities add no workspace tools");

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
