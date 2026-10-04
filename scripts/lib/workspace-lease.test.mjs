import assert from "node:assert/strict";
import {
  applyWorkspaceLeaseRenewal,
  workspaceLeaseDeadline,
  workspaceLeaseDeadlineReached,
  WORKSPACE_LEASE_SAFETY_MARGIN_MS,
} from "./workspace-lease.mjs";

const now = Date.parse("2026-10-04T12:00:00.000Z");
const initialDeadline = workspaceLeaseDeadline("2026-10-04T12:01:00.000Z", now);
assert.equal(initialDeadline, now + 60_000 - WORKSPACE_LEASE_SAFETY_MARGIN_MS);

const run = { workSessionId: "work-session", workspaceLeaseDeadlineAt: initialDeadline };
assert.equal(workspaceLeaseDeadlineReached(run, now), false, "a current acknowledgement grants a bounded local window");
assert.equal(applyWorkspaceLeaseRenewal(run, { workspace_lease_expires_at: "2026-10-04T12:02:00.000Z" }, now), true);
assert.equal(run.workspaceLeaseDeadlineAt, now + 120_000 - WORKSPACE_LEASE_SAFETY_MARGIN_MS,
  "only an acknowledged renewed expiry advances the local deadline");
assert.equal(applyWorkspaceLeaseRenewal(run, {}, now), false, "an acknowledgement without expiry is not a renewal");
assert.equal(run.workspaceLeaseDeadlineAt, now + 120_000 - WORKSPACE_LEASE_SAFETY_MARGIN_MS,
  "an invalid acknowledgement cannot extend or erase the existing deadline");
assert.equal(workspaceLeaseDeadlineReached({ workSessionId: "missing-expiry" }, now), true,
  "a worker with no initial lease expiry fails closed");
assert.equal(workspaceLeaseDeadlineReached(run, run.workspaceLeaseDeadlineAt), true,
  "the local watchdog expires at the safety-adjusted deadline");
assert.equal(workspaceLeaseDeadlineReached({}, now), false, "non-work-session smoke runs need no workspace lease");

console.log("workspace-lease.test.mjs: all assertions passed");
